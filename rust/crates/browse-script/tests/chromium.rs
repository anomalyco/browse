//! execute end to end against a real headless Chromium (skipped when none is installed; set BROWSE_TEST_CHROME):
//! the Playwright-style layer, the helpers and real report-watch scripts that were written for the TypeScript execute.

mod support;

use browse_core::Content;
use serde_json::{Value, json};
use support::{Harness, text_of};

macro_rules! harness {
    () => {
        match Harness::start(false).await {
            Some(h) => h,
            None => {
                eprintln!("no Chromium found; skipping");
                return;
            }
        }
    };
}

impl Harness {
    async fn run(&self, code: &str) -> (String, browse_core::ToolOutput) {
        let output = self.call("execute", json!({ "code": code, "timeoutMs": 60000 })).await;
        (text_of(&output), output)
    }
    async fn script(&self, code: &str) -> String {
        let (text, output) = self.run(code).await;
        assert!(!output.is_error, "execute failed:\n{text}\n--- code:\n{code}");
        text
    }
    async fn value(&self, code: &str) -> Value {
        let text = self.script(code).await;
        let first = text.split("\n\n").next().unwrap();
        serde_json::from_str(first).unwrap_or_else(|_| Value::String(first.to_string()))
    }
}

const FORM: &str = r###"<!doctype html><html><head><title>Form</title></head><body>
<main>
<h1>Sign up</h1>
<label>Email <input id="email" name="email" placeholder="you@example.com"></label>
<label>Password <input id="pw" type="password"></label>
<label><input type="checkbox" id="terms"> I agree</label>
<select id="plan"><option value="free">Free</option><option value="pro">Pro plan</option></select>
<button id="save" data-testid="save" onclick="document.getElementById('out').textContent = 'saved ' + document.getElementById('email').value">Save</button>
<p id="out">nothing yet</p>
<ul><li class="item">One</li><li class="item">Two</li><li class="item" style="display:none">Three</li></ul>
<input id="search" onkeydown="if (event.key === 'Enter') document.getElementById('out').textContent = 'searched ' + this.value">
<a href="/next">Next page</a>
<iframe title="Pay" srcdoc="<button onclick=&quot;this.textContent='paid'&quot;>Pay now</button>"></iframe>
</main>
</body></html>"###;

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn playwright_layer() {
    let h = harness!();
    let url = h.server.page("/form", FORM);
    h.server.page("/next", "<!doctype html><title>Next</title><h1>Second page</h1>");

    let result = h
        .value(&format!(
            r###"
const response = await page.goto({url:?}, {{ waitUntil: "domcontentloaded" }});
await page.getByLabel("Email").fill("a@b.co");
await page.getByPlaceholder("you@example.com").press("End");
await page.locator("#terms").check();
await page.selectOption("#plan", {{ label: "Pro plan" }});
await page.getByRole("button", {{ name: "Save" }}).click();
const items = page.locator("li.item");
await page.locator("#search").fill("cats");
await page.keyboard.press("Enter");
return {{
  status: response.status(),
  ok: response.ok(),
  title: await page.title(),
  url: page.url(),
  out: await page.textContent("#out"),
  email: await page.getByLabel("Email").inputValue(),
  checked: await page.isChecked("#terms"),
  plan: await page.locator("#plan").inputValue(),
  count: await items.count(),
  texts: await items.allTextContents(),
  second: await items.nth(1).innerText(),
  lastVisible: await items.last().isVisible(),
  firstVisible: await items.first().isVisible(),
  missing: await page.locator("#nope").count(),
  testid: await page.getByTestId("save").textContent(),
  eval: await page.evaluate(([a, b]) => a + b + document.querySelectorAll("li").length, [1, 2]),
  evalString: await page.evaluate("1 + 2"),
  dollar: await page.$$eval("li", (els, suffix) => els.map((e) => e.textContent + suffix), "!"),
  frame: await page.frameLocator("iframe[title=Pay]").getByRole("button").textContent(),
  attribute: await page.getAttribute("a", "href"),
  hasContent: (await page.content()).startsWith("<!DOCTYPE html>"),
}}
"###
        ))
        .await;
    assert_eq!(result["status"], 200, "{result}");
    assert_eq!(result["ok"], true);
    assert_eq!(result["title"], "Form");
    assert_eq!(result["url"], url);
    assert_eq!(result["out"], "searched cats", "{result}");
    assert_eq!(result["email"], "a@b.co");
    assert_eq!(result["checked"], true);
    assert_eq!(result["plan"], "pro");
    assert_eq!(result["count"], 3);
    assert_eq!(result["texts"], json!(["One", "Two", "Three"]));
    assert_eq!(result["second"], "Two");
    assert_eq!(result["lastVisible"], false);
    assert_eq!(result["firstVisible"], true);
    assert_eq!(result["missing"], 0);
    assert_eq!(result["testid"], "Save");
    assert_eq!(result["eval"], 6);
    assert_eq!(result["evalString"], 3);
    assert_eq!(result["dollar"], json!(["One!", "Two!", "Three!"]));
    assert_eq!(result["frame"], "Pay now");
    assert_eq!(result["attribute"], "/next");
    assert_eq!(result["hasContent"], true);

    // Save was clicked before the search replaced #out; check the click happened through the frame too.
    let paid = h.value(r###"await page.frameLocator("iframe[title=Pay]").getByRole("button", { name: "Pay now" }).click(); return await page.frameLocator("iframe").locator("button").textContent()"###).await;
    assert_eq!(paid, "paid");

    // Strictness and clear errors.
    let (text, output) = h.run(r###"await page.locator("li.item").click({ timeout: 2000 })"###).await;
    assert!(output.is_error && text.contains("matches 3 elements"), "{text}");
    let (text, output) = h.run(r###"await page.locator("#nope").click({ timeout: 500 })"###).await;
    assert!(output.is_error && text.contains("TimeoutError") || text.contains("No element"), "{text}");
    let caught = h.value(r###"try { await page.waitForSelector("#never", { timeout: 300 }) } catch (e) { return e.name }"###).await;
    assert_eq!(caught, "TimeoutError");

    // Navigation, history and the aftermath.
    let text = h.script(r###"await page.click("text=Next page"); await page.waitForURL("**/next"); const t = await page.title(); await page.goBack(); return t"###).await;
    assert!(text.starts_with("Next") && text.contains("navigation"), "{text}");
    assert_eq!(h.value("page.url()").await, url);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn helpers_tabs_files_and_images() {
    let h = harness!();
    let url = h.server.page("/form", FORM);
    h.server.page("/other", "<!doctype html><title>Other</title><p>other tab</p>");
    h.script(&format!("await page.goto({url:?})")).await;

    // snapshot + ref, the TS way.
    let result = h
        .value(
            r###"
const outline = await snapshot();
const save = outline.split("\n").find((line) => line.includes('button "Save"')).match(/ref=(e\d+)/)[1];
await ref("e1").count();
await page.getByLabel("Email").fill("ref@b.co");
await ref(save).click();
return { out: await page.locator("#out").textContent(), found: (await snapshot({ find: "Save" })).includes("Save") }
"###,
        )
        .await;
    assert_eq!(result["out"], "saved ref@b.co", "{result}");
    assert_eq!(result["found"], true);

    // A screenshot returned is attached; one written to a file isn't.
    let output = h.call("execute", json!({ "code": "return await page.screenshot()" })).await;
    assert!(!output.is_error, "{}", text_of(&output));
    assert!(matches!(output.content.get(1), Some(Content::Image { mime_type, .. }) if mime_type == "image/png"), "{}", text_of(&output));
    let saved = h.value(r###"const r = await page.screenshot({ path: "shots/a.png" }); return { path: r.path, exists: (await files.read("shots/a.png", "base64")).length > 100 }"###).await;
    assert_eq!(saved["exists"], true, "{saved}");
    assert!(saved["path"].as_str().unwrap().ends_with("shots/a.png"));
    let labelled = h.value("const r = await screenshotWithLabels(); return { n: r.labelCount, image: r.image.type }").await;
    assert!(labelled["n"].as_u64().unwrap() > 3, "{labelled}");

    // files and state.
    let read = h.value(r###"const p = await files.write("notes/a.txt", "hello"); state.note = await files.read(p, "utf8"); return { p, dir: files.dir, roots: files.roots.length }"###).await;
    assert!(read["p"].as_str().unwrap().ends_with("notes/a.txt"), "{read}");
    assert_eq!(h.value("state.note").await, "hello");
    let (text, output) = h.run(r###"await files.write("/etc/x", "no")"###).await;
    assert!(output.is_error && text.contains("outside the file roots"), "{text}");

    // context.newPage() leaves `page` on its tab; pages() lists both.
    let other = h.server.page("/other", "<!doctype html><title>Other</title><p>other tab</p>");
    let tabs = h
        .value(&format!(
            r###"
const second = await context.newPage();
await second.goto({other:?});
const titles = [];
for (const p of context.pages()) titles.push(await p.title());
const r = {{ first: await page.title(), second: await second.title(), titles }};
await second.close();
r.after = context.pages().length;
return r
"###
        ))
        .await;
    assert_eq!(tabs["first"], "Form", "{tabs}");
    assert_eq!(tabs["second"], "Other");
    assert_eq!(tabs["titles"].as_array().unwrap().len(), 2);
    assert_eq!(tabs["after"], 1);

    // Raw tools, and an unsupported Playwright API naming the alternative.
    let raw = h.value(r###"const r = await browse.eval({ expression: "document.title" }); const w = await browse.waitFor({ text: "Sign up" }); return [r, typeof w]"###).await;
    assert_eq!(raw, json!(["Form", "object"]));
    let (text, output) = h.run("await context.addCookies([])").await;
    assert!(output.is_error && text.contains("not supported") && text.contains("cookies"), "{text}");
}

const COUNTER: &str = r###"<!doctype html><html><body><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="315" height="100">
<defs><image id="0" href="data:,"/><image id="2" href="data:,"/><image id="6" href="data:,"/></defs>
<use x="270" xlink:href="#6"/><use x="0" xlink:href="#0"/><use x="45" xlink:href="#0"/><use x="90" xlink:href="#0"/><use x="135" xlink:href="#0"/><use x="180" xlink:href="#2"/><use x="225" xlink:href="#2"/>
</svg></body></html>"###;

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn report_watch_scripts_run_unchanged() {
    let h = harness!();
    // counter.js, verbatim except for the URL.
    let counter = h.server.page("/get/counter", COUNTER);
    let script = include_str!("scripts/counter.js").replace("https://count.example.com/get/@counter?padding=7", &counter);
    let value = h.value(&script).await;
    assert_eq!(value["digits"], "0000226", "{value}");
    assert_eq!(value["value"], 226);

    // altsearch.js against a lookalike of the site: the URLs point at the test server and waits are shortened.
    h.server.page("/suspended_one", "<!doctype html><body><main>Account suspended</main></body>");
    h.server.page("/missing_one", "<!doctype html><body><main>This account doesn’t exist</main></body>");
    h.server.page("/protected_one", "<!doctype html><body><main>These posts are protected</main></body>");
    h.server.page("/broken_one", "<!doctype html><body><main>Something went wrong. Try reloading.</main></body>");
    h.server.page("/acme_dev", "<!doctype html><body><main>Posts</main></body>");
    h.server.page("/acme_team", "<!doctype html><body><main>Posts</main></body>");
    h.server.page(
        "/search",
        r###"<!doctype html><body><div data-testid="UserCell"><a href="/acme_dev">Acme</a> builds things</div><div data-testid="UserCell"><a href="/acmecat">acme cat</a></div><div style="height:3000px"></div></body>"###,
    );
    let base = format!("http://127.0.0.1:{}", h.server.port);
    let script = format!(
        "page.waitForTimeout = (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20)));\n{}",
        include_str!("scripts/altsearch.js").replace("https://x.com", &base)
    );
    let value = h.value(&script).await;
    assert_eq!(value["status"], json!({ "suspended_one": "suspended", "missing_one": "missing", "protected_one": "protected", "broken_one": "error", "acme_dev": "visible", "acme_team": "visible" }), "{value}");
    assert_eq!(value["errors"], json!([]), "{value}");
    assert_eq!(value["users"].as_array().unwrap().len(), 16, "{value}");
    assert_eq!(value["users"][0]["handle"], "acme_dev");
    assert_eq!(value["users"][1]["handle"], "acmecat");

    // pages.js, with its targets inlined (it read them from process.env, which execute has never had).
    let one = h.server.page("/p1", "<!doctype html><body>first   page\ntext</body>");
    let script = include_str!("scripts/pages.js").replace(r###"JSON.parse(process.env.OC_TARGETS || "[]")"###, &format!("[{one:?}]")).replace("3000", "10");
    let value = h.value(&script).await;
    assert_eq!(value["pages"][0]["text"], "first page text", "{value}");
}
