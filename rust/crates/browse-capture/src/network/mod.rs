//! A tab's network capture over the CDP Network domain (port of cli/src/network-capture.ts).

mod model;

pub use model::{CapturedEntry, finish};

use std::sync::Weak;

use std::collections::HashMap;
use std::sync::{Arc, Mutex as SyncMutex};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use base64::Engine;
use browse_core::{Cdp, CdpEvent, TabId, TabState, Tool, ToolContext, ToolOutput, ToolSpec};
use serde::Serialize;
use serde_json::{Value, json};
use tokio::sync::{Semaphore, broadcast};

use crate::redaction::Header;
use crate::state::{BusyGuard, TaskGuard};
use crate::{arg_action, arg_bool, arg_int, arg_str, bail_user, json_output, respond, state, tab_schema, target_tab};
use model::{Budget, CapturedRequest, CapturedResponse, MAX_ENTRIES, body_can_fit, content_type, is_returnable_mime_type};

const DEFAULT_MAX_DURATION_MS: i64 = 30 * 60_000;
const MAX_FINALIZERS: usize = 4;
/// How long an out-of-process iframe's own Network events get before its document is completed from what is known.
const CHILD_DOCUMENT_GRACE: Duration = Duration::from_millis(1_000);

#[derive(Default)]
pub(crate) struct NetworkState {
    active: Option<Active>,
    /// Why the last capture ended on its own, shown by status and by a stop that comes too late.
    ended: Option<String>,
    /// What a capture whose tab went away had captured, returned by the next stop.
    ended_result: Option<Value>,
}

struct Active {
    tab: TabId,
    started_at: String,
    ends_at: String,
    shared: Arc<Shared>,
    _events: TaskGuard,
    _expiry: TaskGuard,
    _busy: BusyGuard,
    state: Arc<TabState>,
}

/// Shared with browse-page: it keeps the Network domain on while a capture runs, and capture leaves it on while
/// offline emulation (which needs it) is active.
const CAPTURE_KEY: &str = "browse.network.capture";
const OFFLINE_KEY: &str = "browse.network.offline";

async fn set_capture_flag(state: &TabState, on: bool) {
    state.inner().lock().await.insert(CAPTURE_KEY.into(), Box::new(on));
}

impl Drop for Active {
    /// However the capture ends, turn the Network domain back off unless offline emulation still needs it.
    fn drop(&mut self) {
        let cdp = self.shared.cdp.clone();
        let state = self.state.clone();
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                set_capture_flag(&state, false).await;
                let offline = state.inner().lock().await.get(OFFLINE_KEY).and_then(|v| v.downcast_ref::<bool>()).copied().unwrap_or(false);
                if !offline {
                    let _ = cdp.send("Network.disable", json!({}), None).await;
                }
            });
        }
    }
}

#[derive(Default)]
struct Filters {
    url: Option<String>,
    resource_types: Vec<String>,
    methods: Vec<String>,
    bodies: bool,
}

struct Shared {
    cdp: Arc<dyn Cdp>,
    filters: Filters,
    inner: SyncMutex<Inner>,
    finalizers: Semaphore,
    in_flight: tokio::sync::watch::Sender<usize>,
}

/// A request's CDP session and requestId. Chrome reports some requests across sessions (an out-of-process iframe's
/// document is requested on the parent's session and loaded on the iframe's), so lookups fall back to the requestId.
type Key = (Option<String>, String);

#[derive(Default)]
struct Inner {
    pending: HashMap<Key, Pending>,
    /// By requestId.
    request_extra: HashMap<String, Vec<Header>>,
    response_extra: HashMap<String, ExtraResponse>,
    /// Out-of-process iframes and workers attached to the tab: target id → session.
    children: HashMap<String, String>,
    entries: Vec<CapturedEntry>,
    next_id: usize,
    budget: Budget,
    dropped_entry_count: usize,
    missed_event_count: u64,
    stopping: bool,
}

impl Inner {
    fn pending_key(&self, key: &Key) -> Option<Key> {
        if self.pending.contains_key(key) {
            return Some(key.clone());
        }
        self.pending.keys().find(|other| other.1 == key.1).cloned()
    }

    fn take_pending(&mut self, key: &Key) -> Option<Pending> {
        let key = self.pending_key(key)?;
        self.pending.remove(&key)
    }

    /// A document request that was handed to an out-of-process iframe. Through chrome.debugger the iframe's session
    /// attaches without waiting for the debugger, so its response and loadingFinished can come before its Network
    /// domain is on and never arrive. Its status is known from the raw response headers (ExtraInfo) or a
    /// responseReceived, and the attached iframe means the document was committed.
    fn committed_in_child(&self, pending: &Pending) -> bool {
        pending.resource_type == "Document" && pending.frame_id.as_ref().is_some_and(|frame| self.children.contains_key(frame))
    }

    /// Fills in a missing response from ExtraInfo; true when the request now has one.
    fn known_response(&self, pending: &mut Pending) -> bool {
        if pending.response.is_none()
            && let Some(extra) = self.response_extra.get(&pending.request_id)
            && let Some(status) = extra.status
        {
            pending.response = Some(ResponseInfo {
                status,
                status_text: String::new(),
                headers: extra.headers.clone(),
                mime_type: model::content_type(&extra.headers).map(|mime| mime.split(';').next().unwrap_or("").trim().to_string()),
            });
        }
        pending.response.is_some()
    }
}

/// Raw response headers and status from Network.responseReceivedExtraInfo.
struct ExtraResponse {
    headers: Vec<Header>,
    status: Option<i64>,
}

struct Pending {
    id: String,
    started: Instant,
    started_date_time: String,
    session: Option<String>,
    /// The session the response arrived on; its Network domain holds the body.
    body_session: Option<String>,
    request_id: String,
    method: String,
    url: String,
    headers: Vec<Header>,
    resource_type: String,
    post_data: Option<String>,
    has_post_data: bool,
    redirected_from: Option<String>,
    response: Option<ResponseInfo>,
    failure: Option<String>,
    /// Decoded body bytes reported by Network.dataReceived.
    data_length: usize,
    /// The frame that made the request (for an iframe's document, the iframe; an out-of-process iframe's target id).
    frame_id: Option<String>,
}

#[derive(Clone)]
struct ResponseInfo {
    status: i64,
    status_text: String,
    headers: Vec<Header>,
    mime_type: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Status {
    active: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    tab: Option<TabId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    started_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ends_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ended: Option<String>,
    entry_count: usize,
    pending_count: usize,
    response_count: usize,
    failure_count: usize,
    captured_body_bytes: usize,
    truncated_body_count: usize,
    dropped_entry_count: usize,
    #[serde(skip_serializing_if = "is_zero")]
    missed_event_count: u64,
}

fn is_zero(value: &u64) -> bool {
    *value == 0
}

fn headers_from(value: Option<&Value>) -> Vec<Header> {
    value
        .and_then(Value::as_object)
        .map(|map| {
            map.iter()
                .map(|(name, value)| Header { name: name.clone(), value: value.as_str().map_or_else(|| value.to_string(), str::to_string) })
                .collect()
        })
        .unwrap_or_default()
}

fn response_info(value: &Value) -> ResponseInfo {
    ResponseInfo {
        status: value.get("status").and_then(Value::as_i64).unwrap_or(0),
        status_text: value.get("statusText").and_then(Value::as_str).unwrap_or("").to_string(),
        headers: headers_from(value.get("headers")),
        mime_type: value.get("mimeType").and_then(Value::as_str).filter(|mime| !mime.is_empty()).map(str::to_string),
    }
}

fn status_of(state: &NetworkState) -> Status {
    let Some(active) = &state.active else {
        let ended = state.ended_result.as_ref();
        let count = |key: &str| ended.and_then(|result| result.get(key)).and_then(Value::as_u64).unwrap_or(0) as usize;
        return Status {
            active: false,
            tab: None,
            started_at: None,
            ends_at: None,
            ended: state.ended.clone(),
            entry_count: count("entryCount"),
            pending_count: 0,
            response_count: count("responseCount"),
            failure_count: count("failureCount"),
            captured_body_bytes: count("capturedBodyBytes"),
            truncated_body_count: count("truncatedBodyCount"),
            dropped_entry_count: count("droppedEntryCount"),
            missed_event_count: count("missedEventCount") as u64,
        };
    };
    let inner = active.shared.inner.lock().unwrap();
    Status {
        active: true,
        tab: Some(active.tab),
        started_at: Some(active.started_at.clone()),
        ends_at: Some(active.ends_at.clone()),
        ended: None,
        entry_count: inner.entries.len(),
        pending_count: inner.pending.len(),
        response_count: inner.entries.iter().filter(|entry| entry.response.is_some()).count(),
        failure_count: inner.entries.iter().filter(|entry| entry.failure.is_some()).count(),
        captured_body_bytes: inner.budget.captured_body_bytes,
        truncated_body_count: inner.budget.truncated_body_count,
        dropped_entry_count: inner.dropped_entry_count,
        missed_event_count: inner.missed_event_count,
    }
}

impl Shared {
    fn matches(&self, url: &str, resource_type: &str, method: &str) -> bool {
        self.filters.url.as_ref().is_none_or(|filter| url.contains(filter.as_str()))
            && (self.filters.resource_types.is_empty()
                || self.filters.resource_types.iter().any(|kind| kind.eq_ignore_ascii_case(resource_type)))
            && (self.filters.methods.is_empty() || self.filters.methods.iter().any(|m| m.eq_ignore_ascii_case(method)))
    }

    fn handle(self: &Arc<Self>, event: CdpEvent) {
        let params = &event.params;
        let request_id = params.get("requestId").and_then(Value::as_str).unwrap_or("").to_string();
        let key: Key = (event.session_id.clone(), request_id.clone());
        let mut inner = self.inner.lock().unwrap();
        if inner.stopping {
            return;
        }
        match event.method.as_str() {
            "Network.requestWillBeSent" => {
                let mut redirected_from = None;
                if let Some(redirect) = params.get("redirectResponse")
                    && let Some(mut previous) = inner.take_pending(&key)
                {
                    previous.response = Some(response_info(redirect));
                    redirected_from = Some(previous.url.clone());
                    drop(inner);
                    self.finalize(previous);
                    inner = self.inner.lock().unwrap();
                }
                let request = params.get("request").cloned().unwrap_or(Value::Null);
                let url = request.get("url").and_then(Value::as_str).unwrap_or("").to_string();
                let method = request.get("method").and_then(Value::as_str).unwrap_or("GET").to_string();
                let resource_type = params.get("type").and_then(Value::as_str).unwrap_or("Other").to_string();
                if !self.matches(&url, &resource_type, &method) {
                    inner.request_extra.remove(&request_id);
                    inner.response_extra.remove(&request_id);
                    return;
                }
                if inner.entries.len() + inner.pending.len() >= MAX_ENTRIES {
                    inner.dropped_entry_count += 1;
                    return;
                }
                inner.next_id += 1;
                let id = format!("request-{}", inner.next_id);
                let pending = Pending {
                    id,
                    started: Instant::now(),
                    started_date_time: crate::now_iso(),
                    session: event.session_id.clone(),
                    body_session: event.session_id.clone(),
                    request_id,
                    url,
                    method,
                    headers: headers_from(request.get("headers")),
                    resource_type,
                    post_data: request.get("postData").and_then(Value::as_str).map(str::to_string),
                    has_post_data: request.get("hasPostData").and_then(Value::as_bool).unwrap_or(false),
                    redirected_from,
                    response: None,
                    failure: None,
                    data_length: 0,
                    frame_id: params.get("frameId").and_then(Value::as_str).map(str::to_string),
                };
                inner.pending.insert(key, pending);
            }
            "Network.requestWillBeSentExtraInfo" => {
                if inner.request_extra.len() > 4 * MAX_ENTRIES {
                    inner.request_extra.clear();
                }
                inner.request_extra.insert(request_id, headers_from(params.get("headers")));
            }
            "Network.responseReceivedExtraInfo" => {
                if inner.response_extra.len() > 4 * MAX_ENTRIES {
                    inner.response_extra.clear();
                }
                let extra = ExtraResponse {
                    headers: headers_from(params.get("headers")),
                    status: params.get("statusCode").and_then(Value::as_i64),
                };
                inner.response_extra.insert(request_id, extra);
            }
            "Network.responseReceived" => {
                if let Some(found) = inner.pending_key(&key)
                    && let Some(pending) = inner.pending.get_mut(&found)
                {
                    pending.response = params.get("response").map(response_info);
                    pending.body_session = event.session_id.clone();
                }
            }
            "Network.dataReceived" => {
                if let Some(found) = inner.pending_key(&key)
                    && let Some(pending) = inner.pending.get_mut(&found)
                {
                    pending.data_length += params.get("dataLength").and_then(Value::as_u64).unwrap_or(0) as usize;
                }
            }
            "Network.loadingFinished" => {
                if let Some(mut pending) = inner.take_pending(&key) {
                    pending.body_session = event.session_id.clone();
                    drop(inner);
                    self.finalize(pending);
                }
            }
            "Network.loadingFailed" => {
                if let Some(mut pending) = inner.take_pending(&key) {
                    let text = params.get("errorText").and_then(Value::as_str).filter(|text| !text.is_empty());
                    pending.failure = Some(text.unwrap_or("Request failed").to_string());
                    drop(inner);
                    self.finalize(pending);
                }
            }
            "Target.attachedToTarget" => {
                // Out-of-process iframes and workers have their own Network domain.
                if let Some(session) = params.get("sessionId").and_then(Value::as_str) {
                    let session = session.to_string();
                    let target = params.pointer("/targetInfo/targetId").and_then(Value::as_str).map(str::to_string);
                    if let Some(target) = &target {
                        inner.children.insert(target.clone(), session.clone());
                    }
                    drop(inner);
                    let shared = self.clone();
                    tokio::spawn(async move {
                        let _ = shared.cdp.send("Network.enable", network_enable_params(), Some(&session)).await;
                        // Give the iframe's own events a moment, then complete its document from what is known.
                        tokio::time::sleep(CHILD_DOCUMENT_GRACE).await;
                        if let Some(target) = target {
                            shared.complete_child_documents(&target);
                        }
                    });
                }
            }
            "Target.detachedFromTarget" => {
                if let Some(session) = params.get("sessionId").and_then(Value::as_str) {
                    inner.children.retain(|_, child| child != session);
                }
            }
            _ => {}
        }
    }

    /// Completes document requests committed in the out-of-process iframe `target` whose response is known.
    fn complete_child_documents(self: &Arc<Self>, target: &str) {
        let ready: Vec<Pending> = {
            let mut inner = self.inner.lock().unwrap();
            if inner.stopping {
                return;
            }
            let keys: Vec<Key> = inner
                .pending
                .iter()
                .filter(|(_, pending)| pending.resource_type == "Document" && pending.frame_id.as_deref() == Some(target))
                .map(|(key, _)| key.clone())
                .collect();
            let mut ready = Vec::new();
            for key in keys {
                let Some(mut pending) = inner.pending.remove(&key) else { continue };
                if inner.known_response(&mut pending) {
                    ready.push(pending);
                } else {
                    inner.pending.insert(key, pending);
                }
            }
            ready
        };
        for pending in ready {
            self.finalize(pending);
        }
    }

    /// Fetches the exchange's headers and bodies and records it, at most `MAX_FINALIZERS` at a time.
    fn finalize(self: &Arc<Self>, pending: Pending) {
        let shared = self.clone();
        shared.in_flight.send_modify(|count| *count += 1);
        tokio::spawn(async move {
            let permit = shared.finalizers.acquire().await;
            let entry = shared.build_entry(pending).await;
            shared.inner.lock().unwrap().entries.push(entry);
            drop(permit);
            shared.in_flight.send_modify(|count| *count -= 1);
        });
    }

    async fn build_entry(&self, pending: Pending) -> CapturedEntry {
        let (request_headers, response_headers) = {
            let mut inner = self.inner.lock().unwrap();
            (
                inner.request_extra.remove(&pending.request_id),
                inner.response_extra.remove(&pending.request_id).map(|extra| extra.headers),
            )
        };
        // ExtraInfo headers are the raw ones on the wire, cookies included; prefer them.
        let request_headers = request_headers.filter(|headers| !headers.is_empty()).unwrap_or(pending.headers.clone());
        let request_body = if self.filters.bodies { self.request_body(&pending, &request_headers).await } else { None };
        let response = match &pending.response {
            None => None,
            Some(info) => {
                let headers = response_headers.filter(|headers| !headers.is_empty()).unwrap_or(info.headers.clone());
                let body = if self.filters.bodies { self.response_body(&pending, info, &headers).await } else { None };
                Some(CapturedResponse { status: info.status, status_text: info.status_text.clone(), headers, body })
            }
        };
        CapturedEntry {
            id: pending.id,
            started_date_time: pending.started_date_time,
            duration_ms: pending.started.elapsed().as_millis() as u64,
            request: CapturedRequest {
                method: pending.method,
                url: pending.url,
                headers: request_headers,
                resource_type: pending.resource_type,
                body: request_body,
                redirected_from: pending.redirected_from,
            },
            response,
            failure: pending.failure,
        }
    }

    /// The request body: returned as text when it's a kind redaction can check, else only described. Bodies that
    /// won't be returned are never fetched.
    async fn request_body(&self, pending: &Pending, headers: &[Header]) -> Option<model::CapturedBody> {
        let mime = content_type(headers);
        let declared = model::declared_body_size(headers);
        let size = pending.post_data.as_ref().map(String::len).or(declared);
        if size == Some(0) || (size.is_none() && !pending.has_post_data) {
            return None;
        }
        if !is_returnable_mime_type(mime.as_deref()) {
            return Some(self.inner.lock().unwrap().budget.omitted(mime.as_deref(), size, model::NOT_RETURNED, false));
        }
        let text = match &pending.post_data {
            Some(text) => Some(text.clone()),
            None => {
                let limit = self.inner.lock().unwrap().budget.remaining();
                if let Err((reason, truncated)) = body_can_fit(headers, size, limit) {
                    return Some(self.inner.lock().unwrap().budget.omitted(mime.as_deref(), size, reason, truncated));
                }
                self.cdp
                    .send("Network.getRequestPostData", json!({ "requestId": pending.request_id }), pending.session.as_deref())
                    .await
                    .ok()
                    .and_then(|value| value.get("postData").and_then(Value::as_str).map(str::to_string))
            }
        };
        let mut inner = self.inner.lock().unwrap();
        Some(match text {
            Some(text) => inner.budget.capture(text.as_bytes(), mime.as_deref()),
            None => inner.budget.omitted(mime.as_deref(), size, model::UNAVAILABLE, true),
        })
    }

    /// The response body, under the same rules as `request_body`.
    async fn response_body(&self, pending: &Pending, info: &ResponseInfo, headers: &[Header]) -> Option<model::CapturedBody> {
        let redirect = (300..400).contains(&info.status) && model::header(headers, "location").is_some();
        if redirect || pending.failure.is_some() || matches!(info.status, 101 | 204 | 205 | 304) {
            return None;
        }
        let mime = content_type(headers).or(info.mime_type.clone());
        let size = Some(pending.data_length).filter(|n| *n > 0).or_else(|| model::declared_body_size(headers));
        if size == Some(0) {
            return None;
        }
        if !is_returnable_mime_type(mime.as_deref()) {
            return Some(self.inner.lock().unwrap().budget.omitted(mime.as_deref(), size, model::NOT_RETURNED, false));
        }
        let limit = self.inner.lock().unwrap().budget.remaining();
        if let Err((reason, truncated)) = body_can_fit(headers, size, limit) {
            return Some(self.inner.lock().unwrap().budget.omitted(mime.as_deref(), size, reason, truncated));
        }
        let fetched = tokio::time::timeout(
            Duration::from_secs(2),
            self.cdp.send("Network.getResponseBody", json!({ "requestId": pending.request_id }), pending.body_session.as_deref()),
        )
        .await;
        let bytes = match fetched {
            Ok(Ok(value)) => {
                let body = value.get("body").and_then(Value::as_str).unwrap_or("");
                if value.get("base64Encoded").and_then(Value::as_bool).unwrap_or(false) {
                    base64::engine::general_purpose::STANDARD.decode(body).ok()
                } else {
                    Some(body.as_bytes().to_vec())
                }
            }
            _ => None,
        };
        let mut inner = self.inner.lock().unwrap();
        match bytes {
            Some(bytes) if bytes.is_empty() => None,
            Some(bytes) => Some(inner.budget.capture(&bytes, mime.as_deref())),
            None => Some(inner.budget.omitted(mime.as_deref(), size, model::UNAVAILABLE, true)),
        }
    }

    /// Ends the capture: open requests become failures, finalizers get up to 5 s, then everything is returned.
    async fn drain(self: &Arc<Self>, reason: &str) -> Vec<CapturedEntry> {
        let leftovers: Vec<Pending> = {
            let mut inner = self.inner.lock().unwrap();
            let pending: Vec<Pending> = inner.pending.drain().map(|(_, pending)| pending).collect();
            pending
                .into_iter()
                .map(|mut pending| {
                    let child = inner.committed_in_child(&pending);
                    if !(child && inner.known_response(&mut pending)) {
                        let reason = if child {
                            "the iframe loaded its document in its own process before its response could be captured"
                        } else {
                            reason
                        };
                        pending.failure.get_or_insert_with(|| reason.to_string());
                        pending.response = None;
                    }
                    pending
                })
                .collect()
        };
        for pending in leftovers {
            self.finalize(pending);
        }
        let mut watch = self.in_flight.subscribe();
        let settled = tokio::time::timeout(Duration::from_secs(5), watch.wait_for(|count| *count == 0)).await;
        let mut inner = self.inner.lock().unwrap();
        inner.stopping = true;
        if settled.is_err() {
            inner.dropped_entry_count += *self.in_flight.borrow();
        }
        let mut entries = std::mem::take(&mut inner.entries);
        entries.sort_by(|a, b| {
            let number = |id: &str| id.trim_start_matches("request-").parse::<usize>().unwrap_or(0);
            number(&a.id).cmp(&number(&b.id))
        });
        entries
    }
}

fn network_enable_params() -> Value {
    // Request bodies up to 64 KiB arrive with the event; larger ones are fetched with Network.getRequestPostData.
    json!({ "maxPostDataSize": 65_536 })
}

async fn start(ctx: &ToolContext, args: &Value) -> anyhow::Result<ToolOutput> {
    let tab = target_tab(args)?;
    let strings = |name: &str| -> anyhow::Result<Vec<String>> {
        match args.get(name) {
            None | Some(Value::Null) => Ok(Vec::new()),
            Some(Value::Array(items)) => items
                .iter()
                .map(|item| item.as_str().map(str::to_string).ok_or_else(|| anyhow::anyhow!("{name} must be strings")))
                .collect(),
            Some(_) => bail_user!("{name} must be an array of strings"),
        }
    };
    let filters = Filters {
        url: arg_str(args, "urlFilter")?.filter(|text| !text.is_empty()).map(str::to_string),
        resource_types: strings("resourceTypes")?,
        methods: strings("methods")?,
        bodies: arg_bool(args, "bodies")?.unwrap_or(true),
    };
    let max_duration = arg_int(args, "maxDurationMs", 1_000, 24 * 60 * 60_000)?.unwrap_or(DEFAULT_MAX_DURATION_MS);
    let tab_state = ctx.state(tab).await?;
    let capture = state::get(ctx, tab).await?;
    let mut network = capture.network.lock().await;
    if network.active.is_some() {
        bail_user!("network capture is already active in tab {tab}; stop or cancel it first");
    }
    let cdp = ctx.browser.cdp(tab).await?;
    let mut events = cdp.events();
    cdp.send("Network.enable", network_enable_params(), None).await?;
    let shared = Arc::new(Shared {
        cdp: cdp.clone(),
        filters,
        inner: SyncMutex::new(Inner::default()),
        finalizers: Semaphore::new(MAX_FINALIZERS),
        in_flight: tokio::sync::watch::channel(0).0,
    });
    let listener = shared.clone();
    let weak = Arc::downgrade(&capture);
    let task = tokio::spawn(async move {
        let reason = loop {
            match events.recv().await {
                Ok(event) => {
                    if event.session_id.is_none() {
                        match event.method.as_str() {
                            "Inspector.detached" => {
                                let reason = event.params.get("reason").and_then(Value::as_str).unwrap_or("detached");
                                break format!("its tab went away ({reason})");
                            }
                            "Inspector.targetCrashed" | "Target.targetCrashed" => break "its tab crashed".to_string(),
                            _ => {}
                        }
                    }
                    listener.handle(event)
                }
                Err(broadcast::error::RecvError::Lagged(missed)) => listener.inner.lock().unwrap().missed_event_count += missed,
                Err(broadcast::error::RecvError::Closed) => break "its tab closed or browse was detached from it".to_string(),
            }
        };
        end_with_tab(weak, listener, reason).await;
    });
    // Existing out-of-process iframes are announced again (Target.attachedToTarget), so their Network domain is on too.
    let _ = cdp.send("Target.setAutoAttach", json!({ "autoAttach": true, "waitForDebuggerOnStart": false, "flatten": true }), None).await;
    let weak = Arc::downgrade(&capture);
    let expiry = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(max_duration as u64)).await;
        if let Some(capture) = weak.upgrade() {
            let mut network = capture.network.lock().await;
            if let Some(mut active) = network.active.take() {
                active._expiry.disarm();
            }
            network.ended = Some(format!(
                "it reached its maximum duration of {} s (maxDurationMs), and what it captured was discarded",
                max_duration / 1000
            ));
        }
    });
    let ends_at = crate::iso_time(std::time::SystemTime::now() + Duration::from_millis(max_duration as u64));
    network.ended = None;
    network.ended_result = None;
    network.active = Some(Active {
        tab,
        started_at: crate::now_iso(),
        ends_at,
        shared,
        _events: TaskGuard::new(task.abort_handle()),
        _expiry: TaskGuard::new(expiry.abort_handle()),
        _busy: BusyGuard::new(ctx, tab, "network"),
        state: tab_state.clone(),
    });
    set_capture_flag(&tab_state, true).await;
    json_output(&status_of(&network))
}

/// Ends a capture whose tab went away, keeping what it captured for the next stop.
async fn end_with_tab(weak: Weak<state::CaptureState>, shared: Arc<Shared>, reason: String) {
    let Some(capture) = weak.upgrade() else { return };
    let mut network = capture.network.lock().await;
    if !network.active.as_ref().is_some_and(|active| Arc::ptr_eq(&active.shared, &shared)) {
        return;
    }
    let Some(mut active) = network.active.take() else { return };
    // This task is the events task: let it finish instead of aborting itself.
    active._events.disarm();
    let entries = active.shared.drain(&format!("the capture ended before the request completed: {reason}")).await;
    let mut result = stop_result(&active, &entries);
    result["endedBecause"] = json!(reason);
    network.ended = Some(reason);
    network.ended_result = Some(result);
}

fn stop_result(active: &Active, entries: &[CapturedEntry]) -> Value {
    let (redacted, omissions) = finish(entries);
    let inner = active.shared.inner.lock().unwrap();
    let mut result = json!({
        "active": false,
        "tab": active.tab,
        "startedAt": active.started_at,
        "stoppedAt": crate::now_iso(),
        "entryCount": redacted.len(),
        "responseCount": redacted.iter().filter(|entry| entry.response.is_some()).count(),
        "failureCount": redacted.iter().filter(|entry| entry.failure.is_some()).count(),
        "capturedBodyBytes": inner.budget.captured_body_bytes,
        "truncatedBodyCount": inner.budget.truncated_body_count + omissions,
        "droppedEntryCount": inner.dropped_entry_count,
    });
    if inner.missed_event_count > 0 {
        result["missedEventCount"] = json!(inner.missed_event_count);
    }
    result["exchanges"] = json!(redacted);
    result
}

async fn stop(ctx: &ToolContext, args: &Value) -> anyhow::Result<ToolOutput> {
    let capture = state::get(ctx, target_tab(args)?).await?;
    let mut network = capture.network.lock().await;
    let Some(active) = network.active.take() else {
        if let Some(result) = network.ended_result.take() {
            network.ended = None;
            return json_output(&result);
        }
        match network.ended.take() {
            Some(reason) => bail_user!("network capture is not active: it ended because {reason}. Start a new one."),
            None => bail_user!("network capture is not active in this tab"),
        }
    };
    let mut active = active;
    active._events.abort();
    let entries = active.shared.drain("the capture stopped before the request completed").await;
    json_output(&stop_result(&active, &entries))
}

pub(crate) struct NetworkTool;

#[async_trait]
impl Tool for NetworkTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "network".into(),
            description: "Capture a tab's network traffic. One capture per tab. \
                start begins capturing (filters optional); status returns counters only; stop ends it and returns every \
                exchange (method, url, headers, status, bodies; 1000 requests max); cancel discards it. JSON, form \
                and multipart bodies are returned as text (≤1 MB each, 25 MB per capture); other bodies (HTML, \
                scripts, CSS, images, ...) are never fetched and only described {mimeType, size, omitted}, since they \
                can't be checked for credentials. If the tab closes the capture ends and the next stop still returns \
                what it captured, with endedBecause. Credentials are always replaced with [redacted]: authorization and API-key headers, all \
                cookie values, secret-named query/fragment/JSON/form fields, token-like path segments, and known values \
                wherever they reappear, though inside JSON bodies values under 16 characters are matched only when \
                they came from a secret-named URL field (and are at least 8). A capture ends itself after maxDurationMs."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "action": { "type": "string", "enum": ["start", "status", "stop", "cancel"] },
                    "tab": tab_schema(),
                    "urlFilter": { "type": "string", "description": "start: capture only URLs containing this text." },
                    "resourceTypes": { "type": "array", "items": { "type": "string" }, "description": "start: capture only these CDP resource types, e.g. [\"XHR\", \"Fetch\", \"Document\"]." },
                    "methods": { "type": "array", "items": { "type": "string" }, "description": "start: capture only these HTTP methods, e.g. [\"POST\"]." },
                    "bodies": { "type": "boolean", "description": "start: capture request and response bodies (default true)." },
                    "maxDurationMs": { "type": "integer", "minimum": 1000, "maximum": 86_400_000, "description": "start: end and discard the capture after this long (default 1800000)." }
                },
                "required": ["tab", "action"],
                "additionalProperties": false
            }),
        }
    }

    async fn call(&self, ctx: ToolContext, args: Value) -> anyhow::Result<ToolOutput> {
        respond(
            async {
                match arg_action(&args, &["start", "status", "stop", "cancel"])? {
                    "start" => start(&ctx, &args).await,
                    "stop" => stop(&ctx, &args).await,
                    "status" => {
                        let capture = state::get(&ctx, target_tab(&args)?).await?;
                        let network = capture.network.lock().await;
                        json_output(&status_of(&network))
                    }
                    _ => {
                        let capture = state::get(&ctx, target_tab(&args)?).await?;
                        let mut network = capture.network.lock().await;
                        let cancelled = network.active.take().is_some() || network.ended_result.take().is_some();
                        network.ended = None;
                        json_output(&json!({ "cancelled": cancelled }))
                    }
                }
            }
            .await,
        )
        .await
    }
}
