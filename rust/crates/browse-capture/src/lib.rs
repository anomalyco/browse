//! Capture tools: screenshots (labels, element clips, full page, diff), network capture with redaction, opt-in page
//! console capture and screen recording (CDP screencast → MJPEG Matroska, optionally transcoded with ffmpeg).
//! Downloads aren't offered: Chrome refuses Page/Browser.setDownloadBehavior through chrome.debugger, and the browser
//! may run on another machine than the relay. Everything runs over raw CDP through `ToolContext::browser`; nothing
//! enables the Runtime or Console domains unless the agent starts a console capture.

use std::sync::Arc;

use browse_core::{Tool, ToolContext, ToolOutput};
use serde::Serialize;
use serde_json::Value;

mod console;
mod files;
mod labels;
pub mod mkv;
mod network;
mod page;
pub mod pixeldiff;
pub mod redaction;
mod recording;
mod screencast;
mod screenshot;
mod state;
#[cfg(test)]
mod testing;
#[cfg(test)]
mod unit_tests;

pub fn tools() -> Vec<Arc<dyn Tool>> {
    vec![
        Arc::new(screenshot::ScreenshotTool),
        Arc::new(screenshot::ScreenshotDiffTool),
        Arc::new(network::NetworkTool),
        Arc::new(console::ConsoleTool),
        Arc::new(recording::RecordingTool),
    ]
}

/// A tool's failure the agent can act on, returned as an error result instead of a transport error.
#[derive(Debug)]
pub(crate) struct UserError(pub String);

impl std::fmt::Display for UserError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for UserError {}

macro_rules! bail_user {
    ($($arg:tt)*) => { return Err(anyhow::Error::new($crate::UserError(format!($($arg)*)))) };
}
pub(crate) use bail_user;

/// Runs a tool body, turning `UserError`s and CDP errors into error results the agent sees.
pub(crate) async fn respond(result: anyhow::Result<ToolOutput>) -> anyhow::Result<ToolOutput> {
    match result {
        Ok(output) => Ok(output),
        Err(error) => Ok(ToolOutput::error(format!("{error:#}"))),
    }
}

pub(crate) fn json_output(value: &impl Serialize) -> anyhow::Result<ToolOutput> {
    Ok(ToolOutput::text(serde_json::to_string(value)?))
}

pub(crate) fn arg_str<'a>(args: &'a Value, name: &str) -> anyhow::Result<Option<&'a str>> {
    match args.get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) => Ok(Some(text.as_str())),
        Some(_) => bail_user!("{name} must be a string"),
    }
}

pub(crate) fn arg_bool(args: &Value, name: &str) -> anyhow::Result<Option<bool>> {
    match args.get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Bool(value)) => Ok(Some(*value)),
        Some(_) => bail_user!("{name} must be a boolean"),
    }
}

pub(crate) fn arg_f64(args: &Value, name: &str) -> anyhow::Result<Option<f64>> {
    match args.get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(number)) => Ok(number.as_f64()),
        Some(_) => bail_user!("{name} must be a number"),
    }
}

/// An integer argument within `min..=max`.
pub(crate) fn arg_int(args: &Value, name: &str, min: i64, max: i64) -> anyhow::Result<Option<i64>> {
    match args.get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(number)) => match number.as_i64() {
            Some(value) if (min..=max).contains(&value) => Ok(Some(value)),
            _ => bail_user!("{name} must be an integer from {min} to {max}"),
        },
        Some(_) => bail_user!("{name} must be an integer from {min} to {max}"),
    }
}

pub(crate) fn arg_action<'a>(args: &'a Value, actions: &[&str]) -> anyhow::Result<&'a str> {
    match arg_str(args, "action")? {
        Some(action) if actions.contains(&action) => Ok(action),
        _ => bail_user!("action must be one of: {}", actions.join(", ")),
    }
}

/// The tab a call targets: `tab` when given, else the session's current tab.
pub(crate) async fn target_tab(ctx: &ToolContext, args: &Value) -> anyhow::Result<browse_core::TabId> {
    match arg_tab(args)? {
        Some(tab) => Ok(tab),
        None => Ok(ctx.browser.current_tab(&ctx.session).await?.tab_id),
    }
}

/// The `tab` argument when one was given.
pub(crate) fn arg_tab(args: &Value) -> anyhow::Result<Option<browse_core::TabId>> {
    match args.get("tab") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(number)) => match number.as_i64() {
            Some(tab) => Ok(Some(tab)),
            None => bail_user!("tab must be an integer tab id"),
        },
        Some(_) => bail_user!("tab must be an integer tab id"),
    }
}

pub(crate) fn tab_schema() -> Value {
    serde_json::json!({ "type": "integer", "description": "Tab id. Defaults to the session's current tab." })
}

pub(crate) fn now_iso() -> String {
    iso_time(std::time::SystemTime::now())
}

/// RFC 3339 UTC with milliseconds, like `Date.prototype.toISOString`.
pub(crate) fn iso_time(time: std::time::SystemTime) -> String {
    let duration = time.duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
    let millis = duration.as_millis() as i64;
    let seconds = millis.div_euclid(1000);
    let days = seconds.div_euclid(86_400);
    let rem = seconds.rem_euclid(86_400);
    // Civil-from-days (Howard Hinnant).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + if month <= 2 { 1 } else { 0 };
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60,
        millis.rem_euclid(1000)
    )
}

#[cfg(test)]
mod tests {
    #[test]
    fn iso_time_formats_like_javascript() {
        let time = std::time::UNIX_EPOCH + std::time::Duration::from_millis(1_794_614_400_123);
        assert_eq!(super::iso_time(time), "2026-11-14T00:00:00.123Z");
    }
}
