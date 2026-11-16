//! Agent tabs across relay restarts: the tab registry (<data>/relays/<port>/tabs.json) a restarted relay gives the
//! agents their tabs back from, and the tool calls running.

use std::collections::HashSet;

use browse_core::TabOptions;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::task::AbortHandle;

/// A tool call running, the process that made it, and the tabs it used: they count as busy until it ends.
pub struct RunningCall {
    pub abort: AbortHandle,
    pub pid: Option<u32>,
    /// The caller's key for the call (CALL_HEADER), which POST /tools/cancel names.
    pub key: Option<String>,
    pub tabs: HashSet<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedTab {
    /// The relay's id for the tab, which agents hold.
    pub tab: i64,
    pub target_id: String,
    pub browser_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opener: Option<i64>,
    /// The agent whose call opened the tab (OWNER_HEADER), so a restarted relay can give it back as theirs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub caller: Option<String>,
    #[serde(flatten)]
    pub options: TabOptions,
    #[serde(default)]
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct Registry {
    version: u8,
    tabs: Vec<PersistedTab>,
}

pub fn load(path: &std::path::Path) -> Vec<PersistedTab> {
    let Ok(text) = std::fs::read(path) else { return Vec::new() };
    match serde_json::from_slice::<Registry>(&text) {
        Ok(registry) if registry.version == 1 => registry.tabs,
        _ => {
            let aside = path.with_extension(format!("json.corrupt-{}", crate::util::now_ms()));
            let _ = std::fs::rename(path, &aside);
            crate::rlog!("tabs.registry.corrupt", moved = aside.display().to_string());
            Vec::new()
        }
    }
}

pub fn save(path: &std::path::Path, tabs: &[PersistedTab]) -> std::io::Result<()> {
    crate::paths::write_private_json(path, &json!({ "version": 1, "tabs": tabs }))
}

/// A group label: trimmed, at most 63 characters, without control characters; None when nothing is left.
pub fn clean_group(raw: &str) -> Option<String> {
    let cleaned: String = raw.trim().chars().filter(|c| !c.is_control()).take(63).collect();
    let cleaned = cleaned.trim().to_string();
    (!cleaned.is_empty()).then_some(cleaned)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_round_trips() {
        let dir = std::env::temp_dir().join(format!("browse-relay-registry-{}", crate::util::random_hex(6)));
        let path = dir.join("tabs.json");
        let entry = PersistedTab {
            tab: 7,
            target_id: "T7".into(),
            browser_key: "k1".into(),
            opener: Some(3),
            caller: Some("mcp-01234567".into()),
            options: TabOptions { group: Some("orw-x".into()), allowed_origins: Some(vec!["example.com".into()]), read_only: true, keep_visible: false, browser: None },
            created_at: "now".into(),
        };
        save(&path, std::slice::from_ref(&entry)).unwrap();
        let written: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(written["tabs"][0]["group"], "orw-x");
        assert_eq!(written["tabs"][0]["allowedOrigins"], json!(["example.com"]));
        assert_eq!(written["tabs"][0]["readOnly"], true);
        assert_eq!(load(&path), vec![entry]);
        std::fs::write(&path, "nonsense").unwrap();
        assert!(load(&path).is_empty());
        assert!(!path.exists(), "a corrupt registry is moved aside");
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(clean_group("  orw-x \n").as_deref(), Some("orw-x"));
        assert_eq!(clean_group("  "), None);
    }
}
