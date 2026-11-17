//! `browse uninstall` leaves nothing behind: a stopping relay is done with its files (the final tab write, the
//! shutdown log and relay.json) before uninstall deletes its folders.

use std::net::TcpListener;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use browse_relay::paths::Paths;

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

fn wait_for(what: &str, timeout: Duration, mut done: impl FnMut() -> bool) {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if done() {
            return;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    panic!("timed out waiting for {what}");
}

/// The real `browse` in a throwaway environment: no real agent configs, relays or browse roots.
fn browse(home: &Path, port: u16) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_browse"));
    command
        .env("HOME", home)
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
        .env("OPENCODE_CONFIG_DIR", home.join("opencode"));
    command
}

/// Kills its relay on drop, so a failed assertion doesn't leave one behind.
struct Guard(Child);

impl Guard {
    /// Whether the relay process is still running. Its exit is reaped here, so a zombie doesn't count.
    fn alive(&mut self) -> bool {
        self.0.try_wait().is_ok_and(|status| status.is_none())
    }
}

impl Drop for Guard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[test]
fn uninstall_leaves_no_browse_files_behind_the_relay() {
    let unique = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let home = std::env::temp_dir().join(format!("browse-uninstall-{}-{unique}", std::process::id()));
    std::fs::create_dir_all(&home).unwrap();
    let paths = Paths::rooted(home.join("browse-home"));
    let port = free_port();

    let mut relay = Guard(browse(&home, port).arg("serve").stdout(Stdio::null()).stderr(Stdio::null()).spawn().expect("browse serve starts"));
    wait_for("the relay", Duration::from_secs(15), || paths.relay_state(port).is_file());

    let output = browse(&home, port).arg("uninstall").output().expect("browse uninstall runs");
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(output.status.success(), "uninstall failed:\n{stdout}\n{}", String::from_utf8_lossy(&output.stderr));
    assert!(!paths.config.exists(), "uninstall must remove browse's root: {}", paths.config.display());
    wait_for("the relay process to exit", Duration::from_secs(15), || !relay.alive());

    // The relay persists its tabs and writes relay.shutdown.closed while it stops. Neither may recreate the root.
    std::thread::sleep(Duration::from_secs(2));
    assert!(!paths.config.exists(), "a stopping relay recreated {}", paths.config.display());
    assert!(!paths.tab_registry(port).exists(), "the relay recreated its tab registry");
    assert!(!paths.relay_log().exists(), "the relay recreated its log");

    let _ = std::fs::remove_dir_all(&home);
}
