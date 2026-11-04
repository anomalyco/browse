import { spawnSync } from "node:child_process"
import { existsSync, readFileSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import * as clack from "@clack/prompts"
import type { AgentName, AgentReceipt } from "./agent-config.ts"
import { runtimeLayout } from "../update/auto-update.ts"
import { formatPairingCode } from "../relay/browser-pairing.ts"
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

// In a terminal the outro says what to do next.
export const connectedMessage = "✓ Connected to your browser. Restart your agent, then ask it to open a page."
export const pairedOfflineMessage =
  "! Not connected yet. Open the browser profile already paired with browse and make sure the extension is enabled. It reconnects automatically."
export const manualPair = (code: string) =>
  `Open the Extensions menu → browse → Options, enter ${formatPairingCode(code)} as the pairing code, then click Pair.`

export function flag(args: string[], name: string) {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}

export function findOnPath(name: string) {
  const found = spawnSync(windows ? "where" : "which", [name], { encoding: "utf8" })
  return found.status === 0 ? found.stdout.split(/\r?\n/)[0]?.trim() || undefined : undefined
}

/**
 * The node binary to record: the one on PATH when it is the very binary running now (a `node` found on PATH keeps
 * working across a version manager switch, unlike the path of a running process), otherwise execPath. Never throws:
 * realpath fails for a PATH entry that vanished, or for a symlink into a node that was uninstalled.
 */
export function stableNodePath(execPath = process.execPath, onPath = findOnPath): string {
  const found = onPath("node")
  if (!found) return execPath
  try {
    return realpathSync(found) === realpathSync(execPath) ? found : execPath
  } catch {
    return execPath
  }
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

export const tilde = (file: string) => (file === home || file.startsWith(home + path.sep) ? "~" + file.slice(home.length) : file)

/**
 * install in a terminal draws one rail (clack), like the skills CLI: "✓ " lines are steps, "! " lines warnings, and a
 * line while the spinner waits ends it. Everything else (agents, scripts, other commands) gets the plain lines.
 */
export const rail: { active: boolean; waiting?: ReturnType<typeof clack.spinner> | undefined } = { active: false }

export function log(line: string) {
  if (!rail.active) return void process.stdout.write(line + "\n")
  if (!line.trim()) return
  const ok = line.startsWith("✓ ")
  const warn = line.startsWith("! ")
  const text = ok || warn ? line.slice(2) : line
  if (rail.waiting) {
    const spinner = rail.waiting
    rail.waiting = undefined
    return warn ? spinner.error(text) : spinner.stop(text)
  }
  if (ok) return clack.log.success(text)
  if (warn) return clack.log.warn(text)
  clack.log.message(text)
}

export function fail(message: string): never {
  if (rail.active) {
    rail.waiting?.error("Stopped")
    clack.log.error(message)
    clack.outro("browse isn't set up yet.")
  } else process.stderr.write(message + "\n")
  process.exit(1)
}

export const installWaitTimeout = (args: string[], tty: boolean) => waitTimeout(args, tty ? 180 : 90)

export function waitTimeout(args: string[], defaultSeconds = 180) {
  const seconds = Number(args.includes("--wait-seconds") ? flag(args, "--wait-seconds") : defaultSeconds)
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 3600) fail("--wait-seconds must be between 1 and 3600.")
  return seconds * 1000
}
