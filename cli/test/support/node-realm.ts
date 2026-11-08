import { spawnSync } from "node:child_process"
import path from "node:path"

export type NodeOutcome = { readonly value?: unknown; readonly error?: string; readonly elapsedMs?: number; readonly maxStallMs?: number; readonly stopped?: string; readonly warnings?: readonly string[] }

// The relay runs execute code under Node, whose vm differs from Bun's: escape attempts run there too.
// `home` is the OPENCODE_BROWSER_HOME the Node child runs with.
export function nodeRealmRunner(home: string) {
  return (bodies: readonly string[], setup = "", env: Record<string, string> = {}): NodeOutcome[] => {
    const script = `
      const { ExecuteRealm, sandboxModules, createExecuteFiles, handleExecuteRealmRejection, handleExecuteRealmException } = await import(${JSON.stringify(path.join(import.meta.dir, "../../src/execute-realm.ts"))})
      // The relay's process guard, reduced to the execute part.
      process.on('unhandledRejection', (reason, promise) => { if (!handleExecuteRealmRejection(promise, reason)) throw reason })
      process.on('uncaughtException', (error) => { if (!handleExecuteRealmException(error)) { console.error(error); process.exit(70) } })
      const host = { fn: () => 1, object: { nested: true }, error: () => { throw new Error("host") } }
      ${setup}
      const results = []
      for (const body of JSON.parse(process.argv[1])) {
        const warnings = []
        const realm = new ExecuteRealm({ onUnhandledRejection: warning => warnings.push(warning) })
        // How long the relay's event loop (other sessions, the HTTP API) went without a turn.
        let last = performance.now(), maxStallMs = 0
        const probe = setInterval(() => { const now = performance.now(); maxStallMs = Math.max(maxStallMs, now - last); last = now }, 5)
        const started = performance.now()
        try {
          realm.proxyAsObject(host)
          if (host.files) realm.proxyAsObject(host.files)
          if (host.modules) realm.proxyAsObject(host.modules)
          const value = await realm.run({ source: "(async (host) => { " + body + " })", filename: "test.js", args: [host] })
          const elapsedMs = performance.now() - started
          await new Promise(resolve => setTimeout(resolve, 20)) // let the probe see the last stall, and a detached rejection land
          results.push({ value, elapsedMs, maxStallMs, stopped: realm.stopped?.message, warnings })
        } catch (error) {
          const elapsedMs = performance.now() - started
          await new Promise(resolve => setTimeout(resolve, 20))
          results.push({ error: String(error?.message ?? error), elapsedMs, maxStallMs, stopped: realm.stopped?.message, warnings })
        } finally {
          clearInterval(probe)
          realm.dispose()
          host.emitConsole?.()
          host.page?.removeAllListeners?.()
        }
      }
      console.log(JSON.stringify(results))
    `
    const child = spawnSync("node", ["--input-type=module", "--no-warnings", "-e", script, JSON.stringify(bodies)], { encoding: "utf8", timeout: 30_000, env: { ...process.env, OPENCODE_BROWSER_HOME: home, ...env } })
    if (child.status !== 0) throw new Error(`node failed: ${child.stderr}`)
    return JSON.parse(child.stdout.trim().split("\n").at(-1) ?? "[]") as NodeOutcome[]
  }
}

/** Outcomes without timing, for exact comparisons. */
export const values = (outcomes: readonly NodeOutcome[]) => outcomes.map(({ value, error }) => (error === undefined ? { value } : { error }))

export type ConcurrentNodeOutcome = {
  readonly outcomes: readonly NodeOutcome[]
  /** Wall time from starting all realms to the last one finishing. */
  readonly wallMs: number
  /** Relay thread CPU time used over the same span. */
  readonly cpuMs: number
  readonly maxStallMs: number
}

// Several realms in one Node child, all running at once on the relay's one event loop. Setup can add
// host helpers; every body gets the same `host` object.
export function concurrentNodeRealmRunner(home: string) {
  return (bodies: readonly string[], setup = "", env: Record<string, string> = {}): ConcurrentNodeOutcome => {
    const script = `
      const { ExecuteRealm, handleExecuteRealmRejection, handleExecuteRealmException } = await import(${JSON.stringify(path.join(import.meta.dir, "../../src/execute-realm.ts"))})
      // The relay's process guard, reduced to the execute part.
      process.on('unhandledRejection', (reason, promise) => { if (!handleExecuteRealmRejection(promise, reason)) throw reason })
      process.on('uncaughtException', (error) => { if (!handleExecuteRealmException(error)) { console.error(error); process.exit(70) } })
      const host = {
        busy: (ms) => { const end = performance.now() + ms; while (performance.now() < end) {} },
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      }
      ${setup}
      const bodies = JSON.parse(process.argv[1])
      const realms = bodies.map(() => {
        const realm = new ExecuteRealm()
        realm.proxyAsObject(host)
        return realm
      })
      let last = performance.now(), maxStallMs = 0
      const probe = setInterval(() => { const now = performance.now(); maxStallMs = Math.max(maxStallMs, now - last); last = now }, 5)
      const cpuBefore = process.threadCpuUsage()
      const started = performance.now()
      const outcomes = await Promise.all(bodies.map(async (body, index) => {
        const realm = realms[index]
        try {
          const value = await realm.run({ source: "(async (host) => { " + body + " })", filename: "test.js", args: [host] })
          return { value, stopped: realm.stopped?.message }
        } catch (error) {
          return { error: String(error?.message ?? error), stopped: realm.stopped?.message }
        } finally {
          realm.dispose()
        }
      }))
      const wallMs = performance.now() - started
      const cpu = process.threadCpuUsage(cpuBefore)
      await new Promise((resolve) => setTimeout(resolve, 20))
      clearInterval(probe)
      console.log(JSON.stringify({ outcomes, wallMs, cpuMs: (cpu.user + cpu.system) / 1000, maxStallMs }))
    `
    const child = spawnSync("node", ["--input-type=module", "--no-warnings", "-e", script, JSON.stringify(bodies)], { encoding: "utf8", timeout: 30_000, env: { ...process.env, OPENCODE_BROWSER_HOME: home, ...env } })
    if (child.status !== 0) throw new Error(`node failed: ${child.stderr}`)
    return JSON.parse(child.stdout.trim().split("\n").at(-1) ?? "{}") as ConcurrentNodeOutcome
  }
}

const budgetModule = () => JSON.stringify(path.join(import.meta.dir, "../../src/execute-realm/cpu-budget.ts"))
const globalsModule = () => JSON.stringify(path.join(import.meta.dir, "../../src/execute-realm/globals.ts"))

function runProbe(script: string, home: string, sliceMs: number): string {
  const child = spawnSync("node", ["--input-type=module", "--no-warnings", "-e", script], { encoding: "utf8", timeout: 30_000, env: { ...process.env, OPENCODE_BROWSER_HOME: home, OPENCODE_BROWSER_EXECUTE_SLICE_MS: String(sliceMs) } })
  if (child.status !== 0) throw new Error(`node failed: ${child.stderr}`)
  return child.stdout.trim().split("\n").at(-1) ?? "{}"
}

export type QueueHandoffTimings = { readonly cancelWaitMs: number; readonly releaseWaitMs: number }

/**
 * Queue timings for turns that end without running sandbox code: one waiter is cancelled, another is
 * released. Both must reach the next waiter immediately rather than at the fallback timer.
 */
export function cpuQueueProbe(home: string, sliceMs: number): QueueHandoffTimings {
  const script = `
    const { chargeExecuteCpu, waitForExecuteTurn, releaseExecuteTurn, cancelExecuteWaiters } = await import(${budgetModule()})
    const wait = (owner) => {
      const turn = waitForExecuteTurn(owner)
      if (turn === undefined) throw new Error("expected to wait")
      return turn
    }
    const a = {}, b = {}, c = {}
    chargeExecuteCpu({}, ${sliceMs * 1.6})
    const turnA = wait(a), turnB = wait(b), turnC = wait(c)
    await turnA
    const cancelStarted = performance.now()
    cancelExecuteWaiters(b)
    await turnC
    const cancelWaitMs = performance.now() - cancelStarted

    const d = {}, e = {}
    chargeExecuteCpu({}, ${sliceMs * 1.6})
    const turnD = wait(d), turnE = wait(e)
    await turnD
    const releaseStarted = performance.now()
    releaseExecuteTurn()
    await turnE
    const releaseWaitMs = performance.now() - releaseStarted
    console.log(JSON.stringify({ cancelWaitMs, releaseWaitMs }))
  `
  return JSON.parse(runProbe(script, home, sliceMs)) as QueueHandoffTimings
}

export type QueuedTimerOutcome = { readonly firstRan: boolean; readonly secondDelayMs: number | null }

/**
 * Two realm timers queue behind a charged relay window; the first is cleared after it has queued and
 * before its turn. The second must run as soon as the grant comes, not one fallback slice later.
 */
export function clearedQueuedTimerProbe(home: string, sliceMs: number): QueuedTimerOutcome {
  const script = `
    import vm from "node:vm"
    const { chargeExecuteCpu } = await import(${budgetModule()})
    const { installRealmGlobals } = await import(${globalsModule()})
    const target = vm.createContext({})
    const realm = {
      stopped: undefined, nextTimer: 0, timers: new Map(), context: target,
      toSandbox: (value) => value, toHost: (value) => value,
      dispose(error) { this.stopped = error; for (const timer of this.timers.values()) clearTimeout(timer); this.timers.clear() },
    }
    installRealmGlobals(realm, target)
    chargeExecuteCpu({}, ${sliceMs * 1.6})
    let firstRan = false, secondAt
    const first = target.setTimeout(() => { firstRan = true }, 0)
    target.setTimeout(() => { secondAt = performance.now() }, 0)
    // After both timers have fired and queued, and before the budget frees.
    const clearedAt = performance.now() + ${Math.round(sliceMs / 6)}
    setTimeout(() => target.clearTimeout(first), ${Math.round(sliceMs / 6)})
    await new Promise((resolve) => setTimeout(resolve, ${sliceMs * 3}))
    console.log(JSON.stringify({ firstRan, secondDelayMs: secondAt === undefined ? null : secondAt - clearedAt }))
  `
  return JSON.parse(runProbe(script, home, sliceMs)) as QueuedTimerOutcome
}
