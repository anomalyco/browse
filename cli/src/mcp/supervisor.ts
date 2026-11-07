// `browse mcp` from an installed binary or npm global package: supervise the server so an update swaps it. Agents'
// MCP entries run a stable path (the executable, or the global package's CLI bundle), which the installer replaces in
// place. This supervisor starts that path, forwards stdio (newline-delimited JSON-RPC), and once the installed version
// changes and the relay runs it (or no relay exists), starts the new server, replays the client's `initialize` to it
// (its answer is dropped) and carries on; while it swaps, client messages wait. An npx entry or a downloaded executable
// has nothing supervising it, and serves directly.
import { spawn, type ChildProcessByStdio } from "node:child_process"
import type { Readable, Writable } from "node:stream"
import { existsSync, statSync } from "node:fs"
import path from "node:path"
import { createInterface } from "node:readline"
import { entrySpawnCommand } from "../paths.ts"
import { installedRuntime, installedVersion, type Runtime } from "../update/auto-update.ts"

/** Set for the server a supervisor starts, so it serves instead of supervising again. */
export const directEnvironmentVariable = "OPENCODE_BROWSER_MCP_DIRECT"

type Message = { id?: unknown; method?: unknown; params?: unknown; result?: { capabilities?: { tools?: { listChanged?: unknown } } } }

/** The file whose change means a new version: the executable, or the npm package's manifest. */
const watchedFile = (runtime: Runtime) =>
  runtime.kind === "binary" ? runtime.entry : path.join(path.dirname(path.dirname(runtime.entry)), "package.json")

/** The installed version, re-read only when the watched file changes. */
function versionReader(runtime: Runtime, initial: string) {
  let version = initial
  let stamp = ""
  return () => {
    try {
      const stat = statSync(watchedFile(runtime))
      const next = `${stat.mtimeMs}:${stat.size}`
      if (next === stamp) return version
      stamp = next
      version = installedVersion(runtime) ?? version
      return version
    } catch {
      return version
    }
  }
}

export async function runBinaryMcp(args: readonly string[]) {
  const runtime = installedRuntime()
  if (!runtime || runtime.kind === "npx") {
    // Not an installed binary or global npm package: nothing updates it, so serve directly.
    process.env[directEnvironmentVariable] = "1"
    const { runCli } = await import("../cli.ts")
    return runCli()
  }
  const REPLAY = "opencode-browser-shim-initialize"
  const relayPort = Number(process.env.OPENCODE_BROWSER_PORT) || 19988
  const current = versionReader(runtime, installedVersion(runtime) ?? runtime.version)
  // A stable entry path, replaced in place by the installer.
  const command = () => runtime.entry
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
  // A request is in flight until its response; a cancelled request never gets one, so its client tells us to forget it.
  const trackRequest = (message: Message | undefined) => {
    if (!message) return
    if (message.id !== undefined && message.method !== undefined) inflight.add(message.id)
    if (message.method !== "notifications/cancelled" || !message.params || typeof message.params !== "object") return
    const cancelled = (message.params as { requestId?: unknown }).requestId
    if (cancelled !== undefined) inflight.delete(cancelled)
  }
  const forward = (line: string) => {
    trackRequest(parse(line))
    toChild(line)
  }

  const start = (replay: boolean) => {
    const [file, ...prefix] = entrySpawnCommand(command())
    const next = spawn(file!, [...prefix, "mcp", ...args], { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, [directEnvironmentVariable]: "1" } })
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

  // Once the installed version changes, new requests wait for the swap instead of reaching a server whose relay is
  // going away (or already runs the other version); a switch that doesn't happen releases them.
  let heldSince: number | undefined
  const moved = () => current() !== version
  const fromClient = (line: string) => {
    const message = parse(line)
    // A cancellation drops the request at once, even while client messages wait: it may be the one blocking the swap.
    if (message?.method === "notifications/cancelled") trackRequest(message)
    if (swapping) return void queue.push(line)
    if (moved()) {
      heldSince ??= Date.now()
      queue.push(line)
      return void maybeSwap()
    }
    if (message?.method === "initialize") initialize = message
    if (message?.method === "notifications/initialized") initialized = line
    forward(line)
  }

  // A new version swaps the server only once the relay runs it too (GET /version), so a server never talks to a relay
  // of another version. With no relay at all for a few checks, nothing can mix, and it swaps.
  let checking = false
  let unreachable = 0
  const relayVersion = () =>
    fetch(`http://127.0.0.1:${relayPort}/version`, { signal: AbortSignal.timeout(2000) })
      .then((response) => (response.ok ? (response.json() as Promise<{ version?: unknown }>) : undefined))
      .then((body) => (body && typeof body.version === "string" ? body.version : undefined), () => undefined)
  const maybeSwap = async () => {
    if (swapping || checking) return
    // Held requests go to the current server at the deadline even when a request still looks in flight: a cancelled
    // request may never answer, and waiting for it would wedge the swap forever.
    if (heldSince !== undefined && Date.now() - heldSince > 15000) {
      heldSince = undefined
      for (const line of queue.splice(0)) forward(line)
    }
    if (inflight.size > 0) return
    const next = current()
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

/** Whether this process should supervise its MCP server (an installed binary or global npm package). */
export function supervisesMcp(): boolean {
  const runtime = installedRuntime()
  return !!runtime && runtime.kind !== "npx" && existsSync(runtime.entry)
}
