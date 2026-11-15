//! The page-side scripts browse evaluates in its isolated worlds.

use std::sync::OnceLock;

const HELPERS: &str = include_str!("../js/helpers.js");
const NAMING: &str = include_str!("../js/naming.js");
const CAPTURE: &str = include_str!("../js/capture.js");
/// Playwright's InjectedScript (Apache-2.0), vendored from patchright-core by js/generate.sh.
const INJECTED: &str = include_str!("../js/injected-script.js");

/// The helpers object for one world (js/helpers.js with the snapshot naming and capture sources filled in).
pub fn helpers() -> &'static str {
    static SOURCE: OnceLock<String> = OnceLock::new();
    SOURCE.get_or_init(|| HELPERS.replace("__NAMING__", NAMING).replace("__CAPTURE__", CAPTURE))
}

/// A function, called on the helpers object, that creates the world's InjectedScript once. The two listeners
/// Playwright installs on the window (a custom event it dispatches when the document element is replaced, and
/// capture-phase hit-target interceptors) are left out: browse checks hit targets before input instead, and a
/// dispatched custom event is something the page could observe.
pub fn install_injected(frame_seq: u32) -> String {
    let options = serde_json::json!({
        "isUnderTest": false,
        "sdkLanguage": "javascript",
        "frameSeq": frame_seq,
        "testIdAttributeName": "data-testid",
        "stableRafCount": 1,
        "browserName": "chromium",
        "shouldPrependErrorPrefix": false,
        "isUtilityWorld": true,
        "customEngines": [],
    });
    format!(
        "function () {{\nif (this.inj) return true;\nconst module = {{}};\n{INJECTED}\nconst __BrowseInjected = module.exports.InjectedScript();\n__BrowseInjected.prototype._setupGlobalListenersRemovalDetection = function () {{}};\n__BrowseInjected.prototype._setupHitTargetInterceptors = function () {{}};\nthis.inj = new __BrowseInjected(globalThis, {options});\nthis.inj.__renderYaml = renderAriaSnapshotAsYaml;\nreturn true;\n}}"
    )
}

#[cfg(test)]
mod tests {
    #[test]
    fn helpers_have_no_placeholders_or_markers() {
        let source = super::helpers();
        assert!(!source.contains("__NAMING__"));
        assert!(!source.contains("__CAPTURE__"));
        assert!(!source.contains("sourceURL"));
        assert!(!super::install_injected(0).contains("sourceURL"));
    }
}
