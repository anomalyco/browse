//! Taking over from a relay of the TypeScript browse (0.0.17 and earlier), which can't serve this build's `/tools`.
//! Its updater installs this build, then runs `<new entry> runtime-switch <version>` once no agent is using the
//! browser (cli/src/update/runtime-update.ts); a call from this build that finds one running asks it to stop the same
//! way: POST /shutdown with its shutdown protocol 2 (cli/src/relay/lifecycle.ts `restartRelay`), then waits for it to go.

use std::time::{Duration, Instant};

use anyhow::bail;
use serde_json::{Value, json};

use crate::serve::BUILD_ID;
use crate::{VERSION, http, relay, relay_api, session};

/// A running relay that isn't this Rust browse.
pub fn is_legacy(version: &Value) -> bool {
    version.get("runtime").and_then(Value::as_str) != Some("rust")
}

fn id() -> String {
    format!("{:016x}{:016x}", session::random_u64(), session::random_u64())
}

/// Asks the legacy relay `version` describes to stop, and waits until it has. `force` ends a capture, recording or raw
/// CDP client that would otherwise make it refuse.
pub fn stop(version: &Value, force: bool) -> anyhow::Result<()> {
    let running = version.get("version").and_then(Value::as_str).unwrap_or("unknown");
    // relay::probe only reports a relay whose /version has browse's fields, instanceId among them.
    let instance = version.get("instanceId").and_then(Value::as_str).unwrap_or_default();
    if version.get("managed") != Some(&Value::Bool(true)) || version.get("shutdownProtocol").and_then(Value::as_i64) != Some(2) {
        bail!("an older browse relay ({running}) runs in the foreground; stop it (Ctrl+C where it runs), then try again");
    }
    let mut body = json!({
        "instanceId": instance,
        "requestId": id(),
        "reason": "explicit-restart",
        "client": { "kind": "cli", "instanceId": id(), "buildId": BUILD_ID },
    });
    if force {
        body["force"] = json!(true);
    }
    let body = body.to_string();
    let auth = format!("Bearer {}", relay_api::token().unwrap_or_default());
    let endpoint = relay_api::endpoint();
    match http::request(&endpoint, "POST", "/shutdown", &[("Authorization", auth.as_str()), ("Content-Type", "application/json")], Some(body.as_bytes()), Some(Duration::from_secs(30))) {
        Ok(response) if (200..300).contains(&response.status) => {}
        // It went away on its own, or another process replaced it first.
        Err(http::Error::Unreachable(_)) => {}
        Ok(response) if response.status == 409 && gone(&endpoint, instance) => {}
        Ok(response) => {
            let value: Value = serde_json::from_slice(&response.body).unwrap_or(Value::Null);
            let message = value.get("error").and_then(|e| e.get("message").or(Some(e))).and_then(Value::as_str).map(str::to_owned);
            let message = message.unwrap_or_else(|| String::from_utf8_lossy(&response.body).trim().to_owned());
            bail!("the older browse relay ({running}) didn't stop for browse {VERSION}: {message}");
        }
        Err(error) => bail!("the older browse relay ({running}) didn't stop for browse {VERSION}: {error}"),
    }
    let deadline = Instant::now() + Duration::from_secs(30);
    while !gone(&endpoint, instance) {
        if Instant::now() > deadline {
            bail!("the older browse relay ({running}) accepted the shutdown but is still running");
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    // The relay removes relay.json after its last write (cli/src/relay.ts cleanup): waiting for it to go means an
    // uninstall that follows doesn't delete browse's folders under a relay that is still writing them.
    let pid = version.get("pid").and_then(Value::as_u64).and_then(|pid| u32::try_from(pid).ok());
    let paths = relay_api::paths();
    let configured = browse_relay::port::configured_port();
    while browse_relay::port::read_relay_state(&paths, configured).is_some_and(|state| state.instance_id == instance) {
        if pid.is_some_and(|pid| !browse_relay::process_alive(pid)) {
            break;
        }
        if Instant::now() > deadline {
            bail!("the older browse relay ({running}) accepted the shutdown but is still running");
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Ok(())
}

/// Whether the relay instance `instance` no longer answers at `endpoint`, the one `/shutdown` went to. Resolving the
/// endpoint again would be wrong here: once the old relay deletes relay.json it falls back to the default port, where
/// another program's server may answer. That is not this relay still running, so a non-browse answer means gone.
fn gone(endpoint: &str, instance: &str) -> bool {
    match relay::probe_at(endpoint) {
        relay::Probe::Running(version) => version.get("instanceId").and_then(Value::as_str) != Some(instance),
        relay::Probe::Absent | relay::Probe::Foreign(_) => true,
    }
}

/// `browse runtime-switch <version> [--force]`: what the TypeScript relay's updater runs in the build it installed.
/// Replaces a running legacy relay with this build's; exit 1 when it refused, so that updater tries again later.
pub fn runtime_switch(args: &[String]) -> anyhow::Result<i32> {
    let force = args.iter().any(|a| a == "--force");
    let wanted = args.iter().find(|a| !a.starts_with('-'));
    if let Some(wanted) = wanted.filter(|w| *w != VERSION) {
        eprintln!("browse {wanted} isn't installed here (this is {VERSION})");
        return Ok(1);
    }
    let relay::Probe::Running(version) = relay::probe() else { return Ok(0) };
    if !is_legacy(&version) {
        return Ok(0);
    }
    if let Err(error) = stop(&version, force) {
        eprintln!("{error:#}");
        return Ok(1);
    }
    relay::ensure()?;
    println!("browse relay switched to {VERSION}");
    Ok(0)
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};

    use super::*;

    /// The reply the issue reporter captured (Playwriter 0.12.0, no instanceId) and a legacy browse relay's answer.
    const FOREIGN: &str = r#"{"version":"0.12.0","pid":75049,"activeExecutes":0}"#;
    const LEGACY: &str = r#"{"version":"0.0.17","buildId":"3f2a1c9d","instanceId":"legacy-instance","startedAt":"2026-11-01T12:00:00.000Z","pid":4242,"managed":true,"shutdownProtocol":2}"#;

    /// One HTTP server on a free loopback port (never 19988–19997), answering every request with `body` until stopped.
    struct FakeServer {
        endpoint: String,
        stop: Arc<AtomicBool>,
        thread: Option<std::thread::JoinHandle<()>>,
    }

    impl FakeServer {
        fn start(body: &'static str) -> Self {
            let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
            listener.set_nonblocking(true).unwrap();
            let endpoint = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
            let stop = Arc::new(AtomicBool::new(false));
            let stopping = stop.clone();
            let thread = std::thread::spawn(move || {
                while !stopping.load(Ordering::SeqCst) {
                    match listener.accept() {
                        Ok((mut stream, _)) => {
                            let mut request = [0u8; 2048];
                            let _ = stream.read(&mut request);
                            let response = format!(
                                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                                body.len()
                            );
                            let _ = stream.write_all(response.as_bytes());
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(5)),
                        Err(_) => break,
                    }
                }
            });
            Self { endpoint, stop, thread: Some(thread) }
        }

        fn stop(&mut self) {
            self.stop.store(true, Ordering::SeqCst);
            if let Some(thread) = self.thread.take() {
                let _ = thread.join();
            }
        }
    }

    impl Drop for FakeServer {
        fn drop(&mut self) {
            self.stop();
        }
    }

    /// A foreign reply on another port must not make the legacy relay at the endpoint `/shutdown` went to look running.
    /// `gone` used to probe `relay::probe()`, which re-resolved the endpoint: once the old relay deleted relay.json that
    /// fell back to the default port, where Playwriter answered, and the foreign reply counted as alive until the
    /// deadline. The legacy relay had left its own port long before.
    #[test]
    fn a_foreign_reply_on_another_port_does_not_keep_a_stopped_legacy_relay_alive() {
        let foreign = FakeServer::start(FOREIGN);
        let mut legacy = FakeServer::start(LEGACY);
        assert!(matches!(
            relay::probe_at(&legacy.endpoint),
            relay::Probe::Running(version) if version["instanceId"].as_str() == Some("legacy-instance")
        ));
        // What re-resolving the endpoint would find after relay.json goes: another program's server.
        assert!(matches!(relay::probe_at(&foreign.endpoint), relay::Probe::Foreign(_)));
        legacy.stop();
        // The relay no longer answers at the endpoint /shutdown went to, whatever the other port says.
        assert!(gone(&legacy.endpoint, "legacy-instance"));
        // A non-browse answer at that endpoint means it left the port too, not that it is still running.
        assert!(gone(&foreign.endpoint, "legacy-instance"));
    }
}
