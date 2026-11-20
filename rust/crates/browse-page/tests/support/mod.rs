//! A headless Chromium for integration tests, a `Cdp` over its DevTools WebSocket (one flattened target session
//! stands in for the extension's tab), a fake `Browser`, and a tiny HTTP server for multi-origin pages.

#![allow(dead_code)]

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use browse_core::{Browser, Cdp, CdpError, CdpEvent, HandoffResult, TabId, TabInfo, TabOptions, TabState, ToolContext, ToolOutput};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{broadcast, mpsc, oneshot};
use tokio_tungstenite::tungstenite::Message;

pub fn chrome_binary() -> Option<PathBuf> {
    if let Ok(path) = std::env::var("BROWSE_TEST_CHROME") {
        return Some(PathBuf::from(path));
    }
    let home = std::env::var("HOME").ok()?;
    let cache = PathBuf::from(home).join(".cache/ms-playwright");
    let mut candidates: Vec<PathBuf> = std::fs::read_dir(&cache)
        .ok()?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter_map(|dir| {
            let name = dir.file_name()?.to_string_lossy().to_string();
            if name.starts_with("chromium_headless_shell-") {
                Some(dir.join("chrome-headless-shell-linux64/chrome-headless-shell"))
            } else if name.starts_with("chromium-") {
                Some(dir.join("chrome-linux64/chrome")).filter(|p| p.exists()).or_else(|| Some(dir.join("chrome-linux/chrome")))
            } else {
                None
            }
        })
        .filter(|p| p.exists())
        .collect();
    candidates.sort();
    candidates.pop()
}

pub struct Chrome {
    child: tokio::process::Child,
    pub ws: String,
    _profile: TempDir,
}

pub struct TempDir(pub PathBuf);

impl TempDir {
    pub fn new(name: &str) -> TempDir {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let path = std::env::temp_dir().join(format!("browse-page-{name}-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&path).unwrap();
        TempDir(path)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

impl Drop for Chrome {
    fn drop(&mut self) {
        let _ = self.child.start_kill();
    }
}

pub async fn launch() -> Option<Chrome> {
    let binary = chrome_binary()?;
    let profile = TempDir::new("profile");
    let mut child = tokio::process::Command::new(binary)
        .args([
            "--headless",
            "--remote-debugging-port=0",
            "--no-first-run",
            "--no-default-browser-check",
            "--site-per-process",
            "--disable-gpu",
            "--window-size=1000,800",
        ])
        .arg(format!("--user-data-dir={}", profile.0.display()))
        .arg("about:blank")
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .ok()?;
    let stderr = child.stderr.take()?;
    let mut lines = BufReader::new(stderr).lines();
    let ws = tokio::time::timeout(std::time::Duration::from_secs(20), async {
        while let Ok(Some(line)) = lines.next_line().await {
            if let Some(url) = line.strip_prefix("DevTools listening on ") {
                return Some(url.trim().to_string());
            }
        }
        None
    })
    .await
    .ok()??;
    tokio::spawn(async move { while let Ok(Some(_)) = lines.next_line().await {} });
    Some(Chrome { child, ws, _profile: profile })
}

/// The browser-level connection; `tab` sessions are flattened target sessions over it.
pub struct Connection {
    out: mpsc::UnboundedSender<String>,
    pending: Mutex<HashMap<i64, oneshot::Sender<Result<Value, String>>>>,
    next: AtomicI64,
    events: broadcast::Sender<(String, Option<String>, Value)>,
}

impl Connection {
    pub async fn connect(url: &str) -> Arc<Connection> {
        let (socket, _) = tokio_tungstenite::connect_async(url).await.expect("devtools websocket");
        let (mut write, mut read) = socket.split();
        let (out, mut rx) = mpsc::unbounded_channel::<String>();
        let (events, _) = broadcast::channel(4096);
        let connection = Arc::new(Connection { out, pending: Mutex::new(HashMap::new()), next: AtomicI64::new(1), events });
        tokio::spawn(async move {
            while let Some(text) = rx.recv().await {
                if write.send(Message::Text(text)).await.is_err() {
                    break;
                }
            }
        });
        let reader = connection.clone();
        tokio::spawn(async move {
            while let Some(Ok(message)) = read.next().await {
                let Message::Text(text) = message else { continue };
                let value: Value = match serde_json::from_str(&text) {
                    Ok(value) => value,
                    Err(_) => continue,
                };
                if let Some(id) = value.get("id").and_then(Value::as_i64) {
                    if let Some(tx) = reader.pending.lock().unwrap().remove(&id) {
                        let result = match value.get("error") {
                            Some(error) => Err(error["message"].as_str().unwrap_or("error").to_string()),
                            None => Ok(value["result"].clone()),
                        };
                        let _ = tx.send(result);
                    }
                } else if let Some(method) = value.get("method").and_then(Value::as_str) {
                    let session = value.get("sessionId").and_then(Value::as_str).map(str::to_string);
                    let _ = reader.events.send((method.to_string(), session, value["params"].clone()));
                }
            }
        });
        connection
    }

    pub async fn send(&self, method: &str, params: Value, session: Option<&str>) -> Result<Value, String> {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);
        let mut message = json!({ "id": id, "method": method, "params": params });
        if let Some(session) = session {
            message["sessionId"] = json!(session);
        }
        self.out.send(message.to_string()).map_err(|_| "closed".to_string())?;
        rx.await.map_err(|_| "closed".to_string())?
    }
}

/// One tab, as the relay would expose it.
pub struct TabCdp {
    connection: Arc<Connection>,
    pub session: String,
    pub target: String,
    events: broadcast::Sender<CdpEvent>,
    pub sent: Mutex<Vec<String>>,
    /// Methods that answer with a protocol error, like an extension without file URL access does.
    refusing: Mutex<HashSet<String>>,
    /// A path that replaces every DOM.setFileInputFiles path, for a browser that sees another filesystem.
    rewrite_files: Mutex<Option<(String, bool)>>,
}

impl TabCdp {
    pub async fn open(connection: &Arc<Connection>) -> Arc<TabCdp> {
        let created = connection.send("Target.createTarget", json!({ "url": "about:blank" }), None).await.unwrap();
        let target = created["targetId"].as_str().unwrap().to_string();
        let attached = connection.send("Target.attachToTarget", json!({ "targetId": target, "flatten": true }), None).await.unwrap();
        let session = attached["sessionId"].as_str().unwrap().to_string();
        let (events, _) = broadcast::channel(4096);
        let tab = Arc::new(TabCdp { connection: connection.clone(), session: session.clone(), target, events, sent: Mutex::new(Vec::new()), refusing: Mutex::new(HashSet::new()), rewrite_files: Mutex::new(None) });
        let mut rx = connection.events.subscribe();
        let forward = tab.events.clone();
        let root = session.clone();
        tokio::spawn(async move {
            loop {
                match rx.recv().await {
                    Ok((method, session, params)) => {
                        let session_id = match session {
                            Some(s) if s == root => None,
                            Some(s) => Some(s),
                            None => continue,
                        };
                        let _ = forward.send(CdpEvent { method, params, session_id });
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(_) => break,
                }
            }
        });
        tab
    }

    pub fn methods(&self) -> Vec<String> {
        self.sent.lock().unwrap().clone()
    }

    /// Makes `method` answer with a protocol error, as an extension without file URL access does for
    /// DOM.setFileInputFiles.
    pub fn refuse(&self, method: &str) {
        self.refusing.lock().unwrap().insert(method.to_string());
    }

    /// Makes DOM.setFileInputFiles set this path instead of the ones it was given, for a browser whose filesystem
    /// doesn't have them.
    pub fn rewrite_files_to(&self, path: &str) {
        *self.rewrite_files.lock().unwrap() = Some((path.to_string(), false));
    }

    /// The same, but the sentinel file the probe writes keeps its path, so only the real files look wrong.
    pub fn rewrite_files_except_sentinel_to(&self, path: &str) {
        *self.rewrite_files.lock().unwrap() = Some((path.to_string(), true));
    }
}

#[async_trait]
impl Cdp for TabCdp {
    async fn send(&self, method: &str, mut params: Value, session_id: Option<&str>) -> Result<Value, CdpError> {
        self.sent.lock().unwrap().push(method.to_string());
        if self.refusing.lock().unwrap().contains(method) {
            return Err(CdpError::Protocol(format!("{method}: Not allowed")));
        }
        if method == "DOM.setFileInputFiles"
            && let Some((path, keep_sentinel)) = self.rewrite_files.lock().unwrap().clone() {
                let sentinel = params["files"][0].as_str().is_some_and(|file| std::path::Path::new(file).file_name().is_some_and(|name| name == std::ffi::OsStr::new("sentinel")));
                if !(keep_sentinel && sentinel) {
                    params["files"] = json!([path]);
                }
            }
        let session = session_id.unwrap_or(&self.session);
        self.connection.send(method, params, Some(session)).await.map_err(CdpError::Protocol)
    }

    fn events(&self) -> broadcast::Receiver<CdpEvent> {
        self.events.subscribe()
    }
}

/// One Chromium tab as the browser: tab 1.
pub struct FakeBrowser {
    pub tab: Arc<TabCdp>,
    pub human: bool,
    pub read_only: bool,
    pub connected_locally: bool,
    pub state: Arc<TabState>,
}

#[async_trait]
impl Browser for FakeBrowser {
    async fn open_tab(&self, _url: Option<&str>, _options: &TabOptions) -> anyhow::Result<TabInfo> {
        anyhow::bail!("not in tests")
    }
    async fn tabs(&self) -> anyhow::Result<Vec<TabInfo>> {
        Ok(vec![TabInfo {
            tab: 1,
            url: String::new(),
            title: String::new(),
            lent: false,
            opener: None,
            chosen: None,
            last_used: None,
            busy: false,
            options: TabOptions { read_only: self.read_only, ..TabOptions::default() },
        }])
    }
    async fn close_tab(&self, _tab: TabId) -> anyhow::Result<()> {
        Ok(())
    }
    async fn cdp(&self, _tab: TabId) -> anyhow::Result<Arc<dyn Cdp>> {
        Ok(self.tab.clone())
    }
    async fn state(&self, _tab: TabId) -> anyhow::Result<Arc<TabState>> {
        Ok(self.state.clone())
    }
    async fn handoff(&self, _tab: TabId, _message: &str) -> anyhow::Result<HandoffResult> {
        anyhow::bail!("not in tests")
    }
    async fn human_input(&self, _tab: TabId) -> bool {
        self.human
    }
    async fn connected_locally(&self, _tab: TabId) -> bool {
        self.connected_locally
    }
    async fn read_only(&self, _tab: TabId) -> bool {
        self.read_only
    }
}

pub struct Harness {
    pub chrome: Chrome,
    pub tab: Arc<TabCdp>,
    pub ctx: ToolContext,
    pub tools: Vec<Arc<dyn browse_core::Tool>>,
    /// The tab's state, which the tools share.
    pub state: Arc<TabState>,
    pub server: Server,
    pub files: TempDir,
}

/// Serializes tests that upload, so a test can check the probe's temporary folders left nothing behind.
pub static UPLOAD_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

impl Harness {
    pub async fn start(human: bool) -> Option<Harness> {
        Self::start_with(human, false, true).await
    }

    /// A harness whose browser is on another machine, so uploads copy the files' bytes into the page.
    pub async fn start_elsewhere(human: bool) -> Option<Harness> {
        Self::start_with(human, false, false).await
    }

    /// A harness whose tab reports `readOnly` to the tools.
    pub async fn start_read_only(human: bool) -> Option<Harness> {
        Self::start_with(human, true, true).await
    }

    async fn start_with(human: bool, read_only: bool, connected_locally: bool) -> Option<Harness> {
        let chrome = launch().await?;
        let connection = Connection::connect(&chrome.ws).await;
        let tab = TabCdp::open(&connection).await;
        let files = TempDir::new("files");
        let state = Arc::new(TabState::default());
        let ctx = ToolContext { browser: Arc::new(FakeBrowser { tab: tab.clone(), human, read_only, connected_locally, state: state.clone() }), file_roots: vec![files.0.clone()] };
        let server = Server::start().await;
        Some(Harness { chrome, tab, ctx, tools: browse_page::tools(), state, server, files })
    }

    /// Calls a tool in the harness's tab (`tab` 1 unless the arguments name one; `"tab": null` leaves it out).
    pub async fn call(&self, name: &str, mut args: Value) -> ToolOutput {
        let tool = self.tools.iter().find(|t| t.spec().name == name).unwrap_or_else(|| panic!("no tool {name}"));
        if let Some(map) = args.as_object_mut() {
            match map.get("tab") {
                None => {
                    map.insert("tab".into(), json!(1));
                }
                Some(Value::Null) => {
                    map.remove("tab");
                }
                Some(_) => {}
            }
        }
        tool.call(self.ctx.clone(), args).await.unwrap()
    }

    pub async fn ok(&self, name: &str, args: Value) -> String {
        let output = self.call(name, args.clone()).await;
        let text = text_of(&output);
        assert!(!output.is_error, "{name} {args} failed: {text}");
        text
    }

    pub async fn json(&self, name: &str, args: Value) -> Value {
        let text = self.ok(name, args).await;
        serde_json::from_str(&text).unwrap_or_else(|_| panic!("not JSON: {text}"))
    }

    pub async fn err(&self, name: &str, args: Value) -> String {
        let output = self.call(name, args.clone()).await;
        let text = text_of(&output);
        assert!(output.is_error, "{name} {args} should fail but returned: {text}");
        text
    }
}

pub fn text_of(output: &ToolOutput) -> String {
    output.content.iter().filter_map(|c| match c { browse_core::Content::Text { text } => Some(text.clone()), _ => None }).collect::<Vec<_>>().join("\n")
}

/// Serves registered pages on 127.0.0.1; `localhost` on the same port is a different site.
pub struct Server {
    pub port: u16,
    pages: Arc<Mutex<HashMap<String, String>>>,
}

impl Server {
    pub async fn start() -> Server {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let pages: Arc<Mutex<HashMap<String, String>>> = Arc::new(Mutex::new(HashMap::new()));
        let served = pages.clone();
        tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else { break };
                let pages = served.clone();
                tokio::spawn(async move {
                    let mut buffer = vec![0u8; 8192];
                    let n = stream.read(&mut buffer).await.unwrap_or(0);
                    let request = String::from_utf8_lossy(&buffer[..n]).to_string();
                    let path = request.split_whitespace().nth(1).unwrap_or("/").split('?').next().unwrap_or("/").to_string();
                    // /__status/<code>: that status with an empty body; /__slow/<ms>: a page after a delay;
                    // /__redirect/<n>: n redirects, then /__status/200's page.
                    if let Some(code) = path.strip_prefix("/__status/") {
                        let response = format!("HTTP/1.1 {code} Status\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                        let _ = stream.write_all(response.as_bytes()).await;
                        let _ = stream.shutdown().await;
                        return;
                    }
                    if let Some(ms) = path.strip_prefix("/__slow/") {
                        tokio::time::sleep(std::time::Duration::from_millis(ms.parse().unwrap_or(0))).await;
                        let body = "<!doctype html><title>Slow</title>slow";
                        let response = format!("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                        let _ = stream.write_all(response.as_bytes()).await;
                        let _ = stream.shutdown().await;
                        return;
                    }
                    if let Some(n) = path.strip_prefix("/__redirect/") {
                        let n: u32 = n.parse().unwrap_or(0);
                        let location = if n <= 1 { "/__landed".to_string() } else { format!("/__redirect/{}", n - 1) };
                        let response = format!("HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                        let _ = stream.write_all(response.as_bytes()).await;
                        let _ = stream.shutdown().await;
                        return;
                    }
                    let body = pages.lock().unwrap().get(&path).cloned();
                    let response = match body {
                        Some(body) => format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body),
                        None => "HTTP/1.1 404 Not Found\r\nContent-Length: 9\r\nConnection: close\r\n\r\nnot found".to_string(),
                    };
                    let _ = stream.write_all(response.as_bytes()).await;
                    let _ = stream.shutdown().await;
                });
            }
        });
        Server { port, pages }
    }

    pub fn page(&self, path: &str, html: &str) -> String {
        self.pages.lock().unwrap().insert(path.to_string(), html.to_string());
        format!("http://127.0.0.1:{}{path}", self.port)
    }

    pub fn other_origin(&self, path: &str) -> String {
        format!("http://localhost:{}{path}", self.port)
    }
}

impl Harness {
    pub async fn text_err(&self, name: &str, args: Value) -> String {
        text_of(&self.call(name, args).await)
    }
}
