//! Actionability and pointer targeting: wait for the element to be visible, enabled and stable, scroll it into
//! view, pick a point in it, translate that point through iframes to the page, and check that the element (not an
//! overlay) would receive the input there.

use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Result, anyhow, bail};
use serde_json::{Value, json};

use crate::human::{self, Point};
use crate::input::Input;
use crate::page::{Element, TabPage, v};
use crate::state::PageSession;
use crate::target::{self, Resolved, ResolveOptions, Spec};

const RETRY: Duration = Duration::from_millis(100);
/// Covered-element checks retried before failing: enough for a fading toast or a layout shift, not for a modal.
const HIT_RETRIES: usize = 3;

#[derive(Clone, Copy)]
pub struct PointerOptions {
    pub timeout: Duration,
    pub force: bool,
    /// Offset from the element's top-left corner, in CSS pixels.
    pub position: Option<Point>,
    pub hit_test: bool,
    pub enabled: bool,
}

enum Prepare {
    Detached,
    Failed(anyhow::Error),
}

impl From<anyhow::Error> for Prepare {
    fn from(error: anyhow::Error) -> Self {
        let message = error.to_string();
        if message.contains("document changed") || message.contains("Could not find object") || message.contains("navigated or re-rendered") {
            Prepare::Detached
        } else {
            Prepare::Failed(error)
        }
    }
}

/// Resolves the target and returns it with the page point to send input to.
pub async fn locate(page: &Arc<TabPage>, session: &PageSession, input: &mut Input<'_>, spec: &Spec, options: PointerOptions) -> Result<(Resolved, Point)> {
    let deadline = Instant::now() + options.timeout;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now()).max(Duration::from_millis(100));
        let resolved = target::resolve(page, session, spec, ResolveOptions { timeout: remaining, act: true }).await?;
        match prepare(page, input, &resolved, deadline, options).await {
            Ok(point) => return Ok((resolved, point)),
            Err(Prepare::Detached) if Instant::now() < deadline => {
                tokio::time::sleep(RETRY).await;
                continue;
            }
            Err(Prepare::Detached) => bail!("{} kept re-rendering or detaching from the page; take a new snapshot and retry", describe(&resolved, spec)),
            Err(Prepare::Failed(error)) => return Err(error),
        }
    }
}

fn describe(resolved: &Resolved, spec: &Spec) -> String {
    if resolved.label.is_empty() { spec.label() } else { format!("{} ({})", resolved.label, spec.label()) }
}

async fn prepare(page: &Arc<TabPage>, input: &mut Input<'_>, resolved: &Resolved, deadline: Instant, options: PointerOptions) -> std::result::Result<Point, Prepare> {
    let element = &resolved.element;
    let name = if resolved.label.is_empty() { "the element".to_string() } else { resolved.label.clone() };
    if !options.force {
        let states: Vec<&str> = if options.enabled { vec!["visible", "enabled", "stable"] } else { vec!["visible", "stable"] };
        loop {
            let state = page.call_element(element, "checkStates", vec![v(&states)], true).await?;
            match state.as_str().unwrap_or("ok") {
                "ok" => break,
                "notconnected" => return Err(Prepare::Detached),
                missing => {
                    if Instant::now() >= deadline {
                        let reason = match missing {
                            "visible" => "is not visible",
                            "enabled" => "is disabled",
                            "editable" => "is not editable",
                            "stable" => "keeps moving (it is animating)",
                            other => other,
                        };
                        return Err(Prepare::Failed(anyhow!("{name} {reason}; waited {} ms", options.timeout.as_millis())));
                    }
                    tokio::time::sleep(RETRY).await;
                }
            }
        }
    }
    scroll_into_view(page, input, element).await?;
    let mut hit_attempts = 0;
    loop {
        let point = page.call_element(element, "clickPoint", vec![v(options.position.map(|p| json!({ "x": p.x, "y": p.y })))], true).await?;
        if point.is_null() {
            if Instant::now() >= deadline || options.force {
                return Err(Prepare::Failed(anyhow!("{name} has no visible box to click")));
            }
            tokio::time::sleep(RETRY).await;
            scroll_into_view(page, input, element).await?;
            continue;
        }
        let local = Point { x: point["x"].as_f64().unwrap_or(0.0), y: point["y"].as_f64().unwrap_or(0.0) };
        if !point["inViewport"].as_bool().unwrap_or(true) {
            let _ = page.call_element(element, "scrollIntoView", vec![], true).await;
        }
        let (page_point, chain) = to_page(page, element, local).await?;
        if !options.hit_test || options.force {
            return Ok(page_point);
        }
        match hit_test(page, element, local, &chain).await? {
            None => return Ok(page_point),
            Some(cover) => {
                hit_attempts += 1;
                if hit_attempts >= HIT_RETRIES || Instant::now() >= deadline {
                    return Err(Prepare::Failed(anyhow!(
                        "Can't reach {name}: {cover} is on top of it at ({:.0}, {:.0}). Close or dismiss what covers it (for example press Escape, or click its close button), scroll, or pass force: true to send the input anyway.",
                        page_point.x,
                        page_point.y
                    )));
                }
                tokio::time::sleep(Duration::from_millis(150)).await;
            }
        }
    }
}

/// The iframe owners between an element's frame and the page, innermost first, with each frame's offset in its parent.
async fn to_page(page: &Arc<TabPage>, element: &Element, local: Point) -> Result<(Point, Vec<(Element, Point)>)> {
    let main = page.main_frame();
    let mut chain = Vec::new();
    let mut frame = element.frame.clone();
    let mut point = local;
    while frame != main {
        let owner = page.frame_owner(&frame).await?;
        let offset = page.call_element(&owner, "frameOffset", vec![], false).await?;
        let offset = Point { x: offset["x"].as_f64().unwrap_or(0.0), y: offset["y"].as_f64().unwrap_or(0.0) };
        point = Point { x: point.x + offset.x, y: point.y + offset.y };
        frame = owner.frame.clone();
        chain.push((owner, point));
        if chain.len() > 16 {
            bail!("iframes nested too deeply");
        }
    }
    Ok((point, chain))
}

async fn hit_test(page: &Arc<TabPage>, element: &Element, local: Point, chain: &[(Element, Point)]) -> Result<Option<String>> {
    let result = page.call_element(element, "hitTest", vec![v(local.x), v(local.y)], true).await?;
    match result.as_str() {
        Some("done") => {}
        Some("notconnected") => bail!("The element's document changed while checking it"),
        Some(cover) => return Ok(Some(cover.to_string())),
        None => {}
    }
    // An overlay in a parent document can cover the whole iframe.
    for (owner, point) in chain {
        let result = page.call_element(owner, "hitTest", vec![v(point.x), v(point.y)], true).await?;
        if let Some(cover) = result.as_str().filter(|r| *r != "done" && *r != "notconnected") {
            return Ok(Some(cover.to_string()));
        }
    }
    Ok(None)
}

/// Scrolls an element into view; with human input, the page first scrolls toward it in wheel flicks.
pub async fn scroll_into_view(page: &Arc<TabPage>, input: &mut Input<'_>, element: &Element) -> Result<()> {
    if input.human() && element.frame == page.main_frame() {
        human_scroll(page, input, element).await?;
    }
    let scrolled = page.send("DOM.scrollIntoViewIfNeeded", json!({ "objectId": element.object_id }), element.session.as_deref()).await;
    if scrolled.is_err() {
        page.call_element(element, "scrollIntoView", vec![], false).await?;
    }
    Ok(())
}

async fn human_scroll(page: &Arc<TabPage>, input: &mut Input<'_>, element: &Element) -> Result<()> {
    let viewport = page.call_value(&element.frame, "viewport", vec![], false).await?;
    let (width, height) = (viewport["width"].as_f64().unwrap_or(0.0), viewport["height"].as_f64().unwrap_or(0.0));
    if width <= 0.0 || height <= 0.0 {
        return Ok(());
    }
    let goal = height * human::random(0.35, 0.5);
    let measure = || async {
        let rect = page.call_element(element, "rect", vec![], false).await.ok()?;
        let top = rect["y"].as_f64()?;
        let bottom = top + rect["height"].as_f64()?;
        Some(((top + bottom) / 2.0 - goal, top >= 0.0 && bottom <= height))
    };
    let Some(mut at) = measure().await else { return Ok(()) };
    if at.1 {
        return Ok(());
    }
    let pointer = match input.pointer() {
        Some(pointer) => pointer,
        None => {
            let rest = Point { x: width * human::random(0.35, 0.65), y: height * human::random(0.35, 0.65) };
            input.move_to(rest, 1).await?
        }
    };
    for _ in 0..12 {
        if at.0.abs() <= 2.0 {
            break;
        }
        let amount = at.0.signum() * at.0.abs().min(human::random(450.0, 900.0));
        input.wheel(pointer, 0.0, amount).await?;
        let Some(next) = measure().await else { break };
        if (next.0 - at.0).abs() < 1.0 {
            break;
        }
        at = next;
        if at.1 || at.0.abs() <= 2.0 {
            break;
        }
        human::sleep_ms(human::random(90.0, 240.0)).await;
    }
    Ok(())
}

/// Presses modifier keys for the duration of a pointer action.
pub async fn with_modifiers(input: &mut Input<'_>, modifiers: &[String]) -> Result<Vec<crate::input::KeyDef>> {
    let mut held = Vec::new();
    for name in modifiers {
        let name = match name.as_str() {
            "ControlOrMeta" => if input.mac() { "Meta" } else { "Control" },
            other => other,
        };
        let def = crate::input::key_definition(name).filter(|_| crate::input::modifier_bit(name) != 0).ok_or_else(|| anyhow!("Unknown modifier {name:?}; use Shift, Control, Alt, Meta or ControlOrMeta"))?;
        input.key_down(&def).await?;
        held.push(def);
    }
    Ok(held)
}

pub async fn release_modifiers(input: &mut Input<'_>, held: &[crate::input::KeyDef]) -> Result<()> {
    for def in held.iter().rev() {
        input.key_up(def).await?;
    }
    Ok(())
}

/// Waits until the element is visible, enabled and editable.
pub async fn wait_editable(page: &Arc<TabPage>, resolved: &Resolved, timeout: Duration, force: bool) -> Result<()> {
    if force {
        return Ok(());
    }
    let deadline = Instant::now() + timeout;
    loop {
        let state = page.call_element(&resolved.element, "checkStates", vec![v(["visible", "enabled", "editable"])], true).await?;
        match state.as_str().unwrap_or("ok") {
            "ok" => return Ok(()),
            "notconnected" => bail!("{} was removed from the page; take a new snapshot", resolved.label),
            missing => {
                if Instant::now() >= deadline {
                    let reason = match missing {
                        "visible" => "is not visible",
                        "enabled" => "is disabled",
                        "editable" => "is read-only",
                        other => other,
                    };
                    bail!("{} {reason}; waited {} ms", if resolved.label.is_empty() { "the field" } else { &resolved.label }, timeout.as_millis());
                }
                tokio::time::sleep(RETRY).await;
            }
        }
    }
}

pub fn point_arg(args: &Value) -> Option<Point> {
    Some(Point { x: args.get("x")?.as_f64()?, y: args.get("y")?.as_f64()? })
}
