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
    /// Replaces the `autoUpdate` status the extension's pages show (the binary's update state).
    pub auto_update: Option<AutoUpdateStatus>,
    /// Test-only: the ports an unpinned relay tries.
    pub port_candidates: Option<Vec<u16>>,
}

impl Default for ServeOptions {
    fn default() -> Self {
        Self {
            port: None,
            paths: Paths::from_env(),
            version: env!("CARGO_PKG_VERSION").to_string(),
            build_id: String::new(),
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

    /// See `Relay::set_update_notice`: `(summary, command)`, or None once browse is current.
    pub fn update_notice(&self, notice: Option<(String, String)>) {
        self.relay.set_update_notice(notice);
    }

    /// See `Relay::idle`.
    pub fn idle(&self, quiet: Duration) -> bool {
        self.relay.idle(quiet)
    }

    /// Runs until the relay stops (`stop`, POST /shutdown).
    pub async fn wait(self) {
        let _ = self.task.await;
    }
}

impl Relay {
    /// Nothing would be interrupted by a restart (an update): no call running, no handoff waiting, and no agent
    /// activity for `quiet`. Connected client processes don't count: an agent's `browse mcp` server stays running for
    /// as long as the agent does, and its calls are what actually use the browser.
    pub fn idle(&self, quiet: Duration) -> bool {
        let st = self.st();
        !st.busy() && st.handoffs.is_empty() && st.last_activity.elapsed() >= quiet
    }
}

/// Runs the relay until it stops (SIGINT, SIGTERM, POST /shutdown). `tools` are every crate's tools;
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
    // Sessions are gone: tabs are the handle, and their registry replaces the session catalog.
    let _ = std::fs::remove_file(paths.legacy_session_catalog(configured));
    for entry in crate::registry::load(&paths.tab_registry(configured)) {
        relay.st().restorable.insert(entry.target_id.clone(), entry);
    }
    relay.ready.store(true, Ordering::SeqCst);
    rlog!(
        "relay.ready",
        url = format!("http://127.0.0.1:{}", addr.port()),
        version = relay.version.clone(),
        pid = std::process::id(),
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
    rlog!("relay.shutdown.start", tabs = relay.st().tabs.len());
    drop(listener);
    let links: Vec<_> = relay.st().links.clone();
    for link in &links {
        link.reject_all("Relay closed");
        link.close(1001, "Relay closed");
    }
    tokio::time::sleep(Duration::from_millis(100)).await;
    persister.abort();
    housekeeping.abort();
    if let Some(delay) = test_shutdown_delay() {
        tokio::time::sleep(delay).await;
    }
    relay.persist_final();
    rlog!("relay.shutdown.closed", pid = std::process::id());
    // Last, so a client that waits for it to go (relay::stop, before uninstall deletes browse's folders) knows every
    // write is done: relay.json is the relay's "finished with my files" marker while it stops answering.
    port::remove_relay_state(&relay.paths, relay.configured_port, &relay.instance_id);
    heartbeat.abort();
    relay.finished.store(true, Ordering::SeqCst);
}

/// Test-only: holds open the window between the listener closing and the shutdown's final registry write, so the
/// uninstall test sees the writes a client that only waits for /version would miss.
#[cfg(debug_assertions)]
fn test_shutdown_delay() -> Option<Duration> {
    std::env::var("OPENCODE_BROWSER_TEST_SHUTDOWN_DELAY_MS").ok()?.trim().parse::<u64>().ok().filter(|ms| *ms > 0).map(Duration::from_millis)
}

/// Release builds never delay shutdown for tests.
#[cfg(not(debug_assertions))]
fn test_shutdown_delay() -> Option<Duration> {
    None
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

/// Reads and drops what is left of a request body before the answer goes out: closing a connection with body bytes
/// still unread makes the kernel send a reset instead of a clean close, and a macOS client then loses the answer it
/// hasn't read yet. Frames are dropped as they arrive, up to MAX_BODY, so a huge upload can't hold the relay open.
async fn discard_body(mut body: Incoming) {
    let mut left = MAX_BODY;
    while let Some(frame) = body.frame().await {
        let Ok(frame) = frame else { return };
        let Ok(data) = frame.into_data() else { continue };
        let Some(remaining) = left.checked_sub(data.len()) else { return };
        left = remaining;
    }
}

/// Answers a request, reading whatever is left of its body first: every response goes through here, so an early one
/// (a turned-away request, the version probe) can't leave body bytes unread.
async fn route(relay: Arc<Relay>, peer: SocketAddr, mut request: Request<Incoming>) -> Response<Full<Bytes>> {
    let response = answer(relay, peer, &mut request).await;
    // The extension's upgrade hands the connection over; what follows on it is WebSocket frames, not a body.
    if response.status() != StatusCode::SWITCHING_PROTOCOLS {
        discard_body(request.into_body()).await;
    }
    response
}

async fn answer(relay: Arc<Relay>, peer: SocketAddr, request: &mut Request<Incoming>) -> Response<Full<Bytes>> {
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
        && let Err(error) = crate::origins::validate_host_header(header(request, "host"), &relay.host, relay.port) {
            return json_response(StatusCode::FORBIDDEN, &json!({ "error": error }));
        }
    if path == "/extension" {
        return upgrade_extension(relay, peer, request);
    }
    let probing = header(request, "x-browse-install") == Some("probe") && relay.st().install_waiting_until.is_some_and(|until| Instant::now() < until);
    let compatibility = json!({ "extensionProtocol": { "min": MIN_EXTENSION_PROTOCOL_VERSION, "version": EXTENSION_PROTOCOL_VERSION }, "pairing": PAIRING_SCHEME });
    if let Err(error) = crate::origins::validate_fetch_site(header(request, "sec-fetch-site")) {
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
            // Every relay stops on POST /shutdown; clients before this field went away check it first.
            "managed": true,
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
    // A relay that is stopping for an update must not start new work: answer before the tool would wait on a browser
    // that is already going away. The client retries this (the request never ran) once a restarted relay answers.
    if relay.is_stopping() {
        return json_response(StatusCode::SERVICE_UNAVAILABLE, &json!({ "error": "browse relay is restarting; try again in a moment", "code": "relay-restarting" }));
    }
    let mut authorized = header(request, "authorization").and_then(|v| v.strip_prefix("Bearer ").or_else(|| v.strip_prefix("bearer "))).map(str::trim).map(str::to_string);
    // The TypeScript relay's /json/version handed connectOverCDP clients a WebSocket URL with the token in its query.
    if authorized.is_none() && path.starts_with("/devtools/") {
        authorized = url::form_urlencoded::parse(request.uri().query().unwrap_or_default().as_bytes()).find(|(k, _)| k == LEGACY_TOKEN_PARAM).map(|(_, v)| v.into_owned());
    }
    if !secrets_equal(&relay.token, authorized.as_deref()) {
        return json_response(StatusCode::UNAUTHORIZED, &json!({ "error": "Missing or invalid browse relay token", "code": "unauthorized" }));
    }
    let method = request.method().clone();
    let waiting = header(request, "x-browse-install") == Some("waiting");
    let client_pid = header(request, "opencode-browser-client-pid").and_then(|v| v.parse::<u32>().ok()).filter(|p| *p > 0);
    let client = header(request, &browse_core::CLIENT_HEADER.to_ascii_lowercase()).map(str::to_string);
    let call_key = header(request, &browse_core::CALL_HEADER.to_ascii_lowercase()).filter(|k| !k.is_empty() && k.len() <= 128).map(str::to_string);
    // The TypeScript client's HTTP client (Effect's) sends trace headers on every request; this build's never does.
    let typescript_client = header(request, "b3").is_some();
    // A route that reads the body takes it here, under the size limit; anything else is discarded before the answer
    // (route). Only POST carries one.
    let body = if method == hyper::Method::POST {
        match Limited::new(request.body_mut(), MAX_BODY).collect().await {
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
            let specs = crate::surface::tools(client.as_deref(), specs);
            json_response(StatusCode::OK, &serde_json::to_value(specs).unwrap_or_default())
        }
        ("GET", "/instructions") => json_response(StatusCode::OK, &json!({ "instructions": crate::surface::instructions(client.as_deref().unwrap_or_default()) })),
        ("POST", "/tools/call") => {
            let request: ToolCallRequest = match parsed().map(serde_json::from_value) {
                Ok(Ok(request)) => request,
                Ok(Err(error)) => return json_response(StatusCode::BAD_REQUEST, &json!({ "error": format!("Invalid tool call: {error}"), "code": "invalid-request" })),
                Err(response) => return *response,
            };
            match call_tool_keyed(&relay, request, client_pid, call_key).await {
                Ok(output) => json_response(StatusCode::OK, &serde_json::to_value(output).unwrap_or_default()),
                Err((status, message)) => json_response(status, &json!({ "error": message })),
            }
        }
        ("POST", "/tools/cancel") => {
            let Ok(body) = parsed() else { return json_response(StatusCode::BAD_REQUEST, &json!({ "error": "Invalid JSON body" })) };
            let Some(key) = body["call"].as_str().filter(|k| !k.is_empty()) else {
                return json_response(StatusCode::BAD_REQUEST, &json!({ "error": "call is required", "code": "invalid-request" }));
            };
            let stopped = relay.cancel_call(key);
            rlog!("tool.cancel", stopped = stopped);
            json_response(StatusCode::OK, &json!({ "stopped": stopped }))
        }
        // An old MCP server checks the extension before each browser call, and this relay's answer doesn't decode there.
        ("GET", "/extension/status") if typescript_client => json_response(StatusCode::GONE, &json!({ "error": LEGACY_CLIENT })),
        ("GET", "/extension/status") => {
            if waiting {
                relay.st().install_waiting_until = Some(Instant::now() + Duration::from_secs(5));
            }
            let mut status = relay.extension_status();
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
        // An error envelope without a code, which the TypeScript client (cli/src/relay/client.ts) passes on as the
        // tool's error text as is.
        (_, path) if legacy_route(path) => json_response(StatusCode::GONE, &json!({ "error": LEGACY_CLIENT })),
        _ => json_response(StatusCode::NOT_FOUND, &json!({ "error": "Not found", "code": "not-found" })),
    }
}

/// What a client of the TypeScript browse (0.0.17 and earlier) gets from this relay: an MCP server OpenCode started
/// before the update keeps running the old build until it is restarted.
pub const LEGACY_CLIENT: &str = "browse was updated to a new version, but this browse MCP server is the old one still running, so it can't use the browser until it restarts. If you are running in OpenCode, reconnect it yourself and retry: run `opencode api post /api/experimental/mcp/browse/disconnect`, then `opencode api post /api/experimental/mcp/browse/connect`, from this project's directory (use opencode-browser instead of browse if that is the server's name in the config); if that fails, tell the user to restart OpenCode. In any other app, tell the user browse was updated and how to restart it there: in Claude Code, run /mcp, pick browse and choose Reconnect; in Codex, quit and start codex again (it starts MCP servers with each session); in Cursor, turn browse off and on under Settings > MCP; anywhere else, restart the browse MCP server or the app. The new version's tools replace these after the restart.";

const LEGACY_TOKEN_PARAM: &str = "opencodeBrowserToken";

/// The TypeScript relay's HTTP API (cli/src/http-api.ts) and its CDP WebSocket (/devtools/browser/<id>), which this
/// relay doesn't serve.
fn legacy_route(path: &str) -> bool {
    ["/v1/", "/cli/", "/network/", "/recording/", "/auth/", "/devtools/", "/json/"].iter().any(|prefix| path.starts_with(prefix))
        || matches!(path, "/json" | "/tabs/cleanup" | "/settings")
}

fn upgrade_extension(relay: Arc<Relay>, peer: SocketAddr, request: &mut Request<Incoming>) -> Response<Full<Bytes>> {
    let origin = header(request, "origin").map(str::to_string);
    if let Err(error) = crate::origins::validate_extension_origin(origin.as_deref(), &relay.origins) {
        rlog!("extension.rejected", reason = error, origin = origin);
        return json_response(StatusCode::FORBIDDEN, &json!({ "error": error }));
    }
    let websocket = header(request, "upgrade").is_some_and(|v| v.eq_ignore_ascii_case("websocket"));
    let Some(key) = header(request, "sec-websocket-key").filter(|_| websocket).map(|k| derive_accept_key(k.as_bytes())) else {
        return json_response(StatusCode::BAD_REQUEST, &json!({ "error": "Expected a WebSocket upgrade" }));
    };
    let upgrade = hyper::upgrade::on(request);
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
    /// The relay running the call, for the relay's own tools.
    pub static RELAY: Arc<Relay>;
    /// The running call's id: the tabs it uses are noted under it, and it never stops itself.
    pub static CALL: u64;
    /// The running call's tool name.
    pub static TOOL: String;
    /// The process that made the running call (OpenCode-Browser-Client-Pid).
    pub static CLIENT: Option<u32>;
}

/// Runs one tool call. The tabs it uses (named in its arguments, or opened by it) count as busy until it ends, and
/// their news comes back as warnings.
pub async fn call_tool(relay: &Arc<Relay>, request: ToolCallRequest, client_pid: Option<u32>) -> Result<ToolOutput, (StatusCode, String)> {
    call_tool_keyed(relay, request, client_pid, None).await
}

/// Rewrites `tab` (and every entry of `tabs`) from a caller-chosen id like `work-mail` to the relay's numeric id, and
/// says which chosen id `tab` named. Arguments every tool shares pass through here once.
fn resolve_tab_arguments(relay: &Arc<Relay>, arguments: &mut Value) -> Result<Option<String>, String> {
    let Some(map) = arguments.as_object_mut() else { return Ok(None) };
    let mut chosen = None;
    if let Some(value) = map.get_mut("tab") {
        match value {
            Value::String(name) => {
                let name = name.trim().to_string();
                let tab = relay.resolve_chosen_tab(&name).map_err(|error| format!("{error:#}"))?;
                *value = json!(tab);
                chosen = Some(name);
            }
            Value::Null => {}
            other if other.as_i64().is_some() => {}
            other => return Err(format!("tab must be an integer tab id or a chosen id like `work-mail`, not {other}")),
        }
    }
    if let Some(Value::Array(list)) = map.get_mut("tabs") {
        for value in list.iter_mut() {
            if let Value::String(name) = value {
                let tab = relay.resolve_chosen_tab(name.trim()).map_err(|error| format!("{error:#}"))?;
                *value = json!(tab);
            } else if !value.is_null() && value.as_i64().is_none() {
                return Err(format!("tabs must be integer tab ids or chosen ids like `work-mail`, not {value}"));
            }
        }
    }
    Ok(chosen)
}

/// [call_tool], with the caller's key for the call (CALL_HEADER) so POST /tools/cancel can stop it.
pub async fn call_tool_keyed(relay: &Arc<Relay>, request: ToolCallRequest, client_pid: Option<u32>, key: Option<String>) -> Result<ToolOutput, (StatusCode, String)> {
    let tool = relay.tools.read().unwrap_or_else(|poisoned| poisoned.into_inner()).iter().find(|t| t.spec().name == request.name).cloned();
    let Some(tool) = tool else { return Err((StatusCode::NOT_FOUND, format!("Unknown tool: {}", request.name))) };
    relay.note_activity();
    let context = ToolContext { browser: Arc::new(RelayBrowser(relay.clone())), file_roots: relay.file_roots.clone() };
    let id = relay.next_call.fetch_add(1, Ordering::SeqCst);
    let mut arguments = if request.arguments.is_null() { json!({}) } else { request.arguments };
    // `tab` takes a numeric id or a chosen id (`work-mail`); tools below this line see the numeric one.
    let chosen = match resolve_tab_arguments(relay, &mut arguments) {
        Ok(chosen) => chosen,
        Err(message) => return Ok(ToolOutput::error(message)),
    };
    if let Some(chosen) = &chosen {
        let tab = arguments["tab"].as_i64().unwrap_or_default();
        // A second call on a chosen-id tab gets a clear error instead of interleaving with the one running there.
        // A capture or recording is background work, not a call, so it doesn't refuse calls by the chosen id.
        let busy = {
            let mut st = relay.st();
            let busy = st.tab_call_busy(tab) || st.chosen_reserved(chosen);
            if !busy {
                st.chosen_calls.insert(id, tab);
            }
            busy
        };
        if busy {
            return Ok(ToolOutput::error(format!("{chosen} is busy: another call is running in that tab. Wait for it to finish, then try again.")));
        }
    }
    let tab = arguments.get("tab").and_then(Value::as_i64);
    let name = request.name.clone();
    let started = Instant::now();
    relay.inflight.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).insert(id, InFlight { tool: name.clone(), tab, since: started });
    let task = tokio::spawn(RELAY.scope(relay.clone(), CALL.scope(id, TOOL.scope(name.clone(), CLIENT.scope(client_pid, async move { tool.call(context, arguments).await })))));
    relay.call_started(id, task.abort_handle(), client_pid, key);
    let outcome = task.await;
    let stopped = relay.st().stopped.remove(&id);
    let used = relay.call_finished(id);
    relay.inflight.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).remove(&id);
    let ms = started.elapsed().as_millis() as u64;
    let mut output = match outcome {
        Ok(Ok(output)) => output,
        Ok(Err(error)) => ToolOutput::error(format!("{error:#}")),
        Err(join) if join.is_cancelled() => {
            rlog!("tool.stopped", tool = name.clone(), tabId = tab, ms = ms, reason = stopped.clone());
            ToolOutput::error(stopped.unwrap_or_else(|| "The call was stopped.".into()))
        }
        Err(join) => {
            rlog!("tool.panicked", tool = name.clone(), tabId = tab, ms = ms, error = join.to_string());
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
            Some(outcome) => rlog!("tool.outcome", tool = name.clone(), tabId = tab, ms = ms, outcome = outcome),
            None => rlog!("tool.error", tool = name.clone(), tabId = tab, ms = ms, error = text.chars().take(500).collect::<String>()),
        }
    } else if ms >= 20_000 {
        rlog!("tool.slow", tool = name.clone(), tabId = tab, ms = ms);
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
    let warnings: Vec<String> = {
        let mut st = relay.st();
        let mut warnings = Vec::new();
        for tab in &used {
            if let Some(entry) = st.tabs.get_mut(tab) {
                warnings.append(&mut entry.warnings);
            }
        }
        warnings
    };
    for warning in warnings {
        rlog!("tool.warning", tool = name.clone(), tabId = tab, warning = warning.chars().take(500).collect::<String>());
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

/// Calls and handoffs whose own process exited are stopped; every other client's carry on.
pub(crate) async fn sweep_clients(relay: &Arc<Relay>) {
    let dead: Vec<u32> = {
        let mut st = relay.st();
        let mut alive = HashMap::new();
        let mut alive = |pid: u32| *alive.entry(pid).or_insert_with(|| crate::util::process_alive(pid));
        let mut dead: Vec<u32> = st.calls.values().filter_map(|c| c.pid).chain(st.handoffs.values().filter_map(|h| h.pid)).filter(|pid| !alive(*pid)).collect();
        dead.sort();
        dead.dedup();
        st.clients.retain(|pid| alive(*pid));
        dead
    };
    for pid in dead {
        let message = format!("The client that called this (process {pid}) exited, so it was stopped.");
        let stopped = relay.stop_calls_where(&message, |call| call.pid == Some(pid));
        rlog!("client.gone", pid = pid, calls = stopped);
        relay.finish_client_handoffs(pid);
    }
}

/// Keepalive pings, idle tabs and calls whose client exited.
async fn housekeeping(relay: Arc<Relay>) {
    let keepalive = std::env::var("OPENCODE_BROWSER_KEEPALIVE_MS").ok().and_then(|v| v.parse::<u64>().ok()).unwrap_or(20_000);
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
                        let tabs: std::collections::HashSet<i64> = relay.st().tabs.values().filter(|t| t.link_key == link.key).map(|t| t.id).collect();
                        relay.stop_calls_where(crate::protocol::BROWSER_UNRESPONSIVE, |call| call.tabs.iter().any(|tab| tabs.contains(tab)));
                    }
                });
            }
        }
        if let Some(ttl) = relay.idle_tab_ttl.filter(|_| now - last_reap >= Duration::from_secs(60)) {
            last_reap = now;
            // Tabs no call used for the idle TTL: an agent's closes, a lent one goes back to the user.
            let idle: Vec<(i64, crate::relay::Owner)> = relay.idle_tabs(ttl);
            for (tab, owner) in idle {
                rlog!("tab.reaped", tabId = tab, owner = owner.name());
                if owner == crate::relay::Owner::User {
                    let _ = relay.detach_tab(tab, "idle").await;
                } else if relay.ext_tab(tab, "tabs.remove", json!({})).await.is_ok() {
                    relay.remove_tab(tab, crate::tabs::Release { gone: true, ..Default::default() }, "idle");
                }
            }
        }
        if now - last_orphans >= Duration::from_secs(5) {
            last_orphans = now;
            sweep_clients(&relay).await;
        }
        if now - last_memory >= Duration::from_secs(60) {
            last_memory = now;
            release_memory_soon();
            if let Some(bytes) = crate::util::resident_bytes().filter(|b| *b >= 256 * 1024 * 1024) {
                let tabs = relay.st().tabs.len();
                rlog!("relay.memory", rssMb = bytes / (1024 * 1024), tabs = tabs);
            }
        }
    }
}
