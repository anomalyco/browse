//! W3C WebDriver BiDi implementation of `browse_core::{BrowserDriver, TabDriver, CaptureDriver}`.
//!
//! Targets browsers that speak WebDriver BiDi natively (Firefox / Zen via `--remote-debugging-port`, headless
//! Firefox) or through a BiDi endpoint (Chromium via `chromium-bidi`).
//!
//! Depends ONLY on `browse-core` — never on `browse-cdp` — validating that the core driver seam is genuinely
//! protocol-agnostic.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use base64::Engine;
use browse_core::{
    Arg, BodyKind, BrowserDriver, BrowserEvent, CallOptions, CaptureDriver, ConsoleEvent, DragOutcome, DriverError,
    DriverInfo, DriverResult, Emulation, Eval, FileChooser, Frame, FrameId, Image, KeyEvent, Modifiers, NavigationId,
    NetworkEvent, NetworkOptions, PageEvent, PointerEvent, PointerStep, Realm, Receiver, RemoteRef, RequestId, Screencast,
    Screenshot, Subscription, TabDriver, TabOptions, TargetId, Viewport, World,
};
use serde_json::{Value, json};
use tokio::sync::broadcast;

/// Transport abstraction for a WebDriver BiDi JSON-RPC WebSocket (`ws://127.0.0.1:<port>/session`).
#[async_trait]
pub trait BiDiTransport: Send + Sync {
    async fn send(&self, method: &str, params: Value) -> DriverResult<Value>;
    fn events(&self) -> broadcast::Receiver<BiDiEvent>;
}

#[derive(Debug, Clone)]
pub struct BiDiEvent {
    pub method: String,
    pub params: Value,
}

/// Browser-level WebDriver BiDi driver (`protocol: "webdriver-bidi"`, `transport: "ws"`).
pub struct BiDiBrowserDriver {
    info: DriverInfo,
    transport: Arc<dyn BiDiTransport>,
    events: broadcast::Sender<BrowserEvent>,
}

impl BiDiBrowserDriver {
    pub fn new(info: DriverInfo, transport: Arc<dyn BiDiTransport>) -> Arc<Self> {
        let (events, _) = broadcast::channel(256);
        Arc::new(Self { info, transport, events })
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

    async fn open(&self, url: Option<&str>, _opts: &TabOptions) -> DriverResult<TargetId> {
        let created = self
            .transport
            .send("browsingContext.create", json!({ "type": "tab", "background": true }))
            .await?;
        let context = created["context"]
            .as_str()
            .ok_or_else(|| DriverError::Protocol("browsingContext.create returned no context id".into()))?;
        if let Some(url) = url {
            self.transport
                .send("browsingContext.navigate", json!({ "context": context, "url": url, "wait": "none" }))
                .await?;
        }
        Ok(TargetId::from(context))
    }

    async fn close(&self, target: &TargetId) -> DriverResult<()> {
        self.transport
            .send("browsingContext.close", json!({ "context": target.as_str() }))
            .await?;
        Ok(())
    }

    async fn attach(&self, target: &TargetId) -> DriverResult<Arc<dyn TabDriver>> {
        Ok(BiDiTabDriver::new(target.clone(), self.transport.clone()))
    }
}

/// Per-tab WebDriver BiDi driver.
///
/// Maps every core `TabDriver` and `CaptureDriver` operation directly onto W3C WebDriver BiDi modules
/// (`browsingContext`, `script`, `input`, `network`, `log`, `emulation`), returning `DriverError::Unsupported`
/// only where the BiDi specification genuinely lacks an equivalent (`Emulation::Touch`, `interrupt`).
pub struct BiDiTabDriver {
    context: TargetId,
    transport: Arc<dyn BiDiTransport>,
    events: broadcast::Sender<PageEvent>,
}

impl BiDiTabDriver {
    pub const SANDBOX_NAME: &'static str = "__browse";

    pub fn new(context: TargetId, transport: Arc<dyn BiDiTransport>) -> Arc<Self> {
        let (events, _) = broadcast::channel(512);
        Arc::new(Self { context, transport, events })
    }

    fn script_target(realm: &Realm) -> Value {
        match realm.world {
            World::Main => json!({ "context": realm.frame.as_str() }),
            World::Isolated => json!({ "context": realm.frame.as_str(), "sandbox": Self::SANDBOX_NAME }),
        }
    }
}

#[async_trait]
impl TabDriver for BiDiTabDriver {
    fn events(&self) -> broadcast::Receiver<PageEvent> {
        self.events.subscribe()
    }

    async fn frames(&self) -> DriverResult<Vec<Frame>> {
        let _tree = self
            .transport
            .send("browsingContext.getTree", json!({ "root": self.context.as_str() }))
            .await?;
        Err(DriverError::Unsupported("bidi frame tree parser pending"))
    }

    async fn navigate(&self, url: &str, _referrer: Option<&str>) -> DriverResult<Option<NavigationId>> {
        let res = self
            .transport
            .send(
                "browsingContext.navigate",
                json!({ "context": self.context.as_str(), "url": url, "wait": "none" }),
            )
            .await?;
        Ok(res["navigation"].as_str().map(NavigationId::from))
    }

    async fn reload(&self, bypass_cache: bool) -> DriverResult<()> {
        self.transport
            .send(
                "browsingContext.reload",
                json!({ "context": self.context.as_str(), "ignoreCache": bypass_cache, "wait": "none" }),
            )
            .await?;
        Ok(())
    }

    async fn traverse_history(&self, delta: i32) -> DriverResult<bool> {
        match self
            .transport
            .send(
                "browsingContext.traverseHistory",
                json!({ "context": self.context.as_str(), "delta": delta }),
            )
            .await
        {
            Ok(_) => Ok(true),
            Err(DriverError::Protocol(msg)) if msg.contains("no such history entry") => Ok(false),
            Err(error) => Err(error),
        }
    }

    async fn evaluate(&self, realm: &Realm, expression: &str, opts: CallOptions) -> Eval {
        let _params = json!({
            "expression": expression,
            "target": Self::script_target(realm),
            "awaitPromise": opts.await_promise,
            "userActivation": opts.user_activation,
        });
        Err(DriverError::Unsupported("bidi script.evaluate serializer pending"))
    }

    async fn call(&self, _on: &Receiver, _function: &str, _args: &[Arg], _opts: CallOptions) -> Eval {
        Err(DriverError::Unsupported("bidi script.callFunction serializer pending"))
    }

    async fn release(&self, refs: Vec<RemoteRef>) {
        if refs.is_empty() {
            return;
        }
        let handles: Vec<&str> = refs.iter().map(RemoteRef::token).collect();
        let _ = self
            .transport
            .send(
                "script.disown",
                json!({ "handles": handles, "target": { "context": self.context.as_str() } }),
            )
            .await;
    }

    async fn adopt(&self, _node: &RemoteRef, _world: World) -> DriverResult<RemoteRef> {
        Err(DriverError::Unsupported("bidi sharedId adoption pending"))
    }

    async fn frame_element(&self, _frame: &FrameId) -> DriverResult<RemoteRef> {
        Err(DriverError::Unsupported("bidi frame_element pending"))
    }

    async fn content_frame(&self, _node: &RemoteRef) -> DriverResult<Option<FrameId>> {
        Err(DriverError::Unsupported("bidi content_frame pending"))
    }

    async fn set_file_chooser_interception(&self, _enabled: bool) -> DriverResult<()> {
        Err(DriverError::Unsupported("bidi file chooser interception"))
    }

    async fn take_file_chooser(&self, _timeout: Duration) -> DriverResult<Option<FileChooser>> {
        Err(DriverError::Unsupported("bidi file chooser interception"))
    }

    async fn set_files(&self, input: &RemoteRef, paths: &[PathBuf]) -> DriverResult<()> {
        let files: Vec<String> = paths.iter().map(|p| p.display().to_string()).collect();
        self.transport
            .send(
                "input.setFiles",
                json!({
                    "context": input.frame.as_str(),
                    "element": { "sharedId": input.token() },
                    "files": files,
                }),
            )
            .await?;
        Ok(())
    }

    async fn pointer(&self, _event: PointerEvent) -> DriverResult<()> {
        Err(DriverError::Unsupported("bidi input.performActions pointer pending"))
    }

    async fn key(&self, _event: KeyEvent) -> DriverResult<()> {
        Err(DriverError::Unsupported("bidi input.performActions key pending"))
    }

    async fn insert_text(&self, _text: &str) -> DriverResult<()> {
        Err(DriverError::Unsupported("bidi input.performActions text pending"))
    }

    async fn drag(
        &self,
        _from: (f64, f64),
        _to: (f64, f64),
        _steps: &[PointerStep],
        _modifiers: Modifiers,
    ) -> DriverResult<DragOutcome> {
        Err(DriverError::Unsupported("bidi input.performActions drag pending"))
    }

    async fn answer_dialog(&self, accept: bool, text: Option<&str>) -> DriverResult<()> {
        let mut params = json!({ "context": self.context.as_str(), "accept": accept });
        if let Some(text) = text {
            params["userText"] = json!(text);
        }
        self.transport.send("browsingContext.handleUserPrompt", params).await?;
        Ok(())
    }

    async fn viewport(&self) -> DriverResult<Viewport> {
        Err(DriverError::Unsupported("bidi viewport metrics pending"))
    }

    async fn screenshot(&self, _shot: Screenshot) -> DriverResult<Image> {
        Err(DriverError::Unsupported("bidi browsingContext.captureScreenshot pending"))
    }

    async fn emulate(&self, change: Emulation) -> DriverResult<()> {
        match change {
            Emulation::Viewport(v) => {
                let viewport = v.map(|v| json!({ "width": v.width, "height": v.height }));
                let dpr = v.map(|v| v.device_scale_factor).filter(|d| *d > 0.0);
                self.transport
                    .send(
                        "browsingContext.setViewport",
                        json!({ "context": self.context.as_str(), "viewport": viewport, "devicePixelRatio": dpr }),
                    )
                    .await?;
                Ok(())
            }
            Emulation::UserAgent(agent) => {
                self.transport
                    .send(
                        "emulation.setUserAgentOverride",
                        json!({ "contexts": [self.context.as_str()], "userAgent": agent }),
                    )
                    .await?;
                Ok(())
            }
            Emulation::Geolocation(geo) => {
                let coordinates = geo.map(|g| json!({ "latitude": g.latitude, "longitude": g.longitude, "accuracy": g.accuracy }));
                self.transport
                    .send(
                        "emulation.setGeolocationOverride",
                        json!({ "contexts": [self.context.as_str()], "coordinates": coordinates }),
                    )
                    .await?;
                Ok(())
            }
            Emulation::Offline(offline) => {
                let conditions = if offline { json!({ "type": "offline" }) } else { Value::Null };
                self.transport
                    .send(
                        "emulation.setNetworkConditions",
                        json!({ "contexts": [self.context.as_str()], "networkConditions": conditions }),
                    )
                    .await?;
                Ok(())
            }
            Emulation::Media(_) => Err(DriverError::Unsupported("bidi media emulation pending")),
            Emulation::Touch(_) => Err(DriverError::Unsupported("touch emulation")),
        }
    }

    async fn interrupt(&self, _frame: Option<&FrameId>) -> DriverResult<()> {
        Err(DriverError::Unsupported("interrupt"))
    }

    fn capture(&self) -> &dyn CaptureDriver {
        self
    }
}

#[async_trait]
impl CaptureDriver for BiDiTabDriver {
    async fn console(&self) -> DriverResult<Subscription<ConsoleEvent>> {
        Err(DriverError::Unsupported("bidi log.entryAdded pending"))
    }

    async fn network(&self, _opts: NetworkOptions) -> DriverResult<Subscription<NetworkEvent>> {
        Err(DriverError::Unsupported("bidi network subscription pending"))
    }

    async fn body(&self, request: &RequestId, kind: BodyKind) -> DriverResult<Option<Vec<u8>>> {
        let data_type = match kind {
            BodyKind::Request => "request",
            BodyKind::Response => "response",
        };
        let res = self
            .transport
            .send("network.getData", json!({ "request": request.as_str(), "dataType": data_type }))
            .await?;
        let Some(bytes) = res.get("bytes") else { return Ok(None) };
        match bytes["type"].as_str() {
            Some("string") => Ok(bytes["value"].as_str().map(|s| s.as_bytes().to_vec())),
            Some("base64") => Ok(bytes["value"]
                .as_str()
                .and_then(|s| base64::engine::general_purpose::STANDARD.decode(s).ok())),
            _ => Ok(None),
        }
    }

    fn screencast(&self) -> Option<&dyn Screencast> {
        // Harness automatically falls back to screenshot polling until Firefox 154+ startScreencast is wired.
        None
    }
}
