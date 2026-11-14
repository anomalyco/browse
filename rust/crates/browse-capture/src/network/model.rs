//! Captured exchanges and their final redaction pass (port of cli/src/network-capture/capture.ts).

use serde::Serialize;
use serde_json::Value;

use crate::redaction::{Header, MINIMUM_KNOWN_SUBSTRING_LENGTH, SecretRedactor};

pub const MAX_BODY_BYTES: usize = 1_000_000;
pub const MAX_TOTAL_BODY_BYTES: usize = 25_000_000;
pub const MAX_ENTRIES: usize = 1_000;
// Inside JSON string values only longer known values are replaced: ordinary text rarely contains 16 characters of a
// credential.
const MINIMUM_KNOWN_BODY_SUBSTRING_LENGTH: usize = 16;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapturedBody {
    pub size: usize,
    pub mime_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapturedRequest {
    pub method: String,
    pub url: String,
    pub headers: Vec<Header>,
    pub resource_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<CapturedBody>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub redirected_from: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapturedResponse {
    pub status: i64,
    pub status_text: String,
    pub headers: Vec<Header>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<CapturedBody>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapturedEntry {
    pub id: String,
    pub started_date_time: String,
    pub duration_ms: u64,
    pub request: CapturedRequest,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response: Option<CapturedResponse>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure: Option<String>,
}

pub fn header<'a>(headers: &'a [Header], name: &str) -> Option<&'a str> {
    headers.iter().find(|header| header.name.eq_ignore_ascii_case(name)).map(|header| header.value.as_str())
}

pub fn content_type(headers: &[Header]) -> Option<String> {
    header(headers, "content-type").map(|value| value.trim().to_string())
}

pub fn declared_body_size(headers: &[Header]) -> Option<usize> {
    header(headers, "content-length").and_then(|value| value.trim().parse().ok())
}

pub fn is_textual_mime_type(mime: Option<&str>) -> bool {
    let Some(mime) = mime else { return true };
    let mime = mime.to_ascii_lowercase();
    mime.starts_with("text/")
        || ["json", "javascript", "xml", "x-www-form-urlencoded", "multipart/form-data", "graphql"]
            .iter()
            .any(|needle| mime.contains(needle))
}

/// Whether a body of `size` bytes (declared or measured) with these headers fits in `limit`.
pub fn body_can_fit(headers: &[Header], size: Option<usize>, limit: usize) -> bool {
    if limit == 0 {
        return false;
    }
    let encoding = header(headers, "content-encoding").map(|value| value.trim().to_ascii_lowercase());
    let supported = matches!(encoding.as_deref(), None | Some("identity" | "gzip" | "br" | "deflate" | "zstd"));
    if !supported {
        return false;
    }
    match size.or_else(|| declared_body_size(headers)) {
        Some(size) => size <= limit,
        // Unknown size: fetch textual bodies only; the budget still cuts them off at the limit.
        None => is_textual_mime_type(content_type(headers).as_deref()),
    }
}

/// Body budget shared by one capture.
#[derive(Default)]
pub struct Budget {
    pub captured_body_bytes: usize,
    pub truncated_body_count: usize,
}

impl Budget {
    pub fn remaining(&self) -> usize {
        MAX_TOTAL_BODY_BYTES.saturating_sub(self.captured_body_bytes).min(MAX_BODY_BYTES)
    }

    pub fn capture(&mut self, bytes: &[u8], mime: Option<&str>) -> CapturedBody {
        let remaining = MAX_TOTAL_BODY_BYTES.saturating_sub(self.captured_body_bytes);
        let take = bytes.len().min(MAX_BODY_BYTES).min(remaining);
        let truncated = take < bytes.len();
        self.captured_body_bytes += take;
        let textual = is_textual_mime_type(mime);
        let omitted = truncated || !textual;
        if omitted {
            self.truncated_body_count += 1;
        }
        CapturedBody {
            size: bytes.len(),
            mime_type: mime.unwrap_or("application/octet-stream").to_string(),
            text: (!truncated && textual).then(|| String::from_utf8_lossy(bytes).into_owned()),
            truncated: omitted,
        }
    }

    pub fn truncated(&mut self, mime: Option<&str>, size: usize) -> CapturedBody {
        self.truncated_body_count += 1;
        CapturedBody { size, mime_type: mime.unwrap_or("application/octet-stream").to_string(), text: None, truncated: true }
    }
}

/// Every captured exchange redacted for output; the redactor also covers values learned from later entries.
pub fn finish(entries: &[CapturedEntry]) -> (Vec<CapturedEntry>, usize) {
    let mut redactor = SecretRedactor::new();
    let protected: Vec<CapturedEntry> = entries.iter().map(|entry| protect_entry(entry, &mut redactor)).collect();
    let redacted: Vec<CapturedEntry> = protected.into_iter().map(|entry| redact_known_values(entry, &redactor)).collect();
    let omissions = count_redaction_omissions(entries, &redacted);
    (redacted, omissions)
}

fn count_redaction_omissions(original: &[CapturedEntry], redacted: &[CapturedEntry]) -> usize {
    let had = |body: Option<&CapturedBody>| body.is_some_and(|body| body.text.is_some() && !body.truncated);
    let lost = |body: Option<&CapturedBody>| body.is_none_or(|body| body.text.is_none());
    original
        .iter()
        .zip(redacted)
        .map(|(before, after)| {
            let request = had(before.request.body.as_ref()) && lost(after.request.body.as_ref());
            let response = had(before.response.as_ref().and_then(|r| r.body.as_ref()))
                && lost(after.response.as_ref().and_then(|r| r.body.as_ref()));
            request as usize + response as usize
        })
        .sum()
}

fn protect_body(body: &Option<CapturedBody>, redactor: &mut SecretRedactor) -> Option<CapturedBody> {
    let body = body.as_ref()?;
    let omitted = CapturedBody { size: body.size, mime_type: body.mime_type.clone(), text: None, truncated: true };
    let Some(text) = &body.text else { return Some(omitted) };
    match redactor.protect_body(text, Some(&body.mime_type)) {
        Some(text) => Some(CapturedBody { text: Some(text), ..body.clone() }),
        None => Some(omitted),
    }
}

pub fn protect_entry(entry: &CapturedEntry, redactor: &mut SecretRedactor) -> CapturedEntry {
    let request_headers = redactor.protect_headers(&entry.request.headers);
    let response_headers = entry.response.as_ref().map(|response| redactor.protect_headers(&response.headers));
    let request_body = protect_body(&entry.request.body, redactor);
    let response_body = entry.response.as_ref().and_then(|response| protect_body(&response.body, redactor));
    CapturedEntry {
        request: CapturedRequest {
            url: redactor.protect_url(&entry.request.url),
            headers: request_headers,
            body: request_body,
            redirected_from: entry.request.redirected_from.as_ref().map(|url| redactor.protect_url(url)),
            ..entry.request.clone()
        },
        response: entry.response.as_ref().map(|response| CapturedResponse {
            headers: response_headers.unwrap_or_default(),
            body: response_body,
            ..response.clone()
        }),
        ..entry.clone()
    }
}

fn redact_known_values(entry: CapturedEntry, redactor: &SecretRedactor) -> CapturedEntry {
    let text = |value: &str| redactor.redact_known_substrings(value, MINIMUM_KNOWN_SUBSTRING_LENGTH);
    let headers = |headers: Vec<Header>| {
        headers.into_iter().map(|header| Header { value: text(&header.value), name: header.name }).collect::<Vec<_>>()
    };
    let body = |body: Option<CapturedBody>| body.map(|body| redact_structured_body(body, redactor));
    let mut entry = entry;
    entry.request.url = text(&entry.request.url);
    entry.request.headers = headers(std::mem::take(&mut entry.request.headers));
    entry.request.redirected_from = entry.request.redirected_from.as_deref().map(text);
    entry.request.body = body(entry.request.body.take());
    if let Some(response) = entry.response.as_mut() {
        response.headers = headers(std::mem::take(&mut response.headers));
        response.body = body(response.body.take());
    }
    entry
}

fn redact_structured_body(body: CapturedBody, redactor: &SecretRedactor) -> CapturedBody {
    let Some(text) = &body.text else { return body };
    if !body.mime_type.to_ascii_lowercase().contains("json") {
        return body;
    }
    match serde_json::from_str::<Value>(text) {
        Ok(value) => {
            let text = serde_json::to_string(&redact_known_scalars(value, redactor)).unwrap_or_default();
            CapturedBody { text: Some(text), ..body }
        }
        Err(_) => CapturedBody { text: None, truncated: true, ..body },
    }
}

fn redact_known_scalars(value: Value, redactor: &SecretRedactor) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.into_iter().map(|item| redact_known_scalars(item, redactor)).collect()),
        Value::Object(map) => {
            Value::Object(map.into_iter().map(|(key, item)| (key, redact_known_scalars(item, redactor))).collect())
        }
        Value::String(text) => Value::String(redactor.redact_known_substrings(&text, MINIMUM_KNOWN_BODY_SUBSTRING_LENGTH)),
        other => redactor.redact_scalar(&other),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(url: &str, request_headers: Vec<Header>, request_body: Option<&str>, response_body: Option<&str>) -> CapturedEntry {
        CapturedEntry {
            id: "request-1".into(),
            started_date_time: "2026-11-14T00:00:00.000Z".into(),
            duration_ms: 5,
            request: CapturedRequest {
                method: "POST".into(),
                url: url.into(),
                headers: request_headers,
                resource_type: "Fetch".into(),
                body: request_body.map(|text| CapturedBody {
                    size: text.len(),
                    mime_type: "application/json".into(),
                    text: Some(text.into()),
                    truncated: false,
                }),
                redirected_from: None,
            },
            response: Some(CapturedResponse {
                status: 200,
                status_text: "OK".into(),
                headers: vec![
                    Header { name: "Set-Cookie".into(), value: "sid=abcdefghijklmnop; Path=/; HttpOnly".into() },
                    Header { name: "Content-Type".into(), value: "application/json".into() },
                ],
                body: response_body.map(|text| CapturedBody {
                    size: text.len(),
                    mime_type: "application/json".into(),
                    text: Some(text.into()),
                    truncated: false,
                }),
            }),
            failure: None,
        }
    }

    #[test]
    fn finished_exchanges_are_redacted() {
        let entries = vec![
            entry(
                "https://api.test/login?api_key=k1234567890&page=1",
                vec![
                    Header { name: "Authorization".into(), value: "Bearer tok_live_1234567890abcdef".into() },
                    Header { name: "Cookie".into(), value: "sid=abcdefghijklmnop".into() },
                ],
                Some(r#"{"username":"dax","password":"hunter2hunter2"}"#),
                Some(r#"{"access_token":"tok_live_1234567890abcdef","echo":"your token is tok_live_1234567890abcdef","id":7}"#),
            ),
            // The same credential later shows up under a harmless name.
            entry("https://api.test/next?cursor=tok_live_1234567890abcdef", vec![], None, None),
        ];
        let (redacted, omissions) = finish(&entries);
        assert_eq!(omissions, 0);
        let text = serde_json::to_string(&redacted).unwrap();
        for secret in ["tok_live_1234567890abcdef", "abcdefghijklmnop", "hunter2hunter2", "k1234567890"] {
            assert!(!text.contains(secret), "{secret} leaked: {text}");
        }
        let value: Value = serde_json::from_str(&text).unwrap();
        let first = &value[0];
        assert_eq!(first["request"]["headers"][0]["value"], "Bearer [redacted]");
        assert_eq!(first["request"]["url"], "https://api.test/login?api_key=[redacted]&page=1");
        assert_eq!(first["request"]["body"]["text"], r#"{"username":"dax","password":"[redacted]"}"#);
        assert_eq!(first["response"]["body"]["text"], r#"{"access_token":"[redacted]","echo":"your token is [redacted]","id":7}"#);
        assert_eq!(first["response"]["headers"][0]["value"], "sid=[redacted]; Path=/; HttpOnly");
        assert_eq!(value[1]["request"]["url"], "https://api.test/next?cursor=[redacted]");
    }

    #[test]
    fn unparseable_structured_bodies_are_omitted() {
        let entries = vec![entry("https://api.test/x", vec![], Some("{not json"), None)];
        let (redacted, omissions) = finish(&entries);
        assert_eq!(omissions, 1);
        let body = redacted[0].request.body.as_ref().unwrap();
        assert!(body.text.is_none() && body.truncated);
    }

    #[test]
    fn bodies_respect_limits() {
        let mut budget = Budget::default();
        let body = budget.capture(b"hello", Some("text/plain"));
        assert_eq!(body.text.as_deref(), Some("hello"));
        let binary = budget.capture(&[0u8; 10], Some("image/png"));
        assert!(binary.text.is_none() && binary.truncated);
        assert!(!body_can_fit(&[Header { name: "content-length".into(), value: "2000000".into() }], None, MAX_BODY_BYTES));
        assert!(!body_can_fit(&[Header { name: "content-encoding".into(), value: "compress".into() }], Some(5), 10));
    }
}
