// Setup for browse, without changing opencode itself:
//   install    install the runtime, add the browse MCP server to opencode's config, then check which browsers have the
//              extension. Every channel installs it from the Chrome Web Store item: when no browser has it, install
//              says to add it there and opens that item's page; when one has it, install opens its status page with a
//              one-time pairing code in the URL fragment so it pairs without a step. A checkout also pairs its own
//              build (dist/), and a dev npm install the dev extension it downloads from the release service into
//              <data root>/extension (dev-extension.ts): install writes a one-time code into that folder and reloads a
//              connected one that's out of date, without mentioning either
//   extension  show the unpacked extension folder (for "Load unpacked"), or a stable npm install's store page
//   pair       print a one-time pairing code for a browser; --list shows paired browsers, --revoke unpairs one
//   set        set hostname: where the relay listens (relay-config.ts)
//   uninstall  remove everything install wrote
// Earlier versions registered a native messaging host and wrote an opencode plugin; install and uninstall
// remove those leftovers.
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import * as clack from "@clack/prompts"
import {
  agentLabels,
  agentLocations,
  callingAgent,
  editAgentConfig,
  type AgentName,
  type AgentReceipt,
} from "./setup/agent-config.ts"
import { agentFlags, agentPlan, pickAgents } from "./setup/agent-picker.ts"
import { autoUpdateStatus, describeAutoUpdate } from "./update/auto-update.ts"
import { mintPairingCode, pairingCodeKey, pendingPairingCodeKeys } from "./relay/browser-pairing.ts"
import { cliCommand, compiledBinary, entryCommand, installCommand, oldStoreMarker, scriptEntry } from "./paths.ts"
import {
  extensionProtocolAdvice,
  extensionProtocolSkew,
  unpackedExtensionId,
} from "./protocol.ts"
import {
  defaultBrowser,
  detectBrowsers,
  extensionsPage,
  installedExtensionVersion,
  oldStoreBuild,
  type Browser,
  type Detection,
  type Effects,
  type Match,
  type Profile,
} from "./setup/browsers.ts"
import {
  ensureRelay,
  extension,
  extensionStatus,
  pair,
  pairUnpacked,
  reloadOutdatedExtension,
  set,
  settledExtensionStatus,
  syncDev,
  uninstall,
  type ExtensionStatus,
} from "./setup/commands.ts"
import {
  configRoot,
  connectedMessage,
  fail,
  files,
  findOnPath,
  findOpencode,
  fromSource,
  home,
  installWaitTimeout,
  layout,
  log,
  manualPair,
  MCP_NAME,
  pairedOfflineMessage,
  rail,
  readJson,
  STORE_IDS,
  tilde,
  unpackedFolder,
  type Settings,
} from "./setup/environment.ts"
import {
  locateExtension,
  pairStoreExtension,
  waitForExtension,
  type LocateOptions,
} from "./setup/guidance.ts"
import {
  configFile,
  configureMcp,
  installedRuntime,
  installRuntime,
  legacyBrowserControl,
  manualMcpEntry,
  mcpServers,
  relayNotRestarted,
  removeLegacyHost,
  removeMcp,
  restartOutdatedRelay,
  type Servers,
} from "./setup/mcp.ts"
import { addToPath } from "./setup/binary.ts"
import { installRemote, remoteRelayAddresses, remoteRelayLines } from "./setup/remote.ts"

export {
  configureMcp,
  extensionsPage,
  installedExtensionVersion,
  installedRuntime,
  installWaitTimeout,
  locateExtension,
  manualMcpEntry,
  pairStoreExtension,
  relayNotRestarted,
  remoteRelayAddresses,
  remoteRelayLines,
  removeMcp,
  waitForExtension,
  type Browser,
  type Detection,
  type Effects,
  type LocateOptions,
  type Match,
  type Profile,
  type Servers,
  type Settings,
}

/** The MCP server and relay run under the Node.js that runs install, so it must be one the package supports. */
function checkNode() {
  // A binary install brings its own runtime.
  if (compiledBinary()) return
  // `bun run` stands in a bun shim for a missing node.
  if (process.versions.bun)
    fail(
      "browse runs on Node.js 22.19 or newer, but this ran under Bun (`bun run` uses Bun when `node` isn't on PATH). Install Node.js from https://nodejs.org, then run setup again.",
    )
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number)
  if (major < 22 || (major === 22 && minor < 19))
    fail(
      `browse needs Node.js 22.19 or newer; this is ${process.version} (${process.execPath}). Update Node.js (https://nodejs.org), then run setup again.`,
    )
}

async function install(args: string[]) {
  const tty = !!(process.stdin.isTTY && process.stdout.isTTY)
  const caller = callingAgent(process.env)
  rail.active = tty && !caller
  if (rail.active) clack.intro("browse")
  else if (caller) log(`${agentLabels[caller]} is running this, so browse is set up for ${agentLabels[caller]}.`)
  await installSteps(args, tty, caller)
  if (!rail.active) return
  rail.waiting?.stop()
  clack.outro(
    process.exitCode
      ? "browse isn't fully set up yet. Fix the steps above, then run browse install again."
      : byHand
        ? "Done. Add the MCP server above to your agent, then ask it to open a page."
        : "Done. Ask your agent to open a page.",
  )
}

/** Set when no agent was picked (`--agent none`, or nothing ticked): the MCP entry is then the step, not an aside. */
let byHand = false

function showManualMcp(command: readonly string[], caller: AgentName | undefined) {
  const json = manualMcpEntry(command)
  if (rail.active) return clack.note(json, "Any agent: add browse as an MCP server")
  const intro = byHand
    ? "Add browse to your agent as an MCP server (stdio):"
    : caller
      ? "Using another agent too? Add browse to it as an MCP server (stdio):"
      : "Agent: if you weren't set up above, add browse to your own MCP config (stdio):"
  log(`\n${intro}\n${json.split("\n").map((line) => `  ${line}`).join("\n")}\n`)
}

async function installSteps(args: string[], tty: boolean, caller: AgentName | undefined) {
  checkNode()
  const timeoutMs = installWaitTimeout(args, tty)
  let flags: ReturnType<typeof agentFlags>
  try {
    flags = agentFlags(args)
  } catch (error) {
    fail((error as Error).message)
  }
  const opencode = findOpencode(args)
  const locations = agentLocations(home, configRoot, findOnPath, configFile(), opencode)
  const previous = readJson<Settings>(files.settings)
  const remembered =
    previous?.selectedAgents ??
    (previous?.declinedAgents?.length
      ? locations.filter((a) => a.installed && !previous.declinedAgents!.includes(a.name)).map((a) => a.name)
      : undefined)
  const plan = agentPlan(locations, flags, tty, caller, remembered)

  mkdirSync(files.dir, { recursive: true })
  const { entry, version } = await installRuntime(args.includes("--force"))
  log(`✓ browse ${version} installed${fromSource ? " (from source)" : ""}`)
  const onPath = args.includes("--no-modify-path") ? undefined : addToPath()
  if (onPath) log(`✓ Added browse to your PATH (${tilde(onPath)}). Open a new terminal to use it.`)

  // First the entry for any agent, then the agents install can set up itself: nobody is stuck if theirs isn't found.
  const anyFound = locations.some((a) => a.installed)
  byHand = plan.picker ? !anyFound : plan.selected.length === 0
  showManualMcp(entryCommand(entry), caller)
  const selected = plan.picker ? (anyFound ? await pickAgents(locations, plan.selected) : []) : plan.selected
  if (!selected) {
    process.exitCode = 130
    return
  }
  if (plan.picker && anyFound) byHand = selected.length === 0
  const agents = previous?.agents ?? []
  const opencodeConfigs = previous?.opencodeConfigs ?? (previous?.entry ? [configFile()] : [])
  const selectedAgents = plan.picker ? selected : remembered
  const save = () =>
    writeFileSync(
      files.settings,
      JSON.stringify(
        {
          ...(opencode ? { opencode } : {}),
          entry,
          version,
          agents,
          opencodeConfigs,
          ...(selectedAgents && { selectedAgents }),
        } satisfies Settings,
        null,
        2,
      ) + "\n",
    )
  save()
  if (removeLegacyHost()) log("✓ Removed the native messaging host of an earlier version")

  // An npm or checkout install runs the MCP server under this Node; a binary install's executable runs by itself.
  const node = scriptEntry(entry) ? process.execPath : undefined
  for (const agent of locations) {
    const label = agentLabels[agent.name]
    if (!selected.includes(agent.name)) {
      if (!plan.picker && agent.installed && !flags.requested.length)
        log(`To add ${label} too: ${cliCommand(`install --agent ${agent.name}`)}`)
      continue
    }
    if (agent.name === "opencode") {
      const mcp = configureMcp(agent.file, entry, previous?.entry)
      if (mcp && !opencodeConfigs.includes(agent.file)) {
        opencodeConfigs.push(agent.file)
        save()
      }
      if (!mcp) process.exitCode = 1
      log(
        !mcp
          ? `! ${label} already has a different server named browse in ${tilde(agent.file)}; left it unchanged.`
          : mcp.includes("up to date")
            ? `✓ ${label} already has browse`
            : mcp.includes("added")
              ? `✓ Added browse to ${label} (${tilde(agent.file)})`
              : `✓ Updated browse in ${label} (${tilde(agent.file)})`,
      )
      continue
    }
    const receipt: AgentReceipt = { name: agent.name, file: agent.file, entry, ...(node ? { node } : {}) }
    try {
      // What an earlier install wrote here (an npm install before this binary one, or another Node): replace it.
      const prior = agents.find((a) => a.file === agent.file && a.name === agent.name)
      if (prior && (prior.entry !== receipt.entry || prior.node !== receipt.node) && editAgentConfig(prior, true) === "removed") {
        agents.splice(agents.indexOf(prior), 1)
        save()
      }
      const result = editAgentConfig(receipt)
      if (result === "added") {
        const i = agents.findIndex((a) => a.file === agent.file)
        if (i !== -1) agents.splice(i, 1)
        agents.push(receipt)
        save()
      }
      if (result === "conflict") process.exitCode = 1
      log(
        result === "conflict"
          ? `! ${label} already has a different server named browse in ${tilde(agent.file)}; left it unchanged.`
          : result === "added"
            ? `✓ Added browse to ${label} (${tilde(agent.file)})`
            : `✓ ${label} already has browse`,
      )
    } catch {
      process.exitCode = 1
      log(
        `! Couldn't edit ${tilde(agent.file)} for ${label}. Check its syntax and permissions, then run ${cliCommand(`install --agent ${agent.name}`)}.`,
      )
    }
  }
  for (const line of restartOutdatedRelay(entry) ?? []) log(line)
  const legacy = selected.includes("opencode") ? legacyBrowserControl() : []
  if (legacy.length)
    log(
      `! Browser Control MCP server${legacy.length === 1 ? "" : "s"} ${legacy.map((name) => `"${name}"`).join(", ")} also configured. browse replaces it; remove ${legacy.length === 1 ? "it" : "them"} from ${configFile()} to avoid two sets of browser tools.`,
    )
  if (args.includes("--remote")) return installRemote(entry, tty)

  await syncDev()
  const initial = await settledExtensionStatus(entry)
  const connected = initial?.connected ? initial : undefined
  const pairedOffline = initial?.pairingState === "paired-offline"
  const folder = unpackedFolder()
  if (folder && !pairedOffline) {
    // The unpacked extension finds a one-time code in its own folder and exchanges it for its key, without a step.
    pairUnpacked()
    // A browser already running an older unpacked build keeps its old code until it reloads; ask it to, silently:
    // install never talks about unpacked builds.
    const reload = connected ? await reloadOutdatedExtension(connected, folder) : "current"
    if (reload === "reloaded") log("✓ Reloaded browse in your browser")
  }
  // Including --no-wait (checkout update): an incompatible browser is installed, not waiting to be added or paired.
  const reportMismatch = (status: ExtensionStatus) => {
    const advice = status.nextStep ?? extensionProtocolAdvice(status.protocolVersion, { install: installCommand() })
    if (
      args.includes("--no-wait") &&
      folder &&
      status.origin === `chrome-extension://${unpackedExtensionId}` &&
      extensionProtocolSkew(status.protocolVersion) === "extension-older"
    )
      return log(`! Not connected yet. ${advice}`) // The files were installed; only a browser action remains.
    fail(advice)
  }
  if (initial?.protocolCompatible === false && initial.origin) return reportMismatch(initial)
  log("")
  // Over SSH the browsers here aren't the ones the user looks at, so they aren't scanned.
  const ssh = !!(process.env.SSH_CONNECTION || process.env.SSH_TTY)
  const detections = ssh ? [] : detectBrowsers()
  rmSync(oldStoreMarker(), { force: true })
  const checkStore = (scanned: Detection[]) => {
    const matches = scanned.flatMap((d) => d.enabled).filter((m) => STORE_IDS.includes(m.id))
    if (!matches.length || !matches.every(oldStoreBuild)) return true
    writeFileSync(oldStoreMarker(), "2\n")
    ensureRelay(entry)
    log(
      `! Found browse ${matches[0]!.version} in ${matches[0]!.browser.name}. ${extensionProtocolAdvice(2, { install: cliCommand("install") }, "store")}`,
    )
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
    detections,
    preferred: ssh ? undefined : defaultBrowser(detections.map((detection) => detection.browser)),
    env,
  })
  if (connected || found === "off" || pairedOffline) return
  ensureRelay(entry)
  let code: string | undefined
  const pairingCode = () =>
    code && pendingPairingCodeKeys().includes(pairingCodeKey(code)) ? code : (code = mintPairingCode())
  const pairStore = (scanned: Detection[]) =>
    pairStoreExtension({
      detections: scanned,
      preferred: defaultBrowser(scanned.map((d) => d.browser)),
      allowOpen: !args.includes("--no-open"),
      env,
      code: pairingCode,
    })
  let offer = ssh ? "none" : pairStore(detections)
  const blocked = detections.filter((d) => d.blocked).map((d) => d.browser.name)
  if (offer === "none" && blocked.length)
    log(
      `Couldn't check ${blocked.join(", ")}. If browse is already installed there, pair it manually. ${manualPair(pairingCode())}`,
    )
  const next = `If browse isn't connected after you add it, run \`${cliCommand("install")}\` again to pair it.`
  const agentNext = () => {
    return `Agent: ${
      offer === "opened"
        ? "ask the user to open browse's status page in their browser"
        : offer === "manual" || blocked.length
          ? "ask the user to finish pairing in browse's Options"
          : "ask the user to add browse from the Chrome Web Store"
    }. Then re-run \`${cliCommand("install")}\` to finish, or call the browse status tool to check the connection.`
  }
  if (!env.tty) log(agentNext())
  if (args.includes("--no-wait") || ssh || !env.display) {
    if (env.tty) log(next)
    return
  }
  if (rail.active)
    (rail.waiting = clack.spinner({
      cancelMessage: "Stopped waiting",
      onCancel: () => {
        rail.waiting = undefined
      },
    })).start("Waiting for browse to connect in your browser (Ctrl+C to skip)")
  else log(`Waiting for browse to connect (up to ${timeoutMs / 1000}s; Ctrl+C to skip)…`)
  let stopped = false
  const stop = () => {
    stopped = true
  }
  process.once("SIGINT", stop)
  try {
    const deadline = Date.now() + timeoutMs
    do {
      const status = await extensionStatus(
        !args.includes("--no-open") && (offer === "opened" || (offer === "none" && !blocked.length)),
      )
      if (status?.protocolCompatible === false) return reportMismatch(status)
      if (status?.connected) return log(connectedMessage)
      if (status?.pairingState === "paired-offline") return log(pairedOfflineMessage)
      if (offer === "none") {
        const scan = detectBrowsers()
        if (!checkStore(scan)) return
        if (scan.some((d) => d.enabled.length)) offer = pairStore(scan)
      }
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(1000, deadline - Date.now()))))
    } while (!stopped && Date.now() < deadline)
    if (!env.tty) return log(`! Not connected yet. ${agentNext()}`)
    log(`! Not connected yet. ${code ? manualPair(pairingCode()) : next}`)
    process.exitCode = 1
  } finally {
    process.off("SIGINT", stop)
  }
}

/** Printed before the relay's status by `opencode-browser status`. */
export function printSetupStatus() {
  const settings = readJson<Settings>(files.settings)
  const runtime = installedRuntime(settings, mcpServers()[MCP_NAME])
  log(
    runtime
      ? `Setup:     installed${runtime.source ? " (from source)" : ""}`
      : `Setup:     not installed. Run \`${installCommand()}\`.`,
  )
  log(`Version:   ${runtime ? `${runtime.version ?? "unknown"} (${runtime.entry})` : "not installed"}`)
  log(`opencode:  ${settings?.opencode ?? findOpencode([]) ?? "not found"}`)
  log(mcpServers()[MCP_NAME] ? `MCP:       "${MCP_NAME}" configured` : "MCP:       not configured")
  log(describeAutoUpdate(autoUpdateStatus({ layout })))
  log(`Logs:      ${path.join(files.dir, "logs")}`)
  log("")
}

export async function runSetup(command: string, args: string[]) {
  if (command === "install") return install(args)
  if (command === "extension") return extension()
  if (command === "uninstall") return uninstall(args)
  if (command === "pair") return pair(args)
  if (command === "set") return set(args)
  if (command === "rollback") {
    const { runRollback } = await import("./update/runtime-update.ts")
    return runRollback(args)
  }
}
