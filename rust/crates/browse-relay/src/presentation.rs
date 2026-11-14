//! What the extension shows for an agent tab (cli/src/relay/tab-presentation.ts): the page status card, the toolbar
//! badge and the tab group, kept current one tab at a time (the latest state wins); focus emulation while a session
//! works; and handoffs, where the agent waits for the user to finish something in the tab.

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
const IDLE_AFTER_CALL: Duration = Duration::from_millis(1500);

fn desired(st: &State, tab: i64) -> Option<(Value, Value, Value)> {
    let entry = st.tabs.get(&tab)?;
    let owner = if entry.owner == Owner::User { "user" } else { "session" };
    let handoff = st.handoff_for_tab(tab);
    let session_id = handoff.map(|h| h.session.clone()).or_else(|| entry.session.clone());
    let session = session_id.as_ref().and_then(|id| st.sessions.get(id));
    let read_only = session.is_some_and(|s| s.read_only);
    let state = if handoff.is_some() {
        "waiting"
    } else if session.is_some_and(|s| s.busy()) {
        "running"
    } else {
        "attached"
    };
    let mut status = json!({ "state": state, "owner": owner });
    if let Some(id) = &session_id {
        status["sessionId"] = id.clone().into();
        if read_only {
            status["readOnly"] = true.into();
        }
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
    let group = match &entry.session {
        Some(session) => json!({ "method": "tabs.group", "params": { "sessionId": session } }),
        None => json!({ "method": "tabs.ungroup", "params": {} }),
    };
    Some((status, badge, group))
}

impl Relay {
    /// Brings what the extension shows for the tab up to date; `regroup` resends its group even when unchanged.
    pub fn refresh_presentation(self: &Arc<Self>, tab: i64, regroup: bool) {
        let start = {
            let mut st = self.st();
            if !st.tabs.contains_key(&tab) {
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

    pub fn refresh_session_presentation(self: &Arc<Self>, session: &str) {
        let tabs = self.st().session_tabs(session);
        for tab in tabs {
            self.refresh_presentation(tab, false);
        }
    }

    pub fn call_started(self: &Arc<Self>, session: &str, id: u64, abort: tokio::task::AbortHandle) {
        let first = {
            let mut st = self.st();
            let Some(entry) = st.sessions.get_mut(session) else { return };
            entry.touch();
            entry.calls.insert(id, abort);
            entry.calls.len() == 1
        };
        if first {
            self.refresh_session_presentation(session);
        }
    }

    pub fn call_finished(self: &Arc<Self>, session: &str, id: u64) {
        let epoch = {
            let mut st = self.st();
            let Some(entry) = st.sessions.get_mut(session) else { return };
            entry.calls.remove(&id);
            entry.last_used = std::time::Instant::now();
            if !entry.calls.is_empty() {
                return;
            }
            entry.idle_epoch += 1;
            entry.idle_epoch
        };
        let relay = self.clone();
        let session = session.to_string();
        tokio::spawn(async move {
            tokio::time::sleep(IDLE_AFTER_CALL).await;
            let idle = relay.st().sessions.get(&session).is_some_and(|s| s.calls.is_empty() && s.idle_epoch == epoch);
            if idle {
                relay.release_focus(&session, false);
                relay.refresh_session_presentation(&session);
            }
        });
    }

    /// Ends the session's running calls; their callers get `message`.
    pub fn stop_calls(&self, session: &str, message: &str) {
        let mut st = self.st();
        let Some(entry) = st.sessions.get_mut(session) else { return };
        if entry.calls.is_empty() {
            return;
        }
        let own = crate::serve::CALL.try_with(|id| *id).ok();
        entry.stopped = Some(message.to_string());
        for (id, abort) in &entry.calls {
            if Some(*id) != own {
                abort.abort();
            }
        }
    }

    /// While a session works in a tab, the page sees it focused, so background tabs aren't throttled.
    pub async fn focus_for_call(&self, tab: i64, session: &str) {
        let needed = {
            let mut st = self.st();
            let busy = st.sessions.get(session).is_some_and(|s| s.busy());
            match st.tabs.get_mut(&tab) {
                Some(entry) if busy && !entry.focused => {
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

    /// Drops the focus a session's work held; a keepVisible session keeps it on its own tabs unless `all`.
    pub fn release_focus(&self, session: &str, all: bool) {
        let tabs: Vec<i64> = {
            let mut st = self.st();
            let keep = !all && st.sessions.get(session).is_some_and(|s| s.keep_visible);
            st.tabs
                .values_mut()
                .filter(|t| t.focused && t.session.as_deref() == Some(session) && !(keep && t.owner == Owner::Relay))
                .map(|t| {
                    t.focused = false;
                    t.last_used = std::time::Instant::now();
                    t.id
                })
                .collect()
        };
        for tab in tabs {
            self.debugger_best_effort(tab, None, "Emulation.setFocusEmulationEnabled", json!({ "enabled": false }));
        }
    }

    /// Shows the user a card in the tab and waits until they click Continue (or the toolbar button), the time runs
    /// out, the tab goes away, or the session is stopped.
    pub async fn run_handoff(self: &Arc<Self>, session: &str, tab: i64, message: &str, timeout: Duration) -> anyhow::Result<HandoffResult> {
        let message = message.trim();
        let message = if message.is_empty() { "Finish this step in the tab, then click Continue" } else { message };
        let (done, outcome) = oneshot::channel();
        let id = crate::util::random_hex(16);
        let status = {
            let mut st = self.st();
            let Some(entry) = st.tabs.get(&tab) else { bail!("Tab {tab} isn't attached") };
            if entry.session.as_deref().is_some_and(|s| s != session) {
                bail!("Tab {tab} belongs to another session");
            }
            let target_id = entry.target_id.clone();
            if let Some(mut previous) = st.handoffs.remove(session) {
                previous.done.take().map(|d| d.send("cancelled"));
            }
            st.handoffs.insert(
                session.to_string(),
                Handoff {
                    id: id.clone(),
                    session: session.to_string(),
                    tab,
                    target_id,
                    message: message.to_string(),
                    started_at: crate::util::now_iso(),
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
        rlog!("handoff.started", tabId = tab, session = session);
        if let Err(error) = self.ext_tab(tab, "pageStatus.set", json!({ "status": status })).await {
            self.finish_handoff_id(session, &id, "cancelled");
            self.refresh_presentation(tab, false);
            bail!("Couldn't show the handoff in tab {tab}: {error}");
        }
        let outcome = match tokio::time::timeout(timeout, outcome).await {
            Ok(Ok(outcome)) => outcome,
            Ok(Err(_)) => "cancelled",
            Err(_) => "timeout",
        };
        self.finish_handoff_id(session, &id, outcome);
        rlog!("handoff.finished", tabId = tab, session = session, outcome = outcome);
        self.refresh_presentation(tab, false);
        Ok(HandoffResult { outcome: outcome.to_string(), note: None })
    }

    fn finish_handoff_id(&self, session: &str, id: &str, outcome: &'static str) {
        let mut st = self.st();
        if st.handoffs.get(session).is_some_and(|h| h.id == id)
            && let Some(mut handoff) = st.handoffs.remove(session) {
                handoff.done.take().map(|d| d.send(outcome));
            }
    }

    pub fn finish_handoff(self: &Arc<Self>, session: &str, outcome: &'static str) {
        let tab = {
            let mut st = self.st();
            let Some(mut handoff) = st.handoffs.remove(session) else { return };
            handoff.done.take().map(|d| d.send(outcome));
            handoff.tab
        };
        self.refresh_presentation(tab, false);
    }

    /// The page's Continue button (`handoff.completed`): only the waiter named by its id and tab.
    pub fn complete_handoff(self: &Arc<Self>, tab: i64, id: &str) {
        let session = self.st().handoffs.values().find(|h| h.id == id && h.tab == tab).map(|h| h.session.clone());
        if let Some(session) = session {
            rlog!("handoff.completed", tabId = tab, from = "page");
            self.finish_handoff(&session, "continued");
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
