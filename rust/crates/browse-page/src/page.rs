//! Protocol-agnostic per-tab page model built directly on `browse_core::TabDriver`.
//!
//! Tracks the driver's normalized frame tree and `DocumentId`s, caches browse's `helpers.js` / Playwright
//! `InjectedScript` inside each frame's `World::Isolated`, manages blocking JS dialogs, and collects transient
//! `RemoteRef`s for release at the end of a tool call.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Result, anyhow, bail};
use browse_core::{
    Arg as DriverArg, CallOptions, Dialog, DialogKind, DocumentId, DriverError, DriverResult, Evaluated, Frame,
    FrameId, JsError, LoadState, NavigationId, PageEvent, Realm, Receiver, RemoteRef, Returns, TabDriver, TabId,
    World,
};
use serde_json::{Value, json};
use tokio::sync::{broadcast, watch};

use crate::scripts;

const MAX_EVENTS: usize = 200;

/// Marker error indicating a frame, world, or handle was invalidated by a navigation or re-render.
#[derive(Debug)]
pub struct StaleContext;

impl std::fmt::Display for StaleContext {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "The page navigated or re-rendered while browse was using it; try again")
    }
}

impl std::error::Error for StaleContext {}

#[derive(Debug, Clone)]
pub struct FrameInfo {
    pub id: String,
    pub parent: Option<String>,
    pub url: String,
    pub name: String,
    pub navigation: Option<NavigationId>,
    pub lifecycle: HashSet<LoadState>,
    /// Matches the driver's `DocumentId` for this frame; bumped on every cross-document commit.
    pub generation: u64,
    pub committed_at: Option<std::time::Instant>,
}

#[derive(Debug, Clone)]
struct WorldCache {
    helpers: RemoteRef,
    injected: bool,
    document: DocumentId,
}

/// An element handle in browse's isolated world of a frame.
#[derive(Debug, Clone)]
pub struct Element {
    pub frame: String,
    pub handle: RemoteRef,
    pub generation: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DialogPolicy {
    Manual,
    Accept,
    Dismiss,
}

#[derive(Debug, Clone)]
pub enum TabEvent {
    Navigated { url: String, same_document: bool },
    NavigationStarted { url: String },
    Dialog(Dialog),
    DialogClosed { accepted: bool, auto: bool },
    Popup { url: String },
    Crashed,
}

#[derive(Default)]
struct TabState {
    main_frame: String,
    frames: HashMap<String, FrameInfo>,
    worlds: HashMap<String, WorldCache>,
    frame_seq: HashMap<String, u32>,
    next_seq: u32,
    dialog: Option<Dialog>,
    dialog_policy: Option<DialogPolicy>,
    auto_prompt_text: Option<String>,
    /// The open dialog is being answered by the auto policy (or as a beforeunload); its close is the policy's even
    /// when the browser reports the close before it answers the command (as Firefox does).
    answering_auto: bool,
    /// Bumped for every dialog that opens, so answering one never clears the next.
    dialog_seq: u64,
    /// How many dialog closes the browser reported: the next one is for dialog `close_events + 1`.
    close_events: u64,
    events: Vec<(u64, TabEvent)>,
    seq: u64,
    platform: Option<String>,
    pending_navigation: Option<String>,
    media: MediaEmulation,
    transient: Vec<RemoteRef>,
    closed: bool,
}

#[derive(Debug, Clone, Default)]
pub struct MediaEmulation {
    pub media: String,
    pub features: std::collections::BTreeMap<String, String>,
}

struct Shared {
    tab: TabId,
    driver: Arc<dyn TabDriver>,
    state: Mutex<TabState>,
    changed: watch::Sender<u64>,
    dialog_open: watch::Sender<bool>,
}

pub struct TabPage {
    shared: Arc<Shared>,
    world_lock: tokio::sync::Mutex<()>,
    /// Serializes input on the tab and holds the pointer's human-input state.
    pub input: tokio::sync::Mutex<crate::human::InputState>,
    pump: tokio::task::JoinHandle<()>,
}

impl Drop for TabPage {
    fn drop(&mut self) {
        self.pump.abort();
    }
}

pub fn driver_error(error: DriverError) -> anyhow::Error {
    match error {
        DriverError::Stale => anyhow::Error::new(StaleContext),
        DriverError::Closed(reason) => anyhow!(
            "The tab closed, or browse lost its connection to it, while the command ran ({reason}); check the tab list and try again"
        ),
        other => anyhow!(other),
    }
}

pub fn is_stale(error: &anyhow::Error) -> bool {
    error.downcast_ref::<StaleContext>().is_some()
        || error
            .downcast_ref::<DriverError>()
            .is_some_and(|e| matches!(e, DriverError::Stale))
}

impl TabPage {
    pub async fn attach(tab: TabId, driver: Arc<dyn TabDriver>) -> Result<Arc<TabPage>> {
        let events = driver.events();
        let (changed, _) = watch::channel(0u64);
        let (dialog_open, _) = watch::channel(false);
        let shared = Arc::new(Shared {
            tab,
            driver: driver.clone(),
            state: Mutex::new(TabState::default()),
            changed,
            dialog_open,
        });
        let pump = tokio::spawn(pump(shared.clone(), events));
        let page = Arc::new(TabPage {
            shared: shared.clone(),
            world_lock: tokio::sync::Mutex::new(()),
            input: tokio::sync::Mutex::new(crate::human::InputState::default()),
            pump,
        });
        let frames = driver.frames().await.map_err(driver_error)?;
        shared.sync_frames(&frames);
        Ok(page)
    }

    pub fn tab(&self) -> TabId {
        self.shared.tab
    }

    pub fn driver(&self) -> &Arc<dyn TabDriver> {
        &self.shared.driver
    }

    pub fn alive(&self) -> bool {
        !self.pump.is_finished() && !self.shared.state.lock().unwrap().closed
    }

    pub fn main_frame(&self) -> String {
        self.shared.state.lock().unwrap().main_frame.clone()
    }

    pub fn frame(&self, id: &str) -> Option<FrameInfo> {
        self.shared.state.lock().unwrap().frames.get(id).cloned()
    }

    pub fn frames(&self) -> Vec<FrameInfo> {
        let state = self.shared.state.lock().unwrap();
        let mut out = Vec::new();
        let mut queue = vec![state.main_frame.clone()];
        let mut seen = HashSet::new();
        while let Some(id) = queue.pop() {
            if !seen.insert(id.clone()) {
                continue;
            }
            if let Some(frame) = state.frames.get(&id) {
                out.push(frame.clone());
                let mut children: Vec<_> = state
                    .frames
                    .values()
                    .filter(|f| f.parent.as_deref() == Some(id.as_str()))
                    .map(|f| f.id.clone())
                    .collect();
                children.sort();
                children.reverse();
                queue.extend(children);
            }
        }
        out
    }

    pub fn main_url(&self) -> String {
        let state = self.shared.state.lock().unwrap();
        state
            .frames
            .get(&state.main_frame)
            .map(|f| f.url.clone())
            .unwrap_or_default()
    }

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
        state
            .frame_seq
            .iter()
            .find(|(_, s)| **s == seq)
            .map(|(f, _)| f.clone())
    }

    // Events, dialogs and waiting.

    pub fn event_seq(&self) -> u64 {
        self.shared.state.lock().unwrap().seq
    }

    pub fn events_since(&self, seq: u64) -> Vec<TabEvent> {
        let state = self.shared.state.lock().unwrap();
        state
            .events
            .iter()
            .filter(|(s, _)| *s > seq)
            .map(|(_, e)| e.clone())
            .collect()
    }

    pub fn subscribe(&self) -> watch::Receiver<u64> {
        self.shared.changed.subscribe()
    }

    pub fn dialog(&self) -> Option<Dialog> {
        self.shared.state.lock().unwrap().dialog.clone()
    }

    pub fn blocking_dialog(&self) -> Option<Dialog> {
        let state = self.shared.state.lock().unwrap();
        let dialog = state.dialog.clone()?;
        (state.dialog_policy.is_none() && dialog.kind != DialogKind::BeforeUnload).then_some(dialog)
    }

    pub fn set_dialog_policy(&self, policy: Option<DialogPolicy>, prompt_text: Option<String>) {
        let mut state = self.shared.state.lock().unwrap();
        state.dialog_policy = policy;
        state.auto_prompt_text = prompt_text;
    }

    pub fn dialog_policy(&self) -> Option<DialogPolicy> {
        self.shared.state.lock().unwrap().dialog_policy
    }

    fn dialog_error(dialog: &Dialog) -> anyhow::Error {
        let article = if dialog.kind.as_str().starts_with(['a', 'e', 'i', 'o', 'u']) {
            "An"
        } else {
            "A"
        };
        anyhow!(
            "{article} {} dialog is open: {:?}. The page is paused until it is answered: call dialog with action \"accept\" or \"dismiss\".",
            dialog.kind,
            truncate(&dialog.message, 200)
        )
    }

    pub fn ensure_no_dialog(&self) -> Result<()> {
        match self.dialog() {
            Some(dialog) => Err(Self::dialog_error(&dialog)),
            None => Ok(()),
        }
    }

    pub async fn dialog_opened(&self) {
        let mut rx = self.shared.dialog_open.subscribe();
        let _ = rx.wait_for(|open| *open).await;
    }

    pub async fn guard_dialog<T, F>(&self, fut: F) -> Result<T>
    where
        F: Future<Output = DriverResult<T>>,
    {
        self.ensure_no_dialog()?;
        tokio::select! {
            result = fut => result.map_err(driver_error),
            _ = self.dialog_opened() => Err(Self::dialog_error(&self.dialog().unwrap_or(Dialog {
                kind: DialogKind::Alert,
                message: String::new(),
                default_prompt: String::new(),
                url: String::new(),
            }))),
        }
    }

    pub async fn handle_dialog(&self, accept: bool, prompt_text: Option<&str>) -> Result<Dialog> {
        let (dialog, seq) = {
            let state = self.shared.state.lock().unwrap();
            (state.dialog.clone(), state.dialog_seq)
        };
        let dialog = dialog.ok_or_else(|| anyhow!("No dialog is open on this tab."))?;
        self.shared
            .driver
            .answer_dialog(accept, prompt_text)
            .await
            .map_err(driver_error)?;
        // The page may already have opened its next dialog (Firefox answers only once the script went on): that one
        // stays open.
        self.shared.answered(seq, accept, false);
        Ok(dialog)
    }

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

    pub fn pending_navigation(&self) -> Option<String> {
        self.shared.state.lock().unwrap().pending_navigation.clone()
    }

    pub fn lifecycle_has(&self, frame: &str, state: LoadState) -> bool {
        self.frame(frame)
            .map(|f| f.lifecycle.contains(&state))
            .unwrap_or(false)
    }

    pub fn track_transient(&self, handle: RemoteRef) {
        self.shared.state.lock().unwrap().transient.push(handle);
    }

    // Isolated worlds and helpers.

    async fn helpers(&self, frame: &str) -> Result<RemoteRef> {
        if let Some(cached) = self.cached_helpers(frame) {
            return Ok(cached);
        }
        let _guard = self.world_lock.lock().await;
        if let Some(cached) = self.cached_helpers(frame) {
            return Ok(cached);
        }
        let info = self
            .frame(frame)
            .ok_or_else(|| anyhow!("The frame is gone (it navigated away or was removed)."))?;
        let realm = Realm { frame: FrameId::from(frame), world: World::Isolated };
        let eval_res = tokio::time::timeout(
            Duration::from_secs(10),
            self.guard_dialog(self.shared.driver.evaluate(
                &realm,
                scripts::helpers(),
                CallOptions { returns: Returns::Ref, await_promise: false, user_activation: false },
            )),
        )
        .await
        .map_err(|_| {
            anyhow!(
                "The page did not answer within 10 s while browse set up its helpers (it may be busy or still navigating)"
            )
        })??;
        let helpers = match eval_res {
            Err(err) => bail!("browse could not set up its page helpers: {}", err.message),
            Ok(Evaluated::Object(handle) | Evaluated::Node(handle)) => handle,
            Ok(Evaluated::Json(_)) => bail!("browse could not set up its page helpers in the frame"),
        };
        let mut state = self.shared.state.lock().unwrap();
        let current = state.frames.get(frame).map(|f| f.generation);
        if current != Some(info.generation) {
            return Err(anyhow::Error::new(StaleContext));
        }
        state.worlds.insert(
            frame.to_string(),
            WorldCache {
                helpers: helpers.clone(),
                injected: false,
                document: DocumentId(info.generation),
            },
        );
        Ok(helpers)
    }

    fn cached_helpers(&self, frame: &str) -> Option<RemoteRef> {
        let state = self.shared.state.lock().unwrap();
        let info = state.frames.get(frame)?;
        let world = state.worlds.get(frame)?;
        if world.document.0 != info.generation {
            return None;
        }
        Some(world.helpers.clone())
    }

    pub fn forget_world(&self, frame: &str, document: DocumentId) {
        let mut state = self.shared.state.lock().unwrap();
        if state.worlds.get(frame).map(|w| w.document) == Some(document) {
            state.worlds.remove(frame);
        }
    }

    async fn ensure_injected(&self, frame: &str) -> Result<RemoteRef> {
        let helpers = self.helpers(frame).await?;
        let injected = self
            .shared
            .state
            .lock()
            .unwrap()
            .worlds
            .get(frame)
            .map(|w| w.injected && w.document == helpers.document)
            .unwrap_or(false);
        if injected {
            return Ok(helpers);
        }
        let seq = self.frame_seq(frame);
        let result = self
            .guard_dialog(self.shared.driver.call(
                &Receiver::Ref(helpers.clone()),
                &scripts::install_injected(seq),
                &[],
                CallOptions { returns: Returns::Json, await_promise: false, user_activation: false },
            ))
            .await;
        let eval_res = match result {
            Ok(outcome) => outcome,
            Err(error) => {
                if is_stale(&error) {
                    self.forget_world(frame, helpers.document);
                }
                return Err(error);
            }
        };
        if let Err(err) = eval_res {
            bail!("browse could not load its selector engine: {}", err.message);
        }
        if let Some(w) = self.shared.state.lock().unwrap().worlds.get_mut(frame)
            && w.document == helpers.document
        {
            w.injected = true;
        }
        Ok(helpers)
    }

    /// Calls a custom function bound to the frame's helpers object (`this`), retrying on stale context.
    pub async fn call_helpers_fn(
        &self,
        frame: &str,
        declaration: &str,
        args: &[DriverArg],
        await_promise: bool,
        injected: bool,
    ) -> Result<Value> {
        let mut attempt = 0;
        loop {
            attempt += 1;
            let helpers = if injected {
                self.ensure_injected(frame).await?
            } else {
                self.helpers(frame).await?
            };
            let result = self
                .guard_dialog(self.shared.driver.call(
                    &Receiver::Ref(helpers.clone()),
                    declaration,
                    args,
                    CallOptions { returns: Returns::Json, await_promise, user_activation: false },
                ))
                .await;
            match result {
                Err(error) if is_stale(&error) && attempt < 3 => {
                    self.forget_world(frame, helpers.document);
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
                Err(error) => return Err(error),
                Ok(Err(err)) => bail!("{}", err.message),
                Ok(Ok(Evaluated::Json(value))) => return Ok(value),
                Ok(Ok(_)) => return Ok(Value::Null),
            }
        }
    }

    pub async fn call_driver(
        &self,
        receiver: &Receiver,
        declaration: &str,
        args: &[DriverArg],
        opts: CallOptions,
    ) -> Result<std::result::Result<Evaluated, Box<JsError>>> {
        self.guard_dialog(self.shared.driver.call(receiver, declaration, args, opts))
            .await
    }

    pub async fn call(
        &self,
        frame: &str,
        method: &str,
        args: Vec<Arg>,
        by_value: bool,
        injected: bool,
    ) -> Result<Evaluated> {
        let has_handles = args.iter().any(|a| matches!(a, Arg::Element(_)));
        let mut attempt = 0;
        loop {
            attempt += 1;
            let helpers = if injected {
                self.ensure_injected(frame).await?
            } else {
                self.helpers(frame).await?
            };
            for arg in &args {
                if let Arg::Element(element) = arg
                    && element.handle.document != helpers.document
                {
                    bail!("The element's document changed (the frame navigated or re-rendered); resolve it again.");
                }
            }
            let (encoded_args, declaration) = encode_call(method, &args);
            let result = self
                .guard_dialog(self.shared.driver.call(
                    &Receiver::Ref(helpers.clone()),
                    &declaration,
                    &encoded_args,
                    CallOptions {
                        returns: if by_value { Returns::Json } else { Returns::Ref },
                        await_promise: true,
                        user_activation: false,
                    },
                ))
                .await;
            match result {
                Err(error) if is_stale(&error) => {
                    self.forget_world(frame, helpers.document);
                    if has_handles || attempt >= 3 {
                        bail!("The page navigated or re-rendered while browse was reading it; try again.");
                    }
                    tokio::time::sleep(Duration::from_millis(30)).await;
                }
                Err(error) => return Err(error),
                Ok(Err(err)) => bail!("{}", err.message),
                Ok(Ok(evaluated)) => {
                    if let Evaluated::Node(ref h) | Evaluated::Object(ref h) = evaluated {
                        self.track_transient(h.clone());
                    }
                    return Ok(evaluated);
                }
            }
        }
    }

    pub async fn call_value(&self, frame: &str, method: &str, args: Vec<Arg>, injected: bool) -> Result<Value> {
        match self.call(frame, method, args, true, injected).await? {
            Evaluated::Json(value) => Ok(value),
            _ => Ok(Value::Null),
        }
    }

    pub async fn call_element(
        &self,
        element: &Element,
        method: &str,
        mut args: Vec<Arg>,
        injected: bool,
    ) -> Result<Value> {
        args.insert(0, Arg::Element(element.clone()));
        self.call_value(&element.frame, method, args, injected).await
    }

    pub async fn call_element_result(
        &self,
        frame: &str,
        method: &str,
        args: Vec<Arg>,
        injected: bool,
    ) -> Result<ElementOr> {
        match self.call(frame, method, args, false, injected).await? {
            Evaluated::Node(handle) => Ok(ElementOr::Element(Element {
                frame: frame.to_string(),
                generation: handle.document.0,
                handle,
            })),
            Evaluated::Json(Value::String(status)) => Ok(ElementOr::Status(status)),
            _ => Ok(ElementOr::Status("none".into())),
        }
    }

    pub async fn content_frame(&self, element: &Element, timeout: Duration) -> Result<String> {
        let Some(frame_id) = self
            .guard_dialog(self.shared.driver.content_frame(&element.handle))
            .await?
        else {
            bail!("The element is not an iframe, or its frame is not attached yet.");
        };
        let id = frame_id.as_str().to_string();
        let found = self
            .wait_until(timeout, Duration::from_millis(50), |page| page.frame(&id).is_some())
            .await;
        if !found {
            bail!("The iframe's document is not available (it may still be loading, or be cross-origin and not attached).");
        }
        Ok(id)
    }

    pub async fn frame_owner(&self, frame: &str) -> Result<Element> {
        let handle = self
            .guard_dialog(self.shared.driver.frame_element(&FrameId::from(frame)))
            .await?;
        self.track_transient(handle.clone());
        Ok(Element {
            frame: handle.frame.as_str().to_string(),
            generation: handle.document.0,
            handle,
        })
    }

    pub async fn adopt_main_world(&self, element: &Element) -> Result<RemoteRef> {
        let handle = self
            .guard_dialog(self.shared.driver.adopt(&element.handle, World::Main))
            .await?;
        self.track_transient(handle.clone());
        Ok(handle)
    }

    pub async fn release_object(&self, element: &Element) {
        self.shared.driver.release(vec![element.handle.clone()]).await;
    }

    pub async fn release(&self) {
        if self.dialog().is_some() || self.pending_navigation().is_some() {
            return;
        }
        let handles = std::mem::take(&mut self.shared.state.lock().unwrap().transient);
        if !handles.is_empty() {
            self.shared.driver.release(handles).await;
        }
    }

    pub async fn probe_responsive(&self, frame_id: &str) -> bool {
        let realm = Realm { frame: FrameId::from(frame_id), world: World::Isolated };
        self.shared
            .driver
            .evaluate(&realm, "0", CallOptions { returns: Returns::Json, await_promise: false, user_activation: false })
            .await
            .is_ok()
    }

    pub async fn interrupt(&self, frame_id: Option<&str>) -> bool {
        let frame = frame_id.map(FrameId::from);
        self.shared.driver.interrupt(frame.as_ref()).await.is_ok()
    }

    pub fn media_emulation(&self) -> MediaEmulation {
        self.shared.state.lock().unwrap().media.clone()
    }

    pub fn set_media_emulation(&self, media: MediaEmulation) {
        self.shared.state.lock().unwrap().media = media;
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

/// Encodes arguments for `helpers[method](...args)` as a JSON string + remote handles so nulls survive every protocol.
pub fn encode_call(method: &str, args: &[Arg]) -> (Vec<DriverArg>, String) {
    let mut handles = Vec::new();
    let spec: Vec<Value> = args
        .iter()
        .map(|arg| match arg {
            Arg::Value(value) => json!({ "v": value }),
            Arg::Element(element) => {
                handles.push(DriverArg::Ref(element.handle.clone()));
                json!({ "h": handles.len() - 1 })
            }
            Arg::Undefined => json!({ "u": 1 }),
        })
        .collect();
    let mut arguments = vec![DriverArg::Json(Value::String(Value::Array(spec).to_string()))];
    arguments.extend(handles);
    let declaration = format!(
        "function (spec, ...handles) {{ const args = JSON.parse(spec).map((a) => \"h\" in a ? handles[a.h] : \"u\" in a ? undefined : a.v); return this.{method}(...args) }}"
    );
    (arguments, declaration)
}

pub fn v(value: impl serde::Serialize) -> Arg {
    Arg::Value(serde_json::to_value(value).unwrap_or(Value::Null))
}

#[derive(Debug, Clone)]
pub enum ElementOr {
    Element(Element),
    Status(String),
}

pub fn is_fragment_change(current: &str, next: &str) -> bool {
    let base = |url: &str| url.split('#').next().unwrap_or("").to_string();
    next.contains('#') && !current.is_empty() && base(current) == base(next)
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

    fn sync_frames(&self, frames: &[Frame]) {
        let mut state = self.state.lock().unwrap();
        let present: HashSet<String> = frames.iter().map(|f| f.id.as_str().to_string()).collect();
        if let Some(first) = frames.first() {
            state.main_frame = first.id.as_str().to_string();
        }
        state.frames.retain(|id, _| present.contains(id));
        state.worlds.retain(|id, _| present.contains(id));
        for frame in frames {
            let id = frame.id.as_str().to_string();
            let entry = state.frames.entry(id.clone()).or_insert_with(|| FrameInfo {
                id,
                parent: frame.parent.as_ref().map(|p| p.as_str().to_string()),
                url: frame.url.clone(),
                name: frame.name.clone(),
                navigation: None,
                lifecycle: HashSet::new(),
                generation: frame.document.0,
                committed_at: None,
            });
            entry.parent = frame.parent.as_ref().map(|p| p.as_str().to_string());
            entry.url = frame.url.clone();
            entry.name = frame.name.clone();
            if entry.generation != frame.document.0 {
                entry.generation = frame.document.0;
                entry.lifecycle.clear();
            }
        }
        drop(state);
        self.bump();
    }

    /// browse answered dialog `seq`: it closes if it is still the open one.
    fn answered(&self, seq: u64, accepted: bool, auto: bool) {
        let current = self.state.lock().unwrap().dialog_seq == seq;
        if current {
            self.clear_dialog(Some(accepted), auto);
        }
    }

    fn clear_dialog(&self, accepted: Option<bool>, auto: bool) {
        let mut state = self.state.lock().unwrap();
        let auto = auto || std::mem::take(&mut state.answering_auto);
        if state.dialog.take().is_some()
            && let Some(accepted) = accepted
        {
            self.push(&mut state, TabEvent::DialogClosed { accepted, auto });
        }
        drop(state);
        self.dialog_open.send_replace(false);
        self.bump();
    }

    fn remove_frame_tree(state: &mut TabState, id: &str) {
        let children: Vec<String> = state
            .frames
            .values()
            .filter(|f| f.parent.as_deref() == Some(id))
            .map(|f| f.id.clone())
            .collect();
        for child in children {
            Self::remove_frame_tree(state, &child);
        }
        state.frames.remove(id);
        state.worlds.remove(id);
    }

    fn handle(self: &Arc<Self>, event: PageEvent) {
        match event {
            PageEvent::FrameAttached(frame) => {
                let mut state = self.state.lock().unwrap();
                let id = frame.id.as_str().to_string();
                let parent = frame.parent.as_ref().map(|p| p.as_str().to_string());
                let entry = state.frames.entry(id.clone()).or_insert_with(|| FrameInfo {
                    id,
                    parent: parent.clone(),
                    url: frame.url.clone(),
                    name: frame.name.clone(),
                    navigation: None,
                    lifecycle: HashSet::new(),
                    generation: frame.document.0,
                    committed_at: None,
                });
                if parent.is_some() {
                    entry.parent = parent;
                }
                if !frame.url.is_empty() {
                    entry.url = frame.url;
                }
                if !frame.name.is_empty() {
                    entry.name = frame.name;
                }
                if entry.generation != frame.document.0 {
                    entry.generation = frame.document.0;
                    entry.lifecycle.clear();
                }
            }
            PageEvent::FrameDetached(frame_id) => {
                let mut state = self.state.lock().unwrap();
                Self::remove_frame_tree(&mut state, frame_id.as_str());
            }
            PageEvent::Committed { frame, document, navigation, url, name } => {
                let id = frame.as_str().to_string();
                let mut state = self.state.lock().unwrap();
                let is_main = state.main_frame == id || state.main_frame.is_empty();
                if is_main {
                    state.main_frame = id.clone();
                }
                let entry = state.frames.entry(id.clone()).or_insert_with(|| FrameInfo {
                    id: id.clone(),
                    parent: None,
                    url: String::new(),
                    name: String::new(),
                    navigation: None,
                    lifecycle: HashSet::new(),
                    generation: document.0,
                    committed_at: None,
                });
                entry.url = url.clone();
                entry.name = name;
                entry.navigation = navigation;
                if entry.generation != document.0 {
                    entry.generation = document.0;
                    entry.lifecycle.clear();
                    entry.committed_at = Some(std::time::Instant::now());
                }
                state.worlds.remove(&id);
                if is_main {
                    state.pending_navigation = None;
                    self.push(&mut state, TabEvent::Navigated { url, same_document: false });
                }
            }
            PageEvent::UrlChanged { frame, url } => {
                let id = frame.as_str().to_string();
                let mut state = self.state.lock().unwrap();
                let is_main = state.main_frame == id;
                if let Some(entry) = state.frames.get_mut(&id) {
                    entry.url = url.clone();
                }
                if is_main {
                    self.push(&mut state, TabEvent::Navigated { url, same_document: true });
                }
            }
            PageEvent::NavigationStarted { frame, url, .. } => {
                let mut state = self.state.lock().unwrap();
                if state.main_frame == frame.as_str() {
                    state.pending_navigation = Some(url.clone());
                    self.push(&mut state, TabEvent::NavigationStarted { url });
                }
            }
            PageEvent::NavigationAborted { frame } => {
                let mut state = self.state.lock().unwrap();
                if state.main_frame == frame.as_str() {
                    state.pending_navigation = None;
                }
            }
            PageEvent::Loaded { frame, document, state: load_state } => {
                let mut state = self.state.lock().unwrap();
                if let Some(entry) = state.frames.get_mut(frame.as_str()) {
                    if entry.generation != document.0 {
                        entry.generation = document.0;
                        entry.lifecycle.clear();
                    }
                    entry.lifecycle.insert(load_state);
                }
            }
            PageEvent::DialogOpened(dialog) => {
                let mut state = self.state.lock().unwrap();
                state.dialog = Some(dialog.clone());
                state.dialog_seq += 1;
                let seq = state.dialog_seq;
                let policy = state.dialog_policy;
                let prompt_text = state
                    .auto_prompt_text
                    .clone()
                    .unwrap_or_else(|| dialog.default_prompt.clone());
                self.push(&mut state, TabEvent::Dialog(dialog.clone()));
                drop(state);
                self.dialog_open.send_replace(true);
                let auto = match policy {
                    Some(DialogPolicy::Accept) => Some(true),
                    Some(DialogPolicy::Dismiss) => Some(false),
                    _ if dialog.kind == DialogKind::BeforeUnload => Some(true),
                    _ => None,
                };
                self.state.lock().unwrap().answering_auto = auto.is_some();
                if let Some(accept) = auto {
                    let shared = self.clone();
                    tokio::spawn(async move {
                        let prompt = (accept && dialog.kind == DialogKind::Prompt).then_some(prompt_text.as_str());
                        if shared.driver.answer_dialog(accept, prompt).await.is_ok() {
                            shared.answered(seq, accept, true);
                        }
                    });
                }
            }
            PageEvent::DialogClosed { accepted } => {
                // A close names no dialog: closes come in order, one per dialog. Chrome can report a dialog's close
                // after the page already opened the next one, which must stay open.
                let current = {
                    let mut state = self.state.lock().unwrap();
                    state.close_events += 1;
                    state.close_events == state.dialog_seq
                };
                if current {
                    self.clear_dialog(Some(accepted), false);
                }
                return;
            }
            PageEvent::PopupOpened { url } => {
                let mut state = self.state.lock().unwrap();
                self.push(&mut state, TabEvent::Popup { url });
            }
            PageEvent::Closed(reason) => {
                let mut state = self.state.lock().unwrap();
                state.closed = true;
                if matches!(reason, browse_core::CloseReason::Crashed) {
                    self.push(&mut state, TabEvent::Crashed);
                }
            }
        }
        self.bump();
    }
}

async fn pump(shared: Arc<Shared>, mut events: broadcast::Receiver<PageEvent>) {
    loop {
        match events.recv().await {
            Ok(event) => shared.handle(event),
            Err(broadcast::error::RecvError::Lagged(_)) => {
                if let Ok(frames) = shared.driver.frames().await {
                    shared.sync_frames(&frames);
                }
            }
            Err(broadcast::error::RecvError::Closed) => break,
        }
    }
    shared.state.lock().unwrap().closed = true;
    shared.bump();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn call_arguments_keep_nulls() {
        let (arguments, declaration) = encode_call(
            "refResolve",
            &[Arg::Value(Value::Null), v(json!({ "a": null })), Arg::Undefined],
        );
        assert_eq!(arguments.len(), 1);
        let DriverArg::Json(Value::String(raw)) = &arguments[0] else {
            panic!("expected encoded JSON string");
        };
        let spec: Value = serde_json::from_str(raw).unwrap();
        assert_eq!(spec, json!([{ "v": null }, { "v": { "a": null } }, { "u": 1 }]));
        assert!(declaration.contains("this.refResolve(...args)"));
    }

    /// A tab whose browser reports a dialog closed before it answers the command that closed it, as Firefox does.
    struct EarlyCloseTab {
        events: broadcast::Sender<PageEvent>,
        /// A dialog the page opens as soon as the current one is answered.
        next: Mutex<Option<Dialog>>,
        late: bool,
    }

    #[async_trait::async_trait]
    impl browse_core::CaptureDriver for EarlyCloseTab {
        async fn console(&self) -> browse_core::DriverResult<browse_core::Subscription<browse_core::ConsoleEvent>> {
            Err(DriverError::Unsupported("console"))
        }
        async fn network(&self, _: browse_core::NetworkOptions) -> browse_core::DriverResult<browse_core::Subscription<browse_core::NetworkEvent>> {
            Err(DriverError::Unsupported("network"))
        }
        async fn body(&self, _: &browse_core::RequestId, _: browse_core::BodyKind) -> browse_core::DriverResult<Option<Vec<u8>>> {
            Ok(None)
        }
    }

    #[async_trait::async_trait]
    impl TabDriver for EarlyCloseTab {
        fn events(&self) -> broadcast::Receiver<PageEvent> {
            self.events.subscribe()
        }
        async fn frames(&self) -> browse_core::DriverResult<Vec<browse_core::Frame>> {
            Ok(vec![browse_core::Frame { id: FrameId::from("top"), parent: None, url: "about:blank".into(), name: String::new(), document: browse_core::DocumentId(1) }])
        }
        async fn navigate(&self, _: &str, _: Option<&str>) -> browse_core::DriverResult<Option<browse_core::NavigationId>> {
            Err(DriverError::Unsupported("navigate"))
        }
        async fn reload(&self, _: bool) -> browse_core::DriverResult<()> {
            Err(DriverError::Unsupported("reload"))
        }
        async fn traverse_history(&self, _: i32) -> browse_core::DriverResult<bool> {
            Ok(false)
        }
        async fn evaluate(&self, _: &Realm, _: &str, _: CallOptions) -> browse_core::Eval {
            Err(DriverError::Unsupported("evaluate"))
        }
        async fn call(&self, _: &Receiver, _: &str, _: &[DriverArg], _: CallOptions) -> browse_core::Eval {
            Err(DriverError::Unsupported("call"))
        }
        async fn release(&self, _: Vec<RemoteRef>) {}
        async fn adopt(&self, _: &RemoteRef, _: World) -> browse_core::DriverResult<RemoteRef> {
            Err(DriverError::Unsupported("adopt"))
        }
        async fn frame_element(&self, _: &FrameId) -> browse_core::DriverResult<RemoteRef> {
            Err(DriverError::Unsupported("frame_element"))
        }
        async fn content_frame(&self, _: &RemoteRef) -> browse_core::DriverResult<Option<FrameId>> {
            Ok(None)
        }
        async fn set_files(&self, _: &RemoteRef, _: &[std::path::PathBuf]) -> browse_core::DriverResult<()> {
            Err(DriverError::Unsupported("set_files"))
        }
        async fn pointer(&self, _: browse_core::PointerEvent) -> browse_core::DriverResult<()> {
            Ok(())
        }
        async fn key(&self, _: browse_core::KeyEvent) -> browse_core::DriverResult<()> {
            Ok(())
        }
        async fn insert_text(&self, _: &str) -> browse_core::DriverResult<()> {
            Ok(())
        }
        async fn drag(&self, _: (f64, f64), _: (f64, f64), _: &[browse_core::PointerStep], _: browse_core::Modifiers) -> browse_core::DriverResult<browse_core::DragOutcome> {
            Ok(browse_core::DragOutcome::NotDraggable)
        }
        async fn answer_dialog(&self, accept: bool, _: Option<&str>) -> browse_core::DriverResult<()> {
            if self.late {
                // As Chrome can: answered at once, then the next dialog opens before the first one's close arrives.
                let events = self.events.clone();
                let next = self.next.lock().unwrap().take();
                tokio::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(20)).await;
                    if let Some(next) = next {
                        let _ = events.send(PageEvent::DialogOpened(next));
                    }
                    let _ = events.send(PageEvent::DialogClosed { accepted: accept });
                });
                return Ok(());
            }
            let _ = self.events.send(PageEvent::DialogClosed { accepted: accept });
            if let Some(next) = self.next.lock().unwrap().take() {
                let _ = self.events.send(PageEvent::DialogOpened(next));
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
            Ok(())
        }
        async fn viewport(&self) -> browse_core::DriverResult<browse_core::Viewport> {
            Err(DriverError::Unsupported("viewport"))
        }
        async fn screenshot(&self, _: browse_core::Screenshot) -> browse_core::DriverResult<browse_core::Image> {
            Err(DriverError::Unsupported("screenshot"))
        }
        fn capture(&self) -> &dyn browse_core::CaptureDriver {
            self
        }
    }

    #[tokio::test]
    async fn an_auto_answered_dialog_is_reported_as_auto_even_when_its_close_comes_first() {
        let tab = Arc::new(EarlyCloseTab { events: broadcast::channel(16).0, next: Mutex::new(None), late: false });
        let page = TabPage::attach(1, tab.clone()).await.unwrap();
        page.set_dialog_policy(Some(DialogPolicy::Accept), None);
        let dialog = Dialog { kind: DialogKind::Confirm, message: "Proceed?".into(), default_prompt: String::new(), url: "about:blank".into() };
        tab.events.send(PageEvent::DialogOpened(dialog)).unwrap();
        let started = std::time::Instant::now();
        while page.events_since(0).iter().all(|e| !matches!(e, TabEvent::DialogClosed { .. })) {
            assert!(started.elapsed() < Duration::from_secs(5), "the dialog never closed");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
        let closes: Vec<(bool, bool)> = page
            .events_since(0)
            .iter()
            .filter_map(|e| match e {
                TabEvent::DialogClosed { accepted, auto } => Some((*accepted, *auto)),
                _ => None,
            })
            .collect();
        assert_eq!(closes, vec![(true, true)]);
    }

    #[tokio::test]
    async fn answering_a_dialog_keeps_the_one_the_page_opened_next() {
        for late in [false, true] {
            answer_then_next(late).await;
        }
    }

    async fn answer_then_next(late: bool) {
        let confirm = Dialog { kind: DialogKind::Confirm, message: "second".into(), default_prompt: String::new(), url: "about:blank".into() };
        let tab = Arc::new(EarlyCloseTab { events: broadcast::channel(16).0, next: Mutex::new(Some(confirm)), late });
        let page = TabPage::attach(1, tab.clone()).await.unwrap();
        let alert = Dialog { kind: DialogKind::Alert, message: "first".into(), default_prompt: String::new(), url: "about:blank".into() };
        tab.events.send(PageEvent::DialogOpened(alert)).unwrap();
        assert!(page.wait_until(Duration::from_secs(5), Duration::from_millis(10), |p| p.dialog().is_some()).await);
        let answered = page.handle_dialog(true, None).await.unwrap();
        assert_eq!(answered.message, "first");
        assert!(page.wait_until(Duration::from_secs(5), Duration::from_millis(10), |p| p.dialog().is_some_and(|d| d.message == "second")).await);
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(page.dialog().map(|d| d.message), Some("second".to_string()), "the second dialog is still open (late: {late})");
    }

    #[test]
    fn fragment_changes() {
        assert!(is_fragment_change("https://a.example/x", "https://a.example/x#top"));
        assert!(is_fragment_change("https://a.example/x#a", "https://a.example/x#b"));
        assert!(!is_fragment_change("https://a.example/x", "https://a.example/y#top"));
        assert!(!is_fragment_change("https://a.example/x#a", "https://a.example/x"));
    }
}