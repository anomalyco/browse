//! `HarnessBrowser`: a `browse_core::Browser` over any `BrowserDriver`, standing in for the relay.
//!
//! Tab ids restart at 1 for every scenario, popups a tab's page opens are adopted as tabs (in the order the browser
//! announces them), every tab's driver is wrapped in `GuardedTabDriver` with a small `TabPolicy` (`readOnly` and
//! `allowedOrigins`), human input is off and the browser counts as local. The tab the browser started with is never
//! handed out: it keeps the browser alive when a scenario closes its last tab.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{anyhow, bail};
use async_trait::async_trait;
use browse_core::{
    Browser, BrowserDriver, BrowserEvent, GuardedTabDriver, HandoffResult, LoadState, PageEvent, TabDriver, TabId,
    TabInfo, TabOptions, TabPolicy, TabState, TargetId,
};
use tokio::sync::broadcast;

use crate::launch::BrowserControl;

#[derive(Clone)]
struct Entry {
    target: TargetId,
    raw: Arc<dyn TabDriver>,
    guarded: Arc<dyn TabDriver>,
    state: Arc<TabState>,
    options: TabOptions,
    opener: Option<TabId>,
}

#[derive(Default)]
struct Inner {
    next: TabId,
    tabs: BTreeMap<TabId, Entry>,
}

pub struct HarnessBrowser {
    driver: Arc<dyn BrowserDriver>,
    control: Arc<dyn BrowserControl>,
    inner: Arc<Mutex<Inner>>,
    pump: tokio::task::AbortHandle,
}

/// The sweep's tab policy: `readOnly` and an `allowedOrigins` list of hosts or origins.
pub struct HarnessPolicy {
    read_only: bool,
    allowed_origins: Option<Vec<String>>,
}

/// `scheme://host[:port]` and the host of an http(s) URL.
fn origin_of(url: &str) -> Option<(String, String)> {
    let (scheme, rest) = url.split_once("://")?;
    let authority = rest.split(['/', '?', '#']).next()?;
    let host = authority.rsplit_once('@').map(|(_, h)| h).unwrap_or(authority);
    let hostname = host.split(':').next().unwrap_or(host);
    Some((format!("{}://{}", scheme.to_ascii_lowercase(), host.to_ascii_lowercase()), hostname.to_ascii_lowercase()))
}

pub fn origin_allowed(allowed: &[String], url: &str) -> bool {
    if url == "about:blank" {
        return true;
    }
    let Some((origin, host)) = origin_of(url) else { return false };
    allowed.iter().any(|entry| {
        let entry = entry.trim().trim_end_matches('/').to_ascii_lowercase();
        entry == origin || entry == host
    })
}

#[async_trait]
impl TabPolicy for HarnessPolicy {
    fn is_read_only(&self) -> bool {
        self.read_only
    }

    async fn check_navigation(&self, url: &str) -> Result<(), String> {
        match &self.allowed_origins {
            Some(allowed) if !origin_allowed(allowed, url) => {
                Err(format!("browse blocked navigate to {url}: it is outside this tab's allowedOrigins"))
            }
            _ => Ok(()),
        }
    }
}

fn info(tab: TabId, entry: &Entry, url: String) -> TabInfo {
    TabInfo {
        tab,
        url,
        title: String::new(),
        lent: false,
        chosen: None,
        opener: entry.opener,
        last_used: None,
        busy: false,
        handoff: None,
        options: entry.options.clone(),
    }
}

fn guard(raw: Arc<dyn TabDriver>, options: &TabOptions) -> Arc<dyn TabDriver> {
    let policy = Arc::new(HarnessPolicy { read_only: options.read_only, allowed_origins: options.allowed_origins.clone() });
    GuardedTabDriver::new(raw, policy)
}

impl HarnessBrowser {
    pub fn new(driver: Arc<dyn BrowserDriver>, control: Arc<dyn BrowserControl>) -> Arc<HarnessBrowser> {
        let inner = Arc::new(Mutex::new(Inner { next: 1, tabs: BTreeMap::new() }));
        let mut events = driver.events();
        let pump_inner = inner.clone();
        let pump_driver = driver.clone();
        // Events are handled one at a time, so popups get ids in the order the browser announced them.
        let pump = tokio::spawn(async move {
            loop {
                match events.recv().await {
                    Ok(BrowserEvent::TabOpened { target, opener: Some(opener), .. }) => {
                        adopt(&pump_driver, &pump_inner, target, opener).await;
                    }
                    Ok(BrowserEvent::TabClosed { target }) => {
                        pump_inner.lock().unwrap().tabs.retain(|_, entry| entry.target != target);
                    }
                    Ok(BrowserEvent::Disconnected) | Err(broadcast::error::RecvError::Closed) => break,
                    Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => {}
                }
            }
        });
        Arc::new(HarnessBrowser { driver, control, inner, pump: pump.abort_handle() })
    }

    pub fn driver(&self) -> &Arc<dyn BrowserDriver> {
        &self.driver
    }

    pub async fn top_level_tabs(&self) -> anyhow::Result<usize> {
        self.control.top_level_tabs().await
    }

    /// Closes every tab and restarts ids at 1.
    pub async fn reset(&self) {
        let entries: Vec<Entry> = {
            let mut inner = self.inner.lock().unwrap();
            inner.next = 1;
            std::mem::take(&mut inner.tabs).into_values().collect()
        };
        for entry in entries {
            let _ = tokio::time::timeout(Duration::from_secs(5), self.driver.close(&entry.target)).await;
        }
    }

    /// The unguarded driver of a tab, for the sweep's own checks.
    pub fn raw(&self, tab: TabId) -> anyhow::Result<Arc<dyn TabDriver>> {
        self.entry(tab).map(|e| e.raw)
    }

    pub fn tab_ids(&self) -> Vec<TabId> {
        self.inner.lock().unwrap().tabs.keys().copied().collect()
    }

    fn entry(&self, tab: TabId) -> anyhow::Result<Entry> {
        self.inner.lock().unwrap().tabs.get(&tab).cloned().ok_or_else(|| anyhow!("Tab {tab} is not open"))
    }
}

impl Drop for HarnessBrowser {
    fn drop(&mut self) {
        self.pump.abort();
    }
}

async fn adopt(driver: &Arc<dyn BrowserDriver>, inner: &Arc<Mutex<Inner>>, target: TargetId, opener: TargetId) {
    let (opener_tab, options) = {
        let inner = inner.lock().unwrap();
        if inner.tabs.values().any(|e| e.target == target) {
            return;
        }
        let Some((tab, entry)) = inner.tabs.iter().find(|(_, e)| e.target == opener) else { return };
        (*tab, entry.options.clone())
    };
    let Ok(Ok(raw)) = tokio::time::timeout(Duration::from_secs(10), driver.attach(&target)).await else { return };
    let mut inner = inner.lock().unwrap();
    let tab = inner.next;
    inner.next += 1;
    let guarded = guard(raw.clone(), &options);
    inner.tabs.insert(tab, Entry { target, raw, guarded, state: Arc::default(), options, opener: Some(opener_tab) });
}

async fn main_url(driver: &Arc<dyn TabDriver>) -> String {
    match tokio::time::timeout(Duration::from_secs(2), driver.frames()).await {
        Ok(Ok(frames)) => frames.first().map(|f| f.url.clone()).unwrap_or_default(),
        _ => String::new(),
    }
}

#[async_trait]
impl Browser for HarnessBrowser {
    async fn open_tab(&self, url: Option<&str>, options: &TabOptions) -> anyhow::Result<TabInfo> {
        let url = url.map(str::trim).filter(|u| !u.is_empty() && *u != "about:blank");
        if let (Some(url), Some(allowed)) = (url, &options.allowed_origins)
            && !origin_allowed(allowed, url)
        {
            bail!("browse blocked opening {url}: it is outside this tab's allowedOrigins");
        }
        let target = self.driver.open(None, options).await.map_err(|error| anyhow!("Couldn't open a tab: {error}"))?;
        let raw = match self.driver.attach(&target).await {
            Ok(raw) => raw,
            Err(error) => {
                let _ = self.driver.close(&target).await;
                bail!("Couldn't attach to the new tab: {error}");
            }
        };
        let entry = Entry {
            target,
            raw: raw.clone(),
            guarded: guard(raw.clone(), options),
            state: Arc::default(),
            options: options.clone(),
            opener: None,
        };
        let tab = {
            let mut inner = self.inner.lock().unwrap();
            let tab = inner.next;
            inner.next += 1;
            inner.tabs.insert(tab, entry.clone());
            tab
        };
        if let Some(url) = url {
            let mut events = raw.events();
            match tokio::time::timeout(Duration::from_secs(30), raw.navigate(url, None)).await {
                Ok(Ok(_)) => {}
                Ok(Err(error)) => bail!("Opened tab {tab}, but navigating it failed: {error}"),
                Err(_) => bail!("Opened tab {tab}, but the browser didn't start loading it within 30 s"),
            }
            let _ = tokio::time::timeout(Duration::from_secs(10), async {
                loop {
                    match events.recv().await {
                        Ok(PageEvent::Loaded { state: LoadState::Load, .. }) | Ok(PageEvent::Closed(_)) => break,
                        Err(broadcast::error::RecvError::Closed) => break,
                        _ => {}
                    }
                }
            })
            .await;
        }
        let url = main_url(&raw).await;
        Ok(info(tab, &entry, url))
    }

    async fn tabs(&self) -> anyhow::Result<Vec<TabInfo>> {
        let entries: Vec<(TabId, Entry)> = self.inner.lock().unwrap().tabs.iter().map(|(t, e)| (*t, e.clone())).collect();
        let mut out = Vec::new();
        for (tab, entry) in entries {
            let url = main_url(&entry.raw).await;
            out.push(info(tab, &entry, url));
        }
        Ok(out)
    }

    async fn close_tab(&self, tab: TabId) -> anyhow::Result<()> {
        let entry = self.inner.lock().unwrap().tabs.remove(&tab).ok_or_else(|| anyhow!("Tab {tab} is not open"))?;
        self.driver.close(&entry.target).await.map_err(|error| anyhow!("Couldn't close tab {tab}: {error}"))
    }

    async fn tab_driver(&self, tab: TabId) -> anyhow::Result<Arc<dyn TabDriver>> {
        self.entry(tab).map(|e| e.guarded)
    }

    async fn state(&self, tab: TabId) -> anyhow::Result<Arc<TabState>> {
        self.entry(tab).map(|e| e.state)
    }

    async fn handoff(&self, tab: TabId, _message: &str) -> anyhow::Result<HandoffResult> {
        bail!("tab {tab}: the conformance sweep has nobody to hand off to")
    }

    async fn human_input(&self, _tab: TabId) -> bool {
        false
    }

    async fn connected_locally(&self, _tab: TabId) -> bool {
        true
    }

    async fn read_only(&self, tab: TabId) -> bool {
        self.entry(tab).map(|e| e.options.read_only).unwrap_or(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allowlists_match_hosts_and_origins() {
        let allowed = vec!["127.0.0.1".to_string(), "http://localhost:9".to_string()];
        assert!(origin_allowed(&allowed, "http://127.0.0.1:5/x"));
        assert!(origin_allowed(&allowed, "http://localhost:9/"));
        assert!(!origin_allowed(&allowed, "http://localhost:10/"));
        assert!(!origin_allowed(&allowed, "data:text/html,x"));
        assert!(origin_allowed(&allowed, "about:blank"));
    }
}
