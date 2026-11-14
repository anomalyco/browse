//! Navigation and waiting: goto/back/forward/reload with load, domcontentloaded, commit or settle (network quiet
//! and DOM quiet, capped), and wait_for conditions.

use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Result, anyhow, bail};
use serde_json::{Value, json};

use crate::page::{TabEvent, TabPage, v};
use crate::state::PageSession;
use crate::target::{self, ResolveOptions, Spec};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WaitUntil {
    None,
    Commit,
    DomContentLoaded,
    Load,
    Settle,
}

impl WaitUntil {
    pub fn parse(value: Option<&str>) -> Result<WaitUntil> {
        Ok(match value.unwrap_or("load") {
            "none" => WaitUntil::None,
            "commit" => WaitUntil::Commit,
            "domcontentloaded" | "DOMContentLoaded" => WaitUntil::DomContentLoaded,
            "load" => WaitUntil::Load,
            "settle" | "networkidle" => WaitUntil::Settle,
            other => bail!("waitUntil must be load, domcontentloaded, settle, commit or none; got {other:?}"),
        })
    }
}

/// `example.com` → `https://example.com`, `localhost:3000` / `:3000` → `http://localhost:3000`.
pub fn normalize_url(url: &str) -> String {
    let url = url.trim();
    if url.contains("://") || ["about:", "data:", "blob:", "file:", "chrome:", "javascript:", "view-source:"].iter().any(|p| url.starts_with(p)) {
        return url.to_string();
    }
    if let Some(port) = url.strip_prefix(':') {
        return format!("http://localhost:{port}");
    }
    let host = url.split(['/', '?', '#']).next().unwrap_or("");
    let bare = host.split(':').next().unwrap_or("");
    if bare == "localhost" || bare.ends_with(".localhost") || bare == "127.0.0.1" || bare == "[::1]" || bare.starts_with("192.168.") || bare.starts_with("10.") {
        return format!("http://{url}");
    }
    format!("https://{url}")
}

fn ready_state_matches(state: &str, name: &str) -> bool {
    match name {
        "load" => state == "complete",
        "DOMContentLoaded" => state == "interactive" || state == "complete",
        _ => false,
    }
}

/// Waits for a lifecycle state of the main frame's current document (`loader` when known), falling back to
/// document.readyState for documents restored from the back/forward cache, which fire no lifecycle events.
pub async fn wait_lifecycle(page: &Arc<TabPage>, name: &str, loader: Option<&str>, deadline: Instant) -> bool {
    let mut last_probe = Instant::now();
    loop {
        if page.dialog().is_some() {
            return true;
        }
        let main = page.main_frame();
        if let Some(frame) = page.frame(&main) {
            let right_document = loader.map(|l| frame.loader_id == l).unwrap_or(true);
            if right_document && frame.lifecycle.contains(name) {
                return true;
            }
            if right_document && last_probe.elapsed() >= Duration::from_millis(400) {
                last_probe = Instant::now();
                if let Ok(Ok(info)) = tokio::time::timeout(Duration::from_millis(500), page.call_value(&main, "frameInfo", vec![], false)).await
                    && ready_state_matches(info["readyState"].as_str().unwrap_or(""), name) {
                        return true;
                    }
            }
        }
        if Instant::now() >= deadline {
            return false;
        }
        let mut rx = page.subscribe();
        let _ = tokio::time::timeout(Duration::from_millis(100).min(deadline.saturating_duration_since(Instant::now())), rx.changed()).await;
    }
}

/// After load: the network goes quiet (Chrome's networkAlmostIdle) and the DOM stops changing, within a cap.
pub async fn settle(page: &Arc<TabPage>, deadline: Instant) {
    let cap = deadline.min(Instant::now() + Duration::from_secs(5));
    let main = page.main_frame();
    page.wait_until(cap.saturating_duration_since(Instant::now()), Duration::from_millis(100), |page| {
        page.lifecycle_has(&main, "networkAlmostIdle") || page.lifecycle_has(&main, "networkIdle") || page.dialog().is_some()
    })
    .await;
    if page.dialog().is_none() {
        let left = deadline.saturating_duration_since(Instant::now()).as_millis().min(2_000) as u64;
        if left > 50 {
            let _ = tokio::time::timeout(Duration::from_millis(left + 200), page.call_value(&main, "quiet", vec![v(300), v(left)], false)).await;
        }
    }
}

async fn wait_for_state(page: &Arc<TabPage>, wait: WaitUntil, loader: Option<&str>, deadline: Instant) -> bool {
    match wait {
        WaitUntil::None => true,
        WaitUntil::Commit => {
            let Some(loader) = loader else { return true };
            page.wait_until(deadline.saturating_duration_since(Instant::now()), Duration::from_millis(50), |page| {
                page.frame(&page.main_frame()).map(|f| f.loader_id == loader).unwrap_or(false) || page.dialog().is_some()
            })
            .await
        }
        WaitUntil::DomContentLoaded => wait_lifecycle(page, "DOMContentLoaded", loader, deadline).await,
        WaitUntil::Load => wait_lifecycle(page, "load", loader, deadline).await,
        WaitUntil::Settle => {
            let loaded = wait_lifecycle(page, "load", loader, deadline).await;
            if loaded {
                settle(page, deadline).await;
            }
            loaded
        }
    }
}

pub struct NavResult {
    pub timed_out: bool,
}

pub async fn goto(page: &Arc<TabPage>, url: &str, wait: WaitUntil, timeout: Duration, referrer: Option<&str>) -> Result<NavResult> {
    let deadline = Instant::now() + timeout;
    let mut params = json!({ "url": url });
    if let Some(referrer) = referrer {
        params["referrer"] = json!(referrer);
    }
    let result = page.send("Page.navigate", params, None).await?;
    if let Some(error) = result["errorText"].as_str().filter(|e| !e.is_empty()) {
        if error.contains("ERR_ABORTED") {
            bail!("Navigation to {url} was aborted ({error}): the response may be a download, or the page cancelled it");
        }
        bail!("Navigation to {url} failed: {error}");
    }
    let loader = result["loaderId"].as_str().map(str::to_string);
    let ok = wait_for_state(page, wait, loader.as_deref(), deadline).await;
    Ok(NavResult { timed_out: !ok })
}

pub async fn history(page: &Arc<TabPage>, delta: i64, wait: WaitUntil, timeout: Duration) -> Result<Option<NavResult>> {
    let deadline = Instant::now() + timeout;
    let history = page.send("Page.getNavigationHistory", json!({}), None).await?;
    let index = history["currentIndex"].as_i64().unwrap_or(0) + delta;
    let entries = history["entries"].as_array().cloned().unwrap_or_default();
    let Some(entry) = usize::try_from(index).ok().and_then(|i| entries.get(i)) else {
        return Ok(None);
    };
    let seq = page.event_seq();
    page.send("Page.navigateToHistoryEntry", json!({ "entryId": entry["id"] }), None).await?;
    let committed = page
        .wait_until(deadline.saturating_duration_since(Instant::now()), Duration::from_millis(50), |page| {
            page.events_since(seq).iter().any(|e| matches!(e, TabEvent::Navigated { .. })) || page.dialog().is_some()
        })
        .await;
    if !committed {
        return Ok(Some(NavResult { timed_out: true }));
    }
    let same_document = page.events_since(seq).iter().all(|e| !matches!(e, TabEvent::Navigated { same_document: false, .. }));
    let ok = if same_document { true } else { wait_for_state(page, wait, None, deadline).await };
    Ok(Some(NavResult { timed_out: !ok }))
}

pub async fn reload(page: &Arc<TabPage>, wait: WaitUntil, timeout: Duration, ignore_cache: bool) -> Result<NavResult> {
    let deadline = Instant::now() + timeout;
    let seq = page.event_seq();
    page.send("Page.reload", json!({ "ignoreCache": ignore_cache }), None).await?;
    let committed = page
        .wait_until(deadline.saturating_duration_since(Instant::now()), Duration::from_millis(50), |page| {
            page.events_since(seq).iter().any(|e| matches!(e, TabEvent::Navigated { same_document: false, .. })) || page.dialog().is_some()
        })
        .await;
    if !committed {
        return Ok(NavResult { timed_out: true });
    }
    let loader = page.frame(&page.main_frame()).map(|f| f.loader_id);
    let ok = wait_for_state(page, wait, loader.as_deref(), deadline).await;
    Ok(NavResult { timed_out: !ok })
}

/// A URL pattern: `/regex/flags`, a glob with `*` (`**` also crosses `/`), or a substring.
pub fn url_matches(pattern: &str, url: &str) -> Result<bool> {
    if pattern.len() > 2 && pattern.starts_with('/')
        && let Some(end) = pattern.rfind('/').filter(|e| *e > 0) {
            let flags = &pattern[end + 1..];
            if flags.chars().all(|c| "gimsuy".contains(c)) {
                let prefix = if flags.contains('i') { "(?i)" } else { "" };
                let regex = regex_lite::Regex::new(&format!("{prefix}{}", &pattern[1..end])).map_err(|e| anyhow!("Invalid url pattern {pattern}: {e}"))?;
                return Ok(regex.is_match(url));
            }
        }
    if pattern.contains('*') {
        let mut regex = String::from("^");
        let chars: Vec<char> = pattern.chars().collect();
        let mut i = 0;
        while i < chars.len() {
            match chars[i] {
                '*' if chars.get(i + 1) == Some(&'*') => {
                    regex.push_str(".*");
                    i += 1;
                }
                '*' => regex.push_str("[^/]*"),
                c => regex.push_str(&regex_lite::escape(&c.to_string())),
            }
            i += 1;
        }
        regex.push('$');
        let regex = regex_lite::Regex::new(&regex)?;
        // A glob without a scheme matches anywhere after it.
        if regex.is_match(url) {
            return Ok(true);
        }
        if !pattern.contains("://") {
            let without_scheme = url.split_once("://").map(|(_, r)| r).unwrap_or(url);
            return Ok(regex.is_match(without_scheme));
        }
        return Ok(false);
    }
    Ok(url.contains(pattern))
}

#[derive(Debug, Default)]
pub struct WaitFor {
    pub text: Option<String>,
    pub text_gone: Option<String>,
    pub url: Option<String>,
    pub spec: Option<Spec>,
    pub state: String,
    pub load: Option<WaitUntil>,
    pub ms: Option<u64>,
}

async fn element_state(page: &Arc<TabPage>, session: &PageSession, spec: &Spec, state: &str) -> Result<bool> {
    let resolved = target::resolve(page, session, spec, ResolveOptions { timeout: Duration::ZERO, act: false }).await;
    let resolved = match resolved {
        Ok(resolved) => resolved,
        Err(error) => {
            let message = error.to_string();
            if message.contains("matches") && message.contains("elements") || message.contains("Invalid selector") || message.contains("Unknown snapshot ref") || message.contains("belongs to tab") || message.contains("stale after a page change") {
                return Err(error);
            }
            return Ok(matches!(state, "hidden" | "detached"));
        }
    };
    if state == "attached" {
        return Ok(true);
    }
    if state == "detached" {
        return Ok(false);
    }
    let visible = page.call_element(&resolved.element, "checkStates", vec![v(["visible"])], true).await?.as_str() == Some("ok");
    Ok(if state == "hidden" { !visible } else { visible })
}

/// Waits until every given condition holds. Returns a description of what was waited for.
pub async fn wait_for(page: &Arc<TabPage>, session: &PageSession, conditions: &WaitFor, timeout: Duration) -> Result<String> {
    if let Some(ms) = conditions.ms {
        tokio::time::sleep(Duration::from_millis(ms.min(120_000))).await;
    }
    let deadline = Instant::now() + timeout;
    let mut waiting_for = Vec::new();
    if let Some(load) = conditions.load {
        waiting_for.push(format!("load state {load:?}"));
        if !wait_for_state(page, load, None, deadline).await {
            bail!("Timed out after {} ms waiting for the page to reach {:?}", timeout.as_millis(), load);
        }
    }
    if let Some(text) = &conditions.text {
        waiting_for.push(format!("text {text:?}"));
    }
    if let Some(text) = &conditions.text_gone {
        waiting_for.push(format!("text {text:?} to disappear"));
    }
    if let Some(url) = &conditions.url {
        waiting_for.push(format!("url {url:?}"));
    }
    if let Some(spec) = &conditions.spec {
        waiting_for.push(format!("{} to be {}", spec.label(), conditions.state));
    }
    loop {
        page.ensure_no_dialog()?;
        let mut ok = true;
        let main = page.main_frame();
        if ok
            && let Some(pattern) = &conditions.url {
                ok = url_matches(pattern, &page.main_url())?;
            }
        if ok
            && let Some(text) = &conditions.text {
                ok = page.call_value(&main, "hasText", vec![v(text)], false).await.map(|v| v.as_bool() == Some(true)).unwrap_or(false);
            }
        if ok
            && let Some(text) = &conditions.text_gone {
                ok = page.call_value(&main, "hasText", vec![v(text)], false).await.map(|v| v.as_bool() == Some(false)).unwrap_or(false);
            }
        if ok
            && let Some(spec) = &conditions.spec {
                ok = element_state(page, session, spec, &conditions.state).await?;
            }
        if ok {
            return Ok(waiting_for.join(", "));
        }
        if Instant::now() >= deadline {
            bail!("Timed out after {} ms waiting for {}", timeout.as_millis(), if waiting_for.is_empty() { "nothing".into() } else { waiting_for.join(", ") });
        }
        let mut rx = page.subscribe();
        let _ = tokio::time::timeout(Duration::from_millis(150).min(deadline.saturating_duration_since(Instant::now())), rx.changed()).await;
    }
}

pub fn parse_wait_for(args: &Value) -> Result<WaitFor> {
    let string = |key: &str| args.get(key).and_then(Value::as_str).map(str::to_string);
    let state = string("state").unwrap_or_else(|| "visible".into());
    if !matches!(state.as_str(), "visible" | "hidden" | "attached" | "detached") {
        bail!("state must be visible, hidden, attached or detached");
    }
    let load = match string("load") {
        Some(load) => Some(WaitUntil::parse(Some(&load))?),
        None => None,
    };
    Ok(WaitFor { text: string("text"), text_gone: string("textGone"), url: string("url"), spec: Spec::from_args(args), state, load, ms: args.get("ms").and_then(Value::as_u64) })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls_normalize() {
        assert_eq!(normalize_url("example.com"), "https://example.com");
        assert_eq!(normalize_url(":3000/x"), "http://localhost:3000/x");
        assert_eq!(normalize_url("localhost:8080"), "http://localhost:8080");
        assert_eq!(normalize_url("https://a.b/c"), "https://a.b/c");
        assert_eq!(normalize_url("about:blank"), "about:blank");
        assert_eq!(normalize_url("data:text/html,hi"), "data:text/html,hi");
    }

    #[test]
    fn url_patterns() {
        assert!(url_matches("/checkout", "https://shop.example/checkout?x").unwrap());
        assert!(url_matches("**/orders/*", "https://shop.example/orders/12").unwrap());
        assert!(!url_matches("**/orders/*", "https://shop.example/orders/12/items").unwrap());
        assert!(url_matches("/orders\\/\\d+$/", "https://shop.example/orders/12").unwrap());
        assert!(url_matches("/ORDERS/i", "https://shop.example/orders/12").unwrap());
    }
}
