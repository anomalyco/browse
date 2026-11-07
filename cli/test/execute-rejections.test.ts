import { afterAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "browse-rejections-"))
const home = path.join(scratch, "home")
fs.mkdirSync(home, { recursive: true })
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }))

/** The relay's full-Node rejection scope under Node, where the promise hook exists. */
function runNodeScope(script: string): Record<string, any> {
  const child = spawnSync("node", ["--input-type=module", "--no-warnings", "-e", script], {
    encoding: "utf8",
    timeout: 15_000,
    env: { ...process.env, OPENCODE_BROWSER_HOME: home },
  })
  if (child.status !== 0) throw new Error(`node failed: ${child.stderr}`)
  return JSON.parse(child.stdout.trim().split("\n").at(-1) ?? "{}") as Record<string, any>
}

describe("full-Node rejection scope", () => {
  test("tags a synchronous call and inherits the owner through await continuations", () => {
    const outcome = runNodeScope(`
      const { ExecuteRejectionScope } = await import(${JSON.stringify(path.join(import.meta.dir, "../src/execute/rejection-scope.ts"))})
      const { handleExecuteRealmRejection } = await import(${JSON.stringify(path.join(import.meta.dir, "../src/execute-realm.ts"))})
      const handled = []
      process.on("unhandledRejection", (reason, promise) => {
        handled.push({ message: reason instanceof Error ? reason.message : "non-error", handled: handleExecuteRealmRejection(promise, reason) })
      })
      const warningsA = []
      const warningsB = []
      const a = new ExecuteRejectionScope({ onRejection: warning => warningsA.push(warning) })
      const b = new ExecuteRejectionScope({ onRejection: warning => warningsB.push(warning) })
      a.begin()
      b.begin()
      // The root promise is created by the synchronous call; the child is created after an await.
      const rootA = a.invoke(() => (async () => {
        await new Promise(resolve => setTimeout(resolve, 0))
        Promise.reject(new Error("child-a"))
      })())
      const rootB = b.invoke(() => Promise.reject(new Error("root-b")))
      // Created while both scopes are open but with no owner: neither scope may claim it.
      const host = Promise.reject(new Error("host"))
      void rootA; void rootB; void host
      await new Promise(resolve => setTimeout(resolve, 100))
      a.end()
      b.end()
      // The hook is released once both scopes end.
      const after = Promise.reject(new Error("after"))
      void after
      await new Promise(resolve => setTimeout(resolve, 100))
      console.log(JSON.stringify({ handled, warningsA, warningsB }))
    `)

    const handled = (outcome.handled as Array<{ message: string; handled: boolean }>).sort((a, b) => a.message.localeCompare(b.message))
    expect(handled).toEqual([
      { message: "after", handled: false },
      { message: "child-a", handled: true },
      { message: "host", handled: false },
      { message: "root-b", handled: true },
    ])
    expect(outcome.warningsA).toHaveLength(1)
    expect(outcome.warningsA[0]).toContain("child-a")
    expect(outcome.warningsB).toHaveLength(1)
    expect(outcome.warningsB[0]).toContain("root-b")
  }, 20_000)

  test("restores the owner after a synchronous throw and after overlapping calls", () => {
    const outcome = runNodeScope(`
      const { ExecuteRejectionScope } = await import(${JSON.stringify(path.join(import.meta.dir, "../src/execute/rejection-scope.ts"))})
      const { handleExecuteRealmRejection } = await import(${JSON.stringify(path.join(import.meta.dir, "../src/execute-realm.ts"))})
      const handled = []
      process.on("unhandledRejection", (reason, promise) => {
        handled.push({ message: reason instanceof Error ? reason.message : "non-error", handled: handleExecuteRealmRejection(promise, reason) })
      })
      const a = new ExecuteRejectionScope({ onRejection: () => {} })
      const b = new ExecuteRejectionScope({ onRejection: () => {} })
      a.begin()
      try { a.invoke(() => { throw new Error("sync") }) } catch {}
      b.begin()
      b.invoke(() => Promise.resolve(undefined))
      // Neither a failed invoke nor b's invoke may leave a or b as the active owner.
      const untagged = Promise.reject(new Error("untagged"))
      void untagged
      await new Promise(resolve => setTimeout(resolve, 50))
      a.end()
      b.end()
      console.log(JSON.stringify({ handled }))
    `)
    expect(outcome.handled).toEqual([{ message: "untagged", handled: false }])
  }, 20_000)

  test("a rejection while the call is pending fails the call without a duplicate warning", () => {
    const outcome = runNodeScope(`
      const { ExecuteRealm, handleExecuteRealmRejection } = await import(${JSON.stringify(path.join(import.meta.dir, "../src/execute-realm.ts"))})
      const warnings = []
      process.on("unhandledRejection", (reason, promise) => {
        if (!handleExecuteRealmRejection(promise, reason)) process.exit(70)
      })
      const realm = new ExecuteRealm({ onUnhandledRejection: warning => warnings.push(warning) })
      const result = await realm.run({
        source: "(async () => { Promise.reject(new Error('during-call')); await new Promise(() => {}) })",
        filename: "test.js",
        args: [],
      }).then(value => ({ value }), error => ({ error: error.message }))
      await new Promise(resolve => setTimeout(resolve, 50))
      console.log(JSON.stringify({ result, warnings }))
    `)
    expect(outcome.result.error).toMatch(/Unhandled execute rejection: a non-Error value/)
    expect(outcome.warnings).toEqual([])
  }, 20_000)

  test("a scope that never settles releases the promise hook when it expires", () => {
    const outcome = runNodeScope(`
      const { ExecuteRejectionScope } = await import(${JSON.stringify(path.join(import.meta.dir, "../src/execute/rejection-scope.ts"))})
      const { handleExecuteRealmRejection } = await import(${JSON.stringify(path.join(import.meta.dir, "../src/execute-realm.ts"))})
      const handled = []
      process.on("unhandledRejection", (reason, promise) => {
        handled.push(handleExecuteRealmRejection(promise, reason))
      })
      const scope = new ExecuteRejectionScope({ expiryMs: 20 })
      scope.begin()
      // No end(): a call that never settles. The expiry must release the hook anyway.
      scope.invoke(() => new Promise(() => {}))
      await new Promise(resolve => setTimeout(resolve, 60))
      const after = scope.invoke(() => Promise.reject(new Error("after-expiry")))
      void after
      await new Promise(resolve => setTimeout(resolve, 50))
      console.log(JSON.stringify({ handled }))
    `)
    expect(outcome.handled).toEqual([false])
  }, 20_000)

  test("describing a hostile rejection never runs its toString", () => {
    const nodeOutcome = runNodeScope(`
      const { safeErrorMessage, safeErrorStack } = await import(${JSON.stringify(path.join(import.meta.dir, "../src/execute-realm/rejection-text.ts"))})
      const value = { toString() { for(;;){} } }
      console.log(JSON.stringify({ message: safeErrorMessage(value), stack: safeErrorStack(value) }))
    `)
    expect(nodeOutcome).toEqual({ message: "a non-Error value" })

    const script = `
      const { handleRelayProcessFault } = await import(${JSON.stringify(path.join(import.meta.dir, "../src/relay/process-guard.ts"))})
      handleRelayProcessFault("unhandledRejection", { toString() { for (;;) {} } }, {}, { rethrow: () => {} })
      console.log("returned")
    `
    const child = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 5_000, env: { ...process.env, OPENCODE_BROWSER_HOME: home } })
    expect(child.status, child.stderr).toBe(0)
    expect(child.stdout).toContain("returned")
  }, 20_000)
})
