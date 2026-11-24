//! The relay driving a real headless Firefox over WebDriver BiDi, the way `browse firefox --headless` connects one:
//! found through its profile's lock and `WebDriverBiDiServer.json`, connected with `POST /drivers/connect`, used by
//! the page tools, let go (its BiDi server stays ready for the next client), and quit. Every file lives in a
//! temporary folder (HOME too). Skipped when no Firefox is found; BROWSE_TEST_FIREFOX names one.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use browse_relay::firefox::{self, ProfileState};
use browse_relay::paths::Paths;
use browse_relay::{ServeOptions, start};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_tungstenite::tungstenite::Message;

fn firefox_binary() -> Option<PathBuf> {
    if let Ok(path) = std::env::var("BROWSE_TEST_FIREFOX") {
        return Some(PathBuf::from(path));
    }
    let discovery = firefox::Discovery::system();
    discovery.app(firefox::AppKind::Firefox).or_else(|| discovery.apps().into_iter().find(|a| a.kind != firefox::AppKind::Zen)).map(|a| a.exe)
}

struct Scratch(PathBuf);

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

const PREFS: &str = r#"user_pref("app.update.disabledForTesting", true);
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("datareporting.policy.dataSubmissionEnabled", false);
user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);
user_pref("browser.startup.homepage_override.mstone", "ignore");
"#;

fn launch(binary: &Path, home: &Path, profile: &Path) -> tokio::process::Child {
    tokio::process::Command::new(binary)
        .args(["--headless", "--no-remote", "--profile"])
        .arg(profile)
        .args(["--remote-debugging-port", "0"])
        .env("HOME", home)
        .env("CFFIXED_USER_HOME", home)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .expect("Firefox starts")
}

async fn listening(profile: &Path) -> (String, Option<u32>) {
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        match firefox::state(profile) {
            ProfileState::Listening { url, pid } => return (url, pid),
            ProfileState::Unreadable(detail) => panic!("{detail}"),
            _ if Instant::now() > deadline => panic!("Firefox never listened for WebDriver BiDi"),
            _ => tokio::time::sleep(Duration::from_millis(200)).await,
        }
    }
}

async fn http(port: u16, token: &str, method: &str, path: &str, body: Value) -> (u16, Value) {
    let auth = format!("Bearer {token}");
    let body = body.to_string();
    let response = browse_relay::client::request(port, method, path, &[("Authorization", auth.as_str())], Some(body.as_bytes()), Duration::from_secs(60)).await.unwrap();
    (response.status, response.json().unwrap_or(Value::Null))
}

async fn tool(port: u16, token: &str, name: &str, arguments: Value) -> Value {
    let (status, output) = http(port, token, "POST", "/tools/call", json!({ "name": name, "arguments": arguments })).await;
    assert_eq!(status, 200, "{name}: {output}");
    assert_ne!(output["isError"], true, "{name}: {output}");
    output
}

fn text(output: &Value) -> String {
    output["content"][0]["text"].as_str().unwrap_or("").to_string()
}

/// A one-page HTTP server.
async fn page(html: &'static str) -> u16 {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            tokio::spawn(async move {
                let mut buffer = [0u8; 4096];
                let _ = stream.read(&mut buffer).await;
                let reply = format!("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{html}", html.len());
                let _ = stream.write_all(reply.as_bytes()).await;
            });
        }
    });
    port
}

/// Firefox's own answer to `session.status` on a fresh connection: whether it takes a new session.
async fn ready(url: &str) -> bool {
    let (mut socket, _) = tokio_tungstenite::connect_async(url).await.expect("the BiDi server answers");
    socket.send(Message::Text(json!({ "id": 1, "method": "session.status", "params": {} }).to_string().into())).await.unwrap();
    loop {
        let Some(Ok(Message::Text(reply))) = socket.next().await else { panic!("no session.status answer") };
        let reply: Value = serde_json::from_str(&reply).unwrap();
        if reply["id"] == 1 {
            return reply["result"]["ready"] == true;
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_relay_drives_lets_go_of_and_quits_a_headless_firefox() {
    let Some(binary) = firefox_binary() else {
        eprintln!("no Firefox found; skipping");
        return;
    };
    let root = std::env::temp_dir().join(format!("browse-relay-firefox-live-{}-{}", std::process::id(), Instant::now().elapsed().as_nanos()));
    std::fs::create_dir_all(&root).unwrap();
    let root = std::fs::canonicalize(&root).unwrap();
    let scratch = Scratch(root.clone());
    let home = scratch.0.join("home");
    let profile = scratch.0.join("profile");
    std::fs::create_dir_all(&home).unwrap();
    std::fs::create_dir_all(&profile).unwrap();
    std::fs::write(profile.join("user.js"), PREFS).unwrap();
    assert_eq!(firefox::state(&profile), ProfileState::NotRunning);

    let paths = Paths::rooted(scratch.0.join("browse"));
    let mut tools = browse_relay::tools();
    tools.extend(browse_page::tools());
    let options = ServeOptions { port: Some(0), paths: paths.clone(), version: "0.0.0-test".into(), firefox: None, ..ServeOptions::default() };
    let handle = start(options, tools).await.unwrap();
    let (port, token) = (handle.port(), handle.token().to_string());

    let mut child = launch(&binary, &home, &profile);
    let (url, pid) = listening(&profile).await;
    assert!(url.starts_with("ws://127.0.0.1:") && url.ends_with("/session"), "{url}");
    assert!(pid.is_some(), "the lock names its holder");

    let key = firefox::driver_key(&profile);
    let connect = json!({ "protocol": "webdriver-bidi", "url": url, "key": key, "name": "Firefox" });
    let (status, connected) = http(port, &token, "POST", "/drivers/connect", connect.clone()).await;
    assert_eq!(status, 200, "{connected}");
    assert_eq!(connected["browser"]["key"], key);
    assert_eq!(connected["browser"]["id"], "firefox");

    let site = page("<!doctype html><title>Live</title><h1>Hello from Firefox</h1><button onclick=\"this.textContent='clicked'\">Press</button>").await;
    let opened: Value = serde_json::from_str(&text(&tool(port, &token, "navigate", json!({ "url": format!("http://127.0.0.1:{site}/") })).await)).unwrap();
    let tab = opened["tab"].as_i64().expect("a tab id");
    assert_eq!(opened["title"], "Live", "{opened}");
    let snapshot = text(&tool(port, &token, "snapshot", json!({ "tab": tab })).await);
    assert!(snapshot.contains("heading \"Hello from Firefox\""), "{snapshot}");
    let status_out = tool(port, &token, "status", json!({})).await;
    let reported: Value = serde_json::from_str(&text(&status_out)).unwrap();
    assert_eq!(reported["connected"], true);
    assert!(reported.get("nextStep").is_none_or(Value::is_null), "{reported}");

    // Let go without quitting: Firefox keeps running and takes the next session.
    let (status, done) = http(port, &token, "POST", "/drivers/disconnect", json!({ "browser": key })).await;
    assert_eq!((status, done["disconnected"].clone(), done["quit"].clone()), (200, json!(true), json!(false)), "{done}");
    assert!(firefox::state(&profile).running());
    assert!(ready(&url).await, "the session ended, so Firefox is ready for another");
    let (status, again) = http(port, &token, "POST", "/drivers/connect", connect).await;
    assert_eq!(status, 200, "{again}");

    // Quit: browser.close ends Firefox itself.
    let (status, done) = http(port, &token, "POST", "/drivers/disconnect", json!({ "browser": "firefox", "quit": true })).await;
    assert_eq!((status, done["quit"].clone()), (200, json!(true)), "{done}");
    let exited = tokio::time::timeout(Duration::from_secs(30), child.wait()).await.expect("Firefox exits after browser.close").unwrap();
    assert!(exited.success() || exited.code().is_some(), "{exited:?}");
    let deadline = Instant::now() + Duration::from_secs(10);
    while firefox::state(&profile) != ProfileState::NotRunning && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_eq!(firefox::state(&profile), ProfileState::NotRunning);

    // A killed Firefox leaves its server file behind; the free lock still says it's gone.
    let mut child = launch(&binary, &home, &profile);
    listening(&profile).await;
    child.kill().await.unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while firefox::state(&profile) != ProfileState::NotRunning && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(profile.join("WebDriverBiDiServer.json").exists(), "SIGKILL leaves the server file");
    assert_eq!(firefox::state(&profile), ProfileState::NotRunning);

    handle.stop();
    handle.wait().await;
}
