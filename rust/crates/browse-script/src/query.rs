//! Reading every element a selector matches (count, all, allTextContents, $$eval, isVisible): the page tools act on
//! exactly one element, so locators that read several run a function over all matches in browse's isolated world,
//! with the same Playwright selector engine and frame entering the page tools use.

use std::time::Duration;

use anyhow::Result;
use browse_core::{Arg, ToolContext};
use serde_json::Value;

/// Turns the function's result into JSON: elements become "<tag#id.class>", cycles and functions are dropped.
const SERIALIZE: &str = r##"(value) => {
  const seen = new WeakSet()
  const walk = (v, depth) => {
    if (v === undefined || typeof v === "function" || typeof v === "symbol") return undefined
    if (v === null || typeof v !== "object") return typeof v === "bigint" ? String(v) : (typeof v === "number" && !Number.isFinite(v) ? null : v)
    if (v instanceof Element) return "<" + v.tagName.toLowerCase() + (v.id ? "#" + v.id : "") + (typeof v.className === "string" && v.className.trim() ? "." + v.className.trim().split(/\s+/).join(".") : "") + ">"
    if (v instanceof Node) return "[" + v.nodeName + "]"
    if (v instanceof Date) return v.toISOString()
    if (seen.has(v) || depth > 30) return "[Circular]"
    seen.add(v)
    try {
      if (Array.isArray(v) || v instanceof NodeList || v instanceof HTMLCollection || v instanceof Set) return Array.from(v, (x) => { const w = walk(x, depth + 1); return w === undefined ? null : w })
      if (v instanceof Map) { const o = {}; for (const [k, x] of v) { const w = walk(x, depth + 1); if (w !== undefined) o[String(k)] = w } return o }
      if (v instanceof Error) return { name: v.name, message: v.message }
      if (typeof v.toJSON === "function") { try { return walk(v.toJSON(), depth + 1) } catch {} }
      const o = {}
      for (const k of Object.keys(v)) { let x; try { x = v[k] } catch { continue } const w = walk(x, depth + 1); if (w !== undefined) o[k] = w }
      return o
    } finally { seen.delete(v) }
  }
  return walk(value, 0)
}"##;

/// `{ selector, function, arg, tab?, timeout? }`: calls `function(elements, arg, { visible })` and returns its JSON.
pub async fn run(ctx: &ToolContext, payload: &Value) -> Result<Value> {
    let selector = payload["selector"].as_str().unwrap_or_default();
    let function = payload["function"].as_str().unwrap_or("(els) => els.length");
    let arg = payload.get("arg").cloned().unwrap_or(Value::Null);
    let timeout = Duration::from_millis(payload["timeout"].as_u64().unwrap_or(5_000));
    let tab = crate::host::tab_argument(ctx, payload)?;
    let page = browse_page::state::tab(ctx, tab).await?.page(ctx).await?;
    let (frame, rest) = browse_page::target::selector_frame(&page, selector, timeout).await?;
    let rest = browse_page::target::normalize_selector(if rest.trim().is_empty() { ":root" } else { rest.trim() });
    let declaration = format!(
        "async function (selector, argJson) {{\nconst elements = this.queryAll(selector);\nconst inj = this.inj;\nconst helpers = {{ visible: (el) => inj.elementState(el, 'visible').matches }};\nconst value = await ({function})(elements, JSON.parse(argJson), helpers);\nreturn ({SERIALIZE})(value) ?? null;\n}}"
    );
    page.call_helpers_fn(
        &frame,
        &declaration,
        &[Arg::Json(Value::String(rest)), Arg::Json(Value::String(arg.to_string()))],
        true,
        true,
    )
    .await
}
