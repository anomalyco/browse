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

use crate::{arg_bool, arg_f64, arg_int, arg_str, arg_tab, bail_user, files, labels, respond, state, tab_schema, target_tab};

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
    /// Size of the captured area in CSS pixels.
    css_width: f64,
    css_height: f64,
    /// Image pixels per CSS pixel.
    scale: f64,
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

/// The tab and CDP connection a capture uses; element regions are resolved here into viewport clips.
async fn resolve(ctx: &ToolContext, args: &Value, region: Region) -> anyhow::Result<(TabId, Arc<dyn Cdp>, Region)> {
    match region {
        Region::Element { reference, selector } => {
            let timeout = Duration::from_millis(arg_int(args, "timeoutMs", 0, 60_000)?.unwrap_or(5_000) as u64);
            let (page, element, _) =
                browse_page::resolve_element(ctx, arg_tab(args)?, reference.as_deref(), selector.as_deref(), timeout).await?;
            let (x, y, w, h) = element_rect(&page, &element).await?;
            Ok((page.tab(), page.cdp().clone(), Region::Clip(x, y, w, h)))
        }
        region => {
            let tab = target_tab(ctx, args).await?;
            Ok((tab, ctx.browser.cdp(&ctx.session, tab).await?, region))
        }
    }
}

async fn capture(
    cdp: &dyn Cdp,
    region: &Region,
    format: Format,
    quality: Option<i64>,
    css_scale: bool,
) -> anyhow::Result<Shot> {
    let viewport = page::viewport(cdp).await?;
    let dpr = viewport.device_pixel_ratio;
    let clip_scale = if css_scale { 1.0 / dpr } else { 1.0 };
    let (x, y, width, height, beyond) = match region {
        Region::Viewport => (viewport.page_x, viewport.page_y, viewport.width, viewport.height, false),
        Region::FullPage => (0.0, 0.0, viewport.content_width.max(1.0), viewport.content_height.max(1.0), true),
        Region::Clip(x, y, w, h) => (viewport.page_x + x, viewport.page_y + y, *w, *h, true),
        Region::Element { .. } => bail_user!("resolve the element first"),
    };
    let mut params = json!({
        "format": format.name(),
        "clip": { "x": x, "y": y, "width": width, "height": height, "scale": clip_scale },
        "captureBeyondViewport": beyond,
        "fromSurface": true,
    });
    if format != Format::Png {
        params["quality"] = json!(quality.unwrap_or(80));
    }
    let result = cdp.send("Page.captureScreenshot", params, None).await?;
    let data = result.get("data").and_then(Value::as_str).ok_or_else(|| anyhow::anyhow!("Chrome returned no image"))?;
    Ok(Shot {
        bytes: base64::engine::general_purpose::STANDARD.decode(data)?,
        css_width: width,
        css_height: height,
        scale: clip_scale * dpr,
    })
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
                returns {path, width, height}. labels: true numbers the visible interactive elements on the image \
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
                    "ref": { "type": "string", "description": "Snapshot ref of the element to capture (e.g. \"e12\" or an iframe ref \"f1e3\"); its tab is used unless tab is given." },
                    "selector": { "type": "string", "description": "Selector of the element to capture, as the page tools accept it." },
                    "timeoutMs": { "type": "integer", "minimum": 0, "maximum": 60000, "description": "How long to wait for the ref/selector element (default 5000)." },
                    "clip": {
                        "type": "object",
                        "description": "Rectangle to capture, in viewport CSS pixels (as from getBoundingClientRect).",
                        "properties": { "x": { "type": "number" }, "y": { "type": "number" }, "width": { "type": "number" }, "height": { "type": "number" } },
                        "required": ["x", "y", "width", "height"]
                    },
                    "scale": { "type": "string", "enum": ["css", "device"], "description": "css (default): one image pixel per CSS pixel. device: full device resolution (e.g. 2x on Retina)." },
                    "labels": { "type": "boolean", "description": "Number visible interactive elements on a viewport PNG and list them." },
                    "maxLabels": { "type": "integer", "minimum": 1, "maximum": 300, "description": "Most elements to label (default 80)." },
                    "path": { "type": "string", "description": "Save here instead of returning the image: absolute inside the file roots, or relative to the first root. Replaces an existing file." }
                },
                "additionalProperties": false
            }),
        }
    }

    async fn call(&self, ctx: ToolContext, args: Value) -> anyhow::Result<ToolOutput> {
        respond(
            async {
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
                let path = arg_str(&args, "path")?.map(|raw| files::output_path(&ctx.file_roots, raw)).transpose()?;
                let (tab, cdp, region) = resolve(&ctx, &args, region).await?;
                let mut found = None;
                if with_labels {
                    let max = arg_int(&args, "maxLabels", 1, 300)?.unwrap_or(80) as u32;
                    let capture_state = state::get(&ctx).await;
                    let mut worlds = capture_state.worlds.lock().await;
                    let value = page::evaluate(cdp.as_ref(), &mut worlds, tab, &labels::script(max)).await?;
                    found = Some(serde_json::from_value::<labels::Found>(value)?.labels);
                }
                let mut shot = capture(cdp.as_ref(), &region, format, quality, css_scale).await?;
                if let Some(found) = &found {
                    let mut image = decode_png(&shot.bytes)?;
                    labels::draw(&mut image, found, shot.scale);
                    shot.bytes = encode_png(&image)?;
                }
                let mut summary = json!({
                    "width": round(shot.css_width * shot.scale),
                    "height": round(shot.css_height * shot.scale),
                    "format": format.name(),
                });
                if (shot.scale - 1.0).abs() > 0.001 {
                    summary["scale"] = json!(round(shot.scale));
                }
                if let Some(found) = found {
                    summary["labels"] = json!(found);
                }
                match path {
                    Some(path) => {
                        files::write(&path, &shot.bytes)?;
                        summary["path"] = json!(path);
                        summary["bytes"] = json!(shot.bytes.len());
                        crate::json_output(&summary)
                    }
                    None => Ok(ToolOutput {
                        content: vec![
                            image_content(&shot.bytes, format.mime()),
                            Content::Text { text: serde_json::to_string(&summary)? },
                        ],
                        is_error: false,
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
                        "properties": { "x": { "type": "number" }, "y": { "type": "number" }, "width": { "type": "number" }, "height": { "type": "number" } },
                        "required": ["x", "y", "width", "height"]
                    },
                    "scale": { "type": "string", "enum": ["css", "device"], "description": "Must match how the baseline was taken (default css)." },
                    "threshold": { "type": "number", "minimum": 0, "maximum": 1, "description": "Per-pixel color tolerance (default 0.1); not an allowance for changed area." },
                    "diffPath": { "type": "string", "description": "Save the diff PNG here instead of returning it." },
                    "currentPath": { "type": "string", "description": "Also save the fresh screenshot here (e.g. as the next baseline)." }
                },
                "required": ["baseline"],
                "additionalProperties": false
            }),
        }
    }

    async fn call(&self, ctx: ToolContext, args: Value) -> anyhow::Result<ToolOutput> {
        respond(
            async {
                let Some(baseline) = arg_str(&args, "baseline")? else { bail_user!("baseline is required") };
                let baseline = files::input_path(&ctx.file_roots, baseline)?;
                let threshold = arg_f64(&args, "threshold")?.unwrap_or(0.1);
                let css_scale = !matches!(arg_str(&args, "scale")?, Some("device"));
                let diff_path = arg_str(&args, "diffPath")?.map(|raw| files::output_path(&ctx.file_roots, raw)).transpose()?;
                let current_path =
                    arg_str(&args, "currentPath")?.map(|raw| files::output_path(&ctx.file_roots, raw)).transpose()?;
                let region = region(&args)?;
                let meta = std::fs::metadata(&baseline)?;
                if meta.len() as usize > pixeldiff::MAX_IMAGE_BYTES {
                    bail_user!("the baseline must be a PNG no larger than 32 MiB");
                }
                let before = decode_png(&std::fs::read(&baseline)?)?;
                let (_, cdp, region) = resolve(&ctx, &args, region).await?;
                let shot = capture(cdp.as_ref(), &region, Format::Png, None, css_scale).await?;
                if let Some(path) = &current_path {
                    files::write(path, &shot.bytes)?;
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
                        files::write(&path, &encode_png(&diff.image)?)?;
                        result["diffPath"] = json!(path);
                        crate::json_output(&result)
                    }
                    None if diff.changed_pixels > 0 => Ok(ToolOutput {
                        content: vec![Content::Text { text: serde_json::to_string(&result)? }, image_content(&encode_png(&diff.image)?, "image/png")],
                        is_error: false,
                    }),
                    None => crate::json_output(&result),
                }
            }
            .await,
        )
        .await
    }
}
