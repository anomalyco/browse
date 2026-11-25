//! The extension wire protocol's constants (cli/src/protocol.ts, src/agent-relay/protocol.ts).

use serde_json::Value;

pub const EXTENSION_PROTOCOL_VERSION: i64 = 3;
pub const MIN_EXTENSION_PROTOCOL_VERSION: i64 = 3;
pub const CAPABILITY_TAB_RELEASE: &str = "tab-release";
pub const PAIRING_SCHEME: &str = "opencode-browser-pairing-v3";

pub const UNPACKED_EXTENSION_ID: &str = "afeafocngkodbmaipcngoamamfmekgfo";
pub const PUBLIC_STORE_ID: &str = "mfnicocicmmlkpjnaffgihfjhdgjkdjg";
pub const DEFAULT_PORT: u16 = 19988;
/// After 19988; not 19989, which is Browser Control's. Must match the extension's relayFallbackPorts.
pub const FALLBACK_PORTS: [u16; 8] = [19990, 19991, 19992, 19993, 19994, 19995, 19996, 19997];
pub const BROWSER_UNRESPONSIVE: &str =
    "The browser isn't answering (asleep, frozen or very busy?). Wake it or wait a moment, then try again.";
pub const BROWSER_RELOADING: &str = "browse stopped answering in this browser for over a minute, so the relay asked it to reload. Try again in a few seconds.";
pub const NOT_CONNECTED: &str = "browse extension is not connected";

pub const EVENT_METHODS: &[&str] = &[
    "protocol",
    "hello",
    "auth.code",
    "auth.response",
    "ready",
    "toolbar.clicked",
    "handoff.completed",
    "debugger.event",
    "debugger.attached",
    "debugger.detached",
    "tabs.removed",
    "tabs.opened",
    "pong",
    "log",
    "pageStatus.requested",
    "settings",
];

/// Whether an open `/version` reply is a browse relay's, of this build or the TypeScript one: every browse relay sends
/// these fields (cli/src/http-api.ts, serve.rs). Another program's server can share some of them: Playwriter's relay,
/// also on 19988, answers `{"version":"0.12.0","pid":…,"activeExecutes":0}`.
pub fn is_browse_version(body: &Value) -> bool {
    ["version", "buildId", "instanceId", "startedAt"].iter().all(|key| body[key].is_string()) && body["shutdownProtocol"].is_number()
}

pub fn stable_unpacked_origin() -> String {
    format!("chrome-extension://{UNPACKED_EXTENSION_ID}")
}

/// The store item this install trusts: OPENCODE_BROWSER_STORE_ID when it is a store id, else the public item.
pub fn store_id() -> String {
    std::env::var("OPENCODE_BROWSER_STORE_ID")
        .ok()
        .filter(|id| id.len() == 32 && id.bytes().all(|b| (b'a'..=b'p').contains(&b)))
        .unwrap_or_else(|| PUBLIC_STORE_ID.to_string())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Compatibility {
    pub version: Option<i64>,
    pub compatible: bool,
    pub legacy: bool,
}

pub fn compatibility(value: Option<&Value>) -> Compatibility {
    let version = match value {
        None => Some(1),
        Some(value) => value.as_i64().filter(|v| *v > 0 && value.as_f64().is_some_and(|f| f.fract() == 0.0)),
    };
    let compatible = version.is_some_and(|v| (MIN_EXTENSION_PROTOCOL_VERSION..=EXTENSION_PROTOCOL_VERSION).contains(&v));
    Compatibility { version, compatible, legacy: value.is_none() }
}

pub fn skew(version: Option<i64>) -> Option<&'static str> {
    match version {
        Some(v) if v > EXTENSION_PROTOCOL_VERSION => Some("extension-newer"),
        Some(v) if v < MIN_EXTENSION_PROTOCOL_VERSION => Some("extension-older"),
        _ => None,
    }
}

/// What to tell the user about a protocol mismatch.
pub fn advice(version: Option<i64>, distribution: Option<&str>) -> String {
    let speaks = if MIN_EXTENSION_PROTOCOL_VERSION == EXTENSION_PROTOCOL_VERSION {
        EXTENSION_PROTOCOL_VERSION.to_string()
    } else {
        format!("{MIN_EXTENSION_PROTOCOL_VERSION} to {EXTENSION_PROTOCOL_VERSION}")
    };
    let shown = version.map(|v| v.to_string()).unwrap_or_else(|| "unknown".into());
    let versions = format!("extension protocol {shown}, this relay speaks {speaks}");
    match skew(version) {
        Some("extension-newer") => format!(
            "The browse extension is newer than this browse CLI ({versions}). Update the CLI: run `browse update`, then restart your agent."
        ),
        Some(_) => {
            let unpacked = "Reload browse on your browser's extensions page (↻).";
            let store = "The Chrome Web Store updates it within a few hours (to update now, open chrome://extensions, turn on Developer mode and click Update).";
            let next = match distribution {
                Some("unpacked") => unpacked.to_string(),
                Some("store") => store.to_string(),
                _ => format!("For an unpacked extension: {unpacked} For a store extension: {store}"),
            };
            format!("The browse extension is older than this browse CLI ({versions}). {next}")
        }
        None => format!(
            "The browse extension and this browse CLI don't speak the same protocol ({versions}). Run `browse install` again and update the extension."
        ),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    #[test]
    fn compatibility_follows_the_typescript_rules() {
        let current = super::compatibility(Some(&json!(3)));
        assert!(current.compatible && !current.legacy);
        let missing = super::compatibility(None);
        assert_eq!(missing.version, Some(1));
        assert!(!missing.compatible && missing.legacy);
        assert!(!super::compatibility(Some(&json!(4))).compatible);
        assert_eq!(super::compatibility(Some(&json!("3"))).version, None);
    }
}
