//! CDP network capture reconciliation.
//!
//! Absorbs all CDP-specific network quirks inside `browse-cdp`:
//! - `Network.enable` / `Network.disable` refcounting shared with offline emulation
//! - `Target.setAutoAttach` child sessions for out-of-process iframes & workers
//! - `RequestWillBeSentExtraInfo` / `ResponseReceivedExtraInfo` wire-header merging
//! - `DataReceived` byte accumulation and `CHILD_DOCUMENT_GRACE` completion
//! - Per-request CDP session lookup for `getRequestPostData` and `getResponseBody`

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine;
use browse_core::{
    BodyKind, CloseReason, DriverResult, FrameId, NetworkEvent, NetworkOptions, NetworkRequest, RequestId,
    ResponseHead, Subscription,
};
use serde_json::{Value, json};
use tokio::sync::{broadcast, mpsc, watch};

use crate::wire::{Cdp, CdpEvent, map_cdp_error};

const CHILD_DOCUMENT_GRACE: Duration = Duration::from_millis(1_000);
const MAX_EXTRA_CACHE: usize = 4_000;
/// Extra info for hops not announced yet. A redirect chain never has this many in flight; the cap keeps a stream of
/// extras with no `requestWillBeSent` from growing a chain without bound.
const MAX_EARLY_EXTRA: usize = 16;

pub(crate) fn enable_params() -> Value {
    json!({ "maxPostDataSize": 65_536 })
}

pub(crate) struct NetworkDomain {
    pub capture: bool,
    pub offline: bool,
    /// Child sessions whose `Network.enable` finished, so `CdpTabDriver` does not resume a paused child target before
    /// capture is listening on it.
    pub enabled_sessions: HashSet<String>,
    pub session_ready: watch::Sender<u64>,
}

impl Default for NetworkDomain {
    fn default() -> Self {
        Self {
            capture: false,
            offline: false,
            enabled_sessions: HashSet::new(),
            session_ready: watch::channel(0).0,
        }
    }
}

#[derive(Default)]
pub(crate) struct NetworkBodyMap {
    /// `event_id` -> `(cdp_request_id, request_session, response_body_session)`
    sessions: HashMap<String, (String, Option<String>, Option<String>)>,
}

impl NetworkBodyMap {
    pub(crate) fn record_request(&mut self, event_id: &str, cdp_request_id: &str, session: Option<String>) {
        if self.sessions.len() > 2_000 {
            self.sessions.clear();
        }
        self.sessions
            .insert(event_id.to_string(), (cdp_request_id.to_string(), session.clone(), session));
    }

    pub(crate) fn record_body_session(&mut self, event_id: &str, session: Option<String>) {
        if let Some(entry) = self.sessions.get_mut(event_id) {
            entry.2 = session;
        }
    }

    pub(crate) fn lookup(&self, event_id: &str, kind: BodyKind) -> (String, Option<String>) {
        match self.sessions.get(event_id) {
            Some((cdp_id, req, resp)) => {
                let session = match kind {
                    BodyKind::Request => req.clone(),
                    BodyKind::Response => resp.clone(),
                };
                (cdp_id.clone(), session)
            }
            None => (event_id.to_string(), None),
        }
    }
}

struct Pending {
    /// Unique per redirect hop (equals `cdp_request_id` on hop 0, `{cdp_request_id}#redirect-{n}` on later hops).
    event_id: String,
    cdp_request_id: String,
    /// This hop's index in the chain, so its extra info cannot be filed under another hop.
    hop: usize,
    url: String,
    resource_type: String,
    frame_id: Option<String>,
    data_length: usize,
    response: Option<ResponseHead>,
    /// `responseReceived` said extra-info events (the headers as sent, cookies included) come for it.
    has_extra_info: bool,
    /// The request went to the network: http(s), and nothing said it was served from cache or a service worker. Only
    /// such a failure can still have a `requestWillBeSentExtraInfo` to wait for.
    expects_request_extra: bool,
}

enum FinishingOutcome {
    Finished { body_size: usize },
    Failed { error: String },
}

/// A finished or failed hop whose extra info hasn't arrived yet: CDP may send it after `loadingFinished`,
/// `loadingFailed`, or `requestWillBeSent(redirectResponse)`.
struct Finishing {
    cdp_request_id: String,
    outcome: FinishingOutcome,
    expects_request: bool,
    expects_response: bool,
}

/// How long a finished request waits for its extra info before it is reported without it.
const EXTRA_INFO_GRACE: std::time::Duration = std::time::Duration::from_millis(250);

struct ExtraResponse {
    headers: Vec<(String, String)>,
    status: Option<i64>,
}

/// One hop of a CDP request id's redirect chain, and whether CDP said extra info is coming for it.
struct HopExtra {
    event_id: String,
    expects_request: Option<bool>,
    expects_response: Option<bool>,
    /// The request/response extra was filed here by position before CDP confirmed this hop expects one. If the hop
    /// turns out to have none (a cached redirect), the extra belongs to the next hop.
    request_extra_by_position: bool,
    response_extra_by_position: bool,
}

/// Every hop of one CDP request id. CDP reuses the id across redirects and sends each hop's extra info in order, but
/// a hop without extra info (a cached redirect, a `hasExtraInfo:false` response) never sends one, so the cursors skip
/// it instead of shifting every later hop's extra info onto the wrong hop.
#[derive(Default)]
struct Chain {
    hops: Vec<HopExtra>,
    /// The hop the next `requestWillBeSentExtraInfo` belongs to.
    request_cursor: usize,
    /// The hop the next `responseReceivedExtraInfo` belongs to.
    response_cursor: usize,
    /// Request/response extra info that arrived before its hop was announced, by hop index.
    early_request_extra: HashMap<usize, Vec<(String, String)>>,
    early_response_extra: HashMap<usize, ExtraResponse>,
}

impl Chain {
    fn advance_cursors(&mut self) {
        while self.request_cursor < self.hops.len() && self.hops[self.request_cursor].expects_request == Some(false) {
            self.request_cursor += 1;
        }
        while self.response_cursor < self.hops.len() && self.hops[self.response_cursor].expects_response == Some(false) {
            self.response_cursor += 1;
        }
    }
}

#[derive(Default)]
struct State {
    pending: HashMap<(Option<String>, String), Pending>,
    /// CDP request id -> its redirect chain.
    chains: HashMap<String, Chain>,
    /// Reported hop id -> the headers the request went out with.
    request_extra: HashMap<String, Vec<(String, String)>>,
    /// Reported hop id -> the headers the response came with.
    response_extra: HashMap<String, ExtraResponse>,
    /// Response extra info that arrived before its request's `requestWillBeSent`, by CDP request id.
    early_response_extra: HashMap<String, ExtraResponse>,
    /// Request ids whose chain already ended, so a late extra does not start a chain that never finishes.
    finished_chains: HashSet<String>,
    children: HashMap<String, String>,
    /// Reported hop id -> an ended hop waiting for its extra info.
    finishing: HashMap<String, Finishing>,
}

impl State {
    fn pending_key(&self, key: &(Option<String>, String)) -> Option<(Option<String>, String)> {
        if self.pending.contains_key(key) {
            return Some(key.clone());
        }
        self.pending.keys().find(|other| other.1 == key.1).cloned()
    }

    fn take_pending(&mut self, key: &(Option<String>, String)) -> Option<Pending> {
        let key = self.pending_key(key)?;
        self.pending.remove(&key)
    }

    fn ensure_chain_capacity(&mut self) {
        if self.chains.len() <= MAX_EXTRA_CACHE {
            return;
        }
        // Never evict a live chain: its hop counter is what keeps the ids it already reported apart from new ones.
        let live: HashSet<String> = self
            .pending
            .values()
            .map(|pending| pending.cdp_request_id.clone())
            .chain(self.finishing.values().map(|finishing| finishing.cdp_request_id.clone()))
            .collect();
        let dead: Vec<String> = self.chains.keys().filter(|id| !live.contains(*id)).cloned().collect();
        for id in dead {
            self.remove_chain(&id);
        }
    }

    /// Removes a chain and its extras, remembering the id so a late extra does not start a chain that never ends.
    fn remove_chain(&mut self, cdp_request_id: &str) {
        if let Some(chain) = self.chains.remove(cdp_request_id) {
            for hop in chain.hops {
                self.request_extra.remove(&hop.event_id);
                self.response_extra.remove(&hop.event_id);
            }
        }
        self.early_response_extra.remove(cdp_request_id);
        self.finished_chains.insert(cdp_request_id.to_string());
        if self.finished_chains.len() > MAX_EXTRA_CACHE {
            self.finished_chains.clear();
        }
    }

    /// Appends a hop to `cdp_request_id`'s chain and returns its index and reported id.
    fn next_hop(&mut self, cdp_request_id: &str) -> (usize, String) {
        self.ensure_chain_capacity();
        self.finished_chains.remove(cdp_request_id);
        let (hop, event_id, early_request, early_response) = {
            let chain = self.chains.entry(cdp_request_id.to_string()).or_default();
            let hop = chain.hops.len();
            let event_id = if hop == 0 {
                cdp_request_id.to_string()
            } else {
                format!("{cdp_request_id}#redirect-{hop}")
            };
            let early_request = chain.early_request_extra.remove(&hop);
            let mut early_response = chain.early_response_extra.remove(&hop);
            if early_response.is_none() && hop == 0 {
                early_response = self.early_response_extra.remove(cdp_request_id);
            }
            chain.hops.push(HopExtra {
                event_id: event_id.clone(),
                expects_request: early_request.as_ref().map(|_| true),
                expects_response: early_response.as_ref().map(|_| true),
                request_extra_by_position: early_request.is_some(),
                response_extra_by_position: early_response.is_some(),
            });
            (hop, event_id, early_request, early_response)
        };
        if let Some(headers) = early_request {
            self.request_extra.insert(event_id.clone(), headers);
        }
        if let Some(extra) = early_response {
            self.response_extra.insert(event_id.clone(), extra);
            if let Some(chain) = self.chains.get_mut(cdp_request_id) {
                chain.response_cursor = chain.response_cursor.max(hop + 1);
            }
        }
        (hop, event_id)
    }

    /// Records whether CDP said extra info was or will be emitted for a hop. An extra filed here by position before
    /// CDP answered moves to the next hop when this hop turns out to have none.
    fn set_hop_expectations(&mut self, cdp_request_id: &str, hop: usize, expected: bool) {
        let (shift_request, shift_response) = {
            let Some(chain) = self.chains.get(cdp_request_id) else { return };
            let Some(slot) = chain.hops.get(hop) else { return };
            let shift = !expected && hop + 1 < chain.hops.len();
            (shift && slot.request_extra_by_position, shift && slot.response_extra_by_position)
        };
        if shift_request {
            self.shift_request_extra(cdp_request_id, hop);
        }
        if shift_response {
            self.shift_response_extra(cdp_request_id, hop);
        }
        let Some(chain) = self.chains.get_mut(cdp_request_id) else { return };
        let Some(slot) = chain.hops.get_mut(hop) else { return };
        if expected {
            slot.expects_request = Some(true);
            slot.expects_response = Some(true);
            slot.request_extra_by_position = false;
            slot.response_extra_by_position = false;
        } else {
            slot.expects_request.get_or_insert(false);
            slot.expects_response.get_or_insert(false);
        }
        chain.advance_cursors();
    }

    fn shift_request_extra(&mut self, cdp_request_id: &str, hop: usize) {
        let Some(chain) = self.chains.get_mut(cdp_request_id) else { return };
        let Chain { hops, request_cursor, early_request_extra, .. } = chain;
        shift_extra(&mut self.request_extra, early_request_extra, hops, request_cursor, true, hop);
    }

    fn shift_response_extra(&mut self, cdp_request_id: &str, hop: usize) {
        let Some(chain) = self.chains.get_mut(cdp_request_id) else { return };
        let Chain { hops, response_cursor, early_response_extra, .. } = chain;
        shift_extra(&mut self.response_extra, early_response_extra, hops, response_cursor, false, hop);
    }

    /// Files a `requestWillBeSentExtraInfo` under the hop it belongs to (CDP sends them in hop order), which may not
    /// have been announced yet. Returns the hop's reported id when it exists.
    fn set_request_extra(&mut self, cdp_request_id: &str, headers: Vec<(String, String)>) -> Option<String> {
        self.ensure_chain_capacity();
        if !self.chains.contains_key(cdp_request_id) && self.finished_chains.contains(cdp_request_id) {
            return None;
        }
        let chain = self.chains.entry(cdp_request_id.to_string()).or_default();
        chain.advance_cursors();
        let hop = chain.request_cursor;
        chain.request_cursor += 1;
        if let Some(slot) = chain.hops.get_mut(hop) {
            let event_id = slot.event_id.clone();
            slot.request_extra_by_position |= slot.expects_request.is_none();
            slot.expects_request = Some(true);
            self.request_extra.insert(event_id.clone(), headers);
            Some(event_id)
        } else if chain.early_request_extra.len() < MAX_EARLY_EXTRA {
            chain.early_request_extra.insert(hop, headers);
            None
        } else {
            None
        }
    }

    /// Files a `responseReceivedExtraInfo` under the next hop that has a response. A response extra can arrive before
    /// its `requestWillBeSent`; keep it for the first hop.
    fn set_response_extra(&mut self, cdp_request_id: &str, extra: ExtraResponse) -> Option<String> {
        let Some(chain) = self.chains.get_mut(cdp_request_id) else {
            if !self.finished_chains.contains(cdp_request_id) {
                if self.early_response_extra.len() > MAX_EXTRA_CACHE {
                    self.early_response_extra.clear();
                }
                self.early_response_extra.insert(cdp_request_id.to_string(), extra);
            }
            return None;
        };
        chain.advance_cursors();
        let index = chain.response_cursor;
        if let Some(slot) = chain.hops.get_mut(index) {
            let event_id = slot.event_id.clone();
            slot.response_extra_by_position |= slot.expects_response.is_none();
            slot.expects_response = Some(true);
            chain.response_cursor += 1;
            self.response_extra.insert(event_id.clone(), extra);
            Some(event_id)
        } else {
            chain.response_cursor += 1;
            if chain.early_response_extra.len() < MAX_EARLY_EXTRA {
                chain.early_response_extra.insert(index, extra);
            }
            None
        }
    }

    /// Drops a chain once no hop of it is pending or waiting for extra info.
    fn finish_chain(&mut self, cdp_request_id: &str) {
        if self.pending.values().any(|pending| pending.cdp_request_id == cdp_request_id)
            || self.finishing.values().any(|finishing| finishing.cdp_request_id == cdp_request_id)
        {
            return;
        }
        self.remove_chain(cdp_request_id);
    }

    fn synth_response_from_extra(&self, pending: &mut Pending) -> bool {
        if pending.response.is_none()
            && let Some(extra) = self.response_extra.get(&pending.event_id)
            && let Some(status) = extra.status
        {
            let mime_type = extra
                .headers
                .iter()
                .find(|(name, _)| name.eq_ignore_ascii_case("content-type"))
                .map(|(_, value)| value.split(';').next().unwrap_or("").trim().to_string())
                .filter(|m| !m.is_empty());
            pending.response = Some(ResponseHead {
                status,
                status_text: String::new(),
                headers: extra.headers.clone(),
                mime_type,
            });
        }
        pending.response.is_some()
    }
}

fn extra_expects(slot: &HopExtra, request: bool) -> Option<bool> {
    if request { slot.expects_request } else { slot.expects_response }
}

fn set_extra_expects(slot: &mut HopExtra, request: bool, value: Option<bool>) {
    if request {
        slot.expects_request = value;
    } else {
        slot.expects_response = value;
    }
}

fn extra_by_position(slot: &HopExtra, request: bool) -> bool {
    if request { slot.request_extra_by_position } else { slot.response_extra_by_position }
}

fn set_extra_by_position(slot: &mut HopExtra, request: bool, value: bool) {
    if request {
        slot.request_extra_by_position = value;
    } else {
        slot.response_extra_by_position = value;
    }
}

/// Moves an extra filed under `hop` by position to the next hop(s) that can take it. Hops already known to have no
/// extra are skipped; extras filed by position on later hops shift too. `request` chooses which kind of extra and
/// the matching hop fields/cursor/map.
fn shift_extra<T>(
    extras: &mut HashMap<String, T>,
    early: &mut HashMap<usize, T>,
    hops: &mut [HopExtra],
    cursor: &mut usize,
    request: bool,
    hop: usize,
) {
    let Some(source) = hops.get(hop) else { return };
    let event_id = source.event_id.clone();
    let Some(value) = extras.remove(&event_id) else {
        if let Some(source) = hops.get_mut(hop) {
            set_extra_by_position(source, request, false);
        }
        return;
    };
    if let Some(source) = hops.get_mut(hop) {
        set_extra_expects(source, request, Some(false));
        set_extra_by_position(source, request, false);
    }
    let mut carried = Some(value);
    let mut index = hop + 1;
    while let Some(value) = carried.take() {
        if index >= hops.len() {
            if early.len() < MAX_EARLY_EXTRA {
                early.insert(index, value);
            }
            *cursor = (*cursor).max(index + 1);
            break;
        }
        let slot = &mut hops[index];
        if extra_expects(slot, request) == Some(false) {
            index += 1;
            carried = Some(value);
            continue;
        }
        if extras.contains_key(&slot.event_id) && !extra_by_position(slot, request) {
            index += 1;
            carried = Some(value);
            continue;
        }
        let displaced = if extra_by_position(slot, request) { extras.remove(&slot.event_id) } else { None };
        set_extra_expects(slot, request, Some(true));
        set_extra_by_position(slot, request, true);
        extras.insert(slot.event_id.clone(), value);
        *cursor = (*cursor).max(index + 1);
        carried = displaced;
        index += 1;
    }
}

pub(crate) async fn start(
    cdp: Arc<dyn Cdp>,
    domain: Arc<Mutex<NetworkDomain>>,
    bodies: Arc<Mutex<NetworkBodyMap>>,
    _opts: NetworkOptions,
) -> DriverResult<Subscription<NetworkEvent>> {
    let mut events = cdp.events();
    cdp.send("Network.enable", enable_params(), None)
        .await
        .map_err(map_cdp_error)?;
    {
        let mut guard = domain.lock().unwrap();
        guard.capture = true;
        guard.enabled_sessions.clear();
    }

    let (tx, rx) = mpsc::unbounded_channel::<NetworkEvent>();
    let state = Arc::new(Mutex::new(State::default()));
    let task_cdp = cdp.clone();
    let task_domain = domain.clone();
    let task_state = state.clone();
    let task_bodies = bodies.clone();
    let task_tx = tx.clone();

    let task = tokio::spawn(async move {
        let reason = loop {
            match events.recv().await {
                Ok(event) => {
                    if event.session_id.is_none() {
                        match event.method.as_str() {
                            "Inspector.detached" => {
                                let reason = event
                                    .params
                                    .get("reason")
                                    .and_then(Value::as_str)
                                    .unwrap_or("detached")
                                    .to_string();
                                break CloseReason::Detached(reason);
                            }
                            "Inspector.targetCrashed" | "Target.targetCrashed" => break CloseReason::Crashed,
                            _ => {}
                        }
                    }
                    handle_event(&task_cdp, &task_domain, &task_state, &task_bodies, &task_tx, event);
                }
                Err(broadcast::error::RecvError::Lagged(missed)) => {
                    let _ = task_tx.send(NetworkEvent::Lagged(missed));
                }
                Err(broadcast::error::RecvError::Closed) => break CloseReason::Closed,
            }
        };
        let _ = task_tx.send(NetworkEvent::Closed(reason));
    });

    // Pause newly attached OOPIFs and workers until `Network.enable` runs on them, so immediate subresource fetches
    // in a fresh child target cannot race ahead of capture. `CdpTabDriver` waits on `NetworkDomain::session_ready`
    // before sending `Runtime.runIfWaitingForDebugger`.
    let _ = cdp
        .send(
            "Target.setAutoAttach",
            json!({ "autoAttach": true, "waitForDebuggerOnStart": true, "flatten": true }),
            None,
        )
        .await;

    let cleanup = Box::new(move || {
        Box::pin(async move {
            let should_disable = {
                let mut guard = domain.lock().unwrap();
                guard.capture = false;
                guard.enabled_sessions.clear();
                guard.session_ready.send_modify(|n| *n += 1);
                !guard.offline
            };
            let _ = cdp
                .send(
                    "Target.setAutoAttach",
                    json!({ "autoAttach": true, "waitForDebuggerOnStart": false, "flatten": true }),
                    None,
                )
                .await;
            if should_disable {
                let _ = cdp.send("Network.disable", json!({}), None).await;
            }
        }) as std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>
    });

    let flush_state = state.clone();
    let flush_tx = tx.clone();
    let flush = move || {
        let mut st = flush_state.lock().unwrap();
        let parked: Vec<String> = st.finishing.keys().cloned().collect();
        for event_id in parked {
            flush_finishing(&mut st, &flush_tx, &event_id, true);
        }
    };
    Ok(Subscription::new(rx, Some(task.abort_handle()), Some(cleanup)).with_flush(flush))
}

pub(crate) async fn fetch_body(
    cdp: &dyn Cdp,
    bodies: &Mutex<NetworkBodyMap>,
    request_id: &RequestId,
    kind: BodyKind,
) -> DriverResult<Option<Vec<u8>>> {
    let (cdp_id, scope) = bodies.lock().unwrap().lookup(request_id.as_str(), kind);
    match kind {
        BodyKind::Request => {
            let value = cdp
                .send(
                    "Network.getRequestPostData",
                    json!({ "requestId": cdp_id }),
                    scope.as_deref(),
                )
                .await
                .map_err(map_cdp_error)?;
            Ok(value
                .get("postData")
                .and_then(Value::as_str)
                .map(|s| s.as_bytes().to_vec()))
        }
        BodyKind::Response => {
            let value = cdp
                .send(
                    "Network.getResponseBody",
                    json!({ "requestId": cdp_id }),
                    scope.as_deref(),
                )
                .await
                .map_err(map_cdp_error)?;
            let body = value.get("body").and_then(Value::as_str).unwrap_or("");
            if value.get("base64Encoded").and_then(Value::as_bool).unwrap_or(false) {
                Ok(base64::engine::general_purpose::STANDARD.decode(body).ok())
            } else {
                Ok(Some(body.as_bytes().to_vec()))
            }
        }
    }
}

/// A CDP headers object as a list. CDP joins a header sent more than once (`Set-Cookie`, above all) into one value
/// with newlines; each becomes its own header again, as the other drivers report them.
fn headers_from(value: Option<&Value>) -> Vec<(String, String)> {
    value
        .and_then(Value::as_object)
        .map(|map| {
            map.iter()
                .flat_map(|(name, value)| {
                    let value = value.as_str().map_or_else(|| value.to_string(), str::to_string);
                    value.split('\n').map(|part| (name.clone(), part.to_string())).collect::<Vec<_>>()
                })
                .collect()
        })
        .unwrap_or_default()
}

fn response_head(value: &Value) -> ResponseHead {
    ResponseHead {
        status: value.get("status").and_then(Value::as_i64).unwrap_or(0),
        status_text: value.get("statusText").and_then(Value::as_str).unwrap_or("").to_string(),
        headers: headers_from(value.get("headers")),
        mime_type: value
            .get("mimeType")
            .and_then(Value::as_str)
            .filter(|mime| !mime.is_empty())
            .map(str::to_string),
    }
}

/// Whether a failed request may still get its request extra info. Only a request that reached the network does: a
/// blocked, CORS-blocked, cached, service-worker or name-resolution failure never gets one, and waiting for it would
/// only delay the failure (and risk a stop before it is reported).
fn failure_extra_expected(pending: &Pending, params: &Value) -> bool {
    if params.get("blockedReason").is_some() || params.get("corsErrorStatus").is_some() {
        return false;
    }
    if pending.has_extra_info {
        return true;
    }
    if !pending.expects_request_extra {
        return false;
    }
    !matches!(
        params.get("errorText").and_then(Value::as_str).unwrap_or(""),
        "net::ERR_NAME_NOT_RESOLVED" | "net::ERR_NAME_RESOLUTION_FAILED" | "net::ERR_INTERNET_DISCONNECTED"
    )
}

fn schedule_extra_grace(state: &Arc<Mutex<State>>, tx: &mpsc::UnboundedSender<NetworkEvent>, event_id: &str) {
    let state = state.clone();
    let tx = tx.clone();
    let event_id = event_id.to_string();
    tokio::spawn(async move {
        tokio::time::sleep(EXTRA_INFO_GRACE).await;
        flush_finishing(&mut state.lock().unwrap(), &tx, &event_id, true);
    });
}

fn handle_event(
    cdp: &Arc<dyn Cdp>,
    domain: &Arc<Mutex<NetworkDomain>>,
    state: &Arc<Mutex<State>>,
    bodies: &Arc<Mutex<NetworkBodyMap>>,
    tx: &mpsc::UnboundedSender<NetworkEvent>,
    event: CdpEvent,
) {
    let params = &event.params;
    let request_id = params.get("requestId").and_then(Value::as_str).unwrap_or("").to_string();
    let key = (event.session_id.clone(), request_id.clone());
    match event.method.as_str() {
        "Network.requestWillBeSent" => {
            let request = params.get("request").cloned().unwrap_or(Value::Null);
            let url = request.get("url").and_then(Value::as_str).unwrap_or("").to_string();
            let method = request.get("method").and_then(Value::as_str).unwrap_or("GET").to_string();
            let resource_type = params.get("type").and_then(Value::as_str).unwrap_or("Other").to_string();
            let frame_id = params.get("frameId").and_then(Value::as_str).map(str::to_string);
            let headers = headers_from(request.get("headers"));
            let post_data = request.get("postData").and_then(Value::as_str).map(str::to_string);
            let has_body = request.get("hasPostData").and_then(Value::as_bool).unwrap_or(false);
            let mut st = state.lock().unwrap();
            let previous = params.get("redirectResponse").and_then(|_| st.take_pending(&key));
            // Register the new hop before flushing the previous one. A previous hop that finishes immediately must
            // not remove the chain, or the early request extra info, that the new hop already belongs to.
            let (hop, event_id) = st.next_hop(&request_id);
            bodies
                .lock()
                .unwrap()
                .record_request(&event_id, &request_id, event.session_id.clone());
            st.pending.insert(
                key,
                Pending {
                    event_id: event_id.clone(),
                    cdp_request_id: request_id,
                    hop,
                    url: url.clone(),
                    resource_type: resource_type.clone(),
                    frame_id: frame_id.clone(),
                    data_length: 0,
                    response: None,
                    has_extra_info: false,
                    expects_request_extra: url.starts_with("http://") || url.starts_with("https://"),
                },
            );
            let mut redirect_of = None;
            if let Some(previous) = previous
                && let Some(redirect) = params.get("redirectResponse")
            {
                let redirect_has_extra = params
                    .get("redirectHasExtraInfo")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                st.set_hop_expectations(&previous.cdp_request_id, previous.hop, redirect_has_extra);
                let head = response_head(redirect);
                let previous_id = previous.event_id.clone();
                let _ = tx.send(NetworkEvent::Response {
                    id: RequestId::from(previous_id.clone()),
                    head,
                    // The redirect response is complete once the next hop starts; a stop before its trailing finish
                    // must still report the 302 rather than turning the hop into a failure.
                    committed: true,
                });
                st.finishing.insert(
                    previous_id.clone(),
                    Finishing {
                        cdp_request_id: previous.cdp_request_id.clone(),
                        outcome: FinishingOutcome::Finished { body_size: previous.data_length },
                        expects_request: redirect_has_extra,
                        expects_response: redirect_has_extra,
                    },
                );
                if redirect_has_extra {
                    if !flush_finishing(&mut st, tx, &previous_id, false) {
                        schedule_extra_grace(state, tx, &previous_id);
                    }
                } else {
                    flush_finishing(&mut st, tx, &previous_id, true);
                }
                redirect_of = Some(previous.url);
            }
            drop(st);
            let _ = tx.send(NetworkEvent::Request(NetworkRequest {
                id: RequestId::from(event_id),
                redirect_of,
                frame: frame_id.map(FrameId::from),
                url,
                method,
                headers,
                resource_type,
                post_data,
                has_body,
            }));
        }
        "Network.requestWillBeSentExtraInfo" => {
            let mut st = state.lock().unwrap();
            if st.request_extra.len() > MAX_EXTRA_CACHE {
                st.request_extra.clear();
            }
            if let Some(event_id) = st.set_request_extra(&request_id, headers_from(params.get("headers"))) {
                flush_finishing(&mut st, tx, &event_id, false);
            }
        }
        "Network.responseReceivedExtraInfo" => {
            let mut st = state.lock().unwrap();
            if st.response_extra.len() > MAX_EXTRA_CACHE {
                st.response_extra.clear();
            }
            let extra = ExtraResponse {
                headers: headers_from(params.get("headers")),
                status: params.get("statusCode").and_then(Value::as_i64),
            };
            if let Some(event_id) = st.set_response_extra(&request_id, extra) {
                flush_finishing(&mut st, tx, &event_id, false);
            }
        }
        "Network.requestServedFromCache" => {
            let mut st = state.lock().unwrap();
            if let Some(found) = st.pending_key(&key) {
                let (cdp_request_id, hop) = {
                    let Some(pending) = st.pending.get_mut(&found) else { return };
                    pending.expects_request_extra = false;
                    (pending.cdp_request_id.clone(), pending.hop)
                };
                st.set_hop_expectations(&cdp_request_id, hop, false);
            }
        }
        "Network.responseReceived" => {
            let Some(head) = params.get("response").map(response_head) else { return };
            // A service-worker response has no network extra info to wait for.
            let from_service_worker = params
                .pointer("/response/fromServiceWorker")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let has_extra_info =
                params.get("hasExtraInfo").and_then(Value::as_bool).unwrap_or(false) && !from_service_worker;
            let mut st = state.lock().unwrap();
            if let Some(found) = st.pending_key(&key) {
                let (event_id, cdp_request_id, hop, resource_type, frame_id) = {
                    let Some(pending) = st.pending.get_mut(&found) else { return };
                    pending.response = Some(head.clone());
                    pending.has_extra_info = has_extra_info;
                    if !has_extra_info {
                        pending.expects_request_extra = false;
                    }
                    (
                        pending.event_id.clone(),
                        pending.cdp_request_id.clone(),
                        pending.hop,
                        pending.resource_type.clone(),
                        pending.frame_id.clone(),
                    )
                };
                st.set_hop_expectations(&cdp_request_id, hop, has_extra_info);
                bodies
                    .lock()
                    .unwrap()
                    .record_body_session(&event_id, event.session_id.clone());
                let committed = resource_type == "Document"
                    && frame_id.as_ref().is_some_and(|f| st.children.contains_key(f));
                drop(st);
                let _ = tx.send(NetworkEvent::Response { id: RequestId::from(event_id), head, committed });
            }
        }
        "Network.dataReceived" => {
            let mut st = state.lock().unwrap();
            if let Some(found) = st.pending_key(&key)
                && let Some(pending) = st.pending.get_mut(&found)
            {
                pending.data_length += params.get("dataLength").and_then(Value::as_u64).unwrap_or(0) as usize;
            }
        }
        "Network.loadingFinished" => {
            let mut st = state.lock().unwrap();
            if let Some(pending) = st.take_pending(&key) {
                bodies
                    .lock()
                    .unwrap()
                    .record_body_session(&pending.event_id, event.session_id.clone());
                let event_id = pending.event_id.clone();
                st.finishing.insert(
                    event_id.clone(),
                    Finishing {
                        cdp_request_id: pending.cdp_request_id.clone(),
                        outcome: FinishingOutcome::Finished { body_size: pending.data_length },
                        expects_request: pending.has_extra_info,
                        expects_response: pending.has_extra_info,
                    },
                );
                if pending.has_extra_info {
                    if !flush_finishing(&mut st, tx, &event_id, false) {
                        schedule_extra_grace(state, tx, &event_id);
                    }
                } else {
                    flush_finishing(&mut st, tx, &event_id, true);
                }
            }
        }
        "Network.loadingFailed" => {
            let mut st = state.lock().unwrap();
            if let Some(pending) = st.take_pending(&key) {
                let error = params
                    .get("errorText")
                    .and_then(Value::as_str)
                    .filter(|text| !text.is_empty())
                    .unwrap_or("Request failed")
                    .to_string();
                // A request that reached the network and failed later (aborted, reset) still went out with the
                // headers its extra info reported — which CDP may deliver slightly after `loadingFailed`.
                let wants_extra = failure_extra_expected(&pending, params);
                let event_id = pending.event_id.clone();
                st.finishing.insert(
                    event_id.clone(),
                    Finishing {
                        cdp_request_id: pending.cdp_request_id.clone(),
                        outcome: FinishingOutcome::Failed { error },
                        expects_request: wants_extra,
                        expects_response: false,
                    },
                );
                if wants_extra {
                    if !flush_finishing(&mut st, tx, &event_id, false) {
                        schedule_extra_grace(state, tx, &event_id);
                    }
                } else {
                    flush_finishing(&mut st, tx, &event_id, true);
                }
            }
        }
        "Target.attachedToTarget" => {
            if let Some(session) = params.get("sessionId").and_then(Value::as_str) {
                let session = session.to_string();
                let target = params
                    .pointer("/targetInfo/targetId")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                if let Some(target_id) = &target {
                    let mut st = state.lock().unwrap();
                    st.children.insert(target_id.clone(), session.clone());
                    // Immediately mark any matching pending Document request whose response is already known as committed.
                    let keys: Vec<(Option<String>, String)> = st
                        .pending
                        .iter()
                        .filter(|(_, p)| p.resource_type == "Document" && p.frame_id.as_deref() == Some(target_id.as_str()))
                        .map(|(k, _)| k.clone())
                        .collect();
                    let mut committed_events = Vec::new();
                    for k in keys {
                        if let Some(mut p) = st.pending.remove(&k) {
                            if st.synth_response_from_extra(&mut p)
                                && let Some(head) = p.response.clone()
                            {
                                committed_events.push(NetworkEvent::Response {
                                    id: RequestId::from(p.event_id.clone()),
                                    head,
                                    committed: true,
                                });
                            }
                            st.pending.insert(k, p);
                        }
                    }
                    drop(st);
                    for ev in committed_events {
                        let _ = tx.send(ev);
                    }
                }
                let cdp = cdp.clone();
                let domain = domain.clone();
                let state = state.clone();
                let tx = tx.clone();
                tokio::spawn(async move {
                    let _ = cdp.send("Network.enable", enable_params(), Some(&session)).await;
                    {
                        let mut guard = domain.lock().unwrap();
                        if guard.capture {
                            guard.enabled_sessions.insert(session);
                            guard.session_ready.send_modify(|n| *n += 1);
                        }
                    }
                    tokio::time::sleep(CHILD_DOCUMENT_GRACE).await;
                    if let Some(target_id) = target {
                        complete_child_documents(&state, &tx, &target_id);
                    }
                });
            }
        }
        "Target.detachedFromTarget" => {
            if let Some(session) = params.get("sessionId").and_then(Value::as_str) {
                state.lock().unwrap().children.retain(|_, child| child != session);
                domain.lock().unwrap().enabled_sessions.remove(session);
            }
        }
        _ => {}
    }
}

/// Reports a parked hop once its expected extra info is in (or, with `anyway`, with what there is).
fn flush_finishing(
    st: &mut State,
    tx: &mpsc::UnboundedSender<NetworkEvent>,
    event_id: &str,
    anyway: bool,
) -> bool {
    let Some(finishing) = st.finishing.get(event_id) else { return false };
    let complete = (!finishing.expects_request || st.request_extra.contains_key(event_id))
        && (!finishing.expects_response || st.response_extra.contains_key(event_id));
    if !anyway && !complete {
        return false;
    }
    let Some(finishing) = st.finishing.remove(event_id) else { return false };
    let request_headers = st.request_extra.remove(event_id).filter(|h| !h.is_empty());
    let cdp_request_id = finishing.cdp_request_id.clone();
    match finishing.outcome {
        FinishingOutcome::Finished { body_size } => {
            let response_headers = st.response_extra.remove(event_id).map(|e| e.headers).filter(|h| !h.is_empty());
            let _ = tx.send(NetworkEvent::Finished {
                id: RequestId::from(event_id.to_string()),
                body_size,
                request_headers,
                response_headers,
            });
        }
        FinishingOutcome::Failed { error } => {
            st.response_extra.remove(event_id);
            let _ = tx.send(NetworkEvent::Failed {
                id: RequestId::from(event_id.to_string()),
                error,
                request_headers,
            });
        }
    }
    st.finish_chain(&cdp_request_id);
    true
}

fn complete_child_documents(
    state: &Arc<Mutex<State>>,
    tx: &mpsc::UnboundedSender<NetworkEvent>,
    target_id: &str,
) {
    let mut events_to_send = Vec::new();
    {
        let mut st = state.lock().unwrap();
        let keys: Vec<(Option<String>, String)> = st
            .pending
            .iter()
            .filter(|(_, p)| p.resource_type == "Document" && p.frame_id.as_deref() == Some(target_id))
            .map(|(k, _)| k.clone())
            .collect();
        for key in keys {
            let Some(mut pending) = st.pending.remove(&key) else { continue };
            if st.synth_response_from_extra(&mut pending) {
                let req_extra = st.request_extra.remove(&pending.event_id).filter(|h| !h.is_empty());
                let resp_extra = st
                    .response_extra
                    .remove(&pending.event_id)
                    .map(|e| e.headers)
                    .filter(|h| !h.is_empty());
                let cdp_request_id = pending.cdp_request_id.clone();
                let id = RequestId::from(pending.event_id);
                if let Some(head) = pending.response {
                    events_to_send.push(NetworkEvent::Response { id: id.clone(), head, committed: true });
                }
                events_to_send.push(NetworkEvent::Finished {
                    id,
                    body_size: pending.data_length,
                    request_headers: req_extra,
                    response_headers: resp_extra,
                });
                st.finish_chain(&cdp_request_id);
            } else {
                st.pending.insert(key, pending);
            }
        }
    }
    for ev in events_to_send {
        let _ = tx.send(ev);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(method: &str, params: Value) -> CdpEvent {
        CdpEvent { method: method.into(), params, session_id: None }
    }

    type Headers = Option<Vec<(String, String)>>;

    /// A CDP connection these tests drive only through `handle_event`.
    fn silent_cdp() -> Arc<dyn Cdp> {
        struct Silent;
        #[async_trait::async_trait]
        impl Cdp for Silent {
            async fn send(&self, _: &str, _: Value, _: Option<&str>) -> Result<Value, crate::CdpError> {
                Ok(json!({}))
            }
            fn events(&self) -> tokio::sync::broadcast::Receiver<CdpEvent> {
                tokio::sync::broadcast::channel(1).1
            }
        }
        Arc::new(Silent)
    }

    async fn endings(rx: &mut mpsc::UnboundedReceiver<NetworkEvent>, count: usize) -> Vec<NetworkEvent> {
        let mut events = Vec::new();
        let mut seen = 0;
        while seen < count {
            let Ok(Some(event)) = tokio::time::timeout(Duration::from_secs(1), rx.recv()).await else { break };
            if matches!(event, NetworkEvent::Finished { .. } | NetworkEvent::Failed { .. }) {
                seen += 1;
            }
            events.push(event);
        }
        events
    }

    fn finished(events: &[NetworkEvent], id: &str) -> Option<(Headers, Headers)> {
        events.iter().find_map(|event| match event {
            NetworkEvent::Finished { id: found, request_headers, response_headers, .. } if found.as_str() == id => {
                Some((request_headers.clone(), response_headers.clone()))
            }
            _ => None,
        })
    }

    fn response(events: &[NetworkEvent], id: &str) -> Option<ResponseHead> {
        events.iter().find_map(|event| match event {
            NetworkEvent::Response { id: found, head, .. } if found.as_str() == id => Some(head.clone()),
            _ => None,
        })
    }

    fn sorted(headers: Headers) -> Headers {
        headers.map(|mut headers| {
            headers.sort();
            headers
        })
    }

    /// CDP may send a request's extra info (the headers as sent, cookies included) after its `loadingFinished`.
    #[tokio::test]
    async fn late_extra_info_still_reaches_the_finished_request() {
        let cdp = silent_cdp();
        let domain = Arc::new(Mutex::new(NetworkDomain::default()));
        let state = Arc::new(Mutex::new(State::default()));
        let bodies = Arc::new(Mutex::new(NetworkBodyMap::default()));
        let (tx, mut rx) = mpsc::unbounded_channel();
        let send = |e: CdpEvent| handle_event(&cdp, &domain, &state, &bodies, &tx, e);
        send(event("Network.requestWillBeSent", json!({ "requestId": "1", "type": "Fetch", "request": { "url": "http://a/x", "method": "GET", "headers": {} } })));
        send(event("Network.responseReceived", json!({ "requestId": "1", "hasExtraInfo": true, "response": { "status": 200, "headers": {} } })));
        send(event("Network.loadingFinished", json!({ "requestId": "1" })));
        send(event("Network.requestWillBeSentExtraInfo", json!({ "requestId": "1", "headers": { "Cookie": "sid=1" } })));
        send(event("Network.responseReceivedExtraInfo", json!({ "requestId": "1", "statusCode": 200, "headers": { "Set-Cookie": "a=1" } })));
        let mut finished = None;
        while let Ok(Some(event)) = tokio::time::timeout(std::time::Duration::from_secs(1), rx.recv()).await {
            if let NetworkEvent::Finished { request_headers, response_headers, .. } = event {
                finished = Some((request_headers, response_headers));
                break;
            }
        }
        let (request_headers, response_headers) = finished.expect("a finished event");
        assert_eq!(request_headers, Some(vec![("Cookie".to_string(), "sid=1".to_string())]));
        assert_eq!(response_headers, Some(vec![("Set-Cookie".to_string(), "a=1".to_string())]));
    }

    /// Redirect hops share one CDP `requestId`. Delayed extra info from the 302 hop must attach to the 302 hop
    /// and never bleed onto the redirected destination.
    #[tokio::test]
    async fn redirect_extra_info_stays_on_its_own_hop() {
        let cdp = silent_cdp();
        let domain = Arc::new(Mutex::new(NetworkDomain::default()));
        let state = Arc::new(Mutex::new(State::default()));
        let bodies = Arc::new(Mutex::new(NetworkBodyMap::default()));
        let (tx, mut rx) = mpsc::unbounded_channel();
        let send = |e: CdpEvent| handle_event(&cdp, &domain, &state, &bodies, &tx, e);

        send(event("Network.requestWillBeSent", json!({
            "requestId": "R", "type": "Fetch",
            "request": { "url": "http://a/api/hop", "method": "GET", "headers": {} }
        })));
        // Redirect arrives before the 302 hop's extra info.
        send(event("Network.requestWillBeSent", json!({
            "requestId": "R", "type": "Fetch",
            "redirectHasExtraInfo": true,
            "redirectResponse": { "status": 302, "statusText": "Found", "headers": { "location": "/api/landed", "content-type": "text/plain" }, "mimeType": "text/plain" },
            "request": { "url": "http://a/api/landed", "method": "GET", "headers": {} }
        })));
        send(event("Network.responseReceived", json!({
            "requestId": "R", "hasExtraInfo": true,
            "response": { "status": 200, "statusText": "OK", "headers": { "content-type": "application/json" }, "mimeType": "application/json" }
        })));
        send(event("Network.loadingFinished", json!({ "requestId": "R" })));

        // Extra info for hop 0 (302) arrives now, followed by hop 1 (200).
        send(event("Network.requestWillBeSentExtraInfo", json!({ "requestId": "R", "headers": { "cookie": "sid=hop" } })));
        send(event("Network.responseReceivedExtraInfo", json!({ "requestId": "R", "statusCode": 302, "headers": { "location": "/api/landed", "content-type": "text/plain" } })));
        send(event("Network.requestWillBeSentExtraInfo", json!({ "requestId": "R", "headers": { "cookie": "sid=landed" } })));
        send(event("Network.responseReceivedExtraInfo", json!({ "requestId": "R", "statusCode": 200, "headers": { "content-type": "application/json" } })));

        let mut finished = Vec::new();
        while finished.len() < 2 {
            let ev = tokio::time::timeout(Duration::from_secs(1), rx.recv()).await.unwrap().unwrap();
            if let NetworkEvent::Finished { id, request_headers, response_headers, .. } = ev {
                finished.push((id.as_str().to_string(), request_headers, response_headers));
            }
        }
        assert_eq!(finished[0].0, "R");
        assert_eq!(finished[0].1, Some(vec![("cookie".to_string(), "sid=hop".to_string())]));
        assert!(finished[0].2.as_ref().unwrap().iter().any(|(k, v)| k == "location" && v == "/api/landed"));

        assert_eq!(finished[1].0, "R#redirect-1");
        assert_eq!(finished[1].1, Some(vec![("cookie".to_string(), "sid=landed".to_string())]));
        assert_eq!(finished[1].2, Some(vec![("content-type".to_string(), "application/json".to_string())]));

        // Body lookup for the redirected hop maps back to the real CDP requestId.
        let (cdp_id, _) = bodies.lock().unwrap().lookup("R#redirect-1", BodyKind::Response);
        assert_eq!(cdp_id, "R");
    }

    /// CDP may send `requestWillBeSentExtraInfo` slightly after `loadingFailed` for an aborted request.
    #[tokio::test]
    async fn late_extra_info_still_reaches_the_failed_request() {
        let cdp = silent_cdp();
        let domain = Arc::new(Mutex::new(NetworkDomain::default()));
        let state = Arc::new(Mutex::new(State::default()));
        let bodies = Arc::new(Mutex::new(NetworkBodyMap::default()));
        let (tx, mut rx) = mpsc::unbounded_channel();
        let send = |e: CdpEvent| handle_event(&cdp, &domain, &state, &bodies, &tx, e);

        send(event("Network.requestWillBeSent", json!({
            "requestId": "9", "type": "Fetch",
            "request": { "url": "http://a/api/slow", "method": "GET", "headers": {} }
        })));
        send(event("Network.loadingFailed", json!({ "requestId": "9", "errorText": "net::ERR_ABORTED", "canceled": true })));
        send(event("Network.requestWillBeSentExtraInfo", json!({ "requestId": "9", "headers": { "cookie": "sid=1" } })));

        let mut failed = None;
        while let Ok(Some(ev)) = tokio::time::timeout(Duration::from_secs(1), rx.recv()).await {
            if let NetworkEvent::Failed { error, request_headers, .. } = ev {
                failed = Some((error, request_headers));
                break;
            }
        }
        let (error, request_headers) = failed.expect("a failed event");
        assert_eq!(error, "net::ERR_ABORTED");
        assert_eq!(request_headers, Some(vec![("cookie".to_string(), "sid=1".to_string())]));
    }

    /// Hops without extra info (a cached redirect) must not consume a slot, and late extra info for an earlier hop
    /// must stay there instead of shifting onto a later one.
    #[tokio::test]
    async fn hops_without_extra_info_do_not_shift_late_extra_info() {
        let cdp = silent_cdp();
        let domain = Arc::new(Mutex::new(NetworkDomain::default()));
        let state = Arc::new(Mutex::new(State::default()));
        let bodies = Arc::new(Mutex::new(NetworkBodyMap::default()));
        let (tx, mut rx) = mpsc::unbounded_channel();
        let send = |e: CdpEvent| handle_event(&cdp, &domain, &state, &bodies, &tx, e);

        send(event("Network.requestWillBeSent", json!({
            "requestId": "R", "type": "Fetch",
            "request": { "url": "http://a/hop0", "method": "GET", "headers": {} }
        })));
        send(event("Network.requestWillBeSentExtraInfo", json!({ "requestId": "R", "headers": { "Cookie": "sid=hop0" } })));
        // hop0 -> hop1 over the network; hop0's response extra is late.
        send(event("Network.requestWillBeSent", json!({
            "requestId": "R", "type": "Fetch",
            "redirectHasExtraInfo": true,
            "redirectResponse": { "status": 302, "statusText": "Found", "headers": { "Location": "/hop1", "Content-Type": "text/plain" } },
            "request": { "url": "http://a/hop1", "method": "GET", "headers": {} }
        })));
        // hop1 -> hop2 from cache: no extra info for hop1.
        send(event("Network.requestWillBeSent", json!({
            "requestId": "R", "type": "Fetch",
            "redirectHasExtraInfo": false,
            "redirectResponse": { "status": 301, "statusText": "Moved Permanently", "headers": { "Location": "/hop2" } },
            "request": { "url": "http://a/hop2", "method": "GET", "headers": {} }
        })));
        // hop2 -> hop3 over the network.
        send(event("Network.requestWillBeSent", json!({
            "requestId": "R", "type": "Fetch",
            "redirectHasExtraInfo": true,
            "redirectResponse": { "status": 307, "statusText": "Temporary Redirect", "headers": { "Location": "/hop3", "Content-Type": "text/plain" } },
            "request": { "url": "http://a/hop3", "method": "GET", "headers": {} }
        })));
        send(event("Network.responseReceivedExtraInfo", json!({
            "requestId": "R", "statusCode": 302,
            "headers": { "Location": "/hop1", "Content-Type": "text/plain" }
        })));
        send(event("Network.requestWillBeSentExtraInfo", json!({ "requestId": "R", "headers": { "Cookie": "sid=hop2" } })));
        send(event("Network.responseReceivedExtraInfo", json!({
            "requestId": "R", "statusCode": 307,
            "headers": { "Location": "/hop3", "Content-Type": "text/plain" }
        })));
        send(event("Network.responseReceived", json!({
            "requestId": "R", "hasExtraInfo": true,
            "response": { "status": 200, "statusText": "OK", "headers": { "Content-Type": "application/json" } }
        })));
        send(event("Network.requestWillBeSentExtraInfo", json!({ "requestId": "R", "headers": { "Cookie": "sid=hop3" } })));
        send(event("Network.responseReceivedExtraInfo", json!({
            "requestId": "R", "statusCode": 200, "headers": { "Content-Type": "application/json" }
        })));
        send(event("Network.loadingFinished", json!({ "requestId": "R" })));

        let events = endings(&mut rx, 4).await;
        assert_eq!(response(&events, "R#redirect-2").map(|head| head.status), Some(307));
        assert_eq!(response(&events, "R#redirect-3").map(|head| head.status), Some(200));
        let (request_headers, response_headers) = finished(&events, "R").expect("hop0");
        assert_eq!(sorted(request_headers), Some(vec![("Cookie".to_string(), "sid=hop0".to_string())]));
        assert!(sorted(response_headers).unwrap().contains(&("Location".to_string(), "/hop1".to_string())));
        let (request_headers, response_headers) = finished(&events, "R#redirect-2").expect("hop2");
        assert_eq!(sorted(request_headers), Some(vec![("Cookie".to_string(), "sid=hop2".to_string())]));
        assert!(sorted(response_headers).unwrap().contains(&("Location".to_string(), "/hop3".to_string())));
        let (request_headers, response_headers) = finished(&events, "R#redirect-3").expect("hop3");
        assert_eq!(sorted(request_headers), Some(vec![("Cookie".to_string(), "sid=hop3".to_string())]));
        assert_eq!(
            sorted(response_headers),
            Some(vec![("Content-Type".to_string(), "application/json".to_string())])
        );
    }

    /// The usual order: a redirect hop's extra info is already in when the redirect arrives, and the next hop's request
    /// extra arrives before its own `requestWillBeSent`. Registering the new hop must not lose it.
    #[tokio::test]
    async fn usual_order_keeps_the_next_hops_early_request_extra() {
        let cdp = silent_cdp();
        let domain = Arc::new(Mutex::new(NetworkDomain::default()));
        let state = Arc::new(Mutex::new(State::default()));
        let bodies = Arc::new(Mutex::new(NetworkBodyMap::default()));
        let (tx, mut rx) = mpsc::unbounded_channel();
        let send = |e: CdpEvent| handle_event(&cdp, &domain, &state, &bodies, &tx, e);

        send(event("Network.requestWillBeSent", json!({
            "requestId": "R", "type": "Fetch",
            "request": { "url": "http://a/hop", "method": "GET", "headers": {} }
        })));
        send(event("Network.requestWillBeSentExtraInfo", json!({ "requestId": "R", "headers": { "Cookie": "sid=hop" } })));
        send(event("Network.responseReceivedExtraInfo", json!({
            "requestId": "R", "statusCode": 302,
            "headers": { "Location": "/landed", "Content-Type": "text/plain" }
        })));
        // The landed request's extra info beats the redirect event that announces it.
        send(event("Network.requestWillBeSentExtraInfo", json!({ "requestId": "R", "headers": { "Cookie": "sid=landed" } })));
        send(event("Network.requestWillBeSent", json!({
            "requestId": "R", "type": "Fetch",
            "redirectHasExtraInfo": true,
            "redirectResponse": { "status": 302, "statusText": "Found", "headers": { "Location": "/landed", "Content-Type": "text/plain" } },
            "request": { "url": "http://a/landed", "method": "GET", "headers": {} }
        })));
        send(event("Network.responseReceived", json!({
            "requestId": "R", "hasExtraInfo": true,
            "response": { "status": 200, "statusText": "OK", "headers": { "Content-Type": "application/json" } }
        })));
        send(event("Network.responseReceivedExtraInfo", json!({
            "requestId": "R", "statusCode": 200, "headers": { "Content-Type": "application/json" }
        })));
        send(event("Network.loadingFinished", json!({ "requestId": "R" })));

        let events = endings(&mut rx, 2).await;
        let (request_headers, response_headers) = finished(&events, "R").expect("the redirect hop");
        assert_eq!(sorted(request_headers), Some(vec![("Cookie".to_string(), "sid=hop".to_string())]));
        assert!(sorted(response_headers).unwrap().contains(&("Location".to_string(), "/landed".to_string())));
        let (request_headers, response_headers) = finished(&events, "R#redirect-1").expect("the landed request");
        assert_eq!(sorted(request_headers), Some(vec![("Cookie".to_string(), "sid=landed".to_string())]));
        assert_eq!(
            sorted(response_headers),
            Some(vec![("Content-Type".to_string(), "application/json".to_string())])
        );
    }

    /// CDP doesn't guarantee `requestWillBeSent` comes before its `requestWillBeSentExtraInfo`.
    #[tokio::test]
    async fn early_request_extra_info_reaches_the_request() {
        let cdp = silent_cdp();
        let domain = Arc::new(Mutex::new(NetworkDomain::default()));
        let state = Arc::new(Mutex::new(State::default()));
        let bodies = Arc::new(Mutex::new(NetworkBodyMap::default()));
        let (tx, mut rx) = mpsc::unbounded_channel();
        let send = |e: CdpEvent| handle_event(&cdp, &domain, &state, &bodies, &tx, e);

        send(event("Network.requestWillBeSentExtraInfo", json!({ "requestId": "1", "headers": { "Cookie": "sid=1" } })));
        send(event("Network.requestWillBeSent", json!({
            "requestId": "1", "type": "Fetch",
            "request": { "url": "http://a/x", "method": "GET", "headers": {} }
        })));
        send(event("Network.responseReceived", json!({
            "requestId": "1", "hasExtraInfo": true,
            "response": { "status": 200, "statusText": "OK", "headers": { "Content-Type": "application/json" } }
        })));
        send(event("Network.responseReceivedExtraInfo", json!({ "requestId": "1", "statusCode": 200, "headers": {} })));
        send(event("Network.loadingFinished", json!({ "requestId": "1" })));

        let events = endings(&mut rx, 1).await;
        let (request_headers, _) = finished(&events, "1").expect("the finished request");
        assert_eq!(sorted(request_headers), Some(vec![("Cookie".to_string(), "sid=1".to_string())]));
    }

    /// A failure that never reached the network has no extra info to wait for; waiting only delays the real error and
    /// leaves it un-reported if the capture stops first.
    #[tokio::test]
    async fn failure_that_never_reached_the_network_does_not_wait() {
        let cdp = silent_cdp();
        let domain = Arc::new(Mutex::new(NetworkDomain::default()));
        let state = Arc::new(Mutex::new(State::default()));
        let bodies = Arc::new(Mutex::new(NetworkBodyMap::default()));
        let (tx, mut rx) = mpsc::unbounded_channel();
        let send = |e: CdpEvent| handle_event(&cdp, &domain, &state, &bodies, &tx, e);

        send(event("Network.requestWillBeSent", json!({
            "requestId": "1", "type": "Fetch",
            "request": { "url": "http://a/missing", "method": "GET", "headers": {} }
        })));
        send(event("Network.loadingFailed", json!({
            "requestId": "1", "errorText": "net::ERR_NAME_NOT_RESOLVED"
        })));
        let (error, request_headers) = tokio::time::timeout(Duration::from_millis(150), async {
            loop {
                match rx.recv().await {
                    Some(NetworkEvent::Failed { error, request_headers, .. }) => break (error, request_headers),
                    Some(_) => continue,
                    None => panic!("the event channel closed"),
                }
            }
        })
        .await
        .expect("the failure was reported without waiting for extra info");
        assert_eq!(error, "net::ERR_NAME_NOT_RESOLVED");
        assert_eq!(request_headers, None);
    }

    /// A request extra for the next hop can arrive before its `requestWillBeSent`, when the hop before it is still
    /// unknown. If that hop turns out to be cached, the extra must move on rather than stay on the cached hop.
    #[tokio::test]
    async fn cached_redirect_moves_an_early_request_extra() {
        let cdp = silent_cdp();
        let domain = Arc::new(Mutex::new(NetworkDomain::default()));
        let state = Arc::new(Mutex::new(State::default()));
        let bodies = Arc::new(Mutex::new(NetworkBodyMap::default()));
        let (tx, mut rx) = mpsc::unbounded_channel();
        let send = |e: CdpEvent| handle_event(&cdp, &domain, &state, &bodies, &tx, e);

        send(event("Network.requestWillBeSent", json!({
            "requestId": "R", "type": "Fetch",
            "request": { "url": "http://a/hop0", "method": "GET", "headers": {} }
        })));
        send(event("Network.requestWillBeSentExtraInfo", json!({ "requestId": "R", "headers": { "Cookie": "sid=hop0" } })));
        send(event("Network.responseReceivedExtraInfo", json!({
            "requestId": "R", "statusCode": 302,
            "headers": { "Location": "/hop1", "Content-Type": "text/plain" }
        })));
        // hop0 -> hop1 over the network, and its extras are already in, so hop0 flushes immediately.
        send(event("Network.requestWillBeSent", json!({
            "requestId": "R", "type": "Fetch",
            "redirectHasExtraInfo": true,
            "redirectResponse": { "status": 302, "statusText": "Found", "headers": { "Location": "/hop1", "Content-Type": "text/plain" } },
            "request": { "url": "http://a/hop1", "method": "GET", "headers": {} }
        })));
        // hop2's request extra beats the redirect that announces hop2, while hop1's extra info is still unknown.
        send(event("Network.requestWillBeSentExtraInfo", json!({ "requestId": "R", "headers": { "Cookie": "sid=hop2" } })));
        // hop1 -> hop2 from cache: hop1 sent no extra info, and hop2 is now registered.
        send(event("Network.requestWillBeSent", json!({
            "requestId": "R", "type": "Fetch",
            "redirectHasExtraInfo": false,
            "redirectResponse": { "status": 301, "statusText": "Moved Permanently", "headers": { "Location": "/hop2" } },
            "request": { "url": "http://a/hop2", "method": "GET", "headers": {} }
        })));
        send(event("Network.responseReceived", json!({
            "requestId": "R", "hasExtraInfo": true,
            "response": { "status": 200, "statusText": "OK", "headers": { "Content-Type": "application/json" } }
        })));
        send(event("Network.responseReceivedExtraInfo", json!({
            "requestId": "R", "statusCode": 200, "headers": { "Content-Type": "application/json" }
        })));
        send(event("Network.loadingFinished", json!({ "requestId": "R" })));

        let events = endings(&mut rx, 3).await;
        let (request_headers, _) = finished(&events, "R#redirect-1").expect("the cached hop");
        assert_eq!(request_headers, None);
        let (request_headers, response_headers) = finished(&events, "R#redirect-2").expect("the network hop");
        assert_eq!(sorted(request_headers), Some(vec![("Cookie".to_string(), "sid=hop2".to_string())]));
        assert_eq!(
            sorted(response_headers),
            Some(vec![("Content-Type".to_string(), "application/json".to_string())])
        );
    }

    /// A cached hop can receive the next hop's response extra before the redirect that announces it; it must move on.
    #[tokio::test]
    async fn cached_redirect_moves_an_early_response_extra() {
        let cdp = silent_cdp();
        let domain = Arc::new(Mutex::new(NetworkDomain::default()));
        let state = Arc::new(Mutex::new(State::default()));
        let bodies = Arc::new(Mutex::new(NetworkBodyMap::default()));
        let (tx, mut rx) = mpsc::unbounded_channel();
        let send = |e: CdpEvent| handle_event(&cdp, &domain, &state, &bodies, &tx, e);

        send(event("Network.requestWillBeSent", json!({
            "requestId": "R", "type": "Fetch",
            "request": { "url": "http://a/hop0", "method": "GET", "headers": {} }
        })));
        // hop1's response extra arrives before the redirect event that announces hop1.
        send(event("Network.responseReceivedExtraInfo", json!({
            "requestId": "R", "statusCode": 200, "headers": { "Content-Type": "application/json" }
        })));
        // hop0 -> hop1 from cache: hop0 sent no extra info, and hop1 is now registered.
        send(event("Network.requestWillBeSent", json!({
            "requestId": "R", "type": "Fetch",
            "redirectHasExtraInfo": false,
            "redirectResponse": { "status": 301, "statusText": "Moved Permanently", "headers": { "Location": "/hop1" } },
            "request": { "url": "http://a/hop1", "method": "GET", "headers": {} }
        })));
        send(event("Network.requestWillBeSentExtraInfo", json!({ "requestId": "R", "headers": { "Cookie": "sid=hop1" } })));
        send(event("Network.responseReceived", json!({
            "requestId": "R", "hasExtraInfo": true,
            "response": { "status": 200, "statusText": "OK", "headers": { "Content-Type": "application/json" } }
        })));
        send(event("Network.loadingFinished", json!({ "requestId": "R" })));

        let events = endings(&mut rx, 2).await;
        let (_, response_headers) = finished(&events, "R").expect("the cached hop");
        assert_eq!(response_headers, None);
        let (request_headers, response_headers) = finished(&events, "R#redirect-1").expect("the network hop");
        assert_eq!(sorted(request_headers), Some(vec![("Cookie".to_string(), "sid=hop1".to_string())]));
        assert_eq!(
            sorted(response_headers),
            Some(vec![("Content-Type".to_string(), "application/json".to_string())])
        );
    }

    /// A response extra can arrive before any `requestWillBeSent`; it still belongs to that request.
    #[tokio::test]
    async fn early_response_extra_reaches_the_request() {
        let cdp = silent_cdp();
        let domain = Arc::new(Mutex::new(NetworkDomain::default()));
        let state = Arc::new(Mutex::new(State::default()));
        let bodies = Arc::new(Mutex::new(NetworkBodyMap::default()));
        let (tx, mut rx) = mpsc::unbounded_channel();
        let send = |e: CdpEvent| handle_event(&cdp, &domain, &state, &bodies, &tx, e);

        send(event("Network.responseReceivedExtraInfo", json!({
            "requestId": "R", "statusCode": 200, "headers": { "X-Extra": "kept" }
        })));
        send(event("Network.requestWillBeSent", json!({
            "requestId": "R", "type": "Fetch",
            "request": { "url": "http://a/x", "method": "GET", "headers": {} }
        })));
        send(event("Network.requestWillBeSentExtraInfo", json!({ "requestId": "R", "headers": { "Cookie": "sid=1" } })));
        send(event("Network.responseReceived", json!({
            "requestId": "R", "hasExtraInfo": true,
            "response": { "status": 200, "statusText": "OK", "headers": { "Content-Type": "application/json" } }
        })));
        send(event("Network.loadingFinished", json!({ "requestId": "R" })));

        let events = endings(&mut rx, 1).await;
        let (_, response_headers) = finished(&events, "R").expect("the finished request");
        assert_eq!(sorted(response_headers), Some(vec![("X-Extra".to_string(), "kept".to_string())]));
    }

    #[test]
    fn repeated_headers_are_split_again() {
        let mut headers = headers_from(Some(&json!({
            "Set-Cookie": "sid=1; Path=/\ntheme=dark; Path=/",
            "Content-Type": "application/json",
        })));
        headers.sort();
        assert_eq!(
            headers,
            vec![
                ("Content-Type".to_string(), "application/json".to_string()),
                ("Set-Cookie".to_string(), "sid=1; Path=/".to_string()),
                ("Set-Cookie".to_string(), "theme=dark; Path=/".to_string()),
            ]
        );
    }
}