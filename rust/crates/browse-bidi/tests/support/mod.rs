//! A throwaway headless Firefox (own profile, random port) driven through `BiDiBrowserDriver`, a fake `Browser` with
//! one tab, and a tiny HTTP server for multi-origin pages. Skipped when no Firefox is found (unless
//! BROWSE_TEST_FIREFOX names one).

#![allow(dead_code)]

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use base64::Engine;
use browse_bidi::BiDiBrowserDriver;
use browse_core::{
    Browser, BrowserDriver, Content, HandoffResult, TabDriver, TabId, TabInfo, TabOptions, TabState, TargetId, Tool,
    ToolContext, ToolOutput,
};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

/// At most this many Firefox instances run at once.
static SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(3);

pub fn firefox_binary() -> Option<PathBuf> {
    if let Ok(path) = std::env::var("BROWSE_TEST_FIREFOX") {
        return Some(PathBuf::from(path));
    }
    let mac = PathBuf::from("/Applications/Firefox.app/Contents/MacOS/firefox");
    if mac.exists() {
        return Some(mac);
    }
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path).map(|dir| dir.join("firefox")).find(|candidate| candidate.is_file())
}

fn unique() -> u64 {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().subsec_nanos() as u64;
    nanos ^ (NEXT.fetch_add(1, Ordering::Relaxed) << 32)
}

pub struct TempDir(pub PathBuf);

impl TempDir {
    pub fn new(name: &str) -> TempDir {
        let path = std::env::temp_dir().join(format!("browse-bidi-{name}-{}-{:x}", std::process::id(), unique()));
        std::fs::create_dir_all(&path).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        TempDir(std::fs::canonicalize(&path).unwrap())
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

pub struct Firefox {
    child: tokio::process::Child,
    pub ws: String,
    _profile: TempDir,
    _slot: tokio::sync::SemaphorePermit<'static>,
}

impl Drop for Firefox {
    fn drop(&mut self) {
        let _ = self.child.start_kill();
    }
}

const PREFS: &str = r#"user_pref("app.update.disabledForTesting", true);
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("datareporting.policy.dataSubmissionEnabled", false);
user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);
user_pref("browser.startup.homepage_override.mstone", "ignore");
user_pref("browser.tabs.warnOnClose", false);
"#;

impl Firefox {
    /// Waits for Firefox to exit by itself; whether it did within `limit`.
    pub async fn exited_within(&mut self, limit: Duration) -> bool {
        tokio::time::timeout(limit, self.child.wait()).await.is_ok()
    }
}

/// Launches a headless Firefox; None when there is none (a panic when BROWSE_TEST_FIREFOX names a broken one).
pub async fn launch() -> Option<Firefox> {
    launch_with_prefs("").await
}

/// `launch` with extra prefs.js lines in the profile (as `browse firefox` writes to a real profile).
pub async fn launch_with_prefs(extra: &str) -> Option<Firefox> {
    let binary = firefox_binary()?;
    let required = std::env::var("BROWSE_TEST_FIREFOX").is_ok();
    let slot = SLOTS.acquire().await.unwrap();
    let profile = TempDir::new("profile");
    std::fs::write(profile.0.join("user.js"), PREFS).unwrap();
    if !extra.is_empty() {
        std::fs::write(profile.0.join("prefs.js"), extra).unwrap();
    }
    let spawned = tokio::process::Command::new(&binary)
        .args(["--headless", "--no-remote", "--profile"])
        .arg(&profile.0)
        .args(["--remote-debugging-port", "0", "about:blank"])
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn();
    let mut child = match spawned {
        Ok(child) => child,
        Err(error) if required => panic!("BROWSE_TEST_FIREFOX={} did not start: {error}", binary.display()),
        Err(_) => return None,
    };
    let stderr = child.stderr.take()?;
    let mut lines = BufReader::new(stderr).lines();
    let server_file = profile.0.join("WebDriverBiDiServer.json");
    let ws = tokio::time::timeout(Duration::from_secs(60), async {
        loop {
            tokio::select! {
                line = lines.next_line() => match line {
                    Ok(Some(line)) => {
                        if let Some(url) = line.split("WebDriver BiDi listening on ").nth(1) {
                            return Some(url.trim().to_string());
                        }
                    }
                    _ => return None,
                },
                _ = tokio::time::sleep(Duration::from_millis(250)) => {
                    if let Ok(text) = std::fs::read_to_string(&server_file)
                        && let Ok(server) = serde_json::from_str::<Value>(&text)
                        && let (Some(host), Some(port)) = (server["ws_host"].as_str(), server["ws_port"].as_u64())
                    {
                        return Some(format!("ws://{host}:{port}"));
                    }
                }
            }
        }
    })
    .await
    .ok()
    .flatten();
    let Some(ws) = ws else {
        assert!(!required, "Firefox at {} never opened its WebDriver BiDi port", binary.display());
        return None;
    };
    tokio::spawn(async move { while let Ok(Some(_)) = lines.next_line().await {} });
    Some(Firefox { child, ws, _profile: profile, _slot: slot })
}

/// One Firefox tab as the browser: tab 1.
pub struct FakeBrowser {
    pub driver: Arc<dyn TabDriver>,
    pub human: bool,
    pub connected_locally: bool,
    pub state: Arc<TabState>,
    pub busy: Arc<Mutex<HashMap<String, bool>>>,
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
            handoff: None,
            options: TabOptions::default(),
        }])
    }
    async fn close_tab(&self, _tab: TabId) -> anyhow::Result<()> {
        Ok(())
    }
    async fn tab_driver(&self, _tab: TabId) -> anyhow::Result<Arc<dyn TabDriver>> {
        Ok(self.driver.clone())
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
        false
    }
    fn set_busy(&self, _tab: TabId, key: &str, busy: bool) {
        self.busy.lock().unwrap().insert(key.to_string(), busy);
    }
}

pub struct Harness {
    pub server: Server,
    pub files: TempDir,
    pub ctx: ToolContext,
    pub tools: Vec<Arc<dyn Tool>>,
    pub tab: Arc<dyn TabDriver>,
    pub target: TargetId,
    pub state: Arc<TabState>,
    pub busy: Arc<Mutex<HashMap<String, bool>>>,
    pub driver: Arc<BiDiBrowserDriver>,
    pub firefox: Firefox,
}

impl Harness {
    pub async fn start() -> Option<Harness> {
        Self::start_with(false, true).await
    }

    pub async fn start_with(human: bool, connected_locally: bool) -> Option<Harness> {
        Self::start_in(launch().await?, human, connected_locally).await
    }

    /// A harness whose profile's prefs.js has `prefs`.
    pub async fn start_with_prefs(prefs: &str) -> Option<Harness> {
        Self::start_in(launch_with_prefs(prefs).await?, false, true).await
    }

    async fn start_in(firefox: Firefox, human: bool, connected_locally: bool) -> Option<Harness> {
        let driver = BiDiBrowserDriver::connect(&firefox.ws).await.expect("a WebDriver BiDi session");
        let target = driver.open(None, &TabOptions { keep_visible: true, ..TabOptions::default() }).await.unwrap();
        let tab = driver.attach(&target).await.unwrap();
        let state = Arc::new(TabState::default());
        let busy: Arc<Mutex<HashMap<String, bool>>> = Arc::default();
        let files = TempDir::new("files");
        let browser = FakeBrowser { driver: tab.clone(), human, connected_locally, state: state.clone(), busy: busy.clone() };
        let ctx = ToolContext { browser: Arc::new(browser), file_roots: vec![files.0.clone()] };
        let mut tools = browse_page::tools();
        tools.extend(browse_capture::tools());
        let server = Server::start().await;
        Some(Harness { server, files, ctx, tools, tab, target, state, busy, driver, firefox })
    }

    /// Ends the BiDi session cleanly before Firefox goes away.
    pub async fn finish(self) {
        self.driver.shutdown().await;
    }

    /// Calls a tool in tab 1 (`"tab": null` leaves it out).
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

    /// The JSON value of `expression` in the page (isolated world).
    pub async fn eval(&self, expression: &str) -> Value {
        let text = self.ok("eval", json!({ "expression": expression })).await;
        serde_json::from_str(&text).unwrap_or(Value::String(text))
    }

    pub async fn eval_main(&self, expression: &str) -> Value {
        let text = self.ok("eval", json!({ "expression": expression, "world": "main" })).await;
        serde_json::from_str(&text).unwrap_or(Value::String(text))
    }

    /// The image a tool returned.
    pub async fn image(&self, name: &str, args: Value) -> (Vec<u8>, Value) {
        let output = self.call(name, args.clone()).await;
        assert!(!output.is_error, "{name} {args} failed: {}", text_of(&output));
        let bytes = output
            .content
            .iter()
            .find_map(|c| match c {
                Content::Image { data, .. } => Some(base64::engine::general_purpose::STANDARD.decode(data).unwrap()),
                _ => None,
            })
            .expect("an image");
        let summary = serde_json::from_str(&text_of(&output)).unwrap_or(Value::Null);
        (bytes, summary)
    }
}

pub fn text_of(output: &ToolOutput) -> String {
    output
        .content
        .iter()
        .filter_map(|c| match c {
            Content::Text { text } => Some(text.clone()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn ref_of(snapshot: &str, needle: &str) -> String {
    let line = snapshot.lines().find(|l| l.contains(needle)).unwrap_or_else(|| panic!("no line with {needle:?} in:\n{snapshot}"));
    let start = line.find("ref=").expect("ref") + 4;
    line[start..].split([']', ' ']).next().unwrap().to_string()
}

pub fn png_size(bytes: &[u8]) -> (u32, u32) {
    assert_eq!(&bytes[1..4], b"PNG", "not a PNG");
    (u32::from_be_bytes(bytes[16..20].try_into().unwrap()), u32::from_be_bytes(bytes[20..24].try_into().unwrap()))
}

/// Serves registered pages on 127.0.0.1 (and ::1); `localhost` on the same port is another site.
pub struct Server {
    pub port: u16,
    pages: Arc<Mutex<HashMap<String, String>>>,
    pub hits: Arc<Mutex<Vec<String>>>,
}

async fn read_request(stream: &mut tokio::net::TcpStream) -> Option<(String, Vec<u8>)> {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 8192];
    let header_end = loop {
        let read = stream.read(&mut chunk).await.ok()?;
        if read == 0 {
            return None;
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
        let read = stream.read(&mut chunk).await.ok()?;
        if read == 0 {
            break;
        }
        buffer.extend_from_slice(&chunk[..read]);
    }
    Some((head, buffer[header_end..].to_vec()))
}

async fn respond(mut stream: tokio::net::TcpStream, pages: Arc<Mutex<HashMap<String, String>>>, hits: Arc<Mutex<Vec<String>>>) {
    let Some((head, body)) = read_request(&mut stream).await else { return };
    let target = head.split_whitespace().nth(1).unwrap_or("/").to_string();
    let path = target.split('?').next().unwrap_or("/").to_string();
    hits.lock().unwrap().push(target.clone());
    let reply = |status: &str, kind: &str, extra: &str, body: &[u8]| {
        let mut out = format!(
            "HTTP/1.1 {status}\r\nContent-Type: {kind}\r\nContent-Length: {}\r\n{extra}Connection: close\r\n\r\n",
            body.len()
        )
        .into_bytes();
        out.extend_from_slice(body);
        out
    };
    let response = if let Some(code) = path.strip_prefix("/__status/") {
        reply(&format!("{code} Status"), "text/html", "", b"")
    } else if let Some(ms) = path.strip_prefix("/__slow/") {
        tokio::time::sleep(Duration::from_millis(ms.parse().unwrap_or(0))).await;
        reply("200 OK", "text/html", "", b"<!doctype html><title>Slow</title>slow")
    } else if let Some(n) = path.strip_prefix("/__redirect/") {
        let n: u32 = n.parse().unwrap_or(0);
        let location = if n <= 1 { "/__landed".to_string() } else { format!("/__redirect/{}", n - 1) };
        reply("302 Found", "text/html", &format!("Location: {location}\r\n"), b"")
    } else if path == "/__download" {
        reply("200 OK", "application/octet-stream", "Content-Disposition: attachment; filename=file.bin\r\n", b"binary")
    } else if path == "/__count" {
        let count = hits.lock().unwrap().iter().filter(|hit| hit.starts_with("/__count")).count();
        reply("200 OK", "text/html", "Cache-Control: max-age=3600\r\n", format!("<!doctype html><title>Count</title><p id=n>{count}</p>").as_bytes())
    } else if path.starts_with("/api") {
        let echoed = String::from_utf8_lossy(&body).to_string();
        let answer = json!({ "ok": true, "session_token": "sessvalue1234567890", "echo": echoed }).to_string();
        reply("200 OK", "application/json", "Set-Cookie: sid=cookievalue1234567890; Path=/; HttpOnly\r\n", answer.as_bytes())
    } else {
        match pages.lock().unwrap().get(&path).cloned() {
            Some(page) => reply("200 OK", "text/html; charset=utf-8", "", page.as_bytes()),
            None => reply("404 Not Found", "text/plain", "", b"not found"),
        }
    };
    let _ = stream.write_all(&response).await;
    let _ = stream.shutdown().await;
}

impl Server {
    pub async fn start() -> Server {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let pages: Arc<Mutex<HashMap<String, String>>> = Arc::default();
        let hits: Arc<Mutex<Vec<String>>> = Arc::default();
        let mut listeners = vec![listener];
        // localhost may resolve to ::1 first.
        if let Ok(v6) = tokio::net::TcpListener::bind(("::1", port)).await {
            listeners.push(v6);
        }
        for listener in listeners {
            let pages = pages.clone();
            let hits = hits.clone();
            tokio::spawn(async move {
                while let Ok((stream, _)) = listener.accept().await {
                    tokio::spawn(respond(stream, pages.clone(), hits.clone()));
                }
            });
        }
        Server { port, pages, hits }
    }

    pub fn page(&self, path: &str, html: &str) -> String {
        self.pages.lock().unwrap().insert(path.to_string(), html.to_string());
        self.url(path)
    }

    pub fn url(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}{path}", self.port)
    }

    pub fn other_origin(&self, path: &str) -> String {
        format!("http://localhost:{}{path}", self.port)
    }

    pub fn hits(&self, prefix: &str) -> usize {
        self.hits.lock().unwrap().iter().filter(|hit| hit.starts_with(prefix)).count()
    }
}
