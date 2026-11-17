//! Where the relay listens (cli/src/relay/port.ts). The configured port is OPENCODE_BROWSER_PORT, else 19988; state
//! kept by port stays on the configured port. An unpinned relay whose port another program holds steps to the next
//! free browse port and records the one it bound in <state>/relays/<configured>/relay.json, which clients resolve.

use std::net::IpAddr;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::paths::{self, Paths};
use crate::protocol::{DEFAULT_PORT, FALLBACK_PORTS};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayState {
    pub port: u16,
    pub configured_port: u16,
    pub pid: u32,
    pub instance_id: String,
    pub started_at: String,
}

pub fn env_port() -> Option<u16> {
    std::env::var("OPENCODE_BROWSER_PORT").ok().and_then(|raw| raw.trim().parse::<u16>().ok()).filter(|p| *p > 0)
}

pub fn configured_port() -> u16 {
    env_port().unwrap_or(DEFAULT_PORT)
}

pub fn pinned() -> bool {
    env_port().is_some()
}

pub fn read_relay_state(paths: &Paths, configured: u16) -> Option<RelayState> {
    paths::read_json::<RelayState>(&paths.relay_state(configured)).filter(|s| s.configured_port == configured && s.port > 0 && s.pid > 0 && !s.instance_id.is_empty())
}

pub fn write_relay_state(paths: &Paths, state: &RelayState) -> std::io::Result<()> {
    paths::write_private_json(&paths.relay_state(state.configured_port), state)
}

/// Removes relay.json only when it still describes `instance_id`.
pub fn remove_relay_state(paths: &Paths, configured: u16, instance_id: &str) {
    if read_relay_state(paths, configured).is_some_and(|s| s.instance_id == instance_id) {
        let _ = std::fs::remove_file(paths.relay_state(configured));
    }
}

pub fn read_last_port(paths: &Paths, configured: u16) -> Option<u16> {
    paths::read_json::<serde_json::Value>(&paths.last_port(configured))?.get("port")?.as_u64().and_then(|p| u16::try_from(p).ok()).filter(|p| *p > 0)
}

pub fn write_last_port(paths: &Paths, configured: u16, port: u16) -> std::io::Result<()> {
    paths::write_private_json(&paths.last_port(configured), &serde_json::json!({ "port": port }))
}

/// The port clients should dial: a pinned port, else a live relay.json's, else 19988.
pub fn resolve_port(paths: &Paths) -> u16 {
    if let Some(port) = env_port() {
        return port;
    }
    let configured = configured_port();
    read_relay_state(paths, configured).filter(|s| crate::util::process_alive(s.pid)).map(|s| s.port).unwrap_or(DEFAULT_PORT)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PortOwner {
    Browse,
    Other,
    Nobody,
}

pub async fn probe(port: u16, timeout: Duration) -> PortOwner {
    match crate::client::request(port, "GET", "/version", &[], None, timeout).await {
        Ok(response) => {
            let body = response.json();
            let browse = body.as_ref().is_some_and(crate::client::is_relay_version);
            let starting = body.as_ref().is_some_and(|b| b["code"] == "relay-starting");
            if (response.status == 200 && browse) || (response.status == 503 && starting) { PortOwner::Browse } else { PortOwner::Other }
        }
        Err(_) => PortOwner::Nobody,
    }
}

async fn can_bind(host: IpAddr, port: u16) -> bool {
    match tokio::net::TcpListener::bind((host, port)).await {
        Ok(_) => true,
        Err(error) => error.kind() != std::io::ErrorKind::AddrInUse,
    }
}

async fn can_listen(host: IpAddr, port: u16) -> bool {
    can_bind(host, port).await && (host.is_loopback() || can_bind(IpAddr::from([127, 0, 0, 1]), port).await)
}

fn in_use(host: IpAddr, port: u16) -> anyhow::Error {
    anyhow::anyhow!("listen EADDRINUSE: address already in use {host}:{port}")
}

/// The listen port: a pinned port as is; otherwise refuse to run beside a live recorded relay, then the first free
/// candidate. A candidate held by a browse relay, or by something that isn't HTTP, stops the start.
pub async fn choose_port(paths: &Paths, configured: u16, pinned: bool, host: IpAddr, candidates: Option<Vec<u16>>) -> anyhow::Result<u16> {
    if pinned {
        return Ok(configured);
    }
    let timeout = Duration::from_millis(500);
    if let Some(state) = read_relay_state(paths, configured).filter(|s| crate::util::process_alive(s.pid))
        && crate::client::version(state.port, timeout).await.is_some_and(|v| v["instanceId"] == state.instance_id.as_str()) {
            return Err(in_use(host, state.port));
        }
    if !host.is_loopback()
        && let Some(last) = read_last_port(paths, configured)
            && can_listen(host, last).await {
                return Ok(last);
            }
    let mut ports = candidates.unwrap_or_else(|| std::iter::once(configured).chain(FALLBACK_PORTS).collect());
    ports.dedup();
    for port in &ports {
        if can_listen(host, *port).await {
            return Ok(*port);
        }
        match probe(*port, timeout).await {
            PortOwner::Other => continue,
            _ => return Err(in_use(host, *port)),
        }
    }
    anyhow::bail!(
        "browse relay ports {} are all in use. Set OPENCODE_BROWSER_PORT to a free port, or stop the program holding them.",
        ports.iter().map(u16::to_string).collect::<Vec<_>>().join(", ")
    )
}
