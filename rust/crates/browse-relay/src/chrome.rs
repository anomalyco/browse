//! Standalone Chromium-family profiles driven directly over CDP (`browse chrome`), stored in `<data>/chrome.json`.
//!
//! Only profiles `browse chrome` itself created/connected are recorded and re-attached across relay restarts — browse
//! never scans or touches the user's main Chrome profile here (the Chrome extension handles that).

use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::paths::Paths;

/// One standalone Chromium profile `browse chrome` connected, stored in `<data>/chrome.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordedChrome {
    pub exe: PathBuf,
    pub profile: PathBuf,
    #[serde(default)]
    pub headless: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

impl RecordedChrome {
    pub fn display_name(&self) -> String {
        self.name.clone().unwrap_or_else(|| "Chrome".into())
    }
}

/// The relay's stable key for a standalone Chromium profile's direct CDP driver.
pub fn driver_key(profile: &Path) -> String {
    format!("driver:cdp:{}", profile.display())
}

/// browse's dedicated Chromium user-data-dir (`<data>/profiles/chrome` or `<data>/profiles/chrome-<slug>`).
pub fn dedicated_profile(paths: &Paths, slug: &str) -> PathBuf {
    let clean: String = slug
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .trim_matches('-')
        .to_string();
    let name = if clean.is_empty() || clean == "chrome" || clean == "google-chrome" {
        "chrome".to_string()
    } else {
        format!("chrome-{clean}")
    };
    paths.data.join("profiles").join(name)
}

/// Reads `<profile>/DevToolsActivePort` and returns the loopback CDP WebSocket URL when present and valid.
pub fn listening_url(profile: &Path) -> Option<String> {
    let text = std::fs::read_to_string(profile.join("DevToolsActivePort")).ok()?;
    browse_cdp::ws::parse_devtools_active_port(&text)
}

/// True when the profile has a valid `DevToolsActivePort` whose loopback port accepts a TCP connection right now.
pub fn live_url(profile: &Path) -> Option<String> {
    let url = listening_url(profile)?;
    let addr = url.strip_prefix("ws://")?.split('/').next()?;
    let sock: std::net::SocketAddr = addr.parse().ok()?;
    std::net::TcpStream::connect_timeout(&sock, std::time::Duration::from_millis(250)).ok()?;
    Some(url)
}

pub fn recorded_path(paths: &Paths) -> PathBuf {
    paths.data.join("chrome.json")
}

#[derive(Default, Serialize, Deserialize)]
struct RecordedFile {
    #[serde(default)]
    profiles: Vec<RecordedChrome>,
}

pub fn read_recorded(paths: &Paths) -> Vec<RecordedChrome> {
    crate::paths::read_json::<RecordedFile>(&recorded_path(paths))
        .map(|file| file.profiles)
        .unwrap_or_default()
}

fn write_recorded(paths: &Paths, profiles: &[RecordedChrome]) -> io::Result<()> {
    let file = recorded_path(paths);
    if profiles.is_empty() {
        return match std::fs::remove_file(&file) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            other => other,
        };
    }
    crate::paths::write_private_json(&file, &RecordedFile { profiles: profiles.to_vec() })
}

fn same_dir(a: &Path, b: &Path) -> bool {
    a == b || matches!((std::fs::canonicalize(a), std::fs::canonicalize(b)), (Ok(a), Ok(b)) if a == b)
}

/// Records `record` (most recently connected first, deduplicated by profile directory).
pub fn record(paths: &Paths, record: RecordedChrome) -> io::Result<()> {
    let mut profiles = read_recorded(paths);
    profiles.retain(|existing| !same_dir(&existing.profile, &record.profile));
    profiles.insert(0, record);
    write_recorded(paths, &profiles)
}

/// Removes `profile` from `<data>/chrome.json`.
pub fn forget(paths: &Paths, profile: &Path) -> io::Result<Option<RecordedChrome>> {
    let mut profiles = read_recorded(paths);
    let Some(index) = profiles.iter().position(|r| same_dir(&r.profile, profile)) else {
        return Ok(None);
    };
    let removed = profiles.remove(index);
    write_recorded(paths, &profiles)?;
    Ok(Some(removed))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recorded_chrome_round_trips_and_parses_active_port() {
        let dir = std::env::temp_dir().join(format!("browse-chrome-test-{}", crate::util::random_hex(6)));
        std::fs::create_dir_all(&dir).unwrap();
        let paths = Paths::rooted(dir.clone());
        assert!(read_recorded(&paths).is_empty());
        let prof = dedicated_profile(&paths, "Chrome");
        assert_eq!(prof, dir.join("profiles/chrome"));
        assert_eq!(dedicated_profile(&paths, "Brave"), dir.join("profiles/chrome-brave"));

        let rec = RecordedChrome {
            exe: "/usr/bin/google-chrome".into(),
            profile: prof.clone(),
            headless: true,
            name: Some("Chrome".into()),
        };
        record(&paths, rec.clone()).unwrap();
        assert_eq!(read_recorded(&paths), std::slice::from_ref(&rec));
        assert_eq!(forget(&paths, &prof).unwrap(), Some(rec));
        assert!(!recorded_path(&paths).exists());

        std::fs::create_dir_all(&prof).unwrap();
        std::fs::write(prof.join("DevToolsActivePort"), "9333\n/devtools/browser/uuid-1\n").unwrap();
        assert_eq!(listening_url(&prof).as_deref(), Some("ws://127.0.0.1:9333/devtools/browser/uuid-1"));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
