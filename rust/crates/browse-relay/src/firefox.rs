//! Firefox-family browsers on this computer (Firefox, Developer Edition, Nightly, Zen), read from the filesystem
//! only: where they're installed, their profiles (profiles.ini, installs.ini), whether a profile is running and
//! listening for WebDriver BiDi (its `.parentlock` / `parent.lock`, and `WebDriverBiDiServer.json`), the profiles
//! `browse firefox` connected (`<data>/firefox.json`), and the prefs browse adds to a real profile.
//!
//! Shared by the relay (auto-attach and `nextStep`) and the `browse` CLI. Every root is injectable through
//! `Discovery`, so tests never depend on what this computer has installed.

use std::ffi::OsString;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::paths::Paths;

/// The Firefox-family apps browse knows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AppKind {
    Firefox,
    Dev,
    Nightly,
    Zen,
}

impl AppKind {
    pub const ALL: [AppKind; 4] = [AppKind::Firefox, AppKind::Dev, AppKind::Nightly, AppKind::Zen];

    /// The name `--app` takes and firefox.json records.
    pub fn id(self) -> &'static str {
        match self {
            AppKind::Firefox => "firefox",
            AppKind::Dev => "dev",
            AppKind::Nightly => "nightly",
            AppKind::Zen => "zen",
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            AppKind::Firefox => "Firefox",
            AppKind::Dev => "Firefox Developer Edition",
            AppKind::Nightly => "Firefox Nightly",
            AppKind::Zen => "Zen",
        }
    }

    pub fn parse(value: &str) -> Option<AppKind> {
        match value.trim().to_lowercase().as_str() {
            "firefox" | "release" => Some(AppKind::Firefox),
            "dev" | "developer" | "devedition" | "developer-edition" | "firefox-developer-edition" => Some(AppKind::Dev),
            "nightly" | "firefox-nightly" => Some(AppKind::Nightly),
            "zen" | "zen-browser" => Some(AppKind::Zen),
            _ => None,
        }
    }

    /// macOS bundle names.
    fn bundles(self) -> &'static [&'static str] {
        match self {
            AppKind::Firefox => &["Firefox.app"],
            AppKind::Dev => &["Firefox Developer Edition.app"],
            AppKind::Nightly => &["Firefox Nightly.app"],
            AppKind::Zen => &["Zen.app", "Zen Browser.app"],
        }
    }

    fn mac_executable(self) -> &'static str {
        if self == AppKind::Zen { "zen" } else { "firefox" }
    }

    /// Executables on PATH (Linux).
    fn commands(self) -> &'static [&'static str] {
        match self {
            AppKind::Firefox => &["firefox"],
            AppKind::Dev => &["firefox-developer-edition"],
            AppKind::Nightly => &["firefox-nightly"],
            AppKind::Zen => &["zen-browser", "zen"],
        }
    }

    /// `<Program Files>\<folder>\<exe>` (Windows).
    fn windows_install(self) -> (&'static str, &'static str) {
        match self {
            AppKind::Firefox => ("Mozilla Firefox", "firefox.exe"),
            AppKind::Dev => ("Firefox Developer Edition", "firefox.exe"),
            AppKind::Nightly => ("Firefox Nightly", "firefox.exe"),
            AppKind::Zen => ("Zen Browser", "zen.exe"),
        }
    }

    /// The suffixes Firefox gives the profile it creates for this app's install (`abcd1234.default-release`).
    fn profile_suffix(self) -> &'static [&'static str] {
        match self {
            AppKind::Firefox => &[".default-release", ".default"],
            AppKind::Dev => &[".dev-edition-default"],
            AppKind::Nightly => &[".default-nightly"],
            AppKind::Zen => &[".default (release)", ".default-release", ".default"],
        }
    }

    fn zen(self) -> bool {
        self == AppKind::Zen
    }
}

/// An installed app.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct App {
    pub kind: AppKind,
    pub name: String,
    /// The executable browse runs (headless, Linux, Windows).
    pub exe: PathBuf,
    /// The macOS `.app` bundle, which `open -n -a` launches when there is a window.
    pub bundle: Option<PathBuf>,
}

impl App {
    /// An app at a path the user gave (`--app <path>`): a macOS bundle, or an executable.
    pub fn at(path: &Path) -> Option<App> {
        let lower = path.to_string_lossy().to_lowercase();
        let kind = if lower.contains("zen") {
            AppKind::Zen
        } else if lower.contains("nightly") {
            AppKind::Nightly
        } else if lower.contains("developer") {
            AppKind::Dev
        } else {
            AppKind::Firefox
        };
        if path.extension().is_some_and(|e| e == "app") && path.is_dir() {
            let macos = path.join("Contents").join("MacOS");
            let exe = [kind.mac_executable(), "firefox", "zen"].iter().map(|n| macos.join(n)).find(|p| p.is_file())?;
            return Some(App { kind, name: kind.name().into(), exe, bundle: Some(path.to_path_buf()) });
        }
        path.is_file().then(|| App { kind, name: kind.name().into(), exe: path.to_path_buf(), bundle: None })
    }
}

/// The operating system whose layout to look in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Os {
    Mac,
    Linux,
    Windows,
}

impl Os {
    pub fn current() -> Os {
        if cfg!(target_os = "macos") {
            Os::Mac
        } else if cfg!(windows) {
            Os::Windows
        } else {
            Os::Linux
        }
    }
}

/// Where to look for Firefox-family apps and profiles. `system()` reads this computer's; tests build their own.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Discovery {
    pub os: Os,
    pub home: PathBuf,
    /// Folders holding macOS `.app` bundles.
    pub app_dirs: Vec<PathBuf>,
    /// Windows `Program Files` folders.
    pub program_files: Vec<PathBuf>,
    /// PATH, for executables.
    pub path: Option<OsString>,
    pub xdg_config: Option<PathBuf>,
    pub appdata: Option<PathBuf>,
}

impl Discovery {
    pub fn system() -> Discovery {
        let os = Os::current();
        let home = crate::paths::home_dir();
        let env_dir = |name: &str| std::env::var_os(name).map(PathBuf::from).filter(|p| p.is_absolute());
        let app_dirs = if os == Os::Mac { vec![PathBuf::from("/Applications"), home.join("Applications")] } else { Vec::new() };
        let program_files = if os == Os::Windows {
            let mut dirs: Vec<PathBuf> = ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"].iter().filter_map(|n| env_dir(n)).collect();
            if let Some(local) = env_dir("LOCALAPPDATA") {
                dirs.push(local.join("Programs"));
            }
            dirs.dedup();
            dirs
        } else {
            Vec::new()
        };
        Discovery { os, app_dirs, program_files, path: std::env::var_os("PATH"), xdg_config: env_dir("XDG_CONFIG_HOME"), appdata: env_dir("APPDATA"), home }
    }

    /// Finds nothing: no apps, no profile roots.
    pub fn none() -> Discovery {
        Discovery { os: Os::current(), home: PathBuf::new(), app_dirs: Vec::new(), program_files: Vec::new(), path: None, xdg_config: None, appdata: None }
    }

    /// The installed Firefox-family apps, in `AppKind::ALL` order.
    pub fn apps(&self) -> Vec<App> {
        AppKind::ALL.iter().filter_map(|kind| self.app(*kind)).collect()
    }

    pub fn app(&self, kind: AppKind) -> Option<App> {
        for dir in &self.app_dirs {
            for bundle in kind.bundles() {
                let bundle = dir.join(bundle);
                let exe = bundle.join("Contents").join("MacOS").join(kind.mac_executable());
                if exe.is_file() {
                    return Some(App { kind, name: kind.name().into(), exe, bundle: Some(bundle) });
                }
            }
        }
        let (folder, exe) = kind.windows_install();
        for dir in &self.program_files {
            let exe = dir.join(folder).join(exe);
            if exe.is_file() {
                return Some(App { kind, name: kind.name().into(), exe, bundle: None });
            }
        }
        if let Some(path) = &self.path {
            for dir in std::env::split_paths(path) {
                for command in kind.commands() {
                    let exe = dir.join(command);
                    if exe.is_file() {
                        return Some(App { kind, name: kind.name().into(), exe, bundle: None });
                    }
                }
            }
        }
        None
    }

    /// The folders that may hold this app's profiles.ini (Firefox, Developer Edition and Nightly share one).
    pub fn profile_roots(&self, kind: AppKind) -> Vec<PathBuf> {
        if self.home.as_os_str().is_empty() && self.appdata.is_none() {
            return Vec::new();
        }
        let home = &self.home;
        match self.os {
            Os::Mac if kind.zen() => vec![home.join("Library/Application Support/zen")],
            Os::Mac => vec![home.join("Library/Application Support/Firefox")],
            Os::Linux if kind.zen() => vec![home.join(".zen"), home.join(".var/app/app.zen_browser.zen/.zen")],
            Os::Linux => {
                let config = self.xdg_config.clone().unwrap_or_else(|| home.join(".config"));
                let mut roots = vec![
                    home.join(".mozilla/firefox"),
                    config.join("mozilla/firefox"),
                    home.join("snap/firefox/common/.mozilla/firefox"),
                    home.join(".var/app/org.mozilla.firefox/.mozilla/firefox"),
                ];
                roots.dedup();
                roots
            }
            Os::Windows => {
                let appdata = self.appdata.clone().unwrap_or_else(|| home.join("AppData").join("Roaming"));
                vec![if kind.zen() { appdata.join("zen") } else { appdata.join("Mozilla").join("Firefox") }]
            }
        }
    }

    /// Every profile of this app's roots. Roots that don't exist are skipped; one that can't be read (a sandboxed
    /// agent gets "Operation not permitted" on ~/Library/Application Support/Firefox) is an error when no other root
    /// had any profile.
    pub fn profiles(&self, kind: AppKind) -> io::Result<Profiles> {
        let mut merged = Profiles::default();
        let mut denied = None;
        for root in self.profile_roots(kind) {
            match profiles(&root) {
                Ok(found) => {
                    for profile in found.list {
                        if !merged.list.iter().any(|p| p.dir == profile.dir) {
                            merged.list.push(profile);
                        }
                    }
                    merged.install_defaults.extend(found.install_defaults);
                    merged.roots.extend(found.roots);
                }
                Err(error) if error.kind() == io::ErrorKind::PermissionDenied => {
                    denied = Some(io::Error::new(io::ErrorKind::PermissionDenied, format!("{}: {error}", root.display())));
                }
                Err(_) => {}
            }
        }
        match denied {
            Some(error) if merged.list.is_empty() => Err(error),
            _ => Ok(merged),
        }
    }
}

/// The installed Firefox-family apps on this computer.
pub fn apps() -> Vec<App> {
    Discovery::system().apps()
}

/// This computer's profile roots for an app.
pub fn profile_roots(kind: AppKind) -> Vec<PathBuf> {
    Discovery::system().profile_roots(kind)
}

/// A profile listed in profiles.ini (or found under `Profiles/`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Profile {
    pub name: String,
    pub dir: PathBuf,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Profiles {
    pub roots: Vec<PathBuf>,
    pub list: Vec<Profile>,
    /// `[Install*] Default=` profiles, the ones each install opens (never `[Profile*] Default=1`, which on a fresh
    /// Firefox points at an empty legacy profile).
    pub install_defaults: Vec<PathBuf>,
}

impl Profiles {
    pub fn names(&self) -> Vec<String> {
        self.list.iter().map(|p| p.name.clone()).collect()
    }
}

type IniSection = (String, Vec<(String, String)>);

/// `[section]` and `key=value` lines, in order.
fn parse_ini(text: &str) -> Vec<IniSection> {
    let mut sections: Vec<IniSection> = Vec::new();
    for line in text.trim_start_matches('\u{feff}').lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with(';') || line.starts_with('#') {
            continue;
        }
        if let Some(name) = line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
            sections.push((name.trim().to_string(), Vec::new()));
        } else if let (Some((key, value)), Some(section)) = (line.split_once('='), sections.last_mut()) {
            section.1.push((key.trim().to_string(), value.trim().to_string()));
        }
    }
    sections
}

fn ini_get<'a>(entries: &'a [(String, String)], key: &str) -> Option<&'a str> {
    entries.iter().find(|(k, _)| k.eq_ignore_ascii_case(key)).map(|(_, v)| v.as_str())
}

fn resolve(root: &Path, path: &str, relative: Option<bool>) -> PathBuf {
    let path = Path::new(path);
    match relative {
        Some(false) => path.to_path_buf(),
        Some(true) => root.join(path),
        None if path.is_absolute() => path.to_path_buf(),
        None => root.join(path),
    }
}

/// The profiles of one root: profiles.ini's `[Profile*]` entries, folders under `Profiles/`, and the `[Install*]`
/// defaults of profiles.ini and installs.ini. A root that doesn't exist is `NotFound`; one that can't be read is
/// `PermissionDenied`.
pub fn profiles(root: &Path) -> io::Result<Profiles> {
    std::fs::read_dir(root)?;
    let mut found = Profiles { roots: vec![root.to_path_buf()], ..Profiles::default() };
    let mut installs = Vec::new();
    for file in ["profiles.ini", "installs.ini"] {
        let text = match std::fs::read_to_string(root.join(file)) {
            Ok(text) => text,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error),
        };
        for (section, entries) in parse_ini(&text) {
            let lower = section.to_lowercase();
            // installs.ini's sections are the install hashes alone; profiles.ini's are `[Install<hash>]`.
            let install = file == "installs.ini" || lower.starts_with("install");
            if !install && lower.starts_with("profile") {
                let Some(path) = ini_get(&entries, "Path") else { continue };
                let relative = ini_get(&entries, "IsRelative").map(|v| v.trim() != "0");
                let dir = resolve(root, path, relative);
                let name = ini_get(&entries, "Name").map(str::to_string).unwrap_or_else(|| dir_name(&dir));
                if !found.list.iter().any(|p| p.dir == dir) {
                    found.list.push(Profile { name, dir });
                }
            } else if install
                && let Some(path) = ini_get(&entries, "Default")
            {
                let dir = resolve(root, path, None);
                if !installs.contains(&dir) {
                    installs.push(dir);
                }
            }
        }
    }
    if let Ok(entries) = std::fs::read_dir(root.join("Profiles")) {
        let mut extra: Vec<PathBuf> = entries.filter_map(Result::ok).map(|e| e.path()).filter(|p| p.is_dir()).collect();
        extra.sort();
        for dir in extra {
            if !found.list.iter().any(|p| same_dir(&p.dir, &dir)) {
                found.list.push(Profile { name: dir_name(&dir), dir });
            }
        }
    }
    found.install_defaults = installs;
    Ok(found)
}

fn dir_name(dir: &Path) -> String {
    dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| dir.display().to_string())
}

fn same_dir(a: &Path, b: &Path) -> bool {
    a == b || matches!((std::fs::canonicalize(a), std::fs::canonicalize(b)), (Ok(a), Ok(b)) if a == b)
}

/// Whether a profile's browser is running, and where its WebDriver BiDi server listens.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProfileState {
    NotRunning,
    RunningNoBidi { pid: Option<u32> },
    Listening { url: String, pid: Option<u32> },
    Unreadable(String),
}

impl ProfileState {
    pub fn running(&self) -> bool {
        matches!(self, ProfileState::RunningNoBidi { .. } | ProfileState::Listening { .. })
    }
}

/// `WebDriverBiDiServer.json`'s `{"ws_host": "127.0.0.1", "ws_port": 59834}` as a session URL; None unless the host is
/// a loopback IP and the port is set.
pub fn parse_bidi_server(text: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    let host = value.get("ws_host")?.as_str()?.trim();
    let port = value.get("ws_port")?.as_u64().filter(|p| (1..=65535).contains(p))?;
    let ip: std::net::IpAddr = host.trim_start_matches('[').trim_end_matches(']').parse().ok()?;
    if !ip.is_loopback() {
        return None;
    }
    Some(match ip {
        std::net::IpAddr::V4(v4) => format!("ws://{v4}:{port}/session"),
        std::net::IpAddr::V6(v6) => format!("ws://[{v6}]:{port}/session"),
    })
}

/// A missing lock file means not running, unless the profile folder itself can't be read.
fn no_lock_file(profile: &Path) -> io::Result<Option<Option<u32>>> {
    match std::fs::read_dir(profile) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
        _ => Ok(None),
    }
}

/// Who holds the profile lock: None when it's free, Some(pid) (the pid when the system tells) when held.
#[cfg(unix)]
fn lock_holder(profile: &Path) -> io::Result<Option<Option<u32>>> {
    use std::os::fd::AsRawFd;
    let file = match std::fs::File::open(profile.join(".parentlock")) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return no_lock_file(profile),
        Err(error) => return Err(error),
    };
    // F_GETLK reports a conflicting lock (and its holder) without taking one. The file outlives Firefox, so only the
    // lock says it runs.
    // SAFETY: flock is plain data; fcntl only writes into it.
    let mut lock: libc::flock = unsafe { std::mem::zeroed() };
    lock.l_type = libc::F_WRLCK as _;
    lock.l_whence = libc::SEEK_SET as _;
    lock.l_start = 0;
    lock.l_len = 0;
    // SAFETY: a valid open descriptor and a valid flock pointer.
    let rc = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETLK, &mut lock) };
    if rc == -1 {
        return Err(io::Error::last_os_error());
    }
    if i64::from(lock.l_type) == i64::from(libc::F_UNLCK) {
        return Ok(None);
    }
    Ok(Some((lock.l_pid > 0).then_some(lock.l_pid as u32)))
}

#[cfg(windows)]
fn lock_holder(profile: &Path) -> io::Result<Option<Option<u32>>> {
    use std::os::windows::fs::OpenOptionsExt;
    const ERROR_SHARING_VIOLATION: i32 = 32;
    let lock = profile.join("parent.lock");
    if !lock.exists() {
        return no_lock_file(profile);
    }
    match std::fs::OpenOptions::new().read(true).share_mode(0).open(&lock) {
        Ok(_) => Ok(None),
        Err(error) if error.raw_os_error() == Some(ERROR_SHARING_VIOLATION) => Ok(Some(None)),
        Err(error) => Err(error),
    }
}

/// Whether the profile's browser runs (its lock, checked first) and, when it does, whether it listens for WebDriver
/// BiDi. A stale `WebDriverBiDiServer.json` with a free lock is `NotRunning`.
pub fn state(profile: &Path) -> ProfileState {
    let holder = match lock_holder(profile) {
        Ok(holder) => holder,
        Err(error) => return ProfileState::Unreadable(format!("{}: {error}", profile.display())),
    };
    let Some(pid) = holder else { return ProfileState::NotRunning };
    match std::fs::read_to_string(profile.join("WebDriverBiDiServer.json")).ok().as_deref().and_then(parse_bidi_server) {
        Some(url) => ProfileState::Listening { url, pid },
        None => ProfileState::RunningNoBidi { pid },
    }
}

/// The relay's key for a profile's driver.
pub fn driver_key(profile: &Path) -> String {
    format!("driver:bidi:{}", profile.display())
}

/// A profile `browse firefox` connected, which the relay attaches again whenever it listens.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecordedFirefox {
    pub app: String,
    pub exe: PathBuf,
    pub profile: PathBuf,
    #[serde(default)]
    pub dedicated: bool,
    #[serde(default)]
    pub headless: bool,
    /// The name the browser has in browse (`Firefox`, `Zen`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// browse added `remote.prefs.recommended` to this profile's prefs.js (uninstall takes it out again).
    #[serde(default)]
    pub prefs_added: bool,
}

impl RecordedFirefox {
    pub fn kind(&self) -> Option<AppKind> {
        AppKind::parse(&self.app)
    }

    pub fn display_name(&self) -> String {
        self.name.clone().or_else(|| self.kind().map(|k| k.name().to_string())).unwrap_or_else(|| "Firefox".into())
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct RecordedFile {
    #[serde(default)]
    profiles: Vec<RecordedFirefox>,
}

pub fn recorded_path(paths: &Paths) -> PathBuf {
    paths.data.join("firefox.json")
}

pub fn read_recorded(paths: &Paths) -> Vec<RecordedFirefox> {
    crate::paths::read_json::<RecordedFile>(&recorded_path(paths)).map(|f| f.profiles).unwrap_or_default()
}

fn write_recorded(paths: &Paths, profiles: Vec<RecordedFirefox>) -> io::Result<()> {
    if profiles.is_empty() {
        return match std::fs::remove_file(recorded_path(paths)) {
            Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
            _ => Ok(()),
        };
    }
    crate::paths::write_private_json(&recorded_path(paths), &RecordedFile { profiles })
}

/// Records a profile (replacing an earlier record of it). A profile browse added prefs to keeps that note.
pub fn record(paths: &Paths, mut entry: RecordedFirefox) -> io::Result<()> {
    let mut profiles = read_recorded(paths);
    if let Some(previous) = profiles.iter().find(|p| p.profile == entry.profile) {
        entry.prefs_added |= previous.prefs_added;
    }
    profiles.retain(|p| p.profile != entry.profile);
    profiles.push(entry);
    write_recorded(paths, profiles)
}

/// Forgets a profile; returns its record.
pub fn forget(paths: &Paths, profile: &Path) -> io::Result<Option<RecordedFirefox>> {
    let mut profiles = read_recorded(paths);
    let Some(index) = profiles.iter().position(|p| p.profile == profile) else { return Ok(None) };
    let removed = profiles.remove(index);
    write_recorded(paths, profiles)?;
    Ok(Some(removed))
}

/// The folder of the dedicated profile browse keeps for an app.
pub fn dedicated_profile(paths: &Paths, kind: AppKind) -> PathBuf {
    paths.data.join("profiles").join(kind.id())
}

/// How a profile was chosen.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Chosen {
    Explicit,
    Recorded,
    Listening,
    Running,
    InstallDefault,
    Only,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Selected {
    pub dir: PathBuf,
    pub name: String,
    pub how: Chosen,
    /// The record that chose it.
    pub recorded: Option<RecordedFirefox>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SelectError {
    /// The profile folder can't be read (a sandbox).
    PermissionDenied(String),
    /// `--profile <name>` names no profile.
    NotFound { wanted: String, names: Vec<String> },
    /// Several profiles and nothing says which.
    Ambiguous(Vec<String>),
    /// No profile at all (the app never ran).
    None,
}

impl std::fmt::Display for SelectError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SelectError::PermissionDenied(detail) => write!(f, "browse can't read the profile folder ({detail})"),
            SelectError::NotFound { wanted, names } => write!(f, "no profile is called {wanted:?}; profiles: {}", names.join(", ")),
            SelectError::Ambiguous(names) => write!(f, "there are several profiles and none is the default; pick one with --profile <name>: {}", names.join(", ")),
            SelectError::None => write!(f, "no profile found"),
        }
    }
}

fn looks_like_path(value: &str) -> bool {
    value.contains('/') || value.contains('\\') || value.starts_with('~') || value.starts_with('.') || Path::new(value).is_absolute()
}

fn matches_name(profile: &Profile, wanted: &str) -> bool {
    let wanted = wanted.to_lowercase();
    let dir = dir_name(&profile.dir).to_lowercase();
    profile.name.to_lowercase() == wanted || dir == wanted || dir.split_once('.').is_some_and(|(_, rest)| rest == wanted)
}

/// Picks the profile to connect, in order: `--profile`; the profile recorded for this app; one listening for
/// WebDriver BiDi; the only one running; the install's default; the only one there is.
pub fn select_profile(
    kind: AppKind,
    explicit: Option<&str>,
    recorded: &[RecordedFirefox],
    profiles: io::Result<Profiles>,
    home: &Path,
    state: impl Fn(&Path) -> ProfileState,
) -> Result<Selected, SelectError> {
    let denied = |error: &io::Error| SelectError::PermissionDenied(error.to_string());
    if let Some(wanted) = explicit.map(str::trim).filter(|w| !w.is_empty()) {
        if looks_like_path(wanted) {
            let dir = match wanted.strip_prefix("~/").or_else(|| wanted.strip_prefix("~\\")) {
                Some(rest) => home.join(rest),
                None if wanted == "~" => home.to_path_buf(),
                None => std::path::absolute(wanted).unwrap_or_else(|_| PathBuf::from(wanted)),
            };
            return Ok(Selected { name: dir_name(&dir), dir, how: Chosen::Explicit, recorded: None });
        }
        let profiles = profiles.map_err(|e| denied(&e))?;
        return match profiles.list.iter().find(|p| matches_name(p, wanted)) {
            Some(p) => Ok(Selected { dir: p.dir.clone(), name: p.name.clone(), how: Chosen::Explicit, recorded: None }),
            None => Err(SelectError::NotFound { wanted: wanted.into(), names: profiles.names() }),
        };
    }
    if let Some(record) = recorded.iter().find(|r| r.kind() == Some(kind) && r.profile.is_dir()) {
        return Ok(Selected { dir: record.profile.clone(), name: dir_name(&record.profile), how: Chosen::Recorded, recorded: Some(record.clone()) });
    }
    let profiles = match profiles {
        Ok(profiles) => profiles,
        Err(error) if error.kind() == io::ErrorKind::PermissionDenied => return Err(denied(&error)),
        Err(_) => Profiles::default(),
    };
    let pick = |p: &Profile, how| Selected { dir: p.dir.clone(), name: p.name.clone(), how, recorded: None };
    let states: Vec<ProfileState> = profiles.list.iter().map(|p| state(&p.dir)).collect();
    if let Some(index) = states.iter().position(|s| matches!(s, ProfileState::Listening { .. })) {
        return Ok(pick(&profiles.list[index], Chosen::Listening));
    }
    let running: Vec<usize> = states.iter().enumerate().filter(|(_, s)| matches!(s, ProfileState::RunningNoBidi { .. })).map(|(i, _)| i).collect();
    if let [only] = running.as_slice() {
        return Ok(pick(&profiles.list[*only], Chosen::Running));
    }
    let defaults: Vec<&PathBuf> = profiles.install_defaults.iter().filter(|d| d.is_dir()).collect();
    let preferred = match defaults.as_slice() {
        [only] => Some(*only),
        many => many
            .iter()
            .find(|d| {
                let name = dir_name(d).to_lowercase();
                kind.profile_suffix().iter().any(|suffix| name.ends_with(suffix))
            })
            .or(many.first())
            .copied(),
    };
    if let Some(dir) = preferred {
        let name = profiles.list.iter().find(|p| same_dir(&p.dir, dir)).map(|p| p.name.clone()).unwrap_or_else(|| dir_name(dir));
        return Ok(Selected { dir: dir.clone(), name, how: Chosen::InstallDefault, recorded: None });
    }
    match profiles.list.as_slice() {
        [only] => Ok(pick(only, Chosen::Only)),
        [] => Err(SelectError::None),
        _ => Err(SelectError::Ambiguous(profiles.names())),
    }
}

/// The comment above the pref browse adds to a real profile.
pub const PREFS_MARKER: &str = "// browse: keeps Firefox's defaults (password autofill, Safe Browsing, extension updates, Sync) while browse drives it; browse uninstall removes it";
const RECOMMENDED_OFF: &str = "user_pref(\"remote.prefs.recommended\", false);";
const RESUME_ONCE: &str = "user_pref(\"browser.sessionstore.resume_session_once\", true);";

/// A pref's value as prefs.js sets it (the last line wins).
fn pref_value(text: &str, name: &str) -> Option<String> {
    let needle = format!("user_pref(\"{name}\",");
    text.lines().rev().find_map(|line| {
        let rest = line.trim().strip_prefix(&needle)?;
        Some(rest.trim().trim_end_matches(';').trim().trim_end_matches(')').trim().to_string())
    })
}

fn refuse_running(profile: &Path) -> io::Result<()> {
    match state(profile) {
        ProfileState::NotRunning => Ok(()),
        ProfileState::Unreadable(detail) => Err(io::Error::new(io::ErrorKind::PermissionDenied, detail)),
        _ => Err(io::Error::new(io::ErrorKind::WouldBlock, format!("the browser using {} is running; its prefs.js is changed only while it's closed", profile.display()))),
    }
}

fn read_prefs(profile: &Path) -> io::Result<String> {
    match std::fs::read_to_string(profile.join("prefs.js")) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(String::new()),
        other => other,
    }
}

fn append_prefs(profile: &Path, text: &str, lines: &[&str]) -> io::Result<()> {
    let mut out = text.to_string();
    if !out.is_empty() && !out.ends_with('\n') {
        out.push('\n');
    }
    for line in lines {
        out.push_str(line);
        out.push('\n');
    }
    std::fs::create_dir_all(profile)?;
    std::fs::write(profile.join("prefs.js"), out)
}

/// Adds `remote.prefs.recommended = false` (under browse's marker) to a real profile's prefs.js, so
/// `--remote-debugging-port` leaves its password autofill, Safe Browsing, extension updates and Sync alone. Only
/// while the profile isn't running. Returns whether it was added (false: the profile sets the pref already).
pub fn ensure_real_profile_prefs(profile: &Path) -> io::Result<bool> {
    refuse_running(profile)?;
    let text = read_prefs(profile)?;
    if pref_value(&text, "remote.prefs.recommended").is_some() {
        return Ok(false);
    }
    append_prefs(profile, &text, &[PREFS_MARKER, RECOMMENDED_OFF])?;
    Ok(true)
}

/// Asks the next start to restore the last session once (unless the profile restores it every time), so a relaunch
/// brings the user's windows back. Returns whether it was added.
pub fn ensure_resume_once(profile: &Path) -> io::Result<bool> {
    refuse_running(profile)?;
    let text = read_prefs(profile)?;
    if pref_value(&text, "browser.startup.page").as_deref() == Some("3") || pref_value(&text, "browser.sessionstore.resume_session_once").as_deref() == Some("true") {
        return Ok(false);
    }
    append_prefs(profile, &text, &[RESUME_ONCE])?;
    Ok(true)
}

/// Takes browse's `remote.prefs.recommended` line (and its marker) out of prefs.js, only while the profile isn't
/// running. Returns whether anything was removed.
pub fn remove_browse_prefs(profile: &Path) -> io::Result<bool> {
    refuse_running(profile)?;
    let text = read_prefs(profile)?;
    let kept: Vec<&str> = text.lines().filter(|line| line.trim() != PREFS_MARKER && line.trim() != RECOMMENDED_OFF).collect();
    if kept.len() == text.lines().count() {
        return Ok(false);
    }
    let mut out = kept.join("\n");
    if !out.is_empty() {
        out.push('\n');
    }
    std::fs::write(profile.join("prefs.js"), out)?;
    Ok(true)
}

/// What `nextStep` adds about Firefox when no browser is connected: a recorded profile that needs the user, else
/// a pointer to `browse firefox` when a Firefox-family app is installed.
pub fn next_step_hint(discovery: Option<&Discovery>, recorded: &[RecordedFirefox], busy: &[String]) -> Option<String> {
    for record in recorded {
        let name = record.display_name();
        match state(&record.profile) {
            ProfileState::RunningNoBidi { .. } => {
                return Some(format!(
                    " {name} is open without remote control: run `browse firefox --relaunch` to restart it for browse (ask the user first: private windows won't restore), or `browse firefox --dedicated` for a separate profile."
                ));
            }
            ProfileState::Unreadable(_) => {
                return Some(format!(" browse can't read {name}'s profile folder from here: ask the user to run `browse firefox` in their own terminal."));
            }
            ProfileState::Listening { .. } if busy.contains(&driver_key(&record.profile)) => {
                return Some(format!(" {name} already has another WebDriver BiDi client: close it, or run `browse firefox --relaunch` (ask the user first)."));
            }
            _ => {}
        }
    }
    let apps = discovery?.apps();
    apps.first().map(|app| format!(" Or run `browse firefox` to connect {}.", app.name))
}

#[cfg(test)]
#[path = "firefox_tests.rs"]
pub(crate) mod tests;
