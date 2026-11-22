//! Chrome-family browsers on this computer, which profiles have the browse extension, and opening pages in them
//! (cli/src/setup/browsers.ts).

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde_json::Value;

use crate::setup::home;

pub const STORE_ID: &str = "mfnicocicmmlkpjnaffgihfjhdgjkdjg";

pub fn store_id() -> String {
    std::env::var("OPENCODE_BROWSER_STORE_ID")
        .ok()
        .filter(|id| id.len() == 32 && id.bytes().all(|b| (b'a'..=b'p').contains(&b)))
        .unwrap_or_else(|| STORE_ID.into())
}

pub fn store_url() -> String {
    format!("https://chromewebstore.google.com/detail/{}", store_id())
}

pub struct Browser {
    pub name: &'static str,
    user_data: PathBuf,
    /// macOS: the app bundle name. Elsewhere: executable names on PATH, or full paths on Windows.
    launch: Vec<String>,
}

pub struct Match {
    pub browser: usize,
    pub profile: String,
    pub profile_name: String,
    pub enabled: bool,
}

pub fn browsers() -> Vec<Browser> {
    let home = home();
    if cfg!(target_os = "macos") {
        let support = home.join("Library/Application Support");
        return [
            ("Google Chrome", "Google Chrome", "Google/Chrome"),
            ("Google Chrome Beta", "Google Chrome Beta", "Google/Chrome Beta"),
            ("Google Chrome Canary", "Google Chrome Canary", "Google/Chrome Canary"),
            ("Chromium", "Chromium", "Chromium"),
            ("Microsoft Edge", "Microsoft Edge", "Microsoft Edge"),
            ("Brave", "Brave Browser", "BraveSoftware/Brave-Browser"),
            ("Opera", "Opera", "com.operasoftware.Opera"),
            ("Vivaldi", "Vivaldi", "Vivaldi"),
            ("Helium", "Helium", "net.imput.helium"),
            ("Arc", "Arc", "Arc/User Data"),
            ("Dia", "Dia", "Dia/User Data"),
            ("Comet", "Comet", "Comet"),
        ]
        .into_iter()
        .map(|(name, app, dir)| Browser { name, user_data: support.join(dir), launch: vec![app.into()] })
        .collect();
    }
    if cfg!(windows) {
        let env = |name: &str| std::env::var_os(name).map(PathBuf::from);
        let local = env("LOCALAPPDATA").unwrap_or_else(|| home.join("AppData/Local"));
        let roaming = env("APPDATA").unwrap_or_else(|| home.join("AppData/Roaming"));
        let programs: Vec<PathBuf> = [env("ProgramFiles"), env("ProgramFiles(x86)"), Some(local.clone())].into_iter().flatten().collect();
        let installs = |exe: &str| programs.iter().map(|dir| dir.join(exe).to_string_lossy().into_owned()).collect();
        return vec![
            Browser { name: "Google Chrome", user_data: local.join("Google/Chrome/User Data"), launch: installs("Google\\Chrome\\Application\\chrome.exe") },
            Browser { name: "Microsoft Edge", user_data: local.join("Microsoft/Edge/User Data"), launch: installs("Microsoft\\Edge\\Application\\msedge.exe") },
            Browser { name: "Brave", user_data: local.join("BraveSoftware/Brave-Browser/User Data"), launch: installs("BraveSoftware\\Brave-Browser\\Application\\brave.exe") },
            Browser { name: "Opera", user_data: roaming.join("Opera Software/Opera Stable"), launch: installs("Programs\\Opera\\opera.exe") },
            Browser { name: "Vivaldi", user_data: local.join("Vivaldi/User Data"), launch: installs("Vivaldi\\Application\\vivaldi.exe") },
            Browser { name: "Helium", user_data: local.join("imput/Helium/User Data"), launch: installs("imput\\Helium\\Application\\chrome.exe") },
        ];
    }
    let config = crate::setup::config_home();
    let chrome = std::env::var_os("CHROME_CONFIG_HOME").map(PathBuf::from).unwrap_or_else(|| config.clone());
    [
        ("Google Chrome", &chrome, "google-chrome", &["google-chrome", "google-chrome-stable"][..]),
        ("Google Chrome Beta", &chrome, "google-chrome-beta", &["google-chrome-beta"]),
        ("Google Chrome Unstable", &chrome, "google-chrome-unstable", &["google-chrome-unstable"]),
        ("Chromium", &chrome, "chromium", &["chromium", "chromium-browser"]),
        ("Microsoft Edge", &config, "microsoft-edge", &["microsoft-edge", "microsoft-edge-stable"]),
        ("Brave", &config, "BraveSoftware/Brave-Browser", &["brave-browser", "brave"]),
        ("Opera", &config, "opera", &["opera"]),
        ("Vivaldi", &config, "vivaldi", &["vivaldi", "vivaldi-stable"]),
        ("Helium", &config, "net.imput.helium", &["helium", "helium-browser"]),
    ]
    .into_iter()
    .map(|(name, root, dir, exes)| Browser { name, user_data: root.join(dir), launch: exes.iter().map(|e| (*e).into()).collect() })
    .collect()
}

fn read_json(file: &Path) -> Option<Value> {
    serde_json::from_slice(&std::fs::read(file).ok()?).ok()
}

/// Every profile, in every browser here, that has the store extension.
pub fn detect(browsers: &[Browser]) -> Vec<Match> {
    let id = store_id();
    let mut found = Vec::new();
    for (index, browser) in browsers.iter().enumerate() {
        let Some(state) = read_json(&browser.user_data.join("Local State")) else { continue };
        let profiles: Vec<(String, String)> = match state.pointer("/profile/info_cache").and_then(Value::as_object) {
            Some(cache) if !cache.is_empty() => cache
                .iter()
                .map(|(dir, info)| (dir.clone(), info.get("name").and_then(Value::as_str).unwrap_or(dir).to_owned()))
                .collect(),
            _ => vec![("Default".into(), "Default".into())],
        };
        for (dir, name) in profiles {
            let setting = ["Secure Preferences", "Preferences"]
                .iter()
                .filter_map(|file| read_json(&browser.user_data.join(&dir).join(file)))
                .find_map(|prefs| prefs.pointer(&format!("/extensions/settings/{id}")).cloned());
            let Some(setting) = setting else { continue };
            let enabled = match setting.get("disable_reasons") {
                Some(Value::Array(reasons)) => reasons.is_empty(),
                Some(Value::Number(n)) => n.as_u64() == Some(0),
                _ => true,
            };
            found.push(Match { browser: index, profile: dir, profile_name: name, enabled });
        }
    }
    found
}

pub fn on_path(name: &str) -> Option<PathBuf> {
    let exts: &[&str] = if cfg!(windows) { &[".exe", ".cmd", ""] } else { &[""] };
    std::env::split_paths(&std::env::var_os("PATH")?)
        .flat_map(|dir| exts.iter().map(move |ext| dir.join(format!("{name}{ext}"))))
        .find(|file| file.is_file())
}

fn spawn(program: impl AsRef<std::ffi::OsStr>, args: &[&str]) -> bool {
    Command::new(program).args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().is_ok()
}

/// Opens `url` in a specific browser (and profile); chrome-extension:// URLs only open this way.
pub fn open_in(browser: &Browser, url: &str, profile: Option<&str>) -> bool {
    let flag = profile.map(|p| format!("--profile-directory={p}"));
    let mut args: Vec<&str> = flag.iter().map(String::as_str).collect();
    args.push(url);
    if cfg!(target_os = "macos") {
        let app = &browser.launch[0];
        let bundle = [PathBuf::from("/Applications"), home().join("Applications")]
            .into_iter()
            .map(|dir| dir.join(format!("{app}.app/Contents/MacOS/{app}")))
            .find(|exe| exe.is_file());
        return match bundle {
            Some(exe) => spawn(exe, &args),
            None => url.starts_with("http") && Command::new("open").args(["-a", app, url]).status().is_ok_and(|s| s.success()),
        };
    }
    let exe = if cfg!(windows) {
        browser.launch.iter().map(PathBuf::from).find(|p| p.is_file())
    } else {
        browser.launch.iter().find_map(|name| on_path(name))
    };
    match exe {
        Some(exe) => spawn(exe, &args),
        None => url.starts_with("http") && open_default(url),
    }
}

pub fn open_default(url: &str) -> bool {
    if cfg!(target_os = "macos") {
        Command::new("open").arg(url).status().is_ok_and(|s| s.success())
    } else if cfg!(windows) {
        Command::new("rundll32").args(["url.dll,FileProtocolHandler", url]).status().is_ok_and(|s| s.success())
    } else {
        Command::new("xdg-open").arg(url).stdout(Stdio::null()).stderr(Stdio::null()).status().is_ok_and(|s| s.success())
    }
}
