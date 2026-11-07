// Auto-update for installs, by rerunning whatever installed browse. A checkout never auto-updates: it has `update`.
//
// Layout: one state file, auto-update.json in the state root (logs are beside it in logs/). There is no versions
// directory, no current.json and no shim any more:
//   binary install  the install script this release shipped with (baked in by script/compile.ts) replaces
//                   ~/.local/bin/browse by atomic rename (Windows renames the running executable aside first); running
//                   processes keep their old inode on unix.
//   npm global      `npm install -g @opencode/browse@<version>` replaces the package in place.
//   npx             no-op: npx resolves the package itself, and install never writes npx entries.
//
// The relay checks its channel at launch and at least once an hour. A binary install reads its channel's manifest from
// Anomaly's release service (release-service.ts, anomalyco/release docs/protocol.md) and follows it; an npm global
// install reads the npm dist-tag (latest, or dev for a dev build, which every push to dev publishes). Mode "on"
// (default) runs the installer in its own process, then once no agent is using the browser restarts the relay from the
// same entry path. "notify" only shows the update; "off" doesn't check.
// OPENCODE_BROWSER_AUTO_UPDATE overrides the stored mode. Installed binaries and npm global installs supervise their MCP
// server (mcp/supervisor.ts): it notices the installed version change and swaps the server between requests once the
// relay runs it. The installer and npm do their own integrity checks (the release service's size and SHA-256 for a
// binary); there is no separate checksum path here.
import { spawn, spawnSync } from "node:child_process"
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, realpathSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { cliPrefix, compiledBinary, entrySpawnCommand, fromCheckout, installedBinary, stateRoot } from "../paths.ts"
import { opencodeBrowserVersion } from "../version.ts"
import { checkRelease, releaseChannel, runningServiceTarget, type ReleaseChannel, type ReleaseDecision } from "./release-service.ts"

export const PACKAGE_NAME = "@opencode/browse"
const HOUR_MS = 60 * 60 * 1000
const DEFAULT_REGISTRY = "https://registry.npmjs.org"

export const autoUpdateModes = ["on", "notify", "off"] as const
export type AutoUpdateMode = (typeof autoUpdateModes)[number]
export type Channel = "latest" | "dev" | "beta"
export type InstallKind = "binary" | "npm" | "npx" | "checkout" | "other"

/** A version auto-update installs: 1.2.3, 1.2.4-dev.42 (1.2.4-dev.42.2 for a rerun), or a beta. */
export const UPDATE_VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-(dev|beta)\.(\d+)(?:\.(\d+))?)?$/

export const channelOf = (version: string): Channel => (version.includes("-dev.") ? "dev" : version.includes("-beta.") ? "beta" : "latest")

/** Orders versions as semver does for these shapes: dev below beta below the release, then by run. Anything else never compares as newer. */
export function compareVersions(left: string, right: string): number {
  const parse = (value: string) => {
    const match = UPDATE_VERSION.exec(value)
    if (!match) return undefined
    const stage = match[4] === undefined ? 2 : match[4] === "beta" ? 1 : 0
    return [Number(match[1]), Number(match[2]), Number(match[3]), stage, Number(match[5] ?? 0), Number(match[6] ?? 0)]
  }
  const a = parse(left)
  const b = parse(right)
  if (!a || !b) return 0
  for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return a[index]! < b[index]! ? -1 : 1
  return 0
}

// ---- where this process runs from --------------------------------------------------------------------

/** What kind of install this process runs from. */
export function installKind(entry = process.argv[1] ?? "", checkout = fromCheckout()): InstallKind {
  if (checkout) return "checkout"
  if (compiledBinary()) return "binary"
  const normalized = entry.replaceAll("\\", "/")
  if (/\/_npx\/|\/npm-cache\/_npx\//.test(normalized)) return "npx"
  return entry ? "npm" : "other"
}

export type Runtime = {
  readonly kind: "binary" | "npm" | "npx"
  /** The stable path new processes start from: the executable, or the npm package's CLI bundle. */
  readonly entry: string
  /** The version this process runs. */
  readonly version: string
}

const packageVersion = (entry: string): string | undefined => {
  try {
    const manifest = path.join(path.dirname(path.dirname(entry)), "package.json")
    const version = (JSON.parse(readFileSync(manifest, "utf8")) as { version?: unknown }).version
    return typeof version === "string" ? version : undefined
  } catch {
    return undefined
  }
}

/** npm's bin is a symlink; the package manifest lives beside the real bundle. */
const realEntry = (entry: string) => {
  try {
    return realpathSync(entry)
  } catch {
    return entry
  }
}

/** The installed runtime this process belongs to, or undefined for a checkout or an uninstalled executable. */
export function installedRuntime(entry = process.argv[1] ?? process.execPath): Runtime | undefined {
  const kind = installKind(entry)
  if (kind === "binary") {
    const binary = installedBinary()
    if (binary) return { kind, entry: binary, version: opencodeBrowserVersion }
    // A downloaded executable run in place has nothing to update.
    return undefined
  }
  if (kind !== "npm" && kind !== "npx") return undefined
  const resolved = realEntry(entry)
  return { kind, entry: resolved, version: packageVersion(resolved) ?? opencodeBrowserVersion }
}

/** The version currently on disk at the runtime's stable entry (a binary reports it with --version). */
export function installedVersion(runtime: Runtime): string | undefined {
  if (runtime.kind === "binary") {
    const result = spawnSync(runtime.entry, ["--version"], { encoding: "utf8", timeout: 15_000, env: { ...process.env, OPENCODE_BROWSER_AUTOSTART: "0" } })
    return result.status === 0 ? result.stdout.trim() || undefined : undefined
  }
  return packageVersion(runtime.entry)
}

// ---- state -------------------------------------------------------------------------------------------

export type AutoUpdateState = {
  readonly mode?: AutoUpdateMode
  readonly checkedAt?: number
  readonly latest?: string
  /** The ETag of the release service manifest last read, for If-None-Match. */
  readonly etag?: string
  readonly failed?: string
  readonly lastUpdate?: { readonly from: string; readonly to: string; readonly at: string }
  readonly lastError?: { readonly message: string; readonly at: string; readonly version?: string; readonly attempts?: number }
  /** An installer running in its own process (`self-update`), so npm never blocks the relay. */
  readonly installing?: { readonly version: string; readonly pid: number; readonly startedAt: number }
}

export const autoUpdateStatePath = () => path.join(stateRoot(), "auto-update.json")

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T
  } catch {
    return undefined
  }
}

function writeJsonAtomic(file: string, value: unknown) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 })
  chmodSync(temporary, 0o600)
  renameSync(temporary, file)
}

export function readState(): AutoUpdateState {
  return readJson<AutoUpdateState>(autoUpdateStatePath()) ?? {}
}

export function updateState(change: (state: AutoUpdateState) => AutoUpdateState): AutoUpdateState {
  const next = change(readState())
  writeJsonAtomic(autoUpdateStatePath(), next)
  return next
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

export function storedMode(): AutoUpdateMode {
  const mode = readState().mode
  return mode && (autoUpdateModes as readonly string[]).includes(mode) ? mode : "on"
}

export function effectiveMode(env: NodeJS.ProcessEnv = process.env): AutoUpdateMode {
  return autoUpdateOverride(env) ?? storedMode()
}

export function setStoredMode(mode: AutoUpdateMode) {
  updateState((state) => ({ ...state, mode }))
}

/** What status, the settings tool and the options page show about updates. */
export type AutoUpdateStatus = {
  readonly install: InstallKind
  /** The command that runs this install's CLI in a terminal (cliPrefix), for commands the options page shows. */
  readonly cli: string
  readonly mode: AutoUpdateMode
  readonly effective: AutoUpdateMode
  readonly overriddenBy?: string
  readonly version?: string
  readonly channel?: Channel
  readonly latest?: string
  readonly checkedAt?: string
  readonly lastUpdate?: AutoUpdateState["lastUpdate"]
  readonly lastError?: AutoUpdateState["lastError"]
}

export function autoUpdateStatus(options: { readonly env?: NodeJS.ProcessEnv; readonly runtime?: Runtime } = {}): AutoUpdateStatus {
  const env = options.env ?? process.env
  const runtime = options.runtime === undefined ? installedRuntime() : options.runtime
  const state = readState()
  const override = autoUpdateOverride(env)
  const install = runtime?.kind ?? installKind()
  return {
    install,
    cli: cliPrefix(),
    mode: storedMode(),
    effective: install === "binary" || install === "npm" ? (override ?? storedMode()) : "off",
    ...(override ? { overriddenBy: env.OPENCODE_BROWSER_AUTO_UPDATE !== undefined ? "OPENCODE_BROWSER_AUTO_UPDATE" : "OPENCODE_BROWSER_UPDATE_CHECK" } : {}),
    ...(runtime ? { version: runtime.version, channel: channelOf(runtime.version) } : {}),
    ...(state.latest ? { latest: state.latest } : {}),
    ...(state.checkedAt ? { checkedAt: new Date(state.checkedAt).toISOString() } : {}),
    ...(state.lastUpdate ? { lastUpdate: state.lastUpdate } : {}),
    ...(state.lastError ? { lastError: state.lastError } : {}),
  }
}

/** One line for `status`. */
export function describeAutoUpdate(status: AutoUpdateStatus): string {
  if (status.install === "checkout") return "Updates:   checkout install; `update` pulls new commits"
  if (status.install === "npx") return "Updates:   npx resolves the package itself; `update` is a no-op"
  if (status.install !== "binary" && status.install !== "npm") return "Updates:   not an installed runtime"
  const mode = { on: "automatic", notify: "notify only", off: "off" }[status.effective]
  const parts = [`${mode}${status.overriddenBy ? ` (set by ${status.overriddenBy})` : ""}`, `channel ${status.channel ?? "latest"}`]
  if (updateAvailable(status)) parts.push(`${status.latest} available; the installer runs when no agent is using the browser`)
  if (status.lastError) parts.push(`last attempt failed: ${status.lastError.message}`)
  return `Updates:   ${parts.join("; ")}`
}

/**
 * Whether `status.latest` is another build: the release service's current release is compared for equality only, as
 * the protocol says; npm's dist-tag is ordered as npm orders versions.
 */
export function updateAvailable(status: Pick<AutoUpdateStatus, "install" | "latest" | "version">): boolean {
  if (!status.latest || !status.version) return false
  return status.install === "binary" ? status.latest !== status.version : compareVersions(status.latest, status.version) > 0
}

// ---- registry and installer ----------------------------------------------------------------------------

export type Run = (command: string, args: readonly string[], options?: { readonly timeoutMs?: number; readonly env?: NodeJS.ProcessEnv }) => Promise<{ status: number | null; stdout: string; stderr: string }>

/**
 * Runs a command without blocking the event loop: the relay keeps serving agents and the extension while the installer
 * downloads an update (minutes on a slow network).
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
  // A binary install doesn't need npm, which may not be there.
  const configured = override || (compiledBinary() ? "" : (await run("npm", ["config", "get", "registry"], { timeoutMs: 15_000 })).stdout.trim())
  return /^https?:\/\//.test(configured) ? configured.replace(/\/+$/, "") : DEFAULT_REGISTRY
}

export type Published = { readonly version: string }

/** The channel's dist-tag. */
export async function fetchPublished(options: { readonly registry: string; readonly channel: Channel; readonly fetch?: typeof fetch; readonly packageName?: string }): Promise<Published> {
  const request = options.fetch ?? fetch
  const name = options.packageName ?? PACKAGE_NAME
  const response = await request(`${options.registry}/${name.replace("/", "%2f")}`, {
    headers: { accept: "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8" },
    signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) throw new Error(`the registry answered ${response.status} for ${name}`)
  const body = (await response.json()) as { "dist-tags"?: Record<string, string> }
  const version = body["dist-tags"]?.[options.channel]
  if (!version) throw new Error(`${name} has no ${options.channel} dist-tag`)
  return { version }
}

export type InstallerOptions = {
  readonly runtime: Runtime
  readonly version?: string
  /** The channel the installer follows: stable or dev for a binary, latest or dev for npm. A version pins npm. */
  readonly channel?: Channel | ReleaseChannel
  readonly run?: Run
  readonly fetch?: typeof fetch
  readonly env?: NodeJS.ProcessEnv
  readonly platform?: NodeJS.Platform
  /** The installer text a binary install runs: this release's baked-in one by default, or a test's fixture. */
  readonly installer?: string
}

/**
 * Reruns whatever installed browse. A binary install runs the install script this release shipped with, non-interactively
 * with --no-setup, so it only replaces the executable (the PATH and agent entries install wrote stay). npm global installs
 * run npm install -g. npx is a no-op. Returns the version now installed.
 */
export async function runInstaller(options: InstallerOptions): Promise<string> {
  const run = options.run ?? runCommand
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  if (options.runtime.kind === "npx") return options.runtime.version
  if (options.runtime.kind === "npm") {
    const spec = `${PACKAGE_NAME}@${options.version ?? options.channel ?? "latest"}`
    const npm = await run("npm", ["install", "-g", spec], { timeoutMs: 10 * 60_000, env })
    if (npm.status !== 0) throw new Error(`npm install -g ${spec} failed: ${(npm.stderr || npm.stdout).trim().split("\n").slice(-3).join(" ")}`)
    const version = installedVersion(options.runtime) ?? options.version ?? options.channel ?? "latest"
    if (options.version && compareVersions(version, options.version) < 0)
      throw new Error(`npm install -g ${spec} left ${version}, not the requested ${options.version}`)
    return version
  }
  // OPENCODE_BROWSER_INSTALL_SCRIPT is the explicit override tests and developers use (a local file or a URL); every
  // other binary install runs the installer this release shipped with, never one fetched at update time.
  const override = env.OPENCODE_BROWSER_INSTALL_SCRIPT
  const script = override
    ? existsSync(override)
      ? readFileSync(override, "utf8")
      : await (options.fetch ?? fetch)(override, { signal: AbortSignal.timeout(60_000) }).then(async (response) => {
          if (!response.ok) throw new Error(`couldn't download the installer (${response.status})`)
          return response.text()
        })
    : (options.installer ?? globalThis.__OPENCODE_BROWSER_INSTALLER__)
  if (!script) throw new Error("this build has no installer to run; install browse again with the install script")
  const directory = mkdtempSync(path.join(os.tmpdir(), "browse-install-"))
  const file = path.join(directory, platform === "win32" ? "install.ps1" : "install")
  const args = [...(options.version ? ["--version", options.version] : options.channel ? ["--channel", options.channel] : []), "--no-setup"]
  try {
    writeFileSync(file, script, { mode: platform === "win32" ? 0o600 : 0o700 })
    const command = platform === "win32" ? "powershell.exe" : "sh"
    const argv = platform === "win32" ? ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file, ...args] : [file, ...args]
    const installed = await run(command, argv, { timeoutMs: 10 * 60_000, env })
    if (installed.status !== 0)
      throw new Error(`the installer failed: ${(installed.stderr || installed.stdout).trim().split("\n").slice(-3).join(" ")}`)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
  const version = installedVersion(options.runtime)
  if (!version) throw new Error(`the installer ran, but ${options.runtime.entry} doesn't report a version`)
  if (options.version && compareVersions(version, options.version) < 0)
    throw new Error(`the installer left ${version}, not the requested ${options.version}`)
  return version
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

// ---- the relay's updater -------------------------------------------------------------------------------------

export type AutoUpdaterDeps = {
  readonly runtime: Runtime
  /** No agent is using the browser: nothing in flight, no capture, recording, handoff or raw client, and quiet for a while. */
  readonly isIdle: () => boolean
  readonly log: (event: string, fields?: Record<string, unknown>) => void
  /** The notice changed (status page, MCP note). */
  readonly onChange?: () => void
  /** Starts a detached child process of this version's CLI (`self-update`, `runtime-switch`); onExit gets its exit code. */
  readonly spawnChild?: (args: readonly string[], onExit: (code: number | null) => void) => number | undefined
  readonly env?: NodeJS.ProcessEnv
  readonly fetch?: typeof fetch
  readonly run?: Run
  readonly now?: () => number
}

/** How long an installer may run before the relay gives up on it (the script's own timeout is 10 minutes). */
const INSTALL_TIMEOUT_MS = 15 * 60_000
/** How long a runtime-switch child may run (a drain is bounded by the relay's restart timeout, a start by seconds). */
const SWITCH_TIMEOUT_MS = 5 * 60_000

/**
 * The relay's background updater. tick() checks at most once per checkIntervalMs; in "on" mode a newer version is
 * installed by a detached `self-update` child (the installer), and once the browser is idle a detached
 * `runtime-switch` child drains this relay and starts the new entry. Nothing on the relay's event loop waits for the
 * download. Never throws; failures are kept in auto-update.json.
 */
export function createAutoUpdater(deps: AutoUpdaterDeps) {
  const env = deps.env ?? process.env
  const now = deps.now ?? Date.now
  const { runtime } = deps
  const running = runtime.version
  const checkIntervalMs = Math.min(Number(env.OPENCODE_BROWSER_AUTO_UPDATE_INTERVAL_MS) || HOUR_MS, HOUR_MS)
  const spawnChild = deps.spawnChild ?? ((args, onExit) => spawnRuntimeChild(runtime, args, onExit, env))
  let busy = false
  /** A runtime-switch child in flight; a stuck one is given up on after SWITCH_TIMEOUT_MS. */
  let switching: { pid: number | undefined; startedAt: number } | undefined
  let timer: NodeJS.Timeout | undefined

  /** A binary install's check: its channel's release service manifest, through the protocol's client rules. */
  async function checkBinary(state: AutoUpdateState, channel: Channel): Promise<AutoUpdateState> {
    const target = runningServiceTarget()
    if (!target) throw new Error("this install has no release service target")
    const serviceChannel: ReleaseChannel = releaseChannel(channel)
    const result = await checkRelease({
      version: running,
      channel: serviceChannel,
      target,
      ...(state.etag ? { etag: state.etag } : {}),
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
    })
    if (result.status === "unchanged") {
      deps.log("autoupdate.unchanged", { channel: serviceChannel, running })
      return updateState(({ failed: _failed, ...rest }) => ({ ...rest, checkedAt: now() }))
    }
    if (result.status === "missing") {
      deps.log("autoupdate.no_release", { channel: serviceChannel, running })
      return updateState(({ failed: _failed, latest: _latest, etag: _etag, ...rest }) => ({ ...rest, checkedAt: now() }))
    }
    const decision: ReleaseDecision = result.decision
    if (decision.action === "reject") throw new Error(`the ${serviceChannel} manifest was rejected: ${decision.reason}`)
    deps.log("autoupdate.checked", { channel: serviceChannel, current: result.releaseVersion, running, decision: decision.reason })
    return updateState(({ failed: _failed, latest: _latest, etag: _etag, ...rest }) => ({
      ...rest,
      checkedAt: now(),
      ...(result.etag ? { etag: result.etag } : {}),
      ...(decision.action === "install" ? { latest: decision.version } : {}),
    }))
  }

  async function tick() {
    if (switching && (now() - switching.startedAt > SWITCH_TIMEOUT_MS || (switching.pid !== undefined && !processAlive(switching.pid)))) {
      deps.log("autoupdate.switch_abandoned", { pid: switching.pid })
      switching = undefined
    }
    if (busy || switching) return
    busy = true
    try {
      const mode = effectiveMode(env)
      if (mode === "off") return
      let state = readState()
      if (!state.checkedAt || now() - state.checkedAt >= checkIntervalMs || now() < state.checkedAt) {
        const channel = channelOf(running)
        try {
          if (runtime.kind === "binary") {
            state = await checkBinary(state, channel)
          } else {
            const published = await fetchPublished({ registry: await registryUrl(deps.run, env), channel, ...(deps.fetch ? { fetch: deps.fetch } : {}) })
            state = updateState(({ failed: _failed, ...rest }) => ({ ...rest, checkedAt: now(), latest: published.version }))
            deps.log("autoupdate.checked", { channel, latest: published.version, running })
          }
        } catch (error) {
          state = updateState(({ latest: _latest, ...rest }) => ({ ...rest, checkedAt: now(), failed: (error as Error).message }))
          deps.log("autoupdate.check_failed", { error: (error as Error).message })
        }
        deps.onChange?.()
      }
      const wanted = runtime.kind === "binary" ? state.latest : state.latest && compareVersions(state.latest, running) > 0 ? state.latest : undefined
      if (!wanted || mode !== "on") return

      // An installer in its own process: wait for it, or record that it died without saying how it went.
      const installing = state.installing
      if (installing) {
        const alive = processAlive(installing.pid) && now() - installing.startedAt < INSTALL_TIMEOUT_MS
        if (alive) return
        const installed = installedVersion(runtime)
        state = updateState(({ installing: _installing, ...rest }) => ({
          ...rest,
          ...(installed && installed !== running ? {} : { lastError: { message: "the installer stopped without finishing", at: new Date(now()).toISOString(), version: installing.version } }),
        }))
        deps.log("autoupdate.installer_gone", { version: installing.version })
      }
      const installed = installedVersion(runtime)
      if (installed === wanted) {
        // The build is on disk (this installer's, or another process's). Restart the relay with it once nothing is using the browser.
        if (!deps.isIdle()) return
        switching = { pid: undefined, startedAt: now() }
        deps.log("autoupdate.switching", { from: running, to: installed })
        switching.pid = spawnChild(["runtime-switch", installed], (code) => {
          if (switching) switching = undefined
          if (code !== 0) deps.log("autoupdate.restart_refused", { version: installed, code })
          deps.onChange?.()
        })
        return
      }
      if (state.lastError?.version === wanted) {
        const failure = state.lastError
        const attempts = failure.attempts ?? 1
        const backoff = (attempts <= 1 ? 15 : attempts === 2 ? 60 : 240) * 60_000
        const age = now() - Date.parse(failure.at)
        if (age >= 0 && age < Math.min(backoff, checkIntervalMs)) return
      }
      deps.log("autoupdate.installing", { version: wanted })
      const pid = spawnChild(["self-update", wanted, "--channel", channelOf(running)], (code) => {
        deps.log(code === 0 ? "autoupdate.installed" : "autoupdate.install_failed", { version: wanted, code })
        updateState(({ installing: _installing, ...rest }) => ({
          ...rest,
          ...(code === 0 ? {} : { lastError: { message: "the installer failed", at: new Date(now()).toISOString(), version: wanted, attempts: 1 + (rest.lastError?.version === wanted ? rest.lastError.attempts ?? 1 : 0) } }),
        }))
        deps.onChange?.()
        // Switch as soon as it's ready rather than at the next tick.
        if (code === 0) void tick()
      })
      if (pid) updateState((rest) => ({ ...rest, installing: { version: wanted, pid, startedAt: now() } }))
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

/** Starts `<entry> <args>` detached, logging to stateRoot/logs/auto-update.log; returns its pid. */
export function spawnRuntimeChild(runtime: Runtime, args: readonly string[], onExit: (code: number | null) => void, env: NodeJS.ProcessEnv = process.env): number | undefined {
  const { OPENCODE_BROWSER_MANAGED_RELAY: _managed, OPENCODE_BROWSER_RESTART_REQUEST_ID: _request, ...rest } = env
  const directory = path.join(stateRoot(), "logs")
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const log = openSync(path.join(directory, "auto-update.log"), "a", 0o600)
  try {
    const [file, ...prefix] = entrySpawnCommand(runtime.entry)
    const child = spawn(file!, [...prefix, ...args], { detached: true, stdio: ["ignore", log, log], env: rest })
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
