//! Opt-in capture of a page's own console messages and uncaught errors (port of cli/src/execute/console.ts).
//! It needs the Runtime domain, which a page can detect, so it stays off until an agent starts it.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex as SyncMutex};

use async_trait::async_trait;
use browse_core::{Cdp, CdpEvent, TabId, Tool, ToolContext, ToolOutput, ToolSpec};
use serde::Serialize;
use serde_json::{Value, json};
use tokio::sync::broadcast;

use crate::state::TaskGuard;
use crate::{arg_action, arg_bool, arg_int, arg_str, bail_user, json_output, respond, state, tab_schema, target_tab};

const MAX_ENTRIES: usize = 1_000;
const MAX_TEXT: usize = 4_000;

#[derive(Default)]
pub(crate) struct ConsoleState {
    active: Option<Active>,
}

struct Active {
    tab: TabId,
    cdp: Arc<dyn Cdp>,
    buffer: Arc<SyncMutex<Buffer>>,
    tracker: Arc<SyncMutex<Tracker>>,
    _task: TaskGuard,
}

#[derive(Default)]
struct Buffer {
    entries: VecDeque<Entry>,
    dropped: u64,
    next: u64,
    /// Why the capture ended on its own (its tab went away).
    ended: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    seq: u64,
    time: String,
    /// console method (log, info, warning, error, debug, table, ...), "pageerror" for uncaught exceptions, or the
    /// level (error, warning, info) of a browser log entry.
    #[serde(rename = "type")]
    kind: String,
    text: String,
    /// Browser log entries: what reported it (network, security, javascript, deprecation, intervention, ...).
    #[serde(skip_serializing_if = "Option::is_none")]
    source: Option<String>,
    /// Set for messages from an out-of-process iframe or a worker: its target type.
    #[serde(skip_serializing_if = "Option::is_none")]
    target: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    line: Option<i64>,
}

/// Execution contexts and child targets seen on the tab's CDP connection.
#[derive(Default)]
struct Tracker {
    /// Contexts that aren't a frame's main world (browse's and extensions' isolated worlds), by session.
    isolated: HashSet<(Option<String>, i64)>,
    /// Child sessions (out-of-process iframes, workers) and their target type.
    children: HashMap<String, String>,
}

impl Tracker {
    /// Records what `event` says about contexts and children; returns a newly attached child session.
    fn observe(&mut self, event: &CdpEvent) -> Option<String> {
        let params = &event.params;
        match event.method.as_str() {
            "Runtime.executionContextCreated" => {
                let context = params.get("context")?;
                let id = context.get("id").and_then(Value::as_i64)?;
                if context.pointer("/auxData/isDefault") == Some(&Value::Bool(false)) {
                    self.isolated.insert((event.session_id.clone(), id));
                }
            }
            "Runtime.executionContextDestroyed" => {
                let id = params.get("executionContextId").and_then(Value::as_i64)?;
                self.isolated.remove(&(event.session_id.clone(), id));
            }
            "Runtime.executionContextsCleared" => self.isolated.retain(|(session, _)| *session != event.session_id),
            "Target.attachedToTarget" => {
                let session = params.get("sessionId").and_then(Value::as_str)?.to_string();
                let kind = params.pointer("/targetInfo/type").and_then(Value::as_str).unwrap_or("").to_string();
                if !matches!(kind.as_str(), "iframe" | "worker" | "shared_worker" | "service_worker") {
                    return None;
                }
                return self.children.insert(session.clone(), kind).is_none().then_some(session);
            }
            "Target.detachedFromTarget" => {
                let session = params.get("sessionId").and_then(Value::as_str)?.to_string();
                self.children.remove(&session);
                self.isolated.retain(|(other, _)| other.as_deref() != Some(session.as_str()));
            }
            _ => {}
        }
        None
    }

    fn isolated(&self, event: &CdpEvent) -> bool {
        let context = match event.method.as_str() {
            "Runtime.consoleAPICalled" => event.params.get("executionContextId"),
            "Runtime.exceptionThrown" => event.params.pointer("/exceptionDetails/executionContextId"),
            _ => None,
        };
        context.and_then(Value::as_i64).is_some_and(|id| self.isolated.contains(&(event.session_id.clone(), id)))
    }
}

fn describe(arg: &Value) -> String {
    if let Some(value) = arg.get("value") {
        return match value {
            Value::String(text) => text.clone(),
            other => other.to_string(),
        };
    }
    for key in ["unserializableValue", "description", "type"] {
        if let Some(text) = arg.get(key).and_then(Value::as_str) {
            return text.to_string();
        }
    }
    String::new()
}

fn truncate(mut text: String) -> String {
    if text.len() > MAX_TEXT {
        let mut cut = MAX_TEXT;
        while !text.is_char_boundary(cut) {
            cut -= 1;
        }
        text.truncate(cut);
        text.push('…');
    }
    text
}

struct Message {
    kind: String,
    text: String,
    source: Option<String>,
    url: Option<String>,
    line: Option<i64>,
}

fn message_for(method: &str, params: &Value) -> Option<Message> {
    let url_of = |value: Option<&Value>| value.and_then(Value::as_str).filter(|u| !u.is_empty()).map(str::to_string);
    match method {
        "Runtime.consoleAPICalled" => {
            let kind = params.get("type").and_then(Value::as_str).unwrap_or("log").to_string();
            let text = params
                .get("args")
                .and_then(Value::as_array)
                .map(|args| args.iter().map(describe).collect::<Vec<_>>().join(" "))
                .unwrap_or_default();
            let frame = params.pointer("/stackTrace/callFrames/0");
            let url = url_of(frame.and_then(|f| f.get("url")));
            let line = frame.and_then(|f| f.get("lineNumber")).and_then(Value::as_i64).map(|n| n + 1);
            Some(Message { kind, text, source: None, url, line })
        }
        "Runtime.exceptionThrown" => {
            let details = params.get("exceptionDetails")?;
            let text = details
                .pointer("/exception/description")
                .and_then(Value::as_str)
                .or_else(|| details.get("text").and_then(Value::as_str))
                .unwrap_or("Uncaught error")
                .to_string();
            let url = url_of(details.get("url"));
            let line = details.get("lineNumber").and_then(Value::as_i64).map(|n| n + 1);
            Some(Message { kind: "pageerror".into(), text, source: None, url, line })
        }
        // Browser-reported problems the page's own console calls don't cover: CSP violations, failed resource loads,
        // deprecations, interventions. Verbose entries ([Violation] timing notes) are noise.
        "Log.entryAdded" => {
            let entry = params.get("entry")?;
            let level = entry.get("level").and_then(Value::as_str).unwrap_or("info");
            if level == "verbose" {
                return None;
            }
            Some(Message {
                kind: level.to_string(),
                text: entry.get("text").and_then(Value::as_str).unwrap_or("").to_string(),
                source: entry.get("source").and_then(Value::as_str).map(str::to_string),
                url: url_of(entry.get("url")),
                line: entry.get("lineNumber").and_then(Value::as_i64).map(|n| n + 1),
            })
        }
        _ => None,
    }
}

async fn enable(cdp: &dyn Cdp, session: Option<&str>) -> anyhow::Result<()> {
    cdp.send("Runtime.enable", json!({}), session).await?;
    let _ = cdp.send("Log.enable", json!({}), session).await;
    Ok(())
}

/// Takes what's already queued: contexts and children are recorded, messages (replays of what was logged before the
/// capture) are dropped. Returns newly announced children.
fn drain_replays(events: &mut broadcast::Receiver<CdpEvent>, tracker: &mut Tracker) -> Vec<String> {
    let mut children = Vec::new();
    loop {
        match events.try_recv() {
            Ok(event) => children.extend(tracker.observe(&event)),
            Err(broadcast::error::TryRecvError::Lagged(_)) => {}
            Err(_) => return children,
        }
    }
}

fn tab_gone_reason(event: &CdpEvent) -> Option<String> {
    if event.session_id.is_some() {
        return None;
    }
    match event.method.as_str() {
        "Inspector.detached" => {
            Some(format!("its tab went away ({})", event.params.get("reason").and_then(Value::as_str).unwrap_or("detached")))
        }
        "Inspector.targetCrashed" | "Target.targetCrashed" => Some("its tab crashed".into()),
        _ => None,
    }
}

async fn start(ctx: &ToolContext, args: &Value) -> anyhow::Result<ToolOutput> {
    let tab = target_tab(ctx, args).await?;
    let capture = state::get(ctx).await;
    let mut console = capture.console.lock().await;
    if let Some(active) = &console.active {
        let ended = active.buffer.lock().unwrap().ended.is_some();
        if !ended {
            if active.tab == tab {
                return json_output(&json!({ "capturing": true, "tab": tab }));
            }
            bail_user!("console capture is already running on tab {}; stop it first", active.tab);
        }
        console.active = None;
    }
    let cdp = ctx.browser.cdp(&ctx.session, tab).await?;
    let mut events = cdp.events();
    let mut tracker = Tracker::default();
    enable(cdp.as_ref(), None).await?;
    // Out-of-process iframes and workers already there are announced again, so they are captured too.
    let _ = cdp
        .send("Target.setAutoAttach", json!({ "autoAttach": true, "waitForDebuggerOnStart": false, "flatten": true }), None)
        .await;
    // Enabling Runtime replays what the page logged earlier; only what happens from now on is new.
    let mut children = drain_replays(&mut events, &mut tracker);
    while let Some(child) = children.pop() {
        let _ = enable(cdp.as_ref(), Some(&child)).await;
        children.extend(drain_replays(&mut events, &mut tracker));
    }
    let buffer = Arc::new(SyncMutex::new(Buffer::default()));
    let tracker = Arc::new(SyncMutex::new(tracker));
    let (sink, task_tracker, task_cdp) = (buffer.clone(), tracker.clone(), cdp.clone());
    let task = tokio::spawn(async move {
        let reason = loop {
            let event = match events.recv().await {
                Ok(event) => event,
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break "its tab closed or browse was detached from it".to_string(),
            };
            if let Some(reason) = tab_gone_reason(&event) {
                break reason;
            }
            let (new_child, isolated, target) = {
                let mut tracker = task_tracker.lock().unwrap();
                let new_child = tracker.observe(&event);
                let target = event.session_id.as_ref().and_then(|session| tracker.children.get(session).cloned());
                (new_child, tracker.isolated(&event), target)
            };
            if let Some(child) = new_child {
                // A new child's early messages are replayed when Runtime is enabled on it, and they are all new.
                let cdp = task_cdp.clone();
                tokio::spawn(async move {
                    let _ = enable(cdp.as_ref(), Some(&child)).await;
                });
            }
            if isolated {
                continue;
            }
            let Some(message) = message_for(&event.method, &event.params) else { continue };
            let mut buffer = sink.lock().unwrap();
            buffer.next += 1;
            let seq = buffer.next;
            buffer.entries.push_back(Entry {
                seq,
                time: crate::now_iso(),
                kind: message.kind,
                text: truncate(message.text),
                source: message.source,
                target,
                url: message.url,
                line: message.line,
            });
            if buffer.entries.len() > MAX_ENTRIES {
                buffer.entries.pop_front();
                buffer.dropped += 1;
            }
        };
        sink.lock().unwrap().ended = Some(reason);
    });
    console.active = Some(Active { tab, cdp, buffer, tracker, _task: TaskGuard::new(task.abort_handle()) });
    json_output(&json!({ "capturing": true, "tab": tab }))
}

fn read(console: &ConsoleState, args: &Value) -> anyhow::Result<ToolOutput> {
    let Some(active) = &console.active else { bail_user!("console capture is not running; start it first") };
    let limit = arg_int(args, "limit", 1, MAX_ENTRIES as i64)?.unwrap_or(200) as usize;
    let errors_only = arg_bool(args, "errorsOnly")?.unwrap_or(false);
    let since = arg_int(args, "since", 0, i64::MAX)?.unwrap_or(0) as u64;
    let clear = arg_bool(args, "clear")?.unwrap_or(true);
    let filter = arg_str(args, "filter")?.map(str::to_lowercase);
    let mut buffer = active.buffer.lock().unwrap();
    let matching: Vec<&Entry> = buffer
        .entries
        .iter()
        .filter(|entry| entry.seq > since)
        .filter(|entry| !errors_only || entry.kind == "error" || entry.kind == "pageerror" || entry.kind == "assert")
        .filter(|entry| filter.as_ref().is_none_or(|needle| entry.text.to_lowercase().contains(needle)))
        .collect();
    let skipped = matching.len().saturating_sub(limit);
    let entries: Vec<Entry> = matching.into_iter().skip(skipped).cloned().collect();
    let last = buffer.next;
    let dropped = buffer.dropped;
    if clear {
        // Only what this read returned; entries left out by since, errorsOnly, filter or limit stay.
        let returned: HashSet<u64> = entries.iter().map(|entry| entry.seq).collect();
        buffer.entries.retain(|entry| !returned.contains(&entry.seq));
        buffer.dropped = 0;
    }
    let mut result = json!({ "tab": active.tab, "entries": entries, "lastSeq": last });
    if skipped > 0 {
        result["omitted"] = json!(skipped);
    }
    if dropped > 0 {
        result["droppedOldest"] = json!(dropped);
    }
    if let Some(reason) = &buffer.ended {
        result["capturing"] = json!(false);
        result["ended"] = json!(format!("console capture ended because {reason}; start it again on a tab to keep capturing"));
    }
    json_output(&result)
}

pub(crate) struct ConsoleTool;

#[async_trait]
impl Tool for ConsoleTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "console".into(),
            description: "Opt-in capture of the page's own console messages and uncaught errors for one tab per \
                session. Off by default because it enables the CDP Runtime domain, which pages (and bot checks) can \
                detect; stop it when done. Includes out-of-process iframes and workers, and browser log entries such as \
                CSP violations and failed resource loads (with a source); browse's own scripts are left out. start \
                begins capturing (earlier messages are not included); read returns buffered entries {seq, type, \
                text, source, target, url, line} oldest first and by default removes the ones it returned; stop ends \
                the capture. The buffer keeps the newest 1000 entries. If the tab closes the capture ends and read \
                says so."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "action": { "type": "string", "enum": ["start", "read", "stop"] },
                    "tab": tab_schema(),
                    "errorsOnly": { "type": "boolean", "description": "read: only console.error/assert and uncaught errors." },
                    "filter": { "type": "string", "description": "read: only entries whose text contains this (case-insensitive)." },
                    "since": { "type": "integer", "minimum": 0, "description": "read: only entries with seq greater than this (use a previous lastSeq)." },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 1000, "description": "read: newest entries to return (default 200)." },
                    "clear": { "type": "boolean", "description": "read: remove the returned entries from the buffer (default true)." }
                },
                "required": ["action"],
                "additionalProperties": false
            }),
        }
    }

    async fn call(&self, ctx: ToolContext, args: Value) -> anyhow::Result<ToolOutput> {
        respond(
            async {
                match arg_action(&args, &["start", "read", "stop"])? {
                    "start" => start(&ctx, &args).await,
                    "read" => {
                        let capture = state::get(&ctx).await;
                        let console = capture.console.lock().await;
                        read(&console, &args)
                    }
                    _ => {
                        let capture = state::get(&ctx).await;
                        let mut console = capture.console.lock().await;
                        let Some(active) = console.active.take() else {
                            return json_output(&json!({ "capturing": false }));
                        };
                        // The page no longer sees a debugger once Runtime is off.
                        let children: Vec<String> = active.tracker.lock().unwrap().children.keys().cloned().collect();
                        for session in std::iter::once(None).chain(children.iter().map(|child| Some(child.as_str()))) {
                            let _ = active.cdp.send("Runtime.disable", json!({}), session).await;
                            let _ = active.cdp.send("Log.disable", json!({}), session).await;
                        }
                        json_output(&json!({ "capturing": false, "tab": active.tab }))
                    }
                }
            }
            .await,
        )
        .await
    }
}
