//! Small page helpers over raw CDP: viewport metrics and evaluating browse's own scripts in an isolated world, so the
//! page never sees them (no Runtime.enable, no globals, no sourceURL markers).

use std::collections::HashMap;

use browse_core::{Cdp, TabId};
use serde_json::{Value, json};

use crate::bail_user;

/// Execution context ids of browse-capture's isolated worlds, by tab and main frame id.
#[derive(Default)]
pub(crate) struct Worlds(HashMap<(TabId, String), i64>);

#[derive(Debug, Clone, Copy)]
pub(crate) struct Viewport {
    /// Scroll offset of the visual viewport in CSS pixels (page coordinates of its top-left corner).
    pub page_x: f64,
    pub page_y: f64,
    pub width: f64,
    pub height: f64,
    /// Full document size in CSS pixels.
    pub content_width: f64,
    pub content_height: f64,
    /// Device pixels per CSS pixel; screenshots are scaled by its inverse so their pixels match click coordinates.
    pub device_pixel_ratio: f64,
}

pub(crate) async fn viewport(cdp: &dyn Cdp) -> anyhow::Result<Viewport> {
    let metrics = cdp.send("Page.getLayoutMetrics", json!({}), None).await?;
    let css = metrics.get("cssVisualViewport").or_else(|| metrics.get("visualViewport"));
    let number = |value: Option<&Value>, key: &str| value.and_then(|v| v.get(key)).and_then(Value::as_f64);
    let width = number(css, "clientWidth").unwrap_or(1280.0);
    let height = number(css, "clientHeight").unwrap_or(720.0);
    let content = metrics.get("cssContentSize").or_else(|| metrics.get("contentSize"));
    // visualViewport is in device pixels in current Chrome, cssVisualViewport in CSS pixels.
    let device_width = number(metrics.get("visualViewport"), "clientWidth");
    let zoom = number(css, "zoom").unwrap_or(1.0);
    let device_pixel_ratio = match (device_width, metrics.get("cssVisualViewport")) {
        (Some(device), Some(_)) if width > 0.0 => (device / width / zoom.max(f64::EPSILON)).max(0.1),
        _ => 1.0,
    };
    Ok(Viewport {
        page_x: number(css, "pageX").unwrap_or(0.0),
        page_y: number(css, "pageY").unwrap_or(0.0),
        width,
        height,
        content_width: number(content, "width").unwrap_or(width),
        content_height: number(content, "height").unwrap_or(height),
        device_pixel_ratio: (device_pixel_ratio * 1000.0).round() / 1000.0,
    })
}

async fn main_frame_id(cdp: &dyn Cdp) -> anyhow::Result<String> {
    let tree = cdp.send("Page.getFrameTree", json!({}), None).await?;
    tree.pointer("/frameTree/frame/id")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| anyhow::anyhow!("the page has no main frame"))
}

async fn world(cdp: &dyn Cdp, worlds: &mut Worlds, tab: TabId, fresh: bool) -> anyhow::Result<i64> {
    let frame = main_frame_id(cdp).await?;
    let key = (tab, frame.clone());
    if !fresh
        && let Some(id) = worlds.0.get(&key) {
            return Ok(*id);
        }
    let created = cdp
        .send("Page.createIsolatedWorld", json!({ "frameId": frame, "worldName": "", "grantUniveralAccess": false }), None)
        .await?;
    let id = created
        .get("executionContextId")
        .and_then(Value::as_i64)
        .ok_or_else(|| anyhow::anyhow!("Page.createIsolatedWorld returned no context"))?;
    worlds.0.retain(|(other, _), _| *other != tab);
    worlds.0.insert(key, id);
    Ok(id)
}

/// Evaluates `expression` in browse-capture's isolated world of the tab's main frame and returns its JSON value.
pub(crate) async fn evaluate(cdp: &dyn Cdp, worlds: &mut Worlds, tab: TabId, expression: &str) -> anyhow::Result<Value> {
    let mut fresh = false;
    loop {
        let context = world(cdp, worlds, tab, fresh).await?;
        let result = cdp
            .send(
                "Runtime.evaluate",
                json!({ "expression": expression, "contextId": context, "returnByValue": true, "awaitPromise": true }),
                None,
            )
            .await;
        match result {
            Ok(value) => {
                if let Some(details) = value.get("exceptionDetails") {
                    let text = details
                        .pointer("/exception/description")
                        .and_then(Value::as_str)
                        .or_else(|| details.get("text").and_then(Value::as_str))
                        .unwrap_or("script failed");
                    bail_user!("{text}");
                }
                return Ok(value.pointer("/result/value").cloned().unwrap_or(Value::Null));
            }
            // The world went away with a navigation: make a new one once.
            Err(browse_core::CdpError::Protocol(message)) if !fresh && message.contains("context") => fresh = true,
            Err(error) => return Err(error.into()),
        }
    }
}
