//! Low-level Chrome DevTools Protocol transport trait.
//!
//! Implemented by any CDP transport: the Chrome extension's `chrome.debugger` tunnel (`browse-relay::TabCdp`),
//! a direct DevTools WebSocket (standalone/headless Chromium), or scripted test doubles.

use async_trait::async_trait;
use browse_core::{CloseReason, DriverError};
use serde_json::Value;
use tokio::sync::broadcast;

#[derive(Debug, thiserror::Error)]
pub enum CdpError {
    #[error("{0}")]
    Protocol(String),
    #[error("the tab is gone")]
    TargetClosed,
    #[error("the browser isn't connected")]
    Disconnected,
    #[error("timed out after {0} ms")]
    Timeout(u64),
}

#[derive(Debug, Clone)]
pub struct CdpEvent {
    pub method: String,
    pub params: Value,
    /// The child target session the event came from (an out-of-process iframe, a worker); None for the tab itself.
    pub session_id: Option<String>,
}

/// One tab's raw Chrome DevTools Protocol pipe.
#[async_trait]
pub trait Cdp: Send + Sync {
    async fn send(&self, method: &str, params: Value, session_id: Option<&str>) -> Result<Value, CdpError>;
    fn events(&self) -> broadcast::Receiver<CdpEvent>;
}

/// Translates Chrome/CDP error text into typed `DriverError` variants once, at the protocol boundary.
pub(crate) fn map_cdp_error(error: CdpError) -> DriverError {
    match error {
        CdpError::TargetClosed => DriverError::Closed(CloseReason::Closed),
        CdpError::Disconnected => DriverError::Closed(CloseReason::BrowserDisconnected),
        CdpError::Timeout(ms) => DriverError::Timeout(std::time::Duration::from_millis(ms)),
        CdpError::Protocol(message) => classify_protocol_error(message),
    }
}

pub(crate) fn classify_protocol_error(message: String) -> DriverError {
    if message.contains("Detached while handling command")
        || message.contains("Target closed")
        || message.contains("No target with given id")
        || message.contains("Debugger is not attached")
    {
        return DriverError::Closed(CloseReason::Detached(message));
    }
    if is_stale_cdp_message(&message) {
        return DriverError::Stale;
    }
    if message.contains("browse blocked") {
        return DriverError::Refused(message);
    }
    DriverError::Protocol(message)
}

fn is_stale_cdp_message(message: &str) -> bool {
    [
        "Cannot find context with specified id",
        "Execution context was destroyed",
        "Cannot find default execution context",
        "Inspected target navigated or closed",
        "Could not find object with given id",
        "No frame with given id",
        "Frame with the given id was not found",
        "Cannot find object with id",
    ]
    .iter()
    .any(|needle| message.contains(needle))
}
