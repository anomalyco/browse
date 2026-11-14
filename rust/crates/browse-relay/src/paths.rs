//! Where browse keeps its files, the same layout as the TypeScript CLI (cli/src/paths.ts), so pairings, tokens and
//! sessions carry over:
//!   config  $XDG_CONFIG_HOME/browse   config.json, settings.json
//!   data    $XDG_DATA_HOME/browse     relay-token, browser-tokens.json, browsers.json, relays/<port>/sessions.json
//!   state   $XDG_STATE_HOME/browse    logs/relay.log, pairing-codes.json, relays/<port>/relay.json
//!   cache   $XDG_CACHE_HOME/browse
//! OPENCODE_BROWSER_HOME overrides all four (isolated test relays).

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Paths {
    pub config: PathBuf,
    pub data: PathBuf,
    pub state: PathBuf,
    pub cache: PathBuf,
}

impl Paths {
    pub fn from_env() -> Self {
        let home = home_dir();
        if let Some(root) = std::env::var_os("OPENCODE_BROWSER_HOME").filter(|value| !value.is_empty()) {
            return Self::rooted(PathBuf::from(root));
        }
        let xdg = |variable: &str, fallback: &str| {
            let configured = std::env::var_os(variable).map(PathBuf::from).filter(|path| path.is_absolute());
            configured.unwrap_or_else(|| home.join(fallback)).join("browse")
        };
        Self {
            config: xdg("XDG_CONFIG_HOME", ".config"),
            data: xdg("XDG_DATA_HOME", ".local/share"),
            state: xdg("XDG_STATE_HOME", ".local/state"),
            cache: xdg("XDG_CACHE_HOME", ".cache"),
        }
    }

    /// Every root in one folder, as OPENCODE_BROWSER_HOME does.
    pub fn rooted(root: PathBuf) -> Self {
        Self { config: root.clone(), data: root.clone(), state: root.clone(), cache: root }
    }

    pub fn relay_token(&self) -> PathBuf {
        self.data.join("relay-token")
    }
    pub fn browser_tokens(&self) -> PathBuf {
        self.data.join("browser-tokens.json")
    }
    pub fn legacy_pairing_code(&self) -> PathBuf {
        self.data.join("extension-pairing")
    }
    pub fn browsers(&self) -> PathBuf {
        self.data.join("browsers.json")
    }
    pub fn session_catalog(&self, configured_port: u16) -> PathBuf {
        self.data.join("relays").join(configured_port.to_string()).join("sessions.json")
    }
    pub fn pairing_codes(&self) -> PathBuf {
        self.state.join("pairing-codes.json")
    }
    pub fn relay_state(&self, configured_port: u16) -> PathBuf {
        self.state.join("relays").join(configured_port.to_string()).join("relay.json")
    }
    pub fn last_port(&self, configured_port: u16) -> PathBuf {
        self.state.join("relays").join(configured_port.to_string()).join("last-port.json")
    }
    pub fn relay_log(&self) -> PathBuf {
        self.state.join("logs").join("relay.log")
    }
    pub fn auto_update(&self) -> PathBuf {
        self.state.join("auto-update.json")
    }
    pub fn relay_config(&self) -> PathBuf {
        self.config.join("config.json")
    }
}

pub fn home_dir() -> PathBuf {
    std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."))
}

/// Creates the folder (and its parents) readable only by this user, or tightens an existing one.
pub fn ensure_private_dir(dir: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

/// Writes `value` as JSON atomically (temporary file and rename), readable only by this user.
pub fn write_private_json<T: Serialize + ?Sized>(path: &Path, value: &T) -> std::io::Result<()> {
    let mut text = serde_json::to_string_pretty(value).map_err(std::io::Error::other)?;
    text.push('\n');
    write_private(path, text.as_bytes())
}

pub fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        ensure_private_dir(parent)?;
    }
    let temporary = path.with_extension(format!("{}.{}.tmp", std::process::id(), crate::util::random_hex(6)));
    let result = (|| {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(&temporary, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

pub fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Option<T> {
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}
