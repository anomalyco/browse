//! Live checks against a throwaway headless Chromium (its own temp profile and a random debugging port). Skipped when
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

fn find_chrome() -> Option<(PathBuf, bool)> {
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

struct Chrome {
    child: tokio::process::Child,
    profile: PathBuf,
}

impl Drop for Chrome {
    fn drop(&mut self) {
        let _ = self.child.start_kill();
        let _ = std::fs::remove_dir_all(&self.profile);
    }
}

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>;

struct WsCdp {
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

async fn launch() -> Option<(Chrome, Arc<WsCdp>)> {
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

fn rand_suffix() -> u32 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().subsec_nanos()
}

struct TestBrowser(Arc<WsCdp>, Arc<Mutex<HashMap<String, bool>>>);

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

fn tab() -> TabInfo {
    TabInfo { tab_id: 1, url: String::new(), title: String::new(), active: true }
}

const PAGE: &str = r#"<!doctype html><html><head><title>t</title><style>body{margin:0;font:16px sans-serif} #box{position:absolute;left:100px;top:120px;width:200px;height:50px;background:#36c} @keyframes spin{to{transform:rotate(360deg)}} #spin{position:absolute;left:400px;top:300px;width:80px;height:80px;background:#c33;animation:spin 1s linear infinite}</style></head>
<body><h1>Capture test</h1><button id="go">Go</button> <a href="/file.txt" id="dl">Download</a> <input name="q" placeholder="Search">
<div id="box"></div><div id="spin"></div>
<iframe id="frame" srcdoc="<body style='margin:0'><button style='width:120px;height:40px;background:#0a0;border:0'>Inner</button></body>" style="position:absolute;left:100px;top:200px;width:200px;height:80px;border:0"></iframe>
<script>
window.go = () => fetch('/api?access_token=supersecretquery123&page=2', { method: 'POST', headers: { 'Authorization': 'Bearer abcdefghijklmnopqrstuvwxyz', 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'dax', password: 'hunter2hunter2' }) }).then(r => r.json())
</script></body></html>"#;

async fn serve() -> u16 {
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
                } else if path.starts_with("/file.txt") {
                    ("text/plain", "Content-Disposition: attachment; filename=\"report.txt\"\r\n", "downloaded contents".into())
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

fn tool(name: &str) -> Arc<dyn Tool> {
    browse_capture::tools().into_iter().find(|tool| tool.spec().name == name).unwrap()
}

async fn call(ctx: &ToolContext, name: &str, args: Value) -> ToolOutput {
    let output = tool(name).call(ctx.clone(), args.clone()).await.unwrap();
    assert!(!output.is_error, "{name} {args} failed: {:?}", output.content);
    output
}

fn text(output: &ToolOutput) -> Value {
    output
        .content
        .iter()
        .find_map(|content| match content {
            Content::Text { text } => serde_json::from_str(text).ok(),
            _ => None,
        })
        .unwrap()
}

fn image(output: &ToolOutput) -> Vec<u8> {
    output
        .content
        .iter()
        .find_map(|content| match content {
            Content::Image { data, .. } => Some(base64::engine::general_purpose::STANDARD.decode(data).unwrap()),
            _ => None,
        })
        .unwrap()
}

fn png_size(bytes: &[u8]) -> (u32, u32) {
    (u32::from_be_bytes(bytes[16..20].try_into().unwrap()), u32::from_be_bytes(bytes[20..24].try_into().unwrap()))
}

async fn evaluate(cdp: &WsCdp, expression: &str) -> Value {
    let result = cdp
        .send("Runtime.evaluate", json!({ "expression": expression, "awaitPromise": true, "returnByValue": true }), None)
        .await
        .unwrap();
    result.pointer("/result/value").cloned().unwrap_or(Value::Null)
}

fn ffprobe(path: &std::path::Path) -> Option<String> {
    let output = std::process::Command::new("ffprobe")
        .args(["-v", "error", "-show_entries", "stream=codec_name,width,height:format=duration", "-of", "compact"])
        .arg(path)
        .output()
        .ok()?;
    assert!(output.status.success(), "ffprobe rejected {}: {}", path.display(), String::from_utf8_lossy(&output.stderr));
    Some(String::from_utf8_lossy(&output.stdout).to_string())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn live_capture_tools() {
    let Some((_chrome, cdp)) = launch().await else {
        eprintln!("skipping: no Chromium found");
        return;
    };
    let port = serve().await;
    let root = std::env::temp_dir().join(format!("browse-capture-files-{}", rand_suffix()));
    std::fs::create_dir_all(&root).unwrap();
    let root = std::fs::canonicalize(&root).unwrap();
    let busy: Arc<Mutex<HashMap<String, bool>>> = Arc::default();
    let ctx = ToolContext {
        session: "test".into(),
        browser: Arc::new(TestBrowser(cdp.clone(), busy.clone())),
        state: Arc::new(SessionState::default()),
        file_roots: vec![root.clone()],
    };

    let mut events = cdp.events();
    cdp.send("Page.enable", json!({}), None).await.unwrap();
    cdp.send("Page.navigate", json!({ "url": format!("http://127.0.0.1:{port}/") }), None).await.unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        while let Ok(event) = events.recv().await {
            if event.method == "Page.loadEventFired" {
                break;
            }
        }
    })
    .await
    .unwrap();
    let viewport: Vec<f64> = serde_json::from_value(evaluate(&cdp, "[innerWidth, innerHeight, devicePixelRatio]").await).unwrap();
    eprintln!("viewport {viewport:?}");

    // Screenshots: CSS-pixel by default, device pixels on request, element clips, labels, saved files.
    let shot = call(&ctx, "screenshot", json!({})).await;
    assert_eq!(png_size(&image(&shot)), (viewport[0] as u32, viewport[1] as u32));
    let device = call(&ctx, "screenshot", json!({ "scale": "device" })).await;
    assert_eq!(png_size(&image(&device)).0, (viewport[0] * viewport[2]) as u32);
    let element = call(&ctx, "screenshot", json!({ "selector": "#box" })).await;
    assert_eq!(png_size(&image(&element)), (200, 50));
    let pixels = browse_capture::pixeldiff::decode_png(&image(&element)).unwrap();
    assert_eq!(&pixels.data[..3], &[0x33, 0x66, 0xcc], "the clip is the blue box");
    // Element screenshots by snapshot ref (inside an iframe too) and by selector, resolved by browse-page.
    let page_tool = browse_page::tools().into_iter().find(|tool| tool.spec().name == "snapshot").unwrap();
    let snapshot = page_tool.call(ctx.clone(), json!({})).await.unwrap();
    assert!(!snapshot.is_error, "{:?}", snapshot.content);
    let (_, refs) = browse_page::snapshot_refs(&ctx).await;
    let inner = refs.iter().find(|(_, role, name)| role == "button" && name.as_deref() == Some("Inner")).expect("iframe button ref");
    let by_ref = call(&ctx, "screenshot", json!({ "ref": inner.0 })).await;
    assert_eq!(png_size(&image(&by_ref)), (120, 40));
    let pixels = browse_capture::pixeldiff::decode_png(&image(&by_ref)).unwrap();
    assert_eq!(&pixels.data[..3], &[0x00, 0xaa, 0x00], "the ref clip is the green iframe button ({})", inner.0);
    let go = refs.iter().find(|(_, role, name)| role == "button" && name.as_deref() == Some("Go")).unwrap();
    assert!(call(&ctx, "screenshot", json!({ "ref": go.0 })).await.content.len() == 2);
    let by_role = call(&ctx, "screenshot", json!({ "selector": "internal:role=button[name=\"Go\"i]" })).await;
    assert_eq!(png_size(&image(&by_role)), png_size(&image(&call(&ctx, "screenshot", json!({ "selector": "#go" })).await)));
    let jpeg = call(&ctx, "screenshot", json!({ "format": "jpeg", "quality": 50, "fullPage": true })).await;
    assert_eq!(&image(&jpeg)[..2], &[0xFF, 0xD8]);
    let labelled = call(&ctx, "screenshot", json!({ "labels": true })).await;
    let labels = text(&labelled)["labels"].as_array().unwrap().clone();
    assert!(labels.iter().any(|label| label["selector"] == "#go" && label["role"] == "button"), "{labels:?}");
    assert!(evaluate(&cdp, "document.querySelectorAll('div').length").await == json!(2), "labels left nothing in the page");
    evaluate(&cdp, "document.getElementById('spin').style.animationPlayState = 'paused'").await;
    let saved = text(&call(&ctx, "screenshot", json!({ "path": "shots/base.png" })).await);
    assert_eq!(saved["path"], json!(root.join("shots/base.png")));
    let same = text(&call(&ctx, "screenshot_diff", json!({ "baseline": "shots/base.png" })).await);
    assert_eq!(same["matches"], json!(true), "{same}");
    evaluate(&cdp, "document.getElementById('box').style.background = 'red'").await;
    let changed = call(&ctx, "screenshot_diff", json!({ "baseline": "shots/base.png" })).await;
    assert_eq!(text(&changed)["matches"], json!(false));
    assert!(text(&changed)["changedPixels"].as_u64().unwrap() >= 200 * 50);
    let outside = tool("screenshot").call(ctx.clone(), json!({ "path": "/etc/shot.png" })).await.unwrap();
    assert!(outside.is_error);

    // Network capture with redaction, inline and as HAR.
    call(&ctx, "network", json!({ "action": "start", "urlFilter": "/api" })).await;
    assert_eq!(evaluate(&cdp, "go().then(r => r.ok)").await, json!(true));
    tokio::time::sleep(Duration::from_millis(300)).await;
    let status = text(&call(&ctx, "network", json!({ "action": "status" })).await);
    assert_eq!(status["active"], json!(true));
    assert_eq!(busy.lock().unwrap().get("network"), Some(&true));
    let stopped = call(&ctx, "network", json!({ "action": "stop" })).await;
    let raw = serde_json::to_string(&text(&stopped)).unwrap();
    for secret in ["supersecretquery123", "abcdefghijklmnopqrstuvwxyz", "hunter2hunter2", "sessvalue1234567890", "cookievalue1234567890"] {
        assert!(!raw.contains(secret), "{secret} leaked: {raw}");
    }
    assert_eq!(busy.lock().unwrap().get("network"), Some(&false));
    let exchanges = text(&stopped)["exchanges"].as_array().unwrap().clone();
    assert_eq!(exchanges.len(), 1, "{raw}");
    let exchange = &exchanges[0];
    assert_eq!(exchange["response"]["status"], json!(200));
    assert!(exchange["request"]["body"]["text"].as_str().unwrap().contains(r#""username":"dax""#), "{raw}");
    assert!(exchange["response"]["body"]["text"].as_str().unwrap().contains(r#""ok":true"#), "{raw}");
    // Console capture is opt-in and only sees what happens after start.
    evaluate(&cdp, "console.log('before start')").await;
    call(&ctx, "console", json!({ "action": "start" })).await;
    evaluate(&cdp, "console.log('hello', 42); setTimeout(() => { throw new Error('boom') })").await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let read = text(&call(&ctx, "console", json!({ "action": "read" })).await);
    let entries = read["entries"].as_array().unwrap();
    assert!(entries.iter().any(|entry| entry["text"] == "hello 42" && entry["type"] == "log"), "{read}");
    assert!(entries.iter().any(|entry| entry["type"] == "pageerror" && entry["text"].as_str().unwrap().contains("boom")), "{read}");
    assert!(!entries.iter().any(|entry| entry["text"] == "before start"), "{read}");
    call(&ctx, "console", json!({ "action": "stop" })).await;

    // Recording straight to Matroska.
    evaluate(&cdp, "document.getElementById('spin').style.animationPlayState = 'running'").await;
    let started = text(&call(&ctx, "recording", json!({ "action": "start", "path": "rec/clip.mkv", "frameRate": 20 })).await);
    eprintln!("recording {started}");
    tokio::time::sleep(Duration::from_millis(1_500)).await;
    let status = text(&call(&ctx, "recording", json!({ "action": "status" })).await);
    assert_eq!(status["recording"], json!(true));
    assert_eq!(busy.lock().unwrap().get("recording"), Some(&true));
    let done = text(&call(&ctx, "recording", json!({ "action": "stop" })).await);
    eprintln!("recorded {done}");
    assert_eq!(busy.lock().unwrap().get("recording"), Some(&false));
    let clip = root.join("rec/clip.mkv");
    assert!(done["frameCount"].as_u64().unwrap() >= 2, "{done}");
    if let Some(probe) = ffprobe(&clip) {
        eprintln!("ffprobe {probe}");
        assert!(probe.contains("codec_name=mjpeg"), "{probe}");
    }

    // Recording transcoded to MP4 (needs ffmpeg).
    if which("ffmpeg") {
        call(&ctx, "recording", json!({ "action": "start", "path": "rec/clip.mp4", "frameRate": 10 })).await;
        tokio::time::sleep(Duration::from_millis(1_000)).await;
        let done = text(&call(&ctx, "recording", json!({ "action": "stop" })).await);
        let probe = ffprobe(&root.join("rec/clip.mp4")).unwrap();
        eprintln!("mp4 {done} {probe}");
        assert!(probe.contains("codec_name=h264") && probe.contains(&format!("width={}", viewport[0] as u32)), "{probe}");
    }

    // Downloads land in the file roots.
    let started = text(&call(&ctx, "download", json!({ "action": "start" })).await);
    evaluate(&cdp, "document.getElementById('dl').click()").await;
    let finished = text(&call(&ctx, "download", json!({ "action": "wait", "timeoutMs": 10000 })).await);
    eprintln!("download {started} {finished}");
    assert_eq!(finished["state"], json!("completed"));
    let path = PathBuf::from(finished["path"].as_str().unwrap());
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "downloaded contents");
    call(&ctx, "download", json!({ "action": "stop" })).await;

    std::fs::remove_dir_all(root).unwrap();
}

fn which(binary: &str) -> bool {
    std::process::Command::new(binary).arg("-version").output().is_ok_and(|output| output.status.success())
}

