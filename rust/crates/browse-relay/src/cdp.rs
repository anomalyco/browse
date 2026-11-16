//! One tab's CDP connection: commands go through the extension's chrome.debugger (child sessions by their
//! sessionId), after the relay's guardrails and the tab's allowlist; events come from the tab's broadcast.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use browse_core::{Cdp, CdpError, CdpEvent, TabId};
use serde_json::{Value, json};
use tokio::sync::broadcast;

use crate::link::RpcError;
use crate::relay::Relay;

pub struct TabCdp {
    pub relay: Arc<Relay>,
    pub tab: TabId,
    pub events: broadcast::WeakSender<CdpEvent>,
}

fn cdp_error(error: RpcError) -> CdpError {
    match error {
        RpcError::NotConnected(_) => CdpError::Disconnected,
        RpcError::Timeout(message) => {
            let ms = message.split("after ").nth(1).and_then(|rest| rest.split("ms").next()).and_then(|n| n.trim().parse().ok());
            match ms {
                Some(ms) => CdpError::Timeout(ms),
                None => CdpError::Protocol(message),
            }
        }
        RpcError::Remote(message) if crate::relay::missing_tab(&message) || message.contains("Debugger is not attached") => CdpError::TargetClosed,
        RpcError::Remote(message) => CdpError::Protocol(message),
        RpcError::Closed(message) if message.contains("Target closed") || message.contains("crashed") => CdpError::TargetClosed,
        RpcError::Closed(_) => CdpError::Disconnected,
    }
}

impl TabCdp {
    /// Chrome doesn't announce targets the relay's own auto-attach already attached: replay them.
    fn replay_children(&self) {
        let st = self.relay.st();
        let Some(tab) = st.tabs.get(&self.tab) else { return };
        for (session, child) in &tab.children {
            let params = json!({
                "sessionId": session,
                "targetInfo": { "targetId": child.target_id, "type": child.kind, "url": child.url, "title": "", "attached": true, "canAccessOpener": false },
                "waitingForDebugger": false,
            });
            let _ = tab.events.send(CdpEvent { method: "Target.attachedToTarget".into(), params, session_id: None });
        }
    }

    /// The pages cookies and storage may be used for: this tab's, its opener's and popups', and its group's.
    fn page_urls(&self) -> Vec<String> {
        let st = self.relay.st();
        let Some(me) = st.tabs.get(&self.tab) else { return Vec::new() };
        let group = me.options.group.clone();
        st.tabs
            .values()
            .filter(|t| t.id == self.tab || t.opener == Some(self.tab) || me.opener == Some(t.id) || (group.is_some() && t.owner == crate::relay::Owner::Relay && t.options.group == group))
            .map(|t| t.url.clone())
            .collect()
    }

    /// A background tab's screenshot can wait for a frame that never comes; tiny screenshots nudge it along.
    async fn screenshot(&self, params: Value) -> Result<Value, RpcError> {
        let mut nudge = params.clone();
        nudge["format"] = "jpeg".into();
        nudge["quality"] = 1.into();
        if nudge.get("clip").is_some()
            && let Some(object) = nudge.as_object_mut() {
                object.remove("captureBeyondViewport");
            }
        let relay = self.relay.clone();
        let tab = self.tab;
        let nudges = async move {
            for delay in [600u64, 1_000, 1_500, 2_000, 3_000, 5_000, 8_000] {
                tokio::time::sleep(Duration::from_millis(delay)).await;
                crate::rlog!("screenshot.nudge", tabId = tab, afterMs = delay);
                let relay = relay.clone();
                let nudge = nudge.clone();
                tokio::spawn(async move {
                    let _ = relay.debugger(tab, None, "Page.captureScreenshot", nudge, None).await;
                });
            }
            std::future::pending::<()>().await;
        };
        tokio::select! {
            result = self.relay.debugger(self.tab, None, "Page.captureScreenshot", params, None) => result,
            _ = nudges => unreachable!(),
        }
    }
}

#[async_trait]
impl Cdp for TabCdp {
    async fn send(&self, method: &str, params: Value, session_id: Option<&str>) -> Result<Value, CdpError> {
        let params = if params.is_null() { json!({}) } else { params };
        let options = {
            let st = self.relay.st();
            let Some(tab) = st.tabs.get(&self.tab) else { return Err(CdpError::TargetClosed) };
            if tab.crashed {
                return Err(CdpError::Protocol(format!("Target crashed: tab {}", self.tab)));
            }
            tab.options.clone()
        };
        if let Some(refusal) = crate::guardrails::guard(method, &params, options.read_only, &|| self.page_urls()) {
            return Err(CdpError::Protocol(refusal));
        }
        let url = params.get("url").and_then(Value::as_str).unwrap_or("about:blank").to_string();
        match method {
            "Target.createTarget" => {
                let tab = self.relay.create_tab(Some(&url), &options, Some(self.tab), None).await.map_err(|e| CdpError::Protocol(e.to_string()))?;
                let target = self.relay.st().tabs.get(&tab).map(|t| t.target_id.clone()).unwrap_or_default();
                return Ok(json!({ "targetId": target, "tabId": tab }));
            }
            "Target.closeTarget" => {
                let target = params.get("targetId").and_then(Value::as_str).unwrap_or("");
                let found = {
                    let st = self.relay.st();
                    st.tabs.values().find(|t| t.target_id == target).map(|t| t.id)
                };
                let Some(tab) = found else { return Ok(json!({ "success": false })) };
                let outcome = self.relay.close_or_release(tab).await.map_err(|e| CdpError::Protocol(e.to_string()))?;
                return Ok(json!({ "success": true, "released": outcome == "released" }));
            }
            "Page.close" => {
                // Playwright sends this for page.close({ runBeforeUnload: true }). Forwarded to the debugger it would
                // close the tab directly, so close-or-release the tab the way Target.closeTarget does. None is the
                // tab's own page session; a child frame or worker session can't close the page.
                if let Some(session) = session_id {
                    return Err(CdpError::Protocol(format!("Page.close needs the tab's own page session, not child session {session}")));
                }
                self.relay.close_or_release(self.tab).await.map_err(|e| CdpError::Protocol(e.to_string()))?;
                return Ok(json!({}));
            }
            "Page.navigate" if session_id.is_none() => {
                if let Some(refusal) = self.relay.navigation_refusal(&options, Some(self.tab), method, &url).await {
                    return Err(CdpError::Protocol(refusal));
                }
            }
            _ => {}
        }
        if let Some(tab) = self.relay.st().tabs.get_mut(&self.tab) {
            tab.touch();
        }
        if session_id.is_none() {
            self.relay.focus_for_call(self.tab).await;
        }
        let params = if method == "Emulation.setFocusEmulationEnabled" && session_id.is_none() {
            json!({ "enabled": self.relay.st().tabs.get(&self.tab).is_some_and(|t| t.focused) })
        } else {
            params
        };
        let auto_attach = method == "Target.setAutoAttach" && session_id.is_none() && params["autoAttach"] == true;
        let result = if method == "Page.captureScreenshot" && session_id.is_none() {
            self.screenshot(params).await
        } else {
            self.relay.debugger(self.tab, session_id, method, params, None).await
        };
        let result = result.map_err(cdp_error)?;
        if auto_attach {
            self.replay_children();
        }
        Ok(crate::guardrails::scope_result(method, result, &|| self.page_urls()))
    }

    fn events(&self) -> broadcast::Receiver<CdpEvent> {
        match self.events.upgrade() {
            Some(sender) => sender.subscribe(),
            None => broadcast::channel(1).1,
        }
    }
}
