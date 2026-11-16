//! The real `browse mcp` over stdio against a real relay and a fake extension: an older client that initializes, a
//! 2026-07-28 client that probes with `server/discover` and sends its identity on every request, and two MCP
//! connections that see the same agent and lent tabs.

use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use browse_relay::paths::Paths;
use browse_relay::protocol::stable_unpacked_origin;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

const MODERN: &str = "2026-07-28";

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

/// Kills its child on drop, so a failed assertion doesn't leave a relay behind.
struct Guard(Child);

impl Drop for Guard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// A `browse mcp` client over its stdin and stdout.
struct Mcp {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
}

impl Mcp {
    fn start(home: &Path, port: u16) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_browse"))
            .arg("mcp")
            .env("OPENCODE_BROWSER_HOME", home)
            .env("OPENCODE_BROWSER_PORT", port.to_string())
            .env("OPENCODE_BROWSER_AUTOSTART", "0")
            .env("OPENCODE_BROWSER_UPDATE_CHECK", "0")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("browse mcp starts");
        let stdin = child.stdin.take().unwrap();
        let stdout = BufReader::new(child.stdout.take().unwrap());
        Self { child, stdin, stdout, next_id: 1 }
    }

    fn send(&mut self, message: Value) {
        writeln!(self.stdin, "{message}").unwrap();
        self.stdin.flush().unwrap();
    }

    /// One request; answers for other ids (a notification, an earlier call) are skipped.
    fn request(&mut self, method: &str, params: Value) -> Value {
        let id = self.next_id;
        self.next_id += 1;
        self.send(json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }));
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            assert!(Instant::now() < deadline, "no answer to {method}");
            let mut line = String::new();
            self.stdout.read_line(&mut line).unwrap();
            let message: Value = serde_json::from_str(line.trim()).unwrap_or_else(|_| panic!("not JSON: {line:?}"));
            if message.get("id").and_then(Value::as_u64) == Some(id) {
                assert!(message.get("error").is_none(), "{method} failed: {message}");
                return message["result"].clone();
            }
        }
    }
}

impl Drop for Mcp {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// The per-request `_meta` envelope OpenCode's 2026-07-28 client sends.
fn modern_meta() -> Value {
    json!({
        "io.modelcontextprotocol/protocolVersion": MODERN,
        "io.modelcontextprotocol/clientCapabilities": {},
        "io.modelcontextprotocol/clientInfo": { "name": "opencode", "version": "test" },
    })
}

/// Answers the relay's extension commands like the browser extension does, so tabs can be opened and used. `lends`
/// names tabs the user lends with the toolbar button; every command the relay sends is kept in `seen`.
async fn fake_extension(port: u16, paths: Paths, profile: &str, seen: Arc<Mutex<Vec<Value>>>, mut lends: mpsc::UnboundedReceiver<i64>) {
    let token = browse_relay::pairing::issue_browser_token(&paths, profile, None, None).unwrap();
    let mut request = format!("ws://127.0.0.1:{port}/extension").into_client_request().unwrap();
    request.headers_mut().insert("Origin", stable_unpacked_origin().parse().unwrap());
    let (mut socket, _) = tokio_tungstenite::connect_async(request).await.expect("the extension connects");
    let nonce = "abcdefghijklmnopqrstuvwxyz012345";
    socket
        .send(Message::Text(json!({ "method": "protocol", "params": { "protocolVersion": 3 } }).to_string().into()))
        .await
        .unwrap();
    socket
        .send(Message::Text(
            json!({ "method": "hello", "params": {
                "version": "9.9.9", "build": "test", "protocolVersion": 3, "capabilities": ["tab-release"],
                "profileId": profile, "profileName": "browse", "browser": "Chrome", "name": "Test Chrome",
                "pairing": { "nonce": nonce, "mode": "token" },
            } })
            .to_string()
            .into(),
        ))
        .await
        .unwrap();
    let mut created = 500;
    loop {
        tokio::select! {
            incoming = socket.next() => {
                let Some(Ok(message)) = incoming else { break };
                let Message::Text(text) = message else { continue };
                let command: Value = serde_json::from_str(&text).unwrap();
                let method = command["method"].as_str().unwrap_or_default();
                if method == "auth.challenge" {
                    let relay_nonce = command["params"]["nonce"].as_str().unwrap();
                    let proof = browse_relay::pairing::pairing_proof(&token, "extension", port, nonce, relay_nonce);
                    let response = json!({ "method": "auth.response", "params": { "proof": proof } });
                    socket.send(Message::Text(response.to_string().into())).await.unwrap();
                    socket
                        .send(Message::Text(json!({ "method": "ready" }).to_string().into()))
                        .await
                        .unwrap();
                    continue;
                }
                let Some(id) = command["id"].as_u64() else { continue };
                let params = &command["params"];
                seen.lock().unwrap().push(json!({ "method": method, "params": params }));
                let result = match method {
                    "tabs.create" => {
                        created += 1;
                        json!({ "tabId": created })
                    }
                    "debugger.sendCommand" if params["method"] == "Target.getTargetInfo" => {
                        let tab = params["tabId"].as_i64().unwrap();
                        json!({ "targetInfo": { "targetId": format!("T{tab}"), "type": "page", "url": "about:blank", "title": "", "attached": true } })
                    }
                    _ => json!({}),
                };
                let response = json!({ "id": id, "result": result });
                socket.send(Message::Text(response.to_string().into())).await.unwrap();
            }
            lend = lends.recv() => {
                let Some(tab) = lend else { break };
                socket
                    .send(Message::Text(json!({ "method": "toolbar.clicked", "params": { "tabId": tab } }).to_string().into()))
                    .await
                    .unwrap();
            }
        }
    }
}

#[test]
fn mcp_speaks_both_eras_and_shares_tabs_across_connections() {
    let home: PathBuf = std::env::temp_dir().join(format!("browse-mcp-pool-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&home);
    std::fs::create_dir_all(&home).unwrap();
    let paths = Paths::rooted(home.clone());
    let port = free_port();
    let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap();

    let relay = Guard(
        Command::new(env!("CARGO_BIN_EXE_browse"))
            .arg("serve")
            .env("OPENCODE_BROWSER_HOME", &home)
            .env("OPENCODE_BROWSER_PORT", port.to_string())
            .env("OPENCODE_BROWSER_UPDATE_CHECK", "0")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("browse serve starts"),
    );
    let running = || runtime.block_on(async { browse_relay::client::request(port, "GET", "/version", &[], None, Duration::from_secs(1)).await.is_ok() });
    wait_for("the relay", Duration::from_secs(15), running);
    let relay_token = format!("Bearer {}", std::fs::read_to_string(paths.relay_token()).unwrap().trim());
    let seen: Arc<Mutex<Vec<Value>>> = Arc::default();
    let (lend, lends) = mpsc::unbounded_channel();
    runtime.spawn(fake_extension(port, paths, "pool-test", seen.clone(), lends));
    let connected = || {
        let body = serde_json::to_vec(&json!({ "name": "status", "arguments": {} })).unwrap();
        runtime.block_on(async {
            let output = browse_relay::client::request(
                port,
                "POST",
                "/tools/call",
                &[("Authorization", relay_token.as_str())],
                Some(&body),
                Duration::from_secs(5),
            )
            .await
            .unwrap();
            output.json().is_some_and(|v| v["content"][0]["text"].as_str().is_some_and(|t| t.contains("\"connected\":true")))
        })
    };
    wait_for("the extension to connect", Duration::from_secs(15), connected);

    // (a) A 2025-11-25 client's initialize handshake still works, with the initialize-era result.
    let mut legacy = Mcp::start(&home, port);
    let init = legacy.request(
        "initialize",
        json!({ "protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": { "name": "opencode", "version": "test" } }),
    );
    assert_eq!(init["protocolVersion"], "2025-11-25");
    assert!(init["instructions"].as_str().unwrap_or_default().contains("Tabs are the handle"), "{init}");
    legacy.send(json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }));
    let listed = legacy.request("tools/list", json!({}));
    assert!(listed["tools"].as_array().is_some_and(|tools| !tools.is_empty()), "{listed}");
    assert!(listed.get("resultType").is_none(), "an initialize connection keeps the older result shape: {listed}");
    let status = legacy.request("tools/call", json!({ "name": "status", "arguments": {} }));
    assert_ne!(status["isError"], true, "{status}");

    // (b) A 2026-07-28 client probes with server/discover and never initializes.
    let mut modern = Mcp::start(&home, port);
    let discover = modern.request("server/discover", json!({ "_meta": modern_meta() }));
    assert_eq!(discover["resultType"], "complete", "{discover}");
    assert!(
        discover["supportedVersions"].as_array().is_some_and(|versions| versions.iter().any(|v| v == MODERN)),
        "{discover}"
    );
    let listed = modern.request("tools/list", json!({ "_meta": modern_meta() }));
    assert_eq!(listed["resultType"], "complete", "{listed}");
    assert_eq!(listed["ttlMs"], 0);
    assert!(listed["tools"].as_array().is_some_and(|tools| !tools.is_empty()), "{listed}");
    let status = modern.request("tools/call", json!({ "name": "status", "arguments": {}, "_meta": modern_meta() }));
    assert_eq!(status["resultType"], "complete", "{status}");
    assert_ne!(status["isError"], true, "{status}");

    // (c) Two MCP connections see the same tabs: one opens a tab, the other lists and closes it by id.
    let mut alpha = modern;
    let mut beta = Mcp::start(&home, port);
    let opened = text(&alpha.request(
        "tools/call",
        json!({ "name": "tabs", "arguments": { "action": "new", "group": "alpha" }, "_meta": modern_meta() }),
    ));
    let tab = opened["tab"].as_i64().unwrap_or_else(|| panic!("no tab id in {opened}"));
    for (who, mcp) in [("alpha", &mut alpha), ("beta", &mut beta)] {
        let listed = list_tabs(mcp);
        let found = listed["tabs"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["tab"] == tab)
            .unwrap_or_else(|| panic!("{who} must see the agent tab: {listed}"));
        assert_eq!(found["group"], "alpha", "{who}: {listed}");
        assert_ne!(found["lent"], json!(true), "{who}: an agent tab isn't lent: {listed}");
    }
    let closed = text(&beta.request(
        "tools/call",
        json!({ "name": "tabs", "arguments": { "action": "close", "tab": tab }, "_meta": modern_meta() }),
    ));
    assert_eq!(closed["closed"], json!([tab]), "either connection closes an agent tab by its id: {closed}");

    // A lent tab is listed for both connections, and closing it gives it back instead of closing the user's tab.
    let lent_tab = 700;
    lend.send(lent_tab).unwrap();
    wait_for("the lent tab", Duration::from_secs(15), || {
        list_tabs(&mut beta)["tabs"].as_array().unwrap().iter().any(|t| t["tab"] == lent_tab && t["lent"] == true)
    });
    let alpha_tabs = list_tabs(&mut alpha);
    let lent = alpha_tabs["tabs"].as_array().unwrap().iter().find(|t| t["tab"] == lent_tab).unwrap_or_else(|| panic!("{alpha_tabs}"));
    assert_eq!(lent["lent"], true, "{alpha_tabs}");
    let released = text(&alpha.request(
        "tools/call",
        json!({ "name": "tabs", "arguments": { "action": "close", "tab": lent_tab }, "_meta": modern_meta() }),
    ));
    assert_eq!(released["released"], json!([lent_tab]), "{released}");
    let seen = seen.lock().unwrap();
    assert!(
        seen.iter().any(|c| c["method"] == "debugger.detach" && c["params"]["tabId"] == lent_tab),
        "a lent tab is detached: {seen:?}"
    );
    assert!(
        seen.iter().all(|c| !(c["method"] == "tabs.remove" && c["params"]["tabId"] == lent_tab)),
        "a lent tab is never closed: {seen:?}"
    );

    drop(beta);
    drop(alpha);
    drop(legacy);
    drop(relay);
    let _ = std::fs::remove_dir_all(&home);
}

fn text(result: &Value) -> Value {
    serde_json::from_str(result["content"][0]["text"].as_str().expect("a text tool result")).unwrap()
}

fn list_tabs(mcp: &mut Mcp) -> Value {
    text(&mcp.request("tools/call", json!({ "name": "tabs", "arguments": {}, "_meta": modern_meta() })))
}
