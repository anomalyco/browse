//! Attached tabs: attaching one (an agent's new tab, a tab the user lends with the toolbar button, a reconnecting
//! browser's inventory), routing its debugger events, and letting it go (cli/src/cdp/root-target-lifecycle.ts,
//! cli/src/relay/extension-events.ts).

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context, anyhow, bail};
use browse_core::CdpEvent;
use serde_json::{Value, json};
use tokio::sync::broadcast;

use crate::domain;
use crate::guardrails::is_restricted_url;
use crate::link::{Link, RpcError};
use crate::protocol::CAPABILITY_TAB_RELEASE;
use crate::relay::{KnownOwner, Owner, Relay, Tab};
use crate::rlog;
use crate::util::short_url;

const ATTACH_TIMEOUT: Duration = Duration::from_secs(10);
const INVENTORY_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone)]
pub struct Attach {
    pub tab: i64,
    pub owner: Owner,
    pub session: Option<String>,
    pub already_attached: bool,
    /// An inventory tab the extension says an agent opened: it may be reclaimed by the session that held it.
    pub reclaim_held: bool,
    /// Look up who owned the tab before (a reconnect, a relay restart). A user's lend restores nothing.
    pub restore: bool,
    pub timeout: Duration,
}

impl Attach {
    pub fn new(tab: i64, owner: Owner, session: Option<String>) -> Self {
        Self { tab, owner, session, already_attached: false, reclaim_held: false, restore: false, timeout: ATTACH_TIMEOUT }
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct Release {
    pub update_extension: bool,
    pub released_by_user: bool,
    /// The tab is gone for good (closed, or its page replaced): sessions stop holding it.
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
        let (owner, session) = if attach.session.is_some() || !attach.restore {
            (attach.owner, attach.session.clone())
        } else {
            self.restored_owner(&link, &target_id, attach.reclaim_held).unwrap_or((attach.owner, None))
        };
        let (owner, session) = if attach.session.is_none() && owner == Owner::Relay && session.is_some() && !self.url_allowed(session.as_deref(), &url) {
            rlog!("allowlist.reclaim-refused", tabId = tab, session = session.clone());
            self.debugger_best_effort(tab, None, "Page.navigate", json!({ "url": "about:blank" }));
            (Owner::User, None)
        } else {
            (owner, session)
        };
        self.debugger(tab, None, "Target.setAutoAttach", json!({ "autoAttach": true, "waitForDebuggerOnStart": false, "flatten": true }), limit).await?;
        {
            let mut st = self.st();
            let previous = st.tabs.remove(&tab);
            if let Some(previous) = &previous
                && previous.target_id != target_id {
                    let ids: Vec<String> = st.handoffs.iter().filter(|(_, h)| h.tab == tab).map(|(s, _)| s.clone()).collect();
                    for id in ids {
                        if let Some(mut handoff) = st.handoffs.remove(&id) {
                            handoff.done.take().map(|done| done.send("closed"));
                        }
                    }
                }
            let events = broadcast::channel(1024).0;
            st.tabs.insert(
                tab,
                Tab {
                    id: tab,
                    link_key: link.key.clone(),
                    target_id: target_id.clone(),
                    url,
                    title,
                    owner,
                    session: session.clone(),
                    events,
                    children: HashMap::new(),
                    suppressed: HashSet::new(),
                    crashed: false,
                    main_frame: Some(target_id.clone()),
                    last_used: Instant::now(),
                    focused: false,
                    fresh_popup: false,
                    blanking: 0,
                    cdp: None,
                },
            );
            if let Some(entry) = session.as_ref().and_then(|id| st.sessions.get_mut(id)) {
                if owner == Owner::Relay && !entry.held.contains(&target_id) {
                    entry.held.push(target_id.clone());
                }
                if entry.current.is_none() {
                    entry.current = Some(tab);
                }
            }
            if owner == Owner::User && session.is_none() {
                for entry in st.sessions.values_mut() {
                    entry.held.retain(|id| id != &target_id);
                }
            }
            st.reconnect_owners.remove(&target_id);
        }
        self.schedule_persist();
        self.ext_best_effort(tab, "action.setAttached", json!({ "attached": true }));
        self.refresh_presentation(tab, true);
        rlog!("target.attached", tabId = tab, owner = owner.name(), session = session);
        Ok(tab)
    }

    /// Who owned a tab before it was announced again: the same browser's reconnect, a session's adopted tab, or
    /// (only for a tab the extension says an agent opened) a session that held it.
    fn restored_owner(&self, link: &Link, target_id: &str, reclaim_held: bool) -> Option<(Owner, Option<String>)> {
        let st = self.st();
        if let Some(known) = st.reconnect_owners.get(target_id).filter(|k| k.browser == link.key && st.sessions.contains_key(&k.session)) {
            return Some((known.owner, Some(known.session.clone())));
        }
        let bound = |s: &&crate::sessions::Session| s.browser.as_ref().and_then(|b| b.key.as_deref()).is_none_or(|k| k == link.key);
        if let Some(session) = st.sessions.values().filter(bound).find(|s| s.target.as_ref().is_some_and(|t| t.id == target_id)) {
            let owner = if session.target.as_ref().is_some_and(|t| t.owner == "relay") { Owner::Relay } else { Owner::User };
            if owner == Owner::User || reclaim_held {
                return Some((owner, Some(session.id.clone())));
            }
        }
        if reclaim_held
            && let Some(session) = st.sessions.values().filter(bound).find(|s| s.held.iter().any(|id| id == target_id)) {
                return Some((Owner::Relay, Some(session.id.clone())));
            }
        None
    }

    pub fn url_allowed(&self, session: Option<&str>, url: &str) -> bool {
        match self.session_rules(session) {
            Some(rules) => domain::check_url(url, &rules, false).allowed(),
            None => true,
        }
    }

    pub fn session_rules(&self, session: Option<&str>) -> Option<Vec<domain::OriginRule>> {
        let st = self.st();
        let origins = st.sessions.get(session?)?.allowed_origins.clone()?;
        domain::parse_origin_patterns(&origins).ok().filter(|r| !r.is_empty())
    }

    /// Forgets a tab: its events end, handoffs on it are cancelled, and the extension (when told) clears what it shows.
    pub fn remove_tab(self: &Arc<Self>, tab: i64, options: Release, reason: &str) {
        let removed = {
            let mut st = self.st();
            let removed = st.tabs.remove(&tab);
            st.presented.remove(&tab);
            let ids: Vec<String> = st.handoffs.iter().filter(|(_, h)| h.tab == tab).map(|(s, _)| s.clone()).collect();
            for id in ids {
                if let Some(mut handoff) = st.handoffs.remove(&id) {
                    handoff.done.take().map(|done| done.send("closed"));
                }
            }
            if let Some(removed) = &removed {
                for session in st.sessions.values_mut() {
                    if options.gone || options.released_by_user {
                        if session.current == Some(tab) {
                            session.current = None;
                        }
                        session.held.retain(|id| id != &removed.target_id);
                        if session.target.as_ref().is_some_and(|t| t.id == removed.target_id) {
                            session.target = None;
                        }
                    }
                }
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
            rlog!("target.detached", tabId = tab, reason = reason, session = removed.session);
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
    pub async fn detach_tab(self: &Arc<Self>, tab: i64) -> anyhow::Result<()> {
        self.ext_tab(tab, "debugger.detach", json!({})).await?;
        self.remove_tab(tab, Release { update_extension: true, gone: true, ..Release::default() }, "relay-detached");
        Ok(())
    }

    /// Opens a background tab for a session, attaches it blank, then navigates (so the allowlist sees the real load).
    pub async fn create_tab(self: &Arc<Self>, session: &str, url: Option<&str>) -> anyhow::Result<i64> {
        let url = url.filter(|u| !u.is_empty()).unwrap_or("about:blank");
        if let Some(refusal) = crate::guardrails::guard("Target.createTarget", &json!({ "url": url }), false, session, &Vec::new) {
            bail!(refusal);
        }
        if let Some(refusal) = self.navigation_refusal(session, "Target.createTarget", url).await {
            bail!(refusal);
        }
        if self.st().sessions.get(session).is_some_and(|s| s.read_only) {
            bail!("Session {session} is read-only: it can't open tabs. Adopt a tab the user lent you instead (session tool, action adopt).");
        }
        let link = self.session_link(session).await?;
        let mut params = json!({ "url": "about:blank", "active": false });
        if let Some(window) = crate::settings::agent_window_override() {
            params["window"] = window.into();
        }
        let created = self.ext_link(&link, "tabs.create", params).await?;
        let tab = created.get("tabId").and_then(Value::as_i64).context("tabs.create did not return a tabId")?;
        link.announced.lock().unwrap().insert(tab);
        if let Err(error) = self.setup_tab(Attach::new(tab, Owner::Relay, Some(session.to_string()))).await {
            rlog!("create.attach-failed", tabId = tab, error = error.to_string());
            self.ext_best_effort(tab, "tabs.remove", json!({}));
            self.remove_tab(tab, Release { gone: true, ..Release::default() }, "attach-failed");
            return Err(error);
        }
        if let Some(entry) = self.st().sessions.get_mut(session) {
            entry.current = Some(tab);
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
                        if !self.url_allowed(Some(session), &url) {
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
        let owner = self.st().tabs.get(&tab).map(|t| t.owner).context("That tab isn't attached")?;
        if owner == Owner::User {
            self.detach_tab(tab).await?;
            return Ok("released");
        }
        match self.ext_tab(tab, "tabs.remove", json!({})).await {
            Ok(_) => {}
            Err(RpcError::Remote(message)) if crate::relay::missing_tab(&message) => {}
            Err(error) => return Err(error.into()),
        }
        self.remove_tab(tab, Release { gone: true, ..Release::default() }, "target-closed");
        Ok("closed")
    }

    /// Why an agent navigation must not go ahead under the session's allowlist, if it mustn't.
    pub async fn navigation_refusal(&self, session: &str, method: &str, url: &str) -> Option<String> {
        let rules = self.session_rules(Some(session))?;
        match domain::check_navigation_url(url, &rules).await {
            domain::UrlDecision::Allowed { .. } => None,
            domain::UrlDecision::Refused(reason) => {
                rlog!("allowlist.refused", session = session, method = method, reason = reason.clone());
                Some(format!(
                    "browse blocked {method}: session {session} has a domain allowlist and {reason}. Ask the user before widening it (session tool, action allowlist)."
                ))
            }
        }
    }

    /// The toolbar button: complete a handoff, stop an agent and take the tab back, or lend the tab.
    pub async fn toolbar_clicked(self: &Arc<Self>, tab: i64) {
        let (registered, handoff, session) = {
            let st = self.st();
            let target = st.tabs.get(&tab);
            (target.is_some(), st.handoff_for_tab(tab).map(|h| h.session.clone()), target.and_then(|t| t.session.clone()))
        };
        if registered {
            if let Some(session) = handoff {
                rlog!("handoff.completed", tabId = tab, from = "toolbar");
                self.finish_handoff(&session, "continued");
                return;
            }
            if let Some(session) = session.filter(|s| self.st().sessions.get(s).is_some_and(|s| s.busy())) {
                rlog!("call.stopped", tabId = tab, session = session.clone(), from = "toolbar");
                self.stop_calls(&session, &format!("The user took tab {tab} back (browse toolbar button) while this ran, so it was stopped. Don't use that tab again unless the user lends it back; ask the user how to continue."));
            }
            if let Err(error) = self.detach_tab(tab).await {
                rlog!("toolbar.toggle_failed", tabId = tab, error = error.to_string());
            }
            return;
        }
        if let Err(error) = self.setup_tab(Attach::new(tab, Owner::User, None)).await {
            rlog!("toolbar.attach_failed", tabId = tab, error = error.to_string());
        }
    }

    /// A tab an agent's page opened (target=_blank, window.open) belongs to the opener's session.
    pub fn adopt_opened_tab(self: &Arc<Self>, tab: i64, opener: i64) {
        let session = {
            let st = self.st();
            let Some(opener_tab) = st.tabs.get(&opener) else { return };
            let Some(session) = opener_tab.session.clone() else { return };
            if st.tabs.contains_key(&tab) || (opener_tab.owner == Owner::User && !st.sessions.get(&session).is_some_and(|s| s.busy())) {
                return;
            }
            session
        };
        rlog!("tab.opened", tabId = tab, openerTabId = opener, session = session.clone());
        let relay = self.clone();
        tokio::spawn(async move {
            if let Some((link, _)) = relay.st().browser_tab(tab) {
                link.announced.lock().unwrap().insert(tab);
            }
            for delay in [100u64, 250, 500, 1000, 0] {
                match relay.setup_tab(Attach::new(tab, Owner::Relay, Some(session.clone()))).await {
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
                let mut st = relay.st();
                let Some(popup) = st.tabs.get_mut(&tab) else { return };
                popup.fresh_popup = true;
                popup.url.clone()
            };
            relay.check_committed_url(tab, &url);
        });
    }

    /// The extension re-announced an attached tab (after pairing): set it up, restoring who owned it.
    pub fn queue_inventory(self: &Arc<Self>, link: &Arc<Link>, tab: i64, agent: bool) {
        link.announced.lock().unwrap().insert(tab);
        if agent {
            link.announced_agent.lock().unwrap().insert(tab);
        }
        let relay = self.clone();
        let handle = tokio::spawn(async move {
            let mut attach = Attach::new(tab, Owner::User, None);
            attach.already_attached = true;
            attach.reclaim_held = agent;
            attach.restore = true;
            attach.timeout = INVENTORY_TIMEOUT;
            for attempt in 0..3 {
                match relay.setup_tab(attach.clone()).await {
                    Ok(_) => return,
                    Err(error) if attempt == 2 || error.to_string().contains("did not answer") => {
                        rlog!("extension.inventory.failed", tabId = tab, error = error.to_string());
                        return;
                    }
                    Err(_) => tokio::time::sleep(Duration::from_millis(100 * (attempt + 1))).await,
                }
            }
        });
        link.inventory.lock().unwrap().push(handle);
    }

    /// The extension finished announcing its tabs: reconcile, then the browser counts as connected.
    pub async fn link_ready(self: &Arc<Self>, link: Arc<Link>) {
        let handles: Vec<_> = std::mem::take(&mut *link.inventory.lock().unwrap());
        for handle in handles {
            let _ = handle.await;
        }
        if !self.st().links.iter().any(|l| Arc::ptr_eq(l, &link)) {
            return;
        }
        let announced: HashSet<i64> = link.announced.lock().unwrap().clone();
        let agent: HashSet<i64> = std::mem::take(&mut *link.announced_agent.lock().unwrap());
        let (failed, missing, tombstoned, orphaned, own) = {
            let st = self.st();
            let mine: Vec<&Tab> = st.tabs.values().filter(|t| t.link_key == link.key).collect();
            let failed: Vec<i64> = announced.iter().copied().filter(|id| !st.tabs.contains_key(id)).collect();
            let missing: Vec<i64> = mine.iter().filter(|t| !announced.contains(&t.id)).map(|t| t.id).collect();
            let tombstoned: Vec<i64> = mine.iter().filter(|t| st.tombstones.get(&t.target_id).is_some_and(|k| k == &link.key || k.is_empty())).map(|t| t.id).collect();
            let orphaned: Vec<i64> = mine
                .iter()
                .filter(|t| agent.contains(&t.id) && t.owner == Owner::User && t.session.is_none() && !tombstoned.contains(&t.id))
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
            rlog!("extension.inventory.orphan", tabId = tab, reason = "session deleted");
            self.ext_best_effort(tab, "tabs.remove", json!({}));
            self.remove_tab(tab, Release { gone: true, ..Release::default() }, "session-deleted");
        }
        for tab in orphaned {
            if link.supports(CAPABILITY_TAB_RELEASE) {
                rlog!("extension.inventory.released", tabId = tab, reason = "agent tab without a session");
                self.ext_best_effort(tab, "debugger.detach", json!({ "release": true }));
                self.ext_best_effort(tab, "pageStatus.clear", json!({}));
                self.ext_best_effort(tab, "action.setAttached", json!({ "attached": false }));
                self.remove_tab(tab, Release::default(), "released");
            } else {
                self.ext_best_effort(tab, "tabs.remove", json!({}));
                self.remove_tab(tab, Release { gone: true, ..Release::default() }, "session-deleted");
            }
        }
        {
            let mut st = self.st();
            st.tombstones.retain(|_, key| key != &link.key && !key.is_empty());
            st.reconnect_owners.retain(|_, known| known.browser != link.key);
            st.last_connected = Some(Instant::now());
        }
        link.mark_ready();
        self.send_relay_settings(Some(&link));
        if self.st().update_notice.is_some() {
            self.send_update_notice(&link);
        }
        for tab in own {
            self.refresh_presentation(tab, true);
        }
        let sweep = self.st().swept.insert(link.key.clone());
        if sweep {
            let stale: Vec<i64> = {
                let st = self.st();
                st.tabs.values().filter(|t| t.link_key == link.key && t.owner == Owner::Relay && t.session.as_ref().is_some_and(|s| !st.sessions.contains_key(s))).map(|t| t.id).collect()
            };
            for tab in stale {
                let _ = self.close_or_release(tab).await;
            }
        }
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
            let mine: Vec<(i64, String, Option<String>, Owner)> =
                st.tabs.values().filter(|t| t.link_key == link.key).map(|t| (t.id, t.target_id.clone(), t.session.clone(), t.owner)).collect();
            for (_, target, session, owner) in &mine {
                if let Some(session) = session {
                    st.reconnect_owners.insert(target.clone(), KnownOwner { session: session.clone(), owner: *owner, browser: link.key.clone() });
                }
            }
            mine.into_iter().map(|(id, ..)| id).collect()
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
        if !self.st().tabs.contains_key(&tab) {
            return;
        }
        match reason {
            "target_closed" => {
                let renewed = params.get("reattached") == Some(&Value::Bool(true));
                let (owner, session) = {
                    let st = self.st();
                    let Some(entry) = st.tabs.get(&tab) else { return };
                    (entry.owner, entry.session.clone())
                };
                if renewed {
                    rlog!("debugger.renewed", tabId = tab);
                    let mut attach = Attach::new(tab, owner, session);
                    attach.already_attached = true;
                    if self.setup_tab(attach).await.is_err() {
                        self.remove_tab(tab, Release { update_extension: true, ..Release::default() }, "renew-failed");
                    }
                    return;
                }
                for delay in [50u64, 100, 150] {
                    tokio::time::sleep(Duration::from_millis(delay)).await;
                    if self.debugger(tab, None, "Target.getTargetInfo", json!({}), Some(INVENTORY_TIMEOUT)).await.is_ok() {
                        return;
                    }
                }
                self.remove_tab(tab, Release { update_extension: true, gone: true, ..Release::default() }, "debugger-detached");
            }
            "canceled_by_user" => {
                let session = self.st().tabs.get(&tab).and_then(|t| t.session.clone());
                if let Some(session) = session {
                    self.stop_calls(&session, "The user dismissed the browser's debugging bar, which detached browse from their tabs, so this was stopped. Ask the user how to continue.");
                }
                self.remove_tab(tab, Release { update_extension: true, released_by_user: true, ..Release::default() }, "released-by-user");
            }
            _ => self.remove_tab(tab, Release { update_extension: true, gone: true, ..Release::default() }, "debugger-detached"),
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
            let _ = entry.events.send(CdpEvent { method: method.clone(), params: event_params.clone(), session_id: source.clone() });
        }
        return_follow_up(self, tab, follow_up);
        if crashed {
            let (link, sessions) = {
                let mut st = self.st();
                let sessions: Vec<String> = st.handoffs.iter().filter(|(_, h)| h.tab == tab).map(|(s, _)| s.clone()).collect();
                for session in &sessions {
                    if let Some(mut handoff) = st.handoffs.remove(session) {
                        handoff.done.take().map(|d| d.send("closed"));
                    }
                }
                (st.browser_tab(tab), sessions)
            };
            if let Some((link, local)) = link {
                link.reject_tab(local, &format!("Target crashed: tab {tab}"));
            }
            for session in sessions {
                self.refresh_session_presentation(&session);
            }
        }
        if source.is_none() {
            self.observe_navigation(tab, &method, &event_params, committed);
        }
    }

    /// The session allowlist on a tab's own navigations (cli/src/session-manager/navigation-guard.ts).
    fn observe_navigation(self: &Arc<Self>, tab: i64, method: &str, params: &Value, committed: Option<String>) {
        if !matches!(method, "Page.frameNavigated" | "Page.frameRequestedNavigation" | "Page.frameStartedNavigating" | "Network.responseReceived") {
            return;
        }
        let Some((session, rules, main_frame)) = self.enforced(tab) else { return };
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
                    self.allowlist_violation(tab, &session, url, &format!("its document came from the private address {address} (name it exactly in the allowlist to allow it)"));
                }
            }
            _ => {
                if params.get("frameId").and_then(Value::as_str) != Some(main_frame.as_str()) {
                    return;
                }
                let Some(url) = params.get("url").and_then(Value::as_str) else { return };
                if let domain::UrlDecision::Refused(reason) = domain::check_url(url, &rules, false) {
                    self.debugger_best_effort(tab, None, "Page.stopLoading", json!({}));
                    if let Some(entry) = self.st().sessions.get_mut(&session) {
                        entry.add_warning(format!(
                            "Domain allowlist: a tab of session {session} started to navigate to {}, but {reason}; browse stopped it. Ask the user before widening the allowlist.",
                            short_url(url)
                        ));
                    }
                    rlog!("allowlist.stopped", tabId = tab, session = session, method = method, reason = reason);
                }
            }
        }
    }

    /// The session, its rules and the main frame, when the tab's allowlist applies now (a lent tab only while its
    /// session is busy).
    fn enforced(&self, tab: i64) -> Option<(String, Vec<domain::OriginRule>, String)> {
        let (session, owner, main_frame) = {
            let st = self.st();
            let entry = st.tabs.get(&tab)?;
            (entry.session.clone()?, entry.owner, entry.main_frame.clone().unwrap_or_else(|| entry.target_id.clone()))
        };
        let rules = self.session_rules(Some(&session))?;
        if owner == Owner::User && !self.st().sessions.get(&session).is_some_and(|s| s.busy()) {
            return None;
        }
        Some((session, rules, main_frame))
    }

    pub fn check_committed_url(self: &Arc<Self>, tab: i64, url: &str) -> bool {
        let Some((session, rules, _)) = self.enforced(tab) else { return true };
        match domain::check_url(url, &rules, false) {
            domain::UrlDecision::Allowed { .. } => {
                if !url.starts_with("about:")
                    && let Some(entry) = self.st().tabs.get_mut(&tab) {
                        entry.fresh_popup = false;
                    }
                true
            }
            domain::UrlDecision::Refused(reason) => {
                self.allowlist_violation(tab, &session, url, &reason);
                false
            }
        }
    }

    fn allowlist_violation(self: &Arc<Self>, tab: i64, session: &str, url: &str, reason: &str) {
        let popup = {
            let mut st = self.st();
            let Some(entry) = st.tabs.get_mut(&tab) else { return };
            let popup = entry.fresh_popup && entry.owner == Owner::Relay;
            entry.fresh_popup = false;
            popup
        };
        let action = if popup { "closed the popup" } else { "sent the tab back to about:blank" };
        if let Some(entry) = self.st().sessions.get_mut(session) {
            entry.add_warning(format!(
                "Domain allowlist: a tab of session {session} went to {}, but {reason}; browse {action}. Ask the user before widening the allowlist.",
                short_url(url)
            ));
        }
        rlog!("allowlist.violation", tabId = tab, session = session, url = short_url(url), popup = popup);
        let relay = self.clone();
        tokio::spawn(async move {
            if popup {
                let _ = relay.close_or_release(tab).await;
                return;
            }
            let _ = relay.debugger(tab, None, "Page.stopLoading", json!({}), Some(Duration::from_secs(3))).await;
            let _ = relay.debugger(tab, None, "Page.navigate", json!({ "url": "about:blank" }), Some(Duration::from_secs(10))).await;
        });
    }
}

fn return_follow_up(relay: &Arc<Relay>, tab: i64, commands: Vec<(Option<String>, &'static str, Value)>) {
    for (session, method, params) in commands {
        relay.debugger_best_effort(tab, session, method, params);
    }
}
