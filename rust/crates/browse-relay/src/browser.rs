//! Agent tabs as tools see them: `browse_core::Browser` for the relay, and what a call may do with a tab id.

use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context, anyhow, bail};
use async_trait::async_trait;
use browse_cdp::Cdp;
use browse_core::{Browser, GuardedTabDriver, HandoffResult, TabDriver, TabId, TabInfo, TabOptions, TabPolicy, TabState};
use serde_json::{Value, json};

use crate::link::Link;
use crate::protocol;
use crate::relay::{DIRECT_TAB_BASE, DriverEntry, Owner, Relay, State};

/// The browser a new tab opens in: an extension link, or a directly driven browser.
#[derive(Clone)]
pub enum BrowserRef {
    Extension(Arc<Link>),
    Direct(Arc<DriverEntry>),
}

/// A tab idle cleanup may close (`Relay::idle_candidates`).
#[derive(Debug, Clone)]
pub struct IdleCandidate {
    pub tab: i64,
    pub owner: Owner,
    pub link_key: String,
    pub idle: Duration,
}

/// How long a call waits for a browser that is reconnecting (a worker or relay restart) before failing.
const RECONNECT_WAIT: Duration = Duration::from_secs(12);
/// How long a just-started relay waits for the paired browser to dial back after a restart. A suspended service worker
/// wakes on the extension's reconnect alarm, every 30 s (`extensionReconnectAlarmPeriodMs`, src/agent-relay/protocol.ts),
/// so this covers one alarm plus margin.
const COLD_START_WAIT: Duration = Duration::from_secs(35);
/// A browser that connected this recently is expected back after a relay or worker restart.
const RECENT_CONNECTION: Duration = Duration::from_secs(120);
/// How long a call waits when no browser was ever paired: opening one is the user's move, not a reconnect.
const FIRST_CONNECTION_WAIT: Duration = Duration::from_millis(1500);
/// How long a call naming a tab waits for it to come back with a reconnecting browser.
const TAB_WAIT: Duration = Duration::from_secs(10);

impl Relay {
    /// How long ago this relay started. Tests add an offset here instead of sleeping through the cold-start window.
    fn age(&self) -> Duration {
        #[cfg(test)]
        let extra = Duration::from_millis(self.started_ago.load(std::sync::atomic::Ordering::SeqCst));
        #[cfg(not(test))]
        let extra = Duration::ZERO;
        self.started.elapsed() + extra
    }

    /// Test-only: make this relay look `age` old, for the windows around a restart.
    #[cfg(test)]
    pub fn set_age_for_test(&self, age: Duration) {
        self.started_ago.store(age.as_millis() as u64, std::sync::atomic::Ordering::SeqCst);
    }

    /// The rest of the cold-start window, never shorter than the first-connection wait.
    fn cold_start_wait(&self) -> Duration {
        COLD_START_WAIT.saturating_sub(self.age()).max(FIRST_CONNECTION_WAIT)
    }

    pub fn tab_info(&self, st: &State, tab: i64) -> Option<TabInfo> {
        let entry = st.tabs.get(&tab)?;
        let mut options = entry.options.clone();
        options.browser = st.browser_id_of(entry);
        Some(TabInfo {
            tab,
            url: entry.url.clone(),
            title: entry.title.clone(),
            lent: entry.owner == Owner::User,
            chosen: entry.chosen.clone(),
            opener: entry.opener,
            last_used: Some(entry.last_used_at.clone()),
            busy: st.tab_busy(tab),
            handoff: st.handoff_for_tab(tab).map(crate::relay::Handoff::info),
            options,
        })
    }

    /// Every tab agents can use (the agent-opened ones and the lent ones), by id.
    pub fn tab_infos(&self) -> Vec<TabInfo> {
        let st = self.st();
        let mut ids: Vec<i64> = st.tabs.values().filter(|t| !t.closing).map(|t| t.id).collect();
        ids.sort();
        ids.into_iter().filter_map(|tab| self.tab_info(&st, tab)).collect()
    }

    /// A tab a call names that isn't attached yet comes back with a reconnecting browser's inventory (after a relay
    /// or worker restart): wait for that, briefly, instead of failing at once.
    pub async fn await_tab(&self, tab: i64) {
        // A direct tab never comes back with an extension's inventory.
        if tab >= DIRECT_TAB_BASE {
            return;
        }
        let reconnecting = {
            let st = self.st();
            if st.tabs.contains_key(&tab) {
                return;
            }
            let known = st.reconnect_owners.values().any(|k| k.tab == tab) || st.restorable.values().any(|r| r.tab == tab);
            let recent = self.started.elapsed() < Duration::from_secs(60) || st.last_connected.is_some_and(|at| at.elapsed() < Duration::from_secs(120));
            st.links.iter().any(|l| !l.is_ready() || l.inventory_pending()) || (st.links.is_empty() && (recent || known))
        };
        if reconnecting {
            self.wait_until(TAB_WAIT, |st| {
                st.tabs.contains_key(&tab) || (!st.links.is_empty() && st.links.iter().all(|l| l.is_ready() && !l.inventory_pending()))
            })
            .await;
        }
    }

    /// Whether calls can use the tab, or why not. A tab the user didn't lend is not attached at all, so it is not a
    /// browse tab here.
    pub fn usable_tab(&self, tab: i64) -> anyhow::Result<()> {
        let st = self.st();
        if st.tabs.get(&tab).is_some_and(|t| !t.closing) {
            return Ok(());
        }
        if st.tabs.contains_key(&tab) {
            bail!("Tab {tab} is closing.");
        }
        if let Some(gone) = st.gone_tab(tab) {
            bail!("Tab {tab} is gone ({}). Open another with navigate (without tab), or list the tabs you can use with tabs.", gone.why);
        }
        if st.reconnect_owners.values().any(|k| k.tab == tab) || st.restorable.values().any(|r| r.tab == tab) {
            bail!("Tab {tab} belongs to a browser that isn't connected right now. {}", self.not_connected_advice_for(&st));
        }
        bail!("Tab {tab} isn't a browse tab: browse didn't open it and the user didn't lend it. Open one with navigate (without tab), or list the tabs you can use with tabs.")
    }

    /// The running call uses the tab: the tab counts as busy until the call ends, and the call's warnings include the
    /// tab's.
    pub fn note_call_tab(self: &Arc<Self>, tab: i64) {
        let Ok(id) = crate::serve::CALL.try_with(|id| *id) else { return };
        let fresh = {
            let mut st = self.st();
            let was = st.tab_busy(tab);
            if let Some(entry) = st.tabs.get_mut(&tab) {
                entry.touch();
            }
            match st.calls.get_mut(&id) {
                Some(call) => call.tabs.insert(tab) && !was,
                None => false,
            }
        };
        if fresh {
            self.refresh_presentation(tab, false);
        }
    }

    /// Normalizes the options an agent opens a tab with: the allowlist parsed, the group label cleaned.
    pub fn normalize_options(options: &TabOptions) -> anyhow::Result<TabOptions> {
        let allowed_origins = match &options.allowed_origins {
            Some(origins) => Some(crate::domain::normalize_origin_patterns(origins).map_err(|e| anyhow!(e))?).filter(|o| !o.is_empty()),
            None => None,
        };
        let group = options.group.as_deref().and_then(crate::registry::clean_group);
        Ok(TabOptions { group, allowed_origins, read_only: options.read_only, keep_visible: options.keep_visible, keep_open: options.keep_open, browser: options.browser.clone(), new_window: options.new_window, window_of: options.window_of.clone() })
    }

    /// Turns the idle-close exemption on or off for a tab, and tells the extension, which runs its own idle cleanup.
    /// An extension that can't hold a tab yet gets a warning on the tab instead. Returns whether the option changed.
    pub fn set_keep_open(self: &Arc<Self>, tab: i64, keep_open: bool) -> bool {
        let changed = {
            let mut st = self.st();
            match st.tabs.get_mut(&tab) {
                Some(entry) if entry.options.keep_open != keep_open => {
                    entry.options.keep_open = keep_open;
                    true
                }
                _ => false,
            }
        };
        if changed {
            let link = self.st().browser_tab(tab).map(|(link, _)| link);
            match link {
                Some(link) if link.keeps_open() => {
                    self.ext_best_effort(tab, "tabs.keepOpen", json!({ "keepOpen": keep_open }));
                }
                Some(link) if keep_open => self.warn_keep_open_unavailable(tab, &link),
                _ => {}
            }
            self.schedule_persist();
        }
        changed
    }

    /// The browser to open a tab in, extension or direct. A named one: a connected extension link, else a connected
    /// direct driver, else the extension wait. Unnamed: the extension when it's connected or expected back (paired in
    /// the cold-start window, a link not ready yet, connected in the last two minutes), else the first direct driver.
    pub async fn target_for(self: &Arc<Self>, browser: Option<&str>) -> anyhow::Result<BrowserRef> {
        let nothing = !self.st().any_connected();
        if nothing {
            self.auto_attach_firefox().await;
        }
        if let Some(name) = browser.map(str::trim).filter(|n| !n.is_empty()) {
            {
                let st = self.st();
                if let Some(link) = st.link_by_name(name).filter(|l| l.connected()) {
                    return Ok(BrowserRef::Extension(link));
                }
                if let Some(entry) = st.driver_by_name(name).filter(|d| d.connected()) {
                    return Ok(BrowserRef::Direct(entry));
                }
                // A browser browse drove directly doesn't reconnect by itself: no point waiting for it.
                let wanted = name.to_lowercase();
                let direct = st.known.iter().any(|(key, k)| key.starts_with("driver:") && (k.id == wanted || k.name.to_lowercase() == wanted));
                if direct && st.link_by_name(name).is_none() {
                    bail!("Browser '{name}' isn't connected to browse right now. Ask the user to run `browse firefox` to connect it again, then retry.");
                }
            }
            return self.link_for(Some(name)).await.map(BrowserRef::Extension);
        }
        let direct = |st: &State| st.drivers.iter().find(|d| d.connected()).cloned();
        let wait = {
            let st = self.st();
            if let Some(link) = st.links.iter().find(|l| l.connected()) {
                return Ok(BrowserRef::Extension(link.clone()));
            }
            if direct(&st).is_none() {
                None
            } else {
                let paired = !crate::pairing::read_browser_pairings(&self.paths).is_empty();
                if paired && self.age() < COLD_START_WAIT {
                    Some(self.cold_start_wait())
                } else if !st.links.is_empty() || st.last_connected.is_some_and(|at| at.elapsed() < RECENT_CONNECTION) {
                    Some(RECONNECT_WAIT)
                } else {
                    Some(Duration::ZERO)
                }
            }
        };
        let Some(wait) = wait else { return self.link_for(None).await.map(BrowserRef::Extension) };
        if !wait.is_zero() {
            self.wait_until(wait, State::connected).await;
        }
        let st = self.st();
        if let Some(link) = st.links.iter().find(|l| l.connected()) {
            return Ok(BrowserRef::Extension(link.clone()));
        }
        direct(&st).map(BrowserRef::Direct).ok_or_else(|| anyhow!("No browser is connected. Open the browser with the browse extension."))
    }

    /// Says a keepOpen tab still closes when idle: the connected extension runs its own idle cleanup and can't hold
    /// one back.
    pub fn warn_keep_open_unavailable(&self, tab: i64, link: &Link) {
        let version = link.version.as_deref().map(|v| format!(" ({v})")).unwrap_or_default();
        let warning = format!("The connected browse extension{version} can't keep tabs open yet, so this tab still closes when idle. Update the extension to 0.1.2 or newer to keep it open.");
        if let Some(entry) = self.st().tabs.get_mut(&tab) {
            entry.add_warning(warning);
        }
    }

    /// The browser to open a tab in: the one named (waiting briefly while it reconnects), else the first connected.
    pub async fn link_for(self: &Arc<Self>, browser: Option<&str>) -> anyhow::Result<Arc<Link>> {
        if let Some(name) = browser.map(str::trim).filter(|n| !n.is_empty()) {
            // A connected browser is answered without reading the token file.
            if let Some(link) = self.st().link_by_name(name).filter(|l| l.connected()) {
                return Ok(link);
            }
            // Only a browser browse knows (installed, or paired before) can be reconnecting; any other name fails at once.
            let pairings = crate::pairing::read_browser_pairings(&self.paths);
            let wanted = name.to_lowercase();
            let paired = pairings.values().any(|p| {
                p.id.as_deref().is_some_and(|id| id.to_lowercase() == wanted) || p.name.as_deref().is_some_and(|n| n.to_lowercase() == wanted)
            });
            let known = paired
                || {
                    let st = self.st();
                    st.known.values().any(|k| k.id == wanted || k.name.to_lowercase() == wanted)
                };
            let wait = if paired && self.age() < COLD_START_WAIT { self.cold_start_wait() } else { RECONNECT_WAIT };
            let found = known && self.wait_until(wait, |st| st.link_by_name(name).is_some_and(|l| l.connected())).await;

            let st = self.st();
            return match st.link_by_name(name) {
                Some(link) if found => Ok(link),
                Some(link) if link.unresponsive() => bail!("Browser '{}': {}", link.id, protocol::BROWSER_UNRESPONSIVE),
                Some(link) => bail!("Browser '{}' isn't ready yet; try again in a moment.", link.id),
                None => {
                    let connected = st.links.iter().map(|l| format!("{} ({})", l.id, l.name)).collect::<Vec<_>>().join(", ");
                    bail!("No connected browser is called \"{name}\". {}", if connected.is_empty() { "No browser is connected.".to_string() } else { format!("Connected: {connected}.") })
                }
            };
        }
        let paired = !crate::pairing::read_browser_pairings(&self.paths).is_empty();
        let wait = {
            let st = self.st();
            if paired && !st.connected() && self.age() < COLD_START_WAIT {
                self.cold_start_wait()
            } else if !st.links.is_empty() || st.last_connected.is_some_and(|at| at.elapsed() < RECENT_CONNECTION) {
                RECONNECT_WAIT
            } else {
                FIRST_CONNECTION_WAIT
            }
        };
        self.wait_until(wait, State::connected).await;
        let link = self.st().links.iter().find(|l| l.connected()).cloned();
        link.ok_or_else(|| anyhow!("{}", self.not_connected_advice()))
    }

    pub fn not_connected_advice(&self) -> String {
        let status = self.extension_status();
        status["nextStep"].as_str().map(str::to_string).unwrap_or_else(|| "No browser is connected. Open the browser with the browse extension.".into())
    }

    fn not_connected_advice_for(&self, st: &State) -> String {
        if st.connected() { "Wait a moment for it to reconnect, then try again.".into() } else { "Ask the user to open that browser; browse picks the tab up again when it reconnects.".into() }
    }

    pub fn tab_summaries(&self) -> Vec<Value> {
        let st = self.st();
        let mut tabs: Vec<&crate::relay::Tab> = st.tabs.values().collect();
        tabs.sort_by_key(|t| t.id);
        tabs.iter()
            .map(|t| {
                let browser = st.browser_id_of(t);
                let mut value = json!({
                    "tab": t.id,
                    "targetId": t.target_id,
                    "url": t.url,
                    "title": t.title,
                    "owner": t.owner.name(),
                    "lent": t.owner == Owner::User,
                    "browser": browser,
                    "lastUsed": t.last_used_at,
                    "busy": st.tab_busy(t.id),
                });
                if let Some(chosen) = &t.chosen {
                    value["id"] = chosen.clone().into();
                }
                if let Some(group) = &t.options.group {
                    value["group"] = group.clone().into();
                }
                if t.crashed {
                    value["crashed"] = true.into();
                }
                if let Some(handoff) = st.handoff_for_tab(t.id) {
                    value["handoff"] = json!({ "message": handoff.message, "startedAt": handoff.started_at });
                }
                value
            })
            .collect()
    }

    /// Tabs idle cleanup may close: no call used them for `ttl`. A call, a handoff, a capture or a recording on a tab
    /// keeps it open, and so does `keepOpen`.
    pub fn idle_tabs(&self, ttl: Duration) -> Vec<(i64, Owner)> {
        self.idle_candidates().into_iter().filter(|c| c.idle >= ttl).map(|c| (c.tab, c.owner)).collect()
    }

    /// Every tab idle cleanup may close, with how long no call used it and its browser's link.
    pub fn idle_candidates(&self) -> Vec<IdleCandidate> {
        let st = self.st();
        st.tabs
            .values()
            .filter(|t| !t.options.keep_open && !t.closing && !t.focused && st.handoff_for_tab(t.id).is_none() && !st.tab_busy(t.id))
            .map(|t| IdleCandidate { tab: t.id, owner: t.owner, link_key: t.link_key.clone(), idle: t.last_used.elapsed() })
            .collect()
    }

    pub fn extension_status(&self) -> Value {
        // Firefox's part of `nextStep`, read from disk before the state lock is taken.
        let hint = if self.st().any_connected() {
            None
        } else {
            self.me().auto_attach_soon();
            let recorded = crate::firefox::read_recorded(&self.paths);
            let busy = self.firefox_busy.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone();
            let unpaired = crate::pairing::read_browser_pairings(&self.paths).is_empty();
            crate::firefox::next_step_hint(self.firefox.as_ref().filter(|_| unpaired), &recorded, &busy)
        };
        let st = self.st();
        let default = st.default_link();
        let now = Instant::now();
        let refused = st.handshake.last_refused.is_some_and(|at| now - at < Duration::from_secs(65));
        let unpaired = st.handshake.last_unpaired.is_some_and(|at| now - at < crate::handshake::UNPAIRED_PRESENCE_TTL);
        let mismatch = if default.is_none() { st.handshake.mismatch.clone() } else { None };
        let paired = !crate::pairing::read_browser_pairings(&self.paths).is_empty();
        let any = st.any_connected();
        let state = if st.connected() {
            "connected"
        } else if mismatch.is_some() {
            "incompatible"
        } else if refused {
            "refused"
        } else if unpaired {
            "unpaired"
        } else if paired {
            "paired-offline"
        } else {
            "not-seen"
        };
        let reconnecting = state == "paired-offline" && self.age() < COLD_START_WAIT;
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
            "paired-offline" if reconnecting => {
                Some("The paired browser is reconnecting; try again in a few seconds.".into())
            }
            "paired-offline" => Some("The paired browser isn't connected right now: open it (the profile with browse) and check that the extension is turned on. It reconnects by itself.".into()),
            _ => Some(format!(
                "No browser has connected to browse yet. Add the browse extension from https://chromewebstore.google.com/detail/{} (if it's already added, open that browser), then run `browse install` to pair it, or `browse pair` for a code to enter in the extension.",
                protocol::store_id()
            )),
        };
        let default_direct = if default.as_ref().is_some_and(|l| l.connected()) { None } else { st.drivers.iter().find(|d| d.connected()).cloned() };
        let mut browsers: Vec<Value> = st
            .links
            .iter()
            .map(|link| {
                let mut value = json!({
                    "id": link.id,
                    "name": link.name,
                    "driver": "cdp-extension",
                    "protocol": "cdp",
                    "transport": "extension",
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
        browsers.extend(st.drivers.iter().map(|entry| {
            json!({
                "id": entry.id,
                "name": entry.name,
                "driver": entry.protocol,
                "protocol": entry.protocol,
                "transport": entry.transport,
                "endpoint": entry.endpoint,
                "local": entry.local,
                "key": entry.key,
                "default": default_direct.as_ref().is_some_and(|d| Arc::ptr_eq(d, entry)),
                "connected": entry.connected(),
                "version": entry.version,
                "tabs": st.tabs.values().filter(|t| t.link_key == entry.key).count(),
            })
        }));
        let mut status = json!({
            // The extension's alone: `browse install` polls it to see the extension pair.
            "connected": st.connected(),
            "browserConnected": any,
            "pairingState": state,
            "version": default.as_ref().and_then(|l| l.version.clone()),
            "build": default.as_ref().and_then(|l| l.build.clone()),
            "origin": default.as_ref().and_then(|l| l.origin.clone()).or(mismatch.as_ref().and_then(|m| m.1.clone())),
            "protocolVersion": default.as_ref().and_then(|l| l.protocol.version).or(mismatch.as_ref().and_then(|m| m.0)),
            "protocolCompatible": default.as_ref().map(|l| l.protocol.compatible).or(mismatch.as_ref().map(|_| false)),
            "protocolLegacy": default.as_ref().map(|l| l.protocol.legacy),
            "reconnecting": reconnecting,
            "browsers": browsers,
            "pairingFailures": st.handshake.pairing_failures,
            "activeTargets": st.tabs.len(),
        });
        if let Some(next) = next.filter(|_| !any) {
            status["nextStep"] = format!("{next}{}", hint.unwrap_or_default()).into();
        }
        status
    }
}

/// The read-only flag the relay knows for a tab, whether it is attached, remembered for a reconnecting browser
/// (`reconnect_owners`), or held across a relay restart (`restorable`). None when nothing knows the tab.
pub(crate) fn tab_read_only(st: &crate::relay::State, tab: TabId) -> Option<bool> {
    st.tabs
        .get(&tab)
        .map(|entry| entry.options.read_only)
        .or_else(|| st.reconnect_owners.values().find(|known| known.tab == tab).map(|known| known.options.read_only))
        .or_else(|| st.restorable.values().find(|held| held.tab == tab).map(|held| held.options.read_only))
}

/// Semantic policy enforced at the `TabDriver` boundary for every protocol the relay hosts.
struct RelayTabPolicy {
    relay: Arc<Relay>,
    tab: TabId,
}

#[async_trait]
impl TabPolicy for RelayTabPolicy {
    fn is_read_only(&self) -> bool {
        tab_read_only(&self.relay.st(), self.tab).unwrap_or(false)
    }

    async fn check_navigation(&self, url: &str) -> Result<(), String> {
        let st = self.relay.st();
        let allowed = st
            .tabs
            .get(&self.tab)
            .and_then(|t| t.options.allowed_origins.as_deref());
        if let Some(allowed) = allowed
            && let Ok(rules) = crate::domain::parse_origin_patterns(allowed)
            && !crate::domain::check_url(url, &rules, false).allowed()
        {
            return Err(format!(
                "browse blocked navigation to {url}: not in allowedOrigins ({})",
                allowed.join(", ")
            ));
        }
        Ok(())
    }
}

/// The relay as `browse_core::Browser`, handed to every tool.
#[derive(Clone)]
pub struct RelayBrowser(pub Arc<Relay>);

impl RelayBrowser {
    /// Raw CDP handle for a tab (used by relay-internal CDP guardrail tests and `tab_driver`).
    pub async fn cdp(&self, tab: TabId) -> anyhow::Result<Arc<dyn Cdp>> {
        self.0.await_tab(tab).await;
        self.0.usable_tab(tab)?;
        if self.0.is_direct_tab(tab) {
            bail!("Tab {tab} is not a CDP extension tab");
        }
        self.0.note_call_tab(tab);
        let mut st = self.0.st();
        let entry = st.tabs.get_mut(&tab).context("The tab went away")?;
        if let Some(cdp) = &entry.cdp {
            return Ok(cdp.clone());
        }
        let cdp = Arc::new(crate::cdp::TabCdp { relay: self.0.clone(), tab, events: entry.events.downgrade() });
        entry.cdp = Some(cdp.clone());
        Ok(cdp)
    }
}

#[async_trait]
impl Browser for RelayBrowser {
    async fn open_tab(&self, url: Option<&str>, options: &TabOptions) -> anyhow::Result<TabInfo> {
        let tab = self.0.create_tab(url, options, None, None).await?;
        self.0.note_call_tab(tab);
        let st = self.0.st();
        self.0.tab_info(&st, tab).context("The tab went away")
    }

    async fn tabs(&self) -> anyhow::Result<Vec<TabInfo>> {
        Ok(self.0.tab_infos())
    }

    /// Through the tab's guarded CDP connection: Page.bringToFront is refused for a read-only tab and
    /// unless OPENCODE_BROWSER_ALLOW_FOREGROUND=1 (guardrails.rs), so nothing reaches Chrome otherwise.
    async fn bring_to_front(&self, tab: TabId) -> anyhow::Result<()> {
        let cdp = self.cdp(tab).await?;
        cdp.send("Page.bringToFront", json!({}), None).await.map(|_| ()).map_err(|error| anyhow!("{error}"))
    }

    async fn close_tab(&self, tab: TabId) -> anyhow::Result<()> {
        self.0.await_tab(tab).await;
        self.0.usable_tab(tab)?;
        self.0.close_or_release(tab).await?;
        Ok(())
    }

    async fn tab_driver(&self, tab: TabId) -> anyhow::Result<Arc<dyn TabDriver>> {
        self.0.await_tab(tab).await;
        self.0.usable_tab(tab)?;
        self.0.note_call_tab(tab);
        let mut st = self.0.st();
        let entry = st.tabs.get_mut(&tab).context("The tab went away")?;
        if let Some(driver) = &entry.driver {
            return Ok(driver.clone());
        }
        if entry.backend.is_direct() {
            bail!("Tab {tab} lost its browser driver");
        }
        let cdp = match &entry.cdp {
            Some(cdp) => cdp.clone(),
            None => {
                let cdp = Arc::new(crate::cdp::TabCdp { relay: self.0.clone(), tab, events: entry.events.downgrade() });
                entry.cdp = Some(cdp.clone());
                cdp
            }
        };
        let raw: Arc<dyn TabDriver> = browse_cdp::CdpTabDriver::new(cdp);
        let policy = Arc::new(RelayTabPolicy { relay: self.0.clone(), tab });
        let driver: Arc<dyn TabDriver> = GuardedTabDriver::new(raw, policy);
        entry.driver = Some(driver.clone());
        Ok(driver)
    }

    async fn state(&self, tab: TabId) -> anyhow::Result<Arc<TabState>> {
        self.0.await_tab(tab).await;
        {
            let st = self.0.st();
            if let Some(entry) = st.tabs.get(&tab) {
                return Ok(entry.state.clone());
            }
            if let Some(known) = st.reconnect_owners.values().find(|k| k.tab == tab) {
                return Ok(known.state.clone());
            }
            if let Some(gone) = st.gone_tab(tab) {
                return Ok(gone.state.clone());
            }
        }
        self.0.usable_tab(tab)?;
        bail!("Tab {tab} went away")
    }

    async fn handoff(&self, tab: TabId, message: &str) -> anyhow::Result<HandoffResult> {
        self.0.await_tab(tab).await;
        self.0.usable_tab(tab)?;
        self.0.note_call_tab(tab);
        self.0.run_handoff(tab, message, crate::presentation::DEFAULT_HANDOFF_TIMEOUT).await
    }

    fn set_busy(&self, tab: TabId, key: &str, busy: bool) {
        let changed = {
            let mut st = self.0.st();
            st.last_activity = Instant::now();
            let was = st.tab_busy(tab);
            let Some(entry) = st.tabs.get_mut(&tab) else { return };
            if busy {
                entry.busy_keys.insert(key.to_string());
            } else {
                entry.busy_keys.remove(key);
            }
            entry.touch();
            was != st.tab_busy(tab)
        };
        if changed {
            self.0.refresh_presentation(tab, false);
        }
    }

    async fn human_input(&self, tab: TabId) -> bool {
        let link = self.0.st().browser_tab(tab).map(|(link, _)| link);
        match link {
            Some(link) => self.0.human_input_for_link(&link),
            None => crate::settings::human_input_override().unwrap_or(true),
        }
    }

    async fn connected_locally(&self, tab: TabId) -> bool {
        let st = self.0.st();
        if let Some(entry) = st.tabs.get(&tab).and_then(|t| t.backend.direct()) {
            return entry.local;
        }
        st.browser_tab(tab).map(|(link, _)| link.local).unwrap_or(false)
    }

    async fn read_only(&self, tab: TabId) -> bool {
        if tab_read_only(&self.0.st(), tab) == Some(true) {
            return true;
        }
        if !self.0.st().tabs.contains_key(&tab) {
            self.0.await_tab(tab).await;
        }
        tab_read_only(&self.0.st(), tab).unwrap_or(false)
    }

    /// A numeric tab id, or a caller-chosen id like `work-mail`.
    fn resolve_tab(&self, value: &Value) -> anyhow::Result<TabId> {
        match browse_core::tab_argument(value)? {
            browse_core::TabArg::Id(tab) => Ok(tab),
            browse_core::TabArg::Chosen(chosen) => self.0.resolve_chosen_tab(&chosen),
        }
    }
}

impl Relay {
    /// The tab a caller-chosen id like `work-mail` stands for, or why it can't be used.
    pub fn resolve_chosen_tab(&self, chosen: &str) -> anyhow::Result<TabId> {
        if !browse_core::valid_chosen_id(chosen) {
            bail!("tab must be a numeric tab id (from navigate or tabs) or a chosen id like `work-mail` (lowercase letters, digits and dashes, starting with a letter), not {chosen:?}");
        }
        let st = self.st();
        if let Some(tab) = st.tab_by_chosen(chosen) {
            return Ok(tab);
        }
        if st.away_tab_by_chosen(chosen).is_some() {
            bail!("`{chosen}` is in a browser that isn't connected right now. Open that browser and try again; browse gives the tab back when it reconnects.");
        }
        bail!("No tab has the id `{chosen}`. Open it with tabs {{ action: \"new\", id: \"{chosen}\", url }}; tabs lists the tabs you can use.")
    }
}
