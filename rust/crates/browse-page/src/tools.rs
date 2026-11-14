//! The page tools: typed, composable calls for agents scripting the browser from code.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Result, anyhow, bail};
use async_trait::async_trait;
use browse_core::{Tool, ToolContext, ToolOutput, ToolSpec};
use serde_json::{Map, Value, json};

use crate::actions::{self, PointerOptions};
use crate::aftermath::{self, AfterOptions};
use crate::human::Point;
use crate::input::{Input, Interrupted};
use crate::eval;
use crate::navigation::{self, NavResult, WaitUntil};
use crate::page::{Arg, DialogPolicy, ElementOr, TabPage, truncate, v};
use crate::snapshot;
use crate::state::{self, PageSession};
use crate::target::{self, ResolveOptions, Spec};

type Future_<'a> = Pin<Box<dyn Future<Output = Result<ToolOutput>> + Send + 'a>>;
type Handler = fn(ToolContext, Value) -> Future_<'static>;

struct PageTool {
    name: &'static str,
    description: &'static str,
    schema: fn() -> Value,
    handler: Handler,
}

#[async_trait]
impl Tool for PageTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec { name: self.name.into(), description: self.description.into(), input_schema: (self.schema)() }
    }

    async fn call(&self, ctx: ToolContext, args: Value) -> Result<ToolOutput> {
        let args = if args.is_null() { json!({}) } else { args };
        match (self.handler)(ctx, args).await {
            Ok(output) => Ok(output),
            Err(error) => Ok(ToolOutput::error(error.to_string())),
        }
    }
}

pub fn tools() -> Vec<Arc<dyn Tool>> {
    let list: Vec<PageTool> = vec![
        PageTool { name: "navigate", description: NAVIGATE, schema: navigate_schema, handler: |c, a| Box::pin(navigate(c, a)) },
        PageTool { name: "snapshot", description: SNAPSHOT, schema: snapshot_schema, handler: |c, a| Box::pin(snapshot_tool(c, a)) },
        PageTool { name: "click", description: CLICK, schema: click_schema, handler: |c, a| Box::pin(click(c, a)) },
        PageTool { name: "fill", description: FILL, schema: fill_schema, handler: |c, a| Box::pin(fill(c, a)) },
        PageTool { name: "type", description: TYPE, schema: type_schema, handler: |c, a| Box::pin(type_tool(c, a)) },
        PageTool { name: "press", description: PRESS, schema: press_schema, handler: |c, a| Box::pin(press(c, a)) },
        PageTool { name: "select", description: SELECT, schema: select_schema, handler: |c, a| Box::pin(select(c, a)) },
        PageTool { name: "hover", description: HOVER, schema: hover_schema, handler: |c, a| Box::pin(hover(c, a)) },
        PageTool { name: "drag", description: DRAG, schema: drag_schema, handler: |c, a| Box::pin(drag(c, a)) },
        PageTool { name: "scroll", description: SCROLL, schema: scroll_schema, handler: |c, a| Box::pin(scroll(c, a)) },
        PageTool { name: "eval", description: EVAL, schema: eval_schema, handler: |c, a| Box::pin(eval(c, a)) },
        PageTool { name: "wait_for", description: WAIT_FOR, schema: wait_for_schema, handler: |c, a| Box::pin(wait_for(c, a)) },
        PageTool { name: "dialog", description: DIALOG, schema: dialog_schema, handler: |c, a| Box::pin(dialog(c, a)) },
        PageTool { name: "upload", description: UPLOAD, schema: upload_schema, handler: |c, a| Box::pin(upload(c, a)) },
        PageTool { name: "emulate", description: EMULATE, schema: emulate_schema, handler: |c, a| Box::pin(emulate(c, a)) },
        PageTool { name: "webmcp", description: WEBMCP, schema: webmcp_schema, handler: |c, a| Box::pin(webmcp(c, a)) },
    ];
    list.into_iter().map(|tool| Arc::new(tool) as Arc<dyn Tool>).collect()
}

// Shared argument handling.

fn tab_arg(args: &Value) -> Option<i64> {
    args.get("tab").and_then(Value::as_i64)
}

fn timeout_arg(args: &Value, default_ms: u64) -> Duration {
    Duration::from_millis(args.get("timeout").and_then(Value::as_u64).unwrap_or(default_ms).clamp(0, 300_000))
}

fn str_arg<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key).and_then(Value::as_str)
}

fn bool_arg(args: &Value, key: &str) -> bool {
    args.get(key).and_then(Value::as_bool).unwrap_or(false)
}

const ACTION_TIMEOUT_MS: u64 = 10_000;

struct Ctx {
    ctx: ToolContext,
    session: Arc<PageSession>,
    page: Arc<TabPage>,
}

/// The session state and the tab to act on: `tab`, else the tab a ref belongs to, else the current tab.
async fn open(ctx: &ToolContext, args: &Value) -> Result<Ctx> {
    let session = state::session(ctx).await;
    let mut tab = tab_arg(args);
    if tab.is_none() && args.get("ref").and_then(Value::as_str).is_some() {
        tab = session.ref_tab();
    }
    let page = session.page(ctx, tab).await?;
    Ok(Ctx { ctx: ctx.clone(), session, page })
}

async fn human_enabled(ctx: &ToolContext, page: &TabPage) -> bool {
    match crate::human::override_from_env() {
        Some(value) => value,
        None => ctx.browser.human_input(&ctx.session, page.tab()).await,
    }
}

fn json_output(value: Value) -> ToolOutput {
    ToolOutput::text(serde_json::to_string_pretty(&value).unwrap_or_else(|_| value.to_string()))
}

fn result(base: Map<String, Value>, extra: Map<String, Value>) -> ToolOutput {
    let mut out = base;
    out.extend(extra);
    json_output(Value::Object(out))
}

fn map(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

/// Runs an input action, then reports what it changed. A dialog that opens mid-action ends the action normally.
async fn run_action<F>(c: &Ctx, options: AfterOptions, action: F) -> Result<ToolOutput>
where
    F: for<'a, 'b> FnOnce(&'a Ctx, &'a mut Input<'b>) -> Pin<Box<dyn Future<Output = Result<Map<String, Value>>> + Send + 'a>>,
{
    c.page.ensure_no_dialog()?;
    let before = aftermath::before(&c.ctx, &c.page).await;
    let human = human_enabled(&c.ctx, &c.page).await;
    let outcome = {
        let mut input = Input::new(&c.page, human).await;
        let outcome = action(c, &mut input).await;
        if outcome.as_ref().err().map(|e| e.downcast_ref::<Interrupted>().is_none()).unwrap_or(false) {
            input.reset().await;
        }
        outcome
    };
    let base = match outcome {
        Ok(base) => base,
        Err(error) if error.downcast_ref::<Interrupted>().is_some() => Map::new(),
        Err(error) => {
            c.page.release().await;
            return Err(error);
        }
    };
    let extra = aftermath::after(&c.ctx, &c.page, &before, options).await;
    c.page.release().await;
    Ok(result(base, extra))
}

fn pointer_options(args: &Value, enabled: bool) -> PointerOptions {
    PointerOptions {
        timeout: timeout_arg(args, ACTION_TIMEOUT_MS),
        force: bool_arg(args, "force"),
        position: args.get("position").and_then(|p| Some(Point { x: p.get("x")?.as_f64()?, y: p.get("y")?.as_f64()? })),
        hit_test: true,
        enabled,
    }
}

fn modifiers_arg(args: &Value) -> Vec<String> {
    args.get("modifiers").and_then(Value::as_array).map(|a| a.iter().filter_map(|m| m.as_str().map(str::to_string)).collect()).unwrap_or_default()
}

fn target_label(spec: &Spec, label: &str) -> Value {
    if label.is_empty() { json!(spec.label()) } else { json!(format!("{label} ({})", spec.label())) }
}

// navigate

async fn navigate(ctx: ToolContext, args: Value) -> Result<ToolOutput> {
    let c = open(&ctx, &args).await?;
    let action = str_arg(&args, "action").unwrap_or(if args.get("url").is_some() { "goto" } else { "" });
    let wait = WaitUntil::parse(str_arg(&args, "waitUntil"))?;
    let timeout = timeout_arg(&args, 30_000);
    // A beforeunload dialog (or one under an auto policy) is being answered in the background: let it finish.
    if c.page.dialog().is_some() && c.page.blocking_dialog().is_none() {
        c.page.wait_until(Duration::from_secs(3), Duration::from_millis(50), |page| page.dialog().is_none()).await;
    }
    c.page.ensure_no_dialog()?;
    let before = aftermath::before(&c.ctx, &c.page).await;
    let mut out = Map::new();
    let nav = match action {
        "goto" => {
            let url = str_arg(&args, "url").ok_or_else(|| anyhow!("navigate needs a url"))?;
            let url = navigation::normalize_url(url)?;
            Some(navigation::goto(&c.page, &url, wait, timeout, str_arg(&args, "referrer")).await?)
        }
        "back" | "forward" => {
            let nav = navigation::history(&c.page, if action == "back" { -1 } else { 1 }, wait, timeout).await?;
            if nav.is_none() {
                out.insert("note".into(), json!(format!("There is no page to go {action} to.")));
            }
            nav
        }
        "reload" => Some(navigation::reload(&c.page, wait, timeout, bool_arg(&args, "ignoreCache")).await?),
        "" => bail!("navigate needs a url, or action back, forward or reload"),
        other => bail!("action must be goto, back, forward or reload; got {other:?}"),
    };
    match &nav {
        Some(NavResult { pending: Some(pending), .. }) => {
            out.insert("pending".into(), json!(pending));
            out.insert(
                "warning".into(),
                json!(format!("The navigation to {pending} did not finish within {} ms; it is still loading, and the tab still shows {}.", timeout.as_millis(), c.page.main_url())),
            );
        }
        Some(NavResult { timed_out: true, .. }) => {
            out.insert("warning".into(), json!(format!("Timed out after {} ms waiting for {wait}; the page may still be loading.", timeout.as_millis())));
        }
        _ => {}
    }
    let extra = aftermath::describe(&c.ctx, &c.page, &before, AfterOptions::default()).await;
    let mut extra = extra;
    // While a navigation is pending Chrome holds commands for the page until it commits; don't wait on it.
    if c.page.dialog().is_none() && !extra.contains_key("title") && c.page.pending_navigation().is_none() {
        let main = c.page.main_frame();
        if let Ok(Ok(info)) = tokio::time::timeout(Duration::from_secs(2), c.page.call_value(&main, "frameInfo", vec![], false)).await {
            extra.insert("title".into(), info["title"].clone());
        }
    }
    if let Some(warning) = out.remove("warning") {
        extra.entry("warning").or_insert(warning);
    }
    out.extend(extra);
    c.page.release().await;
    Ok(json_output(Value::Object(out)))
}

// snapshot

async fn snapshot_tool(ctx: ToolContext, args: Value) -> Result<ToolOutput> {
    let c = open(&ctx, &args).await?;
    let options = snapshot::Options::from_args(&args);
    let output = snapshot::snapshot(&c.page, &c.session, &options).await;
    c.page.release().await;
    let text = output?;
    Ok(ToolOutput::text(if text.is_empty() { "(the page has nothing to show)".to_string() } else { text }))
}

// click / hover

async fn click(ctx: ToolContext, args: Value) -> Result<ToolOutput> {
    let c = open(&ctx, &args).await?;
    let spec = Spec::from_args(&args);
    let point = actions::point_arg(&args);
    if spec.is_none() && point.is_none() {
        bail!("click needs a ref, a selector, or x and y");
    }
    let button = str_arg(&args, "button").unwrap_or("left").to_string();
    if !matches!(button.as_str(), "left" | "right" | "middle") {
        bail!("button must be left, right or middle");
    }
    let count = args.get("clickCount").and_then(Value::as_i64).unwrap_or(if bool_arg(&args, "double") { 2 } else { 1 }).clamp(1, 3);
    let modifiers = modifiers_arg(&args);
    let options = pointer_options(&args, true);
    run_action(&c, AfterOptions::default(), move |c, input| {
        Box::pin(async move {
            let mut out = Map::new();
            let at = match (&spec, point) {
                (Some(spec), _) => {
                    let (resolved, at) = actions::locate(&c.page, &c.session, input, spec, options).await?;
                    out.insert("clicked".into(), target_label(spec, &resolved.label));
                    at
                }
                (None, Some(point)) => {
                    if let Some((width, height)) = input.viewport_size().await
                        && (point.x < 0.0 || point.y < 0.0 || point.x > width || point.y > height) {
                            bail!("x/y ({}, {}) is outside the viewport ({width}×{height} CSS pixels); x/y are viewport coordinates. Scroll first, or click a ref", point.x, point.y);
                        }
                    out.insert("clicked".into(), json!({ "x": point.x, "y": point.y }));
                    point
                }
                (None, None) => unreachable!(),
            };
            let held = actions::with_modifiers(input, &modifiers).await?;
            input.click(at, &button, count).await?;
            actions::release_modifiers(input, &held).await?;
            Ok(out)
        })
    })
    .await
}

async fn hover(ctx: ToolContext, args: Value) -> Result<ToolOutput> {
    let c = open(&ctx, &args).await?;
    let spec = Spec::from_args(&args);
    let point = actions::point_arg(&args);
    if spec.is_none() && point.is_none() {
        bail!("hover needs a ref, a selector, or x and y");
    }
    let options = pointer_options(&args, false);
    run_action(&c, AfterOptions { expect_navigation: false, ..AfterOptions::default() }, move |c, input| {
        Box::pin(async move {
            let mut out = Map::new();
            let at = match (&spec, point) {
                (Some(spec), _) => {
                    let (resolved, at) = actions::locate(&c.page, &c.session, input, spec, options).await?;
                    out.insert("hovered".into(), target_label(spec, &resolved.label));
                    at
                }
                (None, Some(point)) => point,
                (None, None) => unreachable!(),
            };
            input.move_to(at, 1).await?;
            Ok(out)
        })
    })
    .await
}

// fill

struct Field {
    spec: Spec,
    value: Option<String>,
    checked: Option<bool>,
}

fn parse_field(value: &Value) -> Result<Field> {
    let spec = Spec::from_args(value).ok_or_else(|| anyhow!("each field needs a ref or a selector"))?;
    let text = match value.get("value") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(s.clone()),
        Some(Value::Number(n)) => Some(n.to_string()),
        Some(Value::Bool(b)) => Some(b.to_string()),
        Some(_) => bail!("value must be a string"),
    };
    let checked = value.get("checked").and_then(Value::as_bool);
    if text.is_some() == checked.is_some() {
        bail!("give each field exactly one of value or checked ({})", spec.label());
    }
    Ok(Field { spec, value: text, checked })
}

async fn fill(ctx: ToolContext, args: Value) -> Result<ToolOutput> {
    let c = open(&ctx, &args).await?;
    let fields: Vec<Field> = match args.get("fields").and_then(Value::as_array) {
        Some(fields) => fields.iter().map(parse_field).collect::<Result<_>>()?,
        None => vec![parse_field(&args)?],
    };
    if fields.is_empty() {
        bail!("fill needs at least one field");
    }
    let timeout = timeout_arg(&args, ACTION_TIMEOUT_MS);
    let force = bool_arg(&args, "force");
    let submit = bool_arg(&args, "submit");
    run_action(&c, AfterOptions::default(), move |c, input| {
        Box::pin(async move {
            let mut filled: Vec<Value> = Vec::new();
            for field in &fields {
                match fill_one(c, input, field, timeout, force).await {
                    Ok(done) => filled.push(done),
                    Err(error) if fields.len() > 1 && error.downcast_ref::<Interrupted>().is_none() => {
                        let done: Vec<String> = filled.iter().map(|f| f["target"].as_str().map(str::to_string).unwrap_or_else(|| f["target"].to_string())).collect();
                        let before = if done.is_empty() { "No field was filled".to_string() } else { format!("Filled {}", done.join(", ")) };
                        bail!("{before}; then {} failed: {error}", field.spec.label());
                    }
                    Err(error) => return Err(error),
                }
            }
            if submit {
                input.press("Enter").await?;
            }
            let mut out = Map::new();
            out.insert("filled".into(), json!(filled));
            if submit {
                out.insert("submitted".into(), json!(true));
            }
            Ok(out)
        })
    })
    .await
}

async fn fill_one(c: &Ctx, input: &mut Input<'_>, field: &Field, timeout: Duration, force: bool) -> Result<Value> {
    let resolved = target::resolve(&c.page, &c.session, &field.spec, ResolveOptions { timeout, act: true }).await?;
    let label = target_label(&field.spec, &resolved.label);
    let kind = c.page.call_element(&resolved.element, "kind", vec![], false).await?;
    let kind = kind.as_str().unwrap_or("other").to_string();
    match kind.as_str() {
        "checkbox" | "radio" => {
            let desired = match (&field.checked, &field.value) {
                (Some(checked), _) => *checked,
                (None, Some(value)) => !matches!(value.to_ascii_lowercase().as_str(), "false" | "off" | "no" | "0" | "unchecked" | ""),
                (None, None) => bail!("{} is a {kind}; pass checked: true or false", label),
            };
            let current = c.page.call_element(&resolved.element, "isChecked", vec![], true).await?.as_bool().unwrap_or(false);
            if current != desired {
                if kind == "radio" && !desired {
                    bail!("{} is a radio button; check another option instead of unchecking it", label);
                }
                let (_, at) = actions::locate(&c.page, &c.session, input, &field.spec, PointerOptions { timeout, force, position: None, hit_test: true, enabled: true }).await?;
                input.click(at, "left", 1).await?;
                let now = c.page.call_element(&resolved.element, "isChecked", vec![], true).await.ok().and_then(|v| v.as_bool());
                if now == Some(current) {
                    bail!("Clicking {} did not change its checked state", label);
                }
            }
            Ok(json!({ "target": label, "checked": desired }))
        }
        "select" | "select-multiple" => {
            let value = field.value.as_ref().ok_or_else(|| anyhow!("{} is a select; pass the option's value or label as value", label))?;
            let selected = select_options(c, &resolved.element, &[json!({ "valueOrLabel": value })], timeout).await?;
            Ok(json!({ "target": label, "selected": selected }))
        }
        "file" => bail!("{} is a file input; use upload", label),
        _ => {
            if field.checked.is_some() {
                bail!("{} is not a checkbox; pass value instead of checked", label);
            }
            actions::wait_editable(&c.page, &resolved, timeout, force).await?;
            let text = field.value.clone().unwrap_or_default();
            let state = c.page.call_element(&resolved.element, "fill", vec![v(&text)], true).await?;
            match state.as_str() {
                Some("needsinput") => {
                    // Input goes to whatever has focus: make sure that is the field.
                    if c.page.call_element(&resolved.element, "isFocused", vec![], false).await?.as_bool() != Some(true) {
                        bail!("{} did not take focus (it may be disabled, hidden, covered or not editable), so nothing was typed", label);
                    }
                    if text.is_empty() {
                        input.press("Delete").await?;
                    } else {
                        input.insert_text(&text).await?;
                    }
                }
                Some("error:notconnected") => bail!("{} was removed from the page while filling it", label),
                _ => {}
            }
            let secret = c.page.call_element(&resolved.element, "isSecret", vec![], true).await.ok().and_then(|v| v.as_bool()).unwrap_or(false);
            if secret {
                return Ok(json!({ "target": label, "value": format!("[hidden: {} characters]", text.chars().count()) }));
            }
            Ok(json!({ "target": label, "value": truncate(&text, 80) }))
        }
    }
}

// type / press

async fn focus_target(c: &Ctx, input: &mut Input<'_>, args: &Value) -> Result<Option<Value>> {
    let Some(spec) = Spec::from_args(args) else { return Ok(None) };
    let timeout = timeout_arg(args, ACTION_TIMEOUT_MS);
    if input.human() {
        // A person clicks into the field before typing.
        let (resolved, at) = actions::locate(&c.page, &c.session, input, &spec, pointer_options(args, true)).await?;
        input.click(at, "left", 1).await?;
        let label = target_label(&spec, &resolved.label);
        if c.page.call_element(&resolved.element, "isFocused", vec![], false).await?.as_bool() != Some(true) {
            // The click didn't focus it (a custom widget, or the click landed on a non-focusable part): focus it.
            c.page.call_element(&resolved.element, "focusForTyping", vec![], true).await?;
            if c.page.call_element(&resolved.element, "isFocused", vec![], false).await?.as_bool() != Some(true) {
                bail!("{} did not take focus (it may be disabled or not focusable), so no keys were sent", label);
            }
        }
        return Ok(Some(label));
    }
    let resolved = target::resolve(&c.page, &c.session, &spec, ResolveOptions { timeout, act: true }).await?;
    let label = target_label(&spec, &resolved.label);
    let focused = c.page.call_element(&resolved.element, "focusForTyping", vec![], true).await?;
    if focused.as_str() == Some("error:notconnected") {
        bail!("{} was removed from the page", label);
    }
    // Keys go to whatever has focus: make sure that is the target.
    if c.page.call_element(&resolved.element, "isFocused", vec![], false).await?.as_bool() != Some(true) {
        bail!("{} did not take focus (it may be disabled, hidden or not focusable), so no keys were sent", label);
    }
    Ok(Some(label))
}

async fn type_tool(ctx: ToolContext, args: Value) -> Result<ToolOutput> {
    let c = open(&ctx, &args).await?;
    let text = str_arg(&args, "text").ok_or_else(|| anyhow!("type needs text"))?.to_string();
    let delay = args.get("delay").and_then(Value::as_f64).unwrap_or(0.0).clamp(0.0, 2_000.0);
    let submit = bool_arg(&args, "submit");
    run_action(&c, AfterOptions::default(), move |c, input| {
        Box::pin(async move {
            let mut out = Map::new();
            if let Some(target) = focus_target(c, input, &args).await? {
                out.insert("target".into(), target);
            }
            input.type_text(&text, delay).await?;
            if submit {
                input.press("Enter").await?;
            }
            out.insert("typed".into(), json!(text.chars().count()));
            Ok(out)
        })
    })
    .await
}

async fn press(ctx: ToolContext, args: Value) -> Result<ToolOutput> {
    let c = open(&ctx, &args).await?;
    let keys: Vec<String> = match args.get("key") {
        Some(Value::String(key)) => vec![key.clone()],
        Some(Value::Array(keys)) => keys.iter().filter_map(|k| k.as_str().map(str::to_string)).collect(),
        _ => bail!("press needs a key, like \"Enter\", \"Control+A\" or [\"Tab\", \"Tab\", \"Enter\"]"),
    };
    let count = args.get("count").and_then(Value::as_u64).unwrap_or(1).clamp(1, 100);
    run_action(&c, AfterOptions::default(), move |c, input| {
        Box::pin(async move {
            let mut out = Map::new();
            if let Some(target) = focus_target(c, input, &args).await? {
                out.insert("target".into(), target);
            }
            for _ in 0..count {
                for key in &keys {
                    input.press(key).await?;
                }
            }
            out.insert("pressed".into(), json!(keys));
            Ok(out)
        })
    })
    .await
}

// select

async fn select_options(c: &Ctx, element: &crate::page::Element, options: &[Value], timeout: Duration) -> Result<Value> {
    // Options that load late get a short wait; a select whose options are all there fails fast with them listed.
    let deadline = std::time::Instant::now() + timeout.min(Duration::from_millis(1_500));
    loop {
        let result = c.page.call_element(element, "selectOptions", vec![v(options)], true).await?;
        match result.as_str() {
            Some("error:optionsnotfound") if std::time::Instant::now() < deadline => {}
            Some("error:optionsnotfound") => {
                let available = c.page.call_element(element, "optionLabels", vec![], true).await.unwrap_or(Value::Null);
                let listed: Vec<String> = available
                    .as_array()
                    .map(|a| a.iter().map(|o| {
                        let (value, label) = (o["value"].as_str().unwrap_or(""), o["label"].as_str().unwrap_or(""));
                        let disabled = if o["disabled"] == true { " (disabled)" } else { "" };
                        if value == label { format!("{label:?}{disabled}") } else { format!("{label:?} (value {value:?}){disabled}") }
                    }).collect())
                    .unwrap_or_default();
                let wanted: Vec<String> = options.iter().map(|o| o.as_object().and_then(|m| m.values().next()).map(Value::to_string).unwrap_or_default()).collect();
                if listed.is_empty() {
                    bail!("No option matches {}; the select has no options", wanted.join(", "));
                }
                bail!("No option matches {}. Options: {}", wanted.join(", "), listed.join(", "));
            }
            Some("error:optionnotenabled") => bail!("The option is disabled"),
            Some("error:notconnected") => bail!("The select was removed from the page"),
            _ => return Ok(result),
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

async fn select(ctx: ToolContext, args: Value) -> Result<ToolOutput> {
    let c = open(&ctx, &args).await?;
    let spec = Spec::from_args(&args).ok_or_else(|| anyhow!("select needs a ref or a selector"))?;
    let values: Vec<Value> = match args.get("values").or_else(|| args.get("value")) {
        Some(Value::String(value)) => vec![json!(value)],
        Some(Value::Number(value)) => vec![json!(value.to_string())],
        Some(Value::Array(values)) => values.clone(),
        _ => bail!("select needs values: the option values or labels to select"),
    };
    let by = str_arg(&args, "by").unwrap_or("valueOrLabel").to_string();
    let options: Vec<Value> = values
        .iter()
        .map(|value| match by.as_str() {
            "index" => Ok(json!({ "index": value.as_u64().or_else(|| value.as_str().and_then(|s| s.parse().ok())).ok_or_else(|| anyhow!("index values must be numbers"))? })),
            "value" => Ok(json!({ "value": value.as_str().map(str::to_string).unwrap_or_else(|| value.to_string()) })),
            "label" => Ok(json!({ "label": value.as_str().map(str::to_string).unwrap_or_else(|| value.to_string()) })),
            _ => Ok(json!({ "valueOrLabel": value.as_str().map(str::to_string).unwrap_or_else(|| value.to_string()) })),
        })
        .collect::<Result<_>>()?;
    let timeout = timeout_arg(&args, ACTION_TIMEOUT_MS);
    run_action(&c, AfterOptions::default(), move |c, _input| {
        Box::pin(async move {
            let resolved = target::resolve(&c.page, &c.session, &spec, ResolveOptions { timeout, act: true }).await?;
            let selected = select_options(c, &resolved.element, &options, timeout).await?;
            let mut out = Map::new();
            out.insert("target".into(), target_label(&spec, &resolved.label));
            out.insert("selected".into(), selected);
            Ok(out)
        })
    })
    .await
}

// drag

fn endpoint(value: Option<&Value>, name: &str) -> Result<(Option<Spec>, Option<Point>)> {
    let value = value.ok_or_else(|| anyhow!("drag needs {name}: a ref, a selector, or x and y"))?;
    if let Some(r) = value.as_str() {
        return Ok((Some(if target::is_compact_ref(r) || target::parse_aria_ref(r).is_some() { Spec::Ref(r.into()) } else { Spec::Selector(r.into()) }), None));
    }
    let spec = Spec::from_args(value);
    let point = actions::point_arg(value);
    if spec.is_none() && point.is_none() {
        bail!("drag {name} needs a ref, a selector, or x and y");
    }
    Ok((spec, point))
}

async fn drag(ctx: ToolContext, args: Value) -> Result<ToolOutput> {
    let c = open(&ctx, &args).await?;
    let (from_spec, from_point) = endpoint(args.get("from"), "from")?;
    let (to_spec, to_point) = endpoint(args.get("to"), "to")?;
    let steps = args.get("steps").and_then(Value::as_u64).unwrap_or(10).clamp(1, 100) as usize;
    let options = pointer_options(&args, true);
    run_action(&c, AfterOptions::default(), move |c, input| {
        Box::pin(async move {
            let mut out = Map::new();
            let from = match &from_spec {
                Some(spec) => {
                    let (resolved, at) = actions::locate(&c.page, &c.session, input, spec, options).await?;
                    out.insert("from".into(), target_label(spec, &resolved.label));
                    at
                }
                None => from_point.unwrap(),
            };
            input.move_to(from, 1).await?;
            c.page.clear_drag();
            input.set_intercept_drags(true).await;
            input.down("left", 1).await?;
            let to = match &to_spec {
                Some(spec) => {
                    let (resolved, at) = actions::locate(&c.page, &c.session, input, spec, PointerOptions { hit_test: false, ..options }).await?;
                    out.insert("to".into(), target_label(spec, &resolved.label));
                    at
                }
                None => to_point.unwrap(),
            };
            // A first small move starts an HTML5 drag, which Chrome hands back as Input.dragIntercepted.
            let nudge = Point { x: from.x + (to.x - from.x).signum() * 5.0, y: from.y + (to.y - from.y).signum() * 5.0 };
            input.move_to(nudge, 1).await?;
            c.page.wait_until(Duration::from_millis(150), Duration::from_millis(25), |page| page.has_drag()).await;
            input.set_intercept_drags(false).await;
            if let Some(data) = c.page.take_drag() {
                input.move_to(to, steps).await?;
                input.dispatch_drag("dragEnter", to, &data).await?;
                input.dispatch_drag("dragOver", to, &data).await?;
                input.dispatch_drag("drop", to, &data).await?;
                input.up("left", 1).await?;
                out.insert("html5".into(), json!(true));
            } else {
                input.move_to(to, steps).await?;
                input.up("left", 1).await?;
            }
            Ok(out)
        })
    })
    .await
}

// scroll

async fn scroll(ctx: ToolContext, args: Value) -> Result<ToolOutput> {
    let c = open(&ctx, &args).await?;
    let spec = Spec::from_args(&args);
    let dx = args.get("deltaX").and_then(Value::as_f64).unwrap_or(0.0);
    let dy = args.get("deltaY").and_then(Value::as_f64).unwrap_or(0.0);
    let to = str_arg(&args, "to").map(str::to_string);
    if let Some(edge) = &to
        && !matches!(edge.as_str(), "top" | "bottom" | "left" | "right") {
            bail!("to must be top, bottom, left or right");
        }
    let timeout = timeout_arg(&args, ACTION_TIMEOUT_MS);
    run_action(&c, AfterOptions { expect_navigation: false, ..AfterOptions::default() }, move |c, input| {
        Box::pin(async move {
            let mut out = Map::new();
            let main = c.page.main_frame();
            let element = match &spec {
                Some(spec) => Some(target::resolve(&c.page, &c.session, spec, ResolveOptions { timeout, act: true }).await?),
                None => None,
            };
            if let Some(resolved) = &element {
                out.insert("target".into(), target_label(spec.as_ref().unwrap(), &resolved.label));
            }
            let frame = element.as_ref().map(|r| r.element.frame.clone()).unwrap_or_else(|| main.clone());
            if let Some(edge) = &to {
                let arg = element.as_ref().map(|r| Arg::Element(r.element.clone())).unwrap_or(Arg::Value(Value::Null));
                c.page.call_value(&frame, "scrollTo", vec![arg, v(edge)], false).await?;
            } else if dx != 0.0 || dy != 0.0 {
                let at = match &spec {
                    Some(spec) => {
                        let (_, at) = actions::locate(&c.page, &c.session, input, spec, PointerOptions { timeout, force: false, position: None, hit_test: false, enabled: false }).await?;
                        at
                    }
                    None => {
                        let vp = c.page.call_value(&main, "viewport", vec![], false).await?;
                        input.pointer().unwrap_or(Point { x: vp["width"].as_f64().unwrap_or(800.0) / 2.0, y: vp["height"].as_f64().unwrap_or(600.0) / 2.0 })
                    }
                };
                input.wheel(at, dx, dy).await?;
            } else if let Some(resolved) = &element {
                actions::scroll_into_view(&c.page, input, &resolved.element).await?;
            } else {
                bail!("scroll needs deltaX/deltaY, to, or a ref/selector to scroll into view");
            }
            // Report the scroll position of what was scrolled: the element when it scrolls itself, else its
            // document; sampled once smooth scrolling has settled.
            let scrolls_itself = match &element {
                Some(_) if to.is_some() => true,
                Some(resolved) if dx != 0.0 || dy != 0.0 => {
                    let state = c.page.call_element(&resolved.element, "scrollState", vec![], false).await?;
                    state["height"].as_f64().unwrap_or(0.0) > state["clientHeight"].as_f64().unwrap_or(0.0) + 1.0
                        || state["width"].as_f64().unwrap_or(0.0) > state["clientWidth"].as_f64().unwrap_or(0.0) + 1.0
                }
                _ => false,
            };
            let read = || async {
                match &element {
                    Some(resolved) if scrolls_itself => c.page.call_element(&resolved.element, "scrollState", vec![], false).await,
                    _ => c.page.call_value(&frame, "scrollState", vec![Arg::Value(Value::Null)], false).await,
                }
            };
            let settle_until = std::time::Instant::now() + Duration::from_millis(1_000);
            tokio::time::sleep(Duration::from_millis(50)).await;
            let mut state = read().await?;
            while std::time::Instant::now() < settle_until {
                tokio::time::sleep(Duration::from_millis(80)).await;
                let next = read().await?;
                let same = next["x"] == state["x"] && next["y"] == state["y"];
                state = next;
                if same {
                    break;
                }
            }
            let y = state["y"].as_f64().unwrap_or(0.0);
            let height = state["height"].as_f64().unwrap_or(0.0);
            let client = state["clientHeight"].as_f64().unwrap_or(0.0);
            out.insert("scrollX".into(), state["x"].clone());
            out.insert("scrollY".into(), json!(y));
            out.insert("scrollHeight".into(), json!(height));
            out.insert("viewportHeight".into(), json!(client));
            out.insert("atBottom".into(), json!(y + client >= height - 2.0));
            Ok(out)
        })
    })
    .await
}

// eval

const MAX_EVAL_CHARS: usize = 100_000;

async fn eval(ctx: ToolContext, args: Value) -> Result<ToolOutput> {
    let c = open(&ctx, &args).await?;
    let expression = str_arg(&args, "expression").ok_or_else(|| anyhow!("eval needs an expression"))?.to_string();
    let world = str_arg(&args, "world").unwrap_or("isolated");
    if !matches!(world, "isolated" | "main") {
        bail!("world must be isolated or main");
    }
    let main_world = world == "main";
    let timeout = timeout_arg(&args, 30_000);
    c.page.ensure_no_dialog()?;
    let spec = Spec::from_args(&args);
    let arg = args.get("arg").cloned();
    let element = match &spec {
        Some(spec) => Some(target::resolve(&c.page, &c.session, spec, ResolveOptions { timeout: timeout.min(Duration::from_millis(ACTION_TIMEOUT_MS)), act: false }).await?),
        None => None,
    };
    let frame = match (&element, str_arg(&args, "frame")) {
        (Some(resolved), _) => resolved.element.frame.clone(),
        (None, Some(selector)) => {
            let found = target::resolve(&c.page, &c.session, &Spec::Selector(selector.into()), ResolveOptions { timeout: Duration::from_millis(ACTION_TIMEOUT_MS), act: false }).await?;
            c.page.content_frame(&found.element, Duration::from_secs(5)).await?
        }
        (None, None) => c.page.main_frame(),
    };
    let page = c.page.clone();
    let callable = element.is_some() || arg.is_some();
    let generation = |page: &TabPage| page.frame(&page.main_frame()).map(|f| f.generation);
    let started_generation = generation(&page);
    let mut attempt = 0;
    let outcome = loop {
        attempt += 1;
        let run = async {
            let target = match &element {
                Some(resolved) => eval::element_target(&page, &resolved.element, main_world).await?,
                None => eval::frame_target(&page, &frame, main_world).await?,
            };
            let compile = page.world(&frame).await.ok().map(|w| (w.context_id, w.session));
            Ok::<_, anyhow::Error>((target, compile))
        };
        let (target, compile) = match run.await {
            Ok(ready) => ready,
            Err(error) if eval::is_lost(&error) && attempt < 2 && element.is_none() => continue,
            Err(error) => {
                c.page.release().await;
                return Err(error);
            }
        };
        let session_used = match &target {
            eval::Target::Element { session, .. } | eval::Target::Context { session, .. } | eval::Target::Object { session, .. } => session.clone(),
        };
        let result = tokio::time::timeout(timeout, eval::run(&page, &target, compile, &expression, arg.as_ref(), callable)).await;
        match result {
            Err(_) => {
                let stopped = eval::stop_if_busy(&page, session_used.as_deref()).await;
                c.page.release().await;
                if stopped {
                    bail!("eval timed out after {} ms; the script was still running, so browse stopped it", timeout.as_millis());
                }
                bail!("eval timed out after {} ms (the code may still finish in the page)", timeout.as_millis());
            }
            Ok(Err(error)) if eval::is_lost(&error) || error.to_string().contains("Inspected target navigated") => {
                let navigated = generation(&page) != started_generation;
                // A stale context that ran nothing: run it once more in a fresh one.
                if !navigated && attempt < 2 && element.is_none() {
                    continue;
                }
                c.page.release().await;
                return Err(eval::lost_context(&page, navigated));
            }
            Ok(other) => break other,
        }
    };
    c.page.release().await;
    let (value, hint) = match outcome? {
        eval::Outcome::Value(value) => (value, None),
        eval::Outcome::Undefined { block } => {
            let hint = (block && !expression.contains("return")).then_some(
                "The code ran as statements and returned nothing: statements must `return` their result (e.g. `const t = document.title; return t`).",
            );
            (Value::Null, hint)
        }
    };
    if let Some(hint) = hint {
        return Ok(json_output(json!({ "result": null, "hint": hint })));
    }
    let text = serde_json::to_string(&value).unwrap_or_else(|_| "null".into());
    let chars = text.chars().count();
    if chars > MAX_EVAL_CHARS {
        let cut: String = text.chars().take(MAX_EVAL_CHARS).collect();
        return Ok(ToolOutput::text(format!("{cut}\n… [truncated: the result is {chars} characters; return less, or pick the fields you need]", )));
    }
    Ok(ToolOutput::text(text))
}

// wait_for

async fn wait_for(ctx: ToolContext, args: Value) -> Result<ToolOutput> {
    let c = open(&ctx, &args).await?;
    let conditions = navigation::parse_wait_for(&args)?;
    if conditions.text.is_none() && conditions.text_gone.is_none() && conditions.url.is_none() && conditions.url_regex.is_none() && conditions.spec.is_none() && conditions.load.is_none() && conditions.ms.is_none() {
        bail!("wait_for needs a condition: text, textGone, url, urlRegex, ref or selector (with state), load, or ms");
    }
    let timeout = timeout_arg(&args, ACTION_TIMEOUT_MS);
    let started = std::time::Instant::now();
    let waited = navigation::wait_for(&c.page, &c.session, &conditions, timeout).await;
    c.page.release().await;
    let waited = waited?;
    let mut out = Map::new();
    out.insert("ok".into(), json!(true));
    if !waited.is_empty() {
        out.insert("waitedFor".into(), json!(waited));
    }
    out.insert("waitedMs".into(), json!(started.elapsed().as_millis() as u64));
    out.insert("url".into(), json!(c.page.main_url()));
    if let Some(dialog) = c.page.dialog() {
        out.insert("dialog".into(), json!({ "type": dialog.kind, "message": dialog.message, "pending": true }));
    }
    Ok(json_output(Value::Object(out)))
}

// dialog

async fn dialog(ctx: ToolContext, args: Value) -> Result<ToolOutput> {
    let c = open(&ctx, &args).await?;
    let action = str_arg(&args, "action").unwrap_or("status");
    let mut out = Map::new();
    if let Some(auto) = str_arg(&args, "auto") {
        let policy = match auto {
            "accept" => Some(DialogPolicy::Accept),
            "dismiss" => Some(DialogPolicy::Dismiss),
            "off" | "manual" => None,
            other => bail!("auto must be accept, dismiss or off; got {other:?}"),
        };
        let prompt_text = if policy == Some(DialogPolicy::Accept) { str_arg(&args, "promptText").map(str::to_string) } else { None };
        c.page.set_dialog_policy(policy, prompt_text);
        out.insert("auto".into(), json!(auto));
    }
    match action {
        "status" => {}
        "accept" | "dismiss" => {
            let before = aftermath::before(&c.ctx, &c.page).await;
            let handled = c.page.handle_dialog(action == "accept", str_arg(&args, "promptText")).await?;
            out.insert("handled".into(), json!({ "type": handled.kind, "message": handled.message, "action": action }));
            let extra = aftermath::after(&c.ctx, &c.page, &before, AfterOptions::default()).await;
            out.extend(extra);
            return Ok(json_output(Value::Object(out)));
        }
        other => bail!("action must be status, accept or dismiss; got {other:?}"),
    }
    match c.page.dialog() {
        Some(dialog) => {
            out.insert("dialog".into(), serde_json::to_value(dialog)?);
        }
        None => {
            out.insert("dialog".into(), Value::Null);
        }
    }
    out.insert("autoPolicy".into(), json!(match c.page.dialog_policy() { Some(DialogPolicy::Accept) => "accept", Some(DialogPolicy::Dismiss) => "dismiss", _ => "off" }));
    Ok(json_output(Value::Object(out)))
}

// upload

async fn upload(ctx: ToolContext, args: Value) -> Result<ToolOutput> {
    let c = open(&ctx, &args).await?;
    let spec = Spec::from_args(&args).ok_or_else(|| anyhow!("upload needs a ref or selector for the file input (or its label)"))?;
    let files: Vec<String> = match args.get("files") {
        Some(Value::String(file)) => vec![file.clone()],
        Some(Value::Array(files)) => files.iter().filter_map(|f| f.as_str().map(str::to_string)).collect(),
        _ => bail!("upload needs files: absolute paths inside the file roots"),
    };
    let checked: Vec<String> = files.iter().map(|f| crate::files::check_upload(f, &c.ctx.file_roots).map(|p| p.display().to_string())).collect::<Result<_>>()?;
    let timeout = timeout_arg(&args, ACTION_TIMEOUT_MS);
    run_action(&c, AfterOptions { expect_navigation: false, ..AfterOptions::default() }, move |c, _input| {
        Box::pin(async move {
            let resolved = target::resolve(&c.page, &c.session, &spec, ResolveOptions { timeout, act: true }).await?;
            let input = match c.page.call_element_result(&resolved.element.frame, "fileInput", vec![Arg::Element(resolved.element.clone())], true).await? {
                ElementOr::Element(element) => element,
                ElementOr::Status(_) => bail!("{} is not a file input (input[type=file]) or its label", target_label(&spec, &resolved.label)),
            };
            set_files(&c.page, &input, &checked).await?;
            let mut out = Map::new();
            out.insert("target".into(), target_label(&spec, &resolved.label));
            out.insert("files".into(), json!(checked.iter().map(|p| std::path::Path::new(p).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()).collect::<Vec<_>>()));
            Ok(out)
        })
    })
    .await
}

/// The most bytes one upload sends into the page.
const MAX_UPLOAD_BYTES: u64 = 50 * 1024 * 1024;
/// Raw bytes per chunk sent to the page (base64 makes each call about a third larger).
const UPLOAD_CHUNK: usize = 768 * 1024;

fn mime_type(path: &std::path::Path) -> &'static str {
    let extension = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    match extension.as_str() {
        "txt" | "log" => "text/plain",
        "csv" => "text/csv",
        "html" | "htm" => "text/html",
        "json" => "application/json",
        "xml" => "application/xml",
        "pdf" => "application/pdf",
        "zip" => "application/zip",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "heic" => "image/heic",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "doc" => "application/msword",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls" => "application/vnd.ms-excel",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "ppt" => "application/vnd.ms-powerpoint",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "md" => "text/markdown",
        _ => "",
    }
}

/// Puts files into a file input as in-memory File objects: browse reads them where it runs and sends the bytes,
/// so it works when the browser is on another machine and without the extension's file URL access.
async fn set_files(page: &Arc<TabPage>, input: &crate::page::Element, paths: &[String]) -> Result<()> {
    use base64::Engine;
    let mut total = 0u64;
    for path in paths {
        total += std::fs::metadata(path).map(|m| m.len()).map_err(|e| anyhow!("upload: {path}: {e}"))?;
    }
    if total > MAX_UPLOAD_BYTES {
        bail!("upload: the files are {:.1} MB together; browse uploads at most {} MB per call", total as f64 / 1_048_576.0, MAX_UPLOAD_BYTES / 1_048_576);
    }
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let mut files = Vec::new();
    let ids: Vec<String> = (0..paths.len()).map(|i| format!("{stamp:x}-{i}")).collect();
    let sent = async {
        for (path, id) in paths.iter().zip(&ids) {
            let bytes = tokio::fs::read(path).await.map_err(|e| anyhow!("upload: {path}: {e}"))?;
            for chunk in bytes.chunks(UPLOAD_CHUNK) {
                let encoded = base64::engine::general_purpose::STANDARD.encode(chunk);
                page.call_value(&input.frame, "uploadChunk", vec![v(id), v(encoded)], false).await?;
            }
            let path = std::path::Path::new(path);
            let modified = std::fs::metadata(path).and_then(|m| m.modified()).ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0);
            files.push(json!({
                "id": id,
                "name": path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
                "mime": mime_type(path),
                "lastModified": modified,
            }));
        }
        page.call_element(input, "uploadFinish", vec![v(&files)], false).await
    }
    .await;
    match sent {
        Ok(status) => match status.as_str() {
            Some("ok") => Ok(()),
            Some("not-multiple") => bail!("upload: the file input takes a single file (it has no `multiple` attribute); pass one file"),
            Some("disabled") => bail!("upload: the file input is disabled"),
            _ => bail!("upload: the page did not accept the files"),
        },
        Err(error) => {
            let _ = page.call_value(&input.frame, "uploadAbort", vec![v(&ids)], false).await;
            Err(error)
        }
    }
}

// emulate

/// Checks every emulate argument before anything changes.
fn validate_emulate(args: &Value) -> Result<()> {
    if args.get("permissions").is_some() {
        bail!("browse can't grant site permissions: that would answer a permission prompt the user never saw. Ask the user to allow it in the browser (handoff).");
    }
    for key in ["timezone", "locale"] {
        if args.get(key).is_some() {
            bail!("emulate can't set {key}: Chrome only allows timezone and locale overrides for trusted clients, not the browser extension browse drives it through.");
        }
    }
    let enums: [(&str, &[&str]); 5] = [
        ("colorScheme", &["light", "dark", "no-preference", "reset"]),
        ("reducedMotion", &["reduce", "no-preference", "reset"]),
        ("forcedColors", &["active", "none", "reset"]),
        ("contrast", &["more", "less", "no-preference", "custom", "reset"]),
        ("media", &["screen", "print", "reset"]),
    ];
    for (key, allowed) in enums {
        if let Some(value) = args.get(key) {
            match value.as_str() {
                Some(value) if allowed.contains(&value) => {}
                _ => bail!("{key} must be one of {}; got {value}", allowed.join(", ")),
            }
        }
    }
    match args.get("viewport") {
        None => {}
        Some(Value::String(s)) if s == "reset" => {}
        Some(Value::Object(viewport)) => {
            for key in ["width", "height"] {
                match viewport.get(key).and_then(Value::as_u64) {
                    Some(n) if (1..=10_000_000).contains(&n) => {}
                    _ => bail!("viewport {key} must be a positive integer (CSS pixels); got {}", viewport.get(key).map(Value::to_string).unwrap_or_else(|| "nothing".into())),
                }
            }
            if let Some(scale) = viewport.get("deviceScaleFactor")
                && !scale.as_f64().map(|s| (0.0..=10.0).contains(&s)).unwrap_or(false) {
                    bail!("viewport deviceScaleFactor must be a number from 0 (the screen's) to 10; got {scale}");
                }
            if let Some(mobile) = viewport.get("mobile")
                && !mobile.is_boolean() {
                    bail!("viewport mobile must be true or false");
                }
        }
        Some(other) => bail!("viewport must be {{ width, height }} or \"reset\"; got {other}"),
    }
    match args.get("geolocation") {
        None => {}
        Some(Value::String(s)) if s == "reset" => {}
        Some(Value::Object(geo)) => {
            let latitude = geo.get("latitude").and_then(Value::as_f64).filter(|l| (-90.0..=90.0).contains(l));
            let longitude = geo.get("longitude").and_then(Value::as_f64).filter(|l| (-180.0..=180.0).contains(l));
            if latitude.is_none() || longitude.is_none() {
                bail!("geolocation needs latitude (-90 to 90) and longitude (-180 to 180)");
            }
            if let Some(accuracy) = geo.get("accuracy")
                && !accuracy.as_f64().map(|a| a >= 0.0).unwrap_or(false) {
                    bail!("geolocation accuracy must be a non-negative number of meters");
                }
        }
        Some(other) => bail!("geolocation must be {{ latitude, longitude }} or \"reset\"; got {other}"),
    }
    for key in ["touch", "offline"] {
        if args.get(key).map(|v| !v.is_boolean()).unwrap_or(false) {
            bail!("{key} must be true or false");
        }
    }
    if let Some(agent) = args.get("userAgent")
        && !agent.as_str().map(|a| !a.trim().is_empty()).unwrap_or(false) {
            bail!("userAgent must be a non-empty string, or \"reset\"");
        }
    Ok(())
}

async fn emulate(ctx: ToolContext, args: Value) -> Result<ToolOutput> {
    let c = open(&ctx, &args).await?;
    let page = &c.page;
    validate_emulate(&args)?;
    let mut applied = Map::new();
    let mut failed = Map::new();
    let mut record = |key: &str, result: Result<Value>| match result {
        Ok(value) => {
            applied.insert(key.into(), value);
        }
        Err(error) => {
            failed.insert(key.into(), json!(error.to_string()));
        }
    };
    match args.get("viewport") {
        Some(Value::String(_)) => {
            let result = async {
                page.send("Emulation.clearDeviceMetricsOverride", json!({}), None).await?;
                // Chrome can drop a single clear that lands while the previous size is still settling.
                tokio::time::sleep(Duration::from_millis(100)).await;
                page.send("Emulation.clearDeviceMetricsOverride", json!({}), None).await?;
                Ok(json!("reset"))
            }
            .await;
            record("viewport", result);
        }
        Some(Value::Object(viewport)) => {
            let width = viewport["width"].as_u64().unwrap_or(0);
            let height = viewport["height"].as_u64().unwrap_or(0);
            let scale = viewport.get("deviceScaleFactor").and_then(Value::as_f64).unwrap_or(0.0);
            let mobile = viewport.get("mobile").and_then(Value::as_bool).unwrap_or(false);
            let settings = json!({ "width": width, "height": height, "deviceScaleFactor": scale, "mobile": mobile });
            let result = page.send("Emulation.setDeviceMetricsOverride", settings.clone(), None).await.map(|_| settings);
            record("viewport", result);
        }
        _ => {}
    }
    let media_keys = [("colorScheme", "prefers-color-scheme"), ("reducedMotion", "prefers-reduced-motion"), ("forcedColors", "forced-colors"), ("contrast", "prefers-contrast")];
    if media_keys.iter().any(|(key, _)| args.get(*key).is_some()) || args.get("media").is_some() {
        // Chrome replaces every emulated media feature on each call: merge with what this tab already has.
        let mut state = page.media_emulation();
        let mut changed = Vec::new();
        for (key, feature) in media_keys {
            if let Some(value) = str_arg(&args, key) {
                if value == "reset" {
                    state.features.remove(feature);
                } else {
                    state.features.insert(feature.into(), value.into());
                }
                changed.push((key, value));
            }
        }
        if let Some(media) = str_arg(&args, "media") {
            state.media = if media == "reset" { String::new() } else { media.into() };
            changed.push(("media", media));
        }
        let features: Vec<Value> = state.features.iter().map(|(name, value)| json!({ "name": name, "value": value })).collect();
        match page.send("Emulation.setEmulatedMedia", json!({ "media": state.media, "features": features }), None).await {
            Ok(_) => {
                page.set_media_emulation(state);
                for (key, value) in changed {
                    record(key, Ok(json!(value)));
                }
            }
            Err(error) => {
                for (key, _) in changed {
                    record(key, Err(anyhow!("{error}")));
                }
            }
        }
    }
    if let Some(agent) = str_arg(&args, "userAgent") {
        let value = if agent == "reset" { "" } else { agent };
        let result = page.send("Emulation.setUserAgentOverride", json!({ "userAgent": value }), None).await.map(|_| json!(agent));
        record("userAgent", result);
    }
    match args.get("geolocation") {
        Some(Value::String(_)) => {
            let result = page.send("Emulation.clearGeolocationOverride", json!({}), None).await.map(|_| json!("reset"));
            record("geolocation", result);
        }
        Some(Value::Object(geo)) => {
            let latitude = geo["latitude"].as_f64().unwrap_or(0.0);
            let longitude = geo["longitude"].as_f64().unwrap_or(0.0);
            let accuracy = geo.get("accuracy").and_then(Value::as_f64).unwrap_or(50.0);
            let result = page
                .send("Emulation.setGeolocationOverride", json!({ "latitude": latitude, "longitude": longitude, "accuracy": accuracy }), None)
                .await
                .map(|_| json!({ "latitude": latitude, "longitude": longitude, "accuracy": accuracy, "note": "the site still needs the user's location permission" }));
            record("geolocation", result);
        }
        _ => {}
    }
    if let Some(touch) = args.get("touch").and_then(Value::as_bool) {
        let result = page.send("Emulation.setTouchEmulationEnabled", json!({ "enabled": touch, "maxTouchPoints": if touch { 5 } else { 1 } }), None).await.map(|_| json!(touch));
        record("touch", result);
    }
    if let Some(offline) = args.get("offline").and_then(Value::as_bool) {
        let conditions = json!({ "offline": offline, "latency": 0, "downloadThroughput": -1, "uploadThroughput": -1 });
        let result = if offline {
            // Chrome applies network emulation only while the Network domain is enabled; enabling it again is
            // harmless, and the conditions are sent after it so they hold even if a disable reset them.
            let result = async {
                page.send("Network.enable", json!({}), None).await?;
                page.send("Network.emulateNetworkConditions", conditions, None).await
            }
            .await;
            if result.is_ok() {
                state::set_offline(&c.ctx, &c.session, page.tab(), true).await;
            }
            result
        } else {
            let _ = page.send("Network.emulateNetworkConditions", conditions, None).await;
            state::set_offline(&c.ctx, &c.session, page.tab(), false).await;
            if !state::network_capture_active(&c.ctx).await {
                let _ = page.send("Network.disable", json!({}), None).await;
            }
            Ok(Value::Null)
        };
        record("offline", result.map(|_| json!(offline)));
    }
    if applied.is_empty() && failed.is_empty() {
        bail!("emulate needs something to change: viewport, colorScheme, reducedMotion, forcedColors, contrast, media, userAgent, geolocation, touch or offline");
    }
    if applied.is_empty() {
        let reasons: Vec<String> = failed.iter().map(|(k, v)| format!("{k}: {}", v.as_str().unwrap_or(""))).collect();
        bail!("Chrome rejected every setting: {}", reasons.join("; "));
    }
    let mut out = json!({ "applied": applied });
    if !failed.is_empty() {
        out["failed"] = Value::Object(failed);
    }
    Ok(json_output(out))
}

// webmcp

const MAX_WEBMCP_TOOLS: usize = 100;

async fn webmcp(ctx: ToolContext, args: Value) -> Result<ToolOutput> {
    let c = open(&ctx, &args).await?;
    let action = str_arg(&args, "action").unwrap_or("list");
    let timeout = timeout_arg(&args, 5_000);
    c.page.ensure_no_dialog()?;
    let frames = c.page.frames();
    let mut counts = std::collections::HashMap::new();
    for frame in &frames {
        *counts.entry(frame.url.clone()).or_insert(0) += 1;
    }
    let mut available = false;
    let mut discovered: usize = 0;
    let mut tools: Vec<(String, bool, Value)> = Vec::new();
    for (index, frame) in frames.iter().enumerate() {
        let label = if counts[&frame.url] > 1 { format!("{} (frame {index})", frame.url) } else { frame.url.clone() };
        let listed = tokio::time::timeout(timeout, c.page.call_value(&frame.id, "webmcpList", vec![], false)).await;
        // A polyfill defines modelContext in the page's own world only; look there when browse's world has none.
        let (listed, main_world) = match listed {
            Ok(Ok(Value::Null)) => (tokio::time::timeout(timeout, webmcp_main_world(&c.page, &frame.id, "webmcpList", vec![])).await, true),
            other => (other, false),
        };
        let Ok(Ok(Value::Array(list))) = listed else { continue };
        available = true;
        for raw in list {
            discovered += 1;
            if tools.len() >= MAX_WEBMCP_TOOLS {
                continue;
            }
            let name = raw["name"].as_str().unwrap_or("").trim().to_string();
            if name.is_empty() {
                continue;
            }
            let mut tool = Map::new();
            tool.insert("name".into(), json!(name));
            if let Some(title) = raw["title"].as_str() {
                tool.insert("title".into(), json!(truncate(title, 200)));
            }
            tool.insert("description".into(), json!(raw["description"].as_str().unwrap_or("").chars().take(1_000).collect::<String>()));
            if let Some(schema) = raw.get("inputSchema").filter(|s| s.to_string().len() <= 32_000) {
                tool.insert("inputSchema".into(), schema.clone());
            }
            if let Some(annotations) = raw.get("annotations").filter(|a| a.as_object().map(|o| o.values().any(|v| v.as_bool() == Some(true))).unwrap_or(false)) {
                tool.insert("annotations".into(), annotations.clone());
            }
            if let Some(origin) = raw["origin"].as_str() {
                tool.insert("origin".into(), json!(origin));
            }
            tool.insert("frame".into(), json!(label));
            tool.insert("frameUrl".into(), json!(frame.url));
            if main_world {
                tool.insert("world".into(), json!("main"));
            }
            tools.push((frame.id.clone(), main_world, Value::Object(tool)));
        }
    }
    let result = match action {
        "list" => Ok(json_output(json!({ "available": available, "tools": tools.iter().map(|(_, _, t)| t).collect::<Vec<_>>(), "omitted": discovered.saturating_sub(MAX_WEBMCP_TOOLS) }))),
        "call" => {
            let name = str_arg(&args, "name").filter(|n| !n.trim().is_empty()).ok_or_else(|| anyhow!("webmcp call needs a tool name"))?;
            let frame_filter = str_arg(&args, "frame");
            let matches: Vec<&(String, bool, Value)> = tools
                .iter()
                .filter(|(_, _, t)| t["name"] == name && frame_filter.map(|f| t["frame"] == f || t["frameUrl"] == f).unwrap_or(true))
                .collect();
            if matches.is_empty() {
                let names: std::collections::BTreeSet<&str> = tools.iter().filter_map(|(_, _, t)| t["name"].as_str()).collect();
                let available = if names.is_empty() { " The page does not register any WebMCP tools.".to_string() } else { format!(" Available tools: {}.", names.into_iter().collect::<Vec<_>>().join(", ")) };
                bail!("No WebMCP tool named {name:?}{}.{available}", frame_filter.map(|f| format!(" in frame {f}")).unwrap_or_default());
            }
            if matches.len() > 1 {
                bail!("WebMCP tool {name:?} is registered in multiple frames; pass frame. Matching frames: {}", matches.iter().map(|(_, _, t)| t["frame"].as_str().unwrap_or("")).collect::<Vec<_>>().join(", "));
            }
            let (frame, main_world, _) = matches[0];
            let input = args.get("input").cloned().unwrap_or(json!({}));
            let input_json = serde_json::to_string(&input)?;
            let called = if *main_world {
                tokio::time::timeout(timeout, webmcp_main_world(&c.page, frame, "webmcpCall", vec![json!(name), json!(input_json)])).await
            } else {
                tokio::time::timeout(timeout, c.page.call_value(frame, "webmcpCall", vec![v(name), v(input_json)], false)).await
            };
            match called {
                Ok(Ok(value)) => Ok(ToolOutput::text(serde_json::to_string(&value).unwrap_or_else(|_| "null".into()))),
                Ok(Err(error)) => Err(error),
                Err(_) => Err(anyhow!("WebMCP tool {name:?} timed out after {} ms", timeout.as_millis())),
            }
        }
        other => Err(anyhow!("action must be list or call; got {other:?}")),
    };
    c.page.release().await;
    result
}

/// Runs one of the WebMCP helpers in the page's main world of `frame` (visible to the page; only used when the
/// isolated world has no modelContext).
async fn webmcp_main_world(page: &Arc<TabPage>, frame: &str, method: &str, args: Vec<Value>) -> Result<Value> {
    let source = page.call_value(frame, "methodSource", vec![v(method)], false).await?;
    let source = source.as_str().ok_or_else(|| anyhow!("browse could not read its WebMCP helper"))?;
    let document = page.document(frame).await?;
    let object = page.main_world_object(&document).await?;
    let declaration = format!("function (spec) {{ return ({{ {source} }}).{method}(...JSON.parse(spec)) }}");
    let result = page
        .send(
            "Runtime.callFunctionOn",
            json!({ "functionDeclaration": declaration, "objectId": object, "arguments": [{ "value": Value::Array(args).to_string() }], "returnByValue": true, "awaitPromise": true, "objectGroup": crate::page::TRANSIENT_GROUP }),
            document.session.as_deref(),
        )
        .await?;
    if let Some(details) = result.get("exceptionDetails") {
        bail!("{}", crate::page::exception_message(details));
    }
    Ok(result["result"].get("value").cloned().unwrap_or(Value::Null))
}

// Schemas and descriptions.

const TARGET_DOC: &str = "Address elements by `ref` from the latest snapshot (\"e12\"; \"a5\" / \"f1a5\" from an aria snapshot) or by `selector`: CSS, or Playwright selectors such as `role=button[name=\"Save\"]`, `text=Sign in`, `label=Email`, `placeholder=Search`, `testid=submit`, chained with `>>` (`form >> role=button`, `>> nth=0`). Enter an iframe with `iframe[title=\"Pay\"] >> frame >> role=button[name=\"Pay\"]`.";

fn tab_prop() -> Value {
    json!({ "type": "integer", "description": "Tab id. Defaults to the tab of `ref`, else the session's current tab." })
}

fn target_props(mut props: Map<String, Value>) -> Map<String, Value> {
    props.insert("ref".into(), json!({ "type": "string", "description": "Snapshot ref, e.g. \"e12\"." }));
    props.insert("selector".into(), json!({ "type": "string", "description": "CSS or Playwright selector, used when there is no ref. Must match exactly one element." }));
    props.insert("tab".into(), tab_prop());
    props
}

fn object(props: Map<String, Value>, required: &[&str]) -> Value {
    json!({ "type": "object", "properties": props, "required": required, "additionalProperties": false })
}

fn props(value: Value) -> Map<String, Value> {
    map(value)
}

const NAVIGATE: &str = "Go to a URL, or back/forward/reload, and wait for the page. Returns JSON: url, title, status (the HTTP status, when known), navigated, from, and when relevant redirects, pending (a navigation still loading when the timeout hit; url is what the tab shows meanwhile), dialog, newTabs, challenge (a bot check or block page was detected; follow its warning, usually handoff) and warning. An HTTP error status is a result, not a failure. A bare host gets https:// (\":3000\" means http://localhost:3000); URLs with a scheme are used as given, and javascript: URLs are refused (use eval). Navigations outside a session's domain allowlist are refused.";

fn navigate_schema() -> Value {
    object(
        props(json!({
            "url": { "type": "string", "description": "Where to go. Required for goto." },
            "action": { "type": "string", "enum": ["goto", "back", "forward", "reload"], "description": "Default goto when url is given." },
            "waitUntil": { "type": "string", "enum": ["load", "domcontentloaded", "settle", "commit", "none"], "description": "load (default); settle also waits for the network and DOM to go quiet (good before a snapshot of an app); commit returns once the new document starts." },
            "timeout": { "type": "integer", "description": "Milliseconds the whole navigation may take, including a slow server (default 30000). Timing out is a warning, not an error." },
            "referrer": { "type": "string" },
            "ignoreCache": { "type": "boolean", "description": "reload only." },
            "tab": tab_prop(),
        })),
        &[],
    )
}

const SNAPSHOT: &str = "A compact outline of the page for deciding what to do next: headings, landmarks, lists, tables, dialogs and every interactive element with a ref, e.g. `- button \"Save\" [ref=e12]`. Refs stay the same across snapshots while the element does, and are valid until the page navigates; pass them to click/fill/etc. Iframe content is nested under its iframe line and its refs work too. Auto-scopes to the open modal dialog, or to <main> (plus header controls) when there is one. Use find to grep (with context lines), diff/delta to see only what changed since the last snapshot, interactive to list only controls, within to scope to a ref or selector. mode \"aria\" returns Playwright's full ARIA tree instead (refs like a5).";

fn snapshot_schema() -> Value {
    object(
        props(json!({
            "within": { "type": "string", "description": "A ref (\"e12\") or selector to snapshot only that part. A selector with several matches uses the first visible one, with no match the whole page; either adds a note." },
            "interactive": { "type": "boolean", "description": "Only controls (and alerts), no headings or paragraphs." },
            "compact": { "type": "boolean", "description": "Collapse navigation, layout tables and redundant headings (default true)." },
            "find": { "type": "string", "description": "Only lines containing this text (case-insensitive), or matching /regex/flags, with context lines around them." },
            "context": { "type": "integer", "description": "Context lines around find matches (0-10, default 2)." },
            "diff": { "type": "boolean", "description": "Only +added / -removed lines versus the previous snapshot (same tab and options required)." },
            "delta": { "type": "boolean", "description": "Like diff when a compatible previous snapshot exists, else a full snapshot." },
            "depth": { "type": "integer", "description": "Heading/nesting depth (1-16, default 10)." },
            "maxItems": { "type": "integer", "description": "Most lines (1-200, default 80); important items are kept first." },
            "frames": { "type": "boolean", "description": "Include iframe content (default true)." },
            "mode": { "type": "string", "enum": ["compact", "aria"], "description": "compact (default) or aria (Playwright's ARIA snapshot in AI mode, with editable values redacted)." },
            "timeout": { "type": "integer", "description": "Milliseconds (default 10000)." },
            "tab": tab_prop(),
        })),
        &[],
    )
}

const CLICK: &str = "Click an element (or x/y in page CSS pixels). Waits until it is visible, enabled and not moving, scrolls it into view and checks nothing covers it: a covered target fails fast naming the element on top (dismiss it, or pass force). Returns JSON: clicked, url, and what changed: navigated/title, urlChanged, dialog (the page is paused until you call dialog), newTabs, challenge/warning.";

fn click_schema() -> Value {
    let mut p = target_props(props(json!({
        "x": { "type": "number" },
        "y": { "type": "number" },
        "button": { "type": "string", "enum": ["left", "right", "middle"] },
        "clickCount": { "type": "integer", "description": "2 for a double click." },
        "modifiers": { "type": "array", "items": { "type": "string", "enum": ["Shift", "Control", "Alt", "Meta", "ControlOrMeta"] }, "description": "Keys held during the click." },
        "position": { "type": "object", "properties": { "x": { "type": "number" }, "y": { "type": "number" } }, "description": "Click point relative to the element's top-left corner instead of its center." },
        "force": { "type": "boolean", "description": "Skip the visible/enabled/covered checks." },
        "timeout": { "type": "integer", "description": "Milliseconds to wait for the element (default 10000)." },
    })));
    p.insert("ref".into(), json!({ "type": "string", "description": TARGET_DOC }));
    object(p, &[])
}

const FILL: &str = "Fill form fields with trusted input, replacing what is there: text inputs, textareas and contenteditable get the value typed in; selects pick the option by value or label; checkboxes/radios/switches take checked. Fill one field with ref/selector + value|checked, or many with fields: [...]. submit presses Enter after the last field. Returns JSON: filled (per field) and what changed.";

fn fill_schema() -> Value {
    let field = json!({
        "type": "object",
        "properties": {
            "ref": { "type": "string" },
            "selector": { "type": "string" },
            "value": { "type": "string" },
            "checked": { "type": "boolean" },
        },
        "additionalProperties": false,
    });
    let mut p = target_props(props(json!({
        "value": { "type": "string" },
        "checked": { "type": "boolean", "description": "For a checkbox, radio or switch." },
        "fields": { "type": "array", "items": field, "description": "Several fields in order, instead of ref/selector + value." },
        "submit": { "type": "boolean", "description": "Press Enter after filling." },
        "force": { "type": "boolean" },
        "timeout": { "type": "integer" },
    })));
    p.insert("ref".into(), json!({ "type": "string", "description": TARGET_DOC }));
    object(p, &[])
}

const TYPE: &str = "Type text key by key into the focused element, or into ref/selector after focusing it (with human input on, it clicks into it first). Unlike fill it does not clear the field, and fires real key events; use it for search boxes with suggestions, editors and key handlers. submit presses Enter afterwards.";

fn type_schema() -> Value {
    object(
        target_props(props(json!({
            "text": { "type": "string" },
            "delay": { "type": "number", "description": "Extra milliseconds between keys." },
            "submit": { "type": "boolean", "description": "Press Enter after typing." },
            "timeout": { "type": "integer" },
        }))),
        &["text"],
    )
}

const PRESS: &str = "Press a key or shortcut on the focused element (or ref/selector after focusing it): \"Enter\", \"Escape\", \"Tab\", \"ArrowDown\", \"PageDown\", \"Control+A\", \"ControlOrMeta+K\", \"Shift+Tab\". key can be a list pressed in order; count repeats it.";

fn press_schema() -> Value {
    object(
        target_props(props(json!({
            "key": { "anyOf": [{ "type": "string" }, { "type": "array", "items": { "type": "string" } }] },
            "count": { "type": "integer", "description": "Repeat the key(s), e.g. 3 x ArrowDown." },
            "timeout": { "type": "integer" },
        }))),
        &["key"],
    )
}

const SELECT: &str = "Select option(s) of a <select> by value or label (by: \"value\", \"label\" or \"index\" to be strict). Several values for a multiple select. Returns the selected values. For custom dropdowns (role=combobox/listbox), click the control and then the option instead.";

fn select_schema() -> Value {
    object(
        target_props(props(json!({
            "values": { "anyOf": [{ "type": "string" }, { "type": "array", "items": { "type": ["string", "integer"] } }] },
            "by": { "type": "string", "enum": ["valueOrLabel", "value", "label", "index"] },
            "timeout": { "type": "integer" },
        }))),
        &["values"],
    )
}

const HOVER: &str = "Move the pointer over an element (or x/y) to open menus or tooltips; then snapshot to see what appeared.";

fn hover_schema() -> Value {
    object(
        target_props(props(json!({
            "x": { "type": "number" },
            "y": { "type": "number" },
            "position": { "type": "object", "properties": { "x": { "type": "number" }, "y": { "type": "number" } } },
            "force": { "type": "boolean" },
            "timeout": { "type": "integer" },
        }))),
        &[],
    )
}

const DRAG: &str = "Drag from one element or point to another with the mouse (HTML5 drag and drop included). from/to are a ref or selector string, or { ref | selector | x, y }.";

fn drag_schema() -> Value {
    let end = json!({ "anyOf": [{ "type": "string" }, { "type": "object", "properties": { "ref": { "type": "string" }, "selector": { "type": "string" }, "x": { "type": "number" }, "y": { "type": "number" } }, "additionalProperties": false }] });
    object(
        props(json!({
            "from": end,
            "to": end,
            "steps": { "type": "integer", "description": "Intermediate mouse moves (default 10)." },
            "force": { "type": "boolean" },
            "timeout": { "type": "integer" },
            "tab": tab_prop(),
        })),
        &["from", "to"],
    )
}

const SCROLL: &str = "Scroll with the mouse wheel by deltaX/deltaY pixels (over ref/selector, or the page), jump to an edge with to (\"top\", \"bottom\"; of the element when given), or scroll ref/selector into view. Returns scrollY, scrollHeight, viewportHeight and atBottom, so loops can stop at the end of an infinite list.";

fn scroll_schema() -> Value {
    object(
        target_props(props(json!({
            "deltaX": { "type": "number" },
            "deltaY": { "type": "number", "description": "Positive scrolls down." },
            "to": { "type": "string", "enum": ["top", "bottom", "left", "right"] },
            "timeout": { "type": "integer" },
        }))),
        &[],
    )
}

const EVAL: &str = "Run JavaScript in the page and return its result as JSON. An expression's value is returned (promises are awaited, await works); statements (const/let, loops, several lines) run as an async function body, so they must `return` their result. Declarations stay local to the call and never leak into the page. DOM nodes come back as \"<tag#id.class>\", Map as an object, Set as an array, Date as an ISO string, Errors as {name, message}, cycles as \"[Circular]\". A script still running at the timeout is stopped. By default it runs in browse's isolated world: it sees the DOM but not the page's own JS globals, and the page can't see it. world \"main\" runs in the page's own world (window variables, frameworks) and is visible to it. With ref/selector or arg, expression must be a function, called as (element, arg) => ...; e.g. expression \"(el) => el.href\" with ref \"e5\". frame (a selector of an <iframe>) runs in that frame. Results over 100k characters are cut.";

fn eval_schema() -> Value {
    object(
        target_props(props(json!({
            "expression": { "type": "string", "description": "An expression, statements whose last value is returned, or a function (element, arg) => ... when ref/selector/arg is given." },
            "arg": { "description": "A JSON value passed as the function's second argument." },
            "world": { "type": "string", "enum": ["isolated", "main"] },
            "frame": { "type": "string", "description": "Selector of an <iframe> to run in, when there is no ref." },
            "timeout": { "type": "integer", "description": "Milliseconds (default 30000)." },
        }))),
        &["expression"],
    )
}

const WAIT_FOR: &str = "Wait until conditions hold (all of them): text appears (or textGone disappears) in the page (case-insensitive and whitespace-normalized like Playwright's text=, unless exact), the url matches (url: a substring, a glob with * and **, or /regex/flags when the body uses regex syntax; urlRegex: a regular expression), ref/selector reaches state (visible by default, hidden, attached, detached), or the page reaches load (load, domcontentloaded, settle, or commit; a navigation in flight is waited for first). ms just sleeps first. Fails with what it was waiting for on timeout.";

fn wait_for_schema() -> Value {
    object(
        target_props(props(json!({
            "text": { "type": "string", "description": "Text that must appear; case-insensitive substring unless exact." },
            "textGone": { "type": "string" },
            "exact": { "type": "boolean", "description": "Match text/textGone exactly (case and whitespace)." },
            "url": { "type": "string", "description": "Substring (\"/checkout\" matches any URL containing it), glob (\"**/orders/*\"), or /regex/flags; it is a regex only when the part between the slashes uses regex syntax (\\ ^ $ * + ? ( ) [ ] { } |), so a path like /docs/us stays a substring." },
            "urlRegex": { "type": "string", "description": "A regular expression the URL must match, without slashes, e.g. \"/orders/\\d+$\". Prefix (?i) for case-insensitive." },
            "state": { "type": "string", "enum": ["visible", "hidden", "attached", "detached"] },
            "load": { "type": "string", "enum": ["load", "domcontentloaded", "settle", "commit"], "description": "commit waits for a navigation in flight to commit." },
            "ms": { "type": "integer", "description": "Sleep this long before checking." },
            "timeout": { "type": "integer", "description": "Milliseconds (default 10000)." },
        }))),
        &[],
    )
}

const DIALOG: &str = "Answer a JavaScript alert/confirm/prompt: action accept (with promptText for a prompt) or dismiss. While one is open the page is paused and other tools fail with its message. status shows the open dialog. auto: \"accept\" or \"dismiss\" answers future dialogs on the tab automatically (\"off\" to stop); beforeunload dialogs are always accepted.";

fn dialog_schema() -> Value {
    object(
        props(json!({
            "action": { "type": "string", "enum": ["status", "accept", "dismiss"] },
            "promptText": { "type": "string", "description": "The answer to a prompt() dialog, for action accept or with auto \"accept\"." },
            "auto": { "type": "string", "enum": ["accept", "dismiss", "off"] },
            "tab": tab_prop(),
        })),
        &[],
    )
}

const UPLOAD: &str = "Set the files of a file input (input[type=file], or its label) without opening the file chooser. files are absolute paths inside browse's file roots, on the machine browse runs on; browse reads them and hands the page in-memory copies (with input and change events), so the browser may be elsewhere. At most 50 MB per call.";

fn upload_schema() -> Value {
    object(
        target_props(props(json!({
            "files": { "anyOf": [{ "type": "string" }, { "type": "array", "items": { "type": "string" } }] },
            "timeout": { "type": "integer" },
        }))),
        &["files"],
    )
}

const EMULATE: &str = "Change how the tab presents itself: viewport { width, height, deviceScaleFactor, mobile } (or \"reset\"), colorScheme, reducedMotion, forcedColors, contrast, media (\"print\"), userAgent, geolocation { latitude, longitude } (the site still needs the user's permission), touch, offline. \"reset\" restores a setting. Permissions can't be granted.";

fn emulate_schema() -> Value {
    object(
        props(json!({
            "viewport": { "anyOf": [{ "type": "string", "enum": ["reset"] }, { "type": "object", "properties": { "width": { "type": "integer" }, "height": { "type": "integer" }, "deviceScaleFactor": { "type": "number" }, "mobile": { "type": "boolean" } }, "required": ["width", "height"] }] },
            "colorScheme": { "type": "string", "enum": ["light", "dark", "no-preference", "reset"] },
            "reducedMotion": { "type": "string", "enum": ["reduce", "no-preference", "reset"] },
            "forcedColors": { "type": "string", "enum": ["active", "none", "reset"] },
            "contrast": { "type": "string", "enum": ["more", "less", "no-preference", "custom", "reset"] },
            "media": { "type": "string", "enum": ["screen", "print", "reset"] },
            "userAgent": { "type": "string" },
            "geolocation": { "anyOf": [{ "type": "string", "enum": ["reset"] }, { "type": "object", "properties": { "latitude": { "type": "number" }, "longitude": { "type": "number" }, "accuracy": { "type": "number" } }, "required": ["latitude", "longitude"] }] },
            "touch": { "type": "boolean" },
            "offline": { "type": "boolean" },
            "tab": tab_prop(),
        })),
        &[],
    )
}

const WEBMCP: &str = "Use tools the page itself offers through WebMCP (navigator.modelContext), in any frame. action list returns { available, tools: [{ name, description, inputSchema, frame }] }; action call runs one by name with input and returns its result. Prefer a site's WebMCP tool over clicking when it does what you need. Tools are read in browse's isolated world; when a page defines modelContext only in its own world (a polyfill), browse reads and calls them there, which the page can observe (such tools show world \"main\").";

fn webmcp_schema() -> Value {
    object(
        props(json!({
            "action": { "type": "string", "enum": ["list", "call"] },
            "name": { "type": "string" },
            "input": { "type": "object" },
            "frame": { "type": "string", "description": "When a tool name exists in several frames: the frame label or URL from list." },
            "timeout": { "type": "integer", "description": "Milliseconds (default 5000)." },
            "tab": tab_prop(),
        })),
        &[],
    )
}
