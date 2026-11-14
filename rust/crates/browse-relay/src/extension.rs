//! Messages from a paired extension: answers to the relay's commands, and its events.

use std::sync::Arc;

use serde_json::Value;

use crate::link::Link;
use crate::protocol::EVENT_METHODS;
use crate::relay::Relay;
use crate::rlog;

pub fn handle(relay: &Arc<Relay>, link: &Arc<Link>, text: &str) {
    let Ok(mut message) = serde_json::from_str::<Value>(text) else { return };
    if !message.is_object() {
        return;
    }
    if message.get("id").is_some_and(Value::is_number) && message.get("method").is_none() {
        link.handle_response(&message);
        return;
    }
    let Some(method) = message.get("method").and_then(Value::as_str).filter(|m| EVENT_METHODS.contains(m)).map(str::to_string) else { return };
    if !link.accepts_commands() {
        return;
    }
    link.note_reply();
    let mut params = message.get_mut("params").map(Value::take).unwrap_or_else(|| Value::Object(Default::default()));
    let tab = {
        let mut st = relay.st();
        let tab = params.get("tabId").and_then(Value::as_i64).map(|local| st.relay_tab_id(&link.key, local));
        if let Some(tab) = tab {
            params["tabId"] = tab.into();
        }
        if let Some(opener) = params.get("openerTabId").and_then(Value::as_i64) {
            params["openerTabId"] = st.relay_tab_id(&link.key, opener).into();
        }
        tab
    };
    match method.as_str() {
        "settings" => relay.apply_extension_settings(link, &params),
        "log" => {
            if let Some(text) = params.get("message").and_then(Value::as_str) {
                rlog!("extension.log", level = params.get("level").and_then(Value::as_str).unwrap_or("log"), message = text);
            }
        }
        "ready" => {
            let relay = relay.clone();
            let link = link.clone();
            tokio::spawn(async move { relay.link_ready(link).await });
        }
        "debugger.attached" => {
            if let Some(tab) = tab {
                relay.queue_inventory(link, tab, params.get("agent") == Some(&Value::Bool(true)));
            }
        }
        "toolbar.clicked" => {
            if let Some(tab) = tab {
                link.announced.lock().unwrap().insert(tab);
                let relay = relay.clone();
                tokio::spawn(async move { relay.toolbar_clicked(tab).await });
            }
        }
        "handoff.completed" => {
            if let (Some(tab), Some(id)) = (tab, params.get("handoffId").and_then(Value::as_str)) {
                relay.complete_handoff(tab, id);
            }
        }
        "pageStatus.requested" => {
            if let Some(tab) = tab {
                if let Some(presented) = relay.st().presented.get_mut(&tab) {
                    presented.status = None;
                }
                relay.refresh_presentation(tab, false);
            }
        }
        "debugger.detached" => {
            if let Some(tab) = tab {
                let relay = relay.clone();
                tokio::spawn(async move { relay.debugger_detached(tab, &params).await });
            }
        }
        "tabs.opened" => {
            if let (Some(tab), Some(opener)) = (tab, params.get("openerTabId").and_then(Value::as_i64)) {
                relay.adopt_opened_tab(tab, opener);
            }
        }
        "tabs.removed" => {
            if let Some(tab) = tab {
                relay.remove_tab(tab, crate::tabs::Release { gone: true, ..Default::default() }, "tab-closed");
            }
        }
        "debugger.event" => {
            if let Some(tab) = tab {
                relay.debugger_event(tab, &params);
            }
        }
        _ => {}
    }
}
