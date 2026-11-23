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
    /// `request_id` -> `(request_session, response_body_session)`
    sessions: HashMap<String, (Option<String>, Option<String>)>,
}

impl NetworkBodyMap {
    pub(crate) fn record_request(&mut self, request_id: &str, session: Option<String>) {
        if self.sessions.len() > 2_000 {
            self.sessions.clear();
        }
        self.sessions
            .insert(request_id.to_string(), (session.clone(), session));
    }

    pub(crate) fn record_body_session(&mut self, request_id: &str, session: Option<String>) {
        if let Some(entry) = self.sessions.get_mut(request_id) {
            entry.1 = session;
        }
    }

    pub(crate) fn session_for(&self, request_id: &str, kind: BodyKind) -> Option<String> {
        self.sessions.get(request_id).and_then(|(req, resp)| match kind {
            BodyKind::Request => req.clone(),
            BodyKind::Response => resp.clone(),
        })
    }
}

struct Pending {
    request_id: String,
    url: String,
    resource_type: String,
    frame_id: Option<String>,
    data_length: usize,
    response: Option<ResponseHead>,
}

struct ExtraResponse {
    headers: Vec<(String, String)>,
    status: Option<i64>,
}

#[derive(Default)]
struct State {
    pending: HashMap<(Option<String>, String), Pending>,
    request_extra: HashMap<String, Vec<(String, String)>>,
    response_extra: HashMap<String, ExtraResponse>,
    children: HashMap<String, String>,
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

    fn synth_response_from_extra(&self, pending: &mut Pending) -> bool {
        if pending.response.is_none()
            && let Some(extra) = self.response_extra.get(&pending.request_id)
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
    let scope = bodies.lock().unwrap().session_for(request_id.as_str(), kind);
    match kind {
        BodyKind::Request => {
            let value = cdp
                .send(
                    "Network.getRequestPostData",
                    json!({ "requestId": request_id.as_str() }),
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
                    json!({ "requestId": request_id.as_str() }),
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

fn headers_from(value: Option<&Value>) -> Vec<(String, String)> {
    value
        .and_then(Value::as_object)
        .map(|map| {
            map.iter()
                .map(|(name, value)| {
                    (name.clone(), value.as_str().map_or_else(|| value.to_string(), str::to_string))
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
                let req_extra = st.request_extra.remove(&previous.request_id).filter(|h| !h.is_empty());
                let resp_extra = st.response_extra.remove(&previous.request_id).map(|e| e.headers).filter(|h| !h.is_empty());
                let head = response_head(redirect);
                let prev_id = RequestId::from(previous.request_id.clone());
                let _ = tx.send(NetworkEvent::Response { id: prev_id.clone(), head, committed: false });
                let _ = tx.send(NetworkEvent::Finished {
                    id: prev_id,
                    body_size: previous.data_length,
                    request_headers: req_extra,
                    response_headers: resp_extra,
                });
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
            bodies.lock().unwrap().record_request(&request_id, event.session_id.clone());
            st.pending.insert(
                key,
                Pending {
                    request_id: request_id.clone(),
                    url: url.clone(),
                    resource_type: resource_type.clone(),
                    frame_id: frame_id.clone(),
                    data_length: 0,
                    response: None,
                },
            );
            drop(st);
            let _ = tx.send(NetworkEvent::Request(NetworkRequest {
                id: RequestId::from(request_id),
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
            st.request_extra.insert(request_id, headers_from(params.get("headers")));
        }
        "Network.responseReceivedExtraInfo" => {
            let mut st = state.lock().unwrap();
            if st.response_extra.len() > MAX_EXTRA_CACHE {
                st.response_extra.clear();
            }
            st.response_extra.insert(
                request_id,
                ExtraResponse {
                    headers: headers_from(params.get("headers")),
                    status: params.get("statusCode").and_then(Value::as_i64),
                },
            );
        }
        "Network.responseReceived" => {
            let Some(head) = params.get("response").map(response_head) else { return };
            bodies.lock().unwrap().record_body_session(&request_id, event.session_id.clone());
            let mut st = state.lock().unwrap();
            if let Some(found) = st.pending_key(&key) {
                let (id, resource_type, frame_id) = {
                    let Some(pending) = st.pending.get_mut(&found) else { return };
                    pending.response = Some(head.clone());
                    (
                        RequestId::from(pending.request_id.clone()),
                        pending.resource_type.clone(),
                        pending.frame_id.clone(),
                    )
                };
                let committed = resource_type == "Document"
                    && frame_id.as_ref().is_some_and(|f| st.children.contains_key(f));
                drop(st);
                let _ = tx.send(NetworkEvent::Response { id, head, committed });
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
            bodies.lock().unwrap().record_body_session(&request_id, event.session_id.clone());
            let mut st = state.lock().unwrap();
            if let Some(pending) = st.take_pending(&key) {
                let req_extra = st.request_extra.remove(&pending.request_id).filter(|h| !h.is_empty());
                let resp_extra = st
                    .response_extra
                    .remove(&pending.request_id)
                    .map(|e| e.headers)
                    .filter(|h| !h.is_empty());
                let id = RequestId::from(pending.request_id);
                let body_size = pending.data_length;
                drop(st);
                let _ = tx.send(NetworkEvent::Finished {
                    id,
                    body_size,
                    request_headers: req_extra,
                    response_headers: resp_extra,
                });
            }
        }
        "Network.loadingFailed" => {
            let mut st = state.lock().unwrap();
            if let Some(pending) = st.take_pending(&key) {
                st.request_extra.remove(&pending.request_id);
                st.response_extra.remove(&pending.request_id);
                let error = params
                    .get("errorText")
                    .and_then(Value::as_str)
                    .filter(|text| !text.is_empty())
                    .unwrap_or("Request failed")
                    .to_string();
                let id = RequestId::from(pending.request_id);
                drop(st);
                let _ = tx.send(NetworkEvent::Failed { id, error });
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
                                    id: RequestId::from(p.request_id.clone()),
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
                let req_extra = st.request_extra.remove(&pending.request_id).filter(|h| !h.is_empty());
                let resp_extra = st
                    .response_extra
                    .remove(&pending.request_id)
                    .map(|e| e.headers)
                    .filter(|h| !h.is_empty());
                let id = RequestId::from(pending.request_id);
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
