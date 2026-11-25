//! One connected browser: its extension's WebSocket and the request/response correlation over it
//! (cli/src/relay/rpc.ts). A timed-out command fails only that command; the socket is closed only when it stops
//! answering WebSocket pings, or the worker stops answering for a minute (then it is asked to reload).

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use tokio::sync::{Notify, mpsc, oneshot};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;

use crate::protocol::{self, BROWSER_RELOADING, BROWSER_UNRESPONSIVE, NOT_CONNECTED};

#[derive(Debug, Clone)]
pub struct Timeouts {
    pub command: Duration,
    pub ping: Duration,
    pub debugger: Duration,
    pub await_promise: Duration,
    pub liveness: Duration,
    pub wedged_after: Duration,
}

fn configured(variable: &str, fallback: u64, min: u64, max: u64) -> Duration {
    let value = std::env::var(variable).ok().and_then(|raw| raw.trim().parse::<u64>().ok());
    Duration::from_millis(value.map(|v| v.clamp(min, max)).unwrap_or(fallback))
}

impl Timeouts {
    pub fn from_env() -> Self {
        Self {
            command: configured("OPENCODE_BROWSER_EXTENSION_TIMEOUT_MS", 30_000, 15_000, 300_000),
            ping: configured("OPENCODE_BROWSER_PING_TIMEOUT_MS", 10_000, 1_000, 30_000),
            debugger: Duration::from_secs(60),
            await_promise: Duration::from_secs(300),
            liveness: Duration::from_secs(10),
            wedged_after: Duration::from_secs(60),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RpcError {
    NotConnected(String),
    Timeout(String),
    Remote(String),
    Closed(String),
}

impl std::fmt::Display for RpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RpcError::NotConnected(m) | RpcError::Timeout(m) | RpcError::Remote(m) | RpcError::Closed(m) => f.write_str(m),
        }
    }
}

impl std::error::Error for RpcError {}

struct Pending {
    reply: oneshot::Sender<Result<Value, RpcError>>,
    debugger_tab: Option<i64>,
}

pub struct Link {
    pub key: String,
    pub id: String,
    pub name: String,
    pub generation: u64,
    pub version: Option<String>,
    pub build: Option<String>,
    pub origin: Option<String>,
    pub protocol: protocol::Compatibility,
    pub capabilities: HashSet<String>,
    pub local: bool,
    pub connected_at: u64,
    out: mpsc::UnboundedSender<Message>,
    timeouts: Timeouts,
    pending: Mutex<HashMap<u64, Pending>>,
    next_id: AtomicU64,
    ready: AtomicBool,
    unresponsive: AtomicBool,
    closed: AtomicBool,
    replies: AtomicU64,
    unanswered_since: Mutex<Option<Instant>>,
    pings: AtomicUsize,
    probing: AtomicBool,
    pub pong: Notify,
    pub human_input: Mutex<Option<bool>>,
    pub pending_relay_settings: AtomicBool,
    pub announced: Mutex<HashSet<i64>>,
    pub announced_agent: Mutex<HashSet<i64>>,
    pub inventory: Mutex<Vec<tokio::task::JoinHandle<()>>>,
    /// Announced tabs still being set up.
    pub inventory_pending: Mutex<HashSet<i64>>,
}

pub struct LinkInfo {
    pub key: String,
    pub id: String,
    pub name: String,
    pub generation: u64,
    pub version: Option<String>,
    pub build: Option<String>,
    pub origin: Option<String>,
    pub protocol: protocol::Compatibility,
    pub capabilities: HashSet<String>,
    pub local: bool,
}

impl Link {
    pub fn new(info: LinkInfo, out: mpsc::UnboundedSender<Message>, timeouts: Timeouts) -> Self {
        Self {
            key: info.key,
            id: info.id,
            name: info.name,
            generation: info.generation,
            version: info.version,
            build: info.build,
            origin: info.origin,
            protocol: info.protocol,
            capabilities: info.capabilities,
            local: info.local,
            connected_at: crate::util::now_ms(),
            out,
            timeouts,
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            ready: AtomicBool::new(false),
            unresponsive: AtomicBool::new(false),
            closed: AtomicBool::new(false),
            replies: AtomicU64::new(0),
            unanswered_since: Mutex::new(None),
            pings: AtomicUsize::new(0),
            probing: AtomicBool::new(false),
            pong: Notify::new(),
            human_input: Mutex::new(None),
            pending_relay_settings: AtomicBool::new(false),
            announced: Mutex::new(HashSet::new()),
            announced_agent: Mutex::new(HashSet::new()),
            inventory: Mutex::new(Vec::new()),
            inventory_pending: Mutex::new(HashSet::new()),
        }
    }

    pub fn supports(&self, capability: &str) -> bool {
        self.capabilities.contains(capability)
    }

    /// Whether the extension holds a tab past its own idle cleanup (`tabs.keepOpen`, `keepOpen` on `tabs.create`).
    /// An announced `keep-open` is authoritative; otherwise the extension must be new enough to handle it anyway.
    pub fn keeps_open(&self) -> bool {
        self.supports(protocol::CAPABILITY_KEEP_OPEN) || self.version.as_deref().is_some_and(protocol::version_keeps_open)
    }

    /// Paired, inventory reconciled, answering and speaking our protocol.
    pub fn connected(&self) -> bool {
        !self.closed.load(Ordering::SeqCst) && self.ready.load(Ordering::SeqCst) && !self.unresponsive() && self.protocol.compatible
    }

    pub fn accepts_commands(&self) -> bool {
        !self.closed.load(Ordering::SeqCst) && self.protocol.compatible
    }

    pub fn unresponsive(&self) -> bool {
        self.unresponsive.load(Ordering::SeqCst)
    }

    pub fn is_ready(&self) -> bool {
        self.ready.load(Ordering::SeqCst)
    }

    pub fn mark_ready(&self) {
        if self.protocol.compatible {
            self.ready.store(true, Ordering::SeqCst);
        }
    }

    /// Announced tabs are still being set up.
    pub fn inventory_pending(&self) -> bool {
        !self.inventory_pending.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).is_empty()
    }

    pub fn ping_pending(&self) -> bool {
        self.pings.load(Ordering::SeqCst) > 0
    }

    pub fn human_input(&self) -> Option<bool> {
        *self.human_input.lock().unwrap()
    }

    pub fn send_raw(&self, value: &Value) {
        let _ = self.out.send(Message::Text(value.to_string().into()));
    }

    pub fn close(&self, code: u16, reason: &str) {
        let _ = self.out.send(Message::Close(Some(CloseFrame { code: CloseCode::from(code), reason: reason.to_string().into() })));
    }

    /// The socket closed: every waiting command fails.
    pub fn disconnected(&self, reason: &str) {
        self.closed.store(true, Ordering::SeqCst);
        self.reject_all(reason);
    }

    pub fn reject_all(&self, reason: &str) {
        for (_, pending) in self.pending.lock().unwrap().drain() {
            let _ = pending.reply.send(Err(RpcError::Closed(reason.to_string())));
        }
    }

    pub fn reject_tab(&self, tab: i64, reason: &str) {
        let mut pending = self.pending.lock().unwrap();
        let ids: Vec<u64> = pending.iter().filter(|(_, p)| p.debugger_tab == Some(tab)).map(|(id, _)| *id).collect();
        for id in ids {
            if let Some(entry) = pending.remove(&id) {
                let _ = entry.reply.send(Err(RpcError::Closed(reason.to_string())));
            }
        }
    }

    pub fn note_reply(&self) {
        self.replies.fetch_add(1, Ordering::SeqCst);
        self.unresponsive.store(false, Ordering::SeqCst);
    }

    /// A `{ id, result | error }` from the extension.
    pub fn handle_response(&self, message: &Value) {
        self.note_reply();
        *self.unanswered_since.lock().unwrap() = None;
        let Some(id) = message.get("id").and_then(Value::as_u64) else { return };
        let Some(pending) = self.pending.lock().unwrap().remove(&id) else { return };
        let outcome = match message.get("error").and_then(Value::as_str) {
            Some(error) => Err(RpcError::Remote(error.to_string())),
            None => Ok(message.get("result").cloned().unwrap_or_else(|| json!({}))),
        };
        let _ = pending.reply.send(outcome);
    }

    fn timeout_for(&self, method: &str, params: &Value) -> Duration {
        let cdp = params.get("method").and_then(Value::as_str);
        let awaits = matches!(cdp, Some("Runtime.evaluate" | "Runtime.callFunctionOn")) && params["params"]["awaitPromise"] == true;
        match method {
            _ if method == "debugger.sendCommand" && awaits => self.timeouts.await_promise,
            "ping" => self.timeouts.ping,
            "debugger.sendCommand" => self.timeouts.debugger,
            _ => self.timeouts.command,
        }
    }

    /// Sends a command (with the browser's own tab ids) and waits for its answer.
    pub async fn call(self: &Arc<Self>, method: &str, params: Value, timeout: Option<Duration>) -> Result<Value, RpcError> {
        if !self.protocol.compatible {
            return Err(RpcError::NotConnected(protocol::advice(self.protocol.version, None)));
        }
        if self.closed.load(Ordering::SeqCst) {
            return Err(RpcError::NotConnected(NOT_CONNECTED.into()));
        }
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (reply, receive) = oneshot::channel();
        let debugger_tab = (method == "debugger.sendCommand").then(|| params.get("tabId").and_then(Value::as_i64)).flatten();
        let limit = timeout.unwrap_or_else(|| self.timeout_for(method, &params));
        self.pending.lock().unwrap().insert(id, Pending { reply, debugger_tab });
        let ping = method == "ping";
        if ping {
            self.pings.fetch_add(1, Ordering::SeqCst);
        }
        let replies = self.replies.load(Ordering::SeqCst);
        let mut message = json!({ "id": id, "method": method });
        if !params.is_null() {
            message["params"] = params;
        }
        if self.out.send(Message::Text(message.to_string().into())).is_err() {
            self.pending.lock().unwrap().remove(&id);
            if ping {
                self.pings.fetch_sub(1, Ordering::SeqCst);
            }
            return Err(RpcError::NotConnected(NOT_CONNECTED.into()));
        }
        let outcome = tokio::time::timeout(limit, receive).await;
        if ping {
            self.pings.fetch_sub(1, Ordering::SeqCst);
        }
        match outcome {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(RpcError::Closed("Extension disconnected".into())),
            Err(_) => {
                self.pending.lock().unwrap().remove(&id);
                if ping {
                    let since = *self.unanswered_since.lock().unwrap().get_or_insert_with(Instant::now);
                    if since.elapsed() >= self.timeouts.wedged_after {
                        self.unresponsive.store(true, Ordering::SeqCst);
                        self.send_raw(&json!({ "id": 0, "method": "runtime.reload" }));
                        self.close(4002, "Extension stopped answering commands; asked it to reload");
                        return Err(RpcError::Timeout(BROWSER_RELOADING.into()));
                    }
                    if self.replies.load(Ordering::SeqCst) != replies {
                        return Ok(json!({}));
                    }
                    self.unresponsive.store(true, Ordering::SeqCst);
                    return Err(RpcError::Timeout(BROWSER_UNRESPONSIVE.into()));
                }
                self.probe_liveness();
                Err(RpcError::Timeout(format!("Extension command timed out after {}ms: {method}", limit.as_millis())))
            }
        }
    }

    /// A WebSocket ping the browser answers itself: no pong means the connection is gone, so close it.
    fn probe_liveness(self: &Arc<Self>) {
        if self.probing.swap(true, Ordering::SeqCst) || self.closed.load(Ordering::SeqCst) {
            return;
        }
        let link = self.clone();
        tokio::spawn(async move {
            let notified = link.pong.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let _ = link.out.send(Message::Ping(Vec::new().into()));
            let answered = tokio::time::timeout(link.timeouts.liveness, notified).await.is_ok();
            link.probing.store(false, Ordering::SeqCst);
            if !answered {
                link.close(4002, "Extension websocket did not answer liveness probe");
            }
        });
    }
}
