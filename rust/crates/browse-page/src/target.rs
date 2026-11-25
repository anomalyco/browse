//! Turning a snapshot ref or a Playwright-style selector into an element handle in the right frame.

use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Result, anyhow, bail};
use serde::Deserialize;
use serde_json::Value;

use crate::page::{Element, ElementOr, TabPage, v};
use crate::state::PageTab;

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

/// Whether a query failed because of the selector itself (parse errors from the selector engines).
fn is_selector_error(message: &str) -> bool {
    ["not a valid selector", "Unknown engine", "Malformed", "SyntaxError", "Unexpected token", "Unexpected end", "Unsupported", "Invalid selector", "Error while parsing selector", "Expected "]
        .iter()
        .any(|needle| message.contains(needle))
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
pub async fn resolve(page: &Arc<TabPage>, tab_state: &PageTab, spec: &Spec, options: ResolveOptions) -> Result<Resolved> {
    let element = match spec {
        Spec::Ref(id) => resolve_ref(page, tab_state, id, options).await?,
        Spec::Selector(selector) => resolve_selector(page, tab_state, selector, options).await?,
    };
    let label = page.call_element(&element, "describe", vec![], false).await.ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default();
    Ok(Resolved { element, label })
}

async fn resolve_ref(page: &Arc<TabPage>, tab_state: &PageTab, id: &str, options: ResolveOptions) -> Result<Element> {
    let normalized = id.strip_prefix('@').unwrap_or(id).to_string();
    if let Some((seq, playwright_ref)) = parse_aria_ref(&normalized) {
        return resolve_aria_ref(page, tab_state, &normalized, seq, &playwright_ref, options).await;
    }
    if !is_compact_ref(&normalized) {
        bail!("Unknown snapshot ref: {id}; refs look like e12 (snapshot) or a12 / f1a3 (aria snapshot). Pass CSS or Playwright selectors as `selector`.");
    }
    let target = {
        let refs = tab_state.refs.lock().unwrap();
        if refs.tab != Some(page.tab()) {
            if let Some(tab) = refs.tab {
                bail!("Snapshot ref {id} belongs to tab {tab}; call snapshot on this tab, or pass tab: {tab}");
            }
            bail!("Unknown snapshot ref: {id}; call snapshot to get current refs");
        }
        if refs.document != page.frame(&page.main_frame()).map(|f| f.generation) {
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
            .call_element_result(&frame, "refResolve", vec![v(&normalized), v(&role), v(&name), v(&target.selector)], injected)
            .await?;
        match result {
            ElementOr::Element(element) => return Ok(element),
            ElementOr::Status(status) if status.starts_with("multiple:") => {
                let rest = &status["multiple:".len()..];
                let (count, previews) = rest.split_once(':').unwrap_or((rest, ""));
                let shown: Vec<String> = previews.lines().map(|line| format!("  {line}")).collect();
                bail!(
                    "Ref {id} ({} {:?}) now matches {count} elements, so browse can't tell which one it was; call snapshot again for fresh refs, or use a more specific selector:\n{}",
                    target.role,
                    target.name.clone().unwrap_or_default(),
                    shown.join("\n")
                );
            }
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

async fn resolve_aria_ref(page: &Arc<TabPage>, tab_state: &PageTab, id: &str, seq: u32, playwright_ref: &str, options: ResolveOptions) -> Result<Element> {
    {
        let refs = tab_state.refs.lock().unwrap();
        let aria = refs.aria.as_ref().ok_or_else(|| anyhow!("Unknown aria snapshot ref: {id}; call snapshot with mode \"aria\" first"))?;
        if aria.tab != page.tab() {
            bail!("Aria ref {id} belongs to tab {}; call snapshot on this tab", aria.tab);
        }
        let main_generation = page.frame(&page.main_frame()).map(|f| f.generation).unwrap_or(0);
        if aria.main_generation != main_generation {
            bail!("Aria snapshot refs are stale after a page change; call snapshot again");
        }
        if !aria.ids.contains(id) {
            bail!("Unknown aria snapshot ref: {id}; the last aria snapshot has no such ref. Call snapshot with mode \"aria\" again for current refs");
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

async fn resolve_selector(page: &Arc<TabPage>, tab_state: &PageTab, selector: &str, options: ResolveOptions) -> Result<Element> {
    let parts = frame_parts(selector);
    let deadline = Instant::now() + options.timeout;
    let mut frame = page.main_frame();
    for (index, part) in parts.iter().enumerate() {
        let last = index == parts.len() - 1;
        let part = normalize_selector(if part.is_empty() { if last { "html" } else { "iframe" } } else { part });
        let element = wait_query(page, &frame, &part, selector, deadline, options.timeout, Some(tab_state)).await?;
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
        let element = wait_query(page, &frame, &part, selector, deadline, timeout, None).await?;
        let remaining = deadline.saturating_duration_since(Instant::now()).max(Duration::from_millis(200));
        frame = page.content_frame(&element, remaining).await?;
    }
    Ok((frame, parts.last().cloned().unwrap_or_default()))
}

async fn wait_query(page: &Arc<TabPage>, frame: &str, part: &str, full: &str, deadline: Instant, timeout: Duration, tab_state: Option<&PageTab>) -> Result<Element> {
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
                } else if is_selector_error(&message) {
                    bail!("Invalid selector {full:?}: {message}");
                } else {
                    return Err(error);
                }
            }
        }
        if Instant::now() >= deadline {
            let hint = near_misses(page, frame, part, tab_state).await;
            bail!("No element matches selector {full:?} (waited {} ms){hint}", timeout.as_millis());
        }
        tokio::time::sleep(POLL).await;
    }
}

#[derive(Deserialize)]
struct NearMisses {
    role: Option<String>,
    items: Vec<NearMiss>,
}

#[derive(Deserialize)]
struct NearMiss {
    role: String,
    name: String,
    #[serde(rename = "ref")]
    ref_id: Option<String>,
}

/// What the frame has instead of the selector's match, as a suffix for the no-match error: the closest elements of
/// the selector's role (or with its name), with their snapshot refs while those are current. Empty when the selector
/// has no role or text to compare, or the lookup fails.
async fn near_misses(page: &Arc<TabPage>, frame: &str, part: &str, tab_state: Option<&PageTab>) -> String {
    let lookup = page.call_value(frame, "nearMisses", vec![v(part)], true);
    let Ok(Ok(value)) = tokio::time::timeout(Duration::from_secs(2), lookup).await else { return String::new() };
    let Ok(Some(found)) = serde_json::from_value::<Option<NearMisses>>(value) else { return String::new() };
    let current_ref = |id: &str| -> bool {
        let Some(tab_state) = tab_state else { return false };
        let refs = tab_state.refs.lock().unwrap();
        if refs.tab != Some(page.tab()) || refs.document != page.frame(&page.main_frame()).map(|f| f.generation) {
            return false;
        }
        match refs.selectors.get(id).map(|target| &target.frame) {
            Some(None) => frame == page.main_frame(),
            Some(Some((owner, generation))) => owner == frame && page.frame(owner).map(|f| f.generation) == Some(*generation),
            None => false,
        }
    };
    format_near_misses(&found, if frame == page.main_frame() { "page" } else { "frame" }, current_ref)
}

fn format_near_misses(found: &NearMisses, place: &str, current_ref: impl Fn(&str) -> bool) -> String {
    let lines: Vec<String> = found
        .items
        .iter()
        .map(|item| {
            let name = if item.name.is_empty() { String::new() } else { format!(" {:?}", truncate(&item.name, 80)) };
            let reference = item.ref_id.as_deref().filter(|id| current_ref(id)).map(|id| format!(" [ref={id}]")).unwrap_or_default();
            format!("  - {}{name}{reference}", item.role)
        })
        .collect();
    let same_role = found.role.as_ref().is_some_and(|role| found.items.iter().all(|item| &item.role == role));
    match (&found.role, lines.is_empty()) {
        (Some(role), true) => format!(".\nThe {place} has no {role}."),
        (None, true) => format!(".\nNo element in the {place} has a similar name."),
        (Some(role), false) if !same_role => format!(".\nThe {place} has no {role}. Elements with a similar name:\n{}", lines.join("\n")),
        _ => format!(".\nClosest elements in the {place}:\n{}", lines.join("\n")),
    }
}

fn truncate(text: &str, max: usize) -> String {
    if text.chars().count() <= max { text.to_string() } else { format!("{}...", text.chars().take(max).collect::<String>()) }
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
