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

function run(body: string, host: Record<string, unknown>) {
  return new ExecuteRealm().run({ source: `(async (host) => { ${body} })`, filename: "test.js", args: [host] })
}

describe("raw CDP file parameters", () => {
  test("DOM.setFileInputFiles paths must be inside the execute file roots", () => {
    function send() {}
    const inside = createExecuteFiles().path("upload.txt")
    expect(() => checkHostCall(send, {}, ["DOM.setFileInputFiles", { files: ["/etc/realm-denied"] }])).toThrow(/outside the execute file roots/)
    expect(() => checkHostCall(send, {}, ["DOM.setFileInputFiles", { files: [inside] }])).not.toThrow()
    expect(() => checkHostCall(send, {}, ["DOM.setFileInputFiles", { files: [inside, "/etc/realm-denied"] }])).toThrow(/outside the execute file roots/)
  })

  test("Input.dispatchDragEvent files and PWA.launchFilesInApp files are checked", () => {
    function send() {}
    const inside = createExecuteFiles().path("drop.txt")
    expect(() => checkHostCall(send, {}, ["Input.dispatchDragEvent", { type: "drop", data: { files: ["/etc/realm-denied"] } }])).toThrow(/outside the execute file roots/)
    expect(() => checkHostCall(send, {}, ["Input.dispatchDragEvent", { type: "drop", data: { files: [inside] } }])).not.toThrow()
    expect(() => checkHostCall(send, {}, ["PWA.launchFilesInApp", { manifestId: "app", files: ["/etc/realm-denied"] }])).toThrow(/outside the execute file roots/)
    expect(() => checkHostCall(send, {}, ["PWA.launchFilesInApp", { manifestId: "app", files: [inside] }])).not.toThrow()
  })

  test("download paths are checked as output folders", () => {
    function send() {}
    const downloads = path.join(createExecuteFiles().dir, "downloads")
    for (const method of ["Browser.setDownloadBehavior", "Page.setDownloadBehavior"]) {
      expect(() => checkHostCall(send, {}, [method, { behavior: "allow", downloadPath: "/etc/realm-denied" }])).toThrow(/outside the execute file roots/)
      expect(() => checkHostCall(send, {}, [method, { behavior: "allow", downloadPath: os.tmpdir() }])).toThrow(/private subdirectory/)
      const call = checkHostCall(send, {}, [method, { behavior: "allow", downloadPath: downloads }])
      expect(call.outputs).toEqual([{ path: downloads, directory: true }])
    }
    const prepared = prepareExecuteFileOutputs(checkHostCall(send, {}, ["Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: downloads }]))
    expect(prepared.outputs).toEqual([])
    expect(fs.statSync(downloads).isDirectory()).toBe(true)
    if (process.getuid) expect(fs.statSync(downloads).mode & 0o777).toBe(0o700)
    fs.rmSync(downloads, { recursive: true, force: true })
  })

  test("commands that carry more CDP or load local code are refused", () => {
    function send() {}
    const inside = createExecuteFiles().dir
    for (const method of ["Extensions.loadUnpacked", "Target.sendMessageToTarget", "Target.exposeDevToolsProtocol"]) {
      for (const params of [{ path: inside, targetId: "target", message: "{}" }, { path: "/etc/realm-denied" }]) {
        expect(() => checkHostCall(send, {}, [method, params])).toThrow(/not available in execute code/)
      }
    }
  })

  test("other CDP commands are unaffected", () => {
    function send() {}
    expect(() => checkHostCall(send, {}, ["Page.navigate", { url: "https://example.com" }])).not.toThrow()
    expect(() => checkHostCall(send, {}, ["Emulation.setEmulatedMedia", { media: "print" }])).not.toThrow()
  })
})

describe("raw CDP sessions reached from execute code", () => {
  test("a browser CDP session checks DOM.setFileInputFiles the same way", async () => {
    const sent: string[] = []
    const session = {
      async send(method: string) {
        sent.push(method)
        return null
      },
    }
    const host = { browser: { async newBrowserCDPSession() { return session } } }
    const refusal = await run(`
      const cdp = await host.browser.newBrowserCDPSession();
      try { await cdp.send("DOM.setFileInputFiles", { files: ["/etc/realm-denied"] }); return "allowed" }
      catch (error) { return error.message }
    `, host)
    expect(refusal).toMatch(/outside the execute file roots/)
    expect(sent).toEqual([])
  })

  test("a page CDP session allows a file inside the roots", async () => {
    const sent: string[] = []
    const session = {
      async send(method: string, params: unknown) {
        sent.push(method)
        return params
      },
    }
    const files = createExecuteFiles()
    const host = { context: { async newCDPSession() { return session } }, page: {}, upload: files.path("upload.txt") }
    const result = await run(`
      const cdp = await host.context.newCDPSession(host.page);
      return await cdp.send("DOM.setFileInputFiles", { files: [host.upload] });
    `, host)
    expect(result).toEqual({ files: [files.path("upload.txt")] })
    expect(sent).toEqual(["DOM.setFileInputFiles"])
  })
})
