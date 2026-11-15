//! Ends a relay that stopped working, so the next client call starts a fresh one: its state lock held too long, its
//! runtime no longer running tasks, or a SIGTERM/SIGINT it couldn't finish within a grace period. It runs on its own
//! OS thread, so a runtime whose workers are all blocked can't stop it.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Once, Weak};
use std::time::{Duration, Instant};

use crate::relay::Relay;
use crate::rlog;

/// A SIGTERM or SIGINT arrived.
static SIGNALLED: AtomicBool = AtomicBool::new(false);
static SIGNALS: Once = Once::new();

/// How long a shutdown signal may take before the process exits anyway.
const SIGNAL_GRACE: Duration = Duration::from_secs(5);
const TICK: Duration = Duration::from_millis(250);

/// The state lock may be held this long (OPENCODE_BROWSER_WATCHDOG_MS, 0 turns the watchdog off).
fn lock_limit() -> Option<Duration> {
    let ms = std::env::var("OPENCODE_BROWSER_WATCHDOG_MS").ok().and_then(|v| v.trim().parse::<u64>().ok()).unwrap_or(10_000);
    (ms > 0).then(|| Duration::from_millis(ms))
}

/// Notes SIGTERM and SIGINT next to whatever else handles them (tokio's handlers keep working).
fn watch_signals() {
    #[cfg(unix)]
    SIGNALS.call_once(|| {
        for signal in [libc::SIGTERM, libc::SIGINT] {
            // SAFETY: the action only stores to an atomic, which is async-signal-safe.
            let _ = unsafe { signal_hook_registry::register(signal, || SIGNALLED.store(true, Ordering::SeqCst)) };
        }
    });
}

/// Keeps `relay.heartbeat` moving while the runtime runs tasks; `finished` is set when the task goes, which also
/// happens when its runtime shuts down.
pub async fn heartbeat(relay: Arc<Relay>) {
    struct Finished(Arc<Relay>);
    impl Drop for Finished {
        fn drop(&mut self) {
            self.0.finished.store(true, Ordering::SeqCst);
        }
    }
    let finished = Finished(relay);
    let mut interval = tokio::time::interval(Duration::from_secs(1));
    loop {
        interval.tick().await;
        finished.0.heartbeat.fetch_add(1, Ordering::SeqCst);
    }
}

pub fn spawn(relay: &Arc<Relay>) {
    watch_signals();
    let Some(limit) = lock_limit() else { return };
    let weak = Arc::downgrade(relay);
    let _ = std::thread::Builder::new().name("browse-watchdog".into()).spawn(move || watch(weak, limit));
}

fn watch(weak: Weak<Relay>, limit: Duration) {
    let runtime_limit = (limit * 2).max(Duration::from_secs(20));
    let mut beat = (u64::MAX, Instant::now());
    let mut signalled_at: Option<Instant> = None;
    loop {
        std::thread::sleep(TICK);
        let Some(relay) = weak.upgrade() else { return };
        if relay.finished.load(Ordering::SeqCst) {
            return;
        }
        let now = Instant::now();
        if SIGNALLED.load(Ordering::SeqCst) {
            let since = *signalled_at.get_or_insert(now);
            if now - since >= SIGNAL_GRACE {
                fatal(&relay, "relay.shutdown.forced", &format!("a shutdown signal wasn't handled within {} s", SIGNAL_GRACE.as_secs()), 143);
            }
        }
        let holder = *relay.holder.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(holder) = holder.filter(|h| now.saturating_duration_since(h.since) >= limit) {
            fatal(
                &relay,
                "relay.lock.stuck",
                &format!("the state lock was taken at {} on {:?} and held for {} ms", holder.at, holder.thread, now.saturating_duration_since(holder.since).as_millis()),
                70,
            );
        }
        let count = relay.heartbeat.load(Ordering::SeqCst);
        if count != beat.0 {
            beat = (count, now);
        } else if count > 0 && now - beat.1 >= runtime_limit {
            fatal(&relay, "relay.runtime.stuck", &format!("the runtime ran no task for {} ms (its workers are blocked)", (now - beat.1).as_millis()), 70);
        }
    }
}

/// Logs what was going on and exits; the relay's port file goes first so clients start a fresh relay.
fn fatal(relay: &Relay, event: &str, reason: &str, code: i32) -> ! {
    let inflight: Vec<String> = match relay.inflight.try_lock() {
        Ok(calls) => {
            let mut calls: Vec<_> = calls.iter().map(|(id, c)| format!("#{id} {} tab={} for {} ms", c.tool, c.tab.map(|t| t.to_string()).unwrap_or_else(|| "-".into()), c.since.elapsed().as_millis())).collect();
            calls.sort();
            calls
        }
        Err(_) => vec!["(unknown: the in-flight list is locked)".into()],
    };
    rlog!(event, reason = reason, calls = inflight.join("; "), pid = std::process::id());
    eprintln!("[browse relay] {event}: {reason}; exiting");
    crate::port::remove_relay_state(&relay.paths, relay.configured_port, &relay.instance_id);
    std::process::exit(code);
}
