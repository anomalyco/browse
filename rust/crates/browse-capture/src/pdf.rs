//! `pdf` (Labs): the tab printed to a PDF file, as the browser's print lays it out (print stylesheets, pagination,
//! paper size and margins, selectable text). Off unless the user turns it on in the extension's options page.

use async_trait::async_trait;
use browse_core::{PdfOptions, Tool, ToolContext, ToolOutput, ToolSpec};
use serde_json::{Value, json};

use crate::{arg_bool, arg_f64, arg_str, bail_user, files, respond, tab_schema, target_tab};

/// The Labs feature this tool belongs to (`browse_relay::settings::LABS`).
pub(crate) const LAB: &str = "pdf";

const LAB_OFF: &str = "Saving pages as PDF is a browse Labs feature and it's off in this browser. The user can turn on \"Save pages as PDF\" under labs on the browse extension's options page. Until then, take a full-page screenshot instead.";

/// Paper sizes in inches (width, height), portrait.
const PAPER: &[(&str, (f64, f64))] = &[
    ("Letter", (8.5, 11.0)),
    ("Legal", (8.5, 14.0)),
    ("Tabloid", (11.0, 17.0)),
    ("Ledger", (17.0, 11.0)),
    ("A0", (33.1, 46.8)),
    ("A1", (23.4, 33.1)),
    ("A2", (16.54, 23.4)),
    ("A3", (11.7, 16.54)),
    ("A4", (8.27, 11.7)),
    ("A5", (5.83, 8.27)),
    ("A6", (4.13, 5.83)),
];

/// Longest paper side browse accepts, in inches.
const MAX_SIDE: f64 = 200.0;

fn length(args: &Value, name: &str, min: f64, max: f64) -> anyhow::Result<Option<f64>> {
    match arg_f64(args, name)? {
        Some(value) if !(min..=max).contains(&value) => bail_user!("{name} must be from {min} to {max} inches"),
        value => Ok(value),
    }
}

pub(crate) fn options(args: &Value) -> anyhow::Result<PdfOptions> {
    let format = arg_str(args, "format")?;
    let width = length(args, "width", 0.1, MAX_SIDE)?;
    let height = length(args, "height", 0.1, MAX_SIDE)?;
    let paper = match (format, width, height) {
        (None, None, None) => None,
        (Some(name), None, None) => match PAPER.iter().find(|(paper, _)| paper.eq_ignore_ascii_case(name)) {
            Some((_, size)) => Some(*size),
            None => bail_user!("format must be one of {}", PAPER.iter().map(|(name, _)| *name).collect::<Vec<_>>().join(", ")),
        },
        (None, Some(width), Some(height)) => Some((width, height)),
        (None, _, _) => bail_user!("give both width and height, or a format"),
        (Some(_), _, _) => bail_user!("use either format or width and height, not both"),
    };
    let margins = match args.get("margin") {
        None | Some(Value::Null) => None,
        Some(margin @ Value::Object(_)) => {
            let side = |name: &str| length(margin, name, 0.0, MAX_SIDE / 2.0).map(|value| value.unwrap_or(0.0));
            Some((side("top")?, side("right")?, side("bottom")?, side("left")?))
        }
        Some(_) => bail_user!("margin must be an object like {{\"top\": 0.5}} (inches)"),
    };
    let scale = match arg_f64(args, "scale")? {
        Some(scale) if !(0.1..=2.0).contains(&scale) => bail_user!("scale must be from 0.1 to 2"),
        scale => scale,
    };
    Ok(PdfOptions {
        landscape: arg_bool(args, "landscape")?.unwrap_or(false),
        background: arg_bool(args, "printBackground")?.unwrap_or(false),
        scale,
        paper,
        margins,
        page_ranges: arg_str(args, "pageRanges")?.map(str::to_string),
        prefer_css_page_size: arg_bool(args, "preferCSSPageSize")?.unwrap_or(false),
    })
}

pub(crate) struct PdfTool;

#[async_trait]
impl Tool for PdfTool {
    fn spec(&self) -> ToolSpec {
        let inches = |description: &str| json!({ "type": "number", "description": description });
        ToolSpec {
            name: "pdf".into(),
            description: "Save the tab as a PDF file, laid out as the browser prints it (print styles, pages, selectable \
                text). Lengths are inches. Returns {path, bytes}."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "tab": tab_schema(),
                    "path": { "type": "string", "description": "Where to save it: absolute inside the file roots (in a private folder you own, not directly in a shared temp folder), or relative (saved in a private folder in the first root). Replaces an existing file." },
                    "format": { "type": "string", "enum": PAPER.iter().map(|(name, _)| *name).collect::<Vec<_>>(), "description": "Paper size (default Letter)." },
                    "width": inches("Paper width, with height, instead of format."),
                    "height": inches("Paper height, with width, instead of format."),
                    "landscape": { "type": "boolean" },
                    "margin": {
                        "type": "object",
                        "properties": { "top": { "type": "number" }, "right": { "type": "number" }, "bottom": { "type": "number" }, "left": { "type": "number" } },
                        "additionalProperties": false
                    },
                    "scale": { "type": "number", "minimum": 0.1, "maximum": 2, "description": "Default 1." },
                    "printBackground": { "type": "boolean", "description": "Print background colors and images." },
                    "pageRanges": { "type": "string", "description": "Pages to keep, like \"1-3, 5\"." },
                    "preferCSSPageSize": { "type": "boolean", "description": "Use the page's CSS @page size over format." }
                },
                "required": ["tab", "path"],
                "additionalProperties": false
            }),
            output_schema: None,
        }
    }

    async fn call(&self, ctx: ToolContext, args: Value) -> anyhow::Result<ToolOutput> {
        respond(
            async {
                let tab = target_tab(&args)?;
                if !ctx.browser.lab_enabled(tab, LAB).await {
                    bail_user!("{LAB_OFF}");
                }
                let options = options(&args)?;
                let Some(raw) = arg_str(&args, "path")? else { bail_user!("pass path: where to save the PDF") };
                let path = files::output_path(&ctx.file_roots, raw, "pdf path")?;
                let driver = ctx.browser.tab_driver(tab).await?;
                let bytes = driver.print_pdf(options).await?;
                files::write(&ctx.file_roots, &path, &bytes, "pdf path")?;
                crate::json_output(&json!({ "path": path, "bytes": bytes.len() }))
            }
            .await,
        )
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paper_comes_from_a_format_or_both_sides() {
        assert_eq!(options(&json!({})).unwrap().paper, None);
        assert_eq!(options(&json!({ "format": "a4" })).unwrap().paper, Some((8.27, 11.7)));
        assert_eq!(options(&json!({ "width": 4.0, "height": 6.0 })).unwrap().paper, Some((4.0, 6.0)));
        assert!(options(&json!({ "width": 4.0 })).is_err());
        assert!(options(&json!({ "format": "A4", "width": 4.0, "height": 6.0 })).is_err());
        assert!(options(&json!({ "format": "B5" })).is_err());
        assert!(options(&json!({ "scale": 3.0 })).is_err());
        assert_eq!(options(&json!({ "margin": { "top": 1.0 } })).unwrap().margins, Some((1.0, 0.0, 0.0, 0.0)));
    }
}
