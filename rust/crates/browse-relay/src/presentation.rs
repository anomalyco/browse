//! What the extension shows for an agent tab (cli/src/relay/tab-presentation.ts): the page status card, the toolbar
//! badge and the tab group, kept current one tab at a time (the latest state wins); focus emulation while a call
//! works in a tab; and handoffs, where the agent waits for the user to finish something in the tab.

use std::sync::Arc;
use std::time::Duration;

use anyhow::bail;
use browse_core::HandoffResult;
use serde_json::{Value, json};
use tokio::sync::oneshot;

use crate::link::Link;
use crate::relay::{Handoff, Owner, Relay, State};
use crate::rlog;

pub const DEFAULT_HANDOFF_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// What a call its client cancelled answers (the client doesn't wait for it).
const CANCELLED: &str = "The call was cancelled by its client.";
/// How long a cancel that arrived before its call is remembered.
const CANCELLED_KEY_TTL: Duration = Duration::from_secs(60);
const IDLE_AFTER_CALL: Duration = Duration::from_millis(1500);

/// The page status, badge and group the extension should show. An agent tab is grouped by its `group` label (the
/// extension's Grouping setting decides whether that is a group of its own, the shared agent group or none); a lent
/// tab stays where the user has it. The status names the group as `sessionId`, which the extension shows as the
/// agent's name.
fn desired(st: &State, tab: i64) -> Option<(Value, Value, Value)> {
    let entry = st.tabs.get(&tab)?;
    let agent = entry.owner == Owner::Relay;
    let handoff = st.handoff_for_tab(tab);
    let read_only = entry.options.read_only;
    let state = if handoff.is_some() {
        "waiting"
    } else if st.tab_busy(tab) {
        "running"
    } else {
        "attached"
    };
    let mut status = json!({ "state": state, "owner": if agent { "session" } else { "user" } });
    if let Some(group) = entry.options.group.as_ref().filter(|_| agent) {
        status["sessionId"] = group.clone().into();
    }
    if read_only {
        status["readOnly"] = true.into();
    }
    if let Some(handoff) = handoff {
        status["message"] = handoff.message.clone().into();
        status["handoffId"] = handoff.id.clone().into();
    }
    let badge = match (state, handoff) {
        ("waiting", Some(h)) => json!({ "text": "WAIT", "color": "#2563eb", "title": format!("browse is waiting for you: {} Click here when you're done.", h.message) }),
        ("running", _) if !read_only => json!({ "text": "RUN", "color": "#f59e0b", "title": "browse is working in this tab. Click to stop it and take this tab back." }),
        _ => json!({ "text": "ON", "color": "#7c3aed", "title": "Detach from browse" }),
    };
    let group = match (agent, &entry.options.group) {
        (true, Some(group)) => json!({ "method": "tabs.group", "params": { "sessionId": group } }),
        (true, None) => json!({ "method": "tabs.group", "params": {} }),
        (false, _) => json!({ "method": "tabs.ungroup", "params": {} }),
    };
    Some((status, badge, group))
}

struct PendingHandoff {
    relay: Arc<Relay>,
    id: String,
    tab: i64,
    armed: bool,
}

impl PendingHandoff {
    fn done(&mut self) {
        self.armed = false;
    }
}

impl Drop for PendingHandoff {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        if self.relay.st().handoffs.get(&self.tab).is_some_and(|h| h.id == self.id) {
            rlog!("handoff.finished", tabId = self.tab, outcome = "cancelled", reason = "call stopped");
        }
        self.relay.finish_handoff_id(self.tab, &self.id, "cancelled");
        if tokio::runtime::Handle::try_current().is_ok() {
            self.relay.refresh_presentation(self.tab, false);
        }
    }
}

/// Takes a direct tab's handoff card down when its handoff ends, however it ends.
struct CardGuard {
    driver: Arc<dyn browse_core::TabDriver>,
    id: String,
}

impl Drop for CardGuard {
    fn drop(&mut self) {
        let driver = self.driver.clone();
        let id = self.id.clone();
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move {
                let _ = tokio::time::timeout(Duration::from_secs(2), crate::handoff_card::remove(driver, &id)).await;
            });
        }
    }
}

impl Relay {
    /// Brings what the extension shows for the tab up to date; `regroup` resends its group even when unchanged.
    pub fn refresh_presentation(self: &Arc<Self>, tab: i64, regroup: bool) {
        let start = {
            let mut st = self.st();
            // A direct tab has no extension to show a status, badge or group.
            if st.tabs.get(&tab).is_none_or(|t| t.backend.is_direct()) {
                return;
            }
            let presented = st.presented.entry(tab).or_default();
            presented.dirty = true;
            if regroup {
                presented.group = None;
                presented.status = None;
            }
            !std::mem::replace(&mut presented.busy, true)
        };
        if !start {
            return;
        }
        let relay = self.clone();
        tokio::spawn(async move {
            loop {
                let work = {
                    let mut st = relay.st();
                    let wanted = desired(&st, tab);
                    let Some(presented) = st.presented.get_mut(&tab) else { return };
                    if !presented.dirty {
                        presented.busy = false;
                        return;
                    }
                    presented.dirty = false;
                    let Some((status, badge, group)) = wanted else {
                        presented.busy = false;
                        return;
                    };
                    let status = (presented.status.as_ref() != Some(&status)).then(|| status.clone());
                    let badge = (presented.badge.as_ref() != Some(&badge)).then(|| badge.clone());
                    let group = (presented.group.as_ref() != Some(&group)).then(|| group.clone());
                    (status, badge, group)
                };
                let (status, badge, group) = work;
                if let Some(badge) = badge
                    && relay.ext_tab(tab, "action.setBadge", badge.clone()).await.is_ok() {
                        relay.st().presented.entry(tab).or_default().badge = Some(badge);
                    }
                if let Some(status) = status
                    && relay.ext_tab(tab, "pageStatus.set", json!({ "status": status })).await.is_ok() {
                        relay.st().presented.entry(tab).or_default().status = Some(status);
                    }
                if let Some(group) = group {
                    let method = if group["method"] == "tabs.group" { "tabs.group" } else { "tabs.ungroup" };
                    if relay.ext_tab(tab, method, group["params"].clone()).await.is_ok() {
                        relay.st().presented.entry(tab).or_default().group = Some(group);
                    }
                }
            }
        });
    }

    pub fn call_started(self: &Arc<Self>, id: u64, abort: tokio::task::AbortHandle, pid: Option<u32>, key: Option<String>) {
        let mut st = self.st();
        if key.as_ref().is_some_and(|key| st.cancelled_calls.remove(key).is_some()) {
            st.stopped.insert(id, CANCELLED.into());
            abort.abort();
        }
        st.calls.insert(id, crate::registry::RunningCall { abort, pid, key, tabs: std::collections::HashSet::new() });
        if let Some(pid) = pid {
            st.clients.insert(pid);
        }
    }

    /// The call ended: returns the tabs it used. A tab with nothing left running goes idle shortly (focus released,
    /// the extension shows it attached again), unless another call starts in it first.
    pub fn call_finished(self: &Arc<Self>, id: u64) -> Vec<i64> {
        let (tabs, idle): (Vec<i64>, Vec<(i64, u64)>) = {
            let mut st = self.st();
            st.stopped.remove(&id);
            st.chosen_calls.remove(&id);
            let Some(call) = st.calls.remove(&id) else { return Vec::new() };
            let mut tabs: Vec<i64> = call.tabs.into_iter().collect();
            tabs.sort();
            let quiet: Vec<i64> = tabs.iter().copied().filter(|tab| !st.tab_busy(*tab)).collect();
            let mut idle = Vec::new();
            for tab in quiet {
                if let Some(entry) = st.tabs.get_mut(&tab) {
                    entry.touch();
                    entry.idle_epoch += 1;
                    idle.push((tab, entry.idle_epoch));
                }
            }
            (tabs, idle)
        };
        if !idle.is_empty() {
            let relay = self.clone();
            tokio::spawn(async move {
                tokio::time::sleep(IDLE_AFTER_CALL).await;
                for (tab, epoch) in idle {
                    let still = {
                        let st = relay.st();
                        st.tabs.get(&tab).is_some_and(|t| t.idle_epoch == epoch) && !st.tab_busy(tab)
                    };
                    if still {
                        relay.release_focus(tab, false);
                        relay.refresh_presentation(tab, false);
                    }
                }
            });
        }
        tabs
    }

    /// Stops the call its caller keyed `key` (CALL_HEADER). A call that hasn't started yet is stopped as it starts.
    pub fn cancel_call(&self, key: &str) -> bool {
        let mut st = self.st();
        let picked: Vec<u64> = st.calls.iter().filter(|(_, call)| call.key.as_deref() == Some(key)).map(|(id, _)| *id).collect();
        for id in &picked {
            st.stopped.insert(*id, CANCELLED.into());
            st.calls[id].abort.abort();
        }
        if picked.is_empty() {
            let now = std::time::Instant::now();
            st.cancelled_calls.retain(|_, at| now.duration_since(*at) < CANCELLED_KEY_TTL);
            st.cancelled_calls.insert(key.to_string(), now);
        }
        !picked.is_empty()
    }

    /// Ends the running calls that use the tab (except the one asking); their callers get `message`.
    pub fn stop_calls(&self, tab: i64, message: &str) -> usize {
        self.stop_calls_where(message, |call| call.tabs.contains(&tab))
    }

    /// Ends the running calls `which` picks (never the one asking); their callers get `message`.
    pub fn stop_calls_where(&self, message: &str, which: impl Fn(&crate::registry::RunningCall) -> bool) -> usize {
        let own = crate::serve::CALL.try_with(|id| *id).ok();
        let mut st = self.st();
        let picked: Vec<u64> = st.calls.iter().filter(|(id, call)| Some(**id) != own && which(call)).map(|(id, _)| *id).collect();
        for id in &picked {
            st.stopped.insert(*id, message.to_string());
            st.calls[id].abort.abort();
        }
        picked.len()
    }

    /// While a call works in a tab, the page sees it focused, so background tabs aren't throttled.
    pub async fn focus_for_call(&self, tab: i64) {
        let needed = {
            let mut st = self.st();
            let busy = st.tab_busy(tab);
            match st.tabs.get_mut(&tab) {
                Some(entry) if busy && !entry.focused && !entry.backend.is_direct() => {
                    entry.focused = true;
                    true
                }
                _ => false,
            }
        };
        if needed {
            let _ = self.debugger(tab, None, "Emulation.setFocusEmulationEnabled", json!({ "enabled": true }), Some(Duration::from_secs(3))).await;
        }
    }

    /// Drops the focus a call held; a keepVisible agent tab keeps it unless `all`.
    pub fn release_focus(&self, tab: i64, all: bool) {
        let release = {
            let mut st = self.st();
            match st.tabs.get_mut(&tab) {
                Some(t) if t.focused && (all || !(t.options.keep_visible && t.owner == Owner::Relay)) => {
                    t.focused = false;
                    t.touch();
                    true
                }
                _ => false,
            }
        };
        if release {
            self.debugger_best_effort(tab, None, "Emulation.setFocusEmulationEnabled", json!({ "enabled": false }));
        }
    }

    /// Shows the user a card in the tab and waits until they click Continue (or the toolbar button), the time runs
    /// out, the tab goes away, or the call is stopped.
    pub async fn run_handoff(self: &Arc<Self>, tab: i64, message: &str, timeout: Duration) -> anyhow::Result<HandoffResult> {
        let message = message.trim();
        let message = if message.is_empty() { "Finish this step in the tab, then click Continue" } else { message };
        if self.is_direct_tab(tab) {
            return self.run_direct_handoff(tab, message, timeout).await;
        }
        let (done, outcome) = oneshot::channel();
        let id = crate::util::random_hex(16);
        let status = {
            let mut st = self.st();
            let Some(entry) = st.tabs.get(&tab) else { bail!("Tab {tab} isn't attached") };
            let target_id = entry.target_id.clone();
            if let Some(mut previous) = st.handoffs.remove(&tab) {
                previous.done.take().map(|d| d.send("cancelled"));
            }
            st.handoffs.insert(
                tab,
                Handoff {
                    id: id.clone(),
                    tab,
                    target_id,
                    message: message.to_string(),
                    started_at: crate::util::now_iso(),
                    pid: crate::serve::CLIENT.try_with(|pid| *pid).ok().flatten(),
                    done: Some(done),
                },
            );
            let (status, badge, _) = desired(&st, tab).expect("the tab is attached");
            let presented = st.presented.entry(tab).or_default();
            presented.status = Some(status.clone());
            presented.badge = Some(badge.clone());
            self.ext_best_effort(tab, "action.setBadge", badge);
            status
        };
        rlog!("handoff.started", tabId = tab);
        // A call stopped while it waits (its client went away, the toolbar button) takes its card down with it.
        let mut pending = PendingHandoff { relay: self.clone(), id: id.clone(), tab, armed: true };
        if let Err(error) = self.ext_tab(tab, "pageStatus.set", json!({ "status": status })).await {
            drop(pending);
            bail!("Couldn't show the handoff in tab {tab}: {error}");
        }
        let outcome = match tokio::time::timeout(timeout, outcome).await {
            Ok(Ok(outcome)) => outcome,
            Ok(Err(_)) => "cancelled",
            Err(_) => "timeout",
        };
        pending.done();
        self.finish_handoff_id(tab, &id, outcome);
        rlog!("handoff.finished", tabId = tab, outcome = outcome);
        self.refresh_presentation(tab, false);
        Ok(HandoffResult { outcome: outcome.to_string(), note: None })
    }

    /// A handoff in a directly driven tab: the card is the page's own, drawn by browse's isolated world in a closed
    /// shadow root, and only a real click on it (checked where it lands) counts. The handoff record is the same as the
    /// extension's, so listing, cancelling and holding back agent input work alike.
    async fn run_direct_handoff(self: &Arc<Self>, tab: i64, message: &str, timeout: Duration) -> anyhow::Result<HandoffResult> {
        let (done, outcome) = oneshot::channel();
        let id = crate::util::random_hex(16);
        let raw = {
            let mut st = self.st();
            let Some(entry) = st.tabs.get(&tab) else { bail!("Tab {tab} isn't attached") };
            let Some(raw) = entry.raw_driver.clone() else { bail!("Tab {tab} lost its browser driver") };
            let target_id = entry.target_id.clone();
            if let Some(mut previous) = st.handoffs.remove(&tab) {
                previous.done.take().map(|d| d.send("cancelled"));
            }
            st.handoffs.insert(
                tab,
                Handoff {
                    id: id.clone(),
                    tab,
                    target_id,
                    message: message.to_string(),
                    started_at: crate::util::now_iso(),
                    pid: crate::serve::CLIENT.try_with(|pid| *pid).ok().flatten(),
                    done: Some(done),
                },
            );
            raw
        };
        rlog!("handoff.started", tabId = tab, direct = true);
        let mut pending = PendingHandoff { relay: self.clone(), id: id.clone(), tab, armed: true };
        let _card = CardGuard { driver: raw.clone(), id: id.clone() };
        let deadline = crate::util::now_ms() + timeout.as_millis() as u64;
        let shown = tokio::select! {
            outcome = outcome => Ok(outcome.unwrap_or("cancelled")),
            clicked = crate::handoff_card::run(raw.clone(), &id, message, deadline) => clicked,
            _ = tokio::time::sleep(timeout) => Ok("timeout"),
        };
        let outcome = match shown {
            Ok(outcome) => outcome,
            Err(error) => {
                drop(pending);
                bail!("Couldn't show the handoff in tab {tab}: {error}");
            }
        };
        pending.done();
        self.finish_handoff_id(tab, &id, outcome);
        rlog!("handoff.finished", tabId = tab, outcome = outcome);
        Ok(HandoffResult { outcome: outcome.to_string(), note: None })
    }

    fn finish_handoff_id(&self, tab: i64, id: &str, outcome: &'static str) {
        let mut st = self.st();
        if st.handoffs.get(&tab).is_some_and(|h| h.id == id)
            && let Some(mut handoff) = st.handoffs.remove(&tab) {
                handoff.done.take().map(|d| d.send(outcome));
            }
    }

    /// Cancels the handoffs process `pid` waits for (it exited).
    pub fn finish_client_handoffs(self: &Arc<Self>, pid: u32) {
        let tabs: Vec<i64> = self.st().handoffs.values().filter(|h| h.pid == Some(pid)).map(|h| h.tab).collect();
        for tab in tabs {
            rlog!("handoff.finished", tabId = tab, outcome = "cancelled", reason = "client exited", pid = pid);
            self.finish_handoff(tab, "cancelled");
        }
    }

    pub fn finish_handoff(self: &Arc<Self>, tab: i64, outcome: &'static str) {
        {
            let mut st = self.st();
            let Some(mut handoff) = st.handoffs.remove(&tab) else { return };
            handoff.done.take().map(|d| d.send(outcome));
        }
        self.refresh_presentation(tab, false);
    }

    /// The page's Continue button (`handoff.completed`): only the waiter named by its id and tab.
    pub fn complete_handoff(self: &Arc<Self>, tab: i64, id: &str) {
        let waiting = self.st().handoffs.get(&tab).is_some_and(|h| h.id == id);
        if waiting {
            rlog!("handoff.completed", tabId = tab, from = "page");
            self.finish_handoff(tab, "continued");
        }
    }

    pub fn auto_update_status(&self) -> Value {
        if let Some(status) = &self.auto_update {
            return status();
        }
        let stored = crate::paths::read_json::<Value>(&self.paths.auto_update())
            .and_then(|v| v.get("mode").and_then(Value::as_str).map(str::to_string))
            .filter(|m| matches!(m.as_str(), "on" | "notify" | "off"))
            .unwrap_or_else(|| "on".into());
        let override_mode = match std::env::var("OPENCODE_BROWSER_AUTO_UPDATE").ok().map(|v| v.trim().to_lowercase()).as_deref() {
            Some("on" | "1" | "true") => Some("on"),
            Some("notify") => Some("notify"),
            Some("off" | "0" | "false") => Some("off"),
            _ if std::env::var("OPENCODE_BROWSER_UPDATE_CHECK").is_ok_and(|v| v == "0") => Some("off"),
            _ => None,
        };
        let mut status = json!({ "install": "binary", "cli": "browse", "mode": stored, "effective": override_mode.unwrap_or(&stored), "version": self.version });
        if override_mode.is_some() {
            status["overriddenBy"] = if std::env::var_os("OPENCODE_BROWSER_AUTO_UPDATE").is_some() { "OPENCODE_BROWSER_AUTO_UPDATE" } else { "OPENCODE_BROWSER_UPDATE_CHECK" }.into();
        }
        status
    }

    pub fn store_auto_update_mode(&self, mode: &str) {
        let path = self.paths.auto_update();
        let mut state = crate::paths::read_json::<Value>(&path).filter(Value::is_object).unwrap_or_else(|| json!({}));
        state["mode"] = mode.into();
        let _ = crate::paths::write_private_json(&path, &state);
    }

    /// What the status pages show from the relay: the settings its environment fixes, updates, and its name for them.
    pub fn send_relay_settings(self: &Arc<Self>, only: Option<&Arc<Link>>) {
        let links: Vec<Arc<Link>> = self.st().links.iter().filter(|l| l.connected() && only.is_none_or(|o| Arc::ptr_eq(o, l))).cloned().collect();
        for link in links {
            link.pending_relay_settings.store(false, std::sync::atomic::Ordering::SeqCst);
            let params = json!({
                "overrides": crate::settings::extension_overrides(),
                "autoUpdate": self.auto_update_status(),
                "browser": { "id": link.id, "name": link.name },
            });
            let relay = self.clone();
            tokio::spawn(async move {
                let _ = relay.ext_link(&link, "relay.settings", params).await;
            });
        }
    }

    /// Tells the extension's pages about a newer browse (or that there is none), now and on every reconnect.
    pub fn set_update_notice(self: &Arc<Self>, notice: Option<(String, String)>) {
        self.st().update_notice = notice;
        let links: Vec<Arc<Link>> = self.st().links.iter().filter(|l| l.connected()).cloned().collect();
        for link in links {
            self.send_update_notice(&link);
        }
    }

    pub fn send_update_notice(self: &Arc<Self>, link: &Arc<Link>) {
        let params = match &self.st().update_notice {
            Some((summary, command)) => json!({ "summary": summary, "command": command }),
            None => Value::Null,
        };
        let relay = self.clone();
        let link = link.clone();
        tokio::spawn(async move {
            let _ = relay.ext_link(&link, "update.notice", params).await;
        });
    }

    /// The extension's own settings (its `settings` event after pairing and on every change).
    pub fn apply_extension_settings(self: &Arc<Self>, link: &Arc<Link>, params: &Value) {
        match params.get("humanInput").and_then(Value::as_str) {
            Some("on") => *link.human_input.lock().unwrap() = Some(true),
            Some("off") => *link.human_input.lock().unwrap() = Some(false),
            _ => {}
        }
        if let Some(mode) = params.get("autoUpdate").and_then(Value::as_str).filter(|m| matches!(*m, "on" | "notify" | "off")) {
            self.store_auto_update_mode(mode);
            rlog!("autoupdate.mode", mode = mode);
        }
        rlog!("extension.settings", browser = link.id.clone(), humanInput = if self.human_input_for_link(link) { "on" } else { "off" });
        if link.connected() {
            self.send_relay_settings(None);
        } else {
            link.pending_relay_settings.store(true, std::sync::atomic::Ordering::SeqCst);
        }
    }

    pub fn human_input_for_link(&self, link: &Link) -> bool {
        crate::settings::human_input_override().or(link.human_input()).unwrap_or(true)
    }
}
