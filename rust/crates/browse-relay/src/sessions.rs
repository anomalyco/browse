//! Agent sessions: what each one owns (its tabs, its current tab, an allowlist), and the catalog that keeps them
//! across relay restarts (<data>/relays/<port>/sessions.json, the TypeScript relay's format).

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use browse_core::SessionState;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::task::AbortHandle;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PersistedTarget {
    pub id: String,
    pub owner: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedSession {
    pub id: String,
    pub created_at: String,
    pub updated_at: String,
    pub read_only: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allowed_origins: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keep_visible: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub browser: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub browser_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<PersistedTarget>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub targets: Option<Vec<PersistedTarget>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_pid: Option<u32>,
}

#[derive(Debug, Serialize, Deserialize)]
struct Catalog {
    version: u8,
    sessions: Vec<PersistedSession>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrowserRef {
    pub id: String,
    pub key: Option<String>,
}

pub struct Session {
    pub id: String,
    pub created_at: String,
    pub updated_at: String,
    pub read_only: bool,
    pub allowed_origins: Option<Vec<String>>,
    pub keep_visible: bool,
    pub browser: Option<BrowserRef>,
    /// The tab bare tool calls act on.
    pub current: Option<i64>,
    /// The durable identity of an adopted (user) tab, so a restarted relay gives it back.
    pub target: Option<PersistedTarget>,
    /// Target ids of the agent tabs the session opened, reclaimed after a relay restart.
    pub held: Vec<String>,
    pub client_pid: Option<u32>,
    pub state: Arc<SessionState>,
    pub calls: HashMap<u64, AbortHandle>,
    pub idle_epoch: u64,
    pub last_used: Instant,
    pub warnings: Vec<String>,
    /// Why the session's running calls were stopped (the toolbar button, a reset), for their callers.
    pub stopped: Option<String>,
    /// Background work tools reported (`Browser::set_busy`: "network", "recording").
    pub busy_keys: std::collections::HashSet<String>,
}

impl Session {
    pub fn new(id: String) -> Self {
        let now = crate::util::now_iso();
        Self {
            id,
            created_at: now.clone(),
            updated_at: now,
            read_only: false,
            allowed_origins: None,
            keep_visible: false,
            browser: None,
            current: None,
            target: None,
            held: Vec::new(),
            client_pid: None,
            state: Arc::new(SessionState::default()),
            calls: HashMap::new(),
            idle_epoch: 0,
            last_used: Instant::now(),
            warnings: Vec::new(),
            stopped: None,
            busy_keys: std::collections::HashSet::new(),
        }
    }

    pub fn from_persisted(entry: PersistedSession) -> Self {
        let mut session = Self::new(entry.id);
        session.created_at = entry.created_at;
        session.updated_at = entry.updated_at;
        session.read_only = entry.read_only;
        session.allowed_origins = entry.allowed_origins.filter(|o| !o.is_empty());
        session.keep_visible = entry.keep_visible == Some(true);
        session.browser = entry.browser.map(|id| BrowserRef { id, key: entry.browser_key });
        session.target = entry.target.filter(|t| t.owner == "user" || t.owner == "relay");
        session.held = entry.targets.unwrap_or_default().into_iter().filter(|t| t.owner == "relay").map(|t| t.id).collect();
        if let Some(target) = session.target.as_ref().filter(|t| t.owner == "relay")
            && !session.held.contains(&target.id) {
                session.held.push(target.id.clone());
            }
        session.client_pid = entry.client_pid;
        session
    }

    pub fn persisted(&self, live_relay_targets: &[String]) -> PersistedSession {
        let mut targets: Vec<String> = self.held.clone();
        for id in live_relay_targets {
            if !targets.contains(id) {
                targets.push(id.clone());
            }
        }
        PersistedSession {
            id: self.id.clone(),
            created_at: self.created_at.clone(),
            updated_at: self.updated_at.clone(),
            read_only: self.read_only,
            allowed_origins: self.allowed_origins.clone(),
            keep_visible: self.keep_visible.then_some(true),
            browser: self.browser.as_ref().map(|b| b.id.clone()),
            browser_key: self.browser.as_ref().and_then(|b| b.key.clone()),
            target: self.target.clone(),
            targets: (!targets.is_empty()).then(|| targets.into_iter().map(|id| PersistedTarget { id, owner: "relay".into() }).collect()),
            client_pid: self.client_pid,
        }
    }

    pub fn busy(&self) -> bool {
        !self.calls.is_empty() || !self.busy_keys.is_empty()
    }

    pub fn touch(&mut self) {
        self.updated_at = crate::util::now_iso();
        self.last_used = Instant::now();
    }

    pub fn add_warning(&mut self, warning: String) {
        if !self.warnings.contains(&warning) && self.warnings.len() < 10 {
            self.warnings.push(warning);
        }
    }
}

pub fn load_catalog(path: &std::path::Path) -> Vec<PersistedSession> {
    let Ok(text) = std::fs::read(path) else { return Vec::new() };
    match serde_json::from_slice::<Catalog>(&text) {
        Ok(catalog) if catalog.version == 1 && catalog.sessions.iter().all(|s| valid_session_id(&s.id)) => catalog.sessions,
        _ => {
            let aside = path.with_extension(format!("json.corrupt-{}", crate::util::now_ms()));
            let _ = std::fs::rename(path, &aside);
            crate::rlog!("session.catalog.corrupt", moved = aside.display().to_string());
            Vec::new()
        }
    }
}

pub fn save_catalog(path: &std::path::Path, sessions: &[PersistedSession]) -> std::io::Result<()> {
    crate::paths::write_private_json(path, &json!({ "version": 1, "sessions": sessions }))
}

/// Lowercase letters, numbers, dashes, underscores and spaces (and emoji), starting with a letter, digit or emoji.
pub fn valid_session_id(id: &str) -> bool {
    if id.is_empty() || id.chars().count() > 63 || id == "." || id == ".." {
        return false;
    }
    let mut chars = id.chars();
    let first = chars.next().unwrap();
    let ok = |c: char| c.is_ascii_lowercase() || c.is_ascii_digit() || (!c.is_ascii() && !c.is_uppercase() && !c.is_control());
    ok(first) && chars.all(|c| ok(c) || c == '-' || c == '_' || c == ' ')
}

/// Sessions browse names itself: an MCP server's, a generated id, or an opencode session's.
pub fn auto_named(id: &str) -> bool {
    mcp_named(id) || id.starts_with("oc-") || generated_name(id)
}

pub fn mcp_named(id: &str) -> bool {
    id.strip_prefix("mcp-").is_some_and(|rest| rest.len() == 8 && rest.bytes().all(|b| b.is_ascii_hexdigit()))
}

fn generated_name(id: &str) -> bool {
    let parts: Vec<&str> = id.split('-').collect();
    parts.len() == 3
        && parts[0].bytes().all(|b| b.is_ascii_lowercase())
        && !parts[0].is_empty()
        && parts[1].bytes().all(|b| b.is_ascii_lowercase())
        && !parts[1].is_empty()
        && parts[2].len() == 3
        && parts[2].bytes().all(|b| b.is_ascii_digit())
}

pub fn generate_session_id(taken: &dyn Fn(&str) -> bool) -> String {
    const ADJECTIVES: [&str; 10] = ["amber", "brisk", "calm", "clever", "cosmic", "gentle", "lucky", "quiet", "rapid", "tidy"];
    const NOUNS: [&str; 10] = ["badger", "comet", "falcon", "otter", "panda", "raven", "sparrow", "tiger", "walrus", "wombat"];
    for _ in 0..100 {
        let [a, n, s1, s2] = crate::util::random_bytes::<4>();
        let id = format!("{}-{}-{:03}", ADJECTIVES[a as usize % 10], NOUNS[n as usize % 10], (u16::from(s1) << 8 | u16::from(s2)) % 1000);
        if !taken(&id) {
            return id;
        }
    }
    format!("session-{}", crate::util::random_hex(4))
}

pub fn summary(session: &Session, tabs: Value, handoff: Option<Value>) -> Value {
    let mut value = json!({
        "id": session.id,
        "createdAt": session.created_at,
        "updatedAt": session.updated_at,
        "currentTab": session.current,
        "tabs": tabs,
    });
    if session.read_only {
        value["readOnly"] = true.into();
    }
    if let Some(origins) = &session.allowed_origins {
        value["allowedOrigins"] = json!(origins);
    }
    if session.keep_visible {
        value["keepVisible"] = true.into();
    }
    if let Some(browser) = &session.browser {
        value["browser"] = browser.id.clone().into();
    }
    if session.busy() {
        value["busy"] = true.into();
    }
    if let Some(handoff) = handoff {
        value["handoff"] = handoff;
    }
    value
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids() {
        assert!(valid_session_id("github"));
        assert!(valid_session_id("oc-ses_abc"));
        assert!(!valid_session_id("GitHub"));
        assert!(!valid_session_id("a/b"));
        assert!(!valid_session_id("-x"));
        assert!(auto_named("mcp-1a2b3c4d"));
        assert!(auto_named("quiet-falcon-333"));
        assert!(!auto_named("github"));
        let id = generate_session_id(&|_| false);
        assert!(auto_named(&id) && valid_session_id(&id), "{id}");
    }

    #[test]
    fn catalog_round_trips_the_typescript_format() {
        let raw = r#"{"version":1,"sessions":[{"id":"work","createdAt":"a","updatedAt":"b","readOnly":false,"browser":"chrome-mac","browserKey":"k1","target":{"id":"T1","owner":"user"},"targets":[{"id":"T2","owner":"relay"}],"clientPid":42}]}"#;
        let dir = std::env::temp_dir().join(format!("browse-relay-catalog-{}", crate::util::random_hex(6)));
        let path = dir.join("sessions.json");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(&path, raw).unwrap();
        let loaded = load_catalog(&path);
        let session = Session::from_persisted(loaded[0].clone());
        assert_eq!(session.held, vec!["T2"]);
        assert_eq!(session.browser.as_ref().unwrap().key.as_deref(), Some("k1"));
        let back = session.persisted(&[]);
        assert_eq!(back.targets.unwrap()[0].id, "T2");
        assert_eq!(back.target.unwrap().owner, "user");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
