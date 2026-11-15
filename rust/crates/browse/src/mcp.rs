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
const EXECUTE_INSTRUCTIONS: &str = include_str!("instructions-execute.md");
/// What clients without a code mode see: one `execute` for the browser work, plus the session housekeeping tools.
const EXECUTE_SURFACE: &[&str] = &["execute", "status", "session", "settings", "tabs_cleanup"];

/// Which tools a client sees. OpenCode composes plain tools in its own code mode; other clients get `execute`.
/// OPENCODE_BROWSER_TOOLS=plain|execute|all overrides it.
#[derive(Clone, Copy, PartialEq, Debug)]
enum Surface {
    Plain,
    Execute,
    All,
}

fn surface(client: &str) -> Surface {
    surface_for(std::env::var("OPENCODE_BROWSER_TOOLS").ok().as_deref(), client)
}

fn surface_for(choice: Option<&str>, client: &str) -> Surface {
    match choice.map(str::to_ascii_lowercase).as_deref() {
        Some("plain") => return Surface::Plain,
        Some("execute") => return Surface::Execute,
        Some("all") => return Surface::All,
        _ => {}
    }
    // OpenCode sends clientInfo { name: "opencode" }.
    if client.to_ascii_lowercase().contains("opencode") { Surface::Plain } else { Surface::Execute }
}

fn listed(surface: Surface, specs: Vec<browse_core::ToolSpec>) -> Vec<browse_core::ToolSpec> {
    match surface {
        Surface::All => specs,
        Surface::Plain => specs.into_iter().filter(|s| s.name != browse_script::NAME).collect(),
        // A relay from before execute existed: its plain tools beat a list without the one that does the work.
        Surface::Execute if !specs.iter().any(|s| s.name == browse_script::NAME) => specs,
        Surface::Execute => EXECUTE_SURFACE.iter().filter_map(|name| specs.iter().find(|s| s.name == *name).cloned()).collect(),
    }
}

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
    let mut surface = surface("");
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
                surface = self::surface(params.pointer("/clientInfo/name").and_then(Value::as_str).unwrap_or_default());
                reply(&out, id, json!({
                    "protocolVersion": version,
                    "capabilities": {"tools": {"listChanged": false}},
                    "serverInfo": {"name": "browse", "version": VERSION},
                    "instructions": if surface == Surface::Plain { INSTRUCTIONS } else { EXECUTE_INSTRUCTIONS },
                }));
            }
            "ping" => reply(&out, id, json!({})),
            "tools/list" => {
                reply(&out, id, json!({ "tools": listed(surface, relay::specs()) }));
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

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(name: &str) -> browse_core::ToolSpec {
        browse_core::ToolSpec { name: name.into(), description: String::new(), input_schema: json!({}) }
    }

    #[test]
    fn opencode_gets_plain_tools_and_others_execute() {
        assert_eq!(surface_for(None, "opencode"), Surface::Plain);
        assert_eq!(surface_for(None, "OpenCode-desktop"), Surface::Plain);
        assert_eq!(surface_for(None, "claude-code"), Surface::Execute);
        assert_eq!(surface_for(None, ""), Surface::Execute);
        assert_eq!(surface_for(Some("all"), "opencode"), Surface::All);
        assert_eq!(surface_for(Some("EXECUTE"), "opencode"), Surface::Execute);
        let all = || ["status", "session", "navigate", "click", "execute", "settings"].map(spec).to_vec();
        let names = |list: Vec<browse_core::ToolSpec>| list.into_iter().map(|s| s.name).collect::<Vec<_>>();
        assert_eq!(names(listed(Surface::Plain, all())), ["status", "session", "navigate", "click", "settings"]);
        assert_eq!(names(listed(Surface::Execute, all())), ["execute", "status", "session", "settings"]);
        // An older relay without execute keeps its plain tools.
        assert_eq!(names(listed(Surface::Execute, ["status", "navigate"].map(spec).to_vec())), ["status", "navigate"]);
    }
}
