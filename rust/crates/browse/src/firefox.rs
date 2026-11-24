//! `browse firefox` and `browse disconnect`: connect a Firefox-family browser (Firefox, Developer Edition, Nightly,
//! Zen) to the relay over WebDriver BiDi, starting it with `--remote-debugging-port` when it isn't listening, and let
//! it go again.

use std::ffi::OsString;
use std::io::{BufRead, IsTerminal, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use anyhow::{Context, bail};
use browse_relay::firefox::{self, App, AppKind, Discovery, ProfileState, RecordedFirefox, SelectError};
use serde_json::{Value, json};

use crate::setup::tilde;
use crate::{relay, relay_api};

/// How long a starting (or quitting) browser gets.
const WAIT: Duration = Duration::from_secs(60);

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Options {
    pub app: Option<String>,
    pub profile: Option<String>,
    pub dedicated: bool,
    pub headless: bool,
    pub relaunch: bool,
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
            let value = args.get(i).filter(|v| !v.starts_with("--")).cloned().with_context(|| format!("{name} needs a value"))?;
            i += 1;
            Ok(value)
        };
        match flag.as_str() {
            "--app" => options.app = Some(value("--app")?),
            "--profile" => options.profile = Some(value("--profile")?),
            "--url" => options.url = Some(value("--url")?),
            "--dedicated" => options.dedicated = true,
            "--headless" => options.headless = true,
            "--relaunch" => options.relaunch = true,
            other => bail!("Unknown option {other} for firefox. Run `browse --help`."),
        }
    }
    if options.headless {
        options.dedicated = true;
    }
    if options.dedicated && options.profile.is_some() {
        bail!("--dedicated uses browse's own profile; it can't be combined with --profile");
    }
    if options.relaunch && options.dedicated {
        bail!("--relaunch restarts your own profile; it can't be combined with --dedicated or --headless");
    }
    Ok(options)
}

pub fn command(args: &[String]) -> anyhow::Result<i32> {
    connect(&parse(args)?)
}

/// The app `--app` names (an id or a path), else the recorded one, else the first installed.
fn resolve_app(discovery: &Discovery, wanted: Option<&str>, recorded: &[RecordedFirefox]) -> Result<App, String> {
    let installed = discovery.apps();
    let list = || {
        if installed.is_empty() {
            "No Firefox, Firefox Developer Edition, Firefox Nightly or Zen is installed here. Install Firefox from https://www.mozilla.org/firefox/, or name one with --app <path>.".to_string()
        } else {
            format!("Installed: {}.", installed.iter().map(|a| format!("{} (--app {})", a.name, a.kind.id())).collect::<Vec<_>>().join(", "))
        }
    };
    match wanted.map(str::trim).filter(|w| !w.is_empty()) {
        Some(wanted) => {
            if let Some(kind) = AppKind::parse(wanted) {
                return installed.iter().find(|a| a.kind == kind).cloned().ok_or_else(|| format!("{} isn't installed here. {}", kind.name(), list()));
            }
            App::at(Path::new(wanted)).ok_or_else(|| format!("--app {wanted:?} is neither firefox, dev, nightly or zen, nor a Firefox app or executable. {}", list()))
        }
        None => {
            let remembered = recorded.iter().filter_map(|r| r.kind()).find_map(|kind| installed.iter().find(|a| a.kind == kind));
            remembered.or(installed.first()).cloned().ok_or_else(list)
        }
    }
}

/// What `browse firefox` works on.
#[derive(Debug, Clone)]
struct Target {
    app: App,
    profile: PathBuf,
    dedicated: bool,
    headless: bool,
}

impl Target {
    fn app_flag(&self) -> String {
        if self.app.kind == AppKind::Firefox { String::new() } else { format!(" --app {}", self.app.kind.id()) }
    }
}

pub fn connect(options: &Options) -> anyhow::Result<i32> {
    relay::ensure()?;
    if let Some(url) = &options.url {
        return connect_url(url);
    }
    let paths = relay_api::paths();
    let discovery = Discovery::system();
    let recorded = firefox::read_recorded(&paths);
    let app = match resolve_app(&discovery, options.app.as_deref(), &recorded) {
        Ok(app) => app,
        Err(message) => {
            eprintln!("{message}");
            return Ok(2);
        }
    };
    let target = if options.dedicated {
        Target { profile: firefox::dedicated_profile(&paths, app.kind), app, dedicated: true, headless: options.headless }
    } else {
        match firefox::select_profile(app.kind, options.profile.as_deref(), &recorded, discovery.profiles(app.kind), &discovery.home, firefox::state) {
            Ok(selected) => {
                let (dedicated, headless) = selected.recorded.as_ref().map_or((false, false), |r| (r.dedicated, r.headless));
                Target { app, profile: selected.dir, dedicated, headless }
            }
            Err(SelectError::PermissionDenied(detail)) => {
                eprintln!("{}", unreadable(&app.name, &detail));
                return Ok(1);
            }
            Err(SelectError::None) => {
                eprintln!("{} has no profile yet. Open it once and run `browse firefox` again, or use `browse firefox --dedicated` for a separate browse profile.", app.name);
                return Ok(2);
            }
            Err(error @ (SelectError::Ambiguous(_) | SelectError::NotFound { .. })) => {
                eprintln!("{} has {error}.", app.name);
                return Ok(2);
            }
        }
    };
    if let Some(browser) = connected(&firefox::driver_key(&target.profile)) {
        println!("✓ Already connected: {} ({}) drives the profile at {}.", text(&browser, "name"), text(&browser, "id"), tilde(&target.profile));
        return Ok(0);
    }
    run(target, options.relaunch)
}

fn text(value: &Value, key: &str) -> String {
    value.get(key).and_then(Value::as_str).unwrap_or("?").to_string()
}

/// The relay's connected direct browsers.
fn direct_browsers() -> Vec<Value> {
    let Some(status) = relay::extension_status(false) else { return Vec::new() };
    status["browsers"].as_array().into_iter().flatten().filter(|b| b["driver"] != "cdp-extension" && b["connected"] == true).cloned().collect()
}

fn connected(key: &str) -> Option<Value> {
    direct_browsers().into_iter().find(|b| b["key"] == key)
}

fn unreadable(name: &str, detail: &str) -> String {
    format!("! browse can't read {name}'s profile folder ({detail}). Run `browse firefox` in your own terminal so it can read Firefox's profile folder.")
}

fn tty() -> bool {
    std::io::stdin().is_terminal() && std::io::stdout().is_terminal()
}

enum Choice {
    Relaunch,
    Dedicated,
    Cancel,
}

fn run(target: Target, relaunch: bool) -> anyhow::Result<i32> {
    let name = target.app.name.clone();
    match firefox::state(&target.profile) {
        ProfileState::Listening { url, .. } => attach(&target, &url, false),
        ProfileState::Unreadable(detail) => {
            eprintln!("{}", unreadable(&name, &detail));
            Ok(1)
        }
        ProfileState::NotRunning => start(&target),
        ProfileState::RunningNoBidi { .. } if target.dedicated => {
            eprintln!("! browse's {name} profile ({}) is open without remote control. Quit that {name} window, then run `browse firefox --dedicated{}` again.", tilde(&target.profile), target.app_flag());
            Ok(1)
        }
        ProfileState::RunningNoBidi { pid } => {
            let choice = if relaunch {
                Choice::Relaunch
            } else if tty() {
                ask(&name)?
            } else {
                println!("{name} is open without remote control, so browse can't connect to it yet. Either:");
                println!("  browse firefox --relaunch{}     restart {name} for browse; its windows and tabs come back (private windows don't)", target.app_flag());
                println!("  browse firefox --dedicated{}    use a separate browse profile instead (none of your sign-ins)", target.app_flag());
                println!("Agent: ask the user before running --relaunch (private windows won't restore).");
                return Ok(2);
            };
            match choice {
                Choice::Relaunch => relaunch_now(&target, pid),
                Choice::Dedicated => {
                    let paths = relay_api::paths();
                    let dedicated = Target { profile: firefox::dedicated_profile(&paths, target.app.kind), dedicated: true, headless: false, app: target.app };
                    if let Some(browser) = connected(&firefox::driver_key(&dedicated.profile)) {
                        println!("✓ Already connected: {} ({}).", text(&browser, "name"), text(&browser, "id"));
                        return Ok(0);
                    }
                    run(dedicated, false)
                }
                Choice::Cancel => {
                    println!("Cancelled; nothing changed.");
                    Ok(1)
                }
            }
        }
    }
}

fn ask(name: &str) -> anyhow::Result<Choice> {
    println!("{name} is open without remote control, so browse can't connect to it yet.");
    print!("[r]elaunch {name} with session restore (private windows won't restore) / [d]edicated clean profile / [c]ancel: ");
    std::io::stdout().flush()?;
    let mut line = String::new();
    std::io::stdin().lock().read_line(&mut line)?;
    Ok(match line.trim().to_lowercase().chars().next() {
        Some('r') => Choice::Relaunch,
        Some('d') => Choice::Dedicated,
        _ => Choice::Cancel,
    })
}

/// First-run noise a dedicated profile doesn't need. browse's own profile keeps Firefox's recommended remote prefs.
const DEDICATED_PREFS: &str = r#"user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("browser.startup.homepage_override.mstone", "ignore");
user_pref("datareporting.policy.dataSubmissionEnabled", false);
user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);
user_pref("browser.aboutwelcome.enabled", false);
user_pref("trailhead.firstrun.didSeeAboutWelcome", true);
"#;

/// Starts a browser that isn't running, with WebDriver BiDi on, and connects it.
fn start(target: &Target) -> anyhow::Result<i32> {
    let mut prefs_added = false;
    if target.dedicated {
        browse_relay::paths::ensure_private_dir(&target.profile)?;
        let user = target.profile.join("user.js");
        if !user.exists() {
            std::fs::write(&user, DEDICATED_PREFS)?;
        }
    } else {
        prefs_added = match firefox::ensure_real_profile_prefs(&target.profile) {
            Ok(added) => added,
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
                eprintln!("{}", unreadable(&target.app.name, &error.to_string()));
                return Ok(1);
            }
            Err(error) => bail!("couldn't prepare {}: {error}", tilde(&target.profile)),
        };
    }
    launch_and_attach(target, prefs_added)
}

fn launch_and_attach(target: &Target, prefs_added: bool) -> anyhow::Result<i32> {
    let mode = if target.headless { " headless" } else { "" };
    println!("Starting {}{mode} with the profile at {}…", target.app.name, tilde(&target.profile));
    launch(target)?;
    match wait_listening(&target.profile)? {
        Some(url) => attach(target, &url, prefs_added),
        None => {
            eprintln!("! {} didn't start listening for browse within {} s. Close it and run `browse firefox` again.", target.app.name, WAIT.as_secs());
            Ok(1)
        }
    }
}

/// Strips the Windows `\\?\` verbatim path prefix before passing a profile path to Firefox.
fn launch_profile_path(profile: &Path) -> OsString {
    #[cfg(windows)]
    if let Some(stripped) = profile.to_str().and_then(|s| s.strip_prefix("\\\\?\\")) {
        return OsString::from(stripped);
    }
    profile.as_os_str().to_os_string()
}

/// The arguments a browser starts with.
fn launch_args(target: &Target) -> Vec<OsString> {
    let mut args: Vec<OsString> = vec!["--profile".into(), launch_profile_path(&target.profile), "--remote-debugging-port".into(), "0".into()];
    if target.dedicated {
        args.push("--no-remote".into());
    }
    if target.headless {
        args.push("--headless".into());
    }
    args
}

fn launch(target: &Target) -> anyhow::Result<()> {
    let args = launch_args(target);
    // A window on macOS opens through Launch Services, so it is the user's app (Dock, menu bar), not browse's child.
    if cfg!(target_os = "macos")
        && !target.headless
        && let Some(bundle) = &target.app.bundle
    {
        let status = Command::new("open").arg("-n").arg("-a").arg(bundle).arg("--args").args(&args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status()?;
        if !status.success() {
            bail!("couldn't open {} ({status})", bundle.display());
        }
        return Ok(());
    }
    let mut command = Command::new(&target.app.exe);
    command.args(&args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    detach(&mut command);
    // The child may exit at once (an update re-executes Firefox): the profile's state says when it's ready.
    command.spawn().with_context(|| format!("couldn't start {}", target.app.exe.display()))?;
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

    // Rust's Command::spawn passes bInheritHandles = TRUE on Windows when stdio is redirected to Stdio::null(),
    // which otherwise leaks browse's parent stdout/stderr pipe handles into the detached Firefox process and hangs
    // piped callers (Command::output, PowerShell, Node/Bun) until Firefox exits.
    for std_handle in [STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE] {
        // SAFETY: GetStdHandle returns NULL or INVALID_HANDLE_VALUE (-1) on failure; SetHandleInformation only
        // clears HANDLE_FLAG_INHERIT for child processes without affecting browse's own I/O.
        unsafe {
            let handle = GetStdHandle(std_handle);
            if !handle.is_null() && handle as isize != -1 {
                let _ = SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0);
            }
        }
    }

    command.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
}

/// Waits for the profile to listen for WebDriver BiDi; None when it doesn't within WAIT.
fn wait_listening(profile: &Path) -> anyhow::Result<Option<String>> {
    let deadline = Instant::now() + WAIT;
    while Instant::now() < deadline {
        match firefox::state(profile) {
            ProfileState::Listening { url, .. } => return Ok(Some(url)),
            ProfileState::Unreadable(detail) => bail!("browse can't read {}: {detail}", tilde(profile)),
            _ => std::thread::sleep(Duration::from_millis(250)),
        }
    }
    Ok(None)
}

/// Asks a running browser to quit (never killing it), waits for its profile to be free, and starts it again with
/// remote control and its session restored once.
fn relaunch_now(target: &Target, pid: Option<u32>) -> anyhow::Result<i32> {
    let name = &target.app.name;
    match pid.filter(|_| cfg!(target_os = "macos")) {
        Some(pid) => {
            println!("Quitting {name} (it asks about anything unsaved)…");
            let script = format!("ObjC.import(\"AppKit\"); $.NSRunningApplication.runningApplicationWithProcessIdentifier({pid}).terminate");
            let _ = Command::new("osascript").args(["-l", "JavaScript", "-e", &script]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status();
        }
        None => println!("Quit {name} now (its menu → Quit, or Ctrl+Q); browse waits up to {} s and opens it again with your tabs.", WAIT.as_secs()),
    }
    let deadline = Instant::now() + WAIT;
    loop {
        match firefox::state(&target.profile) {
            ProfileState::NotRunning => break,
            ProfileState::Unreadable(detail) => {
                eprintln!("{}", unreadable(name, &detail));
                return Ok(1);
            }
            _ if Instant::now() > deadline => {
                eprintln!("! {name} is still running. Quit it, then run `browse firefox --relaunch{}` again.", target.app_flag());
                return Ok(1);
            }
            _ => std::thread::sleep(Duration::from_millis(250)),
        }
    }
    let prefs_added = firefox::ensure_real_profile_prefs(&target.profile).with_context(|| format!("couldn't prepare {}", tilde(&target.profile)))?;
    firefox::ensure_resume_once(&target.profile).with_context(|| format!("couldn't prepare {}", tilde(&target.profile)))?;
    launch_and_attach(target, prefs_added)
}

/// Connects a listening browser to the relay and records it.
fn attach(target: &Target, url: &str, prefs_added: bool) -> anyhow::Result<i32> {
    let key = firefox::driver_key(&target.profile);
    let body = json!({ "protocol": "webdriver-bidi", "url": url, "key": key, "name": target.app.name });
    let (status, answer) = relay::drivers("connect", &body)?;
    if status == 409 && answer["code"] == "driver-session-busy" {
        eprintln!(
            "! {} already has a WebDriver BiDi session: another tool holds it, or an earlier one wasn't ended. Close that tool, or run `browse firefox --relaunch{}` to restart {} (ask first: private windows won't restore).",
            target.app.name,
            target.app_flag(),
            target.app.name
        );
        return Ok(1);
    }
    if status != 200 {
        eprintln!("! Couldn't connect {}: {}", target.app.name, answer["error"].as_str().unwrap_or("the relay refused"));
        return Ok(1);
    }
    let record = RecordedFirefox {
        app: target.app.kind.id().into(),
        exe: target.app.bundle.clone().unwrap_or_else(|| target.app.exe.clone()),
        profile: target.profile.clone(),
        dedicated: target.dedicated,
        headless: target.headless,
        name: Some(target.app.name.clone()),
        prefs_added,
    };
    firefox::record(&relay_api::paths(), record).context("couldn't record the connected profile")?;
    let browser = &answer["browser"];
    println!("✓ Connected {} ({}) to browse as `{}`. Ask your agent to open a page.", target.app.name, tilde(&target.profile), text(browser, "id"));
    println!("  While browse drives it, {} shows a robot icon in the address bar and pages see navigator.webdriver = true.", target.app.name);
    Ok(0)
}

fn connect_url(url: &str) -> anyhow::Result<i32> {
    let (status, answer) = relay::drivers("connect", &json!({ "protocol": "webdriver-bidi", "url": url }))?;
    if status != 200 {
        eprintln!("! Couldn't connect {url}: {}", answer["error"].as_str().unwrap_or("the relay refused"));
        return Ok(1);
    }
    let browser = &answer["browser"];
    let already = if answer["existing"] == true { "Already connected" } else { "Connected" };
    println!("✓ {already}: {} ({}) at {}", text(browser, "name"), text(browser, "id"), text(browser, "endpoint"));
    Ok(0)
}

/// `browse disconnect [browser]`: lets a directly driven browser go (quitting one browse started headless) and
/// forgets its profile, so the relay doesn't attach it again.
pub fn disconnect(args: &[String]) -> anyhow::Result<i32> {
    if let Some(flag) = args.iter().find(|a| a.starts_with('-')) {
        bail!("Unknown option {flag} for disconnect. Run `browse --help`.");
    }
    if args.len() > 1 {
        bail!("disconnect takes one browser (its id or name)");
    }
    let paths = relay_api::paths();
    let browsers = match relay::probe() {
        relay::Probe::Running(_) => direct_browsers(),
        _ => Vec::new(),
    };
    let chosen = match args.first() {
        Some(wanted) => {
            let lower = wanted.trim().to_lowercase();
            browsers.iter().find(|b| b["id"] == lower.as_str() || text(b, "name").to_lowercase() == lower || b["endpoint"] == wanted.as_str()).cloned()
        }
        None if browsers.len() > 1 => {
            println!("Several browsers are connected directly; name one:");
            for browser in &browsers {
                println!("  browse disconnect {}    {}", text(browser, "id"), text(browser, "name"));
            }
            return Ok(2);
        }
        None => browsers.first().cloned(),
    };
    let Some(browser) = chosen else {
        println!("{}", match args.first() {
            Some(wanted) => format!("No directly connected browser is called {wanted:?}."),
            None => "No browser is connected directly.".into(),
        });
        return Ok(1);
    };
    let key = text(&browser, "key");
    let recorded = firefox::read_recorded(&paths).into_iter().find(|r| firefox::driver_key(&r.profile) == key);
    let quit = recorded.as_ref().is_some_and(|r| r.dedicated && r.headless);
    // Forgotten first, so the relay doesn't attach it again the moment it's let go.
    if let Some(record) = &recorded {
        firefox::forget(&paths, &record.profile)?;
    }
    let (status, answer) = relay::drivers("disconnect", &json!({ "browser": text(&browser, "id"), "quit": quit }))?;
    if status != 200 || answer["disconnected"] != true {
        eprintln!("! Couldn't disconnect {}: {}", text(&browser, "name"), answer["error"].as_str().unwrap_or("it was already gone"));
        return Ok(1);
    }
    println!("✓ Disconnected {} ({}){}", text(&browser, "name"), text(&browser, "id"), if quit { " and quit it" } else { "" });
    Ok(0)
}

/// `browse uninstall`'s part: quits the dedicated browsers browse started and takes browse's pref out of the real
/// profiles it changed. Runs before the relay stops and browse's folders go.
pub fn uninstall() -> i32 {
    let paths = relay_api::paths();
    let recorded = firefox::read_recorded(&paths);
    if recorded.is_empty() {
        return 0;
    }
    let _ = std::fs::remove_file(firefox::recorded_path(&paths));
    let mut status = 0;
    for record in recorded.iter().filter(|r| r.dedicated) {
        let ProfileState::Listening { url, .. } = firefox::state(&record.profile) else { continue };
        let key = firefox::driver_key(&record.profile);
        let quit = relay::drivers("connect", &json!({ "protocol": "webdriver-bidi", "url": url, "key": key, "name": record.display_name() }))
            .and_then(|(code, answer)| if code == 200 { relay::drivers("disconnect", &json!({ "browser": key, "quit": true })) } else { Ok((code, answer)) });
        match quit {
            Ok((200, answer)) if answer["quit"] == true => {
                let deadline = Instant::now() + Duration::from_secs(10);
                while firefox::state(&record.profile).running() && Instant::now() < deadline {
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
    for record in recorded.iter().filter(|r| !r.dedicated && r.prefs_added) {
        let prefs = record.profile.join("prefs.js");
        match firefox::remove_browse_prefs(&record.profile) {
            Ok(true) => println!("✓ Took browse's remote.prefs.recommended line out of {}", tilde(&prefs)),
            Ok(false) => {}
            Err(_) => println!("! {} still has browse's line user_pref(\"remote.prefs.recommended\", false); remove it once {} is closed.", tilde(&prefs), record.display_name()),
        }
    }
    status
}

/// Whether `browse install` should offer Firefox: installed apps, by name.
pub fn installed_names() -> Vec<String> {
    firefox::apps().into_iter().map(|a| a.name).collect()
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
        let all = parse(&args(&["--app", "zen", "--profile=work", "--relaunch"])).unwrap();
        assert_eq!(all, Options { app: Some("zen".into()), profile: Some("work".into()), relaunch: true, ..Options::default() });
        let headless = parse(&args(&["--headless"])).unwrap();
        assert!(headless.headless && headless.dedicated, "--headless implies --dedicated");
        assert_eq!(parse(&args(&["--url", "ws://127.0.0.1:9222"])).unwrap().url.as_deref(), Some("ws://127.0.0.1:9222"));
        assert!(parse(&args(&["--app"])).is_err());
        assert!(parse(&args(&["--app", "--dedicated"])).is_err());
        assert!(parse(&args(&["--bogus"])).is_err());
        assert!(parse(&args(&["--dedicated", "--profile", "x"])).is_err());
        assert!(parse(&args(&["--headless", "--relaunch"])).is_err());
    }

    #[test]
    fn launch_arguments() {
        let app = App { kind: AppKind::Firefox, name: "Firefox".into(), exe: "/x/firefox".into(), bundle: None };
        let mut target = Target { app, profile: "/p".into(), dedicated: false, headless: false };
        assert_eq!(launch_args(&target), ["--profile", "/p", "--remote-debugging-port", "0"].map(OsString::from));
        target.dedicated = true;
        target.headless = true;
        assert_eq!(launch_args(&target), ["--profile", "/p", "--remote-debugging-port", "0", "--no-remote", "--headless"].map(OsString::from));
        assert_eq!(target.app_flag(), "");
        target.app.kind = AppKind::Zen;
        assert_eq!(target.app_flag(), " --app zen");
    }

    #[test]
    fn apps_resolve_by_id_path_or_record() {
        let dir = std::env::temp_dir().join(format!("browse-cli-firefox-{}", crate::session::random_u64()));
        let bundle = dir.join("Firefox Nightly.app/Contents/MacOS");
        std::fs::create_dir_all(&bundle).unwrap();
        std::fs::write(bundle.join("firefox"), b"").unwrap();
        let zen = dir.join("Zen.app/Contents/MacOS");
        std::fs::create_dir_all(&zen).unwrap();
        std::fs::write(zen.join("zen"), b"").unwrap();
        let discovery = Discovery { app_dirs: vec![dir.clone()], ..Discovery::none() };
        assert_eq!(resolve_app(&discovery, None, &[]).unwrap().kind, AppKind::Nightly);
        assert_eq!(resolve_app(&discovery, Some("zen"), &[]).unwrap().kind, AppKind::Zen);
        assert!(resolve_app(&discovery, Some("firefox"), &[]).unwrap_err().contains("isn't installed"));
        let record = RecordedFirefox { app: "zen".into(), exe: "/x".into(), profile: "/p".into(), dedicated: false, headless: false, name: None, prefs_added: false };
        assert_eq!(resolve_app(&discovery, None, &[record]).unwrap().kind, AppKind::Zen);
        let by_path = resolve_app(&discovery, Some(dir.join("Zen.app").to_str().unwrap()), &[]).unwrap();
        assert_eq!(by_path.bundle, Some(dir.join("Zen.app")));
        assert!(resolve_app(&Discovery::none(), None, &[]).unwrap_err().contains("No Firefox"));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
