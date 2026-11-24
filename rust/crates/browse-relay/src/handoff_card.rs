//! The handoff card in a directly driven tab (no extension to show one): drawn by browse's isolated world in a closed
//! shadow root at the end of the document, built with DOM calls alone (no markup, no style sheets) so a strict CSP or
//! Trusted Types can't stop it. A click counts only when it is the user's (trusted), lands on the card itself, and the
//! card is shown as drawn: nothing over it, nothing fading, moving or filtering it or the page.

use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail};
use browse_core::{CallOptions, Evaluated, FrameId, PageEvent, Realm, Returns, TabDriver, World};
use serde_json::{Value, json};
use tokio::sync::broadcast;

/// How long the first card may take to appear before the handoff fails.
const SHOW_TIMEOUT: Duration = Duration::from_secs(3);
/// How long one wait for a click lasts in the page before it answers "pending".
const WAIT_MS: u64 = 15_000;

/// Draws the card (once per handoff id per document) and returns true; false once the deadline has passed.
pub const INSTALL: &str = r#"/*browse-handoff:install*/(id, message, deadline) => {
  const g = globalThis;
  const all = g.__browseHandoffs || (g.__browseHandoffs = {});
  const results = g.__browseHandoffResults || (g.__browseHandoffResults = {});
  if (results[id]) return true;
  const existing = all[id];
  if (existing && existing.host.isConnected) { existing.ensure(); return true; }
  if (existing) existing.remove(null);
  if (Date.now() >= deadline || !document.documentElement) return false;
  const imp = (el, props) => { for (const key of Object.keys(props)) el.style.setProperty(key, props[key], 'important'); };
  const hostStyle = {
    all: 'initial', display: 'block', position: 'fixed', right: '16px', bottom: '16px', left: 'auto', top: 'auto',
    width: '340px', 'max-width': 'calc(100vw - 32px)', margin: '0', padding: '0', border: '0',
    'z-index': '2147483647', opacity: '1', transform: 'none', filter: 'none', visibility: 'visible',
    'pointer-events': 'auto', 'clip-path': 'none', mask: 'none', contain: 'none', isolation: 'isolate', zoom: '1',
  };
  const host = document.createElement('browse-handoff');
  const root = host.attachShadow({ mode: 'closed' });
  const card = document.createElement('div');
  imp(card, {
    display: 'block', 'box-sizing': 'border-box', padding: '14px 16px', background: '#ffffff', color: '#111827',
    border: '1px solid #2563eb', 'border-radius': '10px', 'box-shadow': '0 8px 28px rgba(0,0,0,.28)',
    font: '14px/1.4 system-ui, -apple-system, Segoe UI, sans-serif', 'text-align': 'left',
  });
  const title = document.createElement('div');
  title.textContent = 'browse is waiting for you';
  imp(title, { 'font-weight': '600', color: '#2563eb', 'margin-bottom': '6px' });
  const text = document.createElement('div');
  text.textContent = message;
  imp(text, { 'white-space': 'pre-wrap', 'margin-bottom': '12px', 'word-break': 'break-word' });
  const row = document.createElement('div');
  imp(row, { display: 'flex', gap: '8px', 'justify-content': 'flex-end' });
  const button = (label, primary) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    imp(b, {
      font: 'inherit', cursor: 'pointer', padding: '6px 14px', 'border-radius': '6px',
      border: primary ? '1px solid #2563eb' : '1px solid #d1d5db',
      background: primary ? '#2563eb' : '#ffffff', color: primary ? '#ffffff' : '#111827',
    });
    return b;
  };
  const cancel = button('Cancel', false);
  const proceed = button('Continue', true);
  row.append(cancel, proceed);
  card.append(title, text, row);
  root.append(card);
  const s = { id, host, armedAt: performance.now(), waiters: [] };
  const observer = new MutationObserver(() => s.ensure(true));
  const watch = () => observer.observe(host, { attributes: true });
  s.restyle = () => { observer.disconnect(); imp(host, hostStyle); observer.takeRecords(); watch(); };
  s.ensure = (rearm) => {
    s.restyle();
    const el = document.documentElement;
    if (el && (host.parentNode !== el || host.nextSibling !== null)) { el.appendChild(host); rearm = true; }
    if (rearm) s.armedAt = performance.now();
  };
  s.remove = (result) => {
    observer.disconnect();
    removeEventListener('pagehide', onHide, true);
    clearTimeout(timer);
    host.remove();
    if (all[id] === s) delete all[id];
    for (const w of s.waiters.splice(0)) w(result);
  };
  const shown = (node) => {
    const cs = getComputedStyle(node);
    return cs.opacity === '1' && cs.transform === 'none' && cs.filter === 'none';
  };
  const covered = () => {
    const r = host.getBoundingClientRect();
    for (const selector of [':popover-open', ':modal', ':fullscreen']) {
      let list;
      try { list = document.querySelectorAll(selector); } catch (e) { continue; }
      for (const other of list) {
        if (other === host) continue;
        const b = other.getBoundingClientRect();
        if (b.right > r.left && b.left < r.right && b.bottom > r.top && b.top < r.bottom) return true;
      }
    }
    return false;
  };
  const valid = (event) => {
    const el = document.documentElement;
    return event.isTrusted === true
      && performance.now() - s.armedAt >= 500
      && host.isConnected && host.parentNode === el && host.nextSibling === null
      && document.elementFromPoint(event.clientX, event.clientY) === host
      && shown(host) && shown(el)
      && !covered();
  };
  const choose = (outcome) => (event) => {
    event.stopPropagation();
    if (!valid(event)) { s.ensure(true); return; }
    results[id] = outcome;
    s.remove(outcome);
  };
  proceed.addEventListener('click', choose('continue'));
  cancel.addEventListener('click', choose('cancel'));
  const onHide = () => s.remove(null);
  addEventListener('pagehide', onHide, true);
  const timer = setTimeout(() => s.remove(null), Math.max(0, deadline - Date.now()));
  all[id] = s;
  s.ensure(true);
  return true;
}"#;

/// Waits up to `ms` for a click: "continue", "cancel", "pending" (no click yet), or null (no card in this document).
pub const WAIT: &str = r#"/*browse-handoff:wait*/(id, ms) => {
  const results = globalThis.__browseHandoffResults || {};
  if (results[id]) return results[id];
  const s = (globalThis.__browseHandoffs || {})[id];
  if (!s || !s.host.isConnected) return null;
  s.ensure(false);
  return new Promise((resolve) => {
    const waiter = (result) => { clearTimeout(timer); resolve(result); };
    const timer = setTimeout(() => {
      const i = s.waiters.indexOf(waiter);
      if (i >= 0) s.waiters.splice(i, 1);
      resolve('pending');
    }, ms);
    s.waiters.push(waiter);
  });
}"#;

/// Takes the card down.
pub const REMOVE: &str = r#"/*browse-handoff:remove*/(id) => {
  const s = (globalThis.__browseHandoffs || {})[id];
  if (s) s.remove(null);
  if (globalThis.__browseHandoffResults) delete globalThis.__browseHandoffResults[id];
  return true;
}"#;

async fn main_frame(driver: &Arc<dyn TabDriver>) -> anyhow::Result<FrameId> {
    let frames = driver.frames().await?;
    frames.into_iter().next().map(|f| f.id).ok_or_else(|| anyhow!("the tab has no page"))
}

async fn evaluate(driver: &Arc<dyn TabDriver>, frame: &FrameId, expression: String, await_promise: bool) -> anyhow::Result<Value> {
    let realm = Realm { frame: frame.clone(), world: World::Isolated };
    let opts = CallOptions { returns: Returns::Json, await_promise, user_activation: false };
    match driver.evaluate(&realm, &expression, opts).await? {
        Ok(Evaluated::Json(value)) => Ok(value),
        Ok(_) => Ok(Value::Null),
        Err(error) => Err(anyhow!("{}", error.message)),
    }
}

/// After a failure (a navigation swapped the document): the next page event, or a short pause.
async fn settle(events: &mut broadcast::Receiver<PageEvent>) {
    if let Ok(Err(broadcast::error::RecvError::Closed)) = tokio::time::timeout(Duration::from_millis(300), events.recv()).await {
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}

/// Shows the card until the user clicks it: "continued" or "cancelled". It is drawn again in every new document.
pub async fn run(driver: Arc<dyn TabDriver>, id: &str, message: &str, deadline: u64) -> anyhow::Result<&'static str> {
    let mut events = driver.events();
    let started = Instant::now();
    let mut shown = false;
    let install = format!("({INSTALL})({}, {}, {deadline})", json!(id), json!(message));
    let wait = format!("({WAIT})({}, {WAIT_MS})", json!(id));
    loop {
        let installed = match main_frame(&driver).await {
            Ok(frame) => match evaluate(&driver, &frame, install.clone(), false).await {
                Ok(Value::Bool(true)) => Ok(frame),
                Ok(_) => Err(anyhow!("the card couldn't be drawn")),
                Err(error) => Err(error),
            },
            Err(error) => Err(error),
        };
        let frame = match installed {
            Ok(frame) => frame,
            Err(error) => {
                if !shown && started.elapsed() >= SHOW_TIMEOUT {
                    bail!("{error}");
                }
                settle(&mut events).await;
                continue;
            }
        };
        shown = true;
        loop {
            match evaluate(&driver, &frame, wait.clone(), true).await {
                Ok(Value::String(outcome)) if outcome == "continue" => return Ok("continued"),
                Ok(Value::String(outcome)) if outcome == "cancel" => return Ok("cancelled"),
                Ok(Value::String(_)) => continue,
                Ok(_) => break,
                Err(_) => {
                    settle(&mut events).await;
                    break;
                }
            }
        }
    }
}

/// Takes the card down, best effort.
pub async fn remove(driver: Arc<dyn TabDriver>, id: &str) {
    let Ok(frame) = main_frame(&driver).await else { return };
    let _ = evaluate(&driver, &frame, format!("({REMOVE})({})", json!(id)), false).await;
}
