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
    /// The main document the baseline was captured from (its frame generation); a cross-document navigation retires
    /// it, while same-document URL changes (pushState, hash) keep it.
    pub document: u64,
    pub signature: String,
    pub entries: Vec<RenderedEntry>,
}

/// Refs of the last aria-mode snapshot; they resolve through Playwright's aria-ref engine in each frame.
#[derive(Debug, Clone)]
pub struct AriaRefs {
    pub tab: TabId,
    pub main_generation: u64,
    /// The refs the snapshot showed (`a5`, `f1a3`).
    pub ids: std::collections::HashSet<String>,
}

#[derive(Debug, Default)]
pub struct RefRegistry {
    pub tab: Option<TabId>,
    /// The main document generation the refs were captured from.
    pub document: Option<u64>,
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
        self.document = None;
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

/// A tab's page model for one debugger attachment: concurrent first calls share one attach.
struct Slot {
    cdp: Arc<dyn browse_core::Cdp>,
    page: tokio::sync::OnceCell<Arc<TabPage>>,
}

#[derive(Default)]
pub struct PageSession {
    tabs: Mutex<HashMap<TabId, Arc<Slot>>>,
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
        // The map lock is held only to pick the slot, never across the attach: other tabs never wait on it, and
        // concurrent callers for this tab await the same attach.
        let slot = {
            let mut tabs = self.tabs.lock().unwrap();
            tabs.retain(|_, slot| slot.page.get().map(|page| page.alive()).unwrap_or(true));
            let current = tabs.get(&tab).filter(|slot| same_cdp(&slot.cdp, &cdp) && slot.page.get().map(|page| page.alive()).unwrap_or(true)).cloned();
            match current {
                Some(slot) => slot,
                None => {
                    let slot = Arc::new(Slot { cdp: cdp.clone(), page: tokio::sync::OnceCell::new() });
                    tabs.insert(tab, slot.clone());
                    slot
                }
            }
        };
        let page = slot
            .page
            .get_or_try_init(|| async {
                let page = TabPage::attach(tab, slot.cdp.clone()).await?;
                if page.platform().is_none() {
                    let main = page.main_frame();
                    if let Ok(Ok(info)) = tokio::time::timeout(std::time::Duration::from_secs(2), page.call_value(&main, "frameInfo", vec![], false)).await
                        && let Some(platform) = info["platform"].as_str() {
                            page.set_platform(platform.to_string());
                        }
                }
                Ok::<_, anyhow::Error>(page)
            })
            .await?;
        Ok(page.clone())
    }

    /// The tab the registry's refs belong to.
    pub fn ref_tab(&self) -> Option<TabId> {
        let refs = self.refs.lock().unwrap();
        refs.tab.or(refs.aria.as_ref().map(|a| a.tab))
    }
}
