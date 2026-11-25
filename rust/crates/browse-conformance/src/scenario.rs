//! The scenarios, and the runner that records them.
//!
//! A scenario gets a `Run` and nothing that names the backend: the same code drives every browser. Each step is one
//! tool call (or a ground-truth `check`) with an explicit expectation, bounded by `STEP_TIMEOUT`; nothing sleeps:
//! anything that settles over time is polled with `eventually`, and only its final call is recorded.

use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context, anyhow, bail};
use base64::Engine;
use browse_core::{Browser, Content, TabId, Tool, ToolContext, ToolOutput};
use serde_json::{Value, json};

use crate::browser::HarnessBrowser;
use crate::launch::{Launched, TempDir, VIEWPORT};
use crate::sites::{FixtureSites, PASSWORD};
use crate::transcript::{Expect, Normalizer, StepRecord};

/// Longer than any tool's own bound (its timeout, at least 10 s, plus 10 s), so a tool always answers first.
pub const STEP_TIMEOUT: Duration = Duration::from_secs(25);
pub const SCENARIO_TIMEOUT: Duration = Duration::from_secs(120);

pub type ScenarioFuture<'a> = Pin<Box<dyn Future<Output = anyhow::Result<()>> + Send + 'a>>;

pub struct Scenario {
    pub name: &'static str,
    pub run: for<'a, 'e> fn(&'a mut Run<'e>) -> ScenarioFuture<'a>,
}

/// One backend's browser, sites and tools, shared by its scenarios.
pub struct Env {
    label: String,
    pub browser: Arc<HarnessBrowser>,
    pub sites: Arc<FixtureSites>,
    pub files: TempDir,
    pub downloads: PathBuf,
    tools: HashMap<String, Arc<dyn Tool>>,
    normalizer: Normalizer,
    baseline: std::sync::Mutex<Option<Value>>,
}

impl Env {
    pub async fn new(launched: &Launched) -> anyhow::Result<Env> {
        let sites = Arc::new(FixtureSites::start().await?);
        let files = TempDir::new("files")?;
        let browser = HarnessBrowser::new(launched.driver.clone(), launched.control.clone());
        let mut tools = browse_page::tools();
        tools.extend(browse_capture::tools());
        let script = browse_script::tools(&tools);
        tools.extend(script);
        let tools = tools.into_iter().map(|tool| (tool.spec().name, tool)).collect();
        let normalizer = Normalizer {
            primary: sites.primary_host().to_string(),
            cross: sites.cross_host().to_string(),
            files: vec![files.path().to_path_buf(), launched.downloads.clone(), std::env::temp_dir()],
        };
        Ok(Env {
            label: launched.label.clone(),
            browser,
            sites,
            files,
            downloads: launched.downloads.clone(),
            tools,
            normalizer,
            baseline: std::sync::Mutex::new(None),
        })
    }

    pub fn context(&self) -> ToolContext {
        ToolContext { browser: self.browser.clone(), file_roots: vec![self.files.path().to_path_buf()] }
    }

    /// Runs the scenarios in order, each in fresh tabs; returns every step recorded.
    pub async fn run(&self, scenarios: &[&Scenario]) -> Vec<StepRecord> {
        let mut records = Vec::new();
        for scenario in scenarios {
            self.browser.reset().await;
            self.sites.clear_log();
            let mut run = Run { scenario: scenario.name, env: self, records: Vec::new() };
            let started = Instant::now();
            let outcome = tokio::time::timeout(SCENARIO_TIMEOUT, (scenario.run)(&mut run)).await;
            if std::env::var_os("BROWSE_CONFORMANCE_VERBOSE").is_some() {
                eprintln!("    {} {}: {:.1} s", self.label, scenario.name, started.elapsed().as_secs_f64());
            }
            let failure = match outcome {
                Ok(Ok(())) => None,
                Ok(Err(error)) => Some(format!("{error:#}")),
                Err(_) => Some(format!("the scenario did not finish within {} s", SCENARIO_TIMEOUT.as_secs())),
            };
            if let Some(failure) = failure {
                let text = self.normalizer.text(&failure);
                run.records.push(StepRecord {
                    scenario: scenario.name.to_string(),
                    step: "<aborted>".into(),
                    tool: "-".into(),
                    expect: Expect::Ok,
                    is_error: true,
                    raw: failure,
                    normalized: json!({ "error": true, "result": text }),
                    images: Vec::new(),
                    problems: Vec::new(),
                });
            }
            records.extend(run.records);
        }
        self.browser.reset().await;
        records
    }
}

/// One scenario's view of the backend.
pub struct Run<'e> {
    scenario: &'static str,
    env: &'e Env,
    pub records: Vec<StepRecord>,
}

pub fn text_of(output: &ToolOutput) -> String {
    output
        .content
        .iter()
        .filter_map(|c| match c {
            Content::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn parse(text: &str) -> Value {
    serde_json::from_str(text).unwrap_or_else(|_| Value::String(text.to_string()))
}

/// The ref on the first snapshot line containing `needle`.
pub fn ref_of(snapshot: &str, needle: &str) -> anyhow::Result<String> {
    let line = snapshot
        .lines()
        .find(|l| l.contains(needle))
        .ok_or_else(|| anyhow!("no snapshot line with {needle:?} in:\n{snapshot}"))?;
    let start = line.find("[ref=").ok_or_else(|| anyhow!("no ref on {line:?}"))? + 5;
    Ok(line[start..].split([']', ' ']).next().unwrap_or_default().to_string())
}

impl Run<'_> {
    pub fn sites(&self) -> &FixtureSites {
        &self.env.sites
    }

    pub fn url(&self, path: &str) -> String {
        self.env.sites.url(path)
    }

    pub fn cross(&self, path: &str) -> String {
        self.env.sites.cross_url(path)
    }

    pub fn files(&self) -> &Path {
        self.env.files.path()
    }

    pub fn downloads(&self) -> &Path {
        &self.env.downloads
    }

    pub fn browser(&self) -> &Arc<HarnessBrowser> {
        &self.env.browser
    }

    /// Calls a tool without recording it (for the sweep's own bookkeeping).
    pub async fn quiet(&self, tool: &str, args: Value) -> anyhow::Result<ToolOutput> {
        let tool = self.env.tools.get(tool).ok_or_else(|| anyhow!("no tool {tool}"))?.clone();
        match tokio::time::timeout(STEP_TIMEOUT, tool.call(self.env.context(), args)).await {
            Ok(Ok(output)) => Ok(output),
            Ok(Err(error)) => Ok(ToolOutput::error(format!("{error:#}"))),
            Err(_) => bail!("the call did not finish within {} s", STEP_TIMEOUT.as_secs()),
        }
    }

    fn record(&mut self, step: &str, tool: &str, expect: Expect, output: &ToolOutput, probes: &[(u32, u32)]) {
        let (raw, normalized, images, problems) = self.env.normalizer.output(output, probes);
        self.records.push(StepRecord {
            scenario: self.scenario.to_string(),
            step: step.to_string(),
            tool: tool.to_string(),
            expect,
            is_error: output.is_error,
            raw,
            normalized,
            images,
            problems,
        });
    }

    /// Calls a tool and records the step; an overrun of `STEP_TIMEOUT` ends the scenario.
    pub async fn call(&mut self, step: &str, tool: &str, args: Value, expect: Expect, probes: &[(u32, u32)]) -> anyhow::Result<ToolOutput> {
        let output = match self.quiet(tool, args).await {
            Ok(output) => output,
            Err(error) => {
                let output = ToolOutput::error(format!("step timed out: {error}"));
                self.record(step, tool, expect, &output, probes);
                bail!("{step}: {error}");
            }
        };
        self.record(step, tool, expect, &output, probes);
        Ok(output)
    }

    /// A step that should succeed; its result as JSON (or a JSON string of its text).
    pub async fn ok(&mut self, step: &str, tool: &str, args: Value) -> anyhow::Result<Value> {
        let output = self.call(step, tool, args, Expect::Ok, &[]).await?;
        Ok(parse(&text_of(&output)))
    }

    /// A step that should succeed; its text.
    pub async fn text(&mut self, step: &str, tool: &str, args: Value) -> anyhow::Result<String> {
        let output = self.call(step, tool, args, Expect::Ok, &[]).await?;
        Ok(text_of(&output))
    }

    /// A step that should fail; its error text.
    pub async fn err(&mut self, step: &str, tool: &str, args: Value) -> anyhow::Result<String> {
        let output = self.call(step, tool, args, Expect::Error, &[]).await?;
        Ok(text_of(&output))
    }

    /// A screenshot-like step whose image keeps the colors at `probes`.
    pub async fn image(&mut self, step: &str, tool: &str, args: Value, probes: &[(u32, u32)]) -> anyhow::Result<Value> {
        let output = self.call(step, tool, args, Expect::Ok, probes).await?;
        Ok(parse(&text_of(&output)))
    }

    /// A ground-truth check, recorded as a step: it fails (on the reference, or unpinned elsewhere) unless `pass`.
    pub fn check(&mut self, step: &str, pass: bool, detail: Value) {
        let detail = self.env.normalizer.value(detail, &mut Vec::new());
        let body = json!({ "pass": pass, "detail": detail }).to_string();
        let output = if pass { ToolOutput::text(body) } else { ToolOutput::error(body) };
        self.record(step, "check", Expect::Ok, &output, &[]);
    }

    /// Polls a tool (every 100 ms, for at most `within`) until `done` holds for its result, and records the last call.
    pub async fn eventually(
        &mut self,
        step: &str,
        tool: &str,
        args: Value,
        within: Duration,
        done: impl Fn(&Value) -> bool,
    ) -> anyhow::Result<(bool, Value)> {
        let started = Instant::now();
        loop {
            let output = self.quiet(tool, args.clone()).await?;
            let value = parse(&text_of(&output));
            let held = !output.is_error && done(&value);
            if held || started.elapsed() >= within {
                self.record(step, tool, Expect::Ok, &output, &[]);
                return Ok((held, value));
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    /// The JSON value of `expression` in tab `tab` (isolated world), recorded as a step.
    pub async fn eval(&mut self, step: &str, tab: TabId, expression: &str) -> anyhow::Result<Value> {
        self.ok(step, "eval", json!({ "tab": tab, "expression": expression })).await
    }

    /// Opens a tab on about:blank, gives it the sweep's viewport, then loads `path`: three steps.
    pub async fn open(&mut self, path: &str) -> anyhow::Result<TabId> {
        // Visible, as a person's tab would be: Firefox throttles a background tab's timers to one a second.
        let opened = self.ok("open", "navigate", json!({ "url": "about:blank", "keepVisible": true })).await?;
        let tab = opened["tab"].as_i64().ok_or_else(|| anyhow!("navigate opened no tab: {opened}"))?;
        self.viewport("viewport", tab).await?;
        let url = self.url(path);
        self.ok("goto", "navigate", json!({ "tab": tab, "url": url })).await?;
        Ok(tab)
    }

    pub async fn viewport(&mut self, step: &str, tab: TabId) -> anyhow::Result<()> {
        let (width, height) = VIEWPORT;
        self.ok(
            step,
            "emulate",
            json!({ "tab": tab, "viewport": { "width": width, "height": height, "deviceScaleFactor": 1 } }),
        )
        .await?;
        Ok(())
    }

    /// Writes a file in the file root.
    pub fn write_file(&self, name: &str, contents: &str) -> anyhow::Result<String> {
        let path = self.files().join(name);
        std::fs::write(&path, contents).with_context(|| format!("writing {}", path.display()))?;
        Ok(path.display().to_string())
    }
}

macro_rules! scenario {
    ($name:ident) => {
        Scenario { name: stringify!($name), run: |r| Box::pin($name(r)) }
    };
}

/// Every scenario, in the order they run: the baseline first, the leak canary last.
pub fn all() -> Vec<Scenario> {
    vec![
        scenario!(baseline),
        scenario!(app),
        scenario!(spa),
        scenario!(frames),
        scenario!(dialogs),
        scenario!(upload),
        scenario!(drag),
        scenario!(csp),
        scenario!(network),
        scenario!(console),
        scenario!(visual),
        scenario!(non_html),
        scenario!(hangs),
        scenario!(popups),
        scenario!(emulation),
        scenario!(policy),
        scenario!(script),
        scenario!(background),
        scenario!(leak_canary),
    ]
}

const FINGERPRINT: &str = "({ width: innerWidth, height: innerHeight, ratio: devicePixelRatio, agent: navigator.userAgent, online: navigator.onLine, dark: matchMedia('(prefers-color-scheme: dark)').matches, print: matchMedia('print').matches })";

/// A fresh tab's defaults, which the leak canary compares a later fresh tab against.
async fn baseline(r: &mut Run<'_>) -> anyhow::Result<()> {
    let opened = r.ok("open", "navigate", json!({ "url": r.url("/") })).await?;
    let tab = opened["tab"].as_i64().unwrap_or(1);
    let fingerprint = parse(&text_of(&r.quiet("eval", json!({ "tab": tab, "expression": FINGERPRINT })).await?));
    let usable = fingerprint["width"].as_u64().is_some_and(|w| w > 0) && fingerprint["agent"].is_string();
    *r.env.baseline.lock().unwrap() = Some(fingerprint);
    r.check("fingerprint", usable, json!({}));
    Ok(())
}

async fn app(r: &mut Run<'_>) -> anyhow::Result<()> {
    let tab = r.open("/app").await?;
    let snap = r.text("snapshot", "snapshot", json!({ "tab": tab })).await?;
    let name = ref_of(&snap, "textbox \"Name\"")?;
    r.ok(
        "fill-form",
        "fill",
        json!({ "tab": tab, "fields": [
            { "ref": name, "value": "Ada Lovelace" },
            { "selector": "#password", "value": PASSWORD },
            { "selector": "#notes", "value": "line one\nline two" },
            { "selector": "#color", "value": "Green" },
            { "selector": "#agree", "checked": true },
            { "selector": "input[value=l]", "checked": true },
        ] }),
    )
    .await?;
    r.ok("submit", "click", json!({ "tab": tab, "selector": "role=button[name=\"Submit form\"]" })).await?;
    r.eval("submitted", tab, "document.getElementById('submitted').textContent").await?;
    r.ok("click-counter", "click", json!({ "tab": tab, "selector": "#counter" })).await?;
    r.ok("double-click", "click", json!({ "tab": tab, "selector": "#dbl", "clickCount": 2 })).await?;
    r.ok("type-keys", "type", json!({ "tab": tab, "selector": "#keys", "text": "aZ" })).await?;
    // No Shift+Arrow selection: keys sent while a text field has a selection can spin Chromium 148's new headless
    // mode on macOS in AppKit's key-equivalent dispatch for good (a Chromium bug; headful Chrome is fine).
    r.ok("press-keys", "press", json!({ "tab": tab, "selector": "#keys", "key": ["ArrowLeft", "Backspace", "Enter"] })).await?;
    r.ok("events", "eval", json!({ "tab": tab, "world": "main", "expression": "window.__events" })).await?;
    r.eval("keys-value", tab, "document.getElementById('keys').value").await?;
    r.ok("add-item", "click", json!({ "tab": tab, "selector": "#add" })).await?;
    r.text("snapshot-diff", "snapshot", json!({ "tab": tab, "diff": true })).await?;
    r.ok("shadow-click", "click", json!({ "tab": tab, "selector": "role=button[name=\"Shadow button\"]" })).await?;
    r.eval("shadow-state", tab, "document.getElementById('host').shadowRoot.getElementById('sbtn').textContent").await?;
    r.ok("type-editor", "type", json!({ "tab": tab, "selector": "#editor", "text": "café 🚀 日本" })).await?;
    r.eval("editor-text", tab, "document.getElementById('editor').textContent").await?;
    r.err("covered", "click", json!({ "tab": tab, "selector": "#covered", "timeout": 2000 })).await?;
    r.ok("open-modal", "click", json!({ "tab": tab, "selector": "#open-modal" })).await?;
    r.text("modal-snapshot", "snapshot", json!({ "tab": tab })).await?;
    r.ok("close-modal", "click", json!({ "tab": tab, "selector": "#close-modal" })).await?;
    r.ok("select-color", "select", json!({ "tab": tab, "selector": "#color", "values": "Blue" })).await?;
    r.ok("scroll-inner", "scroll", json!({ "tab": tab, "selector": "#scroller", "deltaY": 300 })).await?;
    r.ok("wheel-events", "eval", json!({ "tab": tab, "world": "main", "expression": "window.__wheels" })).await?;
    r.ok("scroll-bottom", "scroll", json!({ "tab": tab, "to": "bottom" })).await?;
    r.ok("scroll-top", "scroll", json!({ "tab": tab, "to": "top" })).await?;
    r.ok("scroll-into-view", "scroll", json!({ "tab": tab, "selector": "#bottom" })).await?;
    r.ok("hover-header", "hover", json!({ "tab": tab, "selector": "#hbtn" })).await?;
    r.ok("click-header", "click", json!({ "tab": tab, "selector": "#hbtn" })).await?;
    r.eval("intl", tab, "document.getElementById('intl').textContent").await?;
    r.text("find", "snapshot", json!({ "tab": tab, "find": "café" })).await?;
    Ok(())
}

async fn spa(r: &mut Run<'_>) -> anyhow::Result<()> {
    let tab = r.open("/spa").await?;
    r.text("snapshot", "snapshot", json!({ "tab": tab })).await?;
    r.ok("fragment", "click", json!({ "tab": tab, "selector": "text=Jump to details" })).await?;
    r.eval("hash", tab, "location.hash").await?;
    r.ok("push-state", "click", json!({ "tab": tab, "selector": "#push" })).await?;
    r.ok("wait-pushed", "wait_for", json!({ "tab": tab, "url": "/spa/pushed" })).await?;
    r.ok("back-from-push", "navigate", json!({ "tab": tab, "action": "back" })).await?;
    r.ok("next-link", "click", json!({ "tab": tab, "selector": "text=Next page" })).await?;
    r.ok("back", "navigate", json!({ "tab": tab, "action": "back" })).await?;
    r.ok("forward", "navigate", json!({ "tab": tab, "action": "forward" })).await?;
    r.ok("reload", "navigate", json!({ "tab": tab, "action": "reload" })).await?;
    r.ok("redirects", "navigate", json!({ "tab": tab, "url": r.url("/redirect/3") })).await?;
    r.ok("not-found", "navigate", json!({ "tab": tab, "url": r.url("/missing") })).await?;
    r.eval("not-found-timing", tab, "(() => { const e = performance.getEntriesByType('navigation')[0]; return [e.responseStatus, e.name, document.title] })()").await?;
    r.ok("server-error", "navigate", json!({ "tab": tab, "url": r.url("/status/500") })).await?;
    r.ok("spa-again", "navigate", json!({ "tab": tab, "url": r.url("/spa") })).await?;
    let home_downloads = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(|h| PathBuf::from(h).join("Downloads").join("conformance.bin"));
    let existed = home_downloads.as_ref().is_some_and(|p| p.exists());
    r.ok("download-link", "click", json!({ "tab": tab, "selector": "text=Download file" })).await?;
    let target = r.downloads().join("conformance.bin");
    let started = Instant::now();
    while !target.exists() && started.elapsed() < Duration::from_secs(10) {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let landed = target.exists();
    let stray = !existed && home_downloads.as_ref().is_some_and(|p| p.exists());
    r.check("downloaded-to-profile", landed && !stray, json!({ "inProfile": landed, "inHomeDownloads": stray }));
    r.ok("bf-a", "navigate", json!({ "tab": tab, "url": r.url("/bf/a") })).await?;
    r.ok("bf-to-b", "click", json!({ "tab": tab, "selector": "text=To B" })).await?;
    r.ok("bf-back", "navigate", json!({ "tab": tab, "action": "back" })).await?;
    r.eval("bf-restored", tab, "document.getElementById('restored').textContent").await?;
    r.ok("gate-pending", "navigate", json!({ "tab": tab, "url": r.url("/gate/spa"), "timeout": 1000 })).await?;
    r.sites().open_gate("spa");
    r.ok("gate-opened", "wait_for", json!({ "tab": tab, "text": "Gate spa opened" })).await?;
    Ok(())
}

async fn frames(r: &mut Run<'_>) -> anyhow::Result<()> {
    let tab = r.open("/frames").await?;
    let snap = r.text("snapshot", "snapshot", json!({ "tab": tab })).await?;
    let same = ref_of(&snap, "button \"Same button\"")?;
    let cross = ref_of(&snap, "button \"Cross button\"")?;
    r.ok("click-same", "click", json!({ "tab": tab, "ref": same })).await?;
    r.ok("click-cross", "click", json!({ "tab": tab, "ref": cross })).await?;
    r.ok("fill-cross", "fill", json!({ "tab": tab, "selector": "iframe[title=\"Cross origin\"] >> frame >> #ci", "value": "über" })).await?;
    r.ok("eval-cross", "eval", json!({ "tab": tab, "frame": "#cross", "expression": "[document.getElementById('cb').textContent, document.getElementById('ci').value, location.origin]" })).await?;
    r.ok(
        "click-deep",
        "click",
        json!({ "tab": tab, "selector": "iframe[title=\"Nested\"] >> frame >> iframe[title=\"Level two\"] >> frame >> iframe[title=\"Level three\"] >> frame >> role=button[name=\"Deep button\"]" }),
    )
    .await?;
    r.text("snapshot-after", "snapshot", json!({ "tab": tab, "diff": true })).await?;
    r.call("click-sandboxed", "click", json!({ "tab": tab, "selector": "iframe[title=\"Sandboxed\"] >> frame >> role=button", "timeout": 2000 }), Expect::Ok, &[]).await?;
    r.ok("cross-alert", "click", json!({ "tab": tab, "selector": "iframe[title=\"Cross origin\"] >> frame >> #calert" })).await?;
    r.ok("answer-cross-alert", "dialog", json!({ "tab": tab, "action": "accept" })).await?;
    r.ok("remove-frame", "click", json!({ "tab": tab, "selector": "#remove" })).await?;
    r.err("stale-ref", "click", json!({ "tab": tab, "ref": same, "timeout": 1000 })).await?;
    r.text("snapshot-removed", "snapshot", json!({ "tab": tab })).await?;
    Ok(())
}

async fn dialogs(r: &mut Run<'_>) -> anyhow::Result<()> {
    let tab = r.open("/dialogs").await?;
    r.ok("alert", "click", json!({ "tab": tab, "selector": "#alert" })).await?;
    r.ok("status", "dialog", json!({ "tab": tab })).await?;
    r.err("blocked-while-open", "eval", json!({ "tab": tab, "expression": "1" })).await?;
    r.ok("accept-alert", "dialog", json!({ "tab": tab, "action": "accept" })).await?;
    r.eval("after-alert", tab, "document.getElementById('out').textContent").await?;
    r.ok("confirm", "click", json!({ "tab": tab, "selector": "#confirm" })).await?;
    r.ok("dismiss-confirm", "dialog", json!({ "tab": tab, "action": "dismiss" })).await?;
    r.eval("after-confirm", tab, "document.getElementById('out').textContent").await?;
    r.ok("prompt", "click", json!({ "tab": tab, "selector": "#prompt" })).await?;
    r.ok("answer-prompt", "dialog", json!({ "tab": tab, "action": "accept", "promptText": "Ada" })).await?;
    r.eval("after-prompt", tab, "document.getElementById('out').textContent").await?;
    r.ok("sequence", "click", json!({ "tab": tab, "selector": "#sequence" })).await?;
    r.ok("sequence-first", "dialog", json!({ "tab": tab, "action": "accept" })).await?;
    r.eventually("sequence-second-open", "dialog", json!({ "tab": tab }), Duration::from_secs(5), |v| !v["dialog"].is_null()).await?;
    r.ok("sequence-second", "dialog", json!({ "tab": tab, "action": "accept" })).await?;
    r.eval("after-sequence", tab, "document.getElementById('out').textContent").await?;
    r.ok("auto-accept", "dialog", json!({ "tab": tab, "auto": "accept" })).await?;
    r.ok("auto-confirm", "click", json!({ "tab": tab, "selector": "#confirm" })).await?;
    r.eventually("after-auto", "eval", json!({ "tab": tab, "expression": "document.getElementById('out').textContent" }), Duration::from_secs(5), |v| v == "confirm true").await?;
    r.ok("auto-off", "dialog", json!({ "tab": tab, "auto": "off" })).await?;
    r.ok("frame-confirm", "click", json!({ "tab": tab, "selector": "iframe[title=\"Dialog frame\"] >> frame >> #fa" })).await?;
    r.ok("accept-frame-confirm", "dialog", json!({ "tab": tab, "action": "accept" })).await?;
    r.ok("frame-result", "eval", json!({ "tab": tab, "frame": "iframe[title=\"Dialog frame\"]", "expression": "document.getElementById('fr').textContent" })).await?;
    r.ok("guard-unload", "click", json!({ "tab": tab, "selector": "#guard" })).await?;
    r.ok("leave-guarded", "navigate", json!({ "tab": tab, "url": r.url("/spa") })).await?;
    r.ok("alert-on-load", "navigate", json!({ "tab": tab, "url": r.url("/dialogs/onload") })).await?;
    r.ok("accept-load-alert", "dialog", json!({ "tab": tab, "action": "accept" })).await?;
    r.ok("loaded-after-alert", "wait_for", json!({ "tab": tab, "text": "Loaded with an alert" })).await?;
    Ok(())
}

async fn upload(r: &mut Run<'_>) -> anyhow::Result<()> {
    let a = r.write_file("alpha.txt", "alpha")?;
    let b = r.write_file("bravo.txt", "bravo")?;
    let c = r.write_file("charlie.txt", "charlie")?;
    let tab = r.open("/upload").await?;
    r.ok("single", "upload", json!({ "tab": tab, "selector": "#single", "files": [a] })).await?;
    r.eventually("single-shown", "eval", json!({ "tab": tab, "expression": "document.getElementById('out').textContent" }), Duration::from_secs(5), |v| v != "none").await?;
    r.ok("hidden-multiple", "upload", json!({ "tab": tab, "selector": "#picker", "files": [b, c] })).await?;
    r.eventually("multiple-shown", "eval", json!({ "tab": tab, "expression": "document.getElementById('out').textContent" }), Duration::from_secs(5), |v| v.as_str().is_some_and(|t| t.starts_with("hidden"))).await?;
    let data = base64::engine::general_purpose::STANDARD.encode("delta");
    r.ok("inline", "upload", json!({ "tab": tab, "selector": "#single", "files": { "name": "delta.txt", "data": data } })).await?;
    r.eventually("inline-shown", "eval", json!({ "tab": tab, "expression": "document.getElementById('out').textContent" }), Duration::from_secs(5), |v| v.as_str().is_some_and(|t| t.contains("delta"))).await?;
    r.err("not-multiple", "upload", json!({ "tab": tab, "selector": "#single", "files": [a.clone(), a] })).await?;
    r.err("outside-roots", "upload", json!({ "tab": tab, "selector": "#single", "files": ["/etc/hosts"] })).await?;
    Ok(())
}

async fn drag(r: &mut Run<'_>) -> anyhow::Result<()> {
    let tab = r.open("/drag").await?;
    let track = r.eval("track-rect", tab, "(() => { const b = document.getElementById('track').getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height } })()").await?;
    let x = track["x"].as_f64().unwrap_or(0.0);
    let y = track["y"].as_f64().unwrap_or(0.0) + 10.0;
    r.ok("slide", "drag", json!({ "tab": tab, "from": { "x": x + 10.0, "y": y }, "to": { "x": x + 300.0, "y": y } })).await?;
    r.eval("slider-value", tab, "document.getElementById('value').textContent").await?;
    r.ok("html5", "drag", json!({ "tab": tab, "from": "#src", "to": "#drop" })).await?;
    r.eventually("dropped", "eval", json!({ "tab": tab, "expression": "document.getElementById('dnd').textContent" }), Duration::from_secs(5), |v| v != "no drop").await?;
    r.ok("drag-events", "eval", json!({ "tab": tab, "world": "main", "expression": "window.__drag" })).await?;
    Ok(())
}

async fn csp(r: &mut Run<'_>) -> anyhow::Result<()> {
    let tab = r.open("/csp").await?;
    r.text("snapshot", "snapshot", json!({ "tab": tab })).await?;
    r.eval("styled", tab, "getComputedStyle(document.getElementById('styled')).color").await?;
    r.ok("main-world", "eval", json!({ "tab": tab, "world": "main", "expression": "document.title + ' / ' + typeof trustedTypes" })).await?;
    r.ok("inline-blocked", "click", json!({ "tab": tab, "selector": "#inert" })).await?;
    r.eval("inline-result", tab, "document.getElementById('inert').textContent").await?;
    r.image("screenshot", "screenshot", json!({ "tab": tab }), &[]).await?;
    r.ok("link", "click", json!({ "tab": tab, "selector": "text=To app" })).await?;
    Ok(())
}

async fn network(r: &mut Run<'_>) -> anyhow::Result<()> {
    let tab = r.open("/network").await?;
    r.ok("start", "network", json!({ "tab": tab, "action": "start", "urlFilter": "/api/" })).await?;
    r.sites().clear_log();
    r.ok("run", "click", json!({ "tab": tab, "selector": "#run" })).await?;
    r.ok("done", "wait_for", json!({ "tab": tab, "text": "done aborted", "timeout": 10000 })).await?;
    // A finished request is only counted once its finalizer builds the entry (it may fetch the response body, and
    // Chromium can hold a finished request briefly for extra header info), so status can be short by one or more
    // exchanges. Wait for every request the fixture served before recording the counters.
    let expected = r.sites().requests("/api/").len() as u64;
    let (settled, status) =
        r.eventually("status", "network", json!({ "tab": tab, "action": "status" }), Duration::from_secs(5), |status| {
            status["entryCount"].as_u64() == Some(expected)
        })
        .await?;
    r.check("status-settled", settled, json!({ "expected": expected, "entryCount": status["entryCount"] }));
    let stopped = r.ok("stop", "network", json!({ "tab": tab, "action": "stop" })).await?;
    r.sites().open_gate("abort");
    let served: Vec<String> = r.sites().requests("/api/").iter().map(|q| format!("{} {}", q.method, q.path())).collect();
    let captured: Vec<String> = stopped["exchanges"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .map(|e| {
                    let url = e["request"]["url"].as_str().unwrap_or("");
                    let path = url.split_once("://").and_then(|(_, rest)| rest.find('/').map(|i| &rest[i..])).unwrap_or(url);
                    format!("{} {}", e["request"]["method"].as_str().unwrap_or(""), path.split('?').next().unwrap_or(""))
                })
                .collect()
        })
        .unwrap_or_default();
    r.check("matches-server", served == captured, json!({ "served": served, "captured": captured }));
    Ok(())
}

async fn console(r: &mut Run<'_>) -> anyhow::Result<()> {
    let tab = r.open("/console").await?;
    r.ok("start", "console", json!({ "tab": tab, "action": "start" })).await?;
    r.ok("run", "click", json!({ "tab": tab, "selector": "#run" })).await?;
    r.ok("done", "wait_for", json!({ "tab": tab, "text": "done", "exact": true, "selector": "#status" })).await?;
    r.eventually("entries", "console", json!({ "tab": tab, "action": "read", "clear": false }), Duration::from_secs(5), |v| {
        v["entries"].as_array().is_some_and(|e| e.len() >= 9)
    })
    .await?;
    r.ok("read", "console", json!({ "tab": tab, "action": "read", "errorsOnly": true })).await?;
    r.ok("read-rest", "console", json!({ "tab": tab, "action": "read" })).await?;
    r.ok("broken", "navigate", json!({ "tab": tab, "url": r.url("/console/broken") })).await?;
    r.eventually("browser-entries", "console", json!({ "tab": tab, "action": "read", "clear": false }), Duration::from_secs(3), |v| {
        v["entries"].as_array().is_some_and(|e| !e.is_empty())
    })
    .await?;
    r.ok("stop", "console", json!({ "tab": tab, "action": "stop" })).await?;
    Ok(())
}

async fn visual(r: &mut Run<'_>) -> anyhow::Result<()> {
    let tab = r.open("/visual").await?;
    let probes = [(100, 50), (300, 50), (500, 50), (100, 225), (650, 225), (900, 700)];
    r.image("viewport-shot", "screenshot", json!({ "tab": tab }), &probes).await?;
    r.ok("baseline", "screenshot", json!({ "tab": tab, "path": "baseline.png" })).await?;
    r.ok("recolor", "click", json!({ "tab": tab, "selector": "#recolor" })).await?;
    r.ok("diff", "screenshot_diff", json!({ "tab": tab, "baseline": "baseline.png", "diffPath": "diff.png" })).await?;
    r.image("full-page", "screenshot", json!({ "tab": tab, "fullPage": true }), &[(100, 50), (500, 1550), (900, 1300)]).await?;
    r.image("clip", "screenshot", json!({ "tab": tab, "clip": { "x": 100, "y": 0, "width": 200, "height": 100 } }), &[(50, 50), (150, 50)]).await?;
    r.image("element", "screenshot", json!({ "tab": tab, "selector": "#blue" }), &[(0, 0), (199, 99)]).await?;
    r.image("jpeg", "screenshot", json!({ "tab": tab, "format": "jpeg", "quality": 90 }), &[]).await?;
    r.ok("record-start", "recording", json!({ "tab": tab, "action": "start", "path": "clip.mkv", "frameRate": 10 })).await?;
    r.ok("record-flip", "click", json!({ "tab": tab, "selector": "#recolor" })).await?;
    r.eventually("record-frames", "recording", json!({ "tab": tab, "action": "status" }), Duration::from_secs(5), |v| v["frameCount"].as_u64().is_some_and(|n| n >= 2)).await?;
    r.ok("record-stop", "recording", json!({ "tab": tab, "action": "stop" })).await?;
    Ok(())
}

async fn non_html(r: &mut Run<'_>) -> anyhow::Result<()> {
    let tab = r.open("/data.json").await?;
    r.eval("json-type", tab, "document.contentType").await?;
    r.text("json-snapshot", "snapshot", json!({ "tab": tab })).await?;
    r.ok("text", "navigate", json!({ "tab": tab, "url": r.url("/plain.txt") })).await?;
    r.eval("text-type", tab, "[document.contentType, document.body.innerText.trim()]").await?;
    r.text("text-snapshot", "snapshot", json!({ "tab": tab })).await?;
    r.ok("image", "navigate", json!({ "tab": tab, "url": r.url("/image.png") })).await?;
    r.eval("image-type", tab, "[document.contentType, document.images.length, document.images[0] && document.images[0].naturalWidth]").await?;
    Ok(())
}

async fn hangs(r: &mut Run<'_>) -> anyhow::Result<()> {
    let tab = r.open("/hangs").await?;
    r.err("busy-loop", "eval", json!({ "tab": tab, "world": "main", "expression": "while (true) {}", "timeout": 2000 })).await?;
    // A script nobody could stop leaves its tab useless: close it and carry on in a new one.
    let closed = r.browser().close_tab(tab).await;
    r.check("close-stuck-tab", closed.is_ok(), json!({ "error": closed.err().map(|e| e.to_string()) }));
    let opened = r.ok("open-again", "navigate", json!({ "url": r.url("/hangs"), "keepVisible": true })).await?;
    let tab = opened["tab"].as_i64().unwrap_or(2);
    r.viewport("viewport-again", tab).await?;
    r.eval("alive-after-loop", tab, "document.getElementById('alive').textContent").await?;
    r.call("basic-auth", "navigate", json!({ "tab": tab, "url": r.url("/auth"), "timeout": 5000 }), Expect::Error, &[]).await?;
    r.ok("after-auth", "navigate", json!({ "tab": tab, "url": r.url("/hangs") })).await?;
    r.eval("alive-at-end", tab, "document.getElementById('alive').textContent").await?;
    // Last: a print dialog may hold the page until the tab closes.
    r.ok("print", "click", json!({ "tab": tab, "selector": "#print", "timeout": 2000 })).await?;
    Ok(())
}

async fn popups(r: &mut Run<'_>) -> anyhow::Result<()> {
    let tab = r.open("/popups").await?;
    r.ok("window-open", "click", json!({ "tab": tab, "selector": "#open" })).await?;
    r.ok("popup-loaded", "wait_for", json!({ "tab": 2, "text": "Popup child" })).await?;
    r.text("popup-snapshot", "snapshot", json!({ "tab": 2 })).await?;
    r.ok("popup-opener", "eval", json!({ "tab": 2, "world": "main", "expression": "window.opener !== null" })).await?;
    r.ok("blank-link", "click", json!({ "tab": tab, "selector": "text=Blank target link" })).await?;
    r.ok("blank-loaded", "wait_for", json!({ "tab": 3, "text": "Popup child" })).await?;
    r.ok("noopener", "click", json!({ "tab": tab, "selector": "#noopener" })).await?;
    r.ok("noopener-loaded", "wait_for", json!({ "tab": 4, "text": "Popup child" })).await?;
    r.ok("noopener-opener", "eval", json!({ "tab": 4, "world": "main", "expression": "window.opener === null" })).await?;
    r.ok("self-close", "click", json!({ "tab": 2, "selector": "text=Close me" })).await?;
    let ids = r.browser().tab_ids();
    let started = Instant::now();
    let mut closed = !ids.contains(&2);
    while !closed && started.elapsed() < Duration::from_secs(5) {
        tokio::time::sleep(Duration::from_millis(100)).await;
        closed = !r.browser().tab_ids().contains(&2);
    }
    r.check("popup-closed", closed, json!({ "tabs": r.browser().tab_ids() }));
    Ok(())
}

async fn emulation(r: &mut Run<'_>) -> anyhow::Result<()> {
    let tab = r.open("/app").await?;
    r.ok("user-agent", "emulate", json!({ "tab": tab, "userAgent": "ConformanceAgent/1.0" })).await?;
    r.eval("agent", tab, "navigator.userAgent").await?;
    r.ok("dark", "emulate", json!({ "tab": tab, "colorScheme": "dark", "reducedMotion": "reduce" })).await?;
    r.eval("media", tab, "[matchMedia('(prefers-color-scheme: dark)').matches, matchMedia('(prefers-reduced-motion: reduce)').matches]").await?;
    r.ok("small", "emulate", json!({ "tab": tab, "viewport": { "width": 500, "height": 400, "deviceScaleFactor": 2 } })).await?;
    r.eval("size", tab, "[innerWidth, innerHeight, devicePixelRatio]").await?;
    r.ok("offline", "emulate", json!({ "tab": tab, "offline": true })).await?;
    r.eval("online", tab, "navigator.onLine").await?;
    r.call("touch", "emulate", json!({ "tab": tab, "touch": true }), Expect::Ok, &[]).await?;
    r.call("print", "emulate", json!({ "tab": tab, "media": "print" }), Expect::Ok, &[]).await?;
    r.ok("geolocation", "emulate", json!({ "tab": tab, "geolocation": { "latitude": 51.5, "longitude": -0.12 } })).await?;
    r.err("permissions", "emulate", json!({ "tab": tab, "permissions": ["geolocation"] })).await?;
    r.ok("reset", "emulate", json!({ "tab": tab, "userAgent": "reset", "colorScheme": "reset", "reducedMotion": "reset", "viewport": "reset", "offline": false, "geolocation": "reset" })).await?;
    r.ok("online-again", "eval", json!({ "tab": tab, "expression": "navigator.onLine" })).await?;
    Ok(())
}

async fn policy(r: &mut Run<'_>) -> anyhow::Result<()> {
    let opened = r.ok("open-read-only", "navigate", json!({ "url": r.url("/policy"), "readOnly": true })).await?;
    let tab = opened["tab"].as_i64().unwrap_or(1);
    r.viewport("viewport", tab).await?;
    r.err("click-refused", "click", json!({ "tab": tab, "selector": "#b" })).await?;
    r.err("navigate-refused", "navigate", json!({ "tab": tab, "url": r.url("/app") })).await?;
    r.text("snapshot-allowed", "snapshot", json!({ "tab": tab })).await?;
    r.eval("eval-allowed", tab, "document.getElementById('b').textContent").await?;
    let opened = r.ok("open-allowlisted", "navigate", json!({ "url": r.url("/policy"), "allowedOrigins": ["127.0.0.1"] })).await?;
    let second = opened["tab"].as_i64().unwrap_or(2);
    r.err("cross-refused", "navigate", json!({ "tab": second, "url": r.cross("/") })).await?;
    r.ok("same-allowed", "navigate", json!({ "tab": second, "url": r.url("/app") })).await?;
    r.err("open-refused", "navigate", json!({ "url": r.cross("/"), "allowedOrigins": ["127.0.0.1"] })).await?;
    r.ok("press-allowed", "click", json!({ "tab": second, "selector": "#counter" })).await?;
    Ok(())
}

async fn script(r: &mut Run<'_>) -> anyhow::Result<()> {
    let tab = r.open("/script").await?;
    r.text(
        "execute",
        "execute",
        json!({ "tab": tab, "timeoutMs": 10000, "code": "await page.getByLabel(\"Query\").fill(\"conformance\");\nawait page.getByRole(\"button\", { name: \"Search\" }).click();\nreturn await page.locator(\"#result\").textContent();" }),
    )
    .await?;
    r.err(
        "execute-error",
        "execute",
        json!({ "tab": tab, "timeoutMs": 10000, "code": "await page.locator(\"#nope\").click({ timeout: 500 });" }),
    )
    .await?;
    r.eval("result", tab, "document.getElementById('result').textContent").await?;
    Ok(())
}

async fn background(r: &mut Run<'_>) -> anyhow::Result<()> {
    let tab = r.open("/background").await?;
    let opened = r.ok("open-second", "navigate", json!({ "url": r.url("/background") })).await?;
    let second = opened["tab"].as_i64().unwrap_or(2);
    r.viewport("viewport-second", second).await?;
    r.ok("click-first", "click", json!({ "tab": tab, "selector": "#b" })).await?;
    r.eval("first-pressed", tab, "document.getElementById('b').textContent.startsWith('pressed')").await?;
    r.image("first-screenshot", "screenshot", json!({ "tab": tab, "clip": { "x": 0, "y": 0, "width": 100, "height": 50 } }), &[]).await?;
    r.ok("click-second", "click", json!({ "tab": second, "selector": "#b" })).await?;
    r.eval("second-pressed", second, "document.getElementById('b').textContent.startsWith('pressed')").await?;
    Ok(())
}

/// Nothing a scenario did may leak into a fresh tab.
async fn leak_canary(r: &mut Run<'_>) -> anyhow::Result<()> {
    let opened = r.ok("open", "navigate", json!({ "url": r.url("/") })).await?;
    let tab = opened["tab"].as_i64().unwrap_or(1);
    let fingerprint = parse(&text_of(&r.quiet("eval", json!({ "tab": tab, "expression": FINGERPRINT })).await?));
    let baseline = r.env.baseline.lock().unwrap().clone().unwrap_or(Value::Null);
    let changed: Vec<String> = baseline
        .as_object()
        .map(|b| b.iter().filter(|(k, v)| fingerprint.get(k.as_str()) != Some(v)).map(|(k, _)| k.clone()).collect())
        .unwrap_or_else(|| vec!["<no baseline>".into()]);
    r.check("fresh-tab-defaults", changed.is_empty(), json!({ "changed": changed }));
    r.ok("no-dialog", "dialog", json!({ "tab": tab })).await?;
    let tabs = r.browser().top_level_tabs().await.unwrap_or(0);
    r.check("tab-count", tabs == 2, json!({ "topLevelTabs": tabs }));
    Ok(())
}
