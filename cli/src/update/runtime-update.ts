// Restarting an install after an update (auto-update.ts has the layout): `update`, and the two commands the relay's
// updater runs in detached children so nothing waits on its event loop:
//   self-update <version> [--channel <tag>]   reruns the installer (binary: its release service channel; npm: npm
//                                             install -g at <version>)
//   runtime-switch <version>                  restarts the relay from the stable entry path (exit 1 when refused)
// A switch drains the running relay first (the same safe restart as `relay restart`, refused while a capture, a
// recording or a raw CDP client is busy). Only once it has stopped does the new entry start, so on a refusal nothing
// changes. --force ends what's blocking it. There is nothing to roll back to: the installer replaces the binary or the
// npm package in place, and running `install` again is the way to go back.
import { Effect } from "effect"
import {
  channelOf,
  compareVersions,
  effectiveMode,
  fetchPublished,
  installedRuntime,
  installedVersion,
  registryUrl,
  runInstaller,
  updateState,
  updateTarget,
  UPDATE_VERSION,
  type Channel,
  type Runtime,
} from "./auto-update.ts"
import { checkRelease, releaseChannel, runningServiceTarget, type ReleaseDecision } from "./release-service.ts"
import { cliCommand, installCommand } from "../paths.ts"
import * as RelayClient from "../relay/client.ts"
import * as RelayLifecycle from "../relay/lifecycle.ts"

const log = (line: string) => process.stdout.write(line + "\n")

/**
 * Restarts the relay from the install's stable entry once `version` is on disk. Undefined when it restarted (or no
 * relay was running), else why not. Nothing on disk moves, so a refused restart leaves the old relay running.
 */
export async function switchTo(runtime: Runtime, version: string, options: { readonly force: boolean }): Promise<string | undefined> {
  const installed = installedVersion(runtime)
  if (!installed) return `${runtime.entry} doesn't report a version`
  if (installed !== version) return `${version} isn't installed`
  const program = Effect.gen(function* () {
    const relay = yield* RelayClient.Service
    const running = yield* Effect.result(relay.version)
    // No relay: nothing to drain or mix with.
    if (running._tag === "Failure") return undefined
    yield* RelayLifecycle.restartRelay({
      relay,
      clientKind: "cli",
      force: options.force,
      otherBuild: true,
      start: RelayLifecycle.startManagedRelay(runtime.entry),
    })
    // Another relay can start in the gap (an old MCP server's next call); it must be the new version.
    const now = yield* relay.version
    return now.version === installed ? undefined : `a relay of version ${now.version} started first`
  }).pipe(Effect.provide(RelayClient.layerFetch))
  return Effect.runPromise(program.pipe(Effect.catch((error) => Effect.succeed((error as Error).message ?? String(error)))))
}

function installedOnly(command: string) {
  const runtime = installedRuntime()
  if (runtime) return runtime
  log(`\`${command}\` is for installs that update themselves (\`${installCommand()}\`); this one isn't.`)
  process.exitCode = 1
  return undefined
}

/** `browse update [--check] [--force]` for an installed binary or npm global install. false when this isn't one. */
export async function runInstalledUpdate(args: readonly string[], runtime = installedRuntime()) {
  if (!runtime) return false
  if (runtime.kind === "npx") {
    log("This is an npx install; npx resolves the package itself, so there is nothing to update here.")
    log(`Install it once with \`${installCommand()}\` to get automatic updates.`)
    return true
  }
  const channel = channelOf(runtime.version)
  if (runtime.kind === "binary") {
    const target = runningServiceTarget()
    if (!target) {
      log("✗ This executable isn't a released browse build, so it has no release channel to follow.")
      process.exitCode = 1
      return true
    }
    const serviceChannel = releaseChannel(channel)
    const answer = await checkRelease({ version: runtime.version, channel: serviceChannel, target }).catch((error: Error) => error)
    if (answer instanceof Error) {
      log(`✗ Couldn't check for updates: ${answer.message}`)
      process.exitCode = 1
      return true
    }
    if (answer.status === "missing") {
      log(`✗ There is no ${serviceChannel} release of browse yet.`)
      process.exitCode = 1
      return true
    }
    if (answer.status === "unchanged") {
      log(`✓ Up to date: ${runtime.version} is the current ${serviceChannel} release.`)
      return true
    }
    const decision: ReleaseDecision = answer.decision
    if (decision.action === "reject") {
      log(`✗ The ${serviceChannel} release manifest was rejected (${decision.reason}). Try again later.`)
      process.exitCode = 1
      return true
    }
    if (decision.action === "none") {
      updateState(({ failed: _failed, latest: _latest, ...state }) => ({ ...state, checkedAt: Date.now() }))
      log(decision.reason === "rollout_deferred" ? `✓ Up to date: ${runtime.version}; the ${serviceChannel} release ${answer.releaseVersion} is still rolling out.` : `✓ Up to date: ${runtime.version} is the current ${serviceChannel} release.`)
      return true
    }
    updateState(({ failed: _failed, ...state }) => ({ ...state, checkedAt: Date.now(), latest: decision.version, ...(answer.etag ? { etag: answer.etag } : {}) }))
    if (args.includes("--check")) {
      log(`Update available: ${decision.version} (you have ${runtime.version}). Run \`${cliCommand("update")}\` to install it.`)
      return true
    }
    log(`Installing ${decision.version} (you have ${runtime.version})…`)
    // The installer reads the same manifest and checks the file's size and SHA-256; it follows the channel, so a
    // release that moved on between the check and the download still installs the current build.
    const installed = await runInstaller({ runtime, channel: serviceChannel }).catch((error: Error) => {
      log(`✗ ${error.message}`)
      process.exitCode = 1
      return undefined
    })
    if (!installed) return true
    updateState(({ installing: _installing, ...state }) => ({ ...state, lastUpdate: { from: runtime.version, to: installed, at: new Date().toISOString() } }))
    const refused = await switchTo({ ...runtime, version: installed }, installed, { force: args.includes("--force") })
    if (refused) {
      const automatic = effectiveMode() === "on"
      log(`! Installed ${installed}, but the relay didn't restart (${refused}).`)
      log(automatic ? "  It keeps running the old version until no agent is using the browser, then restarts." : `  When no agent is using the browser, run \`${cliCommand("update")}\` again.`)
      return true
    }
    log(`✓ Updated ${runtime.version} → ${installed}.`)
    return true
  }
  const published = await fetchPublished({ registry: await registryUrl(), channel }).catch((error: Error) => error)
  if (published instanceof Error) {
    log(`✗ Couldn't check for updates: ${published.message}`)
    process.exitCode = 1
    return true
  }
  updateState(({ failed: _failed, ...state }) => ({ ...state, checkedAt: Date.now(), latest: published.version }))
  if (compareVersions(published.version, runtime.version) <= 0) {
    log(`✓ Up to date: ${runtime.version} is the newest on the ${channel} channel.`)
    return true
  }
  if (args.includes("--check")) {
    log(`Update available: ${published.version} (you have ${runtime.version}). Run \`${cliCommand("update")}\` to install it.`)
    return true
  }
  log(`Installing ${published.version} (you have ${runtime.version})…`)
  const installed = await runInstaller({ runtime, version: published.version, channel }).catch((error: Error) => {
    log(`✗ ${error.message}`)
    process.exitCode = 1
    return undefined
  })
  if (!installed) return true
  updateState(({ installing: _installing, ...state }) => ({ ...state, lastUpdate: { from: runtime.version, to: installed, at: new Date().toISOString() } }))
  // An old runtime/versions runtime's update is in npm's global folder; its relay restarts from there.
  const target = await updateTarget(runtime)
  const refused = target ? await switchTo({ ...target, version: installed }, installed, { force: args.includes("--force") }) : "npm's global folder is unknown (`npm root -g` failed)"
  if (refused) {
    const automatic = effectiveMode() === "on"
    log(`! Installed ${installed}, but the relay didn't restart (${refused}).`)
    log(automatic ? "  It keeps running the old version until no agent is using the browser, then restarts." : `  When no agent is using the browser, run \`${cliCommand("update")}\` again.`)
    return true
  }
  log(`✓ Updated ${runtime.version} → ${installed}.`)
  return true
}

/** `self-update <version> [--channel <tag>]`: the relay's installer child. Exit 0 when the installer succeeded. */
export async function runSelfUpdate(args: readonly string[]) {
  const runtime = installedRuntime()
  const version = args[0]
  const channelAt = args.indexOf("--channel")
  const channel = (channelAt === -1 ? channelOf(version ?? "") : args[channelAt + 1]) as Channel | undefined
  if (!runtime) {
    log("self-update: not an installed runtime")
    process.exitCode = 2
    return
  }
  if (!version || !UPDATE_VERSION.test(version)) {
    log(`self-update: invalid version ${JSON.stringify(version)}`)
    process.exitCode = 2
    return
  }
  try {
    // A binary install follows its release service channel; its installer checks the manifest's size and SHA-256. An
    // npm install is pinned to the version npm serves (version, not channel), as npm install -g does.
    const installChannel = releaseChannel(channel ?? channelOf(version))
    const installed = await runInstaller({
      runtime,
      ...(runtime.kind === "binary" ? { channel: installChannel } : { version, ...(channel ? { channel } : {}) }),
    })
    log(`${new Date().toISOString()} installed ${installed}`)
  } catch (error) {
    updateState(({ installing, ...state }) => {
      const still = installing?.pid === process.pid ? undefined : installing
      return {
        ...state,
        ...(still ? { installing: still } : {}),
        lastError: { message: (error as Error).message, at: new Date().toISOString(), version, attempts: 1 + (state.lastError?.version === version ? state.lastError.attempts ?? 1 : 0) },
      }
    })
    log(`${new Date().toISOString()} install of ${version} failed: ${(error as Error).message}`)
    process.exitCode = 1
  }
}

/** `runtime-switch <version>`: the relay's switch child. Exit 1 when the relay refused (nothing changed). */
export async function runRuntimeSwitch(args: readonly string[]) {
  const runtime = installedRuntime()
  if (!runtime) {
    log("runtime-switch: not an installed runtime")
    process.exitCode = 2
    return
  }
  const version = args[0] ?? installedVersion(runtime)
  if (!version) {
    process.exitCode = 2
    return
  }
  const before = runtime.version
  const refused = await switchTo({ ...runtime, version }, version, { force: false })
  log(`${new Date().toISOString()} switch ${before} → ${version}: ${refused ? `refused (${refused})` : "done"}`)
  if (refused) process.exitCode = 1
}

/** Kept for the old name used by tests and internal callers. */
export const runNpmUpdate = runInstalledUpdate
