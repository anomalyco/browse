//! CDP guardrails (cli/src/cdp/guardrails.ts): methods that would destroy the user's real browser state are refused,
//! read-only sessions only inspect, cookies and site storage are scoped to the session's page hosts, and
//! browser-internal or local documents can't be opened.

use serde_json::Value;

const ALWAYS_BLOCKED: &[(&str, &str)] = &[
    ("Network.clearBrowserCookies", "it would log the user out of every site in their browser"),
    ("Network.clearBrowserCache", "it would clear the user's entire browser cache"),
    ("Storage.clearCookies", "it would log the user out of every site in their browser"),
    ("Network.deleteCookies", "it would delete the user's cookies and can log them out"),
    ("Storage.clearDataForOrigin", "it would erase a site's cookies and stored data in the user's browser"),
    ("Storage.clearDataForStorageKey", "it would erase a site's stored data in the user's browser"),
    ("Browser.close", "it would close the user's browser"),
    ("Browser.grantPermissions", "it would grant a site permissions the user never approved"),
    ("Browser.setPermission", "it would change a site permission without the user's approval"),
    ("Browser.resetPermissions", "it would reset the user's site permissions"),
];

const READ_ONLY_ALLOWED: &[&str] = &[
    "Browser.getVersion",
    "Browser.getWindowForTarget",
    "Target.attachToTarget",
    "Target.detachFromTarget",
    "Target.getTargetInfo",
    "Target.getTargets",
    "Target.setAutoAttach",
    "Page.getFrameTree",
    "Page.getLayoutMetrics",
    "Page.getNavigationHistory",
    "Page.getResourceTree",
    "Page.captureScreenshot",
    "Page.addScriptToEvaluateOnNewDocument",
    "Page.createIsolatedWorld",
    "Page.setLifecycleEventsEnabled",
    "Runtime.callFunctionOn",
    "Runtime.evaluate",
    "Runtime.getProperties",
    "Runtime.releaseObject",
    "Runtime.releaseObjectGroup",
    "Runtime.runIfWaitingForDebugger",
    "Accessibility.getAXNodeAndAncestors",
    "Accessibility.getFullAXTree",
    "Accessibility.getPartialAXTree",
    "Accessibility.getRootAXNode",
    "Accessibility.queryAXTree",
    "DOM.describeNode",
    "DOM.getAttributes",
    "DOM.getBoxModel",
    "DOM.getContentQuads",
    "DOM.getDocument",
    "DOM.getFrameOwner",
    "DOM.getNodeForLocation",
    "DOM.querySelector",
    "DOM.querySelectorAll",
    "DOM.resolveNode",
    "Network.getAllCookies",
    "Network.getCookies",
    "Storage.getCookies",
    "Emulation.setEmulatedMedia",
    "Emulation.setFocusEmulationEnabled",
    "Network.setCacheDisabled",
];

const READ_ONLY_SUBSCRIPTION_DOMAINS: &[&str] = &["Accessibility.", "DOM.", "Log.", "Network.", "Page.", "Performance.", "Runtime."];

fn read_only_allowed(method: &str) -> bool {
    READ_ONLY_ALLOWED.contains(&method)
        || ((method.ends_with(".enable") || method.ends_with(".disable")) && READ_ONLY_SUBSCRIPTION_DOMAINS.iter().any(|d| method.starts_with(d)))
}

const COOKIE_READS: &[&str] = &["Storage.getCookies", "Network.getAllCookies", "Network.getCookies"];
const STORAGE_DOMAINS: &[&str] = &["IndexedDB.", "CacheStorage.", "DOMStorage.", "Storage.", "ServiceWorker."];
const STORAGE_WITHOUT_ORIGIN: &[&str] = &[
    "IndexedDB.enable",
    "IndexedDB.disable",
    "CacheStorage.enable",
    "CacheStorage.disable",
    "DOMStorage.enable",
    "DOMStorage.disable",
    "ServiceWorker.enable",
    "ServiceWorker.disable",
    "ServiceWorker.setForceUpdateOnPageLoad",
    "Storage.getStorageKeyForFrame",
    "Storage.getStorageKey",
    "Storage.getRelatedWebsiteSets",
    "Storage.getAffectedUrlsForThirdPartyCookieMetadata",
];
const STORAGE_ALL_ORIGINS: &[(&str, &str)] = &[
    ("Storage.getTrustTokens", "it reads the private state tokens of every site"),
    ("Storage.setInterestGroupTracking", "it reports every site's interest groups"),
    ("Storage.setInterestGroupAuctionTracking", "it reports every site's ad auctions"),
    ("Storage.setSharedStorageTracking", "it reports every site's shared storage"),
    ("Storage.runBounceTrackingMitigations", "it deletes state of sites in the user's browser"),
    ("Storage.setProtectedAudienceKAnonymity", "it changes ad state of every site"),
    ("ServiceWorker.stopAllWorkers", "it stops every site's service workers"),
];
const ORIGIN_PARAMS: &[&str] = &["securityOrigin", "storageKey", "origin", "ownerOrigin", "issuerOrigin", "scopeURL", "topLevelSite"];
const RESTRICTED_SCHEMES: &[&str] = &[
    "file", "chrome", "chrome-extension", "chrome-untrusted", "chrome-search", "devtools", "view-source", "edge", "brave", "opera", "vivaldi",
    "filesystem",
];

fn env_on(name: &str) -> bool {
    std::env::var(name).is_ok_and(|v| v == "1")
}

fn hostname(raw: &str) -> Option<String> {
    let url = url::Url::parse(raw).ok()?;
    url.host_str().filter(|h| !h.is_empty()).map(|h| h.trim_start_matches('[').trim_end_matches(']').to_lowercase())
}

pub fn page_hosts(urls: &[String]) -> Vec<String> {
    urls.iter()
        .filter_map(|raw| {
            let url = url::Url::parse(raw).ok()?;
            matches!(url.scheme(), "http" | "https").then(|| hostname(raw)).flatten()
        })
        .collect()
}

fn cookie_applies(domain: &str, host: &str) -> bool {
    let domain = domain.to_lowercase();
    let domain = domain.trim_start_matches('.');
    !domain.is_empty() && (host == domain || host.ends_with(&format!(".{domain}")))
}

fn cookie_domain(cookie: &Value) -> Option<String> {
    if let Some(url) = cookie.get("url").and_then(Value::as_str) {
        return hostname(url);
    }
    cookie.get("domain").and_then(Value::as_str).map(str::to_string)
}

fn hosts_text(hosts: &[String]) -> String {
    if hosts.is_empty() { "none".into() } else { hosts.join(", ") }
}

fn storage_origins(params: &Value) -> Vec<String> {
    let mut values = Vec::new();
    let mut collect = |object: Option<&Value>| {
        if let Some(object) = object.and_then(Value::as_object) {
            for name in ORIGIN_PARAMS {
                if let Some(value) = object.get(*name).and_then(Value::as_str).filter(|v| !v.is_empty()) {
                    values.push(value.to_string());
                }
            }
        }
    };
    collect(Some(params));
    collect(params.get("storageId"));
    collect(params.get("storageBucket"));
    collect(params.get("bucket"));
    if let Some(cache) = params.get("cacheId").and_then(Value::as_str) {
        values.push(cache.split('|').next().unwrap_or("").to_string());
    }
    values
}

/// A rejection message when the command must be refused, else None.
pub fn guard(method: &str, params: &Value, read_only: bool, session: &str, page_urls: &dyn Fn() -> Vec<String>) -> Option<String> {
    if let Some((_, reason)) = ALWAYS_BLOCKED.iter().find(|(m, _)| *m == method) {
        return Some(format!("browse blocked {method}: {reason}. This command is always blocked by the relay."));
    }
    if method.starts_with("WebAuthn.") {
        return Some(format!(
            "browse blocked {method}: agents can't drive WebAuthn or add virtual authenticators. This command is always blocked by the relay."
        ));
    }
    if read_only && !read_only_allowed(method) {
        return Some(format!(
            "Session {session} is read-only: {method} is blocked because this tab is read-only. Read-only sessions can take snapshots and screenshots, read page information and subscribe to events. Use a session created without readOnly to interact with pages."
        ));
    }
    if method == "Page.bringToFront" && !env_on("OPENCODE_BROWSER_ALLOW_FOREGROUND") {
        return Some("browse blocked Page.bringToFront: it raises the user's browser window over their work. Use the handoff tool when the user needs to act in the tab, or set OPENCODE_BROWSER_ALLOW_FOREGROUND=1 on the relay to allow it.".into());
    }
    if matches!(method, "Storage.setCookies" | "Network.setCookies" | "Network.setCookie") && !env_on("OPENCODE_BROWSER_ALLOW_ALL_COOKIES") {
        let cookies: Vec<&Value> = if method == "Network.setCookie" {
            vec![params]
        } else {
            params.get("cookies").and_then(Value::as_array).map(|a| a.iter().collect()).unwrap_or_default()
        };
        let hosts = page_hosts(&page_urls());
        for cookie in cookies {
            let domain = cookie_domain(cookie);
            if !domain.as_deref().is_some_and(|d| hosts.iter().any(|h| cookie_applies(d, h))) {
                return Some(format!(
                    "browse blocked {method}: cookies can only be set for the hosts of this session's attached pages ({}), not {}. Set OPENCODE_BROWSER_ALLOW_ALL_COOKIES=1 on the relay to allow it.",
                    hosts_text(&hosts),
                    domain.unwrap_or_else(|| "a cookie without a domain or url".into())
                ));
            }
        }
    }
    if !COOKIE_READS.contains(&method) && method != "Storage.setCookies" && STORAGE_DOMAINS.iter().any(|d| method.starts_with(d)) && !env_on("OPENCODE_BROWSER_ALLOW_ALL_STORAGE") {
        if let Some((_, reason)) = STORAGE_ALL_ORIGINS.iter().find(|(m, _)| *m == method) {
            return Some(format!("browse blocked {method}: {reason}. Set OPENCODE_BROWSER_ALLOW_ALL_STORAGE=1 on the relay to allow it."));
        }
        if !STORAGE_WITHOUT_ORIGIN.contains(&method) {
            let hosts = page_hosts(&page_urls());
            let origins = storage_origins(params);
            let outside = if origins.is_empty() {
                Some("a request that names no origin or storage key".to_string())
            } else {
                origins.into_iter().find(|origin| !hostname(origin.split('^').next().unwrap_or("")).is_some_and(|h| hosts.contains(&h)))
            };
            if let Some(outside) = outside {
                return Some(format!(
                    "browse blocked {method}: site storage can only be used for the hosts of this session's attached pages ({}), not {outside}. Set OPENCODE_BROWSER_ALLOW_ALL_STORAGE=1 on the relay to allow it.",
                    hosts_text(&hosts)
                ));
            }
        }
    }
    if matches!(method, "Page.navigate" | "Target.createTarget")
        && let Some(scheme) = params.get("url").and_then(Value::as_str).and_then(|u| url::Url::parse(u).ok()).map(|u| u.scheme().to_string())
            && RESTRICTED_SCHEMES.contains(&scheme.as_str()) && !(scheme == "file" && env_on("OPENCODE_BROWSER_ALLOW_FILE_URLS")) {
                let hint = if scheme == "file" { " Set OPENCODE_BROWSER_ALLOW_FILE_URLS=1 on the relay to allow file: URLs." } else { "" };
                return Some(format!(
                    "browse blocked {method} to a {scheme}: URL: agents can't open browser-internal pages, other extensions, DevTools or local files.{hint}"
                ));
            }
    if matches!(method, "Page.navigate" | "Target.createTarget")
        && let Some(url) = params.get("url").and_then(Value::as_str).and_then(|u| url::Url::parse(u.trim()).ok())
        && url.scheme() == "about"
        && !matches!(url.path(), "blank" | "srcdoc")
    {
        return Some(format!(
            "browse blocked {method} to {}: about: pages other than about:blank are the browser's own pages (about:version is chrome://version), which agents can't open.",
            url.as_str().chars().take(80).collect::<String>()
        ));
    }
    if method == "Network.loadNetworkResource" && !env_on("OPENCODE_BROWSER_ALLOW_ALL_STORAGE") {
        let hosts = page_hosts(&page_urls());
        let host = params.get("url").and_then(Value::as_str).and_then(hostname);
        if !host.is_some_and(|h| hosts.contains(&h)) {
            return Some(format!(
                "browse blocked Network.loadNetworkResource: it loads URLs with the user's credentials outside the page's same-origin policy, so only the hosts of this session's attached pages ({}) are allowed. Set OPENCODE_BROWSER_ALLOW_ALL_STORAGE=1 on the relay to allow it.",
                hosts_text(&hosts)
            ));
        }
    }
    None
}

/// Cookie reads keep only the cookies that apply to the session's page hosts.
pub fn scope_result(method: &str, mut result: Value, page_urls: &dyn Fn() -> Vec<String>) -> Value {
    if !COOKIE_READS.contains(&method) || env_on("OPENCODE_BROWSER_ALLOW_ALL_COOKIES") {
        return result;
    }
    let hosts = page_hosts(&page_urls());
    if let Some(cookies) = result.get_mut("cookies").and_then(Value::as_array_mut) {
        cookies.retain(|cookie| cookie_domain(cookie).is_some_and(|d| hosts.iter().any(|h| cookie_applies(&d, h))));
    }
    result
}

/// Browser-internal or other-extension documents chrome.debugger refuses to expose.
pub fn is_restricted_url(url: &str) -> bool {
    ["chrome://", "chrome-extension://", "chrome-untrusted://", "devtools://", "edge://", "brave://"].iter().any(|p| url.starts_with(p))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn guards() {
        let urls = || vec!["https://app.example.com/x".to_string()];
        assert!(guard("Browser.close", &json!({}), false, "s", &urls).is_some());
        assert!(guard("Input.dispatchMouseEvent", &json!({}), true, "s", &urls).is_some());
        assert!(guard("Runtime.evaluate", &json!({}), true, "s", &urls).is_none());
        assert!(guard("Page.enable", &json!({}), true, "s", &urls).is_none());
        assert!(guard("Page.navigate", &json!({"url": "chrome://settings"}), false, "s", &urls).is_some());
        assert!(guard("Page.navigate", &json!({"url": "https://x.com"}), false, "s", &urls).is_none());
        assert!(guard("Page.navigate", &json!({"url": "about:version"}), false, "s", &urls).is_some());
        assert!(guard("Target.createTarget", &json!({"url": "ABOUT:settings"}), false, "s", &urls).is_some());
        assert!(guard("Page.navigate", &json!({"url": "about:blank"}), false, "s", &urls).is_none());
        assert!(guard("Page.navigate", &json!({"url": "about:blank#x"}), false, "s", &urls).is_none());
        assert!(guard("Page.navigate", &json!({"url": "about:srcdoc"}), false, "s", &urls).is_none());
        assert!(guard("Network.setCookie", &json!({"domain": ".example.com"}), false, "s", &urls).is_none());
        assert!(guard("Network.setCookie", &json!({"domain": "evil.com"}), false, "s", &urls).is_some());
        assert!(guard("DOMStorage.getDOMStorageItems", &json!({"storageId": {"securityOrigin": "https://app.example.com"}}), false, "s", &urls).is_none());
        assert!(guard("DOMStorage.getDOMStorageItems", &json!({"storageId": {"securityOrigin": "https://bank.com"}}), false, "s", &urls).is_some());
        let scoped = scope_result("Network.getCookies", json!({"cookies": [{"domain": "example.com"}, {"domain": "bank.com"}]}), &urls);
        assert_eq!(scoped["cookies"].as_array().unwrap().len(), 1);
    }
}
