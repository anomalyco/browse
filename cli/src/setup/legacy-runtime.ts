// Taking over the self-managed runtime of releases before 0.0.11 (setup/legacy.ts). Its shim, bin/opencode-browser.mjs,
// starts runtime/versions/<current.json version>/node_modules/@opencode/browse/dist/cli.mjs, and an agent's running
// shim swaps its MCP server once current.json names another version and the relay reports that version. A relay
// started from a current install (the npm global package or the binary) while that runtime is active takes it over, in
// two steps around binding the relay port:
//   prepare  (main.ts, before `serve` starts) only for the default home and a port without a browse relay on it: copies
//            the old folder's data into the XDG folders, the old files winning, and stops treating the old folder as
//            OPENCODE_BROWSER_HOME.
//   commit   (cli/relay.ts, once the relay listens) writes a forwarder for this version that runs the current install,
//            points current.json at it so running agents follow, then migrates (setup/migrate.ts): agents' entries
//            become `browse mcp`, and the old folder goes after a grace period.
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { compiledBinary, installerBinaryPath } from "../paths.ts"
import { probeRelayPort, relayPortPinned, resolveRelayPort } from "../relay/port.ts"
import { channelOf, installedRuntime, type Runtime } from "../update/auto-update.ts"
import { opencodeBrowserVersion } from "../version.ts"
import { insidePath, legacyRuntimeActive, samePath, type LegacyRuntime } from "./legacy.ts"

/** Marks a version folder this module wrote, so it is rewritten rather than mistaken for a real package. */
const FORWARDER = "// browse: this old runtime folder runs the current install"

/** The CLI file the old shim starts for `version`. */
export const legacyEntry = (root: string, version: string) =>
  path.join(root, "runtime", "versions", version, "node_modules", "@opencode", "browse", "dist", "cli.mjs")

/**
 * The install this process runs. A binary is the installer's executable only: under the old shim OPENCODE_BROWSER_HOME
 * points at the old folder, whose bin/ holds the shim, not an executable.
 */
export function currentInstall(options: { readonly compiled?: boolean; readonly execPath?: string; readonly home?: string } = {}): Runtime | undefined {
  if (!(options.compiled ?? compiledBinary())) return installedRuntime()
  const binary = installerBinaryPath(options.home)
  return realpath(binary) === realpath(options.execPath ?? process.execPath) ? { kind: "binary", entry: binary, version: opencodeBrowserVersion } : undefined
}

let pending: { readonly legacy: LegacyRuntime; readonly install: Runtime; readonly home: string } | undefined

/** Before a relay starts: whether it takes the old runtime over (see the top of this file). */
export async function prepareLegacyTakeover(legacy: LegacyRuntime | undefined, options: {
  readonly install?: Runtime | undefined
  readonly env?: NodeJS.ProcessEnv
  readonly home?: string
  /** Tests inject the port and pin state so they never touch the real 19988–19997 range. */
  readonly relayPort?: number
  readonly pinned?: boolean
} = {}): Promise<boolean> {
  const env = options.env ?? process.env
  const install = "install" in options ? options.install : currentInstall()
  if (!legacy || !legacyRuntimeActive(legacy) || !install || install.kind === "npx" || insidePath(install.entry, legacy.root)) return false
  // An isolated relay (its own OPENCODE_BROWSER_HOME) leaves the old runtime alone.
  if (env.OPENCODE_BROWSER_HOME && !samePath(env.OPENCODE_BROWSER_HOME, legacy.root)) return false
  // Another relay holds the port: this one won't start, so it mustn't take anything over. Pinned keeps the old rule:
  // anything listening blocks. Unpinned lets a definite non-browse HTTP reply through, since the relay would then fall
  // back (relay/port.ts), and takes a free port. A browse relay blocks, and so does a port that is bound but silent or
  // times out: a probe that fails to answer is a doubt, not a free port.
  const port = options.relayPort ?? (Number(env.OPENCODE_BROWSER_PORT) || resolveRelayPort())
  if (options.pinned ?? relayPortPinned(env)) {
    if (await portInUse(port)) return false
  } else {
    const owner = await probeRelayPort(port)
    if (owner === "browse" || (owner === "nobody" && (await portInUse(port)))) return false
  }
  const home = options.home ?? os.homedir()
  const { copyLegacyData } = await import("./migrate.ts")
  // First, or the XDG paths the copy writes to would still resolve to the old folder.
  delete env.OPENCODE_BROWSER_HOME
  copyLegacyData(home)
  pending = { legacy, install, home }
  return true
}

/** Once the relay prepareLegacyTakeover started listens: points the old runtime at it, then migrates. Never throws. */
export async function commitLegacyTakeover(now = Date.now()): Promise<boolean> {
  if (!pending) return false
  const { legacy, install, home } = pending
  pending = undefined
  try {
    if (!adoptLegacyRuntime(legacy, install, now)) return false
    const { migrateLegacy } = await import("./migrate.ts")
    migrateLegacy(home, now)
    return true
  } catch {
    return false
  }
}

/** Points the old runtime at `runtime` (this process's install). False when there is nothing to take over. */
export function adoptLegacyRuntime(legacy: LegacyRuntime | undefined, runtime = currentInstall(), now = Date.now()): boolean {
  if (!legacy || !legacyRuntimeActive(legacy) || !runtime || runtime.kind === "npx" || insidePath(runtime.entry, legacy.root)) return false
  const entry = legacyEntry(legacy.root, runtime.version)
  // Another copy of this exact version already sits there: the shim runs the same build, so it only needs the record.
  if (!fs.existsSync(entry) || fs.readFileSync(entry, "utf8").includes(FORWARDER)) writeForwarder(entry, runtime)
  writeAtomic(path.join(legacy.root, "runtime", "current.json"), JSON.stringify({
    version: runtime.version,
    previous: legacy.version,
    channel: channelOf(runtime.version),
    switchedAt: new Date(now).toISOString(),
    movedTo: runtime.entry,
  }, null, 2) + "\n", 0o600)
  return true
}

/** A package folder whose CLI runs `runtime`: a script in this process, an executable as a child with the same stdio. */
function writeForwarder(entry: string, runtime: Runtime) {
  const packageDir = path.dirname(path.dirname(entry))
  fs.mkdirSync(path.dirname(entry), { recursive: true })
  writeAtomic(path.join(packageDir, "package.json"), JSON.stringify({ name: "@opencode/browse", version: runtime.version, private: true }) + "\n")
  const target = JSON.stringify(runtime.entry)
  const run = runtime.kind === "binary"
    ? [
        `import { spawn } from "node:child_process"`,
        `const child = spawn(${target}, process.argv.slice(2), { stdio: "inherit" })`,
        `for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => child.kill(signal))`,
        `child.on("exit", (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0) })`,
      ]
    : [
        `import { pathToFileURL } from "node:url"`,
        `process.argv[1] = ${target}`,
        `await import(pathToFileURL(${target}).href)`,
      ]
  writeAtomic(entry, ["#!/usr/bin/env node", `${FORWARDER} (${runtime.kind}). Don't edit.`, ...run, ""].join("\n"))
}

function realpath(file: string) {
  try {
    return fs.realpathSync(file)
  } catch {
    return path.resolve(file)
  }
}

/** Whether something accepts connections on the relay port; anything but a refusal counts, so a doubt never takes over. */
function portInUse(port: number) {
  return new Promise<boolean>((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port })
    socket.setTimeout(1000, () => (socket.destroy(), resolve(true)))
    socket.once("connect", () => (socket.destroy(), resolve(true)))
    socket.once("error", (error: NodeJS.ErrnoException) => resolve(error.code !== "ECONNREFUSED"))
  })
}

function writeAtomic(file: string, text: string, mode = 0o644) {
  const temporary = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temporary, text, { mode })
  fs.renameSync(temporary, file)
}
