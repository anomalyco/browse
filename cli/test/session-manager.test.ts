import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { ExecuteResult } from "../src/execute.ts"
import { ExecuteRealm } from "../src/execute-realm.ts"
import { HandoffRegistry } from "../src/handoff.ts"
import type { ExecuteSandboxLike } from "../src/relay-types.ts"
import { OpenCodeBrowserSessions } from "../src/session-manager.ts"

const ok = (text: string): ExecuteResult => ({
  text,
  isError: false,
  logs: [],
  logSummary: { totalCount: 0, returnedCount: 0, repeatedCount: 0, omittedCount: 0 },
  warnings: [],
})

/**
 * A sandbox whose scripts are promises the test controls. `abortExecution` behaves like the real one closing the
 * browser connection: a script waiting on Playwright fails, one waiting on something else (a stuck loop) doesn't.
 */
class FakeSandbox implements ExecuteSandboxLike {
  aborted = 0
  executions = 0
  private abortWaiters: Array<() => void> = []
  constructor(readonly script: (sandbox: FakeSandbox) => Promise<ExecuteResult>) {}
  execute() {
    this.executions += 1
    return Effect.promise(() => this.script(this))
  }
  /** Resolves when the sandbox is aborted, as a Playwright call rejects when its connection closes. */
  playwrightCall(): Promise<never> {
    return new Promise((_, reject) => this.abortWaiters.push(() => reject(new Error("Target page, context or browser has been closed"))))
  }
  abortExecution() {
    this.aborted += 1
    for (const waiter of this.abortWaiters.splice(0)) waiter()
    return Effect.void
  }
  disconnectSettled() { return Effect.void }
  closeSettled() { return Effect.void }
  authenticatedJson(): never { throw new Error("unused") }
  adoptPage() { return Effect.void }
  networkStart(): never { throw new Error("unused") }
  networkStatus() { return { active: false } as never }
  networkStop(): never { throw new Error("unused") }
  networkCancel() { return Effect.succeed({ cancelled: false }) }
  networkEnd() { return Effect.succeed({ cancelled: false }) }
  authRefresh(): never { throw new Error("unused") }
  redactNetworkCaptureText(text: string) { return text }
  markTargetCrashed() { return false }
  markTargetProtectedUi() { return false }
  markTargetDetached() { return false }
  markTargetReplaced() { return false }
  restore() {}
  getStatus() { return { connected: true, pageUrl: null, stateKeys: [] } }
}

function manager(script: (sandbox: FakeSandbox) => Promise<ExecuteResult>, options: { readonly handoffs?: HandoffRegistry } = {}) {
  const sandboxes: FakeSandbox[] = []
  const sessions = new OpenCodeBrowserSessions("http://127.0.0.1:0", () => {
    const sandbox = new FakeSandbox(script)
    sandboxes.push(sandbox)
    return sandbox
  }, {
    stopGraceMs: 300,
    lifecycleTimeoutMs: 5_000,
    ...(options.handoffs ? { onCancelSessionHandoff: (id: string) => options.handoffs?.cancelForSession(id) !== undefined } : {}),
  })
  return { sessions, sandboxes }
}

const run = <A>(effect: Effect.Effect<A, unknown>) => Effect.runPromise(effect as Effect.Effect<A, never>)

/** Starts an execute and waits until its script is running; returns the pending response. */
async function startExecute(sessions: OpenCodeBrowserSessions, sessionId: string) {
  const response = run(sessions.execute({ sessionId, code: "...", createIfMissing: true }))
  for (let attempt = 0; attempt < 50 && !sessions.isExecuting(sessionId); attempt++) await Bun.sleep(5)
  expect(sessions.isExecuting(sessionId)).toBe(true)
  // Wrapped: an async function returning the promise itself would wait for it.
  return { response }
}

describe("stopping an execute", () => {
  test("the toolbar stop answers the caller, aborts the script and releases the lock", async () => {
    const { sessions, sandboxes } = manager(async (sandbox) => {
      // A script that keeps using the page: its next Playwright call rejects once the sandbox is aborted.
      if (sandbox.executions === 1) await sandbox.playwrightCall()
      return ok("second")
    })
    const { response: first } = await startExecute(sessions, "s1")
    expect(sessions.stopExecution("s1", "The user took the tab back")).toBe(true)
    const stopped = await first
    expect(stopped.result.isError).toBe(true)
    expect(stopped.result.text).toBe("The user took the tab back")
    expect(stopped.result.diagnostic).toBe("user-stopped")
    expect(sandboxes[0]?.aborted).toBe(1)
    // The lock is free: the next execute runs on the same sandbox (its state kept).
    const second = await run(sessions.execute({ sessionId: "s1", code: "...", createIfMissing: false }))
    expect(second.result.text).toBe("second")
    expect(sandboxes.length).toBe(1)
  })

  test("a script that ignores the stop is abandoned after the grace period", async () => {
    const { sessions, sandboxes } = manager(async (sandbox) => {
      // Never settles: the stop's abort doesn't reach it (a stuck await).
      if (sandbox.executions === 1 && sandboxes.indexOf(sandbox) === 0) await new Promise(() => {})
      return ok("after")
    })
    const { response: first } = await startExecute(sessions, "s2")
    const started = Date.now()
    sessions.stopExecution("s2", "stop")
    expect((await first).result.isError).toBe(true)
    const next = await run(sessions.execute({ sessionId: "s2", code: "...", createIfMissing: false }))
    expect(next.result.text).toBe("after")
    expect(Date.now() - started).toBeLessThan(2_000)
    // The session moved on with a fresh sandbox.
    expect(sandboxes.length).toBe(2)
    expect(sessions.isExecuting("s2")).toBe(false)
  })

  test("stopExecution is false when nothing runs", () => {
    const { sessions } = manager(async () => ok("x"))
    expect(sessions.stopExecution("missing", "stop")).toBe(false)
  })
})

describe("delete and reset while busy", () => {
  test("delete stops a running execute and returns promptly", async () => {
    const { sessions } = manager(async (sandbox) => {
      await sandbox.playwrightCall()
      return ok("never")
    })
    const { response } = await startExecute(sessions, "d1")
    const started = Date.now()
    const deleted = await run(sessions.delete("d1"))
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(deleted).toEqual({ deleted: true, stopped: { execute: true, handoff: false, forced: false } })
    const result = await response
    expect(result.result.isError).toBe(true)
    expect(result.result.text).toContain("was deleted")
    expect(result.result.diagnostic).toBe("session-delete")
    expect(sessions.summary("d1")).toBeUndefined()
  })

  test("delete during a waiting handoff cancels it and returns within seconds", async () => {
    let next = 0
    const handoffs = new HandoffRegistry(() => `h${++next}`)
    let handoffError: string | undefined
    const { sessions } = manager(async () => {
      // A handoff that would wait ten minutes for the user.
      const wait = handoffs.wait({ sessionId: "d2", tabId: 1, targetId: "T1", targetSessionId: "S1", message: "Sign in", timeoutMs: 600_000 })
      const outcome = await wait.outcome
      handoffError = typeof outcome === "object" ? outcome.reason : outcome
      throw new Error("handoff cancelled")
    }, { handoffs })
    const { response } = await startExecute(sessions, "d2")
    await Bun.sleep(20)
    expect(handoffs.pendingForSession("d2")).toBeDefined()
    const started = Date.now()
    const deleted = await run(sessions.delete("d2"))
    expect(Date.now() - started).toBeLessThan(3_000)
    expect(deleted.deleted).toBe(true)
    expect(deleted.stopped).toEqual({ execute: true, handoff: true, forced: false })
    expect(handoffError).toBe("session-stopped")
    expect(handoffs.pendingCount).toBe(0)
    expect((await response).result.text).toContain("was deleted")
  })

  test("reset stops a stuck script, reports it forced, and gives the session a fresh sandbox", async () => {
    const { sessions, sandboxes } = manager(async () => {
      await new Promise(() => {})
      return ok("never")
    })
    const { response } = await startExecute(sessions, "r1")
    const started = Date.now()
    const reset = await run(sessions.reset("r1"))
    expect(Date.now() - started).toBeLessThan(3_000)
    expect(reset?.session.id).toBe("r1")
    expect(reset?.stopped).toEqual({ execute: true, handoff: false, forced: true })
    expect((await response).result.text).toContain("was reset")
    expect(sandboxes.length).toBeGreaterThanOrEqual(2)
    expect(sessions.isExecuting("r1")).toBe(false)
  })

  test("delete of an idle session reports nothing stopped", async () => {
    const { sessions } = manager(async () => ok("x"))
    await run(sessions.execute({ sessionId: "idle", code: "...", createIfMissing: true }))
    expect(await run(sessions.delete("idle"))).toEqual({ deleted: true })
  })
})

describe("closing a session's pages", () => {
  test("delete and reset close every page the session opened, not just its default page", async () => {
    const closed: string[] = []
    const pages: Record<string, string[]> = { many: ["T-default", "T-new-page", "T-popup"], again: ["T-other"] }
    const sessions = new OpenCodeBrowserSessions("http://127.0.0.1:0", () => new FakeSandbox(async () => ok("x")), {
      lifecycleTimeoutMs: 5_000,
      onReleaseRelayTarget: (targetId) => Effect.sync(() => { closed.push(targetId) }),
      relayTargetIdsForSession: (id) => pages[id] ?? [],
    })
    await run(sessions.execute({ sessionId: "many", code: "...", createIfMissing: true }))
    expect(await run(sessions.delete("many"))).toEqual({ deleted: true })
    expect(closed.sort()).toEqual(["T-default", "T-new-page", "T-popup"])
    closed.length = 0
    await run(sessions.execute({ sessionId: "again", code: "...", createIfMissing: true }))
    await run(sessions.reset("again"))
    expect(closed).toEqual(["T-other"])
  })
})

describe("realm timers", () => {
  test("dispose clears pending timers and refuses new ones", async () => {
    const realm = new ExecuteRealm()
    const fired: string[] = []
    const record = realm.toSandbox((name: string) => fired.push(name))
    await realm.run({
      source: "(async function (record) { setTimeout(() => record('timeout'), 30); setInterval(() => record('interval'), 10); setImmediate(() => record('immediate')) })",
      filename: "timers.js",
      args: [record],
    })
    expect(realm.pendingTimers).toBe(3)
    realm.dispose()
    expect(realm.pendingTimers).toBe(0)
    expect(realm.isStopped).toBe(true)
    await Bun.sleep(60)
    expect(fired).toEqual([])
    await expect(realm.run({ source: "(async function (record) { setTimeout(() => record('late'), 1) })", filename: "late.js", args: [record] })).rejects.toThrow("Execute stopped")
    await Bun.sleep(20)
    expect(fired).toEqual([])
  })
})
