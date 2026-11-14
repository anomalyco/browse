//! `download`: send a tab's downloads into a folder inside the file roots and report them. Uses the tab-scoped
//! Page.setDownloadBehavior, never the browser-wide Browser one, so the user's own downloads are untouched.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as SyncMutex};
use std::time::Duration;

use async_trait::async_trait;
use browse_core::{Cdp, TabId, Tool, ToolContext, ToolOutput, ToolSpec};
use serde::Serialize;
use serde_json::{Value, json};
use tokio::sync::{Notify, broadcast};

use crate::redaction::SecretRedactor;
use crate::state::TaskGuard;
use crate::{arg_action, arg_int, arg_str, bail_user, files, json_output, respond, state, tab_schema, target_tab};

#[derive(Default)]
pub(crate) struct DownloadState {
    active: Option<Downloads>,
}

struct Downloads {
    tab: TabId,
    dir: PathBuf,
    cdp: Arc<dyn Cdp>,
    list: Arc<SyncMutex<Vec<Download>>>,
    changed: Arc<Notify>,
    _task: TaskGuard,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Download {
    id: usize,
    #[serde(skip)]
    guid: String,
    /// With credential-looking query values redacted.
    url: String,
    suggested_filename: String,
    /// inProgress, completed or canceled.
    state: String,
    received_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    total_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<PathBuf>,
    started_at: String,
    #[serde(skip)]
    reported: bool,
}

/// Where Chrome put a finished download: its suggested name in `dir`, else the newest file nobody has claimed.
fn locate(dir: &Path, suggested: &str, claimed: &[PathBuf]) -> Option<PathBuf> {
    let name = Path::new(suggested).file_name()?;
    let direct = dir.join(name);
    if direct.is_file() && !claimed.contains(&direct) {
        return Some(direct);
    }
    std::fs::read_dir(dir)
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_file() && !claimed.contains(path))
        .filter(|path| !path.extension().is_some_and(|ext| ext == "crdownload"))
        .max_by_key(|path| std::fs::metadata(path).and_then(|meta| meta.modified()).ok())
}

fn handle(event: &browse_core::CdpEvent, dir: &Path, list: &SyncMutex<Vec<Download>>) -> bool {
    let params = &event.params;
    let guid = params.get("guid").and_then(Value::as_str).unwrap_or("").to_string();
    match event.method.as_str() {
        "Page.downloadWillBegin" | "Browser.downloadWillBegin" => {
            let mut list = list.lock().unwrap();
            if list.iter().any(|download| download.guid == guid) {
                return false;
            }
            let url = params.get("url").and_then(Value::as_str).unwrap_or("");
            let id = list.len() + 1;
            list.push(Download {
                id,
                guid,
                url: SecretRedactor::new().protect_url(url),
                suggested_filename: params.get("suggestedFilename").and_then(Value::as_str).unwrap_or("download").to_string(),
                state: "inProgress".into(),
                received_bytes: 0,
                total_bytes: None,
                path: None,
                started_at: crate::now_iso(),
                reported: false,
            });
            true
        }
        "Page.downloadProgress" | "Browser.downloadProgress" => {
            let mut list = list.lock().unwrap();
            let claimed: Vec<PathBuf> = list.iter().filter_map(|download| download.path.clone()).collect();
            let Some(download) = list.iter_mut().find(|download| download.guid == guid) else { return false };
            let state = params.get("state").and_then(Value::as_str).unwrap_or("inProgress").to_string();
            download.received_bytes = params.get("receivedBytes").and_then(Value::as_f64).unwrap_or(0.0) as u64;
            download.total_bytes =
                params.get("totalBytes").and_then(Value::as_f64).filter(|total| *total > 0.0).map(|total| total as u64);
            if state == "completed" && download.path.is_none() {
                download.path = params
                    .get("filePath")
                    .and_then(Value::as_str)
                    .map(PathBuf::from)
                    .or_else(|| locate(dir, &download.suggested_filename, &claimed));
            }
            let changed = download.state != state || state == "completed";
            download.state = state;
            changed
        }
        _ => false,
    }
}

async fn start(ctx: &ToolContext, args: &Value) -> anyhow::Result<ToolOutput> {
    let tab = target_tab(ctx, args).await?;
    let dir = files::directory_path(&ctx.file_roots, arg_str(args, "dir")?.unwrap_or("downloads"))?;
    let capture = state::get(ctx).await;
    let mut downloads = capture.downloads.lock().await;
    if let Some(active) = downloads.active.take() {
        let _ = active.cdp.send("Page.setDownloadBehavior", json!({ "behavior": "default" }), None).await;
    }
    let cdp = ctx.browser.cdp(&ctx.session, tab).await?;
    let mut events = cdp.events();
    cdp.send("Page.enable", json!({}), None).await?;
    cdp.send("Page.setDownloadBehavior", json!({ "behavior": "allow", "downloadPath": dir }), None).await?;
    let list = Arc::new(SyncMutex::new(Vec::new()));
    let changed = Arc::new(Notify::new());
    let (task_list, task_changed, task_dir) = (list.clone(), changed.clone(), dir.clone());
    let task = tokio::spawn(async move {
        loop {
            match events.recv().await {
                Ok(event) => {
                    if handle(&event, &task_dir, &task_list) {
                        task_changed.notify_waiters();
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => {}
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    });
    downloads.active = Some(Downloads { tab, dir: dir.clone(), cdp, list, changed, _task: TaskGuard::new(task.abort_handle()) });
    json_output(&json!({ "active": true, "tab": tab, "dir": dir }))
}

async fn wait(ctx: &ToolContext, args: &Value) -> anyhow::Result<ToolOutput> {
    let timeout = arg_int(args, "timeoutMs", 0, 10 * 60_000)?.unwrap_or(30_000) as u64;
    let capture = state::get(ctx).await;
    let (list, changed) = {
        let downloads = capture.downloads.lock().await;
        let Some(active) = &downloads.active else { bail_user!("downloads aren't being captured; call download start first") };
        (active.list.clone(), active.changed.clone())
    };
    let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout);
    loop {
        let notified = changed.notified();
        {
            let mut list = list.lock().unwrap();
            if let Some(download) = list.iter_mut().find(|download| !download.reported && download.state != "inProgress") {
                download.reported = true;
                return json_output(&download.clone());
            }
        }
        if tokio::time::timeout_at(deadline, notified).await.is_err() {
            let list = list.lock().unwrap();
            let pending: Vec<&Download> = list.iter().filter(|download| download.state == "inProgress").collect();
            bail_user!(
                "no download finished within {timeout} ms{}",
                if pending.is_empty() { String::new() } else { format!("; still in progress: {}", serde_json::to_string(&pending)?) }
            );
        }
    }
}

pub(crate) struct DownloadTool;

#[async_trait]
impl Tool for DownloadTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "download".into(),
            description: "Capture a tab's downloads into a folder inside the file roots. start sends the tab's \
                downloads to dir (default \"downloads\" in the first root) and tracks them; trigger the download after \
                start (e.g. click a link), then wait returns the next finished download {id, url, suggestedFilename, \
                state: completed|canceled, receivedBytes, path}; list returns all of them; stop restores the browser's \
                normal download handling for the tab."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "action": { "type": "string", "enum": ["start", "wait", "list", "stop"] },
                    "tab": tab_schema(),
                    "dir": { "type": "string", "description": "start: folder for downloads; absolute inside the file roots, or relative to the first root." },
                    "timeoutMs": { "type": "integer", "minimum": 0, "maximum": 600_000, "description": "wait: how long to wait for a download to finish (default 30000)." }
                },
                "required": ["action"],
                "additionalProperties": false
            }),
        }
    }

    async fn call(&self, ctx: ToolContext, args: Value) -> anyhow::Result<ToolOutput> {
        respond(
            async {
                match arg_action(&args, &["start", "wait", "list", "stop"])? {
                    "start" => start(&ctx, &args).await,
                    "wait" => wait(&ctx, &args).await,
                    "list" => {
                        let capture = state::get(&ctx).await;
                        let downloads = capture.downloads.lock().await;
                        let Some(active) = &downloads.active else { return json_output(&json!({ "active": false })) };
                        let list = active.list.lock().unwrap().clone();
                        json_output(&json!({ "active": true, "tab": active.tab, "dir": active.dir, "downloads": list }))
                    }
                    _ => {
                        let capture = state::get(&ctx).await;
                        let active = capture.downloads.lock().await.active.take();
                        let Some(active) = active else { return json_output(&json!({ "active": false })) };
                        let _ = active.cdp.send("Page.setDownloadBehavior", json!({ "behavior": "default" }), None).await;
                        json_output(&json!({ "active": false, "tab": active.tab }))
                    }
                }
            }
            .await,
        )
        .await
    }
}
