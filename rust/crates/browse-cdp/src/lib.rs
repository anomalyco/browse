//! Chrome DevTools Protocol implementation of `browse_core::{TabDriver, CaptureDriver, Screencast}`.
//!
//! All CDP-specific reconciliation lives here so the harness stays protocol-agnostic:
//! - Driver-owned frame tree, `DocumentId` bumping, OOPIF child target auto-attach, and invisible process swaps
//! - Lazy per-(frame, document) `World::Isolated` creation without `Runtime.enable`
//! - Typed `DriverError` mapping (no Chrome error strings leaking upward)
//! - `Network.enable` refcounting shared between network capture and offline emulation
//! - HTML5 drag interception (`Input.setInterceptDrags` / `Input.dragIntercepted` / `Input.dispatchDragEvent`)
//! - Dialog scope tracking, DOM key-to-CDP translation, and tiled fallback for oversized screenshots

mod console;
mod input;
mod network;
mod screencast;
pub mod wire;

pub use wire::{Cdp, CdpError, CdpEvent};

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use base64::Engine;
use browse_core::{
    Arg, BodyKind, CallOptions, CaptureDriver, CloseReason, ConsoleEvent, Dialog, DialogKind, DocumentId, DragOutcome,
    DriverError, DriverResult, Emulation, Eval, Evaluated, Frame, FrameId, Image, ImageFormat, JsError, KeyEvent,
    LoadState, Modifiers, MouseButton, NavigationError, NavigationErrorKind, NavigationId, NetworkEvent,
    NetworkOptions, PageEvent, PointerEvent, PointerStep, Realm, Receiver, RemoteRef, RequestId, Returns, Screencast,
    ScreencastFrame, ScreencastOptions, Screenshot, ScreenshotArea, Subscription, TabDriver, Viewport, World,
};
use serde_json::{Value, json};
use tokio::sync::{broadcast, watch};

use crate::network::{NetworkBodyMap, NetworkDomain};
use crate::wire::map_cdp_error;

const TILE_SIDE: f64 = 4_096.0;
const MAX_TILED_PIXELS: u64 = 16 * 1024 * 1024;

fn next_document_id() -> DocumentId {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    DocumentId(NEXT.fetch_add(1, Ordering::Relaxed))
}

fn world_name() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("__b{:x}", (nanos as u64) ^ (std::process::id() as u64).rotate_left(17))
}

fn str_of(value: &Value, key: &str) -> String {
    value.get(key).and_then(Value::as_str).unwrap_or_default().to_string()
}

fn is_fragment_change(current: &str, next: &str) -> bool {
    let cur_base = current.split('#').next().unwrap_or("");
    let next_base = next.split('#').next().unwrap_or("");
    next.contains('#') && !current.is_empty() && cur_base == next_base
}

#[derive(Clone)]
struct FrameEntry {
    frame: Frame,
    loader_id: String,
    session: Option<String>,
}

#[derive(Default)]
struct DriverState {
    main_frame: Option<FrameId>,
    frames: HashMap<FrameId, FrameEntry>,
    /// Active child target sessions (`session_id` -> `target_id`).
    sessions: HashMap<String, FrameId>,
    /// Cached isolated world CDP `executionContextId` per `(frame_id, document_id)`.
    isolated_worlds: HashMap<(FrameId, DocumentId), i64>,
    /// Active CDP session scope that opened the current JS dialog.
    dialog_scope: Option<String>,
    /// Pressed mouse buttons bitmask for CDP `Input.dispatchMouseEvent`.
    buttons: i64,
    /// Captured HTML5 drag payload from `Input.dragIntercepted`.
    drag_data: Option<Value>,
    /// Whether `Closed` terminal event has already been emitted.
    closed: bool,
}

struct Shared {
    cdp: Arc<dyn Cdp>,
    world_name: String,
    state: Mutex<DriverState>,
    events: Mutex<Option<broadcast::Sender<PageEvent>>>,
    drag_watch: watch::Sender<u64>,
    page_init: tokio::sync::OnceCell<()>,
    world_lock: tokio::sync::Mutex<()>,
    network_domain: Arc<Mutex<NetworkDomain>>,
    network_bodies: Arc<Mutex<NetworkBodyMap>>,
}

impl Shared {
    fn emit(&self, event: PageEvent) {
        if let Some(sender) = self.events.lock().unwrap().as_ref() {
            let _ = sender.send(event);
        }
    }

    fn emit_closed(&self, reason: CloseReason) {
        let should_emit = {
            let mut st = self.state.lock().unwrap();
            if st.closed {
                false
            } else {
                st.closed = true;
                true
            }
        };
        if should_emit {
            self.emit(PageEvent::Closed(reason));
        }
    }

    fn session_for(&self, frame: &FrameId) -> Option<String> {
        self.state
            .lock()
            .unwrap()
            .frames
            .get(frame)
            .and_then(|entry| entry.session.clone())
    }

    fn document_for(&self, frame: &FrameId) -> DocumentId {
        self.state
            .lock()
            .unwrap()
            .frames
            .get(frame)
            .map(|entry| entry.frame.document)
            .unwrap_or_default()
    }

    async fn ensure_page_enabled(&self) -> DriverResult<()> {
        self.page_init
            .get_or_try_init(|| async {
                self.cdp.send("Page.enable", json!({}), None).await.map_err(map_cdp_error)?;
                let _ = self
                    .cdp
                    .send("Page.setLifecycleEventsEnabled", json!({ "enabled": true }), None)
                    .await;
                let tree = self
                    .cdp
                    .send("Page.getFrameTree", json!({}), None)
                    .await
                    .map_err(map_cdp_error)?;
                self.merge_frame_tree(&tree["frameTree"], None, true, None);
                let _ = self
                    .cdp
                    .send(
                        "Target.setAutoAttach",
                        json!({ "autoAttach": true, "waitForDebuggerOnStart": false, "flatten": true }),
                        None,
                    )
                    .await;
                let _ = self
                    .cdp
                    .send("Emulation.setFocusEmulationEnabled", json!({ "enabled": true }), None)
                    .await;
                Ok(())
            })
            .await
            .copied()
    }

    fn merge_frame_tree(
        &self,
        node: &Value,
        session: Option<&str>,
        is_root: bool,
        root_parent: Option<(FrameId, FrameId)>,
    ) -> Vec<Frame> {
        let mut st = self.state.lock().unwrap();
        let mut collected = Vec::new();
        Self::merge_node(&mut st, node, session, is_root, &mut collected);
        if let Some((target, parent)) = root_parent
            && let Some(entry) = st.frames.get_mut(&target)
            && entry.frame.parent.is_none()
        {
            entry.frame.parent = Some(parent.clone());
            if let Some(f) = collected.iter_mut().find(|f| f.id == target) {
                f.parent = Some(parent);
            }
        }
        collected
    }

    fn merge_node(
        st: &mut DriverState,
        node: &Value,
        session: Option<&str>,
        is_root: bool,
        out: &mut Vec<Frame>,
    ) {
        let frame_obj = &node["frame"];
        let id_str = str_of(frame_obj, "id");
        if id_str.is_empty() {
            return;
        }
        let id = FrameId::from(id_str);
        if is_root && session.is_none() {
            st.main_frame = Some(id.clone());
        }
        let parent = frame_obj
            .get("parentId")
            .and_then(Value::as_str)
            .map(FrameId::from);
        let url = format!("{}{}", str_of(frame_obj, "url"), str_of(frame_obj, "urlFragment"));
        let name = str_of(frame_obj, "name");
        let loader = str_of(frame_obj, "loaderId");

        let entry = st.frames.entry(id.clone()).or_insert_with(|| FrameEntry {
            frame: Frame {
                id: id.clone(),
                parent: parent.clone(),
                url: String::new(),
                name: String::new(),
                document: next_document_id(),
            },
            loader_id: String::new(),
            session: session.map(str::to_string),
        });
        entry.session = session.map(str::to_string);
        if parent.is_some() {
            entry.frame.parent = parent;
        }
        if entry.loader_id != loader {
            entry.loader_id = loader;
            entry.frame.document = next_document_id();
        }
        entry.frame.url = url;
        entry.frame.name = name;
        out.push(entry.frame.clone());

        if let Some(children) = node["childFrames"].as_array() {
            for child in children {
                Self::merge_node(st, child, session, false, out);
            }
        }
    }

    fn ordered_frames(&self) -> Vec<Frame> {
        let st = self.state.lock().unwrap();
        let Some(main) = st.main_frame.clone() else {
            return st.frames.values().map(|e| e.frame.clone()).collect();
        };
        let mut out = Vec::new();
        let mut queue = vec![main];
        let mut seen = HashSet::new();
        while let Some(id) = queue.pop() {
            if !seen.insert(id.clone()) {
                continue;
            }
            if let Some(entry) = st.frames.get(&id) {
                out.push(entry.frame.clone());
                let mut children: Vec<FrameId> = st
                    .frames
                    .values()
                    .filter(|e| e.frame.parent.as_ref() == Some(&id))
                    .map(|e| e.frame.id.clone())
                    .collect();
                children.sort();
                children.reverse();
                queue.extend(children);
            }
        }
        out
    }

    fn remove_frame_tree(st: &mut DriverState, id: &FrameId) {
        let children: Vec<FrameId> = st
            .frames
            .values()
            .filter(|e| e.frame.parent.as_ref() == Some(id))
            .map(|e| e.frame.id.clone())
            .collect();
        for child in children {
            Self::remove_frame_tree(st, &child);
        }
        st.frames.remove(id);
        st.isolated_worlds.retain(|(f, _), _| f != id);
    }

    async fn isolated_context(&self, frame: &FrameId) -> DriverResult<(i64, DocumentId, Option<String>)> {
        {
            let st = self.state.lock().unwrap();
            let entry = st.frames.get(frame).ok_or(DriverError::Stale)?;
            let doc = entry.frame.document;
            if let Some(&ctx) = st.isolated_worlds.get(&(frame.clone(), doc)) {
                return Ok((ctx, doc, entry.session.clone()));
            }
        }
        let _guard = self.world_lock.lock().await;
        let (doc, session) = {
            let st = self.state.lock().unwrap();
            let entry = st.frames.get(frame).ok_or(DriverError::Stale)?;
            let doc = entry.frame.document;
            if let Some(&ctx) = st.isolated_worlds.get(&(frame.clone(), doc)) {
                return Ok((ctx, doc, entry.session.clone()));
            }
            (doc, entry.session.clone())
        };
        let created = self
            .cdp
            .send(
                "Page.createIsolatedWorld",
                json!({
                    "frameId": frame.as_str(),
                    "worldName": self.world_name,
                    "grantUniveralAccess": true,
                }),
                session.as_deref(),
            )
            .await
            .map_err(map_cdp_error)?;
        let context_id = created["executionContextId"]
            .as_i64()
            .ok_or_else(|| DriverError::Protocol("Chrome did not create an isolated world for the frame".into()))?;
        let mut st = self.state.lock().unwrap();
        let current_doc = st.frames.get(frame).map(|e| e.frame.document);
        if current_doc != Some(doc) {
            return Err(DriverError::Stale);
        }
        st.isolated_worlds.insert((frame.clone(), doc), context_id);
        Ok((context_id, doc, session))
    }

    fn invalidate_isolated(&self, frame: &FrameId) {
        self.state
            .lock()
            .unwrap()
            .isolated_worlds
            .retain(|(f, _), _| f != frame);
    }

    async fn main_world_document_object(&self, frame: &FrameId) -> DriverResult<(String, DocumentId, Option<String>)> {
        let (ctx, doc, session) = self.isolated_context(frame).await?;
        let doc_res = self
            .cdp
            .send(
                "Runtime.evaluate",
                json!({ "expression": "document", "contextId": ctx }),
                session.as_deref(),
            )
            .await
            .map_err(map_cdp_error)?;
        let iso_id = str_of(&doc_res["result"], "objectId");
        if iso_id.is_empty() {
            return Err(DriverError::Stale);
        }
        let described = self
            .cdp
            .send("DOM.describeNode", json!({ "objectId": iso_id }), session.as_deref())
            .await
            .map_err(map_cdp_error);
        let _ = self
            .cdp
            .send("Runtime.releaseObject", json!({ "objectId": iso_id }), session.as_deref())
            .await;
        let described = described?;
        let backend = described["node"]["backendNodeId"]
            .as_i64()
            .ok_or_else(|| DriverError::Protocol("Chrome did not describe the frame document".into()))?;
        let resolved = self
            .cdp
            .send("DOM.resolveNode", json!({ "backendNodeId": backend }), session.as_deref())
            .await
            .map_err(map_cdp_error)?;
        let object_id = str_of(&resolved["object"], "objectId");
        if object_id.is_empty() {
            return Err(DriverError::Protocol("Chrome could not resolve the frame document in main world".into()));
        }
        Ok((object_id, doc, session))
    }

    fn handle_cdp_event(self: &Arc<Self>, event: CdpEvent) {
        let session = event.session_id.clone();
        let params = &event.params;
        match event.method.as_str() {
            "Page.frameAttached" => {
                let id = FrameId::from(str_of(params, "frameId"));
                if id.as_str().is_empty() {
                    return;
                }
                let parent = params.get("parentFrameId").and_then(Value::as_str).map(FrameId::from);
                let frame = {
                    let mut st = self.state.lock().unwrap();
                    let entry = st.frames.entry(id.clone()).or_insert_with(|| FrameEntry {
                        frame: Frame {
                            id: id.clone(),
                            parent: parent.clone(),
                            url: String::new(),
                            name: String::new(),
                            document: next_document_id(),
                        },
                        loader_id: String::new(),
                        session: session.clone(),
                    });
                    entry.session = session;
                    entry.frame.clone()
                };
                self.emit(PageEvent::FrameAttached(frame));
            }
            "Page.frameNavigated" => {
                let frame_obj = &params["frame"];
                let id = FrameId::from(str_of(frame_obj, "id"));
                if id.as_str().is_empty() {
                    return;
                }
                let unreachable = str_of(frame_obj, "unreachableUrl");
                let url = if unreachable.is_empty() {
                    format!("{}{}", str_of(frame_obj, "url"), str_of(frame_obj, "urlFragment"))
                } else {
                    unreachable
                };
                let name = str_of(frame_obj, "name");
                let parent = frame_obj.get("parentId").and_then(Value::as_str).map(FrameId::from);
                let loader = str_of(frame_obj, "loaderId");
                let is_main = parent.is_none() && session.is_none();

                let (document, removed_children) = {
                    let mut st = self.state.lock().unwrap();
                    if is_main {
                        st.main_frame = Some(id.clone());
                    }
                    let entry = st.frames.entry(id.clone()).or_insert_with(|| FrameEntry {
                        frame: Frame {
                            id: id.clone(),
                            parent: parent.clone(),
                            url: String::new(),
                            name: String::new(),
                            document: next_document_id(),
                        },
                        loader_id: String::new(),
                        session: session.clone(),
                    });
                    entry.frame.url = url.clone();
                    entry.frame.name = name.clone();
                    entry.session = session.clone();
                    if parent.is_some() {
                        entry.frame.parent = parent;
                    }
                    if entry.loader_id != loader {
                        entry.loader_id = loader.clone();
                        entry.frame.document = next_document_id();
                    }
                    let document = entry.frame.document;
                    st.isolated_worlds.retain(|(f, _), _| f != &id);
                    let children: Vec<FrameId> = st
                        .frames
                        .values()
                        .filter(|e| e.frame.parent.as_ref() == Some(&id) && e.session == session)
                        .map(|e| e.frame.id.clone())
                        .collect();
                    for child in &children {
                        Self::remove_frame_tree(&mut st, child);
                    }
                    (document, children)
                };
                for child in removed_children {
                    self.emit(PageEvent::FrameDetached(child));
                }
                let navigation = (!loader.is_empty()).then(|| NavigationId::from(loader));
                self.emit(PageEvent::Committed { frame: id, document, navigation, url, name });
            }
            "Page.navigatedWithinDocument" => {
                let id = FrameId::from(str_of(params, "frameId"));
                let url = str_of(params, "url");
                if let Some(entry) = self.state.lock().unwrap().frames.get_mut(&id) {
                    entry.frame.url = url.clone();
                }
                self.emit(PageEvent::UrlChanged { frame: id, url });
            }
            "Page.frameRequestedNavigation" | "Page.frameStartedNavigating" => {
                if session.is_some() {
                    return;
                }
                let id = FrameId::from(str_of(params, "frameId"));
                let url = str_of(params, "url");
                let kind = str_of(params, "navigationType");
                let disposition = str_of(params, "disposition");
                let elsewhere = !disposition.is_empty() && disposition != "currentTab";
                if elsewhere {
                    return;
                }
                let is_main = {
                    let st = self.state.lock().unwrap();
                    let main_matches = st.main_frame.as_ref() == Some(&id);
                    let current = st.frames.get(&id).map(|e| e.frame.url.clone()).unwrap_or_default();
                    let same_doc = kind == "sameDocument"
                        || kind == "historySameDocument"
                        || (kind.is_empty() && is_fragment_change(&current, &url));
                    main_matches && !same_doc
                };
                if is_main {
                    let loader = str_of(params, "loaderId");
                    let navigation = (!loader.is_empty()).then(|| NavigationId::from(loader));
                    self.emit(PageEvent::NavigationStarted { frame: id, navigation, url });
                }
            }
            "Page.frameStoppedLoading" => {
                if session.is_none() {
                    let id = FrameId::from(str_of(params, "frameId"));
                    self.emit(PageEvent::NavigationAborted { frame: id });
                }
            }
            "Page.frameDetached" => {
                let id = FrameId::from(str_of(params, "frameId"));
                let swapped = str_of(params, "reason") == "swap";
                if swapped {
                    // Process swaps are invisible to the harness: only drop the old process's isolated world.
                    self.invalidate_isolated(&id);
                } else {
                    Self::remove_frame_tree(&mut self.state.lock().unwrap(), &id);
                    self.emit(PageEvent::FrameDetached(id));
                }
            }
            "Page.lifecycleEvent" => {
                let id = FrameId::from(str_of(params, "frameId"));
                let name = str_of(params, "name");
                let loader = str_of(params, "loaderId");
                let doc = {
                    let mut st = self.state.lock().unwrap();
                    let (doc, changed) = {
                        let Some(entry) = st.frames.get_mut(&id) else { return };
                        let changed = name == "init" && !loader.is_empty() && entry.loader_id != loader;
                        if changed {
                            entry.loader_id = loader;
                            entry.frame.document = next_document_id();
                        }
                        (entry.frame.document, changed)
                    };
                    if changed {
                        st.isolated_worlds.retain(|(f, _), _| f != &id);
                    }
                    doc
                };
                let state = match name.as_str() {
                    "DOMContentLoaded" => Some(LoadState::DomContentLoaded),
                    "load" => Some(LoadState::Load),
                    "networkAlmostIdle" | "networkIdle" => Some(LoadState::NetworkIdle),
                    _ => None,
                };
                if let Some(state) = state {
                    self.emit(PageEvent::Loaded { frame: id, document: doc, state });
                }
            }
            "Page.domContentEventFired" | "Page.loadEventFired" if session.is_none() => {
                let target = {
                    let st = self.state.lock().unwrap();
                    st.main_frame
                        .as_ref()
                        .and_then(|id| st.frames.get(id).map(|e| (id.clone(), e.frame.document)))
                };
                if let Some((frame, document)) = target {
                    let state = if event.method == "Page.loadEventFired" {
                        LoadState::Load
                    } else {
                        LoadState::DomContentLoaded
                    };
                    self.emit(PageEvent::Loaded { frame, document, state });
                }
            }
            "Page.javascriptDialogOpening" => {
                let dialog = Dialog {
                    kind: DialogKind::from_wire(&str_of(params, "type")),
                    message: str_of(params, "message"),
                    default_prompt: str_of(params, "defaultPrompt"),
                    url: str_of(params, "url"),
                };
                self.state.lock().unwrap().dialog_scope = session;
                self.emit(PageEvent::DialogOpened(dialog));
            }
            "Page.javascriptDialogClosed" => {
                self.state.lock().unwrap().dialog_scope = None;
                let accepted = params["result"].as_bool().unwrap_or(false);
                self.emit(PageEvent::DialogClosed { accepted });
            }
            "Page.windowOpen" => {
                self.emit(PageEvent::PopupOpened { url: str_of(params, "url") });
            }
            "Input.dragIntercepted" => {
                self.state.lock().unwrap().drag_data = Some(params["data"].clone());
                self.drag_watch.send_modify(|n| *n += 1);
            }
            "Inspector.targetCrashed" | "Target.targetCrashed" if session.is_none() => {
                self.emit_closed(CloseReason::Crashed);
            }
            "Inspector.detached" if session.is_none() => {
                let reason = params
                    .get("reason")
                    .and_then(Value::as_str)
                    .unwrap_or("detached")
                    .to_string();
                self.emit_closed(CloseReason::Detached(reason));
            }
            "Target.attachedToTarget" => {
                let child = str_of(params, "sessionId");
                let info = &params["targetInfo"];
                let kind = str_of(info, "type");
                let target_id = FrameId::from(str_of(info, "targetId"));
                let waiting = params["waitingForDebugger"].as_bool().unwrap_or(false);
                let shared = self.clone();
                if kind == "iframe" {
                    let parent_frame = info.get("parentFrameId").and_then(Value::as_str).map(FrameId::from);
                    self.state.lock().unwrap().sessions.insert(child.clone(), target_id.clone());
                    tokio::spawn(async move {
                        shared.attach_child(child, target_id, parent_frame, waiting).await;
                    });
                } else if waiting {
                    tokio::spawn(async move {
                        let _ = shared
                            .cdp
                            .send("Runtime.runIfWaitingForDebugger", json!({}), Some(&child))
                            .await;
                    });
                }
            }
            "Target.detachedFromTarget" => {
                let child = str_of(params, "sessionId");
                let removed = {
                    let mut st = self.state.lock().unwrap();
                    if st.sessions.remove(&child).is_some() {
                        let ids: Vec<FrameId> = st
                            .frames
                            .values()
                            .filter(|e| e.session.as_deref() == Some(child.as_str()))
                            .map(|e| e.frame.id.clone())
                            .collect();
                        for id in &ids {
                            st.frames.remove(id);
                            st.isolated_worlds.retain(|(f, _), _| f != id);
                        }
                        ids
                    } else {
                        Vec::new()
                    }
                };
                for id in removed {
                    self.emit(PageEvent::FrameDetached(id));
                }
            }
            _ => {}
        }
    }

    async fn attach_child(
        self: Arc<Self>,
        session: String,
        target_id: FrameId,
        parent_frame: Option<FrameId>,
        waiting: bool,
    ) {
        let s = Some(session.as_str());
        let _ = self.cdp.send("Page.enable", json!({}), s).await;
        let _ = self
            .cdp
            .send("Page.setLifecycleEventsEnabled", json!({ "enabled": true }), s)
            .await;
        let tree = self.cdp.send("Page.getFrameTree", json!({}), s).await;
        let _ = self
            .cdp
            .send(
                "Target.setAutoAttach",
                json!({ "autoAttach": true, "waitForDebuggerOnStart": false, "flatten": true }),
                s,
            )
            .await;
        if waiting {
            let _ = self.cdp.send("Runtime.runIfWaitingForDebugger", json!({}), s).await;
        }
        if let Ok(tree) = tree {
            let previous_parent = {
                let st = self.state.lock().unwrap();
                if !st.sessions.contains_key(&session) {
                    return;
                }
                st.frames.get(&target_id).and_then(|e| e.frame.parent.clone())
            };
            let resolved_parent = parent_frame.or(previous_parent).map(|p| (target_id.clone(), p));
            let frames = self.merge_frame_tree(&tree["frameTree"], Some(&session), false, resolved_parent);
            for frame in frames {
                self.emit(PageEvent::FrameAttached(frame));
            }
        }
    }
}

/// CDP implementation of `TabDriver`, `CaptureDriver`, and `Screencast`.
pub struct CdpTabDriver {
    shared: Arc<Shared>,
    pump: tokio::task::JoinHandle<()>,
}

impl CdpTabDriver {
    pub fn new(cdp: Arc<dyn Cdp>) -> Arc<Self> {
        let mut raw_events = cdp.events();
        let (events, _) = broadcast::channel(2048);
        let (drag_watch, _) = watch::channel(0u64);
        let shared = Arc::new(Shared {
            cdp,
            world_name: world_name(),
            state: Mutex::new(DriverState::default()),
            events: Mutex::new(Some(events)),
            drag_watch,
            page_init: tokio::sync::OnceCell::new(),
            world_lock: tokio::sync::Mutex::new(()),
            network_domain: Arc::new(Mutex::new(NetworkDomain::default())),
            network_bodies: Arc::new(Mutex::new(NetworkBodyMap::default())),
        });
        let pump_shared = shared.clone();
        let pump = tokio::spawn(async move {
            loop {
                match raw_events.recv().await {
                    Ok(event) => pump_shared.handle_cdp_event(event),
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
            pump_shared.emit_closed(CloseReason::Closed);
            pump_shared.events.lock().unwrap().take();
        });
        Arc::new(Self { shared, pump })
    }

    pub fn cdp(&self) -> &Arc<dyn Cdp> {
        &self.shared.cdp
    }

    async fn send_mouse(&self, params: Value) -> DriverResult<()> {
        self.shared
            .cdp
            .send("Input.dispatchMouseEvent", params, None)
            .await
            .map_err(map_cdp_error)?;
        Ok(())
    }

    async fn capture_raw(
        &self,
        format: ImageFormat,
        quality: Option<i64>,
        clip: Option<(f64, f64, f64, f64, f64)>,
        beyond: bool,
    ) -> DriverResult<Vec<u8>> {
        let mut params = json!({
            "format": format.name(),
            "captureBeyondViewport": beyond,
            "fromSurface": true,
        });
        if let Some((x, y, width, height, scale)) = clip {
            params["clip"] = json!({ "x": x, "y": y, "width": width, "height": height, "scale": scale });
        }
        if format != ImageFormat::Png {
            params["quality"] = json!(quality.unwrap_or(80));
        }
        let result = self
            .shared
            .cdp
            .send("Page.captureScreenshot", params, None)
            .await
            .map_err(map_cdp_error)?;
        let data = result
            .get("data")
            .and_then(Value::as_str)
            .ok_or_else(|| DriverError::Protocol("Chrome returned no image".into()))?;
        base64::engine::general_purpose::STANDARD
            .decode(data)
            .map_err(|error| DriverError::Protocol(format!("invalid screenshot image data: {error}")))
    }

    async fn capture_tiled(&self, x: f64, y: f64, width: f64, height: f64, scale: f64) -> DriverResult<Vec<u8>> {
        let dpr = self.viewport().await?.device_pixel_ratio;
        let per_css = scale * dpr;
        let total_width = (width * per_css).round() as u64;
        let total_height = (height * per_css).round() as u64;
        if total_width * total_height > MAX_TILED_PIXELS {
            return Err(DriverError::Refused("too large to stitch (over 16 megapixels)".into()));
        }
        let strip = (TILE_SIDE / per_css).floor().max(1.0);
        let mut rgba = Vec::new();
        let mut stitched_height = 0u32;
        let expected_width = total_width as u32;
        let mut offset = 0.0;
        while offset < height {
            let part = strip.min(height - offset);
            let left = x.round();
            let top = (y + offset).round();
            let tw = width.round().max(1.0);
            let th = part.round().max(1.0);
            let png_bytes = self
                .capture_raw(ImageFormat::Png, None, Some((left, top, tw, th, scale)), true)
                .await?;
            let (w, h, data) = decode_png_rgba(&png_bytes)?;
            if w != expected_width {
                return Err(DriverError::Protocol("tiles came back with different widths".into()));
            }
            stitched_height += h;
            rgba.extend_from_slice(&data);
            offset += part;
        }
        encode_png_rgba(expected_width, stitched_height, &rgba)
    }
}

impl Drop for CdpTabDriver {
    fn drop(&mut self) {
        self.pump.abort();
    }
}

#[async_trait]
impl TabDriver for CdpTabDriver {
    fn events(&self) -> broadcast::Receiver<PageEvent> {
        match self.shared.events.lock().unwrap().as_ref() {
            Some(sender) => sender.subscribe(),
            None => broadcast::channel(1).1,
        }
    }

    async fn frames(&self) -> DriverResult<Vec<Frame>> {
        self.shared.ensure_page_enabled().await?;
        let current = self.shared.ordered_frames();
        if !current.is_empty() {
            return Ok(current);
        }
        let tree = self
            .shared
            .cdp
            .send("Page.getFrameTree", json!({}), None)
            .await
            .map_err(map_cdp_error)?;
        self.shared.merge_frame_tree(&tree["frameTree"], None, true, None);
        Ok(self.shared.ordered_frames())
    }

    async fn navigate(&self, url: &str, referrer: Option<&str>) -> DriverResult<Option<NavigationId>> {
        self.shared.ensure_page_enabled().await?;
        let mut params = json!({ "url": url });
        if let Some(referrer) = referrer {
            params["referrer"] = json!(referrer);
        }
        let result = self
            .shared
            .cdp
            .send("Page.navigate", params, None)
            .await
            .map_err(map_cdp_error)?;
        if let Some(error) = result["errorText"].as_str().filter(|e| !e.is_empty())
            && error != "net::ERR_HTTP_RESPONSE_CODE_FAILURE"
        {
            let scheme = url.split(':').next().unwrap_or("").to_ascii_lowercase();
            let kind = if scheme == "data" {
                NavigationErrorKind::Blocked
            } else if error.contains("ERR_ABORTED") {
                NavigationErrorKind::Aborted
            } else {
                NavigationErrorKind::Failed
            };
            return Err(DriverError::Navigation(NavigationError {
                kind,
                detail: error.to_string(),
            }));
        }
        Ok(result["loaderId"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(NavigationId::from))
    }

    async fn reload(&self, bypass_cache: bool) -> DriverResult<()> {
        self.shared.ensure_page_enabled().await?;
        self.shared
            .cdp
            .send("Page.reload", json!({ "ignoreCache": bypass_cache }), None)
            .await
            .map_err(map_cdp_error)?;
        Ok(())
    }

    async fn traverse_history(&self, delta: i32) -> DriverResult<bool> {
        self.shared.ensure_page_enabled().await?;
        let history = self
            .shared
            .cdp
            .send("Page.getNavigationHistory", json!({}), None)
            .await
            .map_err(map_cdp_error)?;
        let index = history["currentIndex"].as_i64().unwrap_or(0) + delta as i64;
        let entries = history["entries"].as_array().cloned().unwrap_or_default();
        let Some(entry) = usize::try_from(index).ok().and_then(|i| entries.get(i)) else {
            return Ok(false);
        };
        self.shared
            .cdp
            .send("Page.navigateToHistoryEntry", json!({ "entryId": entry["id"] }), None)
            .await
            .map_err(map_cdp_error)?;
        Ok(true)
    }

    async fn evaluate(&self, realm: &Realm, expression: &str, opts: CallOptions) -> Eval {
        self.shared.ensure_page_enabled().await?;
        let return_by_value = opts.returns == Returns::Json;
        match realm.world {
            World::Isolated => {
                let (ctx, doc, session) = self.shared.isolated_context(&realm.frame).await?;
                let mut params = json!({
                    "expression": expression,
                    "contextId": ctx,
                    "returnByValue": return_by_value,
                    "awaitPromise": opts.await_promise,
                });
                if opts.user_activation {
                    params["userGesture"] = json!(true);
                }
                let result = self
                    .shared
                    .cdp
                    .send("Runtime.evaluate", params, session.as_deref())
                    .await
                    .map_err(|e| {
                        let mapped = map_cdp_error(e);
                        if matches!(mapped, DriverError::Stale) {
                            self.shared.invalidate_isolated(&realm.frame);
                        }
                        mapped
                    })?;
                Ok(parse_eval_result(&result, &realm.frame, World::Isolated, doc, return_by_value))
            }
            World::Main => {
                let (doc_obj, doc, session) = self.shared.main_world_document_object(&realm.frame).await?;
                let declaration = format!("function () {{ return ({expression}); }}");
                let mut params = json!({
                    "functionDeclaration": declaration,
                    "objectId": doc_obj,
                    "returnByValue": return_by_value,
                    "awaitPromise": opts.await_promise,
                    "generatePreview": true,
                });
                if opts.user_activation {
                    params["userGesture"] = json!(true);
                }
                let result = self
                    .shared
                    .cdp
                    .send("Runtime.callFunctionOn", params, session.as_deref())
                    .await
                    .map_err(map_cdp_error);
                let _ = self
                    .shared
                    .cdp
                    .send("Runtime.releaseObject", json!({ "objectId": doc_obj }), session.as_deref())
                    .await;
                let result = result?;
                Ok(parse_eval_result(&result, &realm.frame, World::Main, doc, return_by_value))
            }
        }
    }

    async fn call(&self, on: &Receiver, function: &str, args: &[Arg], opts: CallOptions) -> Eval {
        self.shared.ensure_page_enabled().await?;
        let return_by_value = opts.returns == Returns::Json;
        let encoded_args: Vec<Value> = args
            .iter()
            .map(|arg| match arg {
                Arg::Json(v) => json!({ "value": v }),
                Arg::Ref(r) => json!({ "objectId": r.token() }),
                Arg::Undefined => json!({}),
            })
            .collect();
        let mut params = json!({
            "functionDeclaration": function,
            "arguments": encoded_args,
            "returnByValue": return_by_value,
            "awaitPromise": opts.await_promise,
            "generatePreview": true,
        });
        if opts.user_activation {
            params["userGesture"] = json!(true);
        }

        let (frame, world, doc, session, temp_doc_obj) = match on {
            Receiver::Ref(handle) => {
                params["objectId"] = json!(handle.token());
                let session = self.shared.session_for(&handle.frame);
                (handle.frame.clone(), handle.world, handle.document, session, None)
            }
            Receiver::Global(realm) => match realm.world {
                World::Isolated => {
                    let (ctx, doc, session) = self.shared.isolated_context(&realm.frame).await?;
                    params["executionContextId"] = json!(ctx);
                    (realm.frame.clone(), World::Isolated, doc, session, None)
                }
                World::Main => {
                    let (doc_obj, doc, session) = self.shared.main_world_document_object(&realm.frame).await?;
                    params["objectId"] = json!(doc_obj);
                    (realm.frame.clone(), World::Main, doc, session, Some(doc_obj))
                }
            },
        };

        let result = self
            .shared
            .cdp
            .send("Runtime.callFunctionOn", params, session.as_deref())
            .await
            .map_err(|e| {
                let mapped = map_cdp_error(e);
                if matches!(mapped, DriverError::Stale) && world == World::Isolated {
                    self.shared.invalidate_isolated(&frame);
                }
                mapped
            });
        if let Some(doc_obj) = temp_doc_obj {
            let _ = self
                .shared
                .cdp
                .send("Runtime.releaseObject", json!({ "objectId": doc_obj }), session.as_deref())
                .await;
        }
        let result = result?;
        Ok(parse_eval_result(&result, &frame, world, doc, return_by_value))
    }

    async fn release(&self, refs: Vec<RemoteRef>) {
        if refs.is_empty() {
            return;
        }
        let mut set = tokio::task::JoinSet::new();
        for handle in refs {
            let cdp = self.shared.cdp.clone();
            let session = self.shared.session_for(&handle.frame);
            let id = handle.token().to_string();
            set.spawn(async move {
                let _ = cdp
                    .send("Runtime.releaseObject", json!({ "objectId": id }), session.as_deref())
                    .await;
            });
        }
        let _ = tokio::time::timeout(Duration::from_millis(400), async {
            while set.join_next().await.is_some() {}
        })
        .await;
        set.detach_all();
    }

    async fn adopt(&self, node: &RemoteRef, world: World) -> DriverResult<RemoteRef> {
        if node.world == world {
            return Ok(node.clone());
        }
        let session = self.shared.session_for(&node.frame);
        let described = self
            .shared
            .cdp
            .send("DOM.describeNode", json!({ "objectId": node.token() }), session.as_deref())
            .await
            .map_err(map_cdp_error)?;
        let backend = described["node"]["backendNodeId"]
            .as_i64()
            .ok_or_else(|| DriverError::Protocol("Chrome did not describe the node".into()))?;
        let mut params = json!({ "backendNodeId": backend });
        let doc = match world {
            World::Main => self.shared.document_for(&node.frame),
            World::Isolated => {
                let (ctx, doc, _) = self.shared.isolated_context(&node.frame).await?;
                params["executionContextId"] = json!(ctx);
                doc
            }
        };
        let resolved = self
            .shared
            .cdp
            .send("DOM.resolveNode", params, session.as_deref())
            .await
            .map_err(map_cdp_error)?;
        let object_id = str_of(&resolved["object"], "objectId");
        if object_id.is_empty() {
            return Err(DriverError::Protocol("Chrome could not resolve the node in the target world".into()));
        }
        Ok(RemoteRef::new(node.frame.clone(), world, doc, object_id))
    }

    async fn frame_element(&self, frame: &FrameId) -> DriverResult<RemoteRef> {
        let (parent, parent_session) = {
            let st = self.shared.state.lock().unwrap();
            let entry = st.frames.get(frame).ok_or(DriverError::Stale)?;
            let parent = entry.frame.parent.clone().ok_or_else(|| {
                DriverError::Protocol("The main frame has no owner element.".into())
            })?;
            let parent_entry = st.frames.get(&parent).ok_or(DriverError::Stale)?;
            (parent, parent_entry.session.clone())
        };
        let owner = self
            .shared
            .cdp
            .send(
                "DOM.getFrameOwner",
                json!({ "frameId": frame.as_str() }),
                parent_session.as_deref(),
            )
            .await
            .map_err(map_cdp_error)?;
        let backend = owner["backendNodeId"]
            .as_i64()
            .ok_or_else(|| DriverError::Protocol("Chrome did not report the iframe element".into()))?;
        let (ctx, doc, _) = self.shared.isolated_context(&parent).await?;
        let resolved = self
            .shared
            .cdp
            .send(
                "DOM.resolveNode",
                json!({ "backendNodeId": backend, "executionContextId": ctx }),
                parent_session.as_deref(),
            )
            .await
            .map_err(map_cdp_error)?;
        let object_id = str_of(&resolved["object"], "objectId");
        if object_id.is_empty() {
            return Err(DriverError::Protocol("Chrome could not resolve the iframe element".into()));
        }
        Ok(RemoteRef::new(parent, World::Isolated, doc, object_id))
    }

    async fn content_frame(&self, node: &RemoteRef) -> DriverResult<Option<FrameId>> {
        let session = self.shared.session_for(&node.frame);
        let described = self
            .shared
            .cdp
            .send("DOM.describeNode", json!({ "objectId": node.token() }), session.as_deref())
            .await
            .map_err(map_cdp_error)?;
        let frame_id = str_of(&described["node"], "frameId");
        Ok((!frame_id.is_empty()).then(|| FrameId::from(frame_id)))
    }

    async fn set_files(&self, input: &RemoteRef, paths: &[PathBuf]) -> DriverResult<()> {
        let session = self.shared.session_for(&input.frame);
        let strings: Vec<String> = paths.iter().map(|p| p.display().to_string()).collect();
        self.shared
            .cdp
            .send(
                "DOM.setFileInputFiles",
                json!({ "objectId": input.token(), "files": strings }),
                session.as_deref(),
            )
            .await
            .map_err(map_cdp_error)?;
        Ok(())
    }

    async fn pointer(&self, event: PointerEvent) -> DriverResult<()> {
        let params = match event {
            PointerEvent::Move { x, y, modifiers } => {
                let buttons = self.shared.state.lock().unwrap().buttons;
                json!({
                    "type": "mouseMoved",
                    "x": x,
                    "y": y,
                    "button": input::pressed_button(buttons),
                    "buttons": buttons,
                    "modifiers": modifiers.bits() as i64,
                })
            }
            PointerEvent::Down { x, y, button, click_count, modifiers } => {
                let buttons = {
                    let mut st = self.shared.state.lock().unwrap();
                    st.buttons |= input::button_bit(button);
                    st.buttons
                };
                json!({
                    "type": "mousePressed",
                    "x": x,
                    "y": y,
                    "button": button.as_str(),
                    "buttons": buttons,
                    "clickCount": click_count as i64,
                    "modifiers": modifiers.bits() as i64,
                })
            }
            PointerEvent::Up { x, y, button, click_count, modifiers } => {
                let buttons = {
                    let mut st = self.shared.state.lock().unwrap();
                    st.buttons &= !input::button_bit(button);
                    st.buttons
                };
                json!({
                    "type": "mouseReleased",
                    "x": x,
                    "y": y,
                    "button": button.as_str(),
                    "buttons": buttons,
                    "clickCount": click_count as i64,
                    "modifiers": modifiers.bits() as i64,
                })
            }
            PointerEvent::Wheel { x, y, delta_x, delta_y, modifiers } => json!({
                "type": "mouseWheel",
                "x": x,
                "y": y,
                "deltaX": delta_x,
                "deltaY": delta_y,
                "modifiers": modifiers.bits() as i64,
            }),
        };
        self.send_mouse(params).await
    }

    async fn key(&self, event: KeyEvent) -> DriverResult<()> {
        self.shared
            .cdp
            .send("Input.dispatchKeyEvent", input::key_event_params(&event), None)
            .await
            .map_err(map_cdp_error)?;
        Ok(())
    }

    async fn insert_text(&self, text: &str) -> DriverResult<()> {
        self.shared
            .cdp
            .send("Input.insertText", json!({ "text": text }), None)
            .await
            .map_err(map_cdp_error)?;
        Ok(())
    }

    async fn drag(
        &self,
        from: (f64, f64),
        to: (f64, f64),
        steps: &[PointerStep],
        modifiers: Modifiers,
    ) -> DriverResult<DragOutcome> {
        self.shared.state.lock().unwrap().drag_data = None;
        let _ = self
            .shared
            .cdp
            .send("Input.setInterceptDrags", json!({ "enabled": true }), None)
            .await;
        self.pointer(PointerEvent::Move { x: from.0, y: from.1, modifiers }).await?;
        self.pointer(PointerEvent::Down {
            x: from.0,
            y: from.1,
            button: MouseButton::Left,
            click_count: 1,
            modifiers,
        })
        .await?;
        let nudge = (
            from.0 + (to.0 - from.0).signum() * 5.0,
            from.1 + (to.1 - from.1).signum() * 5.0,
        );
        self.pointer(PointerEvent::Move { x: nudge.0, y: nudge.1, modifiers }).await?;

        let mut rx = self.shared.drag_watch.subscribe();
        let _ = tokio::time::timeout(
            Duration::from_millis(150),
            rx.wait_for(|_| self.shared.state.lock().unwrap().drag_data.is_some()),
        )
        .await;
        let _ = self
            .shared
            .cdp
            .send("Input.setInterceptDrags", json!({ "enabled": false }), None)
            .await;

        let data = self.shared.state.lock().unwrap().drag_data.take();
        for step in steps {
            if step.delay_ms > 0.0 {
                tokio::time::sleep(Duration::from_micros((step.delay_ms * 1000.0) as u64)).await;
            }
            self.pointer(PointerEvent::Move { x: step.x, y: step.y, modifiers }).await?;
        }
        self.pointer(PointerEvent::Move { x: to.0, y: to.1, modifiers }).await?;

        let outcome = if let Some(data) = data {
            for kind in ["dragEnter", "dragOver", "drop"] {
                self.shared
                    .cdp
                    .send(
                        "Input.dispatchDragEvent",
                        json!({
                            "type": kind,
                            "x": to.0,
                            "y": to.1,
                            "data": data,
                            "modifiers": modifiers.bits() as i64,
                        }),
                        None,
                    )
                    .await
                    .map_err(map_cdp_error)?;
            }
            DragOutcome::Dropped
        } else {
            DragOutcome::NotDraggable
        };
        self.pointer(PointerEvent::Up {
            x: to.0,
            y: to.1,
            button: MouseButton::Left,
            click_count: 1,
            modifiers,
        })
        .await?;
        Ok(outcome)
    }

    async fn answer_dialog(&self, accept: bool, text: Option<&str>) -> DriverResult<()> {
        let scope = self.shared.state.lock().unwrap().dialog_scope.clone();
        let mut params = json!({ "accept": accept });
        if let Some(text) = text {
            params["promptText"] = json!(text);
        }
        self.shared
            .cdp
            .send("Page.handleJavaScriptDialog", params, scope.as_deref())
            .await
            .map_err(map_cdp_error)?;
        self.shared.state.lock().unwrap().dialog_scope = None;
        Ok(())
    }

    async fn viewport(&self) -> DriverResult<Viewport> {
        let metrics = self
            .shared
            .cdp
            .send("Page.getLayoutMetrics", json!({}), None)
            .await
            .map_err(map_cdp_error)?;
        let css = metrics.get("cssVisualViewport").or_else(|| metrics.get("visualViewport"));
        let number = |value: Option<&Value>, key: &str| value.and_then(|v| v.get(key)).and_then(Value::as_f64);
        let width = number(css, "clientWidth").unwrap_or(1280.0);
        let height = number(css, "clientHeight").unwrap_or(720.0);
        let content = metrics.get("cssContentSize").or_else(|| metrics.get("contentSize"));
        let device_width = number(metrics.get("visualViewport"), "clientWidth");
        let zoom = number(css, "zoom").unwrap_or(1.0);
        let device_pixel_ratio = match (device_width, metrics.get("cssVisualViewport")) {
            (Some(device), Some(_)) if width > 0.0 => (device / width / zoom.max(f64::EPSILON)).max(0.1),
            _ => 1.0,
        };
        let layout = metrics.get("cssLayoutViewport");
        let layout_width = number(layout, "clientWidth").filter(|w| *w > 0.0);
        let layout_height = number(layout, "clientHeight").filter(|h| *h > 0.0);
        Ok(Viewport {
            page_x: number(css, "pageX").unwrap_or(0.0),
            page_y: number(css, "pageY").unwrap_or(0.0),
            width,
            height,
            layout_width,
            layout_height,
            content_width: number(content, "width").unwrap_or(width),
            content_height: number(content, "height").unwrap_or(height),
            device_pixel_ratio: (device_pixel_ratio * 1000.0).round() / 1000.0,
        })
    }

    async fn screenshot(&self, shot: Screenshot) -> DriverResult<Image> {
        let (clip, beyond) = match shot.area {
            ScreenshotArea::Viewport => (None, false),
            ScreenshotArea::Clip { rect, beyond_viewport } => (
                Some((rect.x, rect.y, rect.width, rect.height, shot.scale)),
                beyond_viewport,
            ),
        };
        match self.capture_raw(shot.format, shot.quality, clip, beyond).await {
            Ok(bytes) => Ok(Image { bytes, format: shot.format, note: None }),
            Err(DriverError::Protocol(message))
                if beyond
                    && message.contains("Unable to capture screenshot")
                    && let Some((x, y, w, h, s)) = clip =>
            {
                let stitched = self.capture_tiled(x, y, w, h, s).await.map_err(|error| {
                    DriverError::Protocol(format!(
                        "Chrome couldn't capture this screenshot ({message}; in tiles: {error}). Capture a clip or an element instead."
                    ))
                })?;
                let note = (shot.format != ImageFormat::Png)
                    .then(|| format!("taken in tiles and returned as PNG (asked for {})", shot.format.name()));
                Ok(Image { bytes: stitched, format: ImageFormat::Png, note })
            }
            Err(error) => Err(error),
        }
    }

    async fn emulate(&self, change: Emulation) -> DriverResult<()> {
        match change {
            Emulation::Viewport(None) => {
                self.shared
                    .cdp
                    .send("Emulation.clearDeviceMetricsOverride", json!({}), None)
                    .await
                    .map_err(map_cdp_error)?;
                tokio::time::sleep(Duration::from_millis(100)).await;
                self.shared
                    .cdp
                    .send("Emulation.clearDeviceMetricsOverride", json!({}), None)
                    .await
                    .map_err(map_cdp_error)?;
            }
            Emulation::Viewport(Some(v)) => {
                self.shared
                    .cdp
                    .send(
                        "Emulation.setDeviceMetricsOverride",
                        json!({
                            "width": v.width,
                            "height": v.height,
                            "deviceScaleFactor": v.device_scale_factor,
                            "mobile": v.mobile,
                        }),
                        None,
                    )
                    .await
                    .map_err(map_cdp_error)?;
            }
            Emulation::Media(override_) => {
                let features: Vec<Value> = override_
                    .features
                    .iter()
                    .map(|f| json!({ "name": f.name, "value": f.value }))
                    .collect();
                self.shared
                    .cdp
                    .send(
                        "Emulation.setEmulatedMedia",
                        json!({ "media": override_.media, "features": features }),
                        None,
                    )
                    .await
                    .map_err(map_cdp_error)?;
            }
            Emulation::UserAgent(agent) => {
                self.shared
                    .cdp
                    .send(
                        "Emulation.setUserAgentOverride",
                        json!({ "userAgent": agent.unwrap_or_default() }),
                        None,
                    )
                    .await
                    .map_err(map_cdp_error)?;
            }
            Emulation::Geolocation(None) => {
                self.shared
                    .cdp
                    .send("Emulation.clearGeolocationOverride", json!({}), None)
                    .await
                    .map_err(map_cdp_error)?;
            }
            Emulation::Geolocation(Some(geo)) => {
                self.shared
                    .cdp
                    .send(
                        "Emulation.setGeolocationOverride",
                        json!({
                            "latitude": geo.latitude,
                            "longitude": geo.longitude,
                            "accuracy": geo.accuracy,
                        }),
                        None,
                    )
                    .await
                    .map_err(map_cdp_error)?;
            }
            Emulation::Touch(max_points) => {
                let enabled = max_points.is_some();
                let points = max_points.unwrap_or(1);
                self.shared
                    .cdp
                    .send(
                        "Emulation.setTouchEmulationEnabled",
                        json!({ "enabled": enabled, "maxTouchPoints": points }),
                        None,
                    )
                    .await
                    .map_err(map_cdp_error)?;
            }
            Emulation::Offline(offline) => {
                let conditions = json!({
                    "offline": offline,
                    "latency": 0,
                    "downloadThroughput": -1,
                    "uploadThroughput": -1,
                });
                if offline {
                    self.shared
                        .cdp
                        .send("Network.enable", json!({}), None)
                        .await
                        .map_err(map_cdp_error)?;
                    self.shared
                        .cdp
                        .send("Network.emulateNetworkConditions", conditions, None)
                        .await
                        .map_err(map_cdp_error)?;
                    self.shared.network_domain.lock().unwrap().offline = true;
                } else {
                    let _ = self
                        .shared
                        .cdp
                        .send("Network.emulateNetworkConditions", conditions, None)
                        .await;
                    let should_disable = {
                        let mut guard = self.shared.network_domain.lock().unwrap();
                        guard.offline = false;
                        !guard.capture
                    };
                    if should_disable {
                        let _ = self.shared.cdp.send("Network.disable", json!({}), None).await;
                    }
                }
            }
        }
        Ok(())
    }

    async fn interrupt(&self, frame: Option<&FrameId>) -> DriverResult<()> {
        let session = frame.and_then(|id| self.shared.session_for(id));
        let root = self.shared.cdp.send("Runtime.terminateExecution", json!({}), None);
        let child = async {
            match session.as_deref() {
                Some(s) => self.shared.cdp.send("Runtime.terminateExecution", json!({}), Some(s)).await,
                None => Ok(Value::Null),
            }
        };
        let _ = tokio::time::timeout(Duration::from_millis(1_000), async {
            let _ = tokio::join!(root, child);
        })
        .await;
        Ok(())
    }

    fn capture(&self) -> &dyn CaptureDriver {
        self
    }
}

#[async_trait]
impl CaptureDriver for CdpTabDriver {
    async fn console(&self) -> DriverResult<Subscription<ConsoleEvent>> {
        console::start(self.shared.cdp.clone()).await
    }

    async fn network(&self, opts: NetworkOptions) -> DriverResult<Subscription<NetworkEvent>> {
        network::start(
            self.shared.cdp.clone(),
            self.shared.network_domain.clone(),
            self.shared.network_bodies.clone(),
            opts,
        )
        .await
    }

    async fn body(&self, request: &RequestId, kind: BodyKind) -> DriverResult<Option<Vec<u8>>> {
        network::fetch_body(self.shared.cdp.as_ref(), &self.shared.network_bodies, request, kind).await
    }

    fn screencast(&self) -> Option<&dyn Screencast> {
        Some(self)
    }
}

#[async_trait]
impl Screencast for CdpTabDriver {
    async fn start(&self, options: ScreencastOptions) -> DriverResult<Subscription<ScreencastFrame>> {
        screencast::start(self.shared.cdp.clone(), options).await
    }
}

fn parse_eval_result(
    value: &Value,
    frame: &FrameId,
    world: World,
    doc: DocumentId,
    return_by_value: bool,
) -> Result<Evaluated, Box<JsError>> {
    if let Some(details) = value.get("exceptionDetails") {
        return Err(Box::new(parse_js_error(details)));
    }
    let result = &value["result"];
    if !return_by_value
        && let Some(object_id) = result.get("objectId").and_then(Value::as_str)
        && !object_id.is_empty()
    {
        let handle = RemoteRef::new(frame.clone(), world, doc, object_id);
        return if result.get("subtype").and_then(Value::as_str) == Some("node") {
            Ok(Evaluated::Node(handle))
        } else {
            Ok(Evaluated::Object(handle))
        };
    }
    Ok(Evaluated::Json(result.get("value").cloned().unwrap_or(Value::Null)))
}

fn parse_js_error(details: &Value) -> JsError {
    let exception = &details["exception"];
    let class_name = exception.get("className").and_then(Value::as_str).map(str::to_string);
    let subtype = exception.get("subtype").and_then(Value::as_str);
    let description = exception.get("description").and_then(Value::as_str);
    let is_error = subtype == Some("error") || class_name.as_deref().is_some_and(|c| c.ends_with("Error"));

    let message = if is_error {
        let raw = description
            .map(str::to_string)
            .or_else(|| exception.get("value").and_then(Value::as_str).map(str::to_string))
            .unwrap_or_else(|| str_of(details, "text"));
        let lines: Vec<&str> = raw.lines().filter(|l| !l.trim_start().starts_with("at ")).collect();
        let joined = lines.join("\n");
        let stripped = joined.strip_prefix("Uncaught ").unwrap_or(&joined).to_string();
        if stripped.is_empty() { "the page threw an exception".into() } else { stripped }
    } else if let Some(value) = exception.get("value") {
        format!("threw {}", serde_json::to_string(value).unwrap_or_default())
    } else if let Some(unserializable) = exception.get("unserializableValue").and_then(Value::as_str) {
        format!("threw {unserializable}")
    } else if exception.get("type").and_then(Value::as_str) == Some("undefined") {
        "threw undefined".into()
    } else if let Some(preview) = exception.pointer("/preview/properties").and_then(Value::as_array) {
        let fields: Vec<String> = preview
            .iter()
            .map(|p| format!("{}: {}", str_of(p, "name"), str_of(p, "value")))
            .collect();
        format!("threw {} {{ {} }}", class_name.as_deref().unwrap_or("Object"), fields.join(", "))
    } else {
        format!("threw {}", description.unwrap_or("a value"))
    };

    let stack = description.map(str::to_string);
    let has_stack_trace = !details["stackTrace"].is_null();
    let is_compile_syntax_error = class_name.as_deref() == Some("SyntaxError") && !has_stack_trace;

    JsError {
        name: class_name,
        message,
        stack,
        thrown: exception.get("value").cloned(),
        url: details.get("url").and_then(Value::as_str).map(str::to_string),
        line: details.get("lineNumber").and_then(Value::as_i64),
        column: details.get("columnNumber").and_then(Value::as_i64),
        is_compile_syntax_error,
    }
}

fn decode_png_rgba(bytes: &[u8]) -> DriverResult<(u32, u32, Vec<u8>)> {
    let mut decoder = png::Decoder::new(std::io::Cursor::new(bytes));
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut reader = decoder
        .read_info()
        .map_err(|e| DriverError::Protocol(format!("invalid PNG tile: {e}")))?;
    let mut buf = vec![0u8; reader.output_buffer_size().unwrap_or(0)];
    let info = reader
        .next_frame(&mut buf)
        .map_err(|e| DriverError::Protocol(format!("invalid PNG tile frame: {e}")))?;
    let raw = &buf[..info.buffer_size()];
    let rgba = match info.color_type {
        png::ColorType::Rgba => raw.to_vec(),
        png::ColorType::Rgb => {
            let mut out = Vec::with_capacity((info.width * info.height * 4) as usize);
            for &[r, g, b] in raw.as_chunks::<3>().0 {
                out.extend_from_slice(&[r, g, b, 255]);
            }
            out
        }
        png::ColorType::GrayscaleAlpha => {
            let mut out = Vec::with_capacity((info.width * info.height * 4) as usize);
            for &[g, a] in raw.as_chunks::<2>().0 {
                out.extend_from_slice(&[g, g, g, a]);
            }
            out
        }
        png::ColorType::Grayscale => {
            let mut out = Vec::with_capacity((info.width * info.height * 4) as usize);
            for &g in raw {
                out.extend_from_slice(&[g, g, g, 255]);
            }
            out
        }
        other => return Err(DriverError::Protocol(format!("unsupported PNG color type {other:?}"))),
    };
    Ok((info.width, info.height, rgba))
}

fn encode_png_rgba(width: u32, height: u32, rgba: &[u8]) -> DriverResult<Vec<u8>> {
    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder
            .write_header()
            .map_err(|e| DriverError::Protocol(format!("PNG encode failed: {e}")))?;
        writer
            .write_image_data(rgba)
            .map_err(|e| DriverError::Protocol(format!("PNG encode failed: {e}")))?;
    }
    Ok(out)
}
