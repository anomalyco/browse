//! The relay's shared state and its links to browsers. Tab ids are the relay's own: a browser's tab keeps its Chrome
//! id unless another connected browser already has a tab with it, and every command and event is translated at the
//! link's edge (cli/src/relay/browser-links.ts).

use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::ops::{Deref, DerefMut};
use std::panic::Location;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, RwLock, Weak};
use std::time::{Duration, Instant};

use browse_core::{CdpEvent, Tool};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::{Notify, broadcast, oneshot};

use crate::link::{Link, RpcError, Timeouts};
use crate::paths::Paths;
use crate::protocol::NOT_CONNECTED;
use crate::sessions::Session;

pub type AutoUpdateStatus = Arc<dyn Fn() -> Value + Send + Sync>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Owner {
    Relay,
    User,
}

impl Owner {
    pub fn name(self) -> &'static str {
        match self {
            Owner::Relay => "relay",
            Owner::User => "user",
        }
    }
}

#[derive(Debug, Clone)]
pub struct Child {
    pub target_id: String,
    pub kind: String,
    pub url: String,
}

pub struct Tab {
    pub id: i64,
    pub link_key: String,
    pub target_id: String,
    pub url: String,
    pub title: String,
    pub owner: Owner,
    pub session: Option<String>,
    pub events: broadcast::Sender<CdpEvent>,
    pub children: HashMap<String, Child>,
    pub suppressed: HashSet<String>,
    pub crashed: bool,
    pub main_frame: Option<String>,
    pub last_used: Instant,
    pub focused: bool,
    pub fresh_popup: bool,
    pub blanking: u32,
    /// Chrome refuses every command for the tab while another extension's frame (a password manager's popup) is in
    /// it (cli/src/cdp/protected-frames.ts).
    pub protected_ui: bool,
    /// Child frames showing another extension's document; their events are hidden from tools.
    pub protected_frames: HashSet<String>,
    /// Chrome won't let the debugger into the tab ("Cannot attach to this target": a blocked load's error page).
    pub unattachable: bool,
    /// Child frames seen attaching (with a parent), so a navigation intent can be told apart from the main frame's.
    pub child_frames: HashSet<String>,
    /// The one CDP handle tools get for this attachment, with the session it was made for.
    pub cdp: Option<(String, Arc<crate::cdp::TabCdp>)>,
}

#[derive(Debug, Clone)]
pub struct KnownOwner {
    /// The relay's id for the tab, so a reconnecting browser that doesn't announce it again can get it back.
    pub tab: i64,
    pub session: String,
    pub owner: Owner,
    pub browser: String,
}

pub struct Handoff {
    pub id: String,
    pub session: String,
    pub tab: i64,
    pub target_id: String,
    pub message: String,
    pub started_at: String,
    pub done: Option<oneshot::Sender<&'static str>>,
}

#[derive(Default)]
pub struct Presented {
    pub dirty: bool,
    pub busy: bool,
    pub status: Option<Value>,
    pub badge: Option<Value>,
    pub group: Option<Value>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct KnownBrowser {
    pub id: String,
    pub name: String,
}

#[derive(Default)]
pub struct HandshakeStats {
    pub pairing_failures: u32,
    pub last_unpaired: Option<Instant>,
    pub last_refused: Option<Instant>,
    pub mismatch: Option<(Option<i64>, Option<String>)>,
}

pub struct State {
    pub links: Vec<Arc<Link>>,
    pub generation: u64,
    to_relay: HashMap<(String, i64), i64>,
    from_relay: HashMap<i64, (String, i64)>,
    next_tab_id: i64,
    pub known: BTreeMap<String, KnownBrowser>,
    pub tabs: HashMap<i64, Tab>,
    pub sessions: BTreeMap<String, Session>,
    pub callers: HashMap<String, String>,
    pub handoffs: HashMap<String, Handoff>,
    pub reconnect_owners: HashMap<String, KnownOwner>,
    pub tombstones: HashMap<String, String>,
    pub swept: HashSet<String>,
    pub handshake: HandshakeStats,
    pub presented: HashMap<i64, Presented>,
    pub last_activity: Instant,
    pub last_connected: Option<Instant>,
    pub client_gone_since: HashMap<String, Instant>,
    /// A newer browse the extension's pages mention (`update.notice`): summary and command.
    pub update_notice: Option<(String, String)>,
    /// `install` is polling for a browser to pair; the extension's probe hears `installWaiting` until then.
    pub install_waiting_until: Option<Instant>,
}

impl State {
    pub fn link(&self, key: &str) -> Option<Arc<Link>> {
        self.links.iter().find(|l| l.key == key).cloned()
    }

    /// The browser agents use when they don't name one: the first that connected and is ready.
    pub fn default_link(&self) -> Option<Arc<Link>> {
        self.links.iter().find(|l| l.connected()).or(self.links.first()).cloned()
    }

    pub fn link_by_name(&self, wanted: &str) -> Option<Arc<Link>> {
        let wanted = wanted.trim().to_lowercase();
        self.links.iter().find(|l| l.id == wanted).or_else(|| self.links.iter().find(|l| l.name.to_lowercase() == wanted)).cloned()
    }

    pub fn connected(&self) -> bool {
        self.links.iter().any(|l| l.connected())
    }

    /// The relay's id for a browser's tab, assigned the first time it's seen.
    pub fn relay_tab_id(&mut self, key: &str, tab: i64) -> i64 {
        if let Some(id) = self.to_relay.get(&(key.to_string(), tab)) {
            return *id;
        }
        let mut id = tab;
        while self.from_relay.contains_key(&id) {
            id = self.next_tab_id;
            self.next_tab_id += 1;
        }
        self.to_relay.insert((key.to_string(), tab), id);
        self.from_relay.insert(id, (key.to_string(), tab));
        id
    }

    pub fn owner_key(&self, tab: i64) -> Option<&str> {
        self.from_relay.get(&tab).map(|(key, _)| key.as_str())
    }

    /// The connected browser a relay tab id belongs to, and the tab's id there.
    pub fn browser_tab(&self, tab: i64) -> Option<(Arc<Link>, i64)> {
        let (key, local) = self.from_relay.get(&tab)?;
        Some((self.link(key)?, *local))
    }

    /// The browser's id and name for a profile: the id it had, else a new slug of its name unique among known
    /// browsers. A `fallback` name (the computer's address, when its name couldn't be looked up) never replaces the
    /// one the browser already has.
    pub fn identify(&mut self, paths: &Paths, key: &str, name: &str, fallback: bool) -> (String, String) {
        if let Some(previous) = self.known.get(key).filter(|k| k.name == name || fallback) {
            return (previous.id.clone(), previous.name.clone());
        }
        let taken: HashSet<String> = self.known.iter().filter(|(k, _)| *k != key).map(|(_, v)| v.id.clone()).collect();
        let base = browser_slug(name);
        let mut id = base.clone();
        let mut n = 2;
        while taken.contains(&id) {
            id = format!("{base}-{n}");
            n += 1;
        }
        self.known.insert(key.to_string(), KnownBrowser { id: id.clone(), name: name.to_string() });
        let _ = crate::paths::write_private_json(&paths.browsers(), &self.known);
        (id, name.to_string())
    }

    pub fn session_tabs(&self, session: &str) -> Vec<i64> {
        let mut tabs: Vec<i64> = self.tabs.values().filter(|t| t.session.as_deref() == Some(session)).map(|t| t.id).collect();
        tabs.sort();
        tabs
    }

    pub fn handoff_for_tab(&self, tab: i64) -> Option<&Handoff> {
        self.handoffs.values().find(|h| h.tab == tab)
    }
}

thread_local! {
    /// The relays whose state lock this thread holds, and where it took them.
    static HELD: RefCell<Vec<(usize, &'static Location<'static>)>> = const { RefCell::new(Vec::new()) };
}

/// Who holds the state lock: where it was taken, since when, on which thread.
#[derive(Debug, Clone, Copy)]
pub struct Holder {
    pub at: &'static Location<'static>,
    pub since: Instant,
    pub thread: std::thread::ThreadId,
}

/// The state lock, held. Not `Send`, so it can't be held across an `.await` in a spawned task.
pub struct StateGuard<'a> {
    guard: MutexGuard<'a, State>,
    relay: &'a Relay,
}

impl Deref for StateGuard<'_> {
    type Target = State;
    fn deref(&self) -> &State {
        &self.guard
    }
}

impl DerefMut for StateGuard<'_> {
    fn deref_mut(&mut self) -> &mut State {
        &mut self.guard
    }
}

impl Drop for StateGuard<'_> {
    fn drop(&mut self) {
        let me = self.relay as *const Relay as usize;
        *self.relay.holder.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
        HELD.with(|held| {
            let mut held = held.borrow_mut();
            if let Some(index) = held.iter().rposition(|(relay, _)| *relay == me) {
                held.remove(index);
            }
        });
    }
}

/// A tool call in flight, for the log when the relay has to be ended.
#[derive(Debug, Clone)]
pub struct InFlight {
    pub tool: String,
    pub session: String,
    pub since: Instant,
}

/// "Chrome on Dax's MacBook Pro" -> "chrome-daxs-macbook-pro".
pub fn browser_slug(name: &str) -> String {
    let lower = name.to_lowercase().replace(['\'', '’'], "");
    let words: Vec<&str> = lower.split(|c: char| !c.is_ascii_alphanumeric()).filter(|w| !w.is_empty() && *w != "on").collect();
    let mut slug = words.join("-");
    slug.truncate(40);
    let slug = slug.trim_end_matches('-').to_string();
    if slug.is_empty() { "browser".into() } else { slug }
}

pub struct Relay {
    me: Weak<Relay>,
    pub paths: Paths,
    pub configured_port: u16,
    pub port: u16,
    pub host: String,
    pub instance_id: String,
    pub started_at: String,
    pub version: String,
    pub build_id: String,
    pub token: String,
    pub timeouts: Timeouts,
    pub origins: HashSet<String>,
    pub file_roots: Vec<PathBuf>,
    pub auto_update: Option<AutoUpdateStatus>,
    pub idle_shutdown: Option<Duration>,
    pub idle_tab_ttl: Option<Duration>,
    pub state: Mutex<State>,
    pub changed: Notify,
    pub persist: Notify,
    pub stopping: AtomicBool,
    pub stopped: Notify,
    pub tools: RwLock<Vec<Arc<dyn Tool>>>,
    pub next_call: AtomicU64,
    pub ready: AtomicBool,
    /// Started on demand by a client (OPENCODE_BROWSER_MANAGED_RELAY=1).
    pub managed: bool,
    /// Who holds `state`, for the watchdog.
    pub holder: Mutex<Option<Holder>>,
    /// Tool calls in flight by call id, for the log.
    pub inflight: Mutex<HashMap<u64, InFlight>>,
    /// Bumped every second by a task on the runtime; the watchdog ends a relay whose runtime stopped running it.
    pub heartbeat: AtomicU64,
    /// The relay's tasks ended (it closed, or its runtime is gone): the watchdog stops watching.
    pub finished: AtomicBool,
    /// One tab opening at a time per session, so concurrent first calls share the tab.
    pub tab_locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

pub struct RelayConfig {
    pub paths: Paths,
    pub configured_port: u16,
    pub port: u16,
    pub host: String,
    pub version: String,
    pub build_id: String,
    pub auto_update: Option<AutoUpdateStatus>,
    pub idle_shutdown: Option<Duration>,
    pub managed: bool,
}

fn env_ms(variable: &str, fallback: u64) -> Option<Duration> {
    let value = std::env::var(variable).ok().and_then(|v| v.trim().parse::<u64>().ok()).unwrap_or(fallback);
    (value > 0).then(|| Duration::from_millis(value))
}

impl Relay {
    pub fn new(config: RelayConfig) -> anyhow::Result<Arc<Self>> {
        crate::paths::ensure_private_dir(&config.paths.data)?;
        let token = crate::secrets::relay_token(&config.paths)?;
        let known = crate::paths::read_json(&config.paths.browsers()).unwrap_or_default();
        let file_roots = file_roots();
        Ok(Arc::new_cyclic(|me| Relay {
            me: me.clone(),
            paths: config.paths,
            configured_port: config.configured_port,
            port: config.port,
            host: config.host,
            instance_id: crate::util::random_hex(16),
            started_at: crate::util::now_iso(),
            version: config.version,
            build_id: config.build_id,
            token,
            timeouts: Timeouts::from_env(),
            origins: crate::origins::allowed_extension_origins(),
            file_roots,
            auto_update: config.auto_update,
            idle_shutdown: config.idle_shutdown,
            idle_tab_ttl: env_ms("OPENCODE_BROWSER_IDLE_TAB_TTL_MS", 15 * 60_000),
            state: Mutex::new(State {
                links: Vec::new(),
                generation: 0,
                to_relay: HashMap::new(),
                from_relay: HashMap::new(),
                next_tab_id: 1_000_000_000,
                known,
                tabs: HashMap::new(),
                sessions: BTreeMap::new(),
                callers: HashMap::new(),
                handoffs: HashMap::new(),
                reconnect_owners: HashMap::new(),
                tombstones: HashMap::new(),
                swept: HashSet::new(),
                handshake: HandshakeStats::default(),
                presented: HashMap::new(),
                last_activity: Instant::now(),
                last_connected: None,
                client_gone_since: HashMap::new(),
                update_notice: None,
                install_waiting_until: None,
            }),
            changed: Notify::new(),
            persist: Notify::new(),
            stopping: AtomicBool::new(false),
            stopped: Notify::new(),
            tools: RwLock::new(Vec::new()),
            next_call: AtomicU64::new(1),
            ready: AtomicBool::new(false),
            managed: config.managed,
            holder: Mutex::new(None),
            inflight: Mutex::new(HashMap::new()),
            heartbeat: AtomicU64::new(0),
            finished: AtomicBool::new(false),
            tab_locks: Mutex::new(HashMap::new()),
        }))
    }

    pub fn me(&self) -> Arc<Relay> {
        self.me.upgrade().expect("the relay outlives its work")
    }

    /// The relay's state. The lock is not re-entrant: taking it again on a thread that holds it panics instead of
    /// deadlocking (a temporary guard in an `if let`/`match` scrutinee lives for the whole block). Whoever holds it
    /// is recorded for the watchdog, which ends a relay whose lock stays held.
    #[track_caller]
    pub fn st(&self) -> StateGuard<'_> {
        let at = Location::caller();
        let me = self as *const Relay as usize;
        let held = HELD.with(|held| held.borrow().iter().find(|(relay, _)| *relay == me).map(|(_, at)| *at));
        if let Some(held) = held {
            crate::rlog!("relay.lock.reentrant", at = at.to_string(), heldAt = held.to_string());
            panic!("browse relay: the state lock is already held on this thread (taken at {held}, again at {at}); that would deadlock");
        }
        let guard = self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        *self.holder.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(Holder { at, since: Instant::now(), thread: std::thread::current().id() });
        HELD.with(|held| held.borrow_mut().push((me, at)));
        StateGuard { guard, relay: self }
    }

    /// The session's tab-opening lock.
    pub fn tab_lock(&self, session: &str) -> Arc<tokio::sync::Mutex<()>> {
        self.tab_locks.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).entry(session.to_string()).or_default().clone()
    }

    pub fn browsers_changed(&self) {
        self.changed.notify_waiters();
    }

    pub fn stop(&self) {
        if !self.stopping.swap(true, Ordering::SeqCst) {
            self.stopped.notify_waiters();
        }
    }

    pub fn is_stopping(&self) -> bool {
        self.stopping.load(Ordering::SeqCst)
    }

    /// Sends a command for a relay tab to the browser that owns it, translating the tab id both ways.
    pub async fn ext_tab(&self, tab: i64, method: &str, mut params: Value) -> Result<Value, RpcError> {
        let Some((link, local)) = self.st().browser_tab(tab) else { return Err(RpcError::NotConnected(NOT_CONNECTED.into())) };
        params["tabId"] = local.into();
        let result = self.ext_link_raw(&link, method, params, None).await;
        if let Err(RpcError::Remote(message)) = &result
            && missing_tab(message) {
                self.me().forget_missing_tab(tab, method);
            }
        result
    }

    pub async fn ext_link(&self, link: &Arc<Link>, method: &str, params: Value) -> Result<Value, RpcError> {
        self.ext_link_raw(link, method, params, None).await
    }

    async fn ext_link_raw(&self, link: &Arc<Link>, method: &str, params: Value, timeout: Option<Duration>) -> Result<Value, RpcError> {
        let mut result = link.call(method, params, timeout).await?;
        if let Some(local) = result.get("tabId").and_then(Value::as_i64) {
            result["tabId"] = self.st().relay_tab_id(&link.key, local).into();
        }
        Ok(result)
    }

    pub fn ext_best_effort(&self, tab: i64, method: &'static str, params: Value) {
        let relay = self.me();
        tokio::spawn(async move {
            let _ = relay.ext_tab(tab, method, params).await;
        });
    }

    /// A CDP command for a tab (or one of its child sessions) through chrome.debugger.
    pub async fn debugger(&self, tab: i64, session: Option<&str>, method: &str, params: Value, timeout: Option<Duration>) -> Result<Value, RpcError> {
        let Some((link, local)) = self.st().browser_tab(tab) else { return Err(RpcError::NotConnected(NOT_CONNECTED.into())) };
        let mut wire = json!({ "tabId": local, "method": method, "params": if params.is_null() { json!({}) } else { params } });
        if let Some(session) = session {
            wire["sessionId"] = session.into();
        }
        let result = match timeout {
            Some(limit) => match tokio::time::timeout(limit, link.call("debugger.sendCommand", wire, None)).await {
                Ok(result) => result,
                Err(_) => Err(RpcError::Timeout(format!("{method} did not answer within {} ms on tab {tab}", limit.as_millis()))),
            },
            None => link.call("debugger.sendCommand", wire, None).await,
        };
        match &result {
            Err(RpcError::Remote(message)) if missing_tab(message) => self.me().forget_missing_tab(tab, method),
            Err(RpcError::Remote(message))
                if protected_ui_error(message) || (message.contains("not attached") && self.st().tabs.get(&tab).is_some_and(|t| t.protected_ui)) =>
            {
                if let Some(entry) = self.st().tabs.get_mut(&tab)
                    && !std::mem::replace(&mut entry.protected_ui, true) {
                        crate::rlog!("tab.protected_ui", tabId = tab, blocked = true, method = method);
                    }
                return Err(RpcError::Remote(protected_ui_message(tab)));
            }
            Err(RpcError::Remote(message)) if unattachable_error(message) || (message.contains("not attached") && self.st().tabs.get(&tab).is_some_and(|t| t.unattachable)) => {
                let url = {
                    let mut st = self.st();
                    let Some(entry) = st.tabs.get_mut(&tab) else { return result };
                    if !std::mem::replace(&mut entry.unattachable, true) {
                        crate::rlog!("tab.unattachable", tabId = tab, method = method, url = crate::util::short_url(&entry.url));
                    }
                    entry.url.clone()
                };
                return Err(RpcError::Remote(unattachable_message(tab, &url)));
            }
            Ok(_) if session.is_none() => {
                if let Some(entry) = self.st().tabs.get_mut(&tab) {
                    if std::mem::replace(&mut entry.protected_ui, false) {
                        crate::rlog!("tab.protected_ui", tabId = tab, blocked = false);
                    }
                    entry.unattachable = false;
                }
            }
            _ => {}
        }
        result
    }

    pub fn debugger_best_effort(&self, tab: i64, session: Option<String>, method: &'static str, params: Value) {
        let relay = self.me();
        tokio::spawn(async move {
            let _ = relay.debugger(tab, session.as_deref(), method, params, Some(Duration::from_secs(5))).await;
        });
    }

    /// Waits until `ready` holds (re-checked whenever browsers change) or `limit` passes.
    pub async fn wait_until(&self, limit: Duration, ready: impl Fn(&State) -> bool) -> bool {
        let deadline = tokio::time::Instant::now() + limit;
        loop {
            let notified = self.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if ready(&self.st()) {
                return true;
            }
            if tokio::time::timeout_at(deadline, notified).await.is_err() {
                return ready(&self.st());
            }
        }
    }

    pub fn schedule_persist(&self) {
        self.persist.notify_one();
    }

    /// Writes the session catalog now.
    pub fn persist_now(&self) {
        let entries: Vec<_> = {
            let st = self.st();
            st.sessions
                .values()
                .map(|session| {
                    let live: Vec<String> =
                        st.tabs.values().filter(|t| t.owner == Owner::Relay && t.session.as_deref() == Some(&session.id)).map(|t| t.target_id.clone()).collect();
                    let current = session.current.and_then(|tab| st.tabs.get(&tab)).map(|tab| crate::sessions::PersistedTarget { id: tab.target_id.clone(), owner: tab.owner.name().into() });
                    session.persisted(&live, current)
                })
                .collect()
        };
        if let Err(error) = crate::sessions::save_catalog(&self.paths.session_catalog(self.configured_port), &entries) {
            crate::rlog!("session.catalog.write_failed", error = error.to_string());
        }
    }

    pub fn note_activity(&self) {
        self.st().last_activity = Instant::now();
    }
}

/// "No tab with given id 7." from chrome.debugger, "No tab with id: 7." from chrome.tabs.
pub fn missing_tab(message: &str) -> bool {
    message.contains("No tab with given id") || message.contains("No tab with id")
}

/// chrome.debugger refuses every command for a tab while another extension's frame is in it.
pub fn protected_ui_error(message: &str) -> bool {
    message.to_lowercase().contains("cannot access a chrome-extension:// url of different extension")
}

pub fn protected_ui_message(tab: i64) -> String {
    format!(
        "Another extension's popup (a password manager, maybe) is covering the page in tab {tab}, and Chrome blocks browse from the tab while it's open. Ask the user to finish or dismiss it in the browser (or use the handoff tool), then retry. The tab is still yours."
    )
}

/// Chrome keeps the debugger out of some error pages (a load blocked by the browser or another extension).
pub fn unattachable_error(message: &str) -> bool {
    message.contains("Cannot attach to this target")
}

pub fn unattachable_message(tab: i64, url: &str) -> String {
    let page = if url.is_empty() { String::new() } else { format!(" ({})", crate::util::short_url(url)) };
    format!(
        "Tab {tab} is stuck on a Chrome error page{page}: its last load failed (blocked by the browser or another extension), and Chrome doesn't let browse into that page. Call navigate without tabId to load another page (browse replaces an agent's tab), or close it with the tabs tool. A tab the user lent has to be navigated by the user."
    )
}

/// Folders tools may read and write: the temp folders and OPENCODE_BROWSER_FILE_ROOTS (path-list separated).
pub fn file_roots() -> Vec<PathBuf> {
    let mut roots = vec![std::env::temp_dir()];
    if cfg!(unix) {
        roots.push(PathBuf::from("/tmp"));
    }
    if let Some(extra) = std::env::var_os("OPENCODE_BROWSER_FILE_ROOTS") {
        roots.extend(std::env::split_paths(&extra).filter(|p| p.is_absolute()));
    }
    let mut out: Vec<PathBuf> = Vec::new();
    for root in roots {
        let resolved = std::fs::canonicalize(&root).unwrap_or(root);
        if !out.contains(&resolved) {
            out.push(resolved);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    #[test]
    fn slugs() {
        assert_eq!(super::browser_slug("Chrome on Dax's MacBook Pro"), "chrome-daxs-macbook-pro");
        assert_eq!(super::browser_slug("!!!"), "browser");
    }
}
