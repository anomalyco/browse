// Auto-update for npm installs (`npx @opencode/browse install`). A checkout never auto-updates: it has `update`.
//
// Layout in the data root:
//   runtime/versions/<version>/   one npm prefix per installed version (node_modules/@opencode/browse/dist/cli.mjs)
//   runtime/current.json          { version, previous, channel }: the version every new process runs
//   bin/opencode-browser.mjs      the stable shim opencode's MCP entry runs; it reads current.json, so the config
//                                 never changes. For `mcp` it supervises the server and swaps it for the new version
//                                 between requests once current.json moves.
//   auto-update.json              the user's mode and what the last check found
//
// The relay checks the registry for its channel's dist-tag (latest, or beta for a beta install) at most once a day.
// Mode "on" (default) installs a newer version into its own directory, verifies it (the installed package's integrity
// is the one the registry published for that version, and it runs and reports that version), and once no agent is using
// the browser, switches current.json and restarts the relay from the new version. "notify" only shows the update;
// "off" doesn't check. OPENCODE_BROWSER_AUTO_UPDATE overrides the stored mode. The previous version stays installed for
// `opencode-browser rollback`, which also skips the version it rolled back from until a newer one is published.
import { spawn } from "node:child_process"
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { dataRoot, fromCheckout } from "./paths.ts"

export const PACKAGE_NAME = "@opencode/browse"
const DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_REGISTRY = "https://registry.npmjs.org"

export const autoUpdateModes = ["on", "notify", "off"] as const
export type AutoUpdateMode = (typeof autoUpdateModes)[number]
export type Channel = "latest" | "beta"

export type Layout = {
  readonly root: string
  readonly runtime: string
  readonly versions: string
  readonly current: string
  readonly shim: string
  readonly state: string
}

export function runtimeLayout(root = dataRoot()): Layout {
  const runtime = path.join(root, "runtime")
  return {
    root,
    runtime,
    versions: path.join(runtime, "versions"),
    current: path.join(runtime, "current.json"),
    shim: path.join(root, "bin", "opencode-browser.mjs"),
    state: path.join(root, "auto-update.json"),
  }
}

export const versionDirectory = (layout: Layout, version: string) => path.join(layout.versions, version)
export const versionEntry = (layout: Layout, version: string) =>
  path.join(versionDirectory(layout, version), "node_modules", "@opencode", "browse", "dist", "cli.mjs")

export const channelOf = (version: string): Channel => (version.includes("-beta.") ? "beta" : "latest")

/** 1.2.3 and 1.2.3-beta.4, a beta below its release; anything else sorts as unknown (never newer). */
export function compareVersions(left: string, right: string): number {
  const parse = (value: string) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$/.exec(value)
    return match ? [Number(match[1]), Number(match[2]), Number(match[3]), match[4] === undefined ? Number.POSITIVE_INFINITY : Number(match[4])] : undefined
  }
  const a = parse(left)
  const b = parse(right)
  if (!a || !b) return 0
  for (let index = 0; index < 4; index++) if (a[index] !== b[index]) return a[index]! < b[index]! ? -1 : 1
  return 0
}

// ---- files ------------------------------------------------------------------------------------------

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T
  } catch {
    return undefined
  }
}

function writeJsonAtomic(file: string, value: unknown) {
  mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 })
  renameSync(temporary, file)
}

export type Current = { readonly version: string; readonly previous?: string; readonly channel: Channel; readonly switchedAt?: string }

export function readCurrent(layout = runtimeLayout()): Current | undefined {
  const current = readJson<Current>(layout.current)
  return current && typeof current.version === "string" ? current : undefined
}

export function writeCurrent(layout: Layout, current: Current) {
  writeJsonAtomic(layout.current, { ...current, switchedAt: new Date().toISOString() })
}

export type AutoUpdateState = {
  readonly mode?: AutoUpdateMode
  readonly checkedAt?: number
  readonly latest?: string
  readonly integrity?: string
  readonly failed?: string
  /** Installed and verified, waiting for the browser to be idle. */
  readonly pending?: string
  /** Rolled back from: not installed again until a newer version is published. */
  readonly skipped?: string
  readonly lastUpdate?: { readonly from: string; readonly to: string; readonly at: string }
  readonly lastError?: { readonly message: string; readonly at: string; readonly version?: string }
  /** An installer running in its own process (`runtime-install`), so npm never blocks the relay. */
  readonly installing?: { readonly version: string; readonly pid: number; readonly startedAt: number }
}

export function readState(layout = runtimeLayout()): AutoUpdateState {
  return readJson<AutoUpdateState>(layout.state) ?? {}
}

export function updateState(layout: Layout, change: (state: AutoUpdateState) => AutoUpdateState) {
  const next = change(readState(layout))
  writeJsonAtomic(layout.state, next)
  return next
}

// ---- where this process runs from --------------------------------------------------------------------

const realpath = (file: string) => {
  try {
    return realpathSync(file)
  } catch {
    return path.resolve(file)
  }
}

/**
 * The installed npm runtime this process runs from, or undefined: a checkout, npx's cache, or anything else outside
 * runtime/versions/<version>/ in the data root. Only such an install updates itself.
 */
export function npmRuntime(options: { readonly entry?: string; readonly layout?: Layout; readonly checkout?: boolean } = {}) {
  if (options.checkout ?? fromCheckout()) return undefined
  const layout = options.layout ?? runtimeLayout()
  const entry = realpath(options.entry ?? fileURLToPath(import.meta.url))
  const relative = path.relative(realpath(layout.versions), entry).split(path.sep)
  if (relative.length !== 6 || relative[0] === ".." || relative.slice(1).join("/") !== "node_modules/@opencode/browse/dist/cli.mjs") return undefined
  const current = readCurrent(layout)
  if (!current) return undefined
  return { layout, version: relative[0]!, current }
}

// ---- settings -----------------------------------------------------------------------------------------

/** The mode OPENCODE_BROWSER_AUTO_UPDATE (or OPENCODE_BROWSER_UPDATE_CHECK=0, which turns checks off) fixes. */
export function autoUpdateOverride(env: NodeJS.ProcessEnv = process.env): AutoUpdateMode | undefined {
  const value = env.OPENCODE_BROWSER_AUTO_UPDATE?.trim().toLowerCase()
  if (value === "on" || value === "1" || value === "true") return "on"
  if (value === "notify") return "notify"
  if (value === "off" || value === "0" || value === "false") return "off"
  if (env.OPENCODE_BROWSER_UPDATE_CHECK === "0") return "off"
  return undefined
}

export function storedMode(layout = runtimeLayout()): AutoUpdateMode {
  const mode = readState(layout).mode
  return mode && (autoUpdateModes as readonly string[]).includes(mode) ? mode : "on"
}

export function effectiveMode(layout = runtimeLayout(), env: NodeJS.ProcessEnv = process.env): AutoUpdateMode {
  return autoUpdateOverride(env) ?? storedMode(layout)
}

export function setStoredMode(mode: AutoUpdateMode, layout = runtimeLayout()) {
  updateState(layout, (state) => ({ ...state, mode }))
}

/** What status, the settings tool and the options page show about updates. */
export type AutoUpdateStatus = {
  readonly install: "npm" | "checkout" | "other"
  readonly mode: AutoUpdateMode
  readonly effective: AutoUpdateMode
  readonly overriddenBy?: string
  readonly version?: string
  readonly channel?: Channel
  readonly latest?: string
  readonly pending?: string
  readonly previous?: string
  readonly skipped?: string
  readonly checkedAt?: string
  readonly lastUpdate?: AutoUpdateState["lastUpdate"]
  readonly lastError?: AutoUpdateState["lastError"]
}

export function autoUpdateStatus(options: { readonly layout?: Layout; readonly env?: NodeJS.ProcessEnv; readonly runtime?: ReturnType<typeof npmRuntime> } = {}): AutoUpdateStatus {
  const layout = options.layout ?? runtimeLayout()
  const env = options.env ?? process.env
  const runtime = options.runtime === undefined ? npmRuntime({ layout }) : options.runtime
  const state = readState(layout)
  const override = autoUpdateOverride(env)
  const current = runtime?.current ?? readCurrent(layout)
  const install = runtime ? "npm" : fromCheckout() ? "checkout" : current ? "npm" : "other"
  return {
    install,
    mode: storedMode(layout),
    effective: install === "npm" ? (override ?? storedMode(layout)) : "off",
    ...(override ? { overriddenBy: env.OPENCODE_BROWSER_AUTO_UPDATE !== undefined ? "OPENCODE_BROWSER_AUTO_UPDATE" : "OPENCODE_BROWSER_UPDATE_CHECK" } : {}),
    ...(current ? { version: current.version, channel: current.channel } : {}),
    ...(current?.previous && existsSync(versionEntry(layout, current.previous)) ? { previous: current.previous } : {}),
    ...(state.latest ? { latest: state.latest } : {}),
    ...(state.pending ? { pending: state.pending } : {}),
    ...(state.skipped ? { skipped: state.skipped } : {}),
    ...(state.checkedAt ? { checkedAt: new Date(state.checkedAt).toISOString() } : {}),
    ...(state.lastUpdate ? { lastUpdate: state.lastUpdate } : {}),
    ...(state.lastError ? { lastError: state.lastError } : {}),
  }
}

/** One line for `status`. */
export function describeAutoUpdate(status: AutoUpdateStatus): string {
  if (status.install === "checkout") return "Updates:   checkout install; `update` pulls new commits"
  if (status.install !== "npm") return "Updates:   not an installed runtime"
  const mode = { on: "automatic", notify: "notify only", off: "off" }[status.effective]
  const parts = [`${mode}${status.overriddenBy ? ` (set by ${status.overriddenBy})` : ""}`, `channel ${status.channel ?? "latest"}`]
  if (status.pending) parts.push(`${status.pending} installed, switches in when no agent is using the browser`)
  else if (status.latest && status.latest === status.skipped) parts.push(`skipping ${status.latest} (rolled back from it; \`update\` installs it again)`)
  else if (status.latest && status.version && compareVersions(status.latest, status.version) > 0) parts.push(`${status.latest} available`)
  if (status.previous && status.version && compareVersions(status.previous, status.version) < 0) parts.push(`\`rollback\` returns to ${status.previous}`)
  if (status.lastError) parts.push(`last attempt failed: ${status.lastError.message}`)
  return `Updates:   ${parts.join("; ")}`
}

// ---- registry and install ----------------------------------------------------------------------------

export type Run = (command: string, args: readonly string[], options?: { readonly timeoutMs?: number; readonly env?: NodeJS.ProcessEnv }) => Promise<{ status: number | null; stdout: string; stderr: string }>

/**
 * Runs a command without blocking the event loop: the relay keeps serving agents and the extension while npm installs
 * an update (minutes on a slow network).
 */
export const runCommand: Run = (command, args, options = {}) =>
  new Promise((resolve) => {
    // On Windows npm is npm.cmd, which Node only runs through a shell; run npm's own entry beside node.exe instead.
    const npmCli = process.platform === "win32" && command === "npm" ? path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js") : undefined
    const [file, argv] = npmCli && existsSync(npmCli) ? [process.execPath, [npmCli, ...args]] : [command, args]
    const child = spawn(file, argv, { env: options.env ?? process.env, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => void (stdout += chunk))
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => void (stderr += chunk))
    const timer = setTimeout(() => child.kill(), options.timeoutMs ?? 120_000)
    child.on("error", (error) => {
      clearTimeout(timer)
      resolve({ status: null, stdout, stderr: stderr + error.message })
    })
    child.on("close", (status) => {
      clearTimeout(timer)
      resolve({ status, stdout, stderr })
    })
  })

/** The registry npm installs from: OPENCODE_BROWSER_NPM_REGISTRY, else npm's own configuration, else npmjs.org. */
export async function registryUrl(run: Run = runCommand, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const override = env.OPENCODE_BROWSER_NPM_REGISTRY?.trim()
  const configured = override || (await run("npm", ["config", "get", "registry"], { timeoutMs: 15_000 })).stdout.trim()
  return /^https?:\/\//.test(configured) ? configured.replace(/\/+$/, "") : DEFAULT_REGISTRY
}

export type Published = { readonly version: string; readonly integrity: string }

/** The channel's dist-tag and that version's published integrity. */
export async function fetchPublished(options: { readonly registry: string; readonly channel: Channel; readonly fetch?: typeof fetch }): Promise<Published> {
  const request = options.fetch ?? fetch
  const response = await request(`${options.registry}/${PACKAGE_NAME.replace("/", "%2f")}`, {
    headers: { accept: "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8" },
    signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) throw new Error(`the registry answered ${response.status} for ${PACKAGE_NAME}`)
  const body = (await response.json()) as { "dist-tags"?: Record<string, string>; versions?: Record<string, { dist?: { integrity?: string } }> }
  const version = body["dist-tags"]?.[options.channel]
  if (!version) throw new Error(`${PACKAGE_NAME} has no ${options.channel} dist-tag`)
  const integrity = body.versions?.[version]?.dist?.integrity
  if (!integrity || !/^sha512-/.test(integrity)) throw new Error(`${PACKAGE_NAME}@${version} has no sha512 integrity in the registry`)
  return { version, integrity }
}

/**
 * Installs one version into runtime/versions/<version> and verifies it: npm checks the tarball against the registry's
 * integrity while installing; then the lockfile must record that same integrity for the package, and the installed CLI
 * must run and report the version. Built in a temporary directory and renamed into place, so a failed install never
 * leaves a half-written version where the shim could find it. Returns the verified entry.
 */
export async function installVersion(options: {
  readonly layout: Layout
  readonly version: string
  readonly integrity?: string
  readonly spec?: string
  readonly registry?: string
  readonly run?: Run
  readonly node?: string
}): Promise<string> {
  const run = options.run ?? runCommand
  const { layout } = options
  const spec = options.spec ?? `${PACKAGE_NAME}@${options.version}`
  if (spec.startsWith("-") || /[\s"'`&|<>^%!;]/.test(spec)) throw new Error(`Invalid package spec ${JSON.stringify(spec)}`)
  mkdirSync(layout.versions, { recursive: true })
  const temporary = path.join(layout.versions, `.install-${process.pid}-${Date.now()}`)
  rmSync(temporary, { recursive: true, force: true })
  mkdirSync(temporary, { recursive: true })
  try {
    writeFileSync(path.join(temporary, "package.json"), "{\"private\":true}\n")
    const args = ["install", "--prefix", temporary, "--no-audit", "--no-fund", "--ignore-scripts", "--loglevel=error", ...(options.registry ? [`--registry=${options.registry}`] : []), spec]
    const npm = await run("npm", args, { timeoutMs: 10 * 60_000 })
    if (npm.status !== 0) throw new Error(`npm install ${spec} failed: ${(npm.stderr || npm.stdout).trim().split("\n").slice(-3).join(" ")}`)
    const installed = readJson<{ version?: string }>(path.join(temporary, "node_modules", "@opencode", "browse", "package.json"))?.version
    if (!installed) throw new Error(`npm install ${spec} didn't install ${PACKAGE_NAME}`)
    if (options.spec === undefined && installed !== options.version) throw new Error(`npm installed ${installed}, not ${options.version}`)
    if (options.integrity) {
      const locked = readJson<{ packages?: Record<string, { integrity?: string; version?: string }> }>(path.join(temporary, "package-lock.json"))?.packages?.["node_modules/@opencode/browse"]
      if (locked?.integrity !== options.integrity) throw new Error(`${PACKAGE_NAME}@${installed} installed with integrity ${locked?.integrity ?? "unknown"}, not the registry's ${options.integrity}`)
    }
    const entry = path.join(temporary, "node_modules", "@opencode", "browse", "dist", "cli.mjs")
    const reported = await run(options.node ?? process.execPath, [entry, "--version"], { timeoutMs: 30_000, env: { ...process.env, OPENCODE_BROWSER_AUTOSTART: "0" } })
    if (reported.status !== 0 || reported.stdout.trim() !== installed)
      throw new Error(`${PACKAGE_NAME}@${installed} didn't run: \`--version\` printed ${JSON.stringify(reported.stdout.trim() || reported.stderr.trim()).slice(0, 200)}`)
    const target = versionDirectory(layout, installed)
    rmSync(target, { recursive: true, force: true })
    renameSync(temporary, target)
    return versionEntry(layout, installed)
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

/** Whether a process still runs. */
export function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

/**
 * Removes installed versions nothing needs. Never removes the current, previous or pending version (whatever the caller
 * passes), nor a temporary install whose process still runs.
 */
export function pruneVersions(layout: Layout, keep: readonly (string | undefined)[] = []) {
  let names: string[] = []
  try {
    names = readdirSync(layout.versions)
  } catch {
    return
  }
  const current = readCurrent(layout)
  const kept = new Set([...keep, current?.version, current?.previous, readState(layout).pending].filter((name): name is string => !!name))
  for (const name of names) {
    if (kept.has(name)) continue
    const temporary = /^\.install-(\d+)-\d+$/.exec(name)
    if (temporary && processAlive(Number(temporary[1]))) continue
    rmSync(path.join(layout.versions, name), { recursive: true, force: true })
  }
}

/** Clears `pending` when its directory is gone (removed by hand, or by an older version's pruning). */
export function validatePending(layout: Layout): AutoUpdateState {
  const state = readState(layout)
  if (!state.pending || existsSync(versionEntry(layout, state.pending))) return state
  return updateState(layout, ({ pending: _pending, ...rest }) => rest)
}

/** Points new processes at `version`, keeping the version it replaces for rollback. */
export function switchVersion(layout: Layout, version: string, previous: string | undefined) {
  if (!existsSync(versionEntry(layout, version))) throw new Error(`${version} isn't installed in ${layout.versions}`)
  writeCurrent(layout, { version, ...(previous && previous !== version ? { previous } : {}), channel: channelOf(version) })
  writeShim(layout)
}

// ---- the stable shim -------------------------------------------------------------------------------------

/**
 * bin/opencode-browser.mjs. Plain JavaScript that every version writes the same way, with no imports from a version, so
 * removing a version never breaks it. `mcp` runs a small supervisor: it starts the current version's MCP server,
 * forwards stdio (newline-delimited JSON-RPC), and when current.json names another version and no request is in flight,
 * starts the new server, replays the client's `initialize` to it (its answer is dropped), and carries on; while it
 * swaps, client messages wait. Any other command runs the current version in this process.
 */
export function shimSource(): string {
  return `#!/usr/bin/env node
// OpenCode Browser's stable entry, written by install (cli/src/auto-update.ts). opencode's browse MCP server runs this
// file, so its configuration never changes when the runtime updates. Don't edit; install rewrites it.
import { spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import path from "node:path"
import { createInterface } from "node:readline"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const runtime = path.join(root, "runtime")
const current = () => JSON.parse(readFileSync(path.join(runtime, "current.json"), "utf8")).version
const entry = (version) => path.join(runtime, "versions", version, "node_modules", "@opencode", "browse", "dist", "cli.mjs")
process.env.OPENCODE_BROWSER_HOME ??= root
const relayPort = Number(process.env.OPENCODE_BROWSER_PORT) || 19988

if (process.argv[2] !== "mcp") {
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
  const toClient = (line) => process.stdout.write(line + "\\n")
  const toChild = (line) => child.stdin.write(line + "\\n")
  const parse = (line) => { try { return JSON.parse(line) } catch { return undefined } }

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
    if (swapping) return void queue.push(line)
    if (moved()) {
      heldSince ??= Date.now()
      queue.push(line)
      return void maybeSwap()
    }
    const message = parse(line)
    if (message && message.method === "initialize") initialize = message
    if (message && message.method === "notifications/initialized") initialized = line
    if (message && message.id !== undefined && message.method !== undefined) inflight.add(message.id)
    toChild(line)
  }

  // A new version in current.json swaps the server only once the relay runs it too (GET /version), so a server never
  // talks to a relay of another version. With no relay at all for a few checks, nothing can mix, and it swaps.
  let checking = false
  let unreachable = 0
  const relayVersion = () => fetch("http://127.0.0.1:" + relayPort + "/version", { signal: AbortSignal.timeout(2000) })
    .then((response) => (response.ok ? response.json() : undefined))
    .then((body) => (body && typeof body.version === "string" ? body.version : undefined), () => undefined)
  const maybeSwap = async () => {
    if (swapping || checking || inflight.size > 0) return
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
    // Held requests don't wait forever for a relay that never reports the new version.
    const waitedOut = heldSince !== undefined && Date.now() - heldSince > 15000
    if (running !== next && unreachable < 3 && !waitedOut) return
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
`
}

export function writeShim(layout: Layout) {
  mkdirSync(path.dirname(layout.shim), { recursive: true })
  const source = shimSource()
  try {
    if (readFileSync(layout.shim, "utf8") === source) return
  } catch {}
  const temporary = `${layout.shim}.${process.pid}.tmp`
  writeFileSync(temporary, source)
  chmodSync(temporary, 0o755)
  renameSync(temporary, layout.shim)
}

// ---- the relay's updater -------------------------------------------------------------------------------------

export type AutoUpdaterDeps = {
  readonly runtime: NonNullable<ReturnType<typeof npmRuntime>>
  /** No agent is using the browser: nothing in flight, no capture, recording, handoff or raw client, and quiet for a while. */
  readonly isIdle: () => boolean
  readonly log: (event: string, fields?: Record<string, unknown>) => void
  /** The notice changed (status page, MCP note). */
  readonly onChange?: () => void
  /**
   * Starts a detached child process of this version's CLI (`runtime-install`, `runtime-switch`); onExit gets its exit
   * code (null when it couldn't start). Children run on their own, so npm and the restart never block the relay.
   */
  readonly spawnChild?: (args: readonly string[], onExit: (code: number | null) => void) => number | undefined
  readonly env?: NodeJS.ProcessEnv
  readonly fetch?: typeof fetch
  readonly run?: Run
  readonly now?: () => number
}

/** How long an installer may run before the relay gives up on it (npm's own timeout is 10 minutes). */
const INSTALL_TIMEOUT_MS = 15 * 60_000

/**
 * The relay's background updater. tick() checks at most once per checkIntervalMs; in "on" mode a newer version is
 * installed by a detached `runtime-install` child, and once it's installed and the browser is idle, a detached
 * `runtime-switch` child drains this relay, points current.json at the new version and starts its relay (refused while
 * busy, and then nothing changes). Nothing on the relay's event loop waits for npm. Never throws; failures are kept in
 * auto-update.json and tried again on the next day's check.
 */
export function createAutoUpdater(deps: AutoUpdaterDeps) {
  const env = deps.env ?? process.env
  const now = deps.now ?? Date.now
  const { layout, version: running } = deps.runtime
  const checkIntervalMs = Number(env.OPENCODE_BROWSER_AUTO_UPDATE_INTERVAL_MS) || DAY_MS
  const spawnChild = deps.spawnChild ?? ((args, onExit) => spawnRuntimeChild(layout, versionEntry(layout, running), args, onExit, env))
  let busy = false
  let switching = false
  let timer: NodeJS.Timeout | undefined

  // The relay now runs what it was waiting to switch to: record it, and drop versions nothing needs.
  const settled = readState(layout)
  if (settled.pending === running) {
    updateState(layout, ({ pending: _pending, lastError: _error, ...state }) => ({ ...state, lastUpdate: { from: deps.runtime.current.previous ?? "unknown", to: running, at: new Date(now()).toISOString() } }))
    deps.log("autoupdate.switched", { version: running, previous: deps.runtime.current.previous })
    pruneVersions(layout, [running])
  }

  async function tick() {
    if (busy || switching) return
    busy = true
    try {
      const mode = effectiveMode(layout, env)
      if (mode === "off") return
      let state = validatePending(layout)
      if (!state.checkedAt || now() - state.checkedAt >= checkIntervalMs || now() < state.checkedAt) {
        const channel = channelOf(running)
        try {
          const published = await fetchPublished({ registry: await registryUrl(deps.run, env), channel, ...(deps.fetch ? { fetch: deps.fetch } : {}) })
          state = updateState(layout, ({ failed: _failed, ...rest }) => ({ ...rest, checkedAt: now(), latest: published.version, integrity: published.integrity }))
          deps.log("autoupdate.checked", { channel, latest: published.version, running })
        } catch (error) {
          state = updateState(layout, (rest) => ({ ...rest, checkedAt: now(), failed: (error as Error).message }))
          deps.log("autoupdate.check_failed", { error: (error as Error).message })
        }
        deps.onChange?.()
      }
      const latest = state.latest
      const wanted = latest && compareVersions(latest, running) > 0 && latest !== state.skipped ? latest : undefined
      if (!wanted || mode !== "on") return

      // An installer in its own process: wait for it, or record that it died without saying how it went.
      const installing = state.installing
      if (installing) {
        if (processAlive(installing.pid) && now() - installing.startedAt < INSTALL_TIMEOUT_MS) return
        state = updateState(layout, ({ installing: _installing, ...rest }) => ({
          ...rest,
          ...(rest.pending === installing.version ? {} : { lastError: { message: "the installer stopped without finishing", at: new Date(now()).toISOString(), version: installing.version } }),
        }))
        deps.log("autoupdate.installer_gone", { version: installing.version })
      }
      if (state.pending !== wanted) {
        if (state.lastError?.version === wanted && now() - Date.parse(state.lastError.at) < checkIntervalMs) return
        deps.log("autoupdate.installing", { version: wanted })
        const pid = spawnChild(["runtime-install", wanted, ...(state.integrity ? ["--integrity", state.integrity] : [])], (code) => {
          deps.log(code === 0 ? "autoupdate.installed" : "autoupdate.install_failed", { version: wanted, code })
          deps.onChange?.()
          // Switch as soon as it's ready rather than at the next tick.
          if (code === 0) void tick()
        })
        if (pid) updateState(layout, (rest) => ({ ...rest, installing: { version: wanted, pid, startedAt: now() } }))
        return
      }
      if (!deps.isIdle()) return
      const current = readCurrent(layout)
      if (!current || current.version !== running) return
      // runtime-switch drains this relay and only then moves current.json and starts the new relay; when the drain is
      // refused (an agent started meanwhile), it changes nothing and the next idle tick tries again.
      switching = true
      deps.log("autoupdate.switching", { from: running, to: wanted })
      spawnChild(["runtime-switch", wanted], (code) => {
        switching = false
        if (code !== 0) deps.log("autoupdate.restart_refused", { version: wanted, code })
      })
    } catch (error) {
      deps.log("autoupdate.error", { error: (error as Error).message })
    } finally {
      busy = false
    }
  }

  return {
    tick,
    start(intervalMs = Number(env.OPENCODE_BROWSER_AUTO_UPDATE_TICK_MS) || 10 * 60_000) {
      timer = setInterval(() => void tick(), intervalMs)
      timer.unref()
      // First check shortly after startup, not during it.
      setTimeout(() => void tick(), Math.min(intervalMs, 60_000)).unref()
    },
    stop() {
      clearInterval(timer)
    },
  }
}

/** Starts `node <entry> <args>` detached, logging to logs/auto-update.log; returns its pid. */
export function spawnRuntimeChild(layout: Layout, entry: string, args: readonly string[], onExit: (code: number | null) => void, env: NodeJS.ProcessEnv = process.env): number | undefined {
  const { OPENCODE_BROWSER_MANAGED_RELAY: _managed, OPENCODE_BROWSER_RESTART_REQUEST_ID: _request, ...rest } = env
  mkdirSync(path.join(layout.root, "logs"), { recursive: true })
  const log = openSync(path.join(layout.root, "logs", "auto-update.log"), "a", 0o600)
  try {
    const child = spawn(process.execPath, [entry, ...args], { detached: true, stdio: ["ignore", log, log], env: { ...rest, OPENCODE_BROWSER_HOME: layout.root } })
    child.on("error", () => onExit(null))
    child.on("exit", (code) => onExit(code))
    child.unref()
    return child.pid
  } catch {
    onExit(null)
    return undefined
  } finally {
    closeSync(log)
  }
}
