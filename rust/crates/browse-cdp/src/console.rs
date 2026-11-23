//! CDP console capture (`Runtime.enable` + `Log.enable` + child target tracking + isolated world filter).

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use browse_core::{CloseReason, ConsoleEntry, ConsoleEvent, DriverResult, Subscription};
use serde_json::{Value, json};
use tokio::sync::{broadcast, mpsc};

use crate::wire::{Cdp, CdpEvent, map_cdp_error};

#[derive(Default)]
struct Tracker {
    isolated: HashSet<(Option<String>, i64)>,
    children: HashMap<String, String>,
}

impl Tracker {
    fn observe(&mut self, event: &CdpEvent) -> Option<String> {
        let params = &event.params;
        match event.method.as_str() {
            "Runtime.executionContextCreated" => {
                let context = params.get("context")?;
                let id = context.get("id").and_then(Value::as_i64)?;
                if context.pointer("/auxData/isDefault") == Some(&Value::Bool(false)) {
                    self.isolated.insert((event.session_id.clone(), id));
                }
            }
            "Runtime.executionContextDestroyed" => {
                let id = params.get("executionContextId").and_then(Value::as_i64)?;
                self.isolated.remove(&(event.session_id.clone(), id));
            }
            "Runtime.executionContextsCleared" => {
                self.isolated.retain(|(session, _)| *session != event.session_id);
            }
            "Target.attachedToTarget" => {
                let session = params.get("sessionId").and_then(Value::as_str)?.to_string();
                let kind = params
                    .pointer("/targetInfo/type")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                if !matches!(kind.as_str(), "iframe" | "worker" | "shared_worker" | "service_worker") {
                    return None;
                }
                return self.children.insert(session.clone(), kind).is_none().then_some(session);
            }
            "Target.detachedFromTarget" => {
                let session = params.get("sessionId").and_then(Value::as_str)?.to_string();
                self.children.remove(&session);
                self.isolated
                    .retain(|(other, _)| other.as_deref() != Some(session.as_str()));
            }
            _ => {}
        }
        None
    }

    fn isolated(&self, event: &CdpEvent) -> bool {
        let context = match event.method.as_str() {
            "Runtime.consoleAPICalled" => event.params.get("executionContextId"),
            "Runtime.exceptionThrown" => event.params.pointer("/exceptionDetails/executionContextId"),
            _ => None,
        };
        context
            .and_then(Value::as_i64)
            .is_some_and(|id| self.isolated.contains(&(event.session_id.clone(), id)))
    }
}

pub(crate) async fn start(cdp: Arc<dyn Cdp>) -> DriverResult<Subscription<ConsoleEvent>> {
    let mut events = cdp.events();
    let mut tracker = Tracker::default();
    enable(cdp.as_ref(), None).await?;
    let _ = cdp
        .send(
            "Target.setAutoAttach",
            json!({ "autoAttach": true, "waitForDebuggerOnStart": false, "flatten": true }),
            None,
        )
        .await;
    let mut children = drain_replays(&mut events, &mut tracker);
    while let Some(child) = children.pop() {
        let _ = enable(cdp.as_ref(), Some(&child)).await;
        children.extend(drain_replays(&mut events, &mut tracker));
    }
    let tracker = Arc::new(Mutex::new(tracker));
    let (tx, rx) = mpsc::unbounded_channel::<ConsoleEvent>();
    let task_tracker = tracker.clone();
    let task_cdp = cdp.clone();
    let task = tokio::spawn(async move {
        let reason = loop {
            let event = match events.recv().await {
                Ok(event) => event,
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break CloseReason::Closed,
            };
            if let Some(reason) = close_reason(&event) {
                break reason;
            }
            let (new_child, isolated, target) = {
                let mut tracker = task_tracker.lock().unwrap();
                let new_child = tracker.observe(&event);
                let target = event
                    .session_id
                    .as_ref()
                    .and_then(|session| tracker.children.get(session).cloned());
                (new_child, tracker.isolated(&event), target)
            };
            if let Some(child) = new_child {
                let cdp = task_cdp.clone();
                tokio::spawn(async move {
                    let _ = enable(cdp.as_ref(), Some(&child)).await;
                });
                continue;
            }
            if isolated {
                continue;
            }
            if let Some(mut entry) = message_for(&event.method, &event.params) {
                entry.target = target;
                if tx.send(ConsoleEvent::Entry(entry)).is_err() {
                    return;
                }
            }
        };
        let _ = tx.send(ConsoleEvent::Closed(reason));
    });
    let cleanup = Box::new(move || {
        Box::pin(async move {
            let children: Vec<String> = tracker.lock().unwrap().children.keys().cloned().collect();
            for session in std::iter::once(None).chain(children.into_iter().map(Some)) {
                let _ = cdp.send("Runtime.disable", json!({}), session.as_deref()).await;
                let _ = cdp.send("Log.disable", json!({}), session.as_deref()).await;
            }
        }) as std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>
    });
    Ok(Subscription::new(rx, Some(task.abort_handle()), Some(cleanup)))
}

async fn enable(cdp: &dyn Cdp, session: Option<&str>) -> DriverResult<()> {
    cdp.send("Runtime.enable", json!({}), session)
        .await
        .map_err(map_cdp_error)?;
    let _ = cdp.send("Log.enable", json!({}), session).await;
    Ok(())
}

fn drain_replays(events: &mut broadcast::Receiver<CdpEvent>, tracker: &mut Tracker) -> Vec<String> {
    let mut children = Vec::new();
    loop {
        match events.try_recv() {
            Ok(event) => children.extend(tracker.observe(&event)),
            Err(broadcast::error::TryRecvError::Lagged(_)) => {}
            Err(_) => return children,
        }
    }
}

fn close_reason(event: &CdpEvent) -> Option<CloseReason> {
    if event.session_id.is_some() {
        return None;
    }
    match event.method.as_str() {
        "Inspector.detached" => Some(CloseReason::Detached(
            event
                .params
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or("detached")
                .to_string(),
        )),
        "Inspector.targetCrashed" | "Target.targetCrashed" => Some(CloseReason::Crashed),
        _ => None,
    }
}

fn describe(arg: &Value) -> String {
    if let Some(value) = arg.get("value") {
        return match value {
            Value::String(text) => text.clone(),
            other => other.to_string(),
        };
    }
    for key in ["unserializableValue", "description", "type"] {
        if let Some(text) = arg.get(key).and_then(Value::as_str) {
            return text.to_string();
        }
    }
    String::new()
}

fn message_for(method: &str, params: &Value) -> Option<ConsoleEntry> {
    let url_of = |value: Option<&Value>| {
        value
            .and_then(Value::as_str)
            .filter(|u| !u.is_empty())
            .map(str::to_string)
    };
    match method {
        "Runtime.consoleAPICalled" => {
            let kind = params.get("type").and_then(Value::as_str).unwrap_or("log").to_string();
            let text = params
                .get("args")
                .and_then(Value::as_array)
                .map(|args| args.iter().map(describe).collect::<Vec<_>>().join(" "))
                .unwrap_or_default();
            let frame = params.pointer("/stackTrace/callFrames/0");
            let url = url_of(frame.and_then(|f| f.get("url")));
            let line = frame.and_then(|f| f.get("lineNumber")).and_then(Value::as_i64).map(|n| n + 1);
            Some(ConsoleEntry { kind, text, source: None, target: None, url, line })
        }
        "Runtime.exceptionThrown" => {
            let details = params.get("exceptionDetails")?;
            let text = details
                .pointer("/exception/description")
                .and_then(Value::as_str)
                .or_else(|| details.get("text").and_then(Value::as_str))
                .unwrap_or("Uncaught error")
                .to_string();
            let url = url_of(details.get("url"));
            let line = details.get("lineNumber").and_then(Value::as_i64).map(|n| n + 1);
            Some(ConsoleEntry { kind: "pageerror".into(), text, source: None, target: None, url, line })
        }
        "Log.entryAdded" => {
            let entry = params.get("entry")?;
            let level = entry.get("level").and_then(Value::as_str).unwrap_or("info");
            if level == "verbose" {
                return None;
            }
            Some(ConsoleEntry {
                kind: level.to_string(),
                text: entry.get("text").and_then(Value::as_str).unwrap_or("").to_string(),
                source: entry.get("source").and_then(Value::as_str).map(str::to_string),
                target: None,
                url: url_of(entry.get("url")),
                line: entry.get("lineNumber").and_then(Value::as_i64).map(|n| n + 1),
            })
        }
        _ => None,
    }
}
