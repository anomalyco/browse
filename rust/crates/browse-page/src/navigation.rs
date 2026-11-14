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

impl WaitUntil {
    /// The name users pass (`load`, `domcontentloaded`, …).
    pub fn name(self) -> &'static str {
        match self {
            WaitUntil::None => "none",
            WaitUntil::Commit => "commit",
            WaitUntil::DomContentLoaded => "domcontentloaded",
            WaitUntil::Load => "load",
            WaitUntil::Settle => "settle",
        }
    }
}

impl std::fmt::Display for WaitUntil {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.name())
    }
}

const WEB_SCHEMES: &[&str] = &["http", "https", "about", "data", "blob", "file", "view-source"];

/// `example.com` → `https://example.com`, `localhost:3000` / `:3000` → `http://localhost:3000`. Anything with a
/// scheme (`https:`, `mailto:`, `about:`, …) is left alone; only a bare host[:port][/path] gets one.
pub fn normalize_url(url: &str) -> Result<String> {
    let url = url.trim();
    if url.is_empty() {
        bail!("navigate needs a url; got an empty string");
    }
    if let Some(port) = url.strip_prefix(':') {
        return Ok(format!("http://localhost:{port}"));
    }
    if let Some((scheme, rest)) = url.split_once(':') {
        let is_scheme = scheme.chars().next().map(|c| c.is_ascii_alphabetic()).unwrap_or(false)
            && scheme.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'));
        // `host:8080/path` is a host and port, not a scheme.
        let port = rest.split(['/', '?', '#']).next().unwrap_or("");
        let is_port = !port.is_empty() && port.chars().all(|c| c.is_ascii_digit());
        if is_scheme && !is_port {
            let scheme = scheme.to_ascii_lowercase();
            if scheme == "javascript" {
                bail!("navigate can't run javascript: URLs; use eval to run code in the page");
            }
            // Other schemes hand the URL to another app (mailto:, tel:, sms:, intent:, zoommtg:, …), which takes
            // over the tab or the user's desktop.
            if !WEB_SCHEMES.contains(&scheme.as_str()) {
                bail!("navigate only opens web pages (http, https, about:blank, data:, blob:, file:, view-source:); {scheme}: URLs open another app, so browse doesn't follow them");
            }
            return Ok(url.to_string());
        }
    }
    if url.chars().any(char::is_whitespace) {
        bail!("{url:?} doesn't look like a URL; pass something like https://example.com or example.com/path");
    }
    let host = url.split(['/', '?', '#']).next().unwrap_or("");
    let bare = host.rsplit_once(':').filter(|(_, p)| p.chars().all(|c| c.is_ascii_digit())).map(|(h, _)| h).unwrap_or(host);
    if bare == "localhost" || bare.ends_with(".localhost") || bare == "127.0.0.1" || bare == "[::1]" || bare.starts_with("192.168.") || bare.starts_with("10.") {
        return Ok(format!("http://{url}"));
    }
    Ok(format!("https://{url}"))
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
        if page.blocking_dialog().is_some() {
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
        page.lifecycle_has(&main, "networkAlmostIdle") || page.lifecycle_has(&main, "networkIdle") || page.blocking_dialog().is_some()
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
                page.frame(&page.main_frame()).map(|f| f.loader_id == loader).unwrap_or(false) || page.blocking_dialog().is_some()
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

#[derive(Debug, Default)]
pub struct NavResult {
    pub timed_out: bool,
    /// The URL still loading when the wait ended: the tab still shows the previous document.
    pub pending: Option<String>,
}

/// Resolves when a dialog opens that browse won't answer by itself (beforeunload dialogs and an auto policy are
/// answered in the background, so a navigation just continues past them).
async fn blocking_dialog(page: &Arc<TabPage>) {
    let mut rx = page.subscribe();
    while page.blocking_dialog().is_none() {
        if rx.changed().await.is_err() {
            std::future::pending::<()>().await;
        }
    }
}

pub async fn goto(page: &Arc<TabPage>, url: &str, wait: WaitUntil, timeout: Duration, referrer: Option<&str>) -> Result<NavResult> {
    let deadline = Instant::now() + timeout;
    let mut params = json!({ "url": url });
    if let Some(referrer) = referrer {
        params["referrer"] = json!(referrer);
    }
    let seq = page.event_seq();
    // Page.navigate answers once the server responds, so a slow server would hold it past the timeout.
    let result = tokio::select! {
        result = page.send_raw("Page.navigate", params, None) => result?,
        _ = tokio::time::sleep_until(deadline.into()) => return Ok(NavResult { timed_out: true, pending: Some(url.to_string()) }),
        _ = blocking_dialog(page) => return Ok(NavResult::default()),
    };
    if let Some(error) = result["errorText"].as_str().filter(|e| !e.is_empty()) {
        // An HTTP error status with an empty body: Chrome shows its error page, but the server did answer.
        if error != "net::ERR_HTTP_RESPONSE_CODE_FAILURE" {
            let scheme = url.split(':').next().unwrap_or("").to_ascii_lowercase();
            if scheme == "data" {
                bail!("Navigation to the data: URL failed ({error}): Chrome blocks some top-level data: URL navigations. Serve the content from a real URL, or set it with eval (document.body.innerHTML = …)");
            }
            if error.contains("ERR_ABORTED") {
                bail!("Navigation to {url} was aborted ({error}): the response may be a download (check downloads), or the page cancelled it");
            }
            bail!("Navigation to {url} failed: {error}");
        }
    }
    let Some(loader) = result["loaderId"].as_str().map(str::to_string) else {
        // A same-document navigation (only the fragment changed): wait for the URL change to be seen.
        page.wait_until(deadline.saturating_duration_since(Instant::now()).min(Duration::from_millis(1_000)), Duration::from_millis(20), |page| {
            page.events_since(seq).iter().any(|e| matches!(e, TabEvent::Navigated { .. }))
        })
        .await;
        return Ok(NavResult::default());
    };
    let ok = wait_for_state(page, wait, Some(&loader), deadline).await;
    let committed = page.frame(&page.main_frame()).map(|f| f.loader_id == loader).unwrap_or(false);
    Ok(NavResult { timed_out: !ok, pending: (!committed && !ok).then(|| url.to_string()) })
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
    page.send_raw("Page.navigateToHistoryEntry", json!({ "entryId": entry["id"] }), None).await?;
    let committed = page
        .wait_until(deadline.saturating_duration_since(Instant::now()), Duration::from_millis(50), |page| {
            page.events_since(seq).iter().any(|e| matches!(e, TabEvent::Navigated { .. })) || page.blocking_dialog().is_some()
        })
        .await;
    if !committed {
        return Ok(Some(NavResult { timed_out: true, pending: page.pending_navigation() }));
    }
    let same_document = page.events_since(seq).iter().all(|e| !matches!(e, TabEvent::Navigated { same_document: false, .. }));
    let ok = if same_document { true } else { wait_for_state(page, wait, None, deadline).await };
    Ok(Some(NavResult { timed_out: !ok, pending: None }))
}

pub async fn reload(page: &Arc<TabPage>, wait: WaitUntil, timeout: Duration, ignore_cache: bool) -> Result<NavResult> {
    let deadline = Instant::now() + timeout;
    let seq = page.event_seq();
    page.send_raw("Page.reload", json!({ "ignoreCache": ignore_cache }), None).await?;
    let committed = page
        .wait_until(deadline.saturating_duration_since(Instant::now()), Duration::from_millis(50), |page| {
            page.events_since(seq).iter().any(|e| matches!(e, TabEvent::Navigated { same_document: false, .. })) || page.blocking_dialog().is_some()
        })
        .await;
    if !committed {
        return Ok(NavResult { timed_out: true, pending: page.pending_navigation() });
    }
    let loader = page.frame(&page.main_frame()).map(|f| f.loader_id);
    let ok = wait_for_state(page, wait, loader.as_deref(), deadline).await;
    Ok(NavResult { timed_out: !ok, pending: None })
}

/// Whether a pattern written as `/body/flags` is meant as a regular expression: flags from [dgimsuy] and a body
/// with regex syntax (`\\ ^ $ * + ? ( ) [ ] { } |`). A plain path such as `/docs/us` stays a substring.
fn as_regex(pattern: &str) -> Option<(&str, &str)> {
    if pattern.len() <= 2 || !pattern.starts_with('/') {
        return None;
    }
    let end = pattern.rfind('/').filter(|e| *e > 0)?;
    let (body, flags) = (&pattern[1..end], &pattern[end + 1..]);
    if !flags.chars().all(|c| "dgimsuy".contains(c)) {
        return None;
    }
    body.chars().any(|c| "\\^$*+?()[]{}|".contains(c)).then_some((body, flags))
}

pub fn regex_matches(body: &str, flags: &str, url: &str) -> Result<bool> {
    let prefix = if flags.contains('i') { "(?i)" } else { "" };
    let regex = regex_lite::Regex::new(&format!("{prefix}{body}")).map_err(|e| anyhow!("Invalid url regex /{body}/{flags}: {e}"))?;
    Ok(regex.is_match(url))
}

/// A URL pattern: `/regex/flags` (when the body uses regex syntax, see [as_regex]), a glob with `*` (`**` also
/// crosses `/`), or a substring.
pub fn url_matches(pattern: &str, url: &str) -> Result<bool> {
    if let Some((body, flags)) = as_regex(pattern) {
        return regex_matches(body, flags, url);
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
    /// A regular expression the URL must match (no slashes or flags; case-sensitive unless it starts with (?i)).
    pub url_regex: Option<String>,
    /// Match text exactly (case and whitespace) instead of Playwright's case-insensitive, whitespace-normalized match.
    pub exact: bool,
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
        waiting_for.push(format!("load state {load}"));
        // A navigation in flight: wait for its document rather than the one it is replacing.
        if let Some(pending) = page.pending_navigation() {
            let committed = page
                .wait_until(deadline.saturating_duration_since(Instant::now()), Duration::from_millis(50), |page| page.pending_navigation().is_none() || page.blocking_dialog().is_some())
                .await;
            if !committed {
                bail!("Timed out after {} ms waiting for {load}: the navigation to {pending} has not committed yet", timeout.as_millis());
            }
        }
        let loader = page.frame(&page.main_frame()).map(|f| f.loader_id).filter(|l| !l.is_empty());
        let load = if load == WaitUntil::None { WaitUntil::Commit } else { load };
        if !wait_for_state(page, load, loader.as_deref(), deadline).await {
            bail!("Timed out after {} ms waiting for the page to reach {load} (it is at {})", timeout.as_millis(), page.main_url());
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
    if let Some(regex) = &conditions.url_regex {
        waiting_for.push(format!("url matching /{regex}/"));
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
            && let Some(regex) = &conditions.url_regex {
                ok = regex_matches(regex, "", &page.main_url())?;
            }
        if ok
            && let Some(text) = &conditions.text {
                ok = page.call_value(&main, "hasText", vec![v(text), v(conditions.exact)], false).await.map(|v| v.as_bool() == Some(true)).unwrap_or(false);
            }
        if ok
            && let Some(text) = &conditions.text_gone {
                ok = page.call_value(&main, "hasText", vec![v(text), v(conditions.exact)], false).await.map(|v| v.as_bool() == Some(false)).unwrap_or(false);
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
        Some(load) if load == "none" => bail!("load must be load, domcontentloaded, settle or commit; got \"none\""),
        Some(load) => Some(WaitUntil::parse(Some(&load)).map_err(|_| anyhow!("load must be load, domcontentloaded, settle or commit; got {load:?}"))?),
        None => None,
    };
    let url_regex = string("urlRegex");
    if let Some(regex) = &url_regex {
        regex_lite::Regex::new(regex).map_err(|e| anyhow!("Invalid urlRegex {regex:?}: {e}"))?;
    }
    if let Some(url) = string("url")
        && let Some((body, flags)) = as_regex(&url) {
            regex_matches(body, flags, "")?;
        }
    Ok(WaitFor {
        text: string("text"),
        text_gone: string("textGone"),
        url: string("url"),
        url_regex,
        exact: args.get("exact").and_then(Value::as_bool).unwrap_or(false),
        spec: Spec::from_args(args),
        state,
        load,
        ms: args.get("ms").and_then(Value::as_u64),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls_normalize() {
        let n = |url: &str| normalize_url(url).unwrap();
        assert_eq!(n("example.com"), "https://example.com");
        assert_eq!(n(":3000/x"), "http://localhost:3000/x");
        assert_eq!(n("localhost:8080"), "http://localhost:8080");
        assert_eq!(n("example.com:8443/a"), "https://example.com:8443/a");
        assert_eq!(n("https://a.b/c"), "https://a.b/c");
        assert_eq!(n("about:blank"), "about:blank");
        assert_eq!(n("data:text/html,hi"), "data:text/html,hi");
        assert!(normalize_url("mailto:a@b.c").unwrap_err().to_string().contains("another app"));
        assert!(normalize_url("tel:+15551234").is_err());
        assert!(normalize_url("intent://x#Intent;end").is_err());
        assert!(normalize_url("").is_err());
        assert!(normalize_url("  ").is_err());
        assert!(normalize_url("javascript:alert(1)").unwrap_err().to_string().contains("eval"));
    }

    #[test]
    fn url_patterns() {
        assert!(url_matches("/checkout", "https://shop.example/checkout?x").unwrap());
        assert!(url_matches("**/orders/*", "https://shop.example/orders/12").unwrap());
        assert!(!url_matches("**/orders/*", "https://shop.example/orders/12/items").unwrap());
        assert!(url_matches("/orders\\/\\d+$/", "https://shop.example/orders/12").unwrap());
        assert!(url_matches("/ORDERS\\/\\d+/i", "https://shop.example/orders/12").unwrap());
        // A path is a substring, not /regex/flags.
        assert!(url_matches("/docs/us", "https://a.example/docs/us/x").unwrap());
        assert!(!url_matches("/docs/us", "https://a.example/d").unwrap());
        assert!(url_matches("/ORDERS/i", "https://a.example/ORDERS/i").unwrap());
    }
}
