use std::sync::Arc;

use browse_core::{TabId, ToolContext};
use tokio::sync::Mutex;

use crate::{console, network, page, recording};

const KEY: &str = "browse-capture";

/// Everything browse-capture keeps for one tab. Dropping it (the tab is long gone) stops its background tasks.
#[derive(Default)]
pub(crate) struct CaptureState {
    pub network: Mutex<network::NetworkState>,
    pub console: Mutex<console::ConsoleState>,
    pub recording: Arc<Mutex<recording::RecordingState>>,
    pub worlds: Mutex<page::Worlds>,
}

/// browse-capture's state of the tab.
pub(crate) async fn get(ctx: &ToolContext, tab: TabId) -> anyhow::Result<Arc<CaptureState>> {
    Ok(ctx.state(tab).await?.get_or_insert(KEY, || Arc::new(CaptureState::default())).await)
}

/// Aborts a background task when dropped, so a tab's state that goes away takes its captures with it.
pub(crate) struct TaskGuard(Option<tokio::task::AbortHandle>);

impl TaskGuard {
    pub fn new(handle: tokio::task::AbortHandle) -> Self {
        Self(Some(handle))
    }

    pub fn abort(&mut self) {
        if let Some(handle) = self.0.take() {
            handle.abort();
        }
    }

    /// Lets the task run on; for a task that is itself finishing what the guard belongs to.
    pub fn disarm(&mut self) {
        self.0 = None;
    }
}

impl Drop for TaskGuard {
    fn drop(&mut self) {
        if let Some(handle) = self.0.take() {
            handle.abort();
        }
    }
}

/// Marks a background activity in a tab busy for the relay while it lives (`Browser::set_busy`).
pub(crate) struct BusyGuard {
    browser: Arc<dyn browse_core::Browser>,
    tab: TabId,
    key: &'static str,
}

impl BusyGuard {
    pub fn new(ctx: &ToolContext, tab: TabId, key: &'static str) -> Self {
        ctx.browser.set_busy(tab, key, true);
        Self { browser: ctx.browser.clone(), tab, key }
    }
}

impl Drop for BusyGuard {
    fn drop(&mut self) {
        self.browser.set_busy(self.tab, self.key, false);
    }
}
