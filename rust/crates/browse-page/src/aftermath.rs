//! What an action changed: navigations, dialogs, new tabs, a challenge page (the "aftermath" of
//! cli/src/execute/code-runner.ts), reported compactly in every action result.

use std::sync::Arc;
use std::time::{Duration, Instant};

use browse_core::{TabId, ToolContext};
use serde_json::{Map, Value, json};

use crate::challenge;
use crate::page::{TabEvent, TabPage};

pub struct Before {
    seq: u64,
    url: String,
    tabs: Vec<TabId>,
    started: Instant,
}

pub async fn before(ctx: &ToolContext, page: &Arc<TabPage>) -> Before {
    let tabs = ctx.browser.tabs(&ctx.session).await.map(|tabs| tabs.into_iter().map(|t| t.tab_id).collect()).unwrap_or_default();
    Before { seq: page.event_seq(), url: page.main_url(), tabs, started: Instant::now() }
}

#[derive(Clone, Copy)]
pub struct AfterOptions {
    /// Give the action a moment to start a navigation, and wait for one that started to commit.
    pub expect_navigation: bool,
    pub navigation_timeout: Duration,
    pub detect_challenge: bool,
}

impl Default for AfterOptions {
    fn default() -> Self {
        AfterOptions { expect_navigation: true, navigation_timeout: Duration::from_secs(10), detect_challenge: true }
    }
}

fn started_navigation(events: &[TabEvent]) -> (bool, bool) {
    let mut started = false;
    let mut committed = false;
    for event in events {
        match event {
            TabEvent::NavigationStarted { .. } => {
                started = true;
                committed = false;
            }
            TabEvent::Navigated { same_document: false, .. } => committed = true,
            _ => {}
        }
    }
    (started, committed)
}

pub async fn after(ctx: &ToolContext, page: &Arc<TabPage>, before: &Before, options: AfterOptions) -> Map<String, Value> {
    let seq = before.seq;
    if options.expect_navigation && page.dialog().is_none() {
        // Clicks that navigate usually start within a frame or two.
        page.wait_until(Duration::from_millis(150), Duration::from_millis(50), |page| {
            let (started, _) = started_navigation(&page.events_since(seq));
            started || page.dialog().is_some()
        })
        .await;
        let (started, committed) = started_navigation(&page.events_since(seq));
        if started && !committed {
            page.wait_until(options.navigation_timeout, Duration::from_millis(100), |page| {
                started_navigation(&page.events_since(seq)).1 || page.dialog().is_some()
            })
            .await;
        }
        let (_, committed) = started_navigation(&page.events_since(seq));
        if committed {
            let main = page.main_frame();
            let remaining = options.navigation_timeout.saturating_sub(before.started.elapsed()).max(Duration::from_millis(500));
            page.wait_until(remaining, Duration::from_millis(100), |page| page.lifecycle_has(&main, "DOMContentLoaded") || page.dialog().is_some()).await;
        }
    }
    describe(ctx, page, before, options).await
}

pub async fn describe(ctx: &ToolContext, page: &Arc<TabPage>, before: &Before, options: AfterOptions) -> Map<String, Value> {
    let events = page.events_since(before.seq);
    let mut out = Map::new();
    let url = page.main_url();
    out.insert("url".into(), json!(url));
    let navigations: Vec<&str> = events.iter().filter_map(|e| match e { TabEvent::Navigated { url, same_document: false } => Some(url.as_str()), _ => None }).collect();
    let navigated = !navigations.is_empty();
    if navigated {
        out.insert("navigated".into(), json!(true));
        if before.url != url {
            out.insert("from".into(), json!(before.url));
        }
        if navigations.len() > 1 {
            out.insert("redirects".into(), json!(navigations.len() - 1));
        }
    } else if before.url != url {
        out.insert("urlChanged".into(), json!({ "from": before.url }));
    }
    if navigated && page.dialog().is_none() {
        let main = page.main_frame();
        if let Ok(Ok(info)) = tokio::time::timeout(Duration::from_secs(2), page.call_value(&main, "frameInfo", vec![], false)).await
            && let Some(title) = info["title"].as_str() {
                out.insert("title".into(), json!(title));
            }
    }
    let handled: Vec<Value> = events.iter().filter_map(|e| match e { TabEvent::DialogClosed { accepted, auto: true } => Some(json!(if *accepted { "accepted" } else { "dismissed" })), _ => None }).collect();
    let opened: Vec<Value> = events.iter().filter_map(|e| match e { TabEvent::Dialog(d) => Some(json!({ "type": d.kind, "message": d.message })), _ => None }).collect();
    if let Some(dialog) = page.dialog() {
        out.insert("dialog".into(), json!({ "type": dialog.kind, "message": dialog.message, "pending": true, "next": "call dialog with action \"accept\" or \"dismiss\"; the page is paused until then" }));
    } else if !opened.is_empty() {
        out.insert("dialogs".into(), json!(opened.iter().zip(handled.iter().chain(std::iter::repeat(&json!("handled")))).map(|(d, h)| { let mut d = d.clone(); d["handled"] = h.clone(); d }).collect::<Vec<_>>()));
    }
    if events.iter().any(|e| matches!(e, TabEvent::Crashed)) {
        out.insert("crashed".into(), json!(true));
    }
    if let Ok(tabs) = ctx.browser.tabs(&ctx.session).await {
        let new: Vec<Value> = tabs.iter().filter(|t| !before.tabs.contains(&t.tab_id)).map(|t| json!({ "tab": t.tab_id, "url": t.url })).collect();
        if !new.is_empty() {
            out.insert("newTabs".into(), json!(new));
        }
    } else {
        let popups: Vec<Value> = events.iter().filter_map(|e| match e { TabEvent::Popup { url } => Some(json!({ "url": url })), _ => None }).collect();
        if !popups.is_empty() {
            out.insert("newTabs".into(), json!(popups));
        }
    }
    if navigated && options.detect_challenge && page.dialog().is_none()
        && let Some(outcome) = challenge::detect(page, Duration::from_millis(challenge::wait_ms())).await {
            let warning = challenge::warning(&outcome);
            out.insert("challenge".into(), serde_json::to_value(&outcome).unwrap_or(Value::Null));
            if outcome.status == "cleared" {
                out.insert("url".into(), json!(page.main_url()));
            }
            if let Some(warning) = warning {
                out.insert("warning".into(), json!(warning));
            }
        }
    out
}
