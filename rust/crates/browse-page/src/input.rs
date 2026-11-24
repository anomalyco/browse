//! Mouse and keyboard over `browse_core::TabDriver`, human-like when the setting is on.

use std::future::Future;
use std::sync::Arc;

use anyhow::{Result, anyhow, bail};
use browse_core::{
    DragOutcome, DriverError, KeyEvent, Modifiers, MouseButton, PointerEvent, PointerStep, TabDriver,
};
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

#[derive(Debug, Clone, PartialEq)]
pub struct KeyDef {
    pub key: String,
    pub code: String,
    pub text: String,
}

fn def(key: &str, code: &str, text: &str) -> KeyDef {
    KeyDef { key: key.into(), code: code.into(), text: text.into() }
}

/// A US keyboard layout key (pure DOM key/code/text).
pub fn key_definition(name: &str) -> Option<KeyDef> {
    let named = match name {
        "Enter" | "Return" => Some(def("Enter", "Enter", "\r")),
        "Tab" => Some(def("Tab", "Tab", "")),
        "Backspace" => Some(def("Backspace", "Backspace", "")),
        "Escape" | "Esc" => Some(def("Escape", "Escape", "")),
        "Delete" => Some(def("Delete", "Delete", "")),
        "Insert" => Some(def("Insert", "Insert", "")),
        "Home" => Some(def("Home", "Home", "")),
        "End" => Some(def("End", "End", "")),
        "PageUp" => Some(def("PageUp", "PageUp", "")),
        "PageDown" => Some(def("PageDown", "PageDown", "")),
        "ArrowLeft" => Some(def("ArrowLeft", "ArrowLeft", "")),
        "ArrowUp" => Some(def("ArrowUp", "ArrowUp", "")),
        "ArrowRight" => Some(def("ArrowRight", "ArrowRight", "")),
        "ArrowDown" => Some(def("ArrowDown", "ArrowDown", "")),
        "Space" | " " => Some(def(" ", "Space", " ")),
        "CapsLock" => Some(def("CapsLock", "CapsLock", "")),
        "ContextMenu" => Some(def("ContextMenu", "ContextMenu", "")),
        "Shift" => Some(def("Shift", "ShiftLeft", "")),
        "Control" => Some(def("Control", "ControlLeft", "")),
        "Alt" => Some(def("Alt", "AltLeft", "")),
        "Meta" => Some(def("Meta", "MetaLeft", "")),
        _ => None,
    };
    if named.is_some() {
        return named;
    }
    if let Some(number) = name.strip_prefix('F').and_then(|n| n.parse::<i64>().ok())
        && (1..=12).contains(&number)
    {
        return Some(def(name, name, ""));
    }
    if let Some(rest) = name.strip_prefix("Key")
        && rest.len() == 1
        && rest.chars().all(|c| c.is_ascii_uppercase())
    {
        return key_definition(&rest.to_ascii_lowercase());
    }
    if let Some(rest) = name.strip_prefix("Digit")
        && rest.len() == 1
        && rest.chars().all(|c| c.is_ascii_digit())
    {
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
        return Some((def(&s, &format!("Key{upper}"), &s), false));
    }
    if c.is_ascii_uppercase() {
        return Some((def(&s, &format!("Key{c}"), &s), true));
    }
    if c.is_ascii_digit() {
        return Some((def(&s, &format!("Digit{c}"), &s), false));
    }
    let shifted_digits = [(')', '0'), ('!', '1'), ('@', '2'), ('#', '3'), ('$', '4'), ('%', '5'), ('^', '6'), ('&', '7'), ('*', '8'), ('(', '9')];
    if let Some((_, digit)) = shifted_digits.iter().find(|(symbol, _)| *symbol == c) {
        return Some((def(&s, &format!("Digit{digit}"), &s), true));
    }
    let punctuation: [(char, char, &str); 11] = [
        ('`', '~', "Backquote"),
        ('-', '_', "Minus"),
        ('=', '+', "Equal"),
        ('[', '{', "BracketLeft"),
        (']', '}', "BracketRight"),
        ('\\', '|', "Backslash"),
        (';', ':', "Semicolon"),
        ('\'', '"', "Quote"),
        (',', '<', "Comma"),
        ('.', '>', "Period"),
        ('/', '?', "Slash"),
    ];
    for (plain, shifted, code) in punctuation {
        if c == plain {
            return Some((def(&s, code, &s), false));
        }
        if c == shifted {
            return Some((def(&s, code, &s), true));
        }
    }
    match c {
        ' ' => Some((def(" ", "Space", " "), false)),
        '\n' | '\r' => Some((def("Enter", "Enter", "\r"), false)),
        '\t' => Some((def("Tab", "Tab", ""), false)),
        _ => None,
    }
}

pub fn modifier_flag(key: &str) -> Modifiers {
    match key {
        "Alt" => Modifiers::ALT,
        "Control" => Modifiers::CONTROL,
        "Meta" => Modifiers::META,
        "Shift" => Modifiers::SHIFT,
        _ => Modifiers::NONE,
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
    for c in combo.chars() {
        if c == '+' && !current.is_empty() {
            parts.push(std::mem::take(&mut current));
        } else {
            current.push(c);
        }
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
        if modifier_flag(name) == Modifiers::NONE {
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

/// Input on one tab; holding it serializes input, so a press never overtakes the movement before it.
pub struct Input<'a> {
    page: &'a Arc<TabPage>,
    state: MutexGuard<'a, InputState>,
    human: bool,
    mac: bool,
    viewport: Option<(f64, f64)>,
    pub modifiers: Modifiers,
    bounded: bool,
}

const BOUNDED_REPLY: std::time::Duration = std::time::Duration::from_millis(800);

impl<'a> Input<'a> {
    pub async fn new(page: &'a Arc<TabPage>, human: bool) -> Input<'a> {
        let state = page.input.lock().await;
        let mac = page
            .platform()
            .map(|p| p.to_ascii_lowercase().contains("mac"))
            .unwrap_or(false);
        Input { page, state, human, mac, viewport: None, modifiers: Modifiers::NONE, bounded: false }
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

    async fn dispatch<F, Fut>(&self, send: F) -> Result<()>
    where
        F: FnOnce(Arc<dyn TabDriver>) -> Fut + Send + 'static,
        Fut: Future<Output = std::result::Result<(), DriverError>> + Send + 'static,
    {
        if self.page.dialog().is_some() {
            return Err(Interrupted.into());
        }
        let driver = self.page.driver().clone();
        let task = tokio::spawn(async move { send(driver).await.map_err(crate::page::driver_error) });
        let bounded = self.bounded;
        let held = async move {
            if bounded {
                tokio::time::sleep(BOUNDED_REPLY).await;
            } else {
                std::future::pending::<()>().await;
            }
        };
        tokio::select! {
            _ = held => Ok(()),
            result = task => match result {
                Ok(Ok(())) => Ok(()),
                Ok(Err(error)) => Err(error),
                Err(error) => Err(anyhow!("input task failed: {error}")),
            },
            _ = self.page.dialog_opened() => Err(Interrupted.into()),
        }
    }

    async fn pace<F, Fut>(&self, gap_ms: f64, send: F) -> Result<()>
    where
        F: FnOnce(Arc<dyn TabDriver>) -> Fut + Send + 'static,
        Fut: Future<Output = std::result::Result<(), DriverError>> + Send + 'static,
    {
        if self.page.dialog().is_some() {
            return Err(Interrupted.into());
        }
        let started = std::time::Instant::now();
        let driver = self.page.driver().clone();
        let task = tokio::spawn(async move { send(driver).await });
        let gap = std::time::Duration::from_micros((gap_ms * 1000.0) as u64);
        let _ = tokio::time::timeout(gap, task).await;
        let elapsed = started.elapsed().as_secs_f64() * 1000.0;
        human::sleep_ms(gap_ms - elapsed).await;
        Ok(())
    }

    pub async fn viewport_size(&mut self) -> Option<(f64, f64)> {
        self.viewport().await
    }

    async fn viewport(&mut self) -> Option<(f64, f64)> {
        if self.viewport.is_none()
            && let Ok(metrics) = self.page.driver().viewport().await
            && let (Some(w), Some(h)) = (metrics.layout_width, metrics.layout_height)
            && w > 0.0
            && h > 0.0
        {
            self.viewport = Some((w, h));
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

    pub async fn move_to(&mut self, to: Point, steps: usize) -> Result<Point> {
        let target = if self.human { self.state.aim(to) } else { to };
        let modifiers = self.modifiers;
        if self.human {
            let bounds = self.viewport().await;
            let from = self.state.start_point(target, bounds);
            for (point, delay) in human::trajectory(from, target) {
                let p = human::clamp_point(point, bounds);
                let event = PointerEvent::Move { x: p.x, y: p.y, modifiers };
                self.pace(delay, move |d| async move { d.pointer(event).await }).await?;
            }
            self.state.arrived();
        } else if steps > 1 {
            let from = self.state.pointer.unwrap_or(target);
            for i in 1..steps {
                let t = i as f64 / steps as f64;
                let event = PointerEvent::Move {
                    x: from.x + (target.x - from.x) * t,
                    y: from.y + (target.y - from.y) * t,
                    modifiers,
                };
                self.dispatch(move |d| async move { d.pointer(event).await }).await?;
            }
        }
        let event = PointerEvent::Move { x: target.x, y: target.y, modifiers };
        self.dispatch(move |d| async move { d.pointer(event).await }).await?;
        self.state.pointer = Some(target);
        Ok(target)
    }

    pub async fn down(&mut self, button: &str, click_count: i64) -> Result<()> {
        let at = self.state.pointer.unwrap_or(Point { x: 0.0, y: 0.0 });
        if self.human {
            self.state.before_press().await;
        }
        self.state.buttons |= Self::button_bit(button);
        let event = PointerEvent::Down {
            x: at.x,
            y: at.y,
            button: MouseButton::from_name(button).unwrap_or(MouseButton::Left),
            click_count: click_count.max(1) as u32,
            modifiers: self.modifiers,
        };
        self.dispatch(move |d| async move { d.pointer(event).await }).await
    }

    pub async fn up(&mut self, button: &str, click_count: i64) -> Result<()> {
        let at = self.state.pointer.unwrap_or(Point { x: 0.0, y: 0.0 });
        if self.human {
            self.state.before_release().await;
        }
        self.state.buttons &= !Self::button_bit(button);
        let event = PointerEvent::Up {
            x: at.x,
            y: at.y,
            button: MouseButton::from_name(button).unwrap_or(MouseButton::Left),
            click_count: click_count.max(1) as u32,
            modifiers: self.modifiers,
        };
        self.dispatch(move |d| async move { d.pointer(event).await }).await
    }

    pub async fn click(&mut self, at: Point, button: &str, count: i64) -> Result<()> {
        self.move_to(at, 1).await?;
        self.click_after_move(button, count).await
    }

    /// Presses and releases at the pointer's current position, after a caller has moved it there.
    pub async fn click_after_move(&mut self, button: &str, count: i64) -> Result<()> {
        let new_tab = button == "middle"
            || self.modifiers.contains(Modifiers::CONTROL)
            || self.modifiers.contains(Modifiers::META)
            || self.modifiers.contains(Modifiers::SHIFT);
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

    pub async fn wheel(&mut self, at: Point, dx: f64, dy: f64) -> Result<()> {
        let at = self.move_to(at, 1).await?;
        let modifiers = self.modifiers;
        if self.human {
            for frame in human::glide(dx, dy) {
                let event = PointerEvent::Wheel {
                    x: at.x,
                    y: at.y,
                    delta_x: (frame.x * 100.0).round() / 100.0,
                    delta_y: (frame.y * 100.0).round() / 100.0,
                    modifiers,
                };
                self.pace(human::random(15.5, 18.0), move |d| async move { d.pointer(event).await })
                    .await?;
            }
            Ok(())
        } else {
            let event = PointerEvent::Wheel { x: at.x, y: at.y, delta_x: dx, delta_y: dy, modifiers };
            self.dispatch(move |d| async move { d.pointer(event).await }).await
        }
    }

    pub async fn wheel_direct(&mut self, at: Point, dx: f64, dy: f64) -> Result<()> {
        let modifiers = self.modifiers;
        let mv = PointerEvent::Move { x: at.x, y: at.y, modifiers };
        self.dispatch(move |d| async move { d.pointer(mv).await }).await?;
        self.state.pointer = Some(at);
        let wh = PointerEvent::Wheel { x: at.x, y: at.y, delta_x: dx, delta_y: dy, modifiers };
        self.dispatch(move |d| async move { d.pointer(wh).await }).await
    }

    pub async fn key_down(&mut self, key: &KeyDef) -> Result<()> {
        if self.human {
            self.state.before_key().await;
        }
        self.modifiers.insert(modifier_flag(&key.key));
        let event = KeyEvent {
            down: true,
            key: key.key.clone(),
            code: key.code.clone(),
            text: key.text.clone(),
            modifiers: self.modifiers,
            mac: self.mac,
        };
        self.dispatch(move |d| async move { d.key(event).await }).await
    }

    pub async fn key_up(&mut self, key: &KeyDef) -> Result<()> {
        self.modifiers.remove(modifier_flag(&key.key));
        let event = KeyEvent {
            down: false,
            key: key.key.clone(),
            code: key.code.clone(),
            text: String::new(),
            modifiers: self.modifiers,
            mac: self.mac,
        };
        self.dispatch(move |d| async move { d.key(event).await }).await
    }

    pub async fn press(&mut self, combo: &str) -> Result<()> {
        let mut chars = combo.chars();
        if let (Some(c), None) = (chars.next(), chars.next())
            && char_definition(c).is_none()
            && key_definition(combo).is_none()
        {
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
        if self.modifiers.contains(Modifiers::SHIFT)
            && def.key.chars().count() == 1
            && let Some(upper) = shifted(&def.key)
        {
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

    pub async fn type_text(&mut self, text: &str, delay_ms: f64) -> Result<()> {
        for c in text.chars() {
            match char_definition(c) {
                Some((def, needs_shift)) => {
                    let shift = key_definition("Shift").unwrap();
                    if needs_shift && !self.modifiers.contains(Modifiers::SHIFT) {
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
        let text = text.to_string();
        self.dispatch(move |d| async move { d.insert_text(&text).await }).await
    }

    /// Performs a drag from `from` to `to`, delegating HTML5 drag interception to the driver.
    pub async fn drag(&mut self, from: Point, to: Point, steps: usize) -> Result<DragOutcome> {
        let path: Vec<PointerStep> = if self.human {
            let bounds = self.viewport().await;
            human::trajectory(from, to)
                .into_iter()
                .map(|(p, delay_ms)| {
                    let p = human::clamp_point(p, bounds);
                    PointerStep { x: p.x, y: p.y, delay_ms }
                })
                .collect()
        } else if steps > 1 {
            (1..steps)
                .map(|i| {
                    let t = i as f64 / steps as f64;
                    PointerStep {
                        x: from.x + (to.x - from.x) * t,
                        y: from.y + (to.y - from.y) * t,
                        delay_ms: 0.0,
                    }
                })
                .collect()
        } else {
            Vec::new()
        };
        if self.page.dialog().is_some() {
            return Err(Interrupted.into());
        }
        let outcome = tokio::select! {
            result = self.page.driver().drag((from.x, from.y), (to.x, to.y), &path, self.modifiers) => {
                result.map_err(crate::page::driver_error)?
            }
            _ = self.page.dialog_opened() => return Err(Interrupted.into()),
        };
        self.state.pointer = Some(to);
        Ok(outcome)
    }

    pub async fn reset(&mut self) {
        for name in ["Shift", "Control", "Alt", "Meta"] {
            if self.modifiers.contains(modifier_flag(name)) {
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
        assert_eq!(key_definition("F5").unwrap().code, "F5");
        assert_eq!(key_definition("Enter").unwrap().text, "\r");
    }
}
