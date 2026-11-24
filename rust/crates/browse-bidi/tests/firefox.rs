//! End-to-end checks of the WebDriver BiDi driver against a real headless Firefox, through browse's page and capture
//! tools. Skipped when no Firefox is found; set BROWSE_TEST_FIREFOX to choose one.

mod support;

use std::time::{Duration, Instant};

use browse_core::{BrowserDriver, BrowserEvent, DriverError, PageEvent, TabOptions};
use serde_json::json;
use support::{Harness, ref_of};

macro_rules! harness {
    () => {
        harness!(Harness::start())
    };
    ($start:expr) => {
        match $start.await {
            Some(h) => h,
            None => {
                eprintln!("no Firefox found; skipping");
                return;
            }
        }
    };
}

const FORM: &str = r#"<!doctype html><html><head><title>Form</title></head><body>
<main>
<h1>Sign up</h1>
<label>Email <input id="email" name="email"></label>
<label>Password <input id="pw" type="password"></label>
<label><input type="checkbox" id="terms"> I agree</label>
<select id="plan"><option value="free">Free</option><option value="pro">Pro plan</option></select>
<button id="save" onclick="document.getElementById('out').textContent = 'saved ' + document.getElementById('email').value">Save</button>
<button id="twice" ondblclick="this.textContent = 'double clicked'">Twice</button>
<p id="out">nothing yet</p>
<a href="/next">Next page</a>
</main>
</body></html>"#;

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn snapshot_click_fill_and_refs() {
    let h = harness!();
    let url = h.server.page("/form", FORM);
    h.server.page("/next", "<!doctype html><title>Next</title><h1>Second page</h1>");
    let nav = h.json("navigate", json!({ "url": url })).await;
    assert_eq!(nav["title"], "Form", "{nav}");

    let snapshot = h.ok("snapshot", json!({})).await;
    assert!(snapshot.contains("- heading \"Sign up\" [level=1]"), "{snapshot}");
    let email = ref_of(&snapshot, "textbox \"Email\"");
    let save = ref_of(&snapshot, "button \"Save\"");

    let filled = h
        .json("fill", json!({ "fields": [ { "ref": email, "value": "a@b.co" }, { "selector": "#terms", "checked": true }, { "selector": "#plan", "value": "Pro plan" } ] }))
        .await;
    assert_eq!(filled["filled"][1]["checked"], true, "{filled}");
    assert_eq!(filled["filled"][2]["selected"][0], "pro", "{filled}");

    let clicked = h.json("click", json!({ "ref": save })).await;
    assert!(clicked["clicked"].as_str().unwrap().contains("button \"Save\""), "{clicked}");
    assert_eq!(h.eval("document.getElementById('out').textContent").await, "saved a@b.co");

    h.ok("click", json!({ "selector": "#twice", "clickCount": 2 })).await;
    assert_eq!(h.eval("document.getElementById('twice').textContent").await, "double clicked");

    let again = h.ok("snapshot", json!({})).await;
    assert_eq!(ref_of(&again, "button \"Save\""), save);

    h.ok("click", json!({ "selector": "role=checkbox[name=\"I agree\"]" })).await;
    assert_eq!(h.eval("document.getElementById('terms').checked").await, false);
    let typed = h.json("type", json!({ "selector": "label=Password", "text": "Ab1!" })).await;
    assert_eq!(typed["typed"], 4);
    assert_eq!(h.ok("eval", json!({ "expression": "(el) => el.value", "selector": "#pw" })).await, "\"Ab1!\"");

    let next = ref_of(&again, "link \"Next page\"");
    let result = h.json("click", json!({ "ref": next })).await;
    assert_eq!(result["navigated"], true, "{result}");
    assert_eq!(result["title"], "Next");
    let stale = h.err("click", json!({ "ref": save })).await;
    assert!(stale.contains("stale"), "{stale}");
    h.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn navigation_statuses_redirects_fragments_and_history() {
    let h = harness!();
    let landed = h.server.page("/__landed", "<!doctype html><title>Landed</title><main><h1 id=top>Landed Here</h1><p>Some Text</p><div style='height:3000px'></div><p id=bottom>end</p></main>");

    let missing = h.json("navigate", json!({ "url": h.server.url("/__status/404") })).await;
    assert_eq!(missing["status"], 404, "{missing}");
    assert!(missing["url"].as_str().unwrap().ends_with("/__status/404"), "{missing}");

    let redirected = h.json("navigate", json!({ "url": h.server.url("/__redirect/3") })).await;
    assert_eq!(redirected["url"], landed, "{redirected}");
    assert_eq!(redirected["redirects"], 3, "{redirected}");
    assert_eq!(redirected["status"], 200, "{redirected}");

    // Same-document navigations answer at once, without a navigation id.
    let fragment = h.json("navigate", json!({ "url": format!("{landed}#bottom") })).await;
    assert_eq!(fragment["url"], format!("{landed}#bottom"), "{fragment}");
    assert!(fragment.get("urlChanged").is_some(), "{fragment}");
    h.eval("history.pushState({}, '', '/__landed?pushed'); 1").await;
    let waited = h.json("wait_for", json!({ "url": "**/__landed?pushed", "timeout": 2000 })).await;
    assert_eq!(waited["ok"], true, "{waited}");

    // A slow page: navigate gives up waiting, and wait_for load waits for the new document.
    let started = Instant::now();
    let slow = h.json("navigate", json!({ "url": h.server.url("/__slow/3000"), "timeout": 800 })).await;
    assert!(started.elapsed() < Duration::from_millis(2_500), "took {:?}", started.elapsed());
    assert!(slow["pending"].as_str().unwrap().ends_with("/__slow/3000"), "{slow}");
    let waited = h.json("wait_for", json!({ "load": "load", "timeout": 8000 })).await;
    assert!(waited["url"].as_str().unwrap().ends_with("/__slow/3000"), "{waited}");
    assert_eq!(h.eval("document.title").await, "Slow");

    // Back to the pushed entry and the fragment are same-document; to the landed page a cross-document restore
    // (from the back/forward cache, which Firefox doesn't report as a commit).
    let form = h.server.page("/form", FORM);
    h.json("navigate", json!({ "url": landed })).await;
    h.eval("window.restored = 'kept'; 1").await;
    h.json("navigate", json!({ "url": form })).await;
    let back = h.json("navigate", json!({ "action": "back" })).await;
    assert_eq!(back["url"], landed, "{back}");
    assert_eq!(h.eval("document.title").await, "Landed");
    assert_eq!(h.eval("location.pathname").await, "/__landed");
    let snapshot = h.ok("snapshot", json!({})).await;
    assert!(snapshot.contains("Landed Here"), "{snapshot}");
    let forward = h.json("navigate", json!({ "action": "forward" })).await;
    assert_eq!(forward["url"], form, "{forward}");
    assert_eq!(h.eval("document.title").await, "Form");
    let none = h.json("navigate", json!({ "action": "forward" })).await;
    assert!(none["note"].as_str().unwrap().contains("no page"), "{none}");

    // Reload, and reload bypassing the cache.
    let counter = h.server.url("/__count");
    h.json("navigate", json!({ "url": counter })).await;
    let before = h.server.hits("/__count");
    let reloaded = h.json("navigate", json!({ "action": "reload" })).await;
    assert_eq!(reloaded["navigated"], true, "{reloaded}");
    let reloaded = h.json("navigate", json!({ "action": "reload", "ignoreCache": true })).await;
    assert_eq!(reloaded["navigated"], true, "{reloaded}");
    assert!(h.server.hits("/__count") > before, "the uncached reload reached the server");
    assert_eq!(h.eval("document.title").await, "Count");

    // A download and a 204 don't replace the page.
    let error = h.err("navigate", json!({ "url": h.server.url("/__download") })).await;
    assert!(error.contains("aborted"), "{error}");
    let error = h.err("navigate", json!({ "url": h.server.url("/__status/204") })).await;
    assert!(error.contains("aborted"), "{error}");
    assert_eq!(h.eval("document.title").await, "Count");

    // A failed load shows the URL that failed, not Firefox's error page.
    let failed = h.call("navigate", json!({ "url": "http://127.0.0.1:1/" })).await;
    let text = support::text_of(&failed);
    assert!(failed.is_error, "{text}");
    let frames = h.tab.frames().await.unwrap();
    assert!(!frames[0].url.starts_with("about:neterror"), "{frames:?}");

    let error = h.err("navigate", json!({ "url": "javascript:alert(1)" })).await;
    assert!(error.contains("eval"), "{error}");
    h.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn iframes_same_and_cross_origin() {
    let h = harness!();
    h.server.page("/inner", r#"<!doctype html><button onclick="this.textContent='inner clicked'">Inner button</button><input id="field">"#);
    let cross = h.server.other_origin("/inner");
    let url = h.server.page(
        "/frames",
        &format!(
            r#"<!doctype html><h1>Outer</h1>
<iframe title="Same" srcdoc="<button onclick=&quot;this.textContent='same clicked'&quot;>Same button</button>" style="width:300px;height:100px"></iframe>
<iframe title="Cross" src="{cross}" style="width:300px;height:100px;margin-top:50px;border:5px solid black;padding:7px"></iframe>"#
        ),
    );
    h.json("navigate", json!({ "url": url, "waitUntil": "settle" })).await;
    let frames = h.tab.frames().await.unwrap();
    assert_eq!(frames.len(), 3, "{frames:?}");
    assert_eq!(frames[0].id.as_str(), h.target.as_str());

    let snapshot = h.ok("snapshot", json!({})).await;
    assert!(snapshot.contains("iframe \"Same\""), "{snapshot}");
    let same = ref_of(&snapshot, "button \"Same button\"");
    let cross_ref = ref_of(&snapshot, "button \"Inner button\"");
    h.ok("click", json!({ "ref": same })).await;
    // Firefox delivers input sent to the page no further than a cross-origin iframe: the driver routes it in.
    h.ok("click", json!({ "ref": cross_ref })).await;
    let after = h.ok("snapshot", json!({})).await;
    assert!(after.contains("same clicked") && after.contains("inner clicked"), "{after}");
    let via_selector = h
        .ok("eval", json!({ "expression": "document.querySelector('button').textContent", "frame": "iframe[title=Cross]" }))
        .await;
    assert_eq!(via_selector, "\"inner clicked\"");
    // Typing follows focus into the cross-origin frame.
    h.ok("type", json!({ "selector": "iframe[title=Cross] >> frame >> #field", "text": "Hi there" })).await;
    let typed = h.ok("eval", json!({ "expression": "document.getElementById('field').value", "frame": "iframe[title=Cross]" })).await;
    assert_eq!(typed, "\"Hi there\"");
    h.ok("click", json!({ "selector": "iframe[title=Cross] >> frame >> role=button" })).await;
    let aria = h.ok("snapshot", json!({ "mode": "aria" })).await;
    let aria_ref = ref_of(&aria, "button \"same clicked\"");
    assert!(aria_ref.starts_with('f'), "{aria}");
    h.ok("click", json!({ "ref": aria_ref })).await;

    // The driver's frame owner and content frame lookups agree.
    let child = frames.iter().find(|f| f.url.contains("localhost")).unwrap().id.clone();
    let owner = h.tab.frame_element(&child).await.unwrap();
    assert_eq!(owner.frame.as_str(), h.target.as_str());
    assert_eq!(h.tab.content_frame(&owner).await.unwrap(), Some(child.clone()));
    assert!(h.tab.frame_element(&frames[0].id).await.is_err());

    // Navigating away detaches the frames.
    h.server.page("/plain", "<!doctype html><title>Plain</title>");
    h.json("navigate", json!({ "url": h.server.url("/plain") })).await;
    assert_eq!(h.tab.frames().await.unwrap().len(), 1);
    h.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn eval_worlds_serialization_errors_and_navigation() {
    let h = harness!();
    let url = h.server.page(
        "/eval",
        "<!doctype html><title>Eval</title><body><div id=a class='x y'>hi</div><script>window.pageSecret = 42</script></body>",
    );
    h.json("navigate", json!({ "url": url })).await;
    assert_eq!(h.eval("typeof window.pageSecret").await, "undefined");
    assert_eq!(h.eval_main("window.pageSecret").await, 42);
    let with_el = h.ok("eval", json!({ "expression": "(el, arg) => el.textContent + arg", "selector": "#a", "arg": "!", "world": "main" })).await;
    assert_eq!(with_el, "\"hi!\"");
    let isolated_el = h.ok("eval", json!({ "expression": "(el) => el.className", "selector": "#a" })).await;
    assert_eq!(isolated_el, "\"x y\"");
    for world in ["isolated", "main"] {
        assert_eq!(h.ok("eval", json!({ "expression": "const x = 1; return x", "world": world })).await, "1");
        assert_eq!(h.ok("eval", json!({ "expression": "const x = 1; return x", "world": world })).await, "1");
    }
    assert_eq!(h.eval_main("typeof x").await, "undefined");
    assert_eq!(h.ok("eval", json!({ "expression": "await new Promise((r) => setTimeout(() => r(5), 10))" })).await, "5");
    assert_eq!(h.ok("eval", json!({ "expression": "1+1; 2" })).await, "2");
    let echoed = h.ok("eval", json!({ "expression": "(el, a) => JSON.stringify(a)", "arg": { "a": null, "b": [null, 1] } })).await;
    assert_eq!(echoed, "\"{\\\"a\\\":null,\\\"b\\\":[null,1]}\"");

    let value = h
        .json("eval", json!({ "expression": "(() => { const o = { m: new Map([['k', 1]]), s: new Set([1, 2]), d: new Date(0), n: document.getElementById('a'), big: 10n, r: /x/g }; o.self = o; return o })()" }))
        .await;
    assert_eq!(value["m"], json!({ "k": 1 }), "{value}");
    assert_eq!(value["s"], json!([1, 2]), "{value}");
    assert_eq!(value["d"], "1970-01-01T00:00:00.000Z", "{value}");
    assert_eq!(value["n"], "<div#a.x.y \"hi\">", "{value}");
    assert_eq!(value["big"], "10n", "{value}");
    assert_eq!(value["self"], "[Circular]", "{value}");

    let error = h.err("eval", json!({ "expression": "throw null" })).await;
    assert!(error.contains("threw null"), "{error}");
    let error = h.err("eval", json!({ "expression": "throw { custom: 1 }" })).await;
    assert!(error.contains("custom"), "{error}");
    let error = h.err("eval", json!({ "expression": "null.boom" })).await;
    assert!(error.contains("TypeError"), "{error}");
    let error = h.err("eval", json!({ "expression": "el.textContent", "selector": "#a" })).await;
    assert!(error.contains("must be a function"), "{error}");
    let error = h.err("eval", json!({ "expression": "window.close" })).await;
    assert!(error.contains("evaluated to a function"), "{error}");

    // An awaited eval whose page navigates away ends at once instead of waiting forever.
    h.server.page("/after", "<!doctype html><title>After</title>");
    let started = Instant::now();
    let error = h
        .err("eval", json!({ "expression": "setTimeout(() => location.href = '/after', 200); await new Promise(() => {})", "timeout": 20000 }))
        .await;
    assert!(started.elapsed() < Duration::from_secs(8), "took {:?}: {error}", started.elapsed());
    assert!(error.contains("navigated"), "{error}");
    h.json("wait_for", json!({ "load": "load", "timeout": 5000 })).await;
    assert_eq!(h.eval("document.title").await, "After");

    // Media emulation: the color scheme applies, reduced motion is refused without undoing it.
    let initial = h.eval("matchMedia('(prefers-color-scheme: light)').matches").await;
    h.json("emulate", json!({ "colorScheme": "light" })).await;
    assert_eq!(h.eval("matchMedia('(prefers-color-scheme: light)').matches").await, true);
    h.json("emulate", json!({ "colorScheme": "dark" })).await;
    assert_eq!(h.eval("matchMedia('(prefers-color-scheme: dark)').matches").await, true);
    let partial = h.call("emulate", json!({ "reducedMotion": "reduce" })).await;
    assert!(partial.is_error, "{}", support::text_of(&partial));
    assert_eq!(h.eval("matchMedia('(prefers-color-scheme: dark)').matches").await, true);
    h.json("emulate", json!({ "colorScheme": "reset" })).await;
    assert_eq!(h.eval("matchMedia('(prefers-color-scheme: light)').matches").await, initial);
    h.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn dialogs_pause_and_answer() {
    let h = harness!();
    h.server.page("/framed-alert", r#"<!doctype html><button onclick="alert('from the frame')">Frame alert</button>"#);
    let url = h.server.page(
        "/dialogs",
        &format!(
            r#"<!doctype html><title>Dialogs</title>
<button id="confirm" onclick="document.title = String(confirm('Sure?'))">Ask</button>
<button id="prompt" onclick="document.title = 'name=' + prompt('Name?', 'Dax')">Name</button>
<button id="alert" onclick="alert('Hello'); document.title = 'alerted'">Alert</button>
<iframe title="Framed" src="{}"></iframe>"#,
            h.server.other_origin("/framed-alert")
        ),
    );
    h.json("navigate", json!({ "url": url, "waitUntil": "settle" })).await;

    let clicked = h.json("click", json!({ "selector": "#confirm" })).await;
    assert_eq!(clicked["dialog"]["type"], "confirm", "{clicked}");
    assert!(clicked["clicked"].as_str().is_some_and(|label| label.contains("button \"Ask\"")), "{clicked}");
    let blocked = h.err("snapshot", json!({})).await;
    assert!(blocked.contains("dialog is open"), "{blocked}");
    let status = h.json("dialog", json!({})).await;
    assert_eq!(status["dialog"]["message"], "Sure?", "{status}");
    h.ok("dialog", json!({ "action": "accept" })).await;
    assert_eq!(h.eval("document.title").await, "true");

    let clicked = h.json("click", json!({ "selector": "#prompt" })).await;
    assert_eq!(clicked["dialog"]["type"], "prompt", "{clicked}");
    let status = h.json("dialog", json!({})).await;
    assert_eq!(status["dialog"]["defaultPrompt"], "Dax", "{status}");
    h.ok("dialog", json!({ "action": "accept", "promptText": "Zed" })).await;
    assert_eq!(h.eval("document.title").await, "name=Zed");

    // A dialog from a cross-origin iframe is answered in that frame's context.
    let clicked = h.json("click", json!({ "selector": "iframe[title=Framed] >> frame >> role=button" })).await;
    assert_eq!(clicked["dialog"]["message"], "from the frame", "{clicked}");
    h.ok("dialog", json!({ "action": "dismiss" })).await;
    assert!(h.ok("snapshot", json!({})).await.contains("Frame alert"));

    h.ok("dialog", json!({ "auto": "dismiss" })).await;
    h.ok("click", json!({ "selector": "#confirm" })).await;
    assert_eq!(h.eval("document.title").await, "false");
    h.ok("dialog", json!({ "auto": "accept" })).await;
    h.ok("click", json!({ "selector": "#alert" })).await;
    assert_eq!(h.eval("document.title").await, "alerted");
    let none = h.err("dialog", json!({ "action": "accept" })).await;
    assert!(none.to_lowercase().contains("no dialog"), "{none}");
    h.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn keys_scroll_waits_hover_select_and_drag() {
    let h = harness!(Harness::start_with(true, true));
    let url = h.server.page(
        "/misc",
        r#"<!doctype html><style>#src,#dst{width:100px;height:100px;margin:20px;display:inline-block}</style>
<input id="q" onkeydown="if (event.key === 'Enter') document.title = 'searched ' + this.value">
<div id="src" draggable="true" ondragstart="event.dataTransfer.setData('text/plain','moved')" style="background:#c00">drag me</div>
<div id="dst" ondragover="event.preventDefault()" ondrop="event.preventDefault(); this.textContent = event.dataTransfer.getData('text/plain')" style="background:#0c0">drop here</div>
<div id="pad" style="width:200px;height:60px;background:#00c"></div>
<div id="tip" onmouseenter="document.title='hovered'" style="width:50px;height:50px">tip</div>
<select id="multi" multiple><option>a</option><option>b</option><option>c</option></select>
<div style="height:3000px"></div><button id="far" onclick="setTimeout(() => { const p = document.createElement('p'); p.textContent = 'Loaded later'; document.body.append(p) }, 300)">Far away</button>
<script>
  const pad = document.getElementById('pad'); window.moves = 0;
  pad.addEventListener('mousedown', () => { window.dragging = true });
  document.addEventListener('mousemove', (e) => { if (e.buttons) window.moves++ });
  document.addEventListener('mouseup', () => { window.dragging = false; window.released = true });
</script>"#,
    );
    h.json("navigate", json!({ "url": url })).await;

    // Human-like typing, Enter, select-all and delete (Meta on macOS, Control elsewhere).
    h.ok("type", json!({ "selector": "#q", "text": "Rust lang?", "submit": true })).await;
    assert_eq!(h.eval("document.title").await, "searched Rust lang?");
    h.ok("press", json!({ "selector": "#q", "key": ["ControlOrMeta+a", "Backspace"] })).await;
    assert_eq!(h.eval("document.getElementById('q').value").await, "");
    h.ok("press", json!({ "selector": "#q", "key": "é" })).await;
    h.ok("press", json!({ "selector": "#q", "key": "Shift+a" })).await;
    assert_eq!(h.eval("document.getElementById('q').value").await, "éA");
    let refused = h.call("press", json!({ "selector": "#q", "key": "CapsLock" })).await;
    assert!(refused.is_error, "{}", support::text_of(&refused));

    // HTML5 drag and drop, then a plain pointer drag.
    let dragged = h.json("drag", json!({ "from": "#src", "to": "#dst" })).await;
    assert_eq!(dragged["html5"], true, "{dragged}");
    assert_eq!(h.eval("document.getElementById('dst').textContent").await, "moved");
    let plain = h.json("drag", json!({ "from": "#pad", "to": "#tip" })).await;
    assert!(plain.get("html5").is_none(), "{plain}");
    assert_eq!(h.eval_main("window.released === true && window.moves > 0").await, true);

    h.ok("hover", json!({ "selector": "#tip" })).await;
    assert_eq!(h.eval("document.title").await, "hovered");
    let selected = h.json("select", json!({ "selector": "#multi", "values": ["a", "c"] })).await;
    assert_eq!(selected["selected"], json!(["a", "c"]));

    // Wheel scrolling toward a far element, then explicit scrolls and waits.
    h.ok("click", json!({ "selector": "#far" })).await;
    let waited = h.json("wait_for", json!({ "text": "Loaded later", "timeout": 3000 })).await;
    assert_eq!(waited["ok"], true);
    let top = h.json("scroll", json!({ "to": "top" })).await;
    assert_eq!(top["scrollY"], 0.0, "{top}");
    let down = h.json("scroll", json!({ "deltaY": 500 })).await;
    assert!(down["scrollY"].as_f64().unwrap() > 100.0, "{down}");
    let timeout = h.err("wait_for", json!({ "selector": "#missing", "timeout": 300 })).await;
    assert!(timeout.contains("Timed out"), "{timeout}");
    h.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn uploads_by_path_and_by_copy() {
    let h = harness!();
    let url = h.server.page("/upload", r#"<!doctype html><input id="file" type="file" multiple><button id="b">Not a file input</button>"#);
    h.json("navigate", json!({ "url": url })).await;
    h.eval_main("window.uploadChanges = []; document.getElementById('file').addEventListener('change', (event) => window.uploadChanges.push(event.isTrusted)); 1").await;
    let file = h.files.0.join("upload.txt");
    std::fs::write(&file, "hello").unwrap();
    let uploaded = h.json("upload", json!({ "selector": "#file", "files": [file.display().to_string()] })).await;
    assert_eq!(uploaded["files"][0], "upload.txt");
    assert_eq!(uploaded["via"], "paths", "{uploaded}");
    assert_eq!(h.eval("document.getElementById('file').files[0].name").await, "upload.txt");
    assert_eq!(h.eval("document.getElementById('file').files[0].size").await, 5);
    assert_eq!(h.eval_main("window.uploadChanges").await, json!([true]));

    let inline = h
        .json("upload", json!({ "selector": "#file", "files": [{ "name": "notes.txt", "data": "aGVsbG8gaW5saW5l", "mimeType": "text/plain" }] }))
        .await;
    assert_eq!(inline["via"], "copy", "{inline}");
    assert_eq!(h.eval("document.getElementById('file').files[0].text()").await, "hello inline");
    let wrong = h.err("upload", json!({ "selector": "#b", "files": [file.display().to_string()] })).await;
    assert!(!wrong.is_empty());
    h.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn uploads_copy_when_the_browser_is_elsewhere() {
    let h = harness!(Harness::start_with(false, false));
    let url = h.server.page("/upload-copy", r#"<!doctype html><input id="file" type="file" multiple>"#);
    h.json("navigate", json!({ "url": url })).await;
    let file = h.files.0.join("copied.txt");
    std::fs::write(&file, "copied bytes").unwrap();
    let uploaded = h.json("upload", json!({ "selector": "#file", "files": [file.display().to_string()] })).await;
    assert_eq!(uploaded["via"], "copy", "{uploaded}");
    assert_eq!(h.eval("document.getElementById('file').files[0].text()").await, "copied bytes");
    h.finish().await;
}

const CAPTURE_PAGE: &str = r#"<!doctype html><html><head><title>t</title><style>body{margin:0;font:16px sans-serif} #box{position:absolute;left:100px;top:120px;width:200px;height:50px;background:#36c} #spin{position:absolute;left:400px;top:300px;width:80px;height:80px;background:#c33}</style></head>
<body><h1>Capture test</h1><button id="go">Go</button> <input name="q" placeholder="Search">
<div id="box"></div><div id="spin"></div>
<iframe id="frame" srcdoc="<body style='margin:0'><button style='width:120px;height:40px;background:#0a0;border:0'>Inner</button></body>" style="position:absolute;left:100px;top:200px;width:200px;height:80px;border:0"></iframe>
<div style="height:2000px"></div>
<script>
window.go = () => fetch('/api?access_token=supersecretquery123&page=2', { method: 'POST', headers: { 'Authorization': 'Bearer abcdefghijklmnopqrstuvwxyz', 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'dax', password: 'hunter2hunter2' }) }).then(r => r.json())
</script></body></html>"#;

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn screenshots_diffs_and_recordings() {
    let h = harness!();
    let url = h.server.page("/capture", CAPTURE_PAGE);
    h.json("navigate", json!({ "url": url })).await;
    let viewport = h.eval("[document.documentElement.clientWidth, innerHeight, devicePixelRatio]").await;
    let (width, height) = (viewport[0].as_u64().unwrap() as u32, viewport[1].as_u64().unwrap() as u32);

    let (shot, summary) = h.image("screenshot", json!({})).await;
    assert_eq!(support::png_size(&shot), (width, height), "{summary}");
    let (element, _) = h.image("screenshot", json!({ "selector": "#box" })).await;
    assert_eq!(support::png_size(&element), (200, 50));
    let pixels = browse_capture::pixeldiff::decode_png(&element).unwrap();
    assert_eq!(&pixels.data[..3], &[0x33, 0x66, 0xcc], "the clip is the blue box");
    let (clip, _) = h.image("screenshot", json!({ "clip": { "x": 10, "y": 10, "width": 100, "height": 50 } })).await;
    assert_eq!(support::png_size(&clip), (100, 50));
    let (full, summary) = h.image("screenshot", json!({ "fullPage": true })).await;
    let full_size = support::png_size(&full);
    assert!(full_size.1 > 2000, "{summary}");

    // An element inside an iframe, by snapshot ref.
    h.ok("snapshot", json!({})).await;
    let refs = browse_page::snapshot_refs(&h.ctx, 1).await.unwrap();
    let inner = refs.iter().find(|(_, role, name)| role == "button" && name.as_deref() == Some("Inner")).expect("iframe button ref");
    let (by_ref, _) = h.image("screenshot", json!({ "ref": inner.0 })).await;
    assert_eq!(support::png_size(&by_ref), (120, 40));
    let pixels = browse_capture::pixeldiff::decode_png(&by_ref).unwrap();
    assert_eq!(&pixels.data[..3], &[0x00, 0xaa, 0x00]);

    let (jpeg, _) = h.image("screenshot", json!({ "format": "jpeg", "quality": 50 })).await;
    assert_eq!(&jpeg[..2], &[0xFF, 0xD8]);
    let (webp, _) = h.image("screenshot", json!({ "format": "webp", "selector": "#box" })).await;
    assert_eq!(&webp[8..12], b"WEBP");
    let (_, labelled) = h.image("screenshot", json!({ "labels": true })).await;
    let labels = labelled["labels"].as_array().unwrap();
    assert!(labels.iter().any(|label| label["selector"] == "#go" && label["role"] == "button"), "{labelled}");

    // Baselines and diffs.
    let saved = h.json("screenshot", json!({ "path": "shots/base.png" })).await;
    assert_eq!(saved["path"], json!(h.files.0.join("shots/base.png")));
    let same = h.json("screenshot_diff", json!({ "baseline": "shots/base.png" })).await;
    assert_eq!(same["matches"], true, "{same}");
    h.eval("document.getElementById('box').style.background = 'red'; 1").await;
    let changed = h.json("screenshot_diff", json!({ "baseline": "shots/base.png" })).await;
    assert_eq!(changed["matches"], false, "{changed}");
    assert!(changed["changedPixels"].as_u64().unwrap() >= 200 * 50, "{changed}");

    // A HiDPI viewport: CSS-pixel screenshots are resampled, device ones keep every pixel.
    h.json("emulate", json!({ "viewport": { "width": 600, "height": 400, "deviceScaleFactor": 2 } })).await;
    assert_eq!(h.eval("devicePixelRatio").await, 2);
    let (css, summary) = h.image("screenshot", json!({ "selector": "#box" })).await;
    assert_eq!(support::png_size(&css), (200, 50), "{summary}");
    let (device, _) = h.image("screenshot", json!({ "selector": "#box", "scale": "device" })).await;
    assert_eq!(support::png_size(&device), (400, 100));
    let (resampled, summary) = h.image("screenshot", json!({ "selector": "#box", "format": "jpeg" })).await;
    assert_eq!(support::png_size(&resampled), (200, 50), "{summary}");
    assert!(summary["note"].as_str().unwrap_or("").contains("PNG"), "{summary}");
    h.json("emulate", json!({ "viewport": "reset" })).await;
    assert_eq!(h.eval("devicePixelRatio").await, 1);

    // Recording polls screenshots: Firefox has no screencast.
    h.json("recording", json!({ "action": "start", "path": "rec/clip.mkv", "frameRate": 10 })).await;
    tokio::time::sleep(Duration::from_millis(1_200)).await;
    let done = h.json("recording", json!({ "action": "stop" })).await;
    assert!(done["frameCount"].as_u64().unwrap() >= 2, "{done}");
    assert!(h.files.0.join("rec/clip.mkv").exists());
    h.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn network_and_console_capture() {
    let h = harness!();
    let url = h.server.page("/capture", CAPTURE_PAGE);
    h.json("navigate", json!({ "url": url })).await;

    h.json("network", json!({ "action": "start", "urlFilter": "/api" })).await;
    assert_eq!(h.eval_main("go().then(r => r.ok)").await, true);
    tokio::time::sleep(Duration::from_millis(300)).await;
    let status = h.json("network", json!({ "action": "status" })).await;
    assert_eq!(status["active"], true, "{status}");
    assert_eq!(h.busy.lock().unwrap().get("network"), Some(&true));
    let stopped = h.json("network", json!({ "action": "stop" })).await;
    let raw = stopped.to_string();
    for secret in ["supersecretquery123", "abcdefghijklmnopqrstuvwxyz", "hunter2hunter2", "sessvalue1234567890", "cookievalue1234567890"] {
        assert!(!raw.contains(secret), "{secret} leaked: {raw}");
    }
    let exchanges = stopped["exchanges"].as_array().unwrap();
    assert_eq!(exchanges.len(), 1, "{raw}");
    let exchange = &exchanges[0];
    assert_eq!(exchange["request"]["method"], "POST", "{raw}");
    assert_eq!(exchange["response"]["status"], 200, "{raw}");
    assert!(exchange["request"]["body"]["text"].as_str().unwrap().contains(r#""username":"dax""#), "{raw}");
    assert!(exchange["response"]["body"]["text"].as_str().unwrap().contains(r#""ok":true"#), "{raw}");

    // Redirect hops and document requests.
    h.server.page("/__landed", "<!doctype html><title>Landed</title>");
    h.json("network", json!({ "action": "start", "resourceTypes": ["Document"] })).await;
    h.json("navigate", json!({ "url": h.server.url("/__redirect/2") })).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let stopped = h.json("network", json!({ "action": "stop" })).await;
    let exchanges = stopped["exchanges"].as_array().unwrap();
    let urls: Vec<&str> = exchanges.iter().map(|e| e["request"]["url"].as_str().unwrap()).collect();
    assert_eq!(exchanges.len(), 3, "{stopped}");
    assert!(urls[2].ends_with("/__landed"), "{urls:?}");
    assert_eq!(exchanges[0]["response"]["status"], 302, "{stopped}");
    assert!(exchanges[1]["request"]["redirectedFrom"].as_str().unwrap().ends_with("/__redirect/2"), "{stopped}");

    // Console capture only sees what happens after start.
    h.json("navigate", json!({ "url": url })).await;
    h.eval_main("console.log('before start'); 1").await;
    h.json("console", json!({ "action": "start" })).await;
    h.eval_main("console.log('hello', 42); console.warn('careful'); setTimeout(() => { throw new Error('boom') }); 1").await;
    tokio::time::sleep(Duration::from_millis(400)).await;
    let read = h.json("console", json!({ "action": "read" })).await;
    let entries = read["entries"].as_array().unwrap();
    assert!(entries.iter().any(|e| e["text"] == "hello 42" && e["type"] == "log"), "{read}");
    assert!(entries.iter().any(|e| e["text"] == "careful" && e["type"] == "warning"), "{read}");
    assert!(entries.iter().any(|e| e["type"] == "pageerror" && e["text"].as_str().unwrap().contains("boom")), "{read}");
    assert!(!entries.iter().any(|e| e["text"] == "before start"), "{read}");
    h.json("console", json!({ "action": "stop" })).await;
    h.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn emulation_and_unsupported_settings() {
    let h = harness!();
    let url = h.server.page("/emulate", "<!doctype html><title>Emulate</title><p>hi</p>");
    h.json("navigate", json!({ "url": url })).await;
    let emulated = h.json("emulate", json!({ "viewport": { "width": 500, "height": 400 }, "userAgent": "BrowseBot/1.0" })).await;
    assert_eq!(emulated["applied"]["viewport"]["width"], 500, "{emulated}");
    assert_eq!(h.eval("[innerWidth, innerHeight, navigator.userAgent]").await, json!([500, 400, "BrowseBot/1.0"]));
    h.json("emulate", json!({ "viewport": "reset", "userAgent": "reset" })).await;
    assert_ne!(h.eval("navigator.userAgent").await, "BrowseBot/1.0");

    // Touch isn't in WebDriver BiDi yet: it fails on its own without blocking the rest.
    let mixed = h.json("emulate", json!({ "geolocation": { "latitude": 10.5, "longitude": 20.5, "accuracy": 3 }, "touch": true })).await;
    assert!(mixed["applied"].get("geolocation").is_some(), "{mixed}");
    assert!(mixed["failed"]["touch"].as_str().unwrap().contains("not supported"), "{mixed}");

    let fetch = "fetch(location.href + '?' + Math.random()).then(() => 'online', () => 'offline')";
    h.json("emulate", json!({ "offline": true })).await;
    assert_eq!(h.eval(fetch).await, "offline");
    h.json("emulate", json!({ "offline": false })).await;
    assert_eq!(h.eval(fetch).await, "online");
    let error = h.err("emulate", json!({ "touch": true })).await;
    assert!(error.contains("touch"), "{error}");
    h.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn sessions_end_so_the_next_client_can_connect() {
    let Some(firefox) = support::launch().await else {
        eprintln!("no Firefox found; skipping");
        return;
    };
    let first = browse_bidi::BiDiBrowserDriver::connect(&firefox.ws).await.unwrap();
    assert_eq!(first.info().protocol, "webdriver-bidi");
    assert!(first.info().browser.to_lowercase().contains("firefox"), "{:?}", first.info());
    // Firefox allows one session: a second client is refused with a clear reason.
    let refused = browse_bidi::BiDiBrowserDriver::connect(&firefox.ws).await.err().expect("a second session is refused");
    assert!(matches!(refused, DriverError::Refused(_)), "{refused:?}");

    let mut events = first.events();
    let target = first.open(Some("about:blank"), &TabOptions::default()).await.unwrap();
    let opened = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Ok(BrowserEvent::TabOpened { target: opened, .. }) = events.recv().await
                && opened == target
            {
                return;
            }
        }
    })
    .await;
    assert!(opened.is_ok(), "TabOpened arrives");
    let tab = first.attach(&target).await.unwrap();
    let mut page = tab.events();
    first.close(&target).await.unwrap();
    let closed = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match page.recv().await {
                Ok(PageEvent::Closed(_)) => return true,
                Ok(_) => {}
                Err(_) => return false,
            }
        }
    })
    .await;
    assert_eq!(closed, Ok(true));
    assert!(matches!(tab.frames().await, Err(DriverError::Closed(_))));

    first.shutdown().await;
    let second = browse_bidi::BiDiBrowserDriver::connect(&firefox.ws).await.expect("the ended session frees the browser");
    drop(second);
    // Dropping a client ends its session too.
    tokio::time::sleep(Duration::from_millis(300)).await;
    let third = browse_bidi::BiDiBrowserDriver::connect(&firefox.ws).await.expect("a dropped client ends its session");
    third.shutdown().await;
}


/// A real profile `browse firefox` connected keeps Firefox's own defaults (`remote.prefs.recommended` off): the tools
/// work the same there.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn tools_work_with_a_real_profiles_prefs() {
    let h = harness!(Harness::start_with_prefs("// browse\nuser_pref(\"remote.prefs.recommended\", false);\n"));
    assert_eq!(h.eval_main("navigator.webdriver").await, true);
    let url = h.server.page("/real", FORM);
    let nav = h.json("navigate", json!({ "url": url })).await;
    assert_eq!(nav["title"], "Form", "{nav}");
    let snapshot = h.ok("snapshot", json!({})).await;
    assert!(snapshot.contains("- heading \"Sign up\" [level=1]"), "{snapshot}");
    let email = ref_of(&snapshot, "textbox \"Email\"");
    h.json("fill", json!({ "fields": [ { "ref": email, "value": "real@profile.co" } ] })).await;
    h.json("click", json!({ "ref": ref_of(&snapshot, "button \"Save\"") })).await;
    assert_eq!(h.eval("document.getElementById('out').textContent").await, "saved real@profile.co");
    let (png, _) = h.image("screenshot", json!({})).await;
    assert!(png.starts_with(b"\x89PNG"), "a PNG");
    assert_eq!(h.eval_main("typeof Services").await, "undefined", "pages still can't reach chrome privileges");
    h.finish().await;
}

/// `quit` closes the browser itself (`browser.close`), not just the session.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn quit_closes_firefox() {
    let mut h = harness!();
    h.driver.quit().await.expect("browser.close");
    assert!(h.firefox.exited_within(Duration::from_secs(30)).await, "Firefox exits after quit");
}
