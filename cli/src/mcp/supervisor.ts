// `browse mcp` from an installed binary or npm global package: supervise the server so an update swaps it. Agents'
// MCP entries run a stable path (the executable, or the global package's CLI bundle), which the installer replaces in
// place. This supervisor starts that path, forwards stdio (newline-delimited JSON-RPC), and once the installed version
// changes and the relay runs it (or no relay exists), starts the new server, replays the client's `initialize` to it
// (its answer is dropped) and carries on; while it swaps, client messages wait. An npx entry or a downloaded executable
// has nothing supervising it, and serves directly. So does a server another supervisor started: an older install's
// stable shim (bin/opencode-browser.mjs) supervises the version it starts, without telling it to serve directly.
import { spawn, type ChildProcessByStdio } from "node:child_process"
import { randomUUID } from "node:crypto"
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
      const stat = statSync(watchedFile(runtime), { bigint: true })
      // Packed releases can have identical mtimes and sizes. Rename replaces the inode;
      // retain change and creation times for filesystems that don't report a useful inode.
      const next = `${stat.dev}:${stat.ino}:${stat.ctimeNs}:${stat.birthtimeNs}:${stat.mtimeNs}:${stat.size}`
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
  // This supervisor's own replay id: a replay from another supervisor (an older shim above this one, which uses the
  // bare prefix) is a client request like any other, and its answer goes back up.
  const REPLAY = `opencode-browser-shim-initialize-${randomUUID()}`
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
  let swapDeadline: ReturnType<typeof setTimeout> | undefined
  let listChanged = false
  const inflight = new Set<unknown>()
  const queue: string[] = []
  const toClient = (line: string) => process.stdout.write(line + "\n")
  const toChild = (line: string) => child.stdin.write(line + "\n")
  // The child is gone and its stdout is fully read: give the client the answers still buffered in our own stdout, then
  // exit with the child's status. `process.exit` alone would drop them when the client wasn't reading.
  let finishing = false
  const finish = (code: number) => {
    if (finishing) return
    finishing = true
    process.stdout.write("", () => process.exit(code))
  }
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
    const message = parse(line)
    if (message?.method === "initialize") initialize = message
    if (message?.method === "notifications/initialized") initialized = line
    trackRequest(message)
    toChild(line)
  }

  const start = (replay: boolean) => {
    const [file, ...prefix] = entrySpawnCommand(command())
    const next = spawn(file!, [...prefix, "mcp", ...args], { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, [directEnvironmentVariable]: "1" }, windowsHide: true })
    // A server that exits mid-write (an old one being replaced) must not take the supervisor down with EPIPE.
    next.stdin.on("error", () => {})
    child = next
    // A server replaced by a swap keeps exiting in the background; only the current child's status ends the supervisor.
    // Wait for both its close (stdio is done) and readline's close (every line reached the client) before exiting.
    let linesDone = false
    let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined
    const finishChild = () => {
      if (next !== child || !linesDone || !exited) return
      finish(exited.code ?? (exited.signal ? 1 : 0))
    }
    next.on("close", (code, signal) => {
      exited = { code, signal }
      finishChild()
    })
    const reader = createInterface({ input: next.stdout })
    reader.on("close", () => {
      linesDone = true
      finishChild()
    })
    reader.on("line", (line) => {
      if (next !== child) return
      const message = parse(line)
      // The replay's answer is ours alone, even when it arrives after the deadline released the queue.
      if (message && message.id === REPLAY) return finishSwap()
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
      // The new server reads the replay before anything queued behind it, so a late (or lost) answer needn't hold
      // client messages: after a few seconds they go to the new server anyway.
      swapDeadline = setTimeout(finishSwap, 5000)
      swapDeadline.unref()
    }
  }
  const finishSwap = () => {
    if (!swapping) return
    clearTimeout(swapDeadline)
    swapping = false
    if (initialized) toChild(initialized)
    if (listChanged) toClient(JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" }))
    for (const queued of queue.splice(0)) fromClient(queued)
  }

  // Once the installed version changes, check which relay is serving before routing new requests.
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
    forward(line)
  }

  // A new version swaps the server only once the relay runs it too (GET /version), so a server never talks to a relay
  // of another version. With no relay at all for a few checks, nothing can mix, and it swaps.
  let checking = false
  let unreachable = 0
  const relayVersion = () =>
    fetch(`http://127.0.0.1:${relayPort}/version`, { signal: AbortSignal.timeout(2000) })
      .then((response) => (response.ok ? (response.json() as Promise<{ version?: unknown; draining?: unknown }>) : undefined))
      .then((body) => (body && typeof body.version === "string" ? { version: body.version, draining: body.draining === true } : undefined), () => undefined)
  const maybeSwap = async () => {
    if (swapping || checking) return
    // Held requests go to the current server at the deadline even when a request still looks in flight: a cancelled
    // request may never answer, and waiting for it would wedge the swap forever.
    if (heldSince !== undefined && Date.now() - heldSince > 15000) {
      heldSince = undefined
      for (const line of queue.splice(0)) forward(line)
    }
    if (inflight.size > 0 && !queue.length) return
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
    if (running?.draining) return
    if (running?.version === version) {
      // The entry on disk moved, but the current server still matches the relay (even with other calls in flight).
      heldSince = undefined
      for (const line of queue.splice(0)) forward(line)
      return
    }
    // Held requests don't wait forever for a relay that never reports the new version: they go to the current server.
    if (running?.version !== next && unreachable < 3) return
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
    // The child normally exits on its own and `finish` flushes first. This unblocks a child that never does, without
    // cutting off a flush already in progress.
    setTimeout(() => finish(0), 5000).unref()
  })
  setInterval(() => void maybeSwap(), 1000).unref()
}

/** Whether this process should supervise its MCP server (an installed binary or global npm package). */
export function supervisesMcp(): boolean {
  // A supervisor names itself the client before starting its server. The shim older installs left in agents' configs
  // starts each runtime version this way, and supervising again under it would stack two supervisors on one server.
  if (process.env.OPENCODE_BROWSER_CLIENT_PID === String(process.ppid)) return false
  const runtime = installedRuntime()
  return !!runtime && runtime.kind !== "npx" && existsSync(runtime.entry)
}
