// `update` and `rollback` for npm installs (auto-update.ts has the layout). Both switch runtime/current.json and restart
// the relay through the same safe restart as `relay restart`, which a busy relay refuses (a capture, a recording, a raw
// CDP client); then nothing is switched and the command says so. --force ends what's blocking it, like `relay restart`.
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
  switchVersion,
  updateState,
  versionEntry,
  writeCurrent,
  type Layout,
} from "./auto-update.ts"
import { cliCommand, installCommand } from "./paths.ts"
import * as RelayClient from "./relay-client.ts"
import * as RelayLifecycle from "./relay-lifecycle.ts"

const log = (line: string) => process.stdout.write(line + "\n")

/** Restarts the relay from `entry`; undefined when it restarted (or none was running), else why it didn't. */
async function restartFrom(entry: string, options: { readonly force: boolean }): Promise<string | undefined> {
  const program = Effect.gen(function* () {
    const relay = yield* RelayClient.Service
    const running = yield* Effect.result(relay.version)
    if (running._tag === "Failure") return undefined
    yield* RelayLifecycle.restartRelay({
      relay,
      clientKind: "cli",
      force: options.force,
      otherBuild: true,
      start: RelayLifecycle.startManagedRelay(entry),
    })
    return undefined
  }).pipe(Effect.provide(RelayClient.layerFetch))
  return Effect.runPromise(program.pipe(Effect.catch((error) => Effect.succeed((error as Error).message ?? String(error)))))
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
  // Switch first so the replacement relay (and every new process) runs the previous version, and put it back if the
  // relay refuses to restart, so nothing runs a mix.
  writeCurrent(layout, { version: previous, previous: current.version, channel: channelOf(previous) })
  const refused = await restartFrom(versionEntry(layout, previous), { force: args.includes("--force") })
  if (refused) {
    writeCurrent(layout, current)
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
  const current = readCurrent(lay)!
  switchVersion(lay, published.version, current.version)
  const refused = await restartFrom(entry, { force: args.includes("--force") })
  if (refused) {
    // Leave it installed and pending: the relay switches to it by itself once idle (unless auto-update is off).
    writeCurrent(lay, current)
    // Asked for by name: no longer skipped (after a rollback), so the relay may switch to it once idle.
    updateState(lay, ({ skipped: _skipped, ...state }) => ({ ...state, pending: published.version }))
    const automatic = (autoUpdateOverride() ?? readState(lay).mode ?? "on") === "on"
    log(`! Installed ${published.version}, but the relay didn't restart (${refused}).`)
    log(automatic ? "  It switches to the new version by itself once no agent is using the browser." : `  When no agent is using the browser, run \`${cliCommand("update")}\` again.`)
    return true
  }
  updateState(lay, ({ pending: _pending, skipped: _skipped, ...state }) => ({ ...state, lastUpdate: { from: current.version, to: published.version, at: new Date().toISOString() } }))
  pruneVersions(lay, [published.version, current.version])
  log(`✓ Updated ${current.version} → ${published.version}.`)
  return true
}
