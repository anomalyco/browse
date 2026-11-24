//! `screenshot` and `screenshot_diff`: Page.captureScreenshot with the device pixel ratio normalised away, so by default
//! one image pixel is one CSS pixel and coordinates in the image are the coordinates clicks use.

use async_trait::async_trait;
use base64::Engine;
use browse_core::{Cdp, Content, TabId, Tool, ToolContext, ToolOutput, ToolSpec};
use serde_json::{Value, json};

use crate::page;
use crate::pixeldiff::{self, decode_png, encode_png};
use std::sync::Arc;
use std::time::Duration;

use browse_page::{Element, TabPage};

use crate::{arg_bool, arg_f64, arg_int, arg_str, bail_user, files, labels, respond, state, tab_schema, target_tab};

#[derive(Clone, Copy, PartialEq)]
enum Format {
    Png,
    Jpeg,
    Webp,
}

impl Format {
    fn name(self) -> &'static str {
        match self {
            Format::Png => "png",
            Format::Jpeg => "jpeg",
            Format::Webp => "webp",
        }
    }
    fn mime(self) -> &'static str {
        match self {
            Format::Png => "image/png",
            Format::Jpeg => "image/jpeg",
            Format::Webp => "image/webp",
        }
    }
}

enum Region {
    Viewport,
    FullPage,
    /// Viewport CSS pixels.
    Clip(f64, f64, f64, f64),
    /// A snapshot ref or a selector, resolved like the page tools resolve them.
    Element { reference: Option<String>, selector: Option<String> },
}

struct Shot {
    bytes: Vec<u8>,
    format: Format,
    /// Actual image size in pixels.
    width: u32,
    height: u32,
    /// Image pixels per CSS pixel.
    scale: f64,
    /// Why the image differs from what was asked (scaled down, returned as PNG).
    note: Option<String>,
}

/// Longest side of an image returned inline; larger captures are scaled down (saving to a path allows more).
const MAX_INLINE_SIDE: f64 = 8_000.0;
/// Longest side of a saved image; Chrome can't capture larger surfaces.
const MAX_SAVED_SIDE: f64 = 16_384.0;
/// Height in image pixels of each tile when a large capture has to be taken in pieces.
const TILE_SIDE: f64 = 4_096.0;

/// Width and height of a PNG, JPEG or WebP image.
pub(crate) fn image_size(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") && bytes.len() >= 24 {
        return Some((u32::from_be_bytes(bytes[16..20].try_into().ok()?), u32::from_be_bytes(bytes[20..24].try_into().ok()?)));
    }
    if bytes.starts_with(&[0xFF, 0xD8]) {
        return crate::mkv::jpeg_size(bytes);
    }
    if bytes.len() >= 30 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        let le24 = |at: usize| u32::from(bytes[at]) | u32::from(bytes[at + 1]) << 8 | u32::from(bytes[at + 2]) << 16;
        return match &bytes[12..16] {
            b"VP8 " => Some((
                u32::from(u16::from_le_bytes([bytes[26], bytes[27]]) & 0x3FFF),
                u32::from(u16::from_le_bytes([bytes[28], bytes[29]]) & 0x3FFF),
            )),
            b"VP8L" => {
                let bits = u32::from_le_bytes(bytes[21..25].try_into().ok()?);
                Some(((bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1))
            }
            b"VP8X" => Some((le24(24) + 1, le24(27) + 1)),
            _ => None,
        };
    }
    None
}

fn region(args: &Value) -> anyhow::Result<Region> {
    let full_page = arg_bool(args, "fullPage")?.unwrap_or(false);
    let reference = arg_str(args, "ref")?;
    let selector = arg_str(args, "selector")?;
    let clip = match args.get("clip") {
        None | Some(Value::Null) => None,
        Some(clip) => {
            let field = |name: &str| clip.get(name).and_then(Value::as_f64);
            match (field("x"), field("y"), field("width"), field("height")) {
                (Some(x), Some(y), Some(w), Some(h)) if w > 0.0 && h > 0.0 => Some((x, y, w, h)),
                _ => bail_user!("clip needs numeric x, y and positive width and height"),
            }
        }
    };
    let element = reference.is_some() || selector.is_some();
    match (full_page, element, clip) {
        (false, false, None) => Ok(Region::Viewport),
        (true, false, None) => Ok(Region::FullPage),
        (false, true, None) if reference.is_some() && selector.is_some() => bail_user!("use either ref or selector, not both"),
        (false, true, None) => {
            Ok(Region::Element { reference: reference.map(str::to_string), selector: selector.map(str::to_string) })
        }
        (false, false, Some((x, y, w, h))) => Ok(Region::Clip(x, y, w, h)),
        _ => bail_user!("use only one of fullPage, ref/selector and clip"),
    }
}

/// The element's box in main-frame viewport CSS pixels, through any iframes, the way the page tools compute points.
async fn element_rect(page: &Arc<TabPage>, element: &Element) -> anyhow::Result<(f64, f64, f64, f64)> {
    let main = page.main_frame();
    if element.frame != main {
        // Inside an iframe only what its own viewport shows is painted.
        let _ = page.call_element(element, "scrollIntoView", vec![], true).await;
    }
    let rect = page
        .send(
            "Runtime.callFunctionOn",
            json!({
                "functionDeclaration": "function () { const r = this.getBoundingClientRect(); return [r.left, r.top, r.width, r.height] }",
                "objectId": element.object_id,
                "returnByValue": true,
            }),
            element.session.as_deref(),
        )
        .await?;
    let rect: Vec<f64> = serde_json::from_value(rect.pointer("/result/value").cloned().unwrap_or_default()).unwrap_or_default();
    let [mut x, mut y, width, height] = rect[..] else { bail_user!("the element has no box") };
    if width <= 0.0 || height <= 0.0 {
        bail_user!("the element has no visible size");
    }
    let mut frame = element.frame.clone();
    let mut depth = 0;
    while frame != main {
        let owner = page.frame_owner(&frame).await?;
        let offset = page.call_element(&owner, "frameOffset", vec![], false).await?;
        x += offset["x"].as_f64().unwrap_or(0.0);
        y += offset["y"].as_f64().unwrap_or(0.0);
        frame = owner.frame.clone();
        depth += 1;
        if depth > 16 {
            bail_user!("iframes nested too deeply");
        }
    }
    Ok((x, y, width, height))
}

fn outside(viewport: &page::Viewport, (x, y, width, height): (f64, f64, f64, f64)) -> bool {
    const SLACK: f64 = 0.5;
    x < -SLACK || y < -SLACK || x + width > viewport.width + SLACK || y + height > viewport.height + SLACK
}

/// Whole-pixel clip bounds, rounded rather than snapped outward so a clip's size doesn't depend on where a fractional
/// scroll puts the page: some Chromium builds (Dia) refuse fractional clip coordinates with "Unable to encode
/// screenshot".
fn whole_clip((x, y, width, height): (f64, f64, f64, f64)) -> (f64, f64, f64, f64) {
    (x.round(), y.round(), width.round().max(1.0), height.round().max(1.0))
}

/// Keeps a whole-pixel clip inside the rounded viewport, in page coordinates, moving it rather than shrinking it where
/// possible. A clip that doesn't reach beyond the viewport is captured with captureBeyondViewport off, so an overhang
/// would come back unpainted.
fn clamp_clip((x, y, width, height): (f64, f64, f64, f64), (vx, vy, vw, vh): (f64, f64, f64, f64)) -> (f64, f64, f64, f64) {
    let (width, height) = (width.min(vw), height.min(vh));
    let left = x.clamp(vx, vx + vw - width);
    let top = y.clamp(vy, vy + vh - height);
    (left, top, width, height)
}

/// The tab and CDP connection a capture uses; element regions are resolved here into viewport clips. An element
/// outside the viewport that would fit is scrolled into view first, so capturing it doesn't resize the page.
async fn resolve(ctx: &ToolContext, args: &Value, region: Region) -> anyhow::Result<(TabId, Arc<dyn Cdp>, Region)> {
    match region {
        Region::Element { reference, selector } => {
            let timeout = Duration::from_millis(arg_int(args, "timeoutMs", 0, 60_000)?.unwrap_or(5_000) as u64);
            let (page, element, _) =
                browse_page::resolve_element(ctx, target_tab(args)?, reference.as_deref(), selector.as_deref(), timeout).await?;
            let mut rect = element_rect(&page, &element).await?;
            let viewport = page::viewport(page.cdp().as_ref()).await?;
            if outside(&viewport, rect) && rect.2 <= viewport.width && rect.3 <= viewport.height {
                let scrolled = page
                    .send("DOM.scrollIntoViewIfNeeded", json!({ "objectId": element.object_id }), element.session.as_deref())
                    .await;
                if scrolled.is_ok() {
                    rect = element_rect(&page, &element).await?;
                }
            }
            let (x, y, w, h) = rect;
            Ok((page.tab(), page.cdp().clone(), Region::Clip(x, y, w, h)))
        }
        region => {
            let tab = target_tab(args)?;
            Ok((tab, ctx.browser.cdp(tab).await?, region))
        }
    }
}

fn decode(result: &Value) -> anyhow::Result<Vec<u8>> {
    let data = result.get("data").and_then(Value::as_str).ok_or_else(|| anyhow::anyhow!("Chrome returned no image"))?;
    Ok(base64::engine::general_purpose::STANDARD.decode(data)?)
}

/// Captures `region`. Clips inside the viewport are taken as they are on screen; only full pages and clips that reach
/// beyond the viewport use captureBeyondViewport, which makes Chrome resize the page while it captures (pages see
/// resize events), as Playwright does. Captures whose longest side would exceed `max_side` image pixels are scaled
/// down; ones Chrome can't take in one piece are taken in tiles and returned as PNG. Chrome restores any device
/// metrics override (from emulate) itself afterwards, so nothing is re-applied here.
async fn capture(
    cdp: &dyn Cdp,
    region: &Region,
    format: Format,
    quality: Option<i64>,
    css_scale: bool,
    max_side: f64,
) -> anyhow::Result<Shot> {
    let viewport = page::viewport(cdp).await?;
    let dpr = viewport.device_pixel_ratio;
    let mut clip_scale = if css_scale { 1.0 / dpr } else { 1.0 };
    // The viewport's own clip keeps its size, so screenshot_diff baselines of the same viewport still match.
    let viewport_rect = (viewport.page_x.round(), viewport.page_y.round(), viewport.width.round(), viewport.height.round());
    let (x, y, width, height, beyond) = match region {
        Region::Viewport => (viewport_rect.0, viewport_rect.1, viewport_rect.2, viewport_rect.3, false),
        Region::FullPage => {
            let (width, height) = (viewport.content_width.max(1.0), viewport.content_height.max(1.0));
            (0.0, 0.0, width, height, outside(&viewport, (-viewport.page_x, -viewport.page_y, width, height)))
        }
        Region::Clip(x, y, w, h) => (viewport.page_x + x, viewport.page_y + y, *w, *h, outside(&viewport, (*x, *y, *w, *h))),
        Region::Element { .. } => bail_user!("resolve the element first"),
    };
    let (x, y, width, height) = whole_clip((x, y, width, height));
    let (x, y, width, height) = if beyond {
        (x, y, width, height)
    } else {
        if viewport_rect.2 < 1.0 || viewport_rect.3 < 1.0 {
            bail_user!("the tab has no visible area to capture");
        }
        clamp_clip((x, y, width, height), viewport_rect)
    };
    let mut note = None;
    let longest = width.max(height) * clip_scale * dpr;
    if longest > max_side {
        let factor = max_side / longest;
        clip_scale *= factor;
        note = Some(format!(
            "scaled down to {:.0}% to fit {max_side} px per side (the full capture would be {:.0}×{:.0} px); capture a clip or element for full detail{}",
            factor * 100.0,
            width * clip_scale / factor * dpr,
            height * clip_scale / factor * dpr,
            if max_side < MAX_SAVED_SIDE { ", or save to a path for up to 16384 px" } else { "" },
        ));
    }
    let mut params = json!({
        "format": format.name(),
        "clip": { "x": x, "y": y, "width": width, "height": height, "scale": clip_scale },
        "captureBeyondViewport": beyond,
        "fromSurface": true,
    });
    if format != Format::Png {
        params["quality"] = json!(quality.unwrap_or(80));
    }
    let result = cdp.send("Page.captureScreenshot", params, None).await;
    let (bytes, format) = match result {
        Ok(result) => (decode(&result)?, format),
        Err(browse_core::CdpError::Protocol(message)) if beyond && message.contains("Unable to capture screenshot") => {
            let stitched = tiles(cdp, (x, y, width, height), clip_scale).await.map_err(|error| {
                anyhow::Error::new(crate::UserError(format!(
                    "Chrome couldn't capture this {:.0}×{:.0} px screenshot ({message}; in tiles: {error:#}). Capture a clip or an element instead.",
                    width * clip_scale * dpr,
                    height * clip_scale * dpr
                )))
            })?;
            if format != Format::Png {
                let text = format!("taken in tiles and returned as PNG (asked for {})", format.name());
                note = Some(note.map_or(text.clone(), |note| format!("{note}; {text}")));
            }
            (stitched, Format::Png)
        }
        Err(error) => return Err(error.into()),
    };
    let (image_width, image_height) = image_size(&bytes).ok_or_else(|| anyhow::anyhow!("Chrome returned an unreadable image"))?;
    Ok(Shot { bytes, format, width: image_width, height: image_height, scale: image_width as f64 / width, note })
}

/// Captures a large area in horizontal strips and stitches them into one PNG.
async fn tiles(cdp: &dyn Cdp, (x, y, width, height): (f64, f64, f64, f64), clip_scale: f64) -> anyhow::Result<Vec<u8>> {
    let dpr = page::viewport(cdp).await?.device_pixel_ratio;
    let per_css = clip_scale * dpr;
    let total_width = (width * per_css).round() as u64;
    let total_height = (height * per_css).round() as u64;
    if total_width * total_height > pixeldiff::MAX_IMAGE_PIXELS {
        bail_user!("too large to stitch (over 16 megapixels)");
    }
    let strip = (TILE_SIDE / per_css).floor().max(1.0);
    let mut image = pixeldiff::Rgba { width: total_width as u32, height: 0, data: Vec::new() };
    let mut offset = 0.0;
    while offset < height {
        let part = strip.min(height - offset);
        let (left, top, tile_width, tile_height) = whole_clip((x, y + offset, width, part));
        let params = json!({
            "format": "png",
            "clip": { "x": left, "y": top, "width": tile_width, "height": tile_height, "scale": clip_scale },
            "captureBeyondViewport": true,
            "fromSurface": true,
        });
        let tile = decode_png(&decode(&cdp.send("Page.captureScreenshot", params, None).await?)?)?;
        if tile.width != image.width {
            bail_user!("tiles came back with different widths");
        }
        image.height += tile.height;
        image.data.extend_from_slice(&tile.data);
        offset += part;
    }
    encode_png(&image)
}

fn image_content(bytes: &[u8], mime: &str) -> Content {
    Content::Image { data: base64::engine::general_purpose::STANDARD.encode(bytes), mime_type: mime.to_string() }
}

fn round(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

pub(crate) struct ScreenshotTool;

#[async_trait]
impl Tool for ScreenshotTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "screenshot".into(),
            description: "Capture the tab as an image: the viewport (default), the full page, one element (a snapshot \
                ref, including refs inside iframes, or a selector, resolved exactly like the page tools) or a rectangle \
                (clip, viewport CSS pixels). By default image pixels are CSS pixels, so a point (x, y) in \
                a viewport screenshot is the same (x, y) mouse tools use. Returns the image, or saves it to path and \
                returns {path, width, height} (actual image pixels). Inline images are scaled down to at most 8000 px \
                per side, saved ones to 16384 px (a note says so). fullPage on a page taller or wider than the \
                viewport, and clips reaching outside it, make Chrome briefly resize the page (pages see resize \
                events); elements are scrolled into view instead when they fit. labels: true numbers the visible interactive elements on the image \
                (drawn on the PNG, nothing is added to the page) and returns [{label, role, text, context, selector, \
                rect:[x,y,w,h]}] so an element seen in the image can be targeted by selector or by its rect's center."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "tab": tab_schema(),
                    "format": { "type": "string", "enum": ["png", "jpeg", "webp"], "description": "Image format (default png; jpeg/webp are much smaller)." },
                    "quality": { "type": "integer", "minimum": 0, "maximum": 100, "description": "jpeg/webp quality (default 80)." },
                    "fullPage": { "type": "boolean", "description": "Capture the whole scrollable page instead of the viewport." },
                    "ref": { "type": "string", "description": "Snapshot ref of the element to capture (e.g. \"e12\" or an iframe ref \"f1e3\"); from the tab's latest snapshot." },
                    "selector": { "type": "string", "description": "Selector of the element to capture, as the page tools accept it." },
                    "timeoutMs": { "type": "integer", "minimum": 0, "maximum": 60000, "description": "How long to wait for the ref/selector element (default 5000)." },
                    "clip": {
                        "type": "object",
                        "description": "Rectangle to capture, in viewport CSS pixels (as from getBoundingClientRect); rounded to whole pixels.",
                        "properties": { "x": { "type": "number" }, "y": { "type": "number" }, "width": { "type": "number" }, "height": { "type": "number" } },
                        "required": ["x", "y", "width", "height"]
                    },
                    "scale": { "type": "string", "enum": ["css", "device"], "description": "css (default): one image pixel per CSS pixel. device: full device resolution (e.g. 2x on Retina)." },
                    "labels": { "type": "boolean", "description": "Number visible interactive elements on a viewport PNG and list them." },
                    "maxLabels": { "type": "integer", "minimum": 1, "maximum": 300, "description": "Most elements to label (default 80)." },
                    "path": { "type": "string", "description": "Save here instead of returning the image: absolute inside the file roots (in a private folder you own, not directly in a shared temp folder), or relative (saved in a private folder in the first root). Replaces an existing file." }
                },
                "required": ["tab"],
                "additionalProperties": false
            }),
            output_schema: None,
        }
    }

    async fn call(&self, ctx: ToolContext, args: Value) -> anyhow::Result<ToolOutput> {
        respond(
            async {
                target_tab(&args)?;
                let region = region(&args)?;
                let with_labels = arg_bool(&args, "labels")?.unwrap_or(false);
                let format = match arg_str(&args, "format")? {
                    None | Some("png") => Format::Png,
                    Some("jpeg" | "jpg") => Format::Jpeg,
                    Some("webp") => Format::Webp,
                    Some(other) => bail_user!("format must be png, jpeg or webp, not {other}"),
                };
                let quality = arg_int(&args, "quality", 0, 100)?;
                let css_scale = match arg_str(&args, "scale")? {
                    None | Some("css") => true,
                    Some("device") => false,
                    Some(other) => bail_user!("scale must be css or device, not {other}"),
                };
                if with_labels && (format != Format::Png || !matches!(region, Region::Viewport)) {
                    bail_user!("labels work on viewport PNG screenshots only");
                }
                let path = arg_str(&args, "path")?.map(|raw| files::output_path(&ctx.file_roots, raw, "screenshot path")).transpose()?;
                let (tab, cdp, region) = resolve(&ctx, &args, region).await?;
                let mut found = None;
                if with_labels {
                    let max = arg_int(&args, "maxLabels", 1, 300)?.unwrap_or(80) as u32;
                    let capture_state = state::get(&ctx, tab).await?;
                    let mut worlds = capture_state.worlds.lock().await;
                    let value = page::evaluate(cdp.as_ref(), &mut worlds, tab, &labels::script(max)).await?;
                    found = Some(serde_json::from_value::<labels::Found>(value)?.labels);
                }
                let max_side = if path.is_some() { MAX_SAVED_SIDE } else { MAX_INLINE_SIDE };
                let mut shot = capture(cdp.as_ref(), &region, format, quality, css_scale, max_side).await?;
                if let Some(found) = &found {
                    let mut image = decode_png(&shot.bytes)?;
                    labels::draw(&mut image, found, shot.scale);
                    shot.bytes = encode_png(&image)?;
                }
                let mut summary = json!({
                    "width": shot.width,
                    "height": shot.height,
                    "format": shot.format.name(),
                });
                if (shot.scale - 1.0).abs() > 0.001 {
                    summary["scale"] = json!(round(shot.scale));
                }
                let mut notes: Vec<String> = shot.note.take().into_iter().collect();
                if quality.is_some() && format == Format::Png {
                    notes.push("quality applies to jpeg and webp only; it was ignored for png".into());
                }
                if !notes.is_empty() {
                    summary["note"] = json!(notes.join("; "));
                }
                if let Some(found) = found {
                    summary["labels"] = json!(found);
                }
                match path {
                    Some(path) => {
                        files::write(&ctx.file_roots, &path, &shot.bytes, "screenshot path")?;
                        summary["path"] = json!(path);
                        summary["bytes"] = json!(shot.bytes.len());
                        crate::json_output(&summary)
                    }
                    None => Ok(ToolOutput {
                        content: vec![
                            image_content(&shot.bytes, shot.format.mime()),
                            Content::Text { text: serde_json::to_string(&summary)? },
                        ],
                        is_error: false,
                        structured_content: None,
                    }),
                }
            }
            .await,
        )
        .await
    }
}

pub(crate) struct ScreenshotDiffTool;

#[async_trait]
impl Tool for ScreenshotDiffTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "screenshot_diff".into(),
            description: "Compare a fresh PNG screenshot of the tab with a baseline PNG saved earlier by screenshot \
                (same region options and scale, since images are never resized). Returns {matches, changedPixels, \
                totalPixels, changedRatio, width, height}; when anything changed, also the diff image (changes red, \
                the rest faded gray) unless diffPath saves it. Use to check whether an action changed the page."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "baseline": { "type": "string", "description": "PNG to compare against, inside the file roots." },
                    "tab": tab_schema(),
                    "fullPage": { "type": "boolean" },
                    "ref": { "type": "string", "description": "Snapshot ref of the element to compare." },
                    "selector": { "type": "string", "description": "Selector of the element to compare." },
                    "timeoutMs": { "type": "integer", "minimum": 0, "maximum": 60000 },
                    "clip": {
                        "type": "object",
                        "description": "Rectangle to compare, in viewport CSS pixels; rounded to whole pixels.",
                        "properties": { "x": { "type": "number" }, "y": { "type": "number" }, "width": { "type": "number" }, "height": { "type": "number" } },
                        "required": ["x", "y", "width", "height"]
                    },
                    "scale": { "type": "string", "enum": ["css", "device"], "description": "Must match how the baseline was taken (default css)." },
                    "threshold": { "type": "number", "minimum": 0, "maximum": 1, "description": "Per-pixel color tolerance (default 0.1); not an allowance for changed area." },
                    "diffPath": { "type": "string", "description": "Save the diff PNG here instead of returning it." },
                    "currentPath": { "type": "string", "description": "Also save the fresh screenshot here (e.g. as the next baseline)." }
                },
                "required": ["tab", "baseline"],
                "additionalProperties": false
            }),
            output_schema: None,
        }
    }

    async fn call(&self, ctx: ToolContext, args: Value) -> anyhow::Result<ToolOutput> {
        respond(
            async {
                target_tab(&args)?;
                let Some(baseline) = arg_str(&args, "baseline")? else { bail_user!("baseline is required") };
                let operation = "screenshot_diff baseline";
                let bytes = files::read(&ctx.file_roots, baseline, operation, pixeldiff::MAX_IMAGE_BYTES)
                    .map_err(|error| match error.downcast::<crate::UserError>() {
                        Ok(user) if user.0.contains("larger than") => {
                            anyhow::Error::new(crate::UserError("the baseline must be a PNG no larger than 32 MiB".into()))
                        }
                        Ok(user) => anyhow::Error::new(user),
                        Err(error) => error,
                    })?;
                if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
                    bail_user!(
                        "the baseline must be a PNG (screenshot_diff compares PNG screenshots); {baseline} is not one. Save baselines with screenshot format png."
                    );
                }
                let threshold = arg_f64(&args, "threshold")?.unwrap_or(0.1);
                let css_scale = !matches!(arg_str(&args, "scale")?, Some("device"));
                let diff_path =
                    arg_str(&args, "diffPath")?.map(|raw| files::output_path(&ctx.file_roots, raw, "diffPath")).transpose()?;
                let current_path = arg_str(&args, "currentPath")?
                    .map(|raw| files::output_path(&ctx.file_roots, raw, "currentPath"))
                    .transpose()?;
                let region = region(&args)?;
                let before = decode_png(&bytes)?;
                let (_, cdp, region) = resolve(&ctx, &args, region).await?;
                let shot = capture(cdp.as_ref(), &region, Format::Png, None, css_scale, MAX_SAVED_SIDE).await?;
                if let Some(path) = &current_path {
                    files::write(&ctx.file_roots, path, &shot.bytes, "currentPath")?;
                }
                let after = decode_png(&shot.bytes)?;
                let diff = pixeldiff::diff(&before, &after, threshold)?;
                let total = before.width as u64 * before.height as u64;
                let mut result = json!({
                    "matches": diff.changed_pixels == 0,
                    "width": before.width,
                    "height": before.height,
                    "changedPixels": diff.changed_pixels,
                    "totalPixels": total,
                    "changedRatio": diff.changed_pixels as f64 / total as f64,
                    "threshold": threshold,
                });
                if let Some(path) = &current_path {
                    result["currentPath"] = json!(path);
                }
                match diff_path {
                    Some(path) => {
                        files::write(&ctx.file_roots, &path, &encode_png(&diff.image)?, "diffPath")?;
                        result["diffPath"] = json!(path);
                        crate::json_output(&result)
                    }
                    None if diff.changed_pixels > 0 && before.width.max(before.height) as f64 > MAX_INLINE_SIDE => {
                        result["note"] = json!("the diff image is larger than 8000 px per side; pass diffPath to save it");
                        crate::json_output(&result)
                    }
                    None if diff.changed_pixels > 0 => Ok(ToolOutput {
                        content: vec![Content::Text { text: serde_json::to_string(&result)? }, image_content(&encode_png(&diff.image)?, "image/png")],
                        is_error: false,
                        structured_content: None,
                    }),
                    None => crate::json_output(&result),
                }
            }
            .await,
        )
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::FakeCdp;
    use base64::Engine;

    fn fake() -> std::sync::Arc<FakeCdp> {
        let cdp = FakeCdp::new();
        let image = crate::pixeldiff::Rgba { width: 1, height: 1, data: vec![0, 0, 0, 255] };
        cdp.reply(
            "Page.captureScreenshot",
            json!({ "data": base64::engine::general_purpose::STANDARD.encode(crate::pixeldiff::encode_png(&image).unwrap()) }),
        );
        cdp
    }

    fn layout(cdp: &FakeCdp, page_x: f64, page_y: f64, width: f64, height: f64, content_width: f64, content_height: f64) {
        cdp.reply(
            "Page.getLayoutMetrics",
            json!({
                "cssVisualViewport": { "pageX": page_x, "pageY": page_y, "clientWidth": width, "clientHeight": height, "zoom": 1.0 },
                "visualViewport": { "clientWidth": width },
                "cssContentSize": { "width": content_width, "height": content_height },
            }),
        );
    }

    fn clip_of(params: &Value) -> (f64, f64, f64, f64) {
        let clip = &params["clip"];
        let field = |name: &str| clip[name].as_f64().unwrap();
        (field("x"), field("y"), field("width"), field("height"))
    }

    fn assert_whole(params: &Value) {
        let clip = clip_of(params);
        assert_eq!([clip.0, clip.1, clip.2, clip.3].map(f64::fract), [0.0; 4], "{params}");
    }

    fn last_clip(cdp: &FakeCdp) -> (Value, (f64, f64, f64, f64)) {
        let calls = cdp.calls("Page.captureScreenshot");
        let params = calls.last().expect("a capture").0.clone();
        let clip = clip_of(&params);
        (params, clip)
    }

    #[test]
    fn clips_round_to_whole_pixels() {
        assert_eq!(whole_clip((10.5, 20.25, 100.0, 50.0)), (11.0, 20.0, 100.0, 50.0));
        assert_eq!(whole_clip((0.0, 0.0, 1280.0, 720.0)), (0.0, 0.0, 1280.0, 720.0));
        assert_eq!(whole_clip((99.6, 100.4, 719.6, 0.4)), (100.0, 100.0, 720.0, 1.0));
        // A box smaller than a pixel still covers one.
        assert_eq!(whole_clip((5.0, 5.0, 1e-20, 1e-20)), (5.0, 5.0, 1.0, 1.0));
    }

    #[test]
    fn clamp_keeps_a_one_pixel_viewport_inside() {
        assert_eq!(clamp_clip((10.0, 10.0, 20.0, 20.0), (5.0, 5.0, 1.0, 1.0)), (5.0, 5.0, 1.0, 1.0));
    }

    #[tokio::test]
    async fn captures_send_whole_pixel_clips_inside_the_viewport() {
        let cdp = fake();
        layout(&cdp, 10.3, 100.5, 800.0, 600.0, 1600.4, 2400.6);

        let shot = capture(cdp.as_ref(), &Region::Viewport, Format::Png, None, true, MAX_SAVED_SIDE).await.unwrap();
        assert_eq!((shot.width, shot.height), (1, 1));
        for region in [Region::Clip(50.4, 30.6, 100.2, 50.3), Region::Clip(700.4, 550.0, 100.0, 50.0)] {
            capture(cdp.as_ref(), &region, Format::Png, None, true, MAX_SAVED_SIDE).await.unwrap();
        }

        let calls = cdp.calls("Page.captureScreenshot");
        assert_eq!(calls.len(), 3, "{calls:?}");
        for (params, _) in &calls {
            assert_whole(params);
            assert_eq!(params["captureBeyondViewport"], json!(false), "{params}");
        }
        assert_eq!(clip_of(&calls[0].0), (10.0, 101.0, 800.0, 600.0));
        assert_eq!(clip_of(&calls[1].0), (61.0, 131.0, 100.0, 50.0));
        // Near the edge the clip is shifted inside the viewport, not shrunk.
        assert_eq!(clip_of(&calls[2].0), (710.0, 651.0, 100.0, 50.0));
    }

    #[tokio::test]
    async fn clip_size_does_not_depend_on_the_scroll_offset() {
        let cdp = fake();
        let region = Region::Clip(40.0, 30.0, 100.0, 50.0);
        for page_y in [100.0, 100.5] {
            layout(&cdp, 10.3, page_y, 800.0, 600.0, 1600.4, 2400.6);
            capture(cdp.as_ref(), &region, Format::Png, None, true, MAX_SAVED_SIDE).await.unwrap();
        }

        let calls = cdp.calls("Page.captureScreenshot");
        let sizes: Vec<(f64, f64)> = calls.iter().map(|(params, _)| { let (_, _, width, height) = clip_of(params); (width, height) }).collect();
        assert_eq!(sizes, [(100.0, 50.0), (100.0, 50.0)], "{calls:?}");
        // The scroll offset still moves the clip's origin.
        assert_eq!(clip_of(&calls[0].0).1, 130.0);
        assert_eq!(clip_of(&calls[1].0).1, 131.0);
        for (params, _) in &calls {
            assert_whole(params);
        }
    }

    #[tokio::test]
    async fn full_page_inside_the_viewport_keeps_its_size() {
        let cdp = fake();
        layout(&cdp, 0.0, 0.0, 1280.0, 720.0, 1280.4, 720.3);
        capture(cdp.as_ref(), &Region::FullPage, Format::Png, None, true, MAX_SAVED_SIDE).await.unwrap();

        let (params, clip) = last_clip(&cdp);
        assert_eq!(clip, (0.0, 0.0, 1280.0, 720.0));
        assert_eq!(params["captureBeyondViewport"], json!(false), "{params}");
    }

    #[tokio::test]
    async fn full_page_beyond_the_viewport_is_taken_whole() {
        let cdp = fake();
        layout(&cdp, 0.0, 0.0, 1280.0, 720.0, 1280.4, 2400.7);
        capture(cdp.as_ref(), &Region::FullPage, Format::Png, None, true, MAX_SAVED_SIDE).await.unwrap();

        let (params, clip) = last_clip(&cdp);
        assert_eq!(clip, (0.0, 0.0, 1280.0, 2401.0));
        assert_eq!(params["captureBeyondViewport"], json!(true), "{params}");
    }

    #[tokio::test]
    async fn a_zero_width_viewport_still_captures_beyond_it() {
        let cdp = fake();
        layout(&cdp, 0.0, 0.0, 0.4, 720.0, 1280.4, 2400.7);
        capture(cdp.as_ref(), &Region::FullPage, Format::Png, None, true, MAX_SAVED_SIDE).await.unwrap();

        let (params, clip) = last_clip(&cdp);
        assert_eq!(clip, (0.0, 0.0, 1280.0, 2401.0));
        assert_eq!(params["captureBeyondViewport"], json!(true), "{params}");
    }

    #[tokio::test]
    async fn a_clip_above_the_viewport_is_clamped_to_its_origin() {
        let cdp = fake();
        layout(&cdp, 10.3, 100.5, 800.0, 600.0, 1600.4, 2400.6);
        capture(cdp.as_ref(), &Region::Clip(-0.3, -0.2, 100.0, 50.0), Format::Png, None, true, MAX_SAVED_SIDE).await.unwrap();

        let (params, clip) = last_clip(&cdp);
        assert_eq!(clip, (10.0, 101.0, 100.0, 50.0));
        assert_eq!(params["captureBeyondViewport"], json!(false), "{params}");
    }

    #[tokio::test]
    async fn an_edge_clip_keeps_its_size_at_any_scroll_offset() {
        let cdp = fake();
        let region = Region::Clip(0.0, 0.4, 100.0, 600.0);
        for page_y in [100.4, 100.6] {
            layout(&cdp, 10.0, page_y, 800.0, 600.0, 1600.0, 2400.0);
            capture(cdp.as_ref(), &region, Format::Png, None, true, MAX_SAVED_SIDE).await.unwrap();
        }

        let calls = cdp.calls("Page.captureScreenshot");
        let sizes: Vec<(f64, f64)> = calls.iter().map(|(params, _)| { let (_, _, width, height) = clip_of(params); (width, height) }).collect();
        assert_eq!(sizes, [(100.0, 600.0), (100.0, 600.0)], "{calls:?}");
        // The clip moves with the rounded viewport origin instead of losing a row.
        assert_eq!(clip_of(&calls[0].0).1, 100.0);
        assert_eq!(clip_of(&calls[1].0).1, 101.0);
    }

    #[tokio::test]
    async fn scaling_down_keeps_the_clip_whole() {
        let cdp = fake();
        layout(&cdp, 10.0, 100.0, 800.0, 600.0, 800.0, 600.0);
        capture(cdp.as_ref(), &Region::Clip(20.2, 30.7, 100.0, 50.0), Format::Png, None, true, 50.0).await.unwrap();

        let (params, clip) = last_clip(&cdp);
        assert_eq!(clip, (30.0, 131.0, 100.0, 50.0));
        assert_whole(&params);
        assert_eq!(params["clip"]["scale"], json!(0.5), "{params}");
    }

    #[tokio::test]
    async fn a_viewport_without_a_visible_area_is_a_user_error() {
        let cdp = fake();
        layout(&cdp, 0.0, 0.0, 0.4, 720.0, 1280.0, 720.0);
        let error = capture(cdp.as_ref(), &Region::Viewport, Format::Png, None, true, MAX_SAVED_SIDE).await.err().expect("the capture must fail");
        assert!(error.to_string().contains("no visible area"), "{error}");
        assert!(cdp.calls("Page.captureScreenshot").is_empty());
    }
}
