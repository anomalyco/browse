//! The pieces of browse-relay this binary uses outside the relay process, resolved for this environment.

use std::path::PathBuf;

pub use browse_relay::paths::Paths;
pub use browse_relay::protocol::DEFAULT_PORT;

pub fn paths() -> Paths {
    Paths::from_env()
}

/// Where `install` puts the executable: $OPENCODE_BROWSER_HOME/bin, else $XDG_BIN_HOME, else ~/.local/bin.
pub fn bin_root() -> PathBuf {
    if let Some(home) = std::env::var_os("OPENCODE_BROWSER_HOME").filter(|h| !h.is_empty()) {
        return PathBuf::from(home).join("bin");
    }
    std::env::var_os("XDG_BIN_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .unwrap_or_else(|| crate::setup::home().join(".local").join("bin"))
}

/// The port the running relay listens on (a pinned port, else a live relay.json's, else 19988).
pub fn port() -> u16 {
    browse_relay::port::resolve_port(&paths())
}

pub fn endpoint() -> String {
    format!("http://127.0.0.1:{}", port())
}

/// This install's relay token, created on first use.
pub fn token() -> Option<String> {
    browse_relay::secrets::relay_token(&paths()).ok()
}

pub fn browse_files() -> [PathBuf; 4] {
    let paths = paths();
    [paths.config, paths.data, paths.state, paths.cache]
}
