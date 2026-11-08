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
