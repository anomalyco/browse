//! Shared contracts between the browse crates. Nothing here talks to a browser or mentions any specific browser
//! protocol: protocol crates (`browse-cdp`, `browse-bidi`, ...) implement `BrowserDriver`, `TabDriver`, and
//! `CaptureDriver`; the relay implements `Browser`; the page, capture, and script crates implement `Tool`s on top
//! of them; and the binary wires everything together.

pub mod driver;

pub use driver::{
    Arg, BodyKind, BrowserDriver, BrowserEvent, CallOptions, CaptureDriver, CloseReason, ConsoleEntry, ConsoleEvent,
    Dialog, DialogKind, DocumentId, DragOutcome, DriverError, DriverInfo, DriverResult, Emulation, Eval, Evaluated,
    FileChooser, FileChooserArm, Frame, FrameId, Geolocation, GuardedTabDriver, Image, ImageFormat, JsError, KeyEvent,
    LoadState, MediaFeature, MediaOverride, Modifiers, MouseButton, NavigationError, NavigationErrorKind, NavigationId,
    NetworkEvent, NetworkOptions, NetworkRequest, PageEvent, PointerEvent, PointerStep, Realm, Receiver, Rect, RemoteRef,
    RequestId,
    ResponseHead, Returns, Screencast, ScreencastFrame, ScreencastOptions, Screenshot, ScreenshotArea, Subscription,
    TabDriver, TabPolicy, TargetId, UserPresence, Viewport, ViewportOverride, World,
};

use std::any::Any;
use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::Mutex;

pub type TabId = i64;

/// How an agent tab is opened, kept with it for its life (and across relay restarts). Popups a tab opens inherit
/// these.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TabOptions {
    /// A free-form label: the browser tab group's title, and a handle for closing several tabs at once.
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
    /// Never close the tab as idle: it stays until an agent closes it or the user does.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub keep_open: bool,
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
                items
                    .iter()
                    .map(|v| {
                        v.as_str()
                            .map(str::to_string)
                            .ok_or_else(|| anyhow::anyhow!("allowedOrigins must be an array of strings"))
                    })
                    .collect::<anyhow::Result<Vec<_>>>()?,
            ),
            Some(_) => anyhow::bail!("allowedOrigins must be an array of strings"),
        };
        Ok(Self {
            group: text("group")?,
            allowed_origins,
            read_only: flag("readOnly")?,
            keep_visible: flag("keepVisible")?,
            keep_open: flag("keepOpen")?,
            browser: text("browser")?,
        })
    }

    /// The option arguments `from_args` reads that the call gave, to refuse them where they don't apply.
    pub fn given(args: &Value) -> Vec<&'static str> {
        ["group", "allowedOrigins", "readOnly", "keepVisible", "keepOpen", "browser"]
            .into_iter()
            .filter(|key| args.get(*key).is_some_and(|v| !v.is_null()))
            .collect()
    }

    /// The JSON schema properties of the options for opening a tab.
    pub fn schema() -> serde_json::Map<String, Value> {
        let Value::Object(map) = serde_json::json!({
            "group": { "type": "string", "description": "When opening a tab: a label for it (and the popups it opens), e.g. the task's name. It is the tab group's title in the browser, and `tabs` can list or close a whole group at once." },
            "allowedOrigins": { "type": "array", "items": { "type": "string" }, "description": "When opening a tab: hosts or origins it may load (example.com, *.example.com, https://app.example.com, http://localhost:3000). Navigations elsewhere are refused or sent back to about:blank; private and loopback addresses need an exact entry. Popups inherit it. It limits top-level navigations, not iframes or the requests a page makes." },
            "readOnly": { "type": "boolean", "description": "When opening a tab: only read it (snapshots, screenshots, page state); input and later navigation commands are refused, but `eval` and `webmcp` still run page JavaScript that can read, change and navigate the page, so it is not a data boundary." },
            "keepVisible": { "type": "boolean", "description": "When opening a tab: keep it focused to the page between calls, for apps that pause while hidden. Pages can notice." },
            "keepOpen": { "type": "boolean", "description": "When opening a tab: never close it as idle; it stays open until an agent closes it or the user does. Off by default." },
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
    #[serde(default)]
    pub lent: bool,
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "id")]
    pub chosen: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opener: Option<TabId>,
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "lastUsed")]
    pub last_used: Option<String>,
    #[serde(default)]
    pub busy: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub handoff: Option<HandoffInfo>,
    #[serde(flatten)]
    pub options: TabOptions,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HandoffInfo {
    pub message: String,
    #[serde(rename = "startedAt")]
    pub started_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HandoffResult {
    /// "continued", "cancelled", "closed" or "timeout".
    pub outcome: String,
    pub note: Option<String>,
}

/// Why an action is refused on a tab opened with `readOnly`.
/// An MCP outputSchema for a tool's JSON object result. Kept loose on purpose: it tells agents what comes back, while
/// results may carry more keys than it lists.
pub fn output_schema(properties: Value, required: &[&str]) -> Value {
    let mut schema = serde_json::json!({ "type": "object", "properties": properties });
    if !required.is_empty() {
        schema["required"] = serde_json::json!(required);
    }
    schema
}

pub fn read_only_refusal(command: &str) -> String {
    format!(
        "browse blocked {command}: this tab is read-only. Read-only tabs can take snapshots and screenshots, read page information and subscribe to events. Open a tab without readOnly to interact with pages."
    )
}

/// What the harness host (relay) offers tools: tab registry, per-tab drivers, per-tab state, and user handoff.
#[async_trait]
pub trait Browser: Send + Sync {
    async fn open_tab(&self, url: Option<&str>, options: &TabOptions) -> anyhow::Result<TabInfo>;
    async fn tabs(&self) -> anyhow::Result<Vec<TabInfo>>;
    async fn close_tab(&self, tab: TabId) -> anyhow::Result<()>;
    async fn tab_driver(&self, tab: TabId) -> anyhow::Result<Arc<dyn TabDriver>>;
    async fn state(&self, tab: TabId) -> anyhow::Result<Arc<TabState>>;
    async fn handoff(&self, tab: TabId, message: &str) -> anyhow::Result<HandoffResult>;
    async fn human_input(&self, _tab: TabId) -> bool {
        true
    }
    async fn connected_locally(&self, _tab: TabId) -> bool {
        false
    }
    async fn read_only(&self, tab: TabId) -> bool;
    fn set_busy(&self, _tab: TabId, _key: &str, _busy: bool) {}
    fn resolve_tab(&self, value: &Value) -> anyhow::Result<TabId> {
        tab_arg(value)
    }
}

/// Per-tab state tools keep between calls (snapshot refs, network capture, ...), keyed by a crate-chosen string.
#[derive(Default)]
pub struct TabState(Mutex<HashMap<String, Box<dyn Any + Send>>>);

impl TabState {
    pub fn inner(&self) -> &Mutex<HashMap<String, Box<dyn Any + Send>>> {
        &self.0
    }

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
    pub file_roots: Vec<std::path::PathBuf>,
}

impl ToolContext {
    pub async fn state(&self, tab: TabId) -> anyhow::Result<Arc<TabState>> {
        self.browser.state(tab).await
    }
}

pub const MISSING_TAB: &str = "Pass `tab`: the id navigate (or tabs new) returned, or a chosen id like `work-mail`. To open a tab, call navigate with a url; tabs lists the tabs you can use.";

pub fn require_tab(args: &Value) -> anyhow::Result<TabId> {
    match args.get("tab") {
        None | Some(Value::Null) => anyhow::bail!(MISSING_TAB),
        Some(value) => tab_arg(value),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TabArg {
    Id(TabId),
    Chosen(String),
}

pub fn tab_argument(value: &Value) -> anyhow::Result<TabArg> {
    match value {
        Value::Number(_) => match value.as_i64() {
            Some(tab) if tab >= 0 => Ok(TabArg::Id(tab)),
            _ => Err(invalid_tab_id(value)),
        },
        Value::String(text) => {
            if !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit()) {
                let tab = text
                    .parse::<TabId>()
                    .map_err(|_| anyhow::anyhow!("tab id {text} is too large; browse's tab ids are 64-bit integers"))?;
                return Ok(TabArg::Id(tab));
            }
            let chosen = text.trim();
            if chosen.is_empty() {
                return Err(invalid_tab_id(value));
            }
            if chosen != text && chosen.bytes().all(|byte| byte.is_ascii_digit()) {
                anyhow::bail!("tab id {text:?} has spaces around it; pass the digits only");
            }
            if !valid_chosen_id(chosen) {
                anyhow::bail!("tab must be a numeric tab id (from navigate or tabs) or a chosen id like `work-mail` (lowercase letters, digits and dashes, starting with a letter), not {text:?}");
            }
            Ok(TabArg::Chosen(chosen.to_string()))
        }
        other => Err(invalid_tab_id(other)),
    }
}

fn invalid_tab_id(value: &Value) -> anyhow::Error {
    anyhow::anyhow!("tab must be a numeric tab id (from navigate or tabs) or a chosen id like `work-mail`, not {value}")
}

pub fn tab_arg(value: &Value) -> anyhow::Result<TabId> {
    match tab_argument(value)? {
        TabArg::Id(tab) => Ok(tab),
        TabArg::Chosen(chosen) => anyhow::bail!("`{chosen}` is a chosen tab id, and only the relay can resolve it to a tab; pass the numeric id navigate or tabs returned"),
    }
}

pub fn valid_chosen_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    let Some(first) = bytes.first() else { return false };
    bytes.len() <= 64
        && first.is_ascii_lowercase()
        && bytes[1..]
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
}

pub fn tab_schema() -> Value {
    serde_json::json!({
        "type": ["integer", "string"],
        "description": "Tab id (a number or digit string) from navigate or tabs, or a chosen id like `work-mail`."
    })
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
    /// MCP `structuredContent`: the result as an object, for tools that declare an `outputSchema`.
    #[serde(rename = "structuredContent", default, skip_serializing_if = "Option::is_none")]
    pub structured_content: Option<Value>,
}

impl ToolOutput {
    pub fn text(text: impl Into<String>) -> Self {
        Self { content: vec![Content::Text { text: text.into() }], is_error: false, structured_content: None }
    }
    pub fn error(text: impl Into<String>) -> Self {
        Self { content: vec![Content::Text { text: text.into() }], is_error: true, structured_content: None }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolSpec {
    pub name: String,
    pub description: String,
    #[serde(rename = "inputSchema")]
    pub input_schema: Value,
    /// MCP `outputSchema`: a tool with one returns `structuredContent` matching it on every successful call.
    #[serde(rename = "outputSchema", default, skip_serializing_if = "Option::is_none")]
    pub output_schema: Option<Value>,
}

#[async_trait]
pub trait Tool: Send + Sync {
    fn spec(&self) -> ToolSpec;
    async fn call(&self, ctx: ToolContext, args: Value) -> anyhow::Result<ToolOutput>;
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCallRequest {
    pub name: String,
    pub arguments: Value,
}

pub const CLIENT_HEADER: &str = "OpenCode-Browser-Client";
pub const CALL_HEADER: &str = "OpenCode-Browser-Call";

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn a_digit_only_string_is_the_number_it_spells() {
        assert_eq!(tab_argument(&json!("633559866")).unwrap(), TabArg::Id(633559866));
        assert_eq!(tab_argument(&json!(633559866)).unwrap(), TabArg::Id(633559866));
        assert_eq!(tab_arg(&json!("633559866")).unwrap(), 633559866);
        assert_eq!(tab_argument(&json!("007")).unwrap(), TabArg::Id(7));
    }

    #[test]
    fn a_chosen_id_stays_a_chosen_id() {
        assert_eq!(tab_argument(&json!("work-mail")).unwrap(), TabArg::Chosen("work-mail".into()));
        assert_eq!(tab_argument(&json!("  work-mail  ")).unwrap(), TabArg::Chosen("work-mail".into()));
        assert_eq!(tab_argument(&json!("b2")).unwrap(), TabArg::Chosen("b2".into()));
        assert!(tab_arg(&json!("work-mail")).is_err(), "only the relay resolves chosen ids");
    }

    #[test]
    fn invalid_tab_ids_are_refused() {
        for value in [
            json!(""),
            json!("   "),
            json!("12a"),
            json!("-5"),
            json!("+5"),
            json!(" 12 "),
            json!("1.5"),
            json!("99999999999999999999"),
            json!(1.5),
            json!(-5),
            json!(true),
            json!({}),
            json!([]),
        ] {
            assert!(tab_argument(&value).is_err(), "{value} must not be a tab id");
        }
        assert!(tab_argument(&json!("99999999999999999999")).unwrap_err().to_string().contains("too large"));
    }
}
