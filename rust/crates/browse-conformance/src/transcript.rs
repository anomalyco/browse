//! Recorded tool calls and their structural normalization.
//!
//! Only what can't be the same on two runs is scrubbed: the fixture origins (exact `127.0.0.1:<port>` and
//! `localhost:<port>` strings become `PRIMARY` and `CROSS`), the file roots (`<FILES>`), timings and timestamps (checked,
//! then `<TIME>`), network exchange ids (renumbered in order), multipart boundaries, byte counts (checked positive, then
//! `<BYTES>`), image bytes (replaced by their type, size and probed pixel colors), and headers outside a short allowlist.
//! Everything else stays strict: snapshot text and refs, URLs, statuses, bodies, console entries, error texts and
//! numbers.

use std::collections::HashMap;
use std::path::PathBuf;

use base64::Engine;
use browse_core::{Content, ToolOutput};
use serde_json::{Map, Value, json};

/// Keys whose values are timings or timestamps.
const TIME_KEYS: &[&str] = &[
    "waitedMs",
    "durationMs",
    "startedDateTime",
    "time",
    "startedAt",
    "elapsedMs",
    "endedAt",
    "endsAt",
    "stoppedAt",
    // A recording's frame pacing depends on the machine's speed.
    "sourceFrameCount",
    "encodedSourceFrameCount",
    "coalescedFrameCount",
    "droppedFrameCount",
    "achievedSourceFrameRate",
];
/// Keys whose values are byte counts of generated files.
const BYTE_KEYS: &[&str] = &["bytes"];
/// Sizes that depend on the browser: a capture's body total includes multipart bodies, whose boundaries differ in
/// length by browser.
const SIZE_KEYS: &[&str] = &["capturedBodyBytes"];
/// Keys whose values are frame counts of recordings.
const COUNT_KEYS: &[&str] = &["frameCount"];
/// The headers kept in network captures; the rest differ by browser for reasons outside browse.
pub const HEADER_ALLOWLIST: &[&str] = &["content-type", "authorization", "cookie", "set-cookie", "location", "content-length"];

/// What a step expects of its call.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Expect {
    Ok,
    Error,
}

#[derive(Debug, Clone)]
pub struct StepRecord {
    pub scenario: String,
    pub step: String,
    pub tool: String,
    pub expect: Expect,
    pub is_error: bool,
    /// The texts the tool returned, joined (images as a placeholder line).
    pub raw: String,
    pub normalized: Value,
    pub images: Vec<Value>,
    /// Normalizer checks that failed (a timing that wasn't a number, an empty image, ...).
    pub problems: Vec<String>,
}

impl StepRecord {
    pub fn key(&self) -> String {
        format!("{}/{}", self.scenario, self.step)
    }

    pub fn to_json(&self) -> Value {
        json!({
            "scenario": self.scenario,
            "step": self.step,
            "tool": self.tool,
            "expect": match self.expect { Expect::Ok => "ok", Expect::Error => "error" },
            "isError": self.is_error,
            "raw": self.raw,
            "normalized": self.normalized,
        })
    }
}

/// The run-specific strings the normalizer replaces.
#[derive(Debug, Clone)]
pub struct Normalizer {
    pub primary: String,
    pub cross: String,
    pub files: Vec<PathBuf>,
}

impl Normalizer {
    pub fn text(&self, text: &str) -> String {
        let mut out = text.replace(&self.primary, "PRIMARY").replace(&self.cross, "CROSS");
        for root in &self.files {
            let shown = root.display().to_string();
            if shown.len() > 1 {
                out = out.replace(&shown, "<FILES>");
                out = out.replace(&shown.replace('\\', "\\\\"), "<FILES>");
            }
        }
        out
    }

    /// Normalizes one tool result; `probes` are the image points whose colors are kept.
    pub fn output(&self, output: &ToolOutput, probes: &[(u32, u32)]) -> (String, Value, Vec<Value>, Vec<String>) {
        let mut problems = Vec::new();
        let mut texts = Vec::new();
        let mut raw = Vec::new();
        let mut images = Vec::new();
        for content in &output.content {
            match content {
                Content::Text { text } => {
                    raw.push(text.clone());
                    texts.push(text.clone());
                }
                Content::Image { data, mime_type } => {
                    let bytes = base64::engine::general_purpose::STANDARD.decode(data).unwrap_or_default();
                    raw.push(format!("[image {mime_type} {} bytes]", bytes.len()));
                    images.push(image_summary(&bytes, mime_type, probes, &mut problems));
                }
            }
        }
        let joined = texts.join("\n");
        let result = match serde_json::from_str::<Value>(&joined) {
            Ok(value) if value.is_object() || value.is_array() => self.value(value, &mut problems),
            _ => Value::Array(self.text(&joined).lines().map(|line| Value::String(line.to_string())).collect()),
        };
        let normalized = json!({ "error": output.is_error, "result": result, "images": images.clone() });
        (raw.join("\n"), normalized, images, problems)
    }

    pub fn value(&self, value: Value, problems: &mut Vec<String>) -> Value {
        self.walk(None, value, problems)
    }

    fn walk(&self, key: Option<&str>, value: Value, problems: &mut Vec<String>) -> Value {
        if let Some(key) = key {
            if TIME_KEYS.contains(&key) {
                let valid = match &value {
                    Value::Number(n) => n.as_f64().is_some_and(|n| n >= 0.0),
                    Value::String(s) => !s.is_empty(),
                    _ => false,
                };
                if !valid {
                    problems.push(format!("{key} is not a timing: {value}"));
                }
                return json!("<TIME>");
            }
            if SIZE_KEYS.contains(&key) {
                if value.as_u64().is_none() {
                    problems.push(format!("{key} is not a size: {value}"));
                }
                return json!("<LEN>");
            }
            if BYTE_KEYS.contains(&key) || COUNT_KEYS.contains(&key) {
                if value.as_u64().is_none_or(|n| n == 0) {
                    problems.push(format!("{key} is not a positive count: {value}"));
                }
                return json!(if BYTE_KEYS.contains(&key) { "<BYTES>" } else { "<COUNT>" });
            }
            if key == "headers"
                && let Value::Array(items) = &value
                && items.iter().all(|h| h.get("name").is_some())
            {
                return self.headers(items, problems);
            }
        }
        match value {
            Value::String(s) => Value::String(self.text(&s)),
            Value::Array(items) => Value::Array(items.into_iter().map(|item| self.walk(None, item, problems)).collect()),
            Value::Object(map) => Value::Object(
                map.into_iter()
                    .map(|(k, v)| {
                        let v = match (k.as_str(), v) {
                            ("exchanges", Value::Array(items)) => self.exchanges(items, problems),
                            (_, v) => self.walk(Some(&k), v, problems),
                        };
                        (k, v)
                    })
                    .collect(),
            ),
            other => other,
        }
    }

    fn headers(&self, items: &[Value], problems: &mut Vec<String>) -> Value {
        let mut kept: Vec<(String, Value)> = items
            .iter()
            .filter_map(|h| {
                let name = h.get("name")?.as_str()?.to_ascii_lowercase();
                (HEADER_ALLOWLIST.contains(&name.as_str()) || name.starts_with("x-conformance-"))
                    .then(|| (name, self.walk(None, h.get("value").cloned().unwrap_or(Value::Null), problems)))
            })
            .collect();
        kept.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.to_string().cmp(&b.1.to_string())));
        Value::Array(kept.into_iter().map(|(name, value)| json!({ "name": name, "value": value })).collect())
    }

    fn exchanges(&self, items: Vec<Value>, problems: &mut Vec<String>) -> Value {
        let mut ids: HashMap<String, String> = HashMap::new();
        for item in &items {
            if let Some(id) = item.get("id").and_then(Value::as_str) {
                let next = format!("#{}", ids.len() + 1);
                ids.entry(id.to_string()).or_insert(next);
            }
        }
        let renumber = |value: &Value| match value.as_str() {
            Some(id) => json!(ids.get(id).cloned().unwrap_or_else(|| "<UNKNOWN-ID>".into())),
            None => value.clone(),
        };
        let out = items
            .into_iter()
            .map(|mut item| {
                if let Some(id) = item.get("id") {
                    item["id"] = renumber(id);
                }
                if let Some(from) = item.pointer("/request/redirectedFrom").cloned() {
                    item["request"]["redirectedFrom"] = renumber(&from);
                }
                let boundary = item
                    .pointer("/request/headers")
                    .and_then(Value::as_array)
                    .and_then(|headers| {
                        headers.iter().find(|h| h["name"].as_str().is_some_and(|n| n.eq_ignore_ascii_case("content-type")))
                    })
                    .and_then(|h| h["value"].as_str())
                    .and_then(|v| v.split("boundary=").nth(1))
                    .map(|b| b.trim_matches('"').to_string());
                if let Some(boundary) = boundary.filter(|b| !b.is_empty()) {
                    item = replace_strings(item, &boundary, "<BOUNDARY>");
                    // The boundary's length differs by browser, and so do the sizes it is part of.
                    if item.pointer("/request/body/size").is_some() {
                        item["request"]["body"]["size"] = json!("<LEN>");
                    }
                    if let Some(Value::Array(headers)) = item.pointer_mut("/request/headers") {
                        for header in headers {
                            if header["name"].as_str().is_some_and(|n| n.eq_ignore_ascii_case("content-length")) {
                                header["value"] = json!("<LEN>");
                            }
                        }
                    }
                }
                let Value::Object(map) = item else { return item };
                Value::Object(map.into_iter().map(|(k, v)| (k.clone(), self.walk(Some(&k), v, problems))).collect::<Map<_, _>>())
            })
            .collect();
        Value::Array(out)
    }
}

fn replace_strings(value: Value, from: &str, to: &str) -> Value {
    match value {
        Value::String(s) => Value::String(s.replace(from, to)),
        Value::Array(items) => Value::Array(items.into_iter().map(|v| replace_strings(v, from, to)).collect()),
        Value::Object(map) => Value::Object(map.into_iter().map(|(k, v)| (k, replace_strings(v, from, to))).collect()),
        other => other,
    }
}

/// Width and height of a PNG, JPEG or WebP.
pub fn image_size(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") && bytes.len() >= 24 {
        let w = u32::from_be_bytes(bytes[16..20].try_into().ok()?);
        let h = u32::from_be_bytes(bytes[20..24].try_into().ok()?);
        return Some((w, h));
    }
    if bytes.starts_with(&[0xff, 0xd8]) {
        let mut i = 2;
        while i + 9 < bytes.len() {
            if bytes[i] != 0xff {
                i += 1;
                continue;
            }
            let marker = bytes[i + 1];
            let length = u16::from_be_bytes([bytes[i + 2], bytes[i + 3]]) as usize;
            if (0xc0..=0xcf).contains(&marker) && marker != 0xc4 && marker != 0xc8 && marker != 0xcc {
                let h = u16::from_be_bytes([bytes[i + 5], bytes[i + 6]]) as u32;
                let w = u16::from_be_bytes([bytes[i + 7], bytes[i + 8]]) as u32;
                return Some((w, h));
            }
            i += 2 + length;
        }
        return None;
    }
    if bytes.len() >= 30 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        match &bytes[12..16] {
            b"VP8 " => {
                let w = u16::from_le_bytes([bytes[26], bytes[27]]) as u32 & 0x3fff;
                let h = u16::from_le_bytes([bytes[28], bytes[29]]) as u32 & 0x3fff;
                return Some((w, h));
            }
            b"VP8L" => {
                let b = &bytes[21..25];
                let w = 1 + (((b[1] as u32 & 0x3f) << 8) | b[0] as u32);
                let h = 1 + (((b[3] as u32 & 0xf) << 10) | ((b[2] as u32) << 2) | ((b[1] as u32 & 0xc0) >> 6));
                return Some((w, h));
            }
            b"VP8X" => {
                let w = 1 + (bytes[24] as u32 | (bytes[25] as u32) << 8 | (bytes[26] as u32) << 16);
                let h = 1 + (bytes[27] as u32 | (bytes[28] as u32) << 8 | (bytes[29] as u32) << 16);
                return Some((w, h));
            }
            _ => {}
        }
    }
    None
}

/// The RGBA pixels of a PNG.
pub fn decode_png(bytes: &[u8]) -> Option<(u32, u32, Vec<u8>)> {
    let mut decoder = png::Decoder::new(std::io::Cursor::new(bytes));
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut reader = decoder.read_info().ok()?;
    let mut buffer = vec![0; reader.output_buffer_size()?];
    let info = reader.next_frame(&mut buffer).ok()?;
    let data = &buffer[..info.buffer_size()];
    let rgba = match info.color_type {
        png::ColorType::Rgba => data.to_vec(),
        png::ColorType::Rgb => data.as_chunks::<3>().0.iter().flat_map(|p| [p[0], p[1], p[2], 255]).collect(),
        png::ColorType::GrayscaleAlpha => data.as_chunks::<2>().0.iter().flat_map(|p| [p[0], p[0], p[0], p[1]]).collect(),
        png::ColorType::Grayscale => data.iter().flat_map(|g| [*g, *g, *g, 255]).collect(),
        png::ColorType::Indexed => return None,
    };
    Some((info.width, info.height, rgba))
}

fn image_summary(bytes: &[u8], mime: &str, probes: &[(u32, u32)], problems: &mut Vec<String>) -> Value {
    if bytes.is_empty() {
        problems.push(format!("an empty {mime} image"));
    }
    let size = image_size(bytes);
    if size.is_none() {
        problems.push(format!("an unreadable {mime} image"));
    }
    let (width, height) = size.unwrap_or((0, 0));
    let mut colors = Map::new();
    if !probes.is_empty() {
        match decode_png(bytes) {
            Some((w, _, rgba)) => {
                for (x, y) in probes {
                    let at = ((*y as usize) * (w as usize) + (*x as usize)) * 4;
                    let color = rgba
                        .get(at..at + 4)
                        .map(|p| format!("#{:02x}{:02x}{:02x}", p[0], p[1], p[2]))
                        .unwrap_or_else(|| "outside".into());
                    colors.insert(format!("{x},{y}"), json!(color));
                }
            }
            None => problems.push("probes need a PNG".into()),
        }
    }
    json!({ "mime": mime, "width": width, "height": height, "probes": colors })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn normalizer() -> Normalizer {
        Normalizer { primary: "127.0.0.1:5000".into(), cross: "localhost:6000".into(), files: vec![PathBuf::from("/tmp/roots/x")] }
    }

    #[test]
    fn origins_and_files_are_replaced_exactly() {
        let n = normalizer();
        assert_eq!(n.text("http://127.0.0.1:5000/a http://localhost:6000/b"), "http://PRIMARY/a http://CROSS/b");
        assert_eq!(n.text("http://127.0.0.1:50001/a"), "http://PRIMARY1/a", "only the exact string is replaced");
        assert_eq!(n.text("saved /tmp/roots/x/shot.png"), "saved <FILES>/shot.png");
        assert_eq!(n.text("http://localhost:7000/"), "http://localhost:7000/");
    }

    #[test]
    fn timings_are_checked_then_scrubbed() {
        let n = normalizer();
        let mut problems = Vec::new();
        let value = n.value(json!({ "waitedMs": 12, "ok": true, "n": 3 }), &mut problems);
        assert_eq!(value, json!({ "waitedMs": "<TIME>", "ok": true, "n": 3 }));
        assert!(problems.is_empty());
        n.value(json!({ "durationMs": -1, "bytes": 0 }), &mut problems);
        assert_eq!(problems.len(), 2, "{problems:?}");
    }

    #[test]
    fn exchanges_are_renumbered_and_headers_projected() {
        let n = normalizer();
        let mut problems = Vec::new();
        let value = n.value(
            json!({ "exchanges": [
                { "id": "77.1", "startedDateTime": "2026-01-01T00:00:00Z", "durationMs": 3, "request": { "url": "http://127.0.0.1:5000/a", "headers": [{ "name": "User-Agent", "value": "x" }, { "name": "Cookie", "value": "[redacted]" }] } },
                { "id": "77.2", "startedDateTime": "2026-01-01T00:00:00Z", "durationMs": 3, "request": { "redirectedFrom": "77.1", "headers": [{ "name": "Content-Type", "value": "multipart/form-data; boundary=----abc" }, { "name": "content-length", "value": "99" }], "body": { "size": 99, "text": "------abc\r\nx\r\n------abc--" } } }
            ] }),
            &mut problems,
        );
        assert!(problems.is_empty(), "{problems:?}");
        assert_eq!(value["exchanges"][0]["id"], "#1");
        assert_eq!(value["exchanges"][1]["request"]["redirectedFrom"], "#1");
        assert_eq!(value["exchanges"][0]["request"]["url"], "http://PRIMARY/a");
        assert_eq!(value["exchanges"][0]["request"]["headers"], json!([{ "name": "cookie", "value": "[redacted]" }]));
        assert_eq!(value["exchanges"][1]["request"]["body"], json!({ "size": "<LEN>", "text": "--<BOUNDARY>\r\nx\r\n--<BOUNDARY>--" }));
        assert_eq!(value["exchanges"][1]["request"]["headers"][0]["value"], "<LEN>");
    }

    #[test]
    fn images_become_their_size_and_probed_colors() {
        let png = crate::sites::fixture_png();
        assert_eq!(image_size(&png), Some((4, 2)));
        let mut problems = Vec::new();
        let summary = image_summary(&png, "image/png", &[(0, 0), (2, 0), (0, 1)], &mut problems);
        assert_eq!(summary["probes"], json!({ "0,0": "#ff0000", "2,0": "#0000ff", "0,1": "#000000" }));
        assert!(problems.is_empty());
        image_summary(&[], "image/png", &[], &mut problems);
        assert_eq!(problems.len(), 2);
    }

    #[test]
    fn plain_text_is_kept_line_by_line() {
        let n = normalizer();
        let (_, normalized, _, _) = n.output(&ToolOutput::text("- button \"Go\" [ref=e1]\n- link \"http://127.0.0.1:5000/x\""), &[]);
        assert_eq!(normalized["result"], json!(["- button \"Go\" [ref=e1]", "- link \"http://PRIMARY/x\""]));
    }
}