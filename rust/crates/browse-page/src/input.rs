//! Mouse and keyboard over `Input.dispatch*`, human-like when the setting is on.

use std::sync::Arc;

use anyhow::{Result, anyhow, bail};
use serde_json::{Value, json};
use tokio::sync::MutexGuard;

use crate::human::{self, InputState, Point};
use crate::page::TabPage;

/// Input stopped because a JavaScript dialog opened; the action's result reports the dialog.
#[derive(Debug)]
pub struct Interrupted;

impl std::fmt::Display for Interrupted {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "a dialog opened")
    }
}

impl std::error::Error for Interrupted {}

pub const ALT: i64 = 1;
pub const CONTROL: i64 = 2;
pub const META: i64 = 4;
pub const SHIFT: i64 = 8;

#[derive(Debug, Clone, PartialEq)]
pub struct KeyDef {
    pub key: String,
    pub code: String,
    pub key_code: i64,
    pub text: String,
    pub location: i64,
}

fn def(key: &str, code: &str, key_code: i64, text: &str) -> KeyDef {
    KeyDef { key: key.into(), code: code.into(), key_code, text: text.into(), location: 0 }
}

/// A US keyboard layout key. `shift` gives the shifted key for characters typed with Shift.
pub fn key_definition(name: &str) -> Option<KeyDef> {
    let named = match name {
        "Enter" | "Return" => Some(def("Enter", "Enter", 13, "\r")),
        "Tab" => Some(def("Tab", "Tab", 9, "")),
        "Backspace" => Some(def("Backspace", "Backspace", 8, "")),
        "Escape" | "Esc" => Some(def("Escape", "Escape", 27, "")),
        "Delete" => Some(def("Delete", "Delete", 46, "")),
        "Insert" => Some(def("Insert", "Insert", 45, "")),
        "Home" => Some(def("Home", "Home", 36, "")),
        "End" => Some(def("End", "End", 35, "")),
        "PageUp" => Some(def("PageUp", "PageUp", 33, "")),
        "PageDown" => Some(def("PageDown", "PageDown", 34, "")),
        "ArrowLeft" => Some(def("ArrowLeft", "ArrowLeft", 37, "")),
        "ArrowUp" => Some(def("ArrowUp", "ArrowUp", 38, "")),
        "ArrowRight" => Some(def("ArrowRight", "ArrowRight", 39, "")),
        "ArrowDown" => Some(def("ArrowDown", "ArrowDown", 40, "")),
        "Space" | " " => Some(def(" ", "Space", 32, " ")),
        "CapsLock" => Some(def("CapsLock", "CapsLock", 20, "")),
        "ContextMenu" => Some(def("ContextMenu", "ContextMenu", 93, "")),
        "Shift" => Some(KeyDef { location: 1, ..def("Shift", "ShiftLeft", 16, "") }),
        "Control" => Some(KeyDef { location: 1, ..def("Control", "ControlLeft", 17, "") }),
        "Alt" => Some(KeyDef { location: 1, ..def("Alt", "AltLeft", 18, "") }),
        "Meta" => Some(KeyDef { location: 1, ..def("Meta", "MetaLeft", 91, "") }),
        _ => None,
    };
    if named.is_some() {
        return named;
    }
    if let Some(number) = name.strip_prefix('F').and_then(|n| n.parse::<i64>().ok())
        && (1..=12).contains(&number) {
            return Some(def(name, name, 111 + number, ""));
        }
    if let Some(rest) = name.strip_prefix("Key")
        && rest.len() == 1 && rest.chars().all(|c| c.is_ascii_uppercase()) {
            return key_definition(&rest.to_ascii_lowercase());
        }
    if let Some(rest) = name.strip_prefix("Digit")
        && rest.len() == 1 && rest.chars().all(|c| c.is_ascii_digit()) {
            return key_definition(rest);
        }
    let mut chars = name.chars();
    let c = chars.next()?;
    if chars.next().is_some() {
        return None;
    }
    char_definition(c).map(|(def, _)| def)
}

/// The key for a typed character and whether it needs Shift.
pub fn char_definition(c: char) -> Option<(KeyDef, bool)> {
    let s = c.to_string();
    if c.is_ascii_lowercase() {
        let upper = c.to_ascii_uppercase();
        return Some((def(&s, &format!("Key{upper}"), upper as i64, &s), false));
    }
    if c.is_ascii_uppercase() {
        return Some((def(&s, &format!("Key{c}"), c as i64, &s), true));
    }
    if c.is_ascii_digit() {
        return Some((def(&s, &format!("Digit{c}"), c as i64, &s), false));
    }
    let shifted_digits = [(')', '0'), ('!', '1'), ('@', '2'), ('#', '3'), ('$', '4'), ('%', '5'), ('^', '6'), ('&', '7'), ('*', '8'), ('(', '9')];
    if let Some((_, digit)) = shifted_digits.iter().find(|(symbol, _)| *symbol == c) {
        return Some((def(&s, &format!("Digit{digit}"), *digit as i64, &s), true));
    }
    let punctuation: [(char, char, &str, i64); 11] = [
        ('`', '~', "Backquote", 192),
        ('-', '_', "Minus", 189),
        ('=', '+', "Equal", 187),
        ('[', '{', "BracketLeft", 219),
        (']', '}', "BracketRight", 221),
        ('\\', '|', "Backslash", 220),
        (';', ':', "Semicolon", 186),
        ('\'', '"', "Quote", 222),
        (',', '<', "Comma", 188),
        ('.', '>', "Period", 190),
        ('/', '?', "Slash", 191),
    ];
    for (plain, shifted, code, key_code) in punctuation {
        if c == plain {
            return Some((def(&s, code, key_code, &s), false));
        }
        if c == shifted {
            return Some((def(&s, code, key_code, &s), true));
        }
    }
    match c {
        ' ' => Some((def(" ", "Space", 32, " "), false)),
        '\n' | '\r' => Some((def("Enter", "Enter", 13, "\r"), false)),
        '\t' => Some((def("Tab", "Tab", 9, ""), false)),
        _ => None,
    }
}

pub fn modifier_bit(key: &str) -> i64 {
    match key {
        "Alt" => ALT,
        "Control" => CONTROL,
        "Meta" => META,
        "Shift" => SHIFT,
        _ => 0,
    }
}

/// Splits "Control+Shift+K" into modifiers and the key; "ControlOrMeta" is Meta on macOS.
pub fn parse_combo(combo: &str, mac: bool) -> Result<(Vec<String>, String)> {
    let combo = combo.trim();
    if combo.is_empty() {
        bail!("Empty key");
    }
    let mut parts: Vec<String> = Vec::new();
    let mut current = String::new();
    let chars: Vec<char> = combo.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '+' && !current.is_empty() {
            parts.push(std::mem::take(&mut current));
        } else {
            current.push(c);
        }
        i += 1;
    }
    if !current.is_empty() {
        parts.push(current);
    }
    let key = parts.pop().ok_or_else(|| anyhow!("Empty key"))?;
    let mut modifiers = Vec::new();
    for part in parts {
        let name = match part.as_str() {
            "ControlOrMeta" | "CmdOrCtrl" => if mac { "Meta" } else { "Control" },
            "Ctrl" => "Control",
            "Cmd" | "Command" | "Super" => "Meta",
            "Option" => "Alt",
            other => other,
        };
        if modifier_bit(name) == 0 {
            bail!("Unknown modifier {part:?} in {combo:?}; use Shift, Control, Alt, Meta or ControlOrMeta");
        }
        modifiers.push(name.to_string());
    }
    let key = match key.as_str() {
        "ControlOrMeta" => if mac { "Meta".into() } else { "Control".into() },
        _ => key,
    };
    if key_definition(&key).is_none() {
        bail!("Unknown key {key:?}. Use a character, or a name such as Enter, Tab, Escape, Backspace, ArrowDown, PageDown, F5");
    }
    Ok((modifiers, key))
}

/// macOS editing commands Chrome needs alongside key events for shortcuts to act on text fields.
fn mac_command(modifiers: i64, code: &str) -> Option<&'static str> {
    let shift = modifiers & SHIFT != 0;
    let meta = modifiers & META != 0;
    let alt = modifiers & ALT != 0;
    Some(match (meta, alt, shift, code) {
        (true, false, false, "KeyA") => "selectAll",
        (true, false, false, "KeyC") => "copy",
        (true, false, false, "KeyX") => "cut",
        (true, false, false, "KeyV") => "paste",
        (true, false, false, "KeyZ") => "undo",
        (true, false, true, "KeyZ") => "redo",
        (true, false, false, "Backspace") => "deleteToBeginningOfLine",
        (false, true, false, "Backspace") => "deleteWordBackward",
        (true, false, false, "ArrowLeft") => "moveToBeginningOfLine",
        (true, false, false, "ArrowRight") => "moveToEndOfLine",
        (true, false, true, "ArrowLeft") => "moveToBeginningOfLineAndModifySelection",
        (true, false, true, "ArrowRight") => "moveToEndOfLineAndModifySelection",
        (true, false, false, "ArrowUp") => "moveToBeginningOfDocument",
        (true, false, false, "ArrowDown") => "moveToEndOfDocument",
        (false, true, false, "ArrowLeft") => "moveWordLeft",
        (false, true, false, "ArrowRight") => "moveWordRight",
        _ => return None,
    })
}

/// Input on one tab; holding it serializes input, so a press never overtakes the movement before it.
pub struct Input<'a> {
    page: &'a Arc<TabPage>,
    state: MutexGuard<'a, InputState>,
    human: bool,
    mac: bool,
    viewport: Option<(f64, f64)>,
    pub modifiers: i64,
    /// Set after a click that may open a new tab (modifiers or the middle button): Chrome can hold replies to input
    /// for the tab that lost focus, so later events don't wait for theirs.
    bounded: bool,
}

/// How long an input event waits for Chrome's reply once replies may be held.
const BOUNDED_REPLY: std::time::Duration = std::time::Duration::from_millis(800);

impl<'a> Input<'a> {
    pub async fn new(page: &'a Arc<TabPage>, human: bool) -> Input<'a> {
        let state = page.input.lock().await;
        let mac = page.platform().map(|p| p.to_ascii_lowercase().contains("mac")).unwrap_or(false);
        Input { page, state, human, mac, viewport: None, modifiers: 0, bounded: false }
    }

    pub fn human(&self) -> bool {
        self.human
    }

    pub fn mac(&self) -> bool {
        self.mac
    }

    pub fn pointer(&self) -> Option<Point> {
        self.state.pointer
    }

    /// Sends an input command; a dialog opening while it waits interrupts it.
    async fn dispatch(&self, method: &str, params: Value) -> Result<()> {
        if self.page.dialog().is_some() {
            return Err(Interrupted.into());
        }
        let page = self.page.clone();
        let method_owned = method.to_string();
        let task = tokio::spawn(async move { page.send_raw(&method_owned, params, None).await });
        let bounded = self.bounded;
        let held = async move {
            if bounded {
                tokio::time::sleep(BOUNDED_REPLY).await;
            } else {
                std::future::pending::<()>().await;
            }
        };
        tokio::select! {
            // The event was delivered; only its reply is late.
            _ = held => Ok(()),
            result = task => match result {
                Ok(Ok(_)) => Ok(()),
                Ok(Err(error)) => Err(error),
                Err(error) => Err(anyhow!("input task failed: {error}")),
            },
            _ = self.page.dialog_opened() => Err(Interrupted.into()),
        }
    }

    /// Sends one sample of a gesture and waits until the next is due, never longer than the gap: Chrome can hold the
    /// reply to a pointer event for a background tab until its next frame.
    async fn pace(&self, gap_ms: f64, method: &str, params: Value) -> Result<()> {
        if self.page.dialog().is_some() {
            return Err(Interrupted.into());
        }
        let started = std::time::Instant::now();
        let page = self.page.clone();
        let method = method.to_string();
        let task = tokio::spawn(async move { page.send_raw(&method, params, None).await });
        let gap = std::time::Duration::from_micros((gap_ms * 1000.0) as u64);
        let _ = tokio::time::timeout(gap, task).await;
        let elapsed = started.elapsed().as_secs_f64() * 1000.0;
        human::sleep_ms(gap_ms - elapsed).await;
        Ok(())
    }

    /// The layout viewport in CSS pixels.
    pub async fn viewport_size(&mut self) -> Option<(f64, f64)> {
        self.viewport().await
    }

    async fn viewport(&mut self) -> Option<(f64, f64)> {
        if self.viewport.is_none()
            && let Ok(metrics) = self.page.send_raw("Page.getLayoutMetrics", json!({}), None).await {
                let layout = &metrics["cssLayoutViewport"];
                if let (Some(w), Some(h)) = (layout["clientWidth"].as_f64(), layout["clientHeight"].as_f64())
                    && w > 0.0 && h > 0.0 {
                        self.viewport = Some((w, h));
                    }
            }
        self.viewport
    }

    fn button_bit(button: &str) -> i64 {
        match button {
            "left" => 1,
            "right" => 2,
            "middle" => 4,
            "back" => 8,
            "forward" => 16,
            _ => 0,
        }
    }

    /// Moves the pointer to `to` (page coordinates), along a human path when human input is on.
    pub async fn move_to(&mut self, to: Point, steps: usize) -> Result<Point> {
        let target = if self.human { self.state.aim(to) } else { to };
        let buttons = self.state.buttons;
        let pressed = if buttons & 1 != 0 { "left" } else if buttons & 2 != 0 { "right" } else if buttons & 4 != 0 { "middle" } else { "none" };
        if self.human {
            let bounds = self.viewport().await;
            let from = self.state.start_point(target, bounds);
            for (point, delay) in human::trajectory(from, target) {
                let point = human::clamp_point(point, bounds);
                self.pace(delay, "Input.dispatchMouseEvent", json!({ "type": "mouseMoved", "x": point.x, "y": point.y, "button": pressed, "buttons": buttons, "modifiers": self.modifiers })).await?;
            }
            self.state.arrived();
        } else if steps > 1 {
            let from = self.state.pointer.unwrap_or(target);
            for i in 1..steps {
                let t = i as f64 / steps as f64;
                let point = Point { x: from.x + (target.x - from.x) * t, y: from.y + (target.y - from.y) * t };
                self.dispatch("Input.dispatchMouseEvent", json!({ "type": "mouseMoved", "x": point.x, "y": point.y, "button": pressed, "buttons": buttons, "modifiers": self.modifiers })).await?;
            }
        }
        self.dispatch("Input.dispatchMouseEvent", json!({ "type": "mouseMoved", "x": target.x, "y": target.y, "button": pressed, "buttons": buttons, "modifiers": self.modifiers })).await?;
        self.state.pointer = Some(target);
        Ok(target)
    }

    pub async fn down(&mut self, button: &str, click_count: i64) -> Result<()> {
        let at = self.state.pointer.unwrap_or(Point { x: 0.0, y: 0.0 });
        if self.human {
            self.state.before_press().await;
        }
        self.state.buttons |= Self::button_bit(button);
        self.dispatch(
            "Input.dispatchMouseEvent",
            json!({ "type": "mousePressed", "x": at.x, "y": at.y, "button": button, "buttons": self.state.buttons, "clickCount": click_count, "modifiers": self.modifiers }),
        )
        .await
    }

    pub async fn up(&mut self, button: &str, click_count: i64) -> Result<()> {
        let at = self.state.pointer.unwrap_or(Point { x: 0.0, y: 0.0 });
        if self.human {
            self.state.before_release().await;
        }
        self.state.buttons &= !Self::button_bit(button);
        self.dispatch(
            "Input.dispatchMouseEvent",
            json!({ "type": "mouseReleased", "x": at.x, "y": at.y, "button": button, "buttons": self.state.buttons, "clickCount": click_count, "modifiers": self.modifiers }),
        )
        .await
    }

    pub async fn click(&mut self, at: Point, button: &str, count: i64) -> Result<()> {
        self.move_to(at, 1).await?;
        let new_tab = button == "middle" || self.modifiers & (CONTROL | META | SHIFT) != 0;
        for n in 1..=count.max(1) {
            self.down(button, n).await?;
            self.bounded |= new_tab;
            self.up(button, n).await?;
            if n < count && self.human {
                human::sleep_ms(human::random(70.0, 140.0)).await;
            }
        }
        Ok(())
    }

    /// A wheel scroll at `at`; with human input it glides in eased ~60 Hz frames.
    pub async fn wheel(&mut self, at: Point, dx: f64, dy: f64) -> Result<()> {
        // Always move first: the remembered pointer may belong to a previous document, which Chrome no longer
        // hit-tests the wheel against.
        let at = self.move_to(at, 1).await?;
        if self.human {
            for frame in human::glide(dx, dy) {
                self.pace(
                    human::random(15.5, 18.0),
                    "Input.dispatchMouseEvent",
                    json!({ "type": "mouseWheel", "x": at.x, "y": at.y, "deltaX": (frame.x * 100.0).round() / 100.0, "deltaY": (frame.y * 100.0).round() / 100.0, "modifiers": self.modifiers }),
                )
                .await?;
            }
            Ok(())
        } else {
            self.dispatch("Input.dispatchMouseEvent", json!({ "type": "mouseWheel", "x": at.x, "y": at.y, "deltaX": dx, "deltaY": dy, "modifiers": self.modifiers })).await
        }
    }

    /// One plain wheel event at `at`, human input or not.
    pub async fn wheel_direct(&mut self, at: Point, dx: f64, dy: f64) -> Result<()> {
        self.dispatch("Input.dispatchMouseEvent", json!({ "type": "mouseMoved", "x": at.x, "y": at.y, "button": "none", "buttons": self.state.buttons, "modifiers": self.modifiers })).await?;
        self.state.pointer = Some(at);
        self.dispatch("Input.dispatchMouseEvent", json!({ "type": "mouseWheel", "x": at.x, "y": at.y, "deltaX": dx, "deltaY": dy, "modifiers": self.modifiers })).await
    }

    pub async fn key_down(&mut self, key: &KeyDef) -> Result<()> {
        if self.human {
            self.state.before_key().await;
        }
        self.modifiers |= modifier_bit(&key.key);
        // Shortcuts send no text; Shift alone still types.
        let text = if self.modifiers & (CONTROL | ALT | META) != 0 { "" } else { key.text.as_str() };
        let mut params = json!({
            "type": if text.is_empty() { "rawKeyDown" } else { "keyDown" },
            "modifiers": self.modifiers,
            "windowsVirtualKeyCode": key.key_code,
            "nativeVirtualKeyCode": key.key_code,
            "code": key.code,
            "key": key.key,
            "text": text,
            "unmodifiedText": text,
            "location": key.location,
            "autoRepeat": false,
            "isKeypad": false,
        });
        if self.mac
            && let Some(command) = mac_command(self.modifiers, &key.code) {
                params["commands"] = json!([command]);
            }
        self.dispatch("Input.dispatchKeyEvent", params).await
    }

    pub async fn key_up(&mut self, key: &KeyDef) -> Result<()> {
        self.modifiers &= !modifier_bit(&key.key);
        self.dispatch(
            "Input.dispatchKeyEvent",
            json!({ "type": "keyUp", "modifiers": self.modifiers, "key": key.key, "windowsVirtualKeyCode": key.key_code, "nativeVirtualKeyCode": key.key_code, "code": key.code, "location": key.location }),
        )
        .await
    }

    /// Presses a combination like "Enter", "Control+A" or "ControlOrMeta+Shift+K". A single character with no US
    /// key (é, ß, 你) is inserted as text.
    pub async fn press(&mut self, combo: &str) -> Result<()> {
        let mut chars = combo.chars();
        if let (Some(c), None) = (chars.next(), chars.next())
            && char_definition(c).is_none() && key_definition(combo).is_none() {
                if self.human {
                    self.state.before_key().await;
                }
                return self.insert_text(combo).await;
            }
        let (modifiers, key) = parse_combo(combo, self.mac)?;
        let mut held = Vec::new();
        for modifier in &modifiers {
            let def = key_definition(modifier).unwrap();
            self.key_down(&def).await?;
            held.push(def);
        }
        let mut def = key_definition(&key).unwrap();
        // "Shift+a" types "A", as a real keyboard does.
        if self.modifiers & SHIFT != 0 && def.key.chars().count() == 1
            && let Some(upper) = shifted(&def.key) {
                def.key = upper.clone();
                def.text = upper;
            }
        self.key_down(&def).await?;
        self.key_up(&def).await?;
        for def in held.iter().rev() {
            self.key_up(def).await?;
        }
        Ok(())
    }

    /// Types text key by key; characters without a US key are inserted as text.
    pub async fn type_text(&mut self, text: &str, delay_ms: f64) -> Result<()> {
        for c in text.chars() {
            match char_definition(c) {
                Some((def, needs_shift)) => {
                    let shift = key_definition("Shift").unwrap();
                    if needs_shift && self.modifiers & SHIFT == 0 {
                        self.key_down(&shift).await?;
                        self.key_down(&def).await?;
                        self.key_up(&def).await?;
                        self.key_up(&shift).await?;
                    } else {
                        self.key_down(&def).await?;
                        self.key_up(&def).await?;
                    }
                }
                None => {
                    if self.human {
                        self.state.before_key().await;
                    }
                    self.insert_text(&c.to_string()).await?;
                }
            }
            if delay_ms > 0.0 {
                human::sleep_ms(delay_ms).await;
            }
        }
        Ok(())
    }

    pub async fn insert_text(&mut self, text: &str) -> Result<()> {
        self.dispatch("Input.insertText", json!({ "text": text })).await
    }

    /// Releases held modifiers and buttons after a failed action, so the page is not left with keys down.
    pub async fn reset(&mut self) {
        for name in ["Shift", "Control", "Alt", "Meta"] {
            if self.modifiers & modifier_bit(name) != 0 {
                let def = key_definition(name).unwrap();
                let _ = self.key_up(&def).await;
            }
        }
        for button in ["left", "right", "middle"] {
            if self.state.buttons & Self::button_bit(button) != 0 {
                let _ = self.up(button, 1).await;
            }
        }
    }

    pub async fn dispatch_drag(&self, kind: &str, at: Point, data: &Value) -> Result<()> {
        self.dispatch("Input.dispatchDragEvent", json!({ "type": kind, "x": at.x, "y": at.y, "data": data, "modifiers": self.modifiers })).await
    }

    pub async fn set_intercept_drags(&self, enabled: bool) {
        let _ = self.page.send_raw("Input.setInterceptDrags", json!({ "enabled": enabled }), None).await;
    }

    pub fn set_pointer(&mut self, point: Point) {
        self.state.pointer = Some(point);
    }
}

fn shifted(key: &str) -> Option<String> {
    let c = key.chars().next()?;
    if c.is_ascii_lowercase() {
        return Some(c.to_ascii_uppercase().to_string());
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn combos_parse() {
        let (mods, key) = parse_combo("Control+Shift+K", false).unwrap();
        assert_eq!(mods, vec!["Control", "Shift"]);
        assert_eq!(key, "K");
        let (mods, key) = parse_combo("ControlOrMeta+a", true).unwrap();
        assert_eq!(mods, vec!["Meta"]);
        assert_eq!(key, "a");
        let (mods, key) = parse_combo("Shift++", false).unwrap();
        assert_eq!(mods, vec!["Shift"]);
        assert_eq!(key, "+");
        assert!(parse_combo("Hyper+a", false).is_err());
        assert!(parse_combo("NotAKey", false).is_err());
    }

    #[test]
    fn characters_map_to_us_keys() {
        assert_eq!(char_definition('A').unwrap().0.code, "KeyA");
        assert!(char_definition('A').unwrap().1);
        assert_eq!(char_definition('?').unwrap().0.code, "Slash");
        assert_eq!(char_definition('é'), None);
        assert_eq!(key_definition("F5").unwrap().key_code, 116);
        assert_eq!(key_definition("Enter").unwrap().text, "\r");
    }
}
