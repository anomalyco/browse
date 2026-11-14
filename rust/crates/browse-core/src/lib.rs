//! Shared contracts between the browse crates. Nothing here talks to a browser: the relay implements `Browser` and
//! `Cdp`, the page and capture crates implement `Tool`s on top of them, and the binary wires everything together.

use std::any::Any;
use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::{Mutex, broadcast};

pub type SessionId = String;
pub type TabId = i64;

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

/// One tab's Chrome DevTools Protocol connection, routed through the extension's chrome.debugger.
#[async_trait]
pub trait Cdp: Send + Sync {
    async fn send(&self, method: &str, params: Value, session_id: Option<&str>) -> Result<Value, CdpError>;
    fn events(&self) -> broadcast::Receiver<CdpEvent>;
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TabInfo {
    pub tab_id: TabId,
    pub url: String,
    pub title: String,
    pub active: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HandoffResult {
    /// "continued", "cancelled", "closed" or "timeout".
    pub outcome: String,
    pub note: Option<String>,
}

/// What the relay offers tools: a session's tabs and the user-facing pieces only the extension can do.
#[async_trait]
pub trait Browser: Send + Sync {
    async fn tabs(&self, session: &SessionId) -> anyhow::Result<Vec<TabInfo>>;
    /// The session's current tab, opening one when it has none.
    async fn current_tab(&self, session: &SessionId) -> anyhow::Result<TabInfo>;
    async fn open_tab(&self, session: &SessionId, url: Option<&str>) -> anyhow::Result<TabInfo>;
    async fn select_tab(&self, session: &SessionId, tab: TabId) -> anyhow::Result<()>;
    async fn close_tab(&self, session: &SessionId, tab: TabId) -> anyhow::Result<()>;
    async fn cdp(&self, session: &SessionId, tab: TabId) -> anyhow::Result<Arc<dyn Cdp>>;
    async fn handoff(&self, session: &SessionId, tab: TabId, message: &str) -> anyhow::Result<HandoffResult>;
}

/// Stored site secrets. Values never leave the relay except to be typed into an allowed origin.
#[async_trait]
pub trait Secrets: Send + Sync {
    /// The secret's value when `origin` is allowed for it.
    async fn reveal(&self, name: &str, origin: &str) -> anyhow::Result<String>;
}

/// Per-session state tools keep between calls (snapshot refs, network capture, ...), keyed by a crate-chosen string.
#[derive(Default)]
pub struct SessionState(Mutex<HashMap<String, Box<dyn Any + Send>>>);

impl SessionState {
    pub fn inner(&self) -> &Mutex<HashMap<String, Box<dyn Any + Send>>> {
        &self.0
    }
}

#[derive(Clone)]
pub struct ToolContext {
    pub session: SessionId,
    pub browser: Arc<dyn Browser>,
    pub secrets: Arc<dyn Secrets>,
    pub state: Arc<SessionState>,
    /// Folders tools may read or write files in (uploads, screenshots, downloads, HAR files).
    pub file_roots: Vec<std::path::PathBuf>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Content {
    Text { text: String },
    Image { data: String, #[serde(rename = "mimeType")] mime_type: String },
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ToolOutput {
    pub content: Vec<Content>,
    #[serde(rename = "isError", default, skip_serializing_if = "std::ops::Not::not")]
    pub is_error: bool,
}

impl ToolOutput {
    pub fn text(text: impl Into<String>) -> Self {
        Self { content: vec![Content::Text { text: text.into() }], is_error: false }
    }
    pub fn error(text: impl Into<String>) -> Self {
        Self { content: vec![Content::Text { text: text.into() }], is_error: true }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolSpec {
    pub name: String,
    pub description: String,
    #[serde(rename = "inputSchema")]
    pub input_schema: Value,
}

#[async_trait]
pub trait Tool: Send + Sync {
    fn spec(&self) -> ToolSpec;
    async fn call(&self, ctx: ToolContext, args: Value) -> anyhow::Result<ToolOutput>;
}

/// `browse mcp` → relay: POST /tools/call. `GET /tools` returns `Vec<ToolSpec>`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCallRequest {
    pub name: String,
    pub arguments: Value,
    pub session: SessionId,
}
