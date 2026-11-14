//! Finding and calling the running relay from another process (the MCP proxy, the CLI): where it listens, its
//! token, a health check, and the tool API. A small HTTP/1.1 client over loopback, so callers need no HTTP stack.

use std::time::Duration;

use anyhow::{Context, anyhow, bail};
use browse_core::{SessionId, ToolCallRequest, ToolOutput, ToolSpec};
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use crate::paths::Paths;
use crate::port;

#[derive(Debug, Clone)]
pub struct HttpResponse {
    pub status: u16,
    pub body: Vec<u8>,
}

impl HttpResponse {
    pub fn json(&self) -> Option<Value> {
        serde_json::from_slice(&self.body).ok()
    }
}

/// One request to 127.0.0.1:`port`, `Connection: close`.
pub async fn request(port: u16, method: &str, path: &str, headers: &[(&str, &str)], body: Option<&[u8]>, timeout: Duration) -> anyhow::Result<HttpResponse> {
    tokio::time::timeout(timeout, async {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).await?;
        let mut head = format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\nAccept: application/json\r\n");
        for (name, value) in headers {
            head.push_str(&format!("{name}: {value}\r\n"));
        }
        if let Some(body) = body {
            head.push_str(&format!("Content-Type: application/json\r\nContent-Length: {}\r\n", body.len()));
        }
        head.push_str("\r\n");
        stream.write_all(head.as_bytes()).await?;
        if let Some(body) = body {
            stream.write_all(body).await?;
        }
        let mut raw = Vec::new();
        stream.read_to_end(&mut raw).await?;
        parse_response(&raw)
    })
    .await
    .map_err(|_| anyhow!("the relay on port {port} didn't answer within {} ms", timeout.as_millis()))?
}

fn parse_response(raw: &[u8]) -> anyhow::Result<HttpResponse> {
    let split = raw.windows(4).position(|w| w == b"\r\n\r\n").context("malformed HTTP response")?;
    let head = String::from_utf8_lossy(&raw[..split]);
    let mut lines = head.split("\r\n");
    let status = lines.next().and_then(|line| line.split_whitespace().nth(1)).and_then(|s| s.parse().ok()).context("malformed status line")?;
    let chunked = lines.any(|line| line.to_ascii_lowercase().starts_with("transfer-encoding:") && line.to_ascii_lowercase().contains("chunked"));
    let mut body = raw[split + 4..].to_vec();
    if chunked {
        body = dechunk(&body)?;
    }
    Ok(HttpResponse { status, body })
}

fn dechunk(mut data: &[u8]) -> anyhow::Result<Vec<u8>> {
    let mut out = Vec::new();
    loop {
        let end = data.windows(2).position(|w| w == b"\r\n").context("malformed chunk")?;
        let size = usize::from_str_radix(String::from_utf8_lossy(&data[..end]).split(';').next().unwrap_or("").trim(), 16)?;
        data = &data[end + 2..];
        if size == 0 {
            return Ok(out);
        }
        if data.len() < size {
            bail!("truncated chunk");
        }
        out.extend_from_slice(&data[..size]);
        data = data.get(size + 2..).unwrap_or(&[]);
    }
}

/// The relay's open /version answer, when a browse relay holds `port`.
pub async fn version(port: u16, timeout: Duration) -> Option<Value> {
    let response = request(port, "GET", "/version", &[], None, timeout).await.ok()?;
    let body = response.json()?;
    (response.status == 200 && body.get("version").is_some_and(Value::is_string) && body.get("instanceId").is_some_and(Value::is_string)).then_some(body)
}

/// Where the running relay is and how to authenticate with it.
#[derive(Debug, Clone)]
pub struct Endpoint {
    pub port: u16,
    pub token: String,
    pub instance_id: String,
    pub version: String,
}

impl Endpoint {
    pub fn url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }
}

/// The running relay, proven by its /version (and relay.json when it moved to a fallback port), with this install's
/// relay token. None when no relay answers.
pub async fn resolve(paths: &Paths) -> Option<Endpoint> {
    let configured = port::configured_port();
    let live = port::read_relay_state(paths, configured).filter(|s| crate::util::process_alive(s.pid));
    let port = port::env_port().or(live.as_ref().map(|s| s.port)).unwrap_or(crate::protocol::DEFAULT_PORT);
    let answer = version(port, Duration::from_secs(3)).await?;
    let instance_id = answer["instanceId"].as_str()?.to_string();
    if let Some(live) = live.filter(|s| s.port == port)
        && live.instance_id != instance_id {
            return None;
        }
    Some(Endpoint { port, token: crate::secrets::relay_token(paths).ok()?, instance_id, version: answer["version"].as_str()?.to_string() })
}

/// Whether a relay answers and accepts this install's token.
pub async fn health(endpoint: &Endpoint) -> bool {
    let auth = format!("Bearer {}", endpoint.token);
    matches!(request(endpoint.port, "GET", "/tools", &[("Authorization", &auth)], None, Duration::from_secs(3)).await, Ok(r) if r.status == 200)
}

pub async fn list_tools(endpoint: &Endpoint) -> anyhow::Result<Vec<ToolSpec>> {
    let auth = format!("Bearer {}", endpoint.token);
    let response = request(endpoint.port, "GET", "/tools", &[("Authorization", &auth)], None, Duration::from_secs(10)).await?;
    if response.status != 200 {
        bail!("the relay answered {} for /tools: {}", response.status, String::from_utf8_lossy(&response.body));
    }
    Ok(serde_json::from_slice(&response.body)?)
}

/// Calls a tool as `caller` (see `caller_session_id`). Long calls (handoffs wait for the user) get no deadline.
pub async fn call_tool(endpoint: &Endpoint, caller: &SessionId, name: &str, arguments: Value) -> anyhow::Result<ToolOutput> {
    let auth = format!("Bearer {}", endpoint.token);
    let pid = std::process::id().to_string();
    let body = serde_json::to_vec(&ToolCallRequest { name: name.into(), arguments, session: caller.clone() })?;
    let headers = [("Authorization", auth.as_str()), ("OpenCode-Browser-Client-Pid", pid.as_str())];
    let response = request(endpoint.port, "POST", "/tools/call", &headers, Some(&body), Duration::from_secs(24 * 3600)).await?;
    if response.status != 200 {
        let message = response.json().and_then(|v| v["error"].as_str().map(str::to_string)).unwrap_or_else(|| String::from_utf8_lossy(&response.body).into());
        bail!("{message}");
    }
    Ok(serde_json::from_slice(&response.body)?)
}

/// A browse session id for an agent the client names (an OpenCode session id), valid for the relay: `oc-` and the
/// id in lowercase, with a short hash when lowercasing or replacing characters changed it.
pub fn caller_session_id(raw: &str) -> SessionId {
    let cleaned: String = raw.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c.to_ascii_lowercase() } else { '-' }).collect();
    let mut id = if cleaned.starts_with("oc-") { cleaned.clone() } else { format!("oc-{cleaned}") };
    if cleaned != raw {
        use sha2::Digest;
        let digest = sha2::Sha256::digest(raw.as_bytes());
        id.truncate(54);
        id.push('-');
        id.push_str(&digest[..4].iter().map(|b| format!("{b:02x}")).collect::<String>());
    }
    id.truncate(63);
    id
}

#[cfg(test)]
mod tests {
    #[test]
    fn caller_ids_are_valid_session_ids() {
        for raw in ["ses_7b9cQx", "oc-ses-abc", "ses abc/def"] {
            let id = super::caller_session_id(raw);
            assert!(crate::sessions::valid_session_id(&id), "{id}");
        }
        assert_eq!(super::caller_session_id("ses-abc"), "oc-ses-abc");
        assert_ne!(super::caller_session_id("ses_A"), super::caller_session_id("ses_a"));
    }
}
