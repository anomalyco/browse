// Drives browse the way a user has it: an installed binary (curl installer or npm) in its own $HOME, a headed Chrome
// for Testing with the store-equivalent extension (the release zip, with the store's manifest key so its id is the
// store id), paired through install's link (welcome.html#code=…). Nothing here touches the repo build.
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import fs from "node:fs"
import { createHash } from "node:crypto"
import os from "node:os"
import path from "node:path"
import { BrowserCdp } from "./cdp.ts"
import { sleep } from "./env.ts"
import { McpClient } from "./mcp.ts"

/** The Chrome Web Store item (cli/src/paths.ts PUBLIC_STORE_ID); the release zip gets its key, so this is its id. */
export const STORE_EXTENSION_ID = "mfnicocicmmlkpjnaffgihfjhdgjkdjg"
export const CHROME = process.env.BROWSE_STRESS_CHROME ?? path.join(os.homedir(), "chrome-for-testing/current")
export const DISPLAY = process.env.DISPLAY ?? ":99"

export type User = {
  readonly name: string
  readonly home: string
  /** The relay's port for this install (OPENCODE_BROWSER_PORT; 19988 by default). */
  readonly port: number
  /** Chrome's --remote-debugging-port for this user's browser (harness only). */
  readonly debugPort: number
  readonly binary: string
  readonly dataDir: string
  readonly profile: string
}

export function user(name: string, options: { port?: number; debugPort?: number; root?: string; binary?: string } = {}): User {
  if (!/^[\w-]+$/.test(name)) throw new Error(`Invalid test user: ${name}`)
  const root = options.root ?? path.join(os.homedir(), "u")
  const home = path.join(root, `home-${name}`)
  const binary = path.join(home, ".browse/bin/browse")
  const shim = path.join(home, ".local/share/opencode-browser/bin/opencode-browser.mjs")
  return {
    name,
    home,
    port: options.port ?? 19988,
    debugPort: options.debugPort ?? 9222,
    // An npm-only install has the shim and no binary: its commands run through node.
    binary: options.binary ?? (!fs.existsSync(binary) && fs.existsSync(shim) ? shim : binary),
    dataDir: path.join(home, ".local/share/opencode-browser"),
    profile: path.join(home, "chrome-profile"),
  }
}

/** The environment a command of this user runs with: its HOME, its relay port, no update check noise. */
export function userEnv(u: User, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const { OPENCODE_BROWSER_HOME: _home, ...base } = process.env
  return {
    ...base,
    HOME: u.home,
    DISPLAY,
    OPENCODE_BROWSER_PORT: String(u.port),
    OPENCODE_BROWSER_UPDATE_CHECK: process.env.OPENCODE_BROWSER_UPDATE_CHECK ?? "0",
    ...extra,
  }
}

export type CliResult = { status: number | null; stdout: string; stderr: string; ms: number; signal?: string }

/** Runs the user's installed CLI (`browse <args>`), as a shell would. */
export function cli(u: User, args: string[], options: { timeoutMs?: number; env?: NodeJS.ProcessEnv; binary?: string; input?: string } = {}): CliResult {
  const t = Date.now()
  const entry = options.binary ?? u.binary
  const [file, ...prefix] = entry.endsWith(".mjs") ? [process.execPath, entry] : [entry]
  const result = spawnSync(file!, [...prefix, ...args], {
    encoding: "utf8",
    env: userEnv(u, options.env),
    cwd: u.home,
    timeout: options.timeoutMs ?? 60_000,
    input: options.input,
  })
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", ms: Date.now() - t, ...(result.signal ? { signal: result.signal } : {}) }
}

export type Status = {
  endpoint: string
  relay: { running: boolean; version?: string; buildId?: string; stale?: boolean }
  extension: null | { connected: boolean; pairingState?: string; nextStep?: string; version?: string | null; build?: string | null; origin?: string | null; browsers?: { id: string; name: string; default?: boolean; connected?: boolean; version?: string | null }[]; sessions?: any[]; targets?: any[]; rejectedConnections?: number; pairingFailures?: number }
  sessions: any[]
  targets: any[]
  autoUpdate?: any
}

export function status(u: User, options: { binary?: string } = {}): Status {
  const result = cli(u, ["status", "--json"], { timeoutMs: 30_000, ...options })
  if (result.status !== 0) throw new Error(`status --json exited ${result.status}: ${(result.stderr || result.stdout).slice(0, 300)}`)
  return JSON.parse(result.stdout) as Status
}

export function relayToken(u: User): string {
  return fs.readFileSync(path.join(u.dataDir, "relay-token"), "utf8").trim()
}

export async function relayJson<T = any>(u: User, route: string, body?: unknown, timeoutMs = 10_000): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${u.port}${route}`, {
    ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
    headers: { authorization: `Bearer ${relayToken(u)}`, "content-type": "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) throw new Error(`${route}: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`)
  return (await response.json()) as T
}

/** The relay's pid (the process listening on the user's port), if any. */
export function relayPid(u: User): number | undefined {
  const out = spawnSync("ss", ["-ltnpH", `sport = :${u.port}`], { encoding: "utf8" }).stdout
  const match = /pid=(\d+)/.exec(out ?? "")
  return match ? Number(match[1]) : undefined
}

export function relayLog(u: User, lines = 80): string {
  const file = path.join(u.dataDir, "logs/relay.log")
  if (!fs.existsSync(file)) return ""
  return fs.readFileSync(file, "utf8").split("\n").slice(-lines).join("\n")
}

export function relayLogSize(u: User): number {
  const file = path.join(u.dataDir, "logs/relay.log")
  return fs.existsSync(file) ? fs.statSync(file).size : 0
}

/** Relay log lines appended since `from` (a size from relayLogSize). */
export function relayLogSince(u: User, from: number): string {
  const file = path.join(u.dataDir, "logs/relay.log")
  if (!fs.existsSync(file)) return ""
  const fd = fs.openSync(file, "r")
  try {
    const size = fs.fstatSync(fd).size
    if (size <= from) return ""
    const buffer = Buffer.alloc(size - from)
    fs.readSync(fd, buffer, 0, buffer.length, from)
    return buffer.toString("utf8")
  } finally {
    fs.closeSync(fd)
  }
}

/** An MCP stdio client on the user's installed binary, as the user's agent would start it. */
export function mcp(u: User, env: NodeJS.ProcessEnv = {}, binary = u.binary): McpClient {
  // An npm install's entry is the shim script, run by node (what install writes into the agent's MCP config).
  const command = binary.endsWith(".mjs") ? [process.execPath, binary, "mcp"] : [binary, "mcp"]
  return new McpClient(command, userEnv(u, env))
}

/** The npm install's stable MCP entry (auto-update.ts shim). */
export function npmShim(u: User): string {
  return path.join(u.dataDir, "bin/opencode-browser.mjs")
}

/** `browse pair` prints a one-time code; the command keeps waiting for the browser, so it runs detached. */
export function pairingCode(u: User, options: { binary?: string } = {}): string {
  const result = cli(u, ["pair", "--wait-seconds", "1"], { timeoutMs: 30_000, ...options })
  const match = /Pairing code: ([0-9A-Z]{4}-[0-9A-Z]{4})/.exec(result.stdout)
  if (!match) throw new Error(`pair printed no code (exit ${result.status}): ${(result.stdout + result.stderr).slice(0, 400)}`)
  return match[1]!
}

export class Chrome {
  readonly u: User
  readonly child: ChildProcess
  readonly extension: string
  readonly launchedAt: number

  private constructor(u: User, child: ChildProcess, extension: string, launchedAt: number) {
    this.u = u
    this.child = child
    this.extension = extension
    this.launchedAt = launchedAt
  }

  static async launch(u: User, options: { extension: string; url?: string; extraArgs?: string[]; freshProfile?: boolean; waitForDebugger?: boolean } = { extension: "" }): Promise<Chrome> {
    if (options.freshProfile) fs.rmSync(u.profile, { recursive: true, force: true })
    fs.mkdirSync(path.join(u.profile, "Default"), { recursive: true })
    for (const lock of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) fs.rmSync(path.join(u.profile, lock), { force: true })
    developerMode(u.profile)
    const args = [
      `--user-data-dir=${u.profile}`,
      ...(options.extension ? [`--load-extension=${options.extension}`] : []),
      "--no-first-run", "--no-default-browser-check", "--password-store=basic", "--disable-dev-shm-usage",
      `--remote-debugging-port=${u.debugPort}`, "--remote-debugging-address=127.0.0.1",
      "--window-size=1600,1000", "--window-position=0,0",
      ...(options.extraArgs ?? []),
      options.url ?? "about:blank",
    ]
    const child = spawn(CHROME, args, { env: userEnv(u), detached: true, stdio: ["ignore", "ignore", "ignore"] })
    child.unref()
    const chrome = new Chrome(u, child, options.extension, Date.now())
    if (options.waitForDebugger !== false) await chrome.waitForDebugger()
    return chrome
  }

  get pid() { return this.child.pid! }

  async waitForDebugger(timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const ok = await fetch(`http://127.0.0.1:${this.u.debugPort}/json/version`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false)
      if (ok) return
      await sleep(250)
    }
    throw new Error(`Chrome's debugging port ${this.u.debugPort} never answered`)
  }

  /** The process group this harness launched detached, not other profiles of the same Chrome executable. */
  pids(): number[] {
    const out = spawnSync("pgrep", ["-g", String(this.pid), "."], { encoding: "utf8" }).stdout ?? ""
    return out.split("\n").filter(Boolean).map(Number)
  }

  alive(): boolean {
    try { process.kill(this.pid, 0); return true } catch { return false }
  }

  /** As the OS would on sleep: every process of the browser stops getting CPU. */
  freeze() { for (const pid of this.pids()) { try { process.kill(pid, "SIGSTOP") } catch {} } }
  thaw() { for (const pid of this.pids()) { try { process.kill(pid, "SIGCONT") } catch {} } }

  /** A normal quit (SIGTERM to the browser process; it exits its children). */
  async stop(timeoutMs = 15_000): Promise<void> {
    try { process.kill(this.pid, "SIGTERM") } catch {}
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline && this.pids().length) await sleep(200)
    if (this.pids().length) this.kill9()
  }

  /** A crash: every process of the browser dies at once. */
  kill9() { for (const pid of this.pids()) { try { process.kill(pid, "SIGKILL") } catch {} } }

  async cdp(timeoutMs = 10_000): Promise<BrowserCdp> {
    const cdp = await BrowserCdp.connect(timeoutMs, this.u.debugPort)
    cdp.extensionId = extensionIdOf(this.extension)
    return cdp
  }
}

/** Unpacked extensions keep their path-derived id unless the manifest has a key: the release zip gets the store key. */
export function extensionIdOf(folder: string): string {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(folder, "manifest.json"), "utf8")) as { key?: string }
    if (manifest.key) {
      const digest = createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest("hex").slice(0, 32)
      return digest.replace(/[0-9a-f]/g, (hex) => String.fromCharCode(97 + parseInt(hex, 16)))
    }
  } catch {}
  return process.env.BROWSE_STRESS_EXTENSION_ID || STORE_EXTENSION_ID
}

/** The profile keeps developer mode on (unpacked extensions stay enabled across chrome.runtime.reload) and exits cleanly. */
function developerMode(profile: string) {
  const file = path.join(profile, "Default/Preferences")
  let prefs: any = {}
  try { prefs = JSON.parse(fs.readFileSync(file, "utf8")) } catch {}
  prefs.extensions ??= {}
  prefs.extensions.ui ??= {}
  prefs.extensions.ui.developer_mode = true
  for (const entry of Object.values(prefs.extensions.settings ?? {}) as any[]) {
    if (entry && typeof entry === "object" && "disable_reasons" in entry) { delete entry.disable_reasons; entry.state = 1 }
  }
  prefs.profile ??= {}
  prefs.profile.exit_type = "Normal"
  prefs.profile.exited_cleanly = true
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(prefs))
  fs.renameSync(`${file}.tmp`, file)
}

/** Opens install's pairing link in a new tab, exactly what `browse install` does on the user's computer. */
export async function pairViaLink(cdp: BrowserCdp, code: string): Promise<string> {
  const { targetId } = await cdp.send("Target.createTarget", { url: `chrome-extension://${cdp.extensionId}/welcome.html#code=${code}` })
  return targetId as string
}

/** Types the code into the settings page's form and submits it, like a person following `browse pair`'s instructions. */
export async function pairViaSettings(cdp: BrowserCdp, code: string, address?: string): Promise<string> {
  const { targetId } = await cdp.send("Target.createTarget", { url: `chrome-extension://${cdp.extensionId}/settings.html` })
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true })
  try {
    await cdp.send("Runtime.enable", {}, sessionId)
    const expression = `(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set
      const fill = (input, value) => { setter.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })) }
      for (let i = 0; i < 100; i++) {
        const form = document.querySelector("form.relay-form")
        if (form) {
          const inputs = [...form.querySelectorAll("input")]
          const codeInput = inputs.find((input) => input.placeholder === "XXXX-XXXX")
          const addressInput = inputs.find((input) => input.placeholder !== "XXXX-XXXX")
          if (!codeInput) return "no code input"
          if (${JSON.stringify(address ?? null)} !== null && addressInput) fill(addressInput, ${JSON.stringify(address ?? "")})
          fill(codeInput, ${JSON.stringify(code)})
          form.requestSubmit()
          return "submitted"
        }
        await new Promise((r) => setTimeout(r, 100))
      }
      return "no form"
    })()`
    const result = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId, 20_000)
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
    if (result.result.value !== "submitted") throw new Error(`settings form: ${result.result.value}`)
    return targetId as string
  } finally {
    await cdp.send("Target.detachFromTarget", { sessionId }).catch(() => undefined)
  }
}

/** The extension's own connection log (chrome.storage.session; what "Copy diagnostics" shows). */
export async function extensionLog(cdp: BrowserCdp): Promise<{ t: number; event: string; [k: string]: unknown }[]> {
  return await cdp.evalInExtension(`chrome.storage.session.get("agentRelayLog").then((s) => s.agentRelayLog ?? [])`)
}

export function formatExtensionLog(entries: { t: number; event: string; [k: string]: unknown }[], since = 0): string {
  return entries
    .filter((entry) => entry.t >= since)
    .map(({ t, event, ...fields }) => [new Date(t).toISOString(), event, ...Object.entries(fields).map(([k, v]) => `${k}=${typeof v === "string" ? JSON.stringify(v) : String(v)}`)].join(" "))
    .join("\n")
}

/** Collects the service worker's console (console.* and uncaught exceptions) while the collector is open. */
export async function swConsole(cdp: BrowserCdp): Promise<{ lines: string[]; close: () => Promise<void> }> {
  const lines: string[] = []
  const worker = await cdp.extensionWorker()
  if (!worker) return { lines, close: async () => undefined }
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: worker.targetId, flatten: true })
  const off = cdp.on((message) => {
    if (message.sessionId !== sessionId) return
    if (message.method === "Runtime.consoleAPICalled") {
      lines.push(`${new Date(message.params.timestamp).toISOString()} ${message.params.type} ${message.params.args.map((a: any) => a.value ?? a.description ?? "").join(" ")}`.slice(0, 500))
    } else if (message.method === "Runtime.exceptionThrown") {
      lines.push(`${new Date().toISOString()} exception ${message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text}`.slice(0, 500))
    }
  })
  await cdp.send("Runtime.enable", {}, sessionId).catch(() => undefined)
  return {
    lines,
    close: async () => { off(); await cdp.send("Target.detachFromTarget", { sessionId }).catch(() => undefined) },
  }
}

/** Polls until `check` is truthy; resolves with how long it took, rejects after `timeoutMs`. */
export async function waitFor<T>(check: () => Promise<T> | T, options: { timeoutMs?: number; everyMs?: number; label?: string } = {}): Promise<{ ms: number; value: T }> {
  const { timeoutMs = 120_000, everyMs = 250, label = "condition" } = options
  const started = Date.now()
  let last: unknown
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await check()
      if (value) return { ms: Date.now() - started, value }
    } catch (error) {
      last = error
    }
    await sleep(everyMs)
  }
  throw new Error(`${label} not met within ${timeoutMs} ms${last ? `: ${String(last).slice(0, 200)}` : ""}`)
}

export function extensionConnected(u: User, binary?: string): boolean {
  try {
    const s = status(u, binary ? { binary } : {})
    return !!s.extension?.connected
  } catch {
    return false
  }
}

/** Replaces an unpacked extension folder's files with another build's (what a store update does), keeping the path. */
export function replaceExtension(folder: string, source: string) {
  const staging = `${folder}.next`
  fs.rmSync(staging, { recursive: true, force: true })
  fs.cpSync(source, staging, { recursive: true })
  const old = `${folder}.old`
  fs.rmSync(old, { recursive: true, force: true })
  if (fs.existsSync(folder)) fs.renameSync(folder, old)
  fs.renameSync(staging, folder)
  fs.rmSync(old, { recursive: true, force: true })
}

/** Linux `iptables` drops on loopback are what the soak uses for the WAN; for the relay link, drop the relay port. */
export function dropRelayPort(u: User, on: boolean) {
  const action = on ? "-I" : "-D"
  for (const chain of ["INPUT", "OUTPUT"]) {
    spawnSync("sudo", ["-n", "iptables", action, chain, "-p", "tcp", "--dport", String(u.port), "-j", "DROP"], { stdio: "ignore" })
  }
}
