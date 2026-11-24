//! What browse-page keeps in a tab's state (`ToolContext::state`): its page model and its snapshot refs.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use anyhow::Result;
use browse_core::{TabId, ToolContext};

use crate::page::TabPage;
use crate::snapshot::RenderedEntry;

const STATE_KEY: &str = "browse-page";

/// Where a snapshot ref lives.
#[derive(Debug, Clone)]
pub struct RefTarget {
    pub selector: String,
    pub role: String,
    pub name: Option<String>,
    /// Set when the element is inside an iframe: the frame and its document generation when the ref was captured.
    pub frame: Option<(String, u64)>,
}

#[derive(Debug, Clone)]
pub struct Baseline {
    pub tab: TabId,
    /// The main document the baseline was captured from; a cross-document navigation retires it, while same-document
    /// URL changes (pushState, hash) keep it.
    pub document: u64,
    pub signature: String,
    pub entries: Vec<RenderedEntry>,
}

/// Refs of the last aria-mode snapshot; they resolve through Playwright's aria-ref engine in each frame.
#[derive(Debug, Clone)]
pub struct AriaRefs {
    pub tab: TabId,
    pub main_generation: u64,
    pub ids: std::collections::HashSet<String>,
}

#[derive(Debug, Default)]
pub struct RefRegistry {
    pub tab: Option<TabId>,
    pub document: Option<u64>,
    pub selectors: HashMap<String, RefTarget>,
    pub latest: Option<Baseline>,
    pub baseline: Option<Baseline>,
    pub next_ref: u64,
    pub frame_keys: HashMap<String, String>,
    pub next_frame_key: u64,
    pub aria: Option<AriaRefs>,
}

impl RefRegistry {
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

struct Slot {
    driver: Arc<dyn browse_core::TabDriver>,
    page: tokio::sync::OnceCell<Arc<TabPage>>,
}

pub struct PageTab {
    tab: TabId,
    slot: Mutex<Option<Arc<Slot>>>,
    pub refs: Mutex<RefRegistry>,
}

pub async fn tab(ctx: &ToolContext, tab: TabId) -> Result<Arc<PageTab>> {
    let state = ctx.state(tab).await?;
    Ok(state
        .get_or_insert(STATE_KEY, || {
            Arc::new(PageTab { tab, slot: Mutex::new(None), refs: Mutex::new(RefRegistry::default()) })
        })
        .await)
}

fn same_driver(a: &Arc<dyn browse_core::TabDriver>, b: &Arc<dyn browse_core::TabDriver>) -> bool {
    Arc::as_ptr(a) as *const () == Arc::as_ptr(b) as *const ()
}

impl PageTab {
    pub fn id(&self) -> TabId {
        self.tab
    }

    /// The tab's page model, attached on first use (and again when the driver attachment changed).
    pub async fn page(&self, ctx: &ToolContext) -> Result<Arc<TabPage>> {
        let tab = self.tab;
        let driver = ctx.browser.tab_driver(tab).await?;
        let slot = {
            let mut current = self.slot.lock().unwrap();
            let usable = current
                .as_ref()
                .filter(|slot| same_driver(&slot.driver, &driver) && slot.page.get().map(|page| page.alive()).unwrap_or(true))
                .cloned();
            match usable {
                Some(slot) => slot,
                None => {
                    let slot = Arc::new(Slot { driver: driver.clone(), page: tokio::sync::OnceCell::new() });
                    *current = Some(slot.clone());
                    slot
                }
            }
        };
        let page = slot
            .page
            .get_or_try_init(|| async {
                let page = TabPage::attach(tab, slot.driver.clone()).await?;
                if page.platform().is_none() {
                    let main = page.main_frame();
                    if let Ok(Ok(info)) = tokio::time::timeout(
                        std::time::Duration::from_secs(2),
                        page.call_value(&main, "frameInfo", vec![], false),
                    )
                    .await
                        && let Some(platform) = info["platform"].as_str()
                    {
                        page.set_platform(platform.to_string());
                    }
                }
                Ok::<_, anyhow::Error>(page)
            })
            .await?;
        Ok(page.clone())
    }
}
