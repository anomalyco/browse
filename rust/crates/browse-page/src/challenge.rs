//! Bot-challenge and block-page detection (cli/src/execute/challenge-detection.ts).
//!
//! - `non-interactive`: an interstitial the browser clears by itself; browse waits for it, up to a bound.
//! - `interactive`: a challenge only a person should answer; browse reports it and recommends handoff.
//! - `block`: the site refused the visit outright; retrying makes it worse.
//!
//! Generic phrases only count on short pages, so an article that mentions them is not a challenge.

use std::sync::Arc;
use std::time::{Duration, Instant};

use regex_lite::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::page::{TabPage, v};

pub const PROBE_SELECTORS: &[&str] = &[
    "#challenge-form", "#challenge-running", "#challenge-stage", "#cf-challenge-running", ".cf-turnstile", "#cf-error-details",
    "#sec-if-cpt-container", "#sec-cpt-if", "#sec-text-if",
    "#ddv1-captcha-container",
    "#px-captcha", "#px-captcha-wrapper", "[id^='px-captcha']",
    "#main-iframe[src*='_Incapsula_Resource']",
    "#captcha-container awswaf-captcha", "awswaf-captcha", "#challenge-container",
    ".g-recaptcha", "iframe[src*='/recaptcha/'][title*='challenge']", ".h-captcha",
];

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Probe {
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub text_length: usize,
    #[serde(default)]
    pub frame_urls: Vec<String>,
    #[serde(default)]
    pub script_srcs: Vec<String>,
    #[serde(default)]
    pub selectors: Vec<String>,
    #[serde(default)]
    pub visible_selectors: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Detection {
    pub vendor: &'static str,
    pub kind: &'static str,
    pub signal: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Outcome {
    pub vendor: &'static str,
    pub kind: &'static str,
    pub signal: String,
    pub status: &'static str,
    pub url: String,
    #[serde(rename = "waitedMs")]
    pub waited_ms: u64,
    pub recommendation: &'static str,
}

fn re(pattern: &str) -> Regex {
    Regex::new(pattern).expect("challenge pattern")
}

fn short(probe: &Probe) -> bool {
    probe.text_length < 1_500
}

fn host_of(url: &str) -> String {
    let rest = url.split_once("://").map(|(_, r)| r).unwrap_or("");
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host = authority.rsplit('@').next().unwrap_or("");
    host.split(':').next().unwrap_or("").to_ascii_lowercase()
}

fn signal(value: String) -> String {
    value.chars().take(160).collect()
}

/// Classify a probed page, or None when it doesn't look like a challenge or block page.
pub fn classify(probe: &Probe) -> Option<Detection> {
    let title = probe.title.trim().to_lowercase();
    let text = probe.text.to_lowercase();
    let host = host_of(&probe.url);
    let has = |selector: &str| probe.selectors.iter().any(|s| s == selector);
    let visible = |selector: &str| probe.visible_selectors.iter().any(|s| s == selector);
    let frame = |pattern: &str| {
        let regex = re(pattern);
        probe.frame_urls.iter().find(|url| regex.is_match(url)).cloned()
    };
    let script = |pattern: &str| {
        let regex = re(pattern);
        probe.script_srcs.iter().find(|src| regex.is_match(src)).cloned()
    };
    let d = |vendor, kind, signal: String| Some(Detection { vendor, kind, signal });

    // Cloudflare
    if re("sorry, you have been blocked").is_match(&text) && (has("#cf-error-details") || text.contains("cloudflare")) {
        return d("cloudflare", "block", "text: Sorry, you have been blocked".into());
    }
    let interstitial = re(r"^just a moment\b|^attention required! \| cloudflare|^checking your browser|^un instant|^einen moment").is_match(&title)
        || has("#challenge-form")
        || has("#challenge-running")
        || has("#cf-challenge-running")
        || has("#challenge-stage");
    let turnstile = frame(r"^https://challenges\.cloudflare\.com/.*(turnstile|challenge-platform)");
    if interstitial || (turnstile.is_some() && short(probe)) {
        let widget = visible(".cf-turnstile") || re("verify you are human by completing|click to verify|confirm you are human").is_match(&text);
        let found = if interstitial { signal(format!("title: {}", probe.title.trim())) } else { signal(format!("iframe {}", turnstile.unwrap_or_default())) };
        return d("cloudflare", if widget { "interactive" } else { "non-interactive" }, found);
    }

    // PerimeterX / HUMAN
    if has("#px-captcha") || has("#px-captcha-wrapper") || has("[id^='px-captcha']") || re("press (?:&|and) hold").is_match(&text) {
        return d("perimeterx", "interactive", if has("#px-captcha") { "element #px-captcha".into() } else { "text: Press & Hold".into() });
    }

    // DataDome
    let datadome = frame(r"captcha-delivery\.com");
    if datadome.is_some() || has("#ddv1-captcha-container") {
        let non_interactive = datadome.as_deref().map(|url| url.contains("/interstitial/")).unwrap_or(false);
        let found = match &datadome {
            Some(url) => signal(format!("iframe {url}")),
            None => "element #ddv1-captcha-container".into(),
        };
        return d("datadome", if non_interactive { "non-interactive" } else { "interactive" }, found);
    }

    // Akamai Bot Manager
    if has("#sec-if-cpt-container") || has("#sec-cpt-if") || has("#sec-text-if") {
        let interactive = visible("#sec-cpt-if") && re("verify|press|slide|captcha").is_match(&text);
        return d("akamai", if interactive { "interactive" } else { "non-interactive" }, "element #sec-if-cpt-container".into());
    }
    if title == "access denied" && text.contains("you don't have permission to access") && re(r"reference #?\d").is_match(&text) {
        return d("akamai", "block", "title: Access Denied (Akamai reference)".into());
    }

    // Imperva / Incapsula
    let incapsula = frame("_Incapsula_Resource").or_else(|| script("_Incapsula_Resource"));
    if incapsula.is_some() || has("#main-iframe[src*='_Incapsula_Resource']") {
        let captcha = re("captcha|verify you are human|i am human").is_match(&text) || frame("hcaptcha|recaptcha").is_some();
        if re("request unsuccessful|incapsula incident id").is_match(&text) && !captcha {
            return d("imperva", "block", "text: Request unsuccessful (Incapsula)".into());
        }
        return d("imperva", if captcha { "interactive" } else { "non-interactive" }, signal(format!("resource {}", incapsula.unwrap_or_else(|| "_Incapsula_Resource".into()))));
    }
    if text.contains("incapsula incident id") && short(probe) {
        return d("imperva", "block", "text: Incapsula incident ID".into());
    }

    // AWS WAF
    if has("awswaf-captcha") || has("#captcha-container awswaf-captcha") {
        return d("aws-waf", "interactive", "element awswaf-captcha".into());
    }
    if let Some(src) = script(r"\.awswaf\.com/")
        && short(probe) && (has("#challenge-container") || probe.text_length < 300) {
            return d("aws-waf", "non-interactive", signal(format!("script {src}")));
        }

    // Captcha walls: a page that is mostly a reCAPTCHA or hCaptcha widget.
    if short(probe) {
        let recaptcha = frame(r"^https://www\.(?:google|recaptcha)\.(?:com|net)/recaptcha/(?:api2|enterprise)/anchor");
        let hcaptcha = frame(r"^https://(?:newassets\.|assets\.)?hcaptcha\.com/captcha/");
        let wall = re("verify you are (?:a )?human|are you a robot|not a robot|unusual traffic|security check|complete the captcha|captcha").is_match(&text)
            || re("captcha|security check|verify").is_match(&title);
        if let (Some(url), true) = (&hcaptcha, wall) {
            return d("hcaptcha", "interactive", signal(format!("iframe {url}")));
        }
        if let (Some(url), true) = (&recaptcha, wall) {
            return d("recaptcha", "interactive", signal(format!("iframe {url}")));
        }
        if host.starts_with("www.google.") && probe.url.contains("/sorry/") {
            return d("recaptcha", "interactive", "url: google.com/sorry".into());
        }
    }

    // Generic block and verification pages, short pages only.
    if short(probe) {
        if re("^(?:access denied|403 forbidden|forbidden|blocked|request blocked|you have been blocked)$").is_match(&title)
            || re(r"^(?:access to this page has been denied|access denied)\b").is_match(text.trim())
        {
            let shown = if probe.title.trim().is_empty() { text.trim().chars().take(60).collect::<String>() } else { probe.title.trim().to_string() };
            return d("generic", "block", signal(format!("title: {shown}")));
        }
        let both = format!("{title}\n{text}");
        if re(r"verify (?:that )?you are (?:a )?human|confirm you are (?:a )?human|are you a robot\?|pardon our interruption|please verify you are a human|\bbot (?:check|detection)\b").is_match(&both) {
            let found = re(r"verify[^.\n]*human|confirm[^.\n]*human|are you a robot|pardon our interruption|\bbot (?:check|detection)\b")
                .find(&both)
                .map(|m| m.as_str().to_string())
                .unwrap_or_else(|| "verification".into());
            return d("generic", "interactive", signal(format!("text: {found}")));
        }
    }
    None
}

/// How long browse waits for a non-interactive challenge to clear (OPENCODE_BROWSER_CHALLENGE_WAIT_MS, 0 to 60000).
pub fn wait_ms() -> u64 {
    std::env::var("OPENCODE_BROWSER_CHALLENGE_WAIT_MS").ok().and_then(|v| v.parse::<u64>().ok()).filter(|v| *v <= 60_000).unwrap_or(15_000)
}

async fn probe(page: &Arc<TabPage>) -> Option<Option<Probe>> {
    let url = page.main_url();
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Some(None);
    }
    let main = page.main_frame();
    let result = tokio::time::timeout(Duration::from_secs(2), page.call_value(&main, "probe", vec![v(PROBE_SELECTORS)], false)).await;
    let value: Value = match result {
        Ok(Ok(value)) => value,
        _ => return None,
    };
    let mut probe: Probe = serde_json::from_value(value).ok()?;
    probe.frame_urls = page.frames().into_iter().map(|f| f.url).take(50).collect();
    Some(Some(probe))
}

/// Classify the page; wait out a non-interactive challenge for up to `wait`. None when there's no challenge.
pub async fn detect(page: &Arc<TabPage>, wait: Duration) -> Option<Outcome> {
    if page.dialog().is_some() {
        return None;
    }
    let first = probe(page).await??;
    let detected = classify(&first)?;
    let started = Instant::now();
    let mut current = detected.clone();
    let mut url = first.url.clone();
    while current.kind == "non-interactive" && started.elapsed() < wait {
        tokio::time::sleep(Duration::from_millis(1_000).min(wait.saturating_sub(started.elapsed()))).await;
        match probe(page).await {
            // Mid-navigation (the challenge often clears by navigating): still waiting.
            None => continue,
            Some(None) => return Some(outcome(current, "cleared", url, started.elapsed(), "continue")),
            Some(Some(next)) => {
                url = next.url.clone();
                match classify(&next) {
                    None => return Some(outcome(current, "cleared", url, started.elapsed(), "continue")),
                    Some(next) => current = next,
                }
            }
        }
    }
    let waited = if current == detected && detected.kind != "non-interactive" { Duration::ZERO } else { started.elapsed() };
    let recommendation = if current.kind == "block" { "stop" } else { "handoff" };
    Some(outcome(current, "blocked", url, waited, recommendation))
}

fn outcome(detection: Detection, status: &'static str, url: String, waited: Duration, recommendation: &'static str) -> Outcome {
    Outcome { vendor: detection.vendor, kind: detection.kind, signal: detection.signal, status, url, waited_ms: waited.as_millis() as u64, recommendation }
}

fn origin_of(url: &str) -> String {
    match url.split_once("://") {
        Some((scheme, rest)) => format!("{scheme}://{}", rest.split(['/', '?', '#']).next().unwrap_or("")),
        None => url.to_string(),
    }
}

pub fn warning(outcome: &Outcome) -> Option<String> {
    if outcome.status == "cleared" {
        return None;
    }
    let origin = origin_of(&outcome.url);
    if outcome.recommendation == "handoff" {
        let still = if outcome.waited_ms > 0 { format!(", still there after {} s", (outcome.waited_ms as f64 / 1000.0).round()) } else { String::new() };
        return Some(format!(
            "Blocked by a {} {} challenge on {origin} ({}{still}). Don't retry, reload or try to solve it: call handoff(\"Solve the security check on {origin}, then click Continue\") so the user does it, or stop.",
            outcome.vendor, outcome.kind, outcome.signal
        ));
    }
    Some(format!(
        "Blocked: {origin} refused the visit ({}, {}). Don't retry or reload in a loop, which makes the block worse for the user's IP and account: stop, or tell the user.",
        outcome.vendor, outcome.signal
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn probe(title: &str, text: &str) -> Probe {
        Probe { url: "https://shop.example/".into(), title: title.into(), text: text.into(), text_length: text.len(), ..Default::default() }
    }

    #[test]
    fn cloudflare_interstitial_and_block() {
        let found = classify(&probe("Just a moment...", "Checking your browser")).unwrap();
        assert_eq!((found.vendor, found.kind), ("cloudflare", "non-interactive"));
        let mut blocked = probe("Attention", "Sorry, you have been blocked. Cloudflare Ray ID");
        blocked.selectors.push("#cf-error-details".into());
        assert_eq!(classify(&blocked).unwrap().kind, "block");
    }

    #[test]
    fn long_articles_are_not_challenges() {
        let text = format!("verify you are human {}", "lorem ipsum ".repeat(200));
        assert!(classify(&probe("News", &text)).is_none());
        assert_eq!(classify(&probe("Check", "Please verify you are a human")).unwrap().vendor, "generic");
        assert!(classify(&probe("Robot check", "Robot checks are our new product")).is_none());
        assert_eq!(classify(&probe("Hold on", "Running a bot check")).unwrap().vendor, "generic");
    }

    #[test]
    fn perimeterx_and_google_sorry() {
        assert_eq!(classify(&probe("x", "Press & Hold to confirm")).unwrap().vendor, "perimeterx");
        let mut sorry = probe("Sorry", "unusual traffic");
        sorry.url = "https://www.google.com/sorry/index".into();
        assert_eq!(classify(&sorry).unwrap().signal, "url: google.com/sorry");
    }

    #[test]
    fn warning_text() {
        let outcome = Outcome { vendor: "cloudflare", kind: "interactive", signal: "title: Just a moment...".into(), status: "blocked", url: "https://a.example/x?y".into(), waited_ms: 0, recommendation: "handoff" };
        assert!(warning(&outcome).unwrap().contains("on https://a.example ("));
    }
}
