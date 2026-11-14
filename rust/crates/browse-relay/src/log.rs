//! The relay's operational log, one line per lifecycle event, in <state root>/logs/relay.log (rotated at 1 MB).

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

use serde_json::Value;

static LOG: Mutex<Option<PathBuf>> = Mutex::new(None);
const MAX_BYTES: u64 = 1_000_000;

pub fn set_path(path: PathBuf) {
    *LOG.lock().unwrap() = Some(path);
}

/// `relay_log("extension.connected", &[("browser", id.into())])`
pub fn relay_log(event: &str, fields: &[(&str, Value)]) {
    let detail = fields
        .iter()
        .filter(|(_, value)| !value.is_null())
        .map(|(key, value)| match value {
            Value::String(text) if !text.chars().any(char::is_whitespace) => format!("{key}={text}"),
            other => format!("{key}={other}"),
        })
        .collect::<Vec<_>>()
        .join(" ");
    let line = if detail.is_empty() { event.to_string() } else { format!("{event} {detail}") };
    if std::env::var_os("OPENCODE_BROWSER_DEBUG").is_some() {
        eprintln!("[browse relay] {line}");
    }
    let Some(path) = LOG.lock().unwrap().clone() else { return };
    let entry = format!("{} {}\n", crate::util::now_iso(), line.chars().take(64_000).collect::<String>());
    let _ = (|| -> std::io::Result<()> {
        if let Some(parent) = path.parent() {
            crate::paths::ensure_private_dir(parent)?;
        }
        if fs::metadata(&path).map(|m| m.len() + entry.len() as u64 > MAX_BYTES).unwrap_or(false) {
            fs::rename(&path, path.with_extension("log.1"))?;
        }
        let mut options = OpenOptions::new();
        options.create(true).append(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        options.open(&path)?.write_all(entry.as_bytes())
    })();
}

#[macro_export]
macro_rules! rlog {
    ($event:expr $(, $key:ident = $value:expr)* $(,)?) => {
        $crate::log::relay_log($event, &[$((stringify!($key), serde_json::json!($value))),*])
    };
}
