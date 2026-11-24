//! W3C WebDriver BiDi implementation of `browse_core::{BrowserDriver, TabDriver, CaptureDriver}`.
//!
//! Targets browsers that speak WebDriver BiDi natively (Firefox, and Firefox-based browsers such as Zen, started with
//! `--remote-debugging-port`, headless or not). Verified against Firefox 159.
//!
//! Depends only on `browse-core` (never on `browse-cdp`), which keeps the core driver seam protocol-agnostic. All
//! BiDi- and Firefox-specific reconciliation lives here:
//! - one session per browser, ended on shutdown so the browser accepts the next client
//! - frame ids are browsing context ids, documents are numbered on `navigationCommitted` (and on back/forward cache
//!   restores, which Firefox doesn't report as commits)
//! - browse's isolated world is the `__browse` sandbox; refs are `sharedId`s and handles, no table kept
//! - script calls give up with `Stale` when their document goes away, since Firefox never answers them
//! - pointer input is routed into cross-origin iframes, clicks are sent whole so double clicks count
//! - errors are mapped by WebDriver error code, never by message

mod capture;
mod image;
mod input;
mod tab;
mod transport;
mod value;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use browse_core::{
    BrowserDriver, BrowserEvent, DriverError, DriverInfo, DriverResult, TabDriver, TabOptions, TargetId,
};
use serde_json::{Value, json};
use tokio::sync::broadcast;

pub use tab::BiDiTabDriver;
pub use transport::{BiDiClient, BiDiError, BiDiEvent, BiDiTransport, map_error, session_url};

/// The sandbox browse's isolated world lives in.
pub const SANDBOX: &str = "__browse";

/// How long opening a visible tab waits for Firefox to activate it.
const ACTIVATE_WAIT: Duration = Duration::from_secs(3);

/// Browser-wide events: tabs opening and closing. `fragmentNavigated` only reaches Firefox clients through a
/// subscription that isn't scoped to contexts, so it is here too (tabs pick it up from the shared event stream).
const BROWSER_EVENTS: &[&str] = &[
    "browsingContext.contextCreated",
    "browsingContext.contextDestroyed",
    "browsingContext.fragmentNavigated",
];

/// Browser-level WebDriver BiDi driver (`protocol: "webdriver-bidi"`, `transport: "ws"`).
pub struct BiDiBrowserDriver {
    info: DriverInfo,
    transport: Arc<dyn BiDiTransport>,
    client: Option<Arc<BiDiClient>>,
    events: broadcast::Sender<BrowserEvent>,
    subscription: Mutex<Option<String>>,
    pump: tokio::task::AbortHandle,
}

impl BiDiBrowserDriver {
    /// Connects to a browser's WebDriver BiDi endpoint (`ws://127.0.0.1:<port>` as Firefox prints it, or its
    /// `/session` URL) and starts a session.
    pub async fn connect(url: &str) -> DriverResult<Arc<BiDiBrowserDriver>> {
        Self::from_client(BiDiClient::connect(url).await?).await
    }

    /// `connect` over a TCP connection the caller opened (and checked) itself.
    pub async fn connect_stream(url: &str, stream: tokio::net::TcpStream) -> DriverResult<Arc<BiDiBrowserDriver>> {
        Self::from_client(BiDiClient::connect_stream(url, stream).await?).await
    }

    /// `connect`, refusing a non-loopback peer unless `allow_remote`; also says whether the peer is loopback.
    pub async fn connect_loopback_checked(url: &str, allow_remote: bool) -> DriverResult<(Arc<BiDiBrowserDriver>, bool)> {
        let (client, local) = BiDiClient::connect_loopback_checked(url, allow_remote).await?;
        Ok((Self::from_client(client).await?, local))
    }

    async fn from_client(client: Arc<BiDiClient>) -> DriverResult<Arc<BiDiBrowserDriver>> {
        let capabilities = client.capabilities();
        let name = capabilities.get("browserName").and_then(Value::as_str).unwrap_or("browser");
        let version = capabilities.get("browserVersion").and_then(Value::as_str).unwrap_or("");
        let info = DriverInfo {
            id: "bidi+ws".into(),
            name: "WebDriver BiDi".into(),
            protocol: "webdriver-bidi".into(),
            transport: "ws".into(),
            browser: format!("{name} {version}").trim().to_string(),
        };
        let transport: Arc<dyn BiDiTransport> = client.clone();
        match Self::start(info, transport, Some(client.clone())).await {
            Ok(driver) => Ok(driver),
            Err(error) => {
                client.shutdown().await;
                Err(error)
            }
        }
    }

    /// A driver over an existing session (a test double, or a transport the caller manages).
    pub async fn new(info: DriverInfo, transport: Arc<dyn BiDiTransport>) -> DriverResult<Arc<BiDiBrowserDriver>> {
        Self::start(info, transport, None).await
    }

    async fn start(
        info: DriverInfo,
        transport: Arc<dyn BiDiTransport>,
        client: Option<Arc<BiDiClient>>,
    ) -> DriverResult<Arc<BiDiBrowserDriver>> {
        let mut raw = transport.events();
        let subscribed = transport
            .send("session.subscribe", json!({ "events": BROWSER_EVENTS }))
            .await
            .map_err(map_error)?;
        let subscription = subscribed.get("subscription").and_then(Value::as_str).map(str::to_string);
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
        Ok(Arc::new(BiDiBrowserDriver {
            info,
            transport,
            client,
            events,
            subscription: Mutex::new(subscription),
            pump: pump.abort_handle(),
        }))
    }

    pub fn transport(&self) -> &Arc<dyn BiDiTransport> {
        &self.transport
    }

    /// The capabilities the session started with (`browserName`, `browserVersion`, ...), when this driver started it.
    pub fn capabilities(&self) -> Value {
        self.client.as_ref().map(|client| client.capabilities().clone()).unwrap_or(Value::Null)
    }

    /// Ends the session (when this driver started it), so the browser accepts another client.
    pub async fn shutdown(&self) {
        let subscription = self.subscription.lock().unwrap().take();
        if let Some(id) = subscription {
            let _ = tokio::time::timeout(
                Duration::from_secs(2),
                self.transport.send("session.unsubscribe", json!({ "subscriptions": [id] })),
            )
            .await;
        }
        if let Some(client) = &self.client {
            client.shutdown().await;
        }
    }
}

impl Drop for BiDiBrowserDriver {
    fn drop(&mut self) {
        self.pump.abort();
    }
}

fn browser_event(event: &BiDiEvent) -> Option<BrowserEvent> {
    let params = &event.params;
    if !params.get("parent").is_none_or(Value::is_null) {
        return None;
    }
    let context = params.get("context").and_then(Value::as_str)?;
    match event.method.as_str() {
        "browsingContext.contextCreated" => Some(BrowserEvent::TabOpened {
            target: TargetId::from(context),
            opener: params.get("originalOpener").and_then(Value::as_str).map(TargetId::from),
            url: params.get("url").and_then(Value::as_str).unwrap_or("").to_string(),
        }),
        "browsingContext.contextDestroyed" => Some(BrowserEvent::TabClosed { target: TargetId::from(context) }),
        _ => None,
    }
}

#[async_trait]
impl BrowserDriver for BiDiBrowserDriver {
    fn info(&self) -> &DriverInfo {
        &self.info
    }

    fn events(&self) -> broadcast::Receiver<BrowserEvent> {
        self.events.subscribe()
    }

    async fn open(&self, url: Option<&str>, opts: &TabOptions) -> DriverResult<TargetId> {
        // Created in the background, then activated (briefly): a foreground create waits for the window to take focus,
        // which a Firefox without the recommended remote prefs (a real profile, remote.prefs.recommended off) may never
        // report while headless.
        let created = self
            .transport
            .send("browsingContext.create", json!({ "type": "tab", "background": true }))
            .await
            .map_err(map_error)?;
        let context = created
            .get("context")
            .and_then(Value::as_str)
            .ok_or_else(|| DriverError::Protocol("browsingContext.create returned no context".into()))?
            .to_string();
        if opts.keep_visible {
            let _ = tokio::time::timeout(ACTIVATE_WAIT, self.transport.send("browsingContext.activate", json!({ "context": context }))).await;
        }
        if let Some(url) = url {
            // Firefox answers navigate only once the response starts; the tab is usable before that.
            let transport = self.transport.clone();
            let params = json!({ "context": context, "url": url, "wait": "none" });
            tokio::spawn(async move {
                let _ = transport.send("browsingContext.navigate", params).await;
            });
        }
        Ok(TargetId::from(context))
    }

    async fn close(&self, target: &TargetId) -> DriverResult<()> {
        // Closing the last tab quits Firefox on Linux and Windows: leave that one blank instead.
        let tree = self.transport.send("browsingContext.getTree", json!({ "maxDepth": 0 })).await.map_err(map_error)?;
        let contexts = tree.get("contexts").and_then(Value::as_array).cloned().unwrap_or_default();
        let listed = contexts.iter().any(|c| c.get("context").and_then(Value::as_str) == Some(target.as_str()));
        if !listed {
            return Ok(());
        }
        if contexts.len() <= 1 {
            return match self
                .transport
                .send("browsingContext.navigate", json!({ "context": target.as_str(), "url": "about:blank", "wait": "none" }))
                .await
            {
                Ok(_) => Ok(()),
                Err(error) if error.code() == Some("no such frame") => Ok(()),
                Err(error) => Err(map_error(error)),
            };
        }
        match self
            .transport
            .send("browsingContext.close", json!({ "context": target.as_str(), "promptUnload": false }))
            .await
        {
            Ok(_) => Ok(()),
            Err(error) if error.code() == Some("no such frame") => Ok(()),
            Err(error) => Err(map_error(error)),
        }
    }

    async fn attach(&self, target: &TargetId) -> DriverResult<Arc<dyn TabDriver>> {
        let tab: Arc<dyn TabDriver> = BiDiTabDriver::attach(self.transport.clone(), target.clone()).await?;
        Ok(tab)
    }

    async fn shutdown(&self) {
        BiDiBrowserDriver::shutdown(self).await;
    }

    /// `browser.close` (Firefox closes every window and exits; it may drop the connection before answering), then
    /// the session ends.
    async fn quit(&self) -> DriverResult<()> {
        let closed = tokio::time::timeout(Duration::from_secs(2), self.transport.send("browser.close", json!({}))).await;
        self.shutdown().await;
        match closed {
            Ok(Ok(_)) | Ok(Err(BiDiError::Closed)) => Ok(()),
            Ok(Err(error)) => Err(map_error(error)),
            Err(_) => Err(DriverError::Timeout(Duration::from_secs(2))),
        }
    }
}

#[cfg(test)]
mod tests;
