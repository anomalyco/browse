import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { assertExecuteFilePath, checkHostCall, createExecuteFiles, ExecuteRealm } from "../src/execute-realm.ts"

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

type NodeOutcome = { readonly value?: unknown; readonly error?: string }

// The relay runs execute code under Node, whose vm differs from Bun's: escape attempts run there too.
function runInNode(bodies: readonly string[], setup = ""): NodeOutcome[] {
  const script = `
    const { ExecuteRealm, sandboxModules, createExecuteFiles } = await import(${JSON.stringify(path.join(import.meta.dir, "../src/execute-realm.ts"))})
    const host = { fn: () => 1, object: { nested: true }, error: () => { throw new Error("host") } }
    ${setup}
    const results = []
    for (const body of JSON.parse(process.argv[1])) {
      try {
        const realm = new ExecuteRealm()
        realm.proxyAsObject(host)
        if (host.files) realm.proxyAsObject(host.files)
        if (host.modules) realm.proxyAsObject(host.modules)
        results.push({ value: await realm.run({ source: "(async (host) => { " + body + " })", filename: "test.js", args: [host] }) })
        realm.dispose()
      } catch (error) {
        results.push({ error: String(error?.message ?? error) })
      }
    }
    console.log(JSON.stringify(results))
  `
  const child = spawnSync("node", ["--input-type=module", "--no-warnings", "-e", script, JSON.stringify(bodies)], { encoding: "utf8", timeout: 15_000, env: { ...process.env, OPENCODE_BROWSER_HOME: home } })
  if (child.status !== 0) throw new Error(`node failed: ${child.stderr}`)
  return JSON.parse(child.stdout.trim().split("\n").at(-1) ?? "[]") as NodeOutcome[]
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
    expect(globals).toEqual({ value: ["undefined", "undefined", "undefined", "undefined", "function"] })
    expect(importCall?.error).toMatch(/import\(\) is not available/)
    expect(escapes.slice(0, 6).map((outcome) => outcome.error)).toEqual(Array(6).fill(expect.stringMatching(/Code generation from strings disallowed/)))
    // Stack-trace hooks would hand out host call sites; the realm freezes them off.
    expect(escapes[6]).toEqual({ value: "string" })
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
    for (const outcome of outcomes) expect(outcome.error).toMatch(/Code generation from strings disallowed/)
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

  test("CPU budgets cover initial code, awaits, callbacks, thenables, getters and microtasks", () => {
    const bodies = [
      "while(true){}",
      "await Promise.resolve(); while(true){}",
      "await host.fn(); while(true){}",
      "await new Promise(resolve=>setTimeout(()=>{while(true){}},0))",
      "await new Promise(resolve=>queueMicrotask(()=>{while(true){}}))",
      "await host.page.route('**/*', ()=>{while(true){}})",
      "host.page.on('console', ()=>{while(true){}}); host.emitConsole()",
      "return {get value(){while(true){}}}",
      "throw {get message(){while(true){}}}",
      "return {then(){while(true){}}}",
    ]
    const outcomes = runInNode(bodies, playwrightShapes)
    for (const outcome of outcomes) expect(outcome.error).toMatch(/CPU budget/)
  }, 10_000)

  test("Buffer backing stores contain only the view, and unsafe allocation is zeroed", () => {
    const outcomes = runInNode([
      "const value=Buffer.from('x'); return [value.buffer.byteLength, value.length, new TextDecoder().decode(value.buffer).includes('REALM_FAKE_SECRET')]",
      "return [host.buffer.buffer.byteLength, host.buffer.length]",
      "return [Buffer.allocUnsafe(64),Buffer.allocUnsafeSlow(64),host.modules.buffer.SlowBuffer(64)].every(value=>value.every(byte=>byte===0))",
    ], playwrightShapes + "; const marker = Buffer.from('REALM_FAKE_SECRET'.repeat(10));")
    expect(outcomes).toEqual([{ value: [1, 1, false] }, { value: [4, 4] }, { value: true }])
  })
})

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

  test("refuses OpenCode Browser's own data directory even inside a temp root", async () => {
    const files = createExecuteFiles()
    fs.writeFileSync(path.join(home, "relay-token"), "secret")
    await expect(files.read(path.join(home, "relay-token"))).rejects.toThrow(/data directory/)
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
})
