//! `execute`: JavaScript for MCP clients without a code mode of their own (Claude Code, Codex, Cursor, ...). The code
//! runs in an embedded QuickJS on its own thread and drives the browser through browse's own tools, with a
//! Playwright-style `page`/`locator` layer on top so scripts agents write from memory mostly work as they are.
//! No Node, no Playwright, no host access beyond browse calls, timers and `files` inside the file roots.

mod engine;
mod files;
mod host;
mod query;
#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use browse_core::{Content, TabId, Tool, ToolContext, ToolOutput, ToolSpec};
use serde_json::{Value, json};

pub use engine::CPU_SLICE;

/// The execute tool, calling `others` (every other tool of the build) in-process with the execute's context.
pub fn tools(others: &[Arc<dyn Tool>]) -> Vec<Arc<dyn Tool>> {
    let map: HashMap<String, Arc<dyn Tool>> = others.iter().map(|tool| (tool.spec().name, tool.clone())).filter(|(name, _)| name != "execute").collect();
    vec![Arc::new(ExecuteTool { tools: Arc::new(map) })]
}

pub const NAME: &str = "execute";
const DEFAULT_TIMEOUT_MS: u64 = 60_000;
const STATE_KEY: &str = "browse-script/state";
const MAX_STATE: usize = 1024 * 1024;
const MAX_RESULT_CHARS: usize = 100_000;
const MAX_IMAGES: usize = 20;

/// A tool's failure the agent can act on (used by the shared files rules).
#[derive(Debug)]
pub(crate) struct UserError(pub String);

impl std::fmt::Display for UserError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for UserError {}

macro_rules! bail_user {
    ($($arg:tt)*) => { return Err(anyhow::Error::new($crate::UserError(format!($($arg)*)))) };
}
pub(crate) use bail_user;

struct ExecuteTool {
    tools: Arc<HashMap<String, Arc<dyn Tool>>>,
}

pub const DESCRIPTION: &str = "Run JavaScript that drives the browser: the user's real Chrome-family browser, through the browse extension. The code is an async function body (a single expression is returned; `return` a value to get it back) running in a small sandboxed JavaScript engine on the relay: no Node, no require/import, no fs, process or fetch (fetch belongs to the page: use page.evaluate). Synchronous code stops after about 2 seconds without an await. The result has the returned value (JSON, or the string as is), console output, warnings, and what happened to the page (URL changes, navigations, handoffs, a bot challenge: try solving an interactive one first and hand it off with handoff() if it doesn't clear, never retry-loop a blocked site). Return a screenshot (`return await page.screenshot()`) to see it. Tabs are the handle: without `tab`, `page.goto(url)` opens a new tab; the result starts with `tab: <id>`, which you pass as `tab` to the next execute to continue there (with the same `state`). Close tabs you opened when you're done (`page.close()`).";

const CODE_DESCRIPTION: &str = "JavaScript (an async function body). Globals:
- page: a Playwright-style Page for the tab passed as `tab`; without one it has no tab until its first goto(url), which opens a new tab. goto(url, {waitUntil, timeout}), url(), title(), content(), evaluate(fn | string, arg), $eval/$$eval, waitForTimeout/Selector/URL/LoadState/Function, click/fill/type/press/hover/selectOption/check/uncheck(selector, ...), locator(selector), getByRole/Text/Label/Placeholder/TestId/AltText/Title, frameLocator, keyboard.press/type, mouse.click/move/wheel, screenshot({path, fullPage}), goBack/goForward/reload, setViewportSize, close(). Locators: click, dblclick, fill, clear, type, pressSequentially, press, hover, check, uncheck, selectOption, setInputFiles, textContent, innerText, innerHTML, inputValue, getAttribute, isVisible/Hidden/Checked/Enabled/Disabled, count, all, first, last, nth, filter, locator, getBy*, waitFor, evaluate, evaluateAll, allTextContents, boundingBox, screenshot, dragTo. Selectors are CSS or Playwright selectors (role=button[name=\"Save\"], text=Sign in, >> nth=0, iframe >> frame >> ...). Locators are strict: one element. setInputFiles takes paths, { name, buffer } with bytes, or { name, data } with base64 for files not on this machine.
- context.newPage() (a new tab), context.pages() (the tabs this execute works in and their popups); browser.contexts().
- snapshot(options?) → a compact outline with refs (options: find, diff, delta, interactive, within, mode: \"aria\"); ref(\"e12\") → a locator for a snapshot ref. Prefer snapshot + ref over guessing selectors.
- handoff(message, {timeoutMs?, start?}) when only the user can proceed (login, 2FA, captcha, payment); demonstrate(message) to watch the user do a flow.
- screenshotWithLabels(), screenshotDiff({baseline}), network.start/status/stop/cancel, pageConsole.start/read/stop, webmcp.list/call(name, input).
- browse.<tool>(args): any browse tool directly (navigate, snapshot, click, fill, type, press, select, hover, drag, scroll, eval, wait_for, dialog, upload, emulate, webmcp, screenshot, screenshot_diff, network, console, recording, tabs, handoff, demonstrate, status, settings); they act in `page`'s tab unless you pass `tab` (browse.navigate without one opens a tab for `page`); returns its JSON and throws its error.
- files.path(name), files.write(name, data), files.read(name, encoding?) inside the file roots (files.dir, files.roots).
- state: an object kept with the tab between execute calls that pass it as `tab` (JSON values only).
- console.log/warn/error (shown in the result), setTimeout/clearTimeout/setInterval/clearInterval.";

#[async_trait]
impl Tool for ExecuteTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: NAME.into(),
            description: DESCRIPTION.into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "code": { "type": "string", "description": CODE_DESCRIPTION },
                    "timeoutMs": { "type": "integer", "minimum": 0, "description": "Overall timeout in milliseconds (paused while handoff waits on the user); default 60000, 0 for none. Includes waiting behind another execute in the same tab." },
                    "tab": { "type": ["integer", "string"], "description": "The tab `page` stands for: the `tab` an earlier execute (or navigate, tabs) returned, or a chosen id like `work-mail` given to tabs new. Leave it out to start without a tab; page.goto(url) then opens one." },
                },
                "required": ["code"],
                "additionalProperties": false,
            }),
            output_schema: None,
        }
    }

    async fn call(&self, ctx: ToolContext, args: Value) -> anyhow::Result<ToolOutput> {
        let Some(code) = args.get("code").and_then(Value::as_str).filter(|c| !c.trim().is_empty()) else {
            return Ok(ToolOutput::error("execute needs code"));
        };
        let timeout_ms = args.get("timeoutMs").and_then(Value::as_u64).unwrap_or(DEFAULT_TIMEOUT_MS);
        let tab = match args.get("tab").filter(|value| !value.is_null()) {
            None => None,
            Some(value) => match ctx.browser.resolve_tab(value) {
                Ok(tab) => Some(tab),
                Err(error) => return Ok(ToolOutput::error(format!("{error:#}"))),
            },
        };
        let started = std::time::Instant::now();
        // One execute at a time per tab: they share its `page` and `state`.
        let slot = match tab {
            Some(tab) => match state_slot(&ctx, tab).await {
                Ok(slot) => Some(slot),
                Err(error) => return Ok(ToolOutput::error(format!("{error:#}"))),
            },
            None => None,
        };
        let mut held = match &slot {
            None => None,
            Some(slot) => match timeout_ms {
                0 => Some(slot.clone().lock_owned().await),
                ms => match tokio::time::timeout(std::time::Duration::from_millis(ms), slot.clone().lock_owned()).await {
                    Ok(guard) => Some(guard),
                    Err(_) => return Ok(ToolOutput::error(format!("execute timed out after {ms} ms waiting for another execute in tab {} to finish", tab.unwrap_or_default()))),
                },
            },
        };
        let remaining = match timeout_ms {
            0 => 0,
            ms => ms.saturating_sub(started.elapsed().as_millis() as u64).max(1),
        };
        let mut tools: Vec<String> = self.tools.keys().cloned().collect();
        tools.sort();
        let state = held.as_deref().cloned().unwrap_or_else(|| "{}".to_string());
        let job = engine::Job { code: code.to_string(), state, tools, tab, timeout_ms: remaining };
        let host = host::Host { ctx: ctx.clone(), tools: self.tools.clone() };
        let outcome = host.run(job).await;
        let mut warnings = outcome.warnings.clone();
        let report = outcome.finished.as_ref().and_then(|f| f.report.as_ref());
        // The tab `page` ended on (none once it closed its tab); without a report (a timeout), the one it started on.
        let ended_on = match report {
            Some(report) => report["tab"].as_i64(),
            None => tab,
        };
        let mut used: Vec<TabId> = report.and_then(|r| r["tabs"].as_array()).map(|list| list.iter().filter_map(Value::as_i64).collect()).unwrap_or_default();
        used.retain(|t| Some(*t) != ended_on);
        if let Some(saved) = outcome.finished.as_ref().and_then(|f| f.state.clone()) {
            if saved.len() > MAX_STATE {
                warnings.push(format!("state is {} KB as JSON, more than the {} KB kept between calls, so this call's changes to it were dropped", saved.len() / 1024, MAX_STATE / 1024));
            } else {
                match (&mut held, ended_on) {
                    (Some(guard), Some(on)) if Some(on) == tab => **guard = saved,
                    // `page` opened its tab during the run: the state goes with that tab.
                    (_, Some(on)) => {
                        if let Ok(slot) = state_slot(&ctx, on).await {
                            *slot.lock().await = saved;
                        }
                    }
                    _ => {}
                }
            }
        }
        drop(held);
        Ok(render(outcome, warnings, ended_on, &used))
    }
}

/// The tab's execute slot: its `state` as JSON, locked while an execute runs in the tab.
async fn state_slot(ctx: &ToolContext, tab: TabId) -> anyhow::Result<Arc<tokio::sync::Mutex<String>>> {
    Ok(ctx.state(tab).await?.get_or_insert(STATE_KEY, || Arc::new(tokio::sync::Mutex::new("{}".to_string()))).await)
}

fn clip(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_string();
    }
    let cut: String = text.chars().take(limit).collect();
    format!("{cut}\n… [truncated {} characters]", text.chars().count() - limit)
}

/// The execute result: the tab to continue in, the value (or error), then warnings, the page summary and console
/// output, then images.
fn render(outcome: host::Outcome, mut warnings: Vec<String>, tab: Option<TabId>, others: &[TabId]) -> ToolOutput {
    let report = outcome.finished.as_ref().and_then(|f| f.report.clone());
    let stopped = outcome.finished.as_ref().and_then(|f| f.stopped.clone());
    let mut is_error = true;
    let mut images: Vec<usize> = Vec::new();
    let head = if let Some(ms) = outcome.timed_out {
        format!("Error: execute timed out after {ms} ms (pass a larger timeoutMs, or split the work into several calls)")
    } else if let Some(message) = stopped {
        format!("Error: {message}")
    } else if let Some(report) = report {
        if let Some(list) = report["warnings"].as_array() {
            warnings.extend(list.iter().filter_map(Value::as_str).map(str::to_string));
        }
        images = report["images"].as_array().map(|ids| ids.iter().filter_map(Value::as_u64).map(|id| id as usize).collect()).unwrap_or_default();
        if report["ok"] == true {
            is_error = false;
            let text = report["text"].as_str().unwrap_or("undefined");
            if text.chars().count() > MAX_RESULT_CHARS {
                warnings.push(format!(
                    "The result is {} characters, more than the {MAX_RESULT_CHARS} an execute returns: the text shows its start. To keep all of it, write it to a file (await files.write(\"result.json\", JSON.stringify(data))) and return only what you need.",
                    text.chars().count()
                ));
            }
            clip(text, MAX_RESULT_CHARS)
        } else {
            let message = report["error"].as_str().unwrap_or("execute failed");
            clip(message, 3_000)
        }
    } else {
        "Error: execute ended without a result".into()
    };
    let mut parts = Vec::new();
    if let Some(tab) = tab {
        let also = if others.is_empty() { String::new() } else { format!(" (also used: {})", others.iter().map(|t| t.to_string()).collect::<Vec<_>>().join(", ")) };
        parts.push(format!("tab: {tab}{also}"));
    }
    parts.push(head);
    if !warnings.is_empty() {
        parts.push(format!("Warnings:\n{}", warnings.iter().map(|w| format!("- {w}")).collect::<Vec<_>>().join("\n")));
    }
    if let Some(line) = aftermath_line(&outcome.aftermath) {
        parts.push(line);
    }
    if !outcome.logs.is_empty() {
        let mut lines: Vec<String> = outcome.logs.iter().map(|(level, text)| if level == "log" { text.clone() } else { format!("[{level}] {text}") }).collect();
        if outcome.dropped_logs > 0 {
            lines.push(format!("… {} more lines not shown", outcome.dropped_logs));
        }
        parts.push(format!("Console:\n{}", clip(&lines.join("\n"), 20_000)));
    }
    let mut content = vec![Content::Text { text: parts.join("\n\n") }];
    let mut attached = 0;
    for id in images {
        if attached >= MAX_IMAGES {
            break;
        }
        if let Some(image) = outcome.images.get(id) {
            content.push(Content::Image { data: image.data.clone(), mime_type: image.mime_type.clone() });
            attached += 1;
        }
    }
    ToolOutput { content, is_error, structured_content: None }
}

fn aftermath_line(after: &host::Aftermath) -> Option<String> {
    let mut parts = Vec::new();
    match (&after.start_url, &after.end_url) {
        (Some(_), None) => parts.push("the page closed".to_string()),
        // The page opened its tab during the run: the navigations say where it went.
        (None, Some(_)) => {}
        (start, Some(end)) if start.as_deref() != Some(end.as_str()) => {
            parts.push(format!("moved from {} to {}", clip(start.as_deref().unwrap_or("nowhere"), 200), clip(end, 200)))
        }
        _ => {}
    }
    let plural = |n: usize, word: &str| format!("{n} {word}{}", if n == 1 { "" } else { "s" });
    if !after.navigations.is_empty() {
        parts.push(plural(after.navigations.len(), "navigation"));
    }
    if after.handoffs > 0 {
        parts.push(plural(after.handoffs as usize, "handoff"));
    }
    if after.new_tabs > 0 {
        parts.push(plural(after.new_tabs as usize, "new tab"));
    }
    if let Some(dialog) = after.dialogs.last() {
        parts.push(format!("a dialog opened ({})", clip(dialog, 200)));
    }
    let mut lines = Vec::new();
    if !parts.is_empty() {
        lines.push(format!("Page: {}", parts.join("; ")));
    }
    if let Some(challenge) = &after.challenge {
        lines.push(format!("Challenge: {challenge} (try solving an interactive one first, hand off with handoff() if it doesn't clear; never retry-loop it)"));
    }
    (!lines.is_empty()).then(|| lines.join("\n"))
}
