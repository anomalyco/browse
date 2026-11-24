//! The differences between backends that are the engines' own (or a protocol's missing feature), pinned exactly.
//!
//! Each entry names a step, the JSON pointer into its normalized result, and both sides' values. They are strict
//! expected failures: the sweep fails when one no longer occurs (so a fixed engine or driver gets its entry removed),
//! and when either side's value is not the pinned one.

use serde_json::{Value, json};

#[derive(Debug, Clone, PartialEq)]
pub enum Kind {
    /// The protocol has no way to do it; the driver says so.
    Unsupported,
    /// The engines behave differently, and browse reports what each does.
    Engine(&'static str),
    /// A known bug, not fixed in this change.
    Bug(&'static str),
}

#[derive(Debug, Clone)]
pub struct KnownDivergence {
    pub scenario: &'static str,
    pub step: &'static str,
    /// JSON pointer into the step's normalized record (`/error`, `/result/...`, `/images/0/...`).
    pub pointer: &'static str,
    pub kind: Kind,
    pub chromium: Value,
    pub firefox: Value,
}

/// The marker for a key one side doesn't have.
pub const ABSENT: &str = "<absent>";

pub fn absent() -> Value {
    json!(ABSENT)
}

fn d(scenario: &'static str, step: &'static str, pointer: &'static str, kind: Kind, chromium: Value, firefox: Value) -> KnownDivergence {
    KnownDivergence { scenario, step, pointer, kind, chromium, firefox }
}

const BEFOREUNLOAD: &str = "Firefox gives a beforeunload dialog its own standard message; Chromium's is empty";
const ABORT_CODES: &str = "a failed request's error is the engine's own code (net::ERR_* in Chromium, NS_* in Firefox)";
const ERROR_TEXT: &str = "Chromium describes an Error by its stack; WebDriver BiDi serializes Errors without one, so Firefox's text is the message alone";
const REJECTION: &str = "Firefox reports an unhandled rejection without a stack, so without a source location";
const JSON_VIEWER: &str = "Firefox shows JSON responses in its JSON viewer (tabs, filter, tree); Chromium shows the raw text";
const IMAGE_TITLE: &str = "each engine titles a standalone image document its own way";
const BASIC_AUTH: &str = "Firefox holds the navigation on its HTTP auth prompt (which BiDi doesn't surface); headless Chromium cancels the challenge and fails the navigation";
const PRINT: &str = "Firefox's print dialog holds the page's script until it closes, so the click that called print() never returns; headless Chromium returns at once";
const MEDIA: &str = "media emulation";
const TOUCH: &str = "touch emulation";
// Unsupported, by protocol: Chromium's Log domain reports failed resource loads, WebDriver BiDi has no such entries;
// BiDi can't stop a running script (CDP has Runtime.terminateExecution); Firefox 160's BiDi has no media type,
// prefers-* or touch emulation.

/// Every pinned divergence between ˋchromium-cdpˋ (reference) and ˋfirefox-bidiˋ.
pub fn known() -> Vec<KnownDivergence> {
    use Kind::{Engine, Unsupported};
    let unsupported = |what: &str| json!([format!("The browser rejected every setting: {}", what)]);
    vec![
        d("dialogs", "leave-guarded", "/result/dialogs/0/message", Engine(BEFOREUNLOAD), json!(""), json!("This page is asking you to confirm that you want to leave — information you’ve entered may not be saved.")),
        d("network", "stop", "/result/exchanges/7/failure", Engine(ABORT_CODES), json!("net::ERR_ABORTED"), json!("NS_BINDING_ABORTED")),
        d("console", "entries", "/result/entries/2/text", Engine(ERROR_TEXT), json!("errored Error: boom\n    at http://PRIMARY/console:14:34"), json!("errored Error: boom")),
        d("console", "entries", "/result/entries/6/line", Engine(REJECTION), json!(21), absent()),
        d("console", "entries", "/result/entries/6/text", Engine(ERROR_TEXT), json!("Error: unhandled-rejection\n    at http://PRIMARY/console:21:30"), json!("Error: unhandled-rejection")),
        d("console", "entries", "/result/entries/6/url", Engine(REJECTION), json!("http://PRIMARY/console"), absent()),
        d("console", "entries", "/result/entries/7/text", Engine(ERROR_TEXT), json!("TypeError: thrown-error\n    at http://PRIMARY/console:22:41"), json!("TypeError: thrown-error")),
        d("console", "entries", "/result/entries/8/text", Engine(ERROR_TEXT), json!("Error: frame-error\n    at http://CROSS/console/frame:1:183"), json!("Error: frame-error")),
        d("console", "read", "/result/entries/0/text", Engine(ERROR_TEXT), json!("errored Error: boom\n    at http://PRIMARY/console:14:34"), json!("errored Error: boom")),
        d("console", "read", "/result/entries/2/line", Engine(REJECTION), json!(21), absent()),
        d("console", "read", "/result/entries/2/text", Engine(ERROR_TEXT), json!("Error: unhandled-rejection\n    at http://PRIMARY/console:21:30"), json!("Error: unhandled-rejection")),
        d("console", "read", "/result/entries/2/url", Engine(REJECTION), json!("http://PRIMARY/console"), absent()),
        d("console", "read", "/result/entries/3/text", Engine(ERROR_TEXT), json!("TypeError: thrown-error\n    at http://PRIMARY/console:22:41"), json!("TypeError: thrown-error")),
        d("console", "read", "/result/entries/4/text", Engine(ERROR_TEXT), json!("Error: frame-error\n    at http://CROSS/console/frame:1:183"), json!("Error: frame-error")),
        d("console", "browser-entries", "/result/entries", Unsupported, json!([{ "seq": 10, "time": "<TIME>", "type": "error", "text": "Failed to load resource: the server responded with a status of 404 (Not Found)", "source": "network", "url": "http://PRIMARY/missing.png" }]), json!([])),
        d("console", "browser-entries", "/result/lastSeq", Unsupported, json!(10), json!(9)),
        d("non_html", "json-snapshot", "/result", Engine(JSON_VIEWER), json!(["- code \"{\\\"kind\\\":\\\"json\\\",\\\"n\\\":1}\""]), json!(["- tablist \"Tab list\" [3 items]", "  - tab \"JSON\" [ref=e1 selected=true]", "  - tab \"Raw Data\" [ref=e2 selected=false]", "  - tab \"Headers\" [ref=e3 selected=false]", "- button \"Save\" [ref=e4]", "- button \"Copy\" [ref=e5]", "- button \"Collapse All\" [ref=e6]", "- button \"Expand All\" [ref=e7]", "- textbox \"Filter JSON\" [ref=e8]", "- treeitem \"kind \\\"json\\\"\" [ref=e9 selected=false]", "- treeitem \"n 1\" [ref=e10 selected=false]"])),
        d("non_html", "image", "/result/title", Engine(IMAGE_TITLE), json!("image.png (4×2)"), json!("image.png (PNG Image, 4\u{a0}×\u{a0}2 pixels)")),
        d("hangs", "busy-loop", "/result/0", Unsupported, json!("eval timed out after 2000 ms; the script was still running, so browse stopped it"), json!("eval timed out after 2000 ms and browse could not stop the script: the tab is not responding. Close or reload the tab")),
        d("hangs", "basic-auth", "/error", Engine(BASIC_AUTH), json!(true), json!(false)),
        d("hangs", "basic-auth", "/result", Engine(BASIC_AUTH), json!(["Navigation to http://PRIMARY/auth failed: net::ERR_INVALID_AUTH_CREDENTIALS"]), json!({ "pending": "http://PRIMARY/auth", "url": "http://PRIMARY/hangs", "warning": "The navigation to http://PRIMARY/auth did not finish within 5000 ms; it is still loading, and the tab still shows http://PRIMARY/hangs.", "tab": 2 })),
        d("hangs", "after-auth", "/result/from", Engine(BASIC_AUTH), json!("http://PRIMARY/auth"), absent()),
        d("hangs", "print", "/error", Engine(PRINT), json!(false), json!(true)),
        d("hangs", "print", "/result", Engine(PRINT), json!({ "clicked": "button \"Print\" (#print)", "url": "http://PRIMARY/hangs" }), json!(["click did not finish within 20 s: the browser stopped answering (the relay or extension may be restarting). Try again; if it keeps happening, check the tab"])),
        d("emulation", "dark", "/error", Unsupported, json!(false), json!(true)),
        d("emulation", "dark", "/result", Unsupported, json!({ "applied": { "colorScheme": "dark", "reducedMotion": "reduce" } }), unsupported(&format!("colorScheme: {MEDIA} is not supported by this browser driver; reducedMotion: {MEDIA} is not supported by this browser driver"))),
        d("emulation", "media", "/result/0", Unsupported, json!(true), json!(false)),
        d("emulation", "media", "/result/1", Unsupported, json!(true), json!(false)),
        d("emulation", "touch", "/error", Unsupported, json!(false), json!(true)),
        d("emulation", "touch", "/result", Unsupported, json!({ "applied": { "touch": true } }), unsupported(&format!("touch: {TOUCH} is not supported by this browser driver"))),
        d("emulation", "print", "/error", Unsupported, json!(false), json!(true)),
        d("emulation", "print", "/result", Unsupported, json!({ "applied": { "media": "print" } }), unsupported(&format!("media: {MEDIA} is not supported by this browser driver"))),
    ]
}
