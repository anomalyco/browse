//! Recording what the user does in a tab while a handoff waits (cli/src/execute/demonstration.ts). The listeners
//! run in an isolated world of each frame, so the page sees no globals or patched functions; each frame's steps come
//! back through a pending evaluate that resolves as soon as a step is recorded, before a navigation can drop them.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use browse_core::{Browser, Cdp};
use serde_json::{Value, json};

use crate::browser::RelayBrowser;
use crate::relay::Relay;

const INSTALL: &str = r#"(recorderId) => {
  const world = globalThis;
  if (world.__browseDemonstration?.id === recorderId) return;
  world.__browseDemonstration?.cleanup();
  const steps = [];
  const send = (step) => { steps.push(step); world.__browseDemonstration?.wake?.(); };
  const cssPath = (element) => {
    const id = element.getAttribute("id");
    if (id) return `#${CSS.escape(id)}`;
    for (const attribute of ["data-testid", "data-test", "name", "aria-label"]) {
      const value = element.getAttribute(attribute);
      if (!value) continue;
      const candidate = `[${attribute}="${CSS.escape(value)}"]`;
      if (document.querySelectorAll(candidate).length === 1) return candidate;
    }
    const parent = element.parentElement;
    const tag = element.tagName.toLowerCase();
    if (!parent) return tag;
    const siblings = Array.from(parent.children).filter((c) => c.tagName === element.tagName);
    return `${cssPath(parent)} > ${tag}:nth-of-type(${siblings.indexOf(element) + 1})`;
  };
  const nameFor = (element) => {
    const label = element.getAttribute("aria-label")?.trim();
    if (label) return label;
    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy) {
      const text = labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ").replace(/\s+/g, " ").trim();
      if (text) return text;
    }
    const text = element.textContent?.replace(/\s+/g, " ").trim();
    return text ? text.slice(0, 120) : undefined;
  };
  const roleFor = (element) => {
    const explicit = element.getAttribute("role");
    if (explicit) return explicit;
    if (element instanceof HTMLButtonElement) return "button";
    if (element instanceof HTMLAnchorElement) return "link";
    if (element instanceof HTMLInputElement) return element.type === "checkbox" ? "checkbox" : element.type === "radio" ? "radio" : "textbox";
    if (element instanceof HTMLSelectElement) return "combobox";
    if (element instanceof HTMLTextAreaElement || (element instanceof HTMLElement && element.isContentEditable)) return "textbox";
    return undefined;
  };
  const onClick = (event) => {
    const target = event.composedPath().find((c) => c instanceof Element);
    const actionable = target?.closest("button, a[href], summary, [role='button'], [role='link'], [role='tab'], [role='menuitem']");
    if (!actionable) return;
    const role = roleFor(actionable);
    const name = nameFor(actionable);
    send({ kind: "click", selector: cssPath(actionable), ...(role === undefined ? {} : { role }), ...(name === undefined ? {} : { name }) });
  };
  const onInput = (event) => {
    const element = event.target;
    if (element instanceof HTMLInputElement) {
      if (["checkbox", "radio", "file", "button", "submit", "reset"].includes(element.type)) return;
      const secret = element.type === "password";
      send({ kind: "fill", selector: cssPath(element), value: secret ? "" : element.value, ...(secret ? { redacted: true } : {}) });
    } else if (element instanceof HTMLTextAreaElement) {
      send({ kind: "fill", selector: cssPath(element), value: element.value });
    } else if (element instanceof HTMLElement && element.isContentEditable) {
      send({ kind: "fill", selector: cssPath(element), value: element.innerText });
    }
  };
  const onChange = (event) => {
    const element = event.target;
    if (element instanceof HTMLInputElement && (element.type === "checkbox" || element.type === "radio")) {
      send({ kind: "check", selector: cssPath(element), checked: element.checked });
    } else if (element instanceof HTMLSelectElement) {
      send({ kind: "select", selector: cssPath(element), value: element.value });
    } else onInput(event);
  };
  document.addEventListener("click", onClick, true);
  document.addEventListener("input", onInput, true);
  document.addEventListener("change", onChange, true);
  const cleanup = () => {
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("input", onInput, true);
    document.removeEventListener("change", onChange, true);
    const current = world.__browseDemonstration;
    if (current?.id === recorderId) { delete world.__browseDemonstration; current.wake?.(); }
  };
  world.__browseDemonstration = { id: recorderId, steps, cleanup };
}"#;

const TAKE: &str = r#"(recorderId, waitMs) => {
  const state = globalThis.__browseDemonstration;
  if (!state || state.id !== recorderId) return Promise.resolve(null);
  if (state.steps.length > 0) return Promise.resolve(state.steps.splice(0));
  return new Promise((resolve) => {
    const timer = setTimeout(() => { state.wake = undefined; resolve([]); }, waitMs);
    state.wake = () => { clearTimeout(timer); state.wake = undefined; resolve(state.steps.splice(0)); };
  });
}"#;

const REMOVE: &str = r#"(recorderId) => { const state = globalThis.__browseDemonstration; if (state?.id === recorderId) state.cleanup(); }"#;

fn append_step(steps: &mut Vec<Value>, next: Value) {
    if let Some(previous) = steps.last_mut() {
        if next["kind"] == "fill" && previous["kind"] == "fill" && previous["selector"] == next["selector"] {
            *previous = next;
            return;
        }
        if next["kind"] == "navigation" && previous["kind"] == "navigation" && previous["url"] == next["url"] {
            return;
        }
    }
    steps.push(next);
}

fn valid_step(step: &Value) -> bool {
    match step["kind"].as_str() {
        Some("click" | "check" | "select" | "fill") => step["selector"].is_string(),
        Some("navigation") => step["url"].is_string(),
        _ => false,
    }
}

/// Prose for a step, naming the tool calls that would repeat it.
pub fn describe_step(step: &Value) -> String {
    let selector = step["selector"].as_str().unwrap_or("");
    match step["kind"].as_str() {
        Some("navigation") => format!("navigated to {}", step["url"].as_str().unwrap_or("")),
        Some("click") => match (step["role"].as_str(), step["name"].as_str()) {
            (Some(role), Some(name)) => format!("clicked {role} {name:?} ({selector})"),
            _ => format!("clicked {selector}"),
        },
        Some("fill") if step["redacted"] == true => format!("typed a password into {selector} (ask the user to enter it)"),
        Some("fill") => format!("filled {selector} with {}", step["value"]),
        Some("check") => format!("{} {selector}", if step["checked"] == true { "checked" } else { "unchecked" }),
        Some("select") => format!("selected {} in {selector}", step["value"]),
        _ => String::new(),
    }
}

fn frame_ids(tree: &Value, out: &mut Vec<String>) {
    if let Some(id) = tree["frame"]["id"].as_str() {
        out.push(id.to_string());
    }
    for child in tree["childFrames"].as_array().into_iter().flatten() {
        frame_ids(child, out);
    }
}

struct Recorder {
    cdp: Arc<dyn Cdp>,
    id: String,
    world: String,
    steps: Arc<Mutex<Vec<Value>>>,
    contexts: Mutex<HashMap<String, i64>>,
    pumps: Mutex<Vec<tokio::task::JoinHandle<()>>>,
}

impl Recorder {
    async fn install(self: &Arc<Self>, frame: &str) {
        let Ok(world) = self.cdp.send("Page.createIsolatedWorld", json!({ "frameId": frame, "worldName": self.world, "grantUniveralAccess": false }), None).await else { return };
        let Some(context) = world["executionContextId"].as_i64() else { return };
        let install = json!({ "expression": format!("({INSTALL})({})", json!(self.id)), "contextId": context, "returnByValue": true });
        if self.cdp.send("Runtime.evaluate", install, None).await.is_err() {
            return;
        }
        self.contexts.lock().unwrap().insert(frame.to_string(), context);
        let recorder = self.clone();
        let pump = tokio::spawn(async move {
            loop {
                let take = json!({ "expression": format!("({TAKE})({}, 15000)", json!(recorder.id)), "contextId": context, "awaitPromise": true, "returnByValue": true });
                let Ok(result) = recorder.cdp.send("Runtime.evaluate", take, None).await else { return };
                let Some(steps) = result["result"]["value"].as_array() else { return };
                let mut recorded = recorder.steps.lock().unwrap();
                for step in steps.iter().filter(|s| valid_step(s)) {
                    append_step(&mut recorded, step.clone());
                }
            }
        });
        self.pumps.lock().unwrap().push(pump);
    }

    async fn stop(&self) {
        let contexts: Vec<i64> = self.contexts.lock().unwrap().values().copied().collect();
        for context in contexts {
            let remove = json!({ "expression": format!("({REMOVE})({})", json!(self.id)), "contextId": context });
            let _ = self.cdp.send("Runtime.evaluate", remove, None).await;
        }
        let mut pumps: Vec<_> = std::mem::take(&mut *self.pumps.lock().unwrap());
        let _ = tokio::time::timeout(Duration::from_secs(2), futures_util::future::join_all(pumps.iter_mut())).await;
        for pump in pumps {
            pump.abort();
        }
    }
}

/// Asks the user to show a flow in the tab, recording their clicks, fills and navigations until they continue.
pub async fn demonstrate(relay: &Arc<Relay>, tab: i64, message: &str, timeout: Duration) -> anyhow::Result<Value> {
    let browser = RelayBrowser(relay.clone());
    let cdp = browser.cdp(tab).await?;
    let started_url = relay.st().tabs.get(&tab).map(|t| t.url.clone()).unwrap_or_default();
    let recorder = Arc::new(Recorder {
        cdp: cdp.clone(),
        id: format!("demo-{}", crate::util::random_hex(6)),
        world: format!("w{}", crate::util::random_hex(6)),
        steps: Arc::new(Mutex::new(Vec::new())),
        contexts: Mutex::new(HashMap::new()),
        pumps: Mutex::new(Vec::new()),
    });
    let mut events = cdp.events();
    let tree = cdp.send("Page.getFrameTree", json!({}), None).await?;
    let mut frames = Vec::new();
    frame_ids(&tree["frameTree"], &mut frames);
    for frame in &frames {
        recorder.install(frame).await;
    }
    let watcher = {
        let recorder = recorder.clone();
        tokio::spawn(async move {
            while let Ok(event) = events.recv().await {
                if event.session_id.is_some() || event.method != "Page.frameNavigated" {
                    continue;
                }
                let frame = &event.params["frame"];
                let Some(id) = frame["id"].as_str() else { continue };
                if frame.get("parentId").is_none()
                    && let Some(url) = frame["url"].as_str() {
                        append_step(&mut recorder.steps.lock().unwrap(), json!({ "kind": "navigation", "url": url }));
                    }
                recorder.contexts.lock().unwrap().remove(id);
                recorder.install(id).await;
            }
        })
    };
    let message = if message.trim().is_empty() { "Demonstrate the browser flow, then click Continue" } else { message };
    let outcome = relay.run_handoff(tab, message, timeout).await;
    watcher.abort();
    recorder.stop().await;
    let outcome = outcome?;
    let steps = recorder.steps.lock().unwrap().clone();
    let ended_url = relay.st().tabs.get(&tab).map(|t| t.url.clone()).unwrap_or_else(|| started_url.clone());
    let summary: Vec<String> = steps.iter().map(describe_step).collect();
    Ok(json!({ "outcome": outcome.outcome, "startedUrl": started_url, "endedUrl": ended_url, "steps": steps, "summary": summary }))
}
