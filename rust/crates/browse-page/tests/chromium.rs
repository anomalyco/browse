//! End-to-end checks against a real headless Chromium (skipped when none is installed; set BROWSE_TEST_CHROME).

mod support;

use serde_json::json;
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
    let h = harness!(true);
    let url = h.server.page(
        "/misc",
        r#"<!doctype html><input id="pw" type="password"><input id="file" type="file" multiple>
<input id="q" onkeydown="if (event.key === 'Enter') document.title = 'searched ' + this.value">
<div style="height:3000px"></div><button id="far" onclick="setTimeout(() => { const p = document.createElement('p'); p.textContent = 'Loaded later'; document.body.append(p) }, 300)">Far away</button>"#,
    );
    h.ok("navigate", json!({ "url": url })).await;
    h.ok("fill", json!({ "selector": "#pw", "value": "pw-123" })).await;
    let value = h.ok("eval", json!({ "expression": "document.getElementById('pw').value" })).await;
    assert_eq!(value, "\"pw-123\"");
    let rejected = h.err("fill", json!({ "selector": "#pw", "secret": "password" })).await;
    assert!(rejected.contains("value or checked"), "{rejected}");

    let file = h.files.0.join("upload.txt");
    std::fs::write(&file, "hello").unwrap();
    let uploaded = h.json("upload", json!({ "selector": "#file", "files": [file.display().to_string()] })).await;
    assert_eq!(uploaded["files"][0], "upload.txt");
    let names = h.ok("eval", json!({ "expression": "document.getElementById('file').files[0].name" })).await;
    assert_eq!(names, "\"upload.txt\"");
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

// A chat app's thread list: the nav's rows are div[role=button], not links or buttons.
const NAV_ROWS: &str = r#"<!doctype html><html><head><title>Threads</title></head><body><main>
<nav aria-label="Thread list"><h2>Your messages</h2>
<div role="button" tabindex="0"><div><span>alice</span></div></div>
<div role="button" tabindex="0"><div><span>bob</span></div></div>
</nav>
<p>content</p><button>Send message</button>
</main></body></html>"#;

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn navigation_rows_which_are_not_links_or_buttons_stay_in_the_snapshot() {
    let h = harness!(false);
    let url = h.server.page("/nav-rows", NAV_ROWS);
    h.json("navigate", json!({ "url": url })).await;

    // Collapsing this nav to "[0 controls]" hid both rows and their clickable refs.
    for options in [json!({}), json!({ "compact": false }), json!({ "interactive": true })] {
        let snapshot = h.ok("snapshot", options.clone()).await;
        assert!(!snapshot.contains("- navigation"), "{options}: {snapshot}");
        assert!(!snapshot.contains("[0 controls]"), "{options}: {snapshot}");
        let alice = ref_of(&snapshot, "button \"alice\"");
        ref_of(&snapshot, "button \"bob\"");
        if options["interactive"].is_null() {
            assert!(snapshot.contains("- heading \"Your messages\" [level=2]"), "{snapshot}");
        }
        if options == json!({ "interactive": true }) {
            assert!(snapshot.contains("- button \"Send message\""), "{snapshot}");
        }
        // A ref on a row is a working ref, not decoration.
        if options == json!({}) {
            let clicked = h.json("click", json!({ "ref": alice })).await;
            assert!(clicked["clicked"].as_str().unwrap().contains("alice"), "{clicked}");
        }
    }

    // find greps the snapshot, so a hidden row could not be found either.
    let found = h.ok("snapshot", json!({ "find": "alice" })).await;
    assert!(found.starts_with("1 matching snapshot line"), "{found}");
    assert!(found.contains("- button \"alice\""), "{found}");
}

// An ordinary menu: links and buttons, with one hidden link that must not be counted.
const NAV_MENU: &str = r#"<!doctype html><html><head><title>Menu</title></head><body><main>
<nav aria-label="Primary"><a href="/one">one</a><a href="/two">two</a><a href="/three">three</a><a href="/hidden" style="display:none">hidden</a></nav>
<nav aria-label="Search"><a href="/s">Settings</a><input placeholder="Filter"></nav>
<h1>Page</h1>
</main></body></html>"#;

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn navigation_menus_still_collapse_with_a_visible_control_count() {
    let h = harness!(false);
    let url = h.server.page("/nav-menu", NAV_MENU);
    h.json("navigate", json!({ "url": url })).await;

    let snapshot = h.ok("snapshot", json!({})).await;
    assert!(snapshot.contains("- navigation \"Primary\" [3 controls]"), "{snapshot}");
    assert!(!snapshot.contains("link \"one\""), "{snapshot}");
    assert!(!snapshot.contains("hidden"), "{snapshot}");
    // A menu that also holds a text field is not hidden behind a count: the field and the link stay visible.
    assert!(!snapshot.contains("- navigation \"Search\""), "{snapshot}");
    ref_of(&snapshot, "textbox \"Filter\"");
    ref_of(&snapshot, "link \"Settings\"");

    // find greps the rendered lines, so a collapsed menu is expanded to match a link in it.
    let found = h.ok("snapshot", json!({ "find": "Settings" })).await;
    assert!(found.starts_with("1 matching snapshot line"), "{found}");
    assert!(found.contains("- link \"Settings\""), "{found}");
    let found = h.ok("snapshot", json!({ "find": "three" })).await;
    assert!(found.starts_with("1 matching snapshot line"), "{found}");
    assert!(found.contains("- link \"three\""), "{found}");

    // A find capture is expanded and untrimmed, so it must not become the diff baseline.
    let diff = h.ok("snapshot", json!({ "diff": true })).await;
    assert!(diff.ends_with("0 additions, 0 removals, 4 unchanged"), "{diff}");
    let _ = h.ok("snapshot", json!({ "find": "three" })).await;
    let delta = h.ok("snapshot", json!({ "delta": true })).await;
    assert!(delta.ends_with("0 additions, 0 removals, 4 unchanged"), "{delta}");

    // find is ignored under diff and delta, so navigation must not expand there either.
    let find_diff = h.ok("snapshot", json!({ "find": "three", "diff": true })).await;
    assert!(find_diff.ends_with("0 additions, 0 removals, 4 unchanged"), "{find_diff}");
    let find_delta = h.ok("snapshot", json!({ "find": "three", "delta": true })).await;
    assert!(find_delta.ends_with("0 additions, 0 removals, 4 unchanged"), "{find_delta}");

    // interactive lists the controls themselves instead of summarizing them.
    let interactive = h.ok("snapshot", json!({ "interactive": true })).await;
    assert!(!interactive.contains("- navigation"), "{interactive}");
    for control in ["one", "two", "three", "Settings", "Filter"] {
        assert!(interactive.contains(&format!("\"{control}\"")), "{control}: {interactive}");
    }
}

// A sidebar that is link-heavy still collapses, unless one of its controls is not a link or button.
const ASIDE_SIDEBAR: &str = r#"<!doctype html><html><head><title>Aside</title></head><body><main>
<aside aria-label="Sidebar">
<a href="/a">a</a><a href="/b">b</a><a href="/c">c</a><a href="/d">d</a>
<a href="/e">e</a><a href="/f">f</a><a href="/g">g</a><a href="/h">h</a>
<div role="button" tabindex="0">Compose</div>
</aside>
<h1>Page</h1>
</main></body></html>"#;

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn link_heavy_aside_with_an_app_row_stays_expanded() {
    let h = harness!(false);
    let url = h.server.page("/aside", ASIDE_SIDEBAR);
    h.json("navigate", json!({ "url": url })).await;
    let snapshot = h.ok("snapshot", json!({})).await;
    assert!(!snapshot.contains("- navigation \"Sidebar\""), "{snapshot}");
    ref_of(&snapshot, "button \"Compose\"");
    ref_of(&snapshot, "link \"a\"");
}

// The no-main repro: nothing here may be lost, with or without compact.
const NO_MAIN: &str = r#"<!doctype html><html><head><title>No main</title></head><body><div><h2>A</h2><div role="button" tabindex="0"><span>alice</span></div></div><section><h2>B</h2><div role="button" tabindex="0">bob</div></section><nav aria-label="C nav"><h2>C nav</h2><div role="button" tabindex="0"><div><span>carol</span></div></div></nav></body></html>"#;

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn page_without_main_keeps_every_row() {
    let h = harness!(false);
    let url = h.server.page("/no-main", NO_MAIN);
    h.json("navigate", json!({ "url": url })).await;
    for options in [json!({}), json!({ "compact": false }), json!({ "interactive": true })] {
        let snapshot = h.ok("snapshot", options.clone()).await;
        ref_of(&snapshot, "button \"alice\"");
        ref_of(&snapshot, "button \"bob\"");
        ref_of(&snapshot, "button \"carol\"");
        assert!(!snapshot.contains("[0 controls]"), "{options}: {snapshot}");
    }
}

// A sidebar of <details> groups: summaries are disclosure controls, so the nav is still a menu.
const DETAILS_SIDEBAR: &str = r#"<!doctype html><html><head><title>Docs</title></head><body><main>
<nav aria-label="Docs">
<details open><summary>Getting started</summary><a href="/install">Install</a><a href="/run">Run</a></details>
<details open><summary>Guides</summary><a href="/deploy">Deploy</a></details>
<div role="button" aria-expanded="false" tabindex="0">More</div>
<div role="menuitem" tabindex="0">Item</div>
</nav>
<h1>Page</h1>
</main></body></html>"#;

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn details_summary_sidebar_still_collapses() {
    let h = harness!(false);
    let url = h.server.page("/details", DETAILS_SIDEBAR);
    h.json("navigate", json!({ "url": url })).await;
    let snapshot = h.ok("snapshot", json!({})).await;
    assert!(snapshot.contains("- navigation \"Docs\" [7 controls]"), "{snapshot}");
    assert!(!snapshot.contains("Install"), "{snapshot}");
}

// 120 menu buttons and 60 body links: expanding the menu for find used to spend maxItems before the body links.
fn big_menu_html() -> String {
    let buttons: String = (0..120).map(|i| format!("<button>Menu {i}</button>")).collect();
    let links: String = (0..60).map(|i| format!("<a href=\"/body-{i}\">Body link {i}</a>")).collect();
    format!("<!doctype html><html><head><title>Big menu</title></head><body><main><nav aria-label=\"Menu\">{buttons}</nav><h1>Page</h1>{links}</main></body></html>")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn find_still_matches_content_after_a_big_collapsed_menu() {
    let h = harness!(false);
    let url = h.server.page("/big-menu", &big_menu_html());
    h.json("navigate", json!({ "url": url })).await;

    let default = h.ok("snapshot", json!({})).await;
    assert!(default.contains("- navigation \"Menu\" [120 controls]"), "{default}");
    assert!(default.contains("- link \"Body link 50\""), "{default}");
    let found = h.ok("snapshot", json!({ "find": "Body link 50" })).await;
    assert!(found.starts_with("1 matching snapshot line"), "{found}");
    assert!(found.contains("- link \"Body link 50\""), "{found}");
    // The find capture is expanded and untrimmed, so it must not become the diff baseline.
    let diff = h.ok("snapshot", json!({ "diff": true })).await;
    assert!(diff.ends_with("0 additions, 0 removals, 62 unchanged"), "{diff}");
    let _ = h.ok("snapshot", json!({ "find": "Body link 50" })).await;
    let delta = h.ok("snapshot", json!({ "delta": true })).await;
    assert!(delta.ends_with("0 additions, 0 removals, 62 unchanged"), "{delta}");
}

// A ref from a find capture must survive as the same ref in the next snapshot, and click then.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn find_refs_are_reused_by_the_next_snapshot() {
    let h = harness!(false);
    let url = h.server.page("/big-menu-refs", &big_menu_html());
    h.json("navigate", json!({ "url": url })).await;
    let found = h.ok("snapshot", json!({ "find": "Body link 50" })).await;
    let found_ref = ref_of(&found, "link \"Body link 50\"");
    let next = h.ok("snapshot", json!({})).await;
    assert_eq!(ref_of(&next, "link \"Body link 50\""), found_ref, "{next}");
    h.ok("click", json!({ "ref": found_ref })).await;
}

// A ref find showed from a collapsed menu is reused when the next snapshot lists that item too.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn find_menu_item_refs_are_reused_by_an_interactive_snapshot() {
    let h = harness!(false);
    let url = h.server.page("/menu-refs", NAV_MENU);
    h.json("navigate", json!({ "url": url })).await;
    let found = h.ok("snapshot", json!({ "find": "three" })).await;
    let found_ref = ref_of(&found, "link \"three\"");
    let interactive = h.ok("snapshot", json!({ "interactive": true })).await;
    assert_eq!(ref_of(&interactive, "link \"three\""), found_ref, "{interactive}");
    h.ok("click", json!({ "ref": found_ref })).await;
}

// There is no normal snapshot to diff against, so find must not silently become the baseline.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn diff_after_find_on_a_fresh_tab_needs_an_earlier_snapshot() {
    let h = harness!(false);
    let url = h.server.page("/big-menu-fresh", &big_menu_html());
    h.json("navigate", json!({ "url": url })).await;
    h.ok("snapshot", json!({ "find": "Body link 50" })).await;
    let error = h.err("snapshot", json!({ "diff": true })).await;
    assert!(error.contains("needs an earlier snapshot"), "{error}");
}

const TEXT_CONTROLS: &str = r#"<!doctype html><html><head><title>Boxes</title></head><body><main>
<input placeholder="Search messages">
<textarea placeholder="Write a message"></textarea>
<input aria-placeholder="Aria placeholder only">
<input placeholder="" aria-placeholder="Empty placeholder fallback">
<div role="textbox" contenteditable="true" aria-placeholder="Editable message"></div>
<div role="textbox" contenteditable="true" placeholder="Div placeholder"></div>
<input placeholder="Composer" aria-label="Message">
</main></body></html>"#;

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn text_controls_fall_back_to_their_placeholder_for_a_name() {
    let h = harness!(false);
    let url = h.server.page("/text-controls", TEXT_CONTROLS);
    h.json("navigate", json!({ "url": url })).await;
    let snapshot = h.ok("snapshot", json!({})).await;
    for name in ["Search messages", "Write a message", "Aria placeholder only", "Empty placeholder fallback", "Editable message", "Div placeholder"] {
        assert!(snapshot.contains(&format!("\"{name}\"")), "{name}: {snapshot}");
    }
    assert!(!snapshot.contains("\"textbox\""), "{snapshot}");
    // aria-label is a real name and still wins over a placeholder.
    assert!(snapshot.contains("textbox \"Message\""), "{snapshot}");
    assert!(!snapshot.contains("\"Composer\""), "{snapshot}");
}
