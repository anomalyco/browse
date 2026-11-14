//! Snapshots (cli/src/snapshot.ts and cli/src/snapshot/**): the compact capture with persistent refs, iframe
//! content nested under its iframe line, diff and delta against the previous snapshot, find with context, and
//! Playwright's AI-mode aria snapshot.

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Result, anyhow, bail};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::page::{Element, ElementOr, TabPage, is_context_lost, v};
use crate::state::{AriaRefs, Baseline, PageSession, RefTarget};
use crate::target;

pub const DEFAULT_TIMEOUT_MS: u64 = 10_000;
const RETRY_DELAY: Duration = Duration::from_millis(25);
/// Iframe documents captured per snapshot: room for a checkout with a payment and a 3-D Secure frame.
pub const MAX_FRAMES: usize = 8;
/// Frames nested in frames.
pub const MAX_FRAME_DEPTH: usize = 3;
/// One frame gets at least this long, even when many frames share a short deadline.
const MAX_FRAME_TIMEOUT_MS: u64 = 1_000;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub depth: i64,
    pub base_depth: Option<i64>,
    pub key: Option<String>,
    pub parent_keys: Option<Vec<String>>,
    pub role: String,
    pub name: String,
    pub identity_name: Option<String>,
    pub details: Option<String>,
    pub selector: Option<String>,
    pub selector_role: Option<String>,
    #[serde(default)]
    pub iframe: bool,
    #[serde(default)]
    pub root: bool,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Capture {
    pub entries: Vec<Entry>,
    #[serde(default)]
    pub truncated: bool,
    #[serde(default)]
    pub needs_settle: bool,
    #[serde(default)]
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct RenderedEntry {
    pub prefix: String,
    pub details: Option<String>,
    pub selector: Option<String>,
    pub role: Option<String>,
    pub identity_name: Option<String>,
    pub ref_id: Option<String>,
    pub frame_key: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct Options {
    pub within: Option<String>,
    pub interactive: bool,
    pub compact: bool,
    pub diff: bool,
    pub delta: bool,
    pub find: Option<String>,
    pub context: Option<i64>,
    pub depth: i64,
    pub max_items: i64,
    pub timeout_ms: u64,
    pub frames: bool,
    pub aria: bool,
}

impl Options {
    pub fn from_args(args: &Value) -> Options {
        let int = |key: &str| args.get(key).and_then(Value::as_f64).map(|n| n.floor() as i64);
        Options {
            within: args.get("within").and_then(Value::as_str).map(str::to_string),
            interactive: args.get("interactive").and_then(Value::as_bool).unwrap_or(false),
            compact: args.get("compact").and_then(Value::as_bool).unwrap_or(true),
            diff: args.get("diff").and_then(Value::as_bool).unwrap_or(false),
            delta: args.get("delta").and_then(Value::as_bool).unwrap_or(false),
            find: args.get("find").and_then(Value::as_str).map(str::to_string),
            context: int("context"),
            depth: int("depth").unwrap_or(10).clamp(1, 16),
            max_items: int("maxItems").unwrap_or(80).clamp(1, 200),
            timeout_ms: args.get("timeout").and_then(Value::as_u64).unwrap_or(DEFAULT_TIMEOUT_MS).max(100),
            frames: args.get("frames").and_then(Value::as_bool).unwrap_or(true),
            aria: args.get("mode").and_then(Value::as_str) == Some("aria"),
        }
    }
}

#[derive(Debug, Clone)]
struct Settings {
    compact: bool,
    depth: i64,
    interactive: bool,
    max_candidates: i64,
    max_items: i64,
    root_selector: Option<String>,
    root_role: Option<String>,
    root_name: Option<String>,
    report_root_fallback: bool,
}

impl Settings {
    fn to_json(&self) -> Value {
        let mut value = json!({
            "compact": self.compact,
            "depth": self.depth,
            "interactive": self.interactive,
            "maxCandidates": self.max_candidates,
            "maxItems": self.max_items,
            "rootSelector": self.root_selector,
            "rootRole": self.root_role,
            "rootName": self.root_name,
        });
        if self.report_root_fallback {
            value["reportRootFallback"] = json!(true);
        }
        value
    }

    /// A child document keeps the parent's presentation choices, never its root scope, and a bounded budget.
    fn child(&self, iframe_depth: i64) -> Settings {
        Settings {
            compact: self.compact,
            depth: (self.depth - iframe_depth - 1).max(1),
            interactive: self.interactive,
            max_candidates: (self.max_items * 20).max(200),
            max_items: self.max_items,
            root_selector: None,
            root_role: None,
            root_name: None,
            report_root_fallback: false,
        }
    }
}

fn escape_name(name: &str) -> String {
    name.replace('\\', "\\\\").replace('"', "\\\"")
}

struct RenderedCapture {
    entries: Vec<RenderedEntry>,
    depths: Vec<i64>,
}

/// Turn a capture's entries into output lines, resolving structural parents to indentation.
fn render_capture(capture: &Capture) -> RenderedCapture {
    let by_key: HashMap<&str, usize> = capture.entries.iter().enumerate().filter_map(|(i, e)| e.key.as_deref().map(|k| (k, i))).collect();
    let mut cache: HashMap<usize, i64> = HashMap::new();
    fn resolved(index: usize, capture: &Capture, by_key: &HashMap<&str, usize>, cache: &mut HashMap<usize, i64>, guard: usize) -> i64 {
        if let Some(depth) = cache.get(&index) {
            return *depth;
        }
        let entry = &capture.entries[index];
        let parent = entry.parent_keys.as_ref().and_then(|keys| keys.iter().find_map(|k| by_key.get(k.as_str()).copied()));
        let depth = match parent {
            Some(parent) if guard < 64 && parent != index => resolved(parent, capture, by_key, cache, guard + 1) + 1,
            _ => entry.base_depth.unwrap_or(entry.depth),
        };
        cache.insert(index, depth);
        depth
    }
    let root = capture.entries.iter().position(|e| e.root);
    let root_depth = root.map(|r| resolved(r, capture, &by_key, &mut cache, 0));
    let depth_of = |index: usize, cache: &mut HashMap<usize, i64>| -> i64 {
        let depth = resolved(index, capture, &by_key, cache, 0);
        match (root, root_depth) {
            (Some(r), Some(rd)) if r != index => depth.max(rd + 1),
            _ => depth,
        }
    };
    let depths: Vec<i64> = (0..capture.entries.len()).map(|i| depth_of(i, &mut cache)).collect();
    let offset = depths.iter().copied().min().unwrap_or(0);
    let depths: Vec<i64> = depths.iter().map(|d| (d - offset).max(0)).collect();
    let entries = capture
        .entries
        .iter()
        .zip(&depths)
        .map(|(entry, depth)| RenderedEntry {
            prefix: format!("{}- {} \"{}\"", "  ".repeat(*depth as usize), entry.role, escape_name(&entry.name)),
            details: entry.details.clone(),
            selector: entry.selector.clone(),
            role: entry.selector.as_ref().map(|_| entry.selector_role.clone().unwrap_or_else(|| entry.role.clone())),
            identity_name: entry.identity_name.clone(),
            ref_id: None,
            frame_key: None,
        })
        .collect();
    RenderedCapture { entries, depths }
}

pub fn ref_identity(entry: &RenderedEntry) -> Option<String> {
    let selector = entry.selector.as_ref()?;
    let role = entry.role.as_ref()?;
    Some(json!([selector, role, entry.identity_name, entry.frame_key]).to_string())
}

pub fn format_line(entry: &RenderedEntry, id: Option<&str>) -> String {
    let parts: Vec<String> = [id.map(|id| format!("ref={id}")), entry.details.clone()].into_iter().flatten().filter(|s| !s.is_empty()).collect();
    let suffix = parts.join(" ");
    if suffix.is_empty() { entry.prefix.clone() } else { format!("{} [{}]", entry.prefix, suffix) }
}

pub fn format_diff_line(marker: char, entry: &RenderedEntry, id: Option<&str>) -> String {
    let line = format_line(entry, id);
    let indent_len = line.len() - line.trim_start().len();
    let (indent, rest) = line.split_at(indent_len);
    match rest.strip_prefix("- ") {
        Some(body) => format!("{marker} {indent}{body}"),
        None => format!("{marker} {line}"),
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum DiffOp {
    Unchanged(RenderedEntry),
    Removed(RenderedEntry),
    Added(RenderedEntry),
}

pub fn diff_entries(previous: &[RenderedEntry], current: &[RenderedEntry]) -> Vec<DiffOp> {
    let prev: Vec<String> = previous.iter().map(|e| format_line(e, None)).collect();
    let curr: Vec<String> = current.iter().map(|e| format_line(e, None)).collect();
    let (n, m) = (prev.len(), curr.len());
    let mut lengths = vec![vec![0usize; m + 1]; n + 1];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            lengths[i][j] = if prev[i] == curr[j] { lengths[i + 1][j + 1] + 1 } else { lengths[i + 1][j].max(lengths[i][j + 1]) };
        }
    }
    let mut ops = Vec::new();
    let (mut i, mut j) = (0, 0);
    while i < n || j < m {
        if i < n && j < m && prev[i] == curr[j] {
            ops.push(DiffOp::Unchanged(current[j].clone()));
            i += 1;
            j += 1;
        } else if i < n && (j >= m || lengths[i + 1][j] >= lengths[i][j + 1]) {
            ops.push(DiffOp::Removed(previous[i].clone()));
            i += 1;
        } else {
            ops.push(DiffOp::Added(current[j].clone()));
            j += 1;
        }
    }
    ops
}

enum Query {
    Text(String),
    Regex(regex_lite::Regex, String),
}

fn parse_query(query: &str) -> Result<Query> {
    if query.len() > 2 && query.starts_with('/')
        && let Some(end) = query.rfind('/')
            && end > 0 {
                let pattern = &query[1..end];
                let flags = &query[end + 1..];
                if flags.chars().all(|c| "gimsuy".contains(c)) {
                    let mut prefix = String::new();
                    if flags.contains('i') {
                        prefix.push_str("(?i)");
                    }
                    let regex = regex_lite::Regex::new(&format!("{prefix}{pattern}")).map_err(|e| anyhow!("Invalid find pattern {query}: {e}"))?;
                    return Ok(Query::Regex(regex, query.to_string()));
                }
            }
    Ok(Query::Text(query.to_string()))
}

pub fn find_lines(lines: &[String], query: &str, context: Option<i64>) -> Result<String> {
    let context = context.unwrap_or(2).clamp(0, 10) as usize;
    let parsed = parse_query(query)?;
    let matches: Vec<usize> = lines
        .iter()
        .enumerate()
        .filter(|(_, line)| match &parsed {
            Query::Text(text) => line.to_lowercase().contains(&text.to_lowercase()),
            Query::Regex(regex, _) => regex.is_match(line),
        })
        .map(|(i, _)| i)
        .collect();
    if matches.is_empty() {
        let shown = match &parsed {
            Query::Text(text) => serde_json::to_string(text).unwrap(),
            Query::Regex(_, source) => source.clone(),
        };
        return Ok(format!("No snapshot lines matched {shown}."));
    }
    let mut included = std::collections::BTreeSet::new();
    for &index in &matches {
        let start = index.saturating_sub(context);
        let end = (index + context).min(lines.len() - 1);
        included.extend(start..=end);
    }
    let mut output = vec![format!("{} matching snapshot {}:", matches.len(), if matches.len() == 1 { "line" } else { "lines" })];
    let mut previous: Option<usize> = None;
    for index in included {
        if previous.map(|p| index > p + 1).unwrap_or(true) {
            output.push("...".into());
        }
        output.push(lines[index].clone());
        previous = Some(index);
    }
    Ok(output.join("\n"))
}

struct FrameNode {
    frame: Option<String>,
    capture: Capture,
    children: HashMap<usize, FrameNode>,
    note: Option<String>,
    generation: u64,
}

impl FrameNode {
    fn note(note: String) -> FrameNode {
        FrameNode { frame: None, capture: Capture::default(), children: HashMap::new(), note: Some(note), generation: 0 }
    }

    fn count(&self) -> usize {
        1 + self.children.values().map(FrameNode::count).sum::<usize>()
    }
}

struct Budget {
    frames: usize,
    items: i64,
    skipped_budget: usize,
    skipped_deadline: usize,
    skipped_items: usize,
}

fn frame_timeout(remaining: u64, frames_left: usize) -> u64 {
    remaining.min(MAX_FRAME_TIMEOUT_MS.max(remaining / frames_left.max(1) as u64))
}

fn frame_skip_note(count: usize, reason: &str) -> String {
    format!("- ... {count} iframe {} not captured ({reason})", if count == 1 { "content" } else { "contents" })
}

fn frame_failure_note(error: &str) -> &'static str {
    if is_context_lost(error) || error.contains("navigated or re-rendered") || error.contains("frame is gone") || error.contains("tab is gone") {
        "the frame changed while capturing"
    } else if error.contains("timed out") || error.contains("Timeout") {
        "the frame did not answer in time"
    } else {
        "the frame could not be read"
    }
}

fn ms_left(deadline: Instant) -> u64 {
    deadline.saturating_duration_since(Instant::now()).as_millis() as u64
}

async fn with_deadline<T>(deadline: Instant, future: impl std::future::Future<Output = Result<T>>) -> Result<T> {
    match tokio::time::timeout(deadline.saturating_duration_since(Instant::now()).max(Duration::from_millis(1)), future).await {
        Ok(result) => result,
        Err(_) => bail!("timed out"),
    }
}

async fn capture_frames<'a>(
    page: &'a Arc<TabPage>,
    frame: &'a str,
    entries: &'a [Entry],
    settings: &'a Settings,
    deadline: Instant,
    budget: &'a mut Budget,
    depth: usize,
) -> HashMap<usize, FrameNode> {
    let mut frames = HashMap::new();
    for (index, entry) in entries.iter().enumerate() {
        let Some(selector) = entry.selector.as_ref().filter(|_| entry.iframe) else { continue };
        if depth > MAX_FRAME_DEPTH {
            frames.insert(index, FrameNode::note(format!("content not captured (frames nested deeper than {MAX_FRAME_DEPTH})")));
            continue;
        }
        if budget.frames == 0 {
            budget.skipped_budget += 1;
            continue;
        }
        if budget.items <= 0 {
            budget.skipped_items += 1;
            continue;
        }
        let remaining = ms_left(deadline);
        if remaining == 0 {
            budget.skipped_deadline += 1;
            continue;
        }
        let ahead = entries[index..].iter().filter(|e| e.iframe && e.selector.is_some()).count();
        let timeout = frame_timeout(remaining, budget.frames.min(ahead));
        let frame_deadline = deadline.min(Instant::now() + Duration::from_millis(timeout));
        budget.frames -= 1;
        let child = with_deadline(frame_deadline, async {
            let found = page.call_element_result(frame, "first", vec![v(selector)], selector.contains(" >> ")).await?;
            match found {
                ElementOr::Element(element) => page.content_frame(&element, Duration::from_millis(timeout)).await,
                ElementOr::Status(_) => bail!("gone"),
            }
        })
        .await;
        let Ok(child) = child else {
            frames.insert(index, FrameNode::note("content not captured (the iframe is gone or has no frame attached)".into()));
            continue;
        };
        let generation = page.frame(&child).map(|f| f.generation).unwrap_or(0);
        let child_settings = settings.child(entry.depth);
        let captured = with_deadline(frame_deadline, async {
            let value = page.call_value(&child, "capture", vec![v(child_settings.to_json())], false).await?;
            serde_json::from_value::<Capture>(value).map_err(|e| anyhow!("unexpected capture result: {e}"))
        })
        .await;
        match captured {
            Ok(capture) => {
                budget.items = (budget.items - capture.entries.len() as i64).max(0);
                let children = Box::pin(capture_frames(page, &child, &capture.entries, &child_settings, frame_deadline, budget, depth + 1)).await;
                frames.insert(index, FrameNode { frame: Some(child), capture, children, note: None, generation });
            }
            Err(error) => {
                frames.insert(
                    index,
                    FrameNode { frame: Some(child), capture: Capture::default(), children: HashMap::new(), note: Some(format!("content not captured ({})", frame_failure_note(&error.to_string()))), generation },
                );
            }
        }
    }
    frames
}

struct Scope {
    frame: String,
    settings_root: Option<(String, Option<String>, Option<String>)>,
    report_fallback: bool,
    signature: Value,
    /// The frame of a ref root and its generation, so refs registered under it stay bound to that document.
    owner_generation: u64,
}

async fn resolve_scope(page: &Arc<TabPage>, session: &PageSession, options: &Options) -> Result<Scope> {
    let main = page.main_frame();
    let main_generation = page.frame(&main).map(|f| f.generation).unwrap_or(0);
    let Some(within) = options.within.as_ref().map(|w| w.trim().to_string()).filter(|w| !w.is_empty()) else {
        return Ok(Scope { frame: main, settings_root: None, report_fallback: false, signature: json!({ "kind": "page" }), owner_generation: main_generation });
    };
    if target::is_compact_ref(&within) {
        let id = within.strip_prefix('@').unwrap_or(&within).to_string();
        let refs = session.refs.lock().unwrap();
        if refs.tab != Some(page.tab()) || refs.document != Some(main_generation) {
            bail!("Snapshot refs are stale after a page change; call snapshot again");
        }
        let target = refs.selectors.get(&id).cloned().ok_or_else(|| anyhow!("Unknown snapshot ref: {within}; call snapshot to get current refs"))?;
        let (frame, generation) = match &target.frame {
            Some((frame, generation)) => {
                if page.frame(frame).map(|f| f.generation) != Some(*generation) {
                    bail!("Snapshot refs are stale after an iframe navigation or detach; call snapshot again");
                }
                (frame.clone(), *generation)
            }
            None => (main, main_generation),
        };
        return Ok(Scope {
            frame,
            settings_root: Some((target.selector.clone(), Some(target.role.clone()), target.name.clone())),
            report_fallback: false,
            signature: json!({ "kind": "ref", "selector": target.selector, "role": target.role, "name": target.name }),
            owner_generation: generation,
        });
    }
    if target::parse_aria_ref(&within).is_some() {
        bail!("within takes a snapshot ref like e12 or a selector; aria refs (a12) can't scope a snapshot");
    }
    let parts = target::frame_parts(&within);
    if parts.len() > 1 {
        let (frame, rest) = target::selector_frame(page, &within, Duration::from_millis(options.timeout_ms)).await?;
        let generation = page.frame(&frame).map(|f| f.generation).unwrap_or(0);
        let rest = rest.trim().to_string();
        let root = if rest.is_empty() || rest == "html" || rest == "body" { None } else { Some((target::normalize_selector(&rest), None, None)) };
        return Ok(Scope { report_fallback: root.is_some(), settings_root: root, frame, signature: json!({ "kind": "selector", "selector": within }), owner_generation: generation });
    }
    Ok(Scope {
        frame: main,
        settings_root: Some((within.clone(), None, None)),
        report_fallback: true,
        signature: json!({ "kind": "selector", "selector": within }),
        owner_generation: main_generation,
    })
}

async fn capture_main(page: &Arc<TabPage>, scope: &Scope, settings: &Settings, deadline: Instant, diff: bool) -> Result<Capture> {
    let main = page.main_frame();
    let mut attempts = 0;
    loop {
        let start_generation = page.frame(&main).map(|f| f.generation);
        let result = with_deadline(deadline, async {
            let value = page.call_value(&scope.frame, "capture", vec![v(settings.to_json())], false).await?;
            serde_json::from_value::<Capture>(value).map_err(|e| anyhow!("unexpected capture result: {e}"))
        })
        .await;
        let navigated = page.frame(&main).map(|f| f.generation) != start_generation || page.main_frame() != main;
        match result {
            Ok(capture) => {
                if navigated {
                    attempts += 1;
                    if !diff && attempts < 3 && Instant::now() + RETRY_DELAY < deadline {
                        tokio::time::sleep(RETRY_DELAY).await;
                        continue;
                    }
                    bail!("Page navigated while snapshot was capturing; call snapshot again");
                }
                if capture.needs_settle && !diff && attempts == 0 && Instant::now() + Duration::from_millis(120) < deadline {
                    attempts += 1;
                    let _ = with_deadline(deadline, page.call_value(&scope.frame, "quiet", vec![v(120), v(550)], false)).await;
                    continue;
                }
                return Ok(capture);
            }
            Err(error) => {
                let message = error.to_string();
                if settings.root_selector.is_some() && scope.report_fallback && (message.contains("not a valid selector") || message.contains("querySelectorAll")) {
                    // A Playwright selector rather than CSS: resolve it with the injected script and capture from it.
                    let selector = target::normalize_selector(settings.root_selector.as_deref().unwrap());
                    let mut unrooted = settings.clone();
                    unrooted.root_selector = None;
                    let value = with_deadline(deadline, page.call_value(&scope.frame, "captureSelector", vec![v(&selector), v(unrooted.to_json())], true)).await?;
                    if value.is_null() {
                        bail!("snapshot within {selector:?} matched nothing");
                    }
                    return serde_json::from_value::<Capture>(value).map_err(|e| anyhow!("unexpected capture result: {e}"));
                }
                if (is_context_lost(&message) || message.contains("navigated or re-rendered")) && !diff && Instant::now() + RETRY_DELAY < deadline {
                    tokio::time::sleep(RETRY_DELAY).await;
                    continue;
                }
                if message == "timed out" {
                    bail!("Snapshot timed out after the page did not answer in time");
                }
                return Err(error);
            }
        }
    }
}

/// Right after a navigation browse watched, pages often render their content from requests made after load (search
/// results, app shells). While the network is still busy, wait briefly for it to go quiet and the DOM to settle. A
/// document browse didn't see commit, or one older than 15 s, is captured at once.
async fn settle_recent_navigation(page: &Arc<TabPage>, deadline: Instant) {
    let main = page.main_frame();
    let Some(frame) = page.frame(&main) else { return };
    let recent = frame.committed_at.map(|at| at.elapsed() < Duration::from_secs(15)).unwrap_or(false);
    if !recent || frame.lifecycle.is_empty() || frame.lifecycle.contains("networkAlmostIdle") || frame.lifecycle.contains("networkIdle") || page.dialog().is_some() {
        return;
    }
    let left = deadline.saturating_duration_since(Instant::now());
    let cap = (left / 2).min(Duration::from_millis(2_500));
    let started = Instant::now();
    page.wait_until(cap, Duration::from_millis(100), |page| {
        page.lifecycle_has(&main, "networkAlmostIdle") || page.lifecycle_has(&main, "networkIdle") || page.dialog().is_some()
    })
    .await;
    let quiet_max = cap.saturating_sub(started.elapsed()).min(Duration::from_millis(1_000)).as_millis() as u64;
    if quiet_max > 100 && page.dialog().is_none() {
        let _ = tokio::time::timeout(Duration::from_millis(quiet_max + 200), page.call_value(&main, "quiet", vec![v(200), v(quiet_max)], false)).await;
    }
}

/// The compact snapshot; registers refs in the session.
pub async fn snapshot(page: &Arc<TabPage>, session: &PageSession, options: &Options) -> Result<String> {
    if options.aria {
        return aria_snapshot(page, session, options).await;
    }
    page.ensure_no_dialog()?;
    if options.diff && options.delta {
        bail!("snapshot accepts either diff or delta, not both");
    }
    let scope = resolve_scope(page, session, options).await?;
    let max_items = options.max_items;
    let deadline = Instant::now() + Duration::from_millis(options.timeout_ms);
    let (root_selector, root_role, root_name) = match &scope.settings_root {
        Some((selector, role, name)) => (Some(selector.clone()), role.clone(), name.clone()),
        None => (None, None, None),
    };
    let settings = Settings {
        compact: options.compact,
        depth: options.depth,
        interactive: options.interactive,
        max_candidates: (max_items * 20).max(1_000),
        max_items,
        root_selector,
        root_role,
        root_name,
        report_root_fallback: scope.report_fallback,
    };
    let signature = json!({
        "compact": settings.compact,
        "depth": settings.depth,
        "interactive": settings.interactive,
        "frames": options.frames,
        "maxItems": settings.max_items,
        "scope": scope.signature,
    })
    .to_string();
    let document = page.frame(&page.main_frame()).map(|f| f.generation).unwrap_or(0);
    {
        let refs = session.refs.lock().unwrap();
        if options.diff {
            match refs.previous.as_ref() {
                None => bail!("snapshot with diff: true needs an earlier snapshot of this page to compare with; call snapshot without diff first"),
                Some(previous) if previous.tab != page.tab() => {
                    bail!("snapshot with diff: true compares with the previous snapshot, which was of another tab; call snapshot without diff on this tab first")
                }
                Some(previous) if previous.document != document => {
                    bail!("The page loaded a new document since the previous snapshot, so there is nothing to diff against; call snapshot without diff")
                }
                Some(previous) if previous.signature != signature => {
                    bail!("snapshot with diff: true must use the same snapshot options (within, interactive, depth, maxItems, frames, compact) as the previous snapshot")
                }
                _ => {}
            }
        }
    }
    {
        let mut refs = session.refs.lock().unwrap();
        refs.selectors.clear();
        refs.tab = None;
        refs.document = None;
    }
    let main_frame = page.main_frame();
    if !options.diff {
        settle_recent_navigation(page, deadline).await;
    }
    let capture = capture_main(page, &scope, &settings, deadline, options.diff).await?;

    let main = render_capture(&capture);
    let mut budget = Budget { frames: MAX_FRAMES, items: (max_items - main.entries.len() as i64).max(0), skipped_budget: 0, skipped_deadline: 0, skipped_items: 0 };
    let frame_nodes = if options.frames && capture.entries.iter().any(|e| e.iframe) {
        capture_frames(page, &scope.frame, &capture.entries, &settings, deadline, &mut budget, 1).await
    } else {
        HashMap::new()
    };

    let is_pdf = capture.entries.len() <= 2
        && scope.frame == main_frame
        && matches!(tokio::time::timeout(Duration::from_secs(1), page.call_value(&main_frame, "frameInfo", vec![], false)).await, Ok(Ok(info)) if info["contentType"] == "application/pdf");
    let mut refs_guard = session.refs.lock().unwrap();
    let refs = &mut *refs_guard;
    let mut entries: Vec<RenderedEntry> = Vec::new();
    let mut frame_objects: HashMap<String, (String, u64)> = HashMap::new();
    let mut remaining = (max_items - main.entries.len() as i64).max(0);
    let mut omitted = 0usize;

    #[allow(clippy::too_many_arguments)]
    fn emit(
        node: &FrameNode,
        indent: usize,
        entries: &mut Vec<RenderedEntry>,
        frame_objects: &mut HashMap<String, (String, u64)>,
        remaining: &mut i64,
        omitted: &mut usize,
        refs: &mut crate::state::RefRegistry,
        max_items: i64,
    ) {
        let indentation = "  ".repeat(indent);
        if let Some(note) = &node.note {
            entries.push(RenderedEntry { prefix: format!("{indentation}- ... {note}"), ..Default::default() });
            return;
        }
        let Some(frame) = &node.frame else { return };
        if *remaining <= 0 {
            *omitted += node.count();
            return;
        }
        let key = refs.frame_key(frame);
        frame_objects.insert(key.clone(), (frame.clone(), node.generation));
        let child = render_capture(&node.capture);
        for (index, entry) in child.entries.iter().enumerate() {
            if *remaining <= 0 {
                entries.push(RenderedEntry { prefix: format!("{indentation}- ... frame content truncated (maxItems reached)"), ..Default::default() });
                for (nested_index, nested) in &node.children {
                    if *nested_index >= index {
                        *omitted += nested.count();
                    }
                }
                break;
            }
            entries.push(RenderedEntry { prefix: format!("{indentation}{}", entry.prefix), frame_key: Some(key.clone()), ..entry.clone() });
            *remaining -= 1;
            if let Some(nested) = node.children.get(&index) {
                emit(nested, indent + child.depths[index] as usize + 1, entries, frame_objects, remaining, omitted, refs, max_items);
            }
        }
        if node.capture.truncated && *remaining > 0 {
            entries.push(RenderedEntry { prefix: format!("{indentation}- ... frame content truncated after {max_items} items"), ..Default::default() });
        }
    }

    // A snapshot scoped inside an iframe keeps that frame's key, so its refs match the ones of a full snapshot.
    let root_key = (scope.frame != main_frame).then(|| {
        let key = refs.frame_key(&scope.frame);
        frame_objects.insert(key.clone(), (scope.frame.clone(), scope.owner_generation));
        key
    });
    for (index, entry) in main.entries.iter().enumerate() {
        entries.push(RenderedEntry { frame_key: root_key.clone(), ..entry.clone() });
        if let Some(node) = frame_nodes.get(&index) {
            emit(node, main.depths[index] as usize + 1, &mut entries, &mut frame_objects, &mut remaining, &mut omitted, refs, max_items);
        }
    }
    if capture.truncated {
        entries.push(RenderedEntry { prefix: format!("- ... truncated after {max_items} items"), ..Default::default() });
    }
    if budget.skipped_items > 0 {
        entries.push(RenderedEntry { prefix: frame_skip_note(budget.skipped_items, "maxItems reached"), ..Default::default() });
    }
    if budget.skipped_budget > 0 {
        entries.push(RenderedEntry { prefix: frame_skip_note(budget.skipped_budget, &format!("{MAX_FRAMES} iframes at most per snapshot")), ..Default::default() });
    }
    if budget.skipped_deadline > 0 {
        entries.push(RenderedEntry { prefix: frame_skip_note(budget.skipped_deadline, "snapshot deadline reached"), ..Default::default() });
    }
    if omitted > 0 {
        entries.push(RenderedEntry { prefix: frame_skip_note(omitted, "maxItems reached"), ..Default::default() });
    }

    // Refs carry over from the previous snapshot of this tab even if its options differed.
    let same_tab_previous = refs.previous.as_ref().filter(|p| p.tab == page.tab() && p.document == document).cloned();
    let compatible_previous = same_tab_previous.as_ref().filter(|p| p.signature == signature).cloned();
    let mut next_ref = refs.next_ref.max(1);
    let mut reusable: HashMap<String, VecDeque<String>> = HashMap::new();
    for entry in same_tab_previous.as_ref().map(|p| p.entries.as_slice()).unwrap_or(&[]) {
        if let (Some(id), Some(key)) = (&entry.ref_id, ref_identity(entry)) {
            reusable.entry(key).or_default().push_back(id.clone());
        }
    }
    let rendered: Vec<RenderedEntry> = entries
        .into_iter()
        .map(|entry| match ref_identity(&entry) {
            None => entry,
            Some(key) => {
                let id = reusable.get_mut(&key).and_then(VecDeque::pop_front).unwrap_or_else(|| {
                    let id = format!("e{next_ref}");
                    next_ref += 1;
                    id
                });
                RenderedEntry { ref_id: Some(id), ..entry }
            }
        })
        .collect();
    refs.next_ref = next_ref;
    let root_owner = if scope.frame == main_frame { None } else { Some((scope.frame.clone(), scope.owner_generation)) };
    for entry in &rendered {
        let (Some(id), Some(selector), Some(role)) = (&entry.ref_id, &entry.selector, &entry.role) else { continue };
        let owner = match &entry.frame_key {
            Some(key) => frame_objects.get(key).cloned(),
            None => root_owner.clone(),
        };
        refs.selectors.insert(id.clone(), RefTarget { selector: selector.clone(), role: role.clone(), name: entry.identity_name.clone(), frame: owner });
    }
    refs.tab = Some(page.tab());
    refs.document = Some(document);
    refs.aria = None;
    let use_diff = options.diff || (options.delta && compatible_previous.is_some());
    refs.previous = Some(Baseline { tab: page.tab(), document, signature, entries: rendered.clone() });
    drop(refs_guard);

    if !use_diff {
        let mut notes = capture.notes.clone();
        if is_pdf {
            notes.push("- ... this tab shows Chrome's PDF viewer: the document's text is not in the page and can't be snapshotted. Use a screenshot to read it, or fetch the PDF and extract its text another way.".into());
        }
        let lines: Vec<String> = notes.into_iter().chain(rendered.iter().map(|e| format_line(e, e.ref_id.as_deref()))).collect();
        return match &options.find {
            Some(query) => find_lines(&lines, query, options.context),
            None => Ok(lines.join("\n")),
        };
    }
    let previous_entries = compatible_previous.map(|p| p.entries).unwrap_or_default();
    let mut lines: Vec<String> = capture.notes.clone();
    let (mut added, mut removed, mut unchanged) = (0, 0, 0);
    for op in diff_entries(&previous_entries, &rendered) {
        match op {
            DiffOp::Unchanged(_) => unchanged += 1,
            DiffOp::Removed(entry) => {
                removed += 1;
                lines.push(format_diff_line('-', &entry, None));
            }
            DiffOp::Added(entry) => {
                added += 1;
                lines.push(format_diff_line('+', &entry, entry.ref_id.as_deref()));
            }
        }
    }
    let plural = |n: usize, one: &str, many: &str| if n == 1 { one.to_string() } else { many.to_string() };
    lines.push(format!("{added} {}, {removed} {}, {unchanged} unchanged", plural(added, "addition", "additions"), plural(removed, "removal", "removals")));
    Ok(lines.join("\n"))
}

/// Playwright's AI-mode aria snapshot with refs, iframe documents merged under their iframe nodes. Refs are shown
/// as `a<n>` (`f<frame>a<n>` inside iframes) so they never collide with compact snapshot refs.
async fn aria_snapshot(page: &Arc<TabPage>, session: &PageSession, options: &Options) -> Result<String> {
    page.ensure_no_dialog()?;
    if options.diff || options.delta {
        bail!("diff and delta work with the compact snapshot only; leave mode unset");
    }
    let deadline = Instant::now() + Duration::from_millis(options.timeout_ms);
    let main = page.main_frame();
    let (frame, root) = match &options.within {
        Some(within) if !within.trim().is_empty() => {
            if target::is_compact_ref(within) {
                bail!("within takes a selector in aria mode");
            }
            let (frame, rest) = target::selector_frame(page, within, Duration::from_millis(options.timeout_ms)).await?;
            let rest = target::normalize_selector(rest.trim());
            if rest.is_empty() {
                (frame, None)
            } else {
                match page.call_element_result(&frame, "pickRoot", vec![v(&rest)], true).await? {
                    ElementOr::Element(element) => (frame, Some(element)),
                    ElementOr::Status(_) => bail!("snapshot within {within:?} matched nothing"),
                }
            }
        }
        _ => (main.clone(), None),
    };
    let depth = Some(options.depth);
    let mut frames = AriaFrames { budget: MAX_FRAMES, ..Default::default() };
    let json = match aria_frame(page, &frame, root, depth, deadline, &mut frames, 1).await {
        Ok(json) => json,
        Err(error) if error.to_string() == "timed out" => bail!(
            "Aria snapshot timed out after {} ms: the page did not finish building its accessibility tree in time. Narrow it with within or depth, use the compact snapshot (leave mode unset), or pass a longer timeout.",
            options.timeout_ms
        ),
        Err(error) => return Err(error),
    };
    let render_deadline = deadline.max(Instant::now() + Duration::from_secs(5));
    let yaml = with_deadline(render_deadline, page.call_value(&frame, "renderAria", vec![v(&json)], true))
        .await
        .map_err(|e| if e.to_string() == "timed out" { anyhow!("Aria snapshot timed out while rendering; narrow it with within or depth") } else { e })?;
    let yaml = yaml.as_str().unwrap_or_default().to_string();
    let mut rewritten = rewrite_aria_refs(&label_iframes(&yaml, &frames.labels));
    if frames.skipped_limit > 0 {
        rewritten.push('\n');
        rewritten.push_str(&frame_skip_note(frames.skipped_limit, &format!("{MAX_FRAMES} iframes at most per snapshot")));
    }
    if frames.skipped_deadline > 0 {
        rewritten.push('\n');
        rewritten.push_str(&frame_skip_note(frames.skipped_deadline, "snapshot deadline reached"));
    }
    {
        let mut refs = session.refs.lock().unwrap();
        refs.aria = Some(AriaRefs { tab: page.tab(), main_generation: page.frame(&main).map(|f| f.generation).unwrap_or(0), ids: aria_ref_ids(&rewritten) });
    }
    let lines: Vec<String> = rewritten.lines().map(str::to_string).collect();
    let text = match &options.find {
        Some(query) => find_lines(&lines, query, options.context)?,
        None => rewritten,
    };
    Ok(cap_aria(text))
}

/// The most characters an aria snapshot returns.
const MAX_ARIA_CHARS: usize = 100_000;

fn cap_aria(text: String) -> String {
    let total = text.chars().count();
    if total <= MAX_ARIA_CHARS {
        return text;
    }
    let cut: String = text.chars().take(MAX_ARIA_CHARS).collect();
    let cut = cut.rsplit_once('\n').map(|(head, _)| head.to_string()).unwrap_or(cut);
    format!("{cut}\n- ... truncated: the aria snapshot is {total} characters; narrow it with within, depth or find, or use the compact snapshot")
}

#[derive(Default)]
struct AriaFrames {
    budget: usize,
    skipped_limit: usize,
    skipped_deadline: usize,
    /// Playwright iframe refs to their label and, when the content is missing, why.
    labels: HashMap<String, (String, String, Option<String>)>,
}

fn aria_frame<'a>(
    page: &'a Arc<TabPage>,
    frame: &'a str,
    root: Option<Element>,
    depth: Option<i64>,
    deadline: Instant,
    frames: &'a mut AriaFrames,
    level: usize,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Value>> + Send + 'a>> {
    Box::pin(async move {
        let args = vec![root.map(crate::page::Arg::Element).unwrap_or(crate::page::Arg::Value(Value::Null)), v(json!({ "depth": depth }))];
        let snapshot = with_deadline(deadline, page.call_value(frame, "ariaSnapshot", args, true)).await?;
        let mut json = snapshot["json"].clone();
        let depths = snapshot["iframeDepths"].as_object().cloned().unwrap_or_default();
        let iframe_refs: Vec<String> = snapshot["iframeRefs"].as_array().map(|a| a.iter().filter_map(|r| r.as_str().map(str::to_string)).collect()).unwrap_or_default();
        let shown: Vec<&String> = iframe_refs.iter().filter(|r| depths.contains_key(*r)).collect();
        let mut children: HashMap<String, Value> = HashMap::new();
        for (index, reference) in shown.iter().enumerate() {
            let reference = (*reference).clone();
            // The iframe element and its label; cheap, so it gets a short floor past the deadline.
            let label_deadline = deadline.max(Instant::now() + Duration::from_millis(300));
            let element = with_deadline(label_deadline, async {
                match page.call_element_result(frame, "ariaRef", vec![v(&reference)], true).await? {
                    ElementOr::Element(element) => Ok(element),
                    ElementOr::Status(_) => bail!("gone"),
                }
            })
            .await
            .ok();
            let info = match &element {
                Some(element) => with_deadline(label_deadline, page.call_element(element, "iframeInfo", vec![], true)).await.unwrap_or(Value::Null),
                None => Value::Null,
            };
            let name = info["name"].as_str().unwrap_or("frame").to_string();
            let src = info["src"].as_str().unwrap_or_default().to_string();
            let note = |frames: &mut AriaFrames, note: Option<String>| {
                frames.labels.insert(reference.clone(), (name.clone(), src.clone(), note));
            };
            let Some(element) = element else {
                note(frames, Some("content not captured (the iframe is gone or has no frame attached)".into()));
                continue;
            };
            if level > MAX_FRAME_DEPTH {
                note(frames, Some(format!("content not captured (frames nested deeper than {MAX_FRAME_DEPTH})")));
                continue;
            }
            if frames.budget == 0 {
                frames.skipped_limit += 1;
                note(frames, None);
                continue;
            }
            let remaining = ms_left(deadline);
            if remaining == 0 {
                frames.skipped_deadline += 1;
                note(frames, None);
                continue;
            }
            let timeout = frame_timeout(remaining, frames.budget.min(shown.len() - index));
            let frame_deadline = deadline.min(Instant::now() + Duration::from_millis(timeout));
            frames.budget -= 1;
            let child_depth = depth.map(|d| d - depths[&reference].as_i64().unwrap_or(0) - 1);
            let child_frame = match page.content_frame(&element, Duration::from_millis(timeout)).await {
                Ok(child) => child,
                Err(_) => {
                    note(frames, Some("content not captured (the iframe is gone or has no frame attached)".into()));
                    continue;
                }
            };
            match aria_frame(page, &child_frame, None, child_depth, frame_deadline, frames, level + 1).await {
                Ok(value) => {
                    note(frames, None);
                    children.insert(reference.clone(), value);
                }
                Err(error) => note(frames, Some(format!("content not captured ({})", frame_failure_note(&error.to_string())))),
            }
        }
        merge_iframes(&mut json, &children);
        Ok(json)
    })
}

/// Gives Playwright's anonymous `- iframe [ref=e5]` lines their label (`- iframe "Checkout" [src=pay.example]`)
/// and a note under frames whose content is missing.
fn label_iframes(yaml: &str, labels: &HashMap<String, (String, String, Option<String>)>) -> String {
    static PATTERN: std::sync::OnceLock<regex_lite::Regex> = std::sync::OnceLock::new();
    let pattern = PATTERN.get_or_init(|| regex_lite::Regex::new(r#"^(\s*)- iframe(?: "(?:[^"\\]|\\.)*")?((?: \[[^\]]*\])*) \[ref=((?:f\d+)?e\d+)\](:?)$"#).unwrap());
    let mut out = Vec::new();
    for line in yaml.lines() {
        let Some(caps) = pattern.captures(line) else {
            out.push(line.to_string());
            continue;
        };
        let Some((name, src, note)) = labels.get(&caps[3]) else {
            out.push(line.to_string());
            continue;
        };
        let indent = &caps[1];
        let src = if src.is_empty() { String::new() } else { format!(" [src={src}]") };
        let colon = if note.is_some() { ":" } else { &caps[4] };
        out.push(format!("{indent}- iframe {}{src}{} [ref={}]{colon}", serde_json::to_string(name).unwrap_or_default(), &caps[2], &caps[3]));
        if let Some(note) = note {
            out.push(format!("{indent}  - ... {note}"));
        }
    }
    out.join("\n")
}

fn merge_iframes(node: &mut Value, children: &HashMap<String, Value>) {
    match node {
        Value::Array(items) => items.iter_mut().for_each(|item| merge_iframes(item, children)),
        Value::Object(object) => {
            if object.get("role").and_then(Value::as_str) == Some("iframe") {
                if let Some(reference) = object.get("ref").and_then(Value::as_str)
                    && let Some(child) = children.get(reference)
                        && child.as_array().map(|a| !a.is_empty()).unwrap_or(false) {
                            object.insert("children".into(), child.clone());
                        }
                return;
            }
            if let Some(items) = object.get_mut("children") {
                merge_iframes(items, children);
            }
        }
        _ => {}
    }
}

fn aria_ref_ids(yaml: &str) -> std::collections::HashSet<String> {
    static PATTERN: std::sync::OnceLock<regex_lite::Regex> = std::sync::OnceLock::new();
    let pattern = PATTERN.get_or_init(|| regex_lite::Regex::new(r"\[ref=((?:f\d+)?a\d+)\]").unwrap());
    pattern.captures_iter(yaml).map(|c| c[1].to_string()).collect()
}

pub fn rewrite_aria_refs(yaml: &str) -> String {
    static PATTERN: std::sync::OnceLock<regex_lite::Regex> = std::sync::OnceLock::new();
    let pattern = PATTERN.get_or_init(|| regex_lite::Regex::new(r"\[ref=(f\d+)?e(\d+)\]").unwrap());
    pattern.replace_all(yaml, "[ref=${1}a${2}]").into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(prefix: &str) -> RenderedEntry {
        RenderedEntry { prefix: prefix.into(), ..Default::default() }
    }

    #[test]
    fn renders_structural_parents_as_indentation() {
        let capture: Capture = serde_json::from_value(json!({
            "entries": [
                { "depth": 0, "baseDepth": 0, "key": "s1", "role": "list", "name": "Items", "details": "2 items", "priority": 2 },
                { "depth": 1, "baseDepth": 0, "parentKeys": ["s1"], "role": "link", "name": "One \"1\"", "identityName": "One", "selector": "#a", "priority": 1 },
                { "depth": 3, "baseDepth": 2, "role": "button", "name": "Go", "selector": "#b", "selectorRole": "label", "priority": 1 }
            ],
            "truncated": false
        }))
        .unwrap();
        let rendered = render_capture(&capture);
        assert_eq!(rendered.entries[0].prefix, "- list \"Items\"");
        assert_eq!(rendered.entries[1].prefix, "  - link \"One \\\"1\\\"\"");
        assert_eq!(rendered.entries[1].role.as_deref(), Some("link"));
        assert_eq!(rendered.entries[2].prefix, "    - button \"Go\"");
        assert_eq!(rendered.entries[2].role.as_deref(), Some("label"));
        assert_eq!(format_line(&rendered.entries[0], None), "- list \"Items\" [2 items]");
        assert_eq!(format_line(&rendered.entries[1], Some("e3")), "  - link \"One \\\"1\\\"\" [ref=e3]");
    }

    #[test]
    fn diff_marks_additions_and_removals() {
        let previous = vec![entry("- a"), entry("- b"), entry("- c")];
        let current = vec![entry("- a"), entry("- c"), entry("  - d")];
        let ops = diff_entries(&previous, &current);
        assert_eq!(ops.iter().filter(|o| matches!(o, DiffOp::Unchanged(_))).count(), 2);
        assert!(ops.contains(&DiffOp::Removed(entry("- b"))));
        assert!(ops.contains(&DiffOp::Added(entry("  - d"))));
        assert_eq!(format_diff_line('+', &entry("  - d"), Some("e4")), "+   d [ref=e4]");
    }

    #[test]
    fn find_shows_context_and_gaps() {
        let lines: Vec<String> = (0..10).map(|i| format!("- line {i}")).collect();
        let found = find_lines(&lines, "line 5", Some(1)).unwrap();
        assert_eq!(found, "1 matching snapshot line:\n...\n- line 4\n- line 5\n- line 6");
        assert!(find_lines(&lines, "/LINE [12]$/i", Some(0)).unwrap().starts_with("2 matching snapshot lines:"));
        assert_eq!(find_lines(&lines, "nope", None).unwrap(), "No snapshot lines matched \"nope\".");
    }

    #[test]
    fn aria_refs_are_renamed() {
        assert_eq!(rewrite_aria_refs("- button \"x\" [ref=e5]\n- iframe [ref=f1e2]"), "- button \"x\" [ref=a5]\n- iframe [ref=f1a2]");
    }

    #[test]
    fn aria_iframes_get_labels_and_notes() {
        let mut labels = HashMap::new();
        labels.insert("e5".to_string(), ("Checkout".to_string(), "pay.example".to_string(), None));
        labels.insert("e7".to_string(), ("frame".to_string(), String::new(), Some("content not captured (snapshot deadline reached)".to_string())));
        let yaml = "- main:\n  - iframe [ref=e5]:\n    - button \"Pay\" [ref=f1e2]\n  - iframe [ref=e7]";
        let labelled = label_iframes(yaml, &labels);
        assert_eq!(
            labelled,
            "- main:\n  - iframe \"Checkout\" [src=pay.example] [ref=e5]:\n    - button \"Pay\" [ref=f1e2]\n  - iframe \"frame\" [ref=e7]:\n    - ... content not captured (snapshot deadline reached)"
        );
        assert_eq!(aria_ref_ids(&rewrite_aria_refs(&labelled)), ["a5", "f1a2", "a7"].iter().map(|s| s.to_string()).collect());
    }

    #[test]
    fn aria_output_is_capped() {
        let long = "- text: x\n".repeat(20_000);
        let capped = cap_aria(long);
        assert!(capped.chars().count() < MAX_ARIA_CHARS + 200);
        assert!(capped.ends_with("or use the compact snapshot"));
    }

    #[test]
    fn frame_timeouts_share_the_deadline() {
        assert_eq!(frame_timeout(8_000, 4), 2_000);
        assert_eq!(frame_timeout(2_000, 8), 1_000);
        assert_eq!(frame_timeout(500, 8), 500);
    }
}
