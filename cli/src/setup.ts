// Setup for OpenCode Browser, without changing opencode itself:
//   install    install the runtime, add the browse MCP server to opencode's config, copy the unpacked extension
//              (reloading a connected one), then check which browsers have the extension; when none does, guide
//              loading it unpacked (or, once STORE_LISTED, open the Chrome Web Store listing) and wait for it
//   extension  show the unpacked extension folder (for "Load unpacked")
//   pair       print the pairing code a Chrome Web Store build asks for (unpacked builds are paired by install)
//   uninstall  remove everything install wrote
// Earlier versions registered a native messaging host and wrote an opencode plugin; install and uninstall
// remove those leftovers.
import { spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { createInterface } from "node:readline/promises"
import { fileURLToPath } from "node:url"
import { applyEdits, modify, parse } from "jsonc-parser"
import { cliCommand, dataRoot, installCommand, STORE_LISTED } from "./paths.ts"
import { formatPairingCode, pairingCode, relayAuthorization, writeExtensionPairing } from "./relay-secrets.ts"
import { opencodeBrowserVersion } from "./version.ts"

const STORE_ID = "mfnicocicmmlkpjnaffgihfjhdgjkdjg"
/** The unpacked build; its ID is pinned by the manifest key. */
const UNPACKED_ID = "afeafocngkodbmaipcngoamamfmekgfo"
const STORE_URL = `https://chromewebstore.google.com/detail/${STORE_ID}`
const PACKAGE = "opencode-browser-cli"
const MCP_NAME = "browse"
/** The MCP server's name before it was renamed to `browse`. */
const LEGACY_MCP_NAME = "opencode-browser"
const LEGACY_HOST_NAME = "ai.opencode.browser"
const LEGACY_REGISTRY_ROOTS = ["HKCU\\Software\\Google\\Chrome", "HKCU\\Software\\Microsoft\\Edge"]
const windows = process.platform === "win32"

const home = homedir()
const root = dataRoot()
const configRoot = process.env.XDG_CONFIG_HOME ?? path.join(home, ".config")
const files = {
  dir: root,
  /** A pinned npm install of this package: the MCP server runs from here, not the npx cache. */
  runtime: path.join(root, "runtime"),
  settings: path.join(root, "settings.json"),
  extension: path.join(root, "extension"),
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
const bundledExtension = path.join(packageRoot, "extension")
/** From a checkout, the extension folder users load unpacked (dist/) and its source (public/, copied into dist/ by every build). */
const checkoutExtensionDirs = (() => {
  const repo = path.dirname(packageRoot)
  if (!fromSource || !existsSync(path.join(repo, "public", "manifest.json"))) return []
  return [path.join(repo, "public"), path.join(repo, "dist")]
})()

type Settings = { opencode?: string; entry?: string; version?: string }

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

type Servers = Record<string, { type?: unknown; command?: unknown; environment?: unknown; [key: string]: unknown }>

/** Changes whenever the installed runtime does. */
function fingerprint(entry: string) {
  return createHash("sha256").update(readFileOr(entry, entry)).digest("hex").slice(0, 16)
}

/**
 * After an update, a relay still running the old build refuses the new CLI and MCP server; restart it from
 * the new runtime. Restarting keeps browser tabs open but ends in-flight agent work, so it's announced.
 */
function restartOutdatedRelay(entry: string, node: string) {
  const status = spawnSync(node, [entry, "status", "--json"], { encoding: "utf8", timeout: 15_000 })
  if (!/"stale":\s*true/.test(status.stdout ?? "")) return undefined
  const restart = spawnSync(node, [entry, "relay", "restart"], { encoding: "utf8", timeout: 60_000 })
  return restart.status === 0 ? "restarted with the new version" : `could not restart: ${(restart.stderr || restart.stdout).trim()}`
}

function mcpServers() {
  return ((parse(readFileOr(configFile(), "{}")) ?? {}) as { mcp?: { servers?: Servers } }).mcp?.servers ?? {}
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
function configureMcp(entry: string) {
  const file = configFile()
  // A running MCP server keeps its old code after an update, and its relay calls then fail on the build check.
  // Stamping the runtime's fingerprint into the entry changes the config whenever the runtime changes, which
  // makes opencode restart the server with the new code.
  const renamed = removeMcp(LEGACY_MCP_NAME)
  const existing = mcpServers()[MCP_NAME]
  const server = mergedMcpServer(existing, [process.execPath, entry, "mcp"], fingerprint(entry))
  if (existing && JSON.stringify(existing) === JSON.stringify(server)) return `"${MCP_NAME}" is up to date`
  const text = readFileOr(file, "{}")
  const edits = modify(text, ["mcp", "servers", MCP_NAME], server, { formattingOptions: { tabSize: 2, insertSpaces: true } })
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, applyEdits(text, edits))
  if (renamed) return `"${LEGACY_MCP_NAME}" renamed to "${MCP_NAME}" in ${file}`
  return existing ? `"${MCP_NAME}" updated in ${file}` : `"${MCP_NAME}" added to ${file}`
}

function removeMcp(name: string) {
  const file = configFile()
  const text = readFileOr(file, "")
  if (!text || !mcpServers()[name]) return false
  writeFileSync(file, applyEdits(text, modify(text, ["mcp", "servers", name], undefined, {})))
  return true
}

/** MCP servers from the separate Browser Control product, which OpenCode Browser replaces. */
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
 * Installs this exact version into the data root, so the MCP server keeps working after the npx cache is
 * cleared, and an update is one `install` away. From source (development), runs in place.
 * OPENCODE_BROWSER_PACKAGE installs a specific spec instead, for example a local tarball.
 */
function installRuntime() {
  // From a checkout, run the bundle `bun run build` wrote: Node can't run the TypeScript sources (they use
  // syntax type stripping doesn't cover), and the MCP server runs under Node.
  if (fromSource) {
    const bundle = path.join(packageRoot, "dist", "cli.mjs")
    if (!existsSync(bundle)) fail("Build the CLI first: `bun run build` in cli/ (or `bun run setup` at the top).")
    return bundle
  }
  const spec = process.env.OPENCODE_BROWSER_PACKAGE ?? `${PACKAGE}@${opencodeBrowserVersion}`
  // A package name, name@version, tarball path or URL: never an npm flag, and nothing a shell would interpret.
  if (spec.startsWith("-") || /[\s"'`&|<>^%!;]/.test(spec)) fail(`Invalid OPENCODE_BROWSER_PACKAGE: ${JSON.stringify(spec)}`)
  mkdirSync(files.runtime, { recursive: true })
  if (!existsSync(path.join(files.runtime, "package.json"))) writeFileSync(path.join(files.runtime, "package.json"), "{\"private\":true}\n")
  const npmArgs = ["install", "--prefix", files.runtime, "--no-audit", "--no-fund", "--loglevel=error", spec]
  // On Windows npm is a .cmd script, which Node only runs through a shell; run npm's own entry with node instead.
  const npmCli = windows ? windowsNpmCli() : undefined
  const npm = spawnSync(npmCli ? process.execPath : "npm", npmCli ? [npmCli, ...npmArgs] : npmArgs, { encoding: "utf8" })
  if (npm.status !== 0) fail(`Could not install ${spec}: ${(npm.stderr || npm.stdout || "npm failed").trim()}`)
  return path.join(files.runtime, "node_modules", PACKAGE, "dist", "cli.mjs")
}

/** npm's JavaScript entry next to node.exe, or next to the npm.cmd on PATH. */
function windowsNpmCli() {
  const besideNode = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")
  if (existsSync(besideNode)) return besideNode
  const npmCmd = spawnSync("where", ["npm.cmd"], { encoding: "utf8" }).stdout?.split(/\r?\n/).find((line) => line.trim())
  const besideCmd = npmCmd ? path.join(path.dirname(npmCmd.trim()), "node_modules", "npm", "bin", "npm-cli.js") : undefined
  if (besideCmd && existsSync(besideCmd)) return besideCmd
  fail("Could not find npm (node_modules\\npm\\bin\\npm-cli.js next to node.exe or npm.cmd). Install Node.js with npm and retry.")
}

// ---- commands -------------------------------------------------------------------------------------

/** The MCP server and relay run under the Node.js that runs install, so it must be one the package supports. */
function checkNode() {
  // `bun run` stands in a bun shim for a missing node.
  if (process.versions.bun)
    fail("OpenCode Browser needs Node.js 22.19 or newer, and `node` isn't installed (Bun ran in its place). Install Node.js from https://nodejs.org, then run setup again.")
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number)
  if (major < 22 || (major === 22 && minor < 19))
    fail(`OpenCode Browser needs Node.js 22.19 or newer; this is ${process.version} (${process.execPath}). Update Node.js (https://nodejs.org), then run setup again.`)
}

/** The folder to load unpacked: the checkout's dist/ (which `bun run setup` builds), else the copy in the data root. */
function unpackedFolder() {
  return checkoutExtensionDirs[1] ?? files.extension
}

async function install(args: string[]) {
  checkNode()
  const opencode = findOpencode(args)

  mkdirSync(files.dir, { recursive: true })
  const entry = installRuntime()
  log(`✓ OpenCode Browser ${opencodeBrowserVersion} installed${fromSource ? " (from source)" : ""}`)
  writeFileSync(files.settings, JSON.stringify({ ...(opencode ? { opencode } : {}), entry, version: opencodeBrowserVersion } satisfies Settings, null, 2) + "\n")
  if (removeLegacyHost()) log("✓ Removed the native messaging host of an earlier version")

  const node = process.execPath
  log(opencode ? `✓ Using opencode at ${opencode}` : "! opencode not found. Install it (https://opencode.ai), or add the browse server to another MCP client (see the README).")
  const mcp = configureMcp(entry)
  log(`✓ MCP server ${mcp}`)
  const relay = restartOutdatedRelay(entry, node)
  if (relay) log(`${relay.startsWith("restarted") ? "✓" : "!"} Relay ${relay}`)
  const legacy = legacyBrowserControl()
  if (legacy.length)
    log(`! Browser Control MCP server${legacy.length === 1 ? "" : "s"} ${legacy.map((name) => `"${name}"`).join(", ")} also configured. OpenCode Browser replaces it; remove ${legacy.length === 1 ? "it" : "them"} from ${configFile()} to avoid two sets of browser tools.`)

  const connected = await connectedExtension()
  if (existsSync(bundledExtension)) {
    rmSync(files.extension, { recursive: true, force: true })
    cpSync(bundledExtension, files.extension, { recursive: true })
  }
  // The unpacked extension reads the pairing code from its own folder, so it pairs with the relay without a step.
  pairUnpacked()
  log(`✓ Paired the unpacked extension with the relay (for the Chrome Web Store build, run \`${cliCommand("pair")}\`)`)
  if (existsSync(bundledExtension)) {
    // A browser already running an older unpacked build keeps its old code until it reloads; ask it to.
    const reload = connected ? await reloadOutdatedExtension(connected) : "current"
    if (reload === "reloaded") log("✓ Reloaded OpenCode Browser in your browser")
    if (reload === "stale")
      log("! OpenCode Browser didn't reload in your browser. Reload it on the browser's extensions page to finish the update.")
  }
  log("")
  // Over SSH the browsers here aren't the ones the user looks at, so they aren't scanned.
  const ssh = !!(process.env.SSH_CONNECTION || process.env.SSH_TTY)
  const detections = ssh ? [] : detectBrowsers()
  const env = {
    ssh,
    display: process.platform !== "linux" || !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY),
    tty: !!process.stdout.isTTY,
    platform: process.platform,
  }
  const found = locateExtension({
    allowOpen: !args.includes("--no-open"),
    connected: !!connected,
    folder: unpackedFolder(),
    detections,
    preferred: ssh ? undefined : defaultBrowser(detections.map((detection) => detection.browser)),
    env,
  })
  if (found === "guided" && !STORE_LISTED && env.tty && !ssh && !args.includes("--no-wait")) return awaitConnection(entry)
  // The MCP server entry changed: a running opencode picks it up on restart.
  if (found === "ready" && !mcp.endsWith("up to date")) log("Restart opencode (if it's running) to load the browse tools.")
}

/**
 * After the unpacked steps, starts the relay (so the extension connects the moment it's loaded) and waits up to two
 * minutes for it. Ctrl+C stops waiting without failing setup.
 */
async function awaitConnection(entry: string) {
  // Any relay-backed command starts the relay in the background; it keeps running for agents afterwards.
  spawnSync(process.execPath, [entry, "session", "list", "--json"], { stdio: "ignore", timeout: 30_000 })
  log("")
  log("Waiting for the extension to connect (up to 2 minutes; Ctrl+C to skip)…")
  const stop = () => {
    log("")
    log(`Stopped waiting. Once it's loaded, \`${cliCommand("status")}\` shows whether it's connected.`)
    process.exit(0)
  }
  process.once("SIGINT", stop)
  const ok = await waitForExtension({ connected: async () => (await extensionStatus())?.connected === true, timeoutMs: 120_000, intervalMs: 1_000 })
  process.off("SIGINT", stop)
  log(ok
    ? "✓ Connected. Restart opencode, then ask an agent to open a page."
    : `! Not connected yet. Finish the steps above, then check with \`${cliCommand("status")}\`.`)
}

/** Printed before the relay's status by `opencode-browser status`. */
export function printSetupStatus() {
  const settings = readJson<Settings>(files.settings)
  log(settings?.version ? `Setup:     installed` : `Setup:     not installed. Run \`${installCommand()}\`.`)
  log(`Version:   ${settings?.version ?? "not installed"}${settings?.entry ? ` (${settings.entry})` : ""}`)
  log(`opencode:  ${settings?.opencode ?? findOpencode([]) ?? "not found"}`)
  log(mcpServers()[MCP_NAME] ? `MCP:       "${MCP_NAME}" configured` : "MCP:       not configured")
  log(`Logs:      ${path.join(files.dir, "logs")}`)
  log("")
}

function extension() {
  if (!checkoutExtensionDirs.length && !existsSync(files.extension)) {
    if (!existsSync(bundledExtension)) fail("This package has no bundled extension.")
    mkdirSync(files.dir, { recursive: true })
    cpSync(bundledExtension, files.extension, { recursive: true })
  }
  const folder = unpackedFolder()
  if (!existsSync(path.join(folder, "manifest.json"))) fail(`${folder} has no built extension. Run \`${installCommand()}\` first.`)
  pairUnpacked()
  revealFolder(folder)
  log(`Load unpacked from: ${folder}`)
}

/** Writes the pairing code into every unpacked extension folder this install manages. */
function pairUnpacked() {
  const code = pairingCode()
  for (const directory of [files.extension, ...checkoutExtensionDirs])
    if (existsSync(path.join(directory, "manifest.json"))) writeExtensionPairing(directory, code)
}

function pair() {
  mkdirSync(files.dir, { recursive: true })
  pairUnpacked()
  log(`Pairing code: ${formatPairingCode(pairingCode())}`)
  log("")
  log("OpenCode Browser from the Chrome Web Store asks for this code once: open its status page (right-click the")
  log("toolbar button, then Options), paste it, and click Pair. Unpacked installs are paired by `install`.")
  log("Keep it private: with it, a program could pose as the relay to your browser.")
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
  const mcp = [MCP_NAME, LEGACY_MCP_NAME].filter((name) => removeMcp(name))
  rmSync(files.dir, { recursive: true, force: true })
  log(`✓ Removed ${files.dir}`)
  if (host) log("✓ Removed the native messaging host of an earlier version")
  if (mcp.length) log(`✓ Removed the ${mcp.map((name) => `"${name}"`).join(" and ")} MCP server${mcp.length === 1 ? "" : "s"}`)
  log("Remove the extension from your browser to finish.")
}

type ExtensionStatus = { connected?: boolean; build?: string | null; origin?: string | null }

const relayBase = () => `http://127.0.0.1:${Number(process.env.OPENCODE_BROWSER_PORT) || 19988}`

/** The relay token header; the relay rejects every API request without it. */
const relayHeaders = (): Record<string, string> => {
  try {
    return { authorization: relayAuthorization() }
  } catch {
    return {}
  }
}

const extensionStatus = () =>
  fetch(`${relayBase()}/extension/status`, { headers: relayHeaders(), signal: AbortSignal.timeout(3_000) })
    .then((response) => (response.ok ? (response.json() as Promise<ExtensionStatus>) : undefined))
    .catch(() => undefined)

/** The extension connected to the relay, if any; a relay restarted moments ago waits a second or two for it. */
async function connectedExtension() {
  let status = await extensionStatus()
  for (let attempt = 0; status?.connected === false && attempt < 10; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    status = await extensionStatus()
  }
  return status?.connected ? status : undefined
}

/**
 * Reloads the connected extension when it's the unpacked build (the store updates its own) and older than the files
 * just copied, then checks the reload took effect: the build it reports after reconnecting must be the new one.
 */
async function reloadOutdatedExtension(before: ExtensionStatus): Promise<"reloaded" | "stale" | "current"> {
  if (before.origin !== `chrome-extension://${UNPACKED_ID}`) return "current"
  const bundled = readJson<{ build?: string }>(path.join(files.extension, "build.json"))?.build
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
export type Match = { browser: Browser; profile: Profile; id: string }
/** blocked: the OS refused to read the browser's data (macOS privacy protection), so it may have the extension. */
export type Detection = { browser: Browser; blocked: boolean; enabled: Match[]; disabled: Match[] }

/** What locateExtension may do outside the terminal; stubbed in tests so they never open a real browser. */
export type Effects = {
  /** Opens a URL in a specific browser; false when it couldn't be handed to one. */
  open(browser: Browser, url: string): boolean
  /** Shows the folder in the file manager, selected where the OS can, so it can be dragged. */
  reveal(folder: string): boolean
  /** Puts text on the clipboard; false when there is no clipboard tool. */
  copy(text: string): boolean
  log(line: string): void
}

export type LocateOptions = {
  allowOpen: boolean
  connected: boolean
  /** The folder to load unpacked: the checkout's dist/, or the copy in the data root. */
  folder: string
  detections: Detection[]
  preferred: Browser | undefined
  env: { ssh: boolean; display: boolean; tty: boolean; platform: NodeJS.Platform }
  storeListed?: boolean
}

/**
 * Reports the browsers and profiles that have OpenCode Browser. When none does (and none is connected to the relay),
 * guides installing it: until the Chrome Web Store listing is live (STORE_LISTED), that's loading the unpacked build,
 * with the browser's extensions page opened, the folder revealed and its path copied; after, the store listing.
 * Nothing opens when the browsers here aren't the ones the user looks at (SSH, no display), there is no terminal,
 * with --no-open, or when a browser couldn't be checked and may already have it.
 * Returns "ready" when the extension is there, "off" when it's turned off, else "guided".
 */
export function locateExtension(options: LocateOptions, effects: Effects = systemEffects): "ready" | "off" | "guided" {
  const { log } = effects
  const storeListed = options.storeListed ?? STORE_LISTED
  const ready = "✓ Agents can use OpenCode Browser now. Click its toolbar button on a tab to let them use that tab too."
  if (options.env.ssh) {
    if (options.connected) return log(ready), "ready"
    if (storeListed) log(`Install OpenCode Browser in your browser from the Chrome Web Store: ${STORE_URL}`)
    else unpackedSteps({ folder: options.folder, platform: options.env.platform, log })
    return "guided"
  }
  reportDetections(options.detections, options.preferred, log)
  // A connected extension is installed, even somewhere the scan doesn't look (a custom profile directory, a snap).
  if (options.connected || options.detections.some((detection) => detection.enabled.length)) return log(ready), "ready"
  const off = options.detections.flatMap((detection) => detection.disabled)
  if (off.length) {
    log(`! OpenCode Browser is turned off in ${off.map((match) => `${match.browser.name} (${match.profile.name})`).join(", ")}. Turn it on in the browser's extensions page.`)
    return "off"
  }
  const blocked = options.detections.filter((detection) => detection.blocked).map((detection) => detection.browser.name)
  const target = options.preferred ?? options.detections.find((detection) => !detection.blocked)?.browser
  const interactive = options.allowOpen && options.env.display && options.env.tty
  if (storeListed) {
    const opened = interactive && !blocked.length && target !== undefined && effects.open(target, STORE_URL)
    log(`Install OpenCode Browser from the Chrome Web Store${opened ? ` (opened in ${target.name})` : ""}:`)
    log(`  ${STORE_URL}`)
    if (blocked.length) log(`  Already installed in ${blocked.join(", ")}? Then you're set.`)
    log(`  Or load the unpacked build: ${cliCommand("extension")}`)
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
    revealed: act && effects.reveal(options.folder),
    copied: act && effects.copy(options.folder),
  })
  if (blocked.length) log(`Already loaded in ${blocked.join(", ")}? Then you're set.`)
  return "guided"
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
  log("  4. Restart opencode")
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

/** Every browser with user data here, and the profiles that have OpenCode Browser. */
function detectBrowsers() {
  return browsers().flatMap((browser): Detection[] => {
    const state = readLocked(path.join(browser.userData, "Local State"))
    if (state.missing) return []
    // Leftover data of an uninstalled browser: nothing to open it with.
    if (state.blocked) return launcher(browser) ? [{ browser, blocked: true, enabled: [], disabled: [] }] : []
    const matches = listProfiles(browser, state.text).flatMap((profile) => {
      const settings = ["Secure Preferences", "Preferences"].map(
        (file) =>
          (parseJson(readLocked(path.join(browser.userData, profile.dir, file)).text) as { extensions?: { settings?: Record<string, ExtensionSetting> } } | undefined)
            ?.extensions?.settings ?? {},
      )
      const id = [STORE_ID, UNPACKED_ID].find((candidate) => settings.some((entries) => entries[candidate]))
      if (!id) return []
      const setting = settings.find((entries) => entries[id])![id]!
      return [{ browser, profile, id, enabled: !disabled(setting) }]
    })
    return [
      {
        browser,
        blocked: false,
        enabled: matches.filter((match) => match.enabled),
        disabled: matches.filter((match) => !match.enabled),
      },
    ]
  })
}

type ExtensionSetting = { disable_reasons?: unknown }

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
    if (detection.enabled.length) return log(`  ${name}: OpenCode Browser in ${detection.enabled.map(describe).join(", ")}`)
    if (detection.disabled.length) return log(`  ${name}: OpenCode Browser turned off in ${detection.disabled.map(describe).join(", ")}`)
    log(`  ${name}: no OpenCode Browser`)
  })
}

const describe = (match: Match) => `${match.profile.name}${match.id === UNPACKED_ID ? " (unpacked)" : ""}`
const blockedReason = () => (process.platform === "darwin" ? "macOS privacy protection" : "permission denied")

/**
 * Opens a URL in a specific browser by launching its executable with the URL, which forwards it to a running
 * instance; chrome:// URLs only open this way. Without the executable, an https URL goes through the OS, which on
 * macOS can still pick the app; a chrome:// URL can't (it isn't a scheme the OS knows), so it's left to the user.
 */
function openInBrowser(browser: Browser, url: string) {
  const executable = launcher(browser)?.executable
  const web = /^https?:/.test(url)
  if (executable) {
    const child = spawn(executable, [url], { detached: true, stdio: "ignore" })
    child.on("error", () => web && openWithSystem(browser, url))
    child.unref()
    return true
  }
  if (!web) return false
  openWithSystem(browser, url)
  return true
}

function openWithSystem(browser: Browser, url: string) {
  if (process.platform === "darwin") return void spawnSync("open", browser.app ? ["-a", browser.app, url] : [url])
  // rundll32 hands the URL to its handler without cmd parsing the & in it.
  if (windows) return void spawnSync("rundll32", ["url.dll,FileProtocolHandler", url])
  spawnSync("xdg-open", [url])
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

const systemEffects: Effects = { open: openInBrowser, reveal: revealFolder, copy: copyToClipboard, log }

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
  if (command === "pair") return pair()
}
