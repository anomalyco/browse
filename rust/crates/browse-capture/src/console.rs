//! Opt-in capture of a page's own console messages and uncaught errors over `CaptureDriver::console()`.

use std::collections::{HashSet, VecDeque};
use std::sync::{Arc, Mutex as SyncMutex};

use async_trait::async_trait;
use browse_core::{ConsoleEvent, TabId, Tool, ToolContext, ToolOutput, ToolSpec};
use serde::Serialize;
use serde_json::{Value, json};
use tokio::sync::oneshot;

use crate::{arg_action, arg_bool, arg_int, arg_str, bail_user, json_output, respond, state, tab_schema, target_tab};

const MAX_ENTRIES: usize = 1_000;
const MAX_TEXT: usize = 4_000;

#[derive(Default)]
pub(crate) struct ConsoleState {
    active: Option<Active>,
}

struct Active {
    tab: TabId,
    buffer: Arc<SyncMutex<Buffer>>,
    stop_tx: Option<oneshot::Sender<()>>,
    task: Option<tokio::task::JoinHandle<()>>,
}

impl Active {
    async fn stop(mut self) {
        if let Some(tx) = self.stop_tx.take() {
            let _ = tx.send(());
        }
        if let Some(task) = self.task.take() {
            let _ = tokio::time::timeout(std::time::Duration::from_secs(2), task).await;
        }
    }
}

impl Drop for Active {
    fn drop(&mut self) {
        if let Some(tx) = self.stop_tx.take() {
            let _ = tx.send(());
        }
    }
}

#[derive(Default)]
struct Buffer {
    entries: VecDeque<Entry>,
    dropped: u64,
    next: u64,
    ended: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    seq: u64,
    time: String,
    #[serde(rename = "type")]
    kind: String,
    text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    target: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    line: Option<i64>,
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

async fn start(ctx: &ToolContext, args: &Value) -> anyhow::Result<ToolOutput> {
    let tab = target_tab(args)?;
    let capture = state::get(ctx, tab).await?;
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
    let driver = ctx.browser.tab_driver(tab).await?;
    let mut sub = driver.capture().console().await?;
    let buffer = Arc::new(SyncMutex::new(Buffer::default()));
    let sink = buffer.clone();
    let (stop_tx, mut stopped) = oneshot::channel::<()>();
    let task = tokio::spawn(async move {
        let reason = loop {
            tokio::select! {
                _ = &mut stopped => {
                    sub.stop().await;
                    return;
                }
                event = sub.recv() => match event {
                    Some(ConsoleEvent::Entry(message)) => {
                        let mut buffer = sink.lock().unwrap();
                        buffer.next += 1;
                        let seq = buffer.next;
                        buffer.entries.push_back(Entry {
                            seq,
                            time: crate::now_iso(),
                            kind: message.kind,
                            text: truncate(message.text),
                            source: message.source,
                            target: message.target,
                            url: message.url,
                            line: message.line,
                        });
                        if buffer.entries.len() > MAX_ENTRIES {
                            buffer.entries.pop_front();
                            buffer.dropped += 1;
                        }
                    }
                    Some(ConsoleEvent::Closed(reason)) => break reason.to_string(),
                    None => break "its tab closed or browse was detached from it".to_string(),
                }
            }
        };
        sink.lock().unwrap().ended = Some(reason);
    });
    console.active = Some(Active { tab, buffer, stop_tx: Some(stop_tx), task: Some(task) });
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
            description: "Opt-in capture of a tab's own console messages and uncaught errors. Off by default because it enables the browser's runtime console stream, which pages (and bot checks) can \
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
                "required": ["tab", "action"],
                "additionalProperties": false
            }),
            output_schema: None,
        }
    }

    async fn call(&self, ctx: ToolContext, args: Value) -> anyhow::Result<ToolOutput> {
        respond(
            async {
                match arg_action(&args, &["start", "read", "stop"])? {
                    "start" => start(&ctx, &args).await,
                    "read" => {
                        let capture = state::get(&ctx, target_tab(&args)?).await?;
                        let console = capture.console.lock().await;
                        read(&console, &args)
                    }
                    _ => {
                        let capture = state::get(&ctx, target_tab(&args)?).await?;
                        let mut console = capture.console.lock().await;
                        let Some(active) = console.active.take() else {
                            return json_output(&json!({ "capturing": false }));
                        };
                        let tab = active.tab;
                        active.stop().await;
                        json_output(&json!({ "capturing": false, "tab": tab }))
                    }
                }
            }
            .await,
        )
        .await
    }
}
