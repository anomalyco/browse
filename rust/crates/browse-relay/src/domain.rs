//! Per-session domain allowlists (cli/src/auth/domain-policy.ts). With a list, agent navigations to other hosts are
//! refused, and session tabs that end up elsewhere anyway are sent back to about:blank (or a fresh popup closed).
//! Private and loopback addresses need a pattern naming that exact host, even when a wildcard would match.

use std::net::{IpAddr, Ipv4Addr};

use url::Url;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OriginRule {
    pub pattern: String,
    pub scheme: Option<String>,
    pub host: String,
    pub wildcard: bool,
    pub port: Option<u16>,
}

const MAX_PATTERNS: usize = 100;

fn unbracket(host: &str) -> &str {
    host.strip_prefix('[').and_then(|h| h.strip_suffix(']')).unwrap_or(host)
}

pub fn parse_origin_pattern(raw: &str) -> Result<OriginRule, String> {
    let pattern = raw.trim();
    let quoted = serde_json::to_string(raw).unwrap_or_default();
    if pattern.is_empty() {
        return Err("Empty origin pattern".into());
    }
    if pattern == "*" || pattern == "*.*" {
        return Err(format!("Origin pattern {quoted} allows every site; leave the allowlist unset instead"));
    }
    let (scheme, rest) = match pattern.find("://") {
        Some(index) if pattern[..index].chars().all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c)) && index > 0 => {
            (Some(pattern[..index].to_lowercase()), &pattern[index + 3..])
        }
        _ => (None, pattern),
    };
    if let Some(scheme) = &scheme
        && scheme != "http" && scheme != "https" {
            return Err(format!("Origin pattern {quoted}: only http and https origins can be allowed"));
        }
    let rest = rest.strip_suffix('/').unwrap_or(rest);
    if rest.contains(['/', '?', '#']) {
        return Err(format!("Origin pattern {quoted} must be a host or origin, without a path"));
    }
    let wildcard = rest.starts_with("*.");
    let rest = if wildcard { &rest[2..] } else { rest };
    if rest.contains('*') {
        return Err(format!("Origin pattern {quoted}: a wildcard is only allowed as a leading \"*.\""));
    }
    let parsed = Url::parse(&format!("{}://{rest}", scheme.as_deref().unwrap_or("http")))
        .map_err(|_| format!("Origin pattern {quoted} is not a valid host or origin"))?;
    if !parsed.username().is_empty() || parsed.password().is_some() || parsed.path() != "/" || parsed.query().is_some() || parsed.fragment().is_some() {
        return Err(format!("Origin pattern {quoted} must be a host or origin"));
    }
    let host = unbracket(parsed.host_str().unwrap_or("")).to_lowercase();
    if host.is_empty() {
        return Err(format!("Origin pattern {quoted} must be a host or origin"));
    }
    if wildcard && host.parse::<IpAddr>().is_ok() {
        return Err(format!("Origin pattern {quoted}: wildcards don't apply to IP addresses"));
    }
    if wildcard && !host.contains('.') {
        return Err(format!("Origin pattern {quoted}: \"*.\" needs a domain with a dot, like *.example.com"));
    }
    let port = parsed.port().or(match scheme.as_deref() {
        Some("https") => Some(443),
        Some(_) => Some(80),
        None => None,
    });
    Ok(OriginRule { pattern: pattern.to_string(), scheme: scheme.map(|s| format!("{s}:")), host, wildcard, port })
}

pub fn parse_origin_patterns(raw: &[String]) -> Result<Vec<OriginRule>, String> {
    if raw.len() > MAX_PATTERNS {
        return Err(format!("At most {MAX_PATTERNS} origin patterns are allowed"));
    }
    raw.iter().map(|p| parse_origin_pattern(p)).collect()
}

/// Normalized pattern strings for storage and display.
pub fn normalize_origin_patterns(raw: &[String]) -> Result<Vec<String>, String> {
    let entries: Vec<String> = raw.iter().flat_map(|entry| entry.split(',')).map(str::trim).filter(|e| !e.is_empty()).map(String::from).collect();
    let mut out: Vec<String> = Vec::new();
    for rule in parse_origin_patterns(&entries)? {
        let pattern = rule.pattern.to_lowercase();
        if !out.contains(&pattern) {
            out.push(pattern);
        }
    }
    Ok(out)
}

fn private_v4(ip: Ipv4Addr) -> bool {
    const RANGES: [([u8; 4], u32); 14] = [
        ([0, 0, 0, 0], 8),
        ([10, 0, 0, 0], 8),
        ([100, 64, 0, 0], 10),
        ([127, 0, 0, 0], 8),
        ([169, 254, 0, 0], 16),
        ([172, 16, 0, 0], 12),
        ([192, 0, 0, 0], 24),
        ([192, 0, 2, 0], 24),
        ([192, 168, 0, 0], 16),
        ([198, 18, 0, 0], 15),
        ([198, 51, 100, 0], 24),
        ([203, 0, 113, 0], 24),
        ([224, 0, 0, 0], 4),
        ([240, 0, 0, 0], 4),
    ];
    let value = u32::from(ip);
    RANGES.iter().any(|(base, bits)| {
        let mask = if *bits == 0 { 0 } else { u32::MAX << (32 - bits) };
        value & mask == u32::from(Ipv4Addr::from(*base)) & mask
    })
}

/// Loopback, private, link-local, CGNAT, documentation, multicast and reserved addresses.
pub fn is_private_address(address: &str) -> bool {
    let bare = unbracket(address).split('%').next().unwrap_or("").to_lowercase();
    match bare.parse::<IpAddr>() {
        Ok(IpAddr::V4(ip)) => private_v4(ip),
        Ok(IpAddr::V6(ip)) => {
            if ip.is_unspecified() || ip.is_loopback() {
                return true;
            }
            if let Some(v4) = ip.to_ipv4_mapped() {
                return private_v4(v4);
            }
            let segments = ip.segments();
            if segments[..6] == [0, 0, 0, 0, 0, 0] {
                return private_v4(Ipv4Addr::new((segments[6] >> 8) as u8, segments[6] as u8, (segments[7] >> 8) as u8, segments[7] as u8));
            }
            let first = segments[0];
            (first & 0xfe00) == 0xfc00 || (first & 0xffc0) == 0xfe80 || (first & 0xff00) == 0xff00 || (segments[0] == 0x64 && segments[1] == 0xff9b)
        }
        Err(_) => false,
    }
}

fn is_localhost_name(host: &str) -> bool {
    host == "localhost" || host.ends_with(".localhost") || host == "localhost.localdomain"
}

pub fn is_private_host(host: &str) -> bool {
    let bare = unbracket(host).to_lowercase();
    is_localhost_name(&bare) || (bare.parse::<IpAddr>().is_ok() && is_private_address(&bare))
}

fn rule_matches(rule: &OriginRule, url: &Url, host: &str, https_only_without_scheme: bool) -> bool {
    if rule.scheme.as_deref().is_some_and(|s| s != format!("{}:", url.scheme())) {
        return false;
    }
    if rule.scheme.is_none() && https_only_without_scheme && url.scheme() != "https" && !is_private_host(host) {
        return false;
    }
    if rule.port.is_some_and(|port| Some(port) != url.port_or_known_default()) {
        return false;
    }
    if rule.wildcard { host == rule.host || host.ends_with(&format!(".{}", rule.host)) } else { host == rule.host }
}

pub fn explicitly_allows_host(rules: &[OriginRule], raw: &str) -> bool {
    let Ok(url) = Url::parse(raw) else { return false };
    let host = unbracket(url.host_str().unwrap_or("")).to_lowercase();
    rules.iter().any(|rule| !rule.wildcard && rule_matches(rule, &url, &host, false))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UrlDecision {
    Allowed { host: Option<String>, explicit: bool },
    Refused(String),
}

impl UrlDecision {
    pub fn allowed(&self) -> bool {
        matches!(self, UrlDecision::Allowed { .. })
    }
}

/// Checks a URL by its spelling, without DNS.
pub fn check_url(raw: &str, rules: &[OriginRule], https_only_without_scheme: bool) -> UrlDecision {
    let Ok(url) = Url::parse(raw) else {
        return UrlDecision::Refused(format!("{} is not a valid URL", serde_json::to_string(&raw.chars().take(200).collect::<String>()).unwrap_or_default()));
    };
    if matches!(url.scheme(), "about" | "data" | "blob") {
        return UrlDecision::Allowed { host: None, explicit: false };
    }
    if url.scheme() != "http" && url.scheme() != "https" {
        return UrlDecision::Refused(format!("{}: URLs are not allowed for this session", url.scheme()));
    }
    let host = unbracket(url.host_str().unwrap_or("")).to_lowercase();
    let display = match url.port() {
        Some(port) => format!("{}:{port}", url.host_str().unwrap_or("")),
        None => url.host_str().unwrap_or("").to_string(),
    };
    let matching: Vec<&OriginRule> = rules.iter().filter(|rule| rule_matches(rule, &url, &host, https_only_without_scheme)).collect();
    if matching.is_empty() {
        let names = rules.iter().map(|r| r.pattern.as_str()).collect::<Vec<_>>().join(", ");
        return UrlDecision::Refused(format!("{display} is not in the allowed origins ({})", if names.is_empty() { "none" } else { &names }));
    }
    let explicit = matching.iter().any(|rule| !rule.wildcard);
    if is_private_host(&host) && !explicit {
        return UrlDecision::Refused(format!("{display} is a private, loopback or local address; allow it by naming that exact host"));
    }
    UrlDecision::Allowed { host: Some(host), explicit }
}

/// A non-public address the host resolves to, if any (also None when DNS fails).
pub async fn resolves_to_private_address(host: &str) -> Option<String> {
    let bare = unbracket(host);
    if bare.parse::<IpAddr>().is_ok() || is_localhost_name(bare) {
        return is_private_host(bare).then(|| bare.to_string());
    }
    let lookup = tokio::net::lookup_host((bare, 80));
    let addresses = tokio::time::timeout(std::time::Duration::from_secs(2), lookup).await.ok()?.ok()?;
    addresses.map(|a| a.ip().to_string()).find(|ip| is_private_address(ip))
}

/// The full check for an agent navigation: spelling, then DNS for names an explicit pattern doesn't cover.
pub async fn check_navigation_url(raw: &str, rules: &[OriginRule]) -> UrlDecision {
    let decision = check_url(raw, rules, false);
    let UrlDecision::Allowed { host: Some(host), explicit: false } = &decision else { return decision };
    if let Some(address) = resolves_to_private_address(host).await {
        return UrlDecision::Refused(format!("{host} resolves to the private address {address}; allow it by naming that exact host"));
    }
    decision
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rules(patterns: &[&str]) -> Vec<OriginRule> {
        parse_origin_patterns(&patterns.iter().map(|p| p.to_string()).collect::<Vec<_>>()).unwrap()
    }

    #[test]
    fn patterns() {
        let rule = parse_origin_pattern("https://*.Example.com").unwrap();
        assert_eq!(rule.host, "example.com");
        assert!(rule.wildcard);
        assert_eq!(rule.port, Some(443));
        assert!(parse_origin_pattern("*").is_err());
        assert!(parse_origin_pattern("ftp://x.com").is_err());
        assert!(parse_origin_pattern("example.com/path").is_err());
        assert!(parse_origin_pattern("*.10.0.0.1").is_err());
        assert_eq!(normalize_origin_patterns(&["A.com, b.com".into(), "a.com".into()]).unwrap(), vec!["a.com", "b.com"]);
    }

    #[test]
    fn checks() {
        let list = rules(&["example.com", "*.github.com", "http://localhost:3000"]);
        assert!(check_url("https://example.com/x", &list, false).allowed());
        assert!(check_url("https://api.github.com", &list, false).allowed());
        assert!(!check_url("https://evil.com", &list, false).allowed());
        assert!(check_url("http://localhost:3000/", &list, false).allowed());
        assert!(!check_url("http://localhost:3001/", &list, false).allowed());
        assert!(check_url("about:blank", &list, false).allowed());
        assert!(!check_url("file:///etc/passwd", &list, false).allowed());
        assert!(!check_url("http://example.com", &list, true).allowed());
        let wide = rules(&["*.internal.com"]);
        assert!(check_url("https://a.internal.com", &wide, false).allowed());
    }

    #[test]
    fn private_addresses() {
        assert!(is_private_address("127.0.0.1"));
        assert!(is_private_address("10.1.2.3"));
        assert!(is_private_address("[::1]"));
        assert!(is_private_address("::ffff:192.168.1.1"));
        assert!(is_private_address("fd00::1"));
        assert!(!is_private_address("8.8.8.8"));
        assert!(!is_private_address("2606:4700::1111"));
    }
}
