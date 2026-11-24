//! The WebDriver BiDi wire: the `BiDiTransport` seam (so tests can script a fake browser) and `BiDiClient`, one
//! WebSocket session to a browser's `/session` endpoint.
//!
//! A browser such as Firefox allows a single BiDi session at a time, and keeps it until `session.end`: closing the
//! socket without ending the session leaves the endpoint refusing every later client. `BiDiClient` therefore ends
//! the session on `shutdown` and, best effort, when it is dropped.

use std::collections::HashMap;
use std::fmt;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use browse_core::{CloseReason, DriverError, DriverResult};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::sync::{broadcast, mpsc, oneshot};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const SESSION_TIMEOUT: Duration = Duration::from_secs(10);
/// Full-page screenshots arrive as one base64 message, which can be far larger than tungstenite's defaults.
const MAX_MESSAGE: usize = 1 << 30;

/// A failed BiDi command.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BiDiError {
    /// The browser answered with an error; `error` is the WebDriver error code (`no such frame`, `unknown command`, ...).
    Command { error: String, message: String },
    /// The connection closed before the browser answered.
    Closed,
}

impl BiDiError {
    /// The WebDriver error code, when the browser answered.
    pub fn code(&self) -> Option<&str> {
        match self {
            BiDiError::Command { error, .. } => Some(error),
            BiDiError::Closed => None,
        }
    }

    pub fn message(&self) -> &str {
        match self {
            BiDiError::Command { message, .. } => message,
            BiDiError::Closed => "the connection closed",
        }
    }
}

impl fmt::Display for BiDiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            BiDiError::Command { error, message } if message.is_empty() => f.write_str(error),
            BiDiError::Command { error, message } => write!(f, "{error}: {message}"),
            BiDiError::Closed => f.write_str("the browser connection closed"),
        }
    }
}

impl std::error::Error for BiDiError {}

/// One event the session received.
#[derive(Debug, Clone)]
pub struct BiDiEvent {
    pub method: String,
    pub params: Value,
}

/// A WebDriver BiDi session: commands and the session's events.
#[async_trait]
pub trait BiDiTransport: Send + Sync {
    async fn send(&self, method: &str, params: Value) -> Result<Value, BiDiError>;
    /// Every event the session receives. The channel closes when the connection does.
    fn events(&self) -> broadcast::Receiver<BiDiEvent>;
}

type PendingMap = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, BiDiError>>>>>;

/// Removes a command's pending entry when its caller stops waiting, answered or not.
struct PendingGuard<'a> {
    id: u64,
    pending: &'a PendingMap,
}

impl Drop for PendingGuard<'_> {
    fn drop(&mut self) {
        self.pending.lock().unwrap().remove(&self.id);
    }
}

/// A WebDriver BiDi session over one WebSocket.
pub struct BiDiClient {
    out: mpsc::UnboundedSender<Message>,
    pending: PendingMap,
    next: AtomicU64,
    events: Arc<Mutex<Option<broadcast::Sender<BiDiEvent>>>>,
    closed: Arc<AtomicBool>,
    ended: AtomicBool,
    capabilities: Value,
}

/// `ws://host:port` (what Firefox prints) becomes the session endpoint `ws://host:port/session`.
pub fn session_url(url: &str) -> String {
    let trimmed = url.trim();
    let rest = trimmed.split_once("://").map(|(_, rest)| rest).unwrap_or(trimmed);
    if rest.contains('/') && !rest.ends_with('/') {
        trimmed.to_string()
    } else {
        format!("{}/session", trimmed.trim_end_matches('/'))
    }
}

impl BiDiClient {
    /// Connects to `url` (`ws://127.0.0.1:<port>` or its `/session` endpoint) and starts a session that leaves
    /// user prompts open for browse to answer.
    pub async fn connect(url: &str) -> DriverResult<Arc<BiDiClient>> {
        let url = session_url(url);
        let config = WebSocketConfig::default()
            .max_message_size(Some(MAX_MESSAGE))
            .max_frame_size(Some(MAX_MESSAGE));
        let (socket, _) =
            tokio::time::timeout(CONNECT_TIMEOUT, tokio_tungstenite::connect_async_with_config(&url, Some(config), false))
                .await
                .map_err(|_| DriverError::Timeout(CONNECT_TIMEOUT))?
                .map_err(|error| {
                    DriverError::Refused(format!("could not connect to the WebDriver BiDi endpoint at {url}: {error}"))
                })?;
        let (mut sink, mut stream) = socket.split();
        let (out, mut outgoing) = mpsc::unbounded_channel::<Message>();
        let pending: PendingMap = Arc::default();
        let (events, _) = broadcast::channel(4096);
        let events = Arc::new(Mutex::new(Some(events)));
        let closed = Arc::new(AtomicBool::new(false));

        tokio::spawn(async move {
            while let Some(message) = outgoing.recv().await {
                if sink.send(message).await.is_err() {
                    return;
                }
            }
            let _ = sink.send(Message::Close(None)).await;
            let _ = sink.close().await;
        });

        let reader_pending = pending.clone();
        let reader_events = events.clone();
        let reader_closed = closed.clone();
        tokio::spawn(async move {
            while let Some(message) = stream.next().await {
                match message {
                    Ok(Message::Text(text)) => dispatch(text.as_str(), &reader_pending, &reader_events),
                    Ok(Message::Close(_)) | Err(_) => break,
                    Ok(_) => {}
                }
            }
            reader_closed.store(true, Ordering::SeqCst);
            let waiting: Vec<_> = reader_pending.lock().unwrap().drain().map(|(_, tx)| tx).collect();
            for tx in waiting {
                let _ = tx.send(Err(BiDiError::Closed));
            }
            reader_events.lock().unwrap().take();
        });

        let mut client = BiDiClient {
            out,
            pending,
            next: AtomicU64::new(1),
            events,
            closed,
            ended: AtomicBool::new(true),
            capabilities: Value::Null,
        };
        let status = client.timed("session.status", json!({})).await?;
        if status.get("ready").and_then(Value::as_bool) == Some(false) {
            let message = status.get("message").and_then(Value::as_str).unwrap_or("not ready");
            return Err(DriverError::Refused(format!(
                "the browser's WebDriver BiDi endpoint at {url} is busy ({message}): another client holds its only session; close that client, or restart the browser"
            )));
        }
        let capabilities = json!({ "alwaysMatch": { "unhandledPromptBehavior": { "default": "ignore" } } });
        let session = match client.send("session.new", json!({ "capabilities": capabilities })).await {
            Ok(session) => session,
            Err(BiDiError::Command { error, message }) if error == "session not created" => {
                return Err(DriverError::Refused(format!(
                    "the browser refused a WebDriver BiDi session ({message}); another client may hold it, or the browser needs a restart"
                )));
            }
            Err(error) => return Err(crate::map_error(error)),
        };
        client.ended.store(false, Ordering::SeqCst);
        client.capabilities = session.get("capabilities").cloned().unwrap_or(Value::Null);
        Ok(Arc::new(client))
    }

    async fn timed(&self, method: &str, params: Value) -> DriverResult<Value> {
        match tokio::time::timeout(SESSION_TIMEOUT, self.send(method, params)).await {
            Ok(result) => result.map_err(crate::map_error),
            Err(_) => Err(DriverError::Timeout(SESSION_TIMEOUT)),
        }
    }

    /// The capabilities `session.new` returned (`browserName`, `browserVersion`, ...).
    pub fn capabilities(&self) -> &Value {
        &self.capabilities
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    /// Ends the session so the browser accepts a new client. Idempotent.
    pub async fn shutdown(&self) {
        if self.ended.swap(true, Ordering::SeqCst) || self.is_closed() {
            return;
        }
        let _ = tokio::time::timeout(Duration::from_secs(2), self.send("session.end", json!({}))).await;
    }
}

impl Drop for BiDiClient {
    fn drop(&mut self) {
        // The writer flushes this before closing the socket, so the browser frees its session without a runtime here.
        if !self.ended.swap(true, Ordering::SeqCst) {
            let id = self.next.fetch_add(1, Ordering::SeqCst);
            let end = json!({ "id": id, "method": "session.end", "params": {} });
            let _ = self.out.send(Message::text(end.to_string()));
        }
    }
}

fn dispatch(text: &str, pending: &PendingMap, events: &Mutex<Option<broadcast::Sender<BiDiEvent>>>) {
    let Ok(value) = serde_json::from_str::<Value>(text) else { return };
    let kind = value.get("type").and_then(Value::as_str).unwrap_or("");
    if kind == "event" || (value.get("id").is_none() && value.get("method").is_some()) {
        let method = value.get("method").and_then(Value::as_str).unwrap_or("").to_string();
        let params = value.get("params").cloned().unwrap_or(Value::Null);
        if let Some(sender) = events.lock().unwrap().as_ref() {
            let _ = sender.send(BiDiEvent { method, params });
        }
        return;
    }
    let Some(id) = value.get("id").and_then(Value::as_u64) else { return };
    let Some(tx) = pending.lock().unwrap().remove(&id) else { return };
    let result = if kind == "error" || value.get("error").is_some_and(Value::is_string) {
        Err(BiDiError::Command {
            error: value.get("error").and_then(Value::as_str).unwrap_or("unknown error").to_string(),
            message: value.get("message").and_then(Value::as_str).unwrap_or("").to_string(),
        })
    } else {
        Ok(value.get("result").cloned().unwrap_or(Value::Null))
    };
    let _ = tx.send(result);
}

#[async_trait]
impl BiDiTransport for BiDiClient {
    async fn send(&self, method: &str, params: Value) -> Result<Value, BiDiError> {
        let id = self.next.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);
        let _guard = PendingGuard { id, pending: &self.pending };
        if self.closed.load(Ordering::SeqCst) {
            return Err(BiDiError::Closed);
        }
        let message = json!({ "id": id, "method": method, "params": params });
        if self.out.send(Message::text(message.to_string())).is_err() {
            return Err(BiDiError::Closed);
        }
        rx.await.unwrap_or(Err(BiDiError::Closed))
    }

    fn events(&self) -> broadcast::Receiver<BiDiEvent> {
        match self.events.lock().unwrap().as_ref() {
            Some(sender) => sender.subscribe(),
            None => broadcast::channel(1).1,
        }
    }
}

/// Maps a BiDi error by its WebDriver error code (never its message) to the typed driver error. Commands with their
/// own meaning for a code (`no such history entry`, `no such network data`, ...) handle it before calling this.
pub fn map_error(error: BiDiError) -> DriverError {
    let (code, message) = match error {
        BiDiError::Closed => return DriverError::Closed(CloseReason::BrowserDisconnected),
        BiDiError::Command { error, message } => (error, message),
    };
    match code.as_str() {
        "no such frame" | "no such node" | "no such handle" | "stale element reference" | "detached shadow root" => {
            DriverError::Stale
        }
        "unknown command" => DriverError::Unsupported("this WebDriver BiDi command"),
        "invalid session id" => DriverError::Closed(CloseReason::BrowserDisconnected),
        "no such alert" => DriverError::Protocol("no dialog is open".into()),
        "unable to set file input" => DriverError::Refused(message),
        _ if message.is_empty() => DriverError::Protocol(code),
        _ => DriverError::Protocol(format!("{code}: {message}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn command(error: &str, message: &str) -> BiDiError {
        BiDiError::Command { error: error.into(), message: message.into() }
    }

    #[test]
    fn session_urls() {
        assert_eq!(session_url("ws://127.0.0.1:9222"), "ws://127.0.0.1:9222/session");
        assert_eq!(session_url("ws://127.0.0.1:9222/"), "ws://127.0.0.1:9222/session");
        assert_eq!(session_url("ws://127.0.0.1:9222/session"), "ws://127.0.0.1:9222/session");
        assert_eq!(session_url("ws://127.0.0.1:9222/session/abc"), "ws://127.0.0.1:9222/session/abc");
    }

    #[test]
    fn errors_map_by_code() {
        assert!(matches!(map_error(command("no such frame", "Browsing Context with id x not found")), DriverError::Stale));
        assert!(matches!(map_error(command("no such node", "")), DriverError::Stale));
        assert!(matches!(map_error(command("no such handle", "")), DriverError::Stale));
        assert!(matches!(map_error(command("unknown command", "emulation.nope")), DriverError::Unsupported(_)));
        assert!(matches!(
            map_error(command("invalid session id", "")),
            DriverError::Closed(CloseReason::BrowserDisconnected)
        ));
        assert!(matches!(map_error(BiDiError::Closed), DriverError::Closed(CloseReason::BrowserDisconnected)));
        assert!(matches!(map_error(command("unable to set file input", "not a file input")), DriverError::Refused(m) if m == "not a file input"));
        match map_error(command("no such alert", "")) {
            DriverError::Protocol(message) => assert_eq!(message, "no dialog is open"),
            other => panic!("{other:?}"),
        }
        // The message text never decides the variant.
        assert!(matches!(map_error(command("invalid argument", "no such frame")), DriverError::Protocol(_)));
    }

    #[test]
    fn dispatch_routes_answers_and_events() {
        let pending: PendingMap = Arc::default();
        let (sender, mut rx) = broadcast::channel(8);
        let events = Mutex::new(Some(sender));
        let (tx, mut answer) = oneshot::channel();
        pending.lock().unwrap().insert(3, tx);
        dispatch(r#"{"type":"event","method":"log.entryAdded","params":{"text":"hi"}}"#, &pending, &events);
        let event = rx.try_recv().unwrap();
        assert_eq!(event.method, "log.entryAdded");
        assert_eq!(event.params["text"], "hi");
        dispatch(r#"{"type":"error","id":3,"error":"no such frame","message":"gone"}"#, &pending, &events);
        assert_eq!(answer.try_recv().unwrap(), Err(command("no such frame", "gone")));
        assert!(pending.lock().unwrap().is_empty());
        let (tx, mut answer) = oneshot::channel();
        pending.lock().unwrap().insert(4, tx);
        dispatch(r#"{"type":"success","id":4,"result":{"ok":1}}"#, &pending, &events);
        assert_eq!(answer.try_recv().unwrap(), Ok(json!({ "ok": 1 })));
        dispatch("not json", &pending, &events);
        dispatch(r#"{"type":"success","id":99,"result":{}}"#, &pending, &events);
    }
}
