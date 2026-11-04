import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { AgentName, AgentReceipt } from "../agent-config.ts"
import { runtimeLayout } from "../auto-update.ts"
import { formatPairingCode } from "../browser-pairing.ts"
import { dataRoot, devExtension, devExtensionFolder, storeConfig, storeUrl } from "../paths.ts"

/**
 * The Chrome Web Store item this package was released with (paths.ts storeConfig). Only this ID counts as the store
 * build: install hands a pairing code to the extension with this ID, so it must be ours.
 */
const store = storeConfig()
export const STORE_IDS = [store.id].filter((id): id is string => !!id)
/** The store page; undefined for a package built without the store item (and a checkout). */
export const STORE_URL = store.id ? storeUrl(store.id) : undefined
export const PACKAGE = "@opencode/browse"
export const MCP_NAME = "browse"
/** The MCP server's name before it was renamed to `browse`. */
export const LEGACY_MCP_NAME = "opencode-browser"
export const LEGACY_HOST_NAME = "ai.opencode.browser"
export const LEGACY_REGISTRY_ROOTS = ["HKCU\\Software\\Google\\Chrome", "HKCU\\Software\\Microsoft\\Edge"]
export const windows = process.platform === "win32"

export const home = homedir()
export const root = dataRoot()
export const configRoot = process.env.XDG_CONFIG_HOME ?? path.join(home, ".config")
export const layout = runtimeLayout(root)
export const files = {
  dir: root,
  /** Installed versions of this package (auto-update.ts): the MCP server runs from here through the shim, not the npx cache. */
  runtime: path.join(root, "runtime"),
  settings: path.join(root, "settings.json"),
}
/**
 * Files the native messaging host of earlier versions left behind. Not session.json: it has only ever been at
 * <data root>/session.json, which is the current CLI's current-session store (session-store.ts), not a leftover.
 */
export const legacyFiles = [
  path.join(root, "host"),
  path.join(root, "host.bat"),
  path.join(root, `${LEGACY_HOST_NAME}.json`),
  path.join(root, "state.json"),
  path.join(root, "logs", "host.log"),
  path.join(root, "cli.mjs"),
  path.join(configRoot, "opencode", "plugins", "opencode-browser.ts"),
]

const here = path.dirname(fileURLToPath(import.meta.url))
/** This package's root: dist/cli.mjs when published, src/setup/* from source. */
export const packageRoot = path.basename(here) === "setup" ? path.dirname(path.dirname(here)) : path.dirname(here)
/** Running from a source checkout without a package to install: the MCP server runs main.ts in place with bun. */
export const fromSource = existsSync(path.join(packageRoot, "src", "main.ts")) && !process.env.OPENCODE_BROWSER_PACKAGE
/** From a checkout, the extension folder users load unpacked (dist/) and its source (public/, copied into dist/ by every build). */
export const checkoutExtensionDirs = (() => {
  const repo = path.dirname(packageRoot)
  if (!fromSource || !existsSync(path.join(repo, "public", "manifest.json"))) return []
  return [path.join(repo, "public"), path.join(repo, "dist")]
})()

/** The dev extension a dev npm install downloads (paths.ts devExtension); undefined for a checkout or a stable release. */
export const dev = fromSource ? undefined : devExtension()

/** The folder to load unpacked: a checkout's dist/, which `bun run setup` builds, or a dev install's <data root>/extension. */
export const unpackedFolder = (): string | undefined => checkoutExtensionDirs[1] ?? (dev ? devExtensionFolder(root) : undefined)

export type Settings = {
  opencode?: string
  entry?: string
  version?: string
  agents?: AgentReceipt[]
  opencodeConfigs?: string[]
  selectedAgents?: AgentName[]
  declinedAgents?: AgentName[]
}

export const connectedMessage = "✓ Connected. Restart your agent, then ask it to open a page."
export const pairedOfflineMessage =
  "! Not connected yet. Open the browser profile already paired with Browse and make sure the extension is enabled. It reconnects automatically."
export const manualPair = (code: string) =>
  `Open the Extensions menu → Browse → Options, enter ${formatPairingCode(code)} as the pairing code, then click Pair.`

export function flag(args: string[], name: string) {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}

export function findOnPath(name: string) {
  const found = spawnSync(windows ? "where" : "which", [name], { encoding: "utf8" })
  return found.status === 0 ? found.stdout.split(/\r?\n/)[0]?.trim() || undefined : undefined
}

/** The opencode binary (recorded for status): --opencode, $OPENCODE_BIN, or `opencode` on PATH. */
export function findOpencode(args: string[]) {
  const explicit = flag(args, "--opencode") ?? process.env.OPENCODE_BIN
  if (explicit) return path.resolve(explicit)
  return findOnPath("opencode")
}

export function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T
  } catch {
    return undefined
  }
}

export function readFileOr(file: string, fallback: string) {
  try {
    return readFileSync(file, "utf8")
  } catch {
    return fallback
  }
}

export function log(line: string) {
  process.stdout.write(line + "\n")
}

export function fail(message: string): never {
  process.stderr.write(message + "\n")
  process.exit(1)
}

export const installWaitTimeout = (args: string[], tty: boolean) => waitTimeout(args, tty ? 180 : 90)

export function waitTimeout(args: string[], defaultSeconds = 180) {
  const seconds = Number(args.includes("--wait-seconds") ? flag(args, "--wait-seconds") : defaultSeconds)
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 3600) fail("--wait-seconds must be between 1 and 3600.")
  return seconds * 1000
}
