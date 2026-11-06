// One-time migration from earlier layouts to browse's XDG folders:
//   ~/.browse                     the installer's executable plus, in early versions, the data root
//   ~/.local/share/opencode-browser  the data root until 0.0.11 (or %LOCALAPPDATA%\opencode-browser on Windows)
// Every file is copied beside its destination and renamed into place, so an interrupted run simply continues. Existing
// new files always win (the old copy is removed, not merged), which makes a second run a no-op. Agent MCP entries that
// point at ~/.browse/bin/browse are rewritten to ~/.local/bin/browse; entries that record an absolute node path are
// rewritten to the stable `browse` command, since nvm/fnm change node between sessions. Then the old roots are removed.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { parse as parseJsonc, type ParseError } from "jsonc-parser"
import { parse as parseToml } from "smol-toml"
import { parseDocument } from "yaml"
import { binRoot, binaryName, cacheRoot, configRoot, dataRoot, stateRoot } from "../paths.ts"
import { agentLocations, browseServerCommand, editAgentConfig, type AgentName } from "./agent-config.ts"
import { configureMcp } from "./mcp.ts"

type Move = { readonly from: string; readonly to: string }

/** The old data root, which followed XDG_DATA_HOME on unix and LOCALAPPDATA on Windows. */
function oldDataRoot(home: string): string {
  if (home !== os.homedir()) return path.join(home, ".local", "share", "opencode-browser")
  if (process.platform === "win32")
    return path.join(process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "opencode-browser")
  return path.join(process.env.XDG_DATA_HOME ?? path.join(home, ".local", "share"), "opencode-browser")
}

const normalized = (value: string) => value.replaceAll("\\", "/")

/** Where one old file goes; undefined means the self-managed updater's leftovers, which are deleted. */
function destination(relative: string, home: string): string | undefined {
  const file = normalized(relative)
  const [top, ...rest] = file.split("/")
  if (top === "runtime" || top === "versions") return undefined
  if (top === "bin") {
    const name = rest.join("/")
    return name === binaryName() ? path.join(binRoot(home), binaryName()) : undefined
  }
  if (file === "settings.json" || file === "config.json") return path.join(configRoot(home), file)
  if (file === "update-check.json" || file === "extension.json" || top === "extension") return path.join(cacheRoot(home), file)
  if (file === "old-store-extension" || file === "auto-update.json" || file === "pairing-codes.json" || file === "session.json" || top === "logs" || top === "sessions")
    return path.join(stateRoot(home), file)
  if (top === "relays") return path.join(path.basename(file) === "lifecycle.jsonl" ? stateRoot(home) : dataRoot(home), file)
  // Pairings, tokens, secrets, session catalogs and anything unknown are durable data.
  return path.join(dataRoot(home), file)
}

/** The private files and folders that must keep 0600/0700. */
const privatePath = (relative: string) => {
  const file = normalized(relative)
  return file === "relay-token" || file === "browser-tokens.json" || file === "pairing-codes.json" ||
    file === "extension-pairing" || file === "session.json" || file.startsWith("secrets/") || file.startsWith("site-secrets/") ||
    file.startsWith("sessions/") || file === "auto-update.json" || file === "old-store-extension"
}

function filesUnder(root: string, relative = ""): string[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(path.join(root, relative), { withFileTypes: true })
  } catch {
    return []
  }
  return entries.flatMap((entry) => {
    const next = path.join(relative, entry.name)
    if (entry.isDirectory()) return filesUnder(root, next)
    return entry.isFile() ? [next] : []
  })
}

function copyPrivate(from: string, to: string, relative: string) {
  if (fs.existsSync(to)) return
  fs.mkdirSync(path.dirname(to), { recursive: true, mode: privatePath(relative) ? 0o700 : 0o755 })
  const temporary = `${to}.migrate-${process.pid}`
  fs.rmSync(temporary, { force: true })
  try {
    fs.copyFileSync(from, temporary)
    const source = fs.statSync(from)
    fs.chmodSync(temporary, privatePath(relative) ? 0o600 : source.mode & 0o777)
    fs.renameSync(temporary, to)
  } finally {
    fs.rmSync(temporary, { force: true })
  }
}

/** Whether a config file parses in its format, so a textual fallback can't corrupt it. Unknown formats are allowed. */
function configIsValid(file: string): boolean {
  const extension = path.extname(file).toLowerCase()
  try {
    const text = fs.readFileSync(file, "utf8")
    if (extension === ".toml") {
      parseToml(text)
      return true
    }
    if (extension === ".yaml" || extension === ".yml") {
      return parseDocument(text, { merge: true }).errors.length === 0
    }
    if (extension === ".json" || extension === ".jsonc") {
      const errors: ParseError[] = []
      parseJsonc(text, errors, { allowTrailingComma: true })
      return errors.length === 0
    }
    return true
  } catch {
    return false
  }
}

function writeTextAtomic(file: string, text: string) {
  const mode = fs.statSync(file).mode & 0o777
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`)
  try {
    fs.writeFileSync(temporary, text, { mode, flag: "wx" })
    fs.chmodSync(temporary, mode)
    fs.renameSync(temporary, file)
  } finally {
    fs.rmSync(temporary, { force: true })
  }
}

/** Replaces an old binary path in valid config text, including the JSON-escaped Windows form. Invalid configs are left
 * for `browse install` or a person to fix, so migration never rewrites something it can't parse. */
function rewriteBinaryText(file: string, oldBinary: string, newBinary: string) {
  if (!configIsValid(file)) return false
  let text: string
  try {
    text = fs.readFileSync(file, "utf8")
  } catch {
    return false
  }
  const before = text
  for (const [from, to] of [[oldBinary, newBinary], [oldBinary.replaceAll("\\", "\\\\"), newBinary.replaceAll("\\", "\\\\")]] as const)
    text = text.split(from).join(to)
  if (text === before) return false
  writeTextAtomic(file, text)
  return true
}

/** Whether a config still names a path, in plain or JSON-escaped form. */
function referencesPath(file: string, needle: string): boolean {
  try {
    const text = fs.readFileSync(file, "utf8")
    return text.includes(needle) || text.includes(needle.replaceAll("\\", "\\\\"))
  } catch {
    return false
  }
}

const absoluteNode = (command: string) => /(^|[\\/])(node|node\.exe)$/i.test(command)
/** An npm or npx entry (not a checkout) whose command is an absolute node plus a package script. */
const npmEntry = (entry: string) =>
  /(?:opencode-browser\.mjs|_npx[\\/].*@opencode[\\/]browse|node_modules[\\/]@opencode[\\/]browse)/i.test(entry)

/**
 * Rewrites one agent's browse entry. Returns true when it changed. The old entry is removed and re-added with
 * editAgentConfig, so unrelated settings and comments stay; opencode's different schema goes through configureMcp.
 */
function rewriteAgent(name: AgentName, file: string, oldBinary: string, newBinary: string): boolean {
  if (!fs.existsSync(file)) return false
  const command = browseServerCommand(name, file)
  if (!command || command.at(-1) !== "mcp") return false
  const target = command.at(-2)
  if (!target) return false
  if (command[0] === oldBinary || normalized(command[0] ?? "") === normalized(oldBinary)) {
    if (name === "opencode") return !!configureMcp(file, newBinary, oldBinary)
    const changed = editAgentConfig({ name: name as Exclude<AgentName, "opencode">, file, entry: oldBinary }, true)
    return changed === "removed" && editAgentConfig({ name: name as Exclude<AgentName, "opencode">, file, entry: newBinary }) === "added"
  }
  if (absoluteNode(command[0] ?? "") && npmEntry(target)) {
    // An npm install ran an absolute node and a package path; both move under nvm/fnm. `browse` on PATH is stable and
    // the supervisor behind it keeps running across updates.
    if (name === "opencode") return !!configureMcp(file, "browse", target)
    const changed = editAgentConfig({ name: name as Exclude<AgentName, "opencode">, file, node: command[0]!, entry: target }, true)
    return changed === "removed" && editAgentConfig({ name: name as Exclude<AgentName, "opencode">, file, entry: "browse" }) === "added"
  }
  return false
}

export type MigrationResult = { moved: number; rewritten: number; removed: string[] }

/** Idempotent, never throws: migration must not stop browse from starting. */
export function migrateLegacy(home = os.homedir()): MigrationResult {
  const result: MigrationResult = { moved: 0, rewritten: 0, removed: [] }
  if (process.env.OPENCODE_BROWSER_HOME) return result
  const roots = [path.join(home, ".browse"), oldDataRoot(home)]
  for (const root of roots) {
    if (!fs.existsSync(root)) continue
    let complete = true
    for (const relative of filesUnder(root)) {
      const to = destination(relative, home)
      if (!to) continue
      try {
        copyPrivate(path.join(root, relative), to, relative)
        result.moved++
      } catch {
        // Leave the old file for the next run; never overwrite a new one.
        complete = false
      }
    }
    if (complete) result.removed.push(root)
  }
  const oldBinary = path.join(home, ".browse", "bin", binaryName())
  const newBinary = path.join(binRoot(home), binaryName())
  // settings.json records the entry too; keep status and uninstall pointing at the new executable.
  const settingsFile = path.join(configRoot(home), "settings.json")
  try {
    rewriteBinaryText(settingsFile, oldBinary, newBinary)
  } catch {
    // Read-only settings: leave them, and keep the old root below.
  }
  const config = home === os.homedir() && process.env.XDG_CONFIG_HOME && path.isAbsolute(process.env.XDG_CONFIG_HOME)
    ? process.env.XDG_CONFIG_HOME
    : path.join(home, ".config")
  const locations = agentLocations(home, config, () => undefined, path.join(config, "opencode", "opencode.json"))
  for (const location of locations) {
    try {
      if (rewriteAgent(location.name, location.file, oldBinary, newBinary)) result.rewritten++
      else if (rewriteBinaryText(location.file, oldBinary, newBinary)) result.rewritten++
    } catch {
      // A malformed or conflicting config is left alone; `browse install` reports it.
    }
  }
  // Re-scan rather than trusting the rewrite result: if any agent still points into an old root, deleting it would
  // break that agent. Keep the referenced root so the next run retries; the other root can still go.
  const stillReferences = (needle: string) => locations.some((location) => referencesPath(location.file, needle))
  const keep = new Set<string>()
  const browseRoot = path.join(home, ".browse")
  const oldData = oldDataRoot(home)
  if (stillReferences(oldBinary)) keep.add(normalized(browseRoot))
  if (stillReferences(oldData)) keep.add(normalized(oldData))
  if (referencesPath(settingsFile, oldBinary)) keep.add(normalized(browseRoot))
  result.removed = result.removed.filter((root) => !keep.has(normalized(root)))
  const removable = result.removed.splice(0)
  for (const root of removable) {
    try {
      fs.rmSync(root, { recursive: true, force: true })
      result.removed.push(root)
    } catch {
      // A locked file stays for the next run.
    }
  }
  return result
}
