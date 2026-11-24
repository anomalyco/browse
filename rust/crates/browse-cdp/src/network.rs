//! CDP network capture reconciliation.
//!
//! Absorbs all CDP-specific network quirks inside `browse-cdp`:
//! - `Network.enable` / `Network.disable` refcounting shared with offline emulation
//! - `Target.setAutoAttach` child sessions for out-of-process iframes & workers
//! - `RequestWillBeSentExtraInfo` / `ResponseReceivedExtraInfo` wire-header merging
//! - `DataReceived` byte accumulation and `CHILD_DOCUMENT_GRACE` completion
//! - Per-request CDP session lookup for `getRequestPostData` and `getResponseBody`

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine;
use browse_core::{
    BodyKind, CloseReason, DriverResult, FrameId, NetworkEvent, NetworkOptions, NetworkRequest, RequestId,
    ResponseHead, Subscription,
};
use serde_json::{Value, json};
use tokio::sync::{broadcast, mpsc};

use crate::wire::{Cdp, CdpEvent, map_cdp_error};

const CHILD_DOCUMENT_GRACE: Duration = Duration::from_millis(1_000);
const MAX_EXTRA_CACHE: usize = 4_000;

pub(crate) fn enable_params() -> Value {
    json!({ "maxPostDataSize": 65_536 })
}

#[derive(Default)]
pub(crate) struct NetworkDomain {
    pub capture: bool,
    pub offline: bool,
}

#[derive(Default)]
pub(crate) struct NetworkBodyMap {
    /// reported `request_id` -> `(CDP request id, request_session, response_body_session)`
    sessions: HashMap<String, (String, Option<String>, Option<String>)>,
}

impl NetworkBodyMap {
    pub(crate) fn record_request(&mut self, request_id: &str, cdp_id: &str, session: Option<String>) {
        if self.sessions.len() > 2_000 {
            self.sessions.clear();
        }
        self.sessions
            .insert(request_id.to_string(), (cdp_id.to_string(), session.clone(), session));
    }

    pub(crate) fn record_body_session(&mut self, request_id: &str, session: Option<String>) {
        if let Some(entry) = self.sessions.get_mut(request_id) {
            entry.2 = session;
        }
    }

    pub(crate) fn session_for(&self, request_id: &str, kind: BodyKind) -> Option<String> {
        self.sessions.get(request_id).and_then(|(_, req, resp)| match kind {
            BodyKind::Request => req.clone(),
            BodyKind::Response => resp.clone(),
        })
    }

    /// The CDP id to send with `Network.getRequestPostData` / `Network.getResponseBody`: one id covers every hop of
    /// a redirect chain, while each hop is reported under its own id.
    pub(crate) fn cdp_id_for(&self, request_id: &str) -> Option<String> {
        self.sessions.get(request_id).map(|(cdp_id, _, _)| cdp_id.clone())
    }
}

struct Pending {
    /// The id this hop is reported under; unique for every hop of a redirect chain.
    id: String,
    /// CDP's request id, shared by every hop of a redirect chain.
    request_id: String,
    /// This hop's index in the chain (0 for the first).
    hop: usize,
    url: String,
    resource_type: String,
    frame_id: Option<String>,
    data_length: usize,
    response: Option<ResponseHead>,
    /// `responseReceived` said extra-info events (the headers as sent, cookies included) come for it.
    has_extra_info: bool,
    /// An HTTP request sent over the network gets a `requestWillBeSentExtraInfo`; a failed one waits for it.
    expects_request_extra: bool,
}

/// A hop that has ended but whose extra info hasn't arrived yet: CDP may send it after `loadingFinished` /
/// `loadingFailed` / the next redirect hop.
struct Finishing {
    /// CDP's request id of the chain.
    request_id: String,
    ending: Ending,
    expects_request: bool,
    expects_response: bool,
}

enum Ending {
    Finished { body_size: usize },
    Failed { error: String },
}

/// How long a finished request waits for its extra info before it is reported without it.
const EXTRA_INFO_GRACE: std::time::Duration = std::time::Duration::from_millis(250);

struct ExtraResponse {
    headers: Vec<(String, String)>,
    status: Option<i64>,
}

/// Every hop of one CDP request id. CDP reuses the id across redirects and sends each hop's extra info in order, so
/// the k-th `requestWillBeSentExtraInfo` belongs to hop k and the k-th `responseReceivedExtraInfo` to the k-th hop
/// that got a response. `hops` maps those indexes to the ids the hops are reported under.
#[derive(Default)]
struct Chain {
    hops: Vec<String>,
    /// Hop indexes that got a response, in the order they got one.
    responded: Vec<usize>,
    /// How many `requestWillBeSentExtraInfo` events arrived; the next belongs to this hop.
    request_extras: usize,
    /// How many `responseReceivedExtraInfo` events arrived; the next belongs to `responded` at this index.
    response_extras: usize,
    /// Request extra info that arrived before its hop's `requestWillBeSent`, by hop index.
    early_request_extra: HashMap<usize, Vec<(String, String)>>,
}

impl Chain {
    fn record_response(&mut self, hop: usize) {
        if !self.responded.contains(&hop) {
            self.responded.push(hop);
        }
    }
}

#[derive(Default)]
struct State {
    pending: HashMap<(Option<String>, String), Pending>,
    /// CDP request id -> its redirect chain.
    chains: HashMap<String, Chain>,
    /// The reported hop id -> the headers the request went out with.
    request_extra: HashMap<String, Vec<(String, String)>>,
    /// The reported hop id -> the headers the response came with.
    response_extra: HashMap<String, ExtraResponse>,
    children: HashMap<String, String>,
    /// The reported hop id -> an ended hop waiting for its extra info.
    finishing: HashMap<String, Finishing>,
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

    /// Appends a hop to `request_id`'s chain and returns its index, reported id, and any extra info that arrived
    /// before its `requestWillBeSent`.
    fn next_hop(&mut self, request_id: &str) -> (usize, String, Option<Vec<(String, String)>>) {
        let chain = self.chains.entry(request_id.to_string()).or_default();
        let hop = chain.hops.len();
        let id = if hop == 0 { request_id.to_string() } else { format!("{request_id}@{hop}") };
        chain.hops.push(id.clone());
        let early = chain.early_request_extra.remove(&hop);
        (hop, id, early)
    }

    fn record_response(&mut self, request_id: &str, hop: usize) {
        if let Some(chain) = self.chains.get_mut(request_id) {
            chain.record_response(hop);
        }
    }

    /// Files a `requestWillBeSentExtraInfo` under the hop it belongs to (CDP sends them in hop order), which may
    /// not have been announced yet. Returns the hop's reported id when it exists.
    fn set_request_extra(&mut self, request_id: &str, headers: Vec<(String, String)>) -> Option<String> {
        let chain = self.chains.entry(request_id.to_string()).or_default();
        let hop = chain.request_extras;
        chain.request_extras += 1;
        match chain.hops.get(hop).cloned() {
            Some(id) => {
                self.request_extra.insert(id.clone(), headers);
                Some(id)
            }
            None => {
                chain.early_request_extra.insert(hop, headers);
                None
            }
        }
    }

    fn response_extra_hop(&mut self, request_id: &str) -> Option<String> {
        let chain = self.chains.get_mut(request_id)?;
        let index = chain.response_extras;
        chain.response_extras += 1;
        // A response extra can arrive before `responseReceived`; it then belongs to the hop just created.
        let hop = chain.responded.get(index).copied().unwrap_or_else(|| chain.hops.len().saturating_sub(1));
        chain.hops.get(hop).cloned()
    }

    /// Drops a chain once no hop of it is pending or waiting for extra info.
    fn finish_chain(&mut self, request_id: &str) {
        if self.pending.values().any(|pending| pending.request_id == request_id)
            || self.finishing.values().any(|finishing| finishing.request_id == request_id)
        {
            return;
        }
        if let Some(chain) = self.chains.remove(request_id) {
            for id in chain.hops {
                self.request_extra.remove(&id);
                self.response_extra.remove(&id);
            }
        }
    }

    fn synth_response_from_extra(&self, pending: &mut Pending) -> bool {
        if pending.response.is_none()
            && let Some(extra) = self.response_extra.get(&pending.id)
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
    domain.lock().unwrap().capture = true;

    let (tx, rx) = mpsc::unbounded_channel::<NetworkEvent>();
    let state = Arc::new(Mutex::new(State::default()));
    let task_cdp = cdp.clone();
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
                    handle_event(&task_cdp, &task_state, &task_bodies, &task_tx, event);
                }
                Err(broadcast::error::RecvError::Lagged(missed)) => {
                    let _ = task_tx.send(NetworkEvent::Lagged(missed));
                }
                Err(broadcast::error::RecvError::Closed) => break CloseReason::Closed,
            }
        };
        let _ = task_tx.send(NetworkEvent::Closed(reason));
    });

    let _ = cdp
        .send(
            "Target.setAutoAttach",
            json!({ "autoAttach": true, "waitForDebuggerOnStart": false, "flatten": true }),
            None,
        )
        .await;

    let cleanup = Box::new(move || {
        Box::pin(async move {
            let should_disable = {
                let mut guard = domain.lock().unwrap();
                guard.capture = false;
                !guard.offline
            };
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
    let (cdp_id, scope) = {
        let bodies = bodies.lock().unwrap();
        let cdp_id = bodies.cdp_id_for(request_id.as_str()).unwrap_or_else(|| request_id.as_str().to_string());
        (cdp_id, bodies.session_for(request_id.as_str(), kind))
    };
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

fn handle_event(
    cdp: &Arc<dyn Cdp>,
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
            if let Some(redirect) = params.get("redirectResponse")
                && let Some(previous) = st.take_pending(&key)
            {
                // `redirectHasExtraInfo` says whether this hop's extra info was or will be emitted; when it wasn't
                // (a cached redirect), its response head from `redirectResponse` is all there is.
                let has_extra_info = params.get("redirectHasExtraInfo").and_then(Value::as_bool).unwrap_or(false);
                st.record_response(&previous.request_id, previous.hop);
                let head = response_head(redirect);
                let _ = tx.send(NetworkEvent::Response {
                    id: RequestId::from(previous.id.clone()),
                    head,
                    committed: false,
                });
                st.finishing.insert(
                    previous.id.clone(),
                    Finishing {
                        request_id: previous.request_id.clone(),
                        ending: Ending::Finished { body_size: previous.data_length },
                        expects_request: has_extra_info,
                        expects_response: has_extra_info,
                    },
                );
                if has_extra_info {
                    if !flush_finishing(&mut st, tx, &previous.id, false) {
                        flush_after_grace(state, tx, &previous.id);
                    }
                } else {
                    flush_finishing(&mut st, tx, &previous.id, true);
                }
                redirect_of = Some(previous.url);
            }
            let request = params.get("request").cloned().unwrap_or(Value::Null);
            let url = request.get("url").and_then(Value::as_str).unwrap_or("").to_string();
            let method = request.get("method").and_then(Value::as_str).unwrap_or("GET").to_string();
            let resource_type = params.get("type").and_then(Value::as_str).unwrap_or("Other").to_string();
            let frame_id = params.get("frameId").and_then(Value::as_str).map(str::to_string);
            let headers = headers_from(request.get("headers"));
            let post_data = request.get("postData").and_then(Value::as_str).map(str::to_string);
            let has_body = request.get("hasPostData").and_then(Value::as_bool).unwrap_or(false);
            // Each redirect hop is a request of its own, reported under its own id; CDP's request id is shared.
            let (hop, id, early_request_extra) = st.next_hop(&request_id);
            if let Some(headers) = early_request_extra {
                st.request_extra.insert(id.clone(), headers);
            }
            let expects_request_extra = url.starts_with("http://") || url.starts_with("https://");
            bodies.lock().unwrap().record_request(&id, &request_id, event.session_id.clone());
            st.pending.insert(
                key,
                Pending {
                    id: id.clone(),
                    request_id: request_id.clone(),
                    hop,
                    url: url.clone(),
                    resource_type: resource_type.clone(),
                    frame_id: frame_id.clone(),
                    data_length: 0,
                    response: None,
                    has_extra_info: false,
                    expects_request_extra,
                },
            );
            drop(st);
            let _ = tx.send(NetworkEvent::Request(NetworkRequest {
                id: RequestId::from(id),
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
            if let Some(id) = st.set_request_extra(&request_id, headers_from(params.get("headers"))) {
                flush_finishing(&mut st, tx, &id, false);
            }
        }
        "Network.responseReceivedExtraInfo" => {
            let mut st = state.lock().unwrap();
            if st.response_extra.len() > MAX_EXTRA_CACHE {
                st.response_extra.clear();
            }
            if let Some(id) = st.response_extra_hop(&request_id) {
                st.response_extra.insert(
                    id.clone(),
                    ExtraResponse {
                        headers: headers_from(params.get("headers")),
                        status: params.get("statusCode").and_then(Value::as_i64),
                    },
                );
                flush_finishing(&mut st, tx, &id, false);
            }
        }
        "Network.responseReceived" => {
            let Some(head) = params.get("response").map(response_head) else { return };
            let mut st = state.lock().unwrap();
            if let Some(found) = st.pending_key(&key) {
                let (id, request_id, hop, resource_type, frame_id) = {
                    let Some(pending) = st.pending.get_mut(&found) else { return };
                    pending.response = Some(head.clone());
                    pending.has_extra_info = params.get("hasExtraInfo").and_then(Value::as_bool).unwrap_or(false);
                    (
                        pending.id.clone(),
                        pending.request_id.clone(),
                        pending.hop,
                        pending.resource_type.clone(),
                        pending.frame_id.clone(),
                    )
                };
                st.record_response(&request_id, hop);
                bodies.lock().unwrap().record_body_session(&id, event.session_id.clone());
                let committed = resource_type == "Document"
                    && frame_id.as_ref().is_some_and(|f| st.children.contains_key(f));
                drop(st);
                let _ = tx.send(NetworkEvent::Response { id: RequestId::from(id), head, committed });
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
                bodies.lock().unwrap().record_body_session(&pending.id, event.session_id.clone());
                let id = pending.id.clone();
                st.finishing.insert(
                    id.clone(),
                    Finishing {
                        request_id: pending.request_id.clone(),
                        ending: Ending::Finished { body_size: pending.data_length },
                        expects_request: pending.has_extra_info,
                        expects_response: pending.has_extra_info,
                    },
                );
                if pending.has_extra_info {
                    if !flush_finishing(&mut st, tx, &id, false) {
                        flush_after_grace(state, tx, &id);
                    }
                } else {
                    flush_finishing(&mut st, tx, &id, true);
                }
            }
        }
        "Network.loadingFailed" => {
            let mut st = state.lock().unwrap();
            if let Some(pending) = st.take_pending(&key) {
                // A request that reached the network and failed later (aborted, reset) still went out with the
                // headers its extra info reported; wait for that extra info as a finish does.
                let error = params
                    .get("errorText")
                    .and_then(Value::as_str)
                    .filter(|text| !text.is_empty())
                    .unwrap_or("Request failed")
                    .to_string();
                let id = pending.id.clone();
                st.finishing.insert(
                    id.clone(),
                    Finishing {
                        request_id: pending.request_id.clone(),
                        ending: Ending::Failed { error },
                        expects_request: pending.expects_request_extra,
                        expects_response: false,
                    },
                );
                if pending.expects_request_extra {
                    if !flush_finishing(&mut st, tx, &id, false) {
                        flush_after_grace(state, tx, &id);
                    }
                } else {
                    flush_finishing(&mut st, tx, &id, true);
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
                                    id: RequestId::from(p.id.clone()),
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
                let state = state.clone();
                let tx = tx.clone();
                tokio::spawn(async move {
                    let _ = cdp.send("Network.enable", enable_params(), Some(&session)).await;
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
            }
        }
        _ => {}
    }
}

/// Reports an ended hop once its expected extra info is in (or, with `anyway`, with what there is).
fn flush_finishing(st: &mut State, tx: &mpsc::UnboundedSender<NetworkEvent>, id: &str, anyway: bool) -> bool {
    let Some(finishing) = st.finishing.get(id) else { return false };
    let complete = (!finishing.expects_request || st.request_extra.contains_key(id))
        && (!finishing.expects_response || st.response_extra.contains_key(id));
    if !anyway && !complete {
        return false;
    }
    let Some(finishing) = st.finishing.remove(id) else { return false };
    let request_headers = st.request_extra.remove(id).filter(|h| !h.is_empty());
    let request_id = finishing.request_id.clone();
    match finishing.ending {
        Ending::Finished { body_size } => {
            let response_headers = st.response_extra.remove(id).map(|e| e.headers).filter(|h| !h.is_empty());
            let _ = tx.send(NetworkEvent::Finished {
                id: RequestId::from(id.to_string()),
                body_size,
                request_headers,
                response_headers,
            });
        }
        Ending::Failed { error } => {
            st.response_extra.remove(id);
            let _ = tx.send(NetworkEvent::Failed {
                id: RequestId::from(id.to_string()),
                error,
                request_headers,
            });
        }
    }
    st.finish_chain(&request_id);
    true
}

/// Reports a hop after the grace period with whatever extra info has arrived, so a missing event can't hold it
/// forever.
fn flush_after_grace(state: &Arc<Mutex<State>>, tx: &mpsc::UnboundedSender<NetworkEvent>, id: &str) {
    let state = state.clone();
    let tx = tx.clone();
    let id = id.to_string();
    tokio::spawn(async move {
        tokio::time::sleep(EXTRA_INFO_GRACE).await;
        flush_finishing(&mut state.lock().unwrap(), &tx, &id, true);
    });
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
                let req_extra = st.request_extra.remove(&pending.id).filter(|h| !h.is_empty());
                let resp_extra = st.response_extra.remove(&pending.id).map(|e| e.headers).filter(|h| !h.is_empty());
                let request_id = pending.request_id.clone();
                let id = RequestId::from(pending.id);
                if let Some(head) = pending.response {
                    events_to_send.push(NetworkEvent::Response { id: id.clone(), head, committed: true });
                }
                events_to_send.push(NetworkEvent::Finished {
                    id,
                    body_size: pending.data_length,
                    request_headers: req_extra,
                    response_headers: resp_extra,
                });
                st.finish_chain(&request_id);
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
        let state = Arc::new(Mutex::new(State::default()));
        let bodies = Arc::new(Mutex::new(NetworkBodyMap::default()));
        let (tx, mut rx) = mpsc::unbounded_channel();
        let send = |e: CdpEvent| handle_event(&cdp, &state, &bodies, &tx, e);
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

    async fn take_endings(rx: &mut mpsc::UnboundedReceiver<NetworkEvent>, count: usize) -> Vec<NetworkEvent> {
        let mut events = Vec::new();
        let mut endings = 0;
        while endings < count {
            let Ok(Some(event)) = tokio::time::timeout(std::time::Duration::from_secs(1), rx.recv()).await else {
                break;
            };
            if matches!(event, NetworkEvent::Finished { .. } | NetworkEvent::Failed { .. }) {
                endings += 1;
            }
            events.push(event);
        }
        events
    }

    type Headers = Option<Vec<(String, String)>>;

    fn finished(events: &[NetworkEvent], id: &str) -> Option<(Headers, Headers)> {
        events.iter().find_map(|event| match event {
            NetworkEvent::Finished { id: found, request_headers, response_headers, .. } if found.as_str() == id => {
                Some((request_headers.clone(), response_headers.clone()))
            }
            _ => None,
        })
    }

    fn response(events: &[NetworkEvent], id: &str) -> Option<ResponseHead> {
        events.iter().find_map(|event| match event {
            NetworkEvent::Response { id: found, head, .. } if found.as_str() == id => Some(head.clone()),
            _ => None,
        })
    }

    fn sorted(headers: Headers) -> Headers {
        headers.map(|mut headers| {
            headers.sort();
            headers
        })
    }

    /// CDP doesn't guarantee `requestWillBeSent` comes before its `requestWillBeSentExtraInfo`.
    #[tokio::test]
    async fn early_request_extra_info_reaches_the_request() {
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
        let state = Arc::new(Mutex::new(State::default()));
        let bodies = Arc::new(Mutex::new(NetworkBodyMap::default()));
        let (tx, mut rx) = mpsc::unbounded_channel();
        let send = |e: CdpEvent| handle_event(&cdp, &state, &bodies, &tx, e);
        send(event("Network.requestWillBeSentExtraInfo", json!({ "requestId": "1", "headers": { "Cookie": "sid=1" } })));
        send(event("Network.requestWillBeSent", json!({ "requestId": "1", "type": "Fetch", "request": { "url": "http://a/x", "method": "GET", "headers": {} } })));
        send(event("Network.responseReceived", json!({ "requestId": "1", "response": { "status": 200, "headers": {} } })));
        send(event("Network.loadingFinished", json!({ "requestId": "1" })));
        let events = take_endings(&mut rx, 1).await;
        let (request_headers, _) = finished(&events, "1").expect("the finished request");
        assert_eq!(sorted(request_headers), Some(vec![("Cookie".to_string(), "sid=1".to_string())]));
    }

    /// CDP reuses one request id for every hop of a redirect. Extra info for the redirect hop can arrive after the
    /// next hop's `requestWillBeSent`; it must stay with the hop it describes.
    #[tokio::test]
    async fn redirect_hops_keep_their_own_extra_info() {
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
        let state = Arc::new(Mutex::new(State::default()));
        let bodies = Arc::new(Mutex::new(NetworkBodyMap::default()));
        let (tx, mut rx) = mpsc::unbounded_channel();
        let send = |e: CdpEvent| handle_event(&cdp, &state, &bodies, &tx, e);
        send(event("Network.requestWillBeSent", json!({ "requestId": "1", "type": "Fetch", "request": { "url": "http://a/api/hop", "method": "GET", "headers": {} } })));
        send(event(
            "Network.requestWillBeSent",
            json!({
                "requestId": "1",
                "type": "Fetch",
                "redirectHasExtraInfo": true,
                "redirectResponse": { "status": 302, "statusText": "Found", "headers": { "Location": "/api/landed", "Content-Type": "text/plain", "Content-Length": "0" } },
                "request": { "url": "http://a/api/landed", "method": "GET", "headers": {} },
            }),
        ));
        // The hop's extra info lands after the redirect made the landed request the current one.
        send(event("Network.requestWillBeSentExtraInfo", json!({ "requestId": "1", "headers": { "Cookie": "sid=hop" } })));
        send(event(
            "Network.responseReceivedExtraInfo",
            json!({ "requestId": "1", "statusCode": 302, "headers": { "Location": "/api/landed", "Content-Type": "text/plain", "Content-Length": "0" } }),
        ));
        send(event("Network.responseReceived", json!({ "requestId": "1", "hasExtraInfo": true, "response": { "status": 200, "statusText": "OK", "headers": {} } })));
        send(event("Network.requestWillBeSentExtraInfo", json!({ "requestId": "1", "headers": { "Cookie": "sid=landed" } })));
        send(event(
            "Network.responseReceivedExtraInfo",
            json!({ "requestId": "1", "statusCode": 200, "headers": { "Content-Type": "application/json", "Content-Length": "15" } }),
        ));
        send(event("Network.loadingFinished", json!({ "requestId": "1" })));
        let events = take_endings(&mut rx, 2).await;
        assert_eq!(response(&events, "1").map(|head| head.status), Some(302));
        assert_eq!(response(&events, "1@1").map(|head| head.status), Some(200));
        let (request_headers, response_headers) = finished(&events, "1").expect("the redirect hop's finish");
        assert_eq!(sorted(request_headers), Some(vec![("Cookie".to_string(), "sid=hop".to_string())]));
        assert_eq!(
            sorted(response_headers),
            Some(vec![
                ("Content-Length".to_string(), "0".to_string()),
                ("Content-Type".to_string(), "text/plain".to_string()),
                ("Location".to_string(), "/api/landed".to_string()),
            ])
        );
        let (request_headers, response_headers) = finished(&events, "1@1").expect("the landed request's finish");
        assert_eq!(sorted(request_headers), Some(vec![("Cookie".to_string(), "sid=landed".to_string())]));
        assert_eq!(
            sorted(response_headers),
            Some(vec![
                ("Content-Length".to_string(), "15".to_string()),
                ("Content-Type".to_string(), "application/json".to_string()),
            ])
        );
    }

    /// A request can fail before its request extra info arrives; the failure still reports the headers it went out
    /// with.
    #[tokio::test]
    async fn late_request_extra_info_still_reaches_the_failed_request() {
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
        let state = Arc::new(Mutex::new(State::default()));
        let bodies = Arc::new(Mutex::new(NetworkBodyMap::default()));
        let (tx, mut rx) = mpsc::unbounded_channel();
        let send = |e: CdpEvent| handle_event(&cdp, &state, &bodies, &tx, e);
        send(event("Network.requestWillBeSent", json!({ "requestId": "1", "type": "Fetch", "request": { "url": "http://a/api/slow", "method": "GET", "headers": {} } })));
        send(event("Network.loadingFailed", json!({ "requestId": "1", "errorText": "net::ERR_ABORTED" })));
        send(event("Network.requestWillBeSentExtraInfo", json!({ "requestId": "1", "headers": { "Cookie": "sid=1" } })));
        let events = take_endings(&mut rx, 1).await;
        let (request_headers, _) = events
            .iter()
            .find_map(|event| match event {
                NetworkEvent::Failed { id, request_headers, .. } if id.as_str() == "1" => Some((request_headers.clone(), ())),
                _ => None,
            })
            .expect("the failed request");
        assert_eq!(sorted(request_headers), Some(vec![("Cookie".to_string(), "sid=1".to_string())]));
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