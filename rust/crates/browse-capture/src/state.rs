use std::sync::Arc;

use browse_core::ToolContext;
use tokio::sync::Mutex;

use crate::{console, network, page, recording};

const KEY: &str = "browse-capture";

/// Everything browse-capture keeps for one session. Dropping it (the session ends) stops its background tasks.
#[derive(Default)]
pub(crate) struct CaptureState {
    pub network: Mutex<network::NetworkState>,
    pub console: Mutex<console::ConsoleState>,
    pub recording: Arc<Mutex<recording::RecordingState>>,
    pub worlds: Mutex<page::Worlds>,
}

pub(crate) async fn get(ctx: &ToolContext) -> Arc<CaptureState> {
    let mut map = ctx.state.inner().lock().await;
    let entry = map.entry(KEY.to_string()).or_insert_with(|| Box::new(Arc::new(CaptureState::default())));
    match entry.downcast_ref::<Arc<CaptureState>>() {
        Some(state) => state.clone(),
        None => {
            let state = Arc::new(CaptureState::default());
            *entry = Box::new(state.clone());
            state
        }
    }
}

/// Aborts a background task when dropped, so a session that goes away takes its captures with it.
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

/// Marks a background activity of the session busy for the relay while it lives (`Browser::set_busy`).
pub(crate) struct BusyGuard {
    browser: Arc<dyn browse_core::Browser>,
    session: browse_core::SessionId,
    key: &'static str,
}

impl BusyGuard {
    pub fn new(ctx: &ToolContext, key: &'static str) -> Self {
        ctx.browser.set_busy(&ctx.session, key, true);
        Self { browser: ctx.browser.clone(), session: ctx.session.clone(), key }
    }
}

impl Drop for BusyGuard {
    fn drop(&mut self) {
        self.browser.set_busy(&self.session, self.key, false);
    }
}
