//! Scrubs credential-shaped values out of captured network exchanges (port of cli/src/network-capture/redaction.ts).
//! Scrubbed values are remembered so the same credential is also replaced where it shows up under a name that does not
//! look secret.

use std::collections::HashSet;
use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// What a scrubbed credential is replaced with.
pub const REDACTED: &str = "[redacted]";
/// A URL-safe stand-in while a captured value is being rebuilt, so URL encoding leaves it intact.
const SENTINEL: &str = "__browse_redacted__";
/// Known values shorter than this are not replaced inside unrelated text; short strings collide with ordinary text.
pub const MINIMUM_KNOWN_SUBSTRING_LENGTH: usize = 8;

static SECRET_NAME: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i-u)auth(?:orization)?|cookie|credential|csrf|xsrf|token|secret|session|password|passwd|pwd|passcode|otp|(?:^|[-_.])code(?:$|[-_.])|(?:api|access|refresh)[-_.]?key|signature|(?:^|[-_.])sig(?:$|[-_.])").unwrap()
});
static ONE_TIME_FIELD: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i-u)pass(?:word|wd|code|phrase)|(?:^|[-_.])pwd(?:$|[-_.])|otp|totp|(?:^|[-_.])(?:mfa_?|2fa_?|verification_?|auth_?)?code(?:$|[-_.])|(?:^|[-_.])pin(?:$|[-_.])").unwrap()
});
static BOUNDARY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?i-u:boundary=)(?:"([^"]+)"|([^; \t\r\n]+))"#).unwrap());
static FILENAME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i-u);[ \t]*filename\*?=").unwrap());
static PART_NAME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?i-u:;[ \t]*name=")([^"]+)""#).unwrap());

const SECRET_HEADERS: &[&str] =
    &["authorization", "proxy-authorization", "x-api-key", "api-key", "x-csrf-token", "csrf-token", "x-xsrf-token"];
// HTTP/2 pseudo-headers (except :path, protected like a URL) and CORS headers carry routing and policy, not secrets.
const NON_SECRET_HEADERS: &[&str] = &[
    ":authority",
    ":method",
    ":scheme",
    ":status",
    ":protocol",
    "access-control-allow-credentials",
    "access-control-allow-origin",
    "access-control-allow-methods",
    "access-control-allow-headers",
    "access-control-expose-headers",
    "access-control-max-age",
    "access-control-request-method",
    "access-control-request-headers",
    "access-control-allow-private-network",
    "access-control-request-private-network",
];
const COOKIE_ATTRIBUTES: &[&str] =
    &["domain", "path", "expires", "max-age", "samesite", "priority", "partitioned", "secure", "httponly"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Header {
    pub name: String,
    pub value: String,
}

pub fn is_secret_name(name: &str) -> bool {
    SECRET_NAME.is_match(name)
}

#[derive(Default)]
pub struct SecretRedactor {
    known: HashSet<String>,
    // Passwords and one-time codes are replaced at any length, unlike short reusable captures.
    always: HashSet<String>,
}

#[derive(Clone, Copy, PartialEq)]
enum JsonField {
    Open,
    Secret,
    CodeListing,
    CodeVoice,
}

impl SecretRedactor {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn protect_headers(&mut self, headers: &[Header]) -> Vec<Header> {
        headers
            .iter()
            .map(|header| Header { name: header.name.clone(), value: restore(&self.protect_header(&header.name, &header.value)) })
            .collect()
    }

    pub fn protect_url(&mut self, raw: &str) -> String {
        let (base, fragment) = match raw.find('#') {
            Some(index) => (&raw[..index], Some(&raw[index + 1..])),
            None => (raw, None),
        };
        let (path, query) = match base.find('?') {
            Some(index) => (&base[..index], Some(&base[index + 1..])),
            None => (base, None),
        };
        // Only hierarchical URLs (scheme://authority/path) and relative URLs have path segments to protect.
        let path = match path.find("://") {
            Some(index) => {
                let after = index + 3;
                match path[after..].find('/') {
                    Some(slash) => format!("{}{}", &path[..after + slash], self.protect_path(&path[after + slash..])),
                    None => path.to_string(),
                }
            }
            None if has_scheme(path) => path.to_string(),
            None => self.protect_path(path),
        };
        let mut result = path;
        if let Some(query) = query {
            let protected = self.protect_query(query);
            if !protected.is_empty() {
                result.push('?');
                result.push_str(&protected);
            }
        }
        let mut result = restore(&result);
        if let Some(fragment) = fragment {
            result.push('#');
            result.push_str(&restore(&self.protect_fragment(fragment)));
        }
        result
    }

    /// The body with secret fields scrubbed, or None when it can't be parsed safely (it is then omitted).
    pub fn protect_body(&mut self, body: &str, content_type: Option<&str>) -> Option<String> {
        let kind = content_type.unwrap_or("").to_ascii_lowercase();
        if kind.contains("json") {
            let value: Value = serde_json::from_str(body).ok()?;
            let protected = self.protect_json(value, JsonField::Open, "");
            return Some(restore(&serde_json::to_string(&protected).ok()?));
        }
        if kind.contains("application/x-www-form-urlencoded") {
            return Some(restore(&self.protect_query(body)));
        }
        if kind.contains("multipart/form-data") {
            return self.protect_multipart(body, content_type.unwrap_or("")).map(|text| restore(&text));
        }
        None
    }

    pub fn redact_text(&self, text: &str) -> String {
        if self.known.contains(text) {
            return REDACTED.to_string();
        }
        self.redact_known_substrings(text, MINIMUM_KNOWN_SUBSTRING_LENGTH)
    }

    pub fn redact_known_substrings(&self, text: &str, minimum: usize) -> String {
        let mut entries: Vec<String> = Vec::new();
        for value in &self.known {
            if value.chars().count() < minimum && !self.always.contains(value) {
                continue;
            }
            entries.push(value.clone());
            let encoded = encode_uri_component(value);
            if encoded != *value {
                entries.push(encoded);
            }
        }
        entries.sort_by_key(|entry| std::cmp::Reverse(entry.len()));
        let mut output = text.to_string();
        for entry in entries {
            if output.contains(&entry) {
                output = output.replace(&entry, REDACTED);
            }
        }
        output
    }

    /// Redacts scalars that equal a known value (numbers and booleans included).
    pub fn redact_scalar(&self, value: &Value) -> Value {
        let text = match value {
            Value::Number(number) => number.to_string(),
            Value::Bool(flag) => flag.to_string(),
            _ => return value.clone(),
        };
        if self.known.contains(&text) || self.always.contains(&text) { Value::String(REDACTED.into()) } else { value.clone() }
    }

    /// Remember `value` for redaction everywhere.
    pub fn add_redaction_only(&mut self, value: &str) {
        if !value.is_empty() {
            self.always.insert(value.to_string());
            self.known.insert(value.to_string());
        }
    }

    fn scrub(&mut self, value: &str, field: &str) -> String {
        if value.is_empty() {
            return String::new();
        }
        self.known.insert(value.to_string());
        if ONE_TIME_FIELD.is_match(field) {
            self.always.insert(value.to_string());
        }
        SENTINEL.to_string()
    }

    fn protect_path(&mut self, path: &str) -> String {
        path.split('/')
            .map(|segment| {
                let decoded = percent_decode(segment, false).unwrap_or_else(|| segment.to_string());
                if looks_like_token_segment(&decoded) { self.scrub(&decoded, "") } else { segment.to_string() }
            })
            .collect::<Vec<_>>()
            .join("/")
    }

    fn protect_query(&mut self, query: &str) -> String {
        let pairs = parse_form(query)
            .into_iter()
            .map(|(name, value)| {
                let value = if !value.is_empty() && is_secret_name(&name) { self.scrub(&value, &name) } else { value };
                (name, value)
            })
            .collect::<Vec<_>>();
        serialize_form(&pairs)
    }

    fn protect_fragment(&mut self, fragment: &str) -> String {
        fragment
            .split('&')
            .map(|part| {
                let Some(separator) = part.find('=').filter(|index| *index >= 1) else { return part.to_string() };
                let Some((name, value)) = parse_form(part).into_iter().next() else { return part.to_string() };
                let plain = !name.is_empty() && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'.' || b == b'-');
                if !plain || !is_secret_name(&name) || value.is_empty() {
                    return part.to_string();
                }
                format!("{}{}", &part[..separator + 1], self.scrub(&value, &name))
            })
            .collect::<Vec<_>>()
            .join("&")
    }

    fn protect_header(&mut self, name: &str, value: &str) -> String {
        if value.is_empty() {
            return String::new();
        }
        let lower = name.to_ascii_lowercase();
        if lower == ":path" {
            return self.protect_url(value);
        }
        if NON_SECRET_HEADERS.contains(&lower.as_str()) {
            return value.to_string();
        }
        if lower == "cookie" || lower == "set-cookie" {
            let set = lower == "set-cookie";
            let mut protect_line = |line: &str| -> String {
                split_cookie_parts(line)
                    .into_iter()
                    .enumerate()
                    .map(|(index, part)| {
                        let Some(separator) = part.find('=').filter(|index| *index >= 1) else { return part.to_string() };
                        let cookie_name = part[..separator].trim();
                        let cookie_value = &part[separator + 1..];
                        if set && index > 0 && COOKIE_ATTRIBUTES.iter().any(|attr| attr.eq_ignore_ascii_case(cookie_name)) {
                            return part.to_string();
                        }
                        if cookie_value.is_empty() {
                            return part.to_string();
                        }
                        format!("{cookie_name}={}", self.scrub(cookie_value, ""))
                    })
                    .collect::<Vec<_>>()
                    .join("; ")
            };
            return if set { value.split('\n').map(&mut protect_line).collect::<Vec<_>>().join("\n") } else { protect_line(value) };
        }
        if lower == "location" || lower == "referer" || lower == "referrer" {
            return self.protect_url(value);
        }
        if (lower == "authorization" || lower == "proxy-authorization")
            && let Some(index) = value.find(char::is_whitespace).filter(|index| *index > 0) {
                let scheme = &value[..index];
                let credential = value[index..].trim_start();
                if !credential.is_empty() {
                    return format!("{scheme} {}", self.scrub(credential, ""));
                }
            }
        if SECRET_HEADERS.contains(&lower.as_str()) || is_secret_name(&lower) {
            return self.scrub(value, "");
        }
        value.to_string()
    }

    fn protect_json(&mut self, value: Value, field: JsonField, field_name: &str) -> Value {
        match value {
            Value::Array(items) => {
                if field == JsonField::CodeListing {
                    return Value::Array(
                        items
                            .into_iter()
                            .map(|item| if item.is_string() { item } else { self.protect_json(item, JsonField::Secret, field_name) })
                            .collect(),
                    );
                }
                Value::Array(items.into_iter().map(|item| self.protect_json(item, field, field_name)).collect())
            }
            Value::Object(map) => {
                // DocC content never reaches nested objects: everything below a `code` object is secret.
                let inherited =
                    if field == JsonField::CodeListing || field == JsonField::CodeVoice { JsonField::Secret } else { field };
                let kind = map.get("type").cloned();
                Value::Object(
                    map.into_iter()
                        .map(|(key, item)| {
                            let child = json_field(&key, inherited, kind.as_ref(), &item);
                            let protected = self.protect_json(item, child, &key);
                            (key, protected)
                        })
                        .collect(),
                )
            }
            Value::Null => Value::Null,
            Value::String(text) if text.is_empty() => Value::String(text),
            other if field == JsonField::Open => other,
            Value::String(text) if field == JsonField::CodeVoice => Value::String(text),
            Value::String(text) => Value::String(self.scrub(&text, field_name)),
            other => Value::String(self.scrub(&other.to_string(), field_name)),
        }
    }

    fn protect_multipart(&mut self, body: &str, content_type: &str) -> Option<String> {
        let captures = BOUNDARY.captures(content_type)?;
        let boundary = captures.get(1).or_else(|| captures.get(2))?.as_str();
        let delimiter = format!("--{boundary}");
        let mut parts: Vec<String> = body.split(delimiter.as_str()).map(str::to_string).collect();
        if parts.len() < 3 {
            return None;
        }
        let last = parts.len() - 1;
        for part in parts.iter_mut().take(last).skip(1) {
            if !part.starts_with("\r\n") {
                return None;
            }
            let header_end = part.find("\r\n\r\n")?;
            if !part.ends_with("\r\n") {
                return None;
            }
            let headers = &part[2..header_end];
            let disposition =
                headers.split("\r\n").find(|line| line.to_ascii_lowercase().starts_with("content-disposition:"))?;
            if FILENAME.is_match(disposition) {
                return None;
            }
            let name = PART_NAME.captures(disposition)?.get(1)?.as_str().to_string();
            let value_start = header_end + 4;
            let value_end = part.len() - 2;
            if value_start > value_end {
                return None;
            }
            let value = part[value_start..value_end].to_string();
            if value.is_empty() || !is_secret_name(&name) {
                continue;
            }
            let replaced = format!("{}{}{}", &part[..value_start], self.scrub(&value, &name), &part[value_end..]);
            *part = replaced;
        }
        Some(parts.join(delimiter.as_str()))
    }
}

/// Only a DocC codeListing/codeVoice `code` value is content; every other secret-looking key stays secret.
fn json_field(key: &str, inherited: JsonField, kind: Option<&Value>, value: &Value) -> JsonField {
    if inherited == JsonField::Secret {
        return JsonField::Secret;
    }
    if !is_secret_name(key) {
        return inherited;
    }
    if key != "code" {
        return JsonField::Secret;
    }
    match kind.and_then(Value::as_str) {
        Some("codeListing") if value.is_array() => JsonField::CodeListing,
        Some("codeVoice") if value.is_string() => JsonField::CodeVoice,
        _ => JsonField::Secret,
    }
}

fn restore(value: &str) -> String {
    value.replace(SENTINEL, REDACTED)
}

fn has_scheme(text: &str) -> bool {
    match text.find(':') {
        Some(index) if index > 0 => {
            let scheme = &text[..index];
            scheme.as_bytes()[0].is_ascii_alphabetic()
                && scheme.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'-' || b == b'.')
        }
        _ => false,
    }
}

/// Splits a cookie line on `;` followed by optional whitespace.
fn split_cookie_parts(line: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut rest = line;
    while let Some(index) = rest.find(';') {
        parts.push(&rest[..index]);
        rest = rest[index + 1..].trim_start();
    }
    parts.push(rest);
    parts
}

fn is_uuid(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(index, b)| match index {
            8 | 13 | 18 | 23 => *b == b'-',
            _ => b.is_ascii_hexdigit(),
        })
}

fn is_word(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b'-'
}

/// Path segments that look like credentials: JWTs, long hex, and long high-entropy base64/base64url.
pub fn looks_like_token_segment(segment: &str) -> bool {
    if segment.len() < 24 || is_uuid(segment) || segment.contains("${") {
        return false;
    }
    if let Some(rest) = segment.strip_prefix("eyJ") {
        let parts: Vec<&str> = rest.split('.').collect();
        if parts.len() == 3
            && !parts[0].is_empty()
            && !parts[1].is_empty()
            && parts.iter().all(|part| part.bytes().all(is_word))
        {
            return true;
        }
    }
    if segment.len() >= 32 && segment.bytes().all(|b| b.is_ascii_hexdigit()) {
        return true;
    }
    let body = segment.trim_end_matches('=');
    if segment.len() - body.len() > 2
        || body.is_empty()
        || !body.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'~' | b'+' | b'/' | b'-'))
    {
        return false;
    }
    // Slugs such as "how-to-install-the-extension" are words, not tokens.
    let slug = segment.split(['-', '_']).count() > 1
        && segment.split(['-', '_']).all(|word| !word.is_empty() && word.bytes().all(|b| b.is_ascii_alphabetic()));
    if slug {
        return false;
    }
    let distinct = segment.chars().collect::<HashSet<_>>().len();
    let digit = segment.bytes().any(|b| b.is_ascii_digit());
    let lower = segment.bytes().any(|b| b.is_ascii_lowercase());
    let upper = segment.bytes().any(|b| b.is_ascii_uppercase());
    distinct >= 12 && digit && (lower || upper) && ((lower && upper) || segment.len() >= 32)
}

fn hex(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// decodeURIComponent (strict: None on a malformed escape or invalid UTF-8), or form decoding with `plus`.
fn percent_decode(text: &str, plus: bool) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'%' => {
                let decoded = bytes.get(index + 1).and_then(|h| hex(*h)).zip(bytes.get(index + 2).and_then(|l| hex(*l)));
                match decoded {
                    Some((high, low)) => {
                        out.push(high * 16 + low);
                        index += 3;
                        continue;
                    }
                    None if plus => out.push(b'%'),
                    None => return None,
                }
            }
            b'+' if plus => out.push(b' '),
            other => out.push(other),
        }
        index += 1;
    }
    if plus { Some(String::from_utf8_lossy(&out).into_owned()) } else { String::from_utf8(out).ok() }
}

/// URLSearchParams parsing: `&`-separated pairs, `+` as space, percent-decoding, empty pairs skipped.
pub(crate) fn parse_form(text: &str) -> Vec<(String, String)> {
    let text = text.strip_prefix('?').unwrap_or(text);
    text.split('&')
        .filter(|pair| !pair.is_empty())
        .map(|pair| {
            let (name, value) = pair.split_once('=').unwrap_or((pair, ""));
            (percent_decode(name, true).unwrap_or_default(), percent_decode(value, true).unwrap_or_default())
        })
        .collect()
}

fn form_encode(text: &str, out: &mut String) {
    for b in text.bytes() {
        match b {
            b'*' | b'-' | b'.' | b'_' => out.push(b as char),
            b if b.is_ascii_alphanumeric() => out.push(b as char),
            b' ' => out.push('+'),
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
}

/// URLSearchParams.toString().
pub(crate) fn serialize_form(pairs: &[(String, String)]) -> String {
    let mut out = String::new();
    for (index, (name, value)) in pairs.iter().enumerate() {
        if index > 0 {
            out.push('&');
        }
        form_encode(name, &mut out);
        out.push('=');
        form_encode(value, &mut out);
    }
    out
}

pub(crate) fn encode_uri_component(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for b in text.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn header(name: &str, value: &str) -> Header {
        Header { name: name.into(), value: value.into() }
    }

    #[test]
    fn headers_scrub_credentials_and_cookies() {
        let mut redactor = SecretRedactor::new();
        let protected = redactor.protect_headers(&[
            header("Authorization", "Bearer abc.def.ghi-1234567890"),
            header("Cookie", "sid=s3cr3tvalue; theme=dark"),
            header("Set-Cookie", "sid=s3cr3tvalue; Path=/; HttpOnly\nother=1"),
            header("X-Api-Key", "k-123"),
            header("Content-Type", "application/json"),
            header("Access-Control-Allow-Credentials", "true"),
            header("Location", "https://x.test/cb?code=abc&state=ok"),
        ]);
        assert_eq!(protected[0].value, "Bearer [redacted]");
        assert_eq!(protected[1].value, "sid=[redacted]; theme=[redacted]");
        assert_eq!(protected[2].value, "sid=[redacted]; Path=/; HttpOnly\nother=[redacted]");
        assert_eq!(protected[3].value, "[redacted]");
        assert_eq!(protected[4].value, "application/json");
        assert_eq!(protected[5].value, "true");
        assert_eq!(protected[6].value, "https://x.test/cb?code=[redacted]&state=ok");
    }

    #[test]
    fn urls_scrub_query_path_tokens_and_fragments() {
        let mut redactor = SecretRedactor::new();
        assert_eq!(
            redactor.protect_url("https://api.test/v1/items?access_token=xyz&page=2#id_token=abc&tab=1"),
            "https://api.test/v1/items?access_token=[redacted]&page=2#id_token=[redacted]&tab=1"
        );
        let jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl";
        assert_eq!(redactor.protect_url(&format!("https://x.test/reset/{jwt}/done")), "https://x.test/reset/[redacted]/done");
        assert_eq!(
            redactor.protect_url("https://x.test/docs/how-to-install-the-extension-now"),
            "https://x.test/docs/how-to-install-the-extension-now"
        );
        assert_eq!(redactor.protect_url("/relative?session=1"), "/relative?session=[redacted]");
    }

    #[test]
    fn bodies_scrub_structured_fields() {
        let mut redactor = SecretRedactor::new();
        assert_eq!(
            redactor.protect_body(r#"{"user":"dax","password":"hunter2","nested":{"refresh_token":"r-1"},"n":1}"#, Some("application/json")).unwrap(),
            r#"{"user":"dax","password":"[redacted]","nested":{"refresh_token":"[redacted]"},"n":1}"#
        );
        assert_eq!(
            redactor.protect_body("user=dax&password=hunter2", Some("application/x-www-form-urlencoded")).unwrap(),
            "user=dax&password=[redacted]"
        );
        let multipart = "--b\r\nContent-Disposition: form-data; name=\"otp\"\r\n\r\n123456\r\n--b\r\nContent-Disposition: form-data; name=\"q\"\r\n\r\nhi\r\n--b--\r\n";
        assert_eq!(
            redactor.protect_body(multipart, Some("multipart/form-data; boundary=b")).unwrap(),
            multipart.replace("123456", "[redacted]")
        );
        assert!(redactor.protect_body("not json", Some("application/json")).is_none());
        assert!(redactor.protect_body("<html>", Some("text/html")).is_none());
        // DocC code listings are content, not secrets.
        assert_eq!(
            redactor.protect_body(r#"{"type":"codeListing","code":["let x = 1"]}"#, Some("application/json")).unwrap(),
            r#"{"type":"codeListing","code":["let x = 1"]}"#
        );
    }

    #[test]
    fn known_values_are_redacted_elsewhere() {
        let mut redactor = SecretRedactor::new();
        redactor.protect_headers(&[header("Authorization", "Bearer longsecretvalue123")]);
        redactor.protect_body(r#"{"otp":"4821"}"#, Some("application/json"));
        assert_eq!(redactor.redact_text("echo longsecretvalue123 and 4821"), "echo [redacted] and [redacted]");
        assert_eq!(redactor.redact_text("longsecretvalue123"), "[redacted]");
        redactor.protect_headers(&[header("X-Token", "short")]);
        assert_eq!(redactor.redact_text("a short word"), "a short word");
    }
}
