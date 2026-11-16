//! Talking to the local relay, and starting it when nothing is listening (cli/src/relay/lifecycle.ts).

use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use anyhow::{Context, anyhow, bail};
use browse_core::{ToolCallRequest, ToolOutput, ToolSpec};
use serde_json::Value;

use crate::http;
use crate::relay_api;

pub enum Probe {
    Running(Value),
    Absent,
    /// Something answered that isn't a browse relay.
    Foreign(String),
}

pub fn probe() -> Probe {
    let endpoint = relay_api::endpoint();
    match http::request(&endpoint, "GET", "/version", &[], None, Some(Duration::from_secs(5))) {
        Err(http::Error::Unreachable(_)) => Probe::Absent,
        Err(error) => Probe::Foreign(format!("{endpoint} didn't answer /version: {error}")),
        Ok(response) => match serde_json::from_slice::<Value>(&response.body) {
            Ok(version) if response.status == 200 && version.get("version").is_some_and(Value::is_string) => Probe::Running(version),
            // A relay still starting up answers 503.
            _ if response.status == 503 => Probe::Absent,
            _ => Probe::Foreign(format!(
                "port {} is in use by another program, so the browse relay can't start there. Stop that program, or pick another port for browse with OPENCODE_BROWSER_PORT (set it where your agent starts, then restart the agent)",
                endpoint.rsplit(':').next().unwrap_or("")
            )),
        },
    }
}

/// The running relay's /version, starting one when none is listening.
pub fn ensure() -> anyhow::Result<Value> {
    match probe() {
        // A relay of the TypeScript browse can't serve this build: hand over to this one.
        Probe::Running(version) if crate::legacy::is_legacy(&version) => crate::legacy::stop(&version, false)?,
        Probe::Running(version) => return Ok(version),
        // Another program's server on the default port: a relay that may choose its port takes a free fallback one.
        Probe::Foreign(message) if browse_relay::port::pinned() => bail!(message),
        Probe::Foreign(_) | Probe::Absent => {}
    }
    if matches!(std::env::var("OPENCODE_BROWSER_AUTOSTART").as_deref(), Ok("0" | "false")) {
        bail!("automatic relay startup is disabled; no relay is running at {}", relay_api::endpoint());
    }
    start()?;
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        match probe() {
            Probe::Running(version) => return Ok(version),
            Probe::Foreign(message) if Instant::now() > deadline => bail!(message),
            _ if Instant::now() > deadline => bail!("browse relay did not start at {}", relay_api::endpoint()),
            _ => std::thread::sleep(Duration::from_millis(50)),
        }
    }
}

/// Stops a running relay and waits until it's gone. Agent tabs stay open and the next relay takes them back.
pub fn stop() -> anyhow::Result<bool> {
    let version = match probe() {
        Probe::Running(version) => version,
        _ => return Ok(false),
    };
    if crate::legacy::is_legacy(&version) {
        crate::legacy::stop(&version, true)?;
        return Ok(true);
    }
    let instance = version.get("instanceId").and_then(Value::as_str).unwrap_or_default().to_owned();
    match send("POST", "/shutdown", &[], Some(b"{}"), Some(Duration::from_secs(10))) {
        Ok(response) if (200..300).contains(&response.status) => {}
        Err(http::Error::Unreachable(_)) => return Ok(true),
        Ok(response) => bail!("the browse relay didn't stop: {}", String::from_utf8_lossy(&response.body).trim()),
        Err(error) => bail!("the browse relay didn't stop: {error}"),
    }
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        match probe() {
            Probe::Running(v) if v.get("instanceId").and_then(Value::as_str) == Some(instance.as_str()) => {}
            _ => return Ok(true),
        }
        if Instant::now() > deadline {
            bail!("the browse relay accepted the shutdown but is still running");
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// Restarts a running relay so it picks up changed settings (where it listens). Returns false when it couldn't.
pub fn restart() -> anyhow::Result<bool> {
    match stop() {
        Ok(true) => ensure().map(|_| true),
        Ok(false) => Ok(true),
        Err(_) => Ok(false),
    }
}

/// This executable's path, even after an update replaced the file it was started from.
pub fn current_exe() -> anyhow::Result<std::path::PathBuf> {
    let exe = std::env::current_exe().context("can't locate the browse executable")?;
    let text = exe.to_string_lossy();
    Ok(text.strip_suffix(" (deleted)").map(Into::into).unwrap_or(exe))
}

const ENV_NAMES: &[&str] = &[
    "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TEMP", "TMP", "LANG", "LANGUAGE", "TZ", "XDG_DATA_HOME",
    "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_BIN_HOME", "XDG_RUNTIME_DIR", "DISPLAY", "WAYLAND_DISPLAY",
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR", "SYSTEMROOT", "SYSTEMDRIVE",
    "WINDIR", "COMSPEC", "PATHEXT", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "PROGRAMFILES",
    "PROGRAMFILES(X86)", "HOMEDRIVE", "HOMEPATH", "USERNAME",
];

/// Starts `browse serve` detached from this install's executable: for a global install, the binary the launcher runs
/// now, which an update may have moved to another platform package.
pub fn start() -> anyhow::Result<()> {
    match crate::update::install().executable() {
        Some(executable) => start_from(&executable),
        None => start_from(&current_exe()?),
    }
}

/// Starts `<executable> serve` detached, with only the environment it needs (never the agent's API keys).
pub fn start_from(executable: &std::path::Path) -> anyhow::Result<()> {
    let mut command = Command::new(executable);
    command.arg("serve").env_clear().stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    for (name, value) in std::env::vars_os() {
        let upper = name.to_string_lossy().to_uppercase();
        // The package managers' own settings, for a global install's updates.
        let npm = ["NPM_CONFIG_", "BUN_", "PNPM_", "YARN_", "VOLTA_", "COREPACK_"].iter().any(|p| upper.starts_with(p)) || upper == "NODE_EXTRA_CA_CERTS";
        if ENV_NAMES.contains(&upper.as_str()) || upper.starts_with("OPENCODE_BROWSER_") || upper.starts_with("LC_") || npm {
            command.env(name, value);
        }
    }
    command.env("OPENCODE_BROWSER_MANAGED_RELAY", "1");
    detach(&mut command);
    command.spawn().context("failed to start the browse relay")?;
    Ok(())
}

#[cfg(unix)]
fn detach(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    // Its own process group, so a terminal's Ctrl+C or an agent's exit doesn't take the relay with it.
    command.process_group(0);
}

#[cfg(windows)]
fn detach(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const DETACHED_PROCESS: u32 = 0x8;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x200;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
    command.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW | CREATE_BREAKAWAY_FROM_JOB);
}

fn send(method: &str, path: &str, extra: &[(&str, &str)], body: Option<&[u8]>, timeout: Option<Duration>) -> Result<http::Response, http::Error> {
    let auth = format!("Bearer {}", relay_api::token().unwrap_or_default());
    // The relay stops the calls of a process that is gone.
    let pid = std::process::id().to_string();
    let mut headers = vec![("Authorization", auth.as_str()), ("OpenCode-Browser-Client-Pid", pid.as_str())];
    headers.extend_from_slice(extra);
    http::request(&relay_api::endpoint(), method, path, &headers, body, timeout)
}

/// An authorized request to the relay. A relay that is gone (restarted for an update, crashed) is started again and
/// the request retried once; a request that may have reached the relay is never repeated.
fn authorized(method: &str, path: &str, extra: &[(&str, &str)], body: Option<&[u8]>, timeout: Option<Duration>) -> anyhow::Result<Value> {
    ensure()?;
    let response = match send(method, path, extra, body, timeout) {
        Err(http::Error::Unreachable(_)) => {
            ensure()?;
            send(method, path, extra, body, timeout)
        }
        other => other,
    }
    .map_err(|error| anyhow!("the browse relay at {} failed: {error}", relay_api::endpoint()))?;
    let value: Value = serde_json::from_slice(&response.body).unwrap_or(Value::Null);
    if !(200..300).contains(&response.status) {
        let message = value
            .get("error")
            .and_then(|e| e.get("message").or(Some(e)))
            .and_then(Value::as_str)
            .map(str::to_owned)
            .unwrap_or_else(|| String::from_utf8_lossy(&response.body).into_owned());
        bail!("relay answered {}: {}", response.status, message.trim());
    }
    Ok(value)
}

/// The header naming the MCP client, when there is one: the relay decides its tools and instructions by it.
fn client_header(client: Option<&str>) -> Vec<(&'static str, &str)> {
    client.map(|name| vec![(browse_core::CLIENT_HEADER, name)]).unwrap_or_default()
}

/// The tools the relay offers `client` (every tool for None, the CLI).
pub fn tools(client: Option<&str>) -> anyhow::Result<Vec<ToolSpec>> {
    Ok(serde_json::from_value(authorized("GET", "/tools", &client_header(client), None, Some(Duration::from_secs(30)))?)?)
}

pub fn call(request: &ToolCallRequest, client: Option<&str>) -> anyhow::Result<ToolOutput> {
    call_keyed(request, client, None)
}

/// [call], with a key for the call (browse_core::CALL_HEADER) that [cancel] can stop it by.
pub fn call_keyed(request: &ToolCallRequest, client: Option<&str>, key: Option<&str>) -> anyhow::Result<ToolOutput> {
    let body = serde_json::to_vec(request)?;
    let mut headers = client_header(client);
    if let Some(key) = key {
        headers.push((browse_core::CALL_HEADER, key));
    }
    Ok(serde_json::from_value(authorized("POST", "/tools/call", &headers, Some(&body), None)?)?)
}

/// Stops the call [call_keyed] started with `key`, or the call when it starts, if it hasn't yet.
pub fn cancel(key: &str) -> anyhow::Result<()> {
    let body = serde_json::to_vec(&serde_json::json!({ "call": key }))?;
    authorized("POST", "/tools/cancel", &[], Some(&body), Some(Duration::from_secs(10)))?;
    Ok(())
}

/// The MCP instructions for `client`: the running relay's, else this build's, without starting a relay.
pub fn instructions(client: &str) -> String {
    let running = match probe() {
        Probe::Running(_) => authorized("GET", "/instructions", &client_header(Some(client)), None, Some(Duration::from_secs(10))).ok(),
        _ => None,
    };
    running.and_then(|v| v["instructions"].as_str().map(str::to_string)).unwrap_or_else(|| browse_relay::surface::instructions(client).to_string())
}

/// The extension's state (`connected`, `pairingState`, `nextStep`, browsers, tabs) when a relay is running.
/// `waiting` tells the relay an install is waiting for the extension to come.
pub fn extension_status(waiting: bool) -> Option<Value> {
    let Probe::Running(_) = probe() else { return None };
    let extra: &[(&str, &str)] = if waiting { &[("X-Browse-Install", "waiting")] } else { &[] };
    authorized("GET", "/extension/status", extra, None, Some(Duration::from_secs(10))).ok()
}

/// Drops a revoked browser's connection right away.
pub fn drop_browser(key: &str) {
    if let Probe::Running(_) = probe() {
        let body = serde_json::json!({ "key": key }).to_string();
        let _ = authorized("POST", "/extension/revoke", &[], Some(body.as_bytes()), Some(Duration::from_secs(10)));
    }
}

/// The tools this build links in, for listing them without a relay.
pub fn local_tools() -> Vec<std::sync::Arc<dyn browse_core::Tool>> {
    let mut tools = browse_relay::tools();
    tools.extend(browse_page::tools());
    tools.extend(browse_capture::tools());
    let execute = browse_script::tools(&tools);
    tools.extend(execute);
    tools
}

pub fn local_specs() -> Vec<ToolSpec> {
    local_tools().iter().map(|tool| tool.spec()).collect()
}

/// A running relay's tools for `client` (authoritative), else this build's, without starting a relay.
pub fn specs(client: Option<&str>) -> Vec<ToolSpec> {
    let local = || browse_relay::surface::tools(client, local_specs());
    match probe() {
        Probe::Running(_) => tools(client).unwrap_or_else(|_| local()),
        _ => local(),
    }
}

