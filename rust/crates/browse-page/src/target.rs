//! Turning a snapshot ref or a Playwright-style selector into an element handle in the right frame.

use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Result, anyhow, bail};
use serde_json::Value;

use crate::page::{Element, ElementOr, TabPage, v};
use crate::state::PageSession;

/// How long an action waits for a ref that no longer matches its element before failing: long enough for a brief
/// "Saving…" label or a re-mount, far shorter than the action timeout.
const STALE_GRACE: Duration = Duration::from_millis(3_000);
const POLL: Duration = Duration::from_millis(100);

#[derive(Debug, Clone)]
pub enum Spec {
    Ref(String),
    Selector(String),
}

impl Spec {
    pub fn from_args(args: &Value) -> Option<Spec> {
        if let Some(r) = args.get("ref").and_then(Value::as_str).filter(|s| !s.trim().is_empty()) {
            return Some(Spec::Ref(r.trim().to_string()));
        }
        args.get("selector").and_then(Value::as_str).filter(|s| !s.trim().is_empty()).map(|s| Spec::Selector(s.to_string()))
    }

    pub fn label(&self) -> String {
        match self {
            Spec::Ref(r) => r.clone(),
            Spec::Selector(s) => s.clone(),
        }
    }
}

/// The ARIA roles getByRole knows; refs with these roles are checked against their role and name.
pub fn aria_role(role: &str) -> bool {
    matches!(
        role,
        "button" | "checkbox" | "combobox" | "link" | "listbox" | "menuitem" | "menuitemcheckbox" | "menuitemradio" | "option" | "radio" | "searchbox" | "slider" | "spinbutton" | "switch" | "tab" | "textbox" | "treeitem"
    )
}

/// A compact-snapshot ref ("e12", "@e12").
pub fn is_compact_ref(id: &str) -> bool {
    let id = id.strip_prefix('@').unwrap_or(id);
    id.len() > 1 && id.starts_with('e') && id[1..].chars().all(|c| c.is_ascii_digit())
}

/// An aria-snapshot ref ("a5", "f2a5"): the frame sequence and Playwright's own ref ("e5", "f2e5").
pub fn parse_aria_ref(id: &str) -> Option<(u32, String)> {
    let id = id.strip_prefix('@').unwrap_or(id);
    let (seq, rest) = if let Some(rest) = id.strip_prefix('f') {
        let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
        if digits.is_empty() {
            return None;
        }
        (digits.parse().ok()?, &rest[digits.len()..])
    } else {
        (0, id)
    };
    let number = rest.strip_prefix('a')?;
    if number.is_empty() || !number.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let playwright = if seq == 0 { format!("e{number}") } else { format!("f{seq}e{number}") };
    Some((seq, playwright))
}

/// Playwright-style selectors with a few conveniences: `label=`, `placeholder=`, `alt=`, `title=` and `testid=`
/// become Playwright's internal engines (case-insensitive substring unless the value is quoted with a `s` suffix).
pub fn normalize_selector(selector: &str) -> String {
    selector
        .split(" >> ")
        .map(|part| {
            let trimmed = part.trim();
            let quote = |value: &str, exact_default: bool| -> String {
                let value = value.trim();
                if value.starts_with('"') {
                    value.to_string()
                } else {
                    format!("{}{}", serde_json::to_string(value).unwrap(), if exact_default { "s" } else { "i" })
                }
            };
            if let Some(value) = trimmed.strip_prefix("label=") {
                format!("internal:label={}", quote(value, false))
            } else if let Some(value) = trimmed.strip_prefix("placeholder=") {
                format!("internal:attr=[placeholder={}]", quote(value, false))
            } else if let Some(value) = trimmed.strip_prefix("alt=") {
                format!("internal:attr=[alt={}]", quote(value, false))
            } else if let Some(value) = trimmed.strip_prefix("title=") {
                format!("internal:attr=[title={}]", quote(value, false))
            } else if let Some(value) = trimmed.strip_prefix("testid=") {
                format!("internal:testid=[data-testid={}]", quote(value, true))
            } else {
                part.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join(" >> ")
}

/// Splits a selector at `internal:control=enter-frame` (or the shorthand `>> frame >>`) into per-frame parts.
pub fn frame_parts(selector: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut current: Vec<&str> = Vec::new();
    for piece in selector.split(">>") {
        let trimmed = piece.trim();
        if trimmed == "internal:control=enter-frame" || trimmed == "frame" {
            parts.push(current.iter().map(|p| p.trim()).collect::<Vec<_>>().join(" >> "));
            current.clear();
        } else {
            current.push(piece);
        }
    }
    parts.push(current.iter().map(|p| p.trim()).collect::<Vec<_>>().join(" >> "));
    parts
}

pub struct Resolved {
    pub element: Element,
    /// How the element reads in results: `button "Save"`.
    pub label: String,
}

#[derive(Clone, Copy)]
pub struct ResolveOptions {
    pub timeout: Duration,
    /// An action: a ref that stops matching fails after the stale grace instead of waiting the whole timeout.
    pub act: bool,
}

fn selector_error(selector: &str, status: &str) -> Option<anyhow::Error> {
    let rest = status.strip_prefix("multiple:")?;
    let (count, previews) = rest.split_once(':').unwrap_or((rest, ""));
    let shown: Vec<String> = previews.lines().map(|line| format!("  {line}")).collect();
    Some(anyhow!(
        "Selector {selector:?} matches {count} elements; it must match one. Make it more specific (a role and name, an id, or `>> nth=0` for the first):\n{}",
        shown.join("\n")
    ))
}

/// Resolves a ref or selector, waiting for it to appear.
pub async fn resolve(page: &Arc<TabPage>, session: &PageSession, spec: &Spec, options: ResolveOptions) -> Result<Resolved> {
    let element = match spec {
        Spec::Ref(id) => resolve_ref(page, session, id, options).await?,
        Spec::Selector(selector) => resolve_selector(page, selector, options).await?,
    };
    let label = page.call_element(&element, "describe", vec![], false).await.ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default();
    Ok(Resolved { element, label })
}

async fn resolve_ref(page: &Arc<TabPage>, session: &PageSession, id: &str, options: ResolveOptions) -> Result<Element> {
    let normalized = id.strip_prefix('@').unwrap_or(id).to_string();
    if let Some((seq, playwright_ref)) = parse_aria_ref(&normalized) {
        return resolve_aria_ref(page, session, &normalized, seq, &playwright_ref, options).await;
    }
    if !is_compact_ref(&normalized) {
        bail!("Unknown snapshot ref: {id}; refs look like e12 (snapshot) or a12 / f1a3 (aria snapshot). Pass CSS or Playwright selectors as `selector`.");
    }
    let target = {
        let refs = session.refs.lock().unwrap();
        if refs.tab != Some(page.tab()) {
            if let Some(tab) = refs.tab {
                bail!("Snapshot ref {id} belongs to tab {tab}; call snapshot on this tab, or pass tab: {tab}");
            }
            bail!("Unknown snapshot ref: {id}; call snapshot to get current refs");
        }
        if refs.url.as_deref() != Some(page.main_url().as_str()) {
            bail!("Snapshot refs are stale after a page change; call snapshot again");
        }
        refs.selectors.get(&normalized).cloned().ok_or_else(|| anyhow!("Unknown snapshot ref: {id}; call snapshot to get current refs"))?
    };
    let frame = match &target.frame {
        Some((frame, generation)) => {
            let current = page.frame(frame).map(|f| f.generation);
            if current != Some(*generation) {
                bail!("Snapshot ref {id} was captured in an iframe that has navigated or detached; call snapshot again");
            }
            frame.clone()
        }
        None => page.main_frame(),
    };
    let role = aria_role(&target.role).then(|| target.role.clone());
    let name = if role.is_some() { target.name.clone() } else { None };
    let injected = target.selector.contains(" >> ");
    let started = Instant::now();
    let mut first_miss: Option<Instant> = None;
    let mut hidden;
    loop {
        page.ensure_no_dialog()?;
        let result = page
            .call_element_result(&frame, "refResolve", vec![v(&role), v(&name), v(&target.selector)], injected)
            .await?;
        match result {
            ElementOr::Element(element) => return Ok(element),
            ElementOr::Status(status) if status == "hidden" => {
                hidden = true;
                first_miss = None;
            }
            ElementOr::Status(_) => {
                hidden = false;
                let first = *first_miss.get_or_insert_with(Instant::now);
                if options.act && first.elapsed() >= STALE_GRACE {
                    let message = page
                        .call_value(&frame, "refStale", vec![v(&normalized), v(&target.role), v(&target.name), v(&target.selector)], injected)
                        .await?;
                    bail!("{}", message.as_str().unwrap_or("the ref is stale; call snapshot again"));
                }
            }
        }
        if started.elapsed() >= options.timeout {
            if hidden {
                bail!("Ref {id} ({} {:?}) is hidden (waited {} ms for it to become visible)", target.role, target.name.clone().unwrap_or_default(), options.timeout.as_millis());
            }
            let message = page
                .call_value(&frame, "refStale", vec![v(&normalized), v(&target.role), v(&target.name), v(&target.selector)], injected)
                .await?;
            bail!("{}", message.as_str().unwrap_or("the ref is stale; call snapshot again"));
        }
        tokio::time::sleep(POLL).await;
    }
}

async fn resolve_aria_ref(page: &Arc<TabPage>, session: &PageSession, id: &str, seq: u32, playwright_ref: &str, options: ResolveOptions) -> Result<Element> {
    {
        let refs = session.refs.lock().unwrap();
        let aria = refs.aria.as_ref().ok_or_else(|| anyhow!("Unknown aria snapshot ref: {id}; call snapshot with mode \"aria\" first"))?;
        if aria.tab != page.tab() {
            bail!("Aria ref {id} belongs to tab {}; call snapshot on this tab", aria.tab);
        }
        let main_generation = page.frame(&page.main_frame()).map(|f| f.generation).unwrap_or(0);
        if aria.url != page.main_url() || aria.main_generation != main_generation {
            bail!("Aria snapshot refs are stale after a page change; call snapshot again");
        }
    }
    let frame = page.frame_by_seq(seq).ok_or_else(|| anyhow!("Aria ref {id} was captured in an iframe that is gone; call snapshot again"))?;
    let deadline = Instant::now() + options.timeout.min(if options.act { STALE_GRACE } else { options.timeout });
    loop {
        page.ensure_no_dialog()?;
        match page.call_element_result(&frame, "ariaRef", vec![v(playwright_ref)], true).await? {
            ElementOr::Element(element) => return Ok(element),
            ElementOr::Status(_) => {}
        }
        if Instant::now() >= deadline {
            bail!("Aria ref {id} no longer matches an element (the page re-rendered it); call snapshot again");
        }
        tokio::time::sleep(POLL).await;
    }
}

async fn resolve_selector(page: &Arc<TabPage>, selector: &str, options: ResolveOptions) -> Result<Element> {
    let parts = frame_parts(selector);
    let deadline = Instant::now() + options.timeout;
    let mut frame = page.main_frame();
    for (index, part) in parts.iter().enumerate() {
        let last = index == parts.len() - 1;
        let part = normalize_selector(if part.is_empty() { if last { "html" } else { "iframe" } } else { part });
        let element = wait_query(page, &frame, &part, selector, deadline, options.timeout).await?;
        if last {
            return Ok(element);
        }
        let remaining = deadline.saturating_duration_since(Instant::now()).max(Duration::from_millis(200));
        frame = page.content_frame(&element, remaining).await.map_err(|error| anyhow!("{part:?} in {selector:?}: {error}"))?;
    }
    unreachable!("frame_parts returns at least one part")
}

/// The frame a selector's frame-entering parts lead to, and the selector left for that frame.
pub async fn selector_frame(page: &Arc<TabPage>, selector: &str, timeout: Duration) -> Result<(String, String)> {
    let parts = frame_parts(selector);
    let deadline = Instant::now() + timeout;
    let mut frame = page.main_frame();
    for part in &parts[..parts.len() - 1] {
        let part = normalize_selector(if part.is_empty() { "iframe" } else { part });
        let element = wait_query(page, &frame, &part, selector, deadline, timeout).await?;
        let remaining = deadline.saturating_duration_since(Instant::now()).max(Duration::from_millis(200));
        frame = page.content_frame(&element, remaining).await?;
    }
    Ok((frame, parts.last().cloned().unwrap_or_default()))
}

async fn wait_query(page: &Arc<TabPage>, frame: &str, part: &str, full: &str, deadline: Instant, timeout: Duration) -> Result<Element> {
    loop {
        page.ensure_no_dialog()?;
        match page.call_element_result(frame, "query", vec![v(part), v(true)], true).await {
            Ok(ElementOr::Element(element)) => return Ok(element),
            Ok(ElementOr::Status(status)) => {
                if let Some(error) = selector_error(full, &status) {
                    return Err(error);
                }
            }
            Err(error) => {
                let message = error.to_string();
                if message.contains("navigated or re-rendered") {
                    // Keep waiting through a navigation.
                } else {
                    bail!("Invalid selector {full:?}: {message}");
                }
            }
        }
        if Instant::now() >= deadline {
            bail!("No element matches selector {full:?} (waited {} ms)", timeout.as_millis());
        }
        tokio::time::sleep(POLL).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refs_parse() {
        assert!(is_compact_ref("e12"));
        assert!(is_compact_ref("@e1"));
        assert!(!is_compact_ref("e"));
        assert_eq!(parse_aria_ref("a5"), Some((0, "e5".into())));
        assert_eq!(parse_aria_ref("f2a5"), Some((2, "f2e5".into())));
        assert_eq!(parse_aria_ref("e5"), None);
        assert_eq!(parse_aria_ref("fa5"), None);
    }

    #[test]
    fn selector_aliases() {
        assert_eq!(normalize_selector("label=Email"), "internal:label=\"Email\"i");
        assert_eq!(normalize_selector("form >> placeholder=\"Search\"s"), "form >> internal:attr=[placeholder=\"Search\"s]");
        assert_eq!(normalize_selector("testid=save"), "internal:testid=[data-testid=\"save\"s]");
        assert_eq!(normalize_selector("role=button[name=\"Save\"]"), "role=button[name=\"Save\"]");
    }

    #[test]
    fn frame_parts_split() {
        assert_eq!(frame_parts("button"), vec!["button"]);
        assert_eq!(frame_parts("iframe[title=Pay] >> internal:control=enter-frame >> role=button"), vec!["iframe[title=Pay]", "role=button"]);
        assert_eq!(frame_parts("#a >> frame >> #b >> frame >> text=Hi"), vec!["#a", "#b", "text=Hi"]);
    }
}
