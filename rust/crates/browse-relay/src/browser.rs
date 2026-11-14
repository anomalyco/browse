//! Sessions and their tabs, as tools see them: `browse_core::Browser` for the relay, and the session lifecycle
//! (create, adopt, reset, delete) behind the session tool.

use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context, anyhow, bail};
use async_trait::async_trait;
use browse_core::{Browser, Cdp, HandoffResult, SessionId, TabId, TabInfo};
use serde_json::{Value, json};

use crate::link::Link;
use crate::protocol;
use crate::relay::{Owner, Relay, State};
use crate::rlog;
use crate::sessions::{BrowserRef, PersistedTarget, Session, valid_session_id};
use crate::tabs::Release;

/// How long a call waits for a browser that is reconnecting (a worker or relay restart) before failing.
const RECONNECT_WAIT: Duration = Duration::from_secs(12);

#[derive(Debug, Clone, Default)]
pub struct SessionOptions {
    pub read_only: bool,
    pub allowed_origins: Option<Vec<String>>,
    pub keep_visible: bool,
    pub browser: Option<String>,
}

impl Relay {
    pub fn tab_info(&self, st: &State, tab: i64, session: &str) -> Option<TabInfo> {
        let entry = st.tabs.get(&tab)?;
        let current = st.sessions.get(session).and_then(|s| s.current);
        Some(TabInfo { tab_id: tab, url: entry.url.clone(), title: entry.title.clone(), active: current == Some(tab) })
    }

    /// The session's tab, or why it can't use it.
    pub fn visible_tab(&self, session: &str, tab: i64) -> anyhow::Result<()> {
        let st = self.st();
        let Some(entry) = st.tabs.get(&tab) else {
            bail!("Tab {tab} isn't attached to browse. List the session's tabs with the tabs tool, or ask the user to click the browse toolbar button on it.")
        };
        match &entry.session {
            Some(owner) if owner != session => bail!("Tab {tab} belongs to session {owner}."),
            None if entry.owner == Owner::User => bail!("Tab {tab} is one the user lent; adopt it first (session tool, action adopt, tabId {tab})."),
            _ => Ok(()),
        }
    }

    pub fn ensure_session(&self, id: &str) -> anyhow::Result<()> {
        if !valid_session_id(id) {
            bail!("Session ids use lowercase letters, numbers, dashes and underscores, at most 63 characters: {id:?}");
        }
        let mut st = self.st();
        if !st.sessions.contains_key(id) {
            st.sessions.insert(id.to_string(), Session::new(id.to_string()));
            drop(st);
            rlog!("session.created", session = id);
            self.schedule_persist();
        }
        Ok(())
    }

    pub fn create_session(&self, id: Option<&str>, options: SessionOptions) -> anyhow::Result<String> {
        let allowed = match &options.allowed_origins {
            Some(origins) => Some(crate::domain::normalize_origin_patterns(origins).map_err(|e| anyhow!(e))?).filter(|o| !o.is_empty()),
            None => None,
        };
        let mut st = self.st();
        let id = match id {
            Some(id) => {
                if !valid_session_id(id) {
                    bail!("Session ids use lowercase letters, numbers, dashes and underscores, at most 63 characters: {id:?}");
                }
                if st.sessions.contains_key(id) {
                    bail!("Session already exists: {id}");
                }
                id.to_string()
            }
            None => crate::sessions::generate_session_id(&|candidate| st.sessions.contains_key(candidate)),
        };
        let browser = match &options.browser {
            Some(name) => {
                let link = st.link_by_name(name).ok_or_else(|| {
                    let connected = st.links.iter().map(|l| format!("{} ({})", l.id, l.name)).collect::<Vec<_>>().join(", ");
                    anyhow!("No connected browser is called \"{name}\". {}", if connected.is_empty() { "No browser is connected.".to_string() } else { format!("Connected: {connected}.") })
                })?;
                Some(BrowserRef { id: link.id.clone(), key: Some(link.key.clone()) })
            }
            None => None,
        };
        let mut session = Session::new(id.clone());
        session.read_only = options.read_only;
        session.allowed_origins = allowed;
        session.keep_visible = options.keep_visible;
        session.browser = browser;
        st.sessions.insert(id.clone(), session);
        drop(st);
        rlog!("session.created", session = id.clone());
        self.schedule_persist();
        Ok(id)
    }

    /// The browser a session works in: the one it's bound to (waiting briefly while it reconnects), else the default
    /// browser, which it is then bound to.
    pub async fn session_link(self: &Arc<Self>, session: &str) -> anyhow::Result<Arc<Link>> {
        let bound = self.st().sessions.get(session).context("Session not found")?.browser.clone();
        if let Some(BrowserRef { id, key: Some(key) }) = bound {
            let found = self.wait_until(RECONNECT_WAIT, |st| st.link(&key).is_some_and(|l| l.connected())).await;
            let st = self.st();
            return match st.link(&key) {
                Some(link) if found => Ok(link),
                Some(link) if link.unresponsive() => bail!("Session {session} belongs to browser '{id}'. {}", protocol::BROWSER_UNRESPONSIVE),
                _ if crate::pairing::browser_token(&self.paths, &key).is_some() => {
                    bail!("Session {session} belongs to browser '{id}', which isn't connected. Reconnect it or start a new session.")
                }
                _ => bail!("Session {session} belongs to browser '{id}', whose pairing was revoked. Pair it again or start a new session."),
            };
        }
        let recently = {
            let st = self.st();
            st.last_connected.is_some_and(|at| at.elapsed() < Duration::from_secs(120)) || !st.links.is_empty()
        };
        let wait = if recently { RECONNECT_WAIT } else { Duration::from_millis(1500) };
        self.wait_until(wait, State::connected).await;
        let link = {
            let mut st = self.st();
            let link = st.links.iter().find(|l| l.connected()).cloned();
            if let (Some(link), Some(entry)) = (&link, st.sessions.get_mut(session)) {
                entry.browser = Some(BrowserRef { id: link.id.clone(), key: Some(link.key.clone()) });
            }
            link
        };
        match link {
            Some(link) => {
                self.schedule_persist();
                Ok(link)
            }
            None => bail!("{}", self.not_connected_advice()),
        }
    }

    pub fn not_connected_advice(&self) -> String {
        let status = self.extension_status();
        status["nextStep"].as_str().map(str::to_string).unwrap_or_else(|| "No browser is connected. Open the browser with the browse extension.".into())
    }

    /// The session's current tab, opening one when it has none.
    pub async fn current_or_open(self: &Arc<Self>, session: &str) -> anyhow::Result<i64> {
        self.ensure_session(session)?;
        // Concurrent first calls wait for the one opening the tab, then use it.
        let lock = self.tab_lock(session);
        let _opening = lock.lock().await;
        // Only a navigation may start over in a new tab; anything else would act on a blank page.
        let navigating = crate::serve::TOOL.try_with(|tool| tool == "navigate").unwrap_or(false);
        let current = self.st().sessions.get(session).and_then(|s| s.current);
        if let Some(tab) = current {
            let stuck = self.st().tabs.get(&tab).map(|t| (t.unattachable, t.owner, t.url.clone()));
            match stuck {
                Some((true, Owner::Relay, url)) if navigating => {
                    let fresh = self.create_tab(session, None).await?;
                    let _ = self.close_or_release(tab).await;
                    rlog!("tab.replaced", tabId = tab, with = fresh, session = session, reason = "unattachable");
                    if let Some(entry) = self.st().sessions.get_mut(session) {
                        entry.add_warning(format!(
                            "Tab {tab} was stuck on a Chrome error page ({}); browse closed it and opened tab {fresh} for this navigation.",
                            crate::util::short_url(&url)
                        ));
                    }
                    return Ok(fresh);
                }
                Some(_) => return Ok(tab),
                None => {}
            }
            let key = self.st().owner_key(tab).map(str::to_string);
            if let Some(key) = key {
                let back = self.wait_until(RECONNECT_WAIT, |st| st.tabs.contains_key(&tab) || st.link(&key).is_some_and(|l| l.is_ready())).await;
                if back && self.st().tabs.contains_key(&tab) {
                    return Ok(tab);
                }
            }
            if let Some(entry) = self.st().sessions.get_mut(session) {
                entry.current = None;
                entry.lost.get_or_insert_with(|| format!("Tab {tab}, the session's current tab, went away."));
            }
        }
        if let Some(tab) = self.adopt_next_tab(session) {
            return Ok(tab);
        }
        // A browser that is reconnecting (a relay or worker restart) gives the session its tabs back once its
        // inventory is in: wait for that before opening another.
        self.session_link(session).await?;
        if let Some(tab) = self.adopt_next_tab(session) {
            return Ok(tab);
        }
        let lost = self.st().sessions.get(session).and_then(|s| s.lost.clone());
        if let Some(lost) = lost.filter(|_| !navigating) {
            bail!("{lost} Open a page with navigate (or tabs new), or pick a tab with tabs select; browse doesn't quietly start over in a blank tab.");
        }
        self.create_tab(session, None).await
    }

    /// Makes the session's first tab current, if it has one.
    fn adopt_next_tab(&self, session: &str) -> Option<i64> {
        let mut st = self.st();
        let tab = st.session_tabs(session).into_iter().next()?;
        let entry = st.sessions.get_mut(session)?;
        entry.current = Some(tab);
        entry.lost = None;
        Some(tab)
    }

    /// Makes a tab the user lent the session's current tab.
    pub fn adopt(self: &Arc<Self>, session: &str, tab: Option<i64>, url_contains: Option<&str>) -> anyhow::Result<TabInfo> {
        let (tab, released) = {
            let mut st = self.st();
            let browser_key = st.sessions.get(session).context("Session not found")?.browser.as_ref().and_then(|b| b.key.clone());
            let lent: Vec<i64> = {
                let mut lent: Vec<&crate::relay::Tab> = st
                    .tabs
                    .values()
                    .filter(|t| t.owner == Owner::User && t.session.as_deref().is_none_or(|s| s == session))
                    .filter(|t| browser_key.as_deref().is_none_or(|k| k == t.link_key))
                    .collect();
                lent.sort_by_key(|t| t.id);
                lent.into_iter().filter(|t| url_contains.is_none_or(|text| t.url.contains(text))).map(|t| t.id).collect()
            };
            let tab = match tab {
                Some(tab) => {
                    let entry = st.tabs.get(&tab).with_context(|| format!("Tab {tab} is not available to agents. Ask the user to click the browse toolbar button on that tab."))?;
                    if entry.owner != Owner::User {
                        bail!("Tab {tab} is an agent's tab, not one the user lent.");
                    }
                    if let Some(owner) = entry.session.as_deref().filter(|s| *s != session) {
                        bail!("Tab {tab} is adopted by session {owner}.");
                    }
                    if browser_key.as_deref().is_some_and(|k| k != entry.link_key) {
                        bail!("Tab {tab} belongs to another browser. Start a new session for that browser.");
                    }
                    tab
                }
                None => match lent.as_slice() {
                    [only] => *only,
                    [] => bail!("No tab is lent to browse{}. Ask the user to click the browse toolbar button on the tab they want you to use.", url_contains.map(|u| format!(" with a URL containing {u:?}")).unwrap_or_default()),
                    several => bail!("Several lent tabs match ({}); pass tabId or url.", several.iter().map(|t| t.to_string()).collect::<Vec<_>>().join(", ")),
                },
            };
            let link_key = st.tabs[&tab].link_key.clone();
            let target_id = st.tabs[&tab].target_id.clone();
            let link_id = st.link(&link_key).map(|l| l.id.clone()).unwrap_or_default();
            let entry = st.sessions.get_mut(session).context("Session not found")?;
            let previous = entry.target.as_ref().filter(|t| t.owner == "user" && t.id != target_id).map(|t| t.id.clone());
            entry.target = Some(PersistedTarget { id: target_id.clone(), owner: "user".into() });
            entry.current = Some(tab);
            entry.lost = None;
            entry.held.retain(|id| id != &target_id);
            if entry.browser.as_ref().and_then(|b| b.key.as_ref()).is_none() {
                entry.browser = Some(BrowserRef { id: link_id, key: Some(link_key) });
            }
            entry.touch();
            let released = previous.and_then(|previous| {
                let tab = st.tabs.values_mut().find(|t| t.target_id == previous && t.session.as_deref() == Some(session))?;
                tab.session = None;
                Some(tab.id)
            });
            st.tabs.get_mut(&tab).expect("checked").session = Some(session.to_string());
            (tab, released)
        };
        self.schedule_persist();
        if let Some(released) = released {
            self.refresh_presentation(released, false);
        }
        self.refresh_presentation(tab, false);
        rlog!("session.adopted", session = session, tabId = tab);
        let st = self.st();
        self.tab_info(&st, tab, session).context("The tab went away")
    }

    /// Closes a session's agent tabs and gives back the ones the user lent; with `delete` the session goes too.
    pub async fn end_session(self: &Arc<Self>, id: &str, delete: bool) -> anyhow::Result<bool> {
        if !self.st().sessions.contains_key(id) {
            return Ok(false);
        }
        self.stop_calls(id, &format!("Session {id} was {} while this ran.", if delete { "deleted" } else { "reset" }));
        self.finish_handoff(id, "cancelled");
        self.release_focus(id, true);
        let (agent, lent): (Vec<i64>, Vec<i64>) = {
            let st = self.st();
            let tabs: Vec<&crate::relay::Tab> = st.tabs.values().filter(|t| t.session.as_deref() == Some(id)).collect();
            (tabs.iter().filter(|t| t.owner == Owner::Relay).map(|t| t.id).collect(), tabs.iter().filter(|t| t.owner == Owner::User).map(|t| t.id).collect())
        };
        for tab in agent {
            if let Err(error) = self.close_or_release(tab).await {
                rlog!("session.close_tab_failed", session = id, tabId = tab, error = error.to_string());
                self.remove_tab(tab, Release { update_extension: true, gone: true, ..Release::default() }, "session-ended");
            }
        }
        for tab in lent.iter().copied() {
            if let Some(entry) = self.st().tabs.get_mut(&tab) {
                entry.session = None;
            }
            self.refresh_presentation(tab, false);
        }
        {
            let mut st = self.st();
            let Some(session) = st.sessions.remove(id) else { return Ok(false) };
            let browser = session.browser.as_ref().and_then(|b| b.key.clone()).unwrap_or_default();
            let live: Vec<String> = st.tabs.values().map(|t| t.target_id.clone()).collect();
            for target in session.held.iter().filter(|t| !live.contains(t)) {
                st.tombstones.insert(target.clone(), browser.clone());
            }
            if delete {
                st.callers.retain(|_, current| current != id);
            } else {
                let mut fresh = Session::new(id.to_string());
                fresh.created_at = session.created_at.clone();
                fresh.read_only = session.read_only;
                fresh.allowed_origins = session.allowed_origins.clone();
                fresh.keep_visible = session.keep_visible;
                fresh.browser = session.browser.clone();
                fresh.client_pid = session.client_pid;
                st.sessions.insert(id.to_string(), fresh);
            }
        }
        if delete {
            let mut locks = self.tab_locks.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            if locks.get(id).is_some_and(|lock| Arc::strong_count(lock) == 1) {
                locks.remove(id);
            }
        }
        rlog!(if delete { "session.deleted" } else { "session.reset" }, session = id);
        self.schedule_persist();
        Ok(true)
    }

    pub fn set_allowlist(&self, id: &str, origins: &[String]) -> anyhow::Result<Vec<String>> {
        let normalized = crate::domain::normalize_origin_patterns(origins).map_err(|e| anyhow!(e))?;
        let mut st = self.st();
        let session = st.sessions.get_mut(id).with_context(|| format!("Session not found: {id}"))?;
        session.allowed_origins = (!normalized.is_empty()).then(|| normalized.clone());
        session.touch();
        drop(st);
        self.schedule_persist();
        Ok(normalized)
    }

    pub fn session_summary(&self, id: &str) -> Option<Value> {
        let st = self.st();
        let session = st.sessions.get(id)?;
        let tabs: Vec<Value> = st
            .session_tabs(id)
            .into_iter()
            .filter_map(|tab| st.tabs.get(&tab).map(|t| json!({ "tabId": tab, "url": t.url, "title": t.title, "owner": t.owner.name() })))
            .collect();
        let handoff = st.handoffs.get(id).map(|h| json!({ "message": h.message, "tabId": h.tab, "startedAt": h.started_at }));
        Some(crate::sessions::summary(session, Value::Array(tabs), handoff))
    }

    pub fn session_summaries(&self) -> Vec<Value> {
        let ids: Vec<String> = self.st().sessions.keys().cloned().collect();
        ids.iter().filter_map(|id| self.session_summary(id)).collect()
    }

    pub fn tab_summaries(&self) -> Vec<Value> {
        let st = self.st();
        let mut tabs: Vec<&crate::relay::Tab> = st.tabs.values().collect();
        tabs.sort_by_key(|t| t.id);
        tabs.iter()
            .map(|t| {
                let browser = st.link(&t.link_key).map(|l| l.id.clone());
                let mut value = json!({ "tabId": t.id, "targetId": t.target_id, "url": t.url, "title": t.title, "owner": t.owner.name(), "session": t.session, "browser": browser });
                if t.crashed {
                    value["crashed"] = true.into();
                }
                value
            })
            .collect()
    }

    pub fn extension_status(&self) -> Value {
        let st = self.st();
        let default = st.default_link();
        let now = Instant::now();
        let refused = st.handshake.last_refused.is_some_and(|at| now - at < Duration::from_secs(65));
        let unpaired = st.handshake.last_unpaired.is_some_and(|at| now - at < crate::handshake::UNPAIRED_PRESENCE_TTL);
        let mismatch = if default.is_none() { st.handshake.mismatch.clone() } else { None };
        let paired_before = !crate::pairing::read_browser_pairings(&self.paths).is_empty();
        let state = if st.connected() {
            "connected"
        } else if mismatch.is_some() {
            "incompatible"
        } else if refused {
            "refused"
        } else if unpaired {
            "unpaired"
        } else if paired_before {
            "paired-offline"
        } else {
            "not-seen"
        };
        let next = match state {
            "connected" => None,
            _ if default.as_ref().is_some_and(|l| l.unresponsive()) => Some(protocol::BROWSER_UNRESPONSIVE.to_string()),
            "incompatible" => {
                let (version, origin) = mismatch.clone().unwrap_or_default();
                let distribution = match origin.as_deref() {
                    Some(o) if o == protocol::stable_unpacked_origin() => Some("unpacked"),
                    Some(o) if o == format!("chrome-extension://{}", protocol::store_id()) => Some("store"),
                    _ => None,
                };
                Some(protocol::advice(version, distribution))
            }
            "refused" | "unpaired" => Some(format!(
                "{}. Run `browse install` again: it pairs the browser when it can open it, or prints a code to enter in browse's Options (`browse pair` prints one too).",
                if state == "refused" { "browse refused the pairing attempt" } else { "browse is installed but not paired" }
            )),
            "paired-offline" => Some("Open the browser profile already paired with browse and enable the extension; it reconnects automatically.".into()),
            _ => Some(format!(
                "No browser has contacted this relay yet. If browse is installed, open that browser and run `browse install` to pair it. Otherwise add browse from https://chromewebstore.google.com/detail/{}.",
                protocol::store_id()
            )),
        };
        let browsers: Vec<Value> = st
            .links
            .iter()
            .map(|link| {
                let mut value = json!({
                    "id": link.id,
                    "name": link.name,
                    "default": default.as_ref().is_some_and(|d| Arc::ptr_eq(d, link)),
                    "connected": link.connected(),
                    "version": link.version,
                    "tabs": st.tabs.values().filter(|t| t.link_key == link.key).count(),
                });
                if link.unresponsive() {
                    value["unresponsive"] = true.into();
                }
                value
            })
            .collect();
        let mut status = json!({
            "connected": st.connected(),
            "pairingState": state,
            "version": default.as_ref().and_then(|l| l.version.clone()),
            "build": default.as_ref().and_then(|l| l.build.clone()),
            "origin": default.as_ref().and_then(|l| l.origin.clone()).or(mismatch.as_ref().and_then(|m| m.1.clone())),
            "protocolVersion": default.as_ref().and_then(|l| l.protocol.version).or(mismatch.as_ref().and_then(|m| m.0)),
            "protocolCompatible": default.as_ref().map(|l| l.protocol.compatible).or(mismatch.as_ref().map(|_| false)),
            "protocolLegacy": default.as_ref().map(|l| l.protocol.legacy),
            "browsers": browsers,
            "pairingFailures": st.handshake.pairing_failures,
            "activeTargets": st.tabs.len(),
        });
        if let Some(next) = next {
            status["nextStep"] = next.into();
        }
        status
    }
}

/// The relay as `browse_core::Browser`, handed to every tool.
#[derive(Clone)]
pub struct RelayBrowser(pub Arc<Relay>);

#[async_trait]
impl Browser for RelayBrowser {
    async fn tabs(&self, session: &SessionId) -> anyhow::Result<Vec<TabInfo>> {
        let relay = &self.0;
        let tabs = relay.st().session_tabs(session);
        for tab in &tabs {
            if let Ok(result) = relay.debugger(*tab, None, "Target.getTargetInfo", json!({}), Some(Duration::from_secs(3))).await
                && let Some(entry) = relay.st().tabs.get_mut(tab) {
                    if let Some(url) = result["targetInfo"]["url"].as_str() {
                        entry.url = url.to_string();
                    }
                    if let Some(title) = result["targetInfo"]["title"].as_str() {
                        entry.title = title.to_string();
                    }
                }
        }
        let st = relay.st();
        Ok(tabs.into_iter().filter_map(|tab| relay.tab_info(&st, tab, session)).collect())
    }

    async fn current_tab(&self, session: &SessionId) -> anyhow::Result<TabInfo> {
        let tab = self.0.current_or_open(session).await?;
        let st = self.0.st();
        self.0.tab_info(&st, tab, session).context("The tab went away")
    }

    async fn open_tab(&self, session: &SessionId, url: Option<&str>) -> anyhow::Result<TabInfo> {
        self.0.ensure_session(session)?;
        let lock = self.0.tab_lock(session);
        let opening = lock.lock().await;
        let tab = self.0.create_tab(session, url).await;
        drop(opening);
        let tab = tab?;
        let st = self.0.st();
        self.0.tab_info(&st, tab, session).context("The tab went away")
    }

    async fn select_tab(&self, session: &SessionId, tab: TabId) -> anyhow::Result<()> {
        self.0.ensure_session(session)?;
        self.0.visible_tab(session, tab)?;
        if let Some(entry) = self.0.st().sessions.get_mut(session) {
            entry.current = Some(tab);
            entry.lost = None;
        }
        Ok(())
    }

    async fn close_tab(&self, session: &SessionId, tab: TabId) -> anyhow::Result<()> {
        self.0.visible_tab(session, tab)?;
        self.0.close_or_release(tab).await?;
        Ok(())
    }

    async fn cdp(&self, session: &SessionId, tab: TabId) -> anyhow::Result<Arc<dyn Cdp>> {
        self.0.ensure_session(session)?;
        self.0.visible_tab(session, tab)?;
        let mut st = self.0.st();
        let entry = st.tabs.get_mut(&tab).context("The tab went away")?;
        if let Some((owner, cdp)) = &entry.cdp
            && owner == session {
                return Ok(cdp.clone());
            }
        let cdp = Arc::new(crate::cdp::TabCdp { relay: self.0.clone(), tab, session: session.clone(), events: entry.events.downgrade() });
        entry.cdp = Some((session.clone(), cdp.clone()));
        Ok(cdp)
    }

    async fn handoff(&self, session: &SessionId, tab: TabId, message: &str) -> anyhow::Result<HandoffResult> {
        self.0.visible_tab(session, tab)?;
        self.0.run_handoff(session, tab, message, crate::presentation::DEFAULT_HANDOFF_TIMEOUT).await
    }

    fn set_busy(&self, session: &SessionId, key: &str, busy: bool) {
        let changed = {
            let mut st = self.0.st();
            st.last_activity = Instant::now();
            let Some(entry) = st.sessions.get_mut(session) else { return };
            let was = entry.busy();
            if busy {
                entry.busy_keys.insert(key.to_string());
            } else {
                entry.busy_keys.remove(key);
            }
            entry.last_used = Instant::now();
            was != entry.busy()
        };
        if changed {
            self.0.refresh_session_presentation(session);
        }
    }

    async fn human_input(&self, _session: &SessionId, tab: TabId) -> bool {
        let link = self.0.st().browser_tab(tab).map(|(link, _)| link);
        match link {
            Some(link) => self.0.human_input_for_link(&link),
            None => crate::settings::human_input_override().unwrap_or(true),
        }
    }
}
