//! Protocol-agnostic browser driver contracts.
//!
//! Nothing in `browse-core` mentions CDP, WebDriver BiDi, or any specific browser engine. Protocol crates (such as
//! `browse-cdp` or `browse-bidi`) implement `BrowserDriver`, `TabDriver`, and `CaptureDriver`. The harness crates
//! (`browse-page`, `browse-capture`, `browse-script`, and the relay's tab/policy layer) program solely against
//! these traits.

use std::fmt;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::{broadcast, mpsc};

use crate::{HandoffResult, TabOptions};

// ---------------------------------------------------------------------------
// Opaque identifiers
// ---------------------------------------------------------------------------

macro_rules! id_type {
    ($name:ident) => {
        #[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
        pub struct $name(pub Arc<str>);

        impl Serialize for $name {
            fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                serializer.serialize_str(&self.0)
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                String::deserialize(deserializer).map(Self::from)
            }
        }

        impl $name {
            pub fn new(value: impl Into<Arc<str>>) -> Self {
                Self(value.into())
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl From<String> for $name {
            fn from(value: String) -> Self {
                Self(Arc::from(value))
            }
        }

        impl From<&str> for $name {
            fn from(value: &str) -> Self {
                Self(Arc::from(value))
            }
        }

        impl AsRef<str> for $name {
            fn as_ref(&self) -> &str {
                &self.0
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(&self.0)
            }
        }
    };
}

id_type!(TargetId);
id_type!(FrameId);
id_type!(NavigationId);
id_type!(RequestId);

/// Monotonic per-document identifier bumped by the driver on every cross-document commit.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Default, Serialize, Deserialize)]
pub struct DocumentId(pub u64);

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CloseReason {
    Closed,
    Crashed,
    Detached(String),
    BrowserDisconnected,
}

impl fmt::Display for CloseReason {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CloseReason::Closed => write!(f, "its tab closed or browse was detached from it"),
            CloseReason::Crashed => write!(f, "its tab crashed"),
            CloseReason::Detached(reason) => write!(f, "its tab went away ({reason})"),
            CloseReason::BrowserDisconnected => write!(f, "the browser disconnected"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NavigationErrorKind {
    Aborted,
    Blocked,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NavigationError {
    pub kind: NavigationErrorKind,
    pub detail: String,
}

impl fmt::Display for NavigationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.detail)
    }
}

/// Typed errors returned by every driver. The harness matches these variants rather than browser-specific strings.
#[derive(Debug, thiserror::Error)]
pub enum DriverError {
    #[error("{0}")]
    Closed(CloseReason),
    #[error("the frame, execution world, or element handle no longer exists")]
    Stale,
    #[error("{0}")]
    Navigation(NavigationError),
    #[error("{0}")]
    Refused(String),
    #[error("{0} is not supported by this browser driver")]
    Unsupported(&'static str),
    #[error("timed out after {} ms", .0.as_millis())]
    Timeout(Duration),
    #[error("{0}")]
    Protocol(String),
}

pub type DriverResult<T> = std::result::Result<T, DriverError>;

// ---------------------------------------------------------------------------
// Browser-level driver seam
// ---------------------------------------------------------------------------

/// Identifies a connected browser driver (`protocol × transport`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriverInfo {
    pub id: String,
    pub name: String,
    pub protocol: String,
    pub transport: String,
    pub browser: String,
}

#[derive(Debug, Clone)]
pub enum BrowserEvent {
    TabOpened {
        target: TargetId,
        opener: Option<TargetId>,
        url: String,
    },
    TabClosed {
        target: TargetId,
    },
    Disconnected,
}

/// Optional browser-chrome UX available when an extension runs inside the user's visible browser.
#[async_trait]
pub trait UserPresence: Send + Sync {
    async fn handoff(&self, target: &TargetId, message: &str, timeout: Duration) -> anyhow::Result<HandoffResult>;
    async fn set_group(&self, target: &TargetId, group: Option<&str>) -> anyhow::Result<()>;
    async fn set_keep_open(&self, target: &TargetId, keep_open: bool) -> anyhow::Result<()>;
}

/// Browser-level control driver (`cdp+extension`, `cdp+ws`, `bidi+ws`, ...).
#[async_trait]
pub trait BrowserDriver: Send + Sync {
    fn info(&self) -> &DriverInfo;
    fn events(&self) -> broadcast::Receiver<BrowserEvent>;
    async fn open(&self, url: Option<&str>, opts: &TabOptions) -> DriverResult<TargetId>;
    async fn close(&self, target: &TargetId) -> DriverResult<()>;
    /// Attach to `target` and return a ready-to-use `TabDriver` (no separate init step).
    async fn attach(&self, target: &TargetId) -> DriverResult<Arc<dyn TabDriver>>;
    fn presence(&self) -> Option<&dyn UserPresence> {
        None
    }
}

// ---------------------------------------------------------------------------
// Frames, lifecycle, and dialogs
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    pub id: FrameId,
    pub parent: Option<FrameId>,
    pub url: String,
    pub name: String,
    pub document: DocumentId,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum LoadState {
    DomContentLoaded,
    Load,
    NetworkIdle,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DialogKind {
    Alert,
    Confirm,
    Prompt,
    BeforeUnload,
}

impl DialogKind {
    pub fn as_str(self) -> &'static str {
        match self {
            DialogKind::Alert => "alert",
            DialogKind::Confirm => "confirm",
            DialogKind::Prompt => "prompt",
            DialogKind::BeforeUnload => "beforeunload",
        }
    }

    pub fn from_wire(value: &str) -> Self {
        match value {
            "confirm" => DialogKind::Confirm,
            "prompt" => DialogKind::Prompt,
            "beforeunload" => DialogKind::BeforeUnload,
            _ => DialogKind::Alert,
        }
    }
}

impl fmt::Display for DialogKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Dialog {
    #[serde(rename = "type")]
    pub kind: DialogKind,
    pub message: String,
    #[serde(rename = "defaultPrompt", skip_serializing_if = "String::is_empty")]
    pub default_prompt: String,
    pub url: String,
}

/// A native file chooser that opened while interception was armed.
#[derive(Debug, Clone)]
pub struct FileChooser {
    pub frame: FrameId,
    /// The file input the chooser would have filled; None when the browser didn't name one.
    pub input: Option<RemoteRef>,
}

/// Normalized per-tab events emitted by a `TabDriver`.
#[derive(Debug, Clone)]
pub enum PageEvent {
    FrameAttached(Frame),
    /// Whole subtree detached; process swaps are invisible to the harness.
    FrameDetached(FrameId),
    NavigationStarted {
        frame: FrameId,
        navigation: Option<NavigationId>,
        url: String,
    },
    NavigationAborted {
        frame: FrameId,
    },
    Committed {
        frame: FrameId,
        document: DocumentId,
        navigation: Option<NavigationId>,
        url: String,
        name: String,
    },
    /// Same-document URL change (hash / pushState).
    UrlChanged {
        frame: FrameId,
        url: String,
    },
    Loaded {
        frame: FrameId,
        document: DocumentId,
        state: LoadState,
    },
    DialogOpened(Dialog),
    DialogClosed {
        accepted: bool,
    },
    PopupOpened {
        url: String,
    },
    /// Terminal event emitted once when the tab closes, crashes, or detaches.
    Closed(CloseReason),
}

// ---------------------------------------------------------------------------
// Script execution and remote object handles
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum World {
    Main,
    /// The driver's private isolated world for browse, created lazily per frame/document.
    Isolated,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Realm {
    pub frame: FrameId,
    pub world: World,
}

/// An opaque driver-issued reference to a remote JS object or DOM node.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteRef {
    pub frame: FrameId,
    pub world: World,
    pub document: DocumentId,
    token: Arc<str>,
}

impl RemoteRef {
    pub fn new(frame: FrameId, world: World, document: DocumentId, token: impl Into<Arc<str>>) -> Self {
        Self { frame, world, document, token: token.into() }
    }

    pub fn token(&self) -> &str {
        &self.token
    }
}

#[derive(Debug, Clone)]
pub enum Arg {
    Json(Value),
    Ref(RemoteRef),
    Undefined,
}

#[derive(Debug, Clone)]
pub enum Receiver {
    Global(Realm),
    Ref(RemoteRef),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Returns {
    /// Return JSON-serialisable values (`undefined` serialized as `Value::Null`).
    #[default]
    Json,
    /// Return a remote handle (`Evaluated::Node` / `Evaluated::Object`) or primitive JSON.
    Ref,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct CallOptions {
    pub returns: Returns,
    pub await_promise: bool,
    pub user_activation: bool,
}

#[derive(Debug, Clone)]
pub enum Evaluated {
    Json(Value),
    Node(RemoteRef),
    Object(RemoteRef),
}

#[derive(Debug, Clone, Default)]
pub struct JsError {
    pub name: Option<String>,
    pub message: String,
    pub stack: Option<String>,
    pub thrown: Option<Value>,
    pub url: Option<String>,
    pub line: Option<i64>,
    pub column: Option<i64>,
    /// True when the engine rejected syntax at compile time (no code executed).
    pub is_compile_syntax_error: bool,
}

pub type Eval = std::result::Result<std::result::Result<Evaluated, Box<JsError>>, DriverError>;

// ---------------------------------------------------------------------------
// Input (pure DOM semantics; no platform virtual key codes or wire bitmasks)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Modifiers(pub u8);

impl Modifiers {
    pub const NONE: Modifiers = Modifiers(0);
    pub const ALT: Modifiers = Modifiers(1);
    pub const CONTROL: Modifiers = Modifiers(2);
    pub const META: Modifiers = Modifiers(4);
    pub const SHIFT: Modifiers = Modifiers(8);

    pub fn contains(self, other: Modifiers) -> bool {
        self.0 & other.0 == other.0
    }

    pub fn insert(&mut self, other: Modifiers) {
        self.0 |= other.0;
    }

    pub fn remove(&mut self, other: Modifiers) {
        self.0 &= !other.0;
    }

    pub fn bits(self) -> u8 {
        self.0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MouseButton {
    None,
    Left,
    Right,
    Middle,
    Back,
    Forward,
}

impl MouseButton {
    pub fn as_str(self) -> &'static str {
        match self {
            MouseButton::None => "none",
            MouseButton::Left => "left",
            MouseButton::Right => "right",
            MouseButton::Middle => "middle",
            MouseButton::Back => "back",
            MouseButton::Forward => "forward",
        }
    }

    pub fn from_name(name: &str) -> Option<Self> {
        match name {
            "left" => Some(MouseButton::Left),
            "right" => Some(MouseButton::Right),
            "middle" => Some(MouseButton::Middle),
            "back" => Some(MouseButton::Back),
            "forward" => Some(MouseButton::Forward),
            "none" => Some(MouseButton::None),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub enum PointerEvent {
    Move { x: f64, y: f64, modifiers: Modifiers },
    Down { x: f64, y: f64, button: MouseButton, click_count: u32, modifiers: Modifiers },
    Up { x: f64, y: f64, button: MouseButton, click_count: u32, modifiers: Modifiers },
    Wheel { x: f64, y: f64, delta_x: f64, delta_y: f64, modifiers: Modifiers },
}

#[derive(Debug, Clone)]
pub struct KeyEvent {
    pub down: bool,
    pub key: String,
    pub code: String,
    pub text: String,
    pub modifiers: Modifiers,
    pub mac: bool,
}

#[derive(Debug, Clone, Copy)]
pub struct PointerStep {
    pub x: f64,
    pub y: f64,
    pub delay_ms: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DragOutcome {
    Dropped,
    NotDraggable,
}

// ---------------------------------------------------------------------------
// View, screenshots, and emulation
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy)]
pub struct Viewport {
    pub page_x: f64,
    pub page_y: f64,
    pub width: f64,
    pub height: f64,
    pub layout_width: Option<f64>,
    pub layout_height: Option<f64>,
    pub content_width: f64,
    pub content_height: f64,
    pub device_pixel_ratio: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageFormat {
    Png,
    Jpeg,
    Webp,
}

impl ImageFormat {
    pub fn name(self) -> &'static str {
        match self {
            ImageFormat::Png => "png",
            ImageFormat::Jpeg => "jpeg",
            ImageFormat::Webp => "webp",
        }
    }

    pub fn mime(self) -> &'static str {
        match self {
            ImageFormat::Png => "image/png",
            ImageFormat::Jpeg => "image/jpeg",
            ImageFormat::Webp => "image/webp",
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Copy)]
pub enum ScreenshotArea {
    Viewport,
    /// Clip rectangle in page CSS pixels; `beyond_viewport` indicates it extends past the current viewport.
    Clip { rect: Rect, beyond_viewport: bool },
}

#[derive(Debug, Clone, Copy)]
pub struct Screenshot {
    pub format: ImageFormat,
    pub quality: Option<i64>,
    pub area: ScreenshotArea,
    pub scale: f64,
}

#[derive(Debug, Clone)]
pub struct Image {
    pub bytes: Vec<u8>,
    pub format: ImageFormat,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Copy)]
pub struct ViewportOverride {
    pub width: u64,
    pub height: u64,
    pub device_scale_factor: f64,
    pub mobile: bool,
}

#[derive(Debug, Clone)]
pub struct MediaFeature {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, Default)]
pub struct MediaOverride {
    pub media: String,
    pub features: Vec<MediaFeature>,
}

#[derive(Debug, Clone, Copy)]
pub struct Geolocation {
    pub latitude: f64,
    pub longitude: f64,
    pub accuracy: f64,
}

/// Per-operation emulation override. Drivers return `DriverError::Unsupported` for any variant their protocol lacks.
#[derive(Debug, Clone)]
pub enum Emulation {
    Viewport(Option<ViewportOverride>),
    Media(MediaOverride),
    UserAgent(Option<String>),
    Geolocation(Option<Geolocation>),
    Touch(Option<u32>),
    Offline(bool),
}

// ---------------------------------------------------------------------------
// Capture types & Subscription<T>
// ---------------------------------------------------------------------------

type CleanupFn = Box<dyn FnOnce() -> Pin<Box<dyn Future<Output = ()> + Send>> + Send>;

/// A live driver stream that cleanly stops the underlying browser subscription on `stop()` or `Drop`.
pub struct Subscription<T> {
    rx: mpsc::UnboundedReceiver<T>,
    abort: Option<tokio::task::AbortHandle>,
    cleanup: Option<CleanupFn>,
}

impl<T> Subscription<T> {
    pub fn new(
        rx: mpsc::UnboundedReceiver<T>,
        abort: Option<tokio::task::AbortHandle>,
        cleanup: Option<CleanupFn>,
    ) -> Self {
        Self { rx, abort, cleanup }
    }

    pub async fn recv(&mut self) -> Option<T> {
        self.rx.recv().await
    }

    /// Stops the subscription and awaits its cleanup hook.
    pub async fn stop(mut self) {
        if let Some(abort) = self.abort.take() {
            abort.abort();
        }
        if let Some(cleanup) = self.cleanup.take() {
            cleanup().await;
        }
    }
}

impl<T> Drop for Subscription<T> {
    fn drop(&mut self) {
        if let Some(abort) = self.abort.take() {
            abort.abort();
        }
        if let Some(cleanup) = self.cleanup.take()
            && let Ok(handle) = tokio::runtime::Handle::try_current()
        {
            handle.spawn(cleanup());
        }
    }
}

#[derive(Debug, Clone)]
pub struct ConsoleEntry {
    pub kind: String,
    pub text: String,
    pub source: Option<String>,
    pub target: Option<String>,
    pub url: Option<String>,
    pub line: Option<i64>,
}

#[derive(Debug, Clone)]
pub enum ConsoleEvent {
    Entry(ConsoleEntry),
    Closed(CloseReason),
}

#[derive(Debug, Clone, Copy, Default)]
pub struct NetworkOptions {
    pub bodies: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BodyKind {
    Request,
    Response,
}

#[derive(Debug, Clone)]
pub struct NetworkRequest {
    pub id: RequestId,
    pub redirect_of: Option<String>,
    pub frame: Option<FrameId>,
    pub url: String,
    pub method: String,
    pub headers: Vec<(String, String)>,
    pub resource_type: String,
    pub post_data: Option<String>,
    pub has_body: bool,
}

#[derive(Debug, Clone)]
pub struct ResponseHead {
    pub status: i64,
    pub status_text: String,
    pub headers: Vec<(String, String)>,
    pub mime_type: Option<String>,
}

/// Coherent, protocol-neutral network lifecycle events (extra-info merging and child-target handoff live in the driver).
#[derive(Debug, Clone)]
pub enum NetworkEvent {
    Request(NetworkRequest),
    Response {
        id: RequestId,
        head: ResponseHead,
        /// True when the response has already committed (e.g. a document handed to a child process) and should
        /// complete rather than fail if capture stops before the trailing finish event arrives.
        committed: bool,
    },
    Finished {
        id: RequestId,
        body_size: usize,
        request_headers: Option<Vec<(String, String)>>,
        response_headers: Option<Vec<(String, String)>>,
    },
    Failed { id: RequestId, error: String },
    Lagged(u64),
    Closed(CloseReason),
}

#[derive(Debug, Clone, Copy)]
pub struct ScreencastOptions {
    pub frame_rate: u32,
    pub quality: u32,
}

#[derive(Clone)]
pub struct ScreencastFrame {
    pub jpeg: Arc<Vec<u8>>,
    pub device_width: Option<f64>,
    pub device_height: Option<f64>,
    pub at: Instant,
    pub fallback: bool,
}

// ---------------------------------------------------------------------------
// Core TabDriver & CaptureDriver traits
// ---------------------------------------------------------------------------

/// Protocol-agnostic control interface for one browser tab.
///
/// Drivers own their internal frame tree, document ids, isolated worlds, and session routing.
#[async_trait]
pub trait TabDriver: Send + Sync {
    /// Subscribe to normalized page events. On `RecvError::Lagged`, re-sync with `frames()`.
    fn events(&self) -> broadcast::Receiver<PageEvent>;

    /// Current frame tree snapshot (main frame first).
    async fn frames(&self) -> DriverResult<Vec<Frame>>;

    // --- Navigation ---

    /// Navigate the main frame. Returns `None` for same-document navigations (e.g. fragment change).
    async fn navigate(&self, url: &str, referrer: Option<&str>) -> DriverResult<Option<NavigationId>>;
    async fn reload(&self, bypass_cache: bool) -> DriverResult<()>;
    /// Step backward (`delta < 0`) or forward (`delta > 0`) in session history; `false` if no such entry exists.
    async fn traverse_history(&self, delta: i32) -> DriverResult<bool>;

    // --- Script & DOM refs ---

    async fn evaluate(&self, realm: &Realm, expression: &str, opts: CallOptions) -> Eval;
    async fn call(&self, on: &Receiver, function: &str, args: &[Arg], opts: CallOptions) -> Eval;
    async fn release(&self, refs: Vec<RemoteRef>);
    async fn adopt(&self, node: &RemoteRef, world: World) -> DriverResult<RemoteRef>;
    /// The `<iframe>` element owning `frame`, in its parent frame's `World::Isolated`.
    async fn frame_element(&self, frame: &FrameId) -> DriverResult<RemoteRef>;
    /// The child frame shown by an `<iframe>` element, if attached.
    async fn content_frame(&self, node: &RemoteRef) -> DriverResult<Option<FrameId>>;
    async fn set_files(&self, input: &RemoteRef, paths: &[PathBuf]) -> DriverResult<()>;
    /// Enables or disables interception of native file choosers on the tab and every attached child frame.
    async fn set_file_chooser_interception(&self, enabled: bool) -> DriverResult<()>;
    /// The file chooser opened since interception was enabled, waiting up to `timeout` for one.
    async fn take_file_chooser(&self, timeout: Duration) -> DriverResult<Option<FileChooser>>;

    // --- Input & dialogs ---

    async fn pointer(&self, event: PointerEvent) -> DriverResult<()>;
    async fn key(&self, event: KeyEvent) -> DriverResult<()>;
    async fn insert_text(&self, text: &str) -> DriverResult<()>;
    async fn drag(
        &self,
        from: (f64, f64),
        to: (f64, f64),
        steps: &[PointerStep],
        modifiers: Modifiers,
    ) -> DriverResult<DragOutcome>;
    async fn answer_dialog(&self, accept: bool, text: Option<&str>) -> DriverResult<()>;

    // --- View ---

    async fn viewport(&self) -> DriverResult<Viewport>;
    async fn screenshot(&self, shot: Screenshot) -> DriverResult<Image>;

    // --- Per-operation optional methods ---

    async fn emulate(&self, _change: Emulation) -> DriverResult<()> {
        Err(DriverError::Unsupported("emulation"))
    }

    async fn interrupt(&self, _frame: Option<&FrameId>) -> DriverResult<()> {
        Err(DriverError::Unsupported("interrupt"))
    }

    fn capture(&self) -> &dyn CaptureDriver;
}

/// Live capture surface for a tab (console, network, optional native screencast).
#[async_trait]
pub trait CaptureDriver: Send + Sync {
    /// Page-world console messages and uncaught errors (driver filters out browse's isolated world).
    async fn console(&self) -> DriverResult<Subscription<ConsoleEvent>>;
    async fn network(&self, opts: NetworkOptions) -> DriverResult<Subscription<NetworkEvent>>;
    async fn body(&self, request: &RequestId, kind: BodyKind) -> DriverResult<Option<Vec<u8>>>;
    fn screencast(&self) -> Option<&dyn Screencast> {
        None
    }
}

/// Optional native frame-streaming screencast; when `None`, the harness polls `TabDriver::screenshot`.
#[async_trait]
pub trait Screencast: Send + Sync {
    async fn start(&self, options: ScreencastOptions) -> DriverResult<Subscription<ScreencastFrame>>;
}

// ---------------------------------------------------------------------------
// Semantic policy decorator (works identically for every protocol)
// ---------------------------------------------------------------------------

/// Policy checked at the semantic `TabDriver` boundary (read-only tabs, origin allowlist).
pub trait TabPolicy: Send + Sync {
    fn is_read_only(&self) -> bool {
        false
    }
    fn check_navigation(&self, _url: &str) -> Result<(), String> {
        Ok(())
    }
}

/// Wraps any `TabDriver` to enforce `TabPolicy` uniformly regardless of underlying protocol.
pub struct GuardedTabDriver {
    inner: Arc<dyn TabDriver>,
    policy: Arc<dyn TabPolicy>,
}

impl GuardedTabDriver {
    pub fn new(inner: Arc<dyn TabDriver>, policy: Arc<dyn TabPolicy>) -> Arc<Self> {
        Arc::new(Self { inner, policy })
    }

    fn check_write(&self, action: &str) -> DriverResult<()> {
        if self.policy.is_read_only() {
            return Err(DriverError::Refused(crate::read_only_refusal(action)));
        }
        Ok(())
    }
}

#[async_trait]
impl TabDriver for GuardedTabDriver {
    fn events(&self) -> broadcast::Receiver<PageEvent> {
        self.inner.events()
    }

    async fn frames(&self) -> DriverResult<Vec<Frame>> {
        self.inner.frames().await
    }

    async fn navigate(&self, url: &str, referrer: Option<&str>) -> DriverResult<Option<NavigationId>> {
        self.check_write("navigate")?;
        if let Err(reason) = self.policy.check_navigation(url) {
            return Err(DriverError::Refused(reason));
        }
        self.inner.navigate(url, referrer).await
    }

    async fn reload(&self, bypass_cache: bool) -> DriverResult<()> {
        self.check_write("reload")?;
        self.inner.reload(bypass_cache).await
    }

    async fn traverse_history(&self, delta: i32) -> DriverResult<bool> {
        self.check_write("navigate")?;
        self.inner.traverse_history(delta).await
    }

    async fn evaluate(&self, realm: &Realm, expression: &str, opts: CallOptions) -> Eval {
        self.inner.evaluate(realm, expression, opts).await
    }

    async fn call(&self, on: &Receiver, function: &str, args: &[Arg], opts: CallOptions) -> Eval {
        self.inner.call(on, function, args, opts).await
    }

    async fn release(&self, refs: Vec<RemoteRef>) {
        self.inner.release(refs).await
    }

    async fn adopt(&self, node: &RemoteRef, world: World) -> DriverResult<RemoteRef> {
        self.inner.adopt(node, world).await
    }

    async fn frame_element(&self, frame: &FrameId) -> DriverResult<RemoteRef> {
        self.inner.frame_element(frame).await
    }

    async fn content_frame(&self, node: &RemoteRef) -> DriverResult<Option<FrameId>> {
        self.inner.content_frame(node).await
    }

    async fn set_files(&self, input: &RemoteRef, paths: &[PathBuf]) -> DriverResult<()> {
        self.check_write("upload")?;
        self.inner.set_files(input, paths).await
    }

    async fn set_file_chooser_interception(&self, enabled: bool) -> DriverResult<()> {
        self.check_write("upload")?;
        self.inner.set_file_chooser_interception(enabled).await
    }

    async fn take_file_chooser(&self, timeout: Duration) -> DriverResult<Option<FileChooser>> {
        self.inner.take_file_chooser(timeout).await
    }

    async fn pointer(&self, event: PointerEvent) -> DriverResult<()> {
        if !matches!(event, PointerEvent::Wheel { .. }) {
            self.check_write("pointer")?;
        }
        self.inner.pointer(event).await
    }

    async fn key(&self, event: KeyEvent) -> DriverResult<()> {
        self.check_write("key")?;
        self.inner.key(event).await
    }

    async fn insert_text(&self, text: &str) -> DriverResult<()> {
        self.check_write("type")?;
        self.inner.insert_text(text).await
    }

    async fn drag(
        &self,
        from: (f64, f64),
        to: (f64, f64),
        steps: &[PointerStep],
        modifiers: Modifiers,
    ) -> DriverResult<DragOutcome> {
        self.check_write("drag")?;
        self.inner.drag(from, to, steps, modifiers).await
    }

    async fn answer_dialog(&self, accept: bool, text: Option<&str>) -> DriverResult<()> {
        self.check_write("dialog")?;
        self.inner.answer_dialog(accept, text).await
    }

    async fn viewport(&self) -> DriverResult<Viewport> {
        self.inner.viewport().await
    }

    async fn screenshot(&self, shot: Screenshot) -> DriverResult<Image> {
        self.inner.screenshot(shot).await
    }

    async fn emulate(&self, change: Emulation) -> DriverResult<()> {
        self.inner.emulate(change).await
    }

    async fn interrupt(&self, frame: Option<&FrameId>) -> DriverResult<()> {
        self.inner.interrupt(frame).await
    }

    fn capture(&self) -> &dyn CaptureDriver {
        self.inner.capture()
    }
}
