//! Protocol-agnostic network capture over `CaptureDriver::network()`: filtering, redaction, body budgets, and
//! HAR-style exchange assembly.

mod model;

pub use model::{CapturedEntry, finish};

use std::collections::HashMap;
use std::sync::{Arc, Mutex as SyncMutex, Weak};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use browse_core::{
    BodyKind, NetworkEvent, NetworkOptions, RequestId, ResponseHead, Subscription, TabDriver, TabId, Tool, ToolContext,
    ToolOutput, ToolSpec,
};
use serde::Serialize;
use serde_json::{Value, json};
use tokio::sync::{Semaphore, oneshot};

use crate::redaction::Header;
use crate::state::{BusyGuard, TaskGuard};
use crate::{arg_action, arg_bool, arg_int, arg_str, bail_user, json_output, respond, state, tab_schema, target_tab};
use model::{Budget, CapturedRequest, CapturedResponse, MAX_ENTRIES, body_can_fit, content_type, is_returnable_mime_type};

const DEFAULT_MAX_DURATION_MS: i64 = 30 * 60_000;
const MAX_FINALIZERS: usize = 4;

#[derive(Default)]
pub(crate) struct NetworkState {
    active: Option<Active>,
    ended: Option<String>,
    ended_result: Option<Value>,
}

struct Active {
    tab: TabId,
    started_at: String,
    ends_at: String,
    shared: Arc<Shared>,
    stop_tx: Option<oneshot::Sender<()>>,
    events_task: Option<tokio::task::JoinHandle<()>>,
    _expiry: TaskGuard,
    _busy: BusyGuard,
}

impl Active {
    async fn stop_events(&mut self) {
        if let Some(tx) = self.stop_tx.take() {
            let _ = tx.send(());
        }
        if let Some(task) = self.events_task.take() {
            let _ = tokio::time::timeout(Duration::from_secs(2), task).await;
        }
    }
}

impl Drop for Active {
    fn drop(&mut self) {
        if let Some(tx) = self.stop_tx.take() {
            let _ = tx.send(());
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
    driver: Arc<dyn TabDriver>,
    filters: Filters,
    inner: SyncMutex<Inner>,
    finalizers: Semaphore,
    in_flight: tokio::sync::watch::Sender<usize>,
}

#[derive(Default)]
struct Inner {
    pending: HashMap<RequestId, Pending>,
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
    request_id: RequestId,
    method: String,
    url: String,
    headers: Vec<Header>,
    resource_type: String,
    post_data: Option<String>,
    has_post_data: bool,
    redirected_from: Option<String>,
    response: Option<ResponseInfo>,
    committed: bool,
    failure: Option<String>,
    data_length: usize,
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

fn to_headers(pairs: Vec<(String, String)>) -> Vec<Header> {
    pairs.into_iter().map(|(name, value)| Header { name, value }).collect()
}

fn to_response_info(head: ResponseHead) -> ResponseInfo {
    ResponseInfo {
        status: head.status,
        status_text: head.status_text,
        headers: to_headers(head.headers),
        mime_type: head.mime_type,
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

    fn handle(self: &Arc<Self>, event: NetworkEvent) {
        let mut inner = self.inner.lock().unwrap();
        if inner.stopping {
            return;
        }
        match event {
            NetworkEvent::Request(req) => {
                if !self.matches(&req.url, &req.resource_type, &req.method) {
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
                    request_id: req.id.clone(),
                    url: req.url,
                    method: req.method,
                    headers: to_headers(req.headers),
                    resource_type: req.resource_type,
                    post_data: req.post_data,
                    has_post_data: req.has_body,
                    redirected_from: req.redirect_of,
                    response: None,
                    committed: false,
                    failure: None,
                    data_length: 0,
                };
                inner.pending.insert(req.id, pending);
            }
            NetworkEvent::Response { id, head, committed } => {
                if let Some(pending) = inner.pending.get_mut(&id) {
                    pending.response = Some(to_response_info(head));
                    pending.committed |= committed;
                }
            }
            NetworkEvent::Finished {
                id,
                body_size,
                request_headers,
                response_headers,
            } => {
                if let Some(mut pending) = inner.pending.remove(&id) {
                    pending.data_length = body_size;
                    if let Some(headers) = request_headers {
                        pending.headers = to_headers(headers);
                    }
                    if let Some(headers) = response_headers
                        && let Some(resp) = pending.response.as_mut()
                    {
                        resp.headers = to_headers(headers);
                    }
                    drop(inner);
                    self.finalize(pending);
                }
            }
            NetworkEvent::Failed { id, error, request_headers } => {
                if let Some(mut pending) = inner.pending.remove(&id) {
                    pending.failure = Some(error);
                    if let Some(headers) = request_headers {
                        pending.headers = to_headers(headers);
                    }
                    drop(inner);
                    self.finalize(pending);
                }
            }
            NetworkEvent::Lagged(missed) => {
                inner.missed_event_count += missed;
            }
            NetworkEvent::Closed(_) => {}
        }
    }

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
        let request_body = if self.filters.bodies {
            self.request_body(&pending, &pending.headers).await
        } else {
            None
        };
        let response = match &pending.response {
            None => None,
            Some(info) => {
                let body = if self.filters.bodies {
                    self.response_body(&pending, info, &info.headers).await
                } else {
                    None
                };
                Some(CapturedResponse {
                    status: info.status,
                    status_text: info.status_text.clone(),
                    headers: info.headers.clone(),
                    body,
                })
            }
        };
        CapturedEntry {
            id: pending.id,
            started_date_time: pending.started_date_time,
            duration_ms: pending.started.elapsed().as_millis() as u64,
            request: CapturedRequest {
                method: pending.method,
                url: pending.url,
                headers: pending.headers,
                resource_type: pending.resource_type,
                body: request_body,
                redirected_from: pending.redirected_from,
            },
            response,
            failure: pending.failure,
        }
    }

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
        let bytes = match &pending.post_data {
            Some(text) => Some(text.as_bytes().to_vec()),
            None => {
                let limit = self.inner.lock().unwrap().budget.remaining();
                if let Err((reason, truncated)) = body_can_fit(headers, size, limit) {
                    return Some(self.inner.lock().unwrap().budget.omitted(mime.as_deref(), size, reason, truncated));
                }
                self.driver
                    .capture()
                    .body(&pending.request_id, BodyKind::Request)
                    .await
                    .ok()
                    .flatten()
            }
        };
        let mut inner = self.inner.lock().unwrap();
        Some(match bytes {
            Some(bytes) => inner.budget.capture(&bytes, mime.as_deref()),
            None => inner.budget.omitted(mime.as_deref(), size, model::UNAVAILABLE, true),
        })
    }

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
            self.driver.capture().body(&pending.request_id, BodyKind::Response),
        )
        .await;
        let bytes = fetched.ok().and_then(Result::ok).flatten();
        let mut inner = self.inner.lock().unwrap();
        match bytes {
            Some(bytes) if bytes.is_empty() => None,
            Some(bytes) => Some(inner.budget.capture(&bytes, mime.as_deref())),
            None => Some(inner.budget.omitted(mime.as_deref(), size, model::UNAVAILABLE, true)),
        }
    }

    async fn drain(self: &Arc<Self>, reason: &str) -> Vec<CapturedEntry> {
        let leftovers: Vec<Pending> = {
            let mut inner = self.inner.lock().unwrap();
            let pending: Vec<Pending> = inner.pending.drain().map(|(_, pending)| pending).collect();
            pending
                .into_iter()
                .map(|mut pending| {
                    if !(pending.committed && pending.response.is_some()) {
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

/// Takes the events a driver reported for its held hops, dropping Requests (they began after stop). No timer: the
/// driver's flush is synchronous and everything it reports is queued by the time it returns.
fn drain_after_flush(shared: &Arc<Shared>, sub: &mut Subscription<NetworkEvent>) {
    sub.flush();
    while let Some(event) = sub.try_recv() {
        match event {
            NetworkEvent::Request(_) => {}
            NetworkEvent::Closed(_) => break,
            event => shared.handle(event),
        }
    }
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
    let capture = state::get(ctx, tab).await?;
    let mut network = capture.network.lock().await;
    if network.active.is_some() {
        bail_user!("network capture is already active in tab {tab}; stop or cancel it first");
    }
    let driver = ctx.browser.tab_driver(tab).await?;
    let mut sub = driver.capture().network(NetworkOptions { bodies: filters.bodies }).await?;
    let shared = Arc::new(Shared {
        driver,
        filters,
        inner: SyncMutex::new(Inner::default()),
        finalizers: Semaphore::new(MAX_FINALIZERS),
        in_flight: tokio::sync::watch::channel(0).0,
    });
    let listener = shared.clone();
    let weak = Arc::downgrade(&capture);
    let (stop_tx, mut stopped) = oneshot::channel::<()>();
    let events_task = tokio::spawn(async move {
        let reason = loop {
            tokio::select! {
                _ = &mut stopped => {
                    drain_after_flush(&listener, &mut sub);
                    sub.stop().await;
                    return;
                }
                event = sub.recv() => match event {
                    Some(NetworkEvent::Closed(reason)) => break reason.to_string(),
                    Some(event) => listener.handle(event),
                    None => break "its tab closed or browse was detached from it".to_string(),
                }
            }
        };
        end_with_tab(weak, listener, reason).await;
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
    network.ended_result = None;
    network.active = Some(Active {
        tab,
        started_at: crate::now_iso(),
        ends_at,
        shared,
        stop_tx: Some(stop_tx),
        events_task: Some(events_task),
        _expiry: TaskGuard::new(expiry.abort_handle()),
        _busy: BusyGuard::new(ctx, tab, "network"),
    });
    json_output(&status_of(&network))
}

async fn end_with_tab(weak: Weak<state::CaptureState>, shared: Arc<Shared>, reason: String) {
    let Some(capture) = weak.upgrade() else { return };
    let mut network = capture.network.lock().await;
    if !network.active.as_ref().is_some_and(|active| Arc::ptr_eq(&active.shared, &shared)) {
        return;
    }
    let Some(mut active) = network.active.take() else { return };
    active.stop_tx.take();
    active.events_task.take();
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
    let Some(mut active) = network.active.take() else {
        if let Some(result) = network.ended_result.take() {
            network.ended = None;
            return json_output(&result);
        }
        match network.ended.take() {
            Some(reason) => bail_user!("network capture is not active: it ended because {reason}. Start a new one."),
            None => bail_user!("network capture is not active in this tab"),
        }
    };
    active.stop_events().await;
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
                where they reappear in URLs, headers and JSON bodies (inside JSON bodies a value under 16 characters is \
                matched only if it came from a password or one-time-code field, or from a secret-named URL query or \
                fragment field and is at least 8 characters). A capture ends itself after maxDurationMs."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "action": { "type": "string", "enum": ["start", "status", "stop", "cancel"] },
                    "tab": tab_schema(),
                    "urlFilter": { "type": "string", "description": "start: capture only URLs containing this text." },
                    "resourceTypes": { "type": "array", "items": { "type": "string" }, "description": "start: capture only these resource types, e.g. [\"XHR\", \"Fetch\", \"Document\"]." },
                    "methods": { "type": "array", "items": { "type": "string" }, "description": "start: capture only these HTTP methods, e.g. [\"POST\"]." },
                    "bodies": { "type": "boolean", "description": "start: capture request and response bodies (default true)." },
                    "maxDurationMs": { "type": "integer", "minimum": 1000, "maximum": 86_400_000, "description": "start: end and discard the capture after this long (default 1800000)." }
                },
                "required": ["tab", "action"],
                "additionalProperties": false
            }),
            output_schema: Some(browse_core::output_schema(serde_json::json!({ "tab": { "type": "integer" }, "active": { "type": "boolean" }, "entryCount": { "type": "integer" }, "responseCount": { "type": "integer" }, "failureCount": { "type": "integer" }, "exchanges": { "type": "array", "description": "The captured requests and responses, on stop" }, "cancelled": { "type": "boolean" } }), &[])),
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{FakeCdp, call, context, settle};

    fn network_tool() -> std::sync::Arc<dyn browse_core::Tool> {
        crate::tools().into_iter().find(|tool| tool.spec().name == "network").unwrap()
    }

    fn sent(cdp: &FakeCdp, request_id: &str, url: &str) {
        cdp.emit(
            "Network.requestWillBeSent",
            json!({
                "requestId": request_id, "type": "Fetch",
                "request": { "url": url, "method": "GET", "headers": {} }
            }),
            None,
        );
    }

    /// A stop while a driver holds a failed hop reports its real error immediately, with whatever headers it has.
    #[tokio::test]
    async fn stop_flushes_a_parked_failure() {
        let cdp = FakeCdp::new();
        let ctx = context(cdp.clone(), vec![]);
        let network = network_tool();
        assert!(!call(&ctx, network.as_ref(), json!({ "action": "start" })).await.0);
        sent(&cdp, "1", "http://a/api/slow");
        cdp.emit("Network.loadingFailed", json!({ "requestId": "1", "errorText": "net::ERR_ABORTED" }), None);
        settle().await;
        let started = std::time::Instant::now();
        let (error, stopped) = call(&ctx, network.as_ref(), json!({ "action": "stop" })).await;
        assert!(!error, "{stopped}");
        assert!(started.elapsed() < Duration::from_millis(100), "stop waited {}", started.elapsed().as_millis());
        assert_eq!(stopped["exchanges"][0]["failure"], json!("net::ERR_ABORTED"), "{stopped}");
    }

    /// An unfinished request must not make stop wait for the driver's extra-info grace.
    #[tokio::test]
    async fn stop_with_a_never_finishing_request_is_prompt() {
        let cdp = FakeCdp::new();
        let ctx = context(cdp.clone(), vec![]);
        let network = network_tool();
        assert!(!call(&ctx, network.as_ref(), json!({ "action": "start" })).await.0);
        sent(&cdp, "1", "http://a/hang");
        settle().await;
        let started = std::time::Instant::now();
        let (error, stopped) = call(&ctx, network.as_ref(), json!({ "action": "stop" })).await;
        assert!(!error, "{stopped}");
        assert!(started.elapsed() < Duration::from_millis(100), "stop waited {}", started.elapsed().as_millis());
        assert_eq!(stopped["exchanges"][0]["request"]["url"], json!("http://a/hang"), "{stopped}");
    }

    /// A request that starts after the stop must not be part of the result.
    #[tokio::test]
    async fn stop_drops_a_request_delivered_by_flush() {
        let ctx = context(FakeCdp::new(), vec![]);
        let driver = ctx.browser.tab_driver(1).await.unwrap();
        let shared = Arc::new(Shared {
            driver,
            filters: Filters { url: None, resource_types: Vec::new(), methods: Vec::new(), bodies: false },
            inner: SyncMutex::new(Inner::default()),
            finalizers: Semaphore::new(MAX_FINALIZERS),
            in_flight: tokio::sync::watch::channel(0).0,
        });
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let mut sub = Subscription::new(rx, None, None).with_flush(move || {
            let _ = tx.send(NetworkEvent::Request(browse_core::NetworkRequest {
                id: RequestId::from("late"),
                redirect_of: None,
                frame: None,
                url: "http://a/late".into(),
                method: "GET".into(),
                headers: Vec::new(),
                resource_type: "Fetch".into(),
                post_data: None,
                has_body: false,
            }));
            let _ = tx.send(NetworkEvent::Lagged(1));
        });
        drain_after_flush(&shared, &mut sub);
        let inner = shared.inner.lock().unwrap();
        assert_eq!(inner.missed_event_count, 1, "the flush ran");
        assert!(inner.pending.is_empty());
        assert!(inner.entries.is_empty());
    }

    /// A parked redirect reports its 302 even though stop arrives before its trailing finish.
    #[tokio::test]
    async fn stop_keeps_a_parked_redirect_response() {
        let cdp = FakeCdp::new();
        let ctx = context(cdp.clone(), vec![]);
        let network = network_tool();
        assert!(!call(&ctx, network.as_ref(), json!({ "action": "start" })).await.0);
        sent(&cdp, "1", "http://a/hop");
        cdp.emit(
            "Network.requestWillBeSent",
            json!({
                "requestId": "1", "type": "Fetch", "redirectHasExtraInfo": true,
                "redirectResponse": {
                    "status": 302, "statusText": "Found",
                    "headers": { "Location": "/landed", "Content-Type": "text/plain" }
                },
                "request": { "url": "http://a/landed", "method": "GET", "headers": {} }
            }),
            None,
        );
        settle().await;
        let (error, stopped) = call(&ctx, network.as_ref(), json!({ "action": "stop" })).await;
        assert!(!error, "{stopped}");
        let hop = stopped["exchanges"]
            .as_array()
            .unwrap()
            .iter()
            .find(|exchange| exchange["request"]["url"] == "http://a/hop")
            .expect("the redirect hop");
        assert_eq!(hop["response"]["status"], json!(302), "{stopped}");
        assert!(hop.get("failure").is_none(), "{stopped}");
    }
}
