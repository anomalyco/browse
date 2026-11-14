//! Per-session state kept in `ToolContext::state`: the tab pages and the snapshot ref registry.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use anyhow::Result;
use browse_core::{TabId, ToolContext};

use crate::page::TabPage;
use crate::snapshot::RenderedEntry;

const STATE_KEY: &str = "browse-page";
/// Shared with browse-capture: a `bool`, true while offline emulation is on in any tab of the session. Network
/// emulation only works while the Network domain is enabled, so capture must not send `Network.disable` then.
pub const NETWORK_OFFLINE_KEY: &str = "browse.network.offline";
/// Read from browse-capture: a `bool`, true while a network capture runs in the session and needs the Network domain.
pub const NETWORK_CAPTURE_KEY: &str = "browse.network.capture";

/// Where a snapshot ref lives.
#[derive(Debug, Clone)]
pub struct RefTarget {
    pub selector: String,
    pub role: String,
    pub name: Option<String>,
    /// Set when the element is inside an iframe: the frame and its generation when the ref was captured.
    pub frame: Option<(String, u64)>,
}

#[derive(Debug, Clone)]
pub struct Baseline {
    pub tab: TabId,
    /// The main document the baseline was captured from (URL and frame generation); a navigation retires it.
    pub document: (String, u64),
    pub signature: String,
    pub entries: Vec<RenderedEntry>,
}

/// Refs of the last aria-mode snapshot; they resolve through Playwright's aria-ref engine in each frame.
#[derive(Debug, Clone)]
pub struct AriaRefs {
    pub tab: TabId,
    pub url: String,
    pub main_generation: u64,
}

#[derive(Debug, Default)]
pub struct RefRegistry {
    pub tab: Option<TabId>,
    pub url: Option<String>,
    pub selectors: HashMap<String, RefTarget>,
    pub previous: Option<Baseline>,
    pub next_ref: u64,
    pub frame_keys: HashMap<String, String>,
    pub next_frame_key: u64,
    pub aria: Option<AriaRefs>,
}

impl RefRegistry {
    /// Refs and diff baselines never survive the document they were captured from.
    pub fn invalidate(&mut self) {
        self.selectors.clear();
        self.tab = None;
        self.url = None;
        self.previous = None;
    }

    pub fn frame_key(&mut self, frame: &str) -> String {
        if let Some(key) = self.frame_keys.get(frame) {
            return key.clone();
        }
        self.next_frame_key = self.next_frame_key.max(1);
        let key = format!("f{}", self.next_frame_key);
        self.next_frame_key += 1;
        self.frame_keys.insert(frame.to_string(), key.clone());
        key
    }
}

#[derive(Default)]
pub struct PageSession {
    tabs: tokio::sync::Mutex<HashMap<TabId, Arc<TabPage>>>,
    pub refs: Mutex<RefRegistry>,
    /// Tabs with offline emulation on.
    pub offline_tabs: Mutex<std::collections::HashSet<TabId>>,
}

/// Records whether offline emulation is on for `tab` and publishes the session-wide flag under NETWORK_OFFLINE_KEY.
pub async fn set_offline(ctx: &ToolContext, session: &PageSession, tab: TabId, offline: bool) {
    let any = {
        let mut tabs = session.offline_tabs.lock().unwrap();
        if offline {
            tabs.insert(tab);
        } else {
            tabs.remove(&tab);
        }
        !tabs.is_empty()
    };
    ctx.state.inner().lock().await.insert(NETWORK_OFFLINE_KEY.to_string(), Box::new(any));
}

/// Whether browse-capture says a network capture needs the Network domain (NETWORK_CAPTURE_KEY).
pub async fn network_capture_active(ctx: &ToolContext) -> bool {
    ctx.state.inner().lock().await.get(NETWORK_CAPTURE_KEY).and_then(|v| v.downcast_ref::<bool>()).copied().unwrap_or(false)
}

pub async fn session(ctx: &ToolContext) -> Arc<PageSession> {
    let mut map = ctx.state.inner().lock().await;
    let entry = map.entry(STATE_KEY.to_string()).or_insert_with(|| Box::new(Arc::new(PageSession::default())));
    match entry.downcast_ref::<Arc<PageSession>>() {
        Some(session) => session.clone(),
        None => {
            let session = Arc::new(PageSession::default());
            *entry = Box::new(session.clone());
            session
        }
    }
}

fn same_cdp(a: &Arc<dyn browse_core::Cdp>, b: &Arc<dyn browse_core::Cdp>) -> bool {
    Arc::as_ptr(a) as *const () == Arc::as_ptr(b) as *const ()
}

impl PageSession {
    /// The page model of a tab (the session's current tab when `tab` is None), attached on first use.
    pub async fn page(&self, ctx: &ToolContext, tab: Option<TabId>) -> Result<Arc<TabPage>> {
        let tab = match tab {
            Some(tab) => tab,
            None => ctx.browser.current_tab(&ctx.session).await?.tab_id,
        };
        let cdp = ctx.browser.cdp(&ctx.session, tab).await?;
        let mut tabs = self.tabs.lock().await;
        if let Some(page) = tabs.get(&tab)
            && same_cdp(page.cdp(), &cdp) && page.alive() {
                return Ok(page.clone());
            }
        tabs.retain(|_, page| page.alive());
        let page = TabPage::attach(tab, cdp).await?;
        if page.platform().is_none() {
            let main = page.main_frame();
            if let Ok(info) = page.call_value(&main, "frameInfo", vec![], false).await
                && let Some(platform) = info["platform"].as_str() {
                    page.set_platform(platform.to_string());
                }
        }
        tabs.insert(tab, page.clone());
        Ok(page)
    }

    /// The tab the registry's refs belong to.
    pub fn ref_tab(&self) -> Option<TabId> {
        let refs = self.refs.lock().unwrap();
        refs.tab.or(refs.aria.as_ref().map(|a| a.tab))
    }
}
