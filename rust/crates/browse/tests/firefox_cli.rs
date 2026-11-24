//! `browse firefox`, `status`, `disconnect` and `uninstall` against a real headless Firefox in a throwaway environment (HOME,
//! browse's folders and the relay port all temporary; browse's dedicated profile lives there too). Skipped when no
//! Firefox is found; BROWSE_TEST_FIREFOX names one.

use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use browse_relay::firefox::{self, ProfileState};
use browse_relay::paths::Paths;

fn firefox_app() -> Option<PathBuf> {
    if let Ok(path) = std::env::var("BROWSE_TEST_FIREFOX") {
        return Some(PathBuf::from(path));
    }
    firefox::Discovery::system().app(firefox::AppKind::Firefox).map(|app| app.bundle.unwrap_or(app.exe))
}

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

fn wait_for(what: &str, timeout: Duration, mut done: impl FnMut() -> bool) {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if done() {
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    panic!("timed out waiting for {what}");
}

fn browse(home: &Path, port: u16) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_browse"));
    command
        .env("HOME", home)
        .env("CFFIXED_USER_HOME", home)
        .env("USERPROFILE", home)
        .env("XDG_CONFIG_HOME", home.join("config"))
        .env("XDG_DATA_HOME", home.join("xdg-data"))
        .env("XDG_STATE_HOME", home.join("xdg-state"))
        .env("XDG_CACHE_HOME", home.join("xdg-cache"))
        .env("XDG_BIN_HOME", home.join("bin"))
        .env("OPENCODE_BROWSER_HOME", home.join("browse-home"))
        .env("OPENCODE_BROWSER_PORT", port.to_string())
        .env("OPENCODE_BROWSER_AUTO_UPDATE", "off")
        .env("OPENCODE_BROWSER_UPDATE_CHECK", "0")
        .env("CODEX_HOME", home.join("codex"))
        .env("CLAUDE_CONFIG_DIR", home.join("claude"))
        .env("OPENCODE_CONFIG_DIR", home.join("opencode"))
        .stdin(Stdio::null());
    command
}

fn run(home: &Path, port: u16, args: &[&str]) -> (i32, String) {
    let Output { status, stdout, stderr } = browse(home, port).args(args).output().expect("browse runs");
    let text = format!("{}{}", String::from_utf8_lossy(&stdout), String::from_utf8_lossy(&stderr));
    (status.code().unwrap_or(-1), text)
}

struct Guard(Vec<Child>, PathBuf);

impl Drop for Guard {
    fn drop(&mut self) {
        for child in &mut self.0 {
            let _ = child.kill();
            let _ = child.wait();
        }
        // A Firefox a failed assertion left behind: it's this test's own, in its own temporary profile.
        if let ProfileState::Listening { pid: Some(pid), .. } | ProfileState::RunningNoBidi { pid: Some(pid) } = firefox::state(&self.1.join("browse-home/profiles/firefox")) {
            let _ = Command::new("kill").arg(pid.to_string()).status();
        }
        let _ = std::fs::remove_dir_all(&self.1);
    }
}

#[test]
fn browse_firefox_connects_reports_disconnects_and_uninstalls_a_headless_firefox() {
    let Some(app) = firefox_app() else {
        eprintln!("no Firefox found; skipping");
        return;
    };
    let app = app.to_string_lossy().into_owned();
    let unique = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let home = std::env::temp_dir().join(format!("browse-firefox-cli-{}-{unique}", std::process::id()));
    std::fs::create_dir_all(&home).unwrap();
    let home = std::fs::canonicalize(&home).unwrap();
    #[cfg(windows)]
    let home = home
        .to_str()
        .and_then(|s| s.strip_prefix("\\\\?\\"))
        .map(PathBuf::from)
        .unwrap_or(home);
    let mut guard = Guard(Vec::new(), home.clone());
    let paths = Paths::rooted(home.join("browse-home"));
    let port = free_port();
    guard.0.push(browse(&home, port).arg("serve").stdout(Stdio::null()).stderr(Stdio::null()).spawn().expect("browse serve starts"));
    wait_for("the relay", Duration::from_secs(15), || paths.relay_state(port).is_file());

    let (code, out) = run(&home, port, &["disconnect"]);
    assert_eq!(code, 1, "{out}");
    assert!(out.contains("No browser is connected directly"), "{out}");
    let (code, out) = run(&home, port, &["firefox", "--bogus"]);
    assert_eq!(code, 1, "{out}");

    let (code, out) = run(&home, port, &["firefox", "--headless", "--app", &app]);
    assert_eq!(code, 0, "{out}");
    assert!(out.contains("✓ Connected Firefox") && out.contains("navigator.webdriver"), "{out}");
    let profile = firefox::dedicated_profile(&paths, firefox::AppKind::Firefox);
    assert!(matches!(firefox::state(&profile), ProfileState::Listening { .. }));
    let recorded = firefox::read_recorded(&paths);
    assert_eq!(recorded.len(), 1, "{recorded:?}");
    assert!(recorded[0].dedicated && recorded[0].headless && !recorded[0].prefs_added);
    assert_eq!(recorded[0].profile, profile);

    let (code, out) = run(&home, port, &["firefox", "--headless", "--app", &app]);
    assert_eq!(code, 0, "{out}");
    assert!(out.contains("✓ Already connected"), "{out}");
    let (code, out) = run(&home, port, &["status"]);
    assert_eq!(code, 0, "{out}");
    assert!(out.contains("✓ Firefox") && out.contains("(firefox) · webdriver-bidi · 127.0.0.1:"), "{out}");
    assert!(!out.contains("chromewebstore"), "no extension next step while Firefox is connected: {out}");

    let (code, out) = run(&home, port, &["disconnect"]);
    assert_eq!(code, 0, "{out}");
    assert!(out.contains("Disconnected Firefox (firefox) and quit it"), "{out}");
    wait_for("Firefox to quit", Duration::from_secs(30), || firefox::state(&profile) == ProfileState::NotRunning);
    assert!(firefox::read_recorded(&paths).is_empty(), "a disconnected profile is forgotten");

    // Running without remote control: an agent (no terminal) gets both commands and exit 2, and nothing is touched.
    let plain = home.join("plain-profile");
    std::fs::create_dir_all(&plain).unwrap();
    let exe = firefox::App::at(Path::new(&app)).expect("the Firefox under test").exe;
    guard.0.push(
        Command::new(&exe)
            .args(["--headless", "--no-remote", "--profile"])
            .arg(&plain)
            .env("HOME", &home)
            .env("CFFIXED_USER_HOME", &home)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );
    wait_for("Firefox to lock its profile", Duration::from_secs(60), || matches!(firefox::state(&plain), ProfileState::RunningNoBidi { .. }));
    let (code, out) = run(&home, port, &["firefox", "--app", &app, "--profile", plain.to_str().unwrap()]);
    assert_eq!(code, 2, "{out}");
    assert!(out.contains("browse firefox --relaunch") && out.contains("browse firefox --dedicated") && out.contains("Agent: ask the user before running --relaunch"), "{out}");
    let prefs = std::fs::read_to_string(plain.join("prefs.js")).unwrap_or_default();
    assert!(!prefs.contains("remote.prefs.recommended"), "a running profile's prefs.js isn't touched");

    // uninstall quits the dedicated Firefox browse started before it deletes browse's folders.
    let (code, out) = run(&home, port, &["firefox", "--headless", "--app", &app]);
    assert_eq!(code, 0, "{out}");
    let (code, out) = run(&home, port, &["uninstall"]);
    assert_eq!(code, 0, "{out}");
    assert!(out.contains("✓ Quit browse's Firefox"), "{out}");
    assert!(!out.contains("Remove the browse extension"), "no extension was ever paired: {out}");
    assert!(!paths.data.exists());
    wait_for("the dedicated Firefox to be gone", Duration::from_secs(30), || !firefox::state(&profile).running());
}
