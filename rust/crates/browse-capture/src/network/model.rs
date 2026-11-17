//! Captured exchanges and their final redaction pass (port of cli/src/network-capture/capture.ts).

use serde::Serialize;
use serde_json::Value;

use crate::redaction::{Header, MINIMUM_KNOWN_SUBSTRING_LENGTH, SecretRedactor};

pub const MAX_BODY_BYTES: usize = 1_000_000;
pub const MAX_TOTAL_BODY_BYTES: usize = 25_000_000;
pub const MAX_ENTRIES: usize = 1_000;
// Inside JSON string values only longer known values are replaced, since ordinary text rarely contains 16 characters
// of a credential. Values from a secret-named URL query or fragment field are credentials by name and are replaced from
// 8.
const MINIMUM_KNOWN_BODY_SUBSTRING_LENGTH: usize = 16;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapturedBody {
    /// Decoded size in bytes, when known.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<usize>,
    pub mime_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// The body would have been returned but a size limit or a failure kept it out.
    pub truncated: bool,
    /// Why there is no text.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub omitted: Option<String>,
}

pub const NOT_RETURNED: &str =
    "not returned: only JSON, form and multipart bodies are, since other kinds can't be checked for credentials";
pub const TOO_LARGE: &str = "larger than the 1 MB per-body limit";
pub const BUDGET_USED: &str = "the capture's 25 MB body budget was used up";
pub const UNAVAILABLE: &str = "Chrome no longer had the body";
pub const UNSUPPORTED_ENCODING: &str = "its content-encoding can't be decoded";
pub const UNREDACTABLE: &str = "it couldn't be parsed to check it for credentials";

/// Bodies the redactor can check and so returns as text (the same kinds `SecretRedactor::protect_body` accepts).
pub fn is_returnable_mime_type(mime: Option<&str>) -> bool {
    let Some(mime) = mime else { return false };
    let mime = mime.to_ascii_lowercase();
    mime.contains("json") || mime.contains("application/x-www-form-urlencoded") || mime.contains("multipart/form-data")
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

/// Whether the encoding can be decoded and a body of `size` bytes (declared or measured) fits in `limit`; `Err` says
/// why not.
pub fn body_can_fit(headers: &[Header], size: Option<usize>, limit: usize) -> Result<(), (&'static str, bool)> {
    let encoding = header(headers, "content-encoding").map(|value| value.trim().to_ascii_lowercase());
    if !matches!(encoding.as_deref(), None | Some("identity" | "gzip" | "br" | "deflate" | "zstd")) {
        return Err((UNSUPPORTED_ENCODING, true));
    }
    match size.or_else(|| declared_body_size(headers)) {
        Some(size) if size > MAX_BODY_BYTES => Err((TOO_LARGE, true)),
        Some(size) if size > limit => Err((BUDGET_USED, true)),
        _ if limit == 0 => Err((BUDGET_USED, true)),
        _ => Ok(()),
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
        MAX_TOTAL_BODY_BYTES.saturating_sub(self.captured_body_bytes)
    }

    /// Records a fetched returnable body, cut off when it is over the per-body limit or the remaining budget.
    pub fn capture(&mut self, bytes: &[u8], mime: Option<&str>) -> CapturedBody {
        let mime_type = mime.unwrap_or("application/octet-stream").to_string();
        if bytes.len() > MAX_BODY_BYTES {
            return self.omitted(mime, Some(bytes.len()), TOO_LARGE, true);
        }
        if bytes.len() > self.remaining() {
            return self.omitted(mime, Some(bytes.len()), BUDGET_USED, true);
        }
        self.captured_body_bytes += bytes.len();
        CapturedBody {
            size: Some(bytes.len()),
            mime_type,
            text: Some(String::from_utf8_lossy(bytes).into_owned()),
            truncated: false,
            omitted: None,
        }
    }

    /// A body without text; `truncated` ones (kept out by a limit or a failure) are counted.
    pub fn omitted(&mut self, mime: Option<&str>, size: Option<usize>, reason: &str, truncated: bool) -> CapturedBody {
        if truncated {
            self.truncated_body_count += 1;
        }
        CapturedBody {
            size,
            mime_type: mime.unwrap_or("application/octet-stream").to_string(),
            text: None,
            truncated,
            omitted: Some(reason.to_string()),
        }
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
    let Some(text) = &body.text else { return Some(body.clone()) };
    let omitted = CapturedBody { text: None, truncated: true, omitted: Some(UNREDACTABLE.into()), ..body.clone() };
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
        Err(_) => CapturedBody { text: None, truncated: true, omitted: Some(UNREDACTABLE.into()), ..body },
    }
}

fn redact_known_scalars(value: Value, redactor: &SecretRedactor) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.into_iter().map(|item| redact_known_scalars(item, redactor)).collect()),
        Value::Object(map) => {
            Value::Object(map.into_iter().map(|(key, item)| (key, redact_known_scalars(item, redactor))).collect())
        }
        Value::String(text) => Value::String(redactor.redact_known_body_substrings(&text, MINIMUM_KNOWN_BODY_SUBSTRING_LENGTH)),
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
                    size: Some(text.len()),
                    mime_type: "application/json".into(),
                    text: Some(text.into()),
                    truncated: false,
                    omitted: None,
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
                    size: Some(text.len()),
                    mime_type: "application/json".into(),
                    text: Some(text.into()),
                    truncated: false,
                    omitted: None,
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
    fn short_secrets_from_url_fields_are_redacted_in_body_strings() {
        let entries = vec![entry(
            "https://api.test/echo?api_key=k1234567890#signature=f1234567890",
            vec![],
            None,
            Some(r#"{"url":"https://x/y?api_key=k1234567890","note":"signed f1234567890"}"#),
        )];
        let (redacted, _) = finish(&entries);
        let value = serde_json::to_value(&redacted[0]).unwrap();
        assert_eq!(value["request"]["url"], "https://api.test/echo?api_key=[redacted]#signature=[redacted]");
        assert_eq!(value["response"]["body"]["text"], r#"{"url":"https://x/y?api_key=[redacted]","note":"signed [redacted]"}"#);
    }

    #[test]
    fn short_values_from_other_sources_stay_in_body_strings() {
        let entries = vec![entry(
            "https://api.test/x",
            vec![Header { name: "Cookie".into(), value: "sid=abcdef1234".into() }],
            None,
            Some(r#"{"note":"sid=abcdef1234"}"#),
        )];
        let (redacted, _) = finish(&entries);
        let value = serde_json::to_value(&redacted[0]).unwrap();
        assert_eq!(value["request"]["headers"][0]["value"], "sid=[redacted]");
        assert_eq!(value["response"]["body"]["text"], r#"{"note":"sid=abcdef1234"}"#);
    }

    #[test]
    fn short_secret_named_form_values_stay_in_body_strings() {
        let mut exchange = entry(
            "https://api.test/x",
            vec![],
            Some("api_key=k1234567890"),
            Some(r#"{"url":"https://x/y?api_key=k1234567890"}"#),
        );
        exchange.request.body.as_mut().unwrap().mime_type = "application/x-www-form-urlencoded".into();
        let (redacted, _) = finish(&[exchange]);
        let value = serde_json::to_value(&redacted[0]).unwrap();
        assert_eq!(value["request"]["body"]["text"], "api_key=[redacted]");
        assert_eq!(value["response"]["body"]["text"], r#"{"url":"https://x/y?api_key=k1234567890"}"#);
    }

    #[test]
    fn unparseable_structured_bodies_are_omitted() {
        let entries = vec![entry("https://api.test/x", vec![], Some("{not json"), None)];
        let (redacted, omissions) = finish(&entries);
        assert_eq!(omissions, 1);
        let body = redacted[0].request.body.as_ref().unwrap();
        assert!(body.text.is_none() && body.truncated);
        assert_eq!(body.omitted.as_deref(), Some(UNREDACTABLE));
    }

    #[test]
    fn bodies_respect_limits() {
        let mut budget = Budget::default();
        let body = budget.capture(b"{}", Some("application/json"));
        assert_eq!(body.text.as_deref(), Some("{}"));
        assert_eq!(budget.captured_body_bytes, 2);
        let big = budget.capture(&vec![b' '; MAX_BODY_BYTES + 1], Some("application/json"));
        assert!(big.text.is_none() && big.truncated && big.omitted.as_deref() == Some(TOO_LARGE));
        assert_eq!(budget.captured_body_bytes, 2, "bodies that aren't returned don't use the budget");
        assert!(is_returnable_mime_type(Some("application/problem+json")));
        assert!(!is_returnable_mime_type(Some("text/html")) && !is_returnable_mime_type(None));
        let length = |n: &str| vec![Header { name: "content-length".into(), value: n.into() }];
        assert_eq!(body_can_fit(&length("2000000"), None, MAX_TOTAL_BODY_BYTES), Err((TOO_LARGE, true)));
        assert_eq!(body_can_fit(&length("20"), None, 10), Err((BUDGET_USED, true)));
        assert_eq!(body_can_fit(&length("5"), None, 10), Ok(()));
        let compress = vec![Header { name: "content-encoding".into(), value: "compress".into() }];
        assert_eq!(body_can_fit(&compress, Some(5), 10), Err((UNSUPPORTED_ENCODING, true)));
    }
}
