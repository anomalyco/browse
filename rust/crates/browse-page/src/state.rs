//! What browse-page keeps in a tab's state (`ToolContext::state`): its page model and its snapshot refs.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use anyhow::Result;
use browse_core::{TabId, TabState, ToolContext};

use crate::page::TabPage;
use crate::snapshot::RenderedEntry;

const STATE_KEY: &str = "browse-page";
/// Shared with browse-capture: a `bool` in the tab's state, true while offline emulation is on. Network emulation only
/// works while the Network domain is enabled, so capture must not send `Network.disable` then.
pub const NETWORK_OFFLINE_KEY: &str = "browse.network.offline";
/// Read from browse-capture: a `bool` in the tab's state, true while a network capture needs the Network domain.
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
    /// Rendered entries from the latest snapshot, find included, for ref-ID reuse.
    pub latest: Option<Baseline>,
    /// Rendered entries from the latest non-find snapshot, for diff and delta.
    pub baseline: Option<Baseline>,
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
        self.latest = None;
        self.baseline = None;
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

/// browse-page's part of a tab's state.
pub struct PageTab {
    tab: TabId,
    slot: Mutex<Option<Arc<Slot>>>,
    pub refs: Mutex<RefRegistry>,
}

/// Records whether offline emulation is on in the tab, for browse-capture (NETWORK_OFFLINE_KEY).
pub async fn set_offline(state: &TabState, offline: bool) {
    state.inner().lock().await.insert(NETWORK_OFFLINE_KEY.to_string(), Box::new(offline));
}

/// Whether browse-capture says a network capture needs the Network domain in the tab (NETWORK_CAPTURE_KEY).
pub async fn network_capture_active(state: &TabState) -> bool {
    state.inner().lock().await.get(NETWORK_CAPTURE_KEY).and_then(|v| v.downcast_ref::<bool>()).copied().unwrap_or(false)
}

/// browse-page's state of the tab.
pub async fn tab(ctx: &ToolContext, tab: TabId) -> Result<Arc<PageTab>> {
    let state = ctx.state(tab).await?;
    Ok(state.get_or_insert(STATE_KEY, || Arc::new(PageTab { tab, slot: Mutex::new(None), refs: Mutex::new(RefRegistry::default()) })).await)
}

fn same_cdp(a: &Arc<dyn browse_core::Cdp>, b: &Arc<dyn browse_core::Cdp>) -> bool {
    Arc::as_ptr(a) as *const () == Arc::as_ptr(b) as *const ()
}

impl PageTab {
    pub fn id(&self) -> TabId {
        self.tab
    }

    /// The tab's page model, attached on first use (and again when the debugger attachment changed).
    pub async fn page(&self, ctx: &ToolContext) -> Result<Arc<TabPage>> {
        let tab = self.tab;
        let cdp = ctx.browser.cdp(tab).await?;
        // The lock is held only to pick the slot, never across the attach: concurrent callers await the same attach.
        let slot = {
            let mut current = self.slot.lock().unwrap();
            let usable = current.as_ref().filter(|slot| same_cdp(&slot.cdp, &cdp) && slot.page.get().map(|page| page.alive()).unwrap_or(true)).cloned();
            match usable {
                Some(slot) => slot,
                None => {
                    let slot = Arc::new(Slot { cdp: cdp.clone(), page: tokio::sync::OnceCell::new() });
                    *current = Some(slot.clone());
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
}
