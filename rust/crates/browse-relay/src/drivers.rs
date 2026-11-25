//! Browsers the relay drives directly, next to the extension's links: a `BrowserDriver` (WebDriver BiDi for
//! Firefox) registered with `POST /drivers/connect`, its agent tabs (opened, observed, guarded and closed through the
//! driver), and its teardown.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail};
use async_trait::async_trait;
use browse_core::{
    BrowserDriver, BrowserEvent, CallOptions, CloseReason, DriverError, Evaluated, GuardedTabDriver, LoadState, PageEvent, Realm, Returns,
    TabDriver, TabOptions, TabPolicy, TargetId, World,
};
use hyper::StatusCode;
use serde_json::{Value, json};
use tokio::sync::{broadcast, oneshot};

use crate::relay::{Backend, DriverEntry, Owner, Relay, Tab};
use crate::rlog;
use crate::tabs::{Release, real_url, url_allowed};

/// How many browsers the relay drives directly at once.
pub const MAX_DRIVERS: usize = 8;
/// How long relay shutdown spends closing a driver's tabs, and then ending its session.
const TEARDOWN_STEP: Duration = Duration::from_millis(700);
/// How often the relay may try to attach the recorded Firefox profiles.
const AUTO_ATTACH_EVERY: Duration = Duration::from_secs(2);

/// A javascript: URL (Firefox never answers a navigation to one).
pub fn is_javascript(url: &str) -> bool {
    url.trim_start().get(..11).is_some_and(|scheme| scheme.eq_ignore_ascii_case("javascript:"))
}

/// The relay's policy on a direct tab, enforced by `GuardedTabDriver` on every write.
pub(crate) struct DirectTabPolicy {
    pub relay: Arc<Relay>,
    pub tab: i64,
}

#[async_trait]
impl TabPolicy for DirectTabPolicy {
    fn is_read_only(&self) -> bool {
        crate::browser::tab_read_only(&self.relay.st(), self.tab).unwrap_or(false)
    }

    async fn check_navigation(&self, url: &str) -> Result<(), String> {
        if let Some(refusal) = crate::guardrails::guard("Page.navigate", &json!({ "url": url }), false, &Vec::new) {
            return Err(refusal);
        }
        if is_javascript(url) {
            return Err("browse blocked navigate to a javascript: URL: run script with the evaluate tool instead".into());
        }
        let options = self.relay.st().tabs.get(&self.tab).map(|t| t.options.clone()).unwrap_or_default();
        match self.relay.navigation_refusal(&options, Some(self.tab), "navigate", url).await {
            Some(refusal) => Err(refusal),
            None => Ok(()),
        }
    }

    fn check_input(&self, action: &str) -> Result<(), String> {
        if self.relay.st().handoffs.contains_key(&self.tab) {
            return Err(format!("browse blocked {action}: a handoff is waiting on the user in this tab"));
        }
        Ok(())
    }
}

/// "firefox" -> "Firefox".
fn browser_name(raw: &str) -> String {
    let mut chars = raw.trim().chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => "Browser".into(),
    }
}

fn entry_json(entry: &DriverEntry) -> Value {
    json!({
        "id": entry.id,
        "name": entry.name,
        "version": entry.version,
        "protocol": entry.protocol,
        "transport": entry.transport,
        "endpoint": entry.endpoint,
        "local": entry.local,
        "key": entry.key,
    })
}

fn is_entry(tab: &Tab, entry: &Arc<DriverEntry>) -> bool {
    matches!(&tab.backend, Backend::Direct(e) if Arc::ptr_eq(e, entry))
}

impl Relay {
    /// Adds a connected driver: its browser gets an id agents can name, and its events are followed. A relay that is
    /// stopping (or already drives this key) ends the driver's session instead.
    pub async fn register_driver(
        self: &Arc<Self>,
        driver: Arc<dyn BrowserDriver>,
        key: String,
        name: String,
        version: Option<String>,
        endpoint: Option<String>,
        local: bool,
    ) -> anyhow::Result<Arc<DriverEntry>> {
        let events = driver.events();
        let registered = {
            let mut st = self.st();
            if self.is_stopping() {
                Err("the relay is stopping")
            } else if st.drivers.iter().any(|d| d.key == key) {
                Err("that browser is already connected")
            } else if st.drivers.len() >= MAX_DRIVERS {
                Err("browse already drives as many browsers as it can")
            } else {
                let (id, name) = st.identify(&self.paths, &key, &name, false);
                let entry = Arc::new(DriverEntry::new(key.clone(), id, name, version, endpoint, local, driver.clone()));
                st.drivers.push(entry.clone());
                Ok(entry)
            }
        };
        let entry = match registered {
            Ok(entry) => entry,
            Err(reason) => {
                driver.shutdown().await;
                bail!("{reason}");
            }
        };
        let pump = tokio::spawn(pump(self.clone(), entry.clone(), events));
        *entry.pump.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(pump.abort_handle());
        rlog!("driver.connected", browser = entry.id.clone(), protocol = entry.protocol.clone(), local = entry.local);
        self.browsers_changed();
        Ok(entry)
    }

    /// Opens an agent tab in a directly driven browser: blank first (so the allowlist sees the first commit and every
    /// redirect), then navigated through the guarded driver.
    pub async fn create_tab_direct(
        self: &Arc<Self>,
        entry: Arc<DriverEntry>,
        url: Option<&str>,
        options: &TabOptions,
        opener: Option<i64>,
        chosen: Option<&str>,
    ) -> anyhow::Result<i64> {
        let url = url.map(str::trim).filter(|u| !u.is_empty() && *u != "about:blank");
        let mut options = Self::normalize_options(options)?;
        options.browser = None;
        // Window placement is the extension's; the tab (and its popups) never keep a one-off request.
        options.new_window = false;
        options.window_of = None;
        if let Some(url) = url {
            if let Some(refusal) = crate::guardrails::guard("Target.createTarget", &json!({ "url": url }), false, &Vec::new) {
                bail!(refusal);
            }
            if is_javascript(url) {
                bail!("browse blocked opening a javascript: URL: open the page, then run script with the evaluate tool");
            }
            if let Some(refusal) = self.navigation_refusal(&options, None, "Target.createTarget", url).await {
                bail!(refusal);
            }
        }
        if !entry.connected() {
            bail!("Browser '{}' disconnected.", entry.id);
        }
        let target = entry.driver.open(None, &options).await.map_err(|error| anyhow!("Couldn't open a tab in {}: {error}", entry.name))?;
        let raw = match entry.driver.attach(&target).await {
            Ok(raw) => raw,
            Err(error) => {
                let _ = tokio::time::timeout(Duration::from_secs(5), entry.driver.close(&target)).await;
                bail!("Couldn't attach to the new tab in {}: {error}", entry.name);
            }
        };
        let tab = self.insert_direct_tab(&entry, &target, raw.clone(), options.clone(), opener, chosen.map(str::to_string), false).await;
        rlog!("tab.created", tabId = tab, browser = entry.id.clone(), group = options.group.clone());
        let Some(url) = url else { return Ok(tab) };
        let main = {
            let st = self.st();
            let Some(entry) = st.tabs.get(&tab) else { bail!("Tab {tab} went away") };
            entry.main_frame.clone()
        };
        let mut events = raw.events();
        // The URL passed the checks the tab's policy makes (above); the policy itself would refuse a read-only tab's
        // first load, which the opener asked for. Every later navigation goes through the guarded driver.
        let navigated = tokio::time::timeout(Duration::from_secs(30), raw.navigate(url, None)).await;
        let failure = match navigated {
            Ok(Ok(_)) => None,
            Ok(Err(error)) => Some(error.to_string()),
            Err(_) => Some("the browser didn't start loading it within 30 s".into()),
        };
        if let Some(failure) = failure {
            rlog!("create.navigate-failed", tabId = tab, error = failure.clone());
            self.abandon_direct_tab(tab).await;
            bail!("Opened tab {tab}, but navigating it failed: {failure}");
        }
        let _ = tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                match events.recv().await {
                    Ok(PageEvent::Loaded { frame, state: LoadState::Load, .. }) if main.as_deref().is_none_or(|m| m == frame.as_str()) => break,
                    Ok(PageEvent::Closed(_)) | Err(broadcast::error::RecvError::Closed) => break,
                    Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => {}
                }
            }
        })
        .await;
        if let Ok(Ok(frames)) = tokio::time::timeout(Duration::from_secs(5), raw.frames()).await
            && let Some(top) = frames.first()
        {
            if !url_allowed(&options, &top.url) {
                let _ = tokio::time::timeout(Duration::from_secs(10), raw.navigate("about:blank", None)).await;
            } else if let Some(entry) = self.st().tabs.get_mut(&tab) {
                entry.url = top.url.clone();
            }
        }
        refresh_title(self, tab).await;
        Ok(tab)
    }

    /// A new direct tab failed: close it in the browser and forget it.
    async fn abandon_direct_tab(self: &Arc<Self>, tab: i64) {
        if self.close_or_release_why(tab, "attach-failed").await.is_err() {
            self.remove_tab(tab, Release { gone: true, ..Release::default() }, "attach-failed");
        }
    }

    /// Registers an attached direct tab and starts following its page events (subscribed before anything else, so no
    /// commit is missed).
    #[allow(clippy::too_many_arguments)]
    async fn insert_direct_tab(
        self: &Arc<Self>,
        entry: &Arc<DriverEntry>,
        target: &TargetId,
        raw: Arc<dyn TabDriver>,
        options: TabOptions,
        opener: Option<i64>,
        chosen: Option<String>,
        fresh_popup: bool,
    ) -> i64 {
        let events = raw.events();
        let frames = tokio::time::timeout(Duration::from_secs(5), raw.frames()).await.ok().and_then(Result::ok).unwrap_or_default();
        let main = frames.first().map(|f| f.id.to_string()).unwrap_or_else(|| target.to_string());
        let url = frames.first().map(|f| f.url.clone()).unwrap_or_default();
        let tab = {
            let mut st = self.st();
            let tab = st.alloc_direct_tab_id(&entry.key);
            let policy = Arc::new(DirectTabPolicy { relay: self.clone(), tab });
            let guarded: Arc<dyn TabDriver> = GuardedTabDriver::new(raw.clone(), policy);
            st.tabs.insert(
                tab,
                Tab {
                    id: tab,
                    link_key: entry.key.clone(),
                    target_id: target.to_string(),
                    url,
                    title: String::new(),
                    owner: Owner::Relay,
                    chosen,
                    options,
                    opener,
                    state: Arc::default(),
                    busy_keys: HashSet::new(),
                    warnings: Vec::new(),
                    idle_epoch: 0,
                    created_at: crate::util::now_iso(),
                    events: broadcast::channel(16).0,
                    children: HashMap::new(),
                    suppressed: HashSet::new(),
                    crashed: false,
                    main_frame: Some(main.clone()),
                    last_used: Instant::now(),
                    last_used_at: crate::util::now_iso(),
                    focused: false,
                    fresh_popup,
                    blanking: 0,
                    protected_ui: false,
                    protected_frames: HashSet::new(),
                    unattachable: false,
                    closing: false,
                    child_frames: HashSet::new(),
                    cdp: None,
                    driver: Some(guarded),
                    backend: Backend::Direct(entry.clone()),
                    raw_driver: Some(raw),
                    observer: None,
                },
            );
            tab
        };
        let observer = tokio::spawn(observe(self.clone(), tab, main, events));
        match self.st().tabs.get_mut(&tab) {
            Some(entry) => entry.observer = Some(observer.abort_handle()),
            None => observer.abort(),
        }
        rlog!("target.attached", tabId = tab, owner = "relay", browser = entry.id.clone());
        tab
    }

    /// A direct tab's page went away (closed, crashed, or its browser disconnected).
    fn direct_tab_closed(self: &Arc<Self>, tab: i64, reason: &CloseReason) {
        if *reason == CloseReason::Crashed {
            {
                let mut st = self.st();
                let Some(entry) = st.tabs.get_mut(&tab) else { return };
                entry.crashed = true;
                if let Some(mut handoff) = st.handoffs.remove(&tab) {
                    handoff.done.take().map(|done| done.send("closed"));
                }
            }
            rlog!("tab.crashed", tabId = tab);
            return;
        }
        if self.st().tabs.get(&tab).is_none_or(|t| t.closing) {
            return;
        }
        let why = if *reason == CloseReason::BrowserDisconnected { "browser-disconnected" } else { "tab-closed" };
        self.remove_tab(tab, Release { gone: true, ..Release::default() }, why);
    }

    /// A popup an agent tab's page opened in a direct browser is an agent tab too, with the opener's options. Its
    /// current URL is checked at once: a commit before it was registered never reached its observer.
    fn adopt_direct_popup(self: &Arc<Self>, entry: &Arc<DriverEntry>, target: TargetId, opener: TargetId) {
        let (opener_tab, options) = {
            let st = self.st();
            if st.tabs.values().any(|t| is_entry(t, entry) && t.target_id == target.as_str()) {
                return;
            }
            let Some(opener) = st.tabs.values().find(|t| is_entry(t, entry) && t.target_id == opener.as_str() && !t.closing) else { return };
            (opener.id, opener.options.clone())
        };
        let relay = self.clone();
        let entry = entry.clone();
        tokio::spawn(async move {
            let raw = match entry.driver.attach(&target).await {
                Ok(raw) => raw,
                Err(error) => {
                    rlog!("tab.opened.error", openerTabId = opener_tab, error = error.to_string());
                    return;
                }
            };
            let tab = relay.insert_direct_tab(&entry, &target, raw.clone(), options.clone(), Some(opener_tab), None, true).await;
            rlog!("tab.opened", tabId = tab, openerTabId = opener_tab, group = options.group.clone());
            match tokio::time::timeout(Duration::from_secs(5), raw.frames()).await {
                Ok(Ok(frames)) => {
                    let current = frames.first().map(|f| f.url.clone()).unwrap_or_default();
                    let fresh = {
                        let mut st = relay.st();
                        let Some(popup) = st.tabs.get_mut(&tab) else { return };
                        if real_url(&current) {
                            popup.url = current.clone();
                        }
                        popup.fresh_popup && !popup.closing
                    };
                    if fresh && real_url(&current) {
                        relay.check_committed_url(tab, &current);
                    }
                }
                _ => {
                    if relay.enforced(tab).is_some() {
                        relay.close_unverified_popup(tab, "its URL couldn't be read");
                    }
                }
            }
        });
    }

    /// Events were missed: drop the tabs whose page is gone.
    async fn probe_direct_tabs(self: &Arc<Self>, entry: &Arc<DriverEntry>) {
        let tabs: Vec<(i64, Option<Arc<dyn TabDriver>>)> = self.st().tabs.values().filter(|t| is_entry(t, entry)).map(|t| (t.id, t.raw_driver.clone())).collect();
        for (tab, raw) in tabs {
            let Some(raw) = raw else { continue };
            if let Ok(Err(DriverError::Closed(_) | DriverError::Stale)) = tokio::time::timeout(Duration::from_secs(2), raw.frames()).await {
                self.direct_tab_closed(tab, &CloseReason::Closed);
            }
        }
    }

    /// A driver's browser went away: its tabs go (they can't come back: a new session has new contexts), and so does
    /// the driver.
    pub(crate) fn driver_gone(self: &Arc<Self>, entry: &Arc<DriverEntry>, reason: &str) {
        entry.disconnect();
        let (tabs, removed) = {
            let mut st = self.st();
            let tabs: Vec<i64> = st.tabs.values().filter(|t| is_entry(t, entry)).map(|t| t.id).collect();
            let before = st.drivers.len();
            st.drivers.retain(|d| !Arc::ptr_eq(d, entry));
            (tabs, st.drivers.len() != before)
        };
        for tab in tabs {
            self.remove_tab(tab, Release { gone: true, ..Release::default() }, reason);
        }
        if removed {
            rlog!("driver.disconnected", browser = entry.id.clone(), reason = reason);
            self.browsers_changed();
        }
    }

    /// Lets a direct browser go (`POST /drivers/disconnect`): calls in its tabs stop, its agent tabs close, its session
    /// ends (or, with `quit`, the browser quits, tabs and all).
    pub async fn disconnect_driver(self: &Arc<Self>, entry: &Arc<DriverEntry>, quit: bool) {
        entry.disconnect();
        let tabs: HashSet<i64> = self.st().tabs.values().filter(|t| is_entry(t, entry)).map(|t| t.id).collect();
        self.stop_calls_where(&format!("{} was disconnected from browse while this ran, so it was stopped.", entry.name), |call| call.tabs.iter().any(|tab| tabs.contains(tab)));
        if quit {
            if let Ok(Err(error)) = tokio::time::timeout(Duration::from_secs(5), entry.driver.quit()).await {
                rlog!("driver.quit_failed", browser = entry.id.clone(), error = error.to_string());
                let _ = tokio::time::timeout(Duration::from_secs(3), entry.driver.shutdown()).await;
            }
        } else {
            let closes = tabs.iter().map(|tab| self.close_or_release_why(*tab, "driver-disconnected"));
            let _ = tokio::time::timeout(Duration::from_secs(5), futures_util::future::join_all(closes)).await;
            let _ = tokio::time::timeout(Duration::from_secs(3), entry.driver.shutdown()).await;
        }
        self.driver_gone(entry, "driver-disconnected");
    }

    /// Connects the Firefox profiles `browse firefox` recorded (`<data>/firefox.json`) that listen for WebDriver BiDi,
    /// and OPENCODE_BROWSER_BIDI_URL, unless connected already. At most every 2 s. It never scans profiles nobody
    /// recorded (another tool's session isn't browse's to take), and never launches or quits a browser.
    pub async fn auto_attach_firefox(self: &Arc<Self>) {
        {
            let mut last = self.auto_attached.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            if self.is_stopping() || last.is_some_and(|at| at.elapsed() < AUTO_ATTACH_EVERY) {
                return;
            }
            *last = Some(Instant::now());
        }
        let mut bodies = Vec::new();
        if let Some(url) = std::env::var("OPENCODE_BROWSER_BIDI_URL").ok().map(|u| u.trim().to_string()).filter(|u| !u.is_empty()) {
            bodies.push((None, json!({ "protocol": "webdriver-bidi", "url": url })));
        }
        for record in crate::firefox::read_recorded(&self.paths) {
            let key = crate::firefox::driver_key(&record.profile);
            let skip = {
                let st = self.st();
                st.connecting.contains(&key) || st.drivers.iter().any(|d| d.key == key && d.connected())
            };
            if skip {
                continue;
            }
            if let crate::firefox::ProfileState::Listening { url, .. } = crate::firefox::state(&record.profile) {
                bodies.push((Some(key.clone()), json!({ "protocol": "webdriver-bidi", "url": url, "key": key, "name": record.display_name() })));
            }
        }
        for (key, body) in bodies {
            let (status, value) = connect(self, &body).await;
            let busy = status == StatusCode::CONFLICT && value["code"] == "driver-session-busy";
            if let Some(key) = key {
                let mut held = self.firefox_busy.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
                held.retain(|k| *k != key);
                if busy {
                    held.push(key);
                }
            }
            if status != StatusCode::OK {
                rlog!("driver.auto_attach_failed", status = status.as_u16(), code = value["code"].as_str().unwrap_or("").to_string());
            }
        }
    }

    /// Spawns `auto_attach_firefox` when a runtime is there to run it.
    pub(crate) fn auto_attach_soon(self: &Arc<Self>) {
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            let relay = self.clone();
            runtime.spawn(async move { relay.auto_attach_firefox().await });
        }
    }

    /// Relay shutdown: every driver's agent tabs close and its session ends, all at once and briefly, so the shutdown's
    /// final registry write still happens well before the watchdog would end the process.
    pub(crate) async fn shutdown_drivers(self: &Arc<Self>) {
        let drivers: Vec<Arc<DriverEntry>> = self.st().drivers.clone();
        let each = drivers.iter().map(|entry| async move {
            entry.disconnect();
            let tabs: Vec<i64> = self.st().tabs.values().filter(|t| is_entry(t, entry)).map(|t| t.id).collect();
            let closes = tabs.iter().map(|tab| self.close_or_release_why(*tab, "driver-disconnected"));
            let _ = tokio::time::timeout(TEARDOWN_STEP, futures_util::future::join_all(closes)).await;
            let _ = tokio::time::timeout(TEARDOWN_STEP, entry.driver.shutdown()).await;
            self.driver_gone(entry, "driver-disconnected");
        });
        futures_util::future::join_all(each).await;
    }
}

/// Follows a direct tab's main-frame navigation for the allowlist, its URL, and its going away.
async fn observe(relay: Arc<Relay>, tab: i64, main: String, mut events: broadcast::Receiver<PageEvent>) {
    loop {
        let event = match events.recv().await {
            Ok(event) => event,
            Err(broadcast::error::RecvError::Lagged(_)) => {
                resync(&relay, tab).await;
                continue;
            }
            Err(broadcast::error::RecvError::Closed) => {
                relay.direct_tab_closed(tab, &CloseReason::BrowserDisconnected);
                return;
            }
        };
        match event {
            PageEvent::NavigationStarted { frame, url, .. } if frame.as_str() == main => {
                if (url.starts_with("http:") || url.starts_with("https:"))
                    && let Some((rules, _)) = relay.enforced(tab)
                    && let crate::domain::UrlDecision::Refused(reason) = crate::domain::check_url(&url, &rules, false)
                {
                    relay.allowlist_violation(tab, &url, &reason);
                }
            }
            PageEvent::Committed { frame, url, .. } if frame.as_str() == main => {
                match relay.st().tabs.get_mut(&tab) {
                    Some(entry) => entry.url = url.clone(),
                    None => return,
                }
                relay.check_committed_url(tab, &url);
            }
            PageEvent::UrlChanged { frame, url } if frame.as_str() == main => {
                if let Some(entry) = relay.st().tabs.get_mut(&tab) {
                    entry.url = url;
                }
            }
            PageEvent::Closed(reason) => {
                relay.direct_tab_closed(tab, &reason);
                return;
            }
            _ => {}
        }
    }
}

/// Missed page events: read the main frame's URL again and check it.
async fn resync(relay: &Arc<Relay>, tab: i64) {
    let Some(raw) = relay.st().tabs.get(&tab).and_then(|t| t.raw_driver.clone()) else { return };
    match tokio::time::timeout(Duration::from_secs(2), raw.frames()).await {
        Ok(Ok(frames)) => {
            let Some(url) = frames.first().map(|f| f.url.clone()) else { return };
            match relay.st().tabs.get_mut(&tab) {
                Some(entry) => entry.url = url.clone(),
                None => return,
            }
            relay.check_committed_url(tab, &url);
        }
        Ok(Err(DriverError::Closed(reason))) => relay.direct_tab_closed(tab, &reason),
        _ => {}
    }
}

/// Follows a driver's browser-wide events: popups of agent tabs, tabs closing, the browser going away.
async fn pump(relay: Arc<Relay>, entry: Arc<DriverEntry>, mut events: broadcast::Receiver<BrowserEvent>) {
    loop {
        match events.recv().await {
            Ok(BrowserEvent::TabOpened { target, opener: Some(opener), .. }) => relay.adopt_direct_popup(&entry, target, opener),
            Ok(BrowserEvent::TabOpened { .. }) => {}
            Ok(BrowserEvent::TabClosed { target }) => {
                let tab = relay.st().tabs.values().find(|t| is_entry(t, &entry) && t.target_id == target.as_str()).map(|t| t.id);
                if let Some(tab) = tab {
                    relay.direct_tab_closed(tab, &CloseReason::Closed);
                }
            }
            Ok(BrowserEvent::Disconnected) | Err(broadcast::error::RecvError::Closed) => {
                relay.driver_gone(&entry, "browser-disconnected");
                return;
            }
            Err(broadcast::error::RecvError::Lagged(_)) => relay.probe_direct_tabs(&entry).await,
        }
    }
}

/// A direct tab's URL and title, read in browse's isolated world.
async fn refresh_title(relay: &Arc<Relay>, tab: i64) {
    let found = relay.st().tabs.get(&tab).and_then(|t| Some((t.raw_driver.clone()?, t.main_frame.clone()?)));
    let Some((raw, main)) = found else { return };
    let realm = Realm { frame: browse_core::FrameId::from(main), world: World::Isolated };
    let opts = CallOptions { returns: Returns::Json, await_promise: false, user_activation: false };
    let Ok(Ok(Ok(Evaluated::Json(Value::Array(values))))) = tokio::time::timeout(Duration::from_secs(2), raw.evaluate(&realm, "[location.href, document.title]", opts)).await else {
        return;
    };
    if let Some(entry) = relay.st().tabs.get_mut(&tab) {
        if let Some(url) = values.first().and_then(Value::as_str) {
            entry.url = url.to_string();
        }
        if let Some(title) = values.get(1).and_then(Value::as_str) {
            entry.title = title.to_string();
        }
    }
}

/// The `tabs` list's refresh for direct tabs.
pub(crate) async fn refresh_direct_titles(relay: &Arc<Relay>) {
    let tabs: Vec<i64> = relay.st().tabs.values().filter(|t| t.backend.is_direct()).map(|t| t.id).collect();
    futures_util::future::join_all(tabs.into_iter().map(|tab| refresh_title(relay, tab))).await;
}

fn failure(status: StatusCode, code: &str, error: String) -> (StatusCode, Value) {
    (status, json!({ "error": error, "code": code }))
}

/// The endpoint a `/drivers/connect` body names, checked: its session URL, host and port.
fn endpoint(raw: &str) -> Result<(String, String, u16), String> {
    let url = url::Url::parse(raw.trim()).map_err(|error| format!("url is not a valid URL ({error})"))?;
    if url.scheme() != "ws" {
        return Err("url must be a ws:// URL (a WebDriver BiDi endpoint, like ws://127.0.0.1:9222)".into());
    }
    if !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some() {
        return Err("url must not have credentials, a query or a fragment".into());
    }
    let host = url.host_str().filter(|h| !h.is_empty()).ok_or("url has no host")?.to_string();
    let port = url.port_or_known_default().ok_or("url has no port")?;
    let path = match url.path() {
        "" | "/" => "/session",
        path => path,
    };
    Ok((format!("ws://{host}:{port}{path}"), host, port))
}

/// `POST /drivers/connect`: connects a WebDriver BiDi browser and registers it. The connection and its session run in
/// a task of their own, so a client that gives up never leaves a session behind in the browser.
pub(crate) async fn connect(relay: &Arc<Relay>, body: &Value) -> (StatusCode, Value) {
    let protocol = body.get("protocol").and_then(Value::as_str).unwrap_or("");
    if protocol != "webdriver-bidi" {
        return failure(StatusCode::BAD_REQUEST, "invalid-request", format!("protocol must be \"webdriver-bidi\", not {protocol:?}"));
    }
    let Some(raw) = body.get("url").and_then(Value::as_str) else {
        return failure(StatusCode::BAD_REQUEST, "invalid-request", "url is required".into());
    };
    let (url, host, port) = match endpoint(raw) {
        Ok(parts) => parts,
        Err(error) => return failure(StatusCode::BAD_REQUEST, "invalid-request", error),
    };
    let key = match body.get("key") {
        None | Some(Value::Null) => format!("driver:bidi:{host}:{port}"),
        Some(Value::String(key)) if !key.trim().is_empty() && key.len() <= 512 && !key.chars().any(char::is_control) => {
            let key = key.trim();
            if key.starts_with("driver:") { key.to_string() } else { format!("driver:bidi:{key}") }
        }
        Some(_) => return failure(StatusCode::BAD_REQUEST, "invalid-request", "key must be a non-empty string of at most 512 characters".into()),
    };
    let name = body.get("name").and_then(Value::as_str).map(str::trim).filter(|n| !n.is_empty()).map(str::to_string);
    let allow_remote = crate::guardrails::env_on("OPENCODE_BROWSER_ALLOW_REMOTE_DRIVERS");
    {
        let mut st = relay.st();
        if let Some(existing) = st.drivers.iter().find(|d| d.key == key && d.connected()) {
            return (StatusCode::OK, json!({ "connected": true, "existing": true, "browser": entry_json(existing) }));
        }
        if st.connecting.contains(&key) {
            return failure(StatusCode::CONFLICT, "driver-connecting", format!("browse is already connecting to {url}; try again in a moment"));
        }
        if st.drivers.len() + st.connecting.len() >= MAX_DRIVERS {
            return failure(StatusCode::CONFLICT, "driver-limit", format!("browse already drives {MAX_DRIVERS} browsers; disconnect one first"));
        }
        st.connecting.insert(key.clone());
    }
    let (done, answer) = oneshot::channel();
    let task_relay = relay.clone();
    tokio::spawn(async move {
        let relay = task_relay;
        let outcome = connect_now(&relay, &url, &host, port, key.clone(), name, allow_remote).await;
        relay.st().connecting.remove(&key);
        let _ = done.send(outcome);
    });
    answer.await.unwrap_or_else(|_| failure(StatusCode::INTERNAL_SERVER_ERROR, "driver-connect-failed", "the connection task ended".into()))
}

/// Resolves, checks the peer is loopback (before any WebSocket byte), starts the session and registers it.
async fn connect_now(relay: &Arc<Relay>, url: &str, host: &str, port: u16, key: String, name: Option<String>, allow_remote: bool) -> (StatusCode, Value) {
    let not_local = || {
        failure(
            StatusCode::FORBIDDEN,
            "driver-not-local",
            format!("{url} is not on this computer: browse connects only to loopback WebDriver BiDi endpoints unless the relay runs with OPENCODE_BROWSER_ALLOW_REMOTE_DRIVERS=1"),
        )
    };
    let lookup = tokio::time::timeout(Duration::from_secs(5), tokio::net::lookup_host(format!("{host}:{port}"))).await;
    let addresses: Vec<std::net::SocketAddr> = match lookup {
        Ok(Ok(addresses)) => addresses.collect(),
        _ => Vec::new(),
    };
    if addresses.is_empty() {
        return failure(StatusCode::BAD_GATEWAY, "driver-connect-failed", format!("couldn't resolve {host}"));
    }
    if !allow_remote && !addresses.iter().all(|a| a.ip().is_loopback()) {
        return not_local();
    }
    let stream = match tokio::time::timeout(Duration::from_secs(10), tokio::net::TcpStream::connect(&addresses[..])).await {
        Ok(Ok(stream)) => stream,
        Ok(Err(error)) => return failure(StatusCode::BAD_GATEWAY, "driver-connect-failed", format!("couldn't connect to {url}: {error}")),
        Err(_) => return failure(StatusCode::GATEWAY_TIMEOUT, "driver-connect-failed", format!("{url} didn't answer within 10 s")),
    };
    let local = stream.peer_addr().map(|peer| peer.ip().is_loopback()).unwrap_or(false);
    if !local && !allow_remote {
        return not_local();
    }
    let driver = match browse_bidi::BiDiBrowserDriver::connect_stream(url, stream).await {
        Ok(driver) => driver,
        Err(error) => {
            let message = error.to_string();
            let busy = message.contains("Maximum number of active sessions") || message.contains("is busy") || message.contains("refused a WebDriver BiDi session");
            return if busy {
                failure(
                    StatusCode::CONFLICT,
                    "driver-session-busy",
                    format!("The browser at {url} already has a WebDriver BiDi session (another client holds it, or one wasn't ended). Close that client or restart Firefox, then connect again. ({message})"),
                )
            } else {
                failure(StatusCode::BAD_GATEWAY, "driver-connect-failed", message)
            };
        }
    };
    let capabilities = driver.capabilities();
    let name = name.unwrap_or_else(|| browser_name(capabilities.get("browserName").and_then(Value::as_str).unwrap_or("Firefox")));
    let version = capabilities.get("browserVersion").and_then(Value::as_str).map(str::to_string);
    let driver: Arc<dyn BrowserDriver> = driver;
    match relay.register_driver(driver, key, name, version, Some(url.to_string()), local).await {
        Ok(entry) => (StatusCode::OK, json!({ "connected": true, "browser": entry_json(&entry) })),
        Err(error) if relay.is_stopping() => failure(StatusCode::SERVICE_UNAVAILABLE, "relay-restarting", error.to_string()),
        Err(error) => failure(StatusCode::CONFLICT, "driver-connect-failed", error.to_string()),
    }
}

/// `POST /drivers/disconnect`: `{ "browser": "<id | name | endpoint>", "quit"?: true }`.
pub(crate) async fn disconnect(relay: &Arc<Relay>, body: &Value) -> (StatusCode, Value) {
    let Some(browser) = body.get("browser").and_then(Value::as_str).map(str::trim).filter(|b| !b.is_empty()) else {
        return failure(StatusCode::BAD_REQUEST, "invalid-request", "browser is required".into());
    };
    let quit = body.get("quit").and_then(Value::as_bool).unwrap_or(false);
    let entry = relay.st().driver_by_name(browser);
    match entry {
        Some(entry) => {
            relay.disconnect_driver(&entry, quit).await;
            (StatusCode::OK, json!({ "disconnected": true, "browser": entry.id, "quit": quit }))
        }
        None => (StatusCode::OK, json!({ "disconnected": false })),
    }
}
