//! Page interaction over CDP for browse: frames and out-of-process iframes, browse's isolated world per frame with
//! Playwright's InjectedScript, snapshot refs, actionability, human-like input, navigation, dialogs, uploads,
//! emulation, challenge detection and WebMCP. No `Runtime.enable`, no page-visible globals, bindings or sourceURLs.
//!
//! What the `Cdp` of a tab must do for this crate:
//! - Return the same `Arc` from `Browser::cdp` for a tab while its debugger attachment lives (the page model, its
//!   isolated worlds and dialog state hang off it; a different `Arc` rebuilds them), and close the event stream when
//!   the attachment ends.
//! - Pass `Target.setAutoAttach { flatten: true }` through and deliver `Target.attachedToTarget` for out-of-process
//!   iframes, then accept commands on and deliver events from those child sessions (`session_id` set).
//! - Deliver `Page.*` events (`Page.enable` is sent by this crate), including `Page.javascriptDialogOpening`.
//! - Refuse disallowed navigations (`Page.navigate`) with a readable error; this crate shows it as is.

mod actions;
mod aftermath;
pub mod challenge;
mod eval;
mod files;
pub mod human;
pub mod input;
mod navigation;
pub mod page;
mod scripts;
pub mod snapshot;
pub mod state;
pub mod target;
mod tools;

pub use page::{Element, TabPage};
pub use tools::tools;

use std::sync::Arc;
use std::time::Duration;

use browse_core::{TabId, ToolContext};

/// For other crates (screenshots with ref labels, element screenshots): the tab page and an element for a snapshot
/// ref (of the tab's latest snapshot) or selector, resolved exactly as the page tools resolve it.
pub async fn resolve_element(ctx: &ToolContext, tab: TabId, reference: Option<&str>, selector: Option<&str>, timeout: Duration) -> anyhow::Result<(Arc<TabPage>, Element, String)> {
    let tab_state = state::tab(ctx, tab).await?;
    let page = tab_state.page(ctx).await?;
    let spec = match (reference, selector) {
        (Some(r), _) => target::Spec::Ref(r.to_string()),
        (None, Some(s)) => target::Spec::Selector(s.to_string()),
        (None, None) => anyhow::bail!("pass a ref or a selector"),
    };
    let resolved = target::resolve(&page, &tab_state, &spec, target::ResolveOptions { timeout, act: false }).await?;
    Ok((page, resolved.element, resolved.label))
}

/// The refs of the tab's latest compact snapshot: id, role and accessible name.
pub async fn snapshot_refs(ctx: &ToolContext, tab: TabId) -> anyhow::Result<Vec<(String, String, Option<String>)>> {
    let tab_state = state::tab(ctx, tab).await?;
    let refs = tab_state.refs.lock().unwrap();
    let mut list: Vec<(String, String, Option<String>)> = refs.selectors.iter().map(|(id, t)| (id.clone(), t.role.clone(), t.name.clone())).collect();
    list.sort_by_key(|(id, _, _)| id.trim_start_matches('e').parse::<u64>().unwrap_or(0));
    Ok(list)
}
