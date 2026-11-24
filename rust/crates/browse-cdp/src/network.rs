//! CDP network capture reconciliation.
//!
//! Absorbs all CDP-specific network quirks inside `browse-cdp`:
//! - `Network.enable` / `Network.disable` refcounting shared with offline emulation
//! - `Target.setAutoAttach` child sessions for out-of-process iframes & workers
//! - `RequestWillBeSentExtraInfo` / `ResponseReceivedExtraInfo` wire-header merging
//! - `DataReceived` byte accumulation and `CHILD_DOCUMENT_GRACE` completion
//! - Per-request CDP session lookup for `getRequestPostData` and `getResponseBody`

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine;
use browse_core::{
    BodyKind, CloseReason, DriverResult, FrameId, NetworkEvent, NetworkOptions, NetworkRequest, RequestId,
    ResponseHead, Subscription,
};
use serde_json::{Value, json};
use tokio::sync::{broadcast, mpsc, watch};

use crate::wire::{Cdp, CdpEvent, map_cdp_error};

const CHILD_DOCUMENT_GRACE: Duration = Duration::from_millis(1_000);
const MAX_EXTRA_CACHE: usize = 4_000;

pub(crate) fn enable_params() -> Value {
    json!({ "maxPostDataSize": 65_536 })
}

pub(crate) struct NetworkDomain {
    pub capture: bool,
    pub offline: bool,
    /// Child sessions whose `Network.enable` finished, so `CdpTabDriver` does not resume a paused child target before
    /// capture is listening on it.
    pub enabled_sessions: HashSet<String>,
    pub session_ready: watch::Sender<u64>,
}

impl Default for NetworkDomain {
    fn default() -> Self {
        Self {
            capture: false,
            offline: false,
            enabled_sessions: HashSet::new(),
            session_ready: watch::channel(0).0,
        }
    }
}

#[derive(Default)]
pub(crate) struct NetworkBodyMap {
    /// `event_id` -> `(cdp_request_id, request_session, response_body_session)`
    sessions: HashMap<String, (String, Option<String>, Option<String>)>,
}

impl NetworkBodyMap {
    pub(crate) fn record_request(&mut self, event_id: &str, cdp_request_id: &str, session: Option<String>) {
        if self.sessions.len() > 2_000 {
            self.sessions.clear();
        }
        self.sessions
            .insert(event_id.to_string(), (cdp_request_id.to_string(), session.clone(), session));
    }

    pub(crate) fn record_body_session(&mut self, event_id: &str, session: Option<String>) {
        if let Some(entry) = self.sessions.get_mut(event_id) {
            entry.2 = session;
        }
    }

    pub(crate) fn lookup(&self, event_id: &str, kind: BodyKind) -> (String, Option<String>) {
        match self.sessions.get(event_id) {
            Some((cdp_id, req, resp)) => {
                let session = match kind {
                    BodyKind::Request => req.clone(),
                    BodyKind::Response => resp.clone(),
                };
                (cdp_id.clone(), session)
            }
            None => (event_id.to_string(), None),
        }
    }
}

struct Pending {
    /// Unique per redirect hop (equals `cdp_request_id` on hop 0, `{cdp_request_id}#redirect-{n}` on later hops).
    event_id: String,
    cdp_request_id: String,
    url: String,
    resource_type: String,
    frame_id: Option<String>,
    data_length: usize,
    response: Option<ResponseHead>,
    /// `responseReceived` said extra-info events (the headers as sent, cookies included) come for it.
    has_extra_info: bool,
}

enum FinishingOutcome {
    Finished { body_size: usize, want_response_extra: bool },
    Failed { error: String },
}

/// A finished or failed hop whose extra info hasn't arrived yet: CDP may send it after `loadingFinished`,
/// `loadingFailed`, or `requestWillBeSent(redirectResponse)`.
struct Finishing {
    event_id: String,
    outcome: FinishingOutcome,
}

/// How long a finished request waits for its extra info before it is reported without it.
const EXTRA_INFO_GRACE: std::time::Duration = std::time::Duration::from_millis(250);

struct ExtraResponse {
    headers: Vec<(String, String)>,
    status: Option<i64>,
}

#[derive(Default)]
struct State {
    pending: HashMap<(Option<String>, String), Pending>,
    /// Number of redirects observed per CDP `requestId`, used to mint distinct per-hop event ids.
    redirect_count: HashMap<String, usize>,
    /// Per-CDP-`requestId` FIFO queues of extra-info events (redirect hops share one CDP `requestId`).
    request_extra: HashMap<String, VecDeque<Vec<(String, String)>>>,
    response_extra: HashMap<String, VecDeque<ExtraResponse>>,
    children: HashMap<String, String>,
    finishing: HashMap<String, VecDeque<Finishing>>,
}

impl State {
    fn pending_key(&self, key: &(Option<String>, String)) -> Option<(Option<String>, String)> {
        if self.pending.contains_key(key) {
            return Some(key.clone());
        }
        self.pending.keys().find(|other| other.1 == key.1).cloned()
    }

    fn take_pending(&mut self, key: &(Option<String>, String)) -> Option<Pending> {
        let key = self.pending_key(key)?;
        self.pending.remove(&key)
    }

    fn pop_request_extra(&mut self, cdp_request_id: &str) -> Option<Vec<(String, String)>> {
        let item = self.request_extra.get_mut(cdp_request_id)?.pop_front();
        if self.request_extra.get(cdp_request_id).is_some_and(VecDeque::is_empty) {
            self.request_extra.remove(cdp_request_id);
        }
        item
    }

    fn pop_response_extra(&mut self, cdp_request_id: &str) -> Option<ExtraResponse> {
        let item = self.response_extra.get_mut(cdp_request_id)?.pop_front();
        if self.response_extra.get(cdp_request_id).is_some_and(VecDeque::is_empty) {
            self.response_extra.remove(cdp_request_id);
        }
        item
    }

    fn has_finishing(&self, cdp_request_id: &str, event_id: &str) -> bool {
        self.finishing
            .get(cdp_request_id)
            .is_some_and(|queue| queue.iter().any(|item| item.event_id == event_id))
    }

    fn synth_response_from_extra(&self, pending: &mut Pending) -> bool {
        if pending.response.is_none()
            && let Some(extra) = self.response_extra.get(&pending.cdp_request_id).and_then(VecDeque::front)
            && let Some(status) = extra.status
        {
            let mime_type = extra
                .headers
                .iter()
                .find(|(name, _)| name.eq_ignore_ascii_case("content-type"))
                .map(|(_, value)| value.split(';').next().unwrap_or("").trim().to_string())
                .filter(|m| !m.is_empty());
            pending.response = Some(ResponseHead {
                status,
                status_text: String::new(),
                headers: extra.headers.clone(),
                mime_type,
            });
        }
        pending.response.is_some()
    }
}

pub(crate) async fn start(
    cdp: Arc<dyn Cdp>,
    domain: Arc<Mutex<NetworkDomain>>,
    bodies: Arc<Mutex<NetworkBodyMap>>,
    _opts: NetworkOptions,
) -> DriverResult<Subscription<NetworkEvent>> {
    let mut events = cdp.events();
    cdp.send("Network.enable", enable_params(), None)
        .await
        .map_err(map_cdp_error)?;
    {
        let mut guard = domain.lock().unwrap();
        guard.capture = true;
        guard.enabled_sessions.clear();
    }

    let (tx, rx) = mpsc::unbounded_channel::<NetworkEvent>();
    let state = Arc::new(Mutex::new(State::default()));
    let task_cdp = cdp.clone();
    let task_domain = domain.clone();
    let task_state = state.clone();
    let task_bodies = bodies.clone();
    let task_tx = tx.clone();

    let task = tokio::spawn(async move {
        let reason = loop {
            match events.recv().await {
                Ok(event) => {
                    if event.session_id.is_none() {
                        match event.method.as_str() {
                            "Inspector.detached" => {
                                let reason = event
                                    .params
                                    .get("reason")
                                    .and_then(Value::as_str)
                                    .unwrap_or("detached")
                                    .to_string();
                                break CloseReason::Detached(reason);
                            }
                            "Inspector.targetCrashed" | "Target.targetCrashed" => break CloseReason::Crashed,
                            _ => {}
                        }
                    }
                    handle_event(&task_cdp, &task_domain, &task_state, &task_bodies, &task_tx, event);
                }
                Err(broadcast::error::RecvError::Lagged(missed)) => {
                    let _ = task_tx.send(NetworkEvent::Lagged(missed));
                }
                Err(broadcast::error::RecvError::Closed) => break CloseReason::Closed,
            }
        };
        let _ = task_tx.send(NetworkEvent::Closed(reason));
    });

    // Pause newly attached OOPIFs and workers until `Network.enable` runs on them, so immediate subresource fetches
    // in a fresh child target cannot race ahead of capture. `CdpTabDriver` waits on `NetworkDomain::session_ready`
    // before sending `Runtime.runIfWaitingForDebugger`.
    let _ = cdp
        .send(
            "Target.setAutoAttach",
            json!({ "autoAttach": true, "waitForDebuggerOnStart": true, "flatten": true }),
            None,
        )
        .await;

    let cleanup = Box::new(move || {
        Box::pin(async move {
            let should_disable = {
                let mut guard = domain.lock().unwrap();
                guard.capture = false;
                guard.enabled_sessions.clear();
                guard.session_ready.send_modify(|n| *n += 1);
                !guard.offline
            };
            let _ = cdp
                .send(
                    "Target.setAutoAttach",
                    json!({ "autoAttach": true, "waitForDebuggerOnStart": false, "flatten": true }),
                    None,
                )
                .await;
            if should_disable {
                let _ = cdp.send("Network.disable", json!({}), None).await;
            }
        }) as std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>
    });

    Ok(Subscription::new(rx, Some(task.abort_handle()), Some(cleanup)))
}

pub(crate) async fn fetch_body(
    cdp: &dyn Cdp,
    bodies: &Mutex<NetworkBodyMap>,
    request_id: &RequestId,
    kind: BodyKind,
) -> DriverResult<Option<Vec<u8>>> {
    let (cdp_id, scope) = bodies.lock().unwrap().lookup(request_id.as_str(), kind);
    match kind {
        BodyKind::Request => {
            let value = cdp
                .send(
                    "Network.getRequestPostData",
                    json!({ "requestId": cdp_id }),
                    scope.as_deref(),
                )
                .await
                .map_err(map_cdp_error)?;
            Ok(value
                .get("postData")
                .and_then(Value::as_str)
                .map(|s| s.as_bytes().to_vec()))
        }
        BodyKind::Response => {
            let value = cdp
                .send(
                    "Network.getResponseBody",
                    json!({ "requestId": cdp_id }),
                    scope.as_deref(),
                )
                .await
                .map_err(map_cdp_error)?;
            let body = value.get("body").and_then(Value::as_str).unwrap_or("");
            if value.get("base64Encoded").and_then(Value::as_bool).unwrap_or(false) {
                Ok(base64::engine::general_purpose::STANDARD.decode(body).ok())
            } else {
                Ok(Some(body.as_bytes().to_vec()))
            }
        }
    }
}

/// A CDP headers object as a list. CDP joins a header sent more than once (`Set-Cookie`, above all) into one value
/// with newlines; each becomes its own header again, as the other drivers report them.
fn headers_from(value: Option<&Value>) -> Vec<(String, String)> {
    value
        .and_then(Value::as_object)
        .map(|map| {
            map.iter()
                .flat_map(|(name, value)| {
                    let value = value.as_str().map_or_else(|| value.to_string(), str::to_string);
                    value.split('\n').map(|part| (name.clone(), part.to_string())).collect::<Vec<_>>()
                })
                .collect()
        })
        .unwrap_or_default()
}

fn response_head(value: &Value) -> ResponseHead {
    ResponseHead {
        status: value.get("status").and_then(Value::as_i64).unwrap_or(0),
        status_text: value.get("statusText").and_then(Value::as_str).unwrap_or("").to_string(),
        headers: headers_from(value.get("headers")),
        mime_type: value
            .get("mimeType")
            .and_then(Value::as_str)
            .filter(|mime| !mime.is_empty())
            .map(str::to_string),
    }
}

fn schedule_extra_grace(
    state: &Arc<Mutex<State>>,
    tx: &mpsc::UnboundedSender<NetworkEvent>,
    cdp_request_id: String,
    event_id: String,
) {
    let state = state.clone();
    let tx = tx.clone();
    tokio::spawn(async move {
        tokio::time::sleep(EXTRA_INFO_GRACE).await;
        flush_finishing(&mut state.lock().unwrap(), &tx, &cdp_request_id, Some(&event_id));
    });
}

fn handle_event(
    cdp: &Arc<dyn Cdp>,
    domain: &Arc<Mutex<NetworkDomain>>,
    state: &Arc<Mutex<State>>,
    bodies: &Arc<Mutex<NetworkBodyMap>>,
    tx: &mpsc::UnboundedSender<NetworkEvent>,
    event: CdpEvent,
) {
    let params = &event.params;
    let request_id = params.get("requestId").and_then(Value::as_str).unwrap_or("").to_string();
    let key = (event.session_id.clone(), request_id.clone());
    match event.method.as_str() {
        "Network.requestWillBeSent" => {
            let mut st = state.lock().unwrap();
            let mut redirect_of = None;
            let event_id = if let Some(redirect) = params.get("redirectResponse")
                && let Some(previous) = st.take_pending(&key)
            {
                let head = response_head(redirect);
                let prev_id = previous.event_id.clone();
                let redirect_has_extra = params
                    .get("redirectHasExtraInfo")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let _ = tx.send(NetworkEvent::Response {
                    id: RequestId::from(prev_id.clone()),
                    head,
                    committed: false,
                });
                st.finishing.entry(previous.cdp_request_id.clone()).or_default().push_back(Finishing {
                    event_id: prev_id.clone(),
                    outcome: FinishingOutcome::Finished {
                        body_size: previous.data_length,
                        want_response_extra: redirect_has_extra,
                    },
                });
                if redirect_has_extra {
                    flush_finishing(&mut st, tx, &previous.cdp_request_id, None);
                    if st.has_finishing(&previous.cdp_request_id, &prev_id) {
                        schedule_extra_grace(state, tx, previous.cdp_request_id.clone(), prev_id);
                    }
                } else {
                    flush_finishing(&mut st, tx, &previous.cdp_request_id, Some(&prev_id));
                }
                redirect_of = Some(previous.url);
                if st.redirect_count.len() > MAX_EXTRA_CACHE {
                    st.redirect_count.clear();
                }
                let hop = st.redirect_count.entry(request_id.clone()).or_insert(0);
                *hop += 1;
                format!("{request_id}#redirect-{hop}")
            } else {
                request_id.clone()
            };
            let request = params.get("request").cloned().unwrap_or(Value::Null);
            let url = request.get("url").and_then(Value::as_str).unwrap_or("").to_string();
            let method = request.get("method").and_then(Value::as_str).unwrap_or("GET").to_string();
            let resource_type = params.get("type").and_then(Value::as_str).unwrap_or("Other").to_string();
            let frame_id = params.get("frameId").and_then(Value::as_str).map(str::to_string);
            let headers = headers_from(request.get("headers"));
            let post_data = request.get("postData").and_then(Value::as_str).map(str::to_string);
            let has_body = request.get("hasPostData").and_then(Value::as_bool).unwrap_or(false);
            bodies
                .lock()
                .unwrap()
                .record_request(&event_id, &request_id, event.session_id.clone());
            st.pending.insert(
                key,
                Pending {
                    event_id: event_id.clone(),
                    cdp_request_id: request_id,
                    url: url.clone(),
                    resource_type: resource_type.clone(),
                    frame_id: frame_id.clone(),
                    data_length: 0,
                    response: None,
                    has_extra_info: false,
                },
            );
            drop(st);
            let _ = tx.send(NetworkEvent::Request(NetworkRequest {
                id: RequestId::from(event_id),
                redirect_of,
                frame: frame_id.map(FrameId::from),
                url,
                method,
                headers,
                resource_type,
                post_data,
                has_body,
            }));
        }
        "Network.requestWillBeSentExtraInfo" => {
            let mut st = state.lock().unwrap();
            if st.request_extra.len() > MAX_EXTRA_CACHE {
                st.request_extra.clear();
            }
            st.request_extra
                .entry(request_id.clone())
                .or_default()
                .push_back(headers_from(params.get("headers")));
            flush_finishing(&mut st, tx, &request_id, None);
        }
        "Network.responseReceivedExtraInfo" => {
            let mut st = state.lock().unwrap();
            if st.response_extra.len() > MAX_EXTRA_CACHE {
                st.response_extra.clear();
            }
            st.response_extra.entry(request_id.clone()).or_default().push_back(ExtraResponse {
                headers: headers_from(params.get("headers")),
                status: params.get("statusCode").and_then(Value::as_i64),
            });
            flush_finishing(&mut st, tx, &request_id, None);
        }
        "Network.responseReceived" => {
            let Some(head) = params.get("response").map(response_head) else { return };
            let mut st = state.lock().unwrap();
            if let Some(found) = st.pending_key(&key) {
                let (event_id, resource_type, frame_id) = {
                    let Some(pending) = st.pending.get_mut(&found) else { return };
                    pending.response = Some(head.clone());
                    pending.has_extra_info = params.get("hasExtraInfo").and_then(Value::as_bool).unwrap_or(false);
                    (
                        pending.event_id.clone(),
                        pending.resource_type.clone(),
                        pending.frame_id.clone(),
                    )
                };
                bodies
                    .lock()
                    .unwrap()
                    .record_body_session(&event_id, event.session_id.clone());
                let committed = resource_type == "Document"
                    && frame_id.as_ref().is_some_and(|f| st.children.contains_key(f));
                drop(st);
                let _ = tx.send(NetworkEvent::Response { id: RequestId::from(event_id), head, committed });
            }
        }
        "Network.dataReceived" => {
            let mut st = state.lock().unwrap();
            if let Some(found) = st.pending_key(&key)
                && let Some(pending) = st.pending.get_mut(&found)
            {
                pending.data_length += params.get("dataLength").and_then(Value::as_u64).unwrap_or(0) as usize;
            }
        }
        "Network.loadingFinished" => {
            let mut st = state.lock().unwrap();
            if let Some(pending) = st.take_pending(&key) {
                bodies
                    .lock()
                    .unwrap()
                    .record_body_session(&pending.event_id, event.session_id.clone());
                let cdp_id = pending.cdp_request_id.clone();
                let event_id = pending.event_id.clone();
                let queue_had_earlier = st.finishing.get(&cdp_id).is_some_and(|q| !q.is_empty());
                st.finishing.entry(cdp_id.clone()).or_default().push_back(Finishing {
                    event_id: event_id.clone(),
                    outcome: FinishingOutcome::Finished {
                        body_size: pending.data_length,
                        want_response_extra: pending.has_extra_info,
                    },
                });
                if pending.has_extra_info || queue_had_earlier {
                    flush_finishing(&mut st, tx, &cdp_id, None);
                    if st.has_finishing(&cdp_id, &event_id) {
                        schedule_extra_grace(state, tx, cdp_id, event_id);
                    }
                } else {
                    flush_finishing(&mut st, tx, &cdp_id, Some(&event_id));
                }
            }
        }
        "Network.loadingFailed" => {
            let mut st = state.lock().unwrap();
            if let Some(pending) = st.take_pending(&key) {
                let error = params
                    .get("errorText")
                    .and_then(Value::as_str)
                    .filter(|text| !text.is_empty())
                    .unwrap_or("Request failed")
                    .to_string();
                // A request that reached the network and failed later (aborted, reset) still went out with the
                // headers its extra info reported — which CDP may deliver slightly after `loadingFailed`.
                let expect_extra = params.get("blockedReason").is_none() && pending.url.starts_with("http");
                let cdp_id = pending.cdp_request_id.clone();
                let event_id = pending.event_id.clone();
                let queue_had_earlier = st.finishing.get(&cdp_id).is_some_and(|q| !q.is_empty());
                st.finishing.entry(cdp_id.clone()).or_default().push_back(Finishing {
                    event_id: event_id.clone(),
                    outcome: FinishingOutcome::Failed { error },
                });
                if expect_extra || queue_had_earlier {
                    flush_finishing(&mut st, tx, &cdp_id, None);
                    if st.has_finishing(&cdp_id, &event_id) {
                        schedule_extra_grace(state, tx, cdp_id, event_id);
                    }
                } else {
                    flush_finishing(&mut st, tx, &cdp_id, Some(&event_id));
                }
            }
        }
        "Target.attachedToTarget" => {
            if let Some(session) = params.get("sessionId").and_then(Value::as_str) {
                let session = session.to_string();
                let target = params
                    .pointer("/targetInfo/targetId")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                if let Some(target_id) = &target {
                    let mut st = state.lock().unwrap();
                    st.children.insert(target_id.clone(), session.clone());
                    // Immediately mark any matching pending Document request whose response is already known as committed.
                    let keys: Vec<(Option<String>, String)> = st
                        .pending
                        .iter()
                        .filter(|(_, p)| p.resource_type == "Document" && p.frame_id.as_deref() == Some(target_id.as_str()))
                        .map(|(k, _)| k.clone())
                        .collect();
                    let mut committed_events = Vec::new();
                    for k in keys {
                        if let Some(mut p) = st.pending.remove(&k) {
                            if st.synth_response_from_extra(&mut p)
                                && let Some(head) = p.response.clone()
                            {
                                committed_events.push(NetworkEvent::Response {
                                    id: RequestId::from(p.event_id.clone()),
                                    head,
                                    committed: true,
                                });
                            }
                            st.pending.insert(k, p);
                        }
                    }
                    drop(st);
                    for ev in committed_events {
                        let _ = tx.send(ev);
                    }
                }
                let cdp = cdp.clone();
                let domain = domain.clone();
                let state = state.clone();
                let tx = tx.clone();
                tokio::spawn(async move {
                    let _ = cdp.send("Network.enable", enable_params(), Some(&session)).await;
                    {
                        let mut guard = domain.lock().unwrap();
                        if guard.capture {
                            guard.enabled_sessions.insert(session);
                            guard.session_ready.send_modify(|n| *n += 1);
                        }
                    }
                    tokio::time::sleep(CHILD_DOCUMENT_GRACE).await;
                    if let Some(target_id) = target {
                        complete_child_documents(&state, &tx, &target_id);
                    }
                });
            }
        }
        "Target.detachedFromTarget" => {
            if let Some(session) = params.get("sessionId").and_then(Value::as_str) {
                state.lock().unwrap().children.retain(|_, child| child != session);
                domain.lock().unwrap().enabled_sessions.remove(session);
            }
        }
        _ => {}
    }
}

/// Reports queued hops in FIFO order once their extra infos are in (or up through `force_up_to` when the grace timer
/// expires or no extra info is expected).
fn flush_finishing(
    st: &mut State,
    tx: &mpsc::UnboundedSender<NetworkEvent>,
    cdp_request_id: &str,
    force_up_to: Option<&str>,
) {
    let mut forcing = force_up_to.is_some_and(|target| st.has_finishing(cdp_request_id, target));
    loop {
        let (complete, is_target) = {
            let Some(front) = st.finishing.get(cdp_request_id).and_then(VecDeque::front) else {
                st.finishing.remove(cdp_request_id);
                return;
            };
            let has_req = st.request_extra.get(cdp_request_id).is_some_and(|q| !q.is_empty());
            let has_resp = st.response_extra.get(cdp_request_id).is_some_and(|q| !q.is_empty());
            let complete = match &front.outcome {
                FinishingOutcome::Finished { want_response_extra, .. } => {
                    has_req && (!*want_response_extra || has_resp)
                }
                FinishingOutcome::Failed { .. } => has_req,
            };
            let is_target = force_up_to == Some(front.event_id.as_str());
            (complete, is_target)
        };
        if !complete && !forcing {
            return;
        }
        let Some(finishing) = st.finishing.get_mut(cdp_request_id).and_then(VecDeque::pop_front) else {
            return;
        };
        if st.finishing.get(cdp_request_id).is_some_and(VecDeque::is_empty) {
            st.finishing.remove(cdp_request_id);
        }
        let request_headers = st.pop_request_extra(cdp_request_id).filter(|h| !h.is_empty());
        match finishing.outcome {
            FinishingOutcome::Finished { body_size, want_response_extra } => {
                let response_headers = if want_response_extra || st.response_extra.contains_key(cdp_request_id) {
                    st.pop_response_extra(cdp_request_id)
                        .map(|e| e.headers)
                        .filter(|h| !h.is_empty())
                } else {
                    None
                };
                let _ = tx.send(NetworkEvent::Finished {
                    id: RequestId::from(finishing.event_id),
                    body_size,
                    request_headers,
                    response_headers,
                });
            }
            FinishingOutcome::Failed { error } => {
                if !st.finishing.contains_key(cdp_request_id)
                    && !st.pending.keys().any(|(_, id)| id == cdp_request_id)
                {
                    st.response_extra.remove(cdp_request_id);
                }
                let _ = tx.send(NetworkEvent::Failed {
                    id: RequestId::from(finishing.event_id),
                    error,
                    request_headers,
                });
            }
        }
        if is_target {
            forcing = false;
        }
    }
}

fn complete_child_documents(
    state: &Arc<Mutex<State>>,
    tx: &mpsc::UnboundedSender<NetworkEvent>,
    target_id: &str,
) {
    let mut events_to_send = Vec::new();
    {
        let mut st = state.lock().unwrap();
        let keys: Vec<(Option<String>, String)> = st
            .pending
            .iter()
            .filter(|(_, p)| p.resource_type == "Document" && p.frame_id.as_deref() == Some(target_id))
            .map(|(k, _)| k.clone())
            .collect();
        for key in keys {
            let Some(mut pending) = st.pending.remove(&key) else { continue };
            if st.synth_response_from_extra(&mut pending) {
                let req_extra = st.pop_request_extra(&pending.cdp_request_id).filter(|h| !h.is_empty());
                let resp_extra = st
                    .pop_response_extra(&pending.cdp_request_id)
                    .map(|e| e.headers)
                    .filter(|h| !h.is_empty());
                let id = RequestId::from(pending.event_id);
                if let Some(head) = pending.response {
                    events_to_send.push(NetworkEvent::Response { id: id.clone(), head, committed: true });
                }
                events_to_send.push(NetworkEvent::Finished {
                    id,
                    body_size: pending.data_length,
                    request_headers: req_extra,
                    response_headers: resp_extra,
                });
            } else {
                st.pending.insert(key, pending);
            }
        }
    }
    for ev in events_to_send {
        let _ = tx.send(ev);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(method: &str, params: Value) -> CdpEvent {
        CdpEvent { method: method.into(), params, session_id: None }
    }

    /// CDP may send a request's extra info (the headers as sent, cookies included) after its `loadingFinished`.
    #[tokio::test]
    async fn late_extra_info_still_reaches_the_finished_request() {
        struct Silent;
        #[async_trait::async_trait]
        impl Cdp for Silent {
            async fn send(&self, _: &str, _: Value, _: Option<&str>) -> Result<Value, crate::CdpError> {
                Ok(json!({}))
            }
            fn events(&self) -> tokio::sync::broadcast::Receiver<CdpEvent> {
                tokio::sync::broadcast::channel(1).1
            }
        }
        let cdp: Arc<dyn Cdp> = Arc::new(Silent);
        let domain = Arc::new(Mutex::new(NetworkDomain::default()));
        let state = Arc::new(Mutex::new(State::default()));
        let bodies = Arc::new(Mutex::new(NetworkBodyMap::default()));
        let (tx, mut rx) = mpsc::unbounded_channel();
        let send = |e: CdpEvent| handle_event(&cdp, &domain, &state, &bodies, &tx, e);
        send(event("Network.requestWillBeSent", json!({ "requestId": "1", "type": "Fetch", "request": { "url": "http://a/x", "method": "GET", "headers": {} } })));
        send(event("Network.responseReceived", json!({ "requestId": "1", "hasExtraInfo": true, "response": { "status": 200, "headers": {} } })));
        send(event("Network.loadingFinished", json!({ "requestId": "1" })));
        send(event("Network.requestWillBeSentExtraInfo", json!({ "requestId": "1", "headers": { "Cookie": "sid=1" } })));
        send(event("Network.responseReceivedExtraInfo", json!({ "requestId": "1", "statusCode": 200, "headers": { "Set-Cookie": "a=1" } })));
        let mut finished = None;
        while let Ok(Some(event)) = tokio::time::timeout(std::time::Duration::from_secs(1), rx.recv()).await {
            if let NetworkEvent::Finished { request_headers, response_headers, .. } = event {
                finished = Some((request_headers, response_headers));
                break;
            }
        }
        let (request_headers, response_headers) = finished.expect("a finished event");
        assert_eq!(request_headers, Some(vec![("Cookie".to_string(), "sid=1".to_string())]));
        assert_eq!(response_headers, Some(vec![("Set-Cookie".to_string(), "a=1".to_string())]));
    }

    /// Redirect hops share one CDP `requestId`. Delayed extra info from the 302 hop must attach to the 302 hop
    /// and never bleed onto the redirected destination.
    #[tokio::test]
    async fn redirect_extra_info_stays_on_its_own_hop() {
        struct Silent;
        #[async_trait::async_trait]
        impl Cdp for Silent {
            async fn send(&self, _: &str, _: Value, _: Option<&str>) -> Result<Value, crate::CdpError> {
                Ok(json!({}))
            }
            fn events(&self) -> tokio::sync::broadcast::Receiver<CdpEvent> {
                tokio::sync::broadcast::channel(1).1
            }
        }
        let cdp: Arc<dyn Cdp> = Arc::new(Silent);
        let domain = Arc::new(Mutex::new(NetworkDomain::default()));
        let state = Arc::new(Mutex::new(State::default()));
        let bodies = Arc::new(Mutex::new(NetworkBodyMap::default()));
        let (tx, mut rx) = mpsc::unbounded_channel();
        let send = |e: CdpEvent| handle_event(&cdp, &domain, &state, &bodies, &tx, e);

        send(event("Network.requestWillBeSent", json!({
            "requestId": "R", "type": "Fetch",
            "request": { "url": "http://a/api/hop", "method": "GET", "headers": {} }
        })));
        // Redirect arrives before the 302 hop's extra info.
        send(event("Network.requestWillBeSent", json!({
            "requestId": "R", "type": "Fetch",
            "redirectHasExtraInfo": true,
            "redirectResponse": { "status": 302, "statusText": "Found", "headers": { "location": "/api/landed", "content-type": "text/plain" }, "mimeType": "text/plain" },
            "request": { "url": "http://a/api/landed", "method": "GET", "headers": {} }
        })));
        send(event("Network.responseReceived", json!({
            "requestId": "R", "hasExtraInfo": true,
            "response": { "status": 200, "statusText": "OK", "headers": { "content-type": "application/json" }, "mimeType": "application/json" }
        })));
        send(event("Network.loadingFinished", json!({ "requestId": "R" })));

        // Extra info for hop 0 (302) arrives now, followed by hop 1 (200).
        send(event("Network.requestWillBeSentExtraInfo", json!({ "requestId": "R", "headers": { "cookie": "sid=hop" } })));
        send(event("Network.responseReceivedExtraInfo", json!({ "requestId": "R", "statusCode": 302, "headers": { "location": "/api/landed", "content-type": "text/plain" } })));
        send(event("Network.requestWillBeSentExtraInfo", json!({ "requestId": "R", "headers": { "cookie": "sid=landed" } })));
        send(event("Network.responseReceivedExtraInfo", json!({ "requestId": "R", "statusCode": 200, "headers": { "content-type": "application/json" } })));

        let mut finished = Vec::new();
        while finished.len() < 2 {
            let ev = tokio::time::timeout(Duration::from_secs(1), rx.recv()).await.unwrap().unwrap();
            if let NetworkEvent::Finished { id, request_headers, response_headers, .. } = ev {
                finished.push((id.as_str().to_string(), request_headers, response_headers));
            }
        }
        assert_eq!(finished[0].0, "R");
        assert_eq!(finished[0].1, Some(vec![("cookie".to_string(), "sid=hop".to_string())]));
        assert!(finished[0].2.as_ref().unwrap().iter().any(|(k, v)| k == "location" && v == "/api/landed"));

        assert_eq!(finished[1].0, "R#redirect-1");
        assert_eq!(finished[1].1, Some(vec![("cookie".to_string(), "sid=landed".to_string())]));
        assert_eq!(finished[1].2, Some(vec![("content-type".to_string(), "application/json".to_string())]));

        // Body lookup for the redirected hop maps back to the real CDP requestId.
        let (cdp_id, _) = bodies.lock().unwrap().lookup("R#redirect-1", BodyKind::Response);
        assert_eq!(cdp_id, "R");
    }

    /// CDP may send `requestWillBeSentExtraInfo` slightly after `loadingFailed` for an aborted request.
    #[tokio::test]
    async fn late_extra_info_still_reaches_the_failed_request() {
        struct Silent;
        #[async_trait::async_trait]
        impl Cdp for Silent {
            async fn send(&self, _: &str, _: Value, _: Option<&str>) -> Result<Value, crate::CdpError> {
                Ok(json!({}))
            }
            fn events(&self) -> tokio::sync::broadcast::Receiver<CdpEvent> {
                tokio::sync::broadcast::channel(1).1
            }
        }
        let cdp: Arc<dyn Cdp> = Arc::new(Silent);
        let domain = Arc::new(Mutex::new(NetworkDomain::default()));
        let state = Arc::new(Mutex::new(State::default()));
        let bodies = Arc::new(Mutex::new(NetworkBodyMap::default()));
        let (tx, mut rx) = mpsc::unbounded_channel();
        let send = |e: CdpEvent| handle_event(&cdp, &domain, &state, &bodies, &tx, e);

        send(event("Network.requestWillBeSent", json!({
            "requestId": "9", "type": "Fetch",
            "request": { "url": "http://a/api/slow", "method": "GET", "headers": {} }
        })));
        send(event("Network.loadingFailed", json!({ "requestId": "9", "errorText": "net::ERR_ABORTED", "canceled": true })));
        send(event("Network.requestWillBeSentExtraInfo", json!({ "requestId": "9", "headers": { "cookie": "sid=1" } })));

        let mut failed = None;
        while let Ok(Some(ev)) = tokio::time::timeout(Duration::from_secs(1), rx.recv()).await {
            if let NetworkEvent::Failed { error, request_headers, .. } = ev {
                failed = Some((error, request_headers));
                break;
            }
        }
        let (error, request_headers) = failed.expect("a failed event");
        assert_eq!(error, "net::ERR_ABORTED");
        assert_eq!(request_headers, Some(vec![("cookie".to_string(), "sid=1".to_string())]));
    }

    #[test]
    fn repeated_headers_are_split_again() {
        let mut headers = headers_from(Some(&json!({
            "Set-Cookie": "sid=1; Path=/\ntheme=dark; Path=/",
            "Content-Type": "application/json",
        })));
        headers.sort();
        assert_eq!(
            headers,
            vec![
                ("Content-Type".to_string(), "application/json".to_string()),
                ("Set-Cookie".to_string(), "sid=1; Path=/".to_string()),
                ("Set-Cookie".to_string(), "theme=dark; Path=/".to_string()),
            ]
        );
    }
}