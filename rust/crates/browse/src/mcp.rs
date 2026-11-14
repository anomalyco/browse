//! `browse mcp`: a stdio MCP server (newline-delimited JSON-RPC 2.0) that forwards tools to the relay. One process
//! serves every OpenCode agent session; each gets its own browse session from the `_meta` OpenCode sends.

use std::collections::HashSet;
use std::io::{BufRead, Write};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use browse_core::{Content, ToolCallRequest, ToolOutput};
use serde_json::{Value, json};

use crate::{VERSION, relay, session, update};

const PROTOCOLS: &[&str] = &["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const INSTRUCTIONS: &str = include_str!("instructions.md");

#[derive(Default)]
struct Running {
    count: Mutex<usize>,
    idle: Condvar,
}

pub fn run() -> anyhow::Result<()> {
    let out = Arc::new(Mutex::new(std::io::stdout()));
    let running = Arc::new(Running::default());
    let noted = Arc::new(Mutex::new(HashSet::new()));
    // Calls that don't name their agent share one session (one tab set) for the life of this process, not one per call.
    let shared = session::pinned().unwrap_or_else(session::random);
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
        let Some(id) = message.get("id").cloned() else { continue }; // notifications need no answer
        let method = message.get("method").and_then(Value::as_str).unwrap_or_default();
        let params = message.get("params").cloned().unwrap_or(Value::Null);
        match method {
            "initialize" => {
                let asked = params.get("protocolVersion").and_then(Value::as_str).unwrap_or_default();
                let version = PROTOCOLS.iter().find(|v| **v == asked).unwrap_or(&PROTOCOLS[0]);
                reply(&out, id, json!({
                    "protocolVersion": version,
                    "capabilities": {"tools": {"listChanged": false}},
                    "serverInfo": {"name": "browse", "version": VERSION},
                    "instructions": INSTRUCTIONS,
                }));
            }
            "ping" => reply(&out, id, json!({})),
            "tools/list" => {
                reply(&out, id, json!({ "tools": relay::specs() }));
            }
            "tools/call" => {
                let (out, running, noted) = (out.clone(), running.clone(), noted.clone());
                let session = session::for_call(&params, &shared);
                *running.count.lock().unwrap() += 1;
                std::thread::spawn(move || {
                    let mut result = call(&params, session.clone());
                    // Once per agent session: a notify-only install tells the agent about an update to pass on.
                    if let Some((summary, command)) = update::pending_notice()
                        && params.get("name").and_then(Value::as_str) != Some("status")
                        && noted.lock().unwrap().insert(session)
                    {
                        result.content.push(Content::Text {
                            text: format!("Note: browse has an update: {summary}. Tell the user they can run `{command}`, or ask you to run it for them."),
                        });
                    }
                    reply(&out, id, serde_json::to_value(result).unwrap_or(Value::Null));
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
    // stdin closed: nobody reads the answers anymore, so give quick calls a moment and exit. The relay stops the work
    // of a client process that is gone.
    let count = running.count.lock().unwrap();
    let _ = running.idle.wait_timeout_while(count, Duration::from_secs(2), |n| *n > 0);
    Ok(())
}

fn call(params: &Value, session: String) -> ToolOutput {
    let name = params.get("name").and_then(Value::as_str).unwrap_or_default().to_owned();
    let arguments = params.get("arguments").cloned().filter(Value::is_object).unwrap_or_else(|| json!({}));
    relay::call(&ToolCallRequest { name: name.clone(), arguments, session })
        .unwrap_or_else(|error| ToolOutput::error(format!("{name} failed: {error:#}")))
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
