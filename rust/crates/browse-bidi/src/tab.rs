//! The per-tab WebDriver BiDi driver: frame tree, document ids, navigation lifecycle, dialogs, script and refs.

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use browse_core::{
    Arg, CallOptions, CaptureDriver, CloseReason, Dialog, DialogKind, DocumentId, DragOutcome, DriverError,
    DriverResult, Emulation, Eval, FileChooser, FileChooserArm, Frame, FrameId, Image, ImageFormat, KeyEvent, LoadState, Modifiers,
    NavigationError, NavigationErrorKind, NavigationId, PageEvent, PointerEvent, PointerStep, Realm, Receiver,
    RemoteRef, Screenshot, ScreenshotArea, TabDriver, TargetId, Viewport, World,
};
use serde_json::{Value, json};
use tokio::sync::{broadcast, watch};

use crate::transport::{BiDiError, BiDiEvent, BiDiTransport, map_error};
use crate::value::{self, Token};

/// Events every tab subscribes to for its own browsing context tree.
const TAB_EVENTS: &[&str] = &[
    "browsingContext",
    "script.realmCreated",
    "script.realmDestroyed",
    "network.beforeRequestSent",
    "network.responseCompleted",
    "network.fetchError",
];
/// How long a restored document may go without `navigationCommitted` before the driver commits it itself.
const BFCACHE_GRACE: Duration = Duration::from_millis(250);
const WATCHDOG_LIMIT: Duration = Duration::from_secs(60);
const IDLE_QUIET: Duration = Duration::from_millis(500);
const IDLE_MAX_ACTIVE: usize = 2;
/// Requests older than this no longer keep the network busy (long polls, streams).
const IDLE_STALE_REQUEST: Duration = Duration::from_secs(30);
const RELEASE_TIMEOUT: Duration = Duration::from_millis(400);
const CACHE_RESTORE: Duration = Duration::from_secs(10);

fn next_document() -> DocumentId {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    DocumentId(NEXT.fetch_add(1, Ordering::Relaxed))
}

pub(crate) fn str_of<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}

/// Firefox shows failed loads as `about:neterror?e=...&u=<url>`; the frame's URL is the one that failed.
pub(crate) fn display_url(url: &str) -> String {
    let Some(query) = url.strip_prefix("about:neterror?").or_else(|| url.strip_prefix("about:certerror?")) else {
        return url.to_string();
    };
    query
        .split('&')
        .find_map(|pair| pair.strip_prefix("u="))
        .map(percent_decode)
        .filter(|decoded| !decoded.is_empty())
        .unwrap_or_else(|| url.to_string())
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && let Ok(hex) = std::str::from_utf8(&bytes[i + 1..i + 3])
            && let Ok(byte) = u8::from_str_radix(hex, 16)
        {
            out.push(byte);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn is_fragment_change(current: &str, next: &str) -> bool {
    let base = |url: &str| url.split('#').next().unwrap_or("").to_string();
    next.contains('#') && !current.is_empty() && base(current) == base(next)
}

/// A bounded set of recently seen navigation ids.
#[derive(Default)]
pub(crate) struct Recent(VecDeque<String>);

impl Recent {
    fn insert(&mut self, id: &str) {
        if self.contains(id) {
            return;
        }
        if self.0.len() >= 64 {
            self.0.pop_front();
        }
        self.0.push_back(id.to_string());
    }

    fn contains(&self, id: &str) -> bool {
        self.0.iter().any(|seen| seen == id)
    }
}

pub(crate) struct FrameEntry {
    pub frame: Frame,
    /// Bumped whenever the frame's window realm is destroyed, which strands any script awaiting in it.
    pub realm_epoch: u64,
    /// A navigation that started and has not committed: `(navigation, url)`.
    pub pending: Option<(String, String)>,
    /// The navigation that committed the current document.
    pub navigation: Option<String>,
}

impl FrameEntry {
    fn new(id: FrameId, parent: Option<FrameId>, url: String) -> Self {
        FrameEntry {
            frame: Frame { id, parent, url, name: String::new(), document: next_document() },
            realm_epoch: 0,
            pending: None,
            navigation: None,
        }
    }
}

#[derive(Default)]
struct Idle {
    document: DocumentId,
    dom_ready: bool,
    emitted: bool,
    quiet_since: Option<Instant>,
}

#[derive(Default)]
pub(crate) struct State {
    pub frames: HashMap<FrameId, FrameEntry>,
    pub closed: Option<CloseReason>,
    /// Window realms (not sandboxes) by id, to their frame.
    realms: HashMap<String, FrameId>,
    /// The context whose user prompt is open: it may be a child frame.
    pub dialog: Option<FrameId>,
    fragment_navigations: Recent,
    download_navigations: Recent,
    /// Navigations the bfcache watchdog committed; a late `navigationCommitted` for them is ignored.
    synthesized: HashSet<String>,
    /// Owner elements (`sharedId`) of child frames, per parent document.
    pub frame_elements: HashMap<(FrameId, DocumentId), HashMap<FrameId, String>>,
    inflight: HashMap<String, Instant>,
    idle: Idle,
}

impl State {
    fn remove_tree(&mut self, id: &FrameId) {
        let children: Vec<FrameId> = self
            .frames
            .values()
            .filter(|entry| entry.frame.parent.as_ref() == Some(id))
            .map(|entry| entry.frame.id.clone())
            .collect();
        for child in children {
            self.remove_tree(&child);
        }
        self.frames.remove(id);
        self.realms.retain(|_, frame| frame != id);
        self.frame_elements.retain(|(frame, _), _| frame != id);
    }

    fn children(&self, id: &FrameId) -> Vec<FrameId> {
        let mut children: Vec<FrameId> = self
            .frames
            .values()
            .filter(|entry| entry.frame.parent.as_ref() == Some(id))
            .map(|entry| entry.frame.id.clone())
            .collect();
        children.sort();
        children
    }
}

pub(crate) struct Shared {
    pub transport: Arc<dyn BiDiTransport>,
    pub top: FrameId,
    pub state: Mutex<State>,
    events: broadcast::Sender<PageEvent>,
    /// Bumped on every frame, document, realm or close change; script calls race it.
    changed: watch::Sender<u64>,
    pub input: Mutex<crate::input::InputState>,
    pub network: tokio::sync::Mutex<crate::capture::NetworkSubscriptions>,
    subscription: Mutex<Option<String>>,
}

impl Shared {
    pub(crate) fn emit(&self, event: PageEvent) {
        let _ = self.events.send(event);
    }

    pub(crate) fn page_events(&self) -> broadcast::Receiver<PageEvent> {
        self.events.subscribe()
    }

    fn bump(&self) {
        self.changed.send_modify(|n| *n = n.wrapping_add(1));
    }

    /// Whether `context` is this tab's top-level context or one of its frames.
    pub(crate) fn belongs(&self, context: &str) -> bool {
        self.top.as_str() == context || self.state.lock().unwrap().frames.contains_key(&FrameId::from(context))
    }

    pub(crate) fn closed(&self) -> Option<CloseReason> {
        self.state.lock().unwrap().closed.clone()
    }

    /// The current document of `frame` and its realm epoch.
    pub(crate) fn document_of(&self, frame: &FrameId) -> DriverResult<(DocumentId, u64)> {
        let state = self.state.lock().unwrap();
        if let Some(reason) = &state.closed {
            return Err(DriverError::Closed(reason.clone()));
        }
        let entry = state.frames.get(frame).ok_or(DriverError::Stale)?;
        Ok((entry.frame.document, entry.realm_epoch))
    }

    pub(crate) fn frame_url(&self, frame: &FrameId) -> String {
        self.state.lock().unwrap().frames.get(frame).map(|e| e.frame.url.clone()).unwrap_or_default()
    }

    fn top_url(&self) -> String {
        self.frame_url(&self.top)
    }

    /// Maps an error for a command aimed at `frame`: a missing top-level context means the tab closed.
    pub(crate) fn frame_error(&self, error: BiDiError, frame: &FrameId) -> DriverError {
        if error.code() == Some("no such frame") {
            if let Some(reason) = self.closed() {
                return DriverError::Closed(reason);
            }
            if frame == &self.top {
                return DriverError::Closed(CloseReason::Closed);
            }
            return DriverError::Stale;
        }
        map_error(error)
    }

    fn check_alive(&self, frame: &FrameId, document: DocumentId, epoch: u64) -> Option<DriverError> {
        let state = self.state.lock().unwrap();
        if let Some(reason) = &state.closed {
            return Some(DriverError::Closed(reason.clone()));
        }
        match state.frames.get(frame) {
            Some(entry) if entry.frame.document == document && entry.realm_epoch == epoch => None,
            _ => Some(DriverError::Stale),
        }
    }

    /// Resolves once `frame` leaves `document` (navigated, its realm died, detached) or the tab closes.
    async fn gone(&self, frame: &FrameId, document: DocumentId, epoch: u64) -> DriverError {
        let mut rx = self.changed.subscribe();
        loop {
            if let Some(error) = self.check_alive(frame, document, epoch) {
                return error;
            }
            if rx.changed().await.is_err() {
                std::future::pending::<()>().await;
            }
        }
    }

    /// Sends a script command for `frame`'s current document. Firefox never answers a command awaiting a promise in
    /// a document that navigated away, so the command is abandoned with `Stale` as soon as the document changes.
    pub(crate) async fn guarded(
        &self,
        frame: &FrameId,
        document: DocumentId,
        epoch: u64,
        method: &str,
        params: Value,
    ) -> DriverResult<Value> {
        tokio::select! {
            biased;
            result = self.transport.send(method, params) => result.map_err(|error| self.frame_error(error, frame)),
            error = self.gone(frame, document, epoch) => Err(error),
        }
    }

    /// Runs a script in browse's sandbox of `frame`, answering plain JSON (no handles kept).
    pub(crate) async fn sandbox_call(&self, frame: &FrameId, function: &str, args: &[Value]) -> DriverResult<Value> {
        let (document, epoch) = self.document_of(frame)?;
        let params = json!({
            "functionDeclaration": function,
            "arguments": args.iter().map(value::local_value).collect::<Vec<_>>(),
            "target": value::target(frame, World::Isolated),
            "awaitPromise": false,
            "resultOwnership": "none",
            "serializationOptions": { "maxDomDepth": 0, "maxObjectDepth": 2 },
        });
        let result = self.guarded(frame, document, epoch, "script.callFunction", params).await?;
        if result.get("type").and_then(Value::as_str) == Some("exception") {
            let error = value::js_error(&result["exceptionDetails"]);
            return Err(DriverError::Protocol(format!("browse's page script failed: {}", error.message)));
        }
        Ok(result.get("result").cloned().unwrap_or(Value::Null))
    }

    fn ordered_frames(&self) -> Vec<Frame> {
        let state = self.state.lock().unwrap();
        let mut out = Vec::new();
        let mut queue = vec![self.top.clone()];
        let mut seen = HashSet::new();
        while let Some(id) = queue.pop() {
            if !seen.insert(id.clone()) {
                continue;
            }
            if let Some(entry) = state.frames.get(&id) {
                out.push(entry.frame.clone());
                let mut children = state.children(&id);
                children.reverse();
                queue.extend(children);
            }
        }
        out
    }

    fn close(&self, reason: CloseReason) {
        {
            let mut state = self.state.lock().unwrap();
            if state.closed.is_some() {
                return;
            }
            state.closed = Some(reason.clone());
        }
        self.emit(PageEvent::Closed(reason));
        self.bump();
    }

    fn handle(self: &Arc<Self>, event: BiDiEvent) {
        let params = &event.params;
        let context = FrameId::from(str_of(params, "context"));
        let navigation = params.get("navigation").and_then(Value::as_str).map(str::to_string);
        match event.method.as_str() {
            "browsingContext.contextCreated" => match params.get("parent").and_then(Value::as_str) {
                Some(parent) => {
                    let frame = {
                        let mut state = self.state.lock().unwrap();
                        let parent = FrameId::from(parent);
                        if state.closed.is_some() || !state.frames.contains_key(&parent) || state.frames.contains_key(&context) {
                            return;
                        }
                        let entry = FrameEntry::new(context.clone(), Some(parent), str_of(params, "url").to_string());
                        let frame = entry.frame.clone();
                        state.frames.insert(context, entry);
                        frame
                    };
                    self.emit(PageEvent::FrameAttached(frame));
                    self.bump();
                }
                None => {
                    let opener = params.get("originalOpener").and_then(Value::as_str);
                    if context != self.top && opener.is_some_and(|opener| self.belongs(opener)) {
                        self.emit(PageEvent::PopupOpened { url: str_of(params, "url").to_string() });
                    }
                }
            },
            "browsingContext.contextDestroyed" => {
                if context == self.top {
                    self.close(CloseReason::Closed);
                    return;
                }
                {
                    let mut state = self.state.lock().unwrap();
                    if !state.frames.contains_key(&context) {
                        return;
                    }
                    state.remove_tree(&context);
                }
                self.emit(PageEvent::FrameDetached(context));
                self.bump();
            }
            "browsingContext.navigationStarted" => {
                let url = str_of(params, "url").to_string();
                {
                    let mut state = self.state.lock().unwrap();
                    let Some(entry) = state.frames.get_mut(&context) else { return };
                    if let Some(navigation) = &navigation {
                        entry.pending = Some((navigation.clone(), url.clone()));
                    }
                }
                if let Some(navigation) = &navigation {
                    tokio::spawn(self.clone().watchdog(context.clone(), navigation.clone(), url.clone()));
                }
                if context == self.top {
                    self.emit(PageEvent::NavigationStarted {
                        frame: context,
                        navigation: navigation.map(NavigationId::from),
                        url,
                    });
                }
                self.bump();
            }
            "browsingContext.fragmentNavigated" | "browsingContext.historyUpdated" => {
                let url = str_of(params, "url").to_string();
                {
                    let mut state = self.state.lock().unwrap();
                    let fragment = event.method.ends_with("fragmentNavigated");
                    let seen = navigation.as_deref().is_some_and(|n| state.fragment_navigations.contains(n));
                    if fragment && let Some(navigation) = &navigation {
                        state.fragment_navigations.insert(navigation);
                    }
                    let Some(entry) = state.frames.get_mut(&context) else { return };
                    if entry.frame.url == url && (seen || !fragment) {
                        return;
                    }
                    entry.frame.url = url.clone();
                }
                self.emit(PageEvent::UrlChanged { frame: context, url });
                self.bump();
            }
            "browsingContext.navigationCommitted" => {
                let url = display_url(str_of(params, "url"));
                let (document, children) = {
                    let mut state = self.state.lock().unwrap();
                    if let Some(navigation) = &navigation
                        && state.synthesized.remove(navigation)
                    {
                        return;
                    }
                    let children = state.children(&context);
                    let Some(entry) = state.frames.get_mut(&context) else { return };
                    entry.frame.document = next_document();
                    entry.frame.url = url.clone();
                    entry.navigation = navigation.clone();
                    entry.pending = None;
                    let document = entry.frame.document;
                    for child in &children {
                        state.remove_tree(child);
                    }
                    (document, children)
                };
                tokio::spawn(self.clone().mark(context.clone(), document));
                for child in children {
                    self.emit(PageEvent::FrameDetached(child));
                }
                self.emit(PageEvent::Committed {
                    frame: context,
                    document,
                    navigation: navigation.map(NavigationId::from),
                    url,
                    name: String::new(),
                });
                self.bump();
            }
            "browsingContext.navigationFailed" | "browsingContext.downloadWillBegin" | "browsingContext.navigationAborted" => {
                {
                    let mut state = self.state.lock().unwrap();
                    if event.method.ends_with("downloadWillBegin")
                        && let Some(navigation) = &navigation
                    {
                        state.download_navigations.insert(navigation);
                    }
                    let Some(entry) = state.frames.get_mut(&context) else { return };
                    match (&entry.pending, &navigation) {
                        (Some((pending, _)), Some(navigation)) if pending == navigation => entry.pending = None,
                        _ => return,
                    }
                }
                if context == self.top {
                    self.emit(PageEvent::NavigationAborted { frame: context });
                }
                self.bump();
            }
            "browsingContext.domContentLoaded" | "browsingContext.load" => {
                let state_kind =
                    if event.method.ends_with("load") { LoadState::Load } else { LoadState::DomContentLoaded };
                let document = {
                    let mut state = self.state.lock().unwrap();
                    let Some(entry) = state.frames.get(&context) else { return };
                    let document = entry.frame.document;
                    if context == self.top {
                        if state.idle.document != document {
                            state.idle = Idle { document, ..Idle::default() };
                        }
                        state.idle.dom_ready = true;
                    }
                    document
                };
                self.emit(PageEvent::Loaded { frame: context, document, state: state_kind });
            }
            "browsingContext.userPromptOpened" => {
                let dialog = {
                    let mut state = self.state.lock().unwrap();
                    let Some(entry) = state.frames.get(&context) else { return };
                    let url = entry.frame.url.clone();
                    if state.dialog.is_some() {
                        return;
                    }
                    state.dialog = Some(context);
                    Dialog {
                        kind: DialogKind::from_wire(str_of(params, "type")),
                        message: str_of(params, "message").to_string(),
                        default_prompt: str_of(params, "defaultValue").to_string(),
                        url,
                    }
                };
                self.emit(PageEvent::DialogOpened(dialog));
                self.bump();
            }
            "browsingContext.userPromptClosed" => {
                {
                    let mut state = self.state.lock().unwrap();
                    if !state.frames.contains_key(&context) || state.dialog.take().is_none() {
                        return;
                    }
                }
                self.emit(PageEvent::DialogClosed { accepted: params["accepted"].as_bool().unwrap_or(false) });
                self.bump();
            }
            "script.realmCreated" => {
                if str_of(params, "type") != "window" || params.get("sandbox").is_some_and(|s| !s.is_null()) {
                    return;
                }
                let mut state = self.state.lock().unwrap();
                if state.frames.contains_key(&context) {
                    state.realms.insert(str_of(params, "realm").to_string(), context);
                }
            }
            "script.realmDestroyed" => {
                {
                    let mut state = self.state.lock().unwrap();
                    let Some(frame) = state.realms.remove(str_of(params, "realm")) else { return };
                    let Some(entry) = state.frames.get_mut(&frame) else { return };
                    entry.realm_epoch += 1;
                }
                self.bump();
            }
            "network.beforeRequestSent" => {
                let id = str_of(&params["request"], "request").to_string();
                let mut state = self.state.lock().unwrap();
                if state.frames.contains_key(&context) && !id.is_empty() {
                    state.inflight.insert(id, Instant::now());
                }
            }
            "network.responseCompleted" | "network.fetchError" => {
                let id = str_of(&params["request"], "request");
                self.state.lock().unwrap().inflight.remove(id);
            }
            _ => {}
        }
    }

    /// Tags a committed document in browse's sandbox, so the watchdog can tell it from its successor.
    async fn mark(self: Arc<Self>, frame: FrameId, document: DocumentId) {
        let _ = tokio::time::timeout(
            Duration::from_secs(2),
            self.transport.send(
                "script.evaluate",
                json!({
                    "expression": format!("globalThis.__browseDocument = {}; 0", document.0),
                    "target": value::target(&frame, World::Isolated),
                    "awaitPromise": false,
                    "resultOwnership": "none",
                }),
            ),
        )
        .await;
    }

    /// A document restored from the back/forward cache gets no `navigationCommitted` (nor load events): while a
    /// navigation is pending, the frame is probed, and a document other than the tagged current one is committed here.
    async fn watchdog(self: Arc<Self>, frame: FrameId, navigation: String, url: String) {
        let started = Instant::now();
        let (href, ready) = loop {
            tokio::time::sleep(BFCACHE_GRACE).await;
            let (current, document) = {
                let state = self.state.lock().unwrap();
                let Some(entry) = state.frames.get(&frame) else { return };
                if entry.pending.as_ref().map(|(pending, _)| pending) != Some(&navigation) || state.closed.is_some() {
                    return;
                }
                (entry.frame.url.clone(), entry.frame.document)
            };
            if started.elapsed() > WATCHDOG_LIMIT {
                return;
            }
            let probe = self.transport.send(
                "script.evaluate",
                json!({
                    "expression": "[location.href, document.readyState, globalThis.__browseDocument ?? null]",
                    "target": value::target(&frame, World::Isolated),
                    "awaitPromise": false,
                    "resultOwnership": "none",
                }),
            );
            let Ok(Ok(result)) = tokio::time::timeout(Duration::from_secs(2), probe).await else { continue };
            let probed = value::to_json(&result["result"]);
            let href = probed[0].as_str().unwrap_or("").to_string();
            let ready = probed[1].as_str().unwrap_or("").to_string();
            let old = match probed[2].as_u64() {
                Some(tag) => tag == document.0,
                None => href == current && href != url,
            };
            // While Firefox swaps in a new document for a non-blank navigation, the initial transient window briefly
            // reports "about:blank" with no tag; never synthesize a commit for it (doing so would suppress the real
            // navigationCommitted event that follows).
            let transient_blank = href == "about:blank" && url != "about:blank";
            if !href.is_empty() && !old && !transient_blank {
                break (href, ready);
            }
        };
        let (document, children) = {
            let mut state = self.state.lock().unwrap();
            let children = state.children(&frame);
            let Some(entry) = state.frames.get_mut(&frame) else { return };
            if entry.pending.as_ref().map(|(pending, _)| pending) != Some(&navigation) {
                return;
            }
            entry.frame.document = next_document();
            entry.frame.url = href.clone();
            entry.navigation = Some(navigation.clone());
            entry.pending = None;
            let document = entry.frame.document;
            state.synthesized.insert(navigation.clone());
            for child in &children {
                state.remove_tree(child);
            }
            if frame == self.top {
                state.idle = Idle { document, dom_ready: ready != "loading", ..Idle::default() };
            }
            (document, children)
        };
        tokio::spawn(self.clone().mark(frame.clone(), document));
        for child in children {
            self.emit(PageEvent::FrameDetached(child));
        }
        self.emit(PageEvent::Committed {
            frame: frame.clone(),
            document,
            navigation: Some(NavigationId::from(navigation)),
            url: href,
            name: String::new(),
        });
        if ready == "interactive" || ready == "complete" {
            self.emit(PageEvent::Loaded { frame: frame.clone(), document, state: LoadState::DomContentLoaded });
        }
        if ready == "complete" {
            self.emit(PageEvent::Loaded { frame, document, state: LoadState::Load });
        }
        self.bump();
    }

    /// Emits `NetworkIdle` once per main document: at most two requests in flight for 500 ms after DOMContentLoaded.
    fn idle_tick(&self) -> bool {
        let emit = {
            let mut state = self.state.lock().unwrap();
            if state.closed.is_some() {
                return false;
            }
            let Some(document) = state.frames.get(&self.top).map(|e| e.frame.document) else { return true };
            if state.idle.document != document {
                state.idle = Idle { document, ..Idle::default() };
            }
            if !state.idle.dom_ready || state.idle.emitted {
                return true;
            }
            state.inflight.retain(|_, started| started.elapsed() < IDLE_STALE_REQUEST);
            if state.inflight.len() > IDLE_MAX_ACTIVE {
                state.idle.quiet_since = None;
                return true;
            }
            match state.idle.quiet_since {
                None => {
                    state.idle.quiet_since = Some(Instant::now());
                    None
                }
                Some(since) if since.elapsed() >= IDLE_QUIET => {
                    state.idle.emitted = true;
                    Some(document)
                }
                Some(_) => None,
            }
        };
        if let Some(document) = emit {
            self.emit(PageEvent::Loaded { frame: self.top.clone(), document, state: LoadState::NetworkIdle });
        }
        true
    }
}

fn build_tree(state: &mut State, node: &Value, parent: Option<FrameId>) {
    let id = FrameId::from(str_of(node, "context"));
    if id.as_str().is_empty() {
        return;
    }
    state.frames.insert(id.clone(), FrameEntry::new(id.clone(), parent, display_url(str_of(node, "url"))));
    for child in node.get("children").and_then(Value::as_array).into_iter().flatten() {
        build_tree(state, child, Some(id.clone()));
    }
}

/// WebDriver BiDi implementation of `TabDriver` and `CaptureDriver` for one top-level browsing context.
///
/// Frame ids are BiDi browsing context ids (the main frame's is the tab's `TargetId`); browse's isolated world is
/// the `__browse` sandbox. Returns `DriverError::Unsupported` only where BiDi lacks an equivalent (`interrupt`,
/// touch emulation, media types).
pub struct BiDiTabDriver {
    pub(crate) shared: Arc<Shared>,
    tasks: Vec<tokio::task::AbortHandle>,
}

impl BiDiTabDriver {
    /// Attaches to the top-level browsing context `context`: subscribes to its events and reads its frame tree.
    pub async fn attach(transport: Arc<dyn BiDiTransport>, context: TargetId) -> DriverResult<Arc<BiDiTabDriver>> {
        let top = FrameId::from(context.as_str());
        let mut raw = transport.events();
        let closed_tab = |error: BiDiError| match error.code() {
            Some("no such frame") => DriverError::Closed(CloseReason::Closed),
            _ => map_error(error),
        };
        let subscribed = transport
            .send("session.subscribe", json!({ "events": TAB_EVENTS, "contexts": [top.as_str()] }))
            .await
            .map_err(closed_tab)?;
        let subscription = subscribed.get("subscription").and_then(Value::as_str).map(str::to_string);
        let tree = match transport.send("browsingContext.getTree", json!({ "root": top.as_str() })).await {
            Ok(tree) => tree,
            Err(error) => {
                if let Some(id) = &subscription {
                    let _ = transport.send("session.unsubscribe", json!({ "subscriptions": [id] })).await;
                }
                return Err(closed_tab(error));
            }
        };
        let mut state = State::default();
        if let Some(root) = tree.get("contexts").and_then(Value::as_array).and_then(|c| c.first()) {
            build_tree(&mut state, root, None);
        }
        if !state.frames.contains_key(&top) {
            return Err(DriverError::Closed(CloseReason::Closed));
        }
        let (events, _) = broadcast::channel(2048);
        let (changed, _) = watch::channel(0);
        let shared = Arc::new(Shared {
            transport,
            top,
            state: Mutex::new(state),
            events,
            changed,
            input: Mutex::new(crate::input::InputState::default()),
            network: tokio::sync::Mutex::new(crate::capture::NetworkSubscriptions::default()),
            subscription: Mutex::new(subscription),
        });
        let initial: Vec<(FrameId, DocumentId)> =
            shared.state.lock().unwrap().frames.values().map(|e| (e.frame.id.clone(), e.frame.document)).collect();
        for (frame, document) in initial {
            tokio::spawn(shared.clone().mark(frame, document));
        }
        let pump_shared = shared.clone();
        let pump = tokio::spawn(async move {
            loop {
                match raw.recv().await {
                    Ok(event) => {
                        pump_shared.handle(event)
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
            pump_shared.close(CloseReason::BrowserDisconnected);
        });
        let idle_shared = Arc::downgrade(&shared);
        let idle = tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_millis(100)).await;
                let Some(shared) = idle_shared.upgrade() else { return };
                if !shared.idle_tick() {
                    return;
                }
            }
        });
        Ok(Arc::new(BiDiTabDriver { shared, tasks: vec![pump.abort_handle(), idle.abort_handle()] }))
    }

    /// The tab's top-level browsing context.
    pub fn context(&self) -> &FrameId {
        &self.shared.top
    }

    async fn script(&self, frame: &FrameId, document: DocumentId, epoch: u64, method: &str, params: Value) -> DriverResult<Value> {
        self.shared.guarded(frame, document, epoch, method, params).await
    }

    async fn capture_png(&self, params: Value) -> DriverResult<Vec<u8>> {
        let result = self
            .shared
            .transport
            .send("browsingContext.captureScreenshot", params)
            .await
            .map_err(|error| self.shared.frame_error(error, &self.shared.top))?;
        let data = result
            .get("data")
            .and_then(Value::as_str)
            .ok_or_else(|| DriverError::Protocol("the browser returned no screenshot".into()))?;
        use base64::Engine;
        base64::engine::general_purpose::STANDARD
            .decode(data)
            .map_err(|error| DriverError::Protocol(format!("invalid screenshot data: {error}")))
    }

    async fn emulation(&self, method: &str, params: Value, what: &'static str) -> DriverResult<()> {
        match self.shared.transport.send(method, params).await {
            Ok(_) => Ok(()),
            Err(error) if matches!(error.code(), Some("unsupported operation" | "unknown command")) => {
                Err(DriverError::Unsupported(what))
            }
            Err(error) => Err(self.shared.frame_error(error, &self.shared.top)),
        }
    }
}

impl Drop for BiDiTabDriver {
    fn drop(&mut self) {
        for task in &self.tasks {
            task.abort();
        }
        let subscription = self.shared.subscription.lock().unwrap().take();
        if let Some(id) = subscription
            && let Ok(handle) = tokio::runtime::Handle::try_current()
        {
            let transport = self.shared.transport.clone();
            handle.spawn(async move {
                let _ = tokio::time::timeout(
                    Duration::from_secs(2),
                    transport.send("session.unsubscribe", json!({ "subscriptions": [id] })),
                )
                .await;
            });
        }
    }
}

fn navigation_error(message: &str) -> DriverError {
    let detail = message.trim().trim_start_matches("Error:").trim().to_string();
    let kind = if detail.contains("NS_BINDING_ABORTED") || detail.contains("Beforeunload prompt was rejected") {
        NavigationErrorKind::Aborted
    } else {
        NavigationErrorKind::Failed
    };
    DriverError::Navigation(NavigationError { kind, detail })
}

#[async_trait]
impl TabDriver for BiDiTabDriver {
    fn events(&self) -> broadcast::Receiver<PageEvent> {
        self.shared.page_events()
    }

    async fn frames(&self) -> DriverResult<Vec<Frame>> {
        if let Some(reason) = self.shared.closed() {
            return Err(DriverError::Closed(reason));
        }
        Ok(self.shared.ordered_frames())
    }

    async fn navigate(&self, url: &str, _referrer: Option<&str>) -> DriverResult<Option<NavigationId>> {
        if let Some(reason) = self.shared.closed() {
            return Err(DriverError::Closed(reason));
        }
        // Firefox never answers browsingContext.navigate to a javascript: URL.
        if url.trim_start().get(..11).is_some_and(|scheme| scheme.eq_ignore_ascii_case("javascript:")) {
            return Err(DriverError::Refused("browse blocked navigate to a javascript: URL: run script with the evaluate tool instead".into()));
        }
        let fragment = is_fragment_change(&self.shared.top_url(), url);
        let mut events = self.shared.transport.events();
        let result = self
            .shared
            .transport
            .send("browsingContext.navigate", json!({ "context": self.shared.top.as_str(), "url": url, "wait": "none" }))
            .await;
        // Events the browser sent before answering are already queued: a fragment change or a download answers here.
        let mut fragments = HashSet::new();
        let mut downloads = HashSet::new();
        loop {
            match events.try_recv() {
                Ok(event) if str_of(&event.params, "context") == self.shared.top.as_str() => {
                    let navigation = str_of(&event.params, "navigation").to_string();
                    match event.method.as_str() {
                        "browsingContext.fragmentNavigated" => {
                            fragments.insert(navigation);
                        }
                        "browsingContext.downloadWillBegin" => {
                            downloads.insert(navigation);
                        }
                        _ => {}
                    }
                }
                Ok(_) | Err(broadcast::error::TryRecvError::Lagged(_)) => {}
                Err(_) => break,
            }
        }
        let result = match result {
            Ok(result) => result,
            Err(BiDiError::Command { error, message }) if error == "unknown error" => {
                return Err(navigation_error(&message));
            }
            Err(error) => return Err(self.shared.frame_error(error, &self.shared.top)),
        };
        let navigation = str_of(&result, "navigation").to_string();
        let (seen_fragment, seen_download) = {
            let state = self.shared.state.lock().unwrap();
            (state.fragment_navigations.contains(&navigation), state.download_navigations.contains(&navigation))
        };
        if seen_download || downloads.contains(&navigation) {
            return Err(DriverError::Navigation(NavigationError {
                kind: NavigationErrorKind::Aborted,
                detail: "the response is a download".into(),
            }));
        }
        if fragment || seen_fragment || fragments.contains(&navigation) || navigation.is_empty() {
            return Ok(None);
        }
        Ok(Some(NavigationId::from(navigation)))
    }

    async fn reload(&self, bypass_cache: bool) -> DriverResult<()> {
        let top = self.shared.top.clone();
        let transport = self.shared.transport.clone();
        if bypass_cache {
            self.emulation(
                "network.setCacheBehavior",
                json!({ "cacheBehavior": "bypass", "contexts": [top.as_str()] }),
                "reloading without the cache",
            )
            .await?;
            let mut events = transport.events();
            let restore = transport.clone();
            let context = top.clone();
            tokio::spawn(async move {
                let _ = tokio::time::timeout(CACHE_RESTORE, async {
                    loop {
                        match events.recv().await {
                            Ok(event)
                                if str_of(&event.params, "context") == context.as_str()
                                    && matches!(
                                        event.method.as_str(),
                                        "browsingContext.navigationCommitted" | "browsingContext.navigationFailed"
                                    ) =>
                            {
                                return;
                            }
                            Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => {}
                            Err(_) => return,
                        }
                    }
                })
                .await;
                let _ = restore
                    .send("network.setCacheBehavior", json!({ "cacheBehavior": "default", "contexts": [context.as_str()] }))
                    .await;
            });
        }
        let mut events = transport.events();
        let sender = transport.clone();
        let context = top.clone();
        let mut command = tokio::spawn(async move {
            sender.send("browsingContext.reload", json!({ "context": context.as_str(), "wait": "none" })).await
        });
        loop {
            tokio::select! {
                result = &mut command => {
                    return match result {
                        Ok(Ok(_)) => Ok(()),
                        Ok(Err(BiDiError::Command { error, message })) if error == "unknown error" => Err(navigation_error(&message)),
                        Ok(Err(error)) => Err(self.shared.frame_error(error, &top)),
                        Err(error) => Err(DriverError::Protocol(format!("reload failed: {error}"))),
                    };
                }
                event = events.recv() => match event {
                    Ok(event) if event.method == "browsingContext.navigationStarted" && str_of(&event.params, "context") == top.as_str() => return Ok(()),
                    Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => {}
                    Err(_) => return Err(DriverError::Closed(CloseReason::BrowserDisconnected)),
                },
            }
        }
    }

    async fn traverse_history(&self, delta: i32) -> DriverResult<bool> {
        match self
            .shared
            .transport
            .send("browsingContext.traverseHistory", json!({ "context": self.shared.top.as_str(), "delta": delta }))
            .await
        {
            Ok(_) => Ok(true),
            Err(error) if error.code() == Some("no such history entry") => Ok(false),
            Err(error) => Err(self.shared.frame_error(error, &self.shared.top)),
        }
    }

    async fn evaluate(&self, realm: &Realm, expression: &str, opts: CallOptions) -> Eval {
        let (document, epoch) = self.shared.document_of(&realm.frame)?;
        let mut params = json!({
            "expression": expression,
            "target": value::target(&realm.frame, realm.world),
            "awaitPromise": opts.await_promise,
            "userActivation": opts.user_activation,
        });
        value::apply_returns(&mut params, opts.returns);
        let result = self.script(&realm.frame, document, epoch, "script.evaluate", params).await?;
        Ok(value::parse_result(&result, &realm.frame, realm.world, document, opts.returns))
    }

    async fn call(&self, on: &Receiver, function: &str, args: &[Arg], opts: CallOptions) -> Eval {
        let (frame, world) = match on {
            Receiver::Global(realm) => (realm.frame.clone(), realm.world),
            Receiver::Ref(reference) => (reference.frame.clone(), reference.world),
        };
        let (document, epoch) = self.shared.document_of(&frame)?;
        let this = match on {
            Receiver::Global(_) => None,
            Receiver::Ref(reference) => Some(value::checked_token(reference, &frame, document)?.reference()),
        };
        let mut arguments = Vec::with_capacity(args.len());
        for arg in args {
            arguments.push(match arg {
                Arg::Json(json) => value::local_value(json),
                Arg::Undefined => json!({ "type": "undefined" }),
                Arg::Ref(reference) => value::checked_token(reference, &frame, document)?.reference(),
            });
        }
        let mut params = json!({
            "functionDeclaration": function,
            "arguments": arguments,
            "target": value::target(&frame, world),
            "awaitPromise": opts.await_promise,
            "userActivation": opts.user_activation,
        });
        if let Some(this) = this {
            params["this"] = this;
        }
        value::apply_returns(&mut params, opts.returns);
        let result = self.script(&frame, document, epoch, "script.callFunction", params).await?;
        Ok(value::parse_result(&result, &frame, world, document, opts.returns))
    }

    async fn release(&self, refs: Vec<RemoteRef>) {
        let mut groups: HashMap<(FrameId, bool), Vec<String>> = HashMap::new();
        for reference in &refs {
            let current = self.shared.document_of(&reference.frame).ok().map(|(document, _)| document);
            if current != Some(reference.document) {
                continue;
            }
            if let Some(handle) = Token::parse(reference.token()).as_ref().and_then(Token::handle) {
                groups
                    .entry((reference.frame.clone(), reference.world == World::Isolated))
                    .or_default()
                    .push(handle.to_string());
            }
        }
        if groups.is_empty() {
            return;
        }
        let sends = groups.into_iter().map(|((frame, isolated), handles)| {
            let world = if isolated { World::Isolated } else { World::Main };
            let params = json!({ "handles": handles, "target": value::target(&frame, world) });
            let transport = self.shared.transport.clone();
            async move {
                let _ = transport.send("script.disown", params).await;
            }
        });
        let _ = tokio::time::timeout(RELEASE_TIMEOUT, futures_util::future::join_all(sends)).await;
    }

    async fn adopt(&self, node: &RemoteRef, world: World) -> DriverResult<RemoteRef> {
        match Token::parse(node.token()) {
            Some(Token::Node { shared, .. }) => {
                let (document, _) = self.shared.document_of(&node.frame)?;
                if document != node.document {
                    return Err(DriverError::Stale);
                }
                let token = Token::Node { shared, handle: None };
                Ok(RemoteRef::new(node.frame.clone(), world, document, token.encode()))
            }
            _ => Err(DriverError::Protocol("only DOM nodes can move to another world".into())),
        }
    }

    async fn frame_element(&self, frame: &FrameId) -> DriverResult<RemoteRef> {
        let parent = {
            let state = self.shared.state.lock().unwrap();
            let entry = state.frames.get(frame).ok_or(DriverError::Stale)?;
            entry
                .frame
                .parent
                .clone()
                .ok_or_else(|| DriverError::Protocol("The main frame has no owner element.".into()))?
        };
        let (document, _) = self.shared.document_of(&parent)?;
        let cached = {
            let state = self.shared.state.lock().unwrap();
            state.frame_elements.get(&(parent.clone(), document)).and_then(|owners| owners.get(frame).cloned())
        };
        let shared_id = match cached {
            Some(shared_id) => shared_id,
            None => {
                const OWNERS: &str = "function () { const out = []; const walk = (root) => { for (const el of root.querySelectorAll(\"*\")) { if (el.localName === \"iframe\" || el.localName === \"frame\") out.push([el, el.contentWindow]); if (el.shadowRoot) walk(el.shadowRoot); } }; walk(document); return out; }";
                let pairs = self.shared.sandbox_call(&parent, OWNERS, &[]).await?;
                let mut owners = HashMap::new();
                for pair in pair_values(&pairs) {
                    let (Some(element), Some(window)) = (pair.first(), pair.get(1)) else { continue };
                    let shared_id = str_of(element, "sharedId");
                    let context = window.pointer("/value/context").and_then(Value::as_str).unwrap_or("");
                    if !shared_id.is_empty() && !context.is_empty() {
                        owners.insert(FrameId::from(context), shared_id.to_string());
                    }
                }
                let found = owners.get(frame).cloned();
                let mut state = self.shared.state.lock().unwrap();
                state.frame_elements.retain(|(owner, _), _| owner != &parent);
                state.frame_elements.insert((parent.clone(), document), owners);
                found.ok_or(DriverError::Stale)?
            }
        };
        let token = Token::Node { shared: shared_id, handle: None };
        Ok(RemoteRef::new(parent, World::Isolated, document, token.encode()))
    }

    async fn content_frame(&self, node: &RemoteRef) -> DriverResult<Option<FrameId>> {
        let (document, epoch) = self.shared.document_of(&node.frame)?;
        let this = value::checked_token(node, &node.frame, document)?.reference();
        let params = json!({
            "functionDeclaration": "function () { return this.contentWindow; }",
            "this": this,
            "arguments": [],
            "target": value::target(&node.frame, node.world),
            "awaitPromise": false,
            "resultOwnership": "none",
            "serializationOptions": { "maxObjectDepth": 0, "maxDomDepth": 0 },
        });
        let result = self.script(&node.frame, document, epoch, "script.callFunction", params).await?;
        let window = &result["result"];
        if window.get("type").and_then(Value::as_str) != Some("window") {
            return Ok(None);
        }
        Ok(window.pointer("/value/context").and_then(Value::as_str).map(FrameId::from))
    }

    fn prepare_file_chooser_interception(&self) -> FileChooserArm {
        FileChooserArm(0)
    }

    async fn arm_file_chooser_interception(&self, _arm: FileChooserArm) -> DriverResult<()> {
        Err(DriverError::Unsupported("file chooser interception"))
    }

    async fn disarm_file_chooser_interception(&self, _arm: FileChooserArm) {}

    async fn take_file_chooser(&self, _timeout: Duration) -> DriverResult<Option<FileChooser>> {
        Err(DriverError::Unsupported("file chooser interception"))
    }

    async fn set_files(&self, input: &RemoteRef, paths: &[PathBuf]) -> DriverResult<()> {
        let (document, _) = self.shared.document_of(&input.frame)?;
        let element = value::checked_token(input, &input.frame, document)?.reference();
        let files: Vec<String> = paths.iter().map(|path| path.display().to_string()).collect();
        match self
            .shared
            .transport
            .send("input.setFiles", json!({ "context": input.frame.as_str(), "element": element, "files": files }))
            .await
        {
            Ok(_) => Ok(()),
            Err(BiDiError::Command { error, message })
                if error == "unable to set file input" || error == "unsupported operation" =>
            {
                Err(DriverError::Refused(message))
            }
            Err(error) => Err(self.shared.frame_error(error, &input.frame)),
        }
    }

    async fn pointer(&self, event: PointerEvent) -> DriverResult<()> {
        crate::input::pointer(&self.shared, event).await
    }

    async fn key(&self, event: KeyEvent) -> DriverResult<()> {
        crate::input::key(&self.shared, &event).await
    }

    async fn insert_text(&self, text: &str) -> DriverResult<()> {
        crate::input::insert_text(&self.shared, text).await
    }

    async fn drag(
        &self,
        from: (f64, f64),
        to: (f64, f64),
        steps: &[PointerStep],
        modifiers: Modifiers,
    ) -> DriverResult<DragOutcome> {
        crate::input::drag(&self.shared, from, to, steps, modifiers).await
    }

    async fn answer_dialog(&self, accept: bool, text: Option<&str>) -> DriverResult<()> {
        let context = self.shared.state.lock().unwrap().dialog.clone().unwrap_or_else(|| self.shared.top.clone());
        let mut params = json!({ "context": context.as_str(), "accept": accept });
        if let Some(text) = text {
            params["userText"] = json!(text);
        }
        match self.shared.transport.send("browsingContext.handleUserPrompt", params).await {
            Ok(_) => {
                self.shared.state.lock().unwrap().dialog = None;
                Ok(())
            }
            Err(error) if error.code() == Some("no such alert") => {
                self.shared.state.lock().unwrap().dialog = None;
                Err(DriverError::Protocol("no dialog is open".into()))
            }
            Err(error) => Err(self.shared.frame_error(error, &context)),
        }
    }

    async fn viewport(&self) -> DriverResult<Viewport> {
        const METRICS: &str = "function () { const vv = window.visualViewport, de = document.documentElement, body = document.body, se = document.scrollingElement || de; return [vv ? vv.pageLeft : scrollX, vv ? vv.pageTop : scrollY, vv ? vv.width : innerWidth, vv ? vv.height : innerHeight, de ? de.clientWidth : innerWidth, de ? de.clientHeight : innerHeight, Math.max(se ? se.scrollWidth : 0, de ? de.scrollWidth : 0, body ? body.scrollWidth : 0), Math.max(se ? se.scrollHeight : 0, de ? de.scrollHeight : 0, body ? body.scrollHeight : 0), devicePixelRatio]; }";
        let metrics = value::to_json(&self.shared.sandbox_call(&self.shared.top, METRICS, &[]).await?);
        let number = |index: usize| metrics.get(index).and_then(Value::as_f64);
        let width = number(2).unwrap_or(0.0);
        let height = number(3).unwrap_or(0.0);
        Ok(Viewport {
            page_x: number(0).unwrap_or(0.0),
            page_y: number(1).unwrap_or(0.0),
            width,
            height,
            layout_width: number(4).filter(|w| *w > 0.0),
            layout_height: number(5).filter(|h| *h > 0.0),
            content_width: number(6).filter(|w| *w > 0.0).unwrap_or(width),
            content_height: number(7).filter(|h| *h > 0.0).unwrap_or(height),
            // BiDi boxes are CSS pixels and its screenshots don't apply a page zoom, so geometry is already DIP-sized.
            page_zoom: 1.0,
            device_pixel_ratio: number(8).filter(|d| *d > 0.0).unwrap_or(1.0),
        })
    }

    async fn screenshot(&self, shot: Screenshot) -> DriverResult<Image> {
        let resample = (shot.scale - 1.0).abs() > 0.001 && shot.scale > 0.0;
        let format = if resample { ImageFormat::Png } else { shot.format };
        let mut params = json!({ "context": self.shared.top.as_str(), "format": { "type": format.mime() } });
        if format != ImageFormat::Png {
            let quality = shot.quality.unwrap_or(80).clamp(0, 100) as f64 / 100.0;
            params["format"]["quality"] = json!(quality);
        }
        match shot.area {
            ScreenshotArea::Viewport => params["origin"] = json!("viewport"),
            ScreenshotArea::Clip { rect, .. } => {
                params["origin"] = json!("document");
                params["clip"] = json!({ "type": "box", "x": rect.x, "y": rect.y, "width": rect.width, "height": rect.height });
            }
        }
        let bytes = self.capture_png(params).await?;
        if !resample {
            return Ok(Image { bytes, format, note: None });
        }
        let bytes = crate::image::rescale_png(&bytes, shot.scale)?;
        let note = (shot.format != ImageFormat::Png)
            .then(|| format!("resampled and returned as PNG (asked for {})", shot.format.name()));
        Ok(Image { bytes, format: ImageFormat::Png, note })
    }

    async fn emulate(&self, change: Emulation) -> DriverResult<()> {
        let top = self.shared.top.as_str();
        match change {
            Emulation::Viewport(viewport) => {
                let size = viewport.map(|v| json!({ "width": v.width, "height": v.height }));
                let ratio = viewport.map(|v| v.device_scale_factor).filter(|ratio| *ratio > 0.0);
                self.emulation(
                    "browsingContext.setViewport",
                    json!({ "context": top, "viewport": size, "devicePixelRatio": ratio }),
                    "viewport emulation",
                )
                .await
            }
            Emulation::UserAgent(agent) => {
                let agent = agent.filter(|agent| !agent.is_empty());
                self.emulation(
                    "emulation.setUserAgentOverride",
                    json!({ "contexts": [top], "userAgent": agent }),
                    "user agent emulation",
                )
                .await
            }
            Emulation::Geolocation(geo) => {
                let coordinates = geo.map(|g| json!({ "latitude": g.latitude, "longitude": g.longitude, "accuracy": g.accuracy }));
                self.emulation(
                    "emulation.setGeolocationOverride",
                    json!({ "contexts": [top], "coordinates": coordinates }),
                    "geolocation emulation",
                )
                .await
            }
            Emulation::Offline(offline) => {
                let conditions = if offline { json!({ "type": "offline" }) } else { Value::Null };
                self.emulation(
                    "emulation.setNetworkConditions",
                    json!({ "contexts": [top], "networkConditions": conditions }),
                    "offline emulation",
                )
                .await
            }
            Emulation::Media(media) => {
                if !media.media.is_empty() {
                    return Err(DriverError::Unsupported("media emulation"));
                }
                let features = (!media.features.is_empty()).then(|| {
                    Value::Object(media.features.iter().map(|f| (f.name.clone(), json!(f.value))).collect())
                });
                self.emulation(
                    "emulation.setMediaFeaturesOverride",
                    json!({ "contexts": [top], "features": features }),
                    "media emulation",
                )
                .await
            }
            Emulation::Touch(_) => Err(DriverError::Unsupported("touch emulation")),
        }
    }

    fn capture(&self) -> &dyn CaptureDriver {
        self
    }
}

/// The `[element, window]` pairs of a serialized array of arrays.
fn pair_values(result: &Value) -> Vec<Vec<Value>> {
    result
        .get("value")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.get("value").and_then(Value::as_array).cloned())
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn neterror_pages_show_the_url_that_failed() {
        assert_eq!(
            display_url("about:neterror?e=dnsNotFound&u=http%3A//nonexistent.invalid/&c=UTF-8&d=We%20can"),
            "http://nonexistent.invalid/"
        );
        assert_eq!(display_url("http://a/b"), "http://a/b");
        assert_eq!(display_url("about:neterror?e=x"), "about:neterror?e=x");
    }

    #[test]
    fn fragment_changes() {
        assert!(is_fragment_change("http://a/x", "http://a/x#top"));
        assert!(!is_fragment_change("http://a/x", "http://a/y#top"));
        assert!(!is_fragment_change("", "http://a/x#top"));
    }

    #[test]
    fn navigation_errors_by_cause() {
        let kind = |message: &str| match navigation_error(message) {
            DriverError::Navigation(error) => error.kind,
            other => panic!("{other:?}"),
        };
        assert_eq!(kind("Error: NS_BINDING_ABORTED"), NavigationErrorKind::Aborted);
        assert_eq!(kind("Error: Beforeunload prompt was rejected"), NavigationErrorKind::Aborted);
        assert_eq!(kind("Error: NS_ERROR_UNKNOWN_HOST"), NavigationErrorKind::Failed);
        match navigation_error("Error: NS_ERROR_UNKNOWN_HOST") {
            DriverError::Navigation(error) => assert_eq!(error.detail, "NS_ERROR_UNKNOWN_HOST"),
            other => panic!("{other:?}"),
        }
    }
}
