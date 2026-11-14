use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde_json::Value;
use sha2::{Digest, Sha256};

pub fn random_bytes<const N: usize>() -> [u8; N] {
    let mut bytes = [0u8; N];
    getrandom::fill(&mut bytes).expect("the system random source failed");
    bytes
}

pub fn random_hex(bytes: usize) -> String {
    let mut buffer = vec![0u8; bytes];
    getrandom::fill(&mut buffer).expect("the system random source failed");
    buffer.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn b64url(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

pub fn from_b64url(text: &str) -> Option<Vec<u8>> {
    URL_SAFE_NO_PAD.decode(text.trim_end_matches('=')).ok()
}

/// Constant-time comparison of two secrets of any length.
pub fn secrets_equal(expected: &str, actual: Option<&str>) -> bool {
    let Some(actual) = actual else { return false };
    let a = Sha256::digest(expected.as_bytes());
    let b = Sha256::digest(actual.as_bytes());
    let same = a.iter().zip(b.iter()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0;
    same && expected.len() == actual.len()
}

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// An ISO 8601 UTC timestamp, as JavaScript's toISOString writes it.
pub fn iso(ms: u64) -> String {
    let secs = (ms / 1000) as i64;
    let (days, rest) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rest / 3600,
        rest % 3600 / 60,
        rest % 60,
        ms % 1000
    )
}

pub fn now_iso() -> String {
    iso(now_ms())
}

pub fn process_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        pid > 0 && unsafe { libc::kill(pid as libc::pid_t, 0) } == 0
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        true
    }
}

/// This computer's short name ("Daxs-MacBook-Pro.local" -> "Daxs-MacBook-Pro").
pub fn short_hostname() -> String {
    #[cfg(unix)]
    {
        let mut buffer = [0u8; 256];
        if unsafe { libc::gethostname(buffer.as_mut_ptr().cast(), buffer.len()) } == 0 {
            let end = buffer.iter().position(|&byte| byte == 0).unwrap_or(buffer.len());
            let name = String::from_utf8_lossy(&buffer[..end]).to_string();
            if let Some(short) = name.trim_end_matches('.').split('.').next().filter(|s| !s.is_empty()) {
                return short.to_string();
            }
        }
    }
    std::env::var("COMPUTERNAME").unwrap_or_else(|_| "this computer".into())
}

pub fn str_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

/// Origin and path only: query strings and fragments can carry tokens.
pub fn short_url(raw: &str) -> String {
    match url::Url::parse(raw) {
        Ok(url) if url.has_host() => format!("{}{}", url.origin().ascii_serialization(), url.path()).chars().take(200).collect(),
        _ => raw.chars().take(200).collect(),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn iso_matches_javascript() {
        assert_eq!(super::iso(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(super::iso(1_763_136_000_123), "2025-11-14T16:00:00.123Z");
    }
}
