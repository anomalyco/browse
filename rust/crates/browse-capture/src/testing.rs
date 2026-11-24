//! A scripted CDP connection and browser for unit tests: events are pushed by the test, commands are recorded and
//! answered from a table, and dropping the event sender closes the stream like a closed tab.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use browse_cdp::{Cdp, CdpError, CdpEvent};
use browse_core::{Browser, HandoffResult, TabDriver, TabId, TabInfo, TabOptions, TabState, ToolContext};
use serde_json::{Value, json};
use tokio::sync::broadcast;

#[derive(Default)]
pub(crate) struct FakeCdp {
    events: Mutex<Option<broadcast::Sender<CdpEvent>>>,
    pub sent: Mutex<Vec<(String, Value, Option<String>)>>,
    pub replies: Mutex<HashMap<String, Value>>,
}

impl FakeCdp {
    pub fn new() -> Arc<Self> {
        let cdp = Self::default();
        *cdp.events.lock().unwrap() = Some(broadcast::channel(1024).0);
        Arc::new(cdp)
    }

    pub fn emit(&self, method: &str, params: Value, session: Option<&str>) {
        if let Some(sender) = self.events.lock().unwrap().as_ref() {
            let _ = sender.send(CdpEvent { method: method.into(), params, session_id: session.map(str::to_string) });
        }
    }

    /// Closes the event stream, as the relay does when the tab goes away.
    pub fn close(&self) {
        self.events.lock().unwrap().take();
    }

    pub fn reply(&self, method: &str, value: Value) {
        self.replies.lock().unwrap().insert(method.into(), value);
    }

    pub fn calls(&self, method: &str) -> Vec<(Value, Option<String>)> {
        self.sent.lock().unwrap().iter().filter(|(m, _, _)| m == method).map(|(_, p, s)| (p.clone(), s.clone())).collect()
    }
}

#[async_trait]
impl Cdp for FakeCdp {
    async fn send(&self, method: &str, params: Value, session_id: Option<&str>) -> Result<Value, CdpError> {
        self.sent.lock().unwrap().push((method.into(), params, session_id.map(str::to_string)));
        if self.events.lock().unwrap().is_none() {
            return Err(CdpError::TargetClosed);
        }
        Ok(self.replies.lock().unwrap().get(method).cloned().unwrap_or_else(|| json!({})))
    }

    fn events(&self) -> broadcast::Receiver<CdpEvent> {
        match self.events.lock().unwrap().as_ref() {
            Some(sender) => sender.subscribe(),
            None => broadcast::channel(1).1,
        }
    }
}

pub(crate) struct FakeBrowser {
    driver: Arc<dyn TabDriver>,
    state: Arc<TabState>,
}

#[async_trait]
impl Browser for FakeBrowser {
    async fn open_tab(&self, _: Option<&str>, _: &TabOptions) -> anyhow::Result<TabInfo> {
        anyhow::bail!("not in tests")
    }
    async fn tabs(&self) -> anyhow::Result<Vec<TabInfo>> {
        Ok(vec![tab()])
    }
    async fn close_tab(&self, _: TabId) -> anyhow::Result<()> {
        Ok(())
    }
    async fn tab_driver(&self, _: TabId) -> anyhow::Result<Arc<dyn TabDriver>> {
        Ok(self.driver.clone())
    }
    async fn state(&self, _: TabId) -> anyhow::Result<Arc<TabState>> {
        Ok(self.state.clone())
    }
    async fn handoff(&self, _: TabId, _: &str) -> anyhow::Result<HandoffResult> {
        anyhow::bail!("not in tests")
    }
    async fn read_only(&self, _: TabId) -> bool {
        false
    }
}

fn tab() -> TabInfo {
    TabInfo { tab: 1, url: String::new(), title: String::new(), lent: false, opener: None, chosen: None, last_used: None, busy: false, handoff: None, options: TabOptions::default() }
}

pub(crate) fn context(cdp: Arc<FakeCdp>, roots: Vec<std::path::PathBuf>) -> ToolContext {
    let driver: Arc<dyn TabDriver> = browse_cdp::CdpTabDriver::new(cdp);
    ToolContext { browser: Arc::new(FakeBrowser { driver, state: Arc::new(TabState::default()) }), file_roots: roots }
}

/// Calls a tool in the fake's one tab (`tab` 1 unless the arguments name one; `"tab": null` leaves it out).
pub(crate) async fn call(ctx: &ToolContext, tool: &dyn browse_core::Tool, mut args: Value) -> (bool, Value) {
    if let Some(map) = args.as_object_mut() {
        match map.get("tab") {
            None => {
                map.insert("tab".into(), json!(1));
            }
            Some(Value::Null) => {
                map.remove("tab");
            }
            Some(_) => {}
        }
    }
    let output = tool.call(ctx.clone(), args).await.unwrap();
    let text = output
        .content
        .iter()
        .find_map(|content| match content {
            browse_core::Content::Text { text } => Some(text.clone()),
            _ => None,
        })
        .unwrap_or_default();
    (output.is_error, serde_json::from_str(&text).unwrap_or(Value::String(text)))
}

/// Lets spawned tasks run.
pub(crate) async fn settle() {
    for _ in 0..20 {
        tokio::task::yield_now().await;
    }
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
}
