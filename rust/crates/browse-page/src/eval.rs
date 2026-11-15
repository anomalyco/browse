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
      const text = String(node.textContent || "").replace(/\s+/g, " ").trim()
      if (text) s += " " + JSON.stringify(text.length > 40 ? text.slice(0, 40) + "…" : text)
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
        // Keys that aren't strings or numbers would collapse when used as object keys: keep [key, value] pairs.
        if (Array.from(v.keys()).some((key) => typeof key !== "string" && typeof key !== "number")) {
          return Array.from(v, ([key, item]) => [walk(key, depth + 1) ?? null, walk(item, depth + 1) ?? null])
        }
        const out = {}
        for (const [key, item] of v) { const w = walk(item, depth + 1); if (w !== undefined) out[String(key)] = w }
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

/// A function declaration `async function (__element, __argJson)` running `body` (an async function body built
/// from the user's code) inside its own function, so declarations never leak into the page's global scope. `this`
/// is the global object, as for top-level code. It returns `{ value }`, `{ undefined: true }`, `{ function: true }`
/// (a function result it may not call) or `{ notFunction: true }` (a ref/selector/arg was given but the code isn't a
/// function), the value serialized by [SERIALIZE]. Without a ref/selector/arg, a function whose source is the whole
/// `source` (the code is a function literal, like `() => document.title`) is called with no arguments; any other
/// function (`window.close`, a page's own function) is never called.
pub fn declaration(body: &str, callable: bool, source: &str) -> String {
    let source = serde_json::to_string(source.trim()).unwrap_or_else(|_| "null".into());
    format!(
        "async function (__element, __argJson) {{\nconst __arg = __argJson === undefined ? undefined : JSON.parse(__argJson);\nlet __value = await (async function () {{ {body} }}).call(globalThis);\nif (typeof __value === \"function\") {{ if ({callable}) __value = await __value(__element, __arg); else if (Function.prototype.toString.call(__value).trim() === {source}) __value = await __value(); else return {{ function: true }} }} else if ({callable}) return {{ notFunction: true }};\nreturn __value === undefined ? {{ undefined: true }} : {{ value: ({SERIALIZE})(__value) }};\n}}"
    )
}

fn expression_body(expression: &str) -> String {
    format!("return (\n{expression}\n)")
}

fn statements_body(code: &str) -> String {
    format!("\n{code}\n")
}

/// Whether `body` parses as an async function body, checked in browse's isolated world of `frame` by compiling it
/// with the AsyncFunction constructor, which runs nothing. None when that isn't possible (a Content Security Policy
/// that blocks it).
async fn compiles(page: &Arc<TabPage>, frame: &Option<String>, body: &str) -> Option<bool> {
    let frame = frame.as_ref()?;
    page.call_value(frame, "parses", vec![crate::page::v(body)], false).await.ok()?.as_bool()
}

const STATEMENT_KEYWORDS: &[&str] = &["return", "throw", "if", "else", "for", "while", "do", "switch", "try", "catch", "finally", "const", "let", "var", "function", "class", "async function", "import", "export", "break", "continue", "debugger", "case", "default", "}", "{"];

/// REPL-like statements: when the last statement is an expression, the body that returns its value. Split points
/// are the `;` and line breaks near the end; Chrome's parser confirms that the tail is a whole expression and the
/// head plus `return (tail)` is valid, so a split inside a string, comment or expression is never taken.
async fn last_expression_body(page: &Arc<TabPage>, context: &Option<String>, code: &str) -> Option<String> {
    let mut candidates: Vec<usize> = code.char_indices().filter(|(_, c)| *c == ';' || *c == '\n').map(|(i, _)| i + 1).collect();
    candidates.reverse();
    for split in candidates.into_iter().take(30) {
        let (head, tail) = code.split_at(split);
        let trimmed = tail.trim();
        if trimmed.is_empty() {
            continue;
        }
        let starts_with_keyword = STATEMENT_KEYWORDS.iter().any(|k| {
            trimmed.starts_with(k) && trimmed[k.len()..].chars().next().map(|c| !(c.is_alphanumeric() || c == '_' || c == '$')).unwrap_or(true)
        });
        let head_word = head.trim_end().trim_end_matches(';').rsplit(|c: char| !(c.is_alphanumeric() || c == '_' || c == '$')).next().unwrap_or("");
        if starts_with_keyword || matches!(head_word, "return" | "throw" | "else" | "do") {
            continue;
        }
        if compiles(page, context, &expression_body(tail)).await != Some(true) {
            continue;
        }
        let body = format!("\n{head}return ({tail}\n)");
        if compiles(page, context, &body).await == Some(true) {
            return Some(body);
        }
    }
    None
}

/// Whether the code has a `return` outside strings and comments (roughly: nested functions count too).
pub fn has_return(code: &str) -> bool {
    static STRIP: std::sync::OnceLock<regex_lite::Regex> = std::sync::OnceLock::new();
    let strip = STRIP.get_or_init(|| regex_lite::Regex::new(r#"(?s)"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`|//[^\n]*|/\*.*?\*/"#).unwrap());
    let stripped = strip.replace_all(code, " ");
    regex_lite::Regex::new(r"\breturn\b").unwrap().is_match(&stripped)
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

/// Runs the code as an expression when it parses as one; else as statements, returning the last statement's value
/// when it is an expression (like a console), or what the code `return`s.
/// `compile` is the frame to check the syntax in.
pub async fn run(page: &Arc<TabPage>, target: &Target, compile: Option<String>, expression: &str, arg: Option<&Value>, callable: bool) -> Result<Outcome> {
    let expression = expression.trim().trim_end_matches(';').trim_end();
    let known = compiles(page, &compile, &expression_body(expression)).await;
    let mut block = known == Some(false);
    let mut body = if block {
        match last_expression_body(page, &compile, expression).await {
            Some(body) => body,
            None => statements_body(expression),
        }
    } else {
        expression_body(expression)
    };
    let element = matches!(target, Target::Element { .. });
    loop {
        let result = page.send("Runtime.callFunctionOn", params(target, declaration(&body, callable, expression), arg), target.session()).await?;
        if let Some(details) = result.get("exceptionDetails") {
            // Without a syntax check, a SyntaxError means the code is statements; only then is a retry safe, since
            // a compile error runs nothing.
            let syntax = details["exception"]["className"] == "SyntaxError" && details["stackTrace"].is_null();
            if known.is_none() && syntax && !block {
                block = true;
                body = statements_body(expression);
                continue;
            }
            if element && details["exception"]["className"] == "ReferenceError" {
                bail!("{}. With ref or selector, expression must be a function called with the element, e.g. \"(el) => el.textContent\" or \"(el, arg) => …\"", exception_text(details, expression));
            }
            bail!("{}", exception_text(details, expression));
        }
        let value = &result["result"]["value"];
        if value["function"] == true {
            bail!("The expression evaluated to a function it doesn't define, which browse never calls on its own; call it yourself: (fn)(), or pass arg (or a ref/selector) to call it with them");
        }
        if value["notFunction"] == true {
            bail!("With {}, expression must be a function, called as (element, arg) => …; e.g. \"(el) => el.textContent\"", if element { "ref or selector" } else { "arg" });
        }
        if value["undefined"] == true {
            return Ok(Outcome::Undefined { block: block && !body.contains("return (") });
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

#[derive(Debug, PartialEq)]
pub enum Stop {
    /// The page answers: the code is only waiting (on a promise), nothing to stop.
    Idle,
    /// The running script was terminated and the page answers again.
    Stopped,
    /// The page still doesn't answer.
    Stuck,
}

async fn answers(page: &Arc<TabPage>, session: Option<&str>, within: Duration) -> bool {
    let probe = page.send_raw("Runtime.evaluate", json!({ "expression": "0", "returnByValue": true }), session);
    matches!(tokio::time::timeout(within, probe).await, Ok(Ok(_)))
}

/// After a timeout: when the page no longer answers (a busy loop), terminate the running script. Chrome handles
/// Runtime.terminateExecution on its IO thread even while JavaScript is busy; it goes to the tab's root session and
/// the frame's own session (an out-of-process iframe) at once, each without waiting on the other or on the stuck
/// call, and is repeated until the page answers.
pub async fn stop(page: &Arc<TabPage>, session: Option<&str>) -> Stop {
    if answers(page, session, Duration::from_millis(150)).await {
        return Stop::Idle;
    }
    for _ in 0..3 {
        let root = page.send_raw("Runtime.terminateExecution", json!({}), None);
        let frame = async {
            match session {
                Some(session) => page.send_raw("Runtime.terminateExecution", json!({}), Some(session)).await,
                None => Ok(Value::Null),
            }
        };
        let _ = tokio::time::timeout(Duration::from_millis(1_000), async { tokio::join!(root, frame) }).await;
        if answers(page, session, Duration::from_millis(1_000)).await {
            return Stop::Stopped;
        }
    }
    Stop::Stuck
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
        let to = page.pending_navigation().unwrap_or_else(|| page.main_url());
        anyhow!("The page navigated to {to} while eval ran, so its result is lost (the code may have run partly). Run it again on the new page if needed.")
    } else {
        anyhow!("The page's document changed while eval ran; run it again.")
    }
}

pub fn is_lost(error: &anyhow::Error) -> bool {
    is_context_lost(&error.to_string())
}
