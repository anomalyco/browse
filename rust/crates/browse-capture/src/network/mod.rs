//! Session network capture over the CDP Network domain (port of cli/src/network-capture.ts).

mod model;

pub use model::{CapturedEntry, finish};

use std::collections::HashMap;
use std::sync::{Arc, Mutex as SyncMutex};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use base64::Engine;
use browse_core::{Cdp, CdpEvent, SessionState, TabId, Tool, ToolContext, ToolOutput, ToolSpec};
use serde::Serialize;
use serde_json::{Value, json};
use tokio::sync::{Semaphore, broadcast};

use crate::redaction::Header;
use crate::state::{BusyGuard, TaskGuard};
use crate::{arg_action, arg_bool, arg_int, arg_str, bail_user, json_output, respond, state, tab_schema, target_tab};
use model::{Budget, CapturedRequest, CapturedResponse, MAX_ENTRIES, body_can_fit, content_type};

const DEFAULT_MAX_DURATION_MS: i64 = 30 * 60_000;
const MAX_FINALIZERS: usize = 4;

#[derive(Default)]
pub(crate) struct NetworkState {
    active: Option<Active>,
    /// Why the last capture ended on its own, shown by status and by a stop that comes too late.
    ended: Option<String>,
}

struct Active {
    tab: TabId,
    started_at: String,
    ends_at: String,
    shared: Arc<Shared>,
    _events: TaskGuard,
    _expiry: TaskGuard,
    _busy: BusyGuard,
    state: Arc<SessionState>,
}

/// Shared with browse-page: it keeps the Network domain on while a capture runs, and capture leaves it on while
/// offline emulation (which needs it) is active.
const CAPTURE_KEY: &str = "browse.network.capture";
const OFFLINE_KEY: &str = "browse.network.offline";

async fn set_capture_flag(state: &SessionState, on: bool) {
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

#[derive(Default)]
struct Inner {
    pending: HashMap<(Option<String>, String), Pending>,
    request_extra: HashMap<(Option<String>, String), Vec<Header>>,
    response_extra: HashMap<(Option<String>, String), Vec<Header>>,
    entries: Vec<CapturedEntry>,
    next_id: usize,
    budget: Budget,
    dropped_entry_count: usize,
    missed_event_count: u64,
    stopping: bool,
}

struct Pending {
    id: String,
    started: Instant,
    started_date_time: String,
    session: Option<String>,
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
    encoded_length: Option<usize>,
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
        return Status {
            active: false,
            tab: None,
            started_at: None,
            ends_at: None,
            ended: state.ended.clone(),
            entry_count: 0,
            pending_count: 0,
            response_count: 0,
            failure_count: 0,
            captured_body_bytes: 0,
            truncated_body_count: 0,
            dropped_entry_count: 0,
            missed_event_count: 0,
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
        let request_id = || params.get("requestId").and_then(Value::as_str).unwrap_or("").to_string();
        let key = (event.session_id.clone(), request_id());
        let mut inner = self.inner.lock().unwrap();
        if inner.stopping {
            return;
        }
        match event.method.as_str() {
            "Network.requestWillBeSent" => {
                let mut redirected_from = None;
                if let Some(redirect) = params.get("redirectResponse")
                    && let Some(mut previous) = inner.pending.remove(&key) {
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
                    inner.request_extra.remove(&key);
                    inner.response_extra.remove(&key);
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
                    request_id: key.1.clone(),
                    url,
                    method,
                    headers: headers_from(request.get("headers")),
                    resource_type,
                    post_data: request.get("postData").and_then(Value::as_str).map(str::to_string),
                    has_post_data: request.get("hasPostData").and_then(Value::as_bool).unwrap_or(false),
                    redirected_from,
                    response: None,
                    failure: None,
                    encoded_length: None,
                };
                inner.pending.insert(key, pending);
            }
            "Network.requestWillBeSentExtraInfo" => {
                if inner.request_extra.len() > 4 * MAX_ENTRIES {
                    inner.request_extra.clear();
                }
                inner.request_extra.insert(key, headers_from(params.get("headers")));
            }
            "Network.responseReceivedExtraInfo" => {
                if inner.response_extra.len() > 4 * MAX_ENTRIES {
                    inner.response_extra.clear();
                }
                inner.response_extra.insert(key, headers_from(params.get("headers")));
            }
            "Network.responseReceived" => {
                if let Some(pending) = inner.pending.get_mut(&key) {
                    pending.response = params.get("response").map(response_info);
                }
            }
            "Network.loadingFinished" => {
                if let Some(mut pending) = inner.pending.remove(&key) {
                    pending.encoded_length = params.get("encodedDataLength").and_then(Value::as_f64).map(|n| n as usize);
                    drop(inner);
                    self.finalize(pending);
                }
            }
            "Network.loadingFailed" => {
                if let Some(mut pending) = inner.pending.remove(&key) {
                    let text = params.get("errorText").and_then(Value::as_str).filter(|text| !text.is_empty());
                    pending.failure = Some(text.unwrap_or("Request failed").to_string());
                    drop(inner);
                    self.finalize(pending);
                }
            }
            "Target.attachedToTarget" => {
                // Out-of-process iframes and workers have their own Network domain.
                if let Some(session) = params.get("sessionId").and_then(Value::as_str) {
                    let cdp = self.cdp.clone();
                    let session = session.to_string();
                    tokio::spawn(async move {
                        let _ = cdp.send("Network.enable", network_enable_params(), Some(&session)).await;
                    });
                }
            }
            _ => {}
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
        let key = (pending.session.clone(), pending.request_id.clone());
        let (request_headers, response_headers) = {
            let mut inner = self.inner.lock().unwrap();
            (inner.request_extra.remove(&key), inner.response_extra.remove(&key))
        };
        // ExtraInfo headers are the raw ones on the wire, cookies included; prefer them.
        let request_headers = request_headers.filter(|headers| !headers.is_empty()).unwrap_or(pending.headers.clone());
        let session = pending.session.as_deref();
        let request_body = if !self.filters.bodies {
            None
        } else {
            let mime = content_type(&request_headers);
            let declared = model::declared_body_size(&request_headers);
            let may_have_body = match declared {
                Some(size) => size > 0,
                None => pending.post_data.is_some() || pending.has_post_data,
            };
            if !may_have_body {
                None
            } else {
                let limit = self.inner.lock().unwrap().budget.remaining();
                let text = match &pending.post_data {
                    Some(text) => Some(text.clone()),
                    None if body_can_fit(&request_headers, declared, limit) => self
                        .cdp
                        .send("Network.getRequestPostData", json!({ "requestId": pending.request_id }), session)
                        .await
                        .ok()
                        .and_then(|value| value.get("postData").and_then(Value::as_str).map(str::to_string)),
                    None => None,
                };
                let mut inner = self.inner.lock().unwrap();
                Some(match text {
                    Some(text) if text.len() <= limit => inner.budget.capture(text.as_bytes(), mime.as_deref()),
                    Some(text) => inner.budget.truncated(mime.as_deref(), text.len()),
                    None => inner.budget.truncated(mime.as_deref(), declared.unwrap_or(0)),
                })
            }
        };
        let response = match &pending.response {
            None => None,
            Some(info) => {
                let headers = response_headers.filter(|headers| !headers.is_empty()).unwrap_or(info.headers.clone());
                let mime = content_type(&headers).or(info.mime_type.clone());
                let redirect = (300..400).contains(&info.status) && model::header(&headers, "location").is_some();
                let body = if !self.filters.bodies || redirect || pending.failure.is_some() {
                    None
                } else {
                    let limit = self.inner.lock().unwrap().budget.remaining();
                    if limit > 0 && body_can_fit(&headers, pending.encoded_length.filter(|n| *n > 0), limit) {
                        let fetched = tokio::time::timeout(
                            Duration::from_secs(2),
                            self.cdp.send("Network.getResponseBody", json!({ "requestId": pending.request_id }), session),
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
                        Some(match bytes {
                            Some(bytes) => inner.budget.capture(&bytes, mime.as_deref()),
                            None => inner.budget.truncated(mime.as_deref(), pending.encoded_length.unwrap_or(0)),
                        })
                    } else {
                        let mut inner = self.inner.lock().unwrap();
                        Some(inner.budget.truncated(mime.as_deref(), pending.encoded_length.unwrap_or(0)))
                    }
                };
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

    /// Ends the capture: open requests become failures, finalizers get up to 5 s, then everything is returned.
    async fn drain(self: &Arc<Self>) -> Vec<CapturedEntry> {
        let leftovers: Vec<Pending> = {
            let mut inner = self.inner.lock().unwrap();
            inner.pending.drain().map(|(_, pending)| pending).collect()
        };
        for mut pending in leftovers {
            pending.failure.get_or_insert_with(|| "Capture stopped before request completed".into());
            pending.response = None;
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
    let tab = target_tab(ctx, args).await?;
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
    let capture = state::get(ctx).await;
    let mut network = capture.network.lock().await;
    if network.active.is_some() {
        bail_user!("network capture is already active for this session; stop or cancel it first");
    }
    let cdp = ctx.browser.cdp(&ctx.session, tab).await?;
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
    let task = tokio::spawn(async move {
        loop {
            match events.recv().await {
                Ok(event) => listener.handle(event),
                Err(broadcast::error::RecvError::Lagged(missed)) => listener.inner.lock().unwrap().missed_event_count += missed,
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    });
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
    network.active = Some(Active {
        tab,
        started_at: crate::now_iso(),
        ends_at,
        shared,
        _events: TaskGuard::new(task.abort_handle()),
        _expiry: TaskGuard::new(expiry.abort_handle()),
        _busy: BusyGuard::new(ctx, "network"),
        state: ctx.state.clone(),
    });
    set_capture_flag(&ctx.state, true).await;
    json_output(&status_of(&network))
}

async fn stop(ctx: &ToolContext) -> anyhow::Result<ToolOutput> {
    let capture = state::get(ctx).await;
    let mut network = capture.network.lock().await;
    let Some(active) = network.active.take() else {
        match network.ended.take() {
            Some(reason) => bail_user!("network capture is not active: it ended because {reason}. Start a new one."),
            None => bail_user!("network capture is not active for this session"),
        }
    };
    let mut active = active;
    active._events.abort();
    let entries = active.shared.drain().await;
    let (redacted, omissions) = finish(&entries);
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
    json_output(&result)
}

pub(crate) struct NetworkTool;

#[async_trait]
impl Tool for NetworkTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "network".into(),
            description: "Capture a tab's network traffic. One capture per session, bound to the tab it started on. \
                start begins capturing (filters optional); status returns counters only; stop ends it and returns every \
                exchange (method, url, headers, status, bodies as text when textual and ≤1 MB, 25 MB total, 1000 \
                requests max); cancel \
                discards it. Credentials are always replaced with [redacted]: authorization and API-key headers, all \
                cookie values, secret-named query/fragment/JSON/form fields, token-like path segments, and any \
                captured secret value wherever it reappears. A capture ends itself after maxDurationMs."
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
                "required": ["action"],
                "additionalProperties": false
            }),
        }
    }

    async fn call(&self, ctx: ToolContext, args: Value) -> anyhow::Result<ToolOutput> {
        respond(
            async {
                match arg_action(&args, &["start", "status", "stop", "cancel"])? {
                    "start" => start(&ctx, &args).await,
                    "stop" => stop(&ctx).await,
                    "status" => {
                        let capture = state::get(&ctx).await;
                        let network = capture.network.lock().await;
                        json_output(&status_of(&network))
                    }
                    _ => {
                        let capture = state::get(&ctx).await;
                        let mut network = capture.network.lock().await;
                        let cancelled = network.active.take().is_some();
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
