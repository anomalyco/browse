//! Shared contracts between the browse crates. Nothing here talks to a browser: the relay implements `Browser` and
//! `Cdp`, the page and capture crates implement `Tool`s on top of them, and the binary wires everything together.

use std::any::Any;
use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::{Mutex, broadcast};

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

/// How an agent tab is opened, kept with it for its life (and across relay restarts). Popups a tab opens inherit
/// these.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TabOptions {
    /// A free-form label: the Chrome tab group's title, and a handle for closing several tabs at once.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    /// Hosts or origins the tab may load; None for no allowlist.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allowed_origins: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub read_only: bool,
    /// Keep the page focused between calls, for apps that pause while hidden.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub keep_visible: bool,
    /// The connected browser to open the tab in (an id or name `status` lists); the first connected one by default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub browser: Option<String>,
}

impl TabOptions {
    /// The options for opening a tab, from a tool's arguments (navigate and tabs new share them).
    pub fn from_args(args: &Value) -> anyhow::Result<Self> {
        let text = |key: &str| -> anyhow::Result<Option<String>> {
            match args.get(key) {
                None | Some(Value::Null) => Ok(None),
                Some(Value::String(text)) => Ok(Some(text.trim().to_string()).filter(|t| !t.is_empty())),
                Some(other) => anyhow::bail!("{key} must be a string, not {other}"),
            }
        };
        let flag = |key: &str| -> anyhow::Result<bool> {
            match args.get(key) {
                None | Some(Value::Null) => Ok(false),
                Some(Value::Bool(value)) => Ok(*value),
                Some(other) => anyhow::bail!("{key} must be true or false, not {other}"),
            }
        };
        let allowed_origins = match args.get("allowedOrigins") {
            None | Some(Value::Null) => None,
            Some(Value::Array(items)) => Some(
                items.iter().map(|v| v.as_str().map(str::to_string).ok_or_else(|| anyhow::anyhow!("allowedOrigins must be an array of strings"))).collect::<anyhow::Result<Vec<_>>>()?,
            ),
            Some(_) => anyhow::bail!("allowedOrigins must be an array of strings"),
        };
        Ok(Self { group: text("group")?, allowed_origins, read_only: flag("readOnly")?, keep_visible: flag("keepVisible")?, browser: text("browser")? })
    }

    /// The option arguments `from_args` reads that the call gave, to refuse them where they don't apply.
    pub fn given(args: &Value) -> Vec<&'static str> {
        ["group", "allowedOrigins", "readOnly", "keepVisible", "browser"].into_iter().filter(|key| args.get(*key).is_some_and(|v| !v.is_null())).collect()
    }

    /// The JSON schema properties of the options for opening a tab.
    pub fn schema() -> serde_json::Map<String, Value> {
        let Value::Object(map) = serde_json::json!({
            "group": { "type": "string", "description": "When opening a tab: a label for it (and the popups it opens), e.g. the task's name. It is the tab group's title in the browser, and `tabs` can list or close a whole group at once." },
            "allowedOrigins": { "type": "array", "items": { "type": "string" }, "description": "When opening a tab: hosts or origins it may load (example.com, *.example.com, https://app.example.com, http://localhost:3000). Navigations elsewhere are refused or sent back to about:blank; private and loopback addresses need an exact entry. Popups inherit it." },
            "readOnly": { "type": "boolean", "description": "When opening a tab: only read it (snapshots, screenshots, page state); input and later navigation are refused." },
            "keepVisible": { "type": "boolean", "description": "When opening a tab: keep it focused to the page between calls, for apps that pause while hidden. Pages can notice." },
            "browser": { "type": "string", "description": "When opening a tab: which connected browser, by the id or name `status` lists. Defaults to the first connected one." },
        }) else {
            unreachable!()
        };
        map
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TabInfo {
    pub tab: TabId,
    pub url: String,
    pub title: String,
    /// A tab the user lent browse (the toolbar button), rather than one browse opened.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub lent: bool,
    /// The tab whose page opened this one (a popup, target=_blank).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opener: Option<TabId>,
    #[serde(flatten)]
    pub options: TabOptions,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HandoffResult {
    /// "continued", "cancelled", "closed" or "timeout".
    pub outcome: String,
    pub note: Option<String>,
}

/// What the relay offers tools: the tabs agents opened or the user lent, and the user-facing pieces only the
/// extension can do. Every tab is addressed by its id; there is no current tab.
#[async_trait]
pub trait Browser: Send + Sync {
    /// Opens a background agent tab (at `url`, else about:blank) and waits for it to load.
    async fn open_tab(&self, url: Option<&str>, options: &TabOptions) -> anyhow::Result<TabInfo>;
    /// The agent tabs and the tabs the user lent, as last seen (no browser round trip).
    async fn tabs(&self) -> anyhow::Result<Vec<TabInfo>>;
    /// Closes an agent tab; a lent tab is given back to the user instead.
    async fn close_tab(&self, tab: TabId) -> anyhow::Result<()>;
    async fn cdp(&self, tab: TabId) -> anyhow::Result<Arc<dyn Cdp>>;
    /// The state tools keep for the tab. A tab that went away keeps it a little while, so a capture that ended with
    /// it can still be collected.
    async fn state(&self, tab: TabId) -> anyhow::Result<Arc<TabState>>;
    async fn handoff(&self, tab: TabId, message: &str) -> anyhow::Result<HandoffResult>;
    /// The extension's "Human-like input" setting for the tab's browser (curved mouse paths, paced keys). On by
    /// default; OPENCODE_BROWSER_HUMAN_INPUT overrides it in the page tools.
    async fn human_input(&self, _tab: TabId) -> bool {
        true
    }
    /// A background activity in the tab started (`busy`) or ended: a network capture ("network") or a recording
    /// ("recording"), keyed per kind. While any key is busy the tab counts as busy, so idle shutdown, idle tab cleanup
    /// and relay restarts wait for it. Called again with `false` when the activity ends for any reason.
    fn set_busy(&self, _tab: TabId, _key: &str, _busy: bool) {}
}

/// Per-tab state tools keep between calls (snapshot refs, network capture, ...), keyed by a crate-chosen string.
#[derive(Default)]
pub struct TabState(Mutex<HashMap<String, Box<dyn Any + Send>>>);

impl TabState {
    pub fn inner(&self) -> &Mutex<HashMap<String, Box<dyn Any + Send>>> {
        &self.0
    }

    /// The value under `key`, made with `make` the first time.
    pub async fn get_or_insert<T: Clone + Send + 'static>(&self, key: &str, make: impl FnOnce() -> T) -> T {
        let mut map = self.0.lock().await;
        if let Some(value) = map.get(key).and_then(|v| v.downcast_ref::<T>()) {
            return value.clone();
        }
        let value = make();
        map.insert(key.to_string(), Box::new(value.clone()));
        value
    }
}

#[derive(Clone)]
pub struct ToolContext {
    pub browser: Arc<dyn Browser>,
    /// Folders tools may read or write files in (uploads, screenshots, downloads, HAR files).
    pub file_roots: Vec<std::path::PathBuf>,
}

impl ToolContext {
    pub async fn state(&self, tab: TabId) -> anyhow::Result<Arc<TabState>> {
        self.browser.state(tab).await
    }
}

/// What a tool says when a call needs a tab and names none.
pub const MISSING_TAB: &str = "Pass `tab`: the id navigate (or tabs new) returned. To open a tab, call navigate with a url; tabs lists the tabs you can use.";

/// The `tab` argument a tool needs, or the error telling the agent where to get one.
pub fn require_tab(args: &Value) -> anyhow::Result<TabId> {
    match args.get("tab") {
        None | Some(Value::Null) => anyhow::bail!(MISSING_TAB),
        Some(value) => value.as_i64().ok_or_else(|| anyhow::anyhow!("tab must be an integer tab id (from navigate or tabs), not {value}")),
    }
}

/// The schema of a required `tab` argument.
pub fn tab_schema() -> Value {
    serde_json::json!({ "type": "integer", "description": "The tab to act on: the id navigate or tabs new returned (or a lent tab's id from tabs list)." })
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

/// `browse mcp` → relay: POST /tools/call. `GET /tools` returns `Vec<ToolSpec>`. Both take the MCP client's name in
/// the `OpenCode-Browser-Client` header (CLIENT_HEADER), which decides the tools and instructions it gets.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCallRequest {
    pub name: String,
    pub arguments: Value,
}

/// The header naming the MCP client (its `clientInfo.name`) on /tools, /instructions and /tools/call.
pub const CLIENT_HEADER: &str = "OpenCode-Browser-Client";

/// A key the caller picks for one POST /tools/call, so POST /tools/cancel can stop that call (an MCP client's
/// `notifications/cancelled`).
pub const CALL_HEADER: &str = "OpenCode-Browser-Call";
