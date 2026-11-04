import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser"
import {
  compareVersions,
  installVersion,
  pruneVersions,
  readCurrent,
  switchVersion,
  updateState,
  versionEntry,
} from "../auto-update.ts"
import { cliCommand } from "../paths.ts"
import { opencodeBrowserVersion } from "../version.ts"
import { browsers } from "./browsers.ts"
import {
  configRoot,
  fail,
  files,
  fromSource,
  layout,
  LEGACY_HOST_NAME,
  LEGACY_MCP_NAME,
  LEGACY_REGISTRY_ROOTS,
  legacyFiles,
  MCP_NAME,
  PACKAGE,
  packageRoot,
  readFileOr,
  readJson,
  windows,
  type Settings,
} from "./environment.ts"

export type Servers = Record<
  string,
  { type?: unknown; command?: unknown; environment?: unknown; [key: string]: unknown }
>

export function configFile() {
  const directory = path.join(configRoot, "opencode")
  const candidates = ["opencode.json", "opencode.jsonc", ".opencode/opencode.json", ".opencode/opencode.jsonc"].map(
    (name) => path.join(directory, name),
  )
  return candidates.find((file) => existsSync(file) && statSync(file).isFile()) ?? candidates[0]!
}

/** Changes whenever the installed runtime does. */
function fingerprint(entry: string) {
  return createHash("sha256").update(readFileOr(entry, entry)).digest("hex").slice(0, 16)
}

/**
 * After an update, a relay still running the old build refuses the new CLI and MCP server; restart it from
 * the new runtime. Restarting keeps browser tabs open but ends in-flight agent work, so it's announced. The relay
 * declines while agents use it (a connected session, a recording); then it keeps the old version, and the lines say
 * so and how to restart it later.
 */
export function restartOutdatedRelay(entry: string, node: string): string[] | undefined {
  const status = spawnSync(node, [entry, "status", "--json"], { encoding: "utf8", timeout: 15_000 })
  if (!/"stale":\s*true/.test(status.stdout ?? "")) return undefined
  const restart = spawnSync(node, [entry, "relay", "restart"], { encoding: "utf8", timeout: 60_000 })
  if (restart.status === 0) return ["✓ Relay restarted with the new version"]
  return relayNotRestarted(status.stdout ?? "", `${restart.stderr ?? ""}\n${restart.stdout ?? ""}`)
}

/** What to say when the relay declined to restart: who is using it, that it runs the old version, and the command. */
export function relayNotRestarted(statusJson: string, output: string, command = cliCommand("relay restart")): string[] {
  const sessions = (() => {
    try {
      const parsed = JSON.parse(statusJson) as { sessions?: { id?: unknown; connected?: unknown }[] }
      return (parsed.sessions ?? [])
        .filter((item) => item.connected === true && typeof item.id === "string")
        .map((item) => item.id as string)
    } catch {
      return []
    }
  })()
  // The relay's reason, without the restart command's own preamble.
  const reason = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("Restarting the relay leaves"))
    .join(" ")
  const who =
    sessions.length === 1
      ? `an agent session is active (${sessions[0]})`
      : sessions.length > 1
        ? `${sessions.length} agent sessions are active (${sessions.slice(0, 5).join(", ")}${sessions.length > 5 ? ", …" : ""})`
        : undefined
  // A capture, recording or raw client refuses the restart until it ends; --force ends it.
  const forceable = /--force/.test(reason)
  return [
    `! Relay not restarted: ${who ?? (reason || "it declined")}${who && reason ? ` (${reason})` : ""}.`,
    "  It keeps running the previous version, so agents get this update only after it restarts.",
    forceable
      ? `  When no agent is using the browser, run: ${command} (or ${command} --force to end what's blocking it now)`
      : `  When no agent is using the browser, run: ${command}`,
  ]
}

export function mcpServers(file = configFile()) {
  const errors: ParseError[] = []
  const config = parse(existsSync(file) ? readFileSync(file, "utf8") : "{}", errors, { allowTrailingComma: true })
  if (
    errors.length ||
    [config, config?.mcp, config?.mcp?.servers].some(
      (v) => v !== undefined && (!v || typeof v !== "object" || Array.isArray(v)),
    )
  )
    fail(`Invalid ${file}; left unchanged`)
  return (config as { mcp?: { servers?: Servers } }).mcp?.servers ?? {}
}

function ownedMcp(server: Servers[string] | undefined, entry: string | undefined) {
  const command = server?.command
  return (
    Array.isArray(command) &&
    command.length === 3 &&
    command[2] === "mcp" &&
    [entry, layout.shim, path.join(packageRoot, "dist/cli.mjs")].some((e) => e && command[1] === e)
  )
}

/**
 * The browse MCP server entry: the existing one with its command and runtime fingerprint updated, so environment
 * variables and other settings the user added (`enabled`, `timeout`) stay.
 */
function mergedMcpServer(existing: Servers[string] | undefined, command: string[], runtime: string) {
  const environment =
    typeof existing?.environment === "object" && existing.environment !== null && !Array.isArray(existing.environment)
      ? existing.environment
      : {}
  return { ...existing, type: "local", command, environment: { ...environment, OPENCODE_BROWSER_RUNTIME: runtime } }
}

/** Writes (or updates) the browse MCP server so it runs the installed runtime, keeping the user's settings. */
export function configureMcp(file: string, entry: string, previousEntry?: string) {
  // A running MCP server keeps its old code after an update, and its relay calls then fail on the build check.
  // Stamping the runtime's fingerprint into the entry changes the config whenever the runtime changes, which
  // makes opencode restart the server with the new code.
  const existing = mcpServers(file)[MCP_NAME]
  if (existing && !ownedMcp(existing, previousEntry)) return undefined
  const renamed = removeMcp(LEGACY_MCP_NAME, previousEntry, file)
  // The shim of an npm install never changes and swaps the server itself after an update, so its entry stays the same.
  const server = mergedMcpServer(
    existing,
    [process.execPath, entry, "mcp"],
    entry === layout.shim ? "auto-update" : fingerprint(entry),
  )
  if (existing && JSON.stringify(existing) === JSON.stringify(server)) return `"${MCP_NAME}" is up to date`
  const text = readFileOr(file, "{}")
  const edits = modify(text, ["mcp", "servers", MCP_NAME], server, {
    formattingOptions: { tabSize: 2, insertSpaces: true },
  })
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, applyEdits(text, edits))
  if (renamed) return `"${LEGACY_MCP_NAME}" renamed to "${MCP_NAME}" in ${file}`
  return existing ? `"${MCP_NAME}" updated in ${file}` : `"${MCP_NAME}" added to ${file}`
}

export function removeMcp(name: string, entry?: string, file = configFile()) {
  const text = readFileOr(file, "")
  if (!text || !ownedMcp(mcpServers(file)[name], entry)) return false
  writeFileSync(file, applyEdits(text, modify(text, ["mcp", "servers", name], undefined, {})))
  return true
}

/** MCP servers from the separate Browser Control product, which Browse replaces. */
export function legacyBrowserControl() {
  return Object.entries(mcpServers())
    .filter(([name, server]) => name === "browser-control" || JSON.stringify(server.command ?? "").includes("browser-control"))
    .map(([name]) => name)
}

/** Removes the native messaging host and opencode plugin of earlier versions; true when any was there. */
export function removeLegacyHost() {
  const leftovers = [
    ...browsers().flatMap((browser) =>
      browser.manifests.map((directory) => path.join(directory, `${LEGACY_HOST_NAME}.json`)),
    ),
    ...legacyFiles,
  ].filter((file) => existsSync(file))
  leftovers.forEach((file) => rmSync(file, { force: true }))
  const keys = windows
    ? LEGACY_REGISTRY_ROOTS.map((regRoot) => `${regRoot}\\NativeMessagingHosts\\${LEGACY_HOST_NAME}`).filter(
        (key) => spawnSync("reg", ["query", key, "/ve"]).status === 0,
      )
    : []
  keys.forEach((key) => spawnSync("reg", ["delete", key, "/f"]))
  return leftovers.length + keys.length > 0
}

/**
 * Installs this exact version into the data root (runtime/versions/<version>, auto-update.ts), points runtime/current.json
 * at it and writes the stable shim, so the MCP server keeps working after the npx cache is cleared and later updates
 * never change opencode's config. Returns the shim and the version. From source (development), runs in place.
 * OPENCODE_BROWSER_PACKAGE installs a specific spec instead, for example a local tarball.
 */
export async function installRuntime(): Promise<{ entry: string; version: string }> {
  // From a checkout, run the bundle `bun run build` wrote: Node can't run the TypeScript sources (they use
  // syntax type stripping doesn't cover), and the MCP server runs under Node.
  if (fromSource) {
    const bundle = path.join(packageRoot, "dist", "cli.mjs")
    if (!existsSync(bundle)) fail("Build the CLI first: `bun run build` in cli/ (or `bun run setup` at the top).")
    return { entry: bundle, version: opencodeBrowserVersion }
  }
  const spec = process.env.OPENCODE_BROWSER_PACKAGE
  const before = readCurrent(layout)
  // Already installed (install run again): keep it. Reinstalling would replace the files a running relay still loads.
  const existing = versionEntry(layout, opencodeBrowserVersion)
  const reuse =
    !spec &&
    existsSync(existing) &&
    readFileSync(existing).equals(readFileSync(path.join(packageRoot, "dist", "cli.mjs"))) &&
    spawnSync(process.execPath, [existing, "--version"], { encoding: "utf8", timeout: 30_000 }).stdout?.trim() ===
      opencodeBrowserVersion
  let installed: string
  try {
    installed = reuse
      ? existing
      : await installVersion({
          layout,
          version: opencodeBrowserVersion,
          ...(spec ? { spec } : { runningPackage: packageRoot }),
        })
  } catch (error) {
    fail(`Could not install ${spec ?? `${PACKAGE}@${opencodeBrowserVersion}`}: ${(error as Error).message}`)
  }
  const version = path.basename(path.dirname(path.dirname(path.dirname(path.dirname(path.dirname(installed))))))
  // Running install again for the same version keeps the version it replaced for rollback.
  const previous = before?.version === version ? before.previous : before?.version
  switchVersion(layout, version, previous)
  // Installing by hand settles any update the relay was waiting to switch to, and un-skips this version.
  updateState(layout, ({ pending, skipped, ...state }) => ({
    ...state,
    ...(pending && compareVersions(pending, version) > 0 ? { pending } : {}),
    ...(skipped && skipped !== version ? { skipped } : {}),
  }))
  pruneVersions(layout, [version, previous])
  // Earlier versions installed one copy straight into runtime/; the shim replaces it.
  for (const legacy of ["node_modules", "package.json", "package-lock.json"])
    rmSync(path.join(files.runtime, legacy), { recursive: true, force: true })
  return { entry: layout.shim, version }
}

/**
 * What install set up: the runtime the browse MCP server runs and its version. Read from settings.json, else from
 * the MCP server entry itself (a checkout install from an earlier version wrote no version there).
 */
export function installedRuntime(settings: Settings | undefined, server: Servers[string] | undefined) {
  const command = Array.isArray(server?.command)
    ? server.command.filter((part): part is string => typeof part === "string")
    : []
  const entry = settings?.entry ?? command.find((part) => /cli\.m?js$/.test(part))
  if (!entry || (!settings?.version && !existsSync(entry))) return undefined
  // A bundle with the sources beside it is a checkout's build: cli/dist/cli.mjs next to cli/src/main.ts.
  const packageDir = path.dirname(path.dirname(entry))
  const source = existsSync(path.join(packageDir, "src", "main.ts"))
  // The shim runs whatever runtime/current.json names, which auto-update moves.
  const version =
    (entry === layout.shim ? readCurrent(layout)?.version : undefined) ??
    settings?.version ??
    (path.resolve(entry) === path.join(packageRoot, "dist", "cli.mjs")
      ? opencodeBrowserVersion
      : readJson<{ version?: string }>(path.join(packageDir, "package.json"))?.version)
  return { entry, version, source }
}
