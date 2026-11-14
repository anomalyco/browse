//! Pairing the relay with browsers (cli/src/relay/browser-pairing.ts; the extension's half is
//! src/background/pairing.ts). `pair` mints a short single-use code, kept only as a slow hash; an extension exchanges
//! it once over ephemeral ECDH for a token of its own, then proves the token with HMACs over fresh nonces on every
//! connection.

use std::collections::BTreeMap;
use std::path::Path;

use hmac::{Hmac, Mac};
use p256::elliptic_curve::sec1::ToEncodedPoint;
use serde::{Deserialize, Serialize};
use sha2::Sha256;

use crate::paths::{self, Paths};
use crate::util::{b64url, from_b64url, now_ms, random_bytes};

pub const CONTEXT: &str = "opencode-browser-pairing-v3";
const LEGACY_CONTEXT: &str = "opencode-browser-pairing-v2";
const CROCKFORD: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH: usize = 8;
const CODE_KEY_ITERATIONS: u32 = 100_000;
pub const PAIRING_CODE_TTL_MS: u64 = 10 * 60_000;
pub const BUNDLED_PAIRING_CODE_TTL_MS: u64 = 60 * 60_000;
pub const MAX_PAIRING_FAILURES: u32 = 5;
const MAX_PENDING_CODES: usize = 5;

type HmacSha256 = Hmac<Sha256>;

fn hmac(key: &[u8], parts: &[&[u8]]) -> [u8; 32] {
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC takes any key length");
    for part in parts {
        mac.update(part);
    }
    mac.finalize().into_bytes().into()
}

// ---- codes ----------------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct PendingCodes {
    #[serde(default)]
    codes: Vec<PendingCode>,
    #[serde(default)]
    failures: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PendingCode {
    key: String,
    expires_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    receipt: Option<String>,
}

/// A typed code in canonical form (8 characters, I/L read as 1, O as 0), or None.
pub fn normalize_pairing_code(input: &str) -> Option<String> {
    let code: String = input
        .to_uppercase()
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '-')
        .map(|c| match c {
            'I' | 'L' => '1',
            'O' => '0',
            other => other,
        })
        .collect();
    (code.len() == CODE_LENGTH && code.bytes().all(|b| CROCKFORD.contains(&b))).then_some(code)
}

/// ABCD-EFGH
pub fn format_pairing_code(code: &str) -> String {
    code.as_bytes().chunks(4).map(|chunk| String::from_utf8_lossy(chunk).into_owned()).collect::<Vec<_>>().join("-")
}

/// The slow hash both sides derive and the relay stores: PBKDF2-SHA256, hex.
pub fn pairing_code_key(code: &str) -> String {
    let mut key = [0u8; 32];
    pbkdf2::pbkdf2_hmac::<Sha256>(code.as_bytes(), format!("{CONTEXT}|code").as_bytes(), CODE_KEY_ITERATIONS, &mut key);
    key.iter().map(|b| format!("{b:02x}")).collect()
}

fn read_pending(paths: &Paths, now: u64) -> PendingCodes {
    let mut pending: PendingCodes = paths::read_json(&paths.pairing_codes()).unwrap_or_default();
    pending.codes.retain(|entry| entry.key.len() == 64 && entry.key.bytes().all(|b| b.is_ascii_hexdigit()) && entry.expires_at >= now);
    pending
}

fn write_pending(paths: &Paths, pending: &PendingCodes) -> std::io::Result<()> {
    if pending.codes.is_empty() && pending.failures == 0 {
        let _ = std::fs::remove_file(paths.pairing_codes());
        return Ok(());
    }
    paths::write_private_json(&paths.pairing_codes(), pending)
}

/// A new single-use code, valid for `ttl_ms`; only its slow hash is stored. The oldest pending codes go past five.
pub fn mint_pairing_code(paths: &Paths, ttl_ms: u64, receipt: Option<&str>) -> std::io::Result<String> {
    let now = now_ms();
    let code: String = random_bytes::<CODE_LENGTH>().iter().map(|b| CROCKFORD[(b & 31) as usize] as char).collect();
    let mut pending = read_pending(paths, now);
    pending.codes.push(PendingCode { key: pairing_code_key(&code), expires_at: now + ttl_ms, receipt: receipt.map(str::to_string) });
    let skip = pending.codes.len().saturating_sub(MAX_PENDING_CODES);
    let codes = pending.codes.split_off(skip);
    write_pending(paths, &PendingCodes { codes, failures: 0 })?;
    Ok(code)
}

pub fn pending_code_keys(paths: &Paths) -> Vec<String> {
    read_pending(paths, now_ms()).codes.into_iter().map(|entry| entry.key).collect()
}

/// Uses up a code an extension proved; the failure count starts over. Returns its receipt.
pub fn consume_pairing_code(paths: &Paths, key: &str) -> Option<String> {
    let pending = read_pending(paths, now_ms());
    let receipt = pending.codes.iter().find(|entry| entry.key == key).and_then(|entry| entry.receipt.clone());
    let codes = pending.codes.into_iter().filter(|entry| entry.key != key).collect();
    let _ = write_pending(paths, &PendingCodes { codes, failures: 0 });
    receipt
}

/// Counts a wrong code; at the limit every pending code is thrown away. Returns whether that happened.
pub fn record_pairing_failure(paths: &Paths) -> bool {
    let pending = read_pending(paths, now_ms());
    let failures = pending.failures + 1;
    let exhausted = failures >= MAX_PAIRING_FAILURES;
    let had = !pending.codes.is_empty();
    let next = if exhausted { PendingCodes::default() } else { PendingCodes { codes: pending.codes, failures } };
    let _ = write_pending(paths, &next);
    exhausted && had
}

/// Writes a fresh code into an unpacked extension (relay-pairing.json), which exchanges it once for its token.
pub fn write_extension_pairing(extension_dir: &Path, code: &str, port: Option<u16>) -> std::io::Result<()> {
    let mut value = serde_json::json!({ "code": code });
    if let Some(port) = port {
        value["port"] = port.into();
    }
    paths::write_private_json(&extension_dir.join("relay-pairing.json"), &value)
}

// ---- tokens ---------------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserPairing {
    pub token: String,
    pub paired_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub receipt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_seen: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

fn valid_token(token: &str) -> bool {
    token.len() == 43 && token.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// Paired browsers by profile key.
pub fn read_browser_pairings(paths: &Paths) -> BTreeMap<String, BrowserPairing> {
    let raw: BTreeMap<String, serde_json::Value> = paths::read_json(&paths.browser_tokens()).unwrap_or_default();
    raw.into_iter()
        .filter_map(|(key, value)| serde_json::from_value::<BrowserPairing>(value).ok().filter(|p| valid_token(&p.token)).map(|p| (key, p)))
        .collect()
}

fn write_browser_pairings(paths: &Paths, pairings: &BTreeMap<String, BrowserPairing>) -> std::io::Result<()> {
    paths::write_private_json(&paths.browser_tokens(), pairings)
}

pub fn browser_token(paths: &Paths, key: &str) -> Option<String> {
    read_browser_pairings(paths).remove(key).map(|p| p.token)
}

pub fn new_browser_token() -> String {
    b64url(&random_bytes::<32>())
}

/// A token for the browser with this profile key (the given one, or a new one), replacing any it had.
pub fn issue_browser_token(paths: &Paths, key: &str, token: Option<String>, receipt: Option<String>) -> std::io::Result<String> {
    let token = token.unwrap_or_else(new_browser_token);
    let mut pairings = read_browser_pairings(paths);
    pairings.insert(key.to_string(), BrowserPairing { token: token.clone(), paired_at: now_ms(), receipt, last_seen: None, id: None, name: None });
    write_browser_pairings(paths, &pairings)?;
    Ok(token)
}

pub fn touch_browser_pairing(paths: &Paths, key: &str, id: &str, name: &str) {
    let mut pairings = read_browser_pairings(paths);
    if let Some(entry) = pairings.get_mut(key) {
        entry.last_seen = Some(now_ms());
        entry.id = Some(id.to_string());
        entry.name = Some(name.to_string());
        let _ = write_browser_pairings(paths, &pairings);
    }
}

/// Deletes a browser's token; true when it had one.
pub fn revoke_browser_token(paths: &Paths, key: &str) -> std::io::Result<bool> {
    let mut pairings = read_browser_pairings(paths);
    if pairings.remove(key).is_none() {
        return Ok(false);
    }
    write_browser_pairings(paths, &pairings)?;
    Ok(true)
}

// ---- the old shared code --------------------------------------------------------------------------------------

pub fn legacy_pairing_code(paths: &Paths) -> Option<String> {
    let code = std::fs::read_to_string(paths.legacy_pairing_code()).ok()?.trim().to_string();
    (code.len() == 32 && code.bytes().all(|b| CROCKFORD.contains(&b))).then_some(code)
}

pub fn remove_legacy_pairing_code(paths: &Paths) -> bool {
    let existed = legacy_pairing_code(paths).is_some();
    let _ = std::fs::remove_file(paths.legacy_pairing_code());
    existed
}

pub fn legacy_pairing_proof(code: &str, role: &str, port: u16, own_nonce: &str, peer_nonce: &str) -> String {
    let message = format!("{LEGACY_CONTEXT}|{role}|{}|{peer_nonce}|{own_nonce}", endpoint(port));
    b64url(&hmac(code.as_bytes(), &[message.as_bytes()]))
}

// ---- the handshake --------------------------------------------------------------------------------------------

fn endpoint(port: u16) -> String {
    format!("127.0.0.1:{port}/extension")
}

/// HMAC(token, context | role | endpoint | peer nonce | own nonce)
pub fn pairing_proof(token: &str, role: &str, port: u16, own_nonce: &str, peer_nonce: &str) -> String {
    let message = format!("{CONTEXT}|{role}|{}|{peer_nonce}|{own_nonce}", endpoint(port));
    b64url(&hmac(token.as_bytes(), &[message.as_bytes()]))
}

pub struct EcdhExchange {
    pub public_key: String,
    pub secret: [u8; 32],
}

/// The relay's half of an ephemeral P-256 exchange with the extension's public key (uncompressed, base64url).
pub fn ecdh_exchange(peer_public_key: &str) -> Option<EcdhExchange> {
    let peer = from_b64url(peer_public_key)?;
    if peer.len() != 65 || peer[0] != 4 {
        return None;
    }
    let peer = p256::PublicKey::from_sec1_bytes(&peer).ok()?;
    let secret = loop {
        if let Ok(key) = p256::SecretKey::from_slice(&random_bytes::<32>()) {
            break key;
        }
    };
    let public_key = b64url(secret.public_key().to_encoded_point(false).as_bytes());
    let shared = p256::ecdh::diffie_hellman(secret.to_nonzero_scalar(), peer.as_affine());
    Some(EcdhExchange { public_key, secret: (*shared.raw_secret_bytes()).into() })
}

#[derive(Debug, Clone)]
pub struct Transcript {
    pub port: u16,
    pub extension_nonce: String,
    pub relay_nonce: String,
    pub extension_key: String,
    pub relay_key: String,
}

/// HMAC keyed by the code's key material over the ECDH secret and everything both sides sent.
pub fn pairing_session_key(material: &str, secret: &[u8], transcript: &Transcript) -> [u8; 32] {
    let text = format!(
        "{CONTEXT}|session|{}|{}|{}|{}|{}|",
        endpoint(transcript.port),
        transcript.extension_nonce,
        transcript.relay_nonce,
        transcript.extension_key,
        transcript.relay_key
    );
    hmac(material.as_bytes(), &[text.as_bytes(), secret])
}

pub fn session_proof(session_key: &[u8], role: &str) -> String {
    b64url(&hmac(session_key, &[format!("{CONTEXT}|proof|{role}").as_bytes()]))
}

/// A token masked for the extension: its 32 bytes XOR HMAC(session key, "wrap").
pub fn wrap_token(session_key: &[u8], token: &str) -> String {
    let mask = hmac(session_key, &[format!("{CONTEXT}|wrap").as_bytes()]);
    let bytes = from_b64url(token).unwrap_or_default();
    b64url(&bytes.iter().zip(mask.iter()).map(|(b, m)| b ^ m).collect::<Vec<_>>())
}

pub fn unwrap_token(session_key: &[u8], wrapped: &str) -> Option<String> {
    let bytes = from_b64url(wrapped).filter(|b| b.len() == 32)?;
    let mask = hmac(session_key, &[format!("{CONTEXT}|wrap").as_bytes()]);
    Some(b64url(&bytes.iter().zip(mask.iter()).map(|(b, m)| b ^ m).collect::<Vec<_>>()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_paths() -> Paths {
        Paths::rooted(std::env::temp_dir().join(format!("browse-relay-pairing-{}", crate::util::random_hex(6))))
    }

    #[test]
    fn codes_normalize_and_format() {
        assert_eq!(normalize_pairing_code("abcd-efgh").as_deref(), Some("ABCDEFGH"));
        assert_eq!(normalize_pairing_code("oiL1 2345").as_deref(), Some("01112345"));
        assert_eq!(normalize_pairing_code("ABCDEFGU"), None);
        assert_eq!(format_pairing_code("ABCDEFGH"), "ABCD-EFGH");
    }

    #[test]
    fn minted_codes_are_single_use() {
        let paths = temp_paths();
        let code = mint_pairing_code(&paths, PAIRING_CODE_TTL_MS, Some("r1")).unwrap();
        let key = pairing_code_key(&code);
        assert_eq!(pending_code_keys(&paths), vec![key.clone()]);
        assert_eq!(consume_pairing_code(&paths, &key).as_deref(), Some("r1"));
        assert!(pending_code_keys(&paths).is_empty());
        let _ = std::fs::remove_dir_all(&paths.data);
    }

    #[test]
    fn wrong_codes_exhaust_pending() {
        let paths = temp_paths();
        mint_pairing_code(&paths, PAIRING_CODE_TTL_MS, None).unwrap();
        for _ in 0..4 {
            assert!(!record_pairing_failure(&paths));
        }
        assert!(record_pairing_failure(&paths));
        assert!(pending_code_keys(&paths).is_empty());
        let _ = std::fs::remove_dir_all(&paths.data);
    }

    #[test]
    fn wrap_round_trips() {
        let key = [7u8; 32];
        let token = new_browser_token();
        assert_eq!(unwrap_token(&key, &wrap_token(&key, &token)), Some(token));
    }
}
