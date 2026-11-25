//! Another program's server on the relay port isn't a browse relay, even when its `/version` has a string `version`:
//! Playwriter's relay also defaults to 19988 and answered `{"version":"0.12.0",…}`, which browse took for an older
//! browse relay and refused to run beside (#332).

use std::io::{Read, Write};
use std::net::TcpListener;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

/// Serves `body` as every request's 200 JSON reply, on a free loopback port, for the rest of the test process.
fn serve(body: &'static str) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for mut stream in listener.incoming().flatten() {
            let mut buffer = [0u8; 1024];
            let _ = stream.read(&mut buffer);
            let reply = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            let _ = stream.write_all(reply.as_bytes());
        }
    });
    port
}

#[test]
fn a_playwriter_relay_on_the_pinned_port_is_another_program() {
    let port = serve(r#"{"version":"0.12.0","pid":75049,"activeExecutes":0}"#);
    let unique = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let home = std::env::temp_dir().join(format!("browse-foreign-relay-{}-{unique}", std::process::id()));
    std::fs::create_dir_all(&home).unwrap();
    // Pinned, so the relay may not move to a fallback port and the command stops at the probe's verdict.
    let output = Command::new(env!("CARGO_BIN_EXE_browse"))
        .env("HOME", &home)
        .env("USERPROFILE", &home)
        .env("XDG_CONFIG_HOME", home.join("config"))
        .env("XDG_DATA_HOME", home.join("xdg-data"))
        .env("XDG_STATE_HOME", home.join("xdg-state"))
        .env("XDG_CACHE_HOME", home.join("xdg-cache"))
        .env("OPENCODE_BROWSER_HOME", home.join("browse-home"))
        .env("OPENCODE_BROWSER_PORT", port.to_string())
        .env("OPENCODE_BROWSER_AUTO_UPDATE", "off")
        .env("OPENCODE_BROWSER_UPDATE_CHECK", "0")
        .args(["navigate", "about:blank"])
        .output()
        .unwrap();
    let _ = std::fs::remove_dir_all(&home);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(!output.status.success(), "{stderr}");
    assert!(stderr.contains(&format!("port {port} is in use by another program")), "{stderr}");
    assert!(!stderr.contains("older browse relay"), "{stderr}");
}
