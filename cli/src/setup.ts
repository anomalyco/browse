// Setup for Browse, without changing opencode itself:
//   install    install the runtime, add the browse MCP server to opencode's config, then check which browsers have the
//              extension. A stable npm install gets it from the Chrome Web Store item: when no browser has it, install
//              opens that item's page; when one has it, install opens its status page with a one-time pairing code in
//              the URL fragment so it pairs without a step. A checkout loads its own build (dist/) unpacked, and a dev
//              npm install the dev extension it downloads from the release service into <data root>/extension
//              (dev-extension.ts): install puts a one-time code in that folder, reloads a connected one that's out of
//              date, and guides loading it when no browser has it
//   extension  show the unpacked extension folder (for "Load unpacked"), or a stable npm install's store page
//   pair       print a one-time pairing code for a browser; --list shows paired browsers, --revoke unpairs one
//   set        set hostname: where the relay listens (relay-config.ts)
//   uninstall  remove everything install wrote
// Earlier versions registered a native messaging host and wrote an opencode plugin; install and uninstall
// remove those leftovers.
import { spawn, spawnSync } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir, networkInterfaces } from "node:os"
import path from "node:path"
import { createInterface } from "node:readline/promises"
import { fileURLToPath } from "node:url"
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser"
import { agentLabels, agentLocations, agentNames, callingAgent, editAgentConfig, type AgentName, type AgentReceipt } from "./agent-config.ts"
import { describeAutoUpdate, autoUpdateStatus, installVersion, pruneVersions, readCurrent, runtimeLayout, switchVersion, updateState, compareVersions, versionEntry } from "./auto-update.ts"
import {
  bundledPairingCodeTtlMs,
  formatPairingCode,
  legacyPairingCode,
  mintPairingCode,
  pairingCodeKey,
  pairingCodeTtlMs,
  pendingPairingCodeKeys,
  readBrowserPairings,
  removeLegacyPairingCode,
  revokeBrowserToken,
  writeExtensionPairing,
} from "./browser-pairing.ts"
import { syncDevExtension } from "./dev-extension.ts"
import { cliCommand, dataRoot, devExtension, devExtensionFolder, installCommand, oldStoreMarker, storeConfig, storeUrl } from "./paths.ts"
import { extensionProtocolAdvice } from "./protocol.ts"
import { parseHostname, readRelayConfig, writeRelayConfig } from "./relay-config.ts"
import { relayAuthorization } from "./relay-secrets.ts"
import { opencodeBrowserVersion } from "./version.ts"

/**
 * The Chrome Web Store item this package was released with (paths.ts storeConfig). Only this ID counts as the store
 * build: install hands a pairing code to the extension with this ID, so it must be ours.
 */
const store = storeConfig()
const STORE_IDS = [store.id].filter((id): id is string => !!id)
/** The unpacked build (a checkout's, or a dev install's); its ID is pinned by the manifest key. */
const UNPACKED_ID = "afeafocngkodbmaipcngoamamfmekgfo"
/** The store page; undefined for a package built without the store item (and a checkout). */
const STORE_URL = store.id ? storeUrl(store.id) : undefined
const PACKAGE = "@opencode/browse"
const MCP_NAME = "browse"
/** The MCP server's name before it was renamed to `browse`. */
const LEGACY_MCP_NAME = "opencode-browser"
const LEGACY_HOST_NAME = "ai.opencode.browser"
const LEGACY_REGISTRY_ROOTS = ["HKCU\\Software\\Google\\Chrome", "HKCU\\Software\\Microsoft\\Edge"]
const windows = process.platform === "win32"

const home = homedir()
const root = dataRoot()
const configRoot = process.env.XDG_CONFIG_HOME ?? path.join(home, ".config")
const layout = runtimeLayout(root)
const files = {
  dir: root,
  /** Installed versions of this package (auto-update.ts): the MCP server runs from here through the shim, not the npx cache. */
  runtime: path.join(root, "runtime"),
  settings: path.join(root, "settings.json"),
}
/**
 * Files the native messaging host of earlier versions left behind. Not session.json: it has only ever been at
 * <data root>/session.json, which is the current CLI's current-session store (session-store.ts), not a leftover.
 */
const legacyFiles = [
  path.join(root, "host"),
  path.join(root, "host.bat"),
  path.join(root, `${LEGACY_HOST_NAME}.json`),
  path.join(root, "state.json"),
  path.join(root, "logs", "host.log"),
  path.join(root, "cli.mjs"),
  path.join(configRoot, "opencode", "plugins", "opencode-browser.ts"),
]
/** This package's root: dist/cli.mjs when published, src/setup.ts from source. */
const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
/** Running from a source checkout without a package to install: the MCP server runs main.ts in place with bun. */
const fromSource = existsSync(path.join(packageRoot, "src", "main.ts")) && !process.env.OPENCODE_BROWSER_PACKAGE
/** From a checkout, the extension folder users load unpacked (dist/) and its source (public/, copied into dist/ by every build). */
const checkoutExtensionDirs = (() => {
  const repo = path.dirname(packageRoot)
  if (!fromSource || !existsSync(path.join(repo, "public", "manifest.json"))) return []
  return [path.join(repo, "public"), path.join(repo, "dist")]
})()

export type Settings = { opencode?: string; entry?: string; version?: string; agents?: AgentReceipt[]; declinedAgents?: AgentName[] }

export type Browser = {
  name: string
  /** The Chromium user data directory: `Local State` and one directory per profile. */
  userData: string
  /** Where earlier versions wrote the native messaging host manifest. */
  manifests: string[]
  /** How the OS names this browser as the default: bundle IDs, desktop files, or URL ProgIds. */
  defaultIDs: string[]
  /** macOS application name, for `/Applications/<app>.app` and `open -a`. */
  app?: string
  /** Linux: binary names on PATH. Windows: full executable paths. */
  executables: string[]
}

function browsers(): Browser[] {
  if (process.platform === "darwin") {
    const support = (dir: string) => path.join(home, "Library/Application Support", dir)
    const browser = (name: string, app: string, bundleID: string, dirs: string[]): Browser => ({
      name,
      app,
      userData: support(dirs[0]!),
      manifests: dirs.map((dir) => path.join(support(dir), "NativeMessagingHosts")),
      defaultIDs: [bundleID],
      executables: [],
    })
    return [
      browser("Google Chrome", "Google Chrome", "com.google.Chrome", ["Google/Chrome"]),
      browser("Chrome for Testing", "Google Chrome for Testing", "com.google.chrome.for.testing", ["Google/Chrome for Testing", "Google/ChromeForTesting"]),
      browser("Google Chrome Beta", "Google Chrome Beta", "com.google.Chrome.beta", ["Google/Chrome Beta"]),
      browser("Google Chrome Canary", "Google Chrome Canary", "com.google.Chrome.canary", ["Google/Chrome Canary"]),
      browser("Chromium", "Chromium", "org.chromium.Chromium", ["Chromium"]),
      browser("Microsoft Edge", "Microsoft Edge", "com.microsoft.edgemac", ["Microsoft Edge"]),
      browser("Brave", "Brave Browser", "com.brave.Browser", ["BraveSoftware/Brave-Browser"]),
      browser("Opera", "Opera", "com.operasoftware.Opera", ["com.operasoftware.Opera"]),
      browser("Vivaldi", "Vivaldi", "com.vivaldi.Vivaldi", ["Vivaldi"]),
      browser("Helium", "Helium", "net.imput.helium", ["net.imput.helium"]),
      browser("Arc", "Arc", "company.thebrowser.Browser", ["Arc/User Data"]),
      browser("Dia", "Dia", "company.thebrowser.dia", ["Dia/User Data"]),
      browser("Comet", "Comet", "ai.perplexity.comet", ["Comet"]),
    ]
  }
  if (windows) {
    const local = process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local")
    const roaming = process.env.APPDATA ?? path.join(home, "AppData", "Roaming")
    const programs = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], local].filter((dir): dir is string => !!dir)
    const installs = (relative: string) => programs.map((dir) => path.join(dir, relative))
    return [
      { name: "Google Chrome", userData: path.join(local, "Google", "Chrome", "User Data"), manifests: [], defaultIDs: ["ChromeHTML"], executables: installs("Google\\Chrome\\Application\\chrome.exe") },
      { name: "Microsoft Edge", userData: path.join(local, "Microsoft", "Edge", "User Data"), manifests: [], defaultIDs: ["MSEdgeHTM"], executables: installs("Microsoft\\Edge\\Application\\msedge.exe") },
      { name: "Brave", userData: path.join(local, "BraveSoftware", "Brave-Browser", "User Data"), manifests: [], defaultIDs: ["BraveHTML"], executables: installs("BraveSoftware\\Brave-Browser\\Application\\brave.exe") },
      { name: "Opera", userData: path.join(roaming, "Opera Software", "Opera Stable"), manifests: [], defaultIDs: ["OperaStable"], executables: installs("Programs\\Opera\\opera.exe") },
      { name: "Vivaldi", userData: path.join(local, "Vivaldi", "User Data"), manifests: [], defaultIDs: ["VivaldiHTM"], executables: installs("Vivaldi\\Application\\vivaldi.exe") },
    ]
  }
  // Chrome-family builds honor CHROME_CONFIG_HOME before XDG_CONFIG_HOME.
  const chrome = process.env.CHROME_CONFIG_HOME ?? configRoot
  const browser = (name: string, root: string, dir: string, executables: string[]): Browser => ({
    name,
    userData: path.join(root, dir),
    manifests: [path.join(root, dir, "NativeMessagingHosts")],
    defaultIDs: executables,
    executables,
  })
  return [
    browser("Google Chrome", chrome, "google-chrome", ["google-chrome", "google-chrome-stable"]),
    browser("Google Chrome Beta", chrome, "google-chrome-beta", ["google-chrome-beta"]),
    browser("Google Chrome Unstable", chrome, "google-chrome-unstable", ["google-chrome-unstable"]),
    browser("Chrome for Testing", chrome, "google-chrome-for-testing", ["google-chrome-for-testing"]),
    browser("Chromium", chrome, "chromium", ["chromium", "chromium-browser"]),
    browser("Microsoft Edge", configRoot, "microsoft-edge", ["microsoft-edge", "microsoft-edge-stable"]),
    browser("Brave", configRoot, "BraveSoftware/Brave-Browser", ["brave-browser", "brave"]),
    browser("Opera", configRoot, "opera", ["opera"]),
    browser("Vivaldi", configRoot, "vivaldi", ["vivaldi", "vivaldi-stable"]),
    browser("Helium", configRoot, "net.imput.helium", ["helium", "helium-browser"]),
  ]
}

/** The opencode binary (recorded for status): --opencode, $OPENCODE_BIN, or `opencode` on PATH. */
function findOpencode(args: string[]) {
  const explicit = flag(args, "--opencode") ?? process.env.OPENCODE_BIN
  if (explicit) return path.resolve(explicit)
  return findOnPath("opencode")
}

function flag(args: string[], name: string) {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T
  } catch {
    return undefined
  }
}

// ---- opencode config: the browse MCP server ---------------------------------------------------------

function configFile() {
  const directory = path.join(configRoot, "opencode")
  const candidates = ["opencode.json", "opencode.jsonc", ".opencode/opencode.json", ".opencode/opencode.jsonc"].map(
    (name) => path.join(directory, name),
  )
  return candidates.find((file) => existsSync(file) && statSync(file).isFile()) ?? candidates[0]!
}

export type Servers = Record<string, { type?: unknown; command?: unknown; environment?: unknown; [key: string]: unknown }>

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
function restartOutdatedRelay(entry: string, node: string): string[] | undefined {
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
      return (parsed.sessions ?? []).filter((item) => item.connected === true && typeof item.id === "string").map((item) => item.id as string)
    } catch {
      return []
    }
  })()
  // The relay's reason, without the restart command's own preamble.
  const reason = output.split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("Restarting the relay leaves")).join(" ")
  const who = sessions.length === 1
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

function mcpServers() {
  const file = configFile()
  const errors: ParseError[] = []
  const config = parse(existsSync(file) ? readFileSync(file, "utf8") : "{}", errors, { allowTrailingComma: true })
  if (errors.length || [config, config?.mcp, config?.mcp?.servers].some(v => v !== undefined && (!v || typeof v !== "object" || Array.isArray(v)))) fail(`Invalid ${file}; left unchanged`)
  return (config as { mcp?: { servers?: Servers } }).mcp?.servers ?? {}
}

function ownedMcp(server: Servers[string] | undefined, entry: string | undefined) {
  const command = server?.command
  return Array.isArray(command) && command.length === 3 && command[2] === "mcp" && [entry, layout.shim, path.join(packageRoot, "dist/cli.mjs")].some(e => e && command[1] === e)
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
function configureMcp(entry: string, previousEntry?: string) {
  const file = configFile()
  // A running MCP server keeps its old code after an update, and its relay calls then fail on the build check.
  // Stamping the runtime's fingerprint into the entry changes the config whenever the runtime changes, which
  // makes opencode restart the server with the new code.
  const existing = mcpServers()[MCP_NAME]
  if (existing && !ownedMcp(existing, previousEntry)) return undefined
  const renamed = removeMcp(LEGACY_MCP_NAME, previousEntry)
  // The shim of an npm install never changes and swaps the server itself after an update, so its entry stays the same.
  const server = mergedMcpServer(existing, [process.execPath, entry, "mcp"], entry === layout.shim ? "auto-update" : fingerprint(entry))
  if (existing && JSON.stringify(existing) === JSON.stringify(server)) return `"${MCP_NAME}" is up to date`
  const text = readFileOr(file, "{}")
  const edits = modify(text, ["mcp", "servers", MCP_NAME], server, { formattingOptions: { tabSize: 2, insertSpaces: true } })
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, applyEdits(text, edits))
  if (renamed) return `"${LEGACY_MCP_NAME}" renamed to "${MCP_NAME}" in ${file}`
  return existing ? `"${MCP_NAME}" updated in ${file}` : `"${MCP_NAME}" added to ${file}`
}

function removeMcp(name: string, entry?: string) {
  const file = configFile()
  const text = readFileOr(file, "")
  if (!text || !ownedMcp(mcpServers()[name], entry)) return false
  writeFileSync(file, applyEdits(text, modify(text, ["mcp", "servers", name], undefined, {})))
  return true
}

/** MCP servers from the separate Browser Control product, which Browse replaces. */
function legacyBrowserControl() {
  return Object.entries(mcpServers())
    .filter(([name, server]) => name === "browser-control" || JSON.stringify(server.command ?? "").includes("browser-control"))
    .map(([name]) => name)
}

function readFileOr(file: string, fallback: string) {
  try {
    return readFileSync(file, "utf8")
  } catch {
    return fallback
  }
}

/** Removes the native messaging host and opencode plugin of earlier versions; true when any was there. */
function removeLegacyHost() {
  const leftovers = [
    ...browsers().flatMap((browser) => browser.manifests.map((directory) => path.join(directory, `${LEGACY_HOST_NAME}.json`))),
    ...legacyFiles,
  ].filter((file) => existsSync(file))
  leftovers.forEach((file) => rmSync(file, { force: true }))
  const keys = windows
    ? LEGACY_REGISTRY_ROOTS.map((root) => `${root}\\NativeMessagingHosts\\${LEGACY_HOST_NAME}`).filter(
        (key) => spawnSync("reg", ["query", key, "/ve"]).status === 0,
      )
    : []
  keys.forEach((key) => spawnSync("reg", ["delete", key, "/f"]))
  return leftovers.length + keys.length > 0
}

// ---- runtime ----------------------------------------------------------------------------------------

/**
 * Installs this exact version into the data root (runtime/versions/<version>, auto-update.ts), points runtime/current.json
 * at it and writes the stable shim, so the MCP server keeps working after the npx cache is cleared and later updates
 * never change opencode's config. Returns the shim and the version. From source (development), runs in place.
 * OPENCODE_BROWSER_PACKAGE installs a specific spec instead, for example a local tarball.
 */
async function installRuntime(): Promise<{ entry: string; version: string }> {
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
  const reuse = !spec && existsSync(existing) && readFileSync(existing).equals(readFileSync(path.join(packageRoot, "dist", "cli.mjs"))) && spawnSync(process.execPath, [existing, "--version"], { encoding: "utf8", timeout: 30_000 }).stdout?.trim() === opencodeBrowserVersion
  let installed: string
  try {
    installed = reuse ? existing : await installVersion({ layout, version: opencodeBrowserVersion, ...(spec ? { spec } : { runningPackage: packageRoot }) })
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
  for (const legacy of ["node_modules", "package.json", "package-lock.json"]) rmSync(path.join(files.runtime, legacy), { recursive: true, force: true })
  return { entry: layout.shim, version }
}

// ---- commands -------------------------------------------------------------------------------------

/** The MCP server and relay run under the Node.js that runs install, so it must be one the package supports. */
function checkNode() {
  // `bun run` stands in a bun shim for a missing node.
  if (process.versions.bun)
    fail("Browse runs on Node.js 22.19 or newer, but this ran under Bun (`bun run` uses Bun when `node` isn't on PATH). Install Node.js from https://nodejs.org, then run setup again.")
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number)
  if (major < 22 || (major === 22 && minor < 19))
    fail(`Browse needs Node.js 22.19 or newer; this is ${process.version} (${process.execPath}). Update Node.js (https://nodejs.org), then run setup again.`)
}

/** The dev extension a dev npm install downloads (paths.ts devExtension); undefined for a checkout or a stable release. */
const dev = fromSource ? undefined : devExtension()

/** The folder to load unpacked: a checkout's dist/, which `bun run setup` builds, or a dev install's <data root>/extension. */
const unpackedFolder = (): string | undefined => checkoutExtensionDirs[1] ?? (dev ? devExtensionFolder(root) : undefined)

/** Puts this version's dev extension in <data root>/extension (paired); fails install when it can't be downloaded. */
async function syncDev() {
  if (!dev) return
  try {
    const result = await syncDevExtension(dev, { root })
    log(result === "updated" ? `✓ Downloaded the dev extension (${dev.file}) to ${devExtensionFolder(root)}` : `✓ Dev extension ${dev.file} is in ${devExtensionFolder(root)}`)
  } catch (error) {
    fail(`Could not get the dev extension: ${(error as Error).message}`)
  }
}

async function install(args: string[]) {
  checkNode()
  const tty = !!(process.stdin.isTTY && process.stdout.isTTY)
  const timeoutMs = installWaitTimeout(args, tty)
  const requested = args.flatMap((arg, i) => arg === "--agent" ? [args[i + 1] ?? ""] : [])
  for (const name of requested) if (!["opencode", ...agentNames].includes(name)) fail(`Unknown agent ${JSON.stringify(name)}. Choose opencode, ${agentNames.join(", ")}.`)
  const opencode = findOpencode(args)
  const caller = !requested.length ? callingAgent(process.env) : undefined
  const allAgents = args.includes("--all-agents") || args.includes("--yes")

  mkdirSync(files.dir, { recursive: true })
  const { entry, version } = await installRuntime()
  log(`✓ Browse ${version} installed${fromSource ? " (from source)" : ""}`)
  const previous = readJson<Settings>(files.settings)
  const agents = previous?.agents ?? []
  const declined = new Set(previous?.declinedAgents ?? [])
  const save = () => writeFileSync(files.settings, JSON.stringify({ ...(opencode ? { opencode } : {}), entry, version, agents, declinedAgents: [...declined] } satisfies Settings, null, 2) + "\n")
  save()
  if (removeLegacyHost()) log("✓ Removed the native messaging host of an earlier version")

  const node = process.execPath
  const addOpencode = (opencode && ((!requested.length && !caller) || allAgents || args.includes("--opencode"))) || requested.includes("opencode")
  if (addOpencode) {
    const mcp = configureMcp(entry, previous?.entry)
    log(mcp ? `✓ MCP server ${mcp} (opencode)` : `! opencode already has a different server named browse in ${configFile()}; left unchanged.`)
  } else if (opencode && caller) log(`To add opencode: ${cliCommand("install --agent opencode")}`)
  for (const agent of agentLocations(home, configRoot, findOnPath)) {
    const explicit = requested.includes(agent.name) || agent.name === caller
    if (!explicit && (!agent.installed || (requested.length && !args.includes("--all-agents")))) continue
    let consent = explicit || allAgents
    const label = agentLabels[agent.name]
    if (!consent && !caller && tty && !declined.has(agent.name)) {
      const prompt = createInterface({ input: process.stdin, output: process.stdout })
      consent = /^y(es)?$/i.test((await prompt.question(`Add Browse to ${label}? [y/N] `).finally(() => prompt.close())).trim())
      if (!consent) { declined.add(agent.name); save() }
    }
    if (!consent) { log(`To add ${label}: ${cliCommand(`install --agent ${agent.name}`)}`); continue }
    const receipt = { name: agent.name, file: agent.file, entry, node }
    try {
      const result = editAgentConfig(receipt)
      if (result === "added") {
        const i = agents.findIndex(a => a.file === agent.file)
        if (i !== -1) agents.splice(i, 1)
        agents.push(receipt)
      }
      if (result !== "conflict" && (declined.delete(agent.name) || result === "added")) save()
      if (result === "conflict") process.exitCode = 1
      log(result === "conflict" ? `! ${agent.name} already has a different browse server; left ${agent.file} unchanged.` : `✓ ${agent.name}: browse ${result} in ${agent.file}`)
    } catch {
      process.exitCode = 1
      log(`! Couldn't edit ${agent.file} for ${agent.name}. Check its syntax and permissions, then run ${cliCommand(`install --agent ${agent.name}`)}.`)
    }
  }
  for (const line of restartOutdatedRelay(entry, node) ?? []) log(line)
  const legacy = addOpencode ? legacyBrowserControl() : []
  if (legacy.length)
    log(`! Browser Control MCP server${legacy.length === 1 ? "" : "s"} ${legacy.map((name) => `"${name}"`).join(", ")} also configured. Browse replaces it; remove ${legacy.length === 1 ? "it" : "them"} from ${configFile()} to avoid two sets of browser tools.`)

  await syncDev()
  const initial = await settledExtensionStatus(entry)
  const connected = initial?.connected ? initial : undefined
  const pairedOffline = initial?.pairingState === "paired-offline"
  const folder = unpackedFolder()
  if (folder && !pairedOffline) {
    // The unpacked extension finds a one-time code in its own folder and exchanges it for its key, without a step.
    pairUnpacked()
    log("✓ Put a one-time pairing code in the unpacked extension (good for an hour)")
    // A browser already running an older unpacked build keeps its old code until it reloads; ask it to.
    const reload = connected ? await reloadOutdatedExtension(connected, folder) : "current"
    if (reload === "reloaded") log("✓ Reloaded Browse in your browser")
    if (reload === "stale")
      log("! Browse didn't reload in your browser. Reload it on the browser's extensions page to finish the update.")
  }
  log("")
  // Over SSH the browsers here aren't the ones the user looks at, so they aren't scanned.
  const ssh = !!(process.env.SSH_CONNECTION || process.env.SSH_TTY)
  const detections = ssh ? [] : detectBrowsers()
  rmSync(oldStoreMarker(), { force: true })
  const checkStore = (scanned: Detection[]) => {
    const matches = scanned.flatMap(d => d.enabled).filter(m => STORE_IDS.includes(m.id))
    if (!matches.length || !matches.every(oldStoreBuild)) return true
    writeFileSync(oldStoreMarker(), "2\n")
    ensureRelay(entry)
    log(`! Found Browse ${matches[0]!.version} in ${matches[0]!.browser.name}. ${extensionProtocolAdvice(2, { install: cliCommand("install") })}`)
    process.exitCode = 1
    return false
  }
  if (!connected && !checkStore(detections)) return
  const env = {
    ssh,
    display: process.platform !== "linux" || !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY),
    tty,
    platform: process.platform,
  }
  const found = locateExtension({
    allowOpen: !args.includes("--no-open"),
    connected: !!connected,
    pairedOffline,
    ...(folder ? { folder } : {}),
    detections,
    preferred: ssh ? undefined : defaultBrowser(detections.map((detection) => detection.browser)),
    env,
  })
  if (connected || found === "off" || pairedOffline || (!folder && !STORE_URL)) return
  ensureRelay(entry)
  let code: string | undefined
  const pairingCode = () => code && pendingPairingCodeKeys().includes(pairingCodeKey(code)) ? code : (code = mintPairingCode())
  const pairStore = (scanned: Detection[]) => pairStoreExtension({ detections: scanned, preferred: defaultBrowser(scanned.map(d => d.browser)), allowOpen: !args.includes("--no-open"), env, code: pairingCode })
  let offer = ssh ? "none" : pairStore(detections)
  const blocked = detections.filter(d => d.blocked).map(d => d.browser.name)
  if (offer === "none" && blocked.length) log(`Couldn't check ${blocked.join(", ")}. If Browse is already installed there, pair it manually. ${manualPair(pairingCode())}`)
  const next = `If Browse isn't connected after you add it, run \`${cliCommand("install")}\` again to pair it.`
  const agentNext = () => `Agent: ${offer === "opened" ? "ask the user to open Browse's status page in their browser" : offer === "manual" || blocked.length ? "ask the user to finish pairing in Browse's Options" : folder ? "ask the user to load Browse in their browser" : "ask the user to add Browse in their browser"}. Then re-run \`${cliCommand("install")}\` to finish, or call the browse status tool to check the connection.`
  if (!env.tty) log(agentNext())
  if (args.includes("--no-wait") || ssh || !env.display) { if (env.tty) log(next); return }
  log(`Waiting for Browse to connect (up to ${timeoutMs / 1000}s; Ctrl+C to skip)…`)
  let stopped = false
  const stop = () => { stopped = true }
  process.once("SIGINT", stop)
  try {
    const deadline = Date.now() + timeoutMs
    do {
      const status = await extensionStatus(!args.includes("--no-open") && (offer === "opened" || (offer === "none" && !blocked.length)))
      if (status?.protocolCompatible === false) return fail(extensionProtocolAdvice(status.protocolVersion, { install: installCommand() }))
      if (status?.connected) return log(connectedMessage)
      if (status?.pairingState === "paired-offline") return log(pairedOfflineMessage)
      if (!folder && offer === "none") {
        const scan = detectBrowsers()
        if (!checkStore(scan)) return
        if (scan.some(d => d.enabled.length)) offer = pairStore(scan)
      }
      await new Promise(resolve => setTimeout(resolve, Math.max(0, Math.min(1000, deadline - Date.now()))))
    } while (!stopped && Date.now() < deadline)
    if (!env.tty) return log(`! Not connected yet. ${agentNext()}`)
    log(`! Not connected yet. ${code ? manualPair(pairingCode()) : next}`)
    process.exitCode = 1
  } finally { process.off("SIGINT", stop) }
}

const connectedMessage = "✓ Connected. Restart your agent, then ask it to open a page."
const pairedOfflineMessage = "! Not connected yet. Open the browser profile already paired with Browse and make sure the extension is enabled. It reconnects automatically."
const manualPair = (code: string) => `Open the Extensions menu → Browse → Options, enter ${formatPairingCode(code)} as the pairing code, then click Pair.`
export const installWaitTimeout = (args: string[], tty: boolean) => waitTimeout(args, tty ? 180 : 90)
function waitTimeout(args: string[], defaultSeconds = 180) {
  const seconds = Number(args.includes("--wait-seconds") ? flag(args, "--wait-seconds") : defaultSeconds)
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 3600) fail("--wait-seconds must be between 1 and 3600.")
  return seconds * 1000
}
function ensureRelay(entry: string) {
  const started = spawnSync(process.execPath, [entry, "session", "list", "--json"], { encoding: "utf8", timeout: 30_000 })
  if (started.status !== 0) fail(`Couldn't start the Browse relay: ${started.stderr?.trim() || started.error?.message || `run ${cliCommand("doctor")}`}`)
}

/**
 * What install set up: the runtime the browse MCP server runs and its version. Read from settings.json, else from
 * the MCP server entry itself (a checkout install from an earlier version wrote no version there).
 */
export function installedRuntime(settings: Settings | undefined, server: Servers[string] | undefined) {
  const command = Array.isArray(server?.command) ? server.command.filter((part): part is string => typeof part === "string") : []
  const entry = settings?.entry ?? command.find((part) => /cli\.m?js$/.test(part))
  if (!entry || (!settings?.version && !existsSync(entry))) return undefined
  // A bundle with the sources beside it is a checkout's build: cli/dist/cli.mjs next to cli/src/main.ts.
  const packageDir = path.dirname(path.dirname(entry))
  const source = existsSync(path.join(packageDir, "src", "main.ts"))
  // The shim runs whatever runtime/current.json names, which auto-update moves.
  const version =
    (entry === layout.shim ? readCurrent(layout)?.version : undefined) ??
    settings?.version ??
    (path.resolve(entry) === path.join(packageRoot, "dist", "cli.mjs") ? opencodeBrowserVersion : readJson<{ version?: string }>(path.join(packageDir, "package.json"))?.version)
  return { entry, version, source }
}

/** Printed before the relay's status by `opencode-browser status`. */
export function printSetupStatus() {
  const settings = readJson<Settings>(files.settings)
  const runtime = installedRuntime(settings, mcpServers()[MCP_NAME])
  log(runtime ? `Setup:     installed${runtime.source ? " (from source)" : ""}` : `Setup:     not installed. Run \`${installCommand()}\`.`)
  log(`Version:   ${runtime ? `${runtime.version ?? "unknown"} (${runtime.entry})` : "not installed"}`)
  log(`opencode:  ${settings?.opencode ?? findOpencode([]) ?? "not found"}`)
  log(mcpServers()[MCP_NAME] ? `MCP:       "${MCP_NAME}" configured` : "MCP:       not configured")
  log(describeAutoUpdate(autoUpdateStatus({ layout })))
  log(`Logs:      ${path.join(files.dir, "logs")}`)
  log("")
}

async function extension() {
  const folder = unpackedFolder()
  if (!folder) {
    if (!STORE_URL) fail("This package doesn't know its Chrome Web Store item. Install a released version (`npx @opencode/browse install`), or set up Browse from a checkout.")
    log(`Install Browse from the Chrome Web Store: ${STORE_URL}`)
    log(`Then run \`${cliCommand("install")}\` again to pair it.`)
    return
  }
  await syncDev()
  if (!existsSync(path.join(folder, "manifest.json"))) fail(`${folder} has no built extension. Run \`${installCommand()}\` first.`)
  pairUnpacked()
  revealFolder(folder)
  log(`Load unpacked from: ${folder}`)
}

/**
 * Writes a fresh one-time code into every unpacked extension folder this install manages (a checkout's, or a dev
 * install's). It's good for an hour and only until an extension used it, so the folder holds nothing reusable; an
 * extension that already has its key ignores it.
 */
function pairUnpacked() {
  const directories = [...checkoutExtensionDirs, ...(dev ? [devExtensionFolder(root)] : [])].filter((directory) => existsSync(path.join(directory, "manifest.json")))
  if (directories.length === 0) return
  const code = mintPairingCode(undefined, { ttlMs: bundledPairingCodeTtlMs })
  for (const directory of directories) writeExtensionPairing(directory, code)
}

/** `pair`: a new one-time code. `pair --list`: the paired browsers. `pair --revoke <browser>`: unpair one. */
async function pair(args: string[]) {
  mkdirSync(files.dir, { recursive: true })
  if (args[0] === "--list") return listPairings()
  if (args[0] === "--revoke") return revokePairing(args[1])
  if (args.length && !(args.length === 2 && args[0] === "--wait-seconds")) {
    log(`Usage: ${cliCommand("pair")} [--wait-seconds <seconds> | --list | --revoke <browser>]`)
    process.exitCode = 1
    return
  }
  const timeoutMs = Math.min(waitTimeout(args), pairingCodeTtlMs)
  ensureRelay(readJson<Settings>(files.settings)?.entry ?? process.argv[1]!)
  const receipt = randomUUID()
  const code = mintPairingCode(undefined, { receipt })
  log(`Pairing code: ${formatPairingCode(code)}`)
  log(`${manualPair(code)} It works once, within ${pairingCodeTtlMs / 60_000} minutes.`)
  log(`Waiting up to ${timeoutMs / 1000}s for that browser. Later, \`${cliCommand("pair --list")}\` shows paired browsers.`)
  let paired: string | undefined
  await waitForExtension({ timeoutMs, intervalMs: 500, connected: async () => {
    const match = Object.values(readBrowserPairings()).find(browser => browser.receipt === receipt && browser.lastSeen !== undefined)
    paired = match?.name ?? match?.id
    return paired !== undefined
  } })
  if (paired) return log(`✓ Paired ${paired}.`)
  log(`! Pairing not confirmed. For a fresh code run \`${cliCommand("pair")}\`.`)
  process.exitCode = 1
}

/** Paired browsers, with what the relay calls them (browsers.json, browser-links.ts) when it knows. */
function pairedBrowsers() {
  const known = readJson<Record<string, { id?: string; name?: string }>>(path.join(files.dir, "browsers.json")) ?? {}
  return Object.entries(readBrowserPairings()).map(([key, entry]) => ({
    key,
    id: known[key]?.id ?? entry.id,
    name: known[key]?.name ?? entry.name,
    pairedAt: entry.pairedAt,
    lastSeen: entry.lastSeen,
  }))
}

function listPairings() {
  const browsers = pairedBrowsers()
  const date = (time: number | undefined) => (time === undefined ? "never" : new Date(time).toLocaleString())
  if (browsers.length === 0) log(`No paired browsers. Run \`${cliCommand("pair")}\` for a code.`)
  for (const browser of browsers) {
    log(`${browser.id ?? "(not connected yet)"}${browser.name ? `  ${browser.name}` : ""}`)
    log(`  profile    ${browser.key}`)
    log(`  paired     ${date(browser.pairedAt)}`)
    log(`  last seen  ${date(browser.lastSeen)}`)
  }
  if (legacyPairingCode() !== undefined) {
    log("")
    log("The shared pairing code of an earlier version is still accepted: browsers that still use it get their own key the")
    log(`next time they connect. Once they all show up above, \`${cliCommand("pair --revoke legacy")}\` retires it.`)
  }
}

async function revokePairing(target: string | undefined) {
  if (!target) {
    log(`Usage: ${cliCommand("pair --revoke <browser id, name or profile>")}  (see \`${cliCommand("pair --list")}\`)`)
    process.exitCode = 1
    return
  }
  if (target === "legacy") {
    log(removeLegacyPairingCode() ? "✓ The old shared pairing code is no longer accepted" : "The old shared pairing code was already gone.")
    return
  }
  const wanted = target.trim().toLowerCase()
  const browser = pairedBrowsers().find((entry) => entry.key === target || entry.id === wanted || entry.name?.toLowerCase() === wanted)
  if (!browser || !revokeBrowserToken(browser.key)) {
    log(`No paired browser "${target}". \`${cliCommand("pair --list")}\` shows them.`)
    process.exitCode = 1
    return
  }
  // A running relay drops its connection now; any later connection fails pairing anyway.
  const dropped = await fetch(`${relayBase()}/extension/revoke`, {
    method: "POST",
    body: JSON.stringify({ key: browser.key }),
    headers: { "content-type": "application/json", ...relayHeaders() },
    signal: AbortSignal.timeout(3_000),
  }).then(
    async (response) => (response.ok ? ((await response.json()) as { dropped?: boolean }).dropped === true : false),
    () => false,
  )
  log(`✓ Unpaired ${browser.id ?? browser.key}${dropped ? " and disconnected it" : ""}. To use it again, pair it with a new code.`)
}

/** `set hostname <127.0.0.1|0.0.0.0>`: saves where the relay listens and restarts a running relay to apply it. */
async function set(args: string[]) {
  const [key, value] = args
  const hostname = parseHostname(value)
  if (key !== "hostname" || hostname === undefined) {
    log(`Usage: ${cliCommand("set hostname <127.0.0.1|0.0.0.0>")}`)
    log("  127.0.0.1  only browsers on this computer can connect (the default)")
    log("  0.0.0.0    browsers on other computers can connect too, after pairing")
    process.exitCode = 1
    return
  }
  writeRelayConfig({ ...readRelayConfig(), hostname })
  log(`✓ hostname is ${hostname}`)
  const running = await fetch(`${relayBase()}/version`, { signal: AbortSignal.timeout(2000) }).then((response) => response.ok, () => false)
  if (running) {
    const restarted = spawnSync(process.execPath, [process.argv[1]!, "relay", "restart"], { stdio: "inherit" })
    if (restarted.status !== 0) log(`! The relay is still running with the old hostname. Run \`${cliCommand("relay restart --force")}\` to apply it.`)
  }
  if (hostname === "127.0.0.1") return
  const tailscale = Object.values(networkInterfaces()).flat().find((address) => address?.family === "IPv4" && /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(address.address))?.address
  log("")
  log("In the browser on the other computer, open Browse's options (right-click its toolbar button, then Options),")
  log("and under Connection enter:")
  log(`  Relay         ${tailscale ?? "this computer's address"}`)
  log(`  Pairing code  ${formatPairingCode(mintPairingCode())}  (works once, within ${pairingCodeTtlMs / 60_000} minutes; \`${cliCommand("pair")}\` prints another)`)
  log("The connection isn't encrypted by Browse: use it over Tailscale or a LAN you trust, not the open internet.")
}

/** Stored secret profiles are the one thing uninstall deletes that can't be recaptured without the user. */
async function confirmSecretRemoval(args: string[]) {
  const secrets = path.join(files.dir, "secrets")
  const profiles = existsSync(secrets) ? readdirSync(secrets).filter((name) => name.endsWith(".json")) : []
  if (profiles.length === 0 || args.includes("--yes") || args.includes("-y")) return
  const notice = `Uninstalling deletes ${profiles.length} stored secret profile${profiles.length === 1 ? "" : "s"} in ${secrets}.`
  if (!process.stdin.isTTY) fail(`${notice} Re-run with --yes to confirm.`)
  const prompt = createInterface({ input: process.stdin, output: process.stdout })
  const answer = await prompt.question(`${notice} Continue? [y/N] `).finally(() => prompt.close())
  if (!/^y(es)?$/i.test(answer.trim())) fail("Uninstall cancelled; nothing was removed.")
}

async function uninstall(args: string[]) {
  await confirmSecretRemoval(args)
  const host = removeLegacyHost()
  const settings = readJson<Settings>(files.settings)
  const mcp = [MCP_NAME, LEGACY_MCP_NAME].filter((name) => removeMcp(name, settings?.entry))
  for (const receipt of settings?.agents ?? []) {
    try {
      const result = editAgentConfig(receipt, true)
      log(result === "conflict" ? `! ${receipt.file} has a changed browse server; left unchanged.` : `✓ ${receipt.name}: ${result}`)
    } catch { fail(`Couldn't safely remove Browse from ${receipt.file}. Check its syntax and permissions, then re-run uninstall.`) }
  }
  rmSync(files.dir, { recursive: true, force: true })
  log(`✓ Removed ${files.dir}`)
  if (host) log("✓ Removed the native messaging host of an earlier version")
  if (mcp.length) log(`✓ Removed the ${mcp.map((name) => `"${name}"`).join(" and ")} MCP server${mcp.length === 1 ? "" : "s"}`)
  log("Remove the extension from your browser to finish.")
}

type ExtensionStatus = { connected?: boolean; pairingState?: string; build?: string | null; origin?: string | null; protocolCompatible?: boolean | null; protocolVersion?: number | null }

const relayBase = () => `http://127.0.0.1:${Number(process.env.OPENCODE_BROWSER_PORT) || 19988}`

/** The relay token header; the relay rejects every API request without it. */
const relayHeaders = (): Record<string, string> => {
  try {
    return { authorization: relayAuthorization() }
  } catch {
    return {}
  }
}

const extensionStatus = (installWaiting = false) =>
  fetch(`${relayBase()}/extension/status`, { headers: { ...relayHeaders(), ...(installWaiting ? { "x-browse-install": "waiting" } : {}) }, signal: AbortSignal.timeout(3_000) })
    .then((response) => (response.ok ? (response.json() as Promise<ExtensionStatus>) : undefined))
    .catch(() => undefined)

/** The extension connected to the relay, if any; a relay restarted moments ago waits a second or two for it. */
async function settledExtensionStatus(entry: string) {
  let status = await extensionStatus()
  if (!status && Object.keys(readBrowserPairings()).length) {
    ensureRelay(entry)
    status = await extensionStatus()
  }
  for (let attempt = 0; status?.connected === false && attempt < 10; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    status = await extensionStatus()
  }
  return status
}

/**
 * Reloads the connected extension when it's the checkout's unpacked build (the store updates its own) and older than
 * the folder's build, then checks the reload took effect: the build it reports after reconnecting must be the new one.
 */
async function reloadOutdatedExtension(before: ExtensionStatus, folder: string): Promise<"reloaded" | "stale" | "current"> {
  if (before.origin !== `chrome-extension://${UNPACKED_ID}`) return "current"
  const bundled = readJson<{ build?: string }>(path.join(folder, "build.json"))?.build
  if (bundled && before.build === bundled) return "current"
  const sent = await fetch(`${relayBase()}/extension/reload`, {
    method: "POST",
    body: "{}",
    headers: { "content-type": "application/json", ...relayHeaders() },
    signal: AbortSignal.timeout(5_000),
  }).then(
    (response) => response.ok,
    () => false,
  )
  if (!sent) return "stale"
  for (let attempt = 0; attempt < 20; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    const after = await extensionStatus()
    if (after?.connected && after.build !== before.build) return "reloaded"
  }
  return "stale"
}

function findOnPath(name: string) {
  const found = spawnSync(windows ? "where" : "which", [name], { encoding: "utf8" })
  return found.status === 0 ? found.stdout.split(/\r?\n/)[0]?.trim() || undefined : undefined
}

// ---- which browsers have the extension -------------------------------------------------------------

export type Profile = { dir: string; name: string }
export type Match = { browser: Browser; profile: Profile; id: string; version?: string }
const oldStoreBuild = (match: Match) => /^0\.0\.[012]$/.test(match.version ?? "")
/** blocked: the OS refused to read the browser's data (macOS privacy protection), so it may have the extension. */
export type Detection = { browser: Browser; blocked: boolean; enabled: Match[]; disabled: Match[] }

/** What locateExtension may do outside the terminal; stubbed in tests so they never open a real browser. */
export type Effects = {
  /** Opens a URL in a specific browser (and profile directory); false when it couldn't be handed to one. */
  open(browser: Browser, url: string, profile?: string): boolean
  openDefault?(url: string): boolean
  /** Shows the folder in the file manager, selected where the OS can, so it can be dragged. */
  reveal(folder: string): boolean
  /** Puts text on the clipboard; false when there is no clipboard tool. */
  copy(text: string): boolean
  log(line: string): void
}

export type LocateOptions = {
  allowOpen: boolean
  connected: boolean
  pairedOffline?: boolean
  /** The folder to load unpacked (a checkout's dist/, or a dev install's). Without one, the extension comes from the store item. */
  folder?: string
  detections: Detection[]
  preferred: Browser | undefined
  env: { ssh: boolean; display: boolean; tty: boolean; platform: NodeJS.Platform }
  /** The store page to open; defaults to this channel's store item. */
  storeUrl?: string
}

/**
 * Reports the browsers and profiles that have Browse. When none does (and none is connected to the relay),
 * guides installing it: from a checkout or a dev install, loading the unpacked build, with the browser's extensions page
 * opened, the folder revealed and its path copied; from a stable npm install, the Chrome Web Store item, whose page it opens.
 * Nothing opens when the browsers here aren't the ones the user looks at (SSH, no display),
 * with --no-open, or when a browser couldn't be checked and may already have it.
 * Returns "ready" when the extension is there, "off" when it's turned off, else "guided".
 */
export function locateExtension(options: LocateOptions, effects: Effects = systemEffects): "ready" | "off" | "guided" {
  const { log } = effects
  const listing = options.storeUrl ?? STORE_URL
  const noListing = () =>
    log(`! This package doesn't know its Chrome Web Store item, so it can't install the extension. Install a released version (\`npx @opencode/browse install\`), or set up Browse from a checkout.`)
  const pairLater = () => log(`  Once it's added, run \`${cliCommand("install")}\` again to pair it with the relay.`)
  if (options.pairedOffline) return log(pairedOfflineMessage), "ready"
  if (options.env.ssh) {
    if (options.connected) return log(connectedMessage), "ready"
    if (options.folder) unpackedSteps({ folder: options.folder, platform: options.env.platform, log })
    else if (listing) log(`Install Browse in your browser from the Chrome Web Store: ${listing}`), pairLater()
    else noListing()
    return "guided"
  }
  reportDetections(options.detections, options.preferred, log)
  // A connected extension is installed, even somewhere the scan doesn't look (a custom profile directory, a snap).
  if (options.connected) return log(connectedMessage), "ready"
  if (options.detections.some((detection) => detection.enabled.length)) return "ready"
  const off = options.detections.flatMap((detection) => detection.disabled)
  if (off.length) {
    log(`! Browse is turned off in ${off.map((match) => `${match.browser.name} (${match.profile.name})`).join(", ")}. Turn it on in the browser's extensions page.`)
    return "off"
  }
  const blocked = options.detections.filter((detection) => detection.blocked).map((detection) => detection.browser.name)
  const target = options.preferred ?? options.detections.find((detection) => !detection.blocked)?.browser
  const interactive = options.allowOpen && options.env.display
  if (!options.folder) {
    if (!listing) return noListing(), "guided"
    const opened = interactive && !blocked.length && (target ? effects.open(target, listing) : effects.openDefault?.(listing))
    log(`Install Browse from the Chrome Web Store${opened ? ` (opened in ${target?.name ?? "your default browser"})` : ""}:`)
    log(`  ${listing}`)
    log(`  Once it's added, install pairs it with the relay (if install isn't waiting for it, run \`${cliCommand("install")}\` again).`)
    return "guided"
  }
  // A browser that couldn't be checked may already have it: show the steps, but don't open anything over the user's work.
  const act = interactive && !blocked.length
  const page = target ? extensionsPage(target) : "chrome://extensions"
  unpackedSteps({
    folder: options.folder,
    platform: options.env.platform,
    log,
    browser: target?.name,
    page,
    opened: act && target !== undefined && effects.open(target, page),
    revealed: act && options.env.tty && effects.reveal(options.folder),
    copied: act && options.env.tty && effects.copy(options.folder),
  })
  return "guided"
}

/**
 * Pairs a store-installed extension without the copy-paste step: opens its status page in the browser profile that has
 * it, with a one-time pairing code in the URL fragment (`welcome.html#code=<code>`). The page clears the fragment at
 * once and, only when the extension isn't paired, connects with the code, which the relay exchanges for the browser's
 * own token during the handshake (browser-pairing.ts). The code passes through the browser's command line, which other
 * local users can see in the process list (`ps`), so it's worth nothing after its first use or ten minutes, whichever
 * comes first. `pair` and typing the code stay as the fallback.
 * Returns "opened", "manual" (the store build is there but nothing was opened: say how to pair) or "none".
 */
export function pairStoreExtension(
  options: Pick<LocateOptions, "detections" | "preferred" | "allowOpen" | "env"> & { code: () => string; storeIds?: readonly string[] },
  effects: Effects = systemEffects,
): "opened" | "manual" | "none" {
  const ids = options.storeIds ?? STORE_IDS
  const matches = options.detections.flatMap((detection) => detection.enabled).filter((match) => ids.includes(match.id) && !oldStoreBuild(match))
  const match = matches.find((candidate) => candidate.browser.name === options.preferred?.name) ?? matches[0]
  if (!match) return "none"
  const interactive = options.allowOpen && options.env.display && !options.env.ssh
  if (interactive && effects.open(match.browser, `chrome-extension://${match.id}/welcome.html#code=${options.code()}`, match.profile.dir)) {
    effects.log(`✓ Opened Browse's status page in ${match.browser.name} (${match.profile.name}) to pair it with the relay`)
    return "opened"
  }
  effects.log(`To pair Browse in ${match.browser.name} (${match.profile.name}): ${manualPair(options.code())}`)
  return "manual"
}

/** The numbered steps for loading the unpacked build, saying what install already did for each. */
function unpackedSteps(step: {
  folder: string
  platform: NodeJS.Platform
  log: (line: string) => void
  browser?: string | undefined
  page?: string
  opened?: boolean
  revealed?: boolean
  copied?: boolean
}) {
  const { log } = step
  const page = step.page ?? "chrome://extensions"
  const fileManager = step.platform === "darwin" ? "Finder" : step.platform === "win32" ? "Explorer" : "your file manager"
  const paste = step.platform === "darwin" ? "press Cmd+Shift+G in the folder picker and paste" : "paste it into the folder picker"
  log("Load the extension in your browser (one time):")
  log(`  1. Open ${page}${step.browser ? ` in ${step.browser}` : " (or your browser's extensions page)"}${step.opened ? " (opened)" : ""}`)
  log("  2. Turn on Developer mode")
  log(`  3. Click Load unpacked and choose this folder${step.copied ? ` (path copied: ${paste})` : ""}, or drag it onto the page:`)
  log(`     ${step.folder}${step.revealed ? ` (shown in ${fileManager})` : ""}`)
}

/** The browser's own extensions page; every Chromium browser also accepts chrome://, these rewrite it to their scheme. */
export function extensionsPage(browser: Pick<Browser, "name">) {
  const scheme = ({ "Microsoft Edge": "edge", Brave: "brave", Vivaldi: "vivaldi", Opera: "opera" } as Record<string, string>)[browser.name]
  return `${scheme ?? "chrome"}://extensions`
}

/**
 * Polls until the extension connects to the relay: true when it does, false after timeoutMs. Install waits like
 * this after printing the unpacked steps, so the user sees the moment Load unpacked worked.
 */
export async function waitForExtension(options: {
  connected: () => Promise<boolean>
  timeoutMs: number
  intervalMs: number
  sleep?: (ms: number) => Promise<void>
}) {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  for (let waited = 0; ; waited += options.intervalMs) {
    if (await options.connected()) return true
    if (waited >= options.timeoutMs) return false
    await sleep(options.intervalMs)
  }
}

/** Every browser with user data here, and the profiles that have Browse. */
function detectBrowsers() {
  return browsers().flatMap((browser): Detection[] => {
    const state = readLocked(path.join(browser.userData, "Local State"))
    if (state.missing) return []
    // Leftover data of an uninstalled browser: nothing to open it with.
    if (state.blocked) return launcher(browser) ? [{ browser, blocked: true, enabled: [], disabled: [] }] : []
    let blocked = false
    const matches = listProfiles(browser, state.text).flatMap((profile) => {
      const settings = ["Secure Preferences", "Preferences"].map(file => {
        const prefs = readLocked(path.join(browser.userData, profile.dir, file))
        blocked ||= prefs.blocked
        return (parseJson(prefs.text) as { extensions?: { settings?: Record<string, ExtensionSetting> } } | undefined)?.extensions?.settings ?? {}
      })
      const id = [...STORE_IDS, UNPACKED_ID].find((candidate) => settings.some((entries) => entries[candidate]))
      if (!id) return []
      const setting = settings.find((entries) => entries[id])![id]!
      // Unpacked profiles omit the manifest from Secure Preferences and store its absolute folder instead.
      const version = setting.manifest?.version ?? (setting.path && path.isAbsolute(setting.path) ? readJson<{ version?: string }>(path.join(setting.path, "manifest.json"))?.version : undefined)
      return [{ browser, profile, id, ...(version ? { version } : {}), enabled: !disabled(setting) }]
    })
    return [
      {
        browser,
        blocked,
        enabled: matches.filter((match) => match.enabled),
        disabled: matches.filter((match) => !match.enabled),
      },
    ]
  })
}

type ExtensionSetting = { disable_reasons?: unknown; manifest?: { version?: string }; path?: string }

function disabled(setting: ExtensionSetting) {
  const reasons = setting.disable_reasons
  if (Array.isArray(reasons)) return reasons.length > 0
  return typeof reasons === "number" && reasons !== 0
}

/** Profiles from `Local State` (with their display names), else the profile directories themselves. */
function listProfiles(browser: Browser, localState: string | undefined): Profile[] {
  const cache = (parseJson(localState) as { profile?: { info_cache?: Record<string, { name?: string }> } } | undefined)?.profile?.info_cache
  if (cache && Object.keys(cache).length)
    return Object.entries(cache).map(([dir, info]) => ({ dir, name: info.name || dir }))
  const dirs = (() => {
    try {
      return readdirSync(browser.userData)
    } catch {
      return []
    }
  })()
  return dirs.filter((dir) => /^(Default|Profile \d+)$/.test(dir)).map((dir) => ({ dir, name: dir }))
}

function readLocked(file: string) {
  try {
    return { text: readFileSync(file, "utf8"), missing: false, blocked: false }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return { text: undefined, missing: code === "ENOENT" || code === "ENOTDIR", blocked: code === "EPERM" || code === "EACCES" }
  }
}

function parseJson(text: string | undefined): unknown {
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** The OS default web browser among the known ones; undefined when it can't be told or isn't Chromium. */
function defaultBrowser(candidates: Browser[]) {
  const id = defaultBrowserID()
  if (!id) return undefined
  const known = browsers().find((browser) =>
    browser.defaultIDs.some((name) => name.toLowerCase() === id.toLowerCase() || id.startsWith(`${name}.`)),
  )
  return known && (candidates.find((browser) => browser.name === known.name) ?? known)
}

function defaultBrowserID() {
  if (process.platform === "darwin") {
    const plist = path.join(home, "Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist")
    const json = spawnSync("plutil", ["-convert", "json", "-o", "-", plist], { encoding: "utf8" })
    const handlers =
      (parseJson(json.stdout) as { LSHandlers?: { LSHandlerURLScheme?: string; LSHandlerRoleAll?: string }[] } | undefined)?.LSHandlers ?? []
    return ["https", "http"]
      .map((scheme) => handlers.find((handler) => handler.LSHandlerURLScheme === scheme)?.LSHandlerRoleAll)
      .find((bundle) => !!bundle)
  }
  if (windows) {
    const key = "HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice"
    const query = spawnSync("reg", ["query", key, "/v", "ProgId"], { encoding: "utf8" })
    return /ProgId\s+REG_SZ\s+(\S+)/.exec(query.stdout ?? "")?.[1]
  }
  const xdg = spawnSync("xdg-settings", ["get", "default-web-browser"], { encoding: "utf8" })
  return xdg.status === 0 ? xdg.stdout.trim().replace(/\.desktop$/, "") || undefined : undefined
}

function reportDetections(detections: Detection[], preferred: Browser | undefined, log: (line: string) => void) {
  log(`Default browser: ${preferred?.name ?? "unknown"}`)
  detections.forEach((detection) => {
    const name = detection.browser.name
    if (detection.blocked) return log(`  ${name}: couldn't check (${blockedReason()})`)
    if (detection.enabled.length) return log(`  ${name}: Browse in ${detection.enabled.map(describe).join(", ")}`)
    if (detection.disabled.length) return log(`  ${name}: Browse turned off in ${detection.disabled.map(describe).join(", ")}`)
    log(`  ${name}: no Browse`)
  })
}

const describe = (match: Match) => `${match.profile.name}${match.id === UNPACKED_ID ? " (unpacked)" : ""}`
const blockedReason = () => (process.platform === "darwin" ? "macOS privacy protection" : "permission denied")

/**
 * Opens a URL in a specific browser by launching its executable with the URL, which forwards it to a running
 * instance; chrome:// URLs only open this way. Without the executable, an https URL goes through the OS, which on
 * macOS can still pick the app; a chrome:// URL can't (it isn't a scheme the OS knows), so it's left to the user.
 */
function openInBrowser(browser: Browser, url: string, profile?: string) {
  const executable = launcher(browser)?.executable
  const web = /^https?:/.test(url)
  if (executable) {
    const child = spawn(executable, [...(profile ? [`--profile-directory=${profile}`] : []), url], { detached: true, stdio: "ignore" })
    child.on("error", () => web && openWithSystem(browser, url))
    child.unref()
    return true
  }
  if (!web) return false
  return openWithSystem(browser, url)
}

function openWithSystem(browser: Browser | undefined, url: string) {
  if (process.platform === "darwin") return spawnSync("open", browser?.app ? ["-a", browser.app, url] : [url]).status === 0
  // rundll32 hands the URL to its handler without cmd parsing the & in it.
  if (windows) return spawnSync("rundll32", ["url.dll,FileProtocolHandler", url]).status === 0
  return spawnSync("xdg-open", [url]).status === 0
}

/** Shows the folder selected in its parent (Finder, Explorer), or opens the parent (Linux file managers). */
function revealFolder(folder: string) {
  const run = (command: string, args: string[]) => {
    const result = spawnSync(command, args, { stdio: "ignore", timeout: 10_000 })
    // explorer exits 1 even when it opened the window.
    return !result.error && (windows || result.status === 0)
  }
  if (process.platform === "darwin") return run("open", ["-R", folder])
  if (windows) return run("explorer", [`/select,${folder}`])
  return run("xdg-open", [path.dirname(folder)])
}

/** Copies text with the platform's clipboard tool: pbcopy, clip, or wl-copy / xclip / xsel. */
function copyToClipboard(text: string) {
  const tools: [string, string[]][] =
    process.platform === "darwin"
      ? [["pbcopy", []]]
      : windows
        ? [["clip", []]]
        : [
            ...(process.env.WAYLAND_DISPLAY ? [["wl-copy", []] as [string, string[]]] : []),
            ["xclip", ["-selection", "clipboard"]],
            ["xsel", ["--clipboard", "--input"]],
          ]
  return tools.some(([command, args]) => {
    const result = spawnSync(command, args, { input: text, stdio: ["pipe", "ignore", "ignore"], timeout: 5_000 })
    return !result.error && result.status === 0
  })
}

const systemEffects: Effects = { open: openInBrowser, openDefault: url => openWithSystem(undefined, url), reveal: revealFolder, copy: copyToClipboard, log }

/** The browser's executable, or (macOS) just its app bundle when the executable can't be read. */
function launcher(browser: Browser): { executable?: string } | undefined {
  if (process.platform === "darwin") {
    const bundle = [path.join("/Applications", `${browser.app}.app`), path.join(home, "Applications", `${browser.app}.app`)].find((dir) => existsSync(dir))
    if (!bundle) return undefined
    const name = spawnSync("plutil", ["-extract", "CFBundleExecutable", "raw", "-o", "-", path.join(bundle, "Contents", "Info.plist")], { encoding: "utf8" }).stdout?.trim()
    const executable = name ? path.join(bundle, "Contents", "MacOS", name) : undefined
    return executable && existsSync(executable) ? { executable } : {}
  }
  const executable = windows ? browser.executables.find((file) => existsSync(file)) : browser.executables.map(findOnPath).find((file) => !!file)
  return executable ? { executable } : undefined
}

function log(line: string) {
  process.stdout.write(line + "\n")
}

function fail(message: string): never {
  process.stderr.write(message + "\n")
  process.exit(1)
}

export async function runSetup(command: string, args: string[]) {
  if (command === "install") return install(args)
  if (command === "extension") return extension()
  if (command === "uninstall") return uninstall(args)
  if (command === "pair") return pair(args)
  if (command === "set") return set(args)
  if (command === "rollback") {
    const { runRollback } = await import("./runtime-update.ts")
    return runRollback(args)
  }
}
