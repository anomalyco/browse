// Switching an npm install's version (auto-update.ts has the layout): `update`, `rollback`, and the two commands the
// relay's updater runs in detached children so nothing waits on its event loop:
//   runtime-install <version> [--integrity <sri>]   installs and verifies one version, records it as pending
//   runtime-switch <version>                         switches to an installed version (exit 1 when refused)
// A switch drains the running relay first (the same safe restart as `relay restart`, refused while a capture, a recording
// or a raw CDP client is busy). Only once it has stopped does current.json move and the new version's relay start, so
// on a refusal nothing changes: no MCP server swaps, and nothing runs a mix of versions. --force ends what's blocking it.
import { Effect } from "effect"
import { existsSync } from "node:fs"
import {
  autoUpdateOverride,
  channelOf,
  compareVersions,
  fetchPublished,
  installVersion,
  npmRuntime,
  pruneVersions,
  readCurrent,
  readState,
  registryUrl,
  runtimeLayout,
  switchVersion,
  updateState,
  versionEntry,
  writeCurrent,
  type AutoUpdateState,
  type Current,
  type Layout,
} from "./auto-update.ts"
import { cliCommand, installCommand } from "./paths.ts"
import * as RelayClient from "./relay-client.ts"
import * as RelayLifecycle from "./relay-lifecycle.ts"

const log = (line: string) => process.stdout.write(line + "\n")

/**
 * Switches to an installed `version`: drains the running relay, then points current.json at the version (keeping
 * `previous` for rollback) and starts its relay. Undefined when it switched, else why not (and current.json is as it was).
 */
export async function switchTo(layout: Layout, version: string, options: { readonly previous: string | undefined; readonly force: boolean }): Promise<string | undefined> {
  const entry = versionEntry(layout, version)
  if (!existsSync(entry)) return `${version} isn't installed`
  const before: Current | undefined = readCurrent(layout)
  let switched = false
  const point = Effect.sync(() => {
    switchVersion(layout, version, options.previous)
    switched = true
  })
  const program = Effect.gen(function* () {
    const relay = yield* RelayClient.Service
    const running = yield* Effect.result(relay.version)
    // No relay: nothing to drain or mix with.
    if (running._tag === "Failure") {
      yield* point
      return undefined
    }
    yield* RelayLifecycle.restartRelay({
      relay,
      clientKind: "cli",
      force: options.force,
      otherBuild: true,
      // Runs only after the old relay accepted the shutdown and stopped.
      start: point.pipe(Effect.andThen(RelayLifecycle.startManagedRelay(entry))),
    })
    // Another relay can start in the gap (an old MCP server's next call); it must be the new version.
    const now = yield* relay.version
    return now.version === version ? undefined : `a relay of version ${now.version} started first`
  }).pipe(Effect.provide(RelayClient.layerFetch))
  const refused = await Effect.runPromise(program.pipe(Effect.catch((error) => Effect.succeed((error as Error).message ?? String(error)))))
  if (refused && switched && before) writeCurrent(layout, before)
  return refused
}

function npmOnly(command: string) {
  const runtime = npmRuntime()
  if (runtime) return runtime
  log(`\`${command}\` is for npm installs (\`${installCommand()}\`); this one isn't.`)
  process.exitCode = 1
  return undefined
}

/** `opencode-browser rollback [--force]`. */
export async function runRollback(args: readonly string[]) {
  const runtime = npmOnly("rollback")
  if (!runtime) return
  const { layout } = runtime
  const current = readCurrent(layout)!
  const previous = current.previous
  if (!previous || !existsSync(versionEntry(layout, previous))) {
    log(`Nothing to roll back to: ${current.version} has no previous version installed.`)
    process.exitCode = 1
    return
  }
  const refused = await switchTo(layout, previous, { previous: current.version, force: args.includes("--force") })
  if (refused) {
    log(`✗ Not rolled back: the relay didn't restart (${refused}).`)
    log(`  When no agent is using the browser, run \`${cliCommand("rollback")}\` again (or add --force to end what's blocking it).`)
    process.exitCode = 1
    return
  }
  updateState(layout, ({ pending: _pending, ...state }) => ({ ...state, skipped: current.version, lastUpdate: { from: current.version, to: previous, at: new Date().toISOString() } }))
  log(`✓ Rolled back ${current.version} → ${previous}. Auto-update skips ${current.version} until a newer version is published.`)
  log("  Running MCP servers switch to it between requests; restart opencode if a tool still reports the old version.")
}

/** `opencode-browser update [--check] [--force]` for an npm install. */
export async function runNpmUpdate(args: readonly string[], layout?: Layout) {
  const runtime = npmRuntime(layout ? { layout } : {})
  if (!runtime) return false
  const lay = runtime.layout
  const channel = channelOf(runtime.version)
  const published = await fetchPublished({ registry: await registryUrl(), channel }).catch((error: Error) => error)
  if (published instanceof Error) {
    log(`✗ Couldn't check for updates: ${published.message}`)
    process.exitCode = 1
    return true
  }
  updateState(lay, ({ failed: _failed, ...state }) => ({ ...state, checkedAt: Date.now(), latest: published.version, integrity: published.integrity }))
  if (compareVersions(published.version, runtime.version) <= 0) {
    log(`✓ Up to date: ${runtime.version} is the newest on the ${channel} channel.`)
    return true
  }
  if (args.includes("--check")) {
    log(`Update available: ${published.version} (you have ${runtime.version}). Run \`${cliCommand("update")}\` to install it.`)
    return true
  }
  log(`Installing ${published.version} (you have ${runtime.version})…`)
  const entry = await installVersion({ layout: lay, version: published.version, integrity: published.integrity, ...(process.env.OPENCODE_BROWSER_NPM_REGISTRY ? { registry: await registryUrl() } : {}) }).catch((error: Error) => {
    log(`✗ ${error.message}`)
    process.exitCode = 1
    return undefined
  })
  if (!entry) return true
  // Asked for by name: no longer skipped (after a rollback), and pending, so the relay may switch to it once idle.
  updateState(lay, ({ skipped: _skipped, ...state }) => ({ ...state, pending: published.version }))
  const current = readCurrent(lay)!
  const refused = await switchTo(lay, published.version, { previous: current.version, force: args.includes("--force") })
  if (refused) {
    const automatic = (autoUpdateOverride() ?? readState(lay).mode ?? "on") === "on"
    log(`! Installed ${published.version}, but the relay didn't restart (${refused}).`)
    log(automatic ? "  It switches to the new version by itself once no agent is using the browser." : `  When no agent is using the browser, run \`${cliCommand("update")}\` again.`)
    return true
  }
  updateState(lay, ({ pending: _pending, ...state }) => ({ ...state, lastUpdate: { from: current.version, to: published.version, at: new Date().toISOString() } }))
  pruneVersions(lay)
  log(`✓ Updated ${current.version} → ${published.version}.`)
  return true
}

/** `runtime-install <version> [--integrity <sri>]`: the relay's installer child. Exit 0 when installed and pending. */
export async function runRuntimeInstall(args: readonly string[]) {
  const layout = runtimeLayout()
  const version = args[0]
  const integrityAt = args.indexOf("--integrity")
  const integrity = integrityAt === -1 ? undefined : args[integrityAt + 1]
  if (!version || !/^\d+\.\d+\.\d+(-beta\.\d+)?$/.test(version)) {
    log(`runtime-install: invalid version ${JSON.stringify(version)}`)
    process.exitCode = 2
    return
  }
  const clear = (installing: AutoUpdateState["installing"]) => (installing?.pid === process.pid ? undefined : installing)
  try {
    await installVersion({ layout, version, ...(integrity ? { integrity } : {}), ...(process.env.OPENCODE_BROWSER_NPM_REGISTRY ? { registry: await registryUrl() } : {}) })
    updateState(layout, ({ installing, lastError: _error, ...state }) => {
      const still = clear(installing)
      return { ...state, ...(still ? { installing: still } : {}), pending: version }
    })
    log(`${new Date().toISOString()} installed ${version}`)
  } catch (error) {
    updateState(layout, ({ installing, ...state }) => {
      const still = clear(installing)
      return { ...state, ...(still ? { installing: still } : {}), lastError: { message: (error as Error).message, at: new Date().toISOString(), version } }
    })
    log(`${new Date().toISOString()} install of ${version} failed: ${(error as Error).message}`)
    process.exitCode = 1
  }
}

/** `runtime-switch <version>`: the relay's switch child. Exit 1 when the relay refused (nothing changed). */
export async function runRuntimeSwitch(args: readonly string[]) {
  const layout = runtimeLayout()
  const version = args[0]
  const current = readCurrent(layout)
  if (!version || !current) {
    process.exitCode = 2
    return
  }
  const refused = await switchTo(layout, version, { previous: current.version, force: false })
  log(`${new Date().toISOString()} switch ${current.version} → ${version}: ${refused ? `refused (${refused})` : "done"}`)
  if (refused) process.exitCode = 1
}
