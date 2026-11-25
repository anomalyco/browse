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
        Ok(response) if response.status == 409 && gone(instance) => {}
        Ok(response) => {
            let value: Value = serde_json::from_slice(&response.body).unwrap_or(Value::Null);
            let message = value.get("error").and_then(|e| e.get("message").or(Some(e))).and_then(Value::as_str).map(str::to_owned);
            let message = message.unwrap_or_else(|| String::from_utf8_lossy(&response.body).trim().to_owned());
            bail!("the older browse relay ({running}) didn't stop for browse {VERSION}: {message}");
        }
        Err(error) => bail!("the older browse relay ({running}) didn't stop for browse {VERSION}: {error}"),
    }
    let deadline = Instant::now() + Duration::from_secs(30);
    while !gone(instance) {
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

/// Whether the relay instance `instance` no longer answers.
fn gone(instance: &str) -> bool {
    match relay::probe() {
        relay::Probe::Running(version) => version.get("instanceId").and_then(Value::as_str) != Some(instance),
        relay::Probe::Absent => true,
        relay::Probe::Foreign(_) => false,
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
