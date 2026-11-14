//! The relay against a fake extension speaking the real wire protocol: pairing, CDP routing, sessions, the HTTP API.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use browse_core::{Browser, CdpError};
use futures_util::{SinkExt, StreamExt};
use p256::elliptic_curve::sec1::ToEncodedPoint;
use serde_json::{Value, json};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

use crate::pairing;
use crate::paths::Paths;
use crate::serve::{RelayHandle, ServeOptions, start};
use crate::util::{b64url, from_b64url, random_bytes};

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

struct Harness {
    handle: RelayHandle,
    paths: Paths,
}

impl Drop for Harness {
    fn drop(&mut self) {
        self.handle.stop();
        let _ = std::fs::remove_dir_all(&self.paths.data);
    }
}

async fn harness() -> Harness {
    let paths = Paths::rooted(std::env::temp_dir().join(format!("browse-relay-test-{}", crate::util::random_hex(6))));
    let options = ServeOptions { port: Some(0), paths: paths.clone(), version: "0.0.0-test".into(), idle_shutdown: None, ..ServeOptions::default() };
    let handle = start(options, crate::tools()).await.unwrap();
    Harness { handle, paths }
}

async fn connect(port: u16, origin: &str) -> Option<Socket> {
    let mut request = format!("ws://127.0.0.1:{port}/extension").into_client_request().unwrap();
    request.headers_mut().insert("Origin", origin.parse().unwrap());
    tokio_tungstenite::connect_async(request).await.ok().map(|(socket, _)| socket)
}

async fn send(socket: &mut Socket, value: Value) {
    socket.send(Message::Text(value.to_string().into())).await.unwrap();
}

/// The next JSON message, or the close frame as `{ "close": code, "reason": ... }`.
async fn next(socket: &mut Socket) -> Value {
    loop {
        let message = tokio::time::timeout(Duration::from_secs(5), socket.next()).await.expect("the relay answers").expect("the socket stays open");
        match message.unwrap() {
            Message::Text(text) => return serde_json::from_str(&text).unwrap(),
            Message::Close(frame) => return json!({ "close": frame.as_ref().map(|f| u16::from(f.code)), "reason": frame.map(|f| f.reason.to_string()) }),
            _ => continue,
        }
    }
}

fn hello(profile: &str, mode: &str, nonce: &str, ecdh: Option<&str>) -> Value {
    let mut pairing = json!({ "nonce": nonce, "mode": mode });
    if let Some(key) = ecdh {
        pairing["ecdh"] = key.into();
    }
    json!({ "method": "hello", "params": {
        "version": "9.9.9", "build": "test", "protocolVersion": 3, "capabilities": ["tab-release"],
        "profileId": profile, "profileName": "browse", "browser": "Chrome", "name": "Test Chrome", "pairing": pairing,
    } })
}

fn origin() -> String {
    crate::protocol::stable_unpacked_origin()
}

/// Pairs with an issued token, the way the extension does on every connection.
async fn pair_with_token(port: u16, paths: &Paths, profile: &str) -> Socket {
    let token = pairing::issue_browser_token(paths, profile, None, None).unwrap();
    let mut socket = connect(port, &origin()).await.unwrap();
    send(&mut socket, json!({ "method": "protocol", "params": { "protocolVersion": 3 } })).await;
    let nonce = b64url(&random_bytes::<32>());
    send(&mut socket, hello(profile, "token", &nonce, None)).await;
    let challenge = next(&mut socket).await;
    assert_eq!(challenge["method"], "auth.challenge");
    let relay_nonce = challenge["params"]["nonce"].as_str().unwrap().to_string();
    assert_eq!(challenge["params"]["proof"], pairing::pairing_proof(&token, "relay", port, &relay_nonce, &nonce));
    assert_eq!(challenge["params"]["protocol"], json!({ "version": 3, "min": 3 }));
    send(&mut socket, json!({ "method": "auth.response", "params": { "proof": pairing::pairing_proof(&token, "extension", port, &nonce, &relay_nonce) } })).await;
    socket
}

#[derive(Default)]
struct Seen(Mutex<Vec<Value>>);

impl Seen {
    fn commands(&self, method: &str) -> Vec<Value> {
        self.0.lock().unwrap().iter().filter(|c| c["method"] == method).cloned().collect()
    }
    fn cdp(&self, method: &str) -> Vec<Value> {
        self.commands("debugger.sendCommand").into_iter().filter(|c| c["params"]["method"] == method).collect()
    }
}

/// Answers the relay's commands like the extension, records them, and sends whatever is pushed to `events`.
fn fake_extension(socket: Socket, next_tab: i64) -> (Arc<Seen>, mpsc::UnboundedSender<Value>) {
    let seen = Arc::new(Seen::default());
    let (events, mut outgoing) = mpsc::unbounded_channel::<Value>();
    let (mut sink, mut stream) = socket.split();
    let (replies, mut replies_rx) = mpsc::unbounded_channel::<Value>();
    tokio::spawn(async move {
        loop {
            let message = tokio::select! {
                Some(m) = outgoing.recv() => m,
                Some(m) = replies_rx.recv() => m,
                else => break,
            };
            if sink.send(Message::Text(message.to_string().into())).await.is_err() {
                break;
            }
        }
    });
    let record = seen.clone();
    tokio::spawn(async move {
        while let Some(Ok(message)) = stream.next().await {
            let Message::Text(text) = message else { continue };
            let command: Value = serde_json::from_str(&text).unwrap();
            record.0.lock().unwrap().push(command.clone());
            let Some(id) = command["id"].as_u64() else { continue };
            let params = &command["params"];
            let result = match command["method"].as_str().unwrap_or("") {
                "tabs.create" => json!({ "tabId": next_tab }),
                "settings.get" | "settings.set" => json!({ "settings": { "window": "current", "grouping": "shared", "idleMinutes": 10, "humanInput": "on", "handoffNotifications": "recording" } }),
                "debugger.sendCommand" => match params["method"].as_str().unwrap_or("") {
                    "Target.getTargetInfo" => {
                        let tab = params["tabId"].as_i64().unwrap();
                        json!({ "targetInfo": { "targetId": format!("T{tab}"), "type": "page", "url": "about:blank", "title": "", "attached": true } })
                    }
                    "Runtime.evaluate" => json!({ "result": { "type": "number", "value": 42 } }),
                    "Network.getCookies" => json!({ "cookies": [{ "domain": "example.com" }, { "domain": "bank.com" }] }),
                    "Broken.method" => {
                        let _ = replies.send(json!({ "id": id, "error": "No tab with given id 7." }));
                        continue;
                    }
                    _ => json!({}),
                },
                _ => json!({}),
            };
            let _ = replies.send(json!({ "id": id, "result": result }));
        }
    });
    (seen, events)
}

async fn eventually(what: &str, check: impl Fn() -> bool) {
    for _ in 0..200 {
        if check() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("timed out waiting for {what}");
}

#[tokio::test]
async fn pairs_with_a_token_and_routes_cdp_per_tab_and_child_session() {
    let h = harness().await;
    let port = h.handle.port();
    let socket = pair_with_token(port, &h.paths, "profile-a").await;
    let (seen, events) = fake_extension(socket, 7);
    events.send(json!({ "method": "ready" })).unwrap();
    let relay = h.handle.relay.clone();
    eventually("the browser to connect", || relay.st().connected()).await;
    {
        let st = relay.st();
        assert_eq!(st.links[0].id, "test-chrome");
        assert!(st.links[0].supports("tab-release"));
    }

    let browser = h.handle.browser();
    let session = "work".to_string();
    let tab = browser.open_tab(&session, None).await.unwrap();
    assert_eq!(tab.tab_id, 7);
    assert!(tab.active);
    assert_eq!(seen.commands("tabs.create")[0]["params"], json!({ "url": "about:blank", "active": false }));
    assert_eq!(seen.commands("debugger.attach")[0]["params"]["tabId"], 7);
    assert_eq!(seen.cdp("Target.setAutoAttach")[0]["params"]["params"], json!({ "autoAttach": true, "waitForDebuggerOnStart": false, "flatten": true }));
    assert!(seen.cdp("Runtime.enable").is_empty(), "the relay never enables Runtime on its own");

    let cdp = browser.cdp(&session, 7).await.unwrap();
    assert!(Arc::ptr_eq(&cdp, &browser.cdp(&session, 7).await.unwrap()), "one handle per attachment");
    let mut subscription = cdp.events();
    let evaluated = cdp.send("Runtime.evaluate", json!({ "expression": "6*7" }), None).await.unwrap();
    assert_eq!(evaluated["result"]["value"], 42);
    let sent = seen.cdp("Runtime.evaluate").pop().unwrap();
    assert_eq!(sent["params"]["tabId"], 7);
    assert!(sent["params"].get("sessionId").is_none());

    let attached = json!({ "sessionId": "CHILD", "targetInfo": { "targetId": "F1", "type": "iframe", "url": "https://frame.test/" }, "waitingForDebugger": false });
    events.send(json!({ "method": "debugger.event", "params": { "tabId": 7, "method": "Target.attachedToTarget", "params": attached } })).unwrap();
    let restricted = json!({ "sessionId": "EXT", "targetInfo": { "targetId": "F2", "type": "iframe", "url": "chrome-extension://abc/popup.html" }, "waitingForDebugger": false });
    events.send(json!({ "method": "debugger.event", "params": { "tabId": 7, "method": "Target.attachedToTarget", "params": restricted } })).unwrap();
    events.send(json!({ "method": "debugger.event", "params": { "tabId": 7, "sessionId": "EXT", "method": "Runtime.consoleAPICalled", "params": {} } })).unwrap();
    events.send(json!({ "method": "debugger.event", "params": { "tabId": 7, "sessionId": "CHILD", "method": "Page.frameNavigated", "params": { "frame": { "id": "F1" } } } })).unwrap();

    let first = tokio::time::timeout(Duration::from_secs(2), subscription.recv()).await.unwrap().unwrap();
    assert_eq!(first.method, "Target.attachedToTarget");
    assert_eq!(first.session_id, None);
    let second = tokio::time::timeout(Duration::from_secs(2), subscription.recv()).await.unwrap().unwrap();
    assert_eq!((second.method.as_str(), second.session_id.as_deref()), ("Page.frameNavigated", Some("CHILD")), "the restricted frame's events are hidden");

    cdp.send("DOM.getDocument", json!({}), Some("CHILD")).await.unwrap();
    assert_eq!(seen.cdp("DOM.getDocument")[0]["params"]["sessionId"], "CHILD");

    let blocked = cdp.send("Browser.close", json!({}), None).await.unwrap_err();
    assert!(matches!(blocked, CdpError::Protocol(m) if m.contains("always blocked")));
    let scoped = cdp.send("Network.getCookies", json!({}), None).await.unwrap();
    assert_eq!(scoped["cookies"], json!([]), "cookies are scoped to the session's page hosts");

    events.send(json!({ "method": "debugger.event", "params": { "tabId": 7, "method": "Page.frameNavigated", "params": { "frame": { "id": "T7", "url": "https://example.com/" } } } })).unwrap();
    eventually("the url to update", || relay.st().tabs.get(&7).is_some_and(|t| t.url == "https://example.com/")).await;

    let gone = cdp.send("Broken.method", json!({}), None).await.unwrap_err();
    assert!(matches!(gone, CdpError::TargetClosed));
    eventually("the missing tab to be dropped", || !relay.st().tabs.contains_key(&7)).await;
    assert!(matches!(cdp.send("Runtime.evaluate", json!({}), None).await.unwrap_err(), CdpError::TargetClosed));
    loop {
        match tokio::time::timeout(Duration::from_secs(2), subscription.recv()).await.unwrap() {
            Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            _ => continue,
        }
    }
}

#[tokio::test]
async fn refuses_a_wrong_token() {
    let h = harness().await;
    let port = h.handle.port();
    pairing::issue_browser_token(&h.paths, "profile-b", None, None).unwrap();
    let mut socket = connect(port, &origin()).await.unwrap();
    let nonce = b64url(&random_bytes::<32>());
    send(&mut socket, hello("profile-b", "token", &nonce, None)).await;
    let challenge = next(&mut socket).await;
    let relay_nonce = challenge["params"]["nonce"].as_str().unwrap();
    let forged = pairing::pairing_proof(&pairing::new_browser_token(), "extension", port, &nonce, relay_nonce);
    send(&mut socket, json!({ "method": "auth.response", "params": { "proof": forged } })).await;
    let closed = next(&mut socket).await;
    assert_eq!(closed["close"], 4006);
    assert_eq!(h.handle.relay.st().handshake.pairing_failures, 1);
}

#[tokio::test]
async fn refuses_unpaired_profiles_and_other_protocols() {
    let h = harness().await;
    let port = h.handle.port();
    let mut socket = connect(port, &origin()).await.unwrap();
    send(&mut socket, json!({ "method": "protocol", "params": { "protocolVersion": 3, "unpaired": true } })).await;
    assert_eq!(next(&mut socket).await["close"], 1000);
    assert_eq!(h.handle.relay.extension_status()["pairingState"], "unpaired");

    let mut socket = connect(port, &origin()).await.unwrap();
    send(&mut socket, hello("nobody", "token", &b64url(&random_bytes::<32>()), None)).await;
    assert_eq!(next(&mut socket).await["close"], 4006);

    let mut socket = connect(port, &origin()).await.unwrap();
    send(&mut socket, json!({ "method": "protocol", "params": { "protocolVersion": 2 } })).await;
    let closed = next(&mut socket).await;
    assert_eq!(closed["close"], 4003);
    assert_eq!(closed["reason"], "Extension protocol incompatible: extension-older");
    assert_eq!(h.handle.relay.extension_status()["pairingState"], "incompatible");

    let mut socket = connect(port, &origin()).await.unwrap();
    send(&mut socket, json!({ "id": 1, "method": "nonsense" })).await;
    assert_eq!(next(&mut socket).await["close"], 4002);

    assert!(connect(port, "https://evil.example").await.is_none(), "only extension origins may open the socket");
}

#[tokio::test]
async fn exchanges_a_pairing_code_for_a_token() {
    let h = harness().await;
    let port = h.handle.port();
    let code = pairing::mint_pairing_code(&h.paths, pairing::PAIRING_CODE_TTL_MS, Some("receipt-1")).unwrap();
    let secret = loop {
        if let Ok(key) = p256::SecretKey::from_slice(&random_bytes::<32>()) {
            break key;
        }
    };
    let public = b64url(secret.public_key().to_encoded_point(false).as_bytes());
    let nonce = b64url(&random_bytes::<32>());
    let mut socket = connect(port, &origin()).await.unwrap();
    send(&mut socket, hello("profile-c", "code", &nonce, Some(&public))).await;
    let challenge = next(&mut socket).await;
    let relay_nonce = challenge["params"]["nonce"].as_str().unwrap().to_string();
    let relay_key = challenge["params"]["ecdh"].as_str().unwrap().to_string();
    let peer = p256::PublicKey::from_sec1_bytes(&from_b64url(&relay_key).unwrap()).unwrap();
    let shared = p256::ecdh::diffie_hellman(secret.to_nonzero_scalar(), peer.as_affine());
    let transcript = pairing::Transcript { port, extension_nonce: nonce.clone(), relay_nonce: relay_nonce.clone(), extension_key: public, relay_key };
    let session = pairing::pairing_session_key(&pairing::pairing_code_key(&code), shared.raw_secret_bytes(), &transcript);
    send(&mut socket, json!({ "method": "auth.code", "params": { "proof": pairing::session_proof(&session, "extension") } })).await;
    let granted = next(&mut socket).await;
    assert_eq!(granted["method"], "auth.token");
    assert_eq!(granted["params"]["proof"], pairing::session_proof(&session, "relay"));
    let token = pairing::unwrap_token(&session, granted["params"]["wrapped"].as_str().unwrap()).unwrap();
    send(&mut socket, json!({ "method": "auth.response", "params": { "proof": pairing::pairing_proof(&token, "extension", port, &nonce, &relay_nonce) } })).await;
    send(&mut socket, json!({ "method": "ready" })).await;
    let relay = h.handle.relay.clone();
    eventually("the paired browser", || relay.st().connected()).await;
    let stored = pairing::read_browser_pairings(&h.paths).remove("profile-c").unwrap();
    assert_eq!(stored.token, token);
    assert_eq!(stored.receipt.as_deref(), Some("receipt-1"));
    assert!(pairing::pending_code_keys(&h.paths).is_empty(), "a code is single use");
}

#[tokio::test]
async fn reclaims_tabs_and_releases_orphans_after_reconnect() {
    let h = harness().await;
    let port = h.handle.port();
    let relay = h.handle.relay.clone();
    relay.ensure_session("keeper").unwrap();
    relay.st().sessions.get_mut("keeper").unwrap().held.push("T21".into());
    let socket = pair_with_token(port, &h.paths, "profile-d").await;
    let (seen, events) = fake_extension(socket, 30);
    events.send(json!({ "method": "debugger.attached", "params": { "tabId": 21, "agent": true } })).unwrap();
    events.send(json!({ "method": "debugger.attached", "params": { "tabId": 22, "agent": true } })).unwrap();
    events.send(json!({ "method": "debugger.attached", "params": { "tabId": 23 } })).unwrap();
    events.send(json!({ "method": "ready" })).unwrap();
    eventually("the inventory", || relay.st().connected()).await;
    {
        let st = relay.st();
        assert_eq!(st.tabs[&21].session.as_deref(), Some("keeper"));
        assert_eq!(st.tabs[&21].owner, crate::relay::Owner::Relay);
        assert!(!st.tabs.contains_key(&22), "an agent tab no session holds is released");
        assert_eq!(st.tabs[&23].owner, crate::relay::Owner::User);
        assert_eq!(st.tabs[&23].session, None);
    }
    eventually("the release", || seen.commands("debugger.detach").iter().any(|c| c["params"] == json!({ "tabId": 22, "release": true }))).await;
}

async fn http(port: u16, method: &str, path: &str, token: Option<&str>, body: Option<Value>) -> (u16, Value) {
    let auth = token.map(|t| format!("Bearer {t}"));
    let headers: Vec<(&str, &str)> = auth.iter().map(|a| ("Authorization", a.as_str())).collect();
    let body = body.map(|b| b.to_string());
    let response = crate::client::request(port, method, path, &headers, body.as_deref().map(str::as_bytes), Duration::from_secs(5)).await.unwrap();
    (response.status, response.json().unwrap_or(Value::Null))
}

#[tokio::test]
async fn serves_the_tool_api_behind_the_token() {
    let h = harness().await;
    let port = h.handle.port();
    let token = h.handle.token().to_string();
    let (status, version) = http(port, "GET", "/version", None, None).await;
    assert_eq!(status, 200);
    assert_eq!(version["extensionProtocol"], json!({ "min": 3, "version": 3 }));
    assert!(version["instanceId"].is_string());
    assert_eq!(http(port, "GET", "/tools", None, None).await.0, 401);
    let (status, tools) = http(port, "GET", "/tools", Some(&token), None).await;
    assert_eq!(status, 200);
    let names: Vec<&str> = tools.as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
    assert!(names.contains(&"session") && names.contains(&"tabs") && names.contains(&"status"));

    let call = |arguments: Value| json!({ "name": "session", "arguments": arguments, "session": "oc-caller" });
    let (_, created) = http(port, "POST", "/tools/call", Some(&token), Some(call(json!({ "action": "new", "id": "research", "allowedOrigins": ["Example.com"] })))).await;
    let created: Value = serde_json::from_str(created["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(created["currentSession"], "research");
    assert_eq!(created["session"]["allowedOrigins"], json!(["example.com"]));
    let (_, listed) = http(port, "POST", "/tools/call", Some(&token), Some(json!({ "name": "status", "arguments": {}, "session": "oc-caller" }))).await;
    let listed: Value = serde_json::from_str(listed["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(listed["currentSession"], "research", "later calls act on the caller's current session");
    assert_eq!(listed["extension"]["pairingState"], "not-seen");

    let (_, refused) = http(port, "POST", "/tools/call", Some(&token), Some(json!({ "name": "tabs", "arguments": { "session": "missing" }, "session": "oc-caller" }))).await;
    assert_eq!(refused["isError"], true);
    let (_, deleted) = http(port, "POST", "/tools/call", Some(&token), Some(call(json!({ "action": "delete" })))).await;
    let deleted: Value = serde_json::from_str(deleted["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(deleted["currentSession"], "oc-caller");

    let catalog = std::fs::read_to_string(h.paths.session_catalog(0)).unwrap_or_default();
    assert!(!catalog.contains("research"));
}

#[tokio::test]
async fn navigation_respects_the_session_allowlist() {
    let h = harness().await;
    let relay = h.handle.relay.clone();
    let socket = pair_with_token(h.handle.port(), &h.paths, "profile-e").await;
    let (seen, events) = fake_extension(socket, 9);
    events.send(json!({ "method": "ready" })).unwrap();
    eventually("the browser", || relay.st().connected()).await;
    relay.create_session(Some("strict"), crate::browser::SessionOptions { allowed_origins: Some(vec!["example.com".into()]), ..Default::default() }).unwrap();
    let browser = h.handle.browser();
    let refused = browser.open_tab(&"strict".to_string(), Some("https://evil.test/")).await.unwrap_err();
    assert!(refused.to_string().contains("allowlist"), "{refused}");
    assert!(seen.commands("tabs.create").is_empty());
    let tab = browser.open_tab(&"strict".to_string(), None).await.unwrap();
    let cdp = browser.cdp(&"strict".to_string(), tab.tab_id).await.unwrap();
    let error = cdp.send("Page.navigate", json!({ "url": "http://10.0.0.1/" }), None).await.unwrap_err();
    assert!(matches!(error, CdpError::Protocol(m) if m.contains("allowlist")));
    events.send(json!({ "method": "debugger.event", "params": { "tabId": 9, "method": "Page.frameNavigated", "params": { "frame": { "id": "T9", "url": "https://evil.test/" } } } })).unwrap();
    eventually("the tab to be sent back", || seen.cdp("Page.navigate").iter().any(|c| c["params"]["params"]["url"] == "about:blank")).await;
    assert!(relay.st().sessions["strict"].warnings[0].contains("Domain allowlist"));
}

#[tokio::test]
async fn background_work_keeps_a_session_busy() {
    let h = harness().await;
    let browser = h.handle.browser();
    h.handle.relay.ensure_session("capturing").unwrap();
    browser.set_busy(&"capturing".to_string(), "network", true);
    assert!(h.handle.relay.st().sessions["capturing"].busy());
    assert!(!h.handle.idle(Duration::ZERO));
    browser.set_busy(&"capturing".to_string(), "network", false);
    assert!(!h.handle.relay.st().sessions["capturing"].busy());
    assert!(h.handle.idle(Duration::ZERO));
}
