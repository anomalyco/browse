//! `Page.printToPDF` parameters for `TabDriver::print_pdf`.

use browse_core::PdfOptions;
use serde_json::{Value, json};

pub(crate) fn params(options: &PdfOptions) -> Value {
    let mut params = json!({
        "landscape": options.landscape,
        "printBackground": options.background,
        "preferCSSPageSize": options.prefer_css_page_size,
        "transferMode": "ReturnAsBase64",
    });
    if let Some(scale) = options.scale {
        params["scale"] = json!(scale);
    }
    if let Some((width, height)) = options.paper {
        params["paperWidth"] = json!(width);
        params["paperHeight"] = json!(height);
    }
    if let Some((top, right, bottom, left)) = options.margins {
        params["marginTop"] = json!(top);
        params["marginRight"] = json!(right);
        params["marginBottom"] = json!(bottom);
        params["marginLeft"] = json!(left);
    }
    if let Some(ranges) = &options.page_ranges {
        params["pageRanges"] = json!(ranges);
    }
    params
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn leaves_unset_options_to_chrome() {
        let params = params(&PdfOptions::default());
        assert_eq!(params, json!({ "landscape": false, "printBackground": false, "preferCSSPageSize": false, "transferMode": "ReturnAsBase64" }));
    }

    #[test]
    fn passes_paper_margins_and_ranges_in_inches() {
        let options = PdfOptions {
            landscape: true,
            background: true,
            scale: Some(0.5),
            paper: Some((8.5, 11.0)),
            margins: Some((1.0, 0.5, 1.0, 0.5)),
            page_ranges: Some("1-2".into()),
            prefer_css_page_size: true,
        };
        let params = params(&options);
        assert_eq!(params["paperWidth"], 8.5);
        assert_eq!(params["paperHeight"], 11.0);
        assert_eq!(params["marginRight"], 0.5);
        assert_eq!(params["scale"], 0.5);
        assert_eq!(params["pageRanges"], "1-2");
        assert_eq!(params["landscape"], true);
        assert_eq!(params["printBackground"], true);
        assert_eq!(params["preferCSSPageSize"], true);
    }
}
