//! The fixture sites every backend browses: a `primary` origin (`127.0.0.1:<port>`) and a `cross` one
//! (`localhost:<port>`, another site, so its frames are out of process in Chromium), served by one small HTTP/1.1
//! server pair per backend.
//!
//! Everything is deterministic: no timers decide what a page shows, slow responses wait on `/gate/<name>` barriers the
//! sweep opens, every request is logged (the ground truth network capture is checked against), every page has a
//! `data:` icon (so no favicon request races the capture), and nothing is cacheable but the back/forward cache pages.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;

/// Credentials the fixtures send and receive. None may ever appear in a tool's output: the network capture redacts
/// them and the form tools hide the password.
pub const BEARER: &str = "tok_conformance_bearer_9f8e7d6c5b4a";
pub const SESSION_COOKIE: &str = "sid_conformance_cookie_1a2b3c4d5e6f";
pub const ACCESS_TOKEN: &str = "atok_conformance_query_77aa88bb99cc";
pub const PASSWORD: &str = "pw-Conformance-Secret-4242";
pub const SESSION_TOKEN: &str = "sess_conformance_json_0011223344556677";
pub const SECRETS: [&str; 5] = [BEARER, SESSION_COOKIE, ACCESS_TOKEN, PASSWORD, SESSION_TOKEN];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Site {
    Primary,
    Cross,
}

/// One request as the server saw it.
#[derive(Debug, Clone)]
pub struct Logged {
    pub site: Site,
    pub method: String,
    /// Path and query.
    pub target: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Logged {
    pub fn path(&self) -> &str {
        self.target.split('?').next().unwrap_or(&self.target)
    }

    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(n, _)| n.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }
}

struct Shared {
    primary: String,
    cross: String,
    log: Mutex<Vec<Logged>>,
    gates: Mutex<HashMap<String, watch::Sender<bool>>>,
}

impl Shared {
    fn gate(&self, name: &str) -> watch::Receiver<bool> {
        self.gates.lock().unwrap().entry(name.to_string()).or_insert_with(|| watch::channel(false).0).subscribe()
    }
}

pub struct FixtureSites {
    pub primary_port: u16,
    pub cross_port: u16,
    shared: Arc<Shared>,
    tasks: Vec<tokio::task::AbortHandle>,
}

impl Drop for FixtureSites {
    fn drop(&mut self) {
        for task in &self.tasks {
            task.abort();
        }
    }
}

impl FixtureSites {
    pub async fn start() -> anyhow::Result<FixtureSites> {
        let primary = TcpListener::bind("127.0.0.1:0").await?;
        let primary_port = primary.local_addr()?.port();
        let cross = TcpListener::bind("127.0.0.1:0").await?;
        let cross_port = cross.local_addr()?.port();
        let shared = Arc::new(Shared {
            primary: format!("127.0.0.1:{primary_port}"),
            cross: format!("localhost:{cross_port}"),
            log: Mutex::new(Vec::new()),
            gates: Mutex::new(HashMap::new()),
        });
        let mut listeners = vec![(primary, Site::Primary), (cross, Site::Cross)];
        // localhost may resolve to ::1 first.
        if let Ok(v6) = TcpListener::bind(("::1", cross_port)).await {
            listeners.push((v6, Site::Cross));
        }
        let mut tasks = Vec::new();
        for (listener, site) in listeners {
            let shared = shared.clone();
            let task = tokio::spawn(async move {
                while let Ok((stream, _)) = listener.accept().await {
                    tokio::spawn(serve(stream, site, shared.clone()));
                }
            });
            tasks.push(task.abort_handle());
        }
        Ok(FixtureSites { primary_port, cross_port, shared, tasks })
    }

    /// `127.0.0.1:<port>`
    pub fn primary_host(&self) -> &str {
        &self.shared.primary
    }

    /// `localhost:<port>`
    pub fn cross_host(&self) -> &str {
        &self.shared.cross
    }

    pub fn url(&self, path: &str) -> String {
        format!("http://{}{path}", self.shared.primary)
    }

    pub fn cross_url(&self, path: &str) -> String {
        format!("http://{}{path}", self.shared.cross)
    }

    /// Lets every request waiting on `/gate/<name>` (now or later) through.
    pub fn open_gate(&self, name: &str) {
        let sender = self.shared.gates.lock().unwrap().entry(name.to_string()).or_insert_with(|| watch::channel(false).0).clone();
        let _ = sender.send(true);
    }

    pub fn log(&self) -> Vec<Logged> {
        self.shared.log.lock().unwrap().clone()
    }

    pub fn clear_log(&self) {
        self.shared.log.lock().unwrap().clear();
    }

    /// The logged requests whose path starts with `prefix`.
    pub fn requests(&self, prefix: &str) -> Vec<Logged> {
        self.log().into_iter().filter(|r| r.path().starts_with(prefix)).collect()
    }
}

/// Reads one request (headers, then a Content-Length body, across as many reads as it takes); None at EOF.
async fn read_request(stream: &mut TcpStream, buffer: &mut Vec<u8>) -> Option<(String, Vec<(String, String)>, String, Vec<u8>)> {
    let mut chunk = [0u8; 16 * 1024];
    let header_end = loop {
        if let Some(index) = buffer.windows(4).position(|w| w == b"\r\n\r\n") {
            break index + 4;
        }
        let read = stream.read(&mut chunk).await.ok()?;
        if read == 0 {
            return None;
        }
        buffer.extend_from_slice(&chunk[..read]);
    };
    let head = String::from_utf8_lossy(&buffer[..header_end]).to_string();
    let mut lines = head.split("\r\n");
    let mut request_line = lines.next()?.split(' ');
    let method = request_line.next()?.to_string();
    let target = request_line.next()?.to_string();
    let headers: Vec<(String, String)> = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(name, value)| (name.trim().to_string(), value.trim().to_string()))
        .collect();
    let length = headers
        .iter()
        .find(|(n, _)| n.eq_ignore_ascii_case("content-length"))
        .and_then(|(_, v)| v.parse::<usize>().ok())
        .unwrap_or(0);
    while buffer.len() < header_end + length {
        let read = stream.read(&mut chunk).await.ok()?;
        if read == 0 {
            return None;
        }
        buffer.extend_from_slice(&chunk[..read]);
    }
    let body = buffer[header_end..header_end + length].to_vec();
    buffer.drain(..header_end + length);
    Some((method, headers, target, body))
}

async fn serve(mut stream: TcpStream, site: Site, shared: Arc<Shared>) {
    let mut buffer = Vec::new();
    while let Some((method, headers, target, body)) = read_request(&mut stream, &mut buffer).await {
        let logged = Logged { site, method, target, headers, body };
        shared.log.lock().unwrap().push(logged.clone());
        let Some(response) = route(&logged, &shared).await else { return };
        if stream.write_all(&response.bytes(&logged.method)).await.is_err() {
            return;
        }
    }
}

pub struct Response {
    status: &'static str,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Response {
    fn new(status: &'static str, kind: &str, body: impl Into<Vec<u8>>) -> Response {
        Response { status, headers: vec![("Content-Type".into(), kind.into())], body: body.into() }
    }

    fn html(body: String) -> Response {
        Response::new("200 OK", "text/html; charset=utf-8", body)
    }

    fn json(body: &str) -> Response {
        Response::new("200 OK", "application/json", body)
    }

    fn header(mut self, name: &str, value: &str) -> Response {
        self.headers.push((name.into(), value.into()));
        self
    }

    fn bytes(&self, method: &str) -> Vec<u8> {
        let mut head = format!("HTTP/1.1 {}\r\n", self.status);
        for (name, value) in &self.headers {
            head.push_str(&format!("{name}: {value}\r\n"));
        }
        if !self.headers.iter().any(|(n, _)| n.eq_ignore_ascii_case("cache-control")) {
            head.push_str("Cache-Control: no-store\r\n");
        }
        head.push_str(&format!("Content-Length: {}\r\nConnection: keep-alive\r\n\r\n", self.body.len()));
        let mut out = head.into_bytes();
        if method != "HEAD" {
            out.extend_from_slice(&self.body);
        }
        out
    }
}

/// A page with the fixtures' common head.
fn page(shared: &Shared, title: &str, head: &str, body: &str) -> Response {
    let html = format!(
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><link rel=\"icon\" href=\"data:,\"><title>{title}</title>{head}</head><body>{body}</body></html>"
    );
    Response::html(fill(shared, &html))
}

fn fill(shared: &Shared, text: &str) -> String {
    text.replace("{PRIMARY}", &format!("http://{}", shared.primary))
        .replace("{CROSS}", &format!("http://{}", shared.cross))
        .replace("{BEARER}", BEARER)
        .replace("{ACCESS_TOKEN}", ACCESS_TOKEN)
        .replace("{PASSWORD}", PASSWORD)
}

/// A gzip member holding `data` in stored (uncompressed) deflate blocks: the same bytes every time.
pub fn gzip_stored(data: &[u8]) -> Vec<u8> {
    let mut out = vec![0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 0xff];
    let mut blocks = data.chunks(65_535).peekable();
    if blocks.peek().is_none() {
        out.extend_from_slice(&[1, 0, 0, 0xff, 0xff]);
    }
    while let Some(block) = blocks.next() {
        out.push(if blocks.peek().is_none() { 1 } else { 0 });
        let len = block.len() as u16;
        out.extend_from_slice(&len.to_le_bytes());
        out.extend_from_slice(&(!len).to_le_bytes());
        out.extend_from_slice(block);
    }
    out.extend_from_slice(&crc32(data).to_le_bytes());
    out.extend_from_slice(&(data.len() as u32).to_le_bytes());
    out
}

pub fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xffff_ffffu32;
    for byte in data {
        crc ^= *byte as u32;
        for _ in 0..8 {
            crc = if crc & 1 == 1 { (crc >> 1) ^ 0xedb8_8320 } else { crc >> 1 };
        }
    }
    !crc
}

/// A 4×2 opaque PNG (red, green, blue, white on top; black below).
pub fn fixture_png() -> Vec<u8> {
    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, 4, 2);
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().expect("png header");
        let mut pixels = vec![255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255];
        pixels.extend_from_slice(&[0; 12]);
        writer.write_image_data(&pixels).expect("png data");
    }
    out
}

const GZIP_JSON: &str = r#"{"compressed":true,"items":[1,2,3]}"#;

async fn route(request: &Logged, shared: &Shared) -> Option<Response> {
    let path = request.path().to_string();
    let query = request.target.split_once('?').map(|(_, q)| q.to_string()).unwrap_or_default();
    let cross = request.site == Site::Cross;
    let response = match path.as_str() {
        "/favicon.ico" => Response::new("204 No Content", "image/x-icon", Vec::new()),
        "/" => page(shared, "Index", "", "<main><h1>Fixtures</h1><p>Conformance fixtures.</p></main>"),
        "/app" => page(shared, "App", APP_HEAD, APP_BODY),
        "/spa" => page(shared, "SPA", "", SPA_BODY),
        "/spa/next" => page(shared, "SPA next", "", "<main><h1>Next page</h1><a href=\"/spa\">Back to SPA</a></main>"),
        "/landed" => page(shared, "Landed", "", "<main><h1>Landed</h1><p>After redirects.</p></main>"),
        "/download" => Response::new("200 OK", "application/octet-stream", b"conformance download\n".to_vec())
            .header("Content-Disposition", "attachment; filename=\"conformance.bin\""),
        "/bf/a" => page(shared, "BF A", "", BF_A).header("Cache-Control", "private, max-age=0"),
        "/bf/b" => page(shared, "BF B", "", "<main><h1>Page B</h1><a href=\"/bf/a\">To A</a></main>")
            .header("Cache-Control", "private, max-age=0"),
        "/frames" => page(shared, "Frames", "", FRAMES_BODY),
        "/frames/same" => page(shared, "Same frame", "", FRAME_SAME),
        "/frames/cross" => page(shared, "Cross frame", "", FRAME_CROSS),
        "/frames/n1" => page(shared, "Nest 1", "", "<p>Level 1</p><iframe title=\"Level two\" src=\"/frames/n2\" width=\"300\" height=\"120\"></iframe>"),
        "/frames/n2" => page(shared, "Nest 2", "", "<p>Level 2</p><iframe title=\"Level three\" src=\"{CROSS}/frames/n3\" width=\"260\" height=\"60\"></iframe>"),
        "/frames/n3" => page(shared, "Nest 3", "", "<button onclick=\"this.textContent='Deep clicked'\">Deep button</button>"),
        "/dialogs" => page(shared, "Dialogs", "", DIALOGS_BODY),
        "/dialogs/onload" => page(shared, "Alert on load", "", "<main><h1>Loaded with an alert</h1></main><script>alert('during load')</script>"),
        "/dialogs/frame" => page(shared, "Dialog frame", "", "<button id=\"fa\" onclick=\"document.getElementById('fr').textContent=String(confirm('frame confirm'))\">Frame confirm</button><p id=\"fr\"></p>"),
        "/upload" => page(shared, "Upload", "", UPLOAD_BODY),
        "/drag" => page(shared, "Drag", DRAG_HEAD, DRAG_BODY),
        "/csp" => page(shared, "CSP", "<link rel=\"stylesheet\" href=\"/csp.css\">", CSP_BODY).header(
            "Content-Security-Policy",
            "default-src 'self'; style-src 'self'; script-src 'none'; require-trusted-types-for 'script'",
        ),
        "/csp.css" => Response::new("200 OK", "text/css", "main{padding:8px} #styled{color:rgb(0, 128, 0)}"),
        "/network" => page(shared, "Network", "", NETWORK_BODY),
        "/network/frame" => page(shared, "Network frame", "", NETWORK_FRAME),
        "/worker.js" => Response::new("200 OK", "text/javascript", WORKER_JS),
        "/console" => page(shared, "Console", "", CONSOLE_BODY),
        "/console/frame" => page(shared, "Console frame", "", "<p>frame</p><script>setTimeout(function () { throw new Error('frame-error') }, 0); setTimeout(function () { parent.postMessage('frame-ready', '*') }, 0)</script>"),
        "/console/broken" => page(shared, "Broken", "", "<main><h1>Broken resources</h1><img alt=\"missing\" src=\"/missing.png\"></main>"),
        "/visual" => page(shared, "Visual", VISUAL_HEAD, VISUAL_BODY),
        "/data.json" => Response::json(r#"{"kind":"json","n":1}"#),
        "/plain.txt" => Response::new("200 OK", "text/plain; charset=utf-8", "plain text body\nsecond line\n"),
        "/image.png" => Response::new("200 OK", "image/png", fixture_png()),
        "/hangs" => page(shared, "Hangs", "", HANGS_BODY),
        "/auth" => Response::new("401 Unauthorized", "text/html; charset=utf-8", "<!doctype html><title>Unauthorized</title><h1>Unauthorized</h1>")
            .header("WWW-Authenticate", "Basic realm=\"conformance\""),
        "/popups" => page(shared, "Popups", "", POPUPS_BODY),
        "/popups/child" => page(shared, "Popup child", "", "<main><h1>Popup child</h1><button onclick=\"window.close()\">Close me</button></main>"),
        "/policy" => page(shared, "Policy", "", "<main><h1>Policy</h1><button id=\"b\" onclick=\"this.textContent='pressed'\">Press</button><a href=\"{CROSS}/\">Cross link</a></main>"),
        "/script" => page(shared, "Script", "", SCRIPT_BODY),
        "/background" => page(shared, "Background", "", BACKGROUND_BODY),
        "/api/login" => {
            let echoed = String::from_utf8_lossy(&request.body).to_string();
            let user = if echoed.contains("\"user\":\"ada\"") { "ada" } else { "unknown" };
            Response::json(&format!("{{\"ok\":true,\"user\":\"{user}\",\"session_token\":\"{SESSION_TOKEN}\"}}"))
                .header("Set-Cookie", &format!("sid={SESSION_COOKIE}; Path=/api; SameSite=Lax; HttpOnly"))
                .header("Set-Cookie", "theme=dark; Path=/api; SameSite=Lax")
                .header("X-Conformance-Route", "login")
        }
        "/api/profile" => {
            let authorized = request.header("authorization") == Some(&format!("Bearer {BEARER}"))
                && query == format!("access_token={ACCESS_TOKEN}");
            let cookie = request.header("cookie").unwrap_or("").contains(SESSION_COOKIE);
            Response::json(&format!("{{\"name\":\"Ada\",\"authorized\":{authorized},\"cookie\":{cookie}}}"))
        }
        "/api/hop" => Response::new("302 Found", "text/plain", "").header("Location", "/api/landed"),
        "/api/landed" => Response::json(r#"{"landed":true}"#),
        "/api/gzip" => Response::new("200 OK", "application/json", gzip_stored(GZIP_JSON.as_bytes())).header("Content-Encoding", "gzip"),
        "/api/form" => {
            let kind = request.header("content-type").unwrap_or("").split(';').next().unwrap_or("").to_string();
            Response::json(&format!("{{\"received\":{},\"kind\":\"{kind}\"}}", request.body.len()))
        }
        // Multipart bodies differ in length by browser (the boundary): count the parts instead.
        "/api/multipart" => {
            let parts = String::from_utf8_lossy(&request.body).matches("Content-Disposition: form-data").count();
            Response::json(&format!("{{\"parts\":{parts}}}"))
        }
        "/api/worker" | "/api/frame" => Response::json(&format!("{{\"from\":\"{}\"}}", path.trim_start_matches("/api/"))).header(
            "Access-Control-Allow-Origin",
            "*",
        ),
        "/api/slow" => {
            let mut gate = shared.gate("abort");
            let _ = tokio::time::timeout(Duration::from_secs(60), gate.wait_for(|open| *open)).await;
            Response::json(r#"{"slow":true}"#)
        }
        "/probe/waiting" => {
            let waiting = shared.log.lock().unwrap().iter().any(|r| r.path() == "/api/slow");
            Response::json(&format!("{{\"waiting\":{waiting}}}"))
        }
        _ if path.starts_with("/gate/") => {
            let name = path.trim_start_matches("/gate/").to_string();
            let mut gate = shared.gate(&name);
            let _ = tokio::time::timeout(Duration::from_secs(60), gate.wait_for(|open| *open)).await;
            page(shared, "Gate", "", &format!("<main><h1>Gate {name} opened</h1></main>"))
        }
        _ if path.starts_with("/redirect/") => {
            let n: u32 = path.trim_start_matches("/redirect/").parse().unwrap_or(0);
            let location = if n <= 1 { "/landed".to_string() } else { format!("/redirect/{}", n - 1) };
            Response::new("302 Found", "text/plain", "").header("Location", &location)
        }
        _ if path.starts_with("/status/") => {
            let status = match path.trim_start_matches("/status/") {
                "404" => "404 Not Found",
                "500" => "500 Internal Server Error",
                _ => "200 OK",
            };
            Response { status, ..page(shared, "Status", "", "<main><h1>Status page</h1></main>") }
        }
        _ if cross && path == "/" => page(shared, "Cross index", "", "<main><h1>Cross site</h1></main>"),
        _ => Response::new("404 Not Found", "text/html; charset=utf-8", "<!doctype html><title>Not found</title><h1>Not found</h1>"),
    };
    Some(response)
}

const APP_HEAD: &str = r##"<style>
html{scrollbar-width:none} body{margin:0;font:16px sans-serif}
header{position:sticky;top:0;height:40px;background:#ddd;z-index:5}
main{padding:8px;height:2300px;box-sizing:border-box;position:relative}
#bottom{position:absolute;top:2200px;left:8px;margin:0;height:20px;line-height:20px}
#wrap{position:relative;width:160px;height:30px}
#overlay{position:absolute;left:0;top:0;width:160px;height:30px;background:rgba(0,0,0,.2)}
#scroller{height:100px;width:300px;overflow:auto;scroll-behavior:smooth}
#tall{height:2000px}
#editor{border:1px solid #888;min-height:20px;width:300px}
</style>"##;

const APP_BODY: &str = r##"<header><a href="/spa">Go to SPA</a> <button id="hbtn" onclick="this.textContent='Header pressed'">Header button</button></header>
<main>
<h1>Conformance app</h1>
<form id="form">
<label>Name <input id="name" name="name"></label>
<label>Password <input id="password" type="password" name="password"></label>
<label>Notes <textarea id="notes" name="notes"></textarea></label>
<label>Color <select id="color" name="color"><option value="r">Red</option><option value="g">Green</option><option value="b">Blue</option></select></label>
<label><input type="checkbox" id="agree" name="agree"> Agree</label>
<fieldset><legend>Size</legend><label><input type="radio" name="size" value="s"> Small</label> <label><input type="radio" name="size" value="l"> Large</label></fieldset>
<button type="submit">Submit form</button>
</form>
<p id="submitted">Not submitted</p>
<label>Keys <input id="keys" name="keys"></label>
<button id="counter">Clicked 0</button>
<button id="dbl">Double clicked 0</button>
<button id="add">Add item</button>
<ul id="items"></ul>
<div id="host"></div>
<div id="editor" contenteditable="true" role="textbox" aria-label="Editor"></div>
<p id="intl">café 🚀 日本語</p>
<div id="wrap"><button id="covered">Covered button</button><div id="overlay"></div></div>
<button id="open-modal">Open modal</button>
<dialog id="modal"><p>Modal body</p><button id="close-modal">Close modal</button></dialog>
<div id="scroller" tabindex="0" role="region" aria-label="Scroller"><div id="tall">Top of scroller</div></div>
<p id="bottom">Bottom of page</p>
</main>
<script>
window.__events = [];
window.__wheels = [];
function record(text) { window.__events.push(text); }
document.addEventListener('wheel', function (e) { window.__wheels.push((e.target.id || e.target.tagName) + '|' + e.deltaY + '|' + e.deltaMode + '|' + e.isTrusted); }, { passive: true });
var keys = document.getElementById('keys');
['keydown', 'keyup'].forEach(function (type) {
  keys.addEventListener(type, function (e) { record(e.type + '|' + e.key + '|' + e.code + '|' + e.isTrusted + '|' + (e.shiftKey ? 'shift' : '')); });
});
keys.addEventListener('input', function (e) { record('input|' + e.inputType + '|' + keys.value + '|' + e.isTrusted); });
var clicks = 0, doubles = 0;
var counter = document.getElementById('counter');
counter.addEventListener('mousedown', function (e) { record('mousedown|detail=' + e.detail + '|buttons=' + e.buttons + '|' + e.isTrusted); });
counter.addEventListener('click', function (e) { clicks++; counter.textContent = 'Clicked ' + clicks; record('click|detail=' + e.detail + '|button=' + e.button + '|' + e.isTrusted); });
var dbl = document.getElementById('dbl');
dbl.addEventListener('click', function (e) { record('dblclick-target-click|detail=' + e.detail); });
dbl.addEventListener('dblclick', function (e) { doubles++; dbl.textContent = 'Double clicked ' + doubles; record('dblclick|detail=' + e.detail + '|' + e.isTrusted); });
var added = 0;
document.getElementById('add').addEventListener('click', function () {
  added++; var li = document.createElement('li'); li.textContent = 'Item ' + added; document.getElementById('items').appendChild(li);
});
var shadow = document.getElementById('host').attachShadow({ mode: 'open' });
shadow.innerHTML = '<button id="sbtn">Shadow button</button> <input aria-label="Shadow input">';
shadow.getElementById('sbtn').addEventListener('click', function () { this.textContent = 'Shadow clicked'; });
document.getElementById('covered').addEventListener('click', function () { this.textContent = 'Covered clicked'; });
document.getElementById('open-modal').addEventListener('click', function () { document.getElementById('modal').showModal(); });
document.getElementById('close-modal').addEventListener('click', function () { document.getElementById('modal').close(); });
document.getElementById('form').addEventListener('submit', function (e) {
  e.preventDefault();
  var data = new FormData(e.target);
  var out = [];
  data.forEach(function (value, key) { out.push(key + '=' + (key === 'password' ? 'len' + String(value).length : value)); });
  document.getElementById('submitted').textContent = 'Submitted ' + out.join('&');
});
</script>"##;

const SPA_BODY: &str = r##"<main>
<h1>Single page app</h1>
<nav aria-label="Routes">
<a href="#details">Jump to details</a>
<a href="/spa/next">Next page</a>
<a href="/redirect/3">Redirect chain</a>
<a href="/missing">Missing page</a>
<a href="/download">Download file</a>
</nav>
<button id="push" onclick="history.pushState({ n: 1 }, '', '/spa/pushed'); document.getElementById('route').textContent = 'Route pushed'">Push state</button>
<p id="route">Route home</p>
<div style="height:1200px"></div>
<h2 id="details">Details</h2>
<p>Details section.</p>
</main>"##;

const BF_A: &str = r##"<main><h1>Page A</h1><p id="restored">fresh</p><a href="/bf/b">To B</a></main>
<script>
window.addEventListener('pageshow', function (e) { if (e.persisted) document.getElementById('restored').textContent = 'restored'; });
</script>"##;

const FRAMES_BODY: &str = r##"<main>
<h1>Frames</h1>
<iframe id="same" title="Same origin" src="/frames/same" width="400" height="120"></iframe>
<iframe id="cross" title="Cross origin" src="{CROSS}/frames/cross" width="400" height="160"></iframe>
<iframe id="nested" title="Nested" src="/frames/n1" width="400" height="220"></iframe>
<iframe id="sandboxed" title="Sandboxed" sandbox="" srcdoc="<p>Sandboxed text</p><button>Sandboxed button</button>" width="300" height="80"></iframe>
<button id="remove" onclick="document.getElementById('same').remove(); this.textContent = 'Removed'">Remove same frame</button>
</main>"##;

const FRAME_SAME: &str = r##"<button id="sb" onclick="this.textContent = 'Same clicked'">Same button</button>"##;

const FRAME_CROSS: &str = r##"<button id="cb" onclick="this.textContent = 'Cross clicked'">Cross button</button>
<label>Cross input <input id="ci"></label>
<button id="calert" onclick="alert('from cross frame')">Cross alert</button>"##;

const DIALOGS_BODY: &str = r##"<main>
<h1>Dialogs</h1>
<button id="alert" onclick="alert('Plain alert'); document.getElementById('out').textContent = 'alert done'">Alert</button>
<button id="confirm" onclick="document.getElementById('out').textContent = 'confirm ' + confirm('Proceed?')">Confirm</button>
<button id="prompt" onclick="document.getElementById('out').textContent = 'prompt ' + prompt('Your name?', 'nobody')">Prompt</button>
<button id="sequence" onclick="alert('first'); setTimeout(function () { document.getElementById('out').textContent = 'sequence ' + confirm('second') }, 600)">Sequence</button>
<button id="guard" onclick="window.addEventListener('beforeunload', function (e) { e.preventDefault(); e.returnValue = '' }); this.textContent = 'Guarded'">Guard unload</button>
<p id="out">idle</p>
<iframe title="Dialog frame" src="{CROSS}/dialogs/frame" width="300" height="80"></iframe>
</main>"##;

const UPLOAD_BODY: &str = r##"<main>
<h1>Upload</h1>
<label>Single file <input type="file" id="single"></label>
<label for="hidden" id="picker">Pick files</label>
<input type="file" id="hidden" multiple style="display:none">
<pre id="out">none</pre>
</main>
<script>
function show(input) {
  var files = Array.prototype.slice.call(input.files);
  Promise.all(files.map(function (f) { return f.text().then(function (t) { return f.name + ':' + f.size + ':' + t.trim(); }); }))
    .then(function (parts) { document.getElementById('out').textContent = input.id + ' ' + parts.join(','); });
}
document.getElementById('single').addEventListener('change', function () { show(this); });
document.getElementById('hidden').addEventListener('change', function () { show(this); });
</script>"##;

const DRAG_HEAD: &str = r##"<style>
body{margin:0;font:16px sans-serif} main > *{position:absolute;left:20px;margin:0}
h1{top:10px} #value{top:130px} #dnd{top:320px}
#track{top:100px;width:400px;height:20px;background:#ccc;touch-action:none}
#handle{position:absolute;left:0;top:0;width:20px;height:20px;background:#333}
#src{top:160px;width:120px;height:40px;background:#9cf}
#drop{top:220px;width:200px;height:80px;background:#fc9}
</style>"##;

const DRAG_BODY: &str = r##"<main>
<h1>Drag</h1>
<div id="track" role="slider" aria-label="Slider" aria-valuenow="0"><div id="handle"></div></div>
<p id="value">value 0</p>
<div id="src" draggable="true">Drag source</div>
<div id="drop" role="region" aria-label="Drop zone">Drop zone</div>
<p id="dnd">no drop</p>
</main>
<script>
window.__drag = [];
var track = document.getElementById('track'), handle = document.getElementById('handle'), dragging = false;
function setValue(clientX) {
  var rect = track.getBoundingClientRect();
  var v = Math.max(0, Math.min(100, Math.round((clientX - rect.left) / rect.width * 100)));
  handle.style.left = (v * 3.8) + 'px';
  track.setAttribute('aria-valuenow', String(v));
  document.getElementById('value').textContent = 'value ' + v;
}
track.addEventListener('pointerdown', function (e) { dragging = true; track.setPointerCapture(e.pointerId); setValue(e.clientX); });
track.addEventListener('pointermove', function (e) { if (dragging) setValue(e.clientX); });
track.addEventListener('pointerup', function (e) { dragging = false; setValue(e.clientX); });
var src = document.getElementById('src'), drop = document.getElementById('drop');
function note(e) { if (window.__drag[window.__drag.length - 1] !== e.type) window.__drag.push(e.type); }
src.addEventListener('dragstart', function (e) { note(e); e.dataTransfer.setData('text/plain', 'payload-42'); });
src.addEventListener('dragend', note);
drop.addEventListener('dragenter', function (e) { note(e); e.preventDefault(); });
drop.addEventListener('dragover', function (e) { note(e); e.preventDefault(); });
drop.addEventListener('drop', function (e) { note(e); e.preventDefault(); document.getElementById('dnd').textContent = 'dropped ' + e.dataTransfer.getData('text/plain'); });
</script>"##;

const CSP_BODY: &str = r##"<main>
<h1>Strict CSP</h1>
<p id="styled">Styled by the stylesheet</p>
<button id="inert" onclick="this.textContent = 'ran'">Inline handler</button>
<a href="/app">To app</a>
</main>
<script>document.title = 'script ran';</script>"##;

const NETWORK_BODY: &str = r##"<main>
<h1>Network</h1>
<button id="run">Run requests</button>
<p id="status">idle</p>
</main>
<script>
function step(text) { document.getElementById('status').textContent = text; }
function json(response) { return response.json(); }
function frameFetch() {
  return new Promise(function (resolve) {
    window.addEventListener('message', function on(e) { if (e.data === 'frame-fetched') { window.removeEventListener('message', on); resolve(); } });
    var frame = document.createElement('iframe');
    frame.title = 'Network frame';
    frame.src = '{CROSS}/network/frame';
    document.body.appendChild(frame);
  });
}
function workerFetch() {
  return new Promise(function (resolve) {
    // Kept running until the page goes: a terminated worker's responses can vanish before the capture reads them.
    window.__worker = new Worker('/worker.js');
    window.__worker.onmessage = function () { resolve(); };
  });
}
async function waitForSlow() {
  for (;;) {
    var seen = await fetch('/probe/waiting').then(json);
    if (seen.waiting) return;
  }
}
document.getElementById('run').addEventListener('click', async function () {
  step('running');
  await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user: 'ada', password: '{PASSWORD}' }) }).then(json);
  await fetch('/api/profile?access_token={ACCESS_TOKEN}', { headers: { 'Authorization': 'Bearer {BEARER}', 'X-Conformance-Step': 'profile' } }).then(json);
  await fetch('/api/hop').then(json);
  await fetch('/api/gzip').then(json);
  await fetch('/api/form', { method: 'POST', body: new URLSearchParams({ a: '1', b: 'two words' }) }).then(json);
  var form = new FormData(); form.append('field', 'value'); form.append('note', 'multipart');
  await fetch('/api/multipart', { method: 'POST', body: form }).then(json);
  var controller = new AbortController();
  var slow = fetch('/api/slow', { signal: controller.signal }).then(function () { return 'finished'; }, function () { return 'aborted'; });
  await waitForSlow();
  controller.abort();
  var outcome = await slow;
  await workerFetch();
  await frameFetch();
  step('done ' + outcome);
});
</script>"##;

const NETWORK_FRAME: &str = r##"<p>Network frame</p>
<script>
fetch('/api/frame').then(function (r) { return r.json(); }).then(function () { parent.postMessage('frame-fetched', '*'); });
</script>"##;

const WORKER_JS: &str = "fetch('/api/worker').then(function (r) { return r.json(); }).then(function (v) { postMessage(v); });\n";

const CONSOLE_BODY: &str = r##"<main>
<h1>Console</h1>
<button id="run">Log things</button>
<p id="status">idle</p>
</main>
<script>
function later(fn) { setTimeout(fn, 0); }
document.getElementById('run').addEventListener('click', function () {
  later(function () {
    console.log('plain', 42, true, null, undefined);
    later(function () {
      console.warn('warned', { a: 1, b: [1, 2] });
      later(function () {
        console.error('errored', new Error('boom'));
        later(function () {
          console.info('info line');
          console.debug('debug line');
          later(function () {
            console.assert(false, 'asserted');
            later(function () {
              Promise.reject(new Error('unhandled-rejection'));
              later(function () { throw new TypeError('thrown-error'); });
              later(function () {
                window.addEventListener('message', function on(e) {
                  if (e.data !== 'frame-ready') return;
                  window.removeEventListener('message', on);
                  later(function () { later(function () { document.getElementById('status').textContent = 'done'; }); });
                });
                var frame = document.createElement('iframe');
                frame.title = 'Console frame';
                frame.src = '{CROSS}/console/frame';
                document.body.appendChild(frame);
              });
            });
          });
        });
      });
    });
  });
});
</script>"##;

const VISUAL_HEAD: &str = r##"<style>
html{scrollbar-width:none;background:#fff} body{margin:0}
div{position:absolute}
#red{left:0;top:0;width:200px;height:100px;background:#ff0000}
#green{left:200px;top:0;width:200px;height:100px;background:#00ff00}
#blue{left:400px;top:0;width:200px;height:100px;background:#0000ff}
#target{left:0;top:200px;width:200px;height:50px;background:#ff0000}
#target.flipped{background:#0000ff}
#low{left:0;top:1500px;width:1000px;height:100px;background:#000000}
#recolor{position:absolute;left:600px;top:200px;width:100px;height:50px;border:0;padding:0;margin:0;background:#808080;appearance:none;outline:none}
</style>"##;

const VISUAL_BODY: &str = r##"<div id="red"></div><div id="green"></div><div id="blue"></div><div id="target"></div><div id="low"></div>
<button id="recolor" aria-label="Recolor"></button>
<script>
document.getElementById('recolor').addEventListener('click', function () { document.getElementById('target').classList.toggle('flipped'); });
</script>"##;

const HANGS_BODY: &str = r##"<main>
<h1>Hangs</h1>
<button id="print" onclick="window.print(); this.textContent = 'printed'">Print</button>
<p id="alive">alive</p>
</main>"##;

const POPUPS_BODY: &str = r##"<main>
<h1>Popups</h1>
<button id="open" onclick="window.open('/popups/child', 'child')">Open popup</button>
<a href="/popups/child" target="_blank">Blank target link</a>
<button id="noopener" onclick="window.open('/popups/child', '_blank', 'noopener')">Open without opener</button>
</main>"##;

const SCRIPT_BODY: &str = r##"<main>
<h1>Script</h1>
<label>Query <input id="q"></label>
<button id="go" onclick="document.getElementById('result').textContent = 'Searched ' + document.getElementById('q').value">Search</button>
<p id="result">nothing yet</p>
</main>"##;

const BACKGROUND_BODY: &str = r##"<main>
<h1>Background</h1>
<p id="vis">unknown</p>
<button id="b" onclick="this.textContent = 'pressed ' + document.visibilityState">Press</button>
</main>
<script>document.getElementById('vis').textContent = 'seen';</script>"##;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gzip_is_well_formed() {
        let bytes = gzip_stored(b"hello");
        assert_eq!(&bytes[..3], &[0x1f, 0x8b, 8]);
        assert_eq!(crc32(b"123456789"), 0xcbf4_3926);
        assert_eq!(u32::from_le_bytes(bytes[bytes.len() - 4..].try_into().unwrap()), 5);
    }
}
