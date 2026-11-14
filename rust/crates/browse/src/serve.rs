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

pub fn run() -> anyhow::Result<i32> {
    let managed = std::env::var("OPENCODE_BROWSER_MANAGED_RELAY").as_deref() == Ok("1");
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
        let updater = if managed { update::Updater::spawn() } else { None };
        let mut notice = None;
        let mut restart = false;
        let mut tick = tokio::time::interval(Duration::from_secs(5));
        let stop = signalled();
        tokio::pin!(stop);
        loop {
            tokio::select! {
                _ = &mut stop => break,
                _ = tick.tick() => {}
            }
            if handle.relay.is_stopping() {
                break;
            }
            let Some(updater) = &updater else { continue };
            let pending = update::pending_notice();
            if pending != notice {
                notice = pending;
                handle.update_notice(notice.clone());
            }
            if updater.changed() && handle.idle(QUIET) {
                restart = true;
                break;
            }
        }
        handle.stop();
        handle.wait().await;
        anyhow::Ok(restart)
    })?;
    drop(runtime);
    if restart {
        // The port is free again: start the updated executable in our place.
        relay::start()?;
    }
    Ok(0)
}
