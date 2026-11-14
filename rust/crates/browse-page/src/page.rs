//! One tab's page model over CDP: the frame tree (including out-of-process iframes on child target sessions),
//! browse's isolated world per frame, lifecycle state, dialogs and a short log of what happened, all kept without
//! `Runtime.enable` so the page never sees an attached debugger's execution-context bookkeeping.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Result, anyhow, bail};
use browse_core::{Cdp, CdpError, CdpEvent, TabId};
use serde_json::{Value, json};
use tokio::sync::{broadcast, watch};

use crate::scripts;

/// Remote objects browse creates while a tool runs; released when the tool finishes.
pub const TRANSIENT_GROUP: &str = "browse-transient";
const WORLD_GROUP: &str = "browse-world";
const MAX_EVENTS: usize = 200;

#[derive(Debug, Clone)]
pub struct FrameInfo {
    pub id: String,
    pub parent: Option<String>,
    /// The child target session for an out-of-process iframe; None when the tab's own session owns it.
    pub session: Option<String>,
    pub url: String,
    pub name: String,
    pub loader_id: String,
    pub lifecycle: HashSet<String>,
    /// Bumped on every cross-document navigation; refs captured under an older generation are stale.
    pub generation: u64,
}

#[derive(Debug, Clone)]
struct World {
    context_id: i64,
    helpers: String,
    injected: bool,
    generation: u64,
}

/// A frame's isolated world: its execution context and the helpers object (js/helpers.js) living in it.
#[derive(Debug, Clone)]
pub struct WorldRef {
    pub frame: String,
    pub session: Option<String>,
    pub context_id: i64,
    pub helpers: String,
    pub generation: u64,
}

/// An element in browse's isolated world of a frame.
#[derive(Debug, Clone)]
pub struct Element {
    pub frame: String,
    pub session: Option<String>,
    pub object_id: String,
    pub context_id: i64,
    pub generation: u64,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct Dialog {
    #[serde(rename = "type")]
    pub kind: String,
    pub message: String,
    #[serde(rename = "defaultPrompt", skip_serializing_if = "String::is_empty")]
    pub default_prompt: String,
    pub url: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DialogPolicy {
    Manual,
    Accept,
    Dismiss,
}

#[derive(Debug, Clone)]
pub enum TabEvent {
    /// The main frame committed a navigation.
    Navigated { url: String, same_document: bool },
    /// The main frame started loading a new document.
    NavigationStarted { url: String },
    Dialog(Dialog),
    /// A dialog was handled, by browse's policy or the user.
    DialogClosed { accepted: bool, auto: bool },
    Popup { url: String },
    Crashed,
}

#[derive(Default)]
struct TabState {
    main_frame: String,
    frames: HashMap<String, FrameInfo>,
    worlds: HashMap<String, World>,
    frame_seq: HashMap<String, u32>,
    next_seq: u32,
    /// Child target sessions: session id to target id.
    sessions: HashMap<String, String>,
    dialog: Option<Dialog>,
    dialog_policy: Option<DialogPolicy>,
    events: Vec<(u64, TabEvent)>,
    seq: u64,
    drag: Option<Value>,
    platform: Option<String>,
}

struct Shared {
    tab: TabId,
    cdp: Arc<dyn Cdp>,
    state: Mutex<TabState>,
    changed: watch::Sender<u64>,
    dialog_open: watch::Sender<bool>,
}

pub struct TabPage {
    shared: Arc<Shared>,
    world_lock: tokio::sync::Mutex<()>,
    world_name: String,
    /// Serializes input on the tab and holds the pointer's human-input state.
    pub input: tokio::sync::Mutex<crate::human::InputState>,
    pump: tokio::task::JoinHandle<()>,
}

impl Drop for TabPage {
    fn drop(&mut self) {
        self.pump.abort();
    }
}

pub fn cdp_error(error: CdpError) -> anyhow::Error {
    anyhow!(error.to_string())
}

/// Errors that mean the world (or the document) the call ran in is gone; the call can run again in a new one.
pub fn is_context_lost(message: &str) -> bool {
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

fn str_of(value: &Value, key: &str) -> String {
    value.get(key).and_then(Value::as_str).unwrap_or_default().to_string()
}

/// Frame generations are unique across tab pages, so a ref can never match a rebuilt page's frame by accident.
fn next_generation() -> u64 {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
}

fn world_name() -> String {
    // Unique per process; only visible to CDP clients, never to the page.
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    format!("__b{:x}", (nanos as u64) ^ (std::process::id() as u64).rotate_left(17))
}

impl TabPage {
    pub async fn attach(tab: TabId, cdp: Arc<dyn Cdp>) -> Result<Arc<TabPage>> {
        let events = cdp.events();
        let (changed, _) = watch::channel(0u64);
        let (dialog_open, _) = watch::channel(false);
        let shared = Arc::new(Shared { tab, cdp: cdp.clone(), state: Mutex::new(TabState::default()), changed, dialog_open });
        let pump = tokio::spawn(pump(shared.clone(), events));
        let page = Arc::new(TabPage {
            shared: shared.clone(),
            world_lock: tokio::sync::Mutex::new(()),
            world_name: world_name(),
            input: tokio::sync::Mutex::new(crate::human::InputState::default()),
            pump,
        });
        cdp.send("Page.enable", json!({}), None).await.map_err(cdp_error)?;
        let _ = cdp.send("Page.setLifecycleEventsEnabled", json!({ "enabled": true }), None).await;
        let tree = cdp.send("Page.getFrameTree", json!({}), None).await.map_err(cdp_error)?;
        shared.merge_tree(&tree["frameTree"], None, true);
        let _ = cdp
            .send("Target.setAutoAttach", json!({ "autoAttach": true, "waitForDebuggerOnStart": false, "flatten": true }), None)
            .await;
        // Keeps a background tab focused and rendering; the relay may normalize it to the tab's real focus.
        let _ = cdp.send("Emulation.setFocusEmulationEnabled", json!({ "enabled": true }), None).await;
        Ok(page)
    }

    pub fn tab(&self) -> TabId {
        self.shared.tab
    }

    pub fn cdp(&self) -> &Arc<dyn Cdp> {
        &self.shared.cdp
    }

    /// Whether the event pump still runs (the Cdp's event stream is open).
    pub fn alive(&self) -> bool {
        !self.pump.is_finished()
    }

    pub fn main_frame(&self) -> String {
        self.shared.state.lock().unwrap().main_frame.clone()
    }

    pub fn frame(&self, id: &str) -> Option<FrameInfo> {
        self.shared.state.lock().unwrap().frames.get(id).cloned()
    }

    pub fn frames(&self) -> Vec<FrameInfo> {
        let state = self.shared.state.lock().unwrap();
        // Document order is not known; parents before children, main frame first.
        let mut out = Vec::new();
        let mut queue = vec![state.main_frame.clone()];
        let mut seen = HashSet::new();
        while let Some(id) = queue.pop() {
            if !seen.insert(id.clone()) {
                continue;
            }
            if let Some(frame) = state.frames.get(&id) {
                out.push(frame.clone());
                let mut children: Vec<_> = state.frames.values().filter(|f| f.parent.as_deref() == Some(id.as_str())).map(|f| f.id.clone()).collect();
                children.sort();
                children.reverse();
                queue.extend(children);
            }
        }
        out
    }

    pub fn main_url(&self) -> String {
        let state = self.shared.state.lock().unwrap();
        state.frames.get(&state.main_frame).map(|f| f.url.clone()).unwrap_or_default()
    }

    /// The stable sequence number of a frame, used as Playwright's aria-ref prefix ("f3e12"). The main frame is 0.
    pub fn frame_seq(&self, frame: &str) -> u32 {
        let mut state = self.shared.state.lock().unwrap();
        if state.main_frame == frame {
            return 0;
        }
        if let Some(seq) = state.frame_seq.get(frame) {
            return *seq;
        }
        state.next_seq += 1;
        let seq = state.next_seq;
        state.frame_seq.insert(frame.to_string(), seq);
        seq
    }

    pub fn frame_by_seq(&self, seq: u32) -> Option<String> {
        let state = self.shared.state.lock().unwrap();
        if seq == 0 {
            return Some(state.main_frame.clone());
        }
        state.frame_seq.iter().find(|(_, s)| **s == seq).map(|(f, _)| f.clone())
    }

    // Events, dialogs and waiting.

    pub fn event_seq(&self) -> u64 {
        self.shared.state.lock().unwrap().seq
    }

    pub fn events_since(&self, seq: u64) -> Vec<TabEvent> {
        let state = self.shared.state.lock().unwrap();
        state.events.iter().filter(|(s, _)| *s > seq).map(|(_, e)| e.clone()).collect()
    }

    pub fn subscribe(&self) -> watch::Receiver<u64> {
        self.shared.changed.subscribe()
    }

    pub fn dialog(&self) -> Option<Dialog> {
        self.shared.state.lock().unwrap().dialog.clone()
    }

    pub fn set_dialog_policy(&self, policy: Option<DialogPolicy>) {
        self.shared.state.lock().unwrap().dialog_policy = policy;
    }

    pub fn dialog_policy(&self) -> Option<DialogPolicy> {
        self.shared.state.lock().unwrap().dialog_policy
    }

    pub fn take_drag(&self) -> Option<Value> {
        self.shared.state.lock().unwrap().drag.take()
    }

    pub fn clear_drag(&self) {
        self.shared.state.lock().unwrap().drag = None;
    }

    pub fn has_drag(&self) -> bool {
        self.shared.state.lock().unwrap().drag.is_some()
    }

    fn dialog_error(dialog: &Dialog) -> anyhow::Error {
        anyhow!(
            "A {} dialog is open: {:?}. The page is paused until it is answered: call dialog with action \"accept\" or \"dismiss\".",
            dialog.kind,
            truncate(&dialog.message, 200)
        )
    }

    /// Fails while a JavaScript dialog blocks the page: every evaluation would hang until it is answered.
    pub fn ensure_no_dialog(&self) -> Result<()> {
        match self.dialog() {
            Some(dialog) => Err(Self::dialog_error(&dialog)),
            None => Ok(()),
        }
    }

    /// Resolves when a dialog opens.
    pub async fn dialog_opened(&self) {
        let mut rx = self.shared.dialog_open.subscribe();
        let _ = rx.wait_for(|open| *open).await;
    }

    /// Sends a command, failing instead of hanging when a dialog opens while it runs.
    pub async fn send(&self, method: &str, params: Value, session: Option<&str>) -> Result<Value> {
        self.ensure_no_dialog()?;
        let cdp = self.shared.cdp.clone();
        tokio::select! {
            result = cdp.send(method, params, session) => result.map_err(cdp_error),
            _ = self.dialog_opened() => Err(Self::dialog_error(&self.dialog().unwrap_or(Dialog { kind: "dialog".into(), message: String::new(), default_prompt: String::new(), url: String::new() }))),
        }
    }

    /// Sends a command whether or not a dialog is open (input, dialog handling).
    pub async fn send_raw(&self, method: &str, params: Value, session: Option<&str>) -> Result<Value> {
        self.shared.cdp.send(method, params, session).await.map_err(cdp_error)
    }

    pub async fn handle_dialog(&self, accept: bool, prompt_text: Option<&str>) -> Result<Dialog> {
        let dialog = self.dialog().ok_or_else(|| anyhow!("No dialog is open on this tab."))?;
        let mut params = json!({ "accept": accept });
        if let Some(text) = prompt_text {
            params["promptText"] = json!(text);
        }
        self.send_raw("Page.handleJavaScriptDialog", params, None).await?;
        self.shared.clear_dialog(Some(accept), false);
        Ok(dialog)
    }

    /// Waits until `check` passes, re-checking on every page event and at least every `poll`.
    pub async fn wait_until<F>(&self, timeout: Duration, poll: Duration, mut check: F) -> bool
    where
        F: FnMut(&TabPage) -> bool,
    {
        let deadline = tokio::time::Instant::now() + timeout;
        let mut rx = self.subscribe();
        loop {
            if check(self) {
                return true;
            }
            let now = tokio::time::Instant::now();
            if now >= deadline {
                return false;
            }
            let wait = poll.min(deadline - now);
            let _ = tokio::time::timeout(wait, rx.changed()).await;
        }
    }

    pub fn lifecycle_has(&self, frame: &str, name: &str) -> bool {
        self.frame(frame).map(|f| f.lifecycle.contains(name)).unwrap_or(false)
    }

    // Worlds.

    pub async fn world(&self, frame: &str) -> Result<WorldRef> {
        if let Some(world) = self.cached_world(frame) {
            return Ok(world);
        }
        let _guard = self.world_lock.lock().await;
        if let Some(world) = self.cached_world(frame) {
            return Ok(world);
        }
        let info = self.frame(frame).ok_or_else(|| anyhow!("The frame is gone (it navigated away or was removed)."))?;
        let session = info.session.clone();
        let created = self
            .send(
                "Page.createIsolatedWorld",
                json!({ "frameId": frame, "worldName": self.world_name, "grantUniveralAccess": true }),
                session.as_deref(),
            )
            .await?;
        let context_id = created["executionContextId"].as_i64().ok_or_else(|| anyhow!("Chrome did not create an isolated world for the frame"))?;
        let evaluated = self
            .send(
                "Runtime.evaluate",
                json!({ "expression": scripts::helpers(), "contextId": context_id, "returnByValue": false, "objectGroup": WORLD_GROUP }),
                session.as_deref(),
            )
            .await?;
        if let Some(details) = evaluated.get("exceptionDetails") {
            bail!("browse could not set up its page helpers: {}", exception_message(details));
        }
        let helpers = str_of(&evaluated["result"], "objectId");
        if helpers.is_empty() {
            bail!("browse could not set up its page helpers in the frame");
        }
        let mut state = self.shared.state.lock().unwrap();
        let current = state.frames.get(frame).map(|f| f.generation);
        if current != Some(info.generation) {
            bail!("Execution context was destroyed: the frame navigated while browse was attaching");
        }
        state.worlds.insert(frame.to_string(), World { context_id, helpers: helpers.clone(), injected: false, generation: info.generation });
        Ok(WorldRef { frame: frame.to_string(), session, context_id, helpers, generation: info.generation })
    }

    fn cached_world(&self, frame: &str) -> Option<WorldRef> {
        let state = self.shared.state.lock().unwrap();
        let info = state.frames.get(frame)?;
        let world = state.worlds.get(frame)?;
        if world.generation != info.generation {
            return None;
        }
        Some(WorldRef { frame: frame.to_string(), session: info.session.clone(), context_id: world.context_id, helpers: world.helpers.clone(), generation: world.generation })
    }

    pub fn forget_world(&self, frame: &str, context_id: i64) {
        let mut state = self.shared.state.lock().unwrap();
        if state.worlds.get(frame).map(|w| w.context_id) == Some(context_id) {
            state.worlds.remove(frame);
        }
    }

    /// Makes Playwright's InjectedScript available as `this.inj` in the frame's world.
    pub async fn ensure_injected(&self, frame: &str) -> Result<WorldRef> {
        let world = self.world(frame).await?;
        let injected = self.shared.state.lock().unwrap().worlds.get(frame).map(|w| w.injected && w.context_id == world.context_id).unwrap_or(false);
        if injected {
            return Ok(world);
        }
        let seq = self.frame_seq(frame);
        let result = self
            .send(
                "Runtime.callFunctionOn",
                json!({ "functionDeclaration": scripts::install_injected(seq), "objectId": world.helpers, "returnByValue": true, "awaitPromise": false }),
                world.session.as_deref(),
            )
            .await;
        let result = match result {
            Ok(result) => result,
            Err(error) => {
                if is_context_lost(&error.to_string()) {
                    self.forget_world(frame, world.context_id);
                }
                return Err(error);
            }
        };
        if let Some(details) = result.get("exceptionDetails") {
            bail!("browse could not load its selector engine: {}", exception_message(details));
        }
        if let Some(w) = self.shared.state.lock().unwrap().worlds.get_mut(frame)
            && w.context_id == world.context_id {
                w.injected = true;
            }
        Ok(world)
    }

    /// Calls `helpers[method](...args)` in the frame's world. Retries once in a fresh world when the old one is gone
    /// and no element handles are involved.
    pub async fn call(&self, frame: &str, method: &str, args: Vec<Arg>, by_value: bool, injected: bool) -> Result<Value> {
        let has_handles = args.iter().any(|a| matches!(a, Arg::Element(_)));
        let mut attempt = 0;
        loop {
            attempt += 1;
            let world = if injected { self.ensure_injected(frame).await? } else { self.world(frame).await? };
            for arg in &args {
                if let Arg::Element(element) = arg
                    && element.context_id != world.context_id {
                        bail!("The element's document changed (the frame navigated or re-rendered); resolve it again.");
                    }
            }
            let result = self.call_on(&world, method, &args, by_value).await;
            match result {
                Err(error) if is_context_lost(&error.to_string()) => {
                    self.forget_world(frame, world.context_id);
                    if has_handles || attempt >= 3 {
                        bail!("The page navigated or re-rendered while browse was reading it; try again. ({error})");
                    }
                    tokio::time::sleep(Duration::from_millis(30)).await;
                }
                other => return other,
            }
        }
    }

    async fn call_on(&self, world: &WorldRef, method: &str, args: &[Arg], by_value: bool) -> Result<Value> {
        let arguments: Vec<Value> = args.iter().map(Arg::to_cdp).collect();
        let declaration = format!("function (...args) {{ return this.{method}(...args) }}");
        let result = self
            .send(
                "Runtime.callFunctionOn",
                json!({
                    "functionDeclaration": declaration,
                    "objectId": world.helpers,
                    "arguments": arguments,
                    "returnByValue": by_value,
                    "awaitPromise": true,
                    "objectGroup": TRANSIENT_GROUP,
                }),
                world.session.as_deref(),
            )
            .await?;
        if let Some(details) = result.get("exceptionDetails") {
            bail!("{}", exception_message(details));
        }
        Ok(result["result"].clone())
    }

    /// `call` returning the JSON value.
    pub async fn call_value(&self, frame: &str, method: &str, args: Vec<Arg>, injected: bool) -> Result<Value> {
        let result = self.call(frame, method, args, true, injected).await?;
        Ok(result.get("value").cloned().unwrap_or(Value::Null))
    }

    /// `call` on an element's frame, with the element first.
    pub async fn call_element(&self, element: &Element, method: &str, mut args: Vec<Arg>, injected: bool) -> Result<Value> {
        args.insert(0, Arg::Element(element.clone()));
        self.call_value(&element.frame, method, args, injected).await
    }

    /// `call` whose result is an element (or a string status such as "none").
    pub async fn call_element_result(&self, frame: &str, method: &str, args: Vec<Arg>, injected: bool) -> Result<ElementOr> {
        let world = if injected { self.ensure_injected(frame).await? } else { self.world(frame).await? };
        let result = self.call(frame, method, args, false, injected).await?;
        if result.get("subtype").and_then(Value::as_str) == Some("node") {
            let object_id = str_of(&result, "objectId");
            // The call may have run in a fresh world; read the context back from the cache.
            let current = self.cached_world(frame).unwrap_or(world);
            return Ok(ElementOr::Element(Element { frame: frame.to_string(), session: current.session, object_id, context_id: current.context_id, generation: current.generation }));
        }
        if let Some(status) = result.get("value").and_then(Value::as_str) {
            return Ok(ElementOr::Status(status.to_string()));
        }
        Ok(ElementOr::Status("none".into()))
    }

    /// The frame an `<iframe>` element shows, once its document is attached.
    pub async fn content_frame(&self, element: &Element, timeout: Duration) -> Result<String> {
        let described = self.send("DOM.describeNode", json!({ "objectId": element.object_id }), element.session.as_deref()).await?;
        let frame_id = str_of(&described["node"], "frameId");
        if frame_id.is_empty() {
            bail!("The element is not an iframe, or its frame is not attached yet.");
        }
        let found = self.wait_until(timeout, Duration::from_millis(50), |page| page.frame(&frame_id).is_some()).await;
        if !found {
            bail!("The iframe's document is not available (it may still be loading, or be cross-origin and not attached).");
        }
        Ok(frame_id)
    }

    /// The `<iframe>` element showing `frame`, in its parent frame's world.
    pub async fn frame_owner(&self, frame: &str) -> Result<Element> {
        let info = self.frame(frame).ok_or_else(|| anyhow!("The frame is gone."))?;
        let parent = info.parent.clone().ok_or_else(|| anyhow!("The main frame has no owner element."))?;
        let parent_info = self.frame(&parent).ok_or_else(|| anyhow!("The parent frame is gone."))?;
        let owner = self.send("DOM.getFrameOwner", json!({ "frameId": frame }), parent_info.session.as_deref()).await?;
        let backend = owner["backendNodeId"].as_i64().ok_or_else(|| anyhow!("Chrome did not report the iframe element"))?;
        let world = self.world(&parent).await?;
        let resolved = self
            .send(
                "DOM.resolveNode",
                json!({ "backendNodeId": backend, "executionContextId": world.context_id, "objectGroup": TRANSIENT_GROUP }),
                world.session.as_deref(),
            )
            .await?;
        let object_id = str_of(&resolved["object"], "objectId");
        if object_id.is_empty() {
            bail!("Chrome could not resolve the iframe element");
        }
        Ok(Element { frame: parent, session: world.session, object_id, context_id: world.context_id, generation: world.generation })
    }

    /// The same node as a main-world object (for eval in the page's own world).
    pub async fn main_world_object(&self, element: &Element) -> Result<String> {
        let described = self.send("DOM.describeNode", json!({ "objectId": element.object_id }), element.session.as_deref()).await?;
        let backend = described["node"]["backendNodeId"].as_i64().ok_or_else(|| anyhow!("Chrome did not describe the node"))?;
        let resolved = self
            .send("DOM.resolveNode", json!({ "backendNodeId": backend, "objectGroup": TRANSIENT_GROUP }), element.session.as_deref())
            .await?;
        let object_id = str_of(&resolved["object"], "objectId");
        if object_id.is_empty() {
            bail!("Chrome could not resolve the node in the page's world");
        }
        Ok(object_id)
    }

    /// The frame's `document` as an isolated-world element.
    pub async fn document(&self, frame: &str) -> Result<Element> {
        let world = self.world(frame).await?;
        let result = self
            .send(
                "Runtime.evaluate",
                json!({ "expression": "document", "contextId": world.context_id, "objectGroup": TRANSIENT_GROUP }),
                world.session.as_deref(),
            )
            .await?;
        let object_id = str_of(&result["result"], "objectId");
        if object_id.is_empty() {
            bail!("The frame has no document");
        }
        Ok(Element { frame: frame.to_string(), session: world.session, object_id, context_id: world.context_id, generation: world.generation })
    }

    /// Releases the transient objects of every session this tab uses.
    pub async fn release(&self) {
        let sessions: Vec<Option<String>> = {
            let state = self.shared.state.lock().unwrap();
            std::iter::once(None).chain(state.sessions.keys().cloned().map(Some)).collect()
        };
        if self.dialog().is_some() {
            return;
        }
        for session in sessions {
            let _ = tokio::time::timeout(
                Duration::from_secs(2),
                self.shared.cdp.send("Runtime.releaseObjectGroup", json!({ "objectGroup": TRANSIENT_GROUP }), session.as_deref()),
            )
            .await;
        }
    }

    pub fn platform(&self) -> Option<String> {
        self.shared.state.lock().unwrap().platform.clone()
    }

    pub fn set_platform(&self, platform: String) {
        self.shared.state.lock().unwrap().platform = Some(platform);
    }
}

#[derive(Debug, Clone)]
pub enum Arg {
    Value(Value),
    Element(Element),
    Undefined,
}

impl Arg {
    fn to_cdp(&self) -> Value {
        match self {
            Arg::Value(value) => json!({ "value": value }),
            Arg::Element(element) => json!({ "objectId": element.object_id }),
            Arg::Undefined => json!({}),
        }
    }
}

pub fn v(value: impl serde::Serialize) -> Arg {
    Arg::Value(serde_json::to_value(value).unwrap_or(Value::Null))
}

#[derive(Debug, Clone)]
pub enum ElementOr {
    Element(Element),
    Status(String),
}

/// The message of a CDP exceptionDetails, without the stack frames.
pub fn exception_message(details: &Value) -> String {
    let description = details["exception"]["description"].as_str().map(str::to_string).or_else(|| {
        details["exception"]["value"].as_str().map(str::to_string)
    });
    let text = description.unwrap_or_else(|| str_of(details, "text"));
    let lines: Vec<&str> = text.lines().filter(|line| !line.trim_start().starts_with("at ")).collect();
    let message = lines.join("\n");
    let message = message.strip_prefix("Uncaught ").unwrap_or(&message).to_string();
    if message.is_empty() { "the page threw an exception".into() } else { message }
}

pub fn truncate(value: &str, max: usize) -> String {
    if value.chars().count() <= max {
        return value.to_string();
    }
    let cut: String = value.chars().take(max).collect();
    format!("{cut}…")
}

impl Shared {
    fn bump(&self) {
        self.changed.send_modify(|n| *n += 1);
    }

    fn push(&self, state: &mut TabState, event: TabEvent) {
        state.seq += 1;
        let seq = state.seq;
        state.events.push((seq, event));
        if state.events.len() > MAX_EVENTS {
            let drop = state.events.len() - MAX_EVENTS;
            state.events.drain(..drop);
        }
    }

    fn merge_tree(&self, node: &Value, session: Option<&str>, root: bool) {
        let mut state = self.state.lock().unwrap();
        let frame = &node["frame"];
        let id = str_of(frame, "id");
        if id.is_empty() {
            return;
        }
        if root && session.is_none() {
            state.main_frame = id.clone();
        }
        Self::merge_frames(&mut state, node, session);
        drop(state);
        self.bump();
    }

    fn merge_frames(state: &mut TabState, node: &Value, session: Option<&str>) {
        let frame = &node["frame"];
        let id = str_of(frame, "id");
        let parent = frame.get("parentId").and_then(Value::as_str).map(str::to_string);
        let generation = next_generation();
        let entry = state.frames.entry(id.clone()).or_insert_with(|| FrameInfo {
            id: id.clone(),
            parent: parent.clone(),
            session: session.map(str::to_string),
            url: String::new(),
            name: String::new(),
            loader_id: String::new(),
            lifecycle: HashSet::new(),
            generation,
        });
        entry.session = session.map(str::to_string);
        if parent.is_some() {
            entry.parent = parent;
        }
        let loader = str_of(frame, "loaderId");
        if entry.loader_id != loader {
            entry.loader_id = loader;
            entry.generation = generation;
        }
        entry.url = format!("{}{}", str_of(frame, "url"), str_of(frame, "urlFragment"));
        entry.name = str_of(frame, "name");
        if let Some(children) = node["childFrames"].as_array() {
            for child in children {
                Self::merge_frames(state, child, session);
            }
        }
    }

    fn clear_dialog(&self, accepted: Option<bool>, auto: bool) {
        let mut state = self.state.lock().unwrap();
        if state.dialog.take().is_some()
            && let Some(accepted) = accepted {
                self.push(&mut state, TabEvent::DialogClosed { accepted, auto });
            }
        drop(state);
        self.dialog_open.send_replace(false);
        self.bump();
    }

    fn remove_frame_tree(state: &mut TabState, id: &str) {
        let children: Vec<String> = state.frames.values().filter(|f| f.parent.as_deref() == Some(id)).map(|f| f.id.clone()).collect();
        for child in children {
            Self::remove_frame_tree(state, &child);
        }
        state.frames.remove(id);
        state.worlds.remove(id);
    }

    fn handle(self: &Arc<Self>, event: CdpEvent) {
        let session = event.session_id.clone();
        let params = &event.params;
        match event.method.as_str() {
            "Page.frameAttached" => {
                let mut state = self.state.lock().unwrap();
                let id = str_of(params, "frameId");
                let generation = next_generation();
                let parent = params.get("parentFrameId").and_then(Value::as_str).map(str::to_string);
                state.frames.entry(id.clone()).or_insert_with(|| FrameInfo {
                    id,
                    parent,
                    session: session.clone(),
                    url: String::new(),
                    name: String::new(),
                    loader_id: String::new(),
                    lifecycle: HashSet::new(),
                    generation,
                });
            }
            "Page.frameNavigated" => {
                let frame = &params["frame"];
                let id = str_of(frame, "id");
                let url = format!("{}{}", str_of(frame, "url"), str_of(frame, "urlFragment"));
                let mut state = self.state.lock().unwrap();
                let generation = next_generation();
                let parent = frame.get("parentId").and_then(Value::as_str).map(str::to_string);
                let is_main = parent.is_none() && session.is_none();
                if is_main {
                    state.main_frame = id.clone();
                }
                let entry = state.frames.entry(id.clone()).or_insert_with(|| FrameInfo {
                    id: id.clone(),
                    parent: parent.clone(),
                    session: session.clone(),
                    url: String::new(),
                    name: String::new(),
                    loader_id: String::new(),
                    lifecycle: HashSet::new(),
                    generation,
                });
                entry.url = url.clone();
                entry.name = str_of(frame, "name");
                entry.session = session.clone();
                if parent.is_some() {
                    entry.parent = parent;
                }
                let loader = str_of(frame, "loaderId");
                if entry.loader_id != loader {
                    entry.loader_id = loader;
                    entry.generation = generation;
                    entry.lifecycle.clear();
                }
                state.worlds.remove(&id);
                // A new document's child frames attach again.
                let children: Vec<String> = state.frames.values().filter(|f| f.parent.as_deref() == Some(id.as_str()) && f.session == session).map(|f| f.id.clone()).collect();
                for child in children {
                    Self::remove_frame_tree(&mut state, &child);
                }
                if is_main {
                    self.push(&mut state, TabEvent::Navigated { url, same_document: false });
                }
            }
            "Page.navigatedWithinDocument" => {
                let id = str_of(params, "frameId");
                let url = str_of(params, "url");
                let mut state = self.state.lock().unwrap();
                let is_main = state.main_frame == id;
                if let Some(frame) = state.frames.get_mut(&id) {
                    frame.url = url.clone();
                }
                if is_main {
                    self.push(&mut state, TabEvent::Navigated { url, same_document: true });
                }
            }
            "Page.frameRequestedNavigation" | "Page.frameStartedNavigating" => {
                let id = str_of(params, "frameId");
                let mut state = self.state.lock().unwrap();
                if state.main_frame == id && session.is_none() {
                    let url = str_of(params, "url");
                    let kind = str_of(params, "navigationType");
                    let same_document = kind == "sameDocument" || kind.starts_with("same");
                    if !same_document {
                        self.push(&mut state, TabEvent::NavigationStarted { url });
                    }
                }
            }
            "Page.frameDetached" => {
                let id = str_of(params, "frameId");
                let reason = str_of(params, "reason");
                let mut state = self.state.lock().unwrap();
                if reason == "swap" {
                    // The frame moves to its own process; its child target attaches next and takes it over.
                    state.worlds.remove(&id);
                } else {
                    Self::remove_frame_tree(&mut state, &id);
                }
            }
            "Page.lifecycleEvent" => {
                let id = str_of(params, "frameId");
                let name = str_of(params, "name");
                let loader = str_of(params, "loaderId");
                let mut state = self.state.lock().unwrap();
                let generation = next_generation();
                if let Some(frame) = state.frames.get_mut(&id) {
                    if name == "init" {
                        frame.lifecycle.clear();
                        if !loader.is_empty() && frame.loader_id != loader {
                            frame.loader_id = loader;
                            frame.generation = generation;
                        }
                    }
                    frame.lifecycle.insert(name);
                }
            }
            "Page.domContentEventFired" | "Page.loadEventFired" => {
                if session.is_none() {
                    let mut state = self.state.lock().unwrap();
                    let main = state.main_frame.clone();
                    let name = if event.method == "Page.loadEventFired" { "load" } else { "DOMContentLoaded" };
                    if let Some(frame) = state.frames.get_mut(&main) {
                        frame.lifecycle.insert(name.into());
                    }
                }
            }
            "Page.javascriptDialogOpening" => {
                let dialog = Dialog {
                    kind: str_of(params, "type"),
                    message: str_of(params, "message"),
                    default_prompt: str_of(params, "defaultPrompt"),
                    url: str_of(params, "url"),
                };
                let mut state = self.state.lock().unwrap();
                state.dialog = Some(dialog.clone());
                let policy = state.dialog_policy;
                self.push(&mut state, TabEvent::Dialog(dialog.clone()));
                drop(state);
                self.dialog_open.send_replace(true);
                let auto = match policy {
                    Some(DialogPolicy::Accept) => Some(true),
                    Some(DialogPolicy::Dismiss) => Some(false),
                    _ if dialog.kind == "beforeunload" => Some(true),
                    _ => None,
                };
                if let Some(accept) = auto {
                    let shared = self.clone();
                    let session = session.clone();
                    tokio::spawn(async move {
                        let params = if accept && dialog.kind == "prompt" {
                            json!({ "accept": true, "promptText": dialog.default_prompt })
                        } else {
                            json!({ "accept": accept })
                        };
                        if shared.cdp.send("Page.handleJavaScriptDialog", params, session.as_deref()).await.is_ok() {
                            shared.clear_dialog(Some(accept), true);
                        }
                    });
                }
            }
            "Page.javascriptDialogClosed" => {
                let accepted = params["result"].as_bool().unwrap_or(false);
                self.clear_dialog(Some(accepted), false);
                return;
            }
            "Page.windowOpen" => {
                let mut state = self.state.lock().unwrap();
                let url = str_of(params, "url");
                self.push(&mut state, TabEvent::Popup { url });
            }
            "Input.dragIntercepted" => {
                self.state.lock().unwrap().drag = Some(params["data"].clone());
            }
            "Inspector.targetCrashed" => {
                if session.is_none() {
                    let mut state = self.state.lock().unwrap();
                    self.push(&mut state, TabEvent::Crashed);
                }
            }
            "Target.attachedToTarget" => {
                let child = str_of(params, "sessionId");
                let info = &params["targetInfo"];
                let kind = str_of(info, "type");
                let target_id = str_of(info, "targetId");
                let waiting = params["waitingForDebugger"].as_bool().unwrap_or(false);
                let shared = self.clone();
                if kind == "iframe" {
                    let parent_frame = info.get("parentFrameId").and_then(Value::as_str).map(str::to_string);
                    self.state.lock().unwrap().sessions.insert(child.clone(), target_id.clone());
                    tokio::spawn(async move { shared.attach_child(child, target_id, parent_frame, waiting).await });
                } else if waiting {
                    tokio::spawn(async move {
                        let _ = shared.cdp.send("Runtime.runIfWaitingForDebugger", json!({}), Some(&child)).await;
                    });
                }
            }
            "Target.detachedFromTarget" => {
                let child = str_of(params, "sessionId");
                let mut state = self.state.lock().unwrap();
                if state.sessions.remove(&child).is_some() {
                    let ids: Vec<String> = state.frames.values().filter(|f| f.session.as_deref() == Some(child.as_str())).map(|f| f.id.clone()).collect();
                    for id in ids {
                        state.frames.remove(&id);
                        state.worlds.remove(&id);
                    }
                }
            }
            _ => return,
        }
        self.bump();
    }

    async fn attach_child(self: Arc<Self>, session: String, target_id: String, parent_frame: Option<String>, waiting: bool) {
        let cdp = self.cdp.clone();
        let s = Some(session.as_str());
        let _ = cdp.send("Page.enable", json!({}), s).await;
        let _ = cdp.send("Page.setLifecycleEventsEnabled", json!({ "enabled": true }), s).await;
        let tree = cdp.send("Page.getFrameTree", json!({}), s).await;
        let _ = cdp.send("Target.setAutoAttach", json!({ "autoAttach": true, "waitForDebuggerOnStart": false, "flatten": true }), s).await;
        if waiting {
            let _ = cdp.send("Runtime.runIfWaitingForDebugger", json!({}), s).await;
        }
        if let Ok(tree) = tree {
            let mut state = self.state.lock().unwrap();
            if !state.sessions.contains_key(&session) {
                return;
            }
            let previous_parent = state.frames.get(&target_id).and_then(|f| f.parent.clone());
            Self::merge_frames(&mut state, &tree["frameTree"], Some(&session));
            if let Some(frame) = state.frames.get_mut(&target_id)
                && frame.parent.is_none() {
                    frame.parent = parent_frame.or(previous_parent);
                }
            drop(state);
            self.bump();
        }
    }
}

async fn pump(shared: Arc<Shared>, mut events: broadcast::Receiver<CdpEvent>) {
    loop {
        match events.recv().await {
            Ok(event) => shared.handle(event),
            Err(broadcast::error::RecvError::Lagged(_)) => continue,
            Err(broadcast::error::RecvError::Closed) => break,
        }
    }
    shared.bump();
}
