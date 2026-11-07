import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { networkInterfaces } from "node:os"
import path from "node:path"
import { createInterface } from "node:readline/promises"
import { editAgentConfig } from "./agent-config.ts"
import {
  bundledPairingCodeTtlMs,
  formatPairingCode,
  legacyPairingCode,
  mintPairingCode,
  pairingCodeTtlMs,
  readBrowserPairings,
  removeLegacyPairingCode,
  revokeBrowserToken,
  writeExtensionPairing,
} from "../relay/browser-pairing.ts"
import { syncDevExtension } from "./dev-extension.ts"
import { cliCommand, compiledBinary, defaultSettingsPath, devExtensionFolder, entryCommand, installedBinaryPath, installerBinaryPath, installCommand, runningEntry } from "../paths.ts"
import { runCommand } from "../update/auto-update.ts"
import { unpackedExtensionId } from "../protocol.ts"
import { parseHostname, readRelayConfig, writeRelayConfig } from "../relay/config.ts"
import { relayAuthorization } from "../relay/secrets.ts"
import { opencodeBrowserBuildId } from "../version.ts"
import { isInstallerBinary, removeBinaryInstall, samePath } from "./binary.ts"
import { revealFolder } from "./browsers.ts"
import {
  checkoutExtensionDirs,
  dev,
  fail,
  files,
  fromSource,
  LEGACY_MCP_NAME,
  log,
  manualPair,
  MCP_NAME,
  paths,
  readJson,
  STORE_URL,
  unpackedFolder,
  waitTimeout,
  type Settings,
} from "./environment.ts"
import { waitForExtension } from "./guidance.ts"
import { configFile, removeLegacyHost, removeMcp } from "./mcp.ts"

export type ExtensionStatus = {
  connected?: boolean
  pairingState?: string
  nextStep?: string
  build?: string | null
  origin?: string | null
  protocolCompatible?: boolean | null
  protocolVersion?: number | null
}

export const relayBase = () => `http://127.0.0.1:${Number(process.env.OPENCODE_BROWSER_PORT) || 19988}`

/** The relay token header; the relay rejects every API request without it. */
const relayHeaders = (): Record<string, string> => {
  try {
    return { authorization: relayAuthorization() }
  } catch {
    return {}
  }
}

export function ensureRelay(entry: string) {
  const [file, ...prefix] = entryCommand(entry)
  const started = spawnSync(file!, [...prefix, "session", "list", "--json"], {
    encoding: "utf8",
    timeout: 30_000,
  })
  if (started.status !== 0)
    fail(started.stderr?.trim() || `Couldn't reach the browse relay: ${started.error?.message || `run ${cliCommand("doctor")}`}`)
}

export const extensionStatus = (installWaiting = false) =>
  fetch(`${relayBase()}/extension/status`, {
    headers: { ...relayHeaders(), ...(installWaiting ? { "x-browse-install": "waiting" } : {}) },
    signal: AbortSignal.timeout(3_000),
  })
    .then((response) => (response.ok ? (response.json() as Promise<ExtensionStatus>) : undefined))
    .catch(() => undefined)

/** The extension connected to the relay, if any; a relay restarted moments ago waits a second or two for it. */
export async function settledExtensionStatus(entry: string) {
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
export async function reloadOutdatedExtension(
  before: ExtensionStatus,
  folder: string,
): Promise<"reloaded" | "stale" | "current"> {
  if (before.origin !== `chrome-extension://${unpackedExtensionId}`) return "current"
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

/**
 * Puts this version's dev extension in <cache root>/extension (paired, for a developer who loads it), silently: install
 * points every channel at the store build. Fails install when it can't be downloaded.
 */
export async function syncDev() {
  if (!dev) return
  try {
    await syncDevExtension(dev, { root: paths.cache })
  } catch (error) {
    fail(`Could not get the dev extension: ${(error as Error).message}`)
  }
}

/**
 * Writes a fresh one-time code into every unpacked extension folder this install manages (a checkout's, or a dev
 * install's). It's good for an hour and only until an extension used it, so the folder holds nothing reusable; an
 * extension that already has its key ignores it.
 */
export function pairUnpacked() {
  const directories = [...checkoutExtensionDirs, ...(dev ? [devExtensionFolder(paths.cache)] : [])].filter((directory) =>
    existsSync(path.join(directory, "manifest.json")),
  )
  if (directories.length === 0) return
  const code = mintPairingCode(undefined, { ttlMs: bundledPairingCodeTtlMs })
  for (const directory of directories) writeExtensionPairing(directory, code)
}

export async function extension() {
  const folder = unpackedFolder()
  if (!folder) {
    if (!STORE_URL)
      fail(
        "This package doesn't know its Chrome Web Store item. Install a released version (`npx @opencode/browse install`), or set up browse from a checkout.",
      )
    log(`Install browse from the Chrome Web Store: ${STORE_URL}`)
    log(`Then run \`${cliCommand("install")}\` again to pair it.`)
    return
  }
  await syncDev()
  if (!existsSync(path.join(folder, "manifest.json")))
    fail(`${folder} has no built extension. Run \`${installCommand()}\` first.`)
  pairUnpacked()
  revealFolder(folder)
  log(`Load unpacked from: ${folder}`)
}

/** `pair`: a new one-time code. `pair --list`: the paired browsers. `pair --revoke <browser>`: unpair one. */
export async function pair(args: string[]) {
  mkdirSync(files.dir, { recursive: true })
  if (args[0] === "--list") return listPairings()
  if (args[0] === "--revoke") return revokePairing(args[1])
  if (args.length && !(args.length === 2 && args[0] === "--wait-seconds")) {
    log(`Usage: ${cliCommand("pair")} [--wait-seconds <seconds> | --list | --revoke <browser>]`)
    process.exitCode = 1
    return
  }
  const timeoutMs = Math.min(waitTimeout(args), pairingCodeTtlMs)
  ensureRelay(readJson<Settings>(files.settings)?.entry ?? runningEntry())
  const receipt = randomUUID()
  const code = mintPairingCode(undefined, { receipt })
  log(`Pairing code: ${formatPairingCode(code)}`)
  log(`${manualPair(code)} It works once, within ${pairingCodeTtlMs / 60_000} minutes.`)
  log(
    `Waiting up to ${timeoutMs / 1000}s for that browser. Later, \`${cliCommand("pair --list")}\` shows paired browsers.`,
  )
  let paired: string | undefined
  await waitForExtension({
    timeoutMs,
    intervalMs: 500,
    connected: async () => {
      const match = Object.values(readBrowserPairings()).find(
        (browser) => browser.receipt === receipt && browser.lastSeen !== undefined,
      )
      paired = match?.name ?? match?.id
      return paired !== undefined
    },
  })
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
    log(
      "The shared pairing code of an earlier version is still accepted: browsers that still use it get their own key the",
    )
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
    log(
      removeLegacyPairingCode()
        ? "✓ The old shared pairing code is no longer accepted"
        : "The old shared pairing code was already gone.",
    )
    return
  }
  const wanted = target.trim().toLowerCase()
  const browser = pairedBrowsers().find(
    (entry) => entry.key === target || entry.id === wanted || entry.name?.toLowerCase() === wanted,
  )
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
  log(
    `✓ Unpaired ${browser.id ?? browser.key}${dropped ? " and disconnected it" : ""}. To use it again, pair it with a new code.`,
  )
}

/** `set hostname <127.0.0.1|0.0.0.0>`: saves where the relay listens and restarts a running relay to apply it. */
export async function set(args: string[]) {
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
  const running = await fetch(`${relayBase()}/version`, { signal: AbortSignal.timeout(2000) }).then(
    (response) => response.ok,
    () => false,
  )
  if (running) {
    const [file, ...prefix] = entryCommand(runningEntry())
    const restarted = spawnSync(file!, [...prefix, "relay", "restart"], { stdio: "inherit" })
    if (restarted.status !== 0)
      log(`! The relay is still running with the old hostname. Run \`${cliCommand("relay restart --force")}\` to apply it.`)
  }
  if (hostname === "127.0.0.1") return
  const tailscale = Object.values(networkInterfaces())
    .flat()
    .find((address) => address?.family === "IPv4" && /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(address.address))
    ?.address
  log("")
  log(
    "In the browser on the other computer, open browse's options (right-click its toolbar button, then Options),",
  )
  log("and under Connection enter:")
  log(`  Relay         ${tailscale ?? "this computer's address"}`)
  log(
    `  Pairing code  ${formatPairingCode(mintPairingCode())}  (works once, within ${pairingCodeTtlMs / 60_000} minutes; \`${cliCommand("pair")}\` prints another)`,
  )
  log("The connection isn't encrypted by browse: use it over Tailscale or a LAN you trust, not the open internet.")
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

/** Stop only a managed instance that recorded its identity in this install. Never start a relay during uninstall. */
async function stopInstalledRelay() {
  const base = relayBase()
  const audit = path.join(paths.state, "relays", new URL(base).port, "lifecycle.jsonl")
  if (!existsSync(audit)) return
  const probe = async () => {
    try {
      const response = await fetch(`${base}/version`, { redirect: "error", signal: AbortSignal.timeout(2000) })
      return response.ok ? await response.json() as { managed?: boolean; instanceId?: string; shutdownProtocol?: number } : undefined
    } catch (error) {
      const e = error as { code?: string; cause?: { code?: string } }
      if (error instanceof SyntaxError) return undefined // Another HTTP server, not a browse version response.
      if (["ECONNREFUSED", "ConnectionRefused"].includes(e.cause?.code ?? e.code ?? "")) return undefined
      throw error
    }
  }
  const relay = await probe()
  if (!relay?.managed || !relay.instanceId) return
  const ours = readFileSync(audit, "utf8").trim().split("\n").some(line => {
    const event = JSON.parse(line)
    return event._tag === "Ready" && event.instanceId === relay.instanceId
  })
  if (!ours) return
  if (relay.shutdownProtocol !== 2) throw new Error("Stop the legacy relay manually, then run uninstall again.")
  const response = await fetch(`${base}/shutdown`, {
    method: "POST", redirect: "error", headers: { ...relayHeaders(), "content-type": "application/json" }, signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({ instanceId: relay.instanceId, requestId: randomUUID(), reason: "explicit-restart", force: true,
      client: { kind: "cli", instanceId: randomUUID(), buildId: opencodeBrowserBuildId } }),
  })
  if (!response.ok || !(await response.json() as { stopping?: boolean }).stopping) throw new Error("The running relay refused shutdown. Stop it manually, then run uninstall again.")
  for (let n = 0; n < 100; n++) {
    const current = await probe()
    if (!current) return
    if (current.instanceId !== relay.instanceId) throw new Error("Another relay started during uninstall; no files were removed.")
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error("The relay is still stopping. Run uninstall again once it exits.")
}

export async function uninstall(args: string[]) {
  await confirmSecretRemoval(args)
  await stopInstalledRelay()
  const host = removeLegacyHost()
  const settings = readJson<Settings>(files.settings)
  const mcp = (settings?.opencodeConfigs ?? [configFile()]).flatMap((file) =>
    [MCP_NAME, LEGACY_MCP_NAME].filter((name) => removeMcp(name, settings?.entry, file)),
  )
  for (const receipt of settings?.agents ?? []) {
    try {
      const result = editAgentConfig(receipt, true)
      log(
        result === "conflict"
          ? `! ${receipt.file} has a changed browse server; left unchanged.`
          : `✓ ${receipt.name}: ${result}`,
      )
    } catch {
      fail(`Couldn't safely remove browse from ${receipt.file}. Check its syntax and permissions, then re-run uninstall.`)
    }
  }
  const binary = installedBinaryPath()
  if (compiledBinary()) {
    const installer = installerBinaryPath()
    if (installer !== binary && existsSync(installer) && !samePath(installer, binary)) {
      if (!existsSync(defaultSettingsPath()) && isInstallerBinary(installer, binary)) {
        try {
          rmSync(installer, { force: true })
          log(`✓ Removed ${installer}`)
        } catch {
          log(`! Couldn't remove ${installer} while it's running; delete it after uninstall exits.`)
        }
      } else {
        log(`! Left ${installer}; delete it if you no longer use browse there.`)
      }
    }
  }
  if (existsSync(binary)) {
    const left = removeBinaryInstall(binary)
    log(left ? `! Couldn't remove ${left}. After uninstall exits, close any browse agents using the file(s) and delete them.` : `✓ Removed ${binary}`)
  }
  for (const directory of [paths.data, paths.config, paths.state, paths.cache]) {
    try {
      rmSync(directory, { recursive: true, force: true })
      log(`✓ Removed ${directory}`)
    } catch (error) {
      if (process.platform !== "win32" || !["EBUSY", "EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error
      log(`! Couldn't remove all of ${directory}; close running browse agents and remove the remaining files.`)
    }
  }
  if (!compiledBinary() && !fromSource) {
    const npm = await runCommand("npm", ["uninstall", "-g", "@opencode/browse"], { timeoutMs: 120_000 })
    log(npm.status === 0 ? "✓ Removed the global npm package" : `! Couldn't remove the global npm package: ${(npm.stderr || npm.stdout).trim() || "npm uninstall failed"}`)
  }
  if (host) log("✓ Removed the native messaging host of an earlier version")
  if (mcp.length)
    log(`✓ Removed the ${mcp.map((name) => `"${name}"`).join(" and ")} MCP server${mcp.length === 1 ? "" : "s"}`)
  log("Remove the extension from your browser to finish.")
}
