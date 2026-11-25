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

/// Asks the legacy relay `version` describes to stop at `endpoint`, the one it answered its open `/version` on, and
/// waits until it has. `force` ends a capture, recording or raw CDP client that would otherwise make it refuse.
pub fn stop(endpoint: &str, version: &Value, force: bool) -> anyhow::Result<()> {
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
    let pid = relay::stop_pid(version);
    let paths = relay_api::paths();
    let configured = browse_relay::port::configured_port();
    // Relays after relay.json's introduction remove it after their final tab write and shutdown log; while it still
    // names this instance the files they write as they exit may still come, so uninstall can't delete their folders yet.
    let recorded = browse_relay::port::read_relay_state(&paths, configured).is_some_and(|state| state.instance_id == instance);
    let auth = format!("Bearer {}", relay_api::token().unwrap_or_default());
    match http::request(endpoint, "POST", "/shutdown", &[("Authorization", auth.as_str())], Some(body.as_bytes()), Some(Duration::from_secs(30))) {
        Ok(response) if (200..300).contains(&response.status) => {}
        // It went away on its own, or another process replaced it first.
        Err(http::Error::Unreachable(_)) => {}
        Ok(response) if response.status == 409 && gone(endpoint, instance) => {}
        Ok(response) => {
            let value: Value = serde_json::from_slice(&response.body).unwrap_or(Value::Null);
            let message = value.get("error").and_then(|e| e.get("message").or(Some(e))).and_then(Value::as_str).map(str::to_owned);
            let message = message.unwrap_or_else(|| String::from_utf8_lossy(&response.body).trim().to_owned());
            bail!("the older browse relay ({running}) didn't stop for browse {VERSION}: {message}");
        }
        Err(error) => bail!("the older browse relay ({running}) didn't stop for browse {VERSION}: {error}"),
    }
    let deadline = Instant::now() + Duration::from_secs(30);
    while !gone(endpoint, instance) {
        if Instant::now() > deadline {
            bail!("the older browse relay ({running}) accepted the shutdown but is still running");
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    // The relay removes relay.json after its last write (cli/src/relay.ts cleanup), and relays 0.0.6-0.0.16 never wrote
    // one: wait for the record when there is one, else for its pid, so an uninstall that follows doesn't delete
    // browse's folders under a relay that is still writing them.
    loop {
        let writing = recorded && browse_relay::port::read_relay_state(&paths, configured).is_some_and(|state| state.instance_id == instance);
        let alive = pid.is_some_and(browse_relay::process_alive);
        let waiting = if recorded { writing && (pid.is_none() || alive) } else { alive };
        if !waiting {
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
/// another program's server may answer. Transport errors are kept apart too: a relay that reset the connection or
/// stalled while shutting down is not gone yet, unlike one whose port nothing accepts any more.
fn gone(endpoint: &str, instance: &str) -> bool {
    match relay::answer_at(endpoint, Duration::from_secs(5)) {
        // Nothing accepted the connection: the relay left the port.
        Err(http::Error::Unreachable(_)) => true,
        // It accepted but reset, stalled past the timeout or sent something unreadable: it may still be exiting.
        Err(http::Error::Io(_)) => false,
        // A complete answer that isn't a browse relay: something else holds the port now.
        Ok(relay::Answer::Other) => true,
        // A browse relay that is starting has not proved this instance left.
        Ok(relay::Answer::Starting) => false,
        Ok(relay::Answer::Browse(version)) => version.get("instanceId").and_then(Value::as_str) != Some(instance),
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
    let (endpoint, found) = relay::probe_endpoint();
    let relay::Probe::Running(version) = found else { return Ok(0) };
    if !is_legacy(&version) {
        return Ok(0);
    }
    if let Err(error) = stop(&endpoint, &version, force) {
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

    /// What a [`FakeServer`] does after accepting and reading a request.
    #[derive(Clone, Copy)]
    enum Reply {
        Body(&'static str),
        /// Hold the connection open without answering; the client's read timeout is the answer.
        Silent,
        /// Close the connection without answering.
        Close,
    }

    /// One HTTP server on a free loopback port (never 19988–19997), handling every request with `reply` until stopped.
    struct FakeServer {
        endpoint: String,
        stop: Arc<AtomicBool>,
        thread: Option<std::thread::JoinHandle<()>>,
    }

    impl FakeServer {
        fn start(body: &'static str) -> Self {
            Self::serve(Reply::Body(body))
        }

        fn silent() -> Self {
            Self::serve(Reply::Silent)
        }

        fn closing() -> Self {
            Self::serve(Reply::Close)
        }

        fn serve(reply: Reply) -> Self {
            let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
            listener.set_nonblocking(true).unwrap();
            let endpoint = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
            let stop = Arc::new(AtomicBool::new(false));
            let stopping = stop.clone();
            let thread = std::thread::spawn(move || {
                while !stopping.load(Ordering::SeqCst) {
                    match listener.accept() {
                        Ok((mut stream, _)) => {
                            // Accepted sockets can inherit non-blocking mode; read the request blocking with a short
                            // timeout so the answer (or the silence) is deterministic on macOS and Windows too.
                            stream.set_nonblocking(false).ok();
                            stream.set_read_timeout(Some(Duration::from_millis(500))).ok();
                            let mut request = [0u8; 2048];
                            let _ = stream.read(&mut request);
                            match reply {
                                Reply::Body(body) => {
                                    let response = format!(
                                        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                                        body.len()
                                    );
                                    let _ = stream.write_all(response.as_bytes());
                                }
                                // Holding the stream here leaves the client waiting for its read timeout.
                                Reply::Silent => while !stopping.load(Ordering::SeqCst) {
                                    std::thread::sleep(Duration::from_millis(10));
                                },
                                // Dropping the stream without writing closes the connection.
                                Reply::Close => {}
                            }
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

    /// A relay still shutting down may accept the connection and stall. That is not proof it is gone, or a stop would
    /// report a relay that is still writing its files as finished.
    #[test]
    fn a_relay_that_stalls_is_not_gone_while_it_may_still_be_stopping() {
        // The 5s /version read timeout is the point of this case, so the test takes that long.
        let stalling = FakeServer::silent();
        assert!(!gone(&stalling.endpoint, "legacy-instance"));
    }

    /// A relay closing its listener as it exits can reset the probe's connection. That too is not proof it is gone.
    #[test]
    fn a_relay_that_closes_the_connection_is_not_gone_while_it_may_still_be_stopping() {
        let closing = FakeServer::closing();
        assert!(!gone(&closing.endpoint, "legacy-instance"));
    }
}
