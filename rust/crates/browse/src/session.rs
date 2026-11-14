//! Which browse session a call runs in (cli/src/mcp/registry.ts). OpenCode names the calling agent session in each
//! call's `_meta`; its browse session is derived from that id, so it is the same in every server and survives an
//! update. A session pinned with OPENCODE_BROWSER_SESSION wins.

use serde_json::Value;

use crate::relay_api;

const OPENCODE_SESSION_META: &str = "ai.opencode/sessionID";

pub fn caller(opencode_session: &str) -> String {
    relay_api::caller_session_id(opencode_session)
}

pub fn pinned() -> Option<String> {
    std::env::var("OPENCODE_BROWSER_SESSION").ok().filter(|s| !s.is_empty())
}

pub fn random() -> String {
    format!("mcp-{:08x}", random_u64() as u32)
}

/// The caller of an MCP tools/call: the pinned session, else its agent's, else this process's `shared` one. A call's
/// own `session` argument is left to the relay, which runs it there only when that session exists.
pub fn for_call(params: &Value, shared: &str) -> String {
    let agent = params.get("_meta").and_then(|m| m.get(OPENCODE_SESSION_META)).and_then(Value::as_str).filter(|s| !s.is_empty());
    pinned().or_else(|| agent.map(caller)).unwrap_or_else(|| shared.to_owned())
}

/// The CLI's caller: OPENCODE_BROWSER_SESSION, the OpenCode agent session running it, else "cli".
pub fn for_cli() -> String {
    pinned()
        .or_else(|| std::env::var("OPENCODE_SESSION_ID").ok().filter(|s| !s.is_empty()).map(|id| caller(&id)))
        .unwrap_or_else(|| "cli".into())
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn random_u64() -> u64 {
    use std::hash::{BuildHasher, Hasher};
    let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
    hasher.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos());
    hasher.write_u32(std::process::id());
    hasher.finish()
}
