import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { checkHostCall, createExecuteFiles, ExecuteRealm, sandboxModules } from "../src/execute-realm.ts"
import { prepareExecuteFileOutputs } from "../src/execute-realm/file-roots.ts"

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "browse-cdp-roots-"))
let previousHome: string | undefined

beforeAll(() => {
  previousHome = process.env.OPENCODE_BROWSER_HOME
  process.env.OPENCODE_BROWSER_HOME = path.join(scratch, "home")
  fs.mkdirSync(process.env.OPENCODE_BROWSER_HOME, { recursive: true })
})
afterAll(() => {
  if (previousHome === undefined) delete process.env.OPENCODE_BROWSER_HOME
  else process.env.OPENCODE_BROWSER_HOME = previousHome
  fs.rmSync(scratch, { recursive: true, force: true })
})

class CDPSession {
  readonly sent: Array<{ readonly method: unknown; readonly params: string | undefined }> = []
  async send(method: unknown, params?: unknown) {
    this.sent.push({ method, params: params === undefined ? undefined : JSON.stringify(params) })
    return "sent"
  }
  async detach() {}
}

function run(body: string, host: Record<string, unknown>) {
  return new ExecuteRealm().run({ source: `(async (host) => { ${body} })`, filename: "test.js", args: [host] })
}

function cdpHost(session: CDPSession) {
  return { browser: { async newBrowserCDPSession() { return session } }, context: { async newCDPSession() { return session } }, page: {} }
}

async function sendInRealm(method: string, params: string, session = new CDPSession()) {
  const result = await run(`
    const cdp = await host.browser.newBrowserCDPSession();
    try { await cdp.send(${method}, ${params}); return { sent: true } }
    catch (error) { return { error: error.message } }
  `, cdpHost(session))
  return { result: result as { readonly sent?: boolean; readonly error?: string }, session }
}

function checkCdp(method: string, params: unknown, session = new CDPSession()) {
  const args: unknown[] = [method, params]
  return { args, call: checkHostCall(session.send, session, args) }
}

describe("raw CDP send parameters", () => {
  test("toJSON functions anywhere in params are refused before the mock send runs", async () => {
    const cases = [
      ['"DOM.setFileInputFiles"', '{ files: [{ toJSON() { return "/etc/realm-denied" } }] }'],
      ['"Page.navigate"', '{ toJSON() { return { url: "https://example.com" } } }'],
      ['"Browser.setDownloadBehavior"', '{ behavior: "allow", downloadPath: { toJSON() { return "/etc/realm-denied" } } }'],
      ['"Page.navigate"', '() => ({ url: "https://example.com" })'],
      ['"Page.navigate"', 'Object.assign(() => ({}), { toJSON() { return { url: "https://example.com" } } })'],
    ] as const
    for (const [method, params] of cases) {
      const { result, session } = await sendInRealm(method, params)
      expect(result.error, method).toMatch(/plain JSON data/)
      expect(session.sent, method).toEqual([])
    }
  })

  test("boxed String method names are refused", async () => {
    const { result, session } = await sendInRealm('new String("DOM.setFileInputFiles")', '{ files: ["/etc/realm-denied"] }')
    expect(result.error).toMatch(/primitive string/)
    expect(session.sent).toEqual([])
  })

  test("file lists must be arrays of strings", async () => {
    const { result, session } = await sendInRealm('"DOM.setFileInputFiles"', '{ files: { 0: "/etc/realm-denied" } }')
    expect(result.error).toMatch(/must be an array of file paths/)
    expect(session.sent).toEqual([])
  })

  test("valid params are deep-copied and sent", () => {
    const params = { url: "https://example.com", nested: [1, true, null, "x"] }
    const { args } = checkCdp("Page.navigate", params)
    expect(args[1]).not.toBe(params)
    expect(args[1]).toEqual(params)
    expect(JSON.stringify(args[1])).toBe(JSON.stringify(params))
  })

  test("a normal CDP call still reaches the mock send", async () => {
    const { result, session } = await sendInRealm('"Page.navigate"', '{ url: "https://example.com" }')
    expect(result.sent).toBe(true)
    expect(session.sent).toEqual([{ method: "Page.navigate", params: '{"url":"https://example.com"}' }])
  })

  test("undefined object properties are omitted like JSON.stringify", async () => {
    const { result, session } = await sendInRealm('"Runtime.evaluate"', '{ expression: "1", contextId: undefined }')
    expect(result.sent).toBe(true)
    expect(session.sent).toEqual([{ method: "Runtime.evaluate", params: '{"expression":"1"}' }])
    const files = createExecuteFiles()
    const { args } = checkCdp("DOM.setFileInputFiles", { nodeId: 1, files: [files.path("upload.txt")], objectId: undefined })
    expect("objectId" in (args[1] as object)).toBe(false)
    expect(JSON.stringify(args[1])).toBe(JSON.stringify({ nodeId: 1, files: [files.path("upload.txt")] }))
  })

  test("undefined array elements are still refused", async () => {
    const { result, session } = await sendInRealm('"Page.navigate"', '{ urls: ["https://example.com", undefined] }')
    expect(result.error).toMatch(/arrays cannot contain undefined, use null/)
    expect(session.sent).toEqual([])
  })

  test("proxies, cycles and accessors are refused", () => {
    const session = new CDPSession()
    expect(() => checkCdp("Page.navigate", new Proxy({ url: "https://example.com" }, {}), session)).toThrow(/proxies/)
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    expect(() => checkCdp("Page.navigate", cycle, session)).toThrow(/cyclical/)
    const accessor: Record<string, unknown> = {}
    Object.defineProperty(accessor, "url", { get: () => "https://example.com", enumerable: true })
    expect(() => checkCdp("Page.navigate", accessor, session)).toThrow(/getters, setters/)
  })
})

describe("raw CDP file inputs", () => {
  const files = createExecuteFiles()
  const inside = files.path("upload.txt")
  const root = files.roots[0]!
  const directory = path.join(files.dir, "upload-dir")
  fs.mkdirSync(directory, { recursive: true })

  test("DOM.setFileInputFiles, drag and PWA files refuse roots and directories", () => {
    const session = new CDPSession()
    const methods: Array<readonly [string, (value: string) => Record<string, unknown>]> = [
      ["DOM.setFileInputFiles", (value) => ({ files: [value] })],
      ["Input.dispatchDragEvent", (value) => ({ type: "drop", data: { files: [value] } })],
      ["PWA.launchFilesInApp", (value) => ({ manifestId: "app", files: [value] })],
    ]
    for (const [method, params] of methods) {
      expect(() => checkCdp(method, params(root), session), method).toThrow(/execute file root/)
      expect(() => checkCdp(method, params(directory), session), method).toThrow(/is a directory/)
      expect(() => checkCdp(method, params("/etc/realm-denied"), session), method).toThrow(/outside the execute file roots/)
      expect(() => checkCdp(method, params(inside), session), method).not.toThrow()
    }
  })

  test("file paths are written back resolved", () => {
    const path = `${files.dir}/nested/../upload.txt`
    const cases: Array<readonly [string, (files: string[]) => Record<string, unknown>, (params: unknown) => string[]]> = [
      ["DOM.setFileInputFiles", (files) => ({ files }), (params) => (params as { files: string[] }).files],
      ["Input.dispatchDragEvent", (files) => ({ type: "drop", data: { files } }), (params) => (params as { data: { files: string[] } }).data.files],
      ["PWA.launchFilesInApp", (files) => ({ manifestId: "app", files }), (params) => (params as { files: string[] }).files],
    ]
    for (const [method, params, filesOf] of cases) {
      const { args } = checkCdp(method, params([path]))
      expect(filesOf(args[1]), method).toEqual([inside])
    }
  })

  test("setInputFiles and setFiles refuse roots but keep directory support; drop refuses directories", () => {
    function setInputFiles() {}
    function setFiles() {}
    function drop() {}
    expect(() => checkHostCall(setInputFiles, {}, [root])).toThrow(/execute file root/)
    expect(() => checkHostCall(setInputFiles, {}, [directory])).not.toThrow()
    expect(() => checkHostCall(setFiles, {}, [root])).toThrow(/execute file root/)
    expect(() => checkHostCall(setFiles, {}, [directory])).not.toThrow()
    expect(() => checkHostCall(drop, {}, [{ files: [root] }])).toThrow(/execute file root/)
    expect(() => checkHostCall(drop, {}, [{ files: [directory] }])).toThrow(/is a directory/)
    expect(() => checkHostCall(drop, {}, [{ files: { name: "a.txt", mimeType: "text/plain", buffer: Buffer.from("a") } }])).not.toThrow()
  })
})

describe("directory uploads", () => {
  const files = createExecuteFiles()
  const root = path.join(files.dir, "upload-tree")
  const nested = path.join(root, "nested")
  fs.mkdirSync(nested, { recursive: true })
  fs.writeFileSync(path.join(root, "a.txt"), "a")
  fs.writeFileSync(path.join(nested, "b.txt"), "b")

  test("regular files and nested folders are allowed", () => {
    function setInputFiles() {}
    function setFiles() {}
    expect(() => checkHostCall(setInputFiles, {}, [root])).not.toThrow()
    expect(() => checkHostCall(setFiles, {}, [root])).not.toThrow()
    expect(() => checkHostCall(setInputFiles, {}, [[path.join(root, "a.txt"), nested]])).not.toThrow()
  })

  test.skipIf(process.platform === "win32")("symlinks inside an uploaded directory are refused", () => {
    const link = path.join(root, "outside-link")
    fs.symlinkSync("/etc/realm-denied", link)
    try {
      function setInputFiles() {}
      expect(() => checkHostCall(setInputFiles, {}, [root])).toThrow(/symlink/)
    } finally {
      fs.unlinkSync(link)
    }
  })

  test("the folder-upload entry budget is shared across paths", () => {
    const capped = path.join(files.dir, "upload-cap")
    fs.mkdirSync(capped)
    for (let index = 0; index < 501; index += 1) fs.writeFileSync(path.join(capped, `${index}.txt`), "")
    try {
      function setInputFiles() {}
      expect(() => checkHostCall(setInputFiles, {}, [[capped, capped]])).toThrow(/limited to 1000/)
    } finally {
      fs.rmSync(capped, { recursive: true, force: true })
    }
  })
})

describe("drop payloads", () => {
  test("function payloads with files are refused and never reach the host", async () => {
    const received: unknown[] = []
    const drop = (payload: unknown) => { received.push(payload) }
    const result = await run(`
      const payload = Object.assign(() => {}, { files: [host.outside] });
      try { await host.drop(payload); return "allowed" } catch (error) { return error.message }
    `, { drop, outside: "/etc/realm-denied" })
    expect(result).toMatch(/plain object/)
    expect(received).toEqual([])
  })

  test("inherited and accessor files properties are refused", () => {
    function drop() {}
    const inherited = Object.create({ files: ["/etc/realm-denied"] })
    expect(() => checkHostCall(drop, {}, [inherited])).toThrow(/plain object/)
    const accessor: Record<string, unknown> = {}
    Object.defineProperty(accessor, "files", { get: () => ["/etc/realm-denied"], enumerable: true })
    expect(() => checkHostCall(drop, {}, [accessor])).toThrow(/data property/)
  })

  test("a valid payload is copied and paths are rewritten", () => {
    function drop() {}
    const files = createExecuteFiles()
    const inside = files.path("drop.txt")
    const payload = { files: [`${files.dir}/nested/../drop.txt`], data: { "text/plain": "hi" } }
    const args: unknown[] = [payload]
    checkHostCall(drop, {}, args)
    expect(args[0]).not.toBe(payload)
    expect((args[0] as { files: string[] }).files).toEqual([inside])
    expect((args[0] as { data: Record<string, string> }).data).toEqual({ "text/plain": "hi" })
  })
})

describe("download behavior", () => {
  const files = createExecuteFiles()
  const downloads = files.path("downloads")
  const direct = path.join(files.roots[0]!, "downloads-direct")

  function download(method: string, params: Record<string, unknown>) {
    const args: unknown[] = [method, params]
    return { args, call: checkHostCall(function send() {}, {}, args) }
  }

  test("default behavior, missing paths and non-string paths are refused", () => {
    for (const method of ["Browser.setDownloadBehavior", "Page.setDownloadBehavior"]) {
      expect(() => download(method, { behavior: "default" })).toThrow(/default downloads go outside/)
      expect(() => download(method, { behavior: "allow" })).toThrow(/requires a downloadPath/)
      expect(() => download(method, { behavior: "allowAndName" })).toThrow(/requires a downloadPath/)
      expect(() => download(method, { behavior: "allow", downloadPath: 1 })).toThrow(/downloadPath must be a string/)
      expect(() => download(method, { behavior: "allow", downloadPath: "/etc/realm-denied" })).toThrow(/outside the execute file roots/)
      if (process.getuid) expect(() => download(method, { behavior: "allow", downloadPath: direct })).toThrow(/private subdirectory/)
    }
  })

  test("the download folder is checked, written back and prepared", () => {
    for (const method of ["Browser.setDownloadBehavior", "Page.setDownloadBehavior"]) {
      const { args, call } = download(method, { behavior: "allow", downloadPath: `${files.dir}/nested/../downloads` })
      expect(call.outputs).toEqual([{ path: downloads, directory: true }])
      expect((args[1] as { downloadPath: string }).downloadPath).toBe(downloads)
    }
    const prepared = prepareExecuteFileOutputs(download("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: downloads }).call)
    expect(prepared.outputs).toEqual([])
    expect(fs.statSync(downloads).isDirectory()).toBe(true)
    if (process.getuid) expect(fs.statSync(downloads).mode & 0o777).toBe(0o700)
    fs.rmSync(downloads, { recursive: true, force: true })
  })

  test("the execute files directory itself is allowed as a download folder", () => {
    const { call } = download("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: files.dir })
    expect(call.outputs).toEqual([{ path: files.dir, directory: true }])
    expect(() => prepareExecuteFileOutputs(call)).not.toThrow()
  })

  test("deny still validates a supplied path without preparing it", () => {
    const { call } = download("Browser.setDownloadBehavior", { behavior: "deny", downloadPath: downloads })
    expect(call.outputs).toEqual([])
    expect(() => download("Browser.setDownloadBehavior", { behavior: "deny", downloadPath: "/etc/realm-denied" })).toThrow(/outside the execute file roots/)
  })
})

describe("refused CDP commands", () => {
  test("extension control, PWA install, file info and raw CDP tunnels are refused", () => {
    const session = new CDPSession()
    const methods = [
      ["Extensions.loadUnpacked", { path: "/etc/realm-denied" }],
      ["Extensions.getStorageItems", { id: "extension" }],
      ["Extensions.setStorageItems", { id: "extension", values: [] }],
      ["PWA.install", { manifestId: "app", installUrlOrBundleUrl: "file:///etc/realm-denied" }],
      ["DOM.getFileInfo", { objectId: "node" }],
      ["Target.sendMessageToTarget", { message: "{}" }],
      ["Target.exposeDevToolsProtocol", { targetId: "target" }],
    ] as const
    for (const [method, params] of methods) {
      expect(() => checkCdp(method, params, session), method).toThrow(/not available in execute code/)
    }
  })
})

describe("other file-taking APIs", () => {
  test("setStorageState checks string paths but allows inline state", () => {
    function setStorageState() {}
    expect(() => checkHostCall(setStorageState, {}, ["/etc/realm-denied"])).toThrow(/outside the execute file roots/)
    expect(() => checkHostCall(setStorageState, {}, [createExecuteFiles().path("state.json")])).not.toThrow()
    expect(() => checkHostCall(setStorageState, {}, [{ cookies: [], origins: [] }])).not.toThrow()
  })

  test("browser.bind is refused but module bind functions are not", () => {
    class Browser {
      async bind() {}
    }
    const browser = new Browser()
    expect(() => checkHostCall(browser.bind, browser, ["server"])).toThrow(/not available in execute code/)
    const events = { bind() {} }
    expect(() => checkHostCall(events.bind, events, [{}])).not.toThrow()
  })
})

describe("send methods that are not CDP", () => {
  test("WebSocketRoute-like send keeps accepting strings and buffers", async () => {
    const received: unknown[] = []
    const route = { send(message: unknown) { received.push(message) } }
    const result = await run(`
      host.route.send("hello");
      host.route.send(host.buffer);
      return "ok";
    `, { route, buffer: Buffer.from("hi") })
    expect(result).toBe("ok")
    expect(received).toEqual(["hello", Buffer.from("hi")])
    expect(() => checkHostCall(route.send, route, ["hello"])).not.toThrow()
    expect(() => checkHostCall(route.send, route, [Buffer.from("hi")])).not.toThrow()
  })
})

describe("sandbox modules", () => {
  test("stream drop is not treated as a drag-and-drop payload", async () => {
    const result = await run(`
      const { Readable } = host.stream;
      return await Readable.from([1, 2, 3]).drop(1).toArray();
    `, { stream: sandboxModules.stream })
    expect(result).toEqual([2, 3])
  })

  const iteratorDrop = (globalThis as { Iterator?: { prototype?: { drop?: unknown } } }).Iterator?.prototype?.drop
  test.skipIf(typeof iteratorDrop !== "function")("host iterator drop is not treated as a drag-and-drop payload", async () => {
    const map = new Map([["a", 1], ["b", 2], ["c", 3]])
    const result = await run(`return host.map.keys().drop(1).toArray();`, { map })
    expect(result).toEqual(["b", "c"])
  })

  test("module bind functions remain available", async () => {
    const result = await run(`
      const { PassThrough } = host.stream;
      return typeof host.stream.bind(new PassThrough());
    `, { stream: sandboxModules.stream })
    expect(result).toBe("function")
  })
})

describe("function arguments with file options", () => {
  test("a function options bag with path is refused before the host", async () => {
    const received: unknown[] = []
    const screenshot = (options: unknown) => { received.push(options); return "ok" }
    const result = await run(`
      const options = Object.assign(() => {}, { path: "/etc/realm-denied" });
      try { await host.screenshot(options); return "allowed" } catch (error) { return error.message }
    `, { screenshot })
    expect(result).toMatch(/function arguments cannot be used as options/)
    expect(received).toEqual([])
  })

  test("ordinary function callbacks still pass", () => {
    function addInitScript() {}
    function route() {}
    expect(() => checkHostCall(addInitScript, {}, [() => 1])).not.toThrow()
    expect(() => checkHostCall(route, {}, ["**/*", () => 1])).not.toThrow()
  })

  test("nested callbacks in file option methods still pass", () => {
    function start() {}
    function newContext() {}
    function screenshot() {}
    expect(() => checkHostCall(start, {}, [{ onFrame: () => {} }])).not.toThrow()
    expect(() => checkHostCall(newContext, {}, [{ logger: { isEnabled: () => false, log: () => {} } }])).not.toThrow()
    expect(() => checkHostCall(screenshot, {}, [() => {}])).toThrow(/function arguments cannot be used as options/)
  })

  test("a lying has trap cannot hide a file option on a function", () => {
    function route() {}
    const callback = new Proxy(function () {}, {
      has: () => false,
      get: (target, key, receiver) => key === "path" ? "/etc/realm-denied" : Reflect.get(target, key, receiver),
    })
    expect(() => checkHostCall(route, {}, ["**/*", callback])).toThrow(/path/)
  })
})

describe("client certificates", () => {
  test("a stateful Proxy function item is refused before the host", async () => {
    const received: unknown[] = []
    const newContext = (options: unknown) => { received.push(options); return "ok" }
    const result = await run(`
      const cert = new Proxy(function () {}, {
        has: () => false,
        get: (target, key) => key === "certPath" ? "/etc/realm-denied" : undefined,
      });
      try { await host.newContext({ clientCertificates: [cert] }); return "allowed" }
      catch (error) { return error.message }
    `, { newContext })
    expect(result).toMatch(/plain objects/)
    expect(received).toEqual([])
  })

  test("cert paths are checked inside plain certificate entries", () => {
    function newContext() {}
    const files = createExecuteFiles()
    expect(() => checkHostCall(newContext, {}, [{ clientCertificates: [{ origin: "https://example.com", certPath: "/etc/realm-denied" }] }])).toThrow(/outside the execute file roots/)
    const inside = files.path("cert.pem")
    expect(() => checkHostCall(newContext, {}, [{ clientCertificates: [{ origin: "https://example.com", certPath: inside }] }])).not.toThrow()
  })

  test("certificate entries must be plain data objects", () => {
    function newContext() {}
    const accessor: Record<string, unknown> = { origin: "https://example.com" }
    Object.defineProperty(accessor, "certPath", { get: () => "/etc/realm-denied", enumerable: true })
    expect(() => checkHostCall(newContext, {}, [{ clientCertificates: [accessor] }])).toThrow(/data properties/)
    class Certificate {
      readonly origin = "https://example.com"
    }
    expect(() => checkHostCall(newContext, {}, [{ clientCertificates: [new Certificate()] }])).toThrow(/plain objects/)
    expect(() => checkHostCall(newContext, {}, [{ clientCertificates: [() => {}] }])).toThrow(/plain objects/)
    expect(() => checkHostCall(newContext, {}, [{ clientCertificates: [new Proxy({ origin: "https://example.com" }, {})] }])).toThrow(/plain objects/)
    const indexed: unknown[] = []
    Object.defineProperty(indexed, 0, { get: () => ({ origin: "https://example.com" }), enumerable: true })
    expect(() => checkHostCall(newContext, {}, [{ clientCertificates: indexed }])).toThrow(/data properties/)
  })

  test("undefined client certificates and undefined cert paths are allowed", () => {
    function newContext() {}
    expect(() => checkHostCall(newContext, {}, [{ clientCertificates: undefined }])).not.toThrow()
    expect(() => checkHostCall(newContext, {}, [{
      clientCertificates: [{
        origin: "https://example.com",
        cert: Buffer.from("cert"),
        key: Buffer.from("key"),
        certPath: undefined,
        keyPath: undefined,
      }],
    }])).not.toThrow()
  })

  test("clientCertificates in unrelated data is left alone", () => {
    function evaluate() {}
    expect(() => checkHostCall(evaluate, {}, [() => 1, { clientCertificates: null }])).not.toThrow()
  })
})

describe("path-like values", () => {
  test("route.fulfill refuses Buffer and file URL paths before the host", async () => {
    const received: unknown[] = []
    const fulfill = (options: unknown) => { received.push(options); return "ok" }
    const result = await run(`
      const failures = [];
      for (const path of [Buffer.from("/etc/hosts"), new URL("file:///etc/hosts")]) {
        try { await host.fulfill({ path }); failures.push("allowed") } catch (error) { failures.push(error.message) }
      }
      return failures;
    `, { fulfill })
    expect(result).toEqual([
      "fulfill: path must be a path string",
      "fulfill: path must be a path string",
    ])
    expect(received).toEqual([])
  })

  test("string paths still work, and other input APIs refuse PathLike values", () => {
    function screenshot() {}
    function screenshotDiff() {}
    function setInputFiles() {}
    function saveAs() {}
    function setStorageState() {}
    function drop() {}
    function fulfill() {}
    const files = createExecuteFiles()
    expect(() => checkHostCall(screenshot, {}, [{ path: files.path("shot.png") }])).not.toThrow()
    expect(() => checkHostCall(screenshot, {}, [{ path: Buffer.from("/etc/hosts") }])).toThrow(/path must be a path string/)
    expect(() => checkHostCall(screenshot, {}, [{ path: new URL("file:///etc/hosts") }])).toThrow(/path must be a path string/)
    expect(() => checkHostCall(fulfill, {}, [{ path: 5 }])).toThrow(/path must be a path string/)
    expect(() => checkHostCall(screenshotDiff, {}, [{ baseline: Buffer.from("png") }])).not.toThrow()
    expect(() => checkHostCall(setInputFiles, {}, [Buffer.from("/etc/hosts")])).toThrow(/strings or file payload objects/)
    expect(() => checkHostCall(setInputFiles, {}, [new URL("file:///etc/hosts")])).toThrow(/strings or file payload objects/)
    expect(() => checkHostCall(setInputFiles, {}, [{ name: "a.txt", mimeType: "text/plain", buffer: Buffer.from("a") }])).not.toThrow()
    expect(() => checkHostCall(saveAs, {}, [Buffer.from("/etc/hosts")])).toThrow(/file paths must be strings/)
    expect(() => checkHostCall(setStorageState, {}, [Buffer.from("/etc/hosts")])).toThrow(/storage state/)
    expect(() => checkHostCall(drop, {}, [{ files: [Buffer.from("/etc/hosts")] }])).toThrow(/strings or file payload objects/)
    expect(() => checkHostCall(drop, {}, [{ files: { name: "a.txt", mimeType: "text/plain", buffer: Buffer.from("a") } }])).not.toThrow()
  })

  test("non-file data arguments are recursed without path restrictions", () => {
    function fulfill() {}
    function evaluate() {}
    function addInitScript() {}
    expect(() => checkHostCall(fulfill, {}, [{
      json: { errors: [{ path: ["user", 0] }] },
    }])).not.toThrow()
    expect(() => checkHostCall(fulfill, {}, [{ json: { dir: "ltr" } }])).not.toThrow()
    expect(() => checkHostCall(evaluate, {}, [() => 1, { baseline: 0.5, keyPath: ["a", "b"] }])).not.toThrow()
    expect(() => checkHostCall(addInitScript, {}, [() => 1, { path: { a: 1 } }])).not.toThrow()
  })

  test("inline storage state allows cookie paths and refuses PathLike values", () => {
    function newContext() {}
    expect(() => checkHostCall(newContext, {}, [{
      storageState: { cookies: [{ name: "a", value: "b", domain: "example.com", path: "/" }], origins: [] },
    }])).not.toThrow()
    expect(() => checkHostCall(newContext, {}, [{ storageState: Buffer.from("/etc/hosts") }])).toThrow(/storageState/)
    expect(() => checkHostCall(newContext, {}, [{ storageState: new URL("file:///etc/hosts") }])).toThrow(/storageState/)
  })
})
