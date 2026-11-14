//! The eval tool's page side: wrapping the user's code so declarations stay local and results serialize like the
//! TypeScript implementation, plus the error, timeout and navigation handling around it.

use std::sync::Arc;
use std::time::Duration;

use anyhow::{Result, anyhow, bail};
use serde_json::{Value, json};

use crate::page::{Element, TabPage, TRANSIENT_GROUP, is_context_lost};

/// Turns any value into JSON-safe data in the page: Map → object, Set → array, Date → ISO string, Error →
/// {name, message, stack}, DOM nodes → "<tag#id.class>", circular references → "[Circular]", BigInt → "10n",
/// symbols and functions → descriptive strings. Bounded by a node budget.
const SERIALIZE: &str = r##"(value) => {
  let budget = 20000
  const stack = new Set()
  const tag = (v) => Object.prototype.toString.call(v)
  const describeNode = (node) => {
    if (node.nodeType === 1) {
      let s = String(node.localName || node.nodeName).toLowerCase()
      if (node.id) s += "#" + node.id
      const cls = typeof node.className === "string" ? node.className.trim().split(/\s+/).filter(Boolean).slice(0, 3) : []
      for (const c of cls) s += "." + c
      return "<" + s + ">"
    }
    if (node.nodeType === 3) return "#text " + JSON.stringify(String(node.textContent || "").slice(0, 80))
    if (node.nodeType === 9) return "<#document>"
    return "<" + node.nodeName + ">"
  }
  const walk = (v, depth) => {
    if (--budget < 0) return "[…]"
    if (v === null) return null
    switch (typeof v) {
      case "undefined": return undefined
      case "string": case "boolean": return v
      case "number": return Number.isFinite(v) ? v : String(v)
      case "bigint": return v + "n"
      case "symbol": return v.toString()
      case "function": return "[Function " + (v.name || "anonymous") + "]"
    }
    if (stack.has(v)) return "[Circular]"
    if (depth > 30) return "[…]"
    const kind = tag(v)
    if (kind === "[object Window]" || v === globalThis) return "[Window]"
    if (typeof v.nodeType === "number" && typeof v.nodeName === "string") return describeNode(v)
    if (v instanceof Date || kind === "[object Date]") return isNaN(v.getTime()) ? "Invalid Date" : v.toISOString()
    if (v instanceof RegExp || kind === "[object RegExp]") return String(v)
    stack.add(v)
    try {
      if (v instanceof Error || kind === "[object Error]") {
        const out = { name: v.name, message: v.message }
        if (v.stack) out.stack = String(v.stack).split("\n").slice(0, 6).join("\n")
        return out
      }
      if (kind === "[object NodeList]" || kind === "[object HTMLCollection]" || Array.isArray(v)) {
        return Array.from(v, (item) => { const w = walk(item, depth + 1); return w === undefined ? null : w })
      }
      if (v instanceof Map || kind === "[object Map]") {
        const out = {}
        for (const [key, item] of v) { const w = walk(item, depth + 1); if (w !== undefined) out[typeof key === "string" ? key : String(walk(key, depth + 1))] = w }
        return out
      }
      if (v instanceof Set || kind === "[object Set]") return Array.from(v, (item) => { const w = walk(item, depth + 1); return w === undefined ? null : w })
      if (ArrayBuffer.isView(v)) return Array.from(v.slice ? v.slice(0, 1000) : [], (n) => typeof n === "bigint" ? n + "n" : n)
      if (v instanceof ArrayBuffer) return "[ArrayBuffer " + v.byteLength + " bytes]"
      if (typeof v.toJSON === "function") {
        try { return walk(v.toJSON(), depth + 1) } catch {}
      }
      const out = {}
      for (const key of Object.keys(v)) {
        let item
        try { item = v[key] } catch (error) { item = "[Thrown: " + (error && error.message || error) + "]" }
        const w = walk(item, depth + 1)
        if (w !== undefined) out[key] = w
      }
      return out
    } finally {
      stack.delete(v)
    }
  }
  return walk(value, 0)
}"##;

/// Lines of the wrapper before the user's code, to map exception positions back to it.
const PREFIX_LINES: i64 = 3;

/// The user's code as the body of an async function: `return (<expression>)`, or the statements as given.
fn body(expression: &str, block: bool) -> (String, &'static str) {
    let (open, close) = if block { ("", "") } else { ("return (", ")") };
    (format!("{open}\n{expression}\n"), close)
}

/// A function declaration `async function (__element, __argJson)` running `expression` as an expression, or as
/// statements (`block`), inside its own function so declarations never leak into the page's global scope. `this`
/// is the global object, as for top-level code. It returns `{ value }`, `{ undefined: true }` or
/// `{ function: true }` (a function result it may not call), the value serialized by [SERIALIZE].
pub fn declaration(expression: &str, block: bool, callable: bool) -> String {
    let (code, close) = body(expression, block);
    format!(
        "async function (__element, __argJson) {{\nconst __arg = __argJson === undefined ? undefined : JSON.parse(__argJson);\nlet __value = await (async function () {{ {code}{close} }}).call(globalThis);\nif (typeof __value === \"function\") {{ if (!{callable}) return {{ function: true }}; __value = await __value(__element, __arg) }}\nreturn __value === undefined ? {{ undefined: true }} : {{ value: ({SERIALIZE})(__value) }};\n}}"
    )
}

/// Whether the code parses as an expression (Runtime.compileScript compiles without running anything). None when
/// Chrome couldn't tell.
async fn parses_as_expression(page: &Arc<TabPage>, context: Option<(i64, Option<String>)>, expression: &str) -> Option<bool> {
    let (context_id, session) = context?;
    let source = format!("(async function () {{ return (\n{expression}\n) }})");
    let result = page
        .send("Runtime.compileScript", json!({ "expression": source, "sourceURL": "", "persistScript": false, "executionContextId": context_id }), session.as_deref())
        .await
        .ok()?;
    Some(result.get("exceptionDetails").is_none())
}

/// What an eval call needs to run: where and against what.
pub enum Target {
    /// An element (in its world); `this` stays the global object and the element is the function's first argument.
    Element { object_id: String, session: Option<String> },
    /// An execution context (browse's isolated world of a frame).
    Context { context_id: i64, session: Option<String> },
    /// The page's main world of a frame, reached through its document object.
    Object { object_id: String, session: Option<String> },
}

impl Target {
    fn session(&self) -> Option<&str> {
        match self {
            Target::Element { session, .. } | Target::Context { session, .. } | Target::Object { session, .. } => session.as_deref(),
        }
    }
}

pub enum Outcome {
    Value(Value),
    /// The code ran as statements and gave nothing back.
    Undefined { block: bool },
}

fn params(target: &Target, declaration: String, arg: Option<&Value>) -> Value {
    let arg = match arg {
        Some(a) => json!({ "value": a.to_string() }),
        None => json!({}),
    };
    let mut params = json!({
        "functionDeclaration": declaration,
        "returnByValue": true,
        "awaitPromise": true,
        "generatePreview": true,
        "userGesture": true,
        "objectGroup": TRANSIENT_GROUP,
    });
    match target {
        Target::Element { object_id, .. } => {
            params["objectId"] = json!(object_id);
            params["arguments"] = json!([{ "objectId": object_id }, arg]);
        }
        Target::Context { context_id, .. } => {
            params["executionContextId"] = json!(context_id);
            params["arguments"] = json!([{}, arg]);
        }
        Target::Object { object_id, .. } => {
            params["objectId"] = json!(object_id);
            params["arguments"] = json!([{}, arg]);
        }
    }
    params
}

/// Runs the code as an expression when it parses as one, else as statements whose result needs `return`.
/// `compile` is an execution context of the frame (any world) to check the syntax in.
pub async fn run(page: &Arc<TabPage>, target: &Target, compile: Option<(i64, Option<String>)>, expression: &str, arg: Option<&Value>, callable: bool) -> Result<Outcome> {
    let expression = expression.trim().trim_end_matches(';').trim_end();
    let known = parses_as_expression(page, compile, expression).await;
    let mut block = known == Some(false);
    loop {
        let result = page.send("Runtime.callFunctionOn", params(target, declaration(expression, block, callable), arg), target.session()).await?;
        if let Some(details) = result.get("exceptionDetails") {
            // Without a syntax check, a SyntaxError means the code is statements; only then is a retry safe, since
            // a compile error runs nothing.
            let syntax = details["exception"]["className"] == "SyntaxError" && details["stackTrace"].is_null();
            if known.is_none() && syntax && !block {
                block = true;
                continue;
            }
            bail!("{}", exception_text(details, expression));
        }
        let value = &result["result"]["value"];
        if value["function"] == true {
            bail!("The expression evaluated to a function; pass arg (or a ref/selector) to call it, or call it yourself: (fn)()");
        }
        if value["undefined"] == true {
            return Ok(Outcome::Undefined { block });
        }
        return Ok(Outcome::Value(value.get("value").cloned().unwrap_or(Value::Null)));
    }
}

/// The message of a thrown exception: Errors as `Name: message`, other values as JSON, with the line:column in the
/// eval code when the throw happened there.
pub fn exception_text(details: &Value, expression: &str) -> String {
    let exception = &details["exception"];
    let mut message = if exception["subtype"] == "error" || exception["className"].as_str().map(|c| c.ends_with("Error")).unwrap_or(false) {
        crate::page::exception_message(details)
    } else if let Some(value) = exception.get("value") {
        format!("threw {}", serde_json::to_string(value).unwrap_or_default())
    } else if let Some(unserializable) = exception["unserializableValue"].as_str() {
        format!("threw {unserializable}")
    } else if exception["type"] == "undefined" {
        "threw undefined".into()
    } else if let Some(preview) = exception["preview"]["properties"].as_array() {
        let fields: Vec<String> = preview.iter().map(|p| format!("{}: {}", p["name"].as_str().unwrap_or(""), p["value"].as_str().unwrap_or(""))).collect();
        format!("threw {} {{ {} }}", exception["className"].as_str().unwrap_or("Object"), fields.join(", "))
    } else {
        format!("threw {}", exception["description"].as_str().unwrap_or("a value"))
    };
    // The throw site: the stack's first frame when it is the eval code itself (an anonymous script), else the
    // details' position (synchronous throws).
    let description = exception["description"].as_str().unwrap_or("");
    let first_frame = description.lines().map(str::trim).find(|line| line.starts_with("at "));
    let position = match first_frame {
        Some(frame) => {
            let location = frame.trim_end_matches(')').rsplit(['(', ' ']).next().unwrap_or("");
            let mut parts = location.rsplitn(3, ':');
            let column = parts.next().and_then(|c| c.parse::<i64>().ok());
            let line = parts.next().and_then(|l| l.parse::<i64>().ok());
            let script = parts.next().unwrap_or("");
            (script == "<anonymous>").then_some(()).and(line.zip(column)).map(|(l, c)| (l - PREFIX_LINES, c))
        }
        None if details["url"].as_str().map(str::is_empty).unwrap_or(true) && details["lineNumber"].as_i64().unwrap_or(0) > 0 => {
            Some((details["lineNumber"].as_i64().unwrap_or(0) - PREFIX_LINES + 1, details["columnNumber"].as_i64().unwrap_or(0) + 1))
        }
        None => None,
    };
    let lines = expression.lines().count() as i64;
    if let Some((line, column)) = position
        && line >= 1 && line <= lines {
            message = format!("{message} (at line {line}:{column} of the eval code)");
        }
    message
}

/// After a timeout: when the page no longer answers (a busy loop), stop the running script.
pub async fn stop_if_busy(page: &Arc<TabPage>, session: Option<&str>) -> bool {
    let probe = page.send_raw("Runtime.evaluate", json!({ "expression": "0", "returnByValue": true }), session);
    if tokio::time::timeout(Duration::from_millis(300), probe).await.is_ok() {
        return false;
    }
    page.send_raw("Runtime.terminateExecution", json!({}), session).await.is_ok()
}

/// An element target in the main world, or in browse's world.
pub async fn element_target(page: &Arc<TabPage>, element: &Element, main_world: bool) -> Result<Target> {
    let object_id = if main_world { page.main_world_object(element).await? } else { element.object_id.clone() };
    Ok(Target::Element { object_id, session: element.session.clone() })
}

/// A frame target: browse's isolated world, or the page's main world through the frame's document.
pub async fn frame_target(page: &Arc<TabPage>, frame: &str, main_world: bool) -> Result<Target> {
    if main_world {
        let document = page.document(frame).await?;
        let object_id = page.main_world_object(&document).await?;
        return Ok(Target::Object { object_id, session: document.session });
    }
    let world = page.world(frame).await?;
    Ok(Target::Context { context_id: world.context_id, session: world.session })
}

/// A context or navigation error, phrased for the user.
pub fn lost_context(page: &TabPage, navigated: bool) -> anyhow::Error {
    if navigated {
        anyhow!("The page navigated to {} while eval ran, so its result is lost (the code may have run partly). Run it again on the new page if needed.", page.main_url())
    } else {
        anyhow!("The page's document changed while eval ran; run it again.")
    }
}

pub fn is_lost(error: &anyhow::Error) -> bool {
    is_context_lost(&error.to_string())
}
