#![allow(dead_code)]
//! Harness for live checks against a throwaway headless Chromium (its own temp profile and a random debugging port). Skipped when
//! no Chromium is found; set BROWSE_TEST_CHROME to choose one. Never touches the user's browser or the browse relay.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use base64::Engine;
use browse_core::{
    Browser, Cdp, CdpError, CdpEvent, Content, HandoffResult, SessionId, SessionState, TabId, TabInfo, Tool,
    ToolContext, ToolOutput,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt};
use tokio::sync::{broadcast, mpsc, oneshot};
use tokio_tungstenite::tungstenite::Message;

pub fn find_chrome() -> Option<(PathBuf, bool)> {
    if let Ok(path) = std::env::var("BROWSE_TEST_CHROME") {
        return Some((PathBuf::from(path), true));
    }
    let cache = PathBuf::from(std::env::var("HOME").ok()?).join(".cache/ms-playwright");
    let mut candidates: Vec<(PathBuf, bool)> = Vec::new();
    for entry in std::fs::read_dir(&cache).ok()?.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with("chromium_headless_shell-") {
            candidates.push((entry.path().join("chrome-headless-shell-linux64/chrome-headless-shell"), false));
        } else if name.starts_with("chromium-") {
            candidates.push((entry.path().join("chrome-linux64/chrome"), true));
        }
    }
    candidates.retain(|(path, _)| path.exists());
    // Newest full Chromium first (closest to the real browser), else the newest headless shell.
    candidates.sort_by(|a, b| (a.1, &a.0).cmp(&(b.1, &b.0)));
    candidates.pop()
}

pub struct Chrome {
    pub child: tokio::process::Child,
    pub profile: PathBuf,
}

impl Drop for Chrome {
    fn drop(&mut self) {
        let _ = self.child.start_kill();
        let _ = std::fs::remove_dir_all(&self.profile);
    }
}

pub type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>;

pub struct WsCdp {
    out: mpsc::UnboundedSender<String>,
    pending: Pending,
    next: AtomicU64,
    events: broadcast::Sender<CdpEvent>,
    page_session: Mutex<Option<String>>,
}

impl WsCdp {
    async fn raw(&self, method: &str, params: Value, session: Option<&str>) -> Result<Value, CdpError> {
        let id = self.next.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);
        let mut message = json!({ "id": id, "method": method, "params": params });
        if let Some(session) = session {
            message["sessionId"] = json!(session);
        }
        self.out.send(message.to_string()).map_err(|_| CdpError::Disconnected)?;
        match tokio::time::timeout(Duration::from_secs(30), rx).await {
            Ok(Ok(Ok(value))) => Ok(value),
            Ok(Ok(Err(error))) => Err(CdpError::Protocol(error)),
            Ok(Err(_)) => Err(CdpError::Disconnected),
            Err(_) => Err(CdpError::Timeout(30_000)),
        }
    }
}

#[async_trait]
impl Cdp for WsCdp {
    async fn send(&self, method: &str, params: Value, session_id: Option<&str>) -> Result<Value, CdpError> {
        let page = self.page_session.lock().unwrap().clone();
        self.raw(method, params, session_id.or(page.as_deref())).await
    }
    fn events(&self) -> broadcast::Receiver<CdpEvent> {
        self.events.subscribe()
    }
}

pub async fn launch() -> Option<(Chrome, Arc<WsCdp>)> {
    let (binary, full) = find_chrome()?;
    let profile = std::env::temp_dir().join(format!("browse-capture-live-{}-{}", std::process::id(), rand_suffix()));
    std::fs::create_dir_all(&profile).ok()?;
    let mut command = tokio::process::Command::new(&binary);
    if full {
        command.arg("--headless=new");
    }
    command
        .args([
            "--remote-debugging-port=0",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-gpu",
            "--no-sandbox",
            "--force-device-scale-factor=2",
            "--window-size=800,600",
            "--hide-scrollbars",
        ])
        .arg(format!("--user-data-dir={}", profile.display()))
        .arg("about:blank")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let mut child = command.spawn().ok()?;
    let stderr = child.stderr.take()?;
    let mut lines = tokio::io::BufReader::new(stderr).lines();
    let url = tokio::time::timeout(Duration::from_secs(20), async {
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
    let chrome = Chrome { child, profile };
    let (socket, _) = tokio_tungstenite::connect_async(url).await.ok()?;
    let (mut sink, mut stream) = socket.split();
    let (out, mut outgoing) = mpsc::unbounded_channel::<String>();
    tokio::spawn(async move {
        while let Some(text) = outgoing.recv().await {
            if sink.send(Message::Text(text.into())).await.is_err() {
                break;
            }
        }
    });
    let cdp = Arc::new(WsCdp {
        out,
        pending: Arc::default(),
        next: AtomicU64::new(1),
        events: broadcast::channel(4096).0,
        page_session: Mutex::new(None),
    });
    let reader = cdp.clone();
    tokio::spawn(async move {
        while let Some(Ok(message)) = stream.next().await {
            let Message::Text(text) = message else { continue };
            let Ok(value) = serde_json::from_str::<Value>(&text) else { continue };
            if let Some(id) = value.get("id").and_then(Value::as_u64) {
                if let Some(tx) = reader.pending.lock().unwrap().remove(&id) {
                    let result = match value.get("error") {
                        Some(error) => Err(error.get("message").and_then(Value::as_str).unwrap_or("error").to_string()),
                        None => Ok(value.get("result").cloned().unwrap_or(Value::Null)),
                    };
                    let _ = tx.send(result);
                }
                continue;
            }
            let session = value.get("sessionId").and_then(Value::as_str).map(str::to_string);
            let page = reader.page_session.lock().unwrap().clone();
            if session.is_none() {
                continue;
            }
            let _ = reader.events.send(CdpEvent {
                method: value.get("method").and_then(Value::as_str).unwrap_or("").to_string(),
                params: value.get("params").cloned().unwrap_or(Value::Null),
                session_id: if session == page { None } else { session },
            });
        }
    });
    let target = cdp.raw("Target.createTarget", json!({ "url": "about:blank" }), None).await.ok()?;
    let target_id = target.get("targetId")?.as_str()?.to_string();
    let attached =
        cdp.raw("Target.attachToTarget", json!({ "targetId": target_id, "flatten": true }), None).await.ok()?;
    *cdp.page_session.lock().unwrap() = Some(attached.get("sessionId")?.as_str()?.to_string());
    Some((chrome, cdp))
}

pub fn rand_suffix() -> u32 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().subsec_nanos()
}

pub struct TestBrowser(pub Arc<WsCdp>, pub Arc<Mutex<HashMap<String, bool>>>);

#[async_trait]
impl Browser for TestBrowser {
    async fn tabs(&self, _: &SessionId) -> anyhow::Result<Vec<TabInfo>> {
        Ok(vec![tab()])
    }
    async fn current_tab(&self, _: &SessionId) -> anyhow::Result<TabInfo> {
        Ok(tab())
    }
    async fn open_tab(&self, _: &SessionId, _: Option<&str>) -> anyhow::Result<TabInfo> {
        anyhow::bail!("not in tests")
    }
    async fn select_tab(&self, _: &SessionId, _: TabId) -> anyhow::Result<()> {
        Ok(())
    }
    async fn close_tab(&self, _: &SessionId, _: TabId) -> anyhow::Result<()> {
        Ok(())
    }
    async fn cdp(&self, _: &SessionId, _: TabId) -> anyhow::Result<Arc<dyn Cdp>> {
        Ok(self.0.clone())
    }
    async fn handoff(&self, _: &SessionId, _: TabId, _: &str) -> anyhow::Result<HandoffResult> {
        anyhow::bail!("not in tests")
    }
    fn set_busy(&self, _: &SessionId, key: &str, busy: bool) {
        self.1.lock().unwrap().insert(key.to_string(), busy);
    }
}

pub fn tab() -> TabInfo {
    TabInfo { tab_id: 1, url: String::new(), title: String::new(), active: true }
}

pub const PAGE: &str = r#"<!doctype html><html><head><title>t</title><style>body{margin:0;font:16px sans-serif} #box{position:absolute;left:100px;top:120px;width:200px;height:50px;background:#36c} @keyframes spin{to{transform:rotate(360deg)}} #spin{position:absolute;left:400px;top:300px;width:80px;height:80px;background:#c33;animation:spin 1s linear infinite}</style></head>
<body><h1>Capture test</h1><button id="go">Go</button> <input name="q" placeholder="Search">
<div id="box"></div><div id="spin"></div>
<iframe id="frame" srcdoc="<body style='margin:0'><button style='width:120px;height:40px;background:#0a0;border:0'>Inner</button></body>" style="position:absolute;left:100px;top:200px;width:200px;height:80px;border:0"></iframe>
<script>
window.go = () => fetch('/api?access_token=supersecretquery123&page=2', { method: 'POST', headers: { 'Authorization': 'Bearer abcdefghijklmnopqrstuvwxyz', 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'dax', password: 'hunter2hunter2' }) }).then(r => r.json())
</script></body></html>"#;

pub async fn serve() -> u16 {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            tokio::spawn(async move {
                let mut buffer = Vec::new();
                let mut chunk = [0u8; 4096];
                let header_end = loop {
                    let Ok(read) = socket.read(&mut chunk).await else { return };
                    if read == 0 {
                        return;
                    }
                    buffer.extend_from_slice(&chunk[..read]);
                    if let Some(index) = buffer.windows(4).position(|w| w == b"\r\n\r\n") {
                        break index + 4;
                    }
                };
                let head = String::from_utf8_lossy(&buffer[..header_end]).to_string();
                let length = head
                    .lines()
                    .find_map(|line| line.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap_or(0)))
                    .unwrap_or(0);
                while buffer.len() < header_end + length {
                    let Ok(read) = socket.read(&mut chunk).await else { return };
                    if read == 0 {
                        break;
                    }
                    buffer.extend_from_slice(&chunk[..read]);
                }
                let path = head.split_whitespace().nth(1).unwrap_or("/").to_string();
                let (kind, extra, body): (&str, &str, String) = if path.starts_with("/api") {
                    (
                        "application/json",
                        "Set-Cookie: sid=cookievalue1234567890; Path=/; HttpOnly\r\n",
                        r#"{"session_token":"sessvalue1234567890","ok":true}"#.into(),
                    )
                } else if path.starts_with("/oopif") {
                    ("text/html", "", format!("<!doctype html><body><iframe src=\"http://localhost:{port}/frame\"></iframe></body>"))
                } else if path.starts_with("/frame") {
                    ("text/html", "", "<!doctype html><body><p>frame</p><script>console.log('from frame')</script></body>".into())
                } else if path.starts_with("/tall") {
                    ("text/html", "", "<!doctype html><body style=\"margin:0\"><div style=\"height:12000px;background:linear-gradient(red,blue)\"></div></body>".into())
                } else {
                    ("text/html", "", PAGE.into())
                };
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: {kind}\r\nContent-Length: {}\r\n{extra}Connection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = socket.write_all(response.as_bytes()).await;
            });
        }
    });
    port
}

pub fn tool(name: &str) -> Arc<dyn Tool> {
    browse_capture::tools().into_iter().find(|tool| tool.spec().name == name).unwrap()
}

pub async fn call(ctx: &ToolContext, name: &str, args: Value) -> ToolOutput {
    let output = tool(name).call(ctx.clone(), args.clone()).await.unwrap();
    assert!(!output.is_error, "{name} {args} failed: {:?}", output.content);
    output
}

pub fn text(output: &ToolOutput) -> Value {
    output
        .content
        .iter()
        .find_map(|content| match content {
            Content::Text { text } => serde_json::from_str(text).ok(),
            _ => None,
        })
        .unwrap()
}

pub fn image(output: &ToolOutput) -> Vec<u8> {
    output
        .content
        .iter()
        .find_map(|content| match content {
            Content::Image { data, .. } => Some(base64::engine::general_purpose::STANDARD.decode(data).unwrap()),
            _ => None,
        })
        .unwrap()
}

pub fn png_size(bytes: &[u8]) -> (u32, u32) {
    (u32::from_be_bytes(bytes[16..20].try_into().unwrap()), u32::from_be_bytes(bytes[20..24].try_into().unwrap()))
}

pub async fn evaluate(cdp: &WsCdp, expression: &str) -> Value {
    let result = cdp
        .send("Runtime.evaluate", json!({ "expression": expression, "awaitPromise": true, "returnByValue": true }), None)
        .await
        .unwrap();
    result.pointer("/result/value").cloned().unwrap_or(Value::Null)
}

pub fn ffprobe(path: &std::path::Path) -> Option<String> {
    let output = std::process::Command::new("ffprobe")
        .args(["-v", "error", "-show_entries", "stream=codec_name,width,height,pix_fmt:format=duration", "-of", "compact"])
        .arg(path)
        .output()
        .ok()?;
    assert!(output.status.success(), "ffprobe rejected {}: {}", path.display(), String::from_utf8_lossy(&output.stderr));
    Some(String::from_utf8_lossy(&output.stdout).to_string())
}


pub fn which(binary: &str) -> bool {
    std::process::Command::new(binary).arg("-version").output().is_ok_and(|output| output.status.success())
}

/// A tool context over the live tab, writing files into a fresh private root.
pub fn context(cdp: &Arc<WsCdp>) -> (ToolContext, PathBuf, Arc<Mutex<HashMap<String, bool>>>) {
    let root = std::env::temp_dir().join(format!("browse-capture-files-{}", rand_suffix()));
    std::fs::create_dir_all(&root).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    let root = std::fs::canonicalize(&root).unwrap();
    let busy: Arc<Mutex<HashMap<String, bool>>> = Arc::default();
    let ctx = ToolContext {
        session: "test".into(),
        browser: Arc::new(TestBrowser(cdp.clone(), busy.clone())),
        state: Arc::new(SessionState::default()),
        file_roots: vec![root.clone()],
    };
    (ctx, root, busy)
}

/// Navigates the tab and waits for its load event.
pub async fn goto(cdp: &WsCdp, url: &str) {
    let mut events = cdp.events();
    cdp.send("Page.enable", json!({}), None).await.unwrap();
    cdp.send("Page.navigate", json!({ "url": url }), None).await.unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        while let Ok(event) = events.recv().await {
            if event.method == "Page.loadEventFired" && event.session_id.is_none() {
                break;
            }
        }
    })
    .await
    .unwrap();
}

/// Evaluates in a fresh isolated world of the main frame (the page can't see it); returns its context id.
pub async fn isolated_world(cdp: &WsCdp) -> i64 {
    let tree = cdp.send("Page.getFrameTree", json!({}), None).await.unwrap();
    let frame = tree.pointer("/frameTree/frame/id").and_then(Value::as_str).unwrap().to_string();
    let world = cdp.send("Page.createIsolatedWorld", json!({ "frameId": frame, "worldName": "test" }), None).await.unwrap();
    world["executionContextId"].as_i64().unwrap()
}

pub async fn evaluate_in(cdp: &WsCdp, context: i64, expression: &str) -> Value {
    let result = cdp
        .send("Runtime.evaluate", json!({ "expression": expression, "contextId": context, "awaitPromise": true, "returnByValue": true }), None)
        .await
        .unwrap();
    result.pointer("/result/value").cloned().unwrap_or(Value::Null)
}
