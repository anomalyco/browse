import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import * as clack from "@clack/prompts"
import type { AgentName, AgentReceipt } from "./agent-config.ts"
import {
  compareVersions,
  pruneVersions,
  runtimeLayout,
  skipBroken,
  switchVersion,
  updateState,
  VersionDoesNotStart,
  versionEntry,
  type Current,
} from "../update/auto-update.ts"
import { formatPairingCode } from "../relay/browser-pairing.ts"
import { cliCommand, dataRoot, devExtension, devExtensionFolder, PUBLIC_STORE_ID, storeConfig, storeUrl } from "../paths.ts"

/**
 * The Chrome Web Store item install points users at: the one this package was released with (paths.ts storeConfig), or
 * browse's public item for a checkout and a package built without one. Install hands a pairing code to the extension
 * with this ID, so it must be ours.
 */
const storeId = storeConfig().id ?? PUBLIC_STORE_ID
export const STORE_IDS = [storeId]
/** The store page every channel installs the extension from. */
export const STORE_URL = storeUrl(storeId)
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
export const connectedMessage = "✓ Connected to your browser. Ask your agent to open a page."
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

export function fail(message: string, outro = "browse isn't set up yet."): never {
  if (rail.active) {
    rail.waiting?.error("Stopped")
    clack.log.error(message)
    clack.outro(outro)
  } else process.stderr.write(message + "\n")
  process.exit(1)
}

export const installWaitTimeout = (args: string[], tty: boolean) => waitTimeout(args, tty ? 180 : 90)

export function waitTimeout(args: string[], defaultSeconds = 180) {
  const seconds = Number(args.includes("--wait-seconds") ? flag(args, "--wait-seconds") : defaultSeconds)
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 3600) fail("--wait-seconds must be between 1 and 3600.")
  return seconds * 1000
}

/** Another version is installed and runs from runtime/versions, in its own format (npm, or a binary install). */
const otherWorking = (before: Current | undefined, version: string): before is Current =>
  before !== undefined && before.version !== version && existsSync(versionEntry(layout, before.version, before.binary !== undefined))

/**
 * Stops install when installing `version` failed. One that doesn't start is skipped like an update that didn't start,
 * and a working install stays as it was (a binary install's executable back on PATH, where the install script put the
 * new one). `what` names what was installed.
 */
export function failInstall(before: Current | undefined, version: string, error: Error, what = `browse ${version}`, installed = false): never {
  if (error instanceof VersionDoesNotStart) {
    skipBroken(layout, version, error.message, installed)
    if (otherWorking(before, version)) {
      if (before.binary) switchVersion(layout, before.version, before.previous, before.binary)
      fail(`${error.message}. Kept browse ${before.version}; auto-update skips ${version} until a newer version is published.`, `browse ${before.version} is still set up.`)
    }
  }
  fail(`Could not install ${what}: ${error.message}`)
}

/**
 * Both formats keep a version in runtime/versions/<version>, so installing the current version in the other format
 * would replace the files its relay runs from. Stops install instead.
 */
export function refuseFormatChange(before: Current | undefined, version: string, binary: boolean) {
  if (before?.version !== version || (before.binary !== undefined) === binary) return
  fail(
    `browse ${version} is already installed here ${before.binary ? "as an executable" : "with npm"}. To install it the other way, run \`${cliCommand("uninstall")}\` first, or install again once a newer version is published.`,
    `browse ${version} is still set up.`,
  )
}

/**
 * Makes the installed `version` current. Over another working install it switches the way updates do (switchTo):
 * checked first, and when the new relay fails after the old one stopped, the old one is back. When it doesn't switch
 * (that, or the relay is busy), install stops with the old version as it was. `binary`: a binary install's executable
 * on PATH. `force`: end what keeps the relay busy.
 */
export async function switchInstalled(before: Current | undefined, version: string, options: { readonly binary?: string; readonly force?: boolean } = {}) {
  // Running install again for the same version keeps the version it replaced for rollback.
  const previous = before?.version === version ? before.previous : before?.version
  if (otherWorking(before, version)) {
    const { switchTo } = await import("../update/runtime-update.ts")
    const refused = await switchTo(layout, version, { previous, force: options.force ?? false, ...(options.binary ? { binary: options.binary } : {}) })
    if (refused?.broken) failInstall(before, version, new VersionDoesNotStart(refused.message), undefined, true)
    if (refused) {
      if (before.binary) switchVersion(layout, before.version, before.previous, before.binary)
      fail(
        `browse ${before.version} keeps running: the relay didn't restart (${refused.message}). When no agent is using the browser, run \`${cliCommand("install")}\` again (add --force to end what's blocking it).`,
        `browse ${before.version} is still set up.`,
      )
    }
  } else switchVersion(layout, version, previous, options.binary)
  // Installing by hand settles any update the relay was waiting to switch to, and un-skips this version.
  updateState(layout, ({ pending, skipped, ...state }) => ({
    ...state,
    ...(pending && compareVersions(pending, version) > 0 ? { pending } : {}),
    ...(skipped && skipped !== version ? { skipped } : {}),
  }))
  pruneVersions(layout, [version, previous])
}
