//! Input over `input.performActions`.
//!
//! - Pointer and wheel input goes to the browsing context under the pointer: Firefox delivers actions sent to a page
//!   no further than the `<iframe>` element of a cross-origin frame, so the driver hit-tests and re-targets them into
//!   the frame (in its own coordinates). While a button is held, the route chosen by the press is kept.
//! - Keys and text go to the context holding focus (following focused `<iframe>`s down).
//! - A press is held back until its release, and both go out in one `input.performActions` (with the time between
//!   them as a pause): Firefox only counts consecutive clicks (`dblclick`) within one action sequence.

use std::sync::Arc;
use std::time::{Duration, Instant};

use browse_core::{DragOutcome, DriverError, DriverResult, FrameId, KeyEvent, Modifiers, MouseButton, PointerEvent, PointerStep};
use serde_json::{Value, json};

use crate::tab::Shared;

const HIT_TIMEOUT: Duration = Duration::from_secs(2);
/// A press with no release by then is sent on its own, so the page sees it.
const LONE_PRESS: Duration = Duration::from_millis(1_000);
const MAX_HOLD_MS: u128 = 10_000;
const MAX_FRAME_DEPTH: usize = 8;

/// Where pointer input goes: a browsing context and the offset of its viewport in the page's.
#[derive(Debug, Clone)]
pub(crate) struct Route {
    context: FrameId,
    dx: f64,
    dy: f64,
    width: f64,
    height: f64,
}

impl Route {
    fn top(top: &FrameId) -> Route {
        Route { context: top.clone(), dx: 0.0, dy: 0.0, width: f64::INFINITY, height: f64::INFINITY }
    }

    /// Page coordinates in this context's viewport, kept inside it (Firefox refuses moves outside the viewport).
    fn local(&self, x: f64, y: f64) -> (f64, f64) {
        (clamp(x - self.dx, self.width), clamp(y - self.dy, self.height))
    }
}

fn clamp(value: f64, extent: f64) -> f64 {
    let max = if extent.is_finite() { (extent - 1.0).max(0.0) } else { f64::MAX };
    let value = if value.is_finite() { value } else { 0.0 };
    value.max(0.0).min(max)
}

#[derive(Debug)]
struct Press {
    seq: u64,
    at: Instant,
    route: Route,
    button: u8,
    x: f64,
    y: f64,
}

#[derive(Debug, Default)]
pub(crate) struct InputState {
    press: Option<Press>,
    held: Option<Route>,
    wheel: (f64, f64),
    seq: u64,
    /// Where the pointer last went: a move to the same spot would reset Firefox's click count.
    at: Option<(FrameId, f64, f64)>,
}

impl InputState {
    /// A move to `(x, y)` in `context`, unless the pointer is already there.
    fn move_to(&mut self, context: &FrameId, x: f64, y: f64) -> Option<Value> {
        let here = Some((context.clone(), x, y));
        if self.at == here {
            return None;
        }
        self.at = here;
        Some(move_to(x, y, 0))
    }
}

pub(crate) fn button_code(button: MouseButton) -> Option<u8> {
    match button {
        MouseButton::Left => Some(0),
        MouseButton::Middle => Some(1),
        MouseButton::Right => Some(2),
        MouseButton::Back => Some(3),
        MouseButton::Forward => Some(4),
        MouseButton::None => None,
    }
}

fn mouse(actions: Vec<Value>) -> Value {
    json!({ "type": "pointer", "id": "mouse", "parameters": { "pointerType": "mouse" }, "actions": actions })
}

fn move_to(x: f64, y: f64, duration: u64) -> Value {
    json!({ "type": "pointerMove", "x": x, "y": y, "duration": duration, "origin": "viewport" })
}

fn button_action(kind: &str, button: u8) -> Value {
    json!({ "type": kind, "button": button })
}

fn keyboard(actions: Vec<Value>) -> Value {
    json!({ "type": "key", "id": "keyboard", "actions": actions })
}

fn window_context(value: &Value) -> Option<&str> {
    (value.get("type").and_then(Value::as_str) == Some("window"))
        .then(|| value.pointer("/value/context").and_then(Value::as_str))
        .flatten()
}

async fn perform(shared: &Shared, context: &FrameId, actions: Vec<Value>) -> DriverResult<()> {
    match shared
        .transport
        .send("input.performActions", json!({ "context": context.as_str(), "actions": actions }))
        .await
    {
        Ok(_) => Ok(()),
        Err(error) if error.code() == Some("move target out of bounds") => {
            Err(DriverError::Protocol(format!("the pointer can't go there: {}", error.message())))
        }
        Err(error) => Err(shared.frame_error(error, context)),
    }
}

const HIT_TEST: &str = "function (x, y) { const w = innerWidth, h = innerHeight; const cx = Math.min(Math.max(x, 0), Math.max(w - 1, 0)), cy = Math.min(Math.max(y, 0), Math.max(h - 1, 0)); let el = document.elementFromPoint(cx, cy); while (el && el.shadowRoot) { const inner = el.shadowRoot.elementFromPoint(cx, cy); if (!inner || inner === el) break; el = inner; } if (el && (el.localName === \"iframe\" || el.localName === \"frame\") && el.contentWindow) { const r = el.getBoundingClientRect(), s = getComputedStyle(el); return [w, h, el.contentWindow, r.left + el.clientLeft + (parseFloat(s.paddingLeft) || 0), r.top + el.clientTop + (parseFloat(s.paddingTop) || 0)]; } return [w, h]; }";

const FOCUSED: &str = "function () { let el = document.activeElement; while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement; return el && (el.localName === \"iframe\" || el.localName === \"frame\") ? el.contentWindow : null; }";

const INSERT_TEXT: &str = "function (text) { return document.execCommand(\"insertText\", false, text); }";

const DRAGGABLE: &str = "function (x, y) { let el = document.elementFromPoint(x, y); while (el && !el.draggable) el = el.parentElement; return !!el; }";

/// HTML5 drag and drop with one shared `DataTransfer`: synthetic, because Firefox never ends a native drag that
/// `input.performActions` starts.
const SYNTHETIC_DRAG: &str = "function (fx, fy, tx, ty) { const at = (x, y) => document.elementFromPoint(x, y); let src = at(fx, fy); while (src && !src.draggable) src = src.parentElement; if (!src) return \"not-draggable\"; const dt = new DataTransfer(); const fire = (el, type, x, y) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, dataTransfer: dt })); if (!fire(src, \"dragstart\", fx, fy)) return \"cancelled\"; const dst = at(tx, ty) || document.body; fire(dst, \"dragenter\", tx, ty); const accepted = !fire(dst, \"dragover\", tx, ty); if (accepted) fire(dst, \"drop\", tx, ty); fire(src, \"dragend\", tx, ty); return accepted ? \"dropped\" : \"rejected\"; }";

/// The context under page point `(x, y)`, descending into iframes.
async fn route(shared: &Shared, x: f64, y: f64) -> Route {
    let mut route = Route::top(&shared.top);
    for _ in 0..MAX_FRAME_DEPTH {
        let (lx, ly) = (x - route.dx, y - route.dy);
        let Ok(Ok(result)) =
            tokio::time::timeout(HIT_TIMEOUT, shared.sandbox_call(&route.context, HIT_TEST, &[json!(lx), json!(ly)])).await
        else {
            break;
        };
        let Some(items) = result.get("value").and_then(Value::as_array) else { break };
        let number = |index: usize| items.get(index).and_then(|v| v.get("value")).and_then(Value::as_f64);
        if let (Some(width), Some(height)) = (number(0), number(1)) {
            route.width = width;
            route.height = height;
        }
        let Some(child) = items.get(2).and_then(window_context) else { break };
        if !shared.belongs(child) {
            break;
        }
        route = Route {
            context: FrameId::from(child),
            dx: route.dx + number(3).unwrap_or(0.0),
            dy: route.dy + number(4).unwrap_or(0.0),
            width: f64::INFINITY,
            height: f64::INFINITY,
        };
    }
    route
}

/// The context holding keyboard focus.
async fn focused(shared: &Shared) -> FrameId {
    let mut context = shared.top.clone();
    for _ in 0..MAX_FRAME_DEPTH {
        let Ok(Ok(result)) = tokio::time::timeout(HIT_TIMEOUT, shared.sandbox_call(&context, FOCUSED, &[])).await else {
            break;
        };
        let Some(child) = window_context(&result) else { break };
        if !shared.belongs(child) {
            break;
        }
        context = FrameId::from(child);
    }
    context
}

/// Sends a held-back press on its own.
async fn flush(shared: &Shared) -> DriverResult<()> {
    let press = shared.input.lock().unwrap().press.take();
    match press {
        Some(press) => send_press(shared, press).await,
        None => Ok(()),
    }
}

async fn send_press(shared: &Shared, press: Press) -> DriverResult<()> {
    let mut actions: Vec<Value> = shared.input.lock().unwrap().move_to(&press.route.context, press.x, press.y).into_iter().collect();
    actions.push(button_action("pointerDown", press.button));
    perform(shared, &press.route.context, vec![mouse(actions)]).await
}

pub(crate) async fn pointer(shared: &Arc<Shared>, event: PointerEvent) -> DriverResult<()> {
    match event {
        PointerEvent::Move { x, y, .. } => {
            flush(shared).await?;
            let held = shared.input.lock().unwrap().held.clone();
            let route = match held {
                Some(route) => route,
                None => route(shared, x, y).await,
            };
            let (x, y) = route.local(x, y);
            let Some(step) = shared.input.lock().unwrap().move_to(&route.context, x, y) else { return Ok(()) };
            perform(shared, &route.context, vec![mouse(vec![step])]).await
        }
        PointerEvent::Down { x, y, button, .. } => {
            flush(shared).await?;
            let Some(button) = button_code(button) else { return Ok(()) };
            let route = route(shared, x, y).await;
            let (lx, ly) = route.local(x, y);
            let seq = {
                let mut state = shared.input.lock().unwrap();
                state.seq += 1;
                let seq = state.seq;
                state.held = Some(route.clone());
                state.press = Some(Press { seq, at: Instant::now(), route, button, x: lx, y: ly });
                seq
            };
            let weak = Arc::downgrade(shared);
            tokio::spawn(async move {
                tokio::time::sleep(LONE_PRESS).await;
                let Some(shared) = weak.upgrade() else { return };
                let press = {
                    let mut state = shared.input.lock().unwrap();
                    match state.press.take() {
                        Some(press) if press.seq == seq => Some(press),
                        other => {
                            state.press = other;
                            None
                        }
                    }
                };
                if let Some(press) = press {
                    let _ = send_press(&shared, press).await;
                }
            });
            Ok(())
        }
        PointerEvent::Up { x, y, button, .. } => {
            let Some(button) = button_code(button) else { return Ok(()) };
            let press = {
                let mut state = shared.input.lock().unwrap();
                match state.press.take() {
                    Some(press) if press.button == button => {
                        state.held = None;
                        Some(press)
                    }
                    other => {
                        state.press = other;
                        None
                    }
                }
            };
            if let Some(press) = press {
                let hold = press.at.elapsed().as_millis().min(MAX_HOLD_MS) as u64;
                let mut actions: Vec<Value> =
                    shared.input.lock().unwrap().move_to(&press.route.context, press.x, press.y).into_iter().collect();
                actions.extend([
                    button_action("pointerDown", button),
                    json!({ "type": "pause", "duration": hold }),
                    button_action("pointerUp", button),
                ]);
                return perform(shared, &press.route.context, vec![mouse(actions)]).await;
            }
            flush(shared).await?;
            let held = shared.input.lock().unwrap().held.take();
            let route = match held {
                Some(route) => route,
                None => route(shared, x, y).await,
            };
            let (x, y) = route.local(x, y);
            let mut actions: Vec<Value> = shared.input.lock().unwrap().move_to(&route.context, x, y).into_iter().collect();
            actions.push(button_action("pointerUp", button));
            perform(shared, &route.context, vec![mouse(actions)]).await
        }
        PointerEvent::Wheel { x, y, delta_x, delta_y, .. } => {
            flush(shared).await?;
            let (dx, dy) = {
                let mut state = shared.input.lock().unwrap();
                let total = (delta_x + state.wheel.0, delta_y + state.wheel.1);
                let rounded = (total.0.round(), total.1.round());
                state.wheel = (total.0 - rounded.0, total.1 - rounded.1);
                rounded
            };
            if dx == 0.0 && dy == 0.0 {
                return Ok(());
            }
            let held = shared.input.lock().unwrap().held.clone();
            let route = match held {
                Some(route) => route,
                None => route(shared, x, y).await,
            };
            let (lx, ly) = route.local(x.round(), y.round());
            let scroll = json!({
                "type": "scroll",
                "x": lx.floor() as i64,
                "y": ly.floor() as i64,
                "deltaX": dx as i64,
                "deltaY": dy as i64,
                "duration": 0,
                "origin": "viewport",
            });
            perform(shared, &route.context, vec![json!({ "type": "wheel", "id": "wheel", "actions": [scroll] })]).await
        }
    }
}

/// The WebDriver key value for a DOM key: one code point as is, named keys from the WebDriver key table.
pub(crate) fn key_value(event: &KeyEvent) -> DriverResult<String> {
    let key = event.key.as_str();
    let code = event.code.as_str();
    if code.starts_with("Numpad") && key.chars().count() == 1 {
        let c = key.chars().next().unwrap_or_default();
        let numpad = match c {
            '0'..='9' => char::from_u32(0xE01A + (c as u32 - '0' as u32)),
            '*' => Some('\u{E024}'),
            '+' => Some('\u{E025}'),
            ',' => Some('\u{E026}'),
            '-' => Some('\u{E027}'),
            '.' => Some('\u{E028}'),
            '/' => Some('\u{E029}'),
            _ => None,
        };
        if let Some(numpad) = numpad {
            return Ok(numpad.to_string());
        }
    }
    let named = match key {
        "Shift" => Some(if code == "ShiftRight" { '\u{E050}' } else { '\u{E008}' }),
        "Control" => Some(if code == "ControlRight" { '\u{E051}' } else { '\u{E009}' }),
        "Alt" => Some(if code == "AltRight" { '\u{E052}' } else { '\u{E00A}' }),
        "Meta" => Some(if code == "MetaRight" { '\u{E053}' } else { '\u{E03D}' }),
        // WebDriver's U+E006 is Return (code "Enter"); U+E007 is the keypad's Enter (code "NumpadEnter").
        "Enter" => Some(if code == "NumpadEnter" { '\u{E007}' } else { '\u{E006}' }),
        "Cancel" => Some('\u{E001}'),
        "Help" => Some('\u{E002}'),
        "Backspace" => Some('\u{E003}'),
        "Tab" => Some('\u{E004}'),
        "Clear" => Some('\u{E005}'),
        "Pause" => Some('\u{E00B}'),
        "Escape" => Some('\u{E00C}'),
        "PageUp" => Some('\u{E00E}'),
        "PageDown" => Some('\u{E00F}'),
        "End" => Some('\u{E010}'),
        "Home" => Some('\u{E011}'),
        "ArrowLeft" => Some('\u{E012}'),
        "ArrowUp" => Some('\u{E013}'),
        "ArrowRight" => Some('\u{E014}'),
        "ArrowDown" => Some('\u{E015}'),
        "Insert" => Some('\u{E016}'),
        "Delete" => Some('\u{E017}'),
        "CapsLock" => return Err(DriverError::Unsupported("the CapsLock key")),
        "ContextMenu" => return Err(DriverError::Unsupported("the ContextMenu key")),
        _ => None,
    };
    if let Some(named) = named {
        return Ok(named.to_string());
    }
    if let Some(number) = key.strip_prefix('F').and_then(|n| n.parse::<u32>().ok())
        && (1..=12).contains(&number)
    {
        return Ok(char::from_u32(0xE031 + number - 1).unwrap_or_default().to_string());
    }
    let mut chars = key.chars();
    match (chars.next(), chars.next()) {
        (Some(c), None) => Ok(c.to_string()),
        _ => Err(DriverError::Unsupported("this key")),
    }
}

pub(crate) async fn key(shared: &Arc<Shared>, event: &KeyEvent) -> DriverResult<()> {
    flush(shared).await?;
    let value = key_value(event)?;
    let context = focused(shared).await;
    let kind = if event.down { "keyDown" } else { "keyUp" };
    perform(shared, &context, vec![keyboard(vec![json!({ "type": kind, "value": value })])]).await
}

pub(crate) async fn insert_text(shared: &Arc<Shared>, text: &str) -> DriverResult<()> {
    flush(shared).await?;
    let context = focused(shared).await;
    let inserted = shared.sandbox_call(&context, INSERT_TEXT, &[json!(text)]).await;
    if matches!(&inserted, Ok(result) if result.get("value") == Some(&Value::Bool(true))) {
        return Ok(());
    }
    let mut actions = Vec::new();
    for c in text.chars() {
        let value = match c {
            '\n' | '\r' => '\u{E006}'.to_string(),
            '\t' => '\u{E004}'.to_string(),
            c => c.to_string(),
        };
        actions.push(json!({ "type": "keyDown", "value": value }));
        actions.push(json!({ "type": "keyUp", "value": value }));
    }
    if actions.is_empty() {
        return Ok(());
    }
    perform(shared, &context, vec![keyboard(actions)]).await
}

pub(crate) async fn drag(
    shared: &Arc<Shared>,
    from: (f64, f64),
    to: (f64, f64),
    steps: &[PointerStep],
    _modifiers: Modifiers,
) -> DriverResult<DragOutcome> {
    flush(shared).await?;
    {
        let mut state = shared.input.lock().unwrap();
        state.held = None;
        state.at = Some((FrameId::from(""), f64::NAN, f64::NAN));
    }
    let route = route(shared, from.0, from.1).await;
    let (fx, fy) = route.local(from.0, from.1);
    let (tx, ty) = route.local(to.0, to.1);
    let draggable = shared
        .sandbox_call(&route.context, DRAGGABLE, &[json!(fx), json!(fy)])
        .await
        .map(|result| result.get("value") == Some(&Value::Bool(true)))
        .unwrap_or(false);
    if !draggable {
        let mut actions = vec![move_to(fx, fy, 0), button_action("pointerDown", 0)];
        for step in steps {
            let (x, y) = route.local(step.x, step.y);
            actions.push(move_to(x, y, step.delay_ms.max(0.0).round() as u64));
        }
        actions.push(move_to(tx, ty, 0));
        actions.push(button_action("pointerUp", 0));
        perform(shared, &route.context, vec![mouse(actions)]).await?;
        return Ok(DragOutcome::NotDraggable);
    }
    perform(shared, &route.context, vec![mouse(vec![move_to(fx, fy, 0)])]).await?;
    let outcome = shared
        .sandbox_call(&route.context, SYNTHETIC_DRAG, &[json!(fx), json!(fy), json!(tx), json!(ty)])
        .await?;
    perform(shared, &route.context, vec![mouse(vec![move_to(tx, ty, 0)])]).await?;
    Ok(match outcome.get("value").and_then(Value::as_str) {
        Some("not-draggable") => DragOutcome::NotDraggable,
        _ => DragOutcome::Dropped,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(key: &str, code: &str) -> KeyEvent {
        KeyEvent { down: true, key: key.into(), code: code.into(), text: String::new(), modifiers: Modifiers::NONE, mac: false }
    }

    #[test]
    fn keys_map_to_webdriver_values() {
        let value = |k: &str, c: &str| key_value(&key(k, c)).unwrap();
        assert_eq!(value("a", "KeyA"), "a");
        assert_eq!(value("A", "KeyA"), "A");
        assert_eq!(value(" ", "Space"), " ");
        assert_eq!(value("é", ""), "é");
        assert_eq!(value("Enter", "Enter"), "\u{E006}");
        assert_eq!(value("Enter", "NumpadEnter"), "\u{E007}");
        assert_eq!(value("Shift", "ShiftLeft"), "\u{E008}");
        assert_eq!(value("Shift", "ShiftRight"), "\u{E050}");
        assert_eq!(value("Meta", "MetaLeft"), "\u{E03D}");
        assert_eq!(value("Control", "ControlRight"), "\u{E051}");
        assert_eq!(value("ArrowLeft", "ArrowLeft"), "\u{E012}");
        assert_eq!(value("Backspace", "Backspace"), "\u{E003}");
        assert_eq!(value("F1", "F1"), "\u{E031}");
        assert_eq!(value("F12", "F12"), "\u{E03C}");
        assert_eq!(value("7", "Numpad7"), "\u{E021}");
        assert!(matches!(key_value(&key("CapsLock", "CapsLock")), Err(DriverError::Unsupported(_))));
        assert!(matches!(key_value(&key("ContextMenu", "ContextMenu")), Err(DriverError::Unsupported(_))));
        assert!(matches!(key_value(&key("AudioVolumeUp", "")), Err(DriverError::Unsupported(_))));
    }

    #[test]
    fn routes_keep_points_in_the_viewport() {
        let route = Route { context: FrameId::from("c"), dx: 100.0, dy: 50.0, width: 300.0, height: 150.0 };
        assert_eq!(route.local(150.0, 60.0), (50.0, 10.0));
        assert_eq!(route.local(10.0, 10.0), (0.0, 0.0));
        assert_eq!(route.local(1000.0, 1000.0), (299.0, 149.0));
        assert_eq!(Route::top(&FrameId::from("t")).local(5000.0, -3.0), (5000.0, 0.0));
    }

    #[test]
    fn buttons() {
        assert_eq!(button_code(MouseButton::Left), Some(0));
        assert_eq!(button_code(MouseButton::Middle), Some(1));
        assert_eq!(button_code(MouseButton::Right), Some(2));
        assert_eq!(button_code(MouseButton::Back), Some(3));
        assert_eq!(button_code(MouseButton::Forward), Some(4));
        assert_eq!(button_code(MouseButton::None), None);
    }
}
