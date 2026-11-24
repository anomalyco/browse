//! `browse chrome`: connects a standalone Chromium-family browser (dedicated clean profile, headless or headed,
//! or an existing `ws://` CDP endpoint) directly to the relay with no Chrome extension required.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use anyhow::{Context, bail};
use browse_relay::chrome::{self, RecordedChrome};
use serde_json::{Value, json};

use crate::browsers;
use crate::setup::tilde;
use crate::{relay, relay_api};

const WAIT: Duration = Duration::from_secs(30);

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Options {
    pub app: Option<String>,
    pub headless: bool,
    pub url: Option<String>,
}

pub fn parse(args: &[String]) -> anyhow::Result<Options> {
    let mut options = Options::default();
    let mut i = 0;
    while i < args.len() {
        let (flag, inline) = match args[i].split_once('=') {
            Some((flag, value)) if flag.starts_with("--") => (flag.to_string(), Some(value.to_string())),
            _ => (args[i].clone(), None),
        };
        i += 1;
        let mut value = |name: &str| -> anyhow::Result<String> {
            if let Some(value) = inline.clone() {
                return Ok(value);
            }
            let value = args
                .get(i)
                .filter(|v| !v.starts_with("--"))
                .cloned()
                .with_context(|| format!("{name} needs a value"))?;
            i += 1;
            Ok(value)
        };
        match flag.as_str() {
            "--app" => options.app = Some(value("--app")?),
            "--url" => options.url = Some(value("--url")?),
            "--headless" => options.headless = true,
            // Standalone Chrome always uses browse's dedicated profile; accept --dedicated as a no-op alias.
            "--dedicated" => {}
            other => bail!("Unknown option {other} for chrome. Run `browse --help`."),
        }
    }
    if options.url.is_some() && (options.app.is_some() || options.headless) {
        bail!("--url connects an already-running CDP endpoint; it can't be combined with --app or --headless");
    }
    Ok(options)
}

pub fn command(args: &[String]) -> anyhow::Result<i32> {
    connect(&parse(args)?)
}

#[derive(Debug, Clone)]
struct ChromeApp {
    name: String,
    slug: String,
    exe: PathBuf,
}

fn app_at(path: &Path) -> Option<ChromeApp> {
    if path.extension().is_some_and(|e| e == "app") && path.is_dir() {
        let stem = path.file_stem()?.to_string_lossy().into_owned();
        let macos = path.join("Contents").join("MacOS");
        let exe = [stem.as_str(), "Google Chrome", "Google Chrome for Testing", "Chromium", "Brave Browser", "Microsoft Edge"]
            .into_iter()
            .map(|n| macos.join(n))
            .find(|p| p.is_file())
            .or_else(|| {
                std::fs::read_dir(&macos)
                    .ok()?
                    .filter_map(Result::ok)
                    .map(|e| e.path())
                    .find(|p| p.is_file())
            })?;
        let name = short_name(&stem);
        return Some(ChromeApp { slug: slug_of(&name), name, exe });
    }
    if path.is_file() {
        let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "Chrome".into());
        let name = short_name(&stem);
        return Some(ChromeApp { slug: slug_of(&name), name, exe: path.to_path_buf() });
    }
    None
}

fn short_name(raw: &str) -> String {
    let lower = raw.to_lowercase();
    if lower.contains("brave") {
        "Brave".into()
    } else if lower.contains("edge") || lower == "msedge" {
        "Edge".into()
    } else if lower.contains("vivaldi") {
        "Vivaldi".into()
    } else if lower.contains("helium") {
        "Helium".into()
    } else if lower.contains("arc") {
        "Arc".into()
    } else if lower.contains("chromium") {
        "Chromium".into()
    } else if lower.contains("chrome") {
        "Chrome".into()
    } else {
        raw.to_string()
    }
}

fn slug_of(name: &str) -> String {
    name.to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .trim_matches('-')
        .to_string()
}

fn installed_apps() -> Vec<ChromeApp> {
    let mut apps = Vec::new();
    for browser in browsers::browsers() {
        if let Some(exe) = find_browser_exe(&browser) {
            let name = short_name(browser.name);
            apps.push(ChromeApp { slug: slug_of(&name), name, exe });
        }
    }
    apps
}

fn find_browser_exe(browser: &browsers::Browser) -> Option<PathBuf> {
    if cfg!(target_os = "macos") {
        let home = crate::setup::home();
        for app_name in browser.launch_names() {
            for dir in [PathBuf::from("/Applications"), home.join("Applications")] {
                let bundle = dir.join(format!("{app_name}.app"));
                if let Some(app) = app_at(&bundle) {
                    return Some(app.exe);
                }
            }
        }
        return None;
    }
    if cfg!(windows) {
        return browser.launch_names().iter().map(PathBuf::from).find(|p| p.is_file());
    }
    browser.launch_names().iter().find_map(|name| browsers::on_path(name))
}

fn resolve_app(wanted: Option<&str>, recorded: &[RecordedChrome]) -> Result<ChromeApp, String> {
    let installed = installed_apps();
    let list = || {
        if installed.is_empty() {
            "No Chrome-family browser was found here. Install Chrome or Chromium, or pass --app <path>.".to_string()
        } else {
            let names: Vec<&str> = installed.iter().map(|a| a.name.as_str()).collect();
            format!("Found here: {}.", names.join(", "))
        }
    };
    match wanted {
        Some(wanted) => {
            if let Some(app) = app_at(Path::new(wanted)) {
                return Ok(app);
            }
            let needle = wanted.trim().to_lowercase();
            installed
                .iter()
                .find(|a| a.slug == needle || a.name.to_lowercase() == needle || a.name.to_lowercase().contains(&needle))
                .cloned()
                .ok_or_else(|| format!("--app {wanted:?} didn't match an installed Chrome-family browser or executable. {}", list()))
        }
        None => {
            if let Some(rec) = recorded.first()
                && rec.exe.is_file()
            {
                let name = rec.display_name();
                return Ok(ChromeApp { slug: slug_of(&name), name, exe: rec.exe.clone() });
            }
            installed.first().cloned().ok_or_else(list)
        }
    }
}

pub fn connect(options: &Options) -> anyhow::Result<i32> {
    relay::ensure()?;
    if let Some(url) = &options.url {
        return connect_url(url);
    }
    let paths = relay_api::paths();
    let recorded = chrome::read_recorded(&paths);
    let app = match resolve_app(options.app.as_deref(), &recorded) {
        Ok(app) => app,
        Err(message) => {
            eprintln!("{message}");
            return Ok(2);
        }
    };
    let profile = chrome::dedicated_profile(&paths, &app.slug);
    let key = chrome::driver_key(&profile);
    if let Some(browser) = connected(&key) {
        println!(
            "✓ Already connected: {} ({}) drives the standalone profile at {}.",
            text(&browser, "name"),
            text(&browser, "id"),
            tilde(&profile)
        );
        return Ok(0);
    }
    if let Some(url) = chrome::live_url(&profile) {
        return attach(&app, &profile, &url, options.headless);
    }
    std::fs::create_dir_all(&profile).with_context(|| format!("creating {}", profile.display()))?;
    // Remove stale discovery files before starting so wait_listening only sees this launch.
    let _ = std::fs::remove_file(profile.join("DevToolsActivePort"));
    let log_path = profile.join("devtools.log");
    let _ = std::fs::remove_file(&log_path);
    let mode = if options.headless { " headless" } else { "" };
    println!("Starting {}{mode} with a standalone profile at {}…", app.name, tilde(&profile));
    launch(&app.exe, &profile, &log_path, options.headless)?;
    match wait_listening(&profile, &log_path) {
        Some(url) => attach(&app, &profile, &url, options.headless),
        None => {
            let tail = std::fs::read_to_string(&log_path)
                .ok()
                .map(|s| s.lines().rev().take(6).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join(" | "))
                .filter(|s| !s.is_empty());
            if let Some(tail) = tail {
                eprintln!("! {} didn't open a DevTools port within {} s ({tail}). Close it and run `browse chrome` again.", app.name, WAIT.as_secs());
            } else {
                eprintln!("! {} didn't open a DevTools port within {} s. Close it and run `browse chrome` again.", app.name, WAIT.as_secs());
            }
            Ok(1)
        }
    }
}

fn launch_profile_path(profile: &Path) -> OsString {
    #[cfg(windows)]
    if let Some(stripped) = profile.to_str().and_then(|s| s.strip_prefix("\\\\?\\")) {
        return OsString::from(stripped);
    }
    profile.as_os_str().to_os_string()
}

fn launch_args(profile: &Path, headless: bool) -> Vec<OsString> {
    let mut args: Vec<OsString> = vec![
        OsString::from(format!("--user-data-dir={}", launch_profile_path(profile).to_string_lossy())),
        "--remote-debugging-port=0".into(),
        "--no-first-run".into(),
        "--no-default-browser-check".into(),
        "--disable-background-timer-throttling".into(),
        "--disable-renderer-backgrounding".into(),
        "--disable-backgrounding-occluded-windows".into(),
    ];
    #[cfg(target_os = "macos")]
    {
        args.push("--use-mock-keychain".into());
        args.push("--password-store=basic".into());
    }
    if headless {
        args.push("--headless=new".into());
        args.push("--disable-gpu".into());
        #[cfg(target_os = "macos")]
        args.push("--disable-renderer-accessibility".into());
    }
    args.push("about:blank".into());
    args
}

fn launch(exe: &Path, profile: &Path, log_path: &Path, headless: bool) -> anyhow::Result<()> {
    let stderr = std::fs::File::create(log_path).map(Stdio::from).unwrap_or_else(|_| Stdio::null());
    let mut command = Command::new(exe);
    command
        .args(launch_args(profile, headless))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(stderr);
    detach(&mut command);
    command.spawn().with_context(|| format!("couldn't start {}", exe.display()))?;
    Ok(())
}

#[cfg(unix)]
fn detach(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    // SAFETY: setsid is async-signal-safe.
    unsafe {
        command.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
}

#[cfg(windows)]
fn detach(command: &mut Command) {
    use std::ffi::c_void;
    use std::os::windows::process::CommandExt;

    const DETACHED_PROCESS: u32 = 0x8;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x200;
    const STD_INPUT_HANDLE: u32 = 0xFFFF_FFF6;
    const STD_OUTPUT_HANDLE: u32 = 0xFFFF_FFF5;
    const STD_ERROR_HANDLE: u32 = 0xFFFF_FFF4;
    const HANDLE_FLAG_INHERIT: u32 = 0x0000_0001;

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetStdHandle(n_std_handle: u32) -> *mut c_void;
        fn SetHandleInformation(h_object: *mut c_void, dw_mask: u32, dw_flags: u32) -> i32;
    }

    for std_handle in [STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE] {
        // SAFETY: standard handle query + clearing inherit bit for child processes only.
        unsafe {
            let handle = GetStdHandle(std_handle);
            if !handle.is_null() && handle as isize != -1 {
                let _ = SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0);
            }
        }
    }

    command.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
}

fn parse_devtools_log(text: &str) -> Option<String> {
    text.lines().find_map(|line| {
        let url = line.trim().strip_prefix("DevTools listening on ")?.trim();
        let rest = url.strip_prefix("ws://")?;
        let (host_port, path) = rest.split_once('/')?;
        let (host, port) = host_port.rsplit_once(':')?;
        if !matches!(host, "127.0.0.1" | "localhost" | "[::1]") || port.parse::<u16>().ok().filter(|p| *p > 0).is_none() {
            return None;
        }
        if !path.starts_with("devtools/browser/") || path.chars().any(|c| c.is_control() || c.is_whitespace()) {
            return None;
        }
        Some(format!("ws://127.0.0.1:{port}/{path}"))
    })
}

fn wait_listening(profile: &Path, log_path: &Path) -> Option<String> {
    let deadline = Instant::now() + WAIT;
    while Instant::now() < deadline {
        if let Some(url) = chrome::live_url(profile) {
            return Some(url);
        }
        if let Ok(text) = std::fs::read_to_string(log_path)
            && let Some(url) = parse_devtools_log(&text)
        {
            // Persist DevToolsActivePort when Chrome only announced the endpoint on stderr (e.g. headless Windows).
            if let Some(rest) = url.strip_prefix("ws://127.0.0.1:")
                && let Some((port, path)) = rest.split_once('/')
            {
                let _ = std::fs::write(profile.join("DevToolsActivePort"), format!("{port}\n/{path}\n"));
            }
            if chrome::live_url(profile).is_some() {
                return Some(url);
            }
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    None
}

fn attach(app: &ChromeApp, profile: &Path, url: &str, headless: bool) -> anyhow::Result<i32> {
    let key = chrome::driver_key(profile);
    let body = json!({ "protocol": "cdp", "url": url, "key": key, "name": app.name });
    let (status, answer) = relay::drivers("connect", &body)?;
    if status != 200 {
        eprintln!("! Couldn't connect {}: {}", app.name, answer["error"].as_str().unwrap_or("the relay refused"));
        return Ok(1);
    }
    let record = RecordedChrome {
        exe: app.exe.clone(),
        profile: profile.to_path_buf(),
        headless,
        name: Some(app.name.clone()),
    };
    chrome::record(&relay_api::paths(), record).context("couldn't record the connected standalone Chrome profile")?;
    let browser = &answer["browser"];
    println!(
        "✓ Connected {} ({}) to browse as `{}`. Ask your agent to open a page.",
        app.name,
        tilde(profile),
        text(browser, "id")
    );
    Ok(0)
}

fn connect_url(url: &str) -> anyhow::Result<i32> {
    let (status, answer) = relay::drivers("connect", &json!({ "protocol": "cdp", "url": url }))?;
    if status != 200 {
        eprintln!("! Couldn't connect {url}: {}", answer["error"].as_str().unwrap_or("the relay refused"));
        return Ok(1);
    }
    let browser = &answer["browser"];
    let already = if answer["existing"] == true { "Already connected" } else { "Connected" };
    println!("✓ {already}: {} ({}) at {}", text(browser, "name"), text(browser, "id"), text(browser, "endpoint"));
    Ok(0)
}

fn text(value: &Value, key: &str) -> String {
    value.get(key).and_then(Value::as_str).unwrap_or("?").to_string()
}

fn connected(key: &str) -> Option<Value> {
    let status = relay::extension_status(false)?;
    status["browsers"]
        .as_array()?
        .iter()
        .find(|b| b["driver"] != "cdp-extension" && b["connected"] == true && b["key"] == key)
        .cloned()
}

/// `browse uninstall`'s part: quits any browse-launched standalone Chrome instances before deleting browse's files.
pub fn uninstall() -> i32 {
    let paths = relay_api::paths();
    let recorded = chrome::read_recorded(&paths);
    if recorded.is_empty() {
        return 0;
    }
    let _ = std::fs::remove_file(chrome::recorded_path(&paths));
    let mut status = 0;
    for record in &recorded {
        let Some(url) = chrome::live_url(&record.profile) else { continue };
        let key = chrome::driver_key(&record.profile);
        let quit = relay::drivers("connect", &json!({ "protocol": "cdp", "url": url, "key": key, "name": record.display_name() }))
            .and_then(|(code, answer)| if code == 200 { relay::drivers("disconnect", &json!({ "browser": key, "quit": true })) } else { Ok((code, answer)) });
        match quit {
            Ok((200, answer)) if answer["quit"] == true => {
                let deadline = Instant::now() + Duration::from_secs(10);
                while chrome::live_url(&record.profile).is_some() && Instant::now() < deadline {
                    std::thread::sleep(Duration::from_millis(100));
                }
                println!("✓ Quit browse's {} ({})", record.display_name(), tilde(&record.profile));
            }
            _ => {
                println!("! Couldn't quit browse's {} ({}); quit it yourself.", record.display_name(), tilde(&record.profile));
                status = 1;
            }
        }
    }
    status
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn flags() {
        assert_eq!(parse(&[]).unwrap(), Options::default());
        assert_eq!(parse(&args(&["--headless", "--app", "brave"])).unwrap(), Options { app: Some("brave".into()), headless: true, url: None });
        assert_eq!(parse(&args(&["--dedicated"])).unwrap(), Options::default());
        assert_eq!(
            parse(&args(&["--url", "ws://127.0.0.1:9222/devtools/browser/1"])).unwrap().url.as_deref(),
            Some("ws://127.0.0.1:9222/devtools/browser/1")
        );
        assert!(parse(&args(&["--url", "ws://127.0.0.1:9222/devtools/browser/1", "--headless"])).is_err());
        assert!(parse(&args(&["--bogus"])).is_err());
    }

    #[test]
    fn launch_arguments() {
        let headed = launch_args(Path::new("/tmp/p"), false);
        assert!(headed.contains(&OsString::from("--user-data-dir=/tmp/p")));
        assert!(headed.contains(&OsString::from("--remote-debugging-port=0")));
        assert!(!headed.contains(&OsString::from("--headless=new")));
        let headless = launch_args(Path::new("/tmp/p"), true);
        assert!(headless.contains(&OsString::from("--headless=new")));
        assert!(headless.contains(&OsString::from("--disable-gpu")));
    }

    #[test]
    fn parses_devtools_stderr_log() {
        assert_eq!(
            parse_devtools_log("noise\nDevTools listening on ws://127.0.0.1:54321/devtools/browser/abc-123\n"),
            Some("ws://127.0.0.1:54321/devtools/browser/abc-123".to_string())
        );
        assert_eq!(parse_devtools_log("DevTools listening on ws://evil.com:9222/devtools/browser/abc"), None);
    }
}
