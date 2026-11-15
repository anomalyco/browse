//! The engine and the host against fake tools (no browser).

use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use browse_core::{Browser, Cdp, Content, HandoffResult, SessionId, SessionState, TabId, TabInfo, Tool, ToolContext, ToolOutput, ToolSpec};
use serde_json::{Value, json};

struct FakeBrowser;

#[async_trait]
impl Browser for FakeBrowser {
    async fn tabs(&self, _: &SessionId) -> anyhow::Result<Vec<TabInfo>> {
        Ok(vec![TabInfo { tab_id: 7, url: "https://example.com/".into(), title: "Example".into(), active: true }])
    }
    async fn current_tab(&self, _: &SessionId) -> anyhow::Result<TabInfo> {
        Ok(TabInfo { tab_id: 7, url: "https://example.com/".into(), title: "Example".into(), active: true })
    }
    async fn open_tab(&self, _: &SessionId, _: Option<&str>) -> anyhow::Result<TabInfo> {
        anyhow::bail!("no tabs here")
    }
    async fn select_tab(&self, _: &SessionId, _: TabId) -> anyhow::Result<()> {
        Ok(())
    }
    async fn close_tab(&self, _: &SessionId, _: TabId) -> anyhow::Result<()> {
        Ok(())
    }
    async fn cdp(&self, _: &SessionId, _: TabId) -> anyhow::Result<Arc<dyn Cdp>> {
        anyhow::bail!("no cdp here")
    }
    async fn handoff(&self, _: &SessionId, _: TabId, _: &str) -> anyhow::Result<HandoffResult> {
        anyhow::bail!("no handoff here")
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
            "navigate" => ToolOutput::text(json!({ "url": args["url"], "title": "T", "status": 200, "navigated": true }).to_string()),
            "handoff" => {
                tokio::time::sleep(Duration::from_millis(args["ms"].as_u64().unwrap_or(0))).await;
                ToolOutput::text(json!({ "outcome": "continued" }).to_string())
            }
            _ => ToolOutput::text(""),
        })
    }
}

fn context() -> ToolContext {
    ToolContext { session: "test".into(), browser: Arc::new(FakeBrowser), state: Arc::new(SessionState::default()), file_roots: vec![] }
}

fn execute() -> Arc<dyn Tool> {
    let fakes: Vec<Arc<dyn Tool>> = ["echo", "fail", "picture", "navigate", "handoff"].into_iter().map(|n| Arc::new(Fake(n)) as Arc<dyn Tool>).collect();
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
    let session = err("await browse.echo({ session: 'other' })").await;
    assert!(session.contains("execute's session"), "{session}");
    let fetched = err("await fetch('https://example.com')").await;
    assert!(fetched.contains("page.evaluate"), "{fetched}");
}

#[tokio::test]
async fn navigation_and_images() {
    let (text, output) = run_in(&context(), json!({ "code": "const r = await page.goto('https://example.com/a'); return { status: r.status(), ok: r.ok(), shot: await browse.picture() }" })).await;
    assert!(!output.is_error, "{text}");
    assert!(text.contains(r#""status":200"#) && text.contains(r#""shot":{"type":"image","mimeType":"image/png""#), "{text}");
    assert!(text.contains("1 navigation"), "{text}");
    assert_eq!(output.content.len(), 2);
    // Images not returned aren't attached.
    let (_, output) = run_in(&context(), json!({ "code": "await browse.picture(); return 1" })).await;
    assert_eq!(output.content.len(), 1);
    assert_eq!(ok("(await browse.picture()).toString('base64')").await, "iVBORw0KGgo=");
}

#[tokio::test]
async fn timers_state_and_limits() {
    assert_eq!(ok("let n = 0; const t = setInterval(() => n++, 10); await new Promise((r) => setTimeout(r, 120)); clearInterval(t); return n > 3").await, "true");
    let never = err("await new Promise(() => {})").await;
    assert!(never.contains("nothing will ever settle"), "{never}");

    let ctx = context();
    let (first, _) = run_in(&ctx, json!({ "code": "state.count = (state.count || 0) + 1; return state.count" })).await;
    let (second, _) = run_in(&ctx, json!({ "code": "state.count += 1; return state.count" })).await;
    assert_eq!((first.as_str(), second.as_str()), ("1", "2"));

    let started = Instant::now();
    let busy = err("while (true) {}").await;
    assert!(busy.contains("Synchronous JavaScript ran for more than 2 seconds"), "{busy}");
    assert!(started.elapsed() < Duration::from_secs(5));
    // The loop's state change before it was stopped is kept.
    let (_, _) = run_in(&ctx, json!({ "code": "state.mark = 'x'; while (true) {}" })).await;
    let (kept, _) = run_in(&ctx, json!({ "code": "state.mark" })).await;
    assert_eq!(kept, "x");

    let (slow, output) = run_in(&ctx, json!({ "code": "state.slow = 1; await new Promise((r) => setTimeout(r, 5000))", "timeoutMs": 200 })).await;
    assert!(output.is_error && slow.contains("timed out after 200 ms"), "{slow}");
    let (kept, _) = run_in(&ctx, json!({ "code": "state.slow" })).await;
    assert_eq!(kept, "1");

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
