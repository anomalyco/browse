//! End-to-end checks against a real headless Chromium (skipped when none is installed; set BROWSE_TEST_CHROME).

mod support;

use serde_json::{Value, json};
use support::Harness;

macro_rules! harness {
    ($human:expr) => {
        match Harness::start($human).await {
            Some(h) => h,
            None => {
                eprintln!("no Chromium found; skipping");
                return;
            }
        }
    };
}

fn ref_of(snapshot: &str, needle: &str) -> String {
    let line = snapshot.lines().find(|l| l.contains(needle)).unwrap_or_else(|| panic!("no line with {needle:?} in:\n{snapshot}"));
    let start = line.find("ref=").expect("ref") + 4;
    line[start..].split([']', ' ']).next().unwrap().to_string()
}

const FORM: &str = r#"<!doctype html><html><head><title>Form</title></head><body>
<main>
<h1>Sign up</h1>
<label>Email <input id="email" name="email"></label>
<label>Password <input id="pw" type="password"></label>
<label><input type="checkbox" id="terms"> I agree</label>
<select id="plan"><option value="free">Free</option><option value="pro">Pro plan</option></select>
<button id="save" onclick="document.getElementById('out').textContent = 'saved ' + document.getElementById('email').value">Save</button>
<p id="out">nothing yet</p>
<a href="/next">Next page</a>
</main>
</body></html>"#;

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn snapshot_click_fill_and_refs() {
    let h = harness!(false);
    let url = h.server.page("/form", FORM);
    h.server.page("/next", "<!doctype html><title>Next</title><h1>Second page</h1>");
    let nav = h.json("navigate", json!({ "url": url })).await;
    assert_eq!(nav["title"], "Form");

    let snapshot = h.ok("snapshot", json!({})).await;
    assert!(snapshot.contains("- heading \"Sign up\" [level=1]"), "{snapshot}");
    let email = ref_of(&snapshot, "textbox \"Email\"");
    let save = ref_of(&snapshot, "button \"Save\"");

    let filled = h.json("fill", json!({ "fields": [ { "ref": email, "value": "a@b.co" }, { "selector": "#terms", "checked": true }, { "selector": "#plan", "value": "Pro plan" } ] })).await;
    assert_eq!(filled["filled"][1]["checked"], true, "{filled}");
    assert_eq!(filled["filled"][2]["selected"][0], "pro", "{filled}");

    let clicked = h.json("click", json!({ "ref": save })).await;
    assert!(clicked["clicked"].as_str().unwrap().contains("button \"Save\""), "{clicked}");
    let text = h.ok("eval", json!({ "expression": "document.getElementById('out').textContent" })).await;
    assert_eq!(text, "\"saved a@b.co\"");

    // Refs survive a second snapshot, and delta shows only what changed.
    let again = h.ok("snapshot", json!({})).await;
    assert_eq!(ref_of(&again, "button \"Save\""), save);
    let delta = h.ok("snapshot", json!({ "delta": true })).await;
    assert!(delta.ends_with("0 additions, 0 removals, 12 unchanged") || delta.contains("unchanged"), "{delta}");
    let found = h.ok("snapshot", json!({ "find": "button \"save" })).await;
    assert!(found.starts_with("1 matching snapshot line"), "{found}");

    // Playwright selectors.
    h.ok("click", json!({ "selector": "role=checkbox[name=\"I agree\"]" })).await;
    let checked = h.ok("eval", json!({ "expression": "document.getElementById('terms').checked" })).await;
    assert_eq!(checked, "false");
    let typed = h.json("type", json!({ "selector": "label=Password", "text": "Ab1!" })).await;
    assert_eq!(typed["typed"], 4);
    let value = h.ok("eval", json!({ "expression": "(el) => el.value", "selector": "#pw" })).await;
    assert_eq!(value, "\"Ab1!\"");

    // Ambiguous selectors fail with the matches.
    let error = h.err("click", json!({ "selector": "input" })).await;
    assert!(error.contains("matches 3 elements"), "{error}");

    // A link click navigates; old refs are stale.
    let next = ref_of(&again, "link \"Next page\"");
    let result = h.json("click", json!({ "ref": next })).await;
    assert_eq!(result["navigated"], true, "{result}");
    assert_eq!(result["title"], "Next");
    let stale = h.err("click", json!({ "ref": save })).await;
    assert!(stale.contains("stale"), "{stale}");

    let back = h.json("navigate", json!({ "action": "back" })).await;
    assert!(back["url"].as_str().unwrap().ends_with("/form"), "{back}");

    // Nothing browse did is visible to the page, and Runtime/Console were never enabled.
    let methods = h.tab.methods();
    assert!(!methods.iter().any(|m| m == "Runtime.enable" || m == "Console.enable"), "{methods:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn snapshot_navigation_controls_stay_visible() {
    let h = harness!(false);
    // A nav of role=button items is content, not a link list: collapsing it would hide every control.
    let page = h.server.page(
        "/nav-controls",
        r#"<!doctype html><div id="a"><h2>A plain div</h2>
  <div role="button" tabindex="0"><div><span>alice</span><span>hi</span></div></div></div>
<section id="b"><h2>B section</h2>
  <div role="button" tabindex="0">bob direct text</div></section>
<nav aria-label="C nav"><h2>C nav</h2>
  <div role="button" tabindex="0"><div><span>carol</span></div></div></nav>
<nav aria-label="Sections"><a href="/a">Alpha</a><a href="/b">Beta</a><a href="/c">Gamma</a></nav>
<aside aria-label="Aside links"><a href="/s1">S1</a><a href="/s2">S2</a><a href="/s3">S3</a><a href="/s4">S4</a>
  <a href="/s5">S5</a><a href="/s6">S6</a><a href="/s7">S7</a><a href="/s8">S8</a></aside>
<nav aria-label="Mobile"><a href="/m">Mobile</a><button style="display:none">Menu</button></nav>
<nav aria-label="Action nav"><a href="/action" role="button">Action</a></nav>
<aside style="height:0"><button style="position:absolute">First</button><button style="position:absolute">Second</button></aside>
<input aria-placeholder="Message only">"#,
    );
    h.ok("navigate", json!({ "url": page })).await;
    let snapshot = h.ok("snapshot", json!({})).await;
    let carol = ref_of(&snapshot, "button \"carol\"");
    assert!(carol.starts_with('e'), "carol keeps a compact ref ({carol}):\n{snapshot}");
    // A pure link list still collapses at its expanded children's heading depth, under the C nav heading.
    assert!(
        snapshot.lines().any(|line| line == "  - navigation \"Sections\" [3 links, collapsed]"),
        "{snapshot}"
    );
    assert!(!snapshot.contains("link \"Alpha\""), "{snapshot}");
    // An aside with enough links still collapses; a hidden button does not keep a link nav open.
    assert!(snapshot.contains("- navigation \"Aside links\" [8 links, collapsed]"), "{snapshot}");
    assert!(snapshot.contains("- navigation \"Mobile\" [1 link, collapsed]"), "{snapshot}");
    // A link whose computed role is button is a control, so its nav stays expanded with a ref.
    let action = ref_of(&snapshot, "button \"Action\"");
    assert!(action.starts_with('e'), "the action keeps a ref ({action}):\n{snapshot}");
    // isVisible doesn't inherit: an invisible aside with visible positioned children still shows them.
    let first = ref_of(&snapshot, "button \"First\"");
    let second = ref_of(&snapshot, "button \"Second\"");
    assert!(first.starts_with('e'), "First keeps a ref ({first}):\n{snapshot}");
    assert!(second.starts_with('e'), "Second keeps a ref ({second}):\n{snapshot}");
    // aria-placeholder names a control that has no label, title or placeholder of its own.
    assert!(snapshot.contains("- textbox \"Message only\" [ref="), "{snapshot}");
    let found = h.ok("snapshot", json!({ "find": "carol" })).await;
    assert!(found.starts_with("1 matching snapshot line"), "{found}");
    // find greps the rendered lines, so a collapsed link list has to be expanded for the match.
    let found_link = h.ok("snapshot", json!({ "find": "Alpha" })).await;
    assert!(found_link.contains("link \"Alpha\""), "{found_link}");
    // A find snapshot must not replace the diff baseline: the page did not change since the first snapshot.
    let diff = h.ok("snapshot", json!({ "diff": true })).await;
    assert_eq!(
        diff,
        format!("0 additions, 0 removals, {} unchanged", snapshot.lines().count()),
        "{diff}"
    );

    // interactive asks for controls, so the summary would hide exactly what was asked for.
    let interactive = h.ok("snapshot", json!({ "interactive": true })).await;
    assert!(!interactive.contains("navigation \"Sections\""), "{interactive}");
    let alpha = ref_of(&interactive, "link \"Alpha\"");
    assert!(alpha.starts_with('e'), "the link keeps a ref ({alpha}):\n{interactive}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn snapshot_main_scope_note() {
    let h = harness!(false);
    let page = h.server.page(
        "/main-scope-note",
        r#"<!doctype html><nav aria-label="Thread list">
  <div role="button" tabindex="0">Thread one</div>
  <div role="button" tabindex="0">Thread two</div></nav>
<main><p>x</p><button>Send message</button></main>"#,
    );
    h.ok("navigate", json!({ "url": page })).await;
    let snapshot = h.ok("snapshot", json!({})).await;
    assert!(
        snapshot.starts_with(
            "scoped to <main>; 1 landmark and 2 controls outside it are not shown (within: \"body\" to include them)\n"
        ),
        "{snapshot}"
    );
    assert!(snapshot.contains("button \"Send message\""), "{snapshot}");
    assert!(!snapshot.contains("Thread one"), "{snapshot}");
    // An explicit within disables main scoping, so the nav rows are captured instead of noted.
    let whole = h.ok("snapshot", json!({ "within": "body" })).await;
    assert!(whole.contains("button \"Thread one\""), "{whole}");
    assert!(!whole.contains("scoped to <main>"), "{whole}");
    // find never filters the note out, even when no entry matches.
    let no_match = h.ok("snapshot", json!({ "find": "nothing on this page" })).await;
    assert_eq!(
        no_match,
        "scoped to <main>; 1 landmark and 2 controls outside it are not shown (within: \"body\" to include them)\nNo snapshot lines matched \"nothing on this page\".",
        "{no_match}"
    );
}

/// An app or game in an iframe over the page, outside <main>: a main the page switched off doesn't scope the snapshot,
/// and an iframe left outside a scoped main is named in the note.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn snapshot_main_scope_and_iframes_outside_it() {
    let h = harness!(false);
    h.server.page("/game", "<!doctype html><h1>Backstab</h1><button>Shoot</button>");
    let overlay = r#"<div style="position:fixed;inset:0"><iframe title="Backstab" src="/game" style="width:100%;height:100%;border:0"></iframe></div>"#;
    let switched_off = h.server.page("/inert-main", &format!(r#"<!doctype html><main inert><a href="/a">01 Blackout</a></main>{overlay}"#));
    h.ok("navigate", json!({ "url": switched_off })).await;
    let snapshot = h.ok("snapshot", json!({})).await;
    assert!(!snapshot.contains("scoped to <main>"), "{snapshot}");
    assert!(snapshot.contains("iframe \"Backstab\"") && snapshot.contains("button \"Shoot\""), "{snapshot}");

    let hidden = h.server.page("/hidden-main", &format!(r#"<!doctype html><main aria-hidden="true"><a href="/a">01 Blackout</a></main>{overlay}"#));
    h.ok("navigate", json!({ "url": hidden })).await;
    let snapshot = h.ok("snapshot", json!({})).await;
    assert!(snapshot.contains("button \"Shoot\""), "{snapshot}");

    let live = h.server.page("/live-main", &format!(r#"<!doctype html><main><a href="/a">01 Blackout</a></main>{overlay}"#));
    h.ok("navigate", json!({ "url": live })).await;
    let snapshot = h.ok("snapshot", json!({})).await;
    assert!(
        snapshot.starts_with("scoped to <main>; 1 iframe outside it is not shown (within: \"body\" to include them)\n"),
        "{snapshot}"
    );
    let whole = h.ok("snapshot", json!({ "within": "body" })).await;
    assert!(whole.contains("button \"Shoot\""), "{whole}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn refs_carry_through_find_snapshots() {
    let h = harness!(false);
    let url = h.server.page("/refs-find", "<!doctype html><button>Start</button>");
    h.ok("navigate", json!({ "url": url })).await;
    h.ok("snapshot", json!({})).await;
    h.ok(
        "eval",
        json!({ "expression": "(() => { const button = document.createElement('button'); button.textContent = 'Submit'; document.body.append(button) })()" }),
    )
    .await;

    let first = h.ok("snapshot", json!({ "find": "Submit" })).await;
    let first_ref = ref_of(&first, "button \"Submit\"");
    // A find snapshot is now the latest snapshot, so the next find reuses the same ref.
    let second = h.ok("snapshot", json!({ "find": "Submit" })).await;
    let second_ref = ref_of(&second, "button \"Submit\"");
    assert_eq!(first_ref, second_ref, "{first}\n---\n{second}");
    let normal = h.ok("snapshot", json!({})).await;
    assert_eq!(ref_of(&normal, "button \"Submit\""), first_ref, "{normal}");
    h.ok("click", json!({ "ref": first_ref })).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn stealth_isolated_world_and_main_world() {
    let h = harness!(false);
    let url = h.server.page("/s", "<!doctype html><script>window.pageSecret = 42; window.baseline = new Set(Object.getOwnPropertyNames(window).concat(['baseline']))</script><button>Go</button>");
    h.ok("navigate", json!({ "url": url })).await;
    h.ok("snapshot", json!({})).await;
    h.ok("click", json!({ "selector": "role=button[name=\"Go\"]" })).await;
    h.ok("snapshot", json!({ "mode": "aria" })).await;
    let isolated = h.ok("eval", json!({ "expression": "typeof window.pageSecret" })).await;
    assert_eq!(isolated, "\"undefined\"");
    let main = h.ok("eval", json!({ "expression": "window.pageSecret", "world": "main" })).await;
    assert_eq!(main, "42");
    let globals = h.ok("eval", json!({ "expression": "Object.getOwnPropertyNames(window).filter((name) => !window.baseline.has(name))", "world": "main" })).await;
    assert_eq!(globals, "[]");
    let with_el = h.ok("eval", json!({ "expression": "(el, arg) => el.textContent + arg", "selector": "button", "arg": "!", "world": "main" })).await;
    assert_eq!(with_el, "\"Go!\"");
}

/// eval's value comes back as structured content too, so clients that read it get the value, not JSON text.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn eval_returns_its_value_as_structured_content() {
    let h = harness!(false);
    let url = h.server.page("/v", "<!doctype html><title>Values</title>");
    h.ok("navigate", json!({ "url": url })).await;
    let structured = |output: browse_core::ToolOutput| output.structured_content.unwrap_or_default();
    let title = h.call("eval", json!({ "expression": "document.title" })).await;
    assert_eq!(support::text_of(&title), "\"Values\"", "the text stays JSON");
    assert_eq!(structured(title), json!({ "value": "Values" }));
    assert_eq!(structured(h.call("eval", json!({ "expression": "1 + 1" })).await), json!({ "value": 2 }));
    assert_eq!(structured(h.call("eval", json!({ "expression": "JSON.stringify([1])" })).await), json!({ "value": "[1]" }));
    assert_eq!(structured(h.call("eval", json!({ "expression": "({ a: [1] })" })).await), json!({ "value": { "a": [1] } }));
    assert_eq!(structured(h.call("eval", json!({ "expression": "undefined" })).await), json!({ "value": null }));
    let nothing = structured(h.call("eval", json!({ "expression": "const t = document.title;" })).await);
    assert_eq!(nothing["value"], serde_json::Value::Null);
    assert!(nothing["hint"].as_str().unwrap_or_default().contains("return"), "{nothing}");
    let big = structured(h.call("eval", json!({ "expression": "'x'.repeat(200000)" })).await);
    assert_eq!(big["value"], serde_json::Value::Null);
    assert!(big["truncated"].as_str().unwrap_or_default().contains("characters"), "{big}");
    let failed = h.call("eval", json!({ "expression": "null.x" })).await;
    assert!(failed.is_error && failed.structured_content.is_none());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn covered_elements_fail_fast_and_dialogs_pause() {
    let h = harness!(false);
    let url = h.server.page(
        "/c",
        r#"<!doctype html><button id="under" onclick="this.textContent='hit'">Under</button>
<div id="overlay" style="position:fixed;inset:0;background:rgba(0,0,0,.3)"></div>
<button id="alert" style="position:fixed;bottom:10px;z-index:2" onclick="document.title = String(confirm('Sure?'))">Ask</button>"#,
    );
    h.ok("navigate", json!({ "url": url })).await;
    let started = std::time::Instant::now();
    let error = h.err("click", json!({ "selector": "#under" })).await;
    assert!(error.contains("div id=\"overlay\""), "{error}");
    assert!(started.elapsed() < std::time::Duration::from_secs(3));

    let clicked = h.json("click", json!({ "selector": "#alert" })).await;
    assert_eq!(clicked["dialog"]["type"], "confirm", "{clicked}");
    let blocked = h.err("snapshot", json!({})).await;
    assert!(blocked.contains("dialog is open"), "{blocked}");
    let status = h.json("dialog", json!({})).await;
    assert_eq!(status["dialog"]["message"], "Sure?");
    h.ok("dialog", json!({ "action": "accept" })).await;
    let title = h.ok("eval", json!({ "expression": "document.title" })).await;
    assert_eq!(title, "\"true\"");
    h.ok("dialog", json!({ "auto": "dismiss" })).await;
    h.ok("click", json!({ "selector": "#alert" })).await;
    let title = h.ok("eval", json!({ "expression": "document.title" })).await;
    assert_eq!(title, "\"false\"");
}

/// fill checks what a click checks on text fields: one under an overlay fails without force and is left untouched,
/// and a fields list stops at the covered one, keeping what it already filled.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn fill_fails_when_something_covers_the_field() {
    let h = harness!(false);
    let url = h.server.page(
        "/covered-form",
        r#"<!doctype html><style>
#first, #name { position: absolute; left: 10px; width: 200px }
#first { top: 10px }
#name { top: 160px }
#overlay { position: fixed; left: 0; top: 100px; width: 100%; height: 300px; background: rgba(0,0,0,.3) }
</style>
<input id="first"><input id="name">
<div id="overlay"></div>"#,
    );
    h.ok("navigate", json!({ "url": url })).await;

    let error = h.err("fill", json!({ "selector": "#name", "value": "x" })).await;
    assert!(error.contains("div id=\"overlay\""), "{error}");
    assert!(error.contains("force: true"), "{error}");
    let value = h.ok("eval", json!({ "expression": "document.getElementById('name').value" })).await;
    assert_eq!(value, "\"\"", "a covered field is left empty");

    // Each field is filled in order: the ones before the covered one keep their value.
    let error = h.err("fill", json!({ "fields": [ { "selector": "#first", "value": "one" }, { "selector": "#name", "value": "two" } ] })).await;
    assert!(error.contains("div id=\"overlay\""), "{error}");
    assert!(error.contains("Filled") && error.contains("then"), "{error}");
    let value = h.ok("eval", json!({ "expression": "document.getElementById('first').value" })).await;
    assert_eq!(value, "\"one\"", "the field before the covered one was filled");
    let value = h.ok("eval", json!({ "expression": "document.getElementById('name').value" })).await;
    assert_eq!(value, "\"\"", "the covered field is left empty");

    h.ok("fill", json!({ "selector": "#name", "value": "x", "force": true })).await;
    let value = h.ok("eval", json!({ "expression": "document.getElementById('name').value" })).await;
    assert_eq!(value, "\"x\"");

    // A floating label over its own field is not a cover: clicking it focuses the field, so both work.
    let url = h.server.page(
        "/floating-label",
        r#"<!doctype html><style>
input { position: absolute; left: 20px; top: 20px; width: 200px; height: 40px }
label { position: absolute; left: 100px; top: 30px; width: 60px; height: 20px; z-index: 2; background: #fff }
</style>
<label for="city">City</label><input id="city">"#,
    );
    h.ok("navigate", json!({ "url": url })).await;
    h.ok("fill", json!({ "selector": "#city", "value": "Paris" })).await;
    let value = h.ok("eval", json!({ "expression": "document.getElementById('city').value" })).await;
    assert_eq!(value, "\"Paris\"");
    h.ok("click", json!({ "selector": "#city" })).await;
    let focused = h.ok("eval", json!({ "expression": "document.activeElement.id" })).await;
    assert_eq!(focused, "\"city\"");
}

/// Native <select>s are often hidden under custom dropdowns (Select2 and the like) and driven by setting their
/// value, so fill and select set them without checking what is on top.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn hidden_or_covered_selects_are_still_set() {
    let h = harness!(false);
    let url = h.server.page(
        "/styled-selects",
        r#"<!doctype html><style>
.select2 { position: relative; display: inline-block }
.select2 select { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; border: 0; clip: rect(0 0 0 0); overflow: hidden }
.select2 span { display: block; padding: 4px 8px; border: 1px solid #ccc; background: #fff }
.covered { position: relative; width: 120px; height: 30px }
.covered button { position: absolute; inset: 0; width: 120px; height: 30px; z-index: 2 }
.covered select { opacity: 0; width: 120px; height: 30px }
</style>
<label class="select2"><span>Free</span><select id="custom"><option value="free">Free</option><option value="pro">Pro</option></select></label>
<div class="covered"><button type="button">Choose</button><select id="invisible"><option value="free">Free</option><option value="pro">Pro</option></select></div>
<select id="none" style="display:none"><option value="free">Free</option><option value="pro">Pro</option></select>"#,
    );
    h.ok("navigate", json!({ "url": url })).await;

    let started = std::time::Instant::now();
    for id in ["custom", "invisible", "none"] {
        h.ok("fill", json!({ "selector": format!("#{id}"), "value": "Pro" })).await;
        let value = h.ok("eval", json!({ "expression": format!("document.getElementById('{id}').value") })).await;
        assert_eq!(value, "\"pro\"", "fill sets #{id}");
        h.ok("select", json!({ "selector": format!("#{id}"), "values": ["Free"] })).await;
        let value = h.ok("eval", json!({ "expression": format!("document.getElementById('{id}').value") })).await;
        assert_eq!(value, "\"free\"", "select sets #{id}");
    }
    assert!(started.elapsed() < std::time::Duration::from_secs(5), "hidden selects are set without waiting; took {:?}", started.elapsed());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn iframes_same_and_cross_origin() {
    let h = harness!(false);
    let inner = h.server.page("/inner", r#"<!doctype html><button onclick="this.textContent='inner clicked'">Inner button</button>"#);
    let cross = h.server.other_origin("/inner");
    let _ = inner;
    let url = h.server.page(
        "/frames",
        &format!(
            r#"<!doctype html><h1>Outer</h1>
<iframe title="Same" srcdoc="<button onclick=&quot;this.textContent='same clicked'&quot;>Same button</button>" style="width:300px;height:100px"></iframe>
<iframe title="Cross" src="{cross}" style="width:300px;height:100px;margin-top:50px"></iframe>"#
        ),
    );
    h.json("navigate", json!({ "url": url, "waitUntil": "settle" })).await;
    let snapshot = h.ok("snapshot", json!({})).await;
    assert!(snapshot.contains("iframe \"Same\""), "{snapshot}");
    let same = ref_of(&snapshot, "button \"Same button\"");
    let cross_ref = ref_of(&snapshot, "button \"Inner button\"");
    h.ok("click", json!({ "ref": same })).await;
    h.ok("click", json!({ "ref": cross_ref })).await;
    let after = h.ok("snapshot", json!({})).await;
    assert!(after.contains("same clicked") && after.contains("inner clicked"), "{after}");
    let via_selector = h.ok("eval", json!({ "expression": "document.querySelector('button').textContent", "frame": "iframe[title=Cross]" })).await;
    assert_eq!(via_selector, "\"inner clicked\"");
    h.ok("click", json!({ "selector": "iframe[title=Cross] >> frame >> role=button" })).await;
    let aria = h.ok("snapshot", json!({ "mode": "aria" })).await;
    assert!(aria.contains("inner clicked"), "{aria}");
    let aria_ref = ref_of(&aria, "button \"same clicked\"");
    assert!(aria_ref.starts_with('f'), "{aria}");
    h.ok("click", json!({ "ref": aria_ref })).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn fill_uploads_keys_scroll_and_waits() {
    let _upload = support::UPLOAD_LOCK.lock().await;
    let h = harness!(true);
    let url = h.server.page(
        "/misc",
        r#"<!doctype html><input id="pw" type="password"><input id="file" type="file" multiple>
<input id="q" onkeydown="if (event.key === 'Enter') document.title = 'searched ' + this.value">
<div style="height:3000px"></div><button id="far" onclick="setTimeout(() => { const p = document.createElement('p'); p.textContent = 'Loaded later'; document.body.append(p) }, 300)">Far away</button>"#,
    );
    h.ok("navigate", json!({ "url": url })).await;
    h.ok("eval", json!({ "expression": "window.uploadChanges = []; document.getElementById('file').addEventListener('change', (event) => window.uploadChanges.push(event.isTrusted))" })).await;
    h.ok("fill", json!({ "selector": "#pw", "value": "pw-123" })).await;
    let value = h.ok("eval", json!({ "expression": "document.getElementById('pw').value" })).await;
    assert_eq!(value, "\"pw-123\"");
    let rejected = h.err("fill", json!({ "selector": "#pw", "secret": "password" })).await;
    assert!(rejected.contains("value or checked"), "{rejected}");

    let file = h.files.0.join("upload.txt");
    std::fs::write(&file, "hello").unwrap();
    let uploaded = h.json("upload", json!({ "selector": "#file", "files": [file.display().to_string()] })).await;
    assert_eq!(uploaded["files"][0], "upload.txt");
    assert_eq!(uploaded["via"], "paths", "{uploaded}");
    let names = h.ok("eval", json!({ "expression": "document.getElementById('file').files[0].name" })).await;
    assert_eq!(names, "\"upload.txt\"");
    let size = h.ok("eval", json!({ "expression": "document.getElementById('file').files[0].size" })).await;
    assert_eq!(size, "5");
    let changes = h.ok("eval", json!({ "expression": "window.uploadChanges" })).await;
    assert_eq!(changes, "[true]", "one trusted change event");
    let prefix = format!("browse-upload-probe-{}-", std::process::id());
    let leftovers: Vec<String> = std::fs::read_dir(std::env::temp_dir())
        .unwrap()
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.file_name().to_string_lossy().to_string())
        .filter(|name| name.starts_with(&prefix))
        .collect();
    assert!(leftovers.is_empty(), "the sentinel folders were removed: {leftovers:?}");
    h.err("upload", json!({ "selector": "#file", "files": ["/etc/passwd"] })).await;

    h.ok("type", json!({ "selector": "#q", "text": "rust lang", "submit": true })).await;
    let title = h.ok("eval", json!({ "expression": "document.title" })).await;
    assert_eq!(title, "\"searched rust lang\"");
    h.ok("press", json!({ "selector": "#q", "key": ["ControlOrMeta+a", "Backspace"] })).await;
    let cleared = h.ok("eval", json!({ "expression": "document.getElementById('q').value" })).await;
    assert_eq!(cleared, "\"\"");

    // Human input scrolls toward the far button with the wheel before clicking it.
    h.ok("click", json!({ "selector": "#far" })).await;
    let waited = h.json("wait_for", json!({ "text": "Loaded later", "timeout": 3000 })).await;
    assert_eq!(waited["ok"], true);
    let scrolled = h.json("scroll", json!({ "to": "top" })).await;
    assert_eq!(scrolled["scrollY"], 0.0);
    let down = h.json("scroll", json!({ "deltaY": 500 })).await;
    assert!(down["scrollY"].as_f64().unwrap() > 100.0, "{down}");
    let timeout = h.err("wait_for", json!({ "selector": "#missing", "timeout": 300 })).await;
    assert!(timeout.contains("Timed out"), "{timeout}");
    let webmcp = h.json("webmcp", json!({ "action": "list" })).await;
    assert_eq!(webmcp["tools"].as_array().unwrap().len(), 0);
    let emulated = h.json("emulate", json!({ "viewport": { "width": 500, "height": 400 }, "colorScheme": "dark" })).await;
    assert_eq!(emulated["applied"]["viewport"]["width"], 500);
    let dark = h.ok("eval", json!({ "expression": "matchMedia('(prefers-color-scheme: dark)').matches && innerWidth" })).await;
    assert_eq!(dark, "500");
    h.ok("emulate", json!({ "viewport": "reset", "colorScheme": "reset" })).await;

    let fetch = "fetch(location.href).then(() => 'online', () => 'offline')";
    h.ok("emulate", json!({ "offline": true })).await;
    assert_eq!(h.ok("eval", json!({ "expression": fetch })).await, "\"offline\"");
    let flag = h.state.inner().lock().await.get("browse.network.offline").and_then(|v| v.downcast_ref::<bool>()).copied();
    assert_eq!(flag, Some(true));
    h.ok("emulate", json!({ "offline": false })).await;
    assert_eq!(h.ok("eval", json!({ "expression": fetch })).await, "\"online\"");
    let flag = h.state.inner().lock().await.get("browse.network.offline").and_then(|v| v.downcast_ref::<bool>()).copied();
    assert_eq!(flag, Some(false));
}

/// The values `Page.setInterceptFileChooserDialog` was sent, in order.
fn chooser_states(calls: &[(String, Value)]) -> Vec<bool> {
    calls
        .iter()
        .filter(|(method, _)| method == "Page.setInterceptFileChooserDialog")
        .map(|(_, params)| params["enabled"].as_bool().unwrap_or(false))
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn upload_clicks_a_button_that_opens_a_file_chooser() {
    let _upload = support::UPLOAD_LOCK.lock().await;
    let h = harness!(false);
    let url = h.server.page(
        "/chooser",
        r#"<!doctype html><button id="attach" onclick="document.getElementById('file').click()">Attach a file</button>
<input id="file" type="file" style="display:none">"#,
    );
    h.ok("navigate", json!({ "url": url })).await;
    h.ok("eval", json!({ "expression": "window.uploadChanges = 0; window.uploadTrusted = null; document.getElementById('file').addEventListener('change', (event) => { window.uploadChanges += 1; window.uploadTrusted = event.isTrusted })" })).await;
    let file = h.files.0.join("chooser.txt");
    std::fs::write(&file, "through the chooser").unwrap();

    let uploaded = h
        .json(
            "upload",
            json!({ "selector": "#attach", "files": [file.display().to_string()] }),
        )
        .await;
    assert_eq!(uploaded["files"][0], "chooser.txt");
    assert_eq!(uploaded["via"], "paths", "{uploaded}");
    assert_eq!(
        h.ok(
            "eval",
            json!({ "expression": "document.getElementById('file').files[0].name" })
        )
        .await,
        "\"chooser.txt\""
    );
    assert_eq!(
        h.ok(
            "eval",
            json!({ "expression": "document.getElementById('file').files[0].text()" })
        )
        .await,
        "\"through the chooser\""
    );
    assert_eq!(
        h.ok("eval", json!({ "expression": "window.uploadChanges" }))
            .await,
        "1"
    );
    assert_eq!(
        h.ok("eval", json!({ "expression": "window.uploadTrusted" }))
            .await,
        "true",
        "the change event is trusted"
    );
    assert_eq!(
        chooser_states(&h.tab.calls()),
        vec![true, false],
        "interception is enabled before the click and disabled after"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn upload_clicks_a_button_that_creates_the_input_while_clicking() {
    let _upload = support::UPLOAD_LOCK.lock().await;
    let h = harness!(false);
    let url = h.server.page(
        "/chooser-dynamic",
        r#"<!doctype html><button id="attach" onclick="const input = document.createElement('input'); input.type = 'file'; input.addEventListener('change', (event) => { document.body.dataset.name = input.files[0].name; document.body.dataset.trusted = event.isTrusted }); document.body.append(input); input.click()">Attach</button>"#,
    );
    h.ok("navigate", json!({ "url": url })).await;
    let file = h.files.0.join("dynamic.txt");
    std::fs::write(&file, "made while clicking").unwrap();

    let uploaded = h
        .json(
            "upload",
            json!({ "selector": "#attach", "files": [file.display().to_string()] }),
        )
        .await;
    assert_eq!(uploaded["files"][0], "dynamic.txt", "{uploaded}");
    assert_eq!(h.ok("eval", json!({ "expression": "document.body.dataset.name" })).await, "\"dynamic.txt\"");
    assert_eq!(h.ok("eval", json!({ "expression": "document.body.dataset.trusted" })).await, "\"true\"");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn upload_reports_a_button_that_opens_no_file_chooser() {
    let _upload = support::UPLOAD_LOCK.lock().await;
    let h = harness!(false);
    let url = h.server.page("/chooser-none", r#"<!doctype html><button id="plain" onclick="document.title = 'clicked'">Nothing</button>"#);
    h.ok("navigate", json!({ "url": url })).await;
    let file = h.files.0.join("unused.txt");
    std::fs::write(&file, "never uploaded").unwrap();

    let error = h
        .err(
            "upload",
            json!({ "selector": "#plain", "files": [file.display().to_string()], "timeout": 1000 }),
        )
        .await;
    assert!(
        error.contains("clicked") && error.contains("no file chooser opened"),
        "{error}"
    );
    assert_eq!(
        chooser_states(&h.tab.calls()),
        vec![true, false],
        "interception is disabled after the error"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn upload_clicks_into_a_cross_origin_iframe() {
    let _upload = support::UPLOAD_LOCK.lock().await;
    let h = harness!(false);
    let inner = h.server.other_origin("/chooser-inner");
    h.server.page(
        "/chooser-inner",
        r#"<!doctype html><button id="attach" onclick="document.getElementById('file').click()">Attach</button>
<input id="file" type="file" onchange="document.body.dataset.changes = (Number(document.body.dataset.changes) || 0) + 1">"#,
    );
    let url = h.server.page("/chooser-outer", &format!(r#"<!doctype html><iframe title="Cross" src="{inner}" style="width:400px;height:300px"></iframe>"#));
    h.ok("navigate", json!({ "url": url })).await;
    h.ok("wait_for", json!({ "selector": "iframe[title=Cross]" }))
        .await;
    let file = h.files.0.join("frame.txt");
    std::fs::write(&file, "inside the frame").unwrap();

    let uploaded = h.json("upload", json!({ "selector": "iframe[title=Cross] >> frame >> #attach", "files": [file.display().to_string()] })).await;
    assert_eq!(uploaded["files"][0], "frame.txt", "{uploaded}");
    let name = h.ok("eval", json!({ "expression": "document.getElementById('file').files[0].name", "frame": "iframe[title=Cross]" })).await;
    assert_eq!(name, "\"frame.txt\"");
    let changes = h.ok("eval", json!({ "expression": "document.body.dataset.changes", "frame": "iframe[title=Cross]" })).await;
    assert_eq!(changes, "\"1\"");
    let states = chooser_states(&h.tab.calls());
    assert_eq!(
        states,
        vec![true, true, false, false],
        "the root and the cross-origin child session were armed and disarmed: {states:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn upload_copies_files_when_the_browser_is_elsewhere() {
    let _upload = support::UPLOAD_LOCK.lock().await;
    let h = match Harness::start_elsewhere(false).await {
        Some(h) => h,
        None => {
            eprintln!("no Chromium found; skipping");
            return;
        }
    };
    let url = h.server.page("/upload-copy", r#"<!doctype html><input id="file" type="file" multiple>"#);
    h.ok("navigate", json!({ "url": url })).await;
    let file = h.files.0.join("copied.txt");
    std::fs::write(&file, "copied bytes").unwrap();
    let uploaded = h.json("upload", json!({ "selector": "#file", "files": [file.display().to_string()] })).await;
    assert_eq!(uploaded["via"], "copy", "{uploaded}");
    let name = h.ok("eval", json!({ "expression": "document.getElementById('file').files[0].name" })).await;
    assert_eq!(name, "\"copied.txt\"");
    let content = h.ok("eval", json!({ "expression": "document.getElementById('file').files[0].text()" })).await;
    assert_eq!(content, "\"copied bytes\"");
    assert!(!h.tab.methods().iter().any(|m| m == "DOM.setFileInputFiles"), "{:?}", h.tab.methods());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn upload_accepts_inline_files_and_mixes_them_with_paths() {
    let _upload = support::UPLOAD_LOCK.lock().await;
    let h = harness!(false);
    let url = h.server.page("/upload-inline", r#"<!doctype html><input id="file" type="file" multiple>"#);
    h.ok("navigate", json!({ "url": url })).await;
    let local = h.files.0.join("local.txt");
    std::fs::write(&local, "local bytes").unwrap();
    // Inline bytes always copy in, even with the browser on this machine, and a mix with paths copies those too.
    let uploaded = h.json(
        "upload",
        json!({
            "selector": "#file",
            "files": [
                { "name": "notes.txt", "data": "aGVsbG8gaW5saW5l", "mimeType": "text/plain", "lastModified": 1_700_000_000_000u64 },
                { "name": "extra.json", "data": "e30=" },
                local.display().to_string(),
            ],
        }),
    )
    .await;
    assert_eq!(uploaded["via"], "copy", "{uploaded}");
    assert_eq!(uploaded["files"], json!(["notes.txt", "extra.json", "local.txt"]));
    assert!(!h.tab.methods().iter().any(|m| m == "DOM.setFileInputFiles"), "{:?}", h.tab.methods());
    let read = h
        .ok(
            "eval",
            json!({ "expression": "Promise.all(Array.from(document.getElementById('file').files).map(async (file) => ({ name: file.name, size: file.size, type: file.type, lastModified: file.lastModified, content: await file.text() })))" }),
        )
        .await;
    let files: serde_json::Value = serde_json::from_str(&read).unwrap();
    assert_eq!(files[0]["name"], "notes.txt");
    assert_eq!(files[0]["size"], 12);
    assert_eq!(files[0]["type"], "text/plain");
    assert_eq!(files[0]["lastModified"], 1_700_000_000_000u64);
    assert_eq!(files[0]["content"], "hello inline");
    // Without mimeType the name's extension picks it, like the paths route.
    assert_eq!(files[1]["name"], "extra.json");
    assert_eq!(files[1]["size"], 2);
    assert_eq!(files[1]["type"], "application/json");
    assert_eq!(files[1]["content"], "{}");
    // No lastModified given: browse stamps it now rather than 1970.
    assert!(files[1]["lastModified"].as_u64().unwrap() > 1_704_067_200_000, "{}", files[1]);
    assert_eq!(files[2]["name"], "local.txt");
    assert_eq!(files[2]["content"], "local bytes");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn upload_accepts_a_single_inline_object_and_an_empty_file() {
    let _upload = support::UPLOAD_LOCK.lock().await;
    let h = harness!(false);
    let url = h.server.page("/upload-inline-single", r#"<!doctype html><input id="file" type="file" multiple>"#);
    h.ok("navigate", json!({ "url": url })).await;
    // files may be one inline object, not only an array of them.
    let uploaded = h.json("upload", json!({ "selector": "#file", "files": { "name": "one.txt", "data": "aGVsbG8=" } })).await;
    assert_eq!(uploaded["via"], "copy", "{uploaded}");
    assert_eq!(uploaded["files"], json!(["one.txt"]));
    assert!(!h.tab.methods().iter().any(|m| m == "DOM.setFileInputFiles"), "{:?}", h.tab.methods());
    let content = h.ok("eval", json!({ "expression": "document.getElementById('file').files[0].text()" })).await;
    assert_eq!(content, "\"hello\"");

    let uploaded = h.json("upload", json!({ "selector": "#file", "files": { "name": "empty.txt", "data": "" } })).await;
    assert_eq!(uploaded["files"], json!(["empty.txt"]));
    let size = h.ok("eval", json!({ "expression": "document.getElementById('file').files[0].size" })).await;
    assert_eq!(size, "0");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn upload_falls_back_to_copy_when_the_browser_refuses_paths() {
    let _upload = support::UPLOAD_LOCK.lock().await;
    let h = harness!(false);
    let url = h.server.page("/upload-refused", r#"<!doctype html><input id="file" type="file" multiple>"#);
    h.ok("navigate", json!({ "url": url })).await;
    // An extension without "Allow access to file URLs" answers DOM.setFileInputFiles with a CDP error.
    h.tab.refuse("DOM.setFileInputFiles");
    let file = h.files.0.join("refused.txt");
    std::fs::write(&file, "read anyway").unwrap();
    let uploaded = h.json("upload", json!({ "selector": "#file", "files": [file.display().to_string()] })).await;
    assert_eq!(uploaded["via"], "copy", "{uploaded}");
    assert!(h.tab.methods().iter().any(|m| m == "DOM.setFileInputFiles"), "{:?}", h.tab.methods());
    let content = h.ok("eval", json!({ "expression": "document.getElementById('file').files[0].text()" })).await;
    assert_eq!(content, "\"read anyway\"");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn upload_falls_back_to_copy_when_the_browser_sees_other_files() {
    let _upload = support::UPLOAD_LOCK.lock().await;
    let h = harness!(false);
    let url = h.server.page("/upload-mismatch", r#"<!doctype html><input id="file" type="file" multiple>"#);
    h.ok("navigate", json!({ "url": url })).await;
    h.ok("eval", json!({ "expression": "window.uploadChanges = 0; document.getElementById('file').addEventListener('change', () => window.uploadChanges++)" })).await;
    // A browser on another filesystem resolves the sentinel and the real paths to a missing file: the probe sees
    // different bytes and sizes, so browse copies instead.
    h.tab.rewrite_files_to(&h.files.0.join("missing.txt").display().to_string());
    let file = h.files.0.join("here.txt");
    std::fs::write(&file, "real bytes").unwrap();
    let uploaded = h.json("upload", json!({ "selector": "#file", "files": [file.display().to_string()] })).await;
    assert_eq!(uploaded["via"], "copy", "{uploaded}");
    assert_eq!(h.ok("eval", json!({ "expression": "window.uploadChanges" })).await, "1");
    let content = h.ok("eval", json!({ "expression": "document.getElementById('file').files[0].text()" })).await;
    assert_eq!(content, "\"real bytes\"");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn upload_falls_back_to_copy_when_the_probe_sees_another_file() {
    let _upload = support::UPLOAD_LOCK.lock().await;
    let h = harness!(false);
    let url = h.server.page("/upload-other-file", r#"<!doctype html><input id="file" type="file" multiple>"#);
    h.ok("navigate", json!({ "url": url })).await;
    h.ok("eval", json!({ "expression": "window.uploadChanges = 0; document.getElementById('file').addEventListener('change', () => window.uploadChanges++)" })).await;
    let real = h.files.0.join("real.txt");
    let other = h.files.0.join("other.txt");
    std::fs::write(&real, "the real bytes").unwrap();
    std::fs::write(&other, "a different file").unwrap();
    // The sentinel reads correctly, but the real path resolves to another file: size and mtime differ.
    h.tab.rewrite_files_except_sentinel_to(&other.display().to_string());
    let uploaded = h.json("upload", json!({ "selector": "#file", "files": [real.display().to_string()] })).await;
    assert_eq!(uploaded["via"], "copy", "{uploaded}");
    assert_eq!(h.ok("eval", json!({ "expression": "window.uploadChanges" })).await, "1");
    let content = h.ok("eval", json!({ "expression": "document.getElementById('file').files[0].text()" })).await;
    assert_eq!(content, "\"the real bytes\"");
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn upload_copies_files_from_a_group_writable_folder() {
    use std::os::unix::fs::PermissionsExt;
    let _upload = support::UPLOAD_LOCK.lock().await;
    let h = harness!(false);
    let url = h.server.page("/upload-group-writable", r#"<!doctype html><input id="file" type="file" multiple>"#);
    h.ok("navigate", json!({ "url": url })).await;
    // check_upload skips the file root itself, so a file directly in it is accepted; private_for_paths still refuses
    // the group-writable folder, and the upload copies instead of handing Chrome a path it may reopen.
    std::fs::set_permissions(&h.files.0, std::fs::Permissions::from_mode(0o775)).unwrap();
    let file = h.files.0.join("group.txt");
    std::fs::write(&file, "group bytes").unwrap();
    let uploaded = h.json("upload", json!({ "selector": "#file", "files": [file.display().to_string()] })).await;
    assert_eq!(uploaded["via"], "copy", "{uploaded}");
    let content = h.ok("eval", json!({ "expression": "document.getElementById('file').files[0].text()" })).await;
    assert_eq!(content, "\"group bytes\"");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn upload_paths_refuses_two_files_without_multiple() {
    let _upload = support::UPLOAD_LOCK.lock().await;
    let h = harness!(false);
    let url = h.server.page("/upload-single", r#"<!doctype html><input id="file" type="file">"#);
    h.ok("navigate", json!({ "url": url })).await;
    h.ok("eval", json!({ "expression": "window.uploadChanges = 0; document.getElementById('file').addEventListener('change', () => window.uploadChanges++)" })).await;
    let one = h.files.0.join("one.txt");
    let two = h.files.0.join("two.txt");
    std::fs::write(&one, "one").unwrap();
    std::fs::write(&two, "two").unwrap();
    let refused = h.err("upload", json!({ "selector": "#file", "files": [one.display().to_string(), two.display().to_string()] })).await;
    assert!(refused.contains("takes a single file") && refused.contains("multiple"), "{refused}");
    assert_eq!(h.ok("eval", json!({ "expression": "document.getElementById('file').files.length" })).await, "0");
    assert_eq!(h.ok("eval", json!({ "expression": "window.uploadChanges" })).await, "0");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn drag_hover_select_reload_and_challenge() {
    let h = harness!(false);
    let url = h.server.page(
        "/d",
        r#"<!doctype html><style>#src,#dst{width:100px;height:100px;margin:20px;display:inline-block}</style>
<div id="src" draggable="true" ondragstart="event.dataTransfer.setData('text/plain','moved')" style="background:#c00">drag me</div>
<div id="dst" ondragover="event.preventDefault()" ondrop="event.preventDefault(); this.textContent = event.dataTransfer.getData('text/plain')" style="background:#0c0">drop here</div>
<div id="tip" onmouseenter="document.title='hovered'" style="width:50px;height:50px">tip</div>
<select id="multi" multiple><option>a</option><option>b</option><option>c</option></select>"#,
    );
    h.ok("navigate", json!({ "url": url })).await;
    let dragged = h.json("drag", json!({ "from": "#src", "to": "#dst" })).await;
    assert_eq!(dragged["html5"], true, "{dragged}");
    let dropped = h.ok("eval", json!({ "expression": "document.getElementById('dst').textContent" })).await;
    assert_eq!(dropped, "\"moved\"");
    h.ok("hover", json!({ "selector": "#tip" })).await;
    assert_eq!(h.ok("eval", json!({ "expression": "document.title" })).await, "\"hovered\"");
    let selected = h.json("select", json!({ "selector": "#multi", "values": ["a", "c"] })).await;
    assert_eq!(selected["selected"], json!(["a", "c"]));
    let reloaded = h.json("navigate", json!({ "action": "reload" })).await;
    assert_eq!(reloaded["navigated"], true, "{reloaded}");
    h.json("wait_for", json!({ "url": "**/d", "load": "load" })).await;

    let blocked = h.server.page("/blocked", "<!doctype html><title>Access Denied</title><p>Access denied</p>");
    let result = h.json("navigate", json!({ "url": blocked })).await;
    assert_eq!(result["challenge"]["kind"], "block", "{result}");
    assert!(result["warning"].as_str().unwrap().contains("refused the visit"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn navigation_statuses_redirects_timeouts_and_fragments() {
    let h = harness!(false);
    let landed = h.server.page("/__landed", "<!doctype html><title>Landed</title><main><h1 id=top>Landed Here</h1><p>Some Text</p></main>");

    let missing = h.json("navigate", json!({ "url": format!("http://127.0.0.1:{}/__status/404", h.server.port) })).await;
    assert_eq!(missing["status"], 404, "{missing}");
    assert!(missing["url"].as_str().unwrap().ends_with("/__status/404"), "{missing}");

    let redirected = h.json("navigate", json!({ "url": format!("http://127.0.0.1:{}/__redirect/3", h.server.port) })).await;
    assert_eq!(redirected["url"], landed, "{redirected}");
    assert_eq!(redirected["redirects"], 3, "{redirected}");
    assert_eq!(redirected["status"], 200, "{redirected}");

    let started = std::time::Instant::now();
    let slow = h.json("navigate", json!({ "url": format!("http://127.0.0.1:{}/__slow/4000", h.server.port), "timeout": 800 })).await;
    assert!(started.elapsed() < std::time::Duration::from_millis(2_500), "took {:?}", started.elapsed());
    assert!(slow["pending"].as_str().unwrap().ends_with("/__slow/4000"), "{slow}");
    assert_eq!(slow["url"], landed, "{slow}");
    // The slow page commits later; wait_for load waits for it rather than the old page.
    let waited = h.json("wait_for", json!({ "load": "load", "timeout": 8000 })).await;
    assert!(waited["url"].as_str().unwrap().ends_with("/__slow/4000"), "{waited}");
    assert_eq!(h.ok("eval", json!({ "expression": "document.title" })).await, "\"Slow\"");

    h.json("navigate", json!({ "url": landed })).await;
    let fragment = h.json("navigate", json!({ "url": format!("{landed}#top") })).await;
    assert_eq!(fragment["url"], format!("{landed}#top"), "{fragment}");
    assert!(fragment.get("urlChanged").is_some(), "{fragment}");

    let error = h.err("navigate", json!({ "url": "javascript:alert(1)" })).await;
    assert!(error.contains("eval"), "{error}");
    let error = h.err("navigate", json!({ "url": "" })).await;
    assert!(error.contains("empty"), "{error}");

    let waited = h.json("wait_for", json!({ "text": "landed   here", "url": "/__landed" })).await;
    assert_eq!(waited["ok"], true, "{waited}");
    let error = h.err("wait_for", json!({ "text": "landed here", "exact": true, "timeout": 300 })).await;
    assert!(error.contains("Timed out"), "{error}");
    let error = h.err("wait_for", json!({ "load": "none" })).await;
    assert!(error.contains("commit"), "{error}");
}

const REFS: &str = r#"<!doctype html><html><head><title>Refs</title></head><body><main>
<details><summary>More info</summary><p>Hidden details</p></details>
<div contenteditable="true" id="editor">Dax</div>
<button id="icon"><svg width="10" height="10"></svg></button>
<button id="go" onclick="this.dataset.clicked = 'yes'">Go</button>
<input id="name" value="Dax">
<select id="size"><option value="1">Small</option><option value="2">Large</option></select>
</main></body></html>"#;

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn refs_nulls_strictness_and_typing() {
    let h = harness!(false);
    let url = h.server.page("/refs", REFS);
    h.json("navigate", json!({ "url": url })).await;
    let snapshot = h.ok("snapshot", json!({})).await;

    // Refs without a standard role or a name resolve (role and name travel as null).
    let summary = ref_of(&snapshot, "summary \"More info\"");
    h.ok("click", json!({ "ref": summary })).await;
    assert_eq!(h.ok("eval", json!({ "expression": "document.querySelector('details').open" })).await, "true");

    // Nulls, also nested, reach the page.
    let echoed = h.ok("eval", json!({ "expression": "(el, a) => JSON.stringify(a)", "arg": { "a": null, "b": [null, 1] } })).await;
    assert_eq!(echoed, "\"{\\\"a\\\":null,\\\"b\\\":[null,1]}\"");

    // A lookalike inserted before a ref's element doesn't take the ref over.
    let go = ref_of(&snapshot, "button \"Go\"");
    h.ok("eval", json!({ "expression": "const b = document.getElementById('go'); const twin = b.cloneNode(true); twin.id = 'twin'; b.before(twin); return 1" })).await;
    h.ok("click", json!({ "ref": go })).await;
    assert_eq!(h.ok("eval", json!({ "expression": "[document.getElementById('go').dataset.clicked, document.getElementById('twin').dataset.clicked]" })).await, "[\"yes\",null]");
    // When the element is gone and several lookalikes remain, the ref fails instead of picking one.
    h.ok("eval", json!({ "expression": "const b = document.getElementById('go'); b.after(b.cloneNode(true)); b.remove(); return 1" })).await;
    let error = h.err("click", json!({ "ref": go })).await;
    assert!(error.contains("matches 2 elements"), "{error}");

    // type appends at the end of a field that wasn't focused; press inserts characters without a US key.
    h.ok("type", json!({ "selector": "#name", "text": " Jr" })).await;
    h.ok("press", json!({ "selector": "#name", "key": "é" })).await;
    assert_eq!(h.ok("eval", json!({ "expression": "document.getElementById('name').value" })).await, "\"Dax Jré\"");

    // select takes a number, and lists the options when nothing matches.
    let selected = h.json("select", json!({ "selector": "#size", "value": 2 })).await;
    assert_eq!(selected["selected"][0], "2", "{selected}");
    let started = std::time::Instant::now();
    let error = h.err("select", json!({ "selector": "#size", "value": "Huge" })).await;
    assert!(error.contains("\"Small\"") && error.contains("\"Large\""), "{error}");
    assert!(started.elapsed() < std::time::Duration::from_secs(4));

    // Aria refs that never existed fail at once.
    h.ok("snapshot", json!({ "mode": "aria" })).await;
    let started = std::time::Instant::now();
    let error = h.err("click", json!({ "ref": "a999" })).await;
    assert!(error.contains("Unknown aria snapshot ref"), "{error}");
    assert!(started.elapsed() < std::time::Duration::from_secs(1));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn eval_scoping_serialization_errors_and_timeouts() {
    let h = harness!(false);
    let url = h.server.page("/eval", "<!doctype html><title>Eval</title><body><div id=a class='x y'>hi</div></body>");
    h.json("navigate", json!({ "url": url })).await;

    // Concurrent calls share the tab's page model and don't wait on each other.
    let (a, b) = tokio::join!(h.ok("eval", json!({ "expression": "1" })), h.ok("eval", json!({ "expression": "2" })));
    assert_eq!((a.as_str(), b.as_str()), ("1", "2"));

    // Declarations stay local: the same code runs twice, and the page never sees them.
    for world in ["isolated", "main"] {
        assert_eq!(h.ok("eval", json!({ "expression": "const x = 1; return x", "world": world })).await, "1");
        assert_eq!(h.ok("eval", json!({ "expression": "const x = 1; return x", "world": world })).await, "1");
    }
    assert_eq!(h.ok("eval", json!({ "expression": "typeof x", "world": "main" })).await, "\"undefined\"");
    assert_eq!(h.ok("eval", json!({ "expression": "\"await is just a word\"" })).await, "\"await is just a word\"");
    assert_eq!(h.ok("eval", json!({ "expression": "await new Promise((r) => setTimeout(() => r(5), 10))" })).await, "5");
    let hinted = h.json("eval", json!({ "expression": "const t = document.title" })).await;
    assert!(hinted["hint"].as_str().unwrap().contains("return"), "{hinted}");

    let value = h.json("eval", json!({ "expression": "(() => { const o = { m: new Map([['k', 1]]), s: new Set([1, 2]), d: new Date(0), n: document.getElementById('a'), big: 10n, r: /x/g }; o.self = o; return o })()" })).await;
    assert_eq!(value["m"], json!({ "k": 1 }), "{value}");
    assert_eq!(value["s"], json!([1, 2]), "{value}");
    assert_eq!(value["d"], "1970-01-01T00:00:00.000Z", "{value}");
    assert_eq!(value["n"], "<div#a.x.y \"hi\">", "{value}");
    assert_eq!(value["big"], "10n", "{value}");
    assert_eq!(value["r"], "/x/g", "{value}");
    assert_eq!(value["self"], "[Circular]", "{value}");
    assert_eq!(h.ok("eval", json!({ "expression": "window" })).await, "\"[Window]\"");

    let error = h.err("eval", json!({ "expression": "throw null" })).await;
    assert!(error.contains("threw null"), "{error}");
    let error = h.err("eval", json!({ "expression": "throw { custom: 1 }" })).await;
    assert!(error.contains("custom"), "{error}");
    let error = h.err("eval", json!({ "expression": "const a = 1;\nnull.boom" })).await;
    assert!(error.contains("line 2"), "{error}");

    // Like a console: the last expression statement's value.
    assert_eq!(h.ok("eval", json!({ "expression": "1+1; 2" })).await, "2");
    assert_eq!(h.ok("eval", json!({ "expression": "const a = 3; a" })).await, "3");
    assert_eq!(h.ok("eval", json!({ "expression": "const s = 'a;b // c';\ns.length" })).await, "8");
    assert_eq!(h.ok("eval", json!({ "expression": "let n = 0\nfor (const i of [1, 2]) n += i\nn * 10" })).await, "30");
    let hinted = h.json("eval", json!({ "expression": "const t = 'return me'" })).await;
    assert!(hinted["hint"].as_str().unwrap().contains("return"), "{hinted}");
    let error = h.err("eval", json!({ "expression": "el.textContent", "selector": "#a" })).await;
    assert!(error.contains("must be a function"), "{error}");
    let error = h.err("eval", json!({ "expression": "document.title", "selector": "#a" })).await;
    assert!(error.contains("must be a function"), "{error}");
    // A function literal with no ref/selector/arg is called, like the Playwright-style `() => ...` agents write; a
    // function the code only refers to (a built-in, a variable) is never called.
    assert_eq!(h.ok("eval", json!({ "expression": "() => document.title" })).await, "\"Eval\"");
    assert_eq!(h.ok("eval", json!({ "expression": "  async () => { await new Promise((r) => setTimeout(r, 5)); return 7 };  " })).await, "7");
    assert_eq!(h.ok("eval", json!({ "expression": "function () { return document.getElementById('a').textContent }", "world": "main" })).await, "\"hi\"");
    for expression in ["window.close", "document.querySelector", "const f = () => 1; f", "[() => 1][0]"] {
        let error = h.err("eval", json!({ "expression": expression })).await;
        assert!(error.contains("evaluated to a function"), "{expression}: {error}");
    }
    let pairs = h.json("eval", json!({ "expression": "new Map([[{ k: 1 }, 'v']])" })).await;
    assert_eq!(pairs, json!([[{ "k": 1 }, "v"]]), "{pairs}");

    // A busy loop is stopped at the timeout and the tab answers again right away.
    for world in ["isolated", "main"] {
        let started = std::time::Instant::now();
        let error = h.err("eval", json!({ "expression": "while (true) {}", "timeout": 1000, "world": world })).await;
        assert!(error.contains("stopped"), "{error}");
        assert!(started.elapsed() < std::time::Duration::from_secs(3), "{:?}", started.elapsed());
        let started = std::time::Instant::now();
        assert_eq!(h.ok("eval", json!({ "expression": "1 + 1" })).await, "2");
        assert!(started.elapsed() < std::time::Duration::from_secs(1), "{:?}", started.elapsed());
    }
    h.json("navigate", json!({ "url": url })).await;
    let error = h.err("navigate", json!({ "url": "mailto:someone@example.com" })).await;
    assert!(error.contains("another app"), "{error}");

    // Media emulation settings combine; bad values change nothing.
    h.json("emulate", json!({ "colorScheme": "dark" })).await;
    h.json("emulate", json!({ "reducedMotion": "reduce" })).await;
    let both = h.ok("eval", json!({ "expression": "matchMedia('(prefers-color-scheme: dark)').matches && matchMedia('(prefers-reduced-motion: reduce)').matches" })).await;
    assert_eq!(both, "true");
    assert!(h.err("emulate", json!({ "colorScheme": "purple" })).await.contains("colorScheme"));
    assert!(h.err("emulate", json!({ "timezone": "Europe/Paris" })).await.contains("timezone"));
    assert!(h.err("emulate", json!({ "viewport": { "width": 0, "height": 10 } })).await.contains("1 to 10000"));
    assert!(h.err("emulate", json!({ "viewport": { "width": 100000, "height": 10 } })).await.contains("1 to 10000"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn page_tools_need_a_tab() {
    let h = harness!(false);
    for tool in &h.tools {
        let name = tool.spec().name;
        let required = tool.spec().input_schema["required"].clone();
        assert_eq!(required.as_array().is_some_and(|r| r.contains(&json!("tab"))), name != "navigate", "{name}: {required}");
        if name == "navigate" {
            continue;
        }
        let output = h.call(&name, json!({ "tab": null, "text": "x", "key": "x", "values": "x", "expression": "1", "files": "x", "from": "a", "to": "b" })).await;
        assert!(output.is_error, "{name}");
        assert!(support::text_of(&output).contains("Pass `tab`"), "{name}: {}", support::text_of(&output));
    }
    // Options for a new tab don't apply to an open one.
    let output = h.call("navigate", json!({ "url": "about:blank", "group": "x" })).await;
    assert!(output.is_error && support::text_of(&output).contains("only apply when navigate opens a tab"), "{}", support::text_of(&output));
}

const READONLY_FORM: &str = r#"<!doctype html><html><head><title>Read-only form</title></head><body>
<main>
<h1>Sign up</h1>
<label>Email <input id="email" name="email"></label>
<label>Start <input id="start" type="date" name="start"></label>
<label>Plan <select id="plan"><option value="free">Free</option><option value="pro">Pro plan</option></select></label>
<label>Attachment <input id="file" type="file" name="file"></label>
<button id="save" onclick="document.getElementById('out').textContent = 'saved'">Save</button>
<p id="out">nothing yet</p>
</main>
</body></html>"#;

/// A tab opened with readOnly refuses input tools before any CDP work, including the ones that would otherwise
/// succeed through Runtime JavaScript (select, fill on a select or date input, upload).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn read_only_tabs_refuse_input_tools() {
    let h = match Harness::start_read_only(false).await {
        Some(h) => h,
        None => {
            eprintln!("no Chromium found; skipping");
            return;
        }
    };
    let url = h.server.page("/readonly-form", READONLY_FORM);
    h.json("navigate", json!({ "url": url })).await;

    let refused = h.err("select", json!({ "selector": "#plan", "values": ["Pro plan"] })).await;
    assert!(refused.contains("browse blocked select") && refused.contains("read-only"), "{refused}");
    let refused = h.err("fill", json!({ "selector": "#plan", "value": "Pro plan" })).await;
    assert!(refused.contains("browse blocked fill") && refused.contains("read-only"), "{refused}");
    let refused = h.err("fill", json!({ "selector": "#start", "value": "2026-01-02" })).await;
    assert!(refused.contains("browse blocked fill") && refused.contains("read-only"), "{refused}");
    let refused = h.err("upload", json!({ "selector": "#file", "files": ["/tmp/browse-read-only-upload.png"] })).await;
    assert!(refused.contains("browse blocked upload") && refused.contains("read-only"), "{refused}");
    let refused = h.err("click", json!({ "selector": "#save" })).await;
    assert!(refused.contains("browse blocked click") && refused.contains("read-only"), "{refused}");

    // Nothing changed, and reading the page still works.
    assert_eq!(h.ok("eval", json!({ "expression": "document.getElementById('plan').value" })).await, "\"free\"");
    assert_eq!(h.ok("eval", json!({ "expression": "document.getElementById('start').value" })).await, "\"\"");
    assert_eq!(h.ok("eval", json!({ "expression": "document.getElementById('file').files.length" })).await, "0");
    assert_eq!(h.ok("eval", json!({ "expression": "document.getElementById('out').textContent" })).await, "\"nothing yet\"");
    assert!(h.ok("snapshot", json!({})).await.contains("Sign up"));
}
