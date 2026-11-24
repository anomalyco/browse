//! `CdpWsBrowserDriver`: a `BrowserDriver` for a Chromium started with `--remote-debugging-port`.
//!
//! The browser-level WebSocket creates, closes and discovers targets (popups arrive as `Target.targetCreated` with an
//! opener). Every attached tab gets its own WebSocket to `/devtools/page/<target>`, wrapped in
//! `browse_cdp::CdpTabDriver`, so no two tabs ever share a session or each other's events.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use browse_cdp::{Cdp, CdpError, CdpEvent, CdpTabDriver};
use browse_core::{
    BrowserDriver, BrowserEvent, CloseReason, DriverError, DriverInfo, DriverResult, TabDriver, TabOptions, TargetId,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::sync::{broadcast, mpsc, oneshot};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;

type Pending = HashMap<i64, oneshot::Sender<Result<Value, CdpError>>>;

/// One DevTools WebSocket: requests matched to answers by id, everything else broadcast as events.
pub struct WsConnection {
    out: mpsc::UnboundedSender<Message>,
    pending: Mutex<Pending>,
    next: AtomicI64,
    events: Mutex<Option<broadcast::Sender<CdpEvent>>>,
    closed: AtomicBool,
    /// What a request on a closed connection fails with: a page socket closes with its tab, the browser's with
    /// the browser.
    closed_error: fn() -> CdpError,
    reader: Mutex<Option<tokio::task::AbortHandle>>,
}

impl WsConnection {
    pub async fn connect(url: &str, closed_error: fn() -> CdpError) -> anyhow::Result<Arc<WsConnection>> {
        let config = WebSocketConfig::default().max_message_size(Some(512 << 20)).max_frame_size(Some(512 << 20));
        let (socket, _) = tokio::time::timeout(
            Duration::from_secs(10),
            tokio_tungstenite::connect_async_with_config(url, Some(config), true),
        )
        .await
        .map_err(|_| anyhow::anyhow!("connecting to {url} timed out"))??;
        let (mut write, mut read) = socket.split();
        let (out, mut rx) = mpsc::unbounded_channel::<Message>();
        let (events, _) = broadcast::channel(8192);
        let connection = Arc::new(WsConnection {
            out,
            pending: Mutex::new(HashMap::new()),
            next: AtomicI64::new(1),
            events: Mutex::new(Some(events)),
            closed: AtomicBool::new(false),
            closed_error,
            reader: Mutex::new(None),
        });
        tokio::spawn(async move {
            while let Some(message) = rx.recv().await {
                let close = matches!(message, Message::Close(_));
                if write.send(message).await.is_err() || close {
                    break;
                }
            }
            let _ = write.close().await;
        });
        let reader = connection.clone();
        let task = tokio::spawn(async move {
            while let Some(Ok(message)) = read.next().await {
                let text = match message {
                    Message::Text(text) => text.to_string(),
                    Message::Binary(bytes) => String::from_utf8_lossy(&bytes).to_string(),
                    Message::Close(_) => break,
                    _ => continue,
                };
                let Ok(value) = serde_json::from_str::<Value>(&text) else { continue };
                reader.dispatch(value);
            }
            reader.finish();
        });
        *connection.reader.lock().unwrap() = Some(task.abort_handle());
        Ok(connection)
    }

    fn dispatch(&self, value: Value) {
        if let Some(id) = value.get("id").and_then(Value::as_i64) {
            let Some(tx) = self.pending.lock().unwrap().remove(&id) else { return };
            let result = match value.get("error") {
                Some(error) => Err(CdpError::Protocol(
                    error.get("message").and_then(Value::as_str).unwrap_or("protocol error").to_string(),
                )),
                None => Ok(value.get("result").cloned().unwrap_or(Value::Null)),
            };
            let _ = tx.send(result);
        } else if let Some(method) = value.get("method").and_then(Value::as_str) {
            let event = CdpEvent {
                method: method.to_string(),
                params: value.get("params").cloned().unwrap_or(Value::Null),
                session_id: value.get("sessionId").and_then(Value::as_str).map(str::to_string),
            };
            if let Some(sender) = self.events.lock().unwrap().as_ref() {
                let _ = sender.send(event);
            }
        }
    }

    /// The socket closed: every request in flight fails, and event subscribers see the stream end.
    fn finish(&self) {
        self.closed.store(true, Ordering::SeqCst);
        let pending: Vec<_> = self.pending.lock().unwrap().drain().collect();
        for (_, tx) in pending {
            let _ = tx.send(Err((self.closed_error)()));
        }
        self.events.lock().unwrap().take();
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    pub fn subscribe(&self) -> broadcast::Receiver<CdpEvent> {
        match self.events.lock().unwrap().as_ref() {
            Some(sender) => sender.subscribe(),
            None => broadcast::channel(1).1,
        }
    }

    pub async fn send(&self, method: &str, params: Value, session: Option<&str>) -> Result<Value, CdpError> {
        if self.is_closed() {
            return Err((self.closed_error)());
        }
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);
        let mut message = json!({ "id": id, "method": method, "params": params });
        if let Some(session) = session {
            message["sessionId"] = json!(session);
        }
        if self.out.send(Message::Text(message.to_string().into())).is_err() {
            self.pending.lock().unwrap().remove(&id);
            return Err((self.closed_error)());
        }
        // A request racing the socket's close may have missed the drain.
        if self.is_closed()
            && let Some(tx) = self.pending.lock().unwrap().remove(&id)
        {
            let _ = tx.send(Err((self.closed_error)()));
        }
        rx.await.unwrap_or_else(|_| Err((self.closed_error)()))
    }

    pub fn close(&self) {
        let _ = self.out.send(Message::Close(None));
        if let Some(reader) = self.reader.lock().unwrap().take() {
            reader.abort();
        }
        self.finish();
    }
}

/// One tab's CDP pipe: its own page WebSocket; child targets (OOPIFs, workers) are flattened sessions on it.
pub struct PageCdp {
    connection: Arc<WsConnection>,
}

#[async_trait]
impl Cdp for PageCdp {
    async fn send(&self, method: &str, params: Value, session_id: Option<&str>) -> Result<Value, CdpError> {
        self.connection.send(method, params, session_id).await
    }

    fn events(&self) -> broadcast::Receiver<CdpEvent> {
        self.connection.subscribe()
    }
}

/// Browser-level CDP driver over `--remote-debugging-port` (`id: "cdp+ws"`).
pub struct CdpWsBrowserDriver {
    info: DriverInfo,
    /// `host:port` of the DevTools server.
    endpoint: String,
    browser: Arc<WsConnection>,
    events: broadcast::Sender<BrowserEvent>,
    pages: Mutex<HashMap<TargetId, Arc<WsConnection>>>,
    pump: tokio::task::AbortHandle,
    product: String,
}

impl CdpWsBrowserDriver {
    /// Connects to the browser endpoint `ws://host:port/devtools/browser/<id>`.
    pub async fn connect(browser_url: &str) -> anyhow::Result<Arc<CdpWsBrowserDriver>> {
        let endpoint = browser_url
            .strip_prefix("ws://")
            .and_then(|rest| rest.split('/').next())
            .ok_or_else(|| anyhow::anyhow!("not a DevTools browser URL: {browser_url}"))?
            .to_string();
        let browser = WsConnection::connect(browser_url, || CdpError::Disconnected).await?;
        let version = browser.send("Browser.getVersion", json!({}), None).await?;
        let product = version.get("product").and_then(Value::as_str).unwrap_or("Chromium").to_string();
        let mut raw = browser.subscribe();
        let (events, _) = broadcast::channel(256);
        let sender = events.clone();
        let pump = tokio::spawn(async move {
            loop {
                match raw.recv().await {
                    Ok(event) => {
                        if let Some(mapped) = browser_event(&event) {
                            let _ = sender.send(mapped);
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
            let _ = sender.send(BrowserEvent::Disconnected);
        });
        browser.send("Target.setDiscoverTargets", json!({ "discover": true }), None).await?;
        let info = DriverInfo {
            id: "cdp+ws".into(),
            name: "Chrome DevTools Protocol".into(),
            protocol: "cdp".into(),
            transport: "ws".into(),
            browser: product.replace('/', " "),
        };
        Ok(Arc::new(CdpWsBrowserDriver {
            info,
            endpoint,
            browser,
            events,
            pages: Mutex::new(HashMap::new()),
            pump: pump.abort_handle(),
            product,
        }))
    }

    /// `Browser.getVersion`'s product, e.g. `HeadlessChrome/148.0.7778.96`.
    pub fn product(&self) -> &str {
        &self.product
    }

    /// A browser-level command (outside any tab).
    pub async fn browser_send(&self, method: &str, params: Value) -> anyhow::Result<Value> {
        Ok(self.browser.send(method, params, None).await?)
    }

    /// The page targets the browser has open.
    pub async fn page_targets(&self) -> anyhow::Result<Vec<TargetId>> {
        let targets = self.browser.send("Target.getTargets", json!({}), None).await?;
        Ok(targets
            .get("targetInfos")
            .and_then(Value::as_array)
            .map(|infos| {
                infos
                    .iter()
                    .filter(|info| info.get("type").and_then(Value::as_str) == Some("page"))
                    .filter_map(|info| info.get("targetId").and_then(Value::as_str).map(TargetId::from))
                    .collect()
            })
            .unwrap_or_default())
    }
}

impl Drop for CdpWsBrowserDriver {
    fn drop(&mut self) {
        self.pump.abort();
    }
}

fn browser_event(event: &CdpEvent) -> Option<BrowserEvent> {
    if event.session_id.is_some() {
        return None;
    }
    let info = &event.params["targetInfo"];
    match event.method.as_str() {
        "Target.targetCreated" if info["type"] == "page" => Some(BrowserEvent::TabOpened {
            target: TargetId::from(info["targetId"].as_str()?),
            opener: info.get("openerId").and_then(Value::as_str).map(TargetId::from),
            url: info.get("url").and_then(Value::as_str).unwrap_or("").to_string(),
        }),
        "Target.targetDestroyed" => {
            Some(BrowserEvent::TabClosed { target: TargetId::from(event.params["targetId"].as_str()?) })
        }
        _ => None,
    }
}

fn map(error: CdpError) -> DriverError {
    match error {
        CdpError::Disconnected => DriverError::Closed(CloseReason::BrowserDisconnected),
        CdpError::TargetClosed => DriverError::Closed(CloseReason::Closed),
        CdpError::Timeout(ms) => DriverError::Timeout(Duration::from_millis(ms)),
        CdpError::Protocol(message) => DriverError::Protocol(message),
    }
}

#[async_trait]
impl BrowserDriver for CdpWsBrowserDriver {
    fn info(&self) -> &DriverInfo {
        &self.info
    }

    fn events(&self) -> broadcast::Receiver<BrowserEvent> {
        self.events.subscribe()
    }

    /// Tabs open in the foreground: from Chromium 156, headless stops producing frames for a background tab once it
    /// takes input, so the next `Page.captureScreenshot` never answers. Background tabs were a workaround for
    /// a foreground tab ignoring selection-changing keys on macOS (Chromium 148); launch.rs now passes
    /// `--disable-renderer-accessibility` for that renderer deadlock.
    async fn open(&self, url: Option<&str>, _opts: &TabOptions) -> DriverResult<TargetId> {
        // On macOS, headless Chromium 148 foreground tabs trigger an AppKit key-selection deadlock and shrink the
        // screencast surface by the browser chrome height; on Linux/Windows Chromium 156+, foreground avoids stalled
        // frames after input.
        let background = cfg!(target_os = "macos");
        let created = self
            .browser
            .send("Target.createTarget", json!({ "url": url.unwrap_or("about:blank"), "background": background }), None)
            .await
            .map_err(map)?;
        created
            .get("targetId")
            .and_then(Value::as_str)
            .map(TargetId::from)
            .ok_or_else(|| DriverError::Protocol("Target.createTarget returned no targetId".into()))
    }

    async fn close(&self, target: &TargetId) -> DriverResult<()> {
        let page = self.pages.lock().unwrap().remove(target);
        let closed = self.browser.send("Target.closeTarget", json!({ "targetId": target.as_str() }), None).await;
        if let Some(page) = page {
            page.close();
        }
        match closed {
            Ok(_) => Ok(()),
            Err(CdpError::Protocol(message)) if message.contains("No target with given id") => Ok(()),
            Err(error) => Err(map(error)),
        }
    }

    async fn attach(&self, target: &TargetId) -> DriverResult<Arc<dyn TabDriver>> {
        let url = format!("ws://{}/devtools/page/{}", self.endpoint, target.as_str());
        let connection = WsConnection::connect(&url, || CdpError::TargetClosed)
            .await
            .map_err(|error| DriverError::Protocol(format!("attaching to {target}: {error}")))?;
        if let Some(previous) = self.pages.lock().unwrap().insert(target.clone(), connection.clone()) {
            previous.close();
        }
        let driver: Arc<dyn TabDriver> = CdpTabDriver::new(Arc::new(PageCdp { connection }));
        Ok(driver)
    }

    async fn shutdown(&self) {
        let pages: Vec<_> = self.pages.lock().unwrap().drain().map(|(_, page)| page).collect();
        for page in pages {
            page.close();
        }
        self.browser.close();
    }

    async fn quit(&self) -> DriverResult<()> {
        let closed = tokio::time::timeout(Duration::from_secs(3), self.browser.send("Browser.close", json!({}), None)).await;
        self.shutdown().await;
        match closed {
            Ok(Ok(_)) | Ok(Err(CdpError::Disconnected)) => Ok(()),
            Ok(Err(error)) => Err(map(error)),
            Err(_) => Err(DriverError::Timeout(Duration::from_secs(3))),
        }
    }
}
