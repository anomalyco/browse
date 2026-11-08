// The folders earlier browse layouts used, kept in their own light module: main.ts checks them on every start, and the
// execute file guard denies them, so neither should pull in the migration module (and its JSON/TOML/YAML parsers).
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

/** The old data root, which followed XDG_DATA_HOME on unix and LOCALAPPDATA on Windows. */
export function legacyDataRoot(home = os.homedir()): string {
  if (home !== os.homedir()) return path.join(home, ".local", "share", "opencode-browser")
  if (process.platform === "win32") {
    const configured = process.env.LOCALAPPDATA
    return path.join(configured && path.isAbsolute(configured) ? configured : path.join(home, "AppData", "Local"), "opencode-browser")
  }
  const configured = process.env.XDG_DATA_HOME
  return path.join(configured && path.isAbsolute(configured) ? configured : path.join(home, ".local", "share"), "opencode-browser")
}

/** Roots earlier layouts kept browse's files in; migration copies them into the XDG folders on the next run. */
export function legacyRoots(home = os.homedir()): readonly string[] {
  return [path.join(home, ".browse"), legacyDataRoot(home)]
}

/** Whether migration has work left: an old root holds more than the extension link it keeps for a dev extension. */
export function legacyRootsLeft(home = os.homedir()) {
  return legacyRoots(home).some((root) => {
    try {
      return fs.readdirSync(root).some((name) => name !== "extension" || !fs.lstatSync(path.join(root, name)).isSymbolicLink())
    } catch {
      return false
    }
  })
}

/**
 * The self-managed runtime of releases before 0.0.11: runtime/current.json names the version under runtime/versions
 * that the old shim (bin/opencode-browser.mjs, which agents' MCP entries run) starts, with OPENCODE_BROWSER_HOME set to
 * the old data root. `movedTo` is set once a relay from a current install took it over (setup/legacy-runtime.ts).
 */
export type LegacyRuntime = {
  readonly root: string
  readonly version: string
  readonly binary?: string
  readonly movedTo?: string
  readonly switchedAt?: string
}

export function legacyRuntime(home = os.homedir()): LegacyRuntime | undefined {
  const root = legacyDataRoot(home)
  try {
    const current = JSON.parse(fs.readFileSync(path.join(root, "runtime", "current.json"), "utf8")) as Record<string, unknown>
    if (typeof current.version !== "string") return undefined
    const text = (key: string) => (typeof current[key] === "string" ? { [key]: current[key] as string } : {})
    return { root, version: current.version, ...text("binary"), ...text("movedTo"), ...text("switchedAt") }
  } catch {
    return undefined
  }
}

/** The old shim still starts browse from runtime/versions: nothing has taken it over, and it doesn't run a binary. */
export const legacyRuntimeActive = (runtime: LegacyRuntime | undefined) => !!runtime && !runtime.binary && !runtime.movedTo

/** How long a taken-over runtime stays, so agents' running shims can follow current.json to the new MCP server. */
export const LEGACY_HANDOVER_GRACE_MS = 10 * 60_000

/** A path with symlinks resolved, where it exists: the old shim names its folder that way, HOME may not. */
const real = (value: string) => {
  try {
    return fs.realpathSync(value)
  } catch {
    return path.resolve(value)
  }
}

/** Whether `file` is inside `root`, comparing real paths (macOS's temporary folders are /var, really /private/var). */
export function insidePath(file: string, root: string) {
  const relative = path.relative(real(root), real(file))
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
}

export const samePath = (left: string, right: string) => {
  const normalize = (value: string) => (process.platform === "win32" ? real(value).toLowerCase() : real(value))
  return normalize(left) === normalize(right)
}

/**
 * Settles OPENCODE_BROWSER_HOME for an old runtime before anything resolves a path. While the old shim still starts
 * browse, every browse process shares its folder with the relay it started (as the shim's own processes do), rather than
 * migrating the folder out from under that relay. Once taken over, the old folder the shim sets is no override.
 */
export function settleLegacyHome(env: NodeJS.ProcessEnv = process.env, runtime = legacyRuntime()) {
  if (runtime && legacyRuntimeActive(runtime)) env.OPENCODE_BROWSER_HOME ??= runtime.root
  else if (runtime?.movedTo && env.OPENCODE_BROWSER_HOME && samePath(env.OPENCODE_BROWSER_HOME, runtime.root)) delete env.OPENCODE_BROWSER_HOME
}
