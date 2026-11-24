//! `browse chrome --headless`, `status`, `navigate`, `disconnect` and `uninstall` against a real headless Chromium
//! in a throwaway environment (HOME, browse's folders and the relay port all temporary). Skipped when no Chromium is
//! found; BROWSE_TEST_CHROME names one.

use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use browse_relay::chrome;
use browse_relay::paths::Paths;

fn chrome_app() -> Option<PathBuf> {
    if let Ok(path) = std::env::var("BROWSE_TEST_CHROME") {
        let p = PathBuf::from(path);
        if p.exists() {
            return Some(p);
        }
    }
    let candidates: &[&str] = if cfg!(target_os = "macos") {
        &[
            "/Applications/Google Chrome.app",
            "/Applications/Google Chrome for Testing.app",
            "/Applications/Chromium.app",
            "/Applications/Brave Browser.app",
        ]
    } else if cfg!(windows) {
        &[
            r"C:\Program Files\Google\Chrome\Application\chrome.exe",
            r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        ]
    } else {
        &["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"]
    };
    candidates.iter().map(PathBuf::from).find(|p| p.exists())
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
        let _ = std::fs::remove_dir_all(&self.1);
    }
}

#[test]
fn browse_chrome_connects_drives_disconnects_and_uninstalls_a_headless_chrome() {
    let Some(app) = chrome_app() else {
        eprintln!("no Chrome found; skipping");
        return;
    };
    let app = app.to_string_lossy().into_owned();
    let unique = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let home = std::env::temp_dir().join(format!("browse-chrome-cli-{}-{unique}", std::process::id()));
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
    guard.0.push(
        browse(&home, port)
            .arg("serve")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("browse serve starts"),
    );
    wait_for("the relay", Duration::from_secs(15), || paths.relay_state(port).is_file());

    let (code, out) = run(&home, port, &["chrome", "--bogus"]);
    assert_eq!(code, 1, "{out}");

    let (code, out) = run(&home, port, &["chrome", "--headless", "--app", &app]);
    assert_eq!(code, 0, "{out}");
    assert!(out.contains("✓ Connected"), "{out}");

    let recorded = chrome::read_recorded(&paths);
    assert_eq!(recorded.len(), 1, "{recorded:?}");
    let profile = recorded[0].profile.clone();
    assert!(recorded[0].headless);
    assert!(chrome::live_url(&profile).is_some());

    // Idempotent second call.
    let (code, out) = run(&home, port, &["chrome", "--headless", "--app", &app]);
    assert_eq!(code, 0, "{out}");
    assert!(out.contains("✓ Already connected"), "{out}");

    // status reports the direct CDP browser.
    let (code, out) = run(&home, port, &["status"]);
    assert_eq!(code, 0, "{out}");
    assert!(out.contains("· cdp · 127.0.0.1:"), "{out}");

    // Drive a real page through the relay over direct CDP.
    let (code, out) = run(&home, port, &["navigate", "data:text/html,<title>DirectCDP</title><h1>Hello%20Chrome</h1>"]);
    assert_eq!(code, 0, "{out}");
    assert!(out.contains("DirectCDP"), "{out}");

    // disconnect forgets the profile and quits the headless Chrome.
    let (code, out) = run(&home, port, &["disconnect"]);
    assert_eq!(code, 0, "{out}");
    assert!(out.contains("and quit it"), "{out}");
    wait_for("Chrome to quit", Duration::from_secs(30), || chrome::live_url(&profile).is_none());
    assert!(chrome::read_recorded(&paths).is_empty());

    // Reconnect and verify uninstall quits it before deleting browse's files.
    let (code, out) = run(&home, port, &["chrome", "--headless", "--app", &app]);
    assert_eq!(code, 0, "{out}");
    let (code, out) = run(&home, port, &["uninstall"]);
    assert_eq!(code, 0, "{out}");
    assert!(out.contains("✓ Quit browse's"), "{out}");
    assert!(!paths.data.exists());
    wait_for("Chrome to be gone", Duration::from_secs(30), || chrome::live_url(&profile).is_none());
}
