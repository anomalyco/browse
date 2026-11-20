//! The async side of an execute: runs the engine's browse calls with the execute's own `ToolContext` (same browser,
//! file roots and checks as a direct call, inside the same task so the relay's per-call context carries over),
//! keeps the overall timeout (paused while a handoff waits on the user), and collects logs, images and what happened
//! to the page.

use std::collections::HashMap;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use browse_core::{Content, TabId, Tool, ToolContext};
use futures_util::stream::{FuturesUnordered, StreamExt};
use serde_json::{Value, json};

use crate::engine::{self, Finished, Job, Settle, ToHost};
use crate::files;

const MAX_LOGS: usize = 200;
const MAX_LOG_CHARS: usize = 2_000;

pub struct Image {
    pub mime_type: String,
    pub data: String,
}

#[derive(Default)]
pub struct Aftermath {
    pub start_url: Option<String>,
    pub end_url: Option<String>,
    pub navigations: Vec<String>,
    pub handoffs: u32,
    pub new_tabs: u32,
    pub dialogs: Vec<String>,
    pub challenge: Option<Value>,
}

pub struct Outcome {
    pub finished: Option<Finished>,
    /// Why the host ended the run (overall timeout), when it did.
    pub timed_out: Option<u64>,
    pub logs: Vec<(String, String)>,
    pub dropped_logs: usize,
    pub warnings: Vec<String>,
    pub images: Vec<Image>,
    pub aftermath: Aftermath,
}

type Pending = Pin<Box<dyn Future<Output = (u64, Result<Value, String>, bool)> + Send>>;

/// Sets the engine's cancel flag when the execute ends any way, including the relay aborting its task.
struct CancelOnDrop(Arc<AtomicBool>);

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Relaxed);
    }
}

pub struct Host {
    pub ctx: ToolContext,
    pub tools: Arc<HashMap<String, Arc<dyn Tool>>>,
}

impl Host {
    pub async fn run(&self, job: Job) -> Outcome {
        let timeout_ms = job.timeout_ms;
        let job_tab = job.tab;
        let mut outcome = Outcome { finished: None, timed_out: None, logs: Vec::new(), dropped_logs: 0, warnings: Vec::new(), images: Vec::new(), aftermath: Aftermath::default() };
        outcome.aftermath.start_url = self.current_url(job.tab).await;
        let (to_host, mut from_engine) = tokio::sync::mpsc::unbounded_channel::<ToHost>();
        let (to_engine, settles) = std::sync::mpsc::channel::<Settle>();
        let cancel = Arc::new(AtomicBool::new(false));
        let _guard = CancelOnDrop(cancel.clone());
        if let Err(error) = engine::spawn(job, to_host, settles, cancel.clone()) {
            outcome.finished = Some(Finished { report: None, stopped: Some(format!("could not start the JavaScript engine: {error}")), state: None });
            return outcome;
        }
        let mut inflight: FuturesUnordered<Pending> = FuturesUnordered::new();
        let mut deadline = (timeout_ms > 0).then(|| tokio::time::Instant::now() + Duration::from_millis(timeout_ms));
        let mut waiting_on_user = 0usize;
        let mut paused_at: Option<Instant> = None;
        loop {
            let sleep_until = match (deadline, waiting_on_user) {
                (Some(deadline), 0) => deadline,
                _ => tokio::time::Instant::now() + Duration::from_secs(24 * 3600),
            };
            tokio::select! {
                message = from_engine.recv() => match message {
                    Some(ToHost::Async { id, op, payload }) => {
                        if is_handoff(&op, &payload) {
                            waiting_on_user += 1;
                            paused_at.get_or_insert_with(Instant::now);
                        }
                        let ctx = self.ctx.clone();
                        let tools = self.tools.clone();
                        let user = is_handoff(&op, &payload);
                        inflight.push(Box::pin(async move { (id, run_async(ctx, tools, &op, payload).await, user) }));
                    }
                    Some(ToHost::Sync { op, payload, reply }) => {
                        let result = self.run_sync(&op, payload, &mut outcome).await;
                        let _ = reply.send(result);
                    }
                    Some(ToHost::Log { level, text }) => self.log(&mut outcome, level, text),
                    Some(ToHost::Done(finished)) => {
                        outcome.finished = Some(finished);
                        break;
                    }
                    None => break,
                },
                Some((id, result, user)) = inflight.next(), if !inflight.is_empty() => {
                    if user {
                        waiting_on_user -= 1;
                        if waiting_on_user == 0
                            && let (Some(started), Some(deadline)) = (paused_at.take(), deadline.as_mut())
                        {
                            *deadline += started.elapsed();
                        }
                    }
                    let result = result.map(|value| self.absorb(value, &mut outcome));
                    let _ = to_engine.send(Settle { id, result });
                }
                _ = tokio::time::sleep_until(sleep_until), if deadline.is_some() && waiting_on_user == 0 => {
                    cancel.store(true, Ordering::Relaxed);
                    outcome.timed_out = Some(timeout_ms);
                    break;
                }
            }
        }
        if outcome.timed_out.is_some() {
            // The engine notices the cancel within a moment; keep its state when it hands it back quickly.
            drop(inflight);
            drop(to_engine);
            let drained = tokio::time::timeout(Duration::from_millis(500), async {
                loop {
                    match from_engine.recv().await {
                        Some(ToHost::Done(finished)) => return Some(finished),
                        Some(ToHost::Log { level, text }) => self.log(&mut outcome, level, text),
                        Some(ToHost::Sync { reply, .. }) => {
                            let _ = reply.send(Err("execute timed out".into()));
                        }
                        Some(_) => {}
                        None => return None,
                    }
                }
            })
            .await;
            if let Ok(Some(finished)) = drained {
                outcome.finished = Some(Finished { report: None, stopped: None, state: finished.state });
            }
        }
        let ended_on = match outcome.finished.as_ref().and_then(|f| f.report.as_ref()) {
            Some(report) => report["tab"].as_i64(),
            None => job_tab,
        };
        outcome.aftermath.end_url = self.current_url(ended_on).await;
        // A page that opened its tab during the run started on nothing.
        if job_tab.is_none() {
            outcome.aftermath.start_url = None;
        }
        outcome
    }

    fn log(&self, outcome: &mut Outcome, level: String, text: String) {
        if level == "unhandled" {
            let first = text.lines().next().unwrap_or_default().to_string();
            let warning = format!("Unhandled promise rejection: {first} (await or catch every promise)");
            if !outcome.warnings.contains(&warning) {
                outcome.warnings.push(warning);
            }
            return;
        }
        if outcome.logs.len() >= MAX_LOGS {
            outcome.dropped_logs += 1;
            return;
        }
        let text = if text.chars().count() > MAX_LOG_CHARS { format!("{}… [cut]", text.chars().take(MAX_LOG_CHARS).collect::<String>()) } else { text };
        outcome.logs.push((level, text));
    }

    /// Keeps a tool result's images (handing the engine their ids) and notes navigations, handoffs, challenges and
    /// warnings for the aftermath.
    fn absorb(&self, value: Value, outcome: &mut Outcome) -> Value {
        let Value::Object(mut map) = value else { return value };
        if let Some(Value::Array(images)) = map.remove("images") {
            let mut ids = Vec::new();
            for image in images {
                let mime_type = image["mimeType"].as_str().unwrap_or("image/png").to_string();
                let data = image["data"].as_str().unwrap_or_default().to_string();
                let size = data.len() * 3 / 4;
                ids.push(json!({ "id": outcome.images.len(), "mimeType": mime_type, "size": size }));
                outcome.images.push(Image { mime_type, data });
            }
            map.insert("images".into(), Value::Array(ids));
        }
        let tool = map.get("tool").and_then(Value::as_str).unwrap_or_default().to_string();
        if let Some(text) = map.get("text").and_then(Value::as_str)
            && let Ok(Value::Object(result)) = serde_json::from_str::<Value>(text)
        {
            let after = &mut outcome.aftermath;
            let url = result.get("url").and_then(Value::as_str).unwrap_or_default().to_string();
            let navigated = result.get("navigated").and_then(Value::as_bool).unwrap_or(false) || (tool == "navigate" && !url.is_empty());
            if navigated && after.navigations.len() < 25 {
                after.navigations.push(url);
            }
            if matches!(tool.as_str(), "handoff" | "demonstrate") {
                after.handoffs += 1;
            }
            if let Some(tabs) = result.get("newTabs").and_then(Value::as_array) {
                after.new_tabs += tabs.len() as u32;
            }
            if let Some(dialog) = result.get("dialog")
                && !dialog.is_null()
            {
                after.dialogs.push(dialog.get("message").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| dialog.to_string()));
            }
            if let Some(challenge) = result.get("challenge").filter(|c| !c.is_null()) {
                after.challenge = Some(challenge.clone());
            }
            if let Some(warning) = result.get("warning").and_then(Value::as_str) {
                let warning = format!("{tool}: {warning}");
                if !outcome.warnings.contains(&warning) && outcome.warnings.len() < 20 {
                    outcome.warnings.push(warning);
                }
            }
        }
        Value::Object(map)
    }

    async fn run_sync(&self, op: &str, payload: Value, outcome: &mut Outcome) -> Result<Value, String> {
        match op {
            "tool" => run_async(self.ctx.clone(), self.tools.clone(), op, payload).await.map(|value| self.absorb(value, outcome)),
            "url" => {
                let tab = tab_argument(&self.ctx, &payload).map_err(|e| format!("{e:#}"))?;
                let page = async { browse_page::state::tab(&self.ctx, tab).await?.page(&self.ctx).await }.await.map_err(|e| format!("{e:#}"))?;
                Ok(Value::String(page.main_url()))
            }
            "image" => {
                let id = payload["id"].as_u64().unwrap_or(u64::MAX) as usize;
                outcome.images.get(id).map(|image| Value::String(image.data.clone())).ok_or_else(|| "no such image".into())
            }
            "files" => files::run(&self.ctx.file_roots, &payload).map_err(|e| format!("{e:#}")),
            other => Err(format!("unknown operation {other}")),
        }
    }

    /// The URL of the tab `page` stands for, without attaching anything.
    async fn current_url(&self, tab: Option<TabId>) -> Option<String> {
        let tab = tab?;
        Some(self.ctx.browser.tabs().await.ok()?.into_iter().find(|t| t.tab == tab)?.url)
    }
}

fn is_handoff(op: &str, payload: &Value) -> bool {
    op == "tool" && matches!(payload["name"].as_str(), Some("handoff" | "demonstrate"))
}

/// The tab a tool payload names, a chosen id like `work-mail` included.
pub(crate) fn tab_argument(ctx: &ToolContext, payload: &Value) -> anyhow::Result<TabId> {
    match payload.get("tab") {
        None | Some(Value::Null) => anyhow::bail!(browse_core::MISSING_TAB),
        Some(value) => ctx.browser.resolve_tab(value),
    }
}

async fn run_async(ctx: ToolContext, tools: Arc<HashMap<String, Arc<dyn Tool>>>, op: &str, payload: Value) -> Result<Value, String> {
    match op {
        "tool" => {
            let name = payload["name"].as_str().unwrap_or_default();
            let Some(tool) = tools.get(name).cloned() else { return Err(format!("browse has no tool named {name}")) };
            let mut args = payload.get("args").cloned().filter(Value::is_object).unwrap_or_else(|| json!({}));
            if let Some(map) = args.as_object_mut() {
                map.retain(|_, v| !v.is_null());
                if let Some(value) = map.get_mut("tab").filter(|v| v.is_string()) {
                    let tab = ctx.browser.resolve_tab(value).map_err(|e| format!("{e:#}"))?;
                    *value = json!(tab);
                }
                if let Some(Value::Array(list)) = map.get_mut("tabs") {
                    for value in list.iter_mut().filter(|v| v.is_string()) {
                        let tab = ctx.browser.resolve_tab(value).map_err(|e| format!("{e:#}"))?;
                        *value = json!(tab);
                    }
                }
            }
            let output = tool.call(ctx, args).await.map_err(|e| format!("{e:#}"))?;
            let text = output.content.iter().filter_map(|c| if let Content::Text { text } = c { Some(text.as_str()) } else { None }).collect::<Vec<_>>().join("\n");
            if output.is_error {
                return Err(if text.is_empty() { format!("{name} failed") } else { text });
            }
            let images: Vec<Value> = output
                .content
                .iter()
                .filter_map(|c| if let Content::Image { data, mime_type } = c { Some(json!({ "mimeType": mime_type, "data": data })) } else { None })
                .collect();
            Ok(json!({ "tool": name, "text": text, "images": images }))
        }
        // `page.bringToFront()`: through the tab's Cdp, so TabCdp::send applies the relay's guardrails (the
        // foreground switch and the tab's read-only option) before anything reaches Chrome.
        "foreground" => {
            let tab = tab_argument(&ctx, &payload).map_err(|e| format!("{e:#}"))?;
            let cdp = ctx.browser.cdp(tab).await.map_err(|e| format!("{e:#}"))?;
            cdp.send("Page.bringToFront", json!({}), None)
                .await
                .map(|_| Value::Null)
                .map_err(|e| e.to_string())
        }
        "sleep" => {
            let ms = payload["ms"].as_f64().unwrap_or(0.0).clamp(0.0, 24.0 * 3600.0 * 1000.0);
            tokio::time::sleep(Duration::from_millis(ms as u64)).await;
            Ok(Value::Null)
        }
        "query" => crate::query::run(&ctx, &payload).await.map_err(|e| format!("{e:#}")),
        other => Err(format!("unknown operation {other}")),
    }
}
