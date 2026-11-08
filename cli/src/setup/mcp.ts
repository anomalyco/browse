import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser"
import { npmGlobalRoot, runCommand, installedVersion } from "../update/auto-update.ts"
import { cliCommand, compiledBinary, entryCommand, entrySpawnCommand, resolveWindowsShim, scriptEntry } from "../paths.ts"
import { opencodeBrowserVersion } from "../version.ts"
import { installBinaryRuntime } from "./binary.ts"
import { browsers } from "./browsers.ts"
import {
  configRoot,
  fail,
  files,
  fromSource,
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

/** Where earlier versions kept the npm shim agents ran; install adopts and removes those entries. */
export const legacyShimPath = () => path.join(files.dir, "bin", "opencode-browser.mjs")

export type Servers = Record<
  string,
  { type?: unknown; command?: unknown; environment?: unknown; [key: string]: unknown }
>

/** OpenCode's user config files under its config folder, in the order OpenCode reads them. */
export const OPENCODE_CONFIG_NAMES = ["opencode.json", "opencode.jsonc", ".opencode/opencode.json", ".opencode/opencode.jsonc"]

export function configFile() {
  const directory = path.join(configRoot, "opencode")
  const candidates = OPENCODE_CONFIG_NAMES.map(
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
export function restartOutdatedRelay(entry: string): string[] | undefined {
  const [file, ...prefix] = entrySpawnCommand(entry)
  const status = spawnSync(file!, [...prefix, "status", "--json"], { encoding: "utf8", timeout: 15_000 })
  if (!/"stale":\s*true/.test(status.stdout ?? "")) return undefined
  const restart = spawnSync(file!, [...prefix, "relay", "restart"], { encoding: "utf8", timeout: 60_000 })
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

/**
 * A browse server install wrote: `<node> <entry> mcp` or `<executable> mcp`, where the entry is the one install recorded,
 * a checkout's bundle, or a binary install's executable on PATH.
 */
function ownedMcp(server: Servers[string] | undefined, entry: string | undefined) {
  const command = server?.command
  if (!Array.isArray(command) || (command.length !== 2 && command.length !== 3) || command.at(-1) !== "mcp") return false
  const target = command.at(-2)
  return [entry, legacyShimPath(), path.join(packageRoot, "dist/cli.mjs")].some((e) => e && target === e)
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
  // An installed binary or npm package supervises its server and swaps it after an update, so its entry stays the same.
  // A checkout has no supervisor: its fingerprint changes the config, making the agent restart the server.
  const stable = !scriptEntry(entry) || !fromSource
  const server = mergedMcpServer(
    existing,
    [...entryCommand(entry, "node"), "mcp"],
    stable ? "auto-update" : fingerprint(entry),
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

/** MCP servers from the separate Browser Control product, which browse replaces. */
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
 * Installs this version where agents can keep running it: the executable in ~/.local/bin for a binary install, a global
 * npm package for an npm one, or the checkout's bundle from source. There is no private runtime or shim any more:
 * updates replace that same path, and the installer owns PATH and agent entries.
 */
export async function installRuntime(): Promise<{ entry: string; version: string; spawnEntry: string }> {
  if (compiledBinary()) {
    const runtime = await installBinaryRuntime()
    return { ...runtime, spawnEntry: runtime.entry }
  }
  // From a checkout, run the bundle `bun run build` wrote: Node can't run the TypeScript sources (they use
  // syntax type stripping doesn't cover), and the MCP server runs under Node.
  if (fromSource) {
    const bundle = path.join(packageRoot, "dist", "cli.mjs")
    if (!existsSync(bundle)) fail("Build the CLI first: `bun run build` in cli/ (or `bun run setup` at the top).")
    return { entry: bundle, version: opencodeBrowserVersion, spawnEntry: bundle }
  }
  const spec = process.env.OPENCODE_BROWSER_PACKAGE
  const globalRoot = await npmGlobalRoot()
  const at = (...parts: string[]) => (globalRoot ? path.join(globalRoot, ...parts) : undefined)
  const globalPackage = at("@opencode", "browse")
  const alreadyGlobal = !!(globalPackage && path.resolve(packageRoot) === path.resolve(globalPackage))
  if (!alreadyGlobal || spec) {
    // npx's cache is evictable, so an npm install becomes a global one: agents then run a stable path, and updates are
    // `npm install -g` (auto-update.ts). The channel matches this build.
    const target = spec ?? `${PACKAGE}@${opencodeBrowserVersion.includes("-dev.") ? "dev" : "latest"}`
    const installed = await runCommand("npm", ["install", "-g", target], { timeoutMs: 10 * 60_000 })
    if (installed.status !== 0)
      fail(`Could not install ${target} globally: ${(installed.stderr || installed.stdout).trim().split("\n").slice(-3).join(" ")}`)
  }
  const root = await npmGlobalRoot()
  if (!root) fail("Could not find npm's global package folder (`npm root -g`); is npm on PATH?")
  const entry = path.join(root, "@opencode", "browse", "dist", "cli.mjs")
  if (!existsSync(entry)) fail(`npm didn't install ${PACKAGE} in ${root}; run \`npm install -g ${PACKAGE}\` and try again.`)
  const version = readJson<{ version?: string }>(path.join(root, "@opencode", "browse", "package.json"))?.version ?? opencodeBrowserVersion
  // Agents run `browse` from PATH, not an absolute node and package path: nvm/fnm change node between sessions, and the
  // global npm bin folder is on PATH whenever npm is. The supervisor and npm keep it current. Setup-time self-spawns
  // use the bundle this install just wrote, since Windows can't start the PATH shim without a shell.
  return { entry: "browse", version, spawnEntry: entry }
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
  if (!entry || (entry !== "browse" && !settings?.version && !existsSync(entry))) return undefined
  // A bundle with the sources beside it is a checkout's build: cli/dist/cli.mjs next to cli/src/main.ts.
  const packageDir = path.dirname(path.dirname(entry))
  const source = scriptEntry(entry) && existsSync(path.join(packageDir, "src", "main.ts"))
  // The installed path reports its own version after an update, even when settings.json still has the old one.
  const windowsShim = process.platform === "win32" && (entry === "browse" || /\.(cmd|bat)$/i.test(entry))
  const onDisk = windowsShim
    ? (() => {
        // No running-entry fallback: report the installed CLI's version, not whatever process happens to ask.
        const resolved = resolveWindowsShim(entry)
        if (!resolved) return undefined
        return installedVersion({
          kind: resolved.length === 2 ? "npm" : "binary",
          entry: resolved[resolved.length - 1]!,
          version: settings?.version ?? opencodeBrowserVersion,
        })
      })()
    : entry === "browse"
      ? spawnSync("browse", ["--version"], { encoding: "utf8", timeout: 15_000 }).stdout?.trim() || undefined
      : existsSync(entry)
        ? installedVersion({ kind: scriptEntry(entry) ? "npm" : "binary", entry, version: settings?.version ?? opencodeBrowserVersion })
        : undefined
  const version = onDisk ?? settings?.version ?? (path.resolve(entry) === path.join(packageRoot, "dist", "cli.mjs")
    ? opencodeBrowserVersion
    : readJson<{ version?: string }>(path.join(packageDir, "package.json"))?.version)
  return { entry, version, source }
}

/**
 * For an agent install doesn't know: the browse MCP server as the stdio entry most agents' configs take. `command` runs
 * the CLI (entryCommand): `[node, entry]`, or a binary install's `[executable]`.
 */
export function manualMcpEntry(command: readonly string[]) {
  const [file, ...args] = command
  const server = JSON.stringify({ command: file, args: [...args, "mcp"] })
    .replace(/","args":/, '", "args": ')
    .replace(/^\{"command":/, '{ "command": ')
    .replace(/\}$/, " }")
  return `{\n  "mcpServers": {\n    "browse": ${server}\n  }\n}`
}
