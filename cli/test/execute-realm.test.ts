import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { assertExecuteFilePath, checkHostCall, createExecuteFiles, ExecuteRealm, handleExecuteRealmRejection } from "../src/execute-realm.ts"
import { isInside, isInstallSibling, prepareExecuteFileOutputs } from "../src/execute-realm/file-roots.ts"
import { cacheRoot, configRoot, dataRoot, installedBinaryPath, installerBinaryPath, stateRoot } from "../src/paths.ts"
import { handleRelayProcessFault } from "../src/relay/process-guard.ts"
import { legacyDataRoot } from "../src/setup/legacy.ts"

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "browse-realm-"))
const home = path.join(scratch, "home")
let previousHome: string | undefined

beforeAll(() => {
  previousHome = process.env.OPENCODE_BROWSER_HOME
  process.env.OPENCODE_BROWSER_HOME = home
  fs.mkdirSync(home, { recursive: true })
})
afterAll(() => {
  if (previousHome === undefined) delete process.env.OPENCODE_BROWSER_HOME
  else process.env.OPENCODE_BROWSER_HOME = previousHome
  fs.rmSync(scratch, { recursive: true, force: true })
})

/** Runs `body` as an async function in a fresh realm with `host` as its only argument. */
function run(body: string, host: Record<string, unknown> = {}) {
  return new ExecuteRealm().run({ source: `(async (host) => { ${body} })`, filename: "test.js", args: [host] })
}

type NodeOutcome = { readonly value?: unknown; readonly error?: string; readonly elapsedMs?: number; readonly maxStallMs?: number; readonly stopped?: string; readonly warnings?: readonly string[] }

// The relay runs execute code under Node, whose vm differs from Bun's: escape attempts run there too.
function runInNode(bodies: readonly string[], setup = "", env: Record<string, string> = {}): NodeOutcome[] {
  const script = `
    const { ExecuteRealm, sandboxModules, createExecuteFiles, handleExecuteRealmRejection, handleExecuteRealmException } = await import(${JSON.stringify(path.join(import.meta.dir, "../src/execute-realm.ts"))})
    // The relay's process guard, reduced to the execute part.
    process.on('unhandledRejection', (reason, promise) => { if (!handleExecuteRealmRejection(promise, reason)) throw reason })
    process.on('uncaughtException', (error) => { if (!handleExecuteRealmException(error)) { console.error(error); process.exit(70) } })
    const host = { fn: () => 1, object: { nested: true }, error: () => { throw new Error("host") } }
    ${setup}
    const results = []
    for (const body of JSON.parse(process.argv[1])) {
      const warnings = []
      const realm = new ExecuteRealm({ onUnhandledRejection: warning => warnings.push(warning) })
      // How long the relay's event loop (other sessions, the HTTP API) went without a turn.
      let last = performance.now(), maxStallMs = 0
      const probe = setInterval(() => { const now = performance.now(); maxStallMs = Math.max(maxStallMs, now - last); last = now }, 5)
      const started = performance.now()
      try {
        realm.proxyAsObject(host)
        if (host.files) realm.proxyAsObject(host.files)
        if (host.modules) realm.proxyAsObject(host.modules)
        const value = await realm.run({ source: "(async (host) => { " + body + " })", filename: "test.js", args: [host] })
        const elapsedMs = performance.now() - started
        await new Promise(resolve => setTimeout(resolve, 20)) // let the probe see the last stall, and a detached rejection land
        results.push({ value, elapsedMs, maxStallMs, stopped: realm.stopped?.message, warnings })
      } catch (error) {
        const elapsedMs = performance.now() - started
        await new Promise(resolve => setTimeout(resolve, 20))
        results.push({ error: String(error?.message ?? error), elapsedMs, maxStallMs, stopped: realm.stopped?.message, warnings })
      } finally {
        clearInterval(probe)
        realm.dispose()
        host.emitConsole?.()
        host.page?.removeAllListeners?.()
      }
    }
    console.log(JSON.stringify(results))
  `
  const child = spawnSync("node", ["--input-type=module", "--no-warnings", "-e", script, JSON.stringify(bodies)], { encoding: "utf8", timeout: 30_000, env: { ...process.env, OPENCODE_BROWSER_HOME: home, ...env } })
  if (child.status !== 0) throw new Error(`node failed: ${child.stderr}`)
  return JSON.parse(child.stdout.trim().split("\n").at(-1) ?? "[]") as NodeOutcome[]
}

/** Outcomes without timing, for exact comparisons. */
const values = (outcomes: readonly NodeOutcome[]) => outcomes.map(({ value, error }) => (error === undefined ? { value } : { error }))

/** Runs realm bodies in a Bun child with the relay's execute guard (Bun has no promiseHooks). */
function runInBun(bodies: readonly string[]): NodeOutcome[] {
  const script = `
    const { ExecuteRealm, handleExecuteRealmRejection } = await import(${JSON.stringify(path.join(import.meta.dir, "../src/execute-realm.ts"))})
    // The relay's execute guard: attributed rejections stop only their realm; unattributed ones are the generic
    // fallback (logged and counted, never rethrown).
    process.on('unhandledRejection', (reason, promise) => { handleExecuteRealmRejection(promise, reason) })
    process.on('uncaughtException', (error) => { console.error(error); process.exit(70) })
    const results = []
    for (const body of ${JSON.stringify(bodies)}) {
      const realm = new ExecuteRealm()
      try {
        const value = await realm.run({ source: "(async () => { " + body + " })", filename: "test.js", args: [] })
        await new Promise(resolve => setTimeout(resolve, 50))
        results.push({ value, stopped: realm.stopped?.message })
      } catch (error) {
        await new Promise(resolve => setTimeout(resolve, 50))
        results.push({ error: String(error?.message ?? error), stopped: realm.stopped?.message })
      } finally {
        realm.dispose()
      }
    }
    console.log(JSON.stringify(results))
  `
  const child = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 30_000, env: { ...process.env, OPENCODE_BROWSER_HOME: home } })
  if (child.status !== 0) throw new Error(`bun failed: ${child.stderr}`)
  return JSON.parse(child.stdout.trim().split("\n").at(-1) ?? "[]") as NodeOutcome[]
}

/** Runs full-Node execute code in a child with the relay's process guard, as OPENCODE_BROWSER_ALLOW_NODE=1 does. */
function runFullNodeExecute(code: string): { readonly value?: unknown; readonly warnings?: readonly string[] } {
  const script = `
    const { runUserCode } = await import(${JSON.stringify(path.join(import.meta.dir, "../src/execute/code-runner.ts"))})
    const { createExecuteFiles, handleExecuteRealmRejection } = await import(${JSON.stringify(path.join(import.meta.dir, "../src/execute-realm.ts"))})
    // Unattributed rejections are the process guard's generic fallback here, not a child-process failure.
    process.on('unhandledRejection', (reason, promise) => { handleExecuteRealmRejection(promise, reason) })
    process.on('uncaughtException', (error) => { console.error(error); process.exit(71) })
    const warnings = []
    const page = {
      on() { return page }, off() { return page },
      mainFrame() { return { url: () => "about:blank" } },
      url() { return "about:blank" }, isClosed() { return false },
    }
    const result = await runUserCode({
      code: ${JSON.stringify(code)},
      globals: { page, files: createExecuteFiles(), handoffTracker: { count: 0 }, modules: {} },
      onUnhandledRejection: (warning) => warnings.push(warning),
    })
    await new Promise(resolve => setTimeout(resolve, 100))
    console.log(JSON.stringify({ value: result.result, warnings }))
  `
  const child = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 15_000, env: { ...process.env, OPENCODE_BROWSER_HOME: home } })
  if (child.status !== 0) throw new Error(`execute child failed: ${child.stderr}`)
  return JSON.parse(child.stdout.trim().split("\n").at(-1) ?? "{}")
}

describe("ExecuteRealm", () => {
  test("runs code and returns plain data", async () => {
    expect(await run("return { sum: 1 + 2, list: [host.value, 'b'] }", { value: "a" })).toEqual({ sum: 3, list: ["a", "b"] })
  })

  test("under Node: no process, require or import(), and constructor chains cannot generate code", () => {
    const [globals, importCall, ...escapes] = runInNode([
      "return [typeof process, typeof require, typeof module, typeof globalThis.process, typeof Buffer]",
      "return await import('node:fs')",
      "return host.fn.constructor('return process')()",
      "return host.object.constructor.constructor('return process')()",
      "return Object.getPrototypeOf(host.fn).constructor('return process')()",
      "return (async () => {}).constructor('return process')()",
      "return eval('process')",
      "try { host.error() } catch (e) { return e.constructor.constructor('return process')() }",
      "Error.prepareStackTrace = (_, frames) => frames; try { host.error() } catch (e) { return typeof e.stack }",
    ])
    expect(globals?.value).toEqual(["undefined", "undefined", "undefined", "undefined", "function"])
    expect(importCall?.error).toMatch(/import\(\) is not available/)
    expect(escapes.slice(0, 6).map((outcome) => outcome.error)).toEqual(Array(6).fill(expect.stringMatching(/Code generation from strings disallowed/)))
    // Stack-trace hooks would hand out host call sites; the realm freezes them off.
    expect(escapes[6]?.value).toBe("string")
  })

  test("errors thrown by host code arrive as sandbox errors", async () => {
    const result = await run("try { host.error() } catch (e) { return [e instanceof Error, e.message] }", { error: () => { throw new Error("boom") } })
    expect(result).toEqual([true, "boom"])
  })

  test("state persists between runs of one realm", async () => {
    const realm = new ExecuteRealm()
    const call = (body: string) => realm.run({ source: `((state) => { ${body} })`, filename: "state.js", args: [undefined], sandboxArgs: new Map([[0, realm.state]]) })
    await call("state.count = 1")
    expect(await call("return ++state.count")).toBe(2)
  })
})

const playwrightShapes = `
  const { EventEmitter } = await import('node:events')
  class Route { async fetch() { return 'UNSAFE' }; async fulfill(options) { return options } }
  class Page extends EventEmitter {
    constructor() { super(); this.keyboard = new Keyboard(); this.mouse = new Mouse() }
    async screenshot(options) { return options }
    async pdf(options) { return options }
    async bringToFront() { return 'UNSAFE' }
    async setInputFiles(selector, files) { return files }
    async goto() {}
    context() { return new BrowserContext() }
    locator() { return new Locator() }
    async route(pattern, handler) { await handler(new Route(), new Request()) }
    get request() { return new APIRequestContext() }
  }
  class BrowserContext { async storageState(options) { return options }; async newPage(options) { return options }; get request() { return new APIRequestContext() }; get tracing() { return new Tracing() } }
  class Locator { async setInputFiles(files) { return files } }
  class ElementHandle extends Locator {}
  class Frame extends Page {}
  class Response {}
  class Request {}
  class Keyboard {}
  class Mouse {}
  class APIRequestContext {}
  class Tracing {}
  class Download {}
  class Video {}
  host.page = new Page()
  host.context = new BrowserContext()
  host.locator = new Locator()
  host.elementHandle = new ElementHandle()
  host.frame = new Frame()
  host.response = new Response()
  host.request = new Request()
  host.route = new Route()
  host.files = createExecuteFiles()
  host.modules = sandboxModules
  host.buffer = Buffer.from('safe')
  host.url = new URL('https://example.test')
  host.download = () => new Download()
  host.video = () => new Video()
  host.getter = new class { get object() { return host.page } }()
  host.emitConsole = () => host.page.emit('console', host.response)
  host.thenable = () => ({ then(resolve) { resolve(host.page) } })
  host.later = () => new Promise(resolve => setTimeout(() => resolve(42), 5))
  // Like Playwright: events arrive from a WebSocket message, outside any execute call.
  host.emitConsoleLater = () => { setTimeout(() => host.page.emit('console', host.response), 5) }
  // A host timer that does not catch, like a wrapper that replaces the realm's own timers.
  host.hostTimer = (callback) => { setTimeout(callback, 5) }
`

describe("Node escape corpus", () => {
  const objects = ["host", "host.page", "host.context", "host.locator", "host.elementHandle", "host.frame", "host.response", "host.request", "host.route", "host.page.keyboard", "host.page.mouse", "host.buffer", "host.url", "host.modules", "host.files", "host.getter.object", "Buffer", "URL", "host.modules.events", "host.modules.events.prototype", "host.modules.stream.prototype", ...["path", "url", "util", "crypto", "buffer", "zlib", "stream"].map(name => `host.modules.${name}`)]

  test("all host proxy mutation traps refuse instances, functions, namespaces and prototypes", () => {
    const outcomes = runInNode(objects.map((object) => `
      'use strict';
      const value = ${object};
      const denied = [];
      for (const target of [value, Object.getPrototypeOf(value)].filter(target => ![Object.prototype, Function.prototype, Uint8Array].includes(target))) {
        for (const mutate of [
          () => { target.realmMarker = 1 },
          () => Object.defineProperty(target, 'realmMarker', {value:1}),
          () => { delete target.realmMarker },
          () => Object.setPrototypeOf(target, null),
          () => Object.preventExtensions(target),
        ]) { try { mutate(); denied.push(false) } catch(e) { denied.push(e instanceof TypeError) } }
      }
      return denied;
    `), playwrightShapes)
    // Intrinsic prototypes are sandbox-local copies, not host proxies, and are intentionally mutable.
    objects.forEach((object, index) => {
      const denied = outcomes[index]?.value as boolean[]
      expect(denied?.length, object).toBeGreaterThanOrEqual(5)
      expect(denied?.every(Boolean), object).toBe(true)
    })
  })

  test("constructor chains, getters and event/route arguments never expose the host realm", () => {
    const outcomes = runInNode([
      ...objects.map((object) => `return ${object}.constructor.constructor('return process')()`),
      "return Object.getOwnPropertyDescriptor(Object.getPrototypeOf(host.getter), 'object').get.call(host.getter).constructor.constructor('return process')()",
      "await host.page.route('**/*', (route) => route.constructor.constructor('return process')())",
      "host.page.on('console', response => response.constructor.constructor('return process')()); host.emitConsole()",
      "host.page.once('console', response => response.constructor.constructor('return process')()); host.emitConsole()",
      "return (await host.thenable()).constructor.constructor('return process')()",
    ], playwrightShapes)
    outcomes.forEach((outcome, index) => expect(outcome.error, `constructor ${index}`).toMatch(/Code generation from strings disallowed/))
  })

  test("direct, call, apply, bind and Reflect.apply all enforce the real target policy", () => {
    const invocations = [
      "fn.call(receiver, ...args)", "fn.apply(receiver, args)", "fn.bind(receiver)(...args)",
      "Reflect.apply(fn, receiver, args)", "Function.prototype.call.call(fn, receiver, ...args)",
      "Function.prototype.apply.call(fn, receiver, args)", "Reflect.apply(Function.prototype.apply, fn, [receiver, args])",
      "Reflect.apply(fn.bind(receiver, ...args), null, [])",
    ]
    const methods = [
      ["host.page", "screenshot", '[{path:"/etc/realm-denied"}]'],
      ["host.page", "pdf", '[{path:"/etc/realm-denied"}]'],
      ["host.context", "storageState", '[{path:"/etc/realm-denied"}]'],
      ["host.locator", "setInputFiles", '["/etc/realm-denied"]'],
      ["host.page", "setInputFiles", '["input", "/etc/realm-denied"]'],
      ["host.page", "bringToFront", '[]'],
      ["host.route", "fetch", '[]'],
      ["host.route", "fulfill", '[{path:"/etc/realm-denied"}]'],
      ["host.route", "fulfill", '[{response:{}}]'],
    ]
    const outcomes = runInNode(methods.flatMap(([receiver, method, args]) => invocations.map((invoke) => `const receiver = ${receiver}; const fn = receiver.${method}; const args = ${args}; return await (${invoke})`)), playwrightShapes)
    for (const outcome of outcomes) expect(outcome.error).toMatch(/outside the execute file roots|bringToFront\(\) is blocked|Node-side requests/)
  })

  test("Node-side HTTP/artifacts, shared receivers and option prototype spoofing are denied", () => {
    const outcomes = runInNode([
      "return host.page.request",
      "return host.context.request",
      "return host.context.tracing",
      "return host.download()",
      "return host.video()",
      "return host.context.newPage({recordHar:{path:host.files.path('record.har')}})",
      "return host.context.newPage({recordVideo:{dir:host.files.dir}})",
      "return host.page.screenshot(JSON.parse('{\"__proto__\":{},\"path\":\"/etc/realm-denied\"}'))",
      "return host.modules.events.prototype.setMaxListeners.call(host.modules.events.prototype, 42)",
      "return host.modules.util.inspect(host.page)",
      "return host.modules.crypto.setEngine('/etc/realm-denied')",
      "return host.modules.events.setMaxListeners(1, Object.getPrototypeOf(host.page))",
      "return host.modules.events.setMaxListeners(1)",
      "return await new Promise((resolve,reject)=>host.modules.util.callbackify(host.page.screenshot).call(host.page, {path:'/etc/realm-denied'}, (error,value)=>error?reject(error):resolve(value)))",
      "host.page.once('console', host.page.bringToFront); host.emitConsole()",
    ], playwrightShapes)
    for (const outcome of outcomes) expect(outcome.error).toMatch(/not available|outside the execute file roots|bringToFront\(\) is blocked/)
  })

  test("promise subclasses/species, proxy traps, stack hooks, clone and dynamic code stay contained", () => {
    const outcomes = runInNode([
      "class P extends Promise {}; return await new P(resolve => resolve(host.page)).then(page=>page.constructor.constructor('return process')())",
      "Object.defineProperty(Promise, Symbol.species, {get(){return host.fn.constructor('return process')()}}); return Promise.resolve(1).then(()=>1)",
      "return new Proxy(host.page, {get(target,key){return Reflect.get(target,key)}}).constructor.constructor('return process')()",
      "return host.fn(new Proxy({}, {ownKeys(){return host.fn.constructor('return process')()}}))",
      "Error.captureStackTrace(host.page); return host.page.stack",
      "'use strict'; Error.prepareStackTrace = (_, frames)=>frames",
      "return (async function*(){})().constructor.constructor('return process')()",
      "return structuredClone(host.page)",
      "return new Function('return process')()",
      "return eval('process')",
      "return import('node:fs')",
    ], playwrightShapes)
    outcomes.forEach((outcome, index) => expect(outcome.error, `escape ${index}: ${JSON.stringify(outcome)}`).toBeDefined())
    expect(runInNode(["return [typeof Atomics,typeof SharedArrayBuffer,typeof WeakRef,typeof FinalizationRegistry]"])[0]?.value).toEqual(Array(4).fill("undefined"))
  })

  // N18: every way execute JavaScript gets the CPU is bounded by one slice, so a runaway loop
  // stalls the relay (and every other session) for at most OPENCODE_BROWSER_EXECUTE_SLICE_MS.
  test("CPU slices bound loops in code, awaits, callbacks, timers, events, getters and thenables", () => {
    const sliceMs = 200
    const cases: Record<string, string> = {
      "sync code": "while(true){}",
      "async function after await": "await Promise.resolve(); while(true){}",
      "after awaiting a host promise": "await host.later(); while(true){}",
      "inside an awaited async function": "await (async () => { await host.later(); while(true){} })()",
      "promise callback": "await host.later().then(() => { while(true){} })",
      "sandbox promise callback": "Promise.resolve().then(() => { while(true){} }); await host.later()",
      "queueMicrotask": "await new Promise(resolve=>queueMicrotask(()=>{while(true){}}))",
      "setTimeout callback": "await new Promise(resolve=>setTimeout(()=>{while(true){}},0))",
      "setInterval callback": "setInterval(()=>{while(true){}},1); await new Promise(()=>{})",
      "uncaught host timer": "host.hostTimer(()=>{while(true){}}); await new Promise(()=>{})",
      "route handler": "await host.page.route('**/*', ()=>{while(true){}})",
      "page.on handler (emitted in a call)": "host.page.on('console', ()=>{while(true){}}); host.emitConsole()",
      "page.on handler (emitted later)": "host.page.on('console', ()=>{while(true){}}); host.emitConsoleLater(); await new Promise(()=>{})",
      "async page.on handler after await": "host.page.on('console', async ()=>{ await host.later(); while(true){} }); host.emitConsoleLater(); await new Promise(()=>{})",
      "getter on the result": "return {get value(){while(true){}}}",
      "getter on a thrown value": "throw {get message(){while(true){}}}",
      "thenable result": "return {then(){while(true){}}}",
      "catastrophic regex": "return /^(a+)+$/.test('a'.repeat(40) + 'b')",
    }
    const outcomes = runInNode(Object.values(cases), playwrightShapes, { OPENCODE_BROWSER_EXECUTE_SLICE_MS: String(sliceMs) })
    Object.keys(cases).forEach((name, index) => {
      const outcome = outcomes[index]!
      expect(outcome.error, name).toMatch(/synchronous CPU budget: JavaScript ran for over 200ms without yielding/)
      expect(outcome.error, name).toMatch(/OPENCODE_BROWSER_EXECUTE_SLICE_MS/)
      // One slice plus scheduling noise; never the whole execute timeout.
      expect(outcome.maxStallMs!, name).toBeGreaterThan(sliceMs * 0.8)
      expect(outcome.maxStallMs!, name).toBeLessThan(sliceMs + 250)
      expect(outcome.elapsedMs!, name).toBeLessThan(sliceMs * 3 + 500)
    })
  }, 30_000)

  test("busy timers that yield between slices hit the sustained budget without starving the relay", () => {
    const sliceMs = 100
    const [outcome] = runInNode([
      `setInterval(() => { const end = performance.now() + ${sliceMs * 0.9}; while (performance.now() < end) {} }, 0); await new Promise(()=>{})`,
    ], "", { OPENCODE_BROWSER_EXECUTE_SLICE_MS: String(sliceMs) })
    expect(outcome?.error).toMatch(/sustained CPU budget/)
    expect(outcome!.maxStallMs!).toBeLessThan(sliceMs + 250)
    // Stopped within a couple of slices (the window is three slice lengths), not after a long burst allowance.
    expect(outcome!.elapsedMs!).toBeLessThan(sliceMs * 6)
  }, 30_000)

  test("a few heavy operations back to back stay under the sustained budget", () => {
    const sliceMs = 200
    const busy = (fraction: number) => `{ const end = performance.now() + ${sliceMs * fraction}; while (performance.now() < end) {} }`
    const pause = (ms: number) => `await new Promise(r => setTimeout(r, ${ms}));`
    const [outcome] = runInNode([
      // One near-full slice, then a burst of three heavy operations, a rest, and another burst.
      `${busy(0.8)} ${pause(0)} ${busy(0.3)} ${pause(4 * sliceMs)}` +
      `for (let i = 0; i < 3; i++) { ${busy(0.4)} ${pause(0)} } ${pause(4 * sliceMs)}` +
      `for (let i = 0; i < 3; i++) { ${busy(0.4)} ${pause(0)} } return "done"`,
    ], "", { OPENCODE_BROWSER_EXECUTE_SLICE_MS: String(sliceMs) })
    expect(outcome?.error).toBeUndefined()
    expect(outcome?.value).toBe("done")
  }, 30_000)

  test("the default slice fits heavy but legitimate execute code", () => {
    const outcomes = runInNode([
      "const text = JSON.stringify(Array.from({length:60000},(_, i)=>({i, name:'item '+i, tags:['a','b','c'], nested:{x:i, y:'y'.repeat(16)}}))); return [text.length > 5e6, JSON.parse(text).length]",
      "const items = Array.from({length:200000},()=>Math.random().toString(36)); items.sort((a,b)=>a.localeCompare(b)); return items.length",
      "const text = 'lorem ipsum dolor sit amet foo@example.com\\n'.repeat(120000); return [[...text.matchAll(/[\\w.]+@[\\w.]+/g)].length, text.split(/\\s+/).length > 600000]",
      "const snap = Array.from({length:30000},(_, i)=>'- button \"Item '+i+'\" [ref=e'+i+']').join('\\n'); return snap.split('\\n').map(line => line.match(/ref=(e\\d+)/)[1]).length",
      "return Array.from({length:100000},(_, i)=>({i, text:'row '+i})).length",
    ])
    expect(values(outcomes)).toEqual([{ value: [true, 60000] }, { value: 200000 }, { value: [120000, true] }, { value: 30000 }, { value: 100000 }])
  }, 30_000)

  test("Buffer backing stores contain only the view, and unsafe allocation is zeroed", () => {
    const outcomes = runInNode([
      "const value=Buffer.from('x'); return [value.buffer.byteLength, value.length, new TextDecoder().decode(value.buffer).includes('REALM_FAKE_SECRET')]",
      "return [host.buffer.buffer.byteLength, host.buffer.length]",
      "return [Buffer.allocUnsafe(64),Buffer.allocUnsafeSlow(64),...(typeof host.modules.buffer.SlowBuffer==='function'?[host.modules.buffer.SlowBuffer(64)]:[])].every(value=>value.every(byte=>byte===0))",
    ], playwrightShapes + "; const marker = Buffer.from('REALM_FAKE_SECRET'.repeat(10));")
    expect(values(outcomes)).toEqual([{ value: [1, 1, false] }, { value: [4, 4] }, { value: true }])
  })

  test("frozen globals and detached rejections stop only their own realm", () => {
    const outcomes = runInNode([
      "const later = host.later(); Object.preventExtensions(globalThis); return await later",
      "const later = host.later(); Object.freeze(globalThis); return await later",
      "Promise.reject(new Error('detached')); await new Promise(()=>{})",
      "setTimeout(async()=>{throw new Error('timer')},0); await new Promise(()=>{})",
      "host.page.on('console', async()=>{throw new Error('listener')}); host.emitConsole(); await new Promise(()=>{})",
      "setTimeout(()=>{throw new Error('timer')},0); await new Promise(()=>{})",
      "globalThis.globalThis = {}; return await host.later()",
      // Host callers that do not catch: an emitter firing outside any execute call, a foreign timer.
      "host.page.on('console', ()=>{throw new Error('listener')}); host.emitConsoleLater(); await new Promise(()=>{})",
      "host.hostTimer(()=>{throw 1}); await new Promise(()=>{})",
      "host.hostTimer(async()=>{throw new Error('async')}); await new Promise(()=>{})",
    ], playwrightShapes)
    // The child exits with an error if any of these reached the process as a relay fault.
    for (const outcome of [...outcomes.slice(0, 6), ...outcomes.slice(7)]) {
      expect(outcome.error).toMatch(/non-extensible|Unhandled execute rejection|timer callback failed|Uncaught exception in an execute callback/)
    }
    expect(outcomes[6]?.value).toBe(42)
  })

  test("an un-awaited helper rejection stops only its realm, is reported, and the call still returns", () => {
    const [outcome] = runInNode([
      `host.files.write("/tmp/some-file", "x"); return { ok: true }`,
    ], playwrightShapes)
    expect(outcome?.value).toEqual({ ok: true })
    expect(outcome?.stopped).toMatch(/Unhandled execute rejection: files\.write: use a private subdirectory/)
    // The call already returned, so this arrives through the sandbox's warning queue, not as its error.
    expect(outcome?.warnings?.join("\n")).toContain("files.write: use a private subdirectory")
  })

  test("a hostile rejection value is never described on the host", () => {
    const [throwing, looping] = runInNode([
      `Promise.reject({ toString() { throw new Error("boom") } }); return 1`,
      `Promise.reject({ toString() { for(;;){} } }); return 1`,
    ])
    for (const outcome of [throwing, looping]) {
      expect(outcome?.value).toBe(1)
      expect(outcome?.stopped).toMatch(/Unhandled execute rejection: reason not shown/)
    }
  }, 30_000)

  test.skipIf(!process.versions.bun)("a hostile rejection value is never described on the host under Bun", () => {
    const outcomes = runInBun([
      `Promise.reject({ toString() { throw new Error("boom") } }); return 1`,
      `Promise.reject({ toString() { for(;;){} } }); return 1`,
    ])
    for (const outcome of outcomes) {
      expect(outcome?.value).toBe(1)
      expect(outcome?.stopped).toMatch(/Unhandled execute rejection: reason not shown/)
    }
  }, 30_000)

  test("full Node execute under Bun returns its value and leaves a late rejection to the generic guard", () => {
    const outcome = runFullNodeExecute(`files.write("/tmp/some-file", "x"); return { ok: true }`)
    expect(outcome.value).toEqual({ ok: true })
    // Bun has no promiseHooks, so full-Node execute gets no per-call warning; the process guard still contains it.
    expect(outcome.warnings ?? []).toEqual([])
  })

  test.skipIf(!process.versions.bun)("a stopped realm does not claim an untagged late promise under Bun", async () => {
    const realm = new ExecuteRealm()
    expect(await realm.run({ source: "(async () => 1)", filename: "test.js", args: [] })).toBe(1)
    // `execute --rm` disposes the realm; a promise that is not a realm Promise must not be blamed on it.
    realm.dispose(new Error("Session deleted after execute --rm"))
    const late = Promise.reject(new Error("late host promise"))
    void late.catch(() => {}) // attribution is what this test checks; don't raise a real unhandled event here
    expect(handleExecuteRealmRejection(late, new Error("late host promise"))).toBe(false)
  })

  test("a hostile unattributed rejection is logged without running its toString", () => {
    let called = false
    const reason = { toString() { called = true; throw new Error("boom") } }
    const rethrown: unknown[] = []
    expect(() => handleRelayProcessFault("unhandledRejection", reason, {}, { rethrow: (cause) => { rethrown.push(cause); throw cause } })).not.toThrow()
    expect(called).toBe(false)
    expect(rethrown).toEqual([])
  })

  test("a rejection with no execute owner is logged and counted, not rethrown", () => {
    const rethrown: unknown[] = []
    const rethrow = (cause: unknown): never => { rethrown.push(cause); throw cause }
    expect(() => handleRelayProcessFault("unhandledRejection", new Error("detached relay-side promise"), {}, { rethrow })).not.toThrow()
    expect(rethrown).toEqual([])
    // A synchronous programming fault in the relay still stops it.
    expect(() => handleRelayProcessFault("uncaughtException", new Error("relay bug"), {}, { rethrow })).toThrow("relay bug")
  })

  test("the files helper stays inside its roots through symlinks from sandbox code", () => {
    const outcomes = runInNode([
      "return await host.files.read('link-etc/hosts')",
      "return await host.files.write('link-etc/realm-denied', 'x')",
      "return host.files.path('link-etc/realm-denied.png')",
      "return await host.files.write('link-file', 'overwrite')",
      "return await host.files.read('link-file')",
      "return await host.page.screenshot({path: host.files.dir + '/link-etc/realm-denied.png'})",
      "return await host.files.write(host.modules.path.join(host.files.dir, 'ok.txt'), 'fine').then(() => host.files.read('ok.txt', 'utf8'))",
    ], playwrightShapes + `
      const fs = await import('node:fs')
      const target = await host.files.write('target.txt', 'untouched')
      fs.symlinkSync('/etc', host.files.dir + '/link-etc')
      fs.symlinkSync(target, host.files.dir + '/link-file')
      process.on('exit', () => fs.rmSync(host.files.dir, { recursive: true, force: true }))
    `)
    outcomes.slice(0, 6).forEach((outcome, index) => expect(outcome.error, `files ${index}`).toMatch(/symlink|outside the execute file roots|private subdirectory/))
    expect(outcomes[6]?.value).toBe("fine")
  })
})

/** A browser whose tracing only stores the path, like Playwright's browser tracing. */
class FakeTraceBrowser {
  trace: string | undefined
  failStart = false
  async startTracing(_page: unknown, options: { path?: string } = {}) {
    if (this.failStart) throw new Error("start failed")
    this.trace = options.path
  }
  async stopTracing() {
    if (!this.trace) return Buffer.alloc(0)
    fs.mkdirSync(path.dirname(this.trace), { recursive: true })
    fs.writeFileSync(this.trace, "trace")
    return Buffer.alloc(0)
  }
}

describe("execute file access", () => {
  test("files writes and reads inside its directory", async () => {
    const files = createExecuteFiles()
    const written = await files.write("realm-test.txt", "hello")
    expect(written.startsWith(files.dir)).toBe(true)
    expect(String(await files.read("realm-test.txt"))).toBe("hello")
    expect(fs.statSync(written).mode & 0o777).toBe(0o600)
    fs.rmSync(written)
  })

  test("refuses paths outside the temp roots, relative paths and symlinks out", async () => {
    const files = createExecuteFiles()
    await expect(files.read("/etc/hosts")).rejects.toThrow(/outside the execute file roots/)
    await expect(files.write(path.join(os.homedir(), ".zshrc-browse-test"), "x")).rejects.toThrow(/outside the execute file roots/)
    expect(() => files.path("../../../etc/passwd")).toThrow(/outside the execute file roots/)
    expect(() => assertExecuteFilePath("relative.png", "screenshot")).toThrow(/absolute path/)
    const link = path.join(scratch, "escape")
    fs.symlinkSync("/etc", link)
    expect(() => assertExecuteFilePath(path.join(link, "hosts"), "files.read")).toThrow(/outside the execute file roots/)
  })

  test("refuses browse's own folders even inside a temp root", async () => {
    const files = createExecuteFiles()
    fs.writeFileSync(path.join(home, "relay-token"), "secret")
    await expect(files.read(path.join(home, "relay-token"))).rejects.toThrow(/browse's own files/)
  })

  test("refuses every browse root, the installed binary and its install siblings", () => {
    const xdg = fs.mkdtempSync(path.join(os.tmpdir(), "browse-realm-xdg-"))
    const variables = {
      XDG_CONFIG_HOME: path.join(xdg, "config"),
      XDG_DATA_HOME: path.join(xdg, "data"),
      XDG_STATE_HOME: path.join(xdg, "state"),
      XDG_CACHE_HOME: path.join(xdg, "cache"),
      XDG_BIN_HOME: path.join(xdg, "bin"),
    } satisfies NodeJS.ProcessEnv
    const names = Object.keys(variables) as Array<keyof typeof variables>
    const saved = new Map(names.map((name) => [name, process.env[name]]))
    const savedBrowseHome = process.env.OPENCODE_BROWSER_HOME
    // paths.ts honours XDG variables against the default home; drop OPENCODE_BROWSER_HOME so each root is separate.
    delete process.env.OPENCODE_BROWSER_HOME
    Object.assign(process.env, variables)
    try {
      for (const root of [configRoot(), dataRoot(), stateRoot(), cacheRoot()]) {
        const file = path.join(root, "secret.json")
        fs.mkdirSync(root, { recursive: true })
        fs.writeFileSync(file, "secret")
        expect(() => assertExecuteFilePath(file, "files.read")).toThrow(/inside browse's own files/)
      }

      const binary = installedBinaryPath()
      fs.mkdirSync(path.dirname(binary), { recursive: true })
      fs.writeFileSync(binary, "binary", { mode: 0o755 })
      for (const denied of [
        binary, `${binary}.new`, `${binary}.${process.pid}.new`, `${binary}.old-0123abcd`, `${binary}.migrate-${process.pid}`,
        `${binary}.new/payload`, `${binary}.old-1/x`,
      ]) {
        expect(() => assertExecuteFilePath(denied, "files.write")).toThrow(/inside browse's own files/)
      }
      // A child literally named `..bypass` is inside the root, not a way out of it.
      expect(() => assertExecuteFilePath(path.join(stateRoot(), "..bypass"), "files.write")).toThrow(/inside browse's own files/)

      // Staging lands beside the resolved install folder even when the bin folder and the binary are both symlinks.
      const realBin = path.join(xdg, "real-bin")
      fs.mkdirSync(realBin, { recursive: true })
      fs.rmSync(variables.XDG_BIN_HOME, { recursive: true, force: true })
      fs.symlinkSync(realBin, variables.XDG_BIN_HOME)
      fs.writeFileSync(path.join(realBin, "browse-target"), "binary", { mode: 0o755 })
      fs.symlinkSync(path.join(realBin, "browse-target"), path.join(realBin, "browse"))
      for (const staging of [path.join(variables.XDG_BIN_HOME, "browse.new"), path.join(realBin, "browse.new")]) {
        expect(() => assertExecuteFilePath(staging, "files.write")).toThrow(/inside browse's own files/)
      }

      // Migration copies these roots into the live ones on the next run, so execute code must not stage files there.
      const legacyData = path.join(variables.XDG_DATA_HOME, "opencode-browser")
      fs.mkdirSync(legacyData, { recursive: true })
      const legacyFile = path.join(legacyData, "relay-token")
      fs.writeFileSync(legacyFile, "secret")
      expect(() => assertExecuteFilePath(legacyFile, "files.read")).toThrow(/inside browse's own files/)
      expect(() => assertExecuteFilePath(path.join(os.homedir(), ".browse", "bin", "browse"), "files.read"))
        .toThrow(/inside browse's own files/)

      const unrelated = path.join(xdg, "unrelated.txt")
      fs.writeFileSync(unrelated, "fine")
      expect(assertExecuteFilePath(unrelated, "files.read")).toBe(fs.realpathSync(unrelated))
      const sibling = path.join(realBin, "other-tool")
      fs.writeFileSync(sibling, "fine")
      expect(assertExecuteFilePath(sibling, "files.read")).toBe(fs.realpathSync(sibling))
    } finally {
      for (const name of names) {
        const value = saved.get(name)
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
      if (savedBrowseHome === undefined) delete process.env.OPENCODE_BROWSER_HOME
      else process.env.OPENCODE_BROWSER_HOME = savedBrowseHome
      fs.rmSync(xdg, { recursive: true, force: true })
    }
  })

  test("refuses the everyday folders and installer binary while OPENCODE_BROWSER_HOME points elsewhere", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "browse-realm-override-"))
    const variables = {
      OPENCODE_BROWSER_HOME: path.join(root, "home"),
      XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_DATA_HOME: path.join(root, "data"),
      XDG_STATE_HOME: path.join(root, "state"),
      XDG_CACHE_HOME: path.join(root, "cache"),
      XDG_BIN_HOME: path.join(root, "bin"),
    } satisfies NodeJS.ProcessEnv
    const names = Object.keys(variables) as Array<keyof typeof variables>
    const saved = new Map(names.map((name) => [name, process.env[name]]))
    Object.assign(process.env, variables)
    try {
      // The override's own folders stay denied.
      const overrideFile = path.join(variables.OPENCODE_BROWSER_HOME, "pairing-codes.json")
      fs.mkdirSync(variables.OPENCODE_BROWSER_HOME, { recursive: true })
      fs.writeFileSync(overrideFile, "{}")
      expect(() => assertExecuteFilePath(overrideFile, "files.read")).toThrow(/inside browse's own files/)

      // So do the everyday XDG folders the override hides from paths.ts.
      const state = path.join(variables.XDG_STATE_HOME, "browse", "pairing-codes.json")
      fs.mkdirSync(path.dirname(state), { recursive: true })
      fs.writeFileSync(state, "{}")
      expect(() => assertExecuteFilePath(state, "files.read")).toThrow(/inside browse's own files/)

      // The installer still writes its binary at the installer path, not under the override.
      const installer = installerBinaryPath()
      expect(installer).toBe(path.join(variables.XDG_BIN_HOME, path.basename(installer)))
      fs.mkdirSync(path.dirname(installer), { recursive: true })
      fs.writeFileSync(installer, "binary", { mode: 0o755 })
      expect(() => assertExecuteFilePath(installer, "files.write")).toThrow(/inside browse's own files/)
      expect(() => assertExecuteFilePath(`${installer}.new/payload`, "files.write")).toThrow(/inside browse's own files/)
    } finally {
      for (const name of names) {
        const value = saved.get(name)
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test.skipIf(process.platform === "win32")("legacyDataRoot ignores an empty or relative XDG_DATA_HOME", () => {
    const saved = process.env.XDG_DATA_HOME
    try {
      for (const value of ["", "relative/data"]) {
        process.env.XDG_DATA_HOME = value
        expect(legacyDataRoot()).toBe(path.join(os.homedir(), ".local", "share", "opencode-browser"))
      }
      const absolute = path.join(scratch, "xdg-data")
      process.env.XDG_DATA_HOME = absolute
      expect(legacyDataRoot()).toBe(path.join(absolute, "opencode-browser"))
    } finally {
      if (saved === undefined) delete process.env.XDG_DATA_HOME
      else process.env.XDG_DATA_HOME = saved
    }
  })

  test("browse-owned checks ignore case where the platform's filesystem does", () => {
    for (const platform of ["darwin", "win32"] as const) {
      expect(isInside("/tmp/xdg/BROWSE/config.json", "/tmp/xdg/browse", platform), platform).toBe(true)
      expect(isInside("/TMP/xdg/browse/config.json", "/tmp/xdg/browse", platform), platform).toBe(true)
      for (const sibling of ["/bin/BROWSE.NEW", "/bin/browse.NEW", "/bin/Browse.Old-1", "/BIN/browse.new", "/bin/browse.MIGRATE-9"]) {
        expect(isInstallSibling(sibling, "/bin/browse", platform), `${platform} ${sibling}`).toBe(true)
      }
    }
    // Linux keeps paths case-sensitive, so these are different files and stay allowed.
    expect(isInside("/tmp/xdg/BROWSE/config.json", "/tmp/xdg/browse", "linux")).toBe(false)
    expect(isInstallSibling("/bin/BROWSE.NEW", "/bin/browse", "linux")).toBe(false)
    expect(isInstallSibling("/bin/browse.NEW", "/bin/browse", "linux")).toBe(false)
  })

  test("private helper directory and descriptor checks reject symlinks and hard links", async () => {
    const files = createExecuteFiles()
    const stat = fs.lstatSync(files.dir)
    expect(stat.isSymbolicLink()).toBe(false)
    expect(stat.mode & 0o777).toBe(0o700)
    if (process.getuid) expect(stat.uid).toBe(process.getuid())
    const target = await files.write(`descriptor-${process.pid}.txt`, "untouched")
    const symlink = `${target}.symlink`
    const hardlink = `${target}.hardlink`
    fs.symlinkSync(target, symlink)
    await expect(files.write(symlink, "overwrite")).rejects.toThrow(/symlink/)
    await expect(files.read(symlink)).rejects.toThrow(/symlink/)
    fs.linkSync(target, hardlink)
    await expect(files.write(hardlink, "overwrite")).rejects.toThrow(/hard links/)
    expect(fs.readFileSync(target, "utf8")).toBe("untouched")
    for (const file of [symlink, hardlink, target]) fs.unlinkSync(file)
  })

  test("Playwright calls with file options and bringToFront are checked", () => {
    function screenshot() {}
    function bringToFront() {}
    function send() {}
    expect(() => checkHostCall(screenshot, {}, [{ path: "/Users/someone/shot.png" }])).toThrow(/outside the execute file roots/)
    expect(() => checkHostCall(screenshot, {}, [{ path: createExecuteFiles().path("shot.png") }])).not.toThrow()
    expect(() => checkHostCall(bringToFront, {}, [])).toThrow(/bringToFront\(\) is blocked/)
    expect(() => checkHostCall(send, {}, ["Page.bringToFront"])).toThrow(/bringToFront\(\) is blocked/)
    expect(() => checkHostCall(send, {}, ["Page.navigate", { url: "https://example.com" }])).not.toThrow()
  })

  test.skipIf(process.platform === "win32")("Playwright file outputs are owner-only under a permissive umask", async () => {
    const files = createExecuteFiles()
    const output = path.join(files.dir, "shots", "nested", "page.png")
    const page = {
      // Like Playwright: recursive mkdir and writeFile, both filtered by the process umask.
      async screenshot(options: { path?: string }) {
        if (!options.path) return "buffer"
        fs.mkdirSync(path.dirname(options.path), { recursive: true })
        fs.writeFileSync(options.path, "png")
        return "saved"
      },
    }
    const previous = process.umask(0o002)
    try {
      const result = await run(`
        const saved = await host.page.screenshot({ path: host.files.path("shots/nested/page.png") });
        const output = host.files.path("shots/nested/page.png");
        return [saved, output, await host.files.read(output, "utf8")];
      `, { page, files })
      expect(result).toEqual(["saved", output, "png"])
    } finally {
      process.umask(previous)
    }
    expect(fs.statSync(path.join(files.dir, "shots")).mode & 0o777).toBe(0o700)
    expect(fs.statSync(path.join(files.dir, "shots", "nested")).mode & 0o777).toBe(0o700)
    expect(fs.statSync(output).mode & 0o777).toBe(0o600)
    fs.rmSync(path.join(files.dir, "shots"), { recursive: true, force: true })
  })

  test("checkHostCall collects outputs without touching the filesystem", async () => {
    const files = createExecuteFiles()
    const dir = path.join(files.dir, "unprepared")
    try {
      function screenshot() {}
      function start() {}
      function stop() {}
      const output = path.join(dir, "nested", "page.png")
      expect(checkHostCall(screenshot, {}, [{ path: output }]).outputs).toHaveLength(1)
      // Only top-level options count: a nested path is still checked, but it is not Playwright's output.
      expect(checkHostCall(screenshot, {}, [{ widget: { path: path.join(dir, "other.png") } }]).outputs).toHaveLength(0)
      // start/startChunk name intermediate folders; stop writes a path (tracing) or outputPath (network).
      expect(checkHostCall(start, {}, [{ path: output }]).outputs).toHaveLength(0)
      expect(checkHostCall(stop, {}, [{ path: output }]).outputs).toHaveLength(1)
      expect(checkHostCall(stop, {}, [{ outputPath: output }]).outputs).toHaveLength(1)
      expect(fs.existsSync(dir)).toBe(false)
      // Construct traps check but never prepare, even under a name Playwright writes files for.
      class Capture {
        readonly path: string | undefined
        constructor(options: { path?: string }) {
          this.path = options.path
        }
      }
      Object.defineProperty(Capture, "name", { value: "screenshot" })
      const captured = await run(`const capture = new host.screenshot({ path: host.files.path("unprepared/nested/page.png") }); return capture.path;`, { screenshot: Capture, files })
      expect(captured).toBe(output)
      expect(fs.existsSync(dir)).toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test.skipIf(process.platform === "win32")("an existing output file keeps its mode", async () => {
    const files = createExecuteFiles()
    const output = path.join(files.dir, "existing.png")
    try {
      fs.writeFileSync(output, "old", { mode: 0o640 })
      fs.chmodSync(output, 0o640)
      const page = {
        async screenshot(options: { path?: string }) {
          fs.writeFileSync(options.path!, "new")
        },
      }
      await run(`await host.page.screenshot({ path: host.files.path("existing.png") }); return null;`, { page, files })
      expect(fs.statSync(output).mode & 0o777).toBe(0o640)
    } finally {
      fs.rmSync(output, { force: true })
    }
  })

  test.skipIf(process.platform === "win32")("a failed output call still secures the file it created", async () => {
    const files = createExecuteFiles()
    const output = path.join(files.dir, "failed.png")
    const previous = process.umask(0o002)
    try {
      const page = {
        async screenshot(options: { path?: string }) {
          fs.writeFileSync(options.path!, "partial")
          throw new Error("capture failed")
        },
      }
      await expect(run(`await host.page.screenshot({ path: host.files.path("failed.png") }); return null;`, { page, files }))
        .rejects.toThrow("capture failed")
      expect(fs.statSync(output).mode & 0o777).toBe(0o600)
    } finally {
      process.umask(previous)
      fs.rmSync(output, { force: true })
    }
  })

  test.skipIf(process.platform === "win32")("a symlink at the output path is not chmodded", async () => {
    const files = createExecuteFiles()
    const outside = path.join(files.dir, "outside.txt")
    const output = path.join(files.dir, "linked.png")
    try {
      fs.writeFileSync(outside, "secret", { mode: 0o644 })
      fs.chmodSync(outside, 0o644)
      const page = {
        async screenshot(options: { path?: string }) {
          fs.symlinkSync(outside, options.path!)
        },
      }
      await run(`await host.page.screenshot({ path: host.files.path("linked.png") }); return null;`, { page, files })
      expect(fs.lstatSync(output).isSymbolicLink()).toBe(true)
      expect(fs.statSync(outside).mode & 0o777).toBe(0o644)
    } finally {
      fs.rmSync(output, { force: true })
      fs.rmSync(outside, { force: true })
    }
  })

  test.skipIf(process.platform === "win32")("an output through a symlinked folder is refused and creates nothing", () => {
    const files = createExecuteFiles()
    const outside = path.join(files.dir, "outside-folder")
    const link = path.join(files.dir, "linked-folder")
    try {
      fs.mkdirSync(outside)
      fs.symlinkSync(outside, link)
      const output = path.join(link, "nested", "page.png")
      expect(() => prepareExecuteFileOutputs({ outputs: [{ path: output }] })).toThrow(/owned directories/)
      expect(fs.existsSync(path.join(outside, "nested"))).toBe(false)
    } finally {
      fs.rmSync(link, { force: true })
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  test.skipIf(process.platform === "win32")("an output below a symlinked ancestor is refused even with an existing child", () => {
    const files = createExecuteFiles()
    const outside = path.join(files.dir, "outside-parent")
    const link = path.join(files.dir, "linked-parent")
    try {
      fs.mkdirSync(path.join(outside, "existing-child"), { recursive: true })
      fs.symlinkSync(outside, link)
      // The old walk stopped at the existing child and missed the symlink above it.
      const output = path.join(link, "existing-child", "nested", "page.png")
      expect(() => prepareExecuteFileOutputs({ outputs: [{ path: output }] })).toThrow(/owned directories/)
      expect(fs.existsSync(path.join(outside, "existing-child", "nested"))).toBe(false)
    } finally {
      fs.rmSync(link, { force: true })
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  test.skipIf(process.platform === "win32")("file-output methods get private folders, input paths are left alone", () => {
    const files = createExecuteFiles()
    const methods = [
      ["screenshot", "path"], ["pdf", "path"], ["storageState", "path"], ["stopChunk", "path"],
      ["screenshotWithLabels", "path"], ["screenshotDiff", "path"], ["stop", "outputPath"],
    ] as const
    try {
      for (const [method, key] of methods) {
        const output = path.join(files.dir, `${method}-output`, "file")
        const fn = ({ [method]: () => {} } as Record<string, () => void>)[method]!
        prepareExecuteFileOutputs(checkHostCall(fn, {}, [{ [key]: output }]))
        expect(fs.statSync(path.dirname(output)).mode & 0o777, method).toBe(0o700)
      }
      // download.saveAs(path) and video.saveAs(path) take the file as their first argument.
      const saved = path.join(files.dir, "saveAs-output", "file")
      prepareExecuteFileOutputs(checkHostCall(function saveAs() {}, {}, [saved]))
      expect(fs.statSync(path.dirname(saved)).mode & 0o777).toBe(0o700)
      // addScriptTag reads its path; Playwright's own mkdir is not involved, so nothing is created for it.
      const input = path.join(files.dir, "input", "file.js")
      expect(() => checkHostCall(function addScriptTag() {}, {}, [{ path: input }])).not.toThrow()
      expect(fs.existsSync(path.dirname(input))).toBe(false)
    } finally {
      for (const [method] of methods) fs.rmSync(path.join(files.dir, `${method}-output`), { recursive: true, force: true })
      fs.rmSync(path.join(files.dir, "saveAs-output"), { recursive: true, force: true })
    }
  })

  test.skipIf(process.platform === "win32")("browser.startTracing is secured when stopTracing writes it", async () => {
    const files = createExecuteFiles()
    const browser = new FakeTraceBrowser()
    const output = path.join(files.dir, "traces", "trace.json")
    const previous = process.umask(0o002)
    try {
      await run(`await host.browser.startTracing(null, { path: host.files.path("traces/trace.json") }); return null;`, { browser, files })
      // startTracing only remembers the path; stopTracing writes and secures it later.
      expect(fs.existsSync(path.dirname(output))).toBe(false)
      await run(`await host.browser.stopTracing(); return null;`, { browser })
      expect(fs.statSync(path.dirname(output)).mode & 0o777).toBe(0o700)
      expect(fs.statSync(output).mode & 0o777).toBe(0o600)
      // A remembered path that stops passing the guard is refused once, then forgotten.
      prepareExecuteFileOutputs(checkHostCall(function startTracing() {}, browser, [null, { path: output }])).commitTrace?.()
      fs.chmodSync(path.dirname(output), 0o777)
      const stopping = checkHostCall(function stopTracing() {}, browser, [])
      expect(stopping.tracePath).toBe(output)
      expect(() => prepareExecuteFileOutputs(stopping)).toThrow(/owned directories/)
      expect(() => checkHostCall(function stopTracing() {}, browser, [])).not.toThrow()
    } finally {
      process.umask(previous)
      fs.rmSync(path.join(files.dir, "traces"), { recursive: true, force: true })
    }
  })

  test.skipIf(process.platform === "win32")("startTracing remembers only a resolved call with a path", async () => {
    const files = createExecuteFiles()
    const browser = new FakeTraceBrowser()
    const rejected = path.join(files.dir, "rejected-trace")
    const cleared = path.join(files.dir, "cleared-trace")
    try {
      browser.failStart = true
      await expect(run(`await host.browser.startTracing(null, { path: host.files.path("rejected-trace/trace.json") }); return null;`, { browser, files }))
        .rejects.toThrow("start failed")
      // A remembered path would make stopTracing create its folder before writing.
      await run(`await host.browser.stopTracing(); return null;`, { browser })
      expect(fs.existsSync(rejected)).toBe(false)
      browser.failStart = false
      await run(`await host.browser.startTracing(null, { path: host.files.path("cleared-trace/trace.json") }); return null;`, { browser, files })
      await run(`await host.browser.startTracing(null); return null;`, { browser })
      await run(`await host.browser.stopTracing(); return null;`, { browser })
      expect(fs.existsSync(cleared)).toBe(false)
    } finally {
      fs.rmSync(rejected, { recursive: true, force: true })
      fs.rmSync(cleared, { recursive: true, force: true })
    }
  })

  test.skipIf(process.platform === "win32")("tracing.stop is secured under a permissive umask", async () => {
    const files = createExecuteFiles()
    const output = path.join(files.dir, "trace-stop", "trace.zip")
    const previous = process.umask(0o002)
    try {
      const tracing = {
        // Like localUtils.zip: writes the archive with the process umask and no mkdir.
        async stop(options: { path?: string } = {}) {
          if (!options.path) return
          fs.writeFileSync(options.path, "zip")
        },
      }
      await run(`await host.tracing.stop({ path: host.files.path("trace-stop/trace.zip") }); return null;`, { tracing, files })
      expect(fs.statSync(path.dirname(output)).mode & 0o777).toBe(0o700)
      expect(fs.statSync(output).mode & 0o777).toBe(0o600)
    } finally {
      process.umask(previous)
      fs.rmSync(path.join(files.dir, "trace-stop"), { recursive: true, force: true })
    }
  })

  test.skipIf(process.platform === "win32")("download.saveAs secures the file it copies", async () => {
    const files = createExecuteFiles()
    const output = path.join(files.dir, "saves", "file.bin")
    const previous = process.umask(0o002)
    try {
      const download = {
        async saveAs(target: string) {
          fs.mkdirSync(path.dirname(target), { recursive: true })
          fs.writeFileSync(target, "data")
        },
      }
      await run(`await host.download.saveAs(host.files.path("saves/file.bin")); return null;`, { download, files })
      expect(fs.statSync(path.dirname(output)).mode & 0o777).toBe(0o700)
      expect(fs.statSync(output).mode & 0o777).toBe(0o600)
    } finally {
      process.umask(previous)
      fs.rmSync(path.join(files.dir, "saves"), { recursive: true, force: true })
    }
  })
})
