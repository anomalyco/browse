//! `browse serve`: the relay in the foreground, with every tool this build links in. A relay started on demand
//! (OPENCODE_BROWSER_MANAGED_RELAY=1) also keeps itself updated and restarts on a new executable once idle.

use std::sync::Arc;
use std::time::Duration;

use browse_relay::ServeOptions;

use crate::{VERSION, relay, update};

/// How long no agent may have used the browser before an update restarts the relay.
const QUIET: Duration = Duration::from_secs(120);

pub const BUILD_ID: &str = match option_env!("BROWSE_BUILD_ID") {
    Some(id) => id,
    None => VERSION,
};

async fn signalled() {
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
}

/// QUIET, or less with OPENCODE_BROWSER_AUTO_UPDATE_QUIET_MS (for tests).
fn quiet() -> Duration {
    std::env::var("OPENCODE_BROWSER_AUTO_UPDATE_QUIET_MS").ok().and_then(|v| v.parse().ok()).map(Duration::from_millis).map_or(QUIET, |q| q.min(QUIET))
}

pub fn run() -> anyhow::Result<i32> {
    let managed = std::env::var("OPENCODE_BROWSER_MANAGED_RELAY").as_deref() == Ok("1");
    // While this executable's path still leads to its install: an update can move it aside (update::install).
    update::install();
    let quiet = quiet();
    let options = ServeOptions {
        version: VERSION.into(),
        build_id: BUILD_ID.into(),
        auto_update: Some(Arc::new(update::status_json)),
        ..ServeOptions::default()
    };
    let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build()?;
    let restart = runtime.block_on(async move {
        let handle = browse_relay::start(options, relay::local_tools()).await?;
        if !managed {
            eprintln!("browse relay listening at http://127.0.0.1:{}", handle.port());
        }
        let relay = handle.relay.clone();
        let mut updater = if managed { update::Updater::spawn(Arc::new(move || relay.idle(quiet))) } else { None };
        let mut notice = None;
        let mut restart = None;
        let mut tick = tokio::time::interval(Duration::from_secs(5));
        let stop = signalled();
        tokio::pin!(stop);
        loop {
            // POST /shutdown (a client's stop, an update) ends the relay task; exit with it instead of waiting for the
            // next tick, so the process is gone as soon as `browse uninstall` or `browse restart` sees it closed.
            let stopped = handle.relay.stopped.notified();
            tokio::pin!(stopped);
            stopped.as_mut().enable();
            if handle.relay.is_stopping() {
                break;
            }
            tokio::select! {
                _ = &mut stop => break,
                _ = &mut stopped => break,
                _ = tick.tick() => {}
            }
            let Some(updater) = &mut updater else { continue };
            let pending = update::pending_notice();
            if pending != notice {
                notice = pending;
                handle.update_notice(notice.clone());
            }
            if handle.idle(quiet)
                && let Some(next) = updater.replacement()
            {
                restart = Some(next);
                break;
            }
        }
        handle.stop();
        handle.wait().await;
        anyhow::Ok(restart)
    })?;
    drop(runtime);
    if let Some(next) = restart {
        // The port is free again: start the updated executable in our place.
        relay::start_from(&next)?;
    }
    Ok(0)
}
