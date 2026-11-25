//! Direct protocol drivers in the relay, against fake `BrowserDriver` / `TabDriver` doubles (and a fake WebDriver
//! BiDi endpoint for `/drivers/connect`): no browser needed.

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use browse_core::{
    Arg, BodyKind, Browser, BrowserDriver, BrowserEvent, CallOptions, CaptureDriver, CloseReason, ConsoleEvent, DocumentId, DragOutcome,
    DriverError, DriverInfo, DriverResult, Eval, Evaluated, Frame, FrameId, Image, KeyEvent, LoadState, Modifiers, MouseButton, NavigationId,
    NetworkEvent, NetworkOptions, PageEvent, PointerEvent, PointerStep, Realm, Receiver, RemoteRef, RequestId, Screenshot, Subscription,
    TabDriver, TabOptions, TargetId, Viewport, World,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::sync::{Notify, broadcast};
use tokio_tungstenite::tungstenite::Message;

use super::{connected, eventually, fake_extension, harness, http, pair_with_token, text, tool};
use crate::browser::BrowserRef;
use crate::relay::{DIRECT_TAB_BASE, Relay};

struct FakeCapture;

#[async_trait]
impl CaptureDriver for FakeCapture {
    async fn console(&self) -> DriverResult<Subscription<ConsoleEvent>> {
        Err(DriverError::Unsupported("console"))
    }
    async fn network(&self, _opts: NetworkOptions) -> DriverResult<Subscription<NetworkEvent>> {
        Err(DriverError::Unsupported("network"))
    }
    async fn body(&self, _request: &RequestId, _kind: BodyKind) -> DriverResult<Option<Vec<u8>>> {
        Ok(None)
    }
}

/// One fake tab: navigations commit at once (through `redirects`), and the handoff card's script calls are answered
/// from `waits` (then `default_wait`).
struct FakeTab {
    target: String,
    url: Mutex<String>,
    events: broadcast::Sender<PageEvent>,
    navigations: Mutex<Vec<String>>,
    pointers: AtomicUsize,
    closed: AtomicBool,
    evaluations: Mutex<Vec<String>>,
    waits: Mutex<VecDeque<&'static str>>,
    default_wait: Mutex<&'static str>,
    capture: FakeCapture,
}

impl FakeTab {
    fn new(target: String) -> Arc<Self> {
        Arc::new(Self {
            target,
            url: Mutex::new("about:blank".into()),
            events: broadcast::channel(256).0,
            navigations: Mutex::default(),
            pointers: AtomicUsize::new(0),
            closed: AtomicBool::new(false),
            evaluations: Mutex::default(),
            waits: Mutex::default(),
            default_wait: Mutex::new("pending"),
            capture: FakeCapture,
        })
    }

    /// The page goes to `url` by itself (a link, a redirect, a script).
    fn commit(&self, url: &str) {
        let frame = FrameId::from(self.target.as_str());
        *self.url.lock().unwrap() = url.to_string();
        let _ = self.events.send(PageEvent::NavigationStarted { frame: frame.clone(), navigation: None, url: url.into() });
        let _ = self.events.send(PageEvent::Committed { frame: frame.clone(), document: DocumentId(1), navigation: None, url: url.into(), name: String::new() });
        let _ = self.events.send(PageEvent::Loaded { frame, document: DocumentId(1), state: LoadState::Load });
    }

    fn navigations(&self) -> Vec<String> {
        self.navigations.lock().unwrap().clone()
    }

    fn evaluated(&self, marker: &str) -> usize {
        self.evaluations.lock().unwrap().iter().filter(|e| e.contains(marker)).count()
    }

    fn close(&self) {
        if !self.closed.swap(true, Ordering::SeqCst) {
            let _ = self.events.send(PageEvent::Closed(CloseReason::Closed));
        }
    }

    fn gone(&self) -> DriverResult<()> {
        if self.closed.load(Ordering::SeqCst) { Err(DriverError::Closed(CloseReason::Closed)) } else { Ok(()) }
    }
}

#[async_trait]
impl TabDriver for FakeTab {
    fn events(&self) -> broadcast::Receiver<PageEvent> {
        self.events.subscribe()
    }
    async fn frames(&self) -> DriverResult<Vec<Frame>> {
        self.gone()?;
        Ok(vec![Frame { id: FrameId::from(self.target.as_str()), parent: None, url: self.url.lock().unwrap().clone(), name: String::new(), document: DocumentId(1) }])
    }
    async fn navigate(&self, url: &str, _referrer: Option<&str>) -> DriverResult<Option<NavigationId>> {
        self.gone()?;
        self.navigations.lock().unwrap().push(url.to_string());
        self.commit(url);
        Ok(Some(NavigationId::from("nav")))
    }
    async fn reload(&self, _bypass_cache: bool) -> DriverResult<()> {
        Ok(())
    }
    async fn traverse_history(&self, _delta: i32) -> DriverResult<bool> {
        Ok(false)
    }
    async fn evaluate(&self, _realm: &Realm, expression: &str, _opts: CallOptions) -> Eval {
        self.gone()?;
        self.evaluations.lock().unwrap().push(expression.to_string());
        if expression.contains("browse-handoff:install") || expression.contains("browse-handoff:remove") {
            return Ok(Ok(Evaluated::Json(json!(true))));
        }
        if expression.contains("browse-handoff:wait") {
            let answer = self.waits.lock().unwrap().pop_front();
            let answer = match answer {
                Some(answer) => answer,
                None => {
                    tokio::time::sleep(Duration::from_millis(20)).await;
                    *self.default_wait.lock().unwrap()
                }
            };
            return match answer {
                "stale" => Err(DriverError::Stale),
                "null" => Ok(Ok(Evaluated::Json(Value::Null))),
                other => Ok(Ok(Evaluated::Json(json!(other)))),
            };
        }
        if expression.contains("document.title") {
            return Ok(Ok(Evaluated::Json(json!([self.url.lock().unwrap().clone(), "Fake title"]))));
        }
        Ok(Ok(Evaluated::Json(Value::Null)))
    }
    async fn call(&self, _on: &Receiver, _function: &str, _args: &[Arg], _opts: CallOptions) -> Eval {
        Err(DriverError::Unsupported("call"))
    }
    async fn release(&self, _refs: Vec<RemoteRef>) {}
    async fn adopt(&self, _node: &RemoteRef, _world: World) -> DriverResult<RemoteRef> {
        Err(DriverError::Unsupported("adopt"))
    }
    async fn frame_element(&self, _frame: &FrameId) -> DriverResult<RemoteRef> {
        Err(DriverError::Unsupported("frame_element"))
    }
    async fn content_frame(&self, _node: &RemoteRef) -> DriverResult<Option<FrameId>> {
        Ok(None)
    }
    fn prepare_file_chooser_interception(&self) -> browse_core::FileChooserArm {
        browse_core::FileChooserArm(0)
    }
    async fn arm_file_chooser_interception(&self, _arm: browse_core::FileChooserArm) -> DriverResult<()> {
        Err(DriverError::Unsupported("file chooser interception"))
    }
    async fn disarm_file_chooser_interception(&self, _arm: browse_core::FileChooserArm) {}
    async fn take_file_chooser(&self, _timeout: Duration) -> DriverResult<Option<browse_core::FileChooser>> {
        Err(DriverError::Unsupported("file chooser interception"))
    }
    async fn set_files(&self, _input: &RemoteRef, _paths: &[PathBuf]) -> DriverResult<()> {
        Ok(())
    }
    async fn pointer(&self, _event: PointerEvent) -> DriverResult<()> {
        self.pointers.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
    async fn key(&self, _event: KeyEvent) -> DriverResult<()> {
        Ok(())
    }
    async fn insert_text(&self, _text: &str) -> DriverResult<()> {
        Ok(())
    }
    async fn drag(&self, _from: (f64, f64), _to: (f64, f64), _steps: &[PointerStep], _modifiers: Modifiers) -> DriverResult<DragOutcome> {
        Ok(DragOutcome::Dropped)
    }
    async fn answer_dialog(&self, _accept: bool, _text: Option<&str>) -> DriverResult<()> {
        Ok(())
    }
    async fn viewport(&self) -> DriverResult<Viewport> {
        Err(DriverError::Unsupported("viewport"))
    }
    async fn screenshot(&self, _shot: Screenshot) -> DriverResult<Image> {
        Err(DriverError::Unsupported("screenshot"))
    }
    fn capture(&self) -> &dyn CaptureDriver {
        &self.capture
    }
}

pub(super) struct FakeBrowser {
    info: DriverInfo,
    events: broadcast::Sender<BrowserEvent>,
    tabs: Mutex<HashMap<String, Arc<FakeTab>>>,
    next: AtomicU64,
    opened: Mutex<Vec<String>>,
    closed: Mutex<Vec<String>>,
    shutdowns: AtomicUsize,
    quits: AtomicUsize,
}

impl FakeBrowser {
    pub(super) fn new() -> Arc<Self> {
        Arc::new(Self {
            info: DriverInfo { id: "bidi+ws".into(), name: "WebDriver BiDi".into(), protocol: "webdriver-bidi".into(), transport: "ws".into(), browser: "firefox 159.0".into() },
            events: broadcast::channel(256).0,
            tabs: Mutex::default(),
            next: AtomicU64::new(1),
            opened: Mutex::default(),
            closed: Mutex::default(),
            shutdowns: AtomicUsize::new(0),
            quits: AtomicUsize::new(0),
        })
    }

    fn add(&self) -> String {
        let target = format!("ctx-{}", self.next.fetch_add(1, Ordering::SeqCst));
        self.tabs.lock().unwrap().insert(target.clone(), FakeTab::new(target.clone()));
        target
    }

    fn tab(&self, target: &str) -> Arc<FakeTab> {
        self.tabs.lock().unwrap()[target].clone()
    }

    fn opened(&self) -> Vec<String> {
        self.opened.lock().unwrap().clone()
    }

    fn closed(&self) -> Vec<String> {
        self.closed.lock().unwrap().clone()
    }

    /// A page in `opener` opens a popup (window.open, target=_blank).
    fn popup(&self, opener: &str) -> String {
        let target = self.add();
        let _ = self.events.send(BrowserEvent::TabOpened { target: TargetId::from(target.as_str()), opener: Some(TargetId::from(opener)), url: String::new() });
        target
    }
}

#[async_trait]
impl BrowserDriver for FakeBrowser {
    fn info(&self) -> &DriverInfo {
        &self.info
    }
    fn events(&self) -> broadcast::Receiver<BrowserEvent> {
        self.events.subscribe()
    }
    async fn open(&self, _url: Option<&str>, _opts: &TabOptions) -> DriverResult<TargetId> {
        let target = self.add();
        self.opened.lock().unwrap().push(target.clone());
        Ok(TargetId::from(target))
    }
    async fn close(&self, target: &TargetId) -> DriverResult<()> {
        let tab = self.tabs.lock().unwrap().remove(target.as_str());
        let Some(tab) = tab else { return Err(DriverError::Stale) };
        tab.close();
        self.closed.lock().unwrap().push(target.to_string());
        let _ = self.events.send(BrowserEvent::TabClosed { target: target.clone() });
        Ok(())
    }
    async fn attach(&self, target: &TargetId) -> DriverResult<Arc<dyn TabDriver>> {
        let tab = self.tabs.lock().unwrap().get(target.as_str()).cloned().ok_or(DriverError::Stale)?;
        Ok(tab)
    }
    async fn shutdown(&self) {
        self.shutdowns.fetch_add(1, Ordering::SeqCst);
    }
    async fn quit(&self) -> DriverResult<()> {
        self.quits.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}

pub(super) async fn register(relay: &Arc<Relay>, fake: &Arc<FakeBrowser>) -> Arc<crate::relay::DriverEntry> {
    let driver: Arc<dyn BrowserDriver> = fake.clone();
    relay.register_driver(driver, "driver:fake:1".into(), "Firefox".into(), Some("159.0".into()), Some("ws://127.0.0.1:1/session".into()), true).await.unwrap()
}

fn allowed(origins: &[&str]) -> TabOptions {
    TabOptions { allowed_origins: Some(origins.iter().map(|o| o.to_string()).collect()), ..TabOptions::default() }
}

fn press() -> PointerEvent {
    PointerEvent::Down { x: 10.0, y: 10.0, button: MouseButton::Left, click_count: 1, modifiers: Modifiers::NONE }
}

#[tokio::test]
async fn a_direct_tab_opens_navigates_and_closes() {
    let h = harness().await;
    let relay = h.handle.relay.clone();
    let fake = FakeBrowser::new();
    let entry = register(&relay, &fake).await;
    assert_eq!(entry.id, "firefox", "the slug is the base name, so a browser update doesn't rename it");
    let browser = h.handle.browser();
    let info = browser.open_tab(Some("https://example.com/"), &TabOptions::default()).await.unwrap();
    assert!(info.tab >= DIRECT_TAB_BASE, "{}", info.tab);
    assert_eq!(info.url, "https://example.com/");
    assert_eq!(info.title, "Fake title");
    assert_eq!(info.options.browser.as_deref(), Some("firefox"));
    let target = fake.opened()[0].clone();
    assert_eq!(fake.tab(&target).navigations(), vec!["https://example.com/"], "opened blank, then navigated");
    assert!(browser.connected_locally(info.tab).await);
    assert!(browser.cdp(info.tab).await.err().unwrap().to_string().contains("not a CDP extension tab"));

    let driver = browser.tab_driver(info.tab).await.unwrap();
    driver.navigate("https://example.org/", None).await.unwrap();
    let watched = relay.clone();
    eventually("the tab's url to follow the commit", || watched.st().tabs.get(&info.tab).is_some_and(|t| t.url == "https://example.org/")).await;
    assert!(matches!(driver.navigate("javascript:alert(1)", None).await, Err(DriverError::Refused(_))));
    assert!(matches!(driver.navigate("file:///etc/passwd", None).await, Err(DriverError::Refused(_))));

    browser.close_tab(info.tab).await.unwrap();
    assert_eq!(fake.closed(), vec![target]);
    assert!(!relay.st().tabs.contains_key(&info.tab));
    assert_eq!(relay.st().gone_tab(info.tab).unwrap().why, "it was closed with the tabs tool");
}

/// Window placement is the extension's: a directly driven browser refuses newWindow and windowOf before opening
/// anything, and a direct tab never keeps them, so its popups don't inherit them.
#[tokio::test]
async fn a_direct_browser_refuses_window_placement_and_never_keeps_it() {
    let h = harness().await;
    let relay = h.handle.relay.clone();
    let fake = FakeBrowser::new();
    let entry = register(&relay, &fake).await;
    let browser = h.handle.browser();
    let refused = browser.open_tab(None, &TabOptions { new_window: true, ..TabOptions::default() }).await.err().unwrap().to_string();
    assert!(refused.contains("directly driven"), "{refused}");
    assert!(fake.opened().is_empty());
    let first = browser.open_tab(None, &TabOptions::default()).await.unwrap().tab;
    let beside = TabOptions { window_of: Some(first.to_string()), ..TabOptions::default() };
    let refused = browser.open_tab(None, &beside).await.err().unwrap().to_string();
    assert!(refused.contains("directly driven"), "{refused}");
    assert_eq!(fake.opened().len(), 1);
    let kept = relay.create_tab_direct(entry, None, &TabOptions { new_window: true, window_of: Some("x".into()), ..TabOptions::default() }, None, None).await.unwrap();
    let options = relay.st().tabs[&kept].options.clone();
    assert!(!options.new_window && options.window_of.is_none(), "{options:?}");
}

#[tokio::test]
async fn an_off_list_commit_blanks_a_read_only_direct_tab() {
    let h = harness().await;
    let relay = h.handle.relay.clone();
    let fake = FakeBrowser::new();
    register(&relay, &fake).await;
    let browser = h.handle.browser();
    let options = TabOptions { read_only: true, ..allowed(&["example.com"]) };
    let info = browser.open_tab(Some("https://example.com/"), &options).await.unwrap();
    let page = fake.tab(&fake.opened()[0]);
    let driver = browser.tab_driver(info.tab).await.unwrap();
    assert!(matches!(driver.navigate("https://example.com/next", None).await, Err(DriverError::Refused(_))), "a read-only tab refuses agent navigation");

    page.commit("https://evil.com/");
    eventually("the tab to be sent back to about:blank", || page.navigations().last().map(String::as_str) == Some("about:blank")).await;
    let warnings = relay.st().tabs[&info.tab].warnings.clone();
    assert!(warnings.iter().any(|w| w.contains("evil.com") && w.contains("about:blank")), "{warnings:?}");
}

#[tokio::test]
async fn a_popups_first_off_list_commit_closes_it_and_warns_the_opener() {
    let h = harness().await;
    let relay = h.handle.relay.clone();
    let fake = FakeBrowser::new();
    register(&relay, &fake).await;
    let info = h.handle.browser().open_tab(Some("https://example.com/"), &allowed(&["example.com"])).await.unwrap();
    let opener = fake.opened()[0].clone();
    let popup = fake.popup(&opener);
    let watched = relay.clone();
    eventually("the popup to be adopted", || watched.st().tabs.values().any(|t| t.opener == Some(info.tab) && t.fresh_popup)).await;
    let adopted = relay.st().tabs.values().find(|t| t.opener == Some(info.tab)).map(|t| (t.id, t.options.allowed_origins.clone())).unwrap();
    assert_eq!(adopted.1, Some(vec!["example.com".to_string()]), "the popup inherits the opener's allowlist");

    fake.tab(&popup).commit("https://evil.com/");
    let closing = fake.clone();
    eventually("the popup to close", || closing.closed().contains(&popup)).await;
    assert!(!relay.st().tabs.contains_key(&adopted.0));
    let warnings = relay.st().tabs[&info.tab].warnings.clone();
    assert!(warnings.iter().any(|w| w.contains("closed the popup")), "{warnings:?}");
}

#[tokio::test]
async fn idle_cleanup_closes_a_direct_tab() {
    let h = harness().await;
    let relay = h.handle.relay.clone();
    let fake = FakeBrowser::new();
    register(&relay, &fake).await;
    let info = h.handle.browser().open_tab(None, &TabOptions::default()).await.unwrap();
    relay.st().tabs.get_mut(&info.tab).unwrap().last_used = std::time::Instant::now() - Duration::from_secs(3_600);
    crate::serve::reap_idle(&relay, Some(Duration::from_secs(60))).await;
    assert_eq!(fake.closed(), fake.opened());
    assert!(!relay.st().tabs.contains_key(&info.tab));
    assert_eq!(relay.st().gone_tab(info.tab).unwrap().why, "it was idle, so browse closed it");
}

#[tokio::test]
async fn extension_status_stays_extension_only_while_status_counts_direct_browsers() {
    let h = harness().await;
    let relay = h.handle.relay.clone();
    let fake = FakeBrowser::new();
    register(&relay, &fake).await;
    let token = h.handle.token().to_string();
    let (status, extension) = http(h.handle.port(), "GET", "/extension/status", Some(&token), None).await;
    assert_eq!(status, 200);
    assert_eq!(extension["connected"], false, "browse install polls this for the extension alone: {extension}");
    assert_eq!(extension["browserConnected"], true);
    assert!(extension.get("nextStep").is_none(), "{extension}");
    let listed = extension["browsers"].as_array().unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0]["id"], "firefox");
    assert_eq!(listed[0]["driver"], "webdriver-bidi");
    assert_eq!(listed[0]["transport"], "ws");
    assert_eq!(listed[0]["endpoint"], "ws://127.0.0.1:1/session");
    assert_eq!(listed[0]["version"], "159.0");
    let reported = text(&serde_json::to_value(tool(&relay, "status", json!({})).await).unwrap());
    assert_eq!(reported["connected"], true, "{reported}");
    assert_eq!(reported["extension"]["connected"], false);
    let settings = tool(&relay, "settings", json!({})).await;
    assert!(settings.is_error);
    assert!(super::tool_text(&settings).contains("OPENCODE_BROWSER_HUMAN_INPUT"), "{}", super::tool_text(&settings));
}

#[tokio::test]
async fn the_default_browser_waits_for_a_paired_chrome_during_cold_start() {
    let h = harness().await;
    let relay = h.handle.relay.clone();
    crate::pairing::issue_browser_token(&h.paths, "profile-direct-cold", None, None).unwrap();
    let fake = FakeBrowser::new();
    register(&relay, &fake).await;
    let waiting = relay.clone();
    let call = tokio::spawn(async move { matches!(waiting.target_for(None).await, Ok(BrowserRef::Extension(_))) });
    tokio::time::sleep(Duration::from_secs(2)).await;
    assert!(!call.is_finished(), "a paired Chrome is expected back during the cold start");
    let socket = pair_with_token(h.handle.port(), &h.paths, "profile-direct-cold").await;
    let (_seen, events) = fake_extension(socket, 900);
    events.send(json!({ "method": "ready" })).unwrap();
    assert!(tokio::time::timeout(Duration::from_secs(10), call).await.unwrap().unwrap(), "the default is the Chrome it waited for");

    // Past the cold start, with no Chrome expected, the direct browser answers at once.
    let later = harness().await;
    crate::pairing::issue_browser_token(&later.paths, "profile-direct-late", None, None).unwrap();
    later.handle.relay.set_age_for_test(Duration::from_secs(36));
    register(&later.handle.relay, &FakeBrowser::new()).await;
    let started = std::time::Instant::now();
    assert!(matches!(later.handle.relay.target_for(None).await, Ok(BrowserRef::Direct(_))));
    assert!(started.elapsed() < Duration::from_secs(1));
}

#[tokio::test]
async fn disconnecting_a_driver_closes_its_tabs_and_ends_its_session_once() {
    let h = harness().await;
    let relay = h.handle.relay.clone();
    let fake = FakeBrowser::new();
    register(&relay, &fake).await;
    let info = h.handle.browser().open_tab(None, &TabOptions::default()).await.unwrap();
    let token = h.handle.token().to_string();
    let port = h.handle.port();
    let (status, unknown) = http(port, "POST", "/drivers/disconnect", Some(&token), Some(json!({ "browser": "nope" }))).await;
    assert_eq!((status, unknown), (200, json!({ "disconnected": false })));
    let (status, done) = http(port, "POST", "/drivers/disconnect", Some(&token), Some(json!({ "browser": "firefox" }))).await;
    assert_eq!(status, 200);
    assert_eq!(done["disconnected"], true);
    assert_eq!(fake.shutdowns.load(Ordering::SeqCst), 1);
    assert_eq!(fake.closed(), fake.opened());
    assert!(relay.st().drivers.is_empty());
    assert!(!relay.st().tabs.contains_key(&info.tab));
    assert_eq!(http(port, "POST", "/drivers/disconnect", None, Some(json!({ "browser": "firefox" }))).await.0, 401);

    // quit: the browser itself is asked to quit.
    let quitting = FakeBrowser::new();
    register(&relay, &quitting).await;
    let (_, done) = http(port, "POST", "/drivers/disconnect", Some(&token), Some(json!({ "browser": "Firefox", "quit": true }))).await;
    assert_eq!(done["disconnected"], true);
    assert_eq!(quitting.quits.load(Ordering::SeqCst), 1);
    assert!(relay.st().drivers.is_empty());
}

#[tokio::test]
async fn relay_shutdown_closes_direct_tabs_and_ends_each_session_once() {
    let h = harness().await;
    let relay = h.handle.relay.clone();
    let fake = FakeBrowser::new();
    register(&relay, &fake).await;
    h.handle.browser().open_tab(None, &TabOptions::default()).await.unwrap();
    let started = std::time::Instant::now();
    h.handle.stop();
    let finished = relay.clone();
    eventually("the relay to finish", || finished.finished.load(Ordering::SeqCst)).await;
    assert!(started.elapsed() < Duration::from_millis(1500));
    assert_eq!(fake.shutdowns.load(Ordering::SeqCst), 1);
    assert_eq!(fake.closed(), fake.opened());
    assert!(relay.st().drivers.is_empty());
}

#[tokio::test]
async fn a_browser_that_goes_away_takes_its_tabs_and_entry_with_it() {
    let h = harness().await;
    let relay = h.handle.relay.clone();
    let fake = FakeBrowser::new();
    register(&relay, &fake).await;
    let info = h.handle.browser().open_tab(None, &TabOptions::default()).await.unwrap();
    let _ = fake.events.send(BrowserEvent::Disconnected);
    let watched = relay.clone();
    eventually("the driver to go", || watched.st().drivers.is_empty() && !watched.st().tabs.contains_key(&info.tab)).await;
    assert_eq!(relay.st().gone_tab(info.tab).unwrap().why, "its browser disconnected");
    assert!(relay.st().reconnect_owners.is_empty(), "a direct tab never waits for a reconnect");
}

/// A fake WebDriver BiDi endpoint: answers the session commands, holding `session.new` until `hold` is notified.
async fn fake_bidi(hold: Option<Arc<Notify>>) -> (u16, Arc<Mutex<Vec<String>>>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let seen: Arc<Mutex<Vec<String>>> = Arc::default();
    let record = seen.clone();
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let record = record.clone();
            let hold = hold.clone();
            tokio::spawn(async move {
                let Ok(socket) = tokio_tungstenite::accept_async(stream).await else { return };
                let (mut sink, mut stream) = socket.split();
                while let Some(Ok(message)) = stream.next().await {
                    let Message::Text(text) = message else { continue };
                    let command: Value = serde_json::from_str(&text).unwrap();
                    let method = command["method"].as_str().unwrap_or("").to_string();
                    record.lock().unwrap().push(method.clone());
                    let result = match method.as_str() {
                        "session.status" => json!({ "ready": true, "message": "" }),
                        "session.new" => {
                            if let Some(hold) = &hold {
                                hold.notified().await;
                            }
                            json!({ "sessionId": "s-1", "capabilities": { "browserName": "firefox", "browserVersion": "159.0" } })
                        }
                        "session.subscribe" => json!({ "subscription": "sub-1" }),
                        _ => json!({}),
                    };
                    let reply = json!({ "type": "success", "id": command["id"], "result": result });
                    if sink.send(Message::Text(reply.to_string().into())).await.is_err() {
                        return;
                    }
                }
            });
        }
    });
    (port, seen)
}

#[tokio::test]
async fn connects_a_loopback_bidi_endpoint_once() {
    let h = harness().await;
    let relay = h.handle.relay.clone();
    let (port, seen) = fake_bidi(None).await;
    let token = h.handle.token().to_string();
    let body = json!({ "protocol": "webdriver-bidi", "url": format!("ws://127.0.0.1:{port}") });
    let (status, connected) = http(h.handle.port(), "POST", "/drivers/connect", Some(&token), Some(body.clone())).await;
    assert_eq!(status, 200, "{connected}");
    assert_eq!(connected["browser"]["name"], "Firefox");
    assert_eq!(connected["browser"]["id"], "firefox");
    assert_eq!(connected["browser"]["version"], "159.0");
    assert_eq!(connected["browser"]["endpoint"], format!("ws://127.0.0.1:{port}/session"));
    assert_eq!(connected["browser"]["local"], true);
    let (status, again) = http(h.handle.port(), "POST", "/drivers/connect", Some(&token), Some(body)).await;
    assert_eq!(status, 200);
    assert_eq!(again["existing"], true);
    assert_eq!(seen.lock().unwrap().iter().filter(|m| *m == "session.new").count(), 1);

    // A caller's key keeps the driver's identity whatever port the browser listens on.
    let (other, _) = fake_bidi(None).await;
    let keyed = json!({ "protocol": "webdriver-bidi", "url": format!("ws://127.0.0.1:{other}"), "key": "/profiles/browse-firefox", "name": "Firefox" });
    let (status, keyed) = http(h.handle.port(), "POST", "/drivers/connect", Some(&token), Some(keyed)).await;
    assert_eq!(status, 200, "{keyed}");
    assert_eq!(keyed["browser"]["key"], "driver:bidi:/profiles/browse-firefox");
    assert_eq!(keyed["browser"]["id"], "firefox-2");
    assert_eq!(relay.st().drivers.len(), 2);

    let (_, done) = http(h.handle.port(), "POST", "/drivers/disconnect", Some(&token), Some(json!({ "browser": format!("ws://127.0.0.1:{port}/session") }))).await;
    assert_eq!(done["disconnected"], true);
    let ended = seen.clone();
    eventually("the session to end", || ended.lock().unwrap().iter().any(|m| m == "session.end")).await;
}

#[tokio::test]
async fn a_connect_racing_relay_stop_ends_its_session() {
    let h = harness().await;
    let relay = h.handle.relay.clone();
    let hold = Arc::new(Notify::new());
    let (port, seen) = fake_bidi(Some(hold.clone())).await;
    let connecting = relay.clone();
    let call = tokio::spawn(async move { crate::drivers::connect(&connecting, &json!({ "protocol": "webdriver-bidi", "url": format!("ws://127.0.0.1:{port}") })).await });
    let asked = seen.clone();
    eventually("session.new to be sent", || asked.lock().unwrap().iter().any(|m| m == "session.new")).await;
    assert!(relay.st().connecting.contains(&format!("driver:bidi:127.0.0.1:{port}")));
    relay.stop();
    hold.notify_one();
    let (status, body) = tokio::time::timeout(Duration::from_secs(10), call).await.unwrap().unwrap();
    assert_eq!(status.as_u16(), 503, "{body}");
    let ended = seen.clone();
    eventually("the session to end", || ended.lock().unwrap().iter().any(|m| m == "session.end")).await;
    assert!(relay.st().drivers.is_empty());
    assert!(relay.st().connecting.is_empty());
}

#[tokio::test]
async fn direct_tabs_stay_out_of_the_tab_registry() {
    let (h, _seen, _events) = connected("profile-direct-registry", 950).await;
    let relay = h.handle.relay.clone();
    let fake = FakeBrowser::new();
    register(&relay, &fake).await;
    let browser = h.handle.browser();
    let chrome = browser.open_tab(None, &TabOptions::default()).await.unwrap();
    assert!(chrome.tab < DIRECT_TAB_BASE, "the connected Chrome is the default");
    let direct = browser.open_tab(None, &TabOptions { browser: Some("firefox".into()), ..TabOptions::default() }).await.unwrap();
    assert!(direct.tab >= DIRECT_TAB_BASE);
    relay.persist_now();
    let saved = crate::registry::load(&h.paths.tab_registry(relay.configured_port));
    assert!(saved.iter().any(|t| t.tab == chrome.tab), "{saved:?}");
    assert!(!saved.iter().any(|t| t.tab == direct.tab), "{saved:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_direct_handoff_redraws_after_a_stale_evaluate_and_holds_agent_input() {
    let h = harness().await;
    let relay = h.handle.relay.clone();
    let fake = FakeBrowser::new();
    register(&relay, &fake).await;
    let browser = h.handle.browser();
    let info = browser.open_tab(Some("https://example.com/"), &TabOptions::default()).await.unwrap();
    let page = fake.tab(&fake.opened()[0]);
    page.waits.lock().unwrap().push_back("stale");
    let waiting = relay.clone();
    let handoff = tokio::spawn(async move { waiting.run_handoff(info.tab, "Sign in, then click Continue", Duration::from_secs(30)).await });
    let watched = page.clone();
    eventually("the card to be drawn again", || watched.evaluated("browse-handoff:install") >= 2).await;
    assert!(relay.st().handoff_for_tab(info.tab).is_some());

    let driver = browser.tab_driver(info.tab).await.unwrap();
    match driver.pointer(press()).await {
        Err(DriverError::Refused(reason)) => assert!(reason.contains("handoff is waiting"), "{reason}"),
        other => panic!("agent input went through during the handoff: {other:?}"),
    }
    assert!(matches!(driver.navigate("https://example.com/x", None).await, Err(DriverError::Refused(_))));
    assert_eq!(page.pointers.load(Ordering::SeqCst), 0);

    *page.default_wait.lock().unwrap() = "continue";
    let result = tokio::time::timeout(Duration::from_secs(10), handoff).await.unwrap().unwrap().unwrap();
    assert_eq!(result.outcome, "continued");
    assert!(relay.st().handoff_for_tab(info.tab).is_none());
    eventually("the card to be taken down", || watched.evaluated("browse-handoff:remove") >= 1).await;
    driver.pointer(press()).await.unwrap();
    assert_eq!(page.pointers.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn drivers_connect_refuses_bad_and_remote_endpoints() {
    let h = harness().await;
    let token = h.handle.token().to_string();
    let port = h.handle.port();
    let connect = |body: Value| http(port, "POST", "/drivers/connect", Some(&token), Some(body));
    let (status, refused) = connect(json!({ "protocol": "webdriver-bidi", "url": "ws://192.0.2.1:9222" })).await;
    assert_eq!(status, 403, "{refused}");
    assert_eq!(refused["code"], "driver-not-local");
    let (status, _) = connect(json!({ "protocol": "cdp", "url": "ws://127.0.0.1:9222" })).await;
    assert_eq!(status, 400);
    let (status, _) = connect(json!({ "protocol": "webdriver-bidi", "url": "http://127.0.0.1:9222" })).await;
    assert_eq!(status, 400);
    let (status, _) = connect(json!({ "protocol": "webdriver-bidi", "url": "ws://user:pw@127.0.0.1:9222" })).await;
    assert_eq!(status, 400);
    let (status, _) = connect(json!({ "protocol": "webdriver-bidi", "url": "ws://127.0.0.1:9222/session?x=1" })).await;
    assert_eq!(status, 400);
    assert_eq!(http(port, "POST", "/drivers/connect", None, Some(json!({ "protocol": "webdriver-bidi", "url": "ws://127.0.0.1:9222" }))).await.0, 401);
    assert!(h.handle.relay.st().drivers.is_empty() && h.handle.relay.st().connecting.is_empty());
}


/// A relay that looks for Firefox-family apps where `discovery` says.
async fn harness_with_firefox(discovery: crate::firefox::Discovery) -> super::Harness {
    let paths = crate::paths::Paths::rooted(std::env::temp_dir().join(format!("browse-relay-test-{}", crate::util::random_hex(6))));
    let options = crate::serve::ServeOptions { port: Some(0), paths: paths.clone(), version: "0.0.0-test".into(), firefox: Some(discovery), ..crate::serve::ServeOptions::default() };
    let handle = crate::serve::start(options, crate::tools()).await.unwrap();
    super::Harness { handle, paths }
}

#[tokio::test]
async fn next_step_points_at_browse_firefox_only_when_firefox_is_installed_and_nothing_is_paired() {
    let apps = crate::firefox::tests::Scratch::new("relay-apps");
    let plain = harness().await;
    let next = plain.handle.relay.extension_status()["nextStep"].as_str().unwrap().to_string();
    assert!(!next.contains("browse firefox"), "the default test relay looks for no Firefox: {next}");

    let empty = harness_with_firefox(crate::firefox::Discovery { app_dirs: vec![apps.0.clone()], ..crate::firefox::Discovery::none() }).await;
    let next = empty.handle.relay.extension_status()["nextStep"].as_str().unwrap().to_string();
    assert!(!next.contains("browse firefox"), "no Firefox installed: {next}");

    let bundle = apps.0.join("Firefox.app/Contents/MacOS");
    std::fs::create_dir_all(&bundle).unwrap();
    std::fs::write(bundle.join("firefox"), b"").unwrap();
    let h = harness_with_firefox(crate::firefox::Discovery { app_dirs: vec![apps.0.clone()], ..crate::firefox::Discovery::none() }).await;
    let status = h.handle.relay.extension_status();
    assert_eq!(status["pairingState"], "not-seen");
    let next = status["nextStep"].as_str().unwrap();
    assert!(next.starts_with("No browser has connected to browse yet."), "{next}");
    assert!(next.ends_with(" Or run `browse firefox` to connect Firefox."), "{next}");
    let error = h.handle.relay.link_for(None).await.err().unwrap().to_string();
    assert!(error.contains("browse firefox"), "{error}");

    crate::pairing::issue_browser_token(&h.paths, "profile-ff-hint", None, None).unwrap();
    let next = h.handle.relay.extension_status()["nextStep"].as_str().unwrap().to_string();
    assert!(!next.contains("browse firefox"), "a paired Chrome is the one to open: {next}");

    let fake = FakeBrowser::new();
    register(&h.handle.relay, &fake).await;
    assert!(h.handle.relay.extension_status().get("nextStep").is_none());
}

#[cfg(unix)]
#[tokio::test]
async fn the_relay_attaches_a_recorded_profile_while_it_listens() {
    use crate::firefox::{self, RecordedFirefox};
    let h = harness().await;
    let relay = h.handle.relay.clone();
    let scratch = firefox::tests::Scratch::new("relay-attach");
    let profile = scratch.0.join("profile");
    let stranger = scratch.0.join("stranger");
    std::fs::create_dir_all(&profile).unwrap();
    std::fs::create_dir_all(&stranger).unwrap();
    let (port, seen) = fake_bidi(None).await;
    let server = format!("{{\"ws_host\":\"127.0.0.1\",\"ws_port\":{port}}}");
    std::fs::write(profile.join("WebDriverBiDiServer.json"), &server).unwrap();
    std::fs::write(stranger.join("WebDriverBiDiServer.json"), &server).unwrap();
    let record = RecordedFirefox { app: "zen".into(), exe: "/x/zen".into(), profile: profile.clone(), dedicated: false, headless: false, name: Some("Zen".into()), prefs_added: false };
    firefox::record(&h.paths, record).unwrap();

    // Not running: a stale server file is nothing to connect to.
    *relay.auto_attached.lock().unwrap() = None;
    relay.auto_attach_firefox().await;
    assert!(relay.st().drivers.is_empty());

    let holder = firefox::tests::Holder::start(&profile);
    let _stranger = firefox::tests::Holder::start(&stranger);
    relay.auto_attach_firefox().await;
    assert!(relay.st().drivers.is_empty(), "at most one try every 2 s");
    *relay.auto_attached.lock().unwrap() = None;
    let target = relay.target_for(None).await.unwrap();
    let BrowserRef::Direct(entry) = target else { panic!("the recorded profile is the browser") };
    assert_eq!(entry.key, firefox::driver_key(&profile));
    assert_eq!(entry.name, "Zen");
    assert_eq!(relay.st().drivers.len(), 1, "an unrecorded profile is never taken");
    assert_eq!(seen.lock().unwrap().iter().filter(|m| *m == "session.new").count(), 1);
    *relay.auto_attached.lock().unwrap() = None;
    relay.auto_attach_firefox().await;
    assert_eq!(seen.lock().unwrap().iter().filter(|m| *m == "session.new").count(), 1, "a connected profile is left alone");
    relay.disconnect_driver(&entry, false).await;
    holder.release();
}

#[cfg(unix)]
#[tokio::test]
async fn a_recorded_profile_held_by_another_client_says_so_in_next_step() {
    use crate::firefox::{self, RecordedFirefox};
    let h = harness().await;
    let relay = h.handle.relay.clone();
    let scratch = firefox::tests::Scratch::new("relay-busy");
    let profile = scratch.0.join("profile");
    std::fs::create_dir_all(&profile).unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            tokio::spawn(async move {
                let Ok(socket) = tokio_tungstenite::accept_async(stream).await else { return };
                let (mut sink, mut stream) = socket.split();
                while let Some(Ok(Message::Text(text))) = stream.next().await {
                    let command: Value = serde_json::from_str(&text).unwrap();
                    let reply = json!({ "type": "error", "id": command["id"], "error": "session not created", "message": "Maximum number of active sessions" });
                    let _ = sink.send(Message::Text(reply.to_string().into())).await;
                }
            });
        }
    });
    std::fs::write(profile.join("WebDriverBiDiServer.json"), format!("{{\"ws_host\":\"127.0.0.1\",\"ws_port\":{port}}}")).unwrap();
    firefox::record(&h.paths, RecordedFirefox { app: "firefox".into(), exe: "/x".into(), profile: profile.clone(), dedicated: false, headless: false, name: None, prefs_added: false }).unwrap();
    let holder = firefox::tests::Holder::start(&profile);
    *relay.auto_attached.lock().unwrap() = None;
    relay.auto_attach_firefox().await;
    assert!(relay.st().drivers.is_empty());
    let next = relay.extension_status()["nextStep"].as_str().unwrap().to_string();
    assert!(next.contains("Firefox already has another WebDriver BiDi client"), "{next}");
    holder.release();
}
