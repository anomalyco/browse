//! `browse mcp`: a stdio MCP server (newline-delimited JSON-RPC 2.0) that forwards to the relay and nothing more. It
//! passes the client's `clientInfo.name` along (browse_core::CLIENT_HEADER), and the relay decides the tools and
//! instructions that client gets. Calls carry no caller identity: every browser call names its tab.

use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use browse_core::{Content, ToolCallRequest, ToolOutput};
use serde_json::{Value, json};

use crate::{VERSION, relay, update};

const PROTOCOLS: &[&str] = &["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

#[derive(Default)]
struct Running {
    count: Mutex<usize>,
    idle: Condvar,
    /// Tool calls in flight, by their JSON-RPC id (as JSON text).
    calls: Mutex<HashMap<String, Pending>>,
}

struct Pending {
    /// The key the relay knows the call by (browse_core::CALL_HEADER).
    key: String,
    /// The client sent `notifications/cancelled` for it, so it gets no answer.
    cancelled: bool,
}

pub fn run() -> anyhow::Result<()> {
    let out = Arc::new(Mutex::new(std::io::stdout()));
    let running = Arc::new(Running::default());
    let noted = Arc::new(AtomicBool::new(false));
    let mut client = String::new();
    let mut line = String::new();
    let mut stdin = std::io::stdin().lock();
    loop {
        line.clear();
        if stdin.read_line(&mut line)? == 0 {
            break;
        }
        let Ok(message) = serde_json::from_str::<Value>(line.trim()) else {
            if !line.trim().is_empty() {
                write(&out, &json!({"jsonrpc": "2.0", "id": null, "error": {"code": -32700, "message": "Parse error"}}));
            }
            continue;
        };
        let Some(id) = message.get("id").cloned() else {
            // Notifications need no answer; a cancelled call is stopped in the relay.
            if message.get("method").and_then(Value::as_str) == Some("notifications/cancelled")
                && let Some(request) = message.pointer("/params/requestId")
            {
                cancel(&running, request);
            }
            continue;
        };
        let method = message.get("method").and_then(Value::as_str).unwrap_or_default();
        let params = message.get("params").cloned().unwrap_or(Value::Null);
        match method {
            "initialize" => {
                let asked = params.get("protocolVersion").and_then(Value::as_str).unwrap_or_default();
                let version = PROTOCOLS.iter().find(|v| **v == asked).unwrap_or(&PROTOCOLS[0]);
                client = params.pointer("/clientInfo/name").and_then(Value::as_str).unwrap_or_default().to_string();
                reply(&out, id, json!({
                    "protocolVersion": version,
                    "capabilities": {"tools": {"listChanged": false}},
                    "serverInfo": {"name": "browse", "version": VERSION},
                    "instructions": relay::instructions(&client),
                }));
            }
            "ping" => reply(&out, id, json!({})),
            "tools/list" => reply(&out, id, json!({ "tools": relay::specs(Some(&client)) })),
            "tools/call" => {
                let (out, running, noted, client) = (out.clone(), running.clone(), noted.clone(), client.clone());
                *running.count.lock().unwrap() += 1;
                let key = format!("{:016x}{:016x}", crate::session::random_u64(), crate::session::random_u64());
                running.calls.lock().unwrap().insert(id.to_string(), Pending { key: key.clone(), cancelled: false });
                std::thread::spawn(move || {
                    let mut result = call(&params, &client, &key);
                    let cancelled = running.calls.lock().unwrap().remove(&id.to_string()).is_some_and(|p| p.cancelled);
                    // Once per process: a notify-only install tells the agent about an update to pass on.
                    if let Some((summary, command)) = update::pending_notice()
                        && params.get("name").and_then(Value::as_str) != Some("status")
                        && !noted.swap(true, Ordering::SeqCst)
                    {
                        result.content.push(Content::Text {
                            text: format!("Note: browse has an update: {summary}. Tell the user they can run `{command}`, or ask you to run it for them."),
                        });
                    }
                    // A cancelled request gets no response (MCP cancellation).
                    if !cancelled {
                        reply(&out, id, serde_json::to_value(result).unwrap_or(Value::Null));
                    }
                    let mut count = running.count.lock().unwrap();
                    *count -= 1;
                    running.idle.notify_all();
                });
            }
            "resources/list" => reply(&out, id, json!({ "resources": [] })),
            "prompts/list" => reply(&out, id, json!({ "prompts": [] })),
            _ => write(&out, &json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32601, "message": format!("Method not found: {method}")}})),
        }
    }
    // stdin closed: nobody reads the answers anymore, so give quick calls a moment and exit. The relay stops the calls
    // of a client process that is gone.
    let count = running.count.lock().unwrap();
    let _ = running.idle.wait_timeout_while(count, Duration::from_secs(2), |n| *n > 0);
    Ok(())
}

/// Stops the call the client cancelled, in the background: the relay ends it (and a handoff it waits on), and its
/// answer is dropped.
fn cancel(running: &Running, request: &Value) {
    let key = {
        let mut calls = running.calls.lock().unwrap();
        let Some(pending) = calls.get_mut(&request.to_string()) else { return };
        pending.cancelled = true;
        pending.key.clone()
    };
    std::thread::spawn(move || {
        let _ = relay::cancel(&key);
    });
}

fn call(params: &Value, client: &str, key: &str) -> ToolOutput {
    let name = params.get("name").and_then(Value::as_str).unwrap_or_default().to_owned();
    let arguments = params.get("arguments").cloned().filter(Value::is_object).unwrap_or_else(|| json!({}));
    relay::call_keyed(&ToolCallRequest { name: name.clone(), arguments }, Some(client), Some(key)).unwrap_or_else(|error| ToolOutput::error(format!("{name} failed: {error:#}")))
}

fn reply(out: &Mutex<std::io::Stdout>, id: Value, result: Value) {
    write(out, &json!({ "jsonrpc": "2.0", "id": id, "result": result }));
}

fn write(out: &Mutex<std::io::Stdout>, message: &Value) {
    let mut text = message.to_string();
    text.push('\n');
    let mut out = out.lock().unwrap();
    let _ = out.write_all(text.as_bytes()).and_then(|_| out.flush());
}
