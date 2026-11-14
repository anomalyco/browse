//! The relay process: one HTTP listener for the extension's WebSocket (/extension), the open version probe
//! (/version) and the token-protected tool API (/tools, /tools/call), plus its housekeeping.

use std::collections::HashMap;
use std::convert::Infallible;
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use anyhow::Context;
use browse_core::{Content, Tool, ToolCallRequest, ToolContext, ToolOutput};
use bytes::Bytes;
use http_body_util::{BodyExt, Full, Limited};
use hyper::body::Incoming;
use hyper::header::{HeaderValue, UPGRADE};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::handshake::derive_accept_key;
use tokio_tungstenite::tungstenite::protocol::{Role, WebSocketConfig};

use crate::browser::RelayBrowser;
use crate::paths::Paths;
use crate::port::{self, RelayState};
use crate::protocol::{EXTENSION_PROTOCOL_VERSION, MIN_EXTENSION_PROTOCOL_VERSION, PAIRING_SCHEME};
use crate::relay::{AutoUpdateStatus, InFlight, Relay, RelayConfig};
use crate::rlog;
use crate::util::secrets_equal;

const MAX_BODY: usize = 16 * 1024 * 1024;
const MAX_MESSAGE: usize = 256 * 1024 * 1024;

#[derive(Clone)]
pub struct ServeOptions {
    /// Listen here, with no fallback. None: OPENCODE_BROWSER_PORT, else 19988 falling back to 19990–19997.
    pub port: Option<u16>,
    pub paths: Paths,
    pub version: String,
    pub build_id: String,
    /// Stop after this long with no tool calls, no live clients and nothing waiting on the user.
    /// OPENCODE_BROWSER_IDLE_SHUTDOWN_MS (0: never), else `MANAGED_IDLE_SHUTDOWN` for a managed relay.
    pub idle_shutdown: Option<Duration>,
    /// Started on demand by a client (OPENCODE_BROWSER_MANAGED_RELAY=1), as `/version` reports.
    pub managed: bool,
    /// Replaces the `autoUpdate` status the extension's pages show (the binary's update state).
    pub auto_update: Option<AutoUpdateStatus>,
    /// Test-only: the ports an unpinned relay tries.
    pub port_candidates: Option<Vec<u16>>,
}

/// How long a relay started on demand waits with nothing to do before it exits; the next call starts it again.
pub const MANAGED_IDLE_SHUTDOWN: Duration = Duration::from_secs(30 * 60);

impl Default for ServeOptions {
    fn default() -> Self {
        let managed = std::env::var("OPENCODE_BROWSER_MANAGED_RELAY").as_deref() == Ok("1");
        let idle_shutdown = match std::env::var("OPENCODE_BROWSER_IDLE_SHUTDOWN_MS").ok().and_then(|v| v.trim().parse::<u64>().ok()) {
            Some(ms) => (ms > 0).then(|| Duration::from_millis(ms)),
            None => managed.then_some(MANAGED_IDLE_SHUTDOWN),
        };
        Self {
            port: None,
            paths: Paths::from_env(),
            version: env!("CARGO_PKG_VERSION").to_string(),
            build_id: String::new(),
            idle_shutdown,
            managed,
            auto_update: None,
            port_candidates: None,
        }
    }
}

/// A started relay.
pub struct RelayHandle {
    pub relay: Arc<Relay>,
    pub addr: SocketAddr,
    task: tokio::task::JoinHandle<()>,
}

impl RelayHandle {
    pub fn port(&self) -> u16 {
        self.addr.port()
    }

    pub fn browser(&self) -> RelayBrowser {
        RelayBrowser(self.relay.clone())
    }

    pub fn token(&self) -> &str {
        &self.relay.token
    }

    pub fn stop(&self) {
        self.relay.stop();
    }

    /// Nothing would be interrupted by a restart (an update): no call running, no handoff waiting, and no agent
    /// activity for `quiet`.
    /// See `Relay::set_update_notice`: `(summary, command)`, or None once browse is current.
    pub fn update_notice(&self, notice: Option<(String, String)>) {
        self.relay.set_update_notice(notice);
    }

    pub fn idle(&self, quiet: Duration) -> bool {
        let st = self.relay.st();
        let clients = st.sessions.values().any(|s| s.clients.iter().any(|pid| crate::util::process_alive(*pid)));
        !clients && !st.sessions.values().any(|s| s.busy()) && st.handoffs.is_empty() && st.last_activity.elapsed() >= quiet
    }

    /// Runs until the relay stops (`stop`, POST /shutdown, idle shutdown).
    pub async fn wait(self) {
        let _ = self.task.await;
    }
}

/// Runs the relay until it stops (SIGINT, SIGTERM, POST /shutdown, idle shutdown). `tools` are every crate's tools;
/// the relay's own come from `browse_relay::tools()`.
pub async fn serve(options: ServeOptions, tools: Vec<Arc<dyn Tool>>) -> anyhow::Result<()> {
    serve_until(options, tools, async {
        #[cfg(unix)]
        {
            let Ok(mut term) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) else {
                return std::future::pending().await;
            };
            tokio::select! {
                _ = tokio::signal::ctrl_c() => {}
                _ = term.recv() => {}
            }
        }
        #[cfg(not(unix))]
        let _ = tokio::signal::ctrl_c().await;
    })
    .await
}

/// Runs the relay until `stop` resolves (or it stops by itself), then closes it cleanly.
pub async fn serve_until(options: ServeOptions, tools: Vec<Arc<dyn Tool>>, stop: impl std::future::Future<Output = ()> + Send + 'static) -> anyhow::Result<()> {
    let handle = start(options, tools).await?;
    let relay = handle.relay.clone();
    tokio::spawn(async move {
        stop.await;
        relay.stop();
    });
    handle.wait().await;
    Ok(())
}

fn relay_host(paths: &Paths) -> IpAddr {
    let configured = crate::paths::read_json::<Value>(&paths.relay_config()).and_then(|v| v["hostname"].as_str().map(str::to_string));
    match configured.as_deref().map(str::trim) {
        Some("0.0.0.0") => IpAddr::from([0, 0, 0, 0]),
        _ => IpAddr::from([127, 0, 0, 1]),
    }
}

/// Binds the relay and starts serving in the background.
pub async fn start(options: ServeOptions, tools: Vec<Arc<dyn Tool>>) -> anyhow::Result<RelayHandle> {
    let paths = options.paths.clone();
    crate::util::tune_allocator();
    crate::log::set_path(paths.relay_log());
    crate::secrets::remove_stored_secrets(&paths);
    let configured = options.port.unwrap_or_else(port::configured_port);
    let pinned = options.port.is_some() || port::pinned();
    let host = relay_host(&paths);
    let chosen = port::choose_port(&paths, configured, pinned, host, options.port_candidates.clone()).await?;
    let listener = TcpListener::bind((host, chosen)).await.with_context(|| format!("listen on {host}:{chosen}"))?;
    let addr = listener.local_addr()?;
    let relay = Relay::new(RelayConfig {
        paths: paths.clone(),
        configured_port: configured,
        port: addr.port(),
        host: "127.0.0.1".into(),
        version: options.version.clone(),
        build_id: options.build_id.clone(),
        auto_update: options.auto_update.clone(),
        idle_shutdown: options.idle_shutdown,
        managed: options.managed,
    })?;
    *relay.tools.write().unwrap_or_else(|poisoned| poisoned.into_inner()) = tools;
    let state = RelayState { port: addr.port(), configured_port: configured, pid: std::process::id(), instance_id: relay.instance_id.clone(), started_at: relay.started_at.clone() };
    if let Err(error) = port::write_relay_state(&paths, &state) {
        rlog!("relay.state.write_failed", error = error.to_string());
        if addr.port() != configured {
            anyhow::bail!("Write the relay port file: {error}");
        }
    }
    let _ = port::write_last_port(&paths, configured, addr.port());
    for entry in crate::sessions::load_catalog(&paths.session_catalog(configured)) {
        let session = crate::sessions::Session::from_persisted(entry);
        relay.st().sessions.insert(session.id.clone(), session);
    }
    relay.ready.store(true, Ordering::SeqCst);
    rlog!(
        "relay.ready",
        url = format!("http://127.0.0.1:{}", addr.port()),
        version = relay.version.clone(),
        pid = std::process::id(),
        managed = relay.managed,
        idleShutdownMs = relay.idle_shutdown.map(|d| d.as_millis() as u64),
    );
    crate::watchdog::spawn(&relay);
    let task = tokio::spawn(run(relay.clone(), listener));
    Ok(RelayHandle { relay, addr, task })
}

async fn run(relay: Arc<Relay>, listener: TcpListener) {
    let heartbeat = tokio::spawn(crate::watchdog::heartbeat(relay.clone()));
    let persister = tokio::spawn(persist_loop(relay.clone()));
    let housekeeping = tokio::spawn(housekeeping(relay.clone()));
    loop {
        let stopped = relay.stopped.notified();
        tokio::pin!(stopped);
        stopped.as_mut().enable();
        if relay.is_stopping() {
            break;
        }
        tokio::select! {
            accepted = listener.accept() => {
                let Ok((stream, peer)) = accepted else { continue };
                let relay = relay.clone();
                tokio::spawn(async move {
                    let service = service_fn(move |request| {
                        let relay = relay.clone();
                        async move { Ok::<_, Infallible>(route(relay, peer, request).await) }
                    });
                    let _ = http1::Builder::new().serve_connection(TokioIo::new(stream), service).with_upgrades().await;
                });
            }
            _ = &mut stopped => break,
        }
    }
    rlog!("relay.shutdown.start", sessions = relay.st().sessions.len());
    drop(listener);
    let links: Vec<_> = relay.st().links.clone();
    for link in &links {
        link.reject_all("Relay closed");
        link.close(1001, "Relay closed");
    }
    tokio::time::sleep(Duration::from_millis(100)).await;
    persister.abort();
    housekeeping.abort();
    relay.persist_now();
    port::remove_relay_state(&relay.paths, relay.configured_port, &relay.instance_id);
    rlog!("relay.shutdown.closed", pid = std::process::id());
    heartbeat.abort();
    relay.finished.store(true, Ordering::SeqCst);
}

async fn persist_loop(relay: Arc<Relay>) {
    loop {
        relay.persist.notified().await;
        tokio::time::sleep(Duration::from_millis(50)).await;
        let relay = relay.clone();
        let _ = tokio::task::spawn_blocking(move || relay.persist_now()).await;
    }
}

fn json_response(status: StatusCode, value: &Value) -> Response<Full<Bytes>> {
    let mut response = Response::new(Full::new(Bytes::from(value.to_string())));
    *response.status_mut() = status;
    response.headers_mut().insert("content-type", HeaderValue::from_static("application/json"));
    response.headers_mut().insert("cache-control", HeaderValue::from_static("no-store"));
    response
}

fn header<'a>(request: &'a Request<Incoming>, name: &str) -> Option<&'a str> {
    request.headers().get(name).and_then(|v| v.to_str().ok())
}

async fn route(relay: Arc<Relay>, peer: SocketAddr, request: Request<Incoming>) -> Response<Full<Bytes>> {
    let local = crate::origins::is_local_peer(&peer);
    let path = request.uri().path().trim_end_matches('/').to_string();
    let path = if path.is_empty() { "/".to_string() } else { path };
    if !local && path != "/extension" {
        return json_response(StatusCode::NOT_FOUND, &json!({}));
    }
    if !relay.ready.load(Ordering::SeqCst) {
        return json_response(StatusCode::SERVICE_UNAVAILABLE, &json!({ "error": "browse relay is starting", "code": "relay-starting" }));
    }
    if local
        && let Err(error) = crate::origins::validate_host_header(header(&request, "host"), &relay.host, relay.port) {
            return json_response(StatusCode::FORBIDDEN, &json!({ "error": error }));
        }
    if path == "/extension" {
        return upgrade_extension(relay, peer, request);
    }
    let probing = header(&request, "x-browse-install") == Some("probe") && relay.st().install_waiting_until.is_some_and(|until| Instant::now() < until);
    let compatibility = json!({ "extensionProtocol": { "min": MIN_EXTENSION_PROTOCOL_VERSION, "version": EXTENSION_PROTOCOL_VERSION }, "pairing": PAIRING_SCHEME });
    if let Err(error) = crate::origins::validate_fetch_site(header(&request, "sec-fetch-site")) {
        let mut body = json!({ "error": error });
        if request.method() == hyper::Method::GET && path == "/version" {
            body["extensionProtocol"] = compatibility["extensionProtocol"].clone();
            body["pairing"] = compatibility["pairing"].clone();
            if probing {
                body["installWaiting"] = true.into();
            }
        }
        return json_response(StatusCode::FORBIDDEN, &body);
    }
    if path == "/" || path == "/version" {
        let mut body = json!({
            "version": relay.version,
            "buildId": relay.build_id,
            "instanceId": relay.instance_id,
            "startedAt": relay.started_at,
            "pid": std::process::id(),
            "managed": relay.managed,
            "shutdownProtocol": 2,
            "runtime": "rust",
        });
        body["extensionProtocol"] = compatibility["extensionProtocol"].clone();
        body["pairing"] = compatibility["pairing"].clone();
        if probing {
            body["installWaiting"] = true.into();
        }
        return json_response(StatusCode::OK, &body);
    }
    let authorized = header(&request, "authorization").and_then(|v| v.strip_prefix("Bearer ").or_else(|| v.strip_prefix("bearer "))).map(str::trim);
    if !secrets_equal(&relay.token, authorized) {
        return json_response(StatusCode::UNAUTHORIZED, &json!({ "error": "Missing or invalid browse relay token", "code": "unauthorized" }));
    }
    let method = request.method().clone();
    let waiting = header(&request, "x-browse-install") == Some("waiting");
    let client_pid = header(&request, "opencode-browser-client-pid").and_then(|v| v.parse::<u32>().ok()).filter(|p| *p > 0);
    let body = if method == hyper::Method::POST {
        match Limited::new(request.into_body(), MAX_BODY).collect().await {
            Ok(collected) => collected.to_bytes(),
            Err(_) => return json_response(StatusCode::PAYLOAD_TOO_LARGE, &json!({ "error": format!("Request body exceeds {MAX_BODY} bytes"), "code": "invalid-request" })),
        }
    } else {
        Bytes::new()
    };
    let parsed = || -> Result<Value, Box<Response<Full<Bytes>>>> {
        if body.is_empty() {
            return Ok(json!({}));
        }
        serde_json::from_slice(&body).map_err(|_| Box::new(json_response(StatusCode::BAD_REQUEST, &json!({ "error": "Invalid JSON body", "code": "invalid-request" }))))
    };
    match (method.as_str(), path.as_str()) {
        ("GET", "/tools") => {
            let specs: Vec<_> = relay.tools.read().unwrap_or_else(|poisoned| poisoned.into_inner()).iter().map(|t| t.spec()).collect();
            json_response(StatusCode::OK, &serde_json::to_value(specs).unwrap_or_default())
        }
        ("POST", "/tools/call") => {
            let request: ToolCallRequest = match parsed().map(serde_json::from_value) {
                Ok(Ok(request)) => request,
                Ok(Err(error)) => return json_response(StatusCode::BAD_REQUEST, &json!({ "error": format!("Invalid tool call: {error}"), "code": "invalid-request" })),
                Err(response) => return *response,
            };
            match call_tool(&relay, request, client_pid).await {
                Ok(output) => json_response(StatusCode::OK, &serde_json::to_value(output).unwrap_or_default()),
                Err((status, message)) => json_response(status, &json!({ "error": message })),
            }
        }
        ("GET", "/extension/status") => {
            if waiting {
                relay.st().install_waiting_until = Some(Instant::now() + Duration::from_secs(5));
            }
            let mut status = relay.extension_status();
            status["sessions"] = Value::Array(relay.session_summaries());
            status["targets"] = Value::Array(relay.tab_summaries());
            json_response(StatusCode::OK, &status)
        }
        ("POST", "/extension/revoke") => {
            let Ok(body) = parsed() else { return json_response(StatusCode::BAD_REQUEST, &json!({ "error": "Invalid JSON body" })) };
            let Some(key) = body["key"].as_str() else { return json_response(StatusCode::BAD_REQUEST, &json!({ "error": "key is required", "code": "invalid-request" })) };
            let links: Vec<_> = relay.st().links.iter().filter(|l| l.key == key).cloned().collect();
            for link in &links {
                link.close(4006, "Pairing revoked: run `pair` and enter the code to pair again");
            }
            json_response(StatusCode::OK, &json!({ "dropped": !links.is_empty() }))
        }
        ("POST", "/extension/reload") => {
            let links: Vec<_> = relay.st().links.iter().filter(|l| l.connected()).cloned().collect();
            for link in &links {
                link.send_raw(&json!({ "id": 0, "method": "runtime.reload" }));
            }
            json_response(StatusCode::OK, &json!({ "reloaded": links.len() }))
        }
        ("POST", "/shutdown") => {
            relay.stop();
            json_response(StatusCode::OK, &json!({ "stopping": true }))
        }
        _ => json_response(StatusCode::NOT_FOUND, &json!({ "error": "Not found", "code": "not-found" })),
    }
}

fn upgrade_extension(relay: Arc<Relay>, peer: SocketAddr, mut request: Request<Incoming>) -> Response<Full<Bytes>> {
    let origin = header(&request, "origin").map(str::to_string);
    if let Err(error) = crate::origins::validate_extension_origin(origin.as_deref(), &relay.origins) {
        rlog!("extension.rejected", reason = error, origin = origin);
        return json_response(StatusCode::FORBIDDEN, &json!({ "error": error }));
    }
    let websocket = header(&request, "upgrade").is_some_and(|v| v.eq_ignore_ascii_case("websocket"));
    let Some(key) = header(&request, "sec-websocket-key").filter(|_| websocket).map(|k| derive_accept_key(k.as_bytes())) else {
        return json_response(StatusCode::BAD_REQUEST, &json!({ "error": "Expected a WebSocket upgrade" }));
    };
    let upgrade = hyper::upgrade::on(&mut request);
    tokio::spawn(async move {
        let Ok(upgraded) = upgrade.await else { return };
        let config = WebSocketConfig::default().max_message_size(Some(MAX_MESSAGE)).max_frame_size(Some(MAX_MESSAGE));
        let ws = WebSocketStream::from_raw_socket(TokioIo::new(upgraded), Role::Server, Some(config)).await;
        crate::handshake::run(relay, ws, peer, origin).await;
    });
    let mut response = Response::new(Full::new(Bytes::new()));
    *response.status_mut() = StatusCode::SWITCHING_PROTOCOLS;
    let headers = response.headers_mut();
    headers.insert(UPGRADE, HeaderValue::from_static("websocket"));
    headers.insert("connection", HeaderValue::from_static("Upgrade"));
    headers.insert("sec-websocket-accept", HeaderValue::from_str(&key).expect("base64 is a valid header"));
    response
}

tokio::task_local! {
    /// The caller of the running tool call (`ToolCallRequest::session`), for the relay's own tools.
    pub static CALLER: String;
    /// The relay running the call, for the relay's own tools.
    pub static RELAY: Arc<Relay>;
    /// The running call's id, so a call that resets its own session isn't stopped by it.
    pub static CALL: u64;
    /// The running call's tool name.
    pub static TOOL: String;
    /// The process that made the running call (OpenCode-Browser-Client-Pid).
    pub static CLIENT: Option<u32>;
}

/// Runs one tool call for `request.session`'s current browse session (or `arguments.session` when it names one).
pub async fn call_tool(relay: &Arc<Relay>, request: ToolCallRequest, client_pid: Option<u32>) -> Result<ToolOutput, (StatusCode, String)> {
    let tool = relay.tools.read().unwrap_or_else(|poisoned| poisoned.into_inner()).iter().find(|t| t.spec().name == request.name).cloned();
    let Some(tool) = tool else { return Err((StatusCode::NOT_FOUND, format!("Unknown tool: {}", request.name))) };
    relay.note_activity();
    let caller = request.session.clone();
    let explicit = (request.name != "session").then(|| request.arguments.get("session").and_then(Value::as_str).map(str::to_string)).flatten();
    let session = match explicit {
        Some(id) if relay.st().sessions.contains_key(&id) => id,
        Some(id) => return Ok(ToolOutput::error(format!("Session not found: {id}. Create it with the session tool (action new) first, or leave session out to use your current one."))),
        None => relay.st().callers.get(&caller).cloned().unwrap_or_else(|| caller.clone()),
    };
    if let Err(error) = relay.ensure_session(&session) {
        return Ok(ToolOutput::error(error.to_string()));
    }
    let state = {
        let mut st = relay.st();
        let entry = st.sessions.get_mut(&session).expect("ensured");
        if let Some(pid) = client_pid {
            entry.client_pid = Some(pid);
            entry.clients.insert(pid);
        }
        entry.state.clone()
    };
    let context = ToolContext {
        session: session.clone(),
        browser: Arc::new(RelayBrowser(relay.clone())),
        state,
        file_roots: relay.file_roots.clone(),
    };
    let id = relay.next_call.fetch_add(1, Ordering::SeqCst);
    let arguments = if request.arguments.is_null() { json!({}) } else { request.arguments };
    let name = request.name.clone();
    let started = Instant::now();
    relay.inflight.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).insert(id, InFlight { tool: name.clone(), session: session.clone(), since: started });
    let task = tokio::spawn(RELAY.scope(
        relay.clone(),
        CALL.scope(id, TOOL.scope(name.clone(), CLIENT.scope(client_pid, CALLER.scope(caller, async move { tool.call(context, arguments).await })))),
    ));
    relay.call_started(&session, id, task.abort_handle(), client_pid);
    let outcome = task.await;
    relay.call_finished(&session, id);
    relay.inflight.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).remove(&id);
    let ms = started.elapsed().as_millis() as u64;
    let mut output = match outcome {
        Ok(Ok(output)) => output,
        Ok(Err(error)) => ToolOutput::error(format!("{error:#}")),
        Err(join) if join.is_cancelled() => {
            let message = relay.st().sessions.get_mut(&session).and_then(|s| s.stopped.remove(&id));
            rlog!("tool.stopped", tool = name.clone(), session = session.clone(), ms = ms, reason = message.clone());
            ToolOutput::error(message.unwrap_or_else(|| "The call was stopped.".into()))
        }
        Err(join) => {
            rlog!("tool.panicked", tool = name.clone(), session = session.clone(), ms = ms, error = join.to_string());
            ToolOutput::error(format!("The tool failed: {join}"))
        }
    };
    if output.is_error {
        let text: String = output.content.iter().filter_map(|c| if let Content::Text { text } = c { Some(text.as_str()) } else { None }).collect::<Vec<_>>().join(" ");
        // A handoff the user didn't finish (timeout, closed, cancelled) is an outcome, not a failure.
        let outcome = matches!(name.as_str(), "handoff" | "demonstrate")
            .then(|| serde_json::from_str::<Value>(&text).ok())
            .flatten()
            .and_then(|v| v["outcome"].as_str().map(str::to_string));
        match outcome {
            Some(outcome) => rlog!("tool.outcome", tool = name.clone(), session = session.clone(), ms = ms, outcome = outcome),
            None => rlog!("tool.error", tool = name.clone(), session = session.clone(), ms = ms, error = text.chars().take(500).collect::<String>()),
        }
    } else if ms >= 20_000 {
        rlog!("tool.slow", tool = name.clone(), session = session.clone(), ms = ms);
    }
    let size: usize = output
        .content
        .iter()
        .map(|c| match c {
            Content::Text { text } => text.len(),
            Content::Image { data, .. } => data.len(),
        })
        .sum();
    if size >= LARGE_OUTPUT {
        release_memory_soon();
    }
    let warnings = relay.st().sessions.get_mut(&session).map(|s| std::mem::take(&mut s.warnings)).unwrap_or_default();
    for warning in warnings {
        rlog!("tool.warning", tool = name.clone(), session = session.clone(), warning = warning.chars().take(500).collect::<String>());
        output.content.push(Content::Text { text: format!("Warning: {warning}") });
    }
    Ok(output)
}

/// An output this big (a large eval result, a full-page screenshot) leaves freed memory worth handing back.
const LARGE_OUTPUT: usize = 1024 * 1024;

/// Returns freed memory to the OS shortly, once at a time.
fn release_memory_soon() {
    static RELEASING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if RELEASING.swap(true, Ordering::SeqCst) {
        return;
    }
    tokio::spawn(async {
        // After the response is written and its buffers are gone.
        tokio::time::sleep(Duration::from_millis(500)).await;
        let _ = tokio::task::spawn_blocking(crate::util::release_memory).await;
        RELEASING.store(false, Ordering::SeqCst);
    });
}

/// Calls and handoffs whose own process exited are stopped (the session's other callers carry on); a session is
/// collected once every process that used it is gone.
pub(crate) async fn sweep_clients(relay: &Arc<Relay>, now: Instant, client_gone_grace: Duration) {
    let (gone, abandoned) = {
        let mut st = relay.st();
        let crate::relay::State { sessions, handoffs, client_gone_since, .. } = &mut *st;
        let mut alive = HashMap::new();
        let mut alive = |pid: u32| *alive.entry(pid).or_insert_with(|| crate::util::process_alive(pid));
        let mut gone = Vec::new();
        let mut abandoned: Vec<(String, u32)> = Vec::new();
        for session in sessions.values_mut() {
            // A call or a handoff whose own process exited has nobody waiting for it; the session's other
            // callers carry on.
            let mut dead: Vec<u32> = session.calls.values().filter_map(|c| c.pid).filter(|pid| !alive(*pid)).collect();
            dead.extend(handoffs.get(&session.id).and_then(|h| h.pid).filter(|pid| !alive(*pid)));
            dead.sort();
            dead.dedup();
            abandoned.extend(dead.into_iter().map(|pid| (session.id.clone(), pid)));
            session.clients.retain(|pid| alive(*pid));
            let used = session.client_pid.is_some();
            if !used || !session.clients.is_empty() {
                client_gone_since.remove(&session.id);
                continue;
            }
            let since = *client_gone_since.entry(session.id.clone()).or_insert(now);
            let busy = session.busy() || handoffs.contains_key(&session.id);
            if now - since >= client_gone_grace && crate::sessions::mcp_named(&session.id) && !busy {
                gone.push(session.id.clone());
            }
        }
        (gone, abandoned)
    };
    for (id, pid) in abandoned {
        let message = format!("The client that called this (process {pid}) exited, so it was stopped.");
        let stopped = relay.stop_client_calls(&id, pid, &message);
        rlog!("session.client_gone", session = id.clone(), pid = pid, calls = stopped);
        relay.finish_client_handoff(&id, pid);
    }
    for id in gone {
        rlog!("session.collected", session = id.clone(), reason = "client gone");
        relay.st().client_gone_since.remove(&id);
        let _ = relay.end_session(&id, true).await;
    }
}

/// Keepalive pings, idle sessions and tabs, sessions whose client exited, and idle shutdown.
async fn housekeeping(relay: Arc<Relay>) {
    let keepalive = std::env::var("OPENCODE_BROWSER_KEEPALIVE_MS").ok().and_then(|v| v.parse::<u64>().ok()).unwrap_or(20_000);
    let client_gone_grace = Duration::from_millis(std::env::var("OPENCODE_BROWSER_CLIENT_GONE_GRACE_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(60_000));
    let started = Instant::now();
    let (mut last_ping, mut last_reap, mut last_orphans, mut last_memory) = (started, started, started, started);
    let mut interval = tokio::time::interval(Duration::from_secs(1));
    loop {
        interval.tick().await;
        let now = Instant::now();
        if keepalive > 0 && now - last_ping >= Duration::from_millis(keepalive) {
            last_ping = now;
            let pairings = crate::pairing::read_browser_pairings(&relay.paths);
            let legacy = crate::pairing::legacy_pairing_code(&relay.paths).is_some();
            let revoked: Vec<_> = relay.st().links.iter().filter(|l| !legacy && !pairings.contains_key(&l.key)).cloned().collect();
            for link in revoked {
                rlog!("extension.revoked", browser = link.id.clone());
                link.close(4006, "Pairing revoked: run `pair` and enter the code to pair again");
            }
            let links: Vec<_> = relay.st().links.iter().filter(|l| (l.connected() || l.unresponsive()) && !l.ping_pending()).cloned().collect();
            for link in links {
                let relay = relay.clone();
                tokio::spawn(async move {
                    if link.call("ping", Value::Null, None).await.is_err() && link.unresponsive() {
                        let sessions: Vec<String> = relay
                            .st()
                            .sessions
                            .values()
                            .filter(|s| s.browser.as_ref().and_then(|b| b.key.as_deref()) == Some(&link.key))
                            .map(|s| s.id.clone())
                            .collect();
                        for session in sessions {
                            relay.stop_calls(&session, crate::protocol::BROWSER_UNRESPONSIVE);
                        }
                    }
                });
            }
        }
        if let Some(ttl) = relay.idle_tab_ttl.filter(|_| now - last_reap >= Duration::from_secs(60)) {
            last_reap = now;
            let (sessions, tabs) = {
                let st = relay.st();
                let sessions: Vec<String> = st
                    .sessions
                    .values()
                    .filter(|s| crate::sessions::auto_named(&s.id) && !s.busy() && !st.handoffs.contains_key(&s.id) && s.last_used.elapsed() >= ttl)
                    .filter(|s| !st.session_tabs(&s.id).is_empty())
                    .map(|s| s.id.clone())
                    .collect();
                let tabs: Vec<i64> = st
                    .tabs
                    .values()
                    .filter(|t| t.owner == crate::relay::Owner::User && t.session.is_none() && !t.focused && t.last_used.elapsed() >= ttl && st.handoff_for_tab(t.id).is_none())
                    .map(|t| t.id)
                    .collect();
                (sessions, tabs)
            };
            for session in sessions {
                rlog!("session.reaped", session = session.clone());
                let _ = relay.end_session(&session, true).await;
            }
            for tab in tabs {
                let _ = relay.detach_tab(tab, "idle").await;
            }
        }
        if now - last_orphans >= Duration::from_secs(5).min(client_gone_grace / 2).max(Duration::from_secs(1)) {
            last_orphans = now;
            sweep_clients(&relay, now, client_gone_grace).await;
        }
        if now - last_memory >= Duration::from_secs(60) {
            last_memory = now;
            release_memory_soon();
            if let Some(bytes) = crate::util::resident_bytes().filter(|b| *b >= 256 * 1024 * 1024) {
                let (sessions, tabs) = {
                    let st = relay.st();
                    (st.sessions.len(), st.tabs.len())
                };
                rlog!("relay.memory", rssMb = bytes / (1024 * 1024), sessions = sessions, tabs = tabs);
            }
        }
        if let Some(idle) = relay.idle_shutdown {
            let quiet = {
                let st = relay.st();
                let clients = st.sessions.values().any(|s| s.clients.iter().any(|pid| crate::util::process_alive(*pid)));
                let busy = st.sessions.values().any(|s| s.busy()) || !st.handoffs.is_empty();
                !clients && !busy && st.last_activity.elapsed() >= idle
            };
            if quiet {
                rlog!("relay.idle_shutdown", idleMs = idle.as_millis() as u64);
                relay.stop();
                return;
            }
        }
    }
}
