// `browse mcp` from a binary install: the npm shim's supervisor (auto-update.ts shimSource), for executables. Agents'
// MCP entries run the executable on PATH, which an update replaces by rename while their server keeps running. This
// supervisor starts the current version's server (runtime/versions/<version>/browse mcp), forwards stdio
// (newline-delimited JSON-RPC), and once current.json names another version, the relay runs it and no request is in
// flight, starts the new server, replays the client's `initialize` to it (its answer is dropped) and carries on; while it
// swaps, client messages wait. Keep it in step with the shim.
import { spawn, type ChildProcessByStdio } from "node:child_process"
import type { Readable, Writable } from "node:stream"
import { existsSync } from "node:fs"
import { createInterface } from "node:readline"
import { npmRuntime, readCurrent, versionEntry } from "../update/auto-update.ts"

/** Set for the server a supervisor starts, so it serves instead of supervising again. */
export const directEnvironmentVariable = "OPENCODE_BROWSER_MCP_DIRECT"

type Message = { id?: unknown; method?: unknown; result?: { capabilities?: { tools?: { listChanged?: unknown } } } }

export async function runBinaryMcp(args: readonly string[]) {
  const runtime = npmRuntime()
  if (!runtime) {
    // Not an installed binary (a downloaded executable run in place): nothing updates it, so serve directly.
    process.env[directEnvironmentVariable] = "1"
    const { runCli } = await import("../cli.ts")
    return runCli()
  }
  const { layout } = runtime
  const REPLAY = "opencode-browser-shim-initialize"
  const relayPort = Number(process.env.OPENCODE_BROWSER_PORT) || 19988
  const current = () => readCurrent(layout)?.version ?? runtime.version
  // A version whose directory is gone (removed by hand) runs as the executable on PATH, which is the current one.
  const command = (version: string) => {
    const entry = versionEntry(layout, version, true)
    return existsSync(entry) ? entry : runtime.current.binary ?? process.execPath
  }
  // Every server this supervisor starts keeps one implicit session, and the relay watches this process (not the
  // server it replaces), so an update doesn't end the agent's session or close its tabs.
  process.env.OPENCODE_BROWSER_MCP_SESSION ??= "mcp-" + Math.random().toString(16).slice(2, 10).padEnd(8, "0")
  process.env.OPENCODE_BROWSER_CLIENT_PID = String(process.pid)
  let version = current()
  let child: ChildProcessByStdio<Writable, Readable, null>
  let initialize: Message | undefined
  let initialized: string | undefined
  let swapping = false
  let listChanged = false
  // The version a swap replaced, until the new server answers; and a version whose server exited before it did.
  let replaced: string | undefined
  let failed: string | undefined
  const inflight = new Set<unknown>()
  const queue: string[] = []
  const toClient = (line: string) => process.stdout.write(line + "\n")
  const toChild = (line: string) => child.stdin.write(line + "\n")
  const parse = (line: string): Message | undefined => {
    try {
      return JSON.parse(line) as Message
    } catch {
      return undefined
    }
  }

  const start = (replay: boolean) => {
    const next = spawn(command(version), ["mcp", ...args], { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, [directEnvironmentVariable]: "1" } })
    // A server that exits mid-write (an old one being replaced) must not take the supervisor down with EPIPE.
    next.stdin.on("error", () => {})
    child = next
    next.on("exit", (code, signal) => {
      if (next !== child) return
      // A new version's server that exits before it's ready (a release that doesn't start) gives way to the old one.
      if (replaced !== undefined) {
        failed = version
        version = replaced
        replaced = undefined
        return void start(true)
      }
      process.exit(code ?? (signal ? 1 : 0))
    })
    createInterface({ input: next.stdout }).on("line", (line) => {
      if (next !== child) return
      const message = parse(line)
      if (message && message.id === REPLAY) {
        replaced = undefined
        if (initialized) toChild(initialized)
        swapping = false
        if (listChanged) toClient(JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" }))
        for (const queued of queue.splice(0)) fromClient(queued)
        return
      }
      if (message && message.id !== undefined && message.method === undefined) {
        inflight.delete(message.id)
        if (message.result?.capabilities?.tools) listChanged = message.result.capabilities.tools.listChanged === true
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
  let heldSince: number | undefined
  const moved = () => {
    const next = current()
    return next !== version && next !== failed
  }
  const fromClient = (line: string) => {
    if (swapping) return void queue.push(line)
    if (moved()) {
      heldSince ??= Date.now()
      queue.push(line)
      return void maybeSwap()
    }
    const message = parse(line)
    if (message?.method === "initialize") initialize = message
    if (message?.method === "notifications/initialized") initialized = line
    if (message && message.id !== undefined && message.method !== undefined) inflight.add(message.id)
    toChild(line)
  }

  // A new version in current.json swaps the server only once the relay runs it too (GET /version), so a server never
  // talks to a relay of another version. With no relay at all for a few checks, nothing can mix, and it swaps. Never to
  // a version whose server already failed to start: this server keeps going, whatever current.json and the relay say.
  let checking = false
  let unreachable = 0
  const relayVersion = () =>
    fetch(`http://127.0.0.1:${relayPort}/version`, { signal: AbortSignal.timeout(2000) })
      .then((response) => (response.ok ? (response.json() as Promise<{ version?: unknown }>) : undefined))
      .then((body) => (body && typeof body.version === "string" ? body.version : undefined), () => undefined)
  const maybeSwap = async () => {
    if (swapping || checking || inflight.size > 0) return
    const next = current()
    if (next === version || next === failed) {
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
    if (running !== next && unreachable < 3) {
      if (heldSince !== undefined && Date.now() - heldSince > 15000) {
        heldSince = undefined
        for (const line of queue.splice(0)) {
          const message = parse(line)
          if (message && message.id !== undefined && message.method !== undefined) inflight.add(message.id)
          toChild(line)
        }
      }
      return
    }
    if (swapping || inflight.size > 0 || current() !== next) return
    const old = child
    replaced = initialize ? version : undefined
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
