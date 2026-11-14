//! The user's browse settings (cli/src/relay/user-settings.ts): the extension's options page owns them; the relay
//! reads and writes them through it (`settings.get`, `settings.set`). Environment variables on the relay override some.

use serde_json::{Map, Value, json};

pub const AGENT_KEYS: [&str; 5] = ["window", "grouping", "idleMinutes", "humanInput", "handoffNotifications"];

pub struct Spec {
    pub label: &'static str,
    pub values: &'static [&'static str],
}

pub fn spec(key: &str) -> Option<Spec> {
    Some(match key {
        "window" => Spec { label: "Where agents open their tabs (current: the user's window; separate: an unfocused window of their own)", values: &["current", "separate"] },
        "grouping" => Spec { label: "How agent tabs are grouped (one shared group, one group per session, or none)", values: &["shared", "session", "none"] },
        "idleMinutes" => Spec { label: "Close agent tabs untouched for this many minutes", values: &["10", "30", "60", "never"] },
        "humanInput" => Spec { label: "Human-like input (off is faster, but easier for sites to flag)", values: &["on", "off"] },
        "handoffNotifications" => Spec { label: "System notification on a handoff (only while recorded, or every handoff)", values: &["recording", "always"] },
        _ => return None,
    })
}

pub const SECURITY_VARIABLES: [&str; 5] = [
    "OPENCODE_BROWSER_ALLOW_ALL_COOKIES",
    "OPENCODE_BROWSER_ALLOW_FOREGROUND",
    "OPENCODE_BROWSER_ALLOW_ALL_STORAGE",
    "OPENCODE_BROWSER_ALLOW_FILE_URLS",
    "OPENCODE_BROWSER_UPDATE_CHECK",
];

/// A setting value as the tool shows it: idleMinutes is a number or "never", the rest strings.
fn shown(key: &str, raw: &str) -> Value {
    if key == "idleMinutes" { raw.parse::<u64>().map(Value::from).unwrap_or_else(|_| raw.into()) } else { raw.into() }
}

pub fn agent_window_override() -> Option<&'static str> {
    match std::env::var("OPENCODE_BROWSER_AGENT_WINDOW").ok()?.trim().to_lowercase().as_str() {
        "current" => Some("current"),
        "separate" => Some("separate"),
        _ => None,
    }
}

pub fn human_input_override() -> Option<bool> {
    let value = std::env::var("OPENCODE_BROWSER_HUMAN_INPUT").ok()?;
    let value = value.trim();
    (!value.is_empty()).then(|| !matches!(value.to_lowercase().as_str(), "0" | "false" | "off" | "no"))
}

/// The settings the relay's environment fixes: key -> (variable, value).
pub fn overrides() -> Vec<(&'static str, &'static str, String)> {
    let mut out = Vec::new();
    if let Some(window) = agent_window_override() {
        out.push(("window", "OPENCODE_BROWSER_AGENT_WINDOW", window.to_string()));
    }
    if let Some(human) = human_input_override() {
        out.push(("humanInput", "OPENCODE_BROWSER_HUMAN_INPUT", if human { "on" } else { "off" }.to_string()));
    }
    out
}

/// What the extension's status page shows as fixed by the relay (`relay.settings` overrides).
pub fn extension_overrides() -> Value {
    let mut map = Map::new();
    if let Some(window) = agent_window_override() {
        map.insert("agentWindow".into(), window.into());
    }
    if let Some(human) = human_input_override() {
        map.insert("humanInput".into(), if human { "on" } else { "off" }.into());
    }
    Value::Object(map)
}

/// Strictly parses requested changes into the setting's canonical strings; every problem at once.
pub fn parse_changes(input: &Value) -> Result<Vec<(String, String)>, String> {
    let Some(object) = input.as_object() else { return Err("Pass the settings to change as an object, for example { \"grouping\": \"shared\" }.".into()) };
    let mut problems = Vec::new();
    let mut changes = Vec::new();
    for (key, raw) in object {
        if key == "autoUpdate" {
            problems.push("autoUpdate can't be read or changed here. The user changes it with `browse settings` or the extension's options page.".to_string());
            continue;
        }
        let Some(spec) = spec(key) else {
            problems.push(if ["allow", "security", "cookie", "foreground", "storage", "file"].iter().any(|w| key.to_lowercase().contains(w)) {
                format!("\"{key}\" is not a setting: security switches ({}) are set only in the relay's environment, never here.", SECURITY_VARIABLES.join(", "))
            } else {
                format!("Unknown setting \"{key}\". Settings: {}.", AGENT_KEYS.join(", "))
            });
            continue;
        };
        let value = match (key.as_str(), raw) {
            ("idleMinutes", Value::Number(n)) if n.as_u64() == Some(0) => Some("never".to_string()),
            ("idleMinutes", Value::String(s)) if s == "0" => Some("never".to_string()),
            ("idleMinutes", Value::Number(n)) => n.as_u64().map(|n| n.to_string()),
            (_, Value::String(s)) => Some(s.clone()),
            _ => None,
        };
        match value.filter(|v| spec.values.contains(&v.as_str())) {
            Some(value) => changes.push((key.clone(), value)),
            None => problems.push(format!("{key} must be one of {} (got {raw}).", spec.values.join(", "))),
        }
    }
    if !problems.is_empty() {
        return Err(problems.join(" "));
    }
    if changes.is_empty() {
        return Err(format!("Nothing to change. Settings: {}.", AGENT_KEYS.join(", ")));
    }
    Ok(changes)
}

/// The extension's settings.get / settings.set answer, as canonical strings.
pub fn from_extension(answer: &Value) -> Result<Vec<(String, String)>, String> {
    let values = answer.get("settings").and_then(Value::as_object).ok_or("The extension answered settings without them")?;
    Ok(AGENT_KEYS
        .iter()
        .map(|key| {
            let value = values.get(*key);
            let text = match (*key, value) {
                ("idleMinutes", Some(Value::Number(n))) if n.as_u64() == Some(0) => "never".to_string(),
                ("idleMinutes", Some(Value::Number(n))) => n.to_string(),
                ("idleMinutes", _) => "10".to_string(),
                (_, Some(Value::String(s))) => s.clone(),
                _ => spec(key).unwrap().values[0].to_string(),
            };
            (key.to_string(), text)
        })
        .collect())
}

/// Changes in the extension's terms (idleMinutes a number, 0 for never).
pub fn to_extension(changes: &[(String, String)]) -> Value {
    let mut map = Map::new();
    for (key, value) in changes {
        let wire = if key == "idleMinutes" { json!(if value == "never" { 0 } else { value.parse::<u64>().unwrap_or(10) }) } else { json!(value) };
        map.insert(key.clone(), wire);
    }
    Value::Object(map)
}

fn lookup<'a>(settings: &'a [(String, String)], key: &str) -> &'a str {
    settings.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str()).unwrap_or("")
}

pub fn report(stored: &[(String, String)]) -> Value {
    let fixed = overrides();
    let mut map = Map::new();
    for key in AGENT_KEYS {
        let spec = spec(key).unwrap();
        let value = lookup(stored, key);
        let over = fixed.iter().find(|(k, _, _)| *k == key);
        let mut entry = json!({
            "value": shown(key, value),
            "effective": shown(key, over.map(|(_, _, v)| v.as_str()).unwrap_or(value)),
            "allowed": spec.values.iter().map(|v| shown(key, v)).collect::<Vec<_>>(),
            "description": spec.label,
        });
        if let Some((_, variable, _)) = over {
            entry["overriddenBy"] = (*variable).into();
        }
        map.insert(key.into(), entry);
    }
    Value::Object(map)
}

pub fn security_note() -> String {
    format!("Security switches ({}) are environment-only and can't be read or changed here.", SECURITY_VARIABLES.join(", "))
}

pub fn describe_changes(before: &[(String, String)], after: &[(String, String)], requested: &[(String, String)]) -> Value {
    let fixed = overrides();
    let (mut changed, mut unchanged, mut overridden, mut lines) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    for (key, value) in requested {
        if let Some((_, variable, effective)) = fixed.iter().find(|(k, _, _)| k == key) {
            overridden.push(json!({ "key": key, "requested": shown(key, value), "variable": variable, "effective": shown(key, effective) }));
            lines.push(format!("Not changed: {key} is fixed to {effective} by {variable} in the relay's environment, so this setting has no effect. Tell the user; to change it they remove or edit {variable} where opencode starts, then restart the relay."));
        } else if lookup(before, key) == lookup(after, key) {
            unchanged.push(key.clone());
        } else {
            changed.push(json!({ "key": key, "from": shown(key, lookup(before, key)), "to": shown(key, lookup(after, key)) }));
        }
    }
    if !changed.is_empty() {
        let text = changed.iter().map(|c| format!("{} from {} to {}", c["key"].as_str().unwrap_or(""), c["from"], c["to"])).collect::<Vec<_>>().join(", ");
        lines.insert(0, format!("Changed {}. Tell the user what you changed; they can change it back on the extension's options page.", text.replace('"', "")));
    }
    if !unchanged.is_empty() {
        let text = unchanged.iter().map(|k| format!("{k} is {}", lookup(after, k))).collect::<Vec<_>>().join(", ");
        lines.push(format!("Already set: {text}."));
    }
    json!({ "changed": changed, "unchanged": unchanged, "overridden": overridden, "settings": report(after), "message": lines.join(" ") })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_strictly() {
        let changes = parse_changes(&json!({ "grouping": "session", "idleMinutes": 0 })).unwrap();
        assert_eq!(changes, vec![("grouping".to_string(), "session".to_string()), ("idleMinutes".to_string(), "never".to_string())]);
        assert!(parse_changes(&json!({ "grouping": "x" })).is_err());
        assert!(parse_changes(&json!({ "allowCookies": true })).unwrap_err().contains("security"));
        assert_eq!(to_extension(&changes), json!({ "grouping": "session", "idleMinutes": 0 }));
    }
}
