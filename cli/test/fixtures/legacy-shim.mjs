#!/usr/bin/env node
// browse's stable entry, written by install (cli/src/auto-update.ts). opencode's browse MCP server runs this
// file, so its configuration never changes when the runtime updates. Don't edit; install rewrites it.
import { spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import path from "node:path"
import { createInterface } from "node:readline"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const runtime = path.join(root, "runtime")
const installed = () => JSON.parse(readFileSync(path.join(runtime, "current.json"), "utf8"))
const current = () => installed().version
const entry = (version) => path.join(runtime, "versions", version, "node_modules", "@opencode", "browse", "dist", "cli.mjs")
process.env.OPENCODE_BROWSER_HOME ??= root
const relayPort = Number(process.env.OPENCODE_BROWSER_PORT) || 19988

const binary = installed().binary
if (binary) {
  // An agent still runs the npm entry after a binary install. The executable supplies its own MCP supervisor.
  const child = spawn(binary, process.argv.slice(2), { stdio: "inherit" })
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => child.kill(signal))
  child.on("exit", (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0) })
} else if (process.argv[2] !== "mcp") {
  process.argv[1] = entry(current())
  await import(pathToFileURL(entry(current())).href)
} else {
  const REPLAY = "opencode-browser-shim-initialize"
  // Every server this supervisor starts keeps one implicit session, and the relay watches this process (not the
  // server it replaces), so an update doesn't end the agent's session or close its tabs.
  process.env.OPENCODE_BROWSER_MCP_SESSION ??= "mcp-" + Math.random().toString(16).slice(2, 10).padEnd(8, "0")
  process.env.OPENCODE_BROWSER_CLIENT_PID = String(process.pid)
  let version = current()
  let child
  let initialize
  let initialized
  let swapping = false
  let listChanged = false
  const inflight = new Set()
  const queue = []
  const toClient = (line) => process.stdout.write(line + "\n")
  const toChild = (line) => child.stdin.write(line + "\n")
  const parse = (line) => { try { return JSON.parse(line) } catch { return undefined } }
  // A request is in flight until its response; a cancelled request never gets one, so its client tells us to forget it.
  const trackRequest = (message) => {
    if (!message) return
    if (message.id !== undefined && message.method !== undefined) inflight.add(message.id)
    if (message.method !== "notifications/cancelled" || !message.params || typeof message.params !== "object") return
    const cancelled = message.params.requestId
    if (cancelled !== undefined) inflight.delete(cancelled)
  }
  const forward = (line) => { trackRequest(parse(line)); toChild(line) }

  const start = (replay) => {
    const next = spawn(process.execPath, [entry(version), "mcp"], { stdio: ["pipe", "pipe", "inherit"], env: process.env })
    // A server that exits mid-write (an old one being replaced) must not take the supervisor down with EPIPE.
    next.stdin.on("error", () => {})
    child = next
    next.on("exit", (code, signal) => {
      if (next !== child) return
      process.exit(code ?? (signal ? 1 : 0))
    })
    createInterface({ input: next.stdout }).on("line", (line) => {
      if (next !== child) return
      const message = parse(line)
      if (message && message.id === REPLAY) {
        if (initialized) toChild(initialized)
        swapping = false
        if (listChanged) toClient(JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" }))
        for (const queued of queue.splice(0)) fromClient(queued)
        return
      }
      if (message && message.id !== undefined && message.method === undefined) {
        inflight.delete(message.id)
        if (message.result && message.result.capabilities && message.result.capabilities.tools) listChanged = message.result.capabilities.tools.listChanged === true
      }
      toClient(line)
      void maybeSwap()
    })
    if (replay && initialize) {
      swapping = true
      toChild(JSON.stringify({ ...initialize, id: REPLAY }))
    }
  }

  // Once current.json names another version, new requests wait for the swap instead of reaching a server whose relay is
  // going away (or already runs the other version); a switch that doesn't happen releases them.
  let heldSince
  const moved = () => { try { return current() !== version } catch { return false } }
  const fromClient = (line) => {
    const message = parse(line)
    // A cancellation drops the request at once, even while client messages wait: it may be the one blocking the swap.
    if (message && message.method === "notifications/cancelled") trackRequest(message)
    if (swapping) return void queue.push(line)
    if (moved()) {
      heldSince ??= Date.now()
      queue.push(line)
      return void maybeSwap()
    }
    if (message && message.method === "initialize") initialize = message
    if (message && message.method === "notifications/initialized") initialized = line
    forward(line)
  }

  // A new version in current.json swaps the server only once the relay runs it too (GET /version), so a server never
  // talks to a relay of another version. With no relay at all for a few checks, nothing can mix, and it swaps.
  let checking = false
  let unreachable = 0
  const relayVersion = () => fetch("http://127.0.0.1:" + relayPort + "/version", { signal: AbortSignal.timeout(2000) })
    .then((response) => (response.ok ? response.json() : undefined))
    .then((body) => (body && typeof body.version === "string" ? body.version : undefined), () => undefined)
  const maybeSwap = async () => {
    if (swapping || checking) return
    // Held requests go to the current server at the deadline even when a request still looks in flight: a cancelled
    // request may never answer, and waiting for it would wedge the swap forever.
    if (heldSince !== undefined && Date.now() - heldSince > 15000) {
      heldSince = undefined
      const released = queue.splice(0)
      for (const line of released) forward(line)
    }
    if (inflight.size > 0) return
    let next
    try { next = current() } catch { return }
    if (next === version) {
      unreachable = 0
      heldSince = undefined
      for (const queued of queue.splice(0)) fromClient(queued)
      return
    }
    checking = true
    const running = await relayVersion()
    checking = false
    unreachable = running === undefined ? unreachable + 1 : 0
    // Held requests don't wait forever for a relay that never reports the new version: they go to the current server.
    if (running !== next && unreachable < 3) return
    if (swapping || inflight.size > 0 || current() !== next) return
    const old = child
    version = next
    heldSince = undefined
    start(true)
    old.stdin.end()
    setTimeout(() => old.kill(), 5000).unref()
  }

  start(false)
  createInterface({ input: process.stdin }).on("line", fromClient).on("close", () => {
    child.stdin.end()
    setTimeout(() => process.exit(0), 5000).unref()
  })
  setInterval(() => void maybeSwap(), 1000).unref()
}
