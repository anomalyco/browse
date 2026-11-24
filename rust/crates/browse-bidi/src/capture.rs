//! Console (`log.entryAdded`) and network (`network.*`) capture for one tab.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use base64::Engine;
use browse_core::{
    BodyKind, CaptureDriver, CloseReason, ConsoleEntry, ConsoleEvent, DriverError, DriverResult, FrameId, NetworkEvent,
    NetworkOptions, NetworkRequest, PageEvent, RequestId, ResponseHead, Screencast, Subscription,
};
use serde_json::{Value, json};
use tokio::sync::{broadcast, mpsc};

use crate::tab::{BiDiTabDriver, Shared, str_of};
use crate::transport::{BiDiEvent, map_error};

/// Largest body a data collector keeps; bigger ones are reported as unavailable.
const MAX_COLLECTED: u64 = 25_000_000;
const CLEANUP_TIMEOUT: Duration = Duration::from_secs(2);

type Cleanup = Box<dyn FnOnce() -> Pin<Box<dyn Future<Output = ()> + Send>> + Send>;

/// The tab's `network.responseStarted` subscription, shared by its network captures.
#[derive(Default)]
pub(crate) struct NetworkSubscriptions {
    captures: usize,
    subscription: Option<String>,
}

async fn unsubscribe(shared: &Shared, id: String) {
    let _ = tokio::time::timeout(
        CLEANUP_TIMEOUT,
        shared.transport.send("session.unsubscribe", json!({ "subscriptions": [id] })),
    )
    .await;
}

async fn subscribe(shared: &Shared, events: &[&str]) -> DriverResult<Option<String>> {
    let result = shared
        .transport
        .send("session.subscribe", json!({ "events": events, "contexts": [shared.top.as_str()] }))
        .await
        .map_err(|error| shared.frame_error(error, &shared.top))?;
    Ok(result.get("subscription").and_then(Value::as_str).map(str::to_string))
}

/// Why a capture ends: the tab closed or the browser went away.
async fn closed(page: &mut broadcast::Receiver<PageEvent>) -> CloseReason {
    loop {
        match page.recv().await {
            Ok(PageEvent::Closed(reason)) => return reason,
            Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => {}
            Err(broadcast::error::RecvError::Closed) => return CloseReason::Closed,
        }
    }
}

fn console_entry(shared: &Shared, params: &Value) -> Option<ConsoleEntry> {
    let context = params.pointer("/source/context").and_then(Value::as_str)?;
    if !shared.belongs(context) {
        return None;
    }
    let kind = match (str_of(params, "type"), str_of(params, "method")) {
        ("javascript", _) => "pageerror".to_string(),
        (_, "warn") => "warning".to_string(),
        (_, "") => str_of(params, "level").to_string(),
        (_, method) => method.to_string(),
    };
    let frame = params.pointer("/stackTrace/callFrames/0");
    let text = params
        .get("args")
        .and_then(Value::as_array)
        .and_then(|args| console_text(args))
        .unwrap_or_else(|| str_of(params, "text").to_string());
    Some(ConsoleEntry {
        kind,
        text,
        source: None,
        // As CDP reports a message from an out-of-process (cross-site) iframe's target.
        target: cross_origin_frame(shared, context).then(|| "iframe".to_string()),
        url: frame.and_then(|f| f.get("url")).and_then(Value::as_str).filter(|u| !u.is_empty()).map(str::to_string),
        line: frame.and_then(|f| f.get("lineNumber")).and_then(Value::as_i64).map(|n| n + 1),
    })
}

/// Whether `context` is a child frame showing another origin than the tab's top document.
fn cross_origin_frame(shared: &Shared, context: &str) -> bool {
    if context == shared.top.as_str() {
        return false;
    }
    let origin = |url: &str| url.split_once("://").map(|(scheme, rest)| format!("{scheme}://{}", rest.split(['/', '?', '#']).next().unwrap_or("")));
    let state = shared.state.lock().unwrap();
    let url = |id: &str| state.frames.get(&FrameId::from(id)).map(|entry| entry.frame.url.clone());
    match (url(context), url(shared.top.as_str())) {
        (Some(frame), Some(top)) => origin(&frame) != origin(&top),
        _ => false,
    }
}

/// A console call's arguments as text, the way the CDP driver words them (DevTools' one-line descriptions:
/// `Object`, `Array(2)`, `Map(1)`); None when an argument has no such description here (errors, functions, nodes),
/// so Firefox's own rendering of the message is used.
pub(crate) fn console_text(args: &[Value]) -> Option<String> {
    let mut parts = Vec::new();
    for arg in args {
        let value = arg.get("value");
        let count = || value.and_then(Value::as_array).map(Vec::len);
        let part = match str_of(arg, "type") {
            "string" => value.and_then(Value::as_str)?.to_string(),
            "number" => match value? {
                Value::String(special) => special.clone(),
                other => other.to_string(),
            },
            "boolean" => value?.to_string(),
            "bigint" => format!("{}n", value.and_then(Value::as_str)?),
            "null" => "null".into(),
            "undefined" => "undefined".into(),
            "object" => "Object".into(),
            "array" => count().map_or_else(|| "Array".into(), |n| format!("Array({n})")),
            "map" => count().map_or_else(|| "Map".into(), |n| format!("Map({n})")),
            "set" => count().map_or_else(|| "Set".into(), |n| format!("Set({n})")),
            "regexp" => {
                let regexp = value?;
                format!("/{}/{}", str_of(regexp, "pattern"), str_of(regexp, "flags"))
            }
            _ => return None,
        };
        parts.push(part);
    }
    Some(parts.join(" "))
}

fn headers(value: Option<&Value>) -> Vec<(String, String)> {
    value
        .and_then(Value::as_array)
        .map(|headers| {
            headers
                .iter()
                .map(|header| {
                    let name = str_of(header, "name").to_string();
                    let raw = &header["value"];
                    let value = match str_of(raw, "type") {
                        "base64" => base64::engine::general_purpose::STANDARD
                            .decode(str_of(raw, "value"))
                            .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
                            .unwrap_or_default(),
                        _ => str_of(raw, "value").to_string(),
                    };
                    (name, value)
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Chrome DevTools-style resource types (what `resourceTypes` filters name) from the fetch destination.
pub(crate) fn resource_type(request: &Value, initiator: &Value) -> &'static str {
    match str_of(request, "destination") {
        "document" | "iframe" | "frame" | "embed" | "object" => return "Document",
        "image" => return "Image",
        "script" | "worker" | "sharedworker" | "serviceworker" => return "Script",
        "style" => return "Stylesheet",
        "font" => return "Font",
        "audio" | "video" | "track" => return "Media",
        "manifest" => return "Manifest",
        _ => {}
    }
    let initiated = match str_of(request, "initiatorType") {
        "" => str_of(initiator, "type"),
        kind => kind,
    };
    match initiated {
        "fetch" | "beacon" => "Fetch",
        "xmlhttprequest" => "XHR",
        _ => "Other",
    }
}

fn response_head(response: &Value) -> ResponseHead {
    ResponseHead {
        status: response.get("status").and_then(Value::as_i64).unwrap_or(0),
        status_text: str_of(response, "statusText").to_string(),
        headers: headers(response.get("headers")),
        mime_type: Some(str_of(response, "mimeType").split(';').next().unwrap_or("").trim().to_string())
            .filter(|mime| !mime.is_empty()),
    }
}

/// Maps one network event of this tab; `previous` keeps each request's last URL for redirect hops.
fn network_events(shared: &Shared, event: &BiDiEvent, previous: &mut HashMap<String, String>) -> Vec<NetworkEvent> {
    let params = &event.params;
    let context = str_of(params, "context");
    if context.is_empty() || !shared.belongs(context) {
        return Vec::new();
    }
    let request = &params["request"];
    let id = str_of(request, "request").to_string();
    if id.is_empty() {
        return Vec::new();
    }
    match event.method.as_str() {
        "network.beforeRequestSent" => {
            let url = str_of(request, "url").to_string();
            let redirect_of = if params.get("redirectCount").and_then(Value::as_u64).unwrap_or(0) > 0 {
                previous.get(&id).cloned()
            } else {
                None
            };
            if previous.len() > 5_000 {
                previous.clear();
            }
            previous.insert(id.clone(), url.clone());
            vec![NetworkEvent::Request(NetworkRequest {
                id: RequestId::from(id),
                redirect_of,
                frame: Some(FrameId::from(context)),
                url,
                method: str_of(request, "method").to_string(),
                headers: headers(request.get("headers")),
                resource_type: resource_type(request, &params["initiator"]).to_string(),
                post_data: None,
                has_body: request.get("bodySize").and_then(Value::as_u64).unwrap_or(0) > 0,
            })]
        }
        "network.responseStarted" => {
            vec![NetworkEvent::Response { id: RequestId::from(id), head: response_head(&params["response"]), committed: false }]
        }
        "network.responseCompleted" => {
            let response = &params["response"];
            let id = RequestId::from(id);
            vec![
                NetworkEvent::Response { id: id.clone(), head: response_head(response), committed: false },
                NetworkEvent::Finished {
                    id,
                    body_size: response.get("bodySize").and_then(Value::as_u64).unwrap_or(0) as usize,
                    request_headers: None,
                    response_headers: None,
                },
            ]
        }
        "network.fetchError" => {
            let error = Some(str_of(params, "errorText")).filter(|e| !e.is_empty()).unwrap_or("Request failed");
            vec![NetworkEvent::Failed { id: RequestId::from(id), error: error.to_string(), request_headers: None }]
        }
        _ => Vec::new(),
    }
}

async fn console(shared: Arc<Shared>) -> DriverResult<Subscription<ConsoleEvent>> {
    if let Some(reason) = shared.closed() {
        return Err(DriverError::Closed(reason));
    }
    // Subscribing replays the messages the browser buffered before it: only newer ones belong to this capture.
    let since = shared
        .sandbox_call(&shared.top, "function () { return Date.now(); }", &[])
        .await
        .ok()
        .and_then(|now| now.get("value").and_then(Value::as_f64));
    let mut raw = shared.transport.events();
    let mut page = shared.page_events();
    let subscription = subscribe(&shared, &["log.entryAdded"]).await?;
    let (tx, rx) = mpsc::unbounded_channel();
    let task_shared = shared.clone();
    let task = tokio::spawn(async move {
        let reason = loop {
            tokio::select! {
                event = raw.recv() => match event {
                    Ok(event) if event.method == "log.entryAdded"
                        && !since.is_some_and(|since| event.params.get("timestamp").and_then(Value::as_f64).is_some_and(|at| at < since)) =>
                    {
                        if let Some(entry) = console_entry(&task_shared, &event.params)
                            && tx.send(ConsoleEvent::Entry(entry)).is_err()
                        {
                            return;
                        }
                    }
                    Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => {}
                    Err(broadcast::error::RecvError::Closed) => break CloseReason::BrowserDisconnected,
                },
                reason = closed(&mut page) => break reason,
            }
        };
        let _ = tx.send(ConsoleEvent::Closed(reason));
    });
    let cleanup: Cleanup = Box::new(move || {
        Box::pin(async move {
            if let Some(id) = subscription {
                unsubscribe(&shared, id).await;
            }
        })
    });
    Ok(Subscription::new(rx, Some(task.abort_handle()), Some(cleanup)))
}

async fn network(shared: Arc<Shared>, opts: NetworkOptions) -> DriverResult<Subscription<NetworkEvent>> {
    if let Some(reason) = shared.closed() {
        return Err(DriverError::Closed(reason));
    }
    let mut raw = shared.transport.events();
    let mut page = shared.page_events();
    {
        let mut subscriptions = shared.network.lock().await;
        if subscriptions.captures == 0 {
            subscriptions.subscription = subscribe(&shared, &["network.responseStarted"]).await?;
        }
        subscriptions.captures += 1;
    }
    let collector = if opts.bodies {
        shared
            .transport
            .send(
                "network.addDataCollector",
                json!({
                    "dataTypes": ["request", "response"],
                    "maxEncodedDataSize": MAX_COLLECTED,
                    "contexts": [shared.top.as_str()],
                }),
            )
            .await
            .ok()
            .and_then(|result| result.get("collector").and_then(Value::as_str).map(str::to_string))
    } else {
        None
    };
    let (tx, rx) = mpsc::unbounded_channel();
    let task_shared = shared.clone();
    let task = tokio::spawn(async move {
        let mut previous = HashMap::new();
        let reason = loop {
            tokio::select! {
                event = raw.recv() => match event {
                    Ok(event) if event.method.starts_with("network.") => {
                        for mapped in network_events(&task_shared, &event, &mut previous) {
                            if tx.send(mapped).is_err() {
                                return;
                            }
                        }
                    }
                    Ok(_) => {}
                    Err(broadcast::error::RecvError::Lagged(missed)) => {
                        if tx.send(NetworkEvent::Lagged(missed)).is_err() {
                            return;
                        }
                    }
                    Err(broadcast::error::RecvError::Closed) => break CloseReason::BrowserDisconnected,
                },
                reason = closed(&mut page) => break reason,
            }
        };
        let _ = tx.send(NetworkEvent::Closed(reason));
    });
    let cleanup: Cleanup = Box::new(move || {
        Box::pin(async move {
            let last = {
                let mut subscriptions = shared.network.lock().await;
                subscriptions.captures = subscriptions.captures.saturating_sub(1);
                if subscriptions.captures == 0 { subscriptions.subscription.take() } else { None }
            };
            if let Some(id) = last {
                unsubscribe(&shared, id).await;
            }
            if let Some(collector) = collector {
                let _ = tokio::time::timeout(
                    CLEANUP_TIMEOUT,
                    shared.transport.send("network.removeDataCollector", json!({ "collector": collector })),
                )
                .await;
            }
        })
    });
    Ok(Subscription::new(rx, Some(task.abort_handle()), Some(cleanup)))
}

fn decode_bytes(bytes: &Value) -> Option<Vec<u8>> {
    match str_of(bytes, "type") {
        "string" => Some(str_of(bytes, "value").as_bytes().to_vec()),
        "base64" => base64::engine::general_purpose::STANDARD.decode(str_of(bytes, "value")).ok(),
        _ => None,
    }
}

#[async_trait]
impl CaptureDriver for BiDiTabDriver {
    /// Console messages and uncaught errors of the tab's frames and workers. WebDriver BiDi attributes messages
    /// logged from browse's sandbox to the page's own realm, so they can't be told apart.
    async fn console(&self) -> DriverResult<Subscription<ConsoleEvent>> {
        console(self.shared.clone()).await
    }

    async fn network(&self, opts: NetworkOptions) -> DriverResult<Subscription<NetworkEvent>> {
        network(self.shared.clone(), opts).await
    }

    async fn body(&self, request: &RequestId, kind: BodyKind) -> DriverResult<Option<Vec<u8>>> {
        let data_type = match kind {
            BodyKind::Request => "request",
            BodyKind::Response => "response",
        };
        match self
            .shared
            .transport
            .send("network.getData", json!({ "dataType": data_type, "request": request.as_str() }))
            .await
        {
            Ok(result) => Ok(result.get("bytes").and_then(decode_bytes)),
            Err(error) if error.code() == Some("no such network data") => Ok(None),
            Err(error) => Err(map_error(error)),
        }
    }

    fn screencast(&self) -> Option<&dyn Screencast> {
        // No BiDi screencast yet: the harness polls `TabDriver::screenshot` instead.
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resource_types() {
        let kind = |request: Value, initiator: Value| resource_type(&request, &initiator);
        assert_eq!(kind(json!({ "destination": "document" }), json!({})), "Document");
        assert_eq!(kind(json!({ "destination": "iframe" }), json!({})), "Document");
        assert_eq!(kind(json!({ "destination": "image", "initiatorType": "img" }), json!({})), "Image");
        assert_eq!(kind(json!({ "destination": "script" }), json!({})), "Script");
        assert_eq!(kind(json!({ "destination": "style" }), json!({})), "Stylesheet");
        assert_eq!(kind(json!({ "destination": "font" }), json!({})), "Font");
        assert_eq!(kind(json!({ "destination": "", "initiatorType": "fetch" }), json!({ "type": "other" })), "Fetch");
        assert_eq!(kind(json!({ "destination": "" }), json!({ "type": "fetch" })), "Fetch");
        assert_eq!(kind(json!({ "destination": "", "initiatorType": "xmlhttprequest" }), json!({})), "XHR");
        assert_eq!(kind(json!({ "destination": "" }), json!({})), "Other");
    }

    #[test]
    fn console_arguments_read_like_devtools() {
        let text = |args: Value| console_text(args.as_array().unwrap());
        assert_eq!(
            text(json!([
                { "type": "string", "value": "plain" },
                { "type": "number", "value": 42 },
                { "type": "boolean", "value": true },
                { "type": "null" },
                { "type": "undefined" },
                { "type": "number", "value": "NaN" },
                { "type": "bigint", "value": "10" },
            ])),
            Some("plain 42 true null undefined NaN 10n".into())
        );
        assert_eq!(
            text(json!([
                { "type": "string", "value": "warned" },
                { "type": "object", "value": [["a", { "type": "number", "value": 1 }]] },
                { "type": "array", "value": [{ "type": "number", "value": 1 }, { "type": "number", "value": 2 }] },
                { "type": "map", "value": [] },
                { "type": "regexp", "value": { "pattern": "a+", "flags": "g" } },
            ])),
            Some("warned Object Array(2) Map(0) /a+/g".into())
        );
        assert_eq!(text(json!([{ "type": "string", "value": "x" }, { "type": "error" }])), None, "errors keep Firefox's text");
    }

    #[test]
    fn headers_decode() {
        let decoded = headers(Some(&json!([
            { "name": "content-type", "value": { "type": "string", "value": "application/json" } },
            { "name": "x-bin", "value": { "type": "base64", "value": "aGk=" } },
        ])));
        assert_eq!(decoded, vec![("content-type".into(), "application/json".into()), ("x-bin".into(), "hi".into())]);
    }

    #[test]
    fn response_heads() {
        let head = response_head(&json!({ "status": 404, "statusText": "Not Found", "mimeType": "text/html; charset=utf-8", "headers": [] }));
        assert_eq!(head.status, 404);
        assert_eq!(head.status_text, "Not Found");
        assert_eq!(head.mime_type.as_deref(), Some("text/html"));
        assert_eq!(response_head(&json!({ "mimeType": "" })).mime_type, None);
    }

    #[test]
    fn bodies_decode() {
        assert_eq!(decode_bytes(&json!({ "type": "string", "value": "{}" })), Some(b"{}".to_vec()));
        assert_eq!(decode_bytes(&json!({ "type": "base64", "value": "aGk=" })), Some(b"hi".to_vec()));
        assert_eq!(decode_bytes(&json!({})), None);
    }
}
