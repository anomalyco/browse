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
function runInNode(bodies: readonly string[]): NodeOutcome[] {
  const script = `
    const { ExecuteRealm } = await import(${JSON.stringify(path.join(import.meta.dir, "../src/execute-realm.ts"))})
    const host = { fn: () => 1, object: { nested: true }, error: () => { throw new Error("host") } }
    const results = []
    for (const body of JSON.parse(process.argv[1])) {
      try {
        results.push({ value: await new ExecuteRealm().run({ source: "(async (host) => { " + body + " })", filename: "test.js", args: [host] }) })
      } catch (error) {
        results.push({ error: String(error?.message ?? error) })
      }
    }
    console.log(JSON.stringify(results))
  `
  const child = spawnSync("node", ["--input-type=module", "--no-warnings", "-e", script, JSON.stringify(bodies)], { encoding: "utf8", env: { ...process.env, OPENCODE_BROWSER_HOME: home } })
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

  test("Playwright calls with file options and bringToFront are checked", () => {
    function screenshot() {}
    function bringToFront() {}
    function send() {}
    expect(() => checkHostCall(screenshot, {}, [{ path: "/Users/someone/shot.png" }])).toThrow(/outside the execute file roots/)
    expect(() => checkHostCall(screenshot, {}, [{ path: path.join(os.tmpdir(), "shot.png") }])).not.toThrow()
    expect(() => checkHostCall(bringToFront, {}, [])).toThrow(/bringToFront\(\) is blocked/)
    expect(() => checkHostCall(send, {}, ["Page.bringToFront"])).toThrow(/bringToFront\(\) is blocked/)
    expect(() => checkHostCall(send, {}, ["Page.navigate", { url: "https://example.com" }])).not.toThrow()
  })
})
