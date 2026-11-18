//! The relay against a fake extension speaking the real wire protocol: pairing, CDP routing, agent tabs (each its own
//! handle), lent tabs, restarts, the HTTP API.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use browse_core::{Browser, CdpError, TabOptions, ToolContext};
use futures_util::{SinkExt, StreamExt};
use p256::elliptic_curve::sec1::ToEncodedPoint;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::Notify;
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
    harness_at(Paths::rooted(std::env::temp_dir().join(format!("browse-relay-test-{}", crate::util::random_hex(6))))).await
}

async fn harness_at(paths: Paths) -> Harness {
    let options = ServeOptions { port: Some(0), paths: paths.clone(), version: "0.0.0-test".into(), ..ServeOptions::default() };
    let handle = start(options, crate::tools()).await.unwrap();
    Harness { handle, paths }
}

fn grouped(group: &str) -> TabOptions {
    TabOptions { group: Some(group.into()), ..TabOptions::default() }
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
    assert_eq!(challenge["method"], "auth.challenge", "{challenge}");
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

/// What the fake extension answers for `Target.getTargetInfo` for a tab, per call: a queued URL is taken first ("" for
/// a popup whose first navigation hasn't committed, "!error" for an error, "!hold:<url>" waits for the tab's `held`
/// `Notify` and then answers `<url>`), then about:blank.
#[derive(Default)]
struct TargetAnswers {
    queued: HashMap<i64, VecDeque<String>>,
    held: HashMap<i64, Arc<Notify>>,
}

type TargetUrls = Arc<Mutex<TargetAnswers>>;

/// Answers the relay's commands like the extension, records them, and sends whatever is pushed to `events`.
fn fake_extension(socket: Socket, next_tab: i64) -> (Arc<Seen>, mpsc::UnboundedSender<Value>) {
    fake_extension_with_urls(socket, next_tab, TargetUrls::default())
}

fn fake_extension_with_urls(socket: Socket, next_tab: i64, urls: TargetUrls) -> (Arc<Seen>, mpsc::UnboundedSender<Value>) {
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
                "tabs.create" => {
                    let created = record.0.lock().unwrap().iter().filter(|c| c["method"] == "tabs.create").count() as i64;
                    let tab = next_tab + created - 1;
                    json!({ "tabId": tab })
                }
                "debugger.attach" => {
                    json!({})
                }
                "settings.get" | "settings.set" => json!({ "settings": { "window": "current", "grouping": "shared", "groupCollapse": "auto", "idleMinutes": 10, "humanInput": "on", "muteTabs": "off", "handoffNotifications": "recording" } }),
                "debugger.sendCommand" => match params["method"].as_str().unwrap_or("") {
                    "Target.getTargetInfo" => {
                        let tab = params["tabId"].as_i64().unwrap();
                        let (url, hold) = {
                            let mut answers = urls.lock().unwrap();
                            let url = answers.queued.get_mut(&tab).and_then(VecDeque::pop_front).unwrap_or_else(|| "about:blank".into());
                            let hold = url.strip_prefix("!hold:").and_then(|_| answers.held.remove(&tab));
                            (url, hold)
                        };
                        if let Some(hold) = hold {
                            hold.notified().await;
                        }
                        let url = url.strip_prefix("!hold:").unwrap_or(&url).to_string();
                        if url == "!error" {
                            let _ = replies.send(json!({ "id": id, "error": "Target.getTargetInfo failed" }));
                            continue;
                        }
                        json!({ "targetInfo": { "targetId": format!("T{tab}"), "type": "page", "url": url, "title": "", "attached": true } })
                    }
                    "Runtime.evaluate" => json!({ "result": { "type": "number", "value": 42 } }),
                    "Network.getCookies" => json!({ "cookies": [{ "domain": "example.com" }, { "domain": "bank.com" }] }),
                    "Big.method" => json!({ "result": { "type": "string", "value": "x".repeat(params["params"]["bytes"].as_u64().unwrap_or(0) as usize) } }),
                    "Unattachable.method" => {
                        let _ = replies.send(json!({ "id": id, "error": "Cannot attach to this target." }));
                        continue;
                    }
                    "Protected.method" => {
                        let _ = replies.send(json!({ "id": id, "error": "Cannot access a chrome-extension:// URL of different extension" }));
                        continue;
                    }
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
    let tab = browser.open_tab(None, &TabOptions::default()).await.unwrap();
    assert_eq!(tab.tab, 7);
    assert!(!tab.lent);
    assert_eq!(tab.options.browser.as_deref(), Some("test-chrome"));
    assert_eq!(seen.commands("tabs.create")[0]["params"], json!({ "url": "about:blank", "active": false }));
    assert_eq!(seen.commands("debugger.attach")[0]["params"]["tabId"], 7);
    assert_eq!(seen.cdp("Target.setAutoAttach")[0]["params"]["params"], json!({ "autoAttach": true, "waitForDebuggerOnStart": false, "flatten": true }));
    assert!(seen.cdp("Runtime.enable").is_empty(), "the relay never enables Runtime on its own");

    let cdp = browser.cdp(7).await.unwrap();
    assert!(Arc::ptr_eq(&cdp, &browser.cdp(7).await.unwrap()), "one handle per attachment");
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
    assert_eq!(scoped["cookies"], json!([]), "cookies are scoped to the tab's page hosts");

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
    // A refusal outranks the fresh relay's pairing: it is not reported as a reconnect.
    let status = h.handle.relay.extension_status();
    assert_eq!(status["pairingState"], "refused");
    assert_eq!(status["reconnecting"], false);
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
    let held = crate::registry::PersistedTab { tab: 21, target_id: "T21".into(), browser_key: "profile-d".into(), opener: None, options: grouped("keeper"), created_at: String::new(), chosen: None, lent: false };
    relay.st().restorable.insert("T21".into(), held);
    let socket = pair_with_token(port, &h.paths, "profile-d").await;
    let (seen, events) = fake_extension(socket, 30);
    events.send(json!({ "method": "debugger.attached", "params": { "tabId": 21, "agent": true } })).unwrap();
    events.send(json!({ "method": "debugger.attached", "params": { "tabId": 22, "agent": true } })).unwrap();
    events.send(json!({ "method": "debugger.attached", "params": { "tabId": 23 } })).unwrap();
    events.send(json!({ "method": "ready" })).unwrap();
    eventually("the inventory", || relay.st().connected()).await;
    {
        let st = relay.st();
        assert_eq!(st.tabs[&21].owner, crate::relay::Owner::Relay);
        assert_eq!(st.tabs[&21].options.group.as_deref(), Some("keeper"), "a reclaimed tab keeps its options");
        assert!(!st.tabs.contains_key(&22), "an agent tab browse has no record of is released");
        assert_eq!(st.tabs[&23].owner, crate::relay::Owner::User, "a lent tab stays lent");
        assert!(st.restorable.is_empty());
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
    assert!(names.contains(&"tabs") && names.contains(&"status") && names.contains(&"handoff"), "{names:?}");
    assert!(!names.contains(&"session") && !names.contains(&"tabs_cleanup"), "{names:?}");

    // The status call takes no caller, and the old proxies' `session` field is ignored.
    let (_, listed) = http(port, "POST", "/tools/call", Some(&token), Some(json!({ "name": "status", "arguments": {}, "session": "oc-caller" }))).await;
    let listed = text(&listed);
    assert_eq!(listed["extension"]["pairingState"], "not-seen");
    assert!(listed.get("currentSession").is_none() && listed.get("sessions").is_none(), "{listed}");
    let (_, tabs) = http(port, "POST", "/tools/call", Some(&token), Some(json!({ "name": "tabs", "arguments": {} }))).await;
    assert_eq!(text(&tabs), json!({ "tabs": [] }));
}

/// The relay picks a client's tools and instructions by the name the MCP proxy forwards.
#[tokio::test]
async fn the_client_name_decides_tools_and_instructions() {
    if std::env::var_os("OPENCODE_BROWSER_TOOLS").is_some() {
        return;
    }
    let h = harness().await;
    let port = h.handle.port();
    let auth = format!("Bearer {}", h.handle.token());
    let get = |path: &'static str, client: &'static str| {
        let auth = auth.clone();
        async move {
            let headers = [("Authorization", auth.as_str()), (browse_core::CLIENT_HEADER, client)];
            crate::client::request(port, "GET", path, &headers, None, Duration::from_secs(5)).await.unwrap().json().unwrap()
        }
    };
    let names = |tools: Value| tools.as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap().to_string()).collect::<Vec<_>>();
    // This registry has no execute tool; the execute surface keeps status and tabs.
    assert_eq!(names(get("/tools", "claude-code").await), ["status", "tabs"]);
    assert!(names(get("/tools", "opencode").await).contains(&"handoff".to_string()));
    let plain = get("/instructions", "opencode").await;
    assert!(plain["instructions"].as_str().unwrap().contains("Tabs are the handle"), "{plain}");
    let scripted = get("/instructions", "cursor").await;
    assert!(scripted["instructions"].as_str().unwrap().contains("execute"), "{scripted}");
}

#[tokio::test]
async fn navigation_respects_the_tab_allowlist() {
    let h = harness().await;
    let relay = h.handle.relay.clone();
    let socket = pair_with_token(h.handle.port(), &h.paths, "profile-e").await;
    let (seen, events) = fake_extension(socket, 9);
    events.send(json!({ "method": "ready" })).unwrap();
    eventually("the browser", || relay.st().connected()).await;
    let browser = h.handle.browser();
    let strict = TabOptions { allowed_origins: Some(vec!["Example.com".into()]), ..TabOptions::default() };
    let refused = browser.open_tab(Some("https://evil.test/"), &strict).await.unwrap_err();
    assert!(refused.to_string().contains("allowlist"), "{refused}");
    assert!(seen.commands("tabs.create").is_empty());
    let tab = browser.open_tab(None, &strict).await.unwrap();
    assert_eq!(tab.options.allowed_origins, Some(vec!["example.com".to_string()]), "the allowlist is normalized");
    let cdp = browser.cdp(tab.tab).await.unwrap();
    let error = cdp.send("Page.navigate", json!({ "url": "http://10.0.0.1/" }), None).await.unwrap_err();
    assert!(matches!(error, CdpError::Protocol(m) if m.contains("allowlist")));
    events.send(json!({ "method": "debugger.event", "params": { "tabId": 9, "method": "Page.frameNavigated", "params": { "frame": { "id": "T9", "url": "https://evil.test/" } } } })).unwrap();
    eventually("the tab to be sent back", || seen.cdp("Page.navigate").iter().any(|c| c["params"]["params"]["url"] == "about:blank")).await;
    assert!(relay.st().tabs[&9].warnings[0].contains("Domain allowlist"), "the tab carries the news to its next call");
}

#[tokio::test]
async fn background_work_keeps_a_tab_busy() {
    let (h, _seen, _events) = connected("profile-busy", 200).await;
    let browser = h.handle.browser();
    let tab = browser.open_tab(None, &TabOptions::default()).await.unwrap().tab;
    let other = browser.open_tab(None, &TabOptions::default()).await.unwrap().tab;
    let relay = h.handle.relay.clone();
    relay.st().last_activity = std::time::Instant::now() - Duration::from_secs(60);
    browser.set_busy(tab, "network", true);
    assert!(relay.st().tab_busy(tab));
    assert!(!relay.st().tab_busy(other), "busy is per tab");
    assert!(!relay.idle(Duration::ZERO));
    browser.set_busy(tab, "network", false);
    assert!(!relay.st().tab_busy(tab));
    assert!(relay.idle(Duration::ZERO));
}

/// An agent's `browse mcp` server lives as long as the agent, so connected clients can't hold an update back: only
/// calls, handoffs and recent activity do.
#[tokio::test]
async fn a_quiet_connected_client_does_not_keep_the_relay_from_going_idle() {
    let (h, _seen, _events) = connected("profile-quiet-client", 240).await;
    let relay = h.handle.relay.clone();
    let task = tokio::spawn(async { std::future::pending::<()>().await });
    relay.call_started(1, task.abort_handle(), Some(std::process::id()), None);
    relay.st().last_activity = std::time::Instant::now() - Duration::from_secs(60);
    assert!(!relay.idle(Duration::ZERO), "a running call still holds the relay");
    relay.call_finished(1);
    assert!(relay.st().clients.contains(&std::process::id()), "the client that called is still alive");
    assert!(relay.idle(Duration::ZERO), "a quiet connected client doesn't hold an update back");
    task.abort();
}

async fn connected(profile: &str, next_tab: i64) -> (Harness, Arc<Seen>, mpsc::UnboundedSender<Value>) {
    connected_with_urls(profile, next_tab, TargetUrls::default()).await
}

async fn connected_with_urls(profile: &str, next_tab: i64, urls: TargetUrls) -> (Harness, Arc<Seen>, mpsc::UnboundedSender<Value>) {
    let h = harness().await;
    let socket = pair_with_token(h.handle.port(), &h.paths, profile).await;
    let (seen, events) = fake_extension_with_urls(socket, next_tab, urls);
    events.send(json!({ "method": "ready" })).unwrap();
    let relay = h.handle.relay.clone();
    eventually("the browser to connect", || relay.st().connected()).await;
    (h, seen, events)
}

fn text(output: &Value) -> Value {
    serde_json::from_str(output["content"][0]["text"].as_str().unwrap_or("null")).unwrap_or(Value::Null)
}

/// Two agents working at once each open their own tab and only touch the ids they got: no current tab to fight over.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn agents_in_parallel_never_touch_each_others_tabs() {
    let (h, seen, _events) = connected("profile-race", 40).await;
    let relay = h.handle.relay.clone();
    let opened: Vec<_> = ["alpha", "beta", "alpha", "beta"]
        .into_iter()
        .map(|group| {
            let relay = relay.clone();
            tokio::spawn(async move {
                let request = browse_core::ToolCallRequest { name: "tabs".into(), arguments: json!({ "action": "new", "group": group }) };
                let output = crate::serve::call_tool(&relay, request, None).await.unwrap();
                let info: Value = serde_json::from_str(match &output.content[0] {
                    browse_core::Content::Text { text } => text,
                    _ => "null",
                })
                .unwrap();
                (group, info["tab"].as_i64().unwrap())
            })
        })
        .collect();
    let mut tabs = Vec::new();
    for call in opened {
        tabs.push(call.await.unwrap());
    }
    assert_eq!(seen.commands("tabs.create").len(), 4, "every opening agent gets its own tab");
    let mut ids: Vec<i64> = tabs.iter().map(|(_, tab)| *tab).collect();
    ids.sort();
    ids.dedup();
    assert_eq!(ids.len(), 4, "{tabs:?}");
    // Each agent's commands go to its own tab only.
    let browser = h.handle.browser();
    for (_, tab) in &tabs {
        browser.cdp(*tab).await.unwrap().send("Runtime.evaluate", json!({ "expression": "1" }), None).await.unwrap();
    }
    let targets: Vec<i64> = seen.cdp("Runtime.evaluate").iter().map(|c| c["params"]["tabId"].as_i64().unwrap()).collect();
    assert_eq!(targets, tabs.iter().map(|(_, tab)| *tab).collect::<Vec<_>>());
    // Closing one agent's group leaves the other's tabs alone.
    let request = browse_core::ToolCallRequest { name: "tabs".into(), arguments: json!({ "action": "close", "group": "alpha" }) };
    let closed = text(&serde_json::to_value(crate::serve::call_tool(&relay, request, None).await.unwrap()).unwrap());
    let alpha: Vec<i64> = tabs.iter().filter(|(g, _)| *g == "alpha").map(|(_, t)| *t).collect();
    let mut closed_ids: Vec<i64> = closed["closed"].as_array().unwrap().iter().map(|v| v.as_i64().unwrap()).collect();
    closed_ids.sort();
    let mut expected = alpha.clone();
    expected.sort();
    assert_eq!(closed_ids, expected, "{closed}");
    for (group, tab) in &tabs {
        assert_eq!(relay.st().tabs.contains_key(tab), *group == "beta", "tab {tab} of {group}");
    }
}

#[test]
#[should_panic(expected = "already held")]
fn retaking_the_state_lock_panics_instead_of_deadlocking() {
    let paths = Paths::rooted(std::env::temp_dir().join(format!("browse-relay-lock-{}", crate::util::random_hex(6))));
    let relay = crate::relay::Relay::new(crate::relay::RelayConfig {
        paths,
        configured_port: 0,
        port: 0,
        host: "127.0.0.1".into(),
        version: "0".into(),
        build_id: String::new(),
        auto_update: None,
    })
    .unwrap();
    let held = relay.st();
    assert!(relay.holder.lock().unwrap().is_some());
    // The temporary in an `if let` scrutinee lives for the whole block: the bug class this catches.
    if let Some(_tab) = held.tabs.get(&1) {}
    let _again = relay.st();
}

#[test]
fn the_state_lock_can_be_taken_again_once_released() {
    let paths = Paths::rooted(std::env::temp_dir().join(format!("browse-relay-lock-{}", crate::util::random_hex(6))));
    let config = |paths: Paths| crate::relay::RelayConfig {
        paths,
        configured_port: 0,
        port: 0,
        host: "127.0.0.1".into(),
        version: "0".into(),
        build_id: String::new(),
        auto_update: None,
    };
    let one = crate::relay::Relay::new(config(paths.clone())).unwrap();
    let two = crate::relay::Relay::new(config(paths.clone())).unwrap();
    {
        let _a = one.st();
        let _b = two.st();
    }
    drop(one.st());
    let _c = one.st();
    assert!(one.holder.lock().unwrap().is_some());
    drop(_c);
    assert!(one.holder.lock().unwrap().is_none());
    let _ = std::fs::remove_dir_all(&paths.data);
}

#[test]
fn an_address_never_replaces_a_known_browser_name() {
    let paths = Paths::rooted(std::env::temp_dir().join(format!("browse-relay-names-{}", crate::util::random_hex(6))));
    let relay = crate::relay::Relay::new(crate::relay::RelayConfig {
        paths: paths.clone(),
        configured_port: 0,
        port: 0,
        host: "127.0.0.1".into(),
        version: "0".into(),
        build_id: String::new(),
        auto_update: None,
    })
    .unwrap();
    let mut st = relay.st();
    assert_eq!(st.identify(&paths, "k", "Chrome on 100.93.238.48", true), ("chrome-100-93-238-48".into(), "Chrome on 100.93.238.48".into()));
    assert_eq!(st.identify(&paths, "k", "Chrome on apollo", false), ("chrome-apollo".into(), "Chrome on apollo".into()), "a looked-up name wins");
    assert_eq!(st.identify(&paths, "k", "Chrome on 100.93.238.48", true), ("chrome-apollo".into(), "Chrome on apollo".into()), "an address doesn't");
    drop(st);
    let _ = std::fs::remove_dir_all(&paths.data);
}

#[tokio::test]
async fn tells_a_typescript_client_to_restart() {
    let h = harness().await;
    let port = h.handle.port();
    let token = h.handle.token().to_string();
    for (method, path) in [("GET", "/cli/sessions"), ("POST", "/v1/sessions/ensure"), ("POST", "/cli/execute"), ("GET", "/json/version"), ("GET", "/json/list"), ("POST", "/network/start"), ("GET", "/recording/status"), ("POST", "/tabs/cleanup"), ("GET", "/settings")] {
        assert_eq!(http(port, method, path, None, None).await.0, 401, "{path} still needs the token");
        // Only the POSTs carry a body, as their client did: a GET body has no meaning here.
        let sent = (method == "POST").then(|| json!({}));
        let (status, body) = http(port, method, path, Some(&token), sent).await;
        assert_eq!(status, 410, "{path}");
        assert_eq!(body, json!({ "error": crate::serve::LEGACY_CLIENT }), "{path}: an envelope the old client shows as is");
    }
    assert_eq!(http(port, "GET", "/nothing", Some(&token), None).await.0, 404);
    assert_eq!(http(port, "GET", "/extension/status", Some(&token), None).await.0, 200);
    let auth = format!("Bearer {token}");
    let headers = [("Authorization", auth.as_str()), ("b3", "aa9d92562c43cc66ff058acafdd739a5-6f0c2ae0224bd859-1")];
    let response = crate::client::request(port, "GET", "/extension/status", &headers, None, Duration::from_secs(5)).await.unwrap();
    assert_eq!((response.status, response.json().unwrap()), (410, json!({ "error": crate::serve::LEGACY_CLIENT })), "the TypeScript client's extension check");

    // connectOverCDP with the WebSocket URL the TypeScript relay's /json/version gave out.
    let upgrade = |token: &str| format!("ws://127.0.0.1:{port}/devtools/browser/abc?opencodeBrowserToken={token}");
    match tokio_tungstenite::connect_async(upgrade(&token)).await {
        Err(tokio_tungstenite::tungstenite::Error::Http(response)) => {
            assert_eq!(response.status(), 410);
            let body: Value = serde_json::from_slice(response.body().as_deref().unwrap_or_default()).unwrap();
            assert_eq!(body["error"], crate::serve::LEGACY_CLIENT);
        }
        other => panic!("expected a refused upgrade, got {:?}", other.map(|(_, response)| response.status())),
    }
    match tokio_tungstenite::connect_async(upgrade("wrong")).await {
        Err(tokio_tungstenite::tungstenite::Error::Http(response)) => assert_eq!(response.status(), 401),
        other => panic!("expected 401, got {:?}", other.map(|(_, response)| response.status())),
    }
}

/// A GET can announce a body, though HTTP gives it no meaning. The relay reads it before it answers: closing with
/// body bytes still unread makes the kernel send a reset instead of a clean close, and a macOS client then loses the
/// answer it hasn't read yet.
#[tokio::test]
async fn reads_a_body_announced_on_a_get() {
    let h = harness().await;
    let port = h.handle.port();
    let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let head = format!(
        "GET /cli/sessions HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n",
        h.handle.token()
    );
    stream.write_all(head.as_bytes()).await.unwrap();
    let mut first = [0u8; 64];
    assert!(tokio::time::timeout(Duration::from_millis(250), stream.read(&mut first)).await.is_err(), "the relay answered before the body it was promised");
    stream.write_all(b"{}").await.unwrap();
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).await.unwrap();
    let raw = String::from_utf8_lossy(&raw);
    assert!(raw.starts_with("HTTP/1.1 410"), "{raw}");
}

/// A request the relay turns away (this one without a token) still gets its body read before the answer: closing with
/// body bytes still unread makes the kernel send a reset instead of a clean close, and a macOS client then loses the
/// 401 it hasn't read yet.
#[tokio::test]
async fn reads_a_body_before_turning_a_request_away() {
    let h = harness().await;
    let port = h.handle.port();
    let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let head = format!("POST /tools/cancel HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n");
    stream.write_all(head.as_bytes()).await.unwrap();
    let mut first = [0u8; 64];
    assert!(tokio::time::timeout(Duration::from_millis(250), stream.read(&mut first)).await.is_err(), "the relay answered before the body it was promised");
    stream.write_all(b"{}").await.unwrap();
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).await.unwrap();
    let raw = String::from_utf8_lossy(&raw);
    assert!(raw.starts_with("HTTP/1.1 401"), "{raw}");
}

/// A client announcing `Expect: 100-continue` hasn't sent its body: the relay answers without polling it (a poll
/// would send `100 Continue` and invite an upload to a request it is turning away) and closes the connection.
#[tokio::test]
async fn a_continue_expectation_gets_no_continue() {
    let h = harness().await;
    let port = h.handle.port();
    let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let head = format!("POST /tools/cancel HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\nContent-Length: 2\r\nExpect: 100-continue\r\n\r\n");
    stream.write_all(head.as_bytes()).await.unwrap();
    let mut raw = Vec::new();
    tokio::time::timeout(Duration::from_secs(2), stream.read_to_end(&mut raw)).await.expect("the relay answers without the body").unwrap();
    let raw = String::from_utf8_lossy(&raw);
    assert!(raw.starts_with("HTTP/1.1 401"), "{raw}");
    assert!(!raw.contains("100 Continue"), "{raw}");
    assert!(raw.to_ascii_lowercase().contains("connection: close"), "{raw}");
}

/// A body announced over MAX_BODY is refused from its size alone: no byte of it is read, so the relay answers promptly
/// and closes the connection.
#[tokio::test]
async fn an_announced_body_over_the_limit_is_refused_unread() {
    let h = harness().await;
    let port = h.handle.port();
    let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let head = format!(
        "POST /tools/cancel HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n",
        h.handle.token(),
        crate::serve::MAX_BODY + 1
    );
    stream.write_all(head.as_bytes()).await.unwrap();
    let mut raw = Vec::new();
    tokio::time::timeout(Duration::from_secs(2), stream.read_to_end(&mut raw)).await.expect("the relay refuses the announced size without the body").unwrap();
    let raw = String::from_utf8_lossy(&raw);
    assert!(raw.starts_with("HTTP/1.1 413"), "{raw}");
}

#[tokio::test]
async fn version_reports_every_relay_as_managed() {
    let paths = Paths::rooted(std::env::temp_dir().join(format!("browse-relay-test-{}", crate::util::random_hex(6))));
    let options = ServeOptions { port: Some(0), paths: paths.clone(), ..ServeOptions::default() };
    let handle = start(options, crate::tools()).await.unwrap();
    let (_, version) = http(handle.port(), "GET", "/version", None, None).await;
    assert_eq!(version["managed"], true);
    handle.stop();
    let _ = std::fs::remove_dir_all(&paths.data);
}

/// The shutdown's final registry write closes the file for good: a persist still queued behind it (a blocking task
/// outliving the aborted persister) must not recreate the registry after relay.json goes.
#[test]
fn a_persist_queued_after_the_final_one_does_nothing() {
    let paths = Paths::rooted(std::env::temp_dir().join(format!("browse-relay-final-persist-{}", crate::util::random_hex(6))));
    let relay = crate::relay::Relay::new(crate::relay::RelayConfig {
        paths: paths.clone(),
        configured_port: 0,
        port: 0,
        host: "127.0.0.1".into(),
        version: "0".into(),
        build_id: String::new(),
        auto_update: None,
    })
    .unwrap();
    relay.persist_now();
    assert!(paths.tab_registry(0).is_file(), "a normal persist writes");
    relay.persist_final();
    std::fs::remove_file(paths.tab_registry(0)).unwrap();
    relay.persist_now();
    relay.persist_final();
    assert!(!paths.tab_registry(0).exists(), "a persist queued after the final one must not recreate the registry");
    let _ = std::fs::remove_dir_all(&paths.data);
}

#[tokio::test]
async fn another_extensions_popup_blocks_the_tab_without_dropping_it() {
    let (h, _seen, events) = connected("profile-protected", 50).await;
    let relay = h.handle.relay.clone();
    let browser = h.handle.browser();
    let tab = browser.open_tab(None, &TabOptions::default()).await.unwrap().tab;
    let cdp = browser.cdp(tab).await.unwrap();
    let mut subscription = cdp.events();
    let page = |method: &str, params: Value| json!({ "method": "debugger.event", "params": { "tabId": tab, "method": method, "params": params } });
    events.send(page("Page.frameAttached", json!({ "frameId": "PM", "parentFrameId": "T50" }))).unwrap();
    events.send(page("Page.frameNavigated", json!({ "frame": { "id": "PM", "parentId": "T50", "url": "chrome-extension://manager/menu.html" } }))).unwrap();
    let attached = tokio::time::timeout(Duration::from_secs(2), subscription.recv()).await.unwrap().unwrap();
    assert_eq!(attached.method, "Page.frameAttached");
    let retracted = tokio::time::timeout(Duration::from_secs(2), subscription.recv()).await.unwrap().unwrap();
    assert_eq!((retracted.method.as_str(), retracted.params["frameId"].as_str()), ("Page.frameDetached", Some("PM")), "the extension's frame is retracted, its navigation hidden");
    eventually("the tab to be marked blocked", || relay.st().tabs.get(&tab).is_some_and(|t| t.protected_ui)).await;

    let error = cdp.send("Protected.method", json!({}), None).await.unwrap_err();
    assert!(error.to_string().contains("Another extension's popup"), "{error}");
    events.send(json!({ "method": "debugger.detached", "params": { "tabId": tab, "reason": "target_closed" } })).unwrap();
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(relay.st().tabs.contains_key(&tab), "the tab stays the agent's");

    events.send(page("Page.frameDetached", json!({ "frameId": "PM" }))).unwrap();
    eventually("the block to lift", || relay.st().tabs.get(&tab).is_some_and(|t| !t.protected_ui)).await;
}

#[tokio::test]
async fn closed_tabs_say_why_and_leave_the_registry() {
    let (h, _seen, _events) = connected("profile-close", 60).await;
    let relay = h.handle.relay.clone();
    let browser = h.handle.browser();
    let first = browser.open_tab(None, &grouped("work")).await.unwrap().tab;
    let second = browser.open_tab(None, &TabOptions::default()).await.unwrap().tab;
    assert_ne!(first, second);
    browser.close_tab(second).await.unwrap();
    let error = browser.cdp(second).await.err().unwrap().to_string();
    assert!(error.contains(&format!("Tab {second} is gone")) && error.contains("closed with the tabs tool") && error.contains("navigate"), "{error}");
    let unknown = browser.cdp(4242).await.err().unwrap().to_string();
    assert!(unknown.contains("isn't a browse tab"), "{unknown}");
    relay.persist_now();
    let registry: Value = serde_json::from_str(&std::fs::read_to_string(h.paths.tab_registry(0)).unwrap()).unwrap();
    assert_eq!(registry["tabs"], json!([{ "tab": first, "targetId": format!("T{first}"), "browserKey": "profile-close", "group": "work", "createdAt": registry["tabs"][0]["createdAt"] }]));
}

/// The extension shows an agent tab in its group: the group label names it, and a tab without one goes in the shared
/// agent group (the extension's Grouping setting decides the rest).
#[tokio::test]
async fn tab_groups_follow_the_group_label() {
    let (h, seen, _events) = connected("profile-groups", 70).await;
    let browser = h.handle.browser();
    let labelled = browser.open_tab(None, &grouped("orw-counter")).await.unwrap().tab;
    let plain = browser.open_tab(None, &TabOptions::default()).await.unwrap().tab;
    eventually("both tabs grouped", || seen.commands("tabs.group").len() >= 2).await;
    let group_of = |tab: i64| seen.commands("tabs.group").into_iter().find(|c| c["params"]["tabId"] == tab).map(|c| c["params"].clone()).unwrap();
    assert_eq!(group_of(labelled)["sessionId"], "orw-counter");
    assert!(group_of(plain).get("sessionId").is_none());
    eventually("page status", || seen.commands("pageStatus.set").iter().any(|c| c["params"]["tabId"] == labelled)).await;
    let status = seen.commands("pageStatus.set").into_iter().find(|c| c["params"]["tabId"] == labelled).unwrap();
    assert_eq!(status["params"]["status"]["owner"], "session");
    assert_eq!(status["params"]["status"]["sessionId"], "orw-counter", "the extension names the agent by the group");
}

/// A popup an agent's page opens is an agent tab too, with the opener's options, and its group closes with it.
#[tokio::test]
async fn popups_inherit_their_openers_options() {
    let (h, _seen, events) = connected("profile-popup", 80).await;
    let relay = h.handle.relay.clone();
    let browser = h.handle.browser();
    let options = TabOptions { group: Some("shop".into()), allowed_origins: Some(vec!["example.com".into()]), read_only: true, ..TabOptions::default() };
    let opener = browser.open_tab(None, &options).await.unwrap().tab;
    events.send(json!({ "method": "tabs.opened", "params": { "tabId": 95, "openerTabId": opener } })).unwrap();
    eventually("the popup to attach", || relay.st().tabs.contains_key(&95)).await;
    let popup = browser.tabs().await.unwrap().into_iter().find(|t| t.tab == 95).unwrap();
    assert!(!popup.lent);
    assert_eq!(popup.opener, Some(opener));
    assert_eq!(popup.options.group.as_deref(), Some("shop"));
    assert_eq!(popup.options.allowed_origins, Some(vec!["example.com".to_string()]));
    assert!(popup.options.read_only);
    assert!(browser.read_only(opener).await);
    assert!(browser.read_only(popup.tab).await);
    let blocked = browser.cdp(95).await.unwrap().send("Input.dispatchKeyEvent", json!({}), None).await.unwrap_err();
    assert!(blocked.to_string().contains("read-only"), "{blocked}");
    // A lent tab's popups don't count while no agent works in it.
    events.send(json!({ "method": "toolbar.clicked", "params": { "tabId": 96 } })).unwrap();
    eventually("the lent tab", || relay.st().tabs.contains_key(&96)).await;
    events.send(json!({ "method": "tabs.opened", "params": { "tabId": 97, "openerTabId": 96 } })).unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!relay.st().tabs.contains_key(&97));
}

/// A popup attaches before its first navigation commits and reports no URL yet: that is nothing to check, so it stays
/// open and the first document that really commits decides. Once one did, a later disallowed navigation blanks it
/// rather than closing it (cli/src/session-manager/navigation-guard.ts).
#[tokio::test]
async fn a_popup_without_a_committed_document_stays_open() {
    let urls = TargetUrls::default();
    urls.lock().unwrap().queued.insert(101, VecDeque::from(["".to_string(), "".to_string()]));
    let (h, seen, events) = connected_with_urls("profile-popup-blank", 100, urls).await;
    let relay = h.handle.relay.clone();
    let browser = h.handle.browser();
    let options = TabOptions { allowed_origins: Some(vec!["example.com".into()]), ..TabOptions::default() };
    let opener = browser.open_tab(None, &options).await.unwrap().tab;
    events.send(json!({ "method": "tabs.opened", "params": { "tabId": 101, "openerTabId": opener } })).unwrap();
    eventually("the popup to attach", || seen.commands("debugger.attach").iter().any(|c| c["params"]["tabId"] == 101)).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(relay.st().tabs.contains_key(&101), "a popup whose first document hasn't committed is not closed");
    assert!(seen.commands("tabs.remove").iter().all(|c| c["params"]["tabId"] != 101));
    let asked = |see: &Seen| see.cdp("Target.getTargetInfo").iter().filter(|c| c["params"]["tabId"] == 101).count();
    assert!(asked(&seen) >= 2, "the attach URL is asked again now that the tab's events are routed");
    events.send(json!({ "method": "debugger.event", "params": { "tabId": 101, "method": "Page.frameNavigated", "params": { "frame": { "id": "T101", "url": "https://example.com/shop" } } } })).unwrap();
    eventually("the committed url", || relay.st().tabs.get(&101).is_some_and(|t| t.url == "https://example.com/shop")).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(relay.st().tabs.contains_key(&101), "an allowed first document keeps the popup open");
    events.send(json!({ "method": "debugger.event", "params": { "tabId": 101, "method": "Page.frameNavigated", "params": { "frame": { "id": "T101", "url": "https://evil.test/" } } } })).unwrap();
    eventually("the popup to be blanked", || seen.cdp("Page.navigate").iter().any(|c| c["params"]["tabId"] == 101 && c["params"]["params"]["url"] == "about:blank")).await;
    assert!(relay.st().tabs.contains_key(&101), "a popup that already committed is blanked, not closed");
    assert!(seen.commands("tabs.remove").iter().all(|c| c["params"]["tabId"] != 101));
}

/// Once a popup's first document commits, the allowlist decides it as before: a disallowed one closes the popup.
#[tokio::test]
async fn a_popups_first_document_must_be_allowed() {
    let urls = TargetUrls::default();
    urls.lock().unwrap().queued.insert(106, VecDeque::from(["".to_string()]));
    let (h, seen, events) = connected_with_urls("profile-popup-refused", 105, urls).await;
    let relay = h.handle.relay.clone();
    let browser = h.handle.browser();
    let options = TabOptions { allowed_origins: Some(vec!["example.com".into()]), ..TabOptions::default() };
    let opener = browser.open_tab(None, &options).await.unwrap().tab;
    events.send(json!({ "method": "tabs.opened", "params": { "tabId": 106, "openerTabId": opener } })).unwrap();
    eventually("the popup to attach", || relay.st().tabs.contains_key(&106)).await;
    events.send(json!({ "method": "debugger.event", "params": { "tabId": 106, "method": "Page.frameNavigated", "params": { "frame": { "id": "T106", "url": "https://evil.test/" } } } })).unwrap();
    eventually("the popup to close", || seen.commands("tabs.remove").iter().any(|c| c["params"]["tabId"] == 106)).await;
    eventually("the popup to leave the tabs list", || !relay.st().tabs.contains_key(&106)).await;
    assert!(relay.st().tabs[&opener].warnings.iter().any(|w| w.contains("Domain allowlist")), "a closed popup's news goes to its opener");
}

/// A disallowed commit in the gap between setup_tab's snapshot and the tab being in st.tabs never reaches
/// observe_navigation: asking Target.getTargetInfo again after the attach catches it.
#[tokio::test]
async fn a_commit_before_the_popup_is_routed_still_closes_it() {
    let urls = TargetUrls::default();
    urls.lock().unwrap().queued.insert(111, VecDeque::from(["".to_string(), "https://evil.test/".to_string()]));
    let (h, seen, events) = connected_with_urls("profile-popup-gap", 110, urls).await;
    let relay = h.handle.relay.clone();
    let browser = h.handle.browser();
    let options = TabOptions { allowed_origins: Some(vec!["example.com".into()]), ..TabOptions::default() };
    let opener = browser.open_tab(None, &options).await.unwrap().tab;
    events.send(json!({ "method": "tabs.opened", "params": { "tabId": 111, "openerTabId": opener } })).unwrap();
    eventually("the popup to close", || seen.commands("tabs.remove").iter().any(|c| c["params"]["tabId"] == 111)).await;
    eventually("the popup to leave the tabs list", || !relay.st().tabs.contains_key(&111)).await;
    assert!(relay.st().tabs[&opener].warnings.iter().any(|w| w.contains("Domain allowlist")), "a closed popup's news goes to its opener");
}

/// A fresh popup whose URL can't be asked again is unverified: under an allowlist it is closed rather than left blank.
#[tokio::test]
async fn a_fresh_popup_is_closed_when_its_url_cannot_be_checked() {
    let urls = TargetUrls::default();
    urls.lock().unwrap().queued.insert(116, VecDeque::from(["".to_string(), "!error".to_string()]));
    let (h, seen, events) = connected_with_urls("profile-popup-unverified", 115, urls).await;
    let relay = h.handle.relay.clone();
    let browser = h.handle.browser();
    let options = TabOptions { allowed_origins: Some(vec!["example.com".into()]), ..TabOptions::default() };
    let opener = browser.open_tab(None, &options).await.unwrap().tab;
    events.send(json!({ "method": "tabs.opened", "params": { "tabId": 116, "openerTabId": opener } })).unwrap();
    eventually("the popup to close", || seen.commands("tabs.remove").iter().any(|c| c["params"]["tabId"] == 116)).await;
    eventually("the popup to leave the tabs list", || !relay.st().tabs.contains_key(&116)).await;
    assert!(relay.st().tabs[&opener].warnings.iter().any(|w| w.contains("could not confirm")), "the opener carries the news");
}

/// Without an allowlist there is nothing to check, so a failed re-query changes nothing.
#[tokio::test]
async fn a_popup_without_an_allowlist_stays_open_when_its_url_cannot_be_checked() {
    let urls = TargetUrls::default();
    urls.lock().unwrap().queued.insert(121, VecDeque::from(["".to_string(), "!error".to_string()]));
    let (h, seen, events) = connected_with_urls("profile-popup-unverified-open", 120, urls).await;
    let relay = h.handle.relay.clone();
    let browser = h.handle.browser();
    let opener = browser.open_tab(None, &TabOptions::default()).await.unwrap().tab;
    events.send(json!({ "method": "tabs.opened", "params": { "tabId": 121, "openerTabId": opener } })).unwrap();
    eventually("the popup's url asked again", || seen.cdp("Target.getTargetInfo").iter().filter(|c| c["params"]["tabId"] == 121).count() >= 2).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(relay.st().tabs.contains_key(&121));
    assert!(seen.commands("tabs.remove").iter().all(|c| c["params"]["tabId"] != 121));
}

/// An event during the re-query can set the stored URL without it being checked, so a changed URL doesn't mean the
/// popup was decided: the reply still has to check it.
#[tokio::test]
async fn a_document_described_during_the_recheck_is_still_checked() {
    let urls = TargetUrls::default();
    let release = Arc::new(Notify::new());
    {
        let mut answers = urls.lock().unwrap();
        answers.queued.insert(126, VecDeque::from(["".to_string(), "!hold:https://evil.test/".to_string()]));
        answers.held.insert(126, release.clone());
    }
    let (h, seen, events) = connected_with_urls("profile-popup-changed", 125, urls).await;
    let relay = h.handle.relay.clone();
    let browser = h.handle.browser();
    let options = TabOptions { allowed_origins: Some(vec!["example.com".into()]), ..TabOptions::default() };
    let opener = browser.open_tab(None, &options).await.unwrap().tab;
    events.send(json!({ "method": "tabs.opened", "params": { "tabId": 126, "openerTabId": opener } })).unwrap();
    let asked = |see: &Seen| see.cdp("Target.getTargetInfo").iter().filter(|c| c["params"]["tabId"] == 126).count();
    eventually("the popup's url asked again", || asked(&seen) >= 2).await;
    events.send(json!({ "method": "debugger.event", "params": { "tabId": 126, "method": "Target.targetInfoChanged", "params": { "targetInfo": { "targetId": "T126", "url": "https://evil.test/", "title": "" } } } })).unwrap();
    eventually("the url the event carried", || relay.st().tabs.get(&126).is_some_and(|t| t.url == "https://evil.test/")).await;
    release.notify_one();
    eventually("the popup to close", || seen.commands("tabs.remove").iter().any(|c| c["params"]["tabId"] == 126)).await;
    eventually("the popup to leave the tabs list", || !relay.st().tabs.contains_key(&126)).await;
    assert!(relay.st().tabs[&opener].warnings.iter().any(|w| w.contains("Domain allowlist")), "the opener carries the news");
}

/// The same with a failed reply: an event that set a URL without checking it still leaves a fresh popup that has to be
/// closed.
#[tokio::test]
async fn a_failed_recheck_closes_a_popup_whose_url_an_event_set() {
    let urls = TargetUrls::default();
    let release = Arc::new(Notify::new());
    {
        let mut answers = urls.lock().unwrap();
        answers.queued.insert(131, VecDeque::from(["".to_string(), "!hold:!error".to_string()]));
        answers.held.insert(131, release.clone());
    }
    let (h, seen, events) = connected_with_urls("profile-popup-changed-unverified", 130, urls).await;
    let relay = h.handle.relay.clone();
    let browser = h.handle.browser();
    let options = TabOptions { allowed_origins: Some(vec!["example.com".into()]), ..TabOptions::default() };
    let opener = browser.open_tab(None, &options).await.unwrap().tab;
    events.send(json!({ "method": "tabs.opened", "params": { "tabId": 131, "openerTabId": opener } })).unwrap();
    let asked = |see: &Seen| see.cdp("Target.getTargetInfo").iter().filter(|c| c["params"]["tabId"] == 131).count();
    eventually("the popup's url asked again", || asked(&seen) >= 2).await;
    events.send(json!({ "method": "debugger.event", "params": { "tabId": 131, "method": "Page.navigatedWithinDocument", "params": { "url": "https://evil.test/" } } })).unwrap();
    eventually("the url the event carried", || relay.st().tabs.get(&131).is_some_and(|t| t.url == "https://evil.test/")).await;
    release.notify_one();
    eventually("the popup to close", || seen.commands("tabs.remove").iter().any(|c| c["params"]["tabId"] == 131)).await;
    eventually("the popup to leave the tabs list", || !relay.st().tabs.contains_key(&131)).await;
    assert!(relay.st().tabs[&opener].warnings.iter().any(|w| w.contains("could not confirm")), "the opener carries the news");
}

/// A tab the user lends (the toolbar button) is usable by its id from tabs list, and closing it gives it back.
#[tokio::test]
async fn lent_tabs_are_used_by_id_and_given_back() {
    let (h, seen, events) = connected("profile-lend", 90).await;
    let relay = h.handle.relay.clone();
    let browser = h.handle.browser();
    events.send(json!({ "method": "toolbar.clicked", "params": { "tabId": 55 } })).unwrap();
    eventually("the lent tab", || relay.st().tabs.contains_key(&55)).await;
    let listed = browser.tabs().await.unwrap();
    assert!(listed.iter().any(|t| t.tab == 55 && t.lent), "{listed:?}");
    browser.cdp(55).await.unwrap().send("Runtime.evaluate", json!({ "expression": "1" }), None).await.unwrap();
    let request = browse_core::ToolCallRequest { name: "tabs".into(), arguments: json!({ "action": "close", "tab": 55 }) };
    let closed = text(&serde_json::to_value(crate::serve::call_tool(&relay, request, None).await.unwrap()).unwrap());
    assert_eq!(closed["released"], json!([55]), "{closed}");
    assert!(seen.commands("tabs.remove").iter().all(|c| c["params"]["tabId"] != 55), "a lent tab is never closed");
    assert!(!relay.st().tabs.contains_key(&55));
    // The user taking a tab back (the toolbar button again) stops what runs in it.
    events.send(json!({ "method": "toolbar.clicked", "params": { "tabId": 56 } })).unwrap();
    eventually("the second lent tab", || relay.st().tabs.contains_key(&56)).await;
    let waiting = {
        let relay = relay.clone();
        let call = browse_core::ToolCallRequest { name: "handoff".into(), arguments: json!({ "message": "wait", "tab": 56, "timeoutSeconds": 30 }) };
        tokio::spawn(async move { crate::serve::call_tool(&relay, call, None).await })
    };
    eventually("the handoff", || relay.st().handoffs.contains_key(&56)).await;
    events.send(json!({ "method": "toolbar.clicked", "params": { "tabId": 56 } })).unwrap();
    let output = tokio::time::timeout(Duration::from_secs(5), waiting).await.unwrap().unwrap().unwrap();
    assert!(text(&serde_json::to_value(&output).unwrap())["outcome"] == "continued", "the toolbar button continues a handoff first");
}

/// Page.close on a lent tab gives it back, like Target.closeTarget: the user keeps it.
#[tokio::test]
async fn page_close_releases_a_lent_tab() {
    let (h, seen, events) = connected("profile-page-close-lent", 500).await;
    let relay = h.handle.relay.clone();
    let browser = h.handle.browser();
    events.send(json!({ "method": "toolbar.clicked", "params": { "tabId": 55 } })).unwrap();
    eventually("the lent tab", || relay.st().tabs.contains_key(&55)).await;
    let cdp = browser.cdp(55).await.unwrap();
    assert_eq!(cdp.send("Page.close", json!({}), None).await.unwrap(), json!({}));
    assert!(!relay.st().tabs.contains_key(&55), "a lent tab is released, not closed");
    assert!(seen.commands("debugger.detach").iter().any(|c| c["params"]["tabId"] == 55));
    assert!(seen.commands("tabs.remove").iter().all(|c| c["params"]["tabId"] != 55), "a lent tab is never closed");
    assert!(seen.cdp("Page.close").is_empty(), "Page.close is not forwarded to the debugger");
}

/// Page.close closes an agent's tab through the relay, and a child session can't close the page it belongs to.
#[tokio::test]
async fn page_close_closes_an_agent_tab_and_refuses_child_sessions() {
    let (h, seen, _events) = connected("profile-page-close-agent", 500).await;
    let relay = h.handle.relay.clone();
    let browser = h.handle.browser();
    let tab = browser.open_tab(None, &TabOptions::default()).await.unwrap().tab;
    let cdp = browser.cdp(tab).await.unwrap();
    let refused = cdp.send("Page.close", json!({}), Some("CHILD")).await.unwrap_err();
    assert!(matches!(refused, CdpError::Protocol(ref message) if message.contains("Page.close needs the tab's own page session")), "{refused:?}");
    assert!(relay.st().tabs.contains_key(&tab), "a child session can't close the tab");
    assert_eq!(cdp.send("Page.close", json!({}), None).await.unwrap(), json!({}));
    assert!(!relay.st().tabs.contains_key(&tab));
    assert!(seen.commands("tabs.remove").iter().any(|c| c["params"]["tabId"] == tab));
    assert!(seen.cdp("Page.close").is_empty(), "Page.close is not forwarded to the debugger");
}

/// Agent tabs, with their ids, options and group, survive a relay restart; the old session catalog is removed.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn agent_tabs_survive_a_relay_restart() {
    let paths = Paths::rooted(std::env::temp_dir().join(format!("browse-relay-restart-{}", crate::util::random_hex(6))));
    let first = harness_at(paths.clone()).await;
    let socket = pair_with_token(first.handle.port(), &paths, "profile-restart").await;
    let (_seen, events) = fake_extension(socket, 150);
    events.send(json!({ "method": "ready" })).unwrap();
    let relay = first.handle.relay.clone();
    eventually("the browser", || relay.st().connected()).await;
    let options = TabOptions { group: Some("orw-x".into()), keep_visible: true, ..TabOptions::default() };
    let tab = first.handle.browser().open_tab(None, &options).await.unwrap().tab;
    relay.persist_now();
    first.handle.stop();
    tokio::time::sleep(Duration::from_millis(300)).await;
    std::mem::forget(first);

    let catalog = paths.legacy_session_catalog(0);
    std::fs::create_dir_all(catalog.parent().unwrap()).unwrap();
    std::fs::write(&catalog, r#"{"version":1,"sessions":[]}"#).unwrap();
    let second = harness_at(paths.clone()).await;
    assert!(!catalog.exists(), "the session catalog of browse before tabs is removed");
    let relay = second.handle.relay.clone();
    let call = {
        let browser = second.handle.browser();
        tokio::spawn(async move { browser.cdp(tab).await.map(|_| ()) })
    };
    let socket = pair_with_token(second.handle.port(), &paths, "profile-restart").await;
    let (_seen, events) = fake_extension(socket, 160);
    events.send(json!({ "method": "debugger.attached", "params": { "tabId": tab, "agent": true } })).unwrap();
    events.send(json!({ "method": "ready" })).unwrap();
    tokio::time::timeout(Duration::from_secs(10), call).await.unwrap().unwrap().expect("a call naming the tab waits for it to come back");
    let back = second.handle.browser().tabs().await.unwrap().into_iter().find(|t| t.tab == tab).unwrap();
    assert!(!back.lent);
    assert_eq!(back.options.group.as_deref(), Some("orw-x"));
    assert!(back.options.keep_visible);
    drop(relay);
}

#[tokio::test]
async fn tool_arguments_are_checked() {
    let (h, _seen, _events) = connected("profile-args", 170).await;
    let port = h.handle.port();
    let token = h.handle.token().to_string();
    let call = |name: &str, arguments: Value| json!({ "name": name, "arguments": arguments });
    let (_, handoff) = http(port, "POST", "/tools/call", Some(&token), Some(call("handoff", json!({ "message": "x", "tab": 170, "timeoutSeconds": 0 })))).await;
    assert_eq!(handoff["isError"], true);
    assert!(handoff["content"][0]["text"].as_str().unwrap().contains("timeoutSeconds"));
    let (_, tabless) = http(port, "POST", "/tools/call", Some(&token), Some(call("handoff", json!({ "message": "x" })))).await;
    assert!(tabless["content"][0]["text"].as_str().unwrap().contains("Pass `tab`"), "{tabless}");
    let (_, nothing) = http(port, "POST", "/tools/call", Some(&token), Some(call("tabs", json!({ "action": "close" })))).await;
    assert_eq!(nothing["isError"], true);
    let (_, negative) = http(port, "POST", "/tools/call", Some(&token), Some(call("tabs", json!({ "action": "close", "idleMinutes": -1 })))).await;
    assert_eq!(negative["isError"], true);
    let (_, navigated) = http(port, "POST", "/tools/call", Some(&token), Some(call("tabs", json!({ "action": "new", "url": "about:version" })))).await;
    assert_eq!(navigated["isError"], true);
    let (_, browser) = http(port, "POST", "/tools/call", Some(&token), Some(call("tabs", json!({ "action": "new", "browser": "netscape" })))).await;
    assert!(browser["content"][0]["text"].as_str().unwrap().contains("No connected browser is called"), "{browser}");
}

#[tokio::test]
async fn opening_a_tab_waits_for_a_browser_without_deadlocking() {
    let h = harness().await;
    // No browser connected yet: this once took the state lock twice in one expression.
    let started = std::time::Instant::now();
    assert!(h.handle.relay.link_for(None).await.is_err());
    assert!(started.elapsed() < Duration::from_secs(5), "a browser that was never paired fails fast");
}

#[tokio::test]
async fn a_paired_browser_reconnecting_after_a_relay_restart_is_waited_for() {
    // The harness relay is as fresh as a restarted one, and the token file is what a restarted relay finds on disk.
    let h = harness().await;
    pairing::issue_browser_token(&h.paths, "profile-restart-wait", None, None).unwrap();
    let relay = h.handle.relay.clone();
    let call = tokio::spawn(async move { relay.link_for(None).await.map(|link| link.id.clone()) });
    tokio::time::sleep(Duration::from_secs(2)).await;
    assert!(!call.is_finished(), "the call waits for the reconnect instead of failing after 1.5 s");
    let socket = pair_with_token(h.handle.port(), &h.paths, "profile-restart-wait").await;
    let (_seen, events) = fake_extension(socket, 200);
    events.send(json!({ "method": "ready" })).unwrap();
    let id = tokio::time::timeout(Duration::from_secs(10), call).await.unwrap().unwrap().unwrap();
    assert_eq!(id, "test-chrome");
}

#[tokio::test]
async fn a_fresh_relay_says_a_paired_browser_is_reconnecting() {
    let h = harness().await;
    // No browser ever connected: a fresh relay that finds a pairing on disk is the reconnecting case.
    pairing::issue_browser_token(&h.paths, "profile-restart-status", None, None).unwrap();
    let status = h.handle.relay.extension_status();
    assert_eq!(status["pairingState"], "paired-offline");
    assert_eq!(status["reconnecting"], true);
    let next = status["nextStep"].as_str().unwrap();
    assert!(next.contains("reconnecting") && next.contains("try again in a few seconds"), "{next}");
    assert!(!next.contains("open it") && !next.contains("check") && !next.contains("restart"), "{next}");
}

#[tokio::test]
async fn after_the_cold_start_window_a_paired_offline_browser_says_to_open_it() {
    let h = harness().await;
    pairing::issue_browser_token(&h.paths, "profile-restart-old", None, None).unwrap();
    // Age the relay past the cold-start window instead of sleeping through it.
    h.handle.relay.set_age_for_test(Duration::from_secs(36));
    let status = h.handle.relay.extension_status();
    assert_eq!(status["pairingState"], "paired-offline");
    assert_eq!(status["reconnecting"], false);
    let next = status["nextStep"].as_str().unwrap();
    assert!(next.contains("open it") && next.contains("check"), "{next}");
    let started = std::time::Instant::now();
    let error = match h.handle.relay.link_for(None).await {
        Ok(_) => panic!("no browser was there to open a tab in"),
        Err(error) => error.to_string(),
    };
    assert!(error.contains("open it") && error.contains("check"), "{error}");
    assert!(started.elapsed() < Duration::from_secs(5), "an expired cold start keeps the fast paired-offline failure");
}

#[tokio::test]
async fn a_tab_stuck_on_an_error_page_says_so() {
    let (h, _seen, _events) = connected("profile-stuck", 180).await;
    let browser = h.handle.browser();
    let tab = browser.open_tab(None, &TabOptions::default()).await.unwrap().tab;
    let cdp = browser.cdp(tab).await.unwrap();
    let error = cdp.send("Unattachable.method", json!({}), None).await.unwrap_err();
    assert!(error.to_string().contains("stuck on a Chrome error page") && error.to_string().contains("navigate"), "{error}");
    assert!(browser.cdp(tab).await.is_ok(), "the tab stays the agent's");
}

#[tokio::test]
async fn a_lost_tab_is_reported_instead_of_replaced_by_a_blank_one() {
    let (h, seen, events) = connected("profile-lost", 190).await;
    let relay = h.handle.relay.clone();
    let browser = h.handle.browser();
    let tab = browser.open_tab(None, &TabOptions::default()).await.unwrap().tab;
    events.send(json!({ "method": "tabs.removed", "params": { "tabId": tab } })).unwrap();
    eventually("the tab to go", || !relay.st().tabs.contains_key(&tab)).await;
    let error = browser.cdp(tab).await.err().unwrap().to_string();
    assert!(error.contains("gone (the tab was closed in the browser)"), "{error}");
    assert_eq!(seen.commands("tabs.create").len(), 1, "no blank tab behind the agent's back");
    assert!(browser.state(tab).await.is_ok(), "a gone tab's state stays a while, for captures that ended with it");
}

fn rss_mb() -> f64 {
    crate::util::release_memory();
    let status = std::fs::read_to_string("/proc/self/status").unwrap_or_default();
    status.lines().find(|l| l.starts_with("VmRSS:")).and_then(|l| l.split_whitespace().nth(1)).and_then(|kb| kb.parse::<f64>().ok()).unwrap_or(0.0) / 1024.0
}

/// `cargo test -p browse-relay memory_after_big_results -- --ignored --nocapture`: RSS around big CDP answers and
/// big events into a subscriber that doesn't read.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore]
async fn memory_after_big_results() {
    let (h, _seen, events) = connected("profile-memory", 100).await;
    let browser = h.handle.browser();
    let tab = browser.open_tab(None, &TabOptions::default()).await.unwrap().tab;
    let cdp = browser.cdp(tab).await.unwrap();
    let start = rss_mb();
    for _ in 0..20 {
        let result = cdp.send("Big.method", json!({ "bytes": 5_000_000 }), None).await.unwrap();
        assert_eq!(result["result"]["value"].as_str().unwrap().len(), 5_000_000);
    }
    tokio::time::sleep(Duration::from_millis(500)).await;
    let after_results = rss_mb();
    let idle = cdp.events();
    let frame = "y".repeat(200_000);
    for batch in 0..30 {
        for _ in 0..50 {
            events.send(json!({ "method": "debugger.event", "params": { "tabId": tab, "method": "Page.screencastFrame", "params": { "data": frame, "sessionId": batch } } })).unwrap();
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    tokio::time::sleep(Duration::from_secs(2)).await;
    let after_events = rss_mb();
    drop(idle);
    tokio::time::sleep(Duration::from_millis(500)).await;
    println!("rss start {start:.0} MB, after 20 x 5 MB results {after_results:.0} MB, after 1500 x 200 KB events with an idle subscriber {after_events:.0} MB, after it went {:.0} MB", rss_mb());
}

fn exited_pid() -> u32 {
    let mut child = std::process::Command::new("true").spawn().unwrap();
    let pid = child.id();
    child.wait().unwrap();
    pid
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn one_client_exiting_stops_only_its_own_calls() {
    let (h, _seen, _events) = connected("profile-clients", 110).await;
    let relay = h.handle.relay.clone();
    let browser = h.handle.browser();
    let live = std::process::id();
    let dead = exited_pid();
    let request = |name: &str, arguments: Value| browse_core::ToolCallRequest { name: name.into(), arguments };
    let tab = browser.open_tab(None, &TabOptions::default()).await.unwrap().tab;

    // The live client waits on a handoff; a client that has since exited made a call too.
    let waiting = {
        let relay = relay.clone();
        let call = request("handoff", json!({ "message": "wait", "tab": tab, "timeoutSeconds": 30 }));
        tokio::spawn(async move { crate::serve::call_tool(&relay, call, Some(live)).await })
    };
    eventually("the handoff", || relay.st().handoffs.contains_key(&tab)).await;
    assert!(relay.st().tab_busy(tab), "a call waiting in the tab keeps it busy");
    crate::serve::call_tool(&relay, request("status", json!({})), Some(dead)).await.unwrap();
    crate::serve::sweep_clients(&relay).await;
    assert!(relay.st().handoffs.contains_key(&tab), "another process exiting doesn't stop this one's handoff");
    assert!(!waiting.is_finished());
    assert_eq!(relay.st().clients.iter().copied().collect::<Vec<_>>(), vec![live]);

    // A call whose own process exited is stopped, naming that process.
    relay.finish_handoff(tab, "continued");
    let output = waiting.await.unwrap().unwrap();
    assert!(!output.is_error);
    let orphan = {
        let relay = relay.clone();
        let call = request("handoff", json!({ "message": "wait", "tab": tab, "timeoutSeconds": 30 }));
        tokio::spawn(async move { crate::serve::call_tool(&relay, call, Some(dead)).await })
    };
    eventually("the second handoff", || relay.st().handoffs.contains_key(&tab)).await;
    crate::serve::sweep_clients(&relay).await;
    let stopped = tokio::time::timeout(Duration::from_secs(5), orphan).await.unwrap().unwrap().unwrap();
    assert!(stopped.is_error);
    let text = match &stopped.content[0] {
        browse_core::Content::Text { text } => text.clone(),
        _ => String::new(),
    };
    assert!(text.contains(&format!("process {dead}")), "{text}");
    eventually("the card to come down", || !relay.st().handoffs.contains_key(&tab)).await;
    eventually("the tab to go idle", || !relay.st().tab_busy(tab)).await;
}

/// POST /tools/cancel stops the call its caller keyed (an MCP client's `notifications/cancelled`): the handoff card
/// comes down and the tab is free. A cancel that arrives before its call stops the call as it starts.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_cancelled_call_stops() {
    let (h, _seen, _events) = connected("profile-cancel", 180).await;
    let relay = h.handle.relay.clone();
    let port = h.handle.port();
    let token = h.handle.token().to_string();
    let tab = h.handle.browser().open_tab(None, &TabOptions::default()).await.unwrap().tab;
    let request = |name: &str, arguments: Value| browse_core::ToolCallRequest { name: name.into(), arguments };
    let text = |output: &browse_core::ToolOutput| match &output.content[0] {
        browse_core::Content::Text { text } => text.clone(),
        _ => String::new(),
    };

    let waiting = {
        let relay = relay.clone();
        let call = request("handoff", json!({ "message": "wait", "tab": tab, "timeoutSeconds": 30 }));
        tokio::spawn(async move { crate::serve::call_tool_keyed(&relay, call, None, Some("key-1".into())).await })
    };
    eventually("the handoff", || relay.st().handoffs.contains_key(&tab)).await;
    let (_, other) = http(port, "POST", "/tools/cancel", Some(&token), Some(json!({ "call": "key-other" }))).await;
    assert_eq!(other["stopped"], false, "another key stops nothing");
    assert!(!waiting.is_finished());
    let (status, cancelled) = http(port, "POST", "/tools/cancel", Some(&token), Some(json!({ "call": "key-1" }))).await;
    assert_eq!((status, &cancelled["stopped"]), (200, &json!(true)), "{cancelled}");
    let stopped = tokio::time::timeout(Duration::from_secs(5), waiting).await.unwrap().unwrap().unwrap();
    assert!(stopped.is_error && text(&stopped).contains("cancelled"), "{}", text(&stopped));
    eventually("the card to come down", || !relay.st().handoffs.contains_key(&tab)).await;
    eventually("the tab to go idle", || !relay.st().tab_busy(tab)).await;

    // The cancel won the race: the call stops as soon as it starts, and its key is used up.
    let (_, early) = http(port, "POST", "/tools/cancel", Some(&token), Some(json!({ "call": "key-2" }))).await;
    assert_eq!(early["stopped"], false);
    let call = request("handoff", json!({ "message": "wait", "tab": tab, "timeoutSeconds": 30 }));
    let output = tokio::time::timeout(Duration::from_secs(5), crate::serve::call_tool_keyed(&relay, call, None, Some("key-2".into()))).await.unwrap().unwrap();
    assert!(output.is_error && text(&output).contains("cancelled"), "{}", text(&output));
    assert!(!relay.st().cancelled_calls.contains_key("key-2"));
    assert!(!relay.st().handoffs.contains_key(&tab));
    let (status, _) = http(port, "POST", "/tools/cancel", Some(&token), Some(json!({}))).await;
    assert_eq!(status, 400);
    assert_eq!(http(port, "POST", "/tools/cancel", None, Some(json!({ "call": "key-1" }))).await.0, 401);
}

#[tokio::test]
async fn close_takes_idle_tabs_and_whole_groups() {
    let (h, seen, _events) = connected("profile-cleanup", 120).await;
    let port = h.handle.port();
    let token = h.handle.token().to_string();
    let browser = h.handle.browser();
    let tidy = browser.open_tab(None, &grouped("tidy")).await.unwrap().tab;
    let started = std::time::Instant::now();
    let (_, cleaned) =
        http(port, "POST", "/tools/call", Some(&token), Some(json!({ "name": "tabs", "arguments": { "action": "close", "group": "tidy", "idleMinutes": 0 } }))).await;
    assert!(started.elapsed() < Duration::from_secs(5));
    assert_eq!(text(&cleaned)["closed"], json!([tidy]), "{cleaned}");
    assert!(seen.commands("tabs.remove").iter().any(|c| c["params"]["tabId"] == tidy));
    // idleMinutes alone picks no tabs: closing needs explicit ids or a group.
    let (_, refused) = http(port, "POST", "/tools/call", Some(&token), Some(json!({ "name": "tabs", "arguments": { "action": "close", "idleMinutes": 0 } }))).await;
    assert_eq!(refused["isError"], true, "{refused}");
    assert!(
        refused["content"][0]["text"].as_str().is_some_and(|t| t.contains("Say which tabs to close")),
        "{refused}"
    );
    // Tabs used just now aren't idle for a minute.
    let fresh = browser.open_tab(None, &grouped("tidy")).await.unwrap().tab;
    let (_, kept) = http(port, "POST", "/tools/call", Some(&token), Some(json!({ "name": "tabs", "arguments": { "action": "close", "group": "tidy", "idleMinutes": 1 } }))).await;
    assert_eq!(text(&kept)["closed"], json!([]), "{kept}");
    let (_, group) = http(port, "POST", "/tools/call", Some(&token), Some(json!({ "name": "tabs", "arguments": { "action": "close", "group": "tidy" } }))).await;
    assert_eq!(text(&group)["closed"], json!([fresh]), "{group}");
}

#[tokio::test]
async fn closing_a_tab_yourself_warns_nothing() {
    let (h, _seen, events) = connected("profile-quiet", 130).await;
    let relay = h.handle.relay.clone();
    let browser = h.handle.browser();
    let first = browser.open_tab(None, &TabOptions::default()).await.unwrap().tab;
    let second = browser.open_tab(None, &TabOptions::default()).await.unwrap().tab;
    // The browser reports the tab closed before it answers the close.
    relay.st().tabs.get_mut(&second).unwrap().closing = true;
    events.send(json!({ "method": "tabs.removed", "params": { "tabId": second } })).unwrap();
    eventually("the tab to go", || !relay.st().tabs.contains_key(&second)).await;
    assert!(relay.st().tabs[&first].warnings.is_empty(), "{:?}", relay.st().tabs[&first].warnings);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_call_naming_a_tab_waits_for_the_reconnecting_browser() {
    let h = harness().await;
    let relay = h.handle.relay.clone();
    let held = crate::registry::PersistedTab { tab: 41, target_id: "T41".into(), browser_key: "profile-restart".into(), opener: None, options: TabOptions::default(), created_at: String::new(), chosen: None, lent: false };
    relay.st().restorable.insert("T41".into(), held);
    let browser = h.handle.browser();
    let call = {
        let browser = browser.clone();
        tokio::spawn(async move { browser.cdp(41).await.map(|_| ()) })
    };
    tokio::time::sleep(Duration::from_millis(300)).await;
    let socket = pair_with_token(h.handle.port(), &h.paths, "profile-restart").await;
    let (_seen, events) = fake_extension(socket, 140);
    events.send(json!({ "method": "debugger.attached", "params": { "tabId": 41, "agent": true } })).unwrap();
    events.send(json!({ "method": "ready" })).unwrap();
    tokio::time::timeout(Duration::from_secs(10), call).await.unwrap().unwrap().expect("the tab came back with the inventory");
}

async fn tool(relay: &Arc<crate::relay::Relay>, name: &str, arguments: Value) -> browse_core::ToolOutput {
    crate::serve::call_tool(relay, browse_core::ToolCallRequest { name: name.into(), arguments }, None).await.unwrap()
}

fn tool_text(output: &browse_core::ToolOutput) -> String {
    output.content.iter().filter_map(|c| if let browse_core::Content::Text { text } = c { Some(text.as_str()) } else { None }).collect::<Vec<_>>().join(" ")
}

#[tokio::test]
async fn a_chosen_id_is_get_or_create_and_listed_with_the_callers_id() {
    let (h, seen, _events) = connected("profile-chosen", 300).await;
    let relay = h.handle.relay.clone();
    let first = tool(&relay, "tabs", json!({ "action": "new", "id": "work-mail" })).await;
    assert!(!first.is_error, "{}", tool_text(&first));
    let first = text(&serde_json::to_value(&first).unwrap());
    let tab = first["tab"].as_i64().unwrap();
    assert_eq!(first["id"], "work-mail");
    assert!(seen.commands("tabs.create")[0]["params"].get("id").is_none(), "the id is the relay's to keep");
    assert!(seen.cdp("Page.navigate").is_empty());

    // The same id again: the tab it already names, and no navigation.
    let again = tool(&relay, "tabs", json!({ "action": "new", "id": "work-mail", "url": "https://evil.test/" })).await;
    let again = text(&serde_json::to_value(&again).unwrap());
    assert_eq!(again["tab"], tab);
    assert_eq!(again["existed"], true);
    assert_eq!(seen.commands("tabs.create").len(), 1, "no second tab for one id");
    assert!(seen.cdp("Page.navigate").is_empty(), "an existing tab is returned without navigating it");

    let listed = text(&serde_json::to_value(tool(&relay, "tabs", json!({})).await).unwrap());
    let entry = &listed["tabs"][0];
    assert_eq!(entry["tab"], tab);
    assert_eq!(entry["id"], "work-mail");
    assert_eq!(entry["lent"], false);
    assert_eq!(entry["busy"], false);
    assert_eq!(entry["browser"], "test-chrome");
    assert!(entry["lastUsed"].as_str().is_some_and(|time| time.ends_with('Z')), "{entry}");

    // A chosen id is a lowercase slug, never something that reads as a number.
    for bad in ["Work-mail", "123", "-mail", "work mail"] {
        let output = tool(&relay, "tabs", json!({ "action": "new", "id": bad })).await;
        assert!(output.is_error && tool_text(&output).contains("lowercase slug"), "{bad}: {}", tool_text(&output));
    }
    assert_eq!(seen.commands("tabs.create").len(), 1, "a refused id opens nothing");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_chosen_id_survives_a_relay_restart() {
    let paths = Paths::rooted(std::env::temp_dir().join(format!("browse-relay-stable-{}", crate::util::random_hex(6))));
    let first = harness_at(paths.clone()).await;
    let socket = pair_with_token(first.handle.port(), &paths, "profile-stable").await;
    let (_seen, events) = fake_extension(socket, 300);
    events.send(json!({ "method": "ready" })).unwrap();
    let relay = first.handle.relay.clone();
    eventually("the browser", || relay.st().connected()).await;
    let named = tool(&relay, "tabs", json!({ "action": "new", "id": "work-mail" })).await;
    let named = text(&serde_json::to_value(&named).unwrap())["tab"].as_i64().unwrap();
    let plain = first.handle.browser().open_tab(None, &TabOptions::default()).await.unwrap().tab;
    assert_ne!(named, plain);
    relay.persist_now();
    first.handle.stop();
    tokio::time::sleep(Duration::from_millis(300)).await;
    std::mem::forget(first);

    // The relay starts again. Its registry comes back from disk and the browser announces the same tabs by their
    // Chrome ids, so both the relay ids and the chosen id agents know them by come back.
    let second = harness_at(paths.clone()).await;
    let socket = pair_with_token(second.handle.port(), &paths, "profile-stable").await;
    let (_seen, events) = fake_extension(socket, 300);
    events.send(json!({ "method": "debugger.attached", "params": { "tabId": named, "agent": true } })).unwrap();
    events.send(json!({ "method": "debugger.attached", "params": { "tabId": plain, "agent": true } })).unwrap();
    events.send(json!({ "method": "ready" })).unwrap();
    let relay = second.handle.relay.clone();
    eventually("the restored tabs", || relay.st().tabs.contains_key(&named) && relay.st().tabs.contains_key(&plain)).await;
    let listed = text(&serde_json::to_value(tool(&relay, "tabs", json!({})).await).unwrap());
    let entry = listed["tabs"].as_array().unwrap().iter().find(|t| t["tab"] == named).unwrap();
    assert_eq!(entry["id"], "work-mail", "the chosen id comes back with the tab");
    assert_eq!(entry["url"], "about:blank");
}

#[tokio::test]
async fn a_lent_tab_survives_a_relay_restart() {
    let paths = Paths::rooted(std::env::temp_dir().join(format!("browse-relay-lent-stable-{}", crate::util::random_hex(6))));
    let first = harness_at(paths.clone()).await;
    let socket = pair_with_token(first.handle.port(), &paths, "profile-lent-stable").await;
    let (_seen, events) = fake_extension(socket, 700);
    events.send(json!({ "method": "ready" })).unwrap();
    events.send(json!({ "method": "toolbar.clicked", "params": { "tabId": 700 } })).unwrap();
    let relay = first.handle.relay.clone();
    eventually("the lent tab", || relay.st().tabs.contains_key(&700)).await;
    relay.persist_now();
    first.handle.stop();
    tokio::time::sleep(Duration::from_millis(300)).await;
    std::mem::forget(first);

    let second = harness_at(paths.clone()).await;
    let socket = pair_with_token(second.handle.port(), &paths, "profile-lent-stable").await;
    let (_seen, events) = fake_extension(socket, 700);
    events.send(json!({ "method": "debugger.attached", "params": { "tabId": 700 } })).unwrap();
    events.send(json!({ "method": "ready" })).unwrap();
    let relay = second.handle.relay.clone();
    eventually("the lent tab to come back", || relay.st().tabs.contains_key(&700)).await;
    let listed = second.handle.browser().tabs().await.unwrap();
    let entry = listed.iter().find(|t| t.tab == 700).unwrap();
    assert!(entry.lent);
    assert_eq!(entry.chosen, None);
}

#[tokio::test]
async fn a_chosen_tab_closes_when_idle_like_any_other() {
    let (h, _seen, _events) = connected("profile-chosen-idle", 400).await;
    let relay = h.handle.relay.clone();
    let named = text(&serde_json::to_value(tool(&relay, "tabs", json!({ "action": "new", "id": "work-mail" })).await).unwrap())["tab"].as_i64().unwrap();
    let plain = h.handle.browser().open_tab(None, &TabOptions::default()).await.unwrap().tab;
    {
        let mut st = relay.st();
        for tab in [named, plain] {
            let entry = st.tabs.get_mut(&tab).unwrap();
            entry.last_used = std::time::Instant::now() - Duration::from_secs(3_600);
        }
    }
    let idle = relay.idle_tabs(Duration::from_secs(60));
    assert!(idle.iter().any(|(tab, _)| *tab == named), "a chosen id closes when idle: {idle:?}");
    assert!(idle.iter().any(|(tab, _)| *tab == plain), "other idle tabs still close: {idle:?}");
    let closed = text(&serde_json::to_value(tool(&relay, "tabs", json!({ "action": "close", "tab": "work-mail", "idleMinutes": 0 })).await).unwrap());
    assert_eq!(closed["closed"], json!([named]), "{closed}");
    assert!(!relay.st().tabs.contains_key(&named));
}

#[tokio::test]
async fn keep_open_tabs_survive_idle_cleanup() {
    let (h, seen, _events) = connected("profile-keep-open", 405).await;
    let relay = h.handle.relay.clone();
    let kept = text(&serde_json::to_value(tool(&relay, "tabs", json!({ "action": "new", "id": "keep-me", "keepOpen": true })).await).unwrap())["tab"].as_i64().unwrap();
    let normal = h.handle.browser().open_tab(None, &TabOptions::default()).await.unwrap().tab;
    assert!(seen.commands("tabs.create")[0]["params"]["keepOpen"].as_bool().unwrap(), "the extension is told, so its own cleanup keeps it");
    let listed = text(&serde_json::to_value(tool(&relay, "tabs", json!({})).await).unwrap());
    let entry = listed["tabs"].as_array().unwrap().iter().find(|t| t["tab"] == kept).unwrap();
    assert_eq!(entry["keepOpen"], true, "tabs list shows the option: {entry}");
    {
        let mut st = relay.st();
        for tab in [kept, normal] {
            let entry = st.tabs.get_mut(&tab).unwrap();
            entry.last_used = std::time::Instant::now() - Duration::from_secs(3_600);
        }
    }
    let idle = relay.idle_tabs(Duration::from_secs(60));
    assert!(!idle.iter().any(|(tab, _)| *tab == kept), "a keepOpen tab stays: {idle:?}");
    assert!(idle.iter().any(|(tab, _)| *tab == normal), "a normal tab still closes: {idle:?}");
    let closed = text(&serde_json::to_value(tool(&relay, "tabs", json!({ "action": "close", "tab": "keep-me", "idleMinutes": 0 })).await).unwrap());
    assert_eq!(closed["closed"], json!([]), "{closed}");

    // Asking again with a different keepOpen updates the stored option and says so.
    let updated = text(&serde_json::to_value(tool(&relay, "tabs", json!({ "action": "new", "id": "keep-me", "keepOpen": false })).await).unwrap());
    assert_eq!(updated["existed"], true);
    assert!(updated["note"].as_str().unwrap().contains("keepOpen is now off"), "{updated}");
    let closed = text(&serde_json::to_value(tool(&relay, "tabs", json!({ "action": "close", "tab": "keep-me", "idleMinutes": 0 })).await).unwrap());
    assert_eq!(closed["closed"], json!([kept]), "with keepOpen off, idle cleanup closes it again: {closed}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_second_call_on_a_chosen_tab_says_it_is_busy() {
    let (h, _seen, _events) = connected("profile-chosen-busy", 410).await;
    let relay = h.handle.relay.clone();
    let tab = text(&serde_json::to_value(tool(&relay, "tabs", json!({ "action": "new", "id": "work-mail" })).await).unwrap())["tab"].as_i64().unwrap();
    let waiting = {
        let relay = relay.clone();
        tokio::spawn(async move { tool(&relay, "handoff", json!({ "message": "wait", "tab": "work-mail", "timeoutSeconds": 30 })).await })
    };
    eventually("the handoff", || relay.st().handoffs.contains_key(&tab)).await;
    let second = tool(&relay, "tabs", json!({ "action": "close", "tab": "work-mail" })).await;
    assert!(second.is_error, "{}", tool_text(&second));
    assert!(tool_text(&second).contains("work-mail is busy"), "{}", tool_text(&second));
    assert!(relay.st().tabs.contains_key(&tab), "the busy call changed nothing");
    relay.finish_handoff(tab, "continued");
    tokio::time::timeout(Duration::from_secs(5), waiting).await.unwrap().unwrap();
    eventually("the tab to go idle", || !relay.st().tab_busy(tab)).await;
    let after = tool(&relay, "tabs", json!({ "action": "close", "tab": "work-mail" })).await;
    assert!(!after.is_error, "{}", tool_text(&after));
}

/// A capture or recording in a chosen-id tab is background work: a call by that id still goes through.
#[tokio::test]
async fn background_work_does_not_make_a_chosen_tab_refuse_calls() {
    let (h, _seen, _events) = connected("profile-chosen-background", 415).await;
    let relay = h.handle.relay.clone();
    let browser = h.handle.browser();
    let tab = text(&serde_json::to_value(tool(&relay, "tabs", json!({ "action": "new", "id": "work-mail" })).await).unwrap())["tab"].as_i64().unwrap();
    browser.set_busy(tab, "network", true);
    assert!(relay.st().tab_busy(tab), "the tab is busy with the capture");
    let closed = tool(&relay, "tabs", json!({ "action": "close", "tab": "work-mail" })).await;
    assert!(!closed.is_error, "{}", tool_text(&closed));
    assert_eq!(text(&serde_json::to_value(&closed).unwrap())["closed"], json!([tab]));
    assert!(!relay.st().tabs.contains_key(&tab), "the call ran instead of being refused");
}

#[tokio::test]
async fn closing_a_chosen_tab_frees_its_id() {
    let (h, seen, _events) = connected("profile-chosen-close", 420).await;
    let relay = h.handle.relay.clone();
    let first = text(&serde_json::to_value(tool(&relay, "tabs", json!({ "action": "new", "id": "work-mail" })).await).unwrap())["tab"].as_i64().unwrap();
    let closed = text(&serde_json::to_value(tool(&relay, "tabs", json!({ "action": "close", "tab": "work-mail" })).await).unwrap());
    assert_eq!(closed["closed"], json!([first]), "{closed}");
    assert!(!relay.st().tabs.contains_key(&first));
    let reopened = text(&serde_json::to_value(tool(&relay, "tabs", json!({ "action": "new", "id": "work-mail" })).await).unwrap());
    assert_ne!(reopened["tab"], first, "the id is freed and opens a new tab");
    assert_eq!(reopened["id"], "work-mail");
    assert_eq!(seen.commands("tabs.create").len(), 2);
}

#[tokio::test]
async fn a_chosen_id_whose_browser_is_disconnected_says_so() {
    let (h, seen, _events) = connected("profile-chosen-away", 430).await;
    let relay = h.handle.relay.clone();
    let tab = text(&serde_json::to_value(tool(&relay, "tabs", json!({ "action": "new", "id": "work-mail" })).await).unwrap())["tab"].as_i64().unwrap();
    let link = relay.st().links[0].clone();
    relay.link_closed(&link, "test");
    eventually("the tab to be remembered", || !relay.st().tabs.contains_key(&tab) && relay.st().away_tab_by_chosen("work-mail") == Some(tab)).await;
    let again = tool(&relay, "tabs", json!({ "action": "new", "id": "work-mail", "url": "https://example.com/" })).await;
    assert!(again.is_error, "{}", tool_text(&again));
    assert!(tool_text(&again).contains("isn't connected"), "{}", tool_text(&again));
    assert_eq!(seen.commands("tabs.create").len(), 1, "no duplicate tab behind the disconnected one");
}

/// A read-only tab stays read-only while it isn't attached: a reconnecting browser keeps its options, so an input
/// tool refuses the tab before the browser comes back (and a page tool can't run its JavaScript).
#[tokio::test]
async fn a_read_only_tab_away_from_its_browser_still_refuses_input() {
    let (h, _seen, _events) = connected("profile-read-only-away", 90).await;
    let relay = h.handle.relay.clone();
    let browser = h.handle.browser();
    let options = TabOptions { read_only: true, ..TabOptions::default() };
    let tab = browser.open_tab(None, &options).await.unwrap().tab;
    let link = relay.st().links[0].clone();
    relay.link_closed(&link, "test");
    eventually("the tab to be remembered", || !relay.st().tabs.contains_key(&tab) && relay.st().reconnect_owners.values().any(|known| known.tab == tab)).await;
    assert!(browser.read_only(tab).await, "a reconnecting tab keeps its read-only options");

    let select = browse_page::tools().into_iter().find(|tool| tool.spec().name == "select").unwrap();
    let ctx = ToolContext { browser: Arc::new(browser), file_roots: Vec::new() };
    let output = select.call(ctx, json!({ "tab": tab, "selector": "#plan", "values": ["pro"] })).await.unwrap();
    let refused = tool_text(&output);
    assert!(output.is_error && refused.contains("browse blocked select") && refused.contains("read-only"), "{refused}");

    // A tab held across a relay restart keeps its options too, before its browser reconnects.
    let held = crate::registry::PersistedTab { tab: 91, target_id: "T91".into(), browser_key: "profile-held".into(), opener: None, options, created_at: String::new(), chosen: None, lent: false };
    relay.st().restorable.insert("T91".into(), held);
    assert!(h.handle.browser().read_only(91).await, "a held tab keeps its read-only options");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn chosen_ids_are_unique_across_two_browsers_and_new_takes_the_browser_option() {
    let h = harness().await;
    let port = h.handle.port();
    let relay = h.handle.relay.clone();
    let first_socket = pair_with_token(port, &h.paths, "profile-one").await;
    let (first_seen, first_events) = fake_extension(first_socket, 500);
    first_events.send(json!({ "method": "ready" })).unwrap();
    // Finish the first pairing before issuing the second browser's token: accepting it records the pairing on disk,
    // and pairing two browsers at once could lose one (the pairings file is read and written again).
    assert!(relay.wait_until(Duration::from_secs(5), |st| st.links.iter().any(|l| l.connected())).await);
    let second_socket = pair_with_token(port, &h.paths, "profile-two").await;
    let (second_seen, second_events) = fake_extension(second_socket, 600);
    second_events.send(json!({ "method": "ready" })).unwrap();
    relay.wait_until(Duration::from_secs(10), |st| st.links.iter().filter(|l| l.connected()).count() == 2).await;
    assert_eq!(relay.st().links.iter().filter(|l| l.connected()).count(), 2, "both browsers connect");
    let browsers: Vec<String> = relay.st().links.iter().map(|l| l.id.clone()).collect();
    assert!(browsers.contains(&"test-chrome".to_string()) && browsers.contains(&"test-chrome-2".to_string()), "{browsers:?}");

    let named = text(&serde_json::to_value(tool(&relay, "tabs", json!({ "action": "new", "id": "work-mail", "browser": "test-chrome" })).await).unwrap())["tab"].as_i64().unwrap();
    assert_eq!(first_seen.commands("tabs.create").len(), 1);
    let same = text(&serde_json::to_value(tool(&relay, "tabs", json!({ "action": "new", "id": "work-mail", "browser": "test-chrome-2", "url": "https://example.com/" })).await).unwrap());
    assert_eq!(same["tab"], named, "one id is one tab, whichever browser is named");
    assert_eq!(same["existed"], true);
    assert_eq!(second_seen.commands("tabs.create").len(), 0);
    let other = text(&serde_json::to_value(tool(&relay, "tabs", json!({ "action": "new", "id": "second-id", "browser": "test-chrome-2" })).await).unwrap());
    assert_ne!(other["tab"], named);
    assert_eq!(second_seen.commands("tabs.create").len(), 1);
}
