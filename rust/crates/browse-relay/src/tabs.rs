//! Attached tabs: attaching one (an agent's new tab, a tab the user lends with the toolbar button, a reconnecting
//! browser's inventory), routing its debugger events, and letting it go (cli/src/cdp/root-target-lifecycle.ts,
//! cli/src/relay/extension-events.ts).

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context, anyhow, bail};
use browse_cdp::CdpEvent;
use browse_core::{TabOptions, TabState};
use serde_json::{Value, json};
use tokio::sync::broadcast;

use crate::domain;
use crate::guardrails::is_restricted_url;
use crate::link::{Link, RpcError};
use crate::protocol::{CAPABILITY_TAB_RELEASE, CAPABILITY_TAB_WINDOWS};

/// Why newWindow and windowOf don't work in a directly driven browser.
const DIRECT_WINDOWS: &str = "newWindow and windowOf work in browsers browse reaches through its extension, not in a directly driven one (Firefox); open the tab without them.";
use crate::relay::{KnownOwner, Owner, Relay, Tab};
use crate::rlog;
use crate::util::short_url;

const ATTACH_TIMEOUT: Duration = Duration::from_secs(10);
const INVENTORY_TIMEOUT: Duration = Duration::from_secs(5);
/// Events a slow subscriber may fall behind by before it skips ahead (RecvError::Lagged). Each holds its CDP params
/// (a screencast frame is a few hundred KB), so this bounds what one stalled reader keeps alive.
const EVENT_BUFFER: usize = 256;
/// How long a reconnecting browser's announced tabs may take before it counts as connected anyway.
const INVENTORY_GRACE: Duration = Duration::from_millis(1500);

#[derive(Clone)]
pub struct Attach {
    pub tab: i64,
    pub owner: Owner,
    pub options: TabOptions,
    pub opener: Option<i64>,
    /// What tools kept for the tab, when it is attached again (a reconnect).
    pub state: Option<Arc<TabState>>,
    pub created_at: Option<String>,
    /// The caller-chosen id the tab is being opened with.
    pub chosen: Option<String>,
    /// Who owned the tab before, found by its target id (a reconnect or a relay restart).
    pub restored: Option<Restored>,
    pub already_attached: bool,
    /// An inventory tab the extension says an agent opened: it may be reclaimed from the tab registry.
    pub reclaim_held: bool,
    /// Look up who owned the tab before (a reconnect, a relay restart). A user's lend restores nothing.
    pub restore: bool,
    /// A tab that was already an agent tab (a reconnect, a renewed debugger, a relay reclaiming it): the agent was
    /// already told about its keepOpen, so attaching it again must not warn about it.
    pub reattached: bool,
    /// Register the tab fresh (an opened popup): a disallowed first document closes it rather than blanking it.
    pub fresh_popup: bool,
    /// Only this page: a tab id that now shows another page (the browser restarted) is let go again.
    pub expect_target: Option<String>,
    pub timeout: Duration,
}

impl Attach {
    pub fn new(tab: i64, owner: Owner) -> Self {
        Self {
            tab,
            owner,
            options: TabOptions::default(),
            opener: None,
            state: None,
            created_at: None,
            chosen: None,
            restored: None,
            already_attached: false,
            reclaim_held: false,
            restore: false,
            reattached: false,
            fresh_popup: false,
            expect_target: None,
            timeout: ATTACH_TIMEOUT,
        }
    }

    /// The same tab again, as it is now (a renewed or lost debugger).
    fn again(tab: &Tab) -> Self {
        let mut attach = Self::new(tab.id, tab.owner);
        attach.options = tab.options.clone();
        attach.opener = tab.opener;
        attach.state = Some(tab.state.clone());
        attach.created_at = Some(tab.created_at.clone());
        attach.chosen = tab.chosen.clone();
        attach.fresh_popup = tab.fresh_popup;
        attach.reattached = true;
        attach
    }
}

/// Who owned a tab before it was announced again.
#[derive(Clone)]
pub struct Restored {
    owner: Owner,
    options: TabOptions,
    opener: Option<i64>,
    state: Option<Arc<TabState>>,
    created_at: String,
    chosen: Option<String>,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct Release {
    pub update_extension: bool,
    pub released_by_user: bool,
    /// The tab is gone for good (closed, or its page replaced): the registry forgets it.
    pub gone: bool,
}

fn target_info(result: &Value) -> Option<(String, String, String, String)> {
    let info = result.get("targetInfo")?;
    Some((
        info.get("targetId")?.as_str()?.to_string(),
        info.get("type")?.as_str()?.to_string(),
        info.get("url").and_then(Value::as_str).unwrap_or("").to_string(),
        info.get("title").and_then(Value::as_str).unwrap_or("").to_string(),
    ))
}

/// A URL that is a real document: not empty (nothing navigated yet) and not an about: page.
pub(crate) fn real_url(url: &str) -> bool {
    !url.is_empty() && !url.starts_with("about:")
}

/// A browser's tabs to ask about: (relay id, the browser's own id).
type LinkTabs = (Arc<Link>, Vec<(i64, i64)>);

/// Where `tabs.create` puts a new tab, by precedence: a new window of its own (`newWindow`), the window of a tab the
/// agent named (`beside`), else beside its label's tabs (`follow`), wherever the user moved them. The relay's window
/// override (OPENCODE_BROWSER_AGENT_WINDOW) fixes placement, so it turns `follow` off. Without any of these the
/// extension's window setting (or the override) decides.
fn place(params: &mut Value, new_window: bool, beside: Option<i64>, follow: Vec<i64>, override_window: Option<&str>) {
    if new_window {
        params["newWindow"] = true.into();
    } else if let Some(local) = beside {
        params["beside"] = local.into();
    } else if override_window.is_none() && !follow.is_empty() {
        params["follow"] = follow.into();
    }
    if let Some(window) = override_window {
        params["window"] = window.into();
    }
}

impl Relay {
    /// Attaches the debugger (unless it already is), sets the tab up and publishes it.
    pub async fn setup_tab(self: &Arc<Self>, attach: Attach) -> anyhow::Result<i64> {
        let tab = attach.tab;
        let link = self.st().browser_tab(tab).map(|(link, _)| link).ok_or_else(|| anyhow!(crate::protocol::NOT_CONNECTED))?;
        let limit = Some(attach.timeout);
        if !attach.already_attached {
            self.ext_tab(tab, "debugger.attach", json!({})).await?;
        }
        self.debugger(tab, None, "Page.enable", json!({}), limit).await?;
        if let Err(RpcError::Timeout(message)) = self.debugger(tab, None, "Emulation.setFocusEmulationEnabled", json!({ "enabled": false }), limit).await {
            bail!(message);
        }
        let info = self.debugger(tab, None, "Target.getTargetInfo", json!({}), limit).await?;
        let (target_id, _, url, title) = target_info(&info).context("Target.getTargetInfo did not return targetInfo")?;
        if attach.expect_target.as_ref().is_some_and(|expected| *expected != target_id) {
            if !attach.already_attached {
                self.ext_best_effort(tab, "debugger.detach", json!({}));
            }
            bail!("Tab {tab} shows another page now");
        }
        let restored = if attach.restore {
            attach.restored.clone().or_else(|| self.restored_owner(&link, &target_id, attach.reclaim_held))
        } else {
            None
        };
        let reclaimed = restored.is_some();
        let Restored { mut owner, mut options, opener, state, created_at, chosen } = restored.unwrap_or_else(|| Restored {
            owner: attach.owner,
            options: attach.options.clone(),
            opener: attach.opener,
            state: attach.state.clone(),
            created_at: attach.created_at.clone().unwrap_or_else(crate::util::now_iso),
            chosen: None,
        });
        if reclaimed && owner == Owner::Relay && !url_allowed(&options, &url) {
            rlog!("allowlist.reclaim-refused", tabId = tab);
            self.debugger_best_effort(tab, None, "Page.navigate", json!({ "url": "about:blank" }));
            owner = Owner::User;
            options = TabOptions::default();
        }
        self.debugger(tab, None, "Target.setAutoAttach", json!({ "autoAttach": true, "waitForDebuggerOnStart": false, "flatten": true }), limit).await?;
        let keep_open = options.keep_open;
        {
            let mut st = self.st();
            let previous = st.tabs.remove(&tab);
            if let Some(previous) = &previous
                && previous.target_id != target_id
                && let Some(mut handoff) = st.handoffs.remove(&tab)
            {
                handoff.done.take().map(|done| done.send("closed"));
            }
            let kept_chosen = previous.as_ref().and_then(|t| t.chosen.clone());
            // The same page attached again (a renewed debugger) keeps its event stream, driver/CDP handle and state.
            let (events, cdp, driver, state, busy_keys, warnings) = match previous.filter(|p| p.target_id == target_id) {
                Some(previous) => (previous.events, previous.cdp, previous.driver, previous.state, previous.busy_keys, previous.warnings),
                None => (broadcast::channel(EVENT_BUFFER).0, None, None, state.unwrap_or_default(), HashSet::new(), Vec::new()),
            };
            st.tabs.insert(
                tab,
                Tab {
                    id: tab,
                    link_key: link.key.clone(),
                    target_id: target_id.clone(),
                    url,
                    title,
                    owner,
                    chosen: kept_chosen.or(chosen).or(attach.chosen.clone()),
                    options,
                    opener,
                    state,
                    busy_keys,
                    warnings,
                    idle_epoch: 0,
                    created_at,
                    events,
                    children: HashMap::new(),
                    suppressed: HashSet::new(),
                    crashed: false,
                    main_frame: Some(target_id.clone()),
                    last_used: Instant::now(),
                    last_used_at: crate::util::now_iso(),
                    focused: false,
                    fresh_popup: attach.fresh_popup,
                    blanking: 0,
                    protected_ui: false,
                    unattachable: false,
                    closing: false,
                    protected_frames: HashSet::new(),
                    child_frames: HashSet::new(),
                    cdp,
                    driver,
                    backend: crate::relay::Backend::Extension,
                    raw_driver: None,
                    observer: None,
                },
            );
            st.reconnect_owners.remove(&target_id);
            st.restorable.remove(&target_id);
        }
        self.schedule_persist();
        self.ext_best_effort(tab, "action.setAttached", json!({ "attached": true }));
        // The extension runs its own idle cleanup, so it needs the same exemption the relay has. Always send the
        // current value to an extension that knows keep-open: it keeps the flag per tracked tab, and a tab it released
        // stays tracked, so a stale true would otherwise never be cleared (sending false is harmless when untracked).
        // An extension that can't hold a tab gets a warning instead: the tab still opens, and only the relay keeps it.
        // The warning is for a tab the agent just opened: an attach that reattaches an existing tab (a reconnect, a
        // renewed debugger, a relay restart reclaiming it) must not tell it again.
        if link.keeps_open() {
            self.ext_best_effort(tab, "tabs.keepOpen", json!({ "keepOpen": keep_open }));
        } else if keep_open && !attach.reattached {
            self.warn_keep_open_unavailable(tab, &link);
        }
        self.refresh_presentation(tab, true);
        rlog!("target.attached", tabId = tab, owner = owner.name());
        Ok(tab)
    }

    /// Who owned a tab before it was announced again: the same browser's reconnect, or (only for a tab the extension
    /// says an agent opened) the previous relay's tab registry.
    fn restored_owner(&self, link: &Link, target_id: &str, reclaim_held: bool) -> Option<Restored> {
        let st = self.st();
        if let Some(known) = st.reconnect_owners.get(target_id).filter(|k| k.browser == link.key) {
            return Some(Restored {
                owner: known.owner,
                options: known.options.clone(),
                opener: known.opener,
                state: Some(known.state.clone()),
                created_at: known.created_at.clone(),
                chosen: known.chosen.clone(),
            });
        }
        let held = st.restorable.get(target_id).filter(|r| reclaim_held && !r.lent && r.browser_key == link.key)?;
        Some(Restored {
            owner: Owner::Relay,
            options: held.options.clone(),
            opener: held.opener,
            state: None,
            created_at: held.created_at.clone(),
            chosen: held.chosen.clone(),
        })
    }

    /// Forgets a tab: its events end, handoffs on it are cancelled, and the extension (when told) clears what it shows.
    pub fn remove_tab(self: &Arc<Self>, tab: i64, options: Release, reason: &str) {
        let removed = {
            let mut st = self.st();
            let removed = st.tabs.remove(&tab);
            st.presented.remove(&tab);
            if let Some(removed) = removed.as_ref().filter(|t| t.backend.is_direct()) {
                if let Some(observer) = &removed.observer {
                    observer.abort();
                }
                st.release_direct_tab_id(tab);
            }
            if let Some(mut handoff) = st.handoffs.remove(&tab) {
                handoff.done.take().map(|done| done.send("closed"));
            }
            if let Some(removed) = &removed
                && !st.reconnect_owners.contains_key(&removed.target_id)
            {
                st.remember_gone(tab, lost_reason(reason).to_string(), removed.state.clone());
            }
            removed
        };
        if options.update_extension {
            self.ext_best_effort(tab, "pageStatus.clear", json!({}));
            let relay_owned = removed.as_ref().is_some_and(|t| t.owner == Owner::Relay);
            if !(options.released_by_user && relay_owned) {
                self.ext_best_effort(tab, "tabs.ungroup", json!({}));
            }
            self.ext_best_effort(tab, "action.setAttached", json!({ "attached": false }));
        }
        if let Some(removed) = removed {
            rlog!("target.detached", tabId = tab, reason = reason, owner = removed.owner.name());
            self.schedule_persist();
        }
    }

    /// Chrome says a tab it never reported closed is gone: drop it, failing what still waits on it.
    pub fn forget_missing_tab(self: &Arc<Self>, tab: i64, method: &str) {
        let link = {
            let st = self.st();
            if !st.tabs.contains_key(&tab) {
                return;
            }
            st.browser_tab(tab)
        };
        rlog!("target.gone", tabId = tab, method = method);
        self.remove_tab(tab, Release { update_extension: true, gone: true, ..Release::default() }, "target-missing");
        if let Some((link, local)) = link {
            link.reject_tab(local, &format!("Target closed: tab {tab} no longer exists"));
        }
    }

    /// The user takes a tab back: the debugger lets go and it is theirs again.
    pub async fn detach_tab(self: &Arc<Self>, tab: i64, reason: &str) -> anyhow::Result<()> {
        self.ext_tab(tab, "debugger.detach", json!({})).await?;
        self.remove_tab(tab, Release { update_extension: true, gone: true, ..Release::default() }, reason);
        Ok(())
    }

    /// The browser window each of `tabs` is in now, from extensions that can say (CAPABILITY_TAB_WINDOWS), by relay
    /// tab id. A browser that doesn't answer in time leaves its tabs out.
    pub async fn tab_windows(&self, tabs: &[i64]) -> HashMap<i64, i64> {
        let mut by_link: HashMap<String, LinkTabs> = HashMap::new();
        {
            let st = self.st();
            for &tab in tabs {
                if let Some((link, local)) = st.browser_tab(tab)
                    && link.supports(CAPABILITY_TAB_WINDOWS)
                {
                    by_link.entry(link.key.clone()).or_insert_with(|| (link.clone(), Vec::new())).1.push((tab, local));
                }
            }
        }
        let asks = by_link.into_values().map(|(link, tabs)| async move {
            let locals: Vec<i64> = tabs.iter().map(|(_, local)| *local).collect();
            let answer = tokio::time::timeout(Duration::from_secs(2), link.call("tabs.windows", json!({ "tabIds": locals }), None)).await;
            let windows = match answer {
                Ok(Ok(answer)) => answer.get("windows").cloned().unwrap_or_default(),
                _ => Value::Null,
            };
            tabs.into_iter()
                .filter_map(|(tab, local)| windows.get(local.to_string()).and_then(Value::as_i64).map(|window| (tab, window)))
                .collect::<Vec<_>>()
        });
        futures_util::future::join_all(asks).await.into_iter().flatten().collect()
    }

    /// The browser's own ids of `link`'s open tabs labelled `group` (agent tabs and lent ones), for a new tab with that
    /// label to open beside them.
    fn label_tabs(&self, link: &Arc<Link>, group: Option<&str>) -> Vec<i64> {
        let Some(group) = group else { return Vec::new() };
        let st = self.st();
        let mut ids: Vec<i64> = st
            .tabs
            .values()
            .filter(|tab| !tab.closing && tab.options.group.as_deref() == Some(group))
            .filter_map(|tab| st.browser_tab(tab.id))
            .filter(|(owner, _)| owner.key == link.key)
            .map(|(_, local)| local)
            .collect();
        ids.sort_unstable();
        ids
    }

    /// Opens a background agent tab, attaches it blank, then navigates (so the allowlist sees the real load). A tab
    /// an agent's page opens (`opener`) goes in the opener's browser. A `chosen` id is kept for the tab, so agents can
    /// use it as `tab` while the tab lives.
    pub async fn create_tab(self: &Arc<Self>, url: Option<&str>, options: &TabOptions, opener: Option<i64>, chosen: Option<&str>) -> anyhow::Result<i64> {
        let url = url.filter(|u| !u.is_empty()).unwrap_or("about:blank");
        let mut options = Self::normalize_options(options)?;
        if let Some(refusal) = crate::guardrails::guard("Target.createTarget", &json!({ "url": url }), false, &Vec::new) {
            bail!(refusal);
        }
        if let Some(refusal) = self.navigation_refusal(&options, None, "Target.createTarget", url).await {
            bail!(refusal);
        }
        // One tab's request: the tab doesn't keep it, so its popups and later tabs don't open windows of their own.
        let new_window = std::mem::take(&mut options.new_window);
        let window_of = options.window_of.take();
        if new_window && window_of.is_some() {
            bail!("Give newWindow or windowOf, not both.");
        }
        let placed = new_window || window_of.is_some();
        let direct_opener = opener.and_then(|o| self.st().tabs.get(&o).and_then(|t| t.backend.direct().cloned()));
        if let Some(entry) = direct_opener {
            return self.create_tab_direct(entry, Some(url), &options, opener, chosen).await;
        }
        // windowOf names a tab: the new one goes in its browser, beside it.
        let beside = match &window_of {
            Some(named) => {
                let tab = match browse_core::tab_argument(&json!(named))? {
                    browse_core::TabArg::Id(tab) => tab,
                    browse_core::TabArg::Chosen(chosen) => self.resolve_chosen_tab(&chosen)?,
                };
                if self.st().tabs.get(&tab).is_some_and(|t| t.backend.is_direct()) {
                    bail!("{}", DIRECT_WINDOWS);
                }
                let known = self.st().tabs.get(&tab).is_some_and(|t| !t.closing);
                let Some((link, local)) = self.st().browser_tab(tab).filter(|_| known) else {
                    bail!("windowOf: tab {named} isn't one of your tabs or a lent one; `tabs` lists them.");
                };
                Some((link, local))
            }
            None => None,
        };
        let link = match (opener.and_then(|o| self.st().browser_tab(o)), &beside) {
            (Some((link, _)), _) => link,
            (None, Some((link, _))) => {
                if let Some(wanted) = options.browser.as_deref()
                    && self.st().link_by_name(wanted).is_none_or(|named| named.key != link.key)
                {
                    bail!("windowOf: tab {} is in another browser than {wanted}.", window_of.as_deref().unwrap_or_default());
                }
                link.clone()
            }
            (None, None) => match self.target_for(options.browser.as_deref()).await? {
                crate::browser::BrowserRef::Extension(link) => link,
                crate::browser::BrowserRef::Direct(entry) => {
                    if placed {
                        bail!("{}", DIRECT_WINDOWS);
                    }
                    return self.create_tab_direct(entry, Some(url), &options, opener, chosen).await;
                }
            },
        };
        options.browser = None;
        let windows = link.supports(CAPABILITY_TAB_WINDOWS);
        if placed && !windows {
            bail!("The browse extension in {} is too old to choose a tab's window (newWindow, windowOf). Update it (chrome://extensions, Update), then try again; or open the tab without them.", link.name);
        }
        let mut params = json!({ "url": "about:blank", "active": false });
        if options.keep_open && link.keeps_open() {
            params["keepOpen"] = true.into();
        }
        let override_window = crate::settings::agent_window_override();
        // The label's tabs, for the new one to follow; not looked up when nothing would use them.
        let follow = if new_window || beside.is_some() || !windows || override_window.is_some() { Vec::new() } else { self.label_tabs(&link, options.group.as_deref()) };
        place(&mut params, new_window, beside.map(|(_, local)| local), follow, override_window);
        let created = self.ext_link(&link, "tabs.create", params).await?;
        let tab = created.get("tabId").and_then(Value::as_i64).context("tabs.create did not return a tabId")?;
        link.announced.lock().unwrap().insert(tab);
        let mut attach = Attach::new(tab, Owner::Relay);
        attach.options = options.clone();
        attach.opener = opener;
        attach.chosen = chosen.map(str::to_string);
        if let Err(error) = self.setup_tab(attach).await {
            rlog!("create.attach-failed", tabId = tab, error = error.to_string());
            self.ext_best_effort(tab, "tabs.remove", json!({}));
            self.remove_tab(tab, Release { gone: true, ..Release::default() }, "attach-failed");
            return Err(error);
        }
        rlog!("tab.created", tabId = tab, group = options.group.clone(), window = created.get("windowId").and_then(Value::as_i64), rule = created.get("rule").and_then(Value::as_str).map(str::to_string));
        if let (Some(group), Some(Value::Array(split))) = (options.group.as_deref(), created.get("windows"))
            && split.len() > 1
        {
            let list = split.iter().filter_map(Value::as_i64).map(|w| w.to_string()).collect::<Vec<_>>().join(", ");
            let into = created.get("windowId").and_then(Value::as_i64).map(|w| format!(" window {w}")).unwrap_or_default();
            if let Some(entry) = self.st().tabs.get_mut(&tab) {
                entry.add_warning(format!("Tabs labelled `{group}` are in several windows ({list}); this one opened in{into}, where the user used one last. If that may be wrong, ask the user which window to use, then open with windowOf set to a tab in it."));
            }
        }
        if url != "about:blank" {
            let events = self.st().tabs.get(&tab).map(|t| t.events.subscribe());
            let navigated = self.debugger(tab, None, "Page.navigate", json!({ "url": url }), Some(Duration::from_secs(30))).await;
            match navigated {
                Ok(result) if result.get("errorText").and_then(Value::as_str).is_some_and(|e| !e.is_empty()) => {
                    bail!("Opened tab {tab}, but loading {} failed: {}", short_url(url), result["errorText"].as_str().unwrap_or(""));
                }
                Ok(_) => {
                    if let Some(mut events) = events {
                        let _ = tokio::time::timeout(Duration::from_secs(10), async {
                            while let Ok(event) = events.recv().await {
                                if event.session_id.is_none() && event.method == "Page.loadEventFired" {
                                    break;
                                }
                            }
                        })
                        .await;
                    }
                    let info = self.debugger(tab, None, "Target.getTargetInfo", json!({}), Some(Duration::from_secs(5))).await.ok();
                    if let Some((_, _, url, title)) = info.as_ref().and_then(target_info) {
                        if !url_allowed(&options, &url) {
                            self.debugger_best_effort(tab, None, "Page.navigate", json!({ "url": "about:blank" }));
                        } else if let Some(entry) = self.st().tabs.get_mut(&tab) {
                            entry.url = url;
                            entry.title = title;
                        }
                    }
                }
                Err(error) => {
                    rlog!("create.navigate-failed", tabId = tab, error = error.to_string());
                    bail!("Opened tab {tab}, but navigating it failed: {error}");
                }
            }
        }
        Ok(tab)
    }

    /// Closes an agent's tab; a tab the user lent is released to them instead.
    pub async fn close_or_release(self: &Arc<Self>, tab: i64) -> anyhow::Result<&'static str> {
        self.close_or_release_why(tab, "target-closed").await
    }

    /// `close_or_release`, remembering `reason` as why the tab went (`idle` for idle cleanup).
    pub async fn close_or_release_why(self: &Arc<Self>, tab: i64, reason: &str) -> anyhow::Result<&'static str> {
        let (owner, backend, target_id) = {
            let mut st = self.st();
            let entry = st.tabs.get_mut(&tab).context("That tab isn't attached")?;
            entry.closing = true;
            (entry.owner, entry.backend.clone(), entry.target_id.clone())
        };
        if let crate::relay::Backend::Direct(entry) = backend {
            let target = browse_core::TargetId::from(target_id);
            let closed = tokio::time::timeout(Duration::from_secs(10), entry.driver.close(&target)).await;
            match closed {
                Ok(Ok(())) | Ok(Err(browse_core::DriverError::Closed(_) | browse_core::DriverError::Stale)) => {}
                Ok(Err(error)) => {
                    if let Some(entry) = self.st().tabs.get_mut(&tab) {
                        entry.closing = false;
                    }
                    bail!("Couldn't close tab {tab}: {error}");
                }
                Err(_) => {
                    if let Some(entry) = self.st().tabs.get_mut(&tab) {
                        entry.closing = false;
                    }
                    bail!("The browser didn't close tab {tab} within 10 s");
                }
            }
            self.remove_tab(tab, Release { gone: true, ..Release::default() }, reason);
            return Ok("closed");
        }
        let failed = |relay: &Self| {
            if let Some(entry) = relay.st().tabs.get_mut(&tab) {
                entry.closing = false;
            }
        };
        if owner == Owner::User {
            if let Err(error) = self.detach_tab(tab, "released").await {
                failed(self);
                return Err(error);
            }
            return Ok("released");
        }
        match self.ext_tab(tab, "tabs.remove", json!({})).await {
            Ok(_) => {}
            Err(RpcError::Remote(message)) if crate::relay::missing_tab(&message) => {}
            Err(error) => {
                failed(self);
                return Err(error.into());
            }
        }
        self.remove_tab(tab, Release { gone: true, ..Release::default() }, reason);
        Ok("closed")
    }

    /// Why an agent navigation must not go ahead under the tab's allowlist, if it mustn't.
    pub async fn navigation_refusal(&self, options: &TabOptions, tab: Option<i64>, method: &str, url: &str) -> Option<String> {
        let rules = rules(options)?;
        match domain::check_navigation_url(url, &rules).await {
            domain::UrlDecision::Allowed { .. } => None,
            domain::UrlDecision::Refused(reason) => {
                rlog!("allowlist.refused", tabId = tab, method = method, reason = reason.clone());
                let which = tab.map(|t| format!("tab {t}")).unwrap_or_else(|| "the new tab".into());
                Some(format!(
                    "browse blocked {method}: {which} has a domain allowlist and {reason}. Ask the user before going elsewhere: a wider allowlist means opening a new tab with it (navigate with allowedOrigins)."
                ))
            }
        }
    }

    /// The toolbar button: complete a handoff, stop an agent and take the tab back, or lend the tab.
    pub async fn toolbar_clicked(self: &Arc<Self>, tab: i64) {
        let (registered, handoff, busy) = {
            let st = self.st();
            (st.tabs.contains_key(&tab), st.handoff_for_tab(tab).is_some(), st.tab_busy(tab))
        };
        if registered {
            if handoff {
                rlog!("handoff.completed", tabId = tab, from = "toolbar");
                self.finish_handoff(tab, "continued");
                return;
            }
            if busy {
                rlog!("call.stopped", tabId = tab, from = "toolbar");
                self.stop_calls(tab, &format!("The user took tab {tab} back (browse toolbar button) while this ran, so it was stopped. Don't use that tab again unless the user lends it back; ask the user how to continue."));
            }
            if let Err(error) = self.detach_tab(tab, "taken-back-by-user").await {
                rlog!("toolbar.toggle_failed", tabId = tab, error = error.to_string());
            }
            return;
        }
        if let Err(error) = self.setup_tab(Attach::new(tab, Owner::User)).await {
            rlog!("toolbar.attach_failed", tabId = tab, error = error.to_string());
        }
    }

    /// A tab an agent's page opened (target=_blank, window.open) is an agent tab too, with the opener's options
    /// (group, allowlist, read-only). A lent tab's popups count only while an agent works in it.
    pub fn adopt_opened_tab(self: &Arc<Self>, tab: i64, opener: i64) {
        let options = {
            let st = self.st();
            let Some(opener_tab) = st.tabs.get(&opener) else { return };
            if st.tabs.contains_key(&tab) || (opener_tab.owner == Owner::User && !st.tab_busy(opener)) {
                return;
            }
            opener_tab.options.clone()
        };
        rlog!("tab.opened", tabId = tab, openerTabId = opener, group = options.group.clone());
        let relay = self.clone();
        tokio::spawn(async move {
            let link = relay.st().browser_tab(tab);
            if let Some((link, _)) = link {
                link.announced.lock().unwrap().insert(tab);
            }
            for delay in [100u64, 250, 500, 1000, 0] {
                let mut attach = Attach::new(tab, Owner::Relay);
                attach.options = options.clone();
                attach.opener = Some(opener);
                attach.fresh_popup = true;
                match relay.setup_tab(attach).await {
                    Ok(_) => break,
                    Err(error) => {
                        let message = error.to_string();
                        let retry = message.contains("already attached") || message.contains("another debugger");
                        if !retry || delay == 0 || relay.st().tabs.contains_key(&tab) {
                            rlog!("tab.opened.error", tabId = tab, error = message);
                            return;
                        }
                        tokio::time::sleep(Duration::from_millis(delay)).await;
                    }
                }
            }
            let url = {
                let st = relay.st();
                // An event may already have decided (the popup's first document was checked), or closed it.
                let Some(popup) = st.tabs.get(&tab).filter(|popup| popup.fresh_popup) else { return };
                popup.url.clone()
            };
            if !url.is_empty() && !url.starts_with("about:") {
                relay.check_committed_url(tab, &url);
                return;
            }
            // A popup attaches before its first navigation commits. A disallowed commit in the gap between setup_tab's
            // snapshot and the tab being in st.tabs never reached observe_navigation, so ask again now that it would.
            let info = relay.debugger(tab, None, "Target.getTargetInfo", json!({}), Some(ATTACH_TIMEOUT)).await;
            match info {
                Ok(info) => {
                    let current = target_info(&info).map(|(_, _, url, _)| url).unwrap_or_default();
                    let mut documents: Vec<String> = Vec::new();
                    {
                        let mut st = relay.st();
                        let Some(entry) = st.tabs.get_mut(&tab) else { return };
                        if !entry.fresh_popup || entry.closing {
                            return;
                        }
                        // An event during the query can set the stored URL (a title change, a history.replaceState)
                        // without it ever being checked, so it is a document too: check both when they differ.
                        if real_url(&current) && (entry.url == url || !real_url(&entry.url)) {
                            entry.url = current.clone();
                        }
                        if real_url(&entry.url) {
                            documents.push(entry.url.clone());
                        }
                        if real_url(&current) && current != entry.url {
                            documents.push(current);
                        }
                    }
                    for document in documents {
                        relay.check_committed_url(tab, &document);
                    }
                }
                Err(error) => {
                    if relay.enforced(tab).is_some() {
                        relay.close_unverified_popup(tab, &error.to_string());
                    }
                }
            }
        });
    }

    /// The extension re-announced an attached tab (after pairing): set it up, restoring who owned it.
    pub fn queue_inventory(self: &Arc<Self>, link: &Arc<Link>, tab: i64, agent: bool) {
        link.announced.lock().unwrap().insert(tab);
        if agent {
            link.announced_agent.lock().unwrap().insert(tab);
        }
        link.inventory_pending.lock().unwrap().insert(tab);
        let relay = self.clone();
        let owner = link.clone();
        let handle = tokio::spawn(async move {
            let link = owner;
            let mut attach = Attach::new(tab, Owner::User);
            attach.already_attached = true;
            attach.reclaim_held = agent;
            attach.restore = true;
            attach.reattached = true;
            attach.timeout = INVENTORY_TIMEOUT;
            for attempt in 0..3 {
                match relay.setup_tab(attach.clone()).await {
                    Ok(_) => break,
                    Err(error) if attempt == 2 || error.to_string().contains("did not answer") => {
                        rlog!("extension.inventory.failed", tabId = tab, error = error.to_string());
                        // Too late for the reconciliation (the browser is already ready): let the tab go here.
                        if link.is_ready() && !relay.st().tabs.contains_key(&tab) {
                            relay.ext_best_effort(tab, "debugger.detach", json!({}));
                        }
                        break;
                    }
                    Err(_) => tokio::time::sleep(Duration::from_millis(100 * (attempt + 1))).await,
                }
            }
            link.inventory_pending.lock().unwrap().remove(&tab);
            relay.browsers_changed();
        });
        link.inventory.lock().unwrap().push(handle);
    }

    /// The extension finished announcing its tabs: reconcile, then the browser counts as connected.
    pub async fn link_ready(self: &Arc<Self>, link: Arc<Link>) {
        // A tab that is slow to set up (a frozen page) finishes on its own: it doesn't hold the browser back.
        let handles: Vec<_> = std::mem::take(&mut *link.inventory.lock().unwrap());
        let deadline = tokio::time::Instant::now() + INVENTORY_GRACE;
        for handle in handles {
            let _ = tokio::time::timeout_at(deadline, handle).await;
        }
        let still_pending: HashSet<i64> = link.inventory_pending.lock().unwrap().clone();
        if !still_pending.is_empty() {
            rlog!("extension.inventory.slow", tabs = still_pending.iter().map(i64::to_string).collect::<Vec<_>>().join(","));
        }
        if !self.st().links.iter().any(|l| Arc::ptr_eq(l, &link)) {
            return;
        }
        let announced: HashSet<i64> = link.announced.lock().unwrap().clone();
        let agent: HashSet<i64> = std::mem::take(&mut *link.announced_agent.lock().unwrap());
        let (failed, missing, tombstoned, orphaned, own) = {
            let st = self.st();
            let mine: Vec<&Tab> = st.tabs.values().filter(|t| t.link_key == link.key).collect();
            let failed: Vec<i64> = announced.iter().copied().filter(|id| !st.tabs.contains_key(id) && !still_pending.contains(id)).collect();
            let missing: Vec<i64> = mine.iter().filter(|t| !announced.contains(&t.id)).map(|t| t.id).collect();
            let tombstoned: Vec<i64> = mine.iter().filter(|t| st.tombstones.get(&t.target_id).is_some_and(|k| k == &link.key || k.is_empty())).map(|t| t.id).collect();
            let orphaned: Vec<i64> = mine
                .iter()
                .filter(|t| agent.contains(&t.id) && t.owner == Owner::User && !tombstoned.contains(&t.id))
                .map(|t| t.id)
                .collect();
            let own: Vec<i64> = mine.iter().map(|t| t.id).collect();
            (failed, missing, tombstoned, orphaned, own)
        };
        for tab in failed {
            rlog!("extension.inventory.dropped", tabId = tab);
            self.ext_best_effort(tab, "debugger.detach", json!({}));
        }
        for tab in missing {
            self.remove_tab(tab, Release::default(), "inventory-missing");
        }
        for tab in tombstoned {
            rlog!("extension.inventory.orphan", tabId = tab, reason = "closed while its browser was away");
            self.ext_best_effort(tab, "tabs.remove", json!({}));
            self.remove_tab(tab, Release { gone: true, ..Release::default() }, "closed-while-away");
        }
        for tab in orphaned {
            if link.supports(CAPABILITY_TAB_RELEASE) {
                rlog!("extension.inventory.released", tabId = tab, reason = "agent tab browse has no record of");
                self.ext_best_effort(tab, "debugger.detach", json!({ "release": true }));
                self.ext_best_effort(tab, "pageStatus.clear", json!({}));
                self.ext_best_effort(tab, "action.setAttached", json!({ "attached": false }));
                self.remove_tab(tab, Release::default(), "released");
            } else {
                self.ext_best_effort(tab, "tabs.remove", json!({}));
                self.remove_tab(tab, Release { gone: true, ..Release::default() }, "orphaned");
            }
        }
        let lost: Vec<(String, KnownOwner)> = {
            let st = self.st();
            st.reconnect_owners
                .iter()
                .filter(|(target, known)| {
                    known.browser == link.key
                        && !announced.contains(&known.tab)
                        && !st.tabs.values().any(|t| &t.target_id == *target)
                        && st.owner_key(known.tab) == Some(link.key.as_str())
                })
                .map(|(target, known)| (target.clone(), known.clone()))
                .collect()
        };
        {
            let mut st = self.st();
            st.tombstones.retain(|_, key| key != &link.key && !key.is_empty());
            st.reconnect_owners.retain(|_, known| known.browser != link.key);
            // Registry tabs this browser didn't announce again are gone (the browser restarted since).
            if still_pending.is_empty() {
                st.restorable.retain(|_, held| held.browser_key != link.key);
            }
            st.last_connected = Some(Instant::now());
        }
        link.mark_ready();
        // Tabs the browser didn't announce again (its debugger went with the connection): attach them again, as
        // they were.
        for (target, known) in lost {
            let relay = self.clone();
            tokio::spawn(async move {
                let tab = known.tab;
                let mut attach = Attach::new(tab, known.owner);
                attach.options = known.options;
                attach.opener = known.opener;
                attach.state = Some(known.state);
                attach.created_at = Some(known.created_at);
                attach.chosen = known.chosen;
                attach.expect_target = Some(target.clone());
                // This is the tab as it was, not a new one: a keepOpen warning already reached the agent.
                attach.reattached = true;
                match relay.setup_tab(attach).await {
                    Ok(_) => rlog!("extension.reconnect.reattached", tabId = tab),
                    Err(error) => rlog!("extension.reconnect.lost", tabId = tab, target = target, error = error.to_string()),
                }
            });
        }
        self.send_relay_settings(Some(&link));
        if self.st().update_notice.is_some() {
            self.send_update_notice(&link);
        }
        for tab in own {
            self.refresh_presentation(tab, true);
        }
        self.schedule_persist();
        rlog!("browsers", connected = self.st().links.iter().map(|l| l.id.clone()).collect::<Vec<_>>().join(", "));
        self.browsers_changed();
    }

    /// A browser's socket closed: its tabs go, remembering who owned them so a reconnect gives them back.
    pub fn link_closed(self: &Arc<Self>, link: &Arc<Link>, reason: &str) {
        link.disconnected(reason);
        let tabs: Vec<i64> = {
            let mut st = self.st();
            let before = st.links.len();
            st.links.retain(|l| !Arc::ptr_eq(l, link));
            if st.links.len() == before {
                return;
            }
            let mine: Vec<(String, KnownOwner)> = st
                .tabs
                .values()
                .filter(|t| t.link_key == link.key && !t.closing)
                .map(|t| {
                    let known = KnownOwner {
                        tab: t.id,
                        owner: t.owner,
                        browser: link.key.clone(),
                        options: t.options.clone(),
                        opener: t.opener,
                        state: t.state.clone(),
                        created_at: t.created_at.clone(),
                        chosen: t.chosen.clone(),
                    };
                    (t.target_id.clone(), known)
                })
                .collect();
            let ids: Vec<i64> = st.tabs.values().filter(|t| t.link_key == link.key).map(|t| t.id).collect();
            for (target, known) in mine {
                st.reconnect_owners.insert(target, known);
            }
            ids
        };
        for tab in tabs {
            self.remove_tab(tab, Release::default(), "extension-disconnected");
        }
        rlog!("extension.close", browser = link.id.clone(), reason = reason);
        self.browsers_changed();
    }

    /// A `debugger.detached` from the extension.
    pub async fn debugger_detached(self: &Arc<Self>, tab: i64, params: &Value) {
        if let Some(child) = params.get("sessionId").and_then(Value::as_str) {
            let mut st = self.st();
            if let Some(entry) = st.tabs.get_mut(&tab) {
                entry.children.remove(child);
                entry.suppressed.remove(child);
            }
            return;
        }
        let reason = params.get("reason").and_then(Value::as_str).unwrap_or("");
        if self.st().tabs.get(&tab).is_none_or(|t| t.closing) {
            return;
        }
        match reason {
            "target_closed" => {
                let renewed = params.get("reattached") == Some(&Value::Bool(true));
                let Some(again) = self.st().tabs.get(&tab).map(Attach::again) else { return };
                if renewed {
                    rlog!("debugger.renewed", tabId = tab);
                    let mut attach = again;
                    attach.already_attached = true;
                    self.reattach(attach).await;
                    return;
                }
                // Chrome detaches for many reasons that leave the page in place (another extension's popup in it, a
                // PDF viewer): keep the tab while it answers, or blocks browse only for that popup.
                for delay in [50u64, 100, 150] {
                    tokio::time::sleep(Duration::from_millis(delay)).await;
                    match self.debugger(tab, None, "Target.getTargetInfo", json!({}), Some(INVENTORY_TIMEOUT)).await {
                        Ok(_) => return,
                        Err(RpcError::Remote(message)) if message == crate::relay::protected_ui_message(tab) => {
                            rlog!("debugger.detached.kept", tabId = tab, reason = "protected-ui");
                            return;
                        }
                        Err(RpcError::Remote(message)) if message.starts_with(&format!("Tab {tab} is stuck on a Chrome error page")) => break,
                        Err(_) if !self.st().tabs.contains_key(&tab) => return,
                        Err(_) => {}
                    }
                }
                let mut attach = again;
                attach.expect_target = self.st().tabs.get(&tab).map(|t| t.target_id.clone());
                self.reattach(attach).await;
            }
            "canceled_by_user" => {
                self.stop_calls(tab, "The user dismissed the browser's debugging bar, which detached browse from their tabs, so this was stopped. Ask the user how to continue.");
                self.remove_tab(tab, Release { update_extension: true, released_by_user: true, ..Release::default() }, "released-by-user");
            }
            _ => self.remove_tab(tab, Release { update_extension: true, gone: true, ..Release::default() }, "debugger-detached"),
        }
    }

    /// Attaches a tab Chrome detached from again, for the same owner. While another extension's popup blocks it,
    /// the tab stays (marked blocked) and attaching is retried until the popup goes or the tab does.
    async fn reattach(self: &Arc<Self>, mut attach: Attach) {
        let tab = attach.tab;
        let deadline = Instant::now() + Duration::from_secs(10 * 60);
        loop {
            let error = match self.setup_tab(attach.clone()).await {
                Ok(_) => {
                    rlog!("debugger.reattached", tabId = tab);
                    return;
                }
                Err(error) => error.to_string(),
            };
            // The message the relay makes of it comes from a command after the attach, which went through.
            if error == crate::relay::protected_ui_message(tab) || error.starts_with(&format!("Tab {tab} is stuck on a Chrome error page")) {
                attach.already_attached = true;
            }
            if error.contains("already attached") && !attach.already_attached {
                attach.already_attached = true;
                continue;
            }
            let unattachable = crate::relay::unattachable_error(&error);
            let unattachable = unattachable || error.starts_with(&format!("Tab {tab} is stuck on a Chrome error page"));
            let blocked = unattachable || crate::relay::protected_ui_error(&error) || error == crate::relay::protected_ui_message(tab);
            if !blocked || Instant::now() >= deadline {
                rlog!("debugger.reattach_failed", tabId = tab, error = error);
                self.remove_tab(tab, Release { update_extension: true, gone: true, ..Release::default() }, "debugger-detached");
                return;
            }
            {
                let mut st = self.st();
                let Some(entry) = st.tabs.get_mut(&tab) else { return };
                if unattachable {
                    if !std::mem::replace(&mut entry.unattachable, true) {
                        rlog!("tab.unattachable", tabId = tab, method = "debugger.attach", url = short_url(&entry.url));
                    }
                } else if !std::mem::replace(&mut entry.protected_ui, true) {
                    rlog!("tab.protected_ui", tabId = tab, blocked = true, method = "debugger.attach");
                }
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
            if !self.st().tabs.contains_key(&tab) {
                return;
            }
        }
    }

    /// A `debugger.event`: keep the tab's picture current, then hand the event to the tab's subscribers.
    pub fn debugger_event(self: &Arc<Self>, tab: i64, params: &Value) {
        let method = params.get("method").and_then(Value::as_str).unwrap_or("").to_string();
        let event_params = params.get("params").cloned().unwrap_or_else(|| json!({}));
        let source = params.get("sessionId").and_then(Value::as_str).map(str::to_string);
        let mut follow_up: Vec<(Option<String>, &'static str, Value)> = Vec::new();
        let mut committed: Option<String> = None;
        let mut crashed = false;
        {
            let mut st = self.st();
            let Some(entry) = st.tabs.get_mut(&tab) else { return };
            if let Some(source) = &source {
                if !entry.children.contains_key(source) && !entry.suppressed.contains(source) {
                    return;
                }
                let lifecycle = matches!(method.as_str(), "Target.attachedToTarget" | "Target.detachedFromTarget" | "Target.targetInfoChanged");
                if entry.suppressed.contains(source) && !lifecycle {
                    return;
                }
            }
            let root = source.is_none();
            let mut forward = true;
            let mut synthetic: Vec<CdpEvent> = Vec::new();
            if root && method.starts_with("Page.") {
                (forward, synthetic) = observe_protected_frame(tab, entry, &method, &event_params);
            }
            match method.as_str() {
                "Inspector.targetCrashed" | "Target.targetCrashed" if root => {
                    entry.crashed = true;
                    crashed = true;
                }
                "Target.attachedToTarget" => {
                    let child = event_params.get("sessionId").and_then(Value::as_str).map(str::to_string);
                    let info = event_params.get("targetInfo");
                    let (Some(child), Some(info)) = (child, info) else { return };
                    let kind = info.get("type").and_then(Value::as_str).unwrap_or("").to_string();
                    let url = info.get("url").and_then(Value::as_str).unwrap_or("").to_string();
                    let waiting = event_params.get("waitingForDebugger") == Some(&Value::Bool(true));
                    let supported = matches!(kind.as_str(), "page" | "iframe" | "worker" | "shared_worker" | "service_worker");
                    if !supported || is_restricted_url(&url) || kind == "page" {
                        entry.suppressed.insert(child.clone());
                        if waiting {
                            follow_up.push((Some(child.clone()), "Runtime.runIfWaitingForDebugger", json!({})));
                        }
                        if kind == "page" {
                            follow_up.push((source.clone(), "Target.detachFromTarget", json!({ "sessionId": child })));
                        }
                        return_follow_up(self, tab, follow_up);
                        return;
                    }
                    entry.suppressed.remove(&child);
                    let target_id = info.get("targetId").and_then(Value::as_str).unwrap_or("").to_string();
                    entry.children.insert(child, crate::relay::Child { target_id, kind, url });
                }
                "Target.detachedFromTarget" => {
                    if let Some(child) = event_params.get("sessionId").and_then(Value::as_str) {
                        entry.children.remove(child);
                        entry.suppressed.remove(child);
                    }
                }
                "Target.targetInfoChanged" => {
                    let Some(info) = event_params.get("targetInfo") else { return };
                    let target_id = info.get("targetId").and_then(Value::as_str).unwrap_or("");
                    let url = info.get("url").and_then(Value::as_str).unwrap_or("").to_string();
                    if target_id == entry.target_id {
                        entry.url = url;
                        entry.title = info.get("title").and_then(Value::as_str).unwrap_or("").to_string();
                    } else if let Some(child_session) = entry.children.iter().find(|(_, c)| c.target_id == target_id).map(|(s, _)| s.clone()) {
                        if is_restricted_url(&url) {
                            entry.children.remove(&child_session);
                            entry.suppressed.insert(child_session);
                            return;
                        }
                        if let Some(child) = entry.children.get_mut(&child_session) {
                            child.url = url;
                        }
                    }
                }
                "Page.frameNavigated" if root => {
                    let frame = &event_params["frame"];
                    if frame.get("parentId").is_none()
                        && let Some(url) = frame.get("url").and_then(Value::as_str) {
                            entry.url = url.to_string();
                            entry.main_frame = frame.get("id").and_then(Value::as_str).map(str::to_string).or(entry.main_frame.take());
                            committed = Some(url.to_string());
                            if entry.focused {
                                follow_up.push((None, "Emulation.setFocusEmulationEnabled", json!({ "enabled": true })));
                            }
                        }
                }
                "Page.navigatedWithinDocument" if root => {
                    let frame = event_params.get("frameId").and_then(Value::as_str);
                    if (frame.is_none() || frame == entry.main_frame.as_deref())
                        && let Some(url) = event_params.get("url").and_then(Value::as_str) {
                            entry.url = url.to_string();
                        }
                }
                _ => {}
            }
            for event in synthetic {
                let _ = entry.events.send(event);
            }
            if forward {
                let _ = entry.events.send(CdpEvent { method: method.clone(), params: event_params.clone(), session_id: source.clone() });
            }
        }
        return_follow_up(self, tab, follow_up);
        if crashed {
            let link = {
                let mut st = self.st();
                if let Some(mut handoff) = st.handoffs.remove(&tab) {
                    handoff.done.take().map(|d| d.send("closed"));
                }
                st.browser_tab(tab)
            };
            if let Some((link, local)) = link {
                link.reject_tab(local, &format!("Target crashed: tab {tab}"));
            }
            self.refresh_presentation(tab, false);
        }
        if source.is_none() {
            self.observe_navigation(tab, &method, &event_params, committed);
        }
    }

    /// The tab's allowlist on its own navigations (cli/src/session-manager/navigation-guard.ts).
    fn observe_navigation(self: &Arc<Self>, tab: i64, method: &str, params: &Value, committed: Option<String>) {
        if !matches!(method, "Page.frameNavigated" | "Page.frameRequestedNavigation" | "Page.frameStartedNavigating" | "Network.responseReceived") {
            return;
        }
        let Some((rules, main_frame)) = self.enforced(tab) else { return };
        match method {
            "Page.frameNavigated" => {
                if let Some(url) = committed {
                    self.check_committed_url(tab, &url);
                }
            }
            "Network.responseReceived" => {
                if params.get("type").and_then(Value::as_str) != Some("Document") || params.get("frameId").and_then(Value::as_str) != Some(main_frame.as_str()) {
                    return;
                }
                let response = &params["response"];
                let (Some(address), Some(url)) = (response.get("remoteIPAddress").and_then(Value::as_str), response.get("url").and_then(Value::as_str)) else { return };
                if domain::is_private_address(address) && !domain::explicitly_allows_host(&rules, url) {
                    self.allowlist_violation(tab, url, &format!("its document came from the private address {address} (name it exactly in the allowlist to allow it)"));
                }
            }
            _ => {
                if params.get("frameId").and_then(Value::as_str) != Some(main_frame.as_str()) {
                    return;
                }
                let Some(url) = params.get("url").and_then(Value::as_str) else { return };
                if let domain::UrlDecision::Refused(reason) = domain::check_url(url, &rules, false) {
                    self.debugger_best_effort(tab, None, "Page.stopLoading", json!({}));
                    let warning = format!(
                        "Domain allowlist: tab {tab} started to navigate to {}, but {reason}; browse stopped it. Ask the user before going elsewhere.",
                        short_url(url)
                    );
                    if self.stop_navigate_calls(tab, &warning) == 0
                        && let Some(entry) = self.st().tabs.get_mut(&tab)
                    {
                        entry.add_warning(warning);
                    }
                    rlog!("allowlist.stopped", tabId = tab, method = method, reason = reason);
                }
            }
        }
    }

    /// Ends the navigate calls running in `tab` with `message` as their error; returns how many.
    fn stop_navigate_calls(&self, tab: i64, message: &str) -> usize {
        let navigating = navigate_calls(&self.inflight);
        if navigating.is_empty() {
            return 0;
        }
        self.st().stop_calls_with_ids(&navigating, tab, message)
    }

    /// The tab's rules and main frame, when it has an allowlist.
    pub(crate) fn enforced(&self, tab: i64) -> Option<(Vec<domain::OriginRule>, String)> {
        let st = self.st();
        let entry = st.tabs.get(&tab)?;
        Some((rules(&entry.options)?, entry.main_frame.clone().unwrap_or_else(|| entry.target_id.clone())))
    }

    pub fn check_committed_url(self: &Arc<Self>, tab: i64, url: &str) -> bool {
        let Some((rules, _)) = self.enforced(tab) else {
            // No allowlist to judge it, but a real document still ends the popup's fresh state.
            self.document_checked(tab, url);
            return true;
        };
        match domain::check_url(url, &rules, false) {
            domain::UrlDecision::Allowed { .. } => {
                self.document_checked(tab, url);
                true
            }
            domain::UrlDecision::Refused(reason) => {
                self.allowlist_violation(tab, url, &reason);
                false
            }
        }
    }

    /// A real document was checked: the popup no longer waits for its first one.
    fn document_checked(&self, tab: i64, url: &str) {
        if real_url(url)
            && let Some(entry) = self.st().tabs.get_mut(&tab) {
                entry.fresh_popup = false;
            }
    }

    pub(crate) fn allowlist_violation(self: &Arc<Self>, tab: i64, url: &str, reason: &str) {
        let navigating = navigate_calls(&self.inflight);
        let popup = {
            let mut st = self.st();
            let Some(entry) = st.tabs.get_mut(&tab) else { return };
            let popup = entry.fresh_popup && entry.owner == Owner::Relay;
            entry.fresh_popup = false;
            let opener = entry.opener.filter(|_| popup);
            let action = if popup { "closed the popup" } else { "sent the tab back to about:blank" };
            let warning = format!("Domain allowlist: tab {tab} went to {}, but {reason}; browse {action}. Ask the user before going elsewhere.", short_url(url));
            // A navigate call that led there ends now with this as its error, instead of reporting a load that didn't
            // happen (or waiting out its timeout).
            let stopped = !popup && st.stop_calls_with_ids(&navigating, tab, &warning) > 0;
            // A closed popup can't carry the news: its opener does.
            match opener {
                _ if stopped => {}
                Some(opener) => {
                    if let Some(opener) = st.tabs.get_mut(&opener) {
                        opener.add_warning(warning);
                    }
                }
                None => {
                    if let Some(entry) = st.tabs.get_mut(&tab) {
                        entry.add_warning(warning);
                    }
                }
            }
            popup
        };
        rlog!("allowlist.violation", tabId = tab, url = short_url(url), popup = popup);
        let relay = self.clone();
        tokio::spawn(async move {
            if popup {
                let _ = relay.close_or_release(tab).await;
                return;
            }
            // A direct tab is blanked through its unguarded driver, so even a read-only tab leaves the page.
            let raw = relay.st().tabs.get(&tab).filter(|t| t.backend.is_direct()).map(|t| t.raw_driver.clone());
            if let Some(raw) = raw {
                if let Some(raw) = raw {
                    let _ = tokio::time::timeout(Duration::from_secs(10), raw.navigate("about:blank", None)).await;
                }
                return;
            }
            let _ = relay.debugger(tab, None, "Page.stopLoading", json!({}), Some(Duration::from_secs(3))).await;
            let _ = relay.debugger(tab, None, "Page.navigate", json!({ "url": "about:blank" }), Some(Duration::from_secs(10))).await;
        });
    }

    /// A fresh popup whose URL couldn't be asked again is unverified: close it, leaving the news with its opener the
    /// way `allowlist_violation` does. Fresh and still open means no document of it passed a check, whatever its
    /// stored URL says.
    pub(crate) fn close_unverified_popup(self: &Arc<Self>, tab: i64, error: &str) {
        {
            let mut st = self.st();
            let Some(entry) = st.tabs.get_mut(&tab) else { return };
            if !entry.fresh_popup || entry.closing || entry.owner != Owner::Relay {
                return;
            }
            entry.fresh_popup = false;
            let warning = format!("Domain allowlist: browse could not confirm tab {tab}'s first document, so it closed the popup. Ask the user before going elsewhere.");
            // A closed popup can't carry the news: its opener does.
            match entry.opener {
                Some(opener) => {
                    if let Some(opener) = st.tabs.get_mut(&opener) {
                        opener.add_warning(warning);
                    }
                }
                None => entry.add_warning(warning),
            }
        }
        rlog!("allowlist.popup-unverified", tabId = tab, error = error);
        let relay = self.clone();
        tokio::spawn(async move {
            let _ = relay.close_or_release(tab).await;
        });
    }
}

/// The ids of the running `navigate` calls.
fn navigate_calls(inflight: &std::sync::Mutex<std::collections::HashMap<u64, crate::relay::InFlight>>) -> Vec<u64> {
    inflight.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).iter().filter(|(_, call)| call.tool == "navigate").map(|(id, _)| *id).collect()
}

/// The tab's allowlist rules, when it has one.
pub fn rules(options: &TabOptions) -> Option<Vec<domain::OriginRule>> {
    domain::parse_origin_patterns(options.allowed_origins.as_ref()?).ok().filter(|r| !r.is_empty())
}

pub fn url_allowed(options: &TabOptions, url: &str) -> bool {
    match rules(options) {
        Some(rules) => domain::check_url(url, &rules, false).allowed(),
        None => true,
    }
}

/// Child frames showing another extension's document (a password manager's inline menu) stay hidden from tools,
/// and the tab counts as blocked while one is there (cli/src/cdp/protected-frames.ts). Returns whether to forward
/// the event, and synthetic events to send first: a `Page.frameDetached` for a frame that just became protected,
/// a `Page.frameAttached` for one that came back to an ordinary document.
fn observe_protected_frame(tab: i64, entry: &mut Tab, method: &str, params: &Value) -> (bool, Vec<CdpEvent>) {
    let frame = params.get("frame");
    let Some(frame_id) = params.get("frameId").and_then(Value::as_str).or_else(|| frame.and_then(|f| f.get("id")).and_then(Value::as_str)).map(str::to_string) else {
        return (true, Vec::new());
    };
    if Some(frame_id.as_str()) == entry.main_frame.as_deref() || frame_id == entry.target_id {
        return (true, Vec::new());
    }
    if method == "Page.frameAttached" && params.get("parentFrameId").and_then(Value::as_str).is_some() {
        entry.child_frames.insert(frame_id.clone());
    }
    let frame_url = frame.and_then(|f| f.get("url")).and_then(Value::as_str);
    let parent = frame.and_then(|f| f.get("parentId")).and_then(Value::as_str).map(str::to_string);
    let intent = matches!(method, "Page.frameRequestedNavigation" | "Page.frameScheduledNavigation" | "Page.frameStartedNavigating");
    let event = |method: &str, params: Value| CdpEvent { method: method.into(), params, session_id: None };
    if entry.protected_frames.contains(&frame_id) {
        if method == "Page.frameDetached" {
            entry.protected_frames.remove(&frame_id);
            entry.child_frames.remove(&frame_id);
            if entry.protected_frames.is_empty() && std::mem::replace(&mut entry.protected_ui, false) {
                rlog!("tab.protected_ui", tabId = tab, blocked = false);
            }
            return (false, Vec::new());
        }
        if method == "Page.frameNavigated"
            && let (Some(url), Some(parent)) = (frame_url, parent)
            && !is_restricted_url(url)
        {
            entry.protected_frames.remove(&frame_id);
            if entry.protected_frames.is_empty() {
                entry.protected_ui = false;
            }
            return (true, vec![event("Page.frameAttached", json!({ "frameId": frame_id, "parentFrameId": parent }))]);
        }
        return (false, Vec::new());
    }
    let restricted = if intent {
        params.get("url").and_then(Value::as_str).is_some_and(is_restricted_url) && entry.child_frames.contains(&frame_id)
    } else {
        method == "Page.frameNavigated" && parent.is_some() && frame_url.is_some_and(is_restricted_url)
    };
    if method == "Page.frameDetached" {
        entry.child_frames.remove(&frame_id);
    }
    if !restricted {
        return (true, Vec::new());
    }
    entry.protected_frames.insert(frame_id.clone());
    if !std::mem::replace(&mut entry.protected_ui, true) {
        rlog!("tab.protected_ui", tabId = tab, blocked = true, frame = "extension");
    }
    (false, vec![event("Page.frameDetached", json!({ "frameId": frame_id, "reason": "remove" }))])
}

fn lost_reason(reason: &str) -> &'static str {
    match reason {
        "tab-closed" => "the tab was closed in the browser",
        "target-closed" => "it was closed with the tabs tool",
        "released" => "it was given back to the user",
        "attach-failed" => "browse couldn't attach to it",
        "closed-while-away" | "orphaned" => "it was closed while its browser was away",
        "inventory-missing" => "its browser no longer has it",
        "released-by-user" => "the user dismissed the browser's debugging bar",
        "taken-back-by-user" => "the user took it back with the browse toolbar button",
        "target-missing" => "Chrome no longer has it",
        "debugger-detached" => "Chrome detached browse from it",
        "idle" => "it was idle, so browse closed it",
        "browser-disconnected" => "its browser disconnected",
        "driver-disconnected" => "its browser was disconnected from browse",
        _ => "browse lost it",
    }
}

fn return_follow_up(relay: &Arc<Relay>, tab: i64, commands: Vec<(Option<String>, &'static str, Value)>) {
    for (session, method, params) in commands {
        relay.debugger_best_effort(tab, session, method, params);
    }
}

#[cfg(test)]
mod place_tests {
    use super::place;
    use serde_json::{Value, json};

    fn placed(new_window: bool, beside: Option<i64>, follow: Vec<i64>, override_window: Option<&str>) -> Value {
        let mut params = json!({});
        place(&mut params, new_window, beside, follow, override_window);
        params
    }

    #[test]
    fn a_label_follows_its_tabs_whatever_the_setting_says() {
        assert_eq!(placed(false, None, vec![3, 4], None), json!({ "follow": [3, 4] }));
        assert_eq!(placed(false, None, Vec::new(), None), json!({}));
    }

    #[test]
    fn the_relay_override_fixes_placement_so_labels_dont_follow() {
        assert_eq!(placed(false, None, vec![3], Some("separate")), json!({ "window": "separate" }));
        assert_eq!(placed(false, None, vec![3], Some("current")), json!({ "window": "current" }));
    }

    #[test]
    fn an_explicit_window_wins_over_the_label() {
        assert_eq!(placed(true, None, vec![3], None), json!({ "newWindow": true }));
        assert_eq!(placed(false, Some(9), vec![3], None), json!({ "beside": 9 }));
        assert_eq!(placed(false, Some(9), Vec::new(), Some("separate")), json!({ "beside": 9, "window": "separate" }));
    }
}
