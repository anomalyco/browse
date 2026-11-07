import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { checkHostCall, createExecuteFiles, ExecuteRealm } from "../src/execute-realm.ts"
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
    expect(result.error).toMatch(/plain JSON data/)
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

  test("browser.bind is refused", () => {
    function bind() {}
    expect(() => checkHostCall(bind, {}, ["server"])).toThrow(/not available in execute code/)
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
