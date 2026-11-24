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
    /// The main document's generation: a navigation that really replaced the document changes it.
    generation: Option<u64>,
}

fn generation(page: &TabPage) -> Option<u64> {
    page.frame(&page.main_frame()).map(|f| f.generation)
}

/// The tabs this tab's page opened (its popups), which become agent tabs too.
async fn popups_of(ctx: &ToolContext, tab: TabId) -> anyhow::Result<Vec<browse_core::TabInfo>> {
    Ok(ctx.browser.tabs().await?.into_iter().filter(|t| t.opener == Some(tab)).collect())
}

pub async fn before(ctx: &ToolContext, page: &Arc<TabPage>) -> Before {
    let tabs = popups_of(ctx, page.tab()).await.map(|tabs| tabs.into_iter().map(|t| t.tab).collect()).unwrap_or_default();
    Before { seq: page.event_seq(), url: page.main_url(), tabs, started: Instant::now(), generation: generation(page) }
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
        // A navigation the input started synchronously is announced before Chrome answers the input event, so it
        // is already queued; this short wait catches it and ones started a frame later.
        page.wait_until(Duration::from_millis(75), Duration::from_millis(50), |page| {
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
            page.wait_until(remaining, Duration::from_millis(100), |page| page.lifecycle_has(&main, browse_core::LoadState::DomContentLoaded) || page.dialog().is_some()).await;
        }
    }
    describe(ctx, page, before, options).await
}

pub async fn describe(ctx: &ToolContext, page: &Arc<TabPage>, before: &Before, options: AfterOptions) -> Map<String, Value> {
    // A dialog browse answers by itself (auto policy, beforeunload) is being handled in the background.
    if page.dialog().is_some() && page.blocking_dialog().is_none() {
        page.wait_until(Duration::from_secs(2), Duration::from_millis(25), |page| page.dialog().is_none()).await;
    }
    let events = page.events_since(before.seq);
    let mut out = Map::new();
    let url = page.main_url();
    out.insert("url".into(), json!(url));
    if let Some(pending) = page.pending_navigation().filter(|p| *p != url) {
        // A navigation that started and is still loading; `url` is what the tab shows until it commits.
        out.insert("pending".into(), json!(pending));
    }
    let navigations: Vec<&str> = events.iter().filter_map(|e| match e { TabEvent::Navigated { url, same_document: false } => Some(url.as_str()), _ => None }).collect();
    // A late commit event of the previous document doesn't count: the document itself must have changed.
    let navigated = !navigations.is_empty() && generation(page) != before.generation;
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
        if let Ok(Ok(info)) = tokio::time::timeout(Duration::from_secs(2), page.call_value(&main, "frameInfo", vec![], false)).await {
            if let Some(title) = info["title"].as_str() {
                out.insert("title".into(), json!(title));
            }
            if let Some(status) = info["status"].as_u64() {
                out.insert("status".into(), json!(status));
            }
            // Server redirects the navigation timing entry saw (same-origin ones) plus client-side ones.
            let redirects = navigations.len() - 1 + info["redirects"].as_u64().unwrap_or(0) as usize;
            if redirects > 0 {
                out.insert("redirects".into(), json!(redirects));
            }
            if info["errorPage"].as_bool() == Some(true) && info["status"].as_u64().is_none() {
                let error = info["netError"].as_str().unwrap_or("a network error");
                out.insert("warning".into(), json!(format!("The browser could not load {url} ({error}) and shows its error page instead.")));
            }
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
    // A popup the page opened (Page.windowOpen) can take a moment to show up as a tab.
    let popups = events.iter().filter(|e| matches!(e, TabEvent::Popup { .. })).count();
    if popups > 0 {
        let until = Instant::now() + Duration::from_millis(1_500);
        while Instant::now() < until {
            match popups_of(ctx, page.tab()).await {
                Ok(tabs) if tabs.iter().filter(|t| !before.tabs.contains(&t.tab)).count() >= popups => break,
                Ok(_) => tokio::time::sleep(Duration::from_millis(100)).await,
                Err(_) => break,
            }
        }
    }
    if let Ok(tabs) = popups_of(ctx, page.tab()).await {
        let new: Vec<Value> = tabs.iter().filter(|t| !before.tabs.contains(&t.tab)).map(|t| json!({ "tab": t.tab, "url": t.url })).collect();
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
                let main = page.main_frame();
                if let Ok(Ok(info)) = tokio::time::timeout(Duration::from_secs(2), page.call_value(&main, "frameInfo", vec![], false)).await
                    && let Some(title) = info["title"].as_str() {
                        out.insert("title".into(), json!(title));
                    }
            }
            if let Some(warning) = warning {
                out.insert("warning".into(), json!(warning));
            }
        }
    out
}
