import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { bundleCli } from "../bundle.ts"

// Closing stdin is how an MCP client shuts a stdio server down. The server must then exit 0, not SIGINT's 130.
const temporary = path.join(os.homedir(), ".cache", "oc-tmp")
fs.mkdirSync(temporary, { recursive: true })
const home = fs.mkdtempSync(path.join(temporary, "browse-mcp-exit-"))
const source = path.join(import.meta.dir, "../src/main.ts")
const children = new Set<ReturnType<typeof spawn>>()
/** An npm install of this CLI under the test's HOME, so `browse mcp` supervises it under Node, as npm installs do. */
let installed = ""
beforeAll(async () => {
  const build = path.join(home, "build")
  await bundleCli({ outdir: build, version: "0.0.1" })
  const root = path.join(home, "lib", "node_modules", "@opencode", "browse")
  fs.cpSync(build, path.join(root, "dist"), { recursive: true })
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "@opencode/browse", version: "0.0.1" }))
  fs.symlinkSync(path.join(import.meta.dir, "../node_modules"), path.join(root, "node_modules"), "junction")
  installed = path.join(root, "dist", "cli.mjs")
}, 30_000)

afterAll(() => {
  try {
    for (const child of children) child.kill("SIGKILL")
    for (const server of serversUnder(home)) {
      try {
        process.kill(server.pid, "SIGKILL")
      } catch {
        // It exited between the listing and the kill.
      }
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  ...process.env,
  HOME: home,
  OPENCODE_BROWSER_HOME: home,
  OPENCODE_BROWSER_PORT: "29988",
  OPENCODE_BROWSER_AUTOSTART: "false",
  OPENCODE_BROWSER_UPDATE_CHECK: "0",
  // The server and supervisor set these themselves; inherit none from whatever started the tests.
  OPENCODE_BROWSER_CLIENT_PID: undefined,
  OPENCODE_BROWSER_MCP_DIRECT: undefined,
  OPENCODE_BROWSER_MCP_SESSION: undefined,
  ...extra,
})

const initialize = { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "0" } }

type Reply = { result?: Record<string, unknown>; error?: unknown }

/** The `mcp` processes running under `folder`, for cleaning up a supervisor's child when a test fails. */
function serversUnder(folder: string) {
  const listing = spawnSync("ps", ["-Ao", "pid=,args="], { encoding: "utf8" }).stdout ?? ""
  return listing.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line)
    return match && match[2]!.includes(folder) && match[2]!.endsWith(" mcp") ? [{ pid: Number(match[1]) }] : []
  })
}

/** A private executable at the installed path, so `browse mcp` supervises the checkout's server. */
function installedBinary() {
  const binary = path.join(home, "bin", "browse")
  fs.mkdirSync(path.dirname(binary), { recursive: true })
  fs.writeFileSync(binary, `#!/usr/bin/env bun
globalThis.__OPENCODE_BROWSER_COMPILED__ = true
globalThis.__OPENCODE_BROWSER_VERSION__ = "1.0.0"
await import(${JSON.stringify(source)})
`, { mode: 0o755 })
  return binary
}

/** Starts `browse mcp` and speaks enough of the protocol to prove the server is serving before stdin closes. */
function server(command: readonly string[], extra: NodeJS.ProcessEnv = {}) {
  const child = spawn(command[0]!, command.slice(1), { stdio: ["pipe", "pipe", "pipe"], env: env(extra), windowsHide: true })
  children.add(child)
  const pending = new Map<number, (reply: Reply) => void>()
  const answered = new Set<number>()
  let buffer = ""
  let stderr = ""
  child.stdout.on("data", (chunk) => {
    buffer += chunk
    for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      if (!line.trim()) continue
      const message = JSON.parse(line) as Reply & { id?: number }
      if (message.id !== undefined) {
        answered.add(message.id)
        pending.get(message.id)?.(message)
      }
    }
  })
  child.stderr.on("data", (chunk) => {
    stderr += chunk
  })
  const send = (id: number, method: string, params: Record<string, unknown> = {}) => {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n")
  }
  const request = (id: number, method: string, params: Record<string, unknown> = {}) =>
    new Promise<Reply>((resolve) => {
      pending.set(id, resolve)
      send(id, method, params)
    })
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal }))
  )
  const handshake = async () => {
    const reply = await request(1, "initialize", initialize)
    if (reply.result?.protocolVersion !== initialize.protocolVersion) throw new Error(`initialize failed: ${JSON.stringify(reply)} ${stderr}`)
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n")
    const tools = await request(2, "tools/list")
    if (!Array.isArray(tools.result?.tools)) throw new Error(`tools/list failed: ${JSON.stringify(tools)} ${stderr}`)
  }
  return { child, handshake, exit, stderr: () => stderr, answered: (id: number) => answered.has(id), send }
}

const within = <A>(ms: number, promise: Promise<A>, what: string): Promise<A> =>
  Promise.race([promise, Bun.sleep(ms).then((): never => { throw new Error(`${what} didn't finish within ${ms} ms`) })])

describe("browse mcp shuts down cleanly when its client closes stdin", () => {
  test("the direct server exits 0", async () => {
    const mcp = server([process.execPath, source, "mcp"], { OPENCODE_BROWSER_MCP_DIRECT: "1" })
    try {
      await mcp.handshake()
      const started = Date.now()
      mcp.child.stdin.end()
      // Well under the supervisor's 5 second fallback: the server exits on its own.
      const exit = await within(4_000, mcp.exit, "the direct server's stdin EOF exit")
      expect({ ...exit, stderr: mcp.stderr(), ms: Date.now() - started }).toMatchObject({ code: 0, signal: null })
    } finally {
      mcp.child.kill("SIGKILL")
    }
  }, 20_000)

  test.skipIf(process.platform === "win32")("an installed binary's supervised server exits 0 promptly", async () => {
    // A private executable path makes `browse mcp` supervise, as an installed binary does.
    const mcp = server([installedBinary(), "mcp"])
    try {
      await mcp.handshake()
      const started = Date.now()
      mcp.child.stdin.end()
      // The supervisor's own stdin-close timer is 5 seconds; a prompt exit proves the child ended on its own.
      const exit = await within(4_000, mcp.exit, "the supervised server's stdin EOF exit")
      expect({ ...exit, stderr: mcp.stderr(), ms: Date.now() - started }).toMatchObject({ code: 0, signal: null })
    } finally {
      mcp.child.kill("SIGKILL")
    }
  }, 20_000)

  test("the supervisor flushes responses a paused client hasn't read", async () => {
    // Node's stdout to a pipe buffers asynchronously; Bun's writes block instead, so only this shape loses data on exit.
    const mcp = server(["node", installed, "mcp"])
    try {
      await mcp.handshake()
      const ids = Array.from({ length: 200 }, (_, index) => 1000 + index)
      // Stop reading the supervisor's stdout so its writes pile up past the pipe's buffer, as a busy client's do.
      mcp.child.stdout.pause()
      for (const id of ids) mcp.send(id, "tools/list")
      await Bun.sleep(1_500)
      mcp.child.stdin.end()
      mcp.child.stdout.resume()
      const exit = await within(15_000, mcp.exit, "the supervisor's stdin EOF exit")
      expect({ ...exit, stderr: mcp.stderr() }).toMatchObject({ code: 0, signal: null })
      expect(ids.filter((id) => !mcp.answered(id))).toEqual([])
    } finally {
      mcp.child.kill("SIGKILL")
    }
  }, 30_000)

  test.skipIf(process.platform === "win32")("a real SIGINT still exits 130", async () => {
    const mcp = server([process.execPath, source, "mcp"], { OPENCODE_BROWSER_MCP_DIRECT: "1" })
    try {
      await mcp.handshake()
      mcp.child.kill("SIGINT")
      const exit = await within(4_000, mcp.exit, "the direct server's SIGINT exit")
      // 130 is the default teardown's interrupt exit; some platforms report the signal instead. Never 0.
      expect(exit.signal === "SIGINT" || exit.code === 130).toBe(true)
    } finally {
      mcp.child.kill("SIGKILL")
    }
  }, 20_000)
})
