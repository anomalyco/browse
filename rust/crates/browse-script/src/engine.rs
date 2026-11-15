//! The QuickJS side of an execute: one runtime on its own thread per run, so a runaway script never blocks the relay.
//! Everything that touches the browser or the clock goes to the host (the execute's async task) as a message: async
//! operations settle a promise later, sync ones block this thread until the host answers.

use std::cell::{Cell, RefCell};
use std::collections::HashSet;
use std::rc::Rc;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use rquickjs::context::EvalOptions;
use rquickjs::function::Rest;
use rquickjs::{Context, Ctx, Exception, Function, Object, Persistent, Runtime, Value as JsValue};
use serde_json::Value;
use tokio::sync::mpsc::UnboundedSender;

const PRELUDE: &str = include_str!("prelude.js");
/// How long synchronous JavaScript may run before the host gets control back (TS's CPU slice).
pub const CPU_SLICE: Duration = Duration::from_secs(2);
const MEMORY_LIMIT: usize = 64 * 1024 * 1024;
const STACK_LIMIT: usize = 1024 * 1024;
const THREAD_STACK: usize = 8 * 1024 * 1024;
/// The globals the code gets, in the order of the wrapper's parameters (the prelude returns them in this order).
pub const GLOBALS: &[&str] = &[
    "console", "browser", "context", "page", "state", "browse", "files", "snapshot", "ariaSnapshot", "ref", "handoff", "demonstrate",
    "screenshotWithLabels", "screenshotDiff", "network", "pageConsole", "webmcp", "fillInput", "fillInputs",
];

pub enum ToHost {
    Async { id: u64, op: String, payload: Value },
    Sync { op: String, payload: Value, reply: mpsc::Sender<Result<Value, String>> },
    Log { level: String, text: String },
    Done(Finished),
}

pub struct Settle {
    pub id: u64,
    pub result: Result<Value, String>,
}

pub struct Job {
    pub code: String,
    pub state: String,
    pub tools: Vec<String>,
    /// The tab `page` stands for, when the call named one.
    pub tab: Option<i64>,
    pub timeout_ms: u64,
}

#[derive(Debug)]
pub struct Finished {
    /// What the prelude reported: `{ ok, value?, text, images, warnings, error?, stack? }`, or None when the engine
    /// stopped the run itself (`stopped` says why).
    pub report: Option<Value>,
    pub stopped: Option<String>,
    /// The `state` object as JSON, to keep for the next call.
    pub state: Option<String>,
}

pub fn spawn(job: Job, host: UnboundedSender<ToHost>, settles: mpsc::Receiver<Settle>, cancel: Arc<AtomicBool>) -> std::io::Result<()> {
    std::thread::Builder::new().name("browse-execute".into()).stack_size(THREAD_STACK).spawn(move || {
        let finished = run(job, &host, settles, &cancel);
        let _ = host.send(ToHost::Done(finished));
    })?;
    Ok(())
}

struct Shared {
    host: UnboundedSender<ToHost>,
    cancel: Arc<AtomicBool>,
    next: Cell<u64>,
    pending: RefCell<HashSet<u64>>,
    slice: Rc<Cell<Instant>>,
    report: RefCell<Option<Value>>,
}

fn stopped(message: impl Into<String>) -> Finished {
    Finished { report: None, stopped: Some(message.into()), state: None }
}

fn run(job: Job, host: &UnboundedSender<ToHost>, settles: mpsc::Receiver<Settle>, cancel: &Arc<AtomicBool>) -> Finished {
    let Ok(runtime) = Runtime::new() else { return stopped("could not start the JavaScript engine") };
    runtime.set_memory_limit(MEMORY_LIMIT);
    runtime.set_max_stack_size(STACK_LIMIT);
    let slice = Rc::new(Cell::new(Instant::now()));
    let over = Rc::new(Cell::new(false));
    // While the state is saved after a cancel, only the CPU slice applies.
    let saving = Rc::new(Cell::new(false));
    {
        let (slice, over, cancel, saving) = (slice.clone(), over.clone(), cancel.clone(), saving.clone());
        runtime.set_interrupt_handler(Some(Box::new(move || {
            if cancel.load(Ordering::Relaxed) && !saving.get() {
                return true;
            }
            if slice.get().elapsed() > CPU_SLICE {
                over.set(true);
                return true;
            }
            false
        })));
    }
    let Ok(context) = Context::full(&runtime) else { return stopped("could not start the JavaScript engine") };
    let shared = Rc::new(Shared {
        host: host.clone(),
        cancel: cancel.clone(),
        next: Cell::new(1),
        pending: RefCell::new(HashSet::new()),
        slice: slice.clone(),
        report: RefCell::new(None),
    });
    {
        let shared = shared.clone();
        runtime.set_host_promise_rejection_tracker(Some(Box::new(move |_ctx, _promise, reason, handled| {
            if !handled {
                let text = describe(&reason);
                let _ = shared.host.send(ToHost::Log { level: "unhandled".into(), text });
            }
        })));
    }

    // Set up the prelude and the code; `settle` and `state` stay reachable for the loop below.
    let setup = context.with(|ctx| -> Result<(Persistent<Function<'static>>, Persistent<Function<'static>>), String> {
        let host_object = host_functions(&ctx, &shared).map_err(|e| format!("engine setup failed: {e}"))?;
        let config = serde_json::json!({ "tools": job.tools, "tab": job.tab, "timeoutMs": job.timeout_ms, "globals": GLOBALS });
        let options = || {
            let mut options = EvalOptions::default();
            options.strict = false;
            options.filename = Some("browse-prelude.js".into());
            options
        };
        let prelude: Function = ctx.eval_with_options(PRELUDE, options()).map_err(|e| format!("prelude failed: {}", caught(&ctx, e)))?;
        let api: Object = prelude
            .call((host_object, config.to_string(), job.state.clone()))
            .map_err(|e| format!("prelude failed: {}", caught(&ctx, e)))?;
        let settle: Function = api.get("settle").map_err(|e| e.to_string())?;
        let start: Function = api.get("start").map_err(|e| e.to_string())?;
        let fail: Function = api.get("fail").map_err(|e| e.to_string())?;
        let save: Function = api.get("saveState").map_err(|e| e.to_string())?;
        shared.slice.set(Instant::now());
        match compile(&ctx, &job.code) {
            Ok(function) => {
                let _: rquickjs::Result<JsValue> = start.call((function,));
            }
            Err(error) => {
                let _: rquickjs::Result<JsValue> = fail.call((error,));
            }
        }
        Ok((Persistent::save(&ctx, settle), Persistent::save(&ctx, save)))
    });
    let (settle, save) = match setup {
        Ok(functions) => functions,
        Err(message) => return stopped(message),
    };

    let save_state = |context: &Context| -> Option<String> {
        // A fresh slice, so an interrupted run can still hand back its state.
        slice.set(Instant::now());
        saving.set(true);
        let state = context.with(|ctx| {
            let save = save.clone().restore(&ctx).ok()?;
            save.call::<_, Option<String>>(()).ok().flatten()
        });
        saving.set(false);
        state
    };

    loop {
        slice.set(Instant::now());
        loop {
            if over.get() || cancel.load(Ordering::Relaxed) {
                break;
            }
            match runtime.execute_pending_job() {
                Ok(true) => continue,
                Ok(false) => break,
                // An exception in a job is already handled by the promise machinery; an interrupt shows up here.
                Err(_) => continue,
            }
        }
        if cancel.load(Ordering::Relaxed) {
            return Finished { report: None, stopped: Some("cancelled".into()), state: save_state(&context) };
        }
        if over.get() {
            over.set(false);
            let state = save_state(&context);
            return Finished {
                report: None,
                stopped: Some(format!(
                    "Synchronous JavaScript ran for more than {} seconds without awaiting anything, so execute stopped it. Break long loops up with `await` (each browse call awaits), or do heavy work in the page with page.evaluate().",
                    CPU_SLICE.as_secs()
                )),
                state,
            };
        }
        if shared.report.borrow().is_some() {
            break;
        }
        if shared.pending.borrow().is_empty() {
            let state = save_state(&context);
            return Finished {
                report: None,
                stopped: Some("The code is waiting on a promise that nothing will ever settle (no browse call or timer is pending), so execute ended it.".into()),
                state,
            };
        }
        let Ok(message) = settles.recv() else {
            return Finished { report: None, stopped: Some("cancelled".into()), state: save_state(&context) };
        };
        if !shared.pending.borrow_mut().remove(&message.id) {
            continue;
        }
        slice.set(Instant::now());
        context.with(|ctx| {
            let Ok(settle) = settle.clone().restore(&ctx) else { return };
            let (ok, json) = match message.result {
                Ok(value) => (true, value.to_string()),
                Err(error) => (false, Value::String(error).to_string()),
            };
            let _: rquickjs::Result<JsValue> = settle.call((message.id as f64, ok, json));
        });
    }
    let report = shared.report.borrow_mut().take();
    let state = save_state(&context);
    Finished { report, stopped: None, state }
}

/// The user's code as an async function taking the globals: a single expression is returned (`page.url()` gives
/// the URL), anything else runs as statements. The code starts on line 1 of execute.js.
fn compile<'js>(ctx: &Ctx<'js>, code: &str) -> Result<Function<'js>, JsValue<'js>> {
    let params = GLOBALS.join(", ");
    let trimmed = code.trim_end().trim_end_matches(';');
    let options = || {
        let mut options = EvalOptions::default();
        options.strict = false;
        options.filename = Some("execute.js".into());
        options
    };
    let expression = format!("(async function ({params}) {{ \"use strict\"; return await ({trimmed}\n) }})");
    if let Ok(function) = ctx.eval_with_options::<Function, _>(expression, options()) {
        return Ok(function);
    }
    let _ = ctx.catch();
    let statements = format!("(async function ({params}) {{ \"use strict\"; {code}\n}})");
    match ctx.eval_with_options::<Function, _>(statements, options()) {
        Ok(function) => Ok(function),
        Err(_) => Err(ctx.catch()),
    }
}

fn caught(ctx: &Ctx<'_>, error: rquickjs::Error) -> String {
    if error.is_exception() {
        return describe(&ctx.catch());
    }
    error.to_string()
}

fn describe(value: &JsValue<'_>) -> String {
    if let Some(exception) = value.as_exception() {
        let message = exception.message().unwrap_or_default();
        return match exception.stack() {
            Some(stack) if !stack.is_empty() => format!("{message}\n{stack}"),
            _ => message,
        };
    }
    value.get::<rquickjs::convert::Coerced<String>>().map(|s| s.0).unwrap_or_else(|_| "unknown error".into())
}

/// `host.async(op, json) → id`, `host.cancel(id)`, `host.sync(op, json) → json`, `host.log(level, text)` and
/// `host.finish(json)`: the only ways out of the engine.
fn host_functions<'js>(ctx: &Ctx<'js>, shared: &Rc<Shared>) -> rquickjs::Result<Object<'js>> {
    let object = Object::new(ctx.clone())?;
    let s = shared.clone();
    object.set(
        "async",
        Function::new(ctx.clone(), move |ctx: Ctx<'js>, op: String, payload: String| -> rquickjs::Result<f64> {
            let payload: Value = serde_json::from_str(&payload).map_err(|e| Exception::throw_type(&ctx, &e.to_string()))?;
            let id = s.next.get();
            s.next.set(id + 1);
            s.pending.borrow_mut().insert(id);
            if s.host.send(ToHost::Async { id, op, payload }).is_err() {
                return Err(Exception::throw_message(&ctx, "execute has ended"));
            }
            Ok(id as f64)
        })?,
    )?;
    let s = shared.clone();
    object.set(
        "cancel",
        Function::new(ctx.clone(), move |id: f64| {
            s.pending.borrow_mut().remove(&(id as u64));
        })?,
    )?;
    let s = shared.clone();
    object.set(
        "sync",
        Function::new(ctx.clone(), move |ctx: Ctx<'js>, op: String, payload: String| -> rquickjs::Result<String> {
            let payload: Value = serde_json::from_str(&payload).map_err(|e| Exception::throw_type(&ctx, &e.to_string()))?;
            let (reply, answer) = mpsc::channel();
            if s.host.send(ToHost::Sync { op, payload, reply }).is_err() {
                return Err(Exception::throw_message(&ctx, "execute has ended"));
            }
            let result = loop {
                match answer.recv_timeout(Duration::from_millis(200)) {
                    Ok(result) => break result,
                    Err(mpsc::RecvTimeoutError::Timeout) if !s.cancel.load(Ordering::Relaxed) => continue,
                    Err(_) => break Err("execute has ended".into()),
                }
            };
            // Time spent waiting on the browser isn't CPU time.
            s.slice.set(Instant::now());
            match result {
                Ok(value) => Ok(value.to_string()),
                Err(message) => Err(Exception::throw_message(&ctx, &message)),
            }
        })?,
    )?;
    let s = shared.clone();
    object.set(
        "log",
        Function::new(ctx.clone(), move |level: String, text: Rest<String>| {
            let _ = s.host.send(ToHost::Log { level, text: text.0.join(" ") });
        })?,
    )?;
    let s = shared.clone();
    object.set(
        "finish",
        Function::new(ctx.clone(), move |json: String| {
            *s.report.borrow_mut() = Some(serde_json::from_str(&json).unwrap_or(Value::Null));
        })?,
    )?;
    Ok(object)
}
