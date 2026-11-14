//! Opt-in capture of a page's own console messages and uncaught errors (port of cli/src/execute/console.ts).
//! It needs the Runtime domain, which a page can detect, so it stays off until an agent starts it.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex as SyncMutex};

use async_trait::async_trait;
use browse_core::{Cdp, TabId, Tool, ToolContext, ToolOutput, ToolSpec};
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
    _task: TaskGuard,
}

#[derive(Default)]
struct Buffer {
    entries: VecDeque<Entry>,
    dropped: u64,
    next: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    seq: u64,
    time: String,
    /// console method (log, info, warning, error, debug, table, ...) or "pageerror" for uncaught exceptions.
    #[serde(rename = "type")]
    kind: String,
    text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    line: Option<i64>,
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

fn entry_for(method: &str, params: &Value) -> Option<(String, String, Option<String>, Option<i64>)> {
    match method {
        "Runtime.consoleAPICalled" => {
            let kind = params.get("type").and_then(Value::as_str).unwrap_or("log").to_string();
            let text = params
                .get("args")
                .and_then(Value::as_array)
                .map(|args| args.iter().map(describe).collect::<Vec<_>>().join(" "))
                .unwrap_or_default();
            let frame = params.pointer("/stackTrace/callFrames/0");
            let url = frame.and_then(|f| f.get("url")).and_then(Value::as_str).filter(|u| !u.is_empty()).map(str::to_string);
            let line = frame.and_then(|f| f.get("lineNumber")).and_then(Value::as_i64).map(|n| n + 1);
            Some((kind, text, url, line))
        }
        "Runtime.exceptionThrown" => {
            let details = params.get("exceptionDetails")?;
            let text = details
                .pointer("/exception/description")
                .and_then(Value::as_str)
                .or_else(|| details.get("text").and_then(Value::as_str))
                .unwrap_or("Uncaught error")
                .to_string();
            let url = details.get("url").and_then(Value::as_str).filter(|u| !u.is_empty()).map(str::to_string);
            let line = details.get("lineNumber").and_then(Value::as_i64).map(|n| n + 1);
            Some(("pageerror".into(), text, url, line))
        }
        _ => None,
    }
}

async fn start(ctx: &ToolContext, args: &Value) -> anyhow::Result<ToolOutput> {
    let tab = target_tab(ctx, args).await?;
    let capture = state::get(ctx).await;
    let mut console = capture.console.lock().await;
    if let Some(active) = &console.active {
        if active.tab == tab {
            return json_output(&json!({ "capturing": true, "tab": tab }));
        }
        bail_user!("console capture is already running on tab {}; stop it first", active.tab);
    }
    let cdp = ctx.browser.cdp(&ctx.session, tab).await?;
    let mut events = cdp.events();
    cdp.send("Runtime.enable", json!({}), None).await?;
    // Enabling Runtime replays what the page logged earlier; only what happens from now on is new.
    while let Ok(_) | Err(broadcast::error::TryRecvError::Lagged(_)) = events.try_recv() {}
    let buffer = Arc::new(SyncMutex::new(Buffer::default()));
    let sink = buffer.clone();
    let task = tokio::spawn(async move {
        loop {
            let event = match events.recv().await {
                Ok(event) => event,
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            };
            if event.session_id.is_some() {
                continue;
            }
            let Some((kind, text, url, line)) = entry_for(&event.method, &event.params) else { continue };
            let mut buffer = sink.lock().unwrap();
            buffer.next += 1;
            let seq = buffer.next;
            buffer.entries.push_back(Entry { seq, time: crate::now_iso(), kind, text: truncate(text), url, line });
            if buffer.entries.len() > MAX_ENTRIES {
                buffer.entries.pop_front();
                buffer.dropped += 1;
            }
        }
    });
    console.active = Some(Active { tab, cdp, buffer, _task: TaskGuard::new(task.abort_handle()) });
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
        buffer.entries.retain(|entry| entry.seq > last);
        buffer.dropped = 0;
    }
    let mut result = json!({ "tab": active.tab, "entries": entries, "lastSeq": last });
    if skipped > 0 {
        result["omitted"] = json!(skipped);
    }
    if dropped > 0 {
        result["droppedOldest"] = json!(dropped);
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
                detect; stop it when done. start begins capturing (earlier messages are not included); read returns \
                buffered entries {seq, type, text, url, line} oldest first and by default clears them; stop ends the \
                capture. The buffer keeps the newest 1000 entries."
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
                    "clear": { "type": "boolean", "description": "read: drop everything read so far from the buffer (default true)." }
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
                        let _ = active.cdp.send("Runtime.disable", json!({}), None).await;
                        json_output(&json!({ "capturing": false, "tab": active.tab }))
                    }
                }
            }
            .await,
        )
        .await
    }
}
