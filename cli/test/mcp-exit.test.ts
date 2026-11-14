import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import fs from "node:fs"
import { createServer, type Socket } from "node:net"
import os from "node:os"
import path from "node:path"
import { bundleCli } from "../bundle.ts"

// Closing stdin is how an MCP client shuts a stdio server down. The server must then exit 0, not SIGINT's 130.
const temporary = path.join(os.homedir(), ".cache", "oc-tmp")
fs.mkdirSync(temporary, { recursive: true })
const home = fs.mkdtempSync(path.join(temporary, "browse-mcp-exit-"))
const source = path.join(import.meta.dir, "../src/main.ts")
const children = new Set<ReturnType<typeof spawn>>()
/** An npm install of this CLI under the test's HOME, so `browse mcp` runs under Node as npm installs do. */
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
  // An older install's supervisor sets these for a server it starts; inherit none from whatever started the tests.
  OPENCODE_BROWSER_CLIENT_PID: undefined,
  OPENCODE_BROWSER_MCP_SESSION: undefined,
  ...extra,
})

const initialize = { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "0" } }

/** What a 2026-07-28 client (Claude Code, say) sends with each request instead of initializing. */
const modernMeta = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "test", version: "0" },
  "io.modelcontextprotocol/clientCapabilities": {},
}

type Reply = { result?: Record<string, unknown>; error?: unknown }

/** A server notification: no id, just a method and params. */
type Notification = { method: string; params?: Record<string, unknown> }

/** A private executable at the installed path, so `browse mcp` runs the checkout's server from it. */
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

/** Kills a test's process when an expectation failed before it exited. */
function cleanup(mcp?: ReturnType<typeof server>) {
  mcp?.child.kill("SIGKILL")
}

/** Starts `browse mcp` and speaks enough of the protocol to prove the server is serving before stdin closes. */
function server(command: readonly string[], extra: NodeJS.ProcessEnv = {}) {
  const child = spawn(command[0]!, command.slice(1), { stdio: ["pipe", "pipe", "pipe"], env: env(extra), windowsHide: true })
  children.add(child)
  const pending = new Map<number, (reply: Reply) => void>()
  const answered = new Set<number>()
  const notifications: Notification[] = []
  const notified = new Map<string, Array<(message: Notification) => void>>()
  let buffer = ""
  let stderr = ""
  child.stdout.on("data", (chunk) => {
    buffer += chunk
    for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      if (!line.trim()) continue
      const message = JSON.parse(line) as Reply & { id?: number; method?: string; params?: Record<string, unknown> }
      if (message.method !== undefined) {
        const notification = { method: message.method, ...(message.params ? { params: message.params } : {}) }
        notifications.push(notification)
        for (const resolve of notified.get(notification.method) ?? []) resolve(notification)
        notified.delete(notification.method)
        continue
      }
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
  /** Waits for a server notification, such as a subscription's acknowledgement. */
  const waitForNotification = (method: string) =>
    new Promise<Notification>((resolve) => {
      const seen = notifications.find((notification) => notification.method === method)
      if (seen) return resolve(seen)
      notified.set(method, [...(notified.get(method) ?? []), resolve])
    })
  return { child, handshake, waitForNotification, request, exit, stderr: () => stderr, answered: (id: number) => answered.has(id), send }
}

/** Starts `browse mcp` and opens the change subscription a 2026-07-28 client keeps for the whole connection. */
async function subscribedServer(command: readonly string[], extra: NodeJS.ProcessEnv = {}) {
  const mcp = server(command, extra)
  try {
    const discovery = await mcp.request(1, "server/discover", { _meta: modernMeta })
    if (!Array.isArray(discovery.result?.supportedVersions)) throw new Error(`server/discover failed: ${JSON.stringify(discovery)} ${mcp.stderr()}`)
    mcp.send(2, "subscriptions/listen", { _meta: modernMeta, notifications: { toolsListChanged: true } })
    const acknowledged = await within(4_000, mcp.waitForNotification("notifications/subscriptions/acknowledged"), "the subscription acknowledgement")
    if (acknowledged.params?.notifications === undefined) throw new Error(`subscriptions/listen failed: ${JSON.stringify(acknowledged)} ${mcp.stderr()}`)
    return mcp
  } catch (error) {
    cleanup(mcp)
    throw error
  }
}

const within = <A>(ms: number, promise: Promise<A>, what: string): Promise<A> =>
  Promise.race([promise, Bun.sleep(ms).then((): never => { throw new Error(`${what} didn't finish within ${ms} ms`) })])

/** A relay port that accepts connections but never answers, so relay reads wait for their timeout instead of failing fast. */
async function blackholeRelay() {
  const sockets = new Set<Socket>()
  const listener = createServer((socket) => {
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
  })
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject)
    listener.listen(0, "127.0.0.1", resolve)
  })
  const address = listener.address()
  if (address === null || typeof address === "string") throw new Error("blackhole relay has no port")
  return {
    port: address.port,
    close: () => {
      for (const socket of sockets) socket.destroy()
      listener.close()
    },
  }
}

describe("browse mcp shuts down cleanly when its client closes stdin", () => {
  test("the server exits 0", async () => {
    const mcp = server([process.execPath, source, "mcp"])
    try {
      await mcp.handshake()
      const started = Date.now()
      mcp.child.stdin.end()
      const exit = await within(4_000, mcp.exit, "the server's stdin EOF exit")
      expect({ ...exit, stderr: mcp.stderr(), ms: Date.now() - started }).toMatchObject({ code: 0, signal: null })
    } finally {
      cleanup(mcp)
    }
  }, 20_000)

  test("the server exits 0 after a live 2026-07-28 subscription", async () => {
    // Claude Code opens `subscriptions/listen` on connect; that request never answers while the client is connected.
    const mcp = await subscribedServer([process.execPath, source, "mcp"])
    try {
      const started = Date.now()
      mcp.child.stdin.end()
      const exit = await within(4_000, mcp.exit, "the subscribed server's stdin EOF exit")
      expect({ ...exit, stderr: mcp.stderr(), ms: Date.now() - started }).toMatchObject({ code: 0, signal: null })
    } finally {
      cleanup(mcp)
    }
  }, 20_000)

  test("a slow tool call still answers after stdin EOF", async () => {
    // `tabs_cleanup` needs the relay. A port that accepts but never answers makes its relay probe wait for the 5 s read
    // timeout, so a tool call is genuinely in flight when stdin closes: it must still be answered. Only a request that
    // never answers, such as `subscriptions/listen`, may be cut.
    const relay = await blackholeRelay()
    const mcp = server([process.execPath, source, "mcp"], { OPENCODE_BROWSER_PORT: String(relay.port) })
    try {
      await mcp.handshake()
      const reply = mcp.request(3, "tools/call", { name: "tabs_cleanup", arguments: {} })
      // Let the call reach the tool before the client goes away.
      await Bun.sleep(300)
      const started = Date.now()
      mcp.child.stdin.end()
      const answer = await within(10_000, reply, "the slow tool call's answer")
      // A real tool result, not the error an interrupted request is answered with.
      expect(answer.error).toBeUndefined()
      expect(answer.result).toBeDefined()
      const exit = await within(10_000, mcp.exit, "the server's exit after a slow tool call")
      expect({ ...exit, stderr: mcp.stderr(), ms: Date.now() - started }).toMatchObject({ code: 0, signal: null })
    } finally {
      cleanup(mcp)
      relay.close()
    }
  }, 30_000)

  test.skipIf(process.platform === "win32")("an installed binary runs the server and exits 0 promptly", async () => {
    const mcp = server([installedBinary(), "mcp"])
    try {
      await mcp.handshake()
      const started = Date.now()
      mcp.child.stdin.end()
      const exit = await within(4_000, mcp.exit, "the binary's stdin EOF exit")
      expect({ ...exit, stderr: mcp.stderr(), ms: Date.now() - started }).toMatchObject({ code: 0, signal: null })
    } finally {
      cleanup(mcp)
    }
  }, 20_000)

  test("the server flushes responses a paused client hasn't read", async () => {
    // Node's stdout to a pipe buffers asynchronously; Bun's writes block instead, so only this shape loses data on exit.
    const mcp = server(["node", installed, "mcp"])
    try {
      await mcp.handshake()
      const ids = Array.from({ length: 200 }, (_, index) => 1000 + index)
      // Stop reading the server's stdout so its writes pile up past the pipe's buffer, as a busy client's do.
      mcp.child.stdout.pause()
      for (const id of ids) mcp.send(id, "tools/list")
      await Bun.sleep(1_500)
      mcp.child.stdin.end()
      mcp.child.stdout.resume()
      const exit = await within(15_000, mcp.exit, "the server's stdin EOF exit")
      expect({ ...exit, stderr: mcp.stderr() }).toMatchObject({ code: 0, signal: null })
      expect(ids.filter((id) => !mcp.answered(id))).toEqual([])
    } finally {
      cleanup(mcp)
    }
  }, 30_000)

  test.skipIf(process.platform === "win32")("a real SIGINT still exits 130", async () => {
    const mcp = server([process.execPath, source, "mcp"])
    try {
      await mcp.handshake()
      mcp.child.kill("SIGINT")
      const exit = await within(4_000, mcp.exit, "the server's SIGINT exit")
      // 130 is the default teardown's interrupt exit; some platforms report the signal instead. Never 0.
      expect(exit.signal === "SIGINT" || exit.code === 130).toBe(true)
    } finally {
      cleanup(mcp)
    }
  }, 20_000)
})

describe("a server npm starts under Node exits on its own", () => {
  test.skipIf(process.platform === "win32")("closing stdin with a live subscription exits 0", async () => {
    // Node's stdin has its own EOF timing.
    const mcp = await subscribedServer(["node", installed, "mcp"])
    try {
      const started = Date.now()
      mcp.child.stdin.end()
      const exit = await within(4_000, mcp.exit, "the Node server's stdin EOF exit with a subscription")
      expect({ ...exit, stderr: mcp.stderr(), ms: Date.now() - started }).toMatchObject({ code: 0, signal: null })
    } finally {
      cleanup(mcp)
    }
  }, 20_000)

  test.skipIf(process.platform === "win32")("SIGINT with a live subscription exits 130", async () => {
    const mcp = await subscribedServer(["node", installed, "mcp"])
    try {
      mcp.child.kill("SIGINT")
      const exit = await within(4_000, mcp.exit, "the Node server's SIGINT exit")
      expect(exit.signal === "SIGINT" || exit.code === 130).toBe(true)
    } finally {
      cleanup(mcp)
    }
  }, 20_000)

  test.skipIf(process.platform === "win32")("SIGTERM with a live subscription exits 130", async () => {
    const mcp = await subscribedServer(["node", installed, "mcp"])
    try {
      mcp.child.kill("SIGTERM")
      const exit = await within(4_000, mcp.exit, "the Node server's SIGTERM exit")
      // The default teardown reports every signal as 130; some platforms report the signal instead.
      expect(exit.signal === "SIGTERM" || exit.code === 130).toBe(true)
    } finally {
      cleanup(mcp)
    }
  }, 20_000)
})
