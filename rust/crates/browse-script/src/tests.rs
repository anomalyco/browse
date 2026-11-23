//! The engine and the host against fake tools (no browser).

use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use browse_core::{Browser, Cdp, Content, HandoffResult, TabId, TabInfo, TabOptions, TabState, Tool, ToolContext, ToolOutput, ToolSpec};
use serde_json::{Value, json};

/// Tab 7 shows example.com; every tab id has its own state.
#[derive(Default)]
struct FakeBrowser {
    states: std::sync::Mutex<std::collections::HashMap<TabId, Arc<TabState>>>,
}

#[async_trait]
impl Browser for FakeBrowser {
    async fn open_tab(&self, _: Option<&str>, _: &TabOptions) -> anyhow::Result<TabInfo> {
        anyhow::bail!("no tabs here")
    }
    async fn tabs(&self) -> anyhow::Result<Vec<TabInfo>> {
        Ok(vec![TabInfo { tab: 7, url: "https://example.com/".into(), title: "Example".into(), lent: false, opener: None, chosen: None, last_used: None, busy: false, options: TabOptions::default() }])
    }
    async fn close_tab(&self, _: TabId) -> anyhow::Result<()> {
        Ok(())
    }
    async fn cdp(&self, _: TabId) -> anyhow::Result<Arc<dyn Cdp>> {
        anyhow::bail!("no cdp here")
    }
    async fn state(&self, tab: TabId) -> anyhow::Result<Arc<TabState>> {
        Ok(self.states.lock().unwrap().entry(tab).or_default().clone())
    }
    async fn handoff(&self, _: TabId, _: &str) -> anyhow::Result<HandoffResult> {
        anyhow::bail!("no handoff here")
    }
    async fn read_only(&self, _: TabId) -> bool {
        false
    }
}

/// `echo` returns its arguments, `fail` fails with `message`, `picture` returns an image, `handoff` waits `ms`.
struct Fake(&'static str);

#[async_trait]
impl Tool for Fake {
    fn spec(&self) -> ToolSpec {
        ToolSpec { name: self.0.into(), description: String::new(), input_schema: json!({ "type": "object" }) }
    }
    async fn call(&self, _ctx: ToolContext, args: Value) -> anyhow::Result<ToolOutput> {
        Ok(match self.0 {
            "echo" => ToolOutput::text(args.to_string()),
            "fail" => ToolOutput::error(args["message"].as_str().unwrap_or("failed").to_string()),
            "picture" => ToolOutput { content: vec![Content::Image { data: "iVBORw0KGgo=".into(), mime_type: "image/png".into() }], is_error: false },
            // Without a tab, navigate opens tab 7.
            "navigate" => ToolOutput::text(json!({ "tab": args.get("tab").cloned().unwrap_or(json!(7)), "url": args["url"], "title": "T", "status": 200, "navigated": true }).to_string()),
            // Echo the upload args so a test can see what setInputFiles hands the tool.
            "upload" => ToolOutput::text(args.to_string()),
            "handoff" => {
                tokio::time::sleep(Duration::from_millis(args["ms"].as_u64().unwrap_or(0))).await;
                ToolOutput::text(json!({ "outcome": "continued" }).to_string())
            }
            _ => ToolOutput::text(""),
        })
    }
}

fn context() -> ToolContext {
    ToolContext { browser: Arc::new(FakeBrowser::default()), file_roots: vec![] }
}

fn execute() -> Arc<dyn Tool> {
    let fakes: Vec<Arc<dyn Tool>> = ["echo", "fail", "picture", "navigate", "handoff", "upload"].into_iter().map(|n| Arc::new(Fake(n)) as Arc<dyn Tool>).collect();
    crate::tools(&fakes).remove(0)
}

async fn run_in(ctx: &ToolContext, args: Value) -> (String, ToolOutput) {
    let output = execute().call(ctx.clone(), args).await.unwrap();
    let text = output.content.iter().filter_map(|c| if let Content::Text { text } = c { Some(text.clone()) } else { None }).collect::<Vec<_>>().join("\n");
    (text, output)
}

async fn ok(code: &str) -> String {
    let (text, output) = run_in(&context(), json!({ "code": code })).await;
    assert!(!output.is_error, "{code} failed: {text}");
    text
}

async fn err(code: &str) -> String {
    let (text, output) = run_in(&context(), json!({ "code": code })).await;
    assert!(output.is_error, "{code} should fail: {text}");
    text
}

#[tokio::test]
async fn values_and_logs() {
    assert_eq!(ok("1 + 1").await, "2");
    assert_eq!(ok("'plain text'").await, "plain text");
    assert_eq!(ok("const a = { x: [1, 2], when: new Date(0) }; return a").await, r#"{"x":[1,2],"when":"1970-01-01T00:00:00.000Z"}"#);
    assert_eq!(ok("async (page) => typeof page.goto").await, "function");
    assert_eq!(ok("(page) => 5").await, "5");
    // A method returned by mistake isn't called.
    assert!(ok("page.url").await.starts_with("url()"));
    let logged = ok("console.log('hello', { a: 1 }); console.error('bad'); return 3").await;
    assert!(logged.starts_with("3\n") && logged.contains("Console:\nhello {\"a\":1}\n[error] bad"), "{logged}");
    let classy = ok("return page").await;
    assert!(classy.contains("could not be represented as JSON"), "{classy}");
}

#[tokio::test]
async fn tools_and_errors() {
    assert_eq!(ok("const r = await browse.echo({ a: 1, skip: undefined }); return r").await, r#"{"a":1}"#);
    let caught = ok("try { await browse.fail({ message: 'Nope: timed out after 5 ms' }) } catch (e) { return e.name + ' ' + e.message }").await;
    assert_eq!(caught, "TimeoutError Nope: timed out after 5 ms");
    let thrown = err("\nawait browse.fail({ message: 'broken' })").await;
    assert!(thrown.starts_with("Error: broken") && thrown.contains("execute.js:2"), "{thrown}");
    let syntax = err("return (").await;
    assert!(syntax.contains("SyntaxError"), "{syntax}");
    let missing = err("await page.route('**', () => {})").await;
    assert!(missing.contains("not supported") && missing.contains("network.start"), "{missing}");
    let tabless = err("await page.click('a')").await;
    assert!(tabless.contains("page has no tab yet") && tabless.contains("page.goto"), "{tabless}");
    assert_eq!(ok("page.url()").await, "about:blank", "a page without a tab is blank");
    let fetched = err("await fetch('https://example.com')").await;
    assert!(fetched.contains("page.evaluate"), "{fetched}");
}

#[tokio::test]
async fn navigation_and_images() {
    let (text, output) = run_in(&context(), json!({ "code": "const r = await page.goto('https://example.com/a'); return { status: r.status(), ok: r.ok(), shot: await browse.picture() }" })).await;
    assert!(!output.is_error, "{text}");
    assert!(text.starts_with("tab: 7\n"), "the result names the tab page.goto opened: {text}");
    assert!(text.contains(r#""status":200"#) && text.contains(r#""shot":{"type":"image","mimeType":"image/png""#), "{text}");
    assert!(text.contains("1 navigation"), "{text}");
    assert_eq!(output.content.len(), 2);
    // Images not returned aren't attached.
    let (_, output) = run_in(&context(), json!({ "code": "await browse.picture(); return 1" })).await;
    assert_eq!(output.content.len(), 1);
    assert_eq!(ok("(await browse.picture()).toString('base64')").await, "iVBORw0KGgo=");
}

#[tokio::test]
async fn set_input_files_sends_paths_and_inline_bytes() {
    let code = r##"
      const strip = (result) => result.files.map((file) => {
        if (typeof file === "string") return file
        const { lastModified, ...rest } = file
        return rest
      })
      const one = await page.setInputFiles("#file", { name: "a.txt", mimeType: "text/plain", buffer: new Uint8Array([104, 105]) })
      const two = await page.setInputFiles("#file", [
        { name: "b.bin", buffer: new Uint8Array([0, 1, 2]).buffer },
        { name: "c.txt", data: "aGVsbG8=" },
        { name: "d.bin", buffer: "AAEC" },
        "local.txt",
      ])
      const three = await page.locator("#file").setInputFiles({ name: "e.txt", data: "IQ==" })
      return { one: strip(one), two: strip(two), three: strip(three) }
    "##;
    let (text, output) = run_in(&context(), json!({ "code": code, "tab": 7 })).await;
    assert!(!output.is_error, "{text}");
    let expected = r#"{"one":[{"name":"a.txt","data":"aGk=","mimeType":"text/plain"}],"two":[{"name":"b.bin","data":"AAEC"},{"name":"c.txt","data":"aGVsbG8="},{"name":"d.bin","data":"AAEC"},"local.txt"],"three":[{"name":"e.txt","data":"IQ=="}]}"#;
    assert!(text.contains(expected), "{text}");

    let (message, output) = run_in(&context(), json!({ "code": "try { await page.setInputFiles('#file', { name: 'x.txt' }) } catch (e) { return e.message }", "tab": 7 })).await;
    assert!(!output.is_error, "{message}");
    assert!(message.contains("Uint8Array") && message.contains("base64"), "{message}");
}

#[tokio::test]
async fn timers_state_and_limits() {
    assert_eq!(ok("let n = 0; const t = setInterval(() => n++, 10); await new Promise((r) => setTimeout(r, 120)); clearInterval(t); return n > 3").await, "true");
    let never = err("await new Promise(() => {})").await;
    assert!(never.contains("nothing will ever settle"), "{never}");

    // state is the tab's: kept between executes in tab 7, and not seen in another tab or without one.
    let ctx = context();
    let (first, _) = run_in(&ctx, json!({ "code": "state.count = (state.count || 0) + 1; return state.count", "tab": 7 })).await;
    let (second, _) = run_in(&ctx, json!({ "code": "state.count += 1; return state.count", "tab": 7 })).await;
    assert_eq!((first.as_str(), second.as_str()), ("tab: 7\n\n1", "tab: 7\n\n2"));
    let (other, _) = run_in(&ctx, json!({ "code": "state.count ?? 'none'", "tab": 8 })).await;
    assert_eq!(other, "tab: 8\n\nnone");
    let (none, _) = run_in(&ctx, json!({ "code": "state.count ?? 'none'" })).await;
    assert_eq!(none, "none");
    // A page that opens its tab during the run leaves its state with that tab.
    let fresh = context();
    let (opened, _) = run_in(&fresh, json!({ "code": "await page.goto('https://example.com/'); state.seen = page._tab; return 'ok'" })).await;
    assert!(opened.starts_with("tab: 7\n\nok"), "{opened}");
    let (seen, _) = run_in(&fresh, json!({ "code": "state.seen", "tab": 7 })).await;
    assert_eq!(seen, "tab: 7\n\n7");

    let started = Instant::now();
    let busy = err("while (true) {}").await;
    assert!(busy.contains("Synchronous JavaScript ran for more than 2 seconds"), "{busy}");
    assert!(started.elapsed() < Duration::from_secs(5));
    // The loop's state change before it was stopped is kept.
    let (_, _) = run_in(&ctx, json!({ "code": "state.mark = 'x'; while (true) {}", "tab": 7 })).await;
    let (kept, _) = run_in(&ctx, json!({ "code": "state.mark", "tab": 7 })).await;
    assert_eq!(kept, "tab: 7\n\nx");

    let (slow, output) = run_in(&ctx, json!({ "code": "state.slow = 1; await new Promise((r) => setTimeout(r, 5000))", "timeoutMs": 200, "tab": 7 })).await;
    assert!(output.is_error && slow.contains("timed out after 200 ms"), "{slow}");
    let (kept, _) = run_in(&ctx, json!({ "code": "state.slow", "tab": 7 })).await;
    assert_eq!(kept, "tab: 7\n\n1");

    let memory = err("const a = []; for (let i = 0; i < 1e8; i++) a.push('x'.repeat(100) + i); return a.length").await;
    assert!(memory.contains("out of memory"), "{memory}");
    let deep = err("const f = (n) => f(n + 1); f(0)").await;
    assert!(deep.contains("stack") || deep.contains("RangeError") || deep.contains("InternalError"), "{deep}");
}

#[tokio::test]
async fn handoff_pauses_the_timeout() {
    let (text, output) = run_in(&context(), json!({ "code": "await browse.handoff({ ms: 600 }); return 'after'", "timeoutMs": 300 })).await;
    assert!(!output.is_error, "{text}");
    assert!(text.starts_with("after") && text.contains("1 handoff"), "{text}");
}
