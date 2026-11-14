//! Labelled screenshots (port of cli/src/snapshot/screenshot-labels.ts). Interactive elements are found from an
//! isolated world and the numbered markers are drawn onto the PNG in Rust, so nothing is ever added to the page.

use serde::{Deserialize, Serialize};

use crate::pixeldiff::Rgba;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct Label {
    pub label: u32,
    pub role: String,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub context: Option<String>,
    /// CSS selector for the element (` >> ` crosses into an open shadow root).
    pub selector: String,
    /// Viewport CSS pixels: [x, y, width, height]; click at the center to hit the element.
    pub rect: [f64; 4],
}

#[derive(Deserialize)]
pub(crate) struct Found {
    pub labels: Vec<Label>,
}

pub(crate) const SCRIPT: &str = r#"(() => {
  const selectors = ["button","a[href]","input","textarea","select","summary",'[role="button"]','[role="link"]','[role="tab"]','[role="menuitem"]','[role="menuitemcheckbox"]','[role="menuitemradio"]','[role="option"]','[role="switch"]','[role="checkbox"]','[role="radio"]','[role="combobox"]','[role="searchbox"]','[role="textbox"]','[role="slider"]','[role="spinbutton"]','[role="treeitem"]',"[onclick]","[contenteditable]"].join(",")
  const isShadowRoot = (node) => typeof ShadowRoot !== "undefined" && node instanceof ShadowRoot
  const results = []
  const visit = (node) => {
    for (let child = node.firstElementChild; child; child = child.nextElementSibling) {
      if (child.matches(selectors)) results.push(child)
      if (child.shadowRoot) visit(child.shadowRoot)
      if (child.firstElementChild) visit(child)
    }
  }
  visit(document)
  const candidates = results.filter((element) => {
    const rect = element.getBoundingClientRect()
    const style = window.getComputedStyle(element)
    if (rect.width < 4 || rect.height < 4) return false
    if (rect.right < 0 || rect.bottom < 0 || rect.left > window.innerWidth || rect.top > window.innerHeight) return false
    return style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0"
  }).slice(0, MAX_LABELS)
  const local = (element, scope) => {
    const id = element.getAttribute("id")
    if (id) return `#${CSS.escape(id)}`
    for (const attr of ["data-testid", "data-test-id", "data-test"]) {
      const value = element.getAttribute(attr)
      if (value) return `[${attr}="${CSS.escape(value)}"]`
    }
    const name = element.getAttribute("name")
    if (name) return `${element.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`
    const parent = element.parentElement
    if (!parent) {
      if (isShadowRoot(scope)) {
        const siblings = Array.from(scope.children).filter((child) => child.tagName === element.tagName)
        return `${element.tagName.toLowerCase()}:nth-of-type(${siblings.indexOf(element) + 1})`
      }
      return element.tagName.toLowerCase()
    }
    const siblings = Array.from(parent.children).filter((child) => child.tagName === element.tagName)
    return `${local(parent, scope)} > ${element.tagName.toLowerCase()}:nth-of-type(${siblings.indexOf(element) + 1})`
  }
  const selectorFor = (element) => {
    const root = element.getRootNode?.()
    if (isShadowRoot(root)) return `${selectorFor(root.host)} >> ${local(element, root)}`
    return local(element, document)
  }
  const roleFor = (element) => {
    const role = element.getAttribute("role")
    if (role) return role
    if (element instanceof HTMLAnchorElement) return "link"
    if (element instanceof HTMLButtonElement) return "button"
    if (element instanceof HTMLInputElement) return element.type || "input"
    if (element instanceof HTMLTextAreaElement) return "textarea"
    if (element instanceof HTMLSelectElement) return "select"
    if (element instanceof HTMLElement && element.isContentEditable) return "contenteditable"
    return element.getAttribute("onclick") ? "onclick" : element.tagName.toLowerCase()
  }
  const normalize = (value) => value.replace(/\s+/g, " ").trim()
  const textFor = (element) => {
    const value = element instanceof HTMLInputElement && element.type !== "password" ? element.value : ""
    return normalize(element.getAttribute("aria-label") || element.getAttribute("placeholder") || value || element.getAttribute("title") || element.textContent || "").slice(0, 80)
  }
  const accessibleText = (element) => {
    const label = element.getAttribute("aria-label")
    if (label) return label
    const labelledBy = element.getAttribute("aria-labelledby")
    if (labelledBy) {
      const text = labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ")
      if (normalize(text)) return text
    }
    if (element instanceof HTMLFieldSetElement) {
      const legend = element.querySelector(":scope > legend")
      if (legend?.textContent) return legend.textContent
    }
    const heading = element.querySelector(":scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6")
    if (heading?.textContent) return heading.textContent
    return element.textContent ?? ""
  }
  const nearestHeading = (element) => {
    const box = element.getBoundingClientRect()
    let nearest, distance = Infinity
    for (const heading of document.querySelectorAll("h1, h2, h3, h4, h5, h6, [role='heading']")) {
      const rect = heading.getBoundingClientRect()
      if (rect.bottom > box.top || rect.right < 0 || rect.left > window.innerWidth) continue
      if (box.top - rect.bottom < distance) { nearest = heading; distance = box.top - rect.bottom }
    }
    return nearest?.textContent ?? ""
  }
  const contextFor = (element, own) => {
    const container = element.closest("tr, [role='row'], li, [role='listitem'], fieldset, section, article, form, [aria-label], [aria-labelledby]")
    const context = normalize(container && container !== element ? accessibleText(container) : nearestHeading(element)).slice(0, 60)
    return !context || context.toLowerCase() === normalize(own).slice(0, 60).toLowerCase() ? undefined : context
  }
  const labels = candidates.map((element, index) => {
    const rect = element.getBoundingClientRect()
    const text = textFor(element)
    const context = contextFor(element, text)
    return {
      label: index + 1,
      role: roleFor(element),
      text,
      ...(context ? { context } : {}),
      selector: selectorFor(element),
      rect: [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)],
    }
  })
  return { labels }
})()"#;

pub(crate) fn script(max: u32) -> String {
    SCRIPT.replace("MAX_LABELS", &max.to_string())
}

// 5x7 glyphs, one row per string, "#" lit.
fn glyph(ch: char) -> Option<[&'static str; 7]> {
    Some(match ch {
        '0' => [" ### ", "#   #", "#  ##", "# # #", "##  #", "#   #", " ### "],
        '1' => ["  #  ", " ##  ", "  #  ", "  #  ", "  #  ", "  #  ", " ### "],
        '2' => [" ### ", "#   #", "    #", "   # ", "  #  ", " #   ", "#####"],
        '3' => ["#####", "   # ", "  #  ", "   # ", "    #", "#   #", " ### "],
        '4' => ["   # ", "  ## ", " # # ", "#  # ", "#####", "   # ", "   # "],
        '5' => ["#####", "#    ", "#### ", "    #", "    #", "#   #", " ### "],
        '6' => ["  ## ", " #   ", "#    ", "#### ", "#   #", "#   #", " ### "],
        '7' => ["#####", "    #", "   # ", "  #  ", " #   ", " #   ", " #   "],
        '8' => [" ### ", "#   #", "#   #", " ### ", "#   #", "#   #", " ### "],
        '9' => [" ### ", "#   #", "#   #", " ####", "    #", "   # ", " ##  "],
        _ => return None,
    })
}

/// Draws each label's number in a purple tag just above its element's top-left corner. `scale` is image pixels per
/// CSS pixel.
pub(crate) fn draw(image: &mut Rgba, labels: &[Label], scale: f64) {
    let (width, height) = (image.width as i64, image.height as i64);
    let mut fill = |x0: f64, y0: f64, w: f64, h: f64, [r, g, b]: [u8; 3]| {
        let (x_start, y_start) = ((x0.round() as i64).max(0), (y0.round() as i64).max(0));
        let (x_end, y_end) = (((x0 + w).round() as i64).min(width), ((y0 + h).round() as i64).min(height));
        for y in y_start..y_end {
            for x in x_start..x_end {
                let offset = ((y * width + x) * 4) as usize;
                image.data[offset..offset + 4].copy_from_slice(&[r, g, b, 255]);
            }
        }
    };
    let dot = (1.6 * scale).round().max(1.0);
    for label in labels {
        let glyphs: Vec<_> = label.label.to_string().chars().filter_map(glyph).collect();
        let text_width = glyphs.len() as f64 * 6.0 * dot - dot;
        let tag_height = 18.0 * scale;
        let tag_width = (18.0 * scale).max(text_width + 8.0 * scale);
        let x = label.rect[0].max(0.0) * scale;
        let y = (label.rect[1] - 18.0).max(0.0) * scale;
        fill(x, y, tag_width, tag_height, [0x7c, 0x3a, 0xed]);
        fill(x + scale, y + scale, tag_width - 2.0 * scale, tag_height - 2.0 * scale, [0xa7, 0x8b, 0xfa]);
        let mut pen_x = x + (tag_width - text_width) / 2.0;
        let pen_y = y + (tag_height - 7.0 * dot) / 2.0;
        for rows in glyphs {
            for (row_index, row) in rows.iter().enumerate() {
                for (column, cell) in row.chars().enumerate() {
                    if cell == '#' {
                        fill(pen_x + column as f64 * dot, pen_y + row_index as f64 * dot, dot, dot, [0x11, 0x18, 0x27]);
                    }
                }
            }
            pen_x += 6.0 * dot;
        }
    }
}
