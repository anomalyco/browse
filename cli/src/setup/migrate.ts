// One-time migration from earlier layouts to browse's XDG folders:
//   ~/.browse                     the installer's executable plus, in early versions, the data root
//   ~/.local/share/opencode-browser  the data root until 0.0.11 (or %LOCALAPPDATA%\opencode-browser on Windows)
// Every file is copied beside its destination and renamed into place, so an interrupted run simply continues. Existing
// new files always win (the old copy is removed, not merged), which makes a second run a no-op. Agent MCP entries that
// point at ~/.browse/bin/browse are rewritten to ~/.local/bin/browse; entries that record an absolute node path are
// rewritten to the stable `browse` command, since nvm/fnm change node between sessions. Then the old roots are removed;
// the old data root waits LEGACY_HANDOVER_GRACE_MS after its runtime was taken over (legacy-runtime.ts).
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { parse as parseJsonc, type ParseError } from "jsonc-parser"
import { parse as parseToml } from "smol-toml"
import { parseDocument } from "yaml"
import { binRoot, binaryName, cacheRoot, configRoot, dataRoot, devExtensionFolder, stateRoot } from "../paths.ts"
import { agentLocations, browseServerCommand, editAgentConfig, type AgentName } from "./agent-config.ts"
import { LEGACY_HANDOVER_GRACE_MS, legacyDataRoot, legacyRoots, legacyRuntime } from "./legacy.ts"
import type { Settings } from "./environment.ts"
import { configureMcp, OPENCODE_CONFIG_NAMES } from "./mcp.ts"

type Move = { readonly from: string; readonly to: string }

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

const lexists = (file: string) => {
  try {
    fs.lstatSync(file)
    return true
  } catch {
    return false
  }
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

function copyPrivate(from: string, to: string, relative: string, overwrite = false) {
  if (!overwrite && fs.existsSync(to)) return
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

/**
 * Copies the old data root into the XDG folders with the old files winning, for taking over a runtime that still uses
 * them (legacy-runtime.ts) before its relay is replaced. Only copies: nothing is removed or rewritten until the new relay
 * owns the port. Never throws.
 */
export function copyLegacyData(home = os.homedir()) {
  const root = legacyDataRoot(home)
  const record = takeoverRecord(home)
  // A takeover that stopped before its relay listened left these copies; the old folder is still the truth, so a file
  // deleted from it since (a site secret, a revoked pairing) must not come back from them.
  for (const file of readCopied(record)) fs.rmSync(file, { force: true })
  const copies = filesUnder(root).flatMap((relative) => {
    const to = destination(relative, home)
    return to ? [{ relative, to }] : []
  })
  try {
    fs.mkdirSync(path.dirname(record), { recursive: true, mode: 0o700 })
    fs.writeFileSync(record, JSON.stringify({ copied: copies.map((copy) => copy.to) }) + "\n", { mode: 0o600 })
  } catch {
    // Without the record a stopped takeover can leave stale copies; copying is still right.
  }
  for (const { relative, to } of copies) {
    try {
      copyPrivate(path.join(root, relative), to, relative, true)
    } catch {
      // The takeover's migration copies it again once the relay is up.
    }
  }
}

/** The files copyLegacyData copied for a takeover not yet published (legacy-runtime.ts). */
const takeoverRecord = (home: string) => path.join(stateRoot(home), "legacy-takeover.json")

function readCopied(record: string): string[] {
  try {
    const copied = (JSON.parse(fs.readFileSync(record, "utf8")) as { copied?: unknown }).copied
    return Array.isArray(copied) ? copied.filter((file): file is string => typeof file === "string") : []
  } catch {
    return []
  }
}

/** What earlier installs recorded in settings.json: the OpenCode configs and agent entries they wrote. */
function recordedConfigs(home: string): AgentLocationRecord[] {
  return [path.join(configRoot(home), "settings.json"), path.join(home, ".browse", "settings.json"), path.join(legacyDataRoot(home), "settings.json")].flatMap((file) => {
    try {
      const settings = JSON.parse(fs.readFileSync(file, "utf8")) as Settings
      return [
        ...(settings.opencodeConfigs ?? []).filter((config) => typeof config === "string").map((config) => ({ name: "opencode" as const, file: config })),
        ...(settings.agents ?? []).filter((agent) => typeof agent?.file === "string").map((agent) => ({ name: agent.name, file: agent.file })),
      ]
    } catch {
      return []
    }
  })
}

type AgentLocationRecord = { readonly name: AgentName; readonly file: string }

/**
 * A dev install's unpacked extension: the browser loaded the old root's extension folder by its path, and reloads that
 * path when the new relay updates the extension. The folder moves to the cache root and the old path becomes a link to
 * it, which stays for as long as the old root does.
 */
function linkLegacyExtension(root: string, home: string) {
  const old = path.join(root, "extension")
  try {
    // Absent, or already the link.
    if (!fs.lstatSync(old).isDirectory()) return
  } catch {
    return
  }
  const folder = devExtensionFolder(cacheRoot(home))
  const link = `${old}.link-${process.pid}`
  try {
    fs.mkdirSync(path.dirname(folder), { recursive: true })
    // Link first, so a failure leaves the folder the browser loads untouched.
    fs.rmSync(link, { force: true })
    fs.symlinkSync(folder, link, "junction")
    if (fs.existsSync(folder)) fs.rmSync(old, { recursive: true, force: true })
    else {
      try {
        fs.renameSync(old, folder)
      } catch {
        fs.cpSync(old, folder, { recursive: true })
        fs.rmSync(old, { recursive: true, force: true })
      }
    }
    fs.renameSync(link, old)
  } catch {
    fs.rmSync(link, { force: true })
  }
}

/** Idempotent, never throws: migration must not stop browse from starting. */
export function migrateLegacy(home = os.homedir(), now = Date.now()): MigrationResult {
  const result: MigrationResult = { moved: 0, rewritten: 0, removed: [] }
  if (process.env.OPENCODE_BROWSER_HOME) return result
  const roots = legacyRoots(home)
  const oldData = legacyDataRoot(home)
  // Read before the files move: settings.json names configs the default locations don't cover.
  const recorded = recordedConfigs(home)
  for (const root of roots) {
    if (!fs.existsSync(root)) continue
    if (root === oldData) linkLegacyExtension(root, home)
    let complete = true
    for (const relative of filesUnder(root)) {
      const to = destination(relative, home)
      if (!to) continue
      try {
        copyPrivate(path.join(root, relative), to, relative)
        result.moved++
        // Moved, not copied, so a later run can't bring back a file deleted in the new folders. The executable stays
        // until no agent runs it, and the extension until no browser loads it.
        const top = normalized(relative).split("/")[0]
        if (top !== "bin" && top !== "extension") fs.rmSync(path.join(root, relative), { force: true })
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
  // Every config the installer may have written browse into: OpenCode's default candidates, then what settings recorded.
  const opencodeConfigs = OPENCODE_CONFIG_NAMES.map((name) => path.join(config, "opencode", name))
  const locations = [
    ...agentLocations(home, config, () => undefined, opencodeConfigs[0]!).filter((location) => location.name !== "opencode"),
    ...opencodeConfigs.map((file) => ({ name: "opencode" as const, file })),
    ...recorded,
  ].filter((location, index, all) => all.findIndex((other) => other.name === location.name && normalized(other.file) === normalized(location.file)) === index)
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
  if (stillReferences(oldBinary)) keep.add(normalized(browseRoot))
  if (stillReferences(oldData)) keep.add(normalized(oldData))
  // Just taken over (legacy-runtime.ts): agents' running shims still read runtime/current.json to reach the new server.
  const takenOver = legacyRuntime(home)
  if (takenOver?.movedTo && !(now - Date.parse(takenOver.switchedAt ?? "") >= LEGACY_HANDOVER_GRACE_MS)) keep.add(normalized(oldData))
  // Published: the copies are the new folders' own files now.
  if (takenOver?.movedTo) {
    try {
      fs.rmSync(takeoverRecord(home), { force: true })
    } catch {
      // A stale record only means a later takeover's copy removes these; there won't be one.
    }
  }
  if (referencesPath(settingsFile, oldBinary)) keep.add(normalized(browseRoot))
  result.removed = result.removed.filter((root) => !keep.has(normalized(root)))
  const removable = result.removed.splice(0)
  for (const root of removable) {
    try {
      // The extension link outlives everything else in the old data root (linkLegacyExtension).
      const keepExtension = root === oldData && lexists(path.join(root, "extension"))
      if (!keepExtension) fs.rmSync(root, { recursive: true, force: true })
      else for (const name of fs.readdirSync(root)) if (name !== "extension") fs.rmSync(path.join(root, name), { recursive: true, force: true })
      result.removed.push(root)
    } catch {
      // A locked file stays for the next run.
    }
  }
  return result
}
