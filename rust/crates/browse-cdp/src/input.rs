//! CDP input translation: maps DOM `KeyEvent` / `PointerEvent` to CDP `Input.dispatchKeyEvent` /
//! `Input.dispatchMouseEvent` parameters (Windows virtual key codes, key location, macOS editing commands).

use browse_core::{KeyEvent, Modifiers, MouseButton};
use serde_json::{Value, json};

pub(crate) fn button_bit(button: MouseButton) -> i64 {
    match button {
        MouseButton::Left => 1,
        MouseButton::Right => 2,
        MouseButton::Middle => 4,
        MouseButton::Back => 8,
        MouseButton::Forward => 16,
        MouseButton::None => 0,
    }
}

pub(crate) fn pressed_button(buttons: i64) -> &'static str {
    if buttons & 1 != 0 {
        "left"
    } else if buttons & 2 != 0 {
        "right"
    } else if buttons & 4 != 0 {
        "middle"
    } else {
        "none"
    }
}

pub(crate) fn windows_vk(code: &str, key: &str) -> (i64, i64) {
    let named = match code {
        "Enter" => Some((13, 0)),
        "Tab" => Some((9, 0)),
        "Backspace" => Some((8, 0)),
        "Escape" => Some((27, 0)),
        "Delete" => Some((46, 0)),
        "Insert" => Some((45, 0)),
        "Home" => Some((36, 0)),
        "End" => Some((35, 0)),
        "PageUp" => Some((33, 0)),
        "PageDown" => Some((34, 0)),
        "ArrowLeft" => Some((37, 0)),
        "ArrowUp" => Some((38, 0)),
        "ArrowRight" => Some((39, 0)),
        "ArrowDown" => Some((40, 0)),
        "Space" => Some((32, 0)),
        "CapsLock" => Some((20, 0)),
        "ContextMenu" => Some((93, 0)),
        "ShiftLeft" => Some((16, 1)),
        "ShiftRight" => Some((16, 2)),
        "ControlLeft" => Some((17, 1)),
        "ControlRight" => Some((17, 2)),
        "AltLeft" => Some((18, 1)),
        "AltRight" => Some((18, 2)),
        "MetaLeft" => Some((91, 1)),
        "MetaRight" => Some((92, 2)),
        "Backquote" => Some((192, 0)),
        "Minus" => Some((189, 0)),
        "Equal" => Some((187, 0)),
        "BracketLeft" => Some((219, 0)),
        "BracketRight" => Some((221, 0)),
        "Backslash" => Some((220, 0)),
        "Semicolon" => Some((186, 0)),
        "Quote" => Some((222, 0)),
        "Comma" => Some((188, 0)),
        "Period" => Some((190, 0)),
        "Slash" => Some((191, 0)),
        _ => None,
    };
    if let Some(pair) = named {
        return pair;
    }
    if let Some(rest) = code.strip_prefix("Key")
        && let Some(c) = rest.chars().next()
        && rest.len() == 1
    {
        return (c.to_ascii_uppercase() as i64, 0);
    }
    if let Some(rest) = code.strip_prefix("Digit")
        && let Some(c) = rest.chars().next()
        && rest.len() == 1
    {
        return (c as i64, 0);
    }
    if let Some(number) = code.strip_prefix('F').and_then(|n| n.parse::<i64>().ok())
        && (1..=12).contains(&number)
    {
        return (111 + number, 0);
    }
    let fallback = key.chars().next().map(|c| c.to_ascii_uppercase() as i64).unwrap_or(0);
    (fallback, 0)
}

/// macOS editing commands Chrome needs alongside key events for shortcuts to act on text fields.
fn mac_command(modifiers: Modifiers, code: &str) -> Option<&'static str> {
    let shift = modifiers.contains(Modifiers::SHIFT);
    let meta = modifiers.contains(Modifiers::META);
    let alt = modifiers.contains(Modifiers::ALT);
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

pub(crate) fn key_event_params(event: &KeyEvent) -> Value {
    let (vk, location) = windows_vk(&event.code, &event.key);
    let modifiers = event.modifiers.bits() as i64;
    if !event.down {
        return json!({
            "type": "keyUp",
            "modifiers": modifiers,
            "key": event.key,
            "windowsVirtualKeyCode": vk,
            "nativeVirtualKeyCode": vk,
            "code": event.code,
            "location": location,
        });
    }
    let has_shortcut_mod = event.modifiers.contains(Modifiers::CONTROL)
        || event.modifiers.contains(Modifiers::ALT)
        || event.modifiers.contains(Modifiers::META);
    let text = if has_shortcut_mod { "" } else { event.text.as_str() };
    let mut params = json!({
        "type": if text.is_empty() { "rawKeyDown" } else { "keyDown" },
        "modifiers": modifiers,
        "windowsVirtualKeyCode": vk,
        "nativeVirtualKeyCode": vk,
        "code": event.code,
        "key": event.key,
        "text": text,
        "unmodifiedText": text,
        "location": location,
        "autoRepeat": false,
        "isKeypad": false,
    });
    if event.mac
        && let Some(command) = mac_command(event.modifiers, &event.code)
    {
        params["commands"] = json!([command]);
    }
    params
}
