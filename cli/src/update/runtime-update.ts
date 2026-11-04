// Switching an npm or binary install's version (auto-update.ts has the layout): `update`, `rollback`, and the two commands the
// relay's updater runs in detached children so nothing waits on its event loop:
//   runtime-install <version> [--integrity <sri>]   installs and verifies one version (it starts), records it as pending
//   runtime-switch <version>                         switches to an installed version (exit 1 when refused or broken)
// A switch first runs the version's relay and MCP server on a spare port (verifyStarts), and a version that doesn't
// start never replaces the running relay; auto-update then skips it until a newer one is published. Then it drains the
// running relay (the same safe restart as `relay restart`, refused while a capture, a recording or a raw CDP client is
// busy). Only once it has stopped does current.json move and the new version's relay start, so on a refusal nothing
// changes: no MCP server swaps, and nothing runs a mix of versions. --force ends what's blocking it. If the new relay
// still fails to start, it's stopped, current.json goes back and the old version's relay starts again at once.
import { Effect } from "effect"
import { existsSync, rmSync } from "node:fs"
import {
  channelOf,
  compareVersions,
  effectiveMode,
  UPDATE_VERSION,
  fetchPublished,
  installVersion,
  npmRuntime,
  processAlive,
  pruneVersions,
  readCurrent,
  registryUrl,
  runtimeLayout,
  skipBroken,
  switchVersion,
  updateState,
  verifyStarts,
  versionDirectory,
  versionEntry,
  type AutoUpdateState,
  type Current,
  type Layout,
} from "./auto-update.ts"
import { cliCommand, installCommand } from "../paths.ts"
import * as RelayClient from "../relay/client.ts"
import * as RelayLifecycle from "../relay/lifecycle.ts"

const log = (line: string) => process.stdout.write(line + "\n")

/** Why a switch didn't happen. `broken`: the version's relay didn't start, so auto-update skips it (skipBroken). */
export type Refusal = { readonly message: string; readonly broken?: true }

/**
 * Switches to an installed `version`: checks that its relay starts (on a spare port), drains the running relay, then
 * points current.json at the version (keeping `previous` for rollback) and starts its relay. Undefined when it switched,
 * else why not; current.json is then as it was, and when the old relay had already stopped, it's started again.
 */
export async function switchTo(layout: Layout, version: string, options: { readonly previous: string | undefined; readonly force: boolean }): Promise<Refusal | undefined> {
  const entry = versionEntry(layout, version)
  if (!existsSync(entry)) return { message: `${version} isn't installed` }
  // Before anything stops a relay that works.
  const unstartable = await verifyStarts(layout, version).then(() => undefined, (error: Error) => error.message)
  if (unstartable) return { message: unstartable, broken: true }
  const before: Current | undefined = readCurrent(layout)
  let switched = false
  let launched = false
  /** The new version's relay process, once started. */
  let candidate: number | undefined
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
      // current.json moves once the old relay accepted the shutdown (so its MCP servers stop restarting it), and the new
      // relay starts once it has gone. A refused shutdown reaches neither.
      onShutdownAccepted: point,
      start: Effect.suspend(() => (switched ? Effect.void : point)).pipe(
        Effect.andThen(RelayLifecycle.startManagedRelay(entry)),
        Effect.map((pid) => {
          launched = true
          candidate = pid
        }),
      ),
    })
    // Another relay can start in the gap (an old MCP server's next call); it must be the new version.
    const now = yield* relay.version
    return now.version === version ? undefined : { message: `a relay of version ${now.version} started first` }
  })
  // The old relay stopped and the switch failed after all. The new relay goes (one still starting would take the port),
  // and the old version and its relay come back now rather than at the next agent's call. We stopped that relay, so
  // this starts it whatever OPENCODE_BROWSER_AUTOSTART says.
  const restore = (previous: Current) =>
    Effect.gen(function* () {
      if (candidate !== undefined && processAlive(candidate)) process.kill(candidate, "SIGKILL")
      yield* Effect.try({ try: () => switchVersion(layout, previous.version, previous.previous, previous.binary), catch: (cause) => cause as Error })
      const relay = yield* RelayClient.Service
      const answering = yield* Effect.result(relay.version)
      if (answering._tag === "Failure" && answering.failure instanceof RelayClient.RelayUnreachable)
        yield* RelayLifecycle.startManagedRelay(versionEntry(layout, previous.version))
      const back = yield* RelayLifecycle.waitForRelayReady({ relay })
      if (back.version !== previous.version) return yield* Effect.fail(new Error(`a relay of version ${back.version} answered instead`))
    })
  const message = (error: unknown) => (error as Error).message ?? String(error)
  return Effect.runPromise(program.pipe(
    Effect.catch((error) => Effect.succeed<Refusal>({ message: message(error), ...(launched ? { broken: true as const } : {}) })),
    Effect.flatMap((refused) =>
      refused && switched && before
        ? restore(before).pipe(
            Effect.as(refused),
            Effect.catch((error) => Effect.succeed<Refusal>({ ...refused, message: `${refused.message}; restarting ${before.version} failed too: ${message(error)}` })),
          )
        : Effect.succeed(refused),
    ),
    Effect.provide(RelayClient.layerFetch),
    Effect.catch((error) => Effect.succeed<Refusal>({ message: message(error) })),
  ))
}

function npmOnly(command: string) {
  const runtime = npmRuntime()
  if (runtime) return runtime
  log(`\`${command}\` is for installs that update themselves (\`${installCommand()}\`); this one isn't.`)
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
  if (refused?.broken) {
    log(`✗ Not rolled back: ${refused.message}. ${current.version} keeps running.`)
    process.exitCode = 1
    return
  }
  if (refused) {
    log(`✗ Not rolled back: the relay didn't restart (${refused.message}).`)
    log(`  When no agent is using the browser, run \`${cliCommand("rollback")}\` again (or add --force to end what's blocking it).`)
    process.exitCode = 1
    return
  }
  updateState(layout, ({ pending: _pending, lastError: _error, ...state }) => ({ ...state, skipped: current.version, lastUpdate: { from: current.version, to: previous, at: new Date().toISOString() } }))
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
  if (refused?.broken) {
    skipBroken(lay, published.version, refused.message)
    log(`✗ Installed ${published.version}, but ${refused.message}. ${current.version} keeps running, and auto-update skips ${published.version} until a newer version is published.`)
    process.exitCode = 1
    return true
  }
  if (refused) {
    const automatic = effectiveMode(lay) === "on"
    log(`! Installed ${published.version}, but the relay didn't restart (${refused.message}).`)
    log(automatic ? "  It switches to the new version by itself once no agent is using the browser." : `  When no agent is using the browser, run \`${cliCommand("update")}\` again.`)
    return true
  }
  updateState(lay, ({ pending: _pending, lastError: _error, ...state }) => ({ ...state, lastUpdate: { from: current.version, to: published.version, at: new Date().toISOString() } }))
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
  if (!version || !UPDATE_VERSION.test(version)) {
    log(`runtime-install: invalid version ${JSON.stringify(version)}`)
    process.exitCode = 2
    return
  }
  const clear = (installing: AutoUpdateState["installing"]) => (installing?.pid === process.pid ? undefined : installing)
  try {
    await installVersion({ layout, version, ...(integrity ? { integrity } : {}), ...(process.env.OPENCODE_BROWSER_NPM_REGISTRY ? { registry: await registryUrl() } : {}) })
    // Installed means it runs: one that doesn't start goes, and isn't installed again until a newer one is published.
    const unstartable = await verifyStarts(layout, version).then(() => undefined, (error: Error) => error.message)
    if (unstartable) {
      rmSync(versionDirectory(layout, version), { recursive: true, force: true })
      skipBroken(layout, version, unstartable)
      updateState(layout, ({ installing, ...state }) => {
        const still = clear(installing)
        return { ...state, ...(still ? { installing: still } : {}) }
      })
      log(`${new Date().toISOString()} install of ${version} failed (${unstartable}); skipping ${version} until a newer version is published`)
      process.exitCode = 1
      return
    }
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
  if (refused?.broken) skipBroken(layout, version, refused.message)
  const outcome = refused?.broken ? `failed (${refused.message}); skipping ${version} until a newer version is published` : refused ? `refused (${refused.message})` : "done"
  log(`${new Date().toISOString()} switch ${current.version} → ${version}: ${outcome}`)
  if (refused) process.exitCode = 1
}
