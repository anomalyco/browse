import { describe, expect, test } from "bun:test"
import { Effect, Fiber } from "effect"
import { boundExecuteResult, jsonValueWarning, maxExecuteResultChars, toJsonSafeValue, type ExecuteOptions, type ExecuteResult } from "../src/execute.ts"
import { ExecuteRealm } from "../src/execute-realm.ts"
import { HandoffRegistry } from "../src/session-manager/handoff.ts"
import type { ConnectedTarget, ExecuteSandboxLike } from "../src/relay/types.ts"
import { OpenCodeBrowserSessions } from "../src/session-manager.ts"

const ok = (text: string): ExecuteResult => ({
  text,
  isError: false,
  logs: [],
  logSummary: { totalCount: 0, returnedCount: 0, repeatedCount: 0, omittedCount: 0 },
  warnings: [],
})

/**
 * A sandbox whose scripts are promises the test controls. `stopRealm` behaves like the real one stopping user code,
 * and `disconnectSettled` like closing the browser connection: a script waiting on Playwright fails, one waiting on
 * something else (a stuck loop) doesn't.
 */
class FakeSandbox implements ExecuteSandboxLike {
  /** Browser connections closed. */
  aborted = 0
  /** Realms stopped; user code stops here. */
  realmStops = 0
  executions = 0
  readonly calls: Array<ExecuteOptions | undefined> = []
  private abortWaiters: Array<() => void> = []
  constructor(readonly script: (sandbox: FakeSandbox) => Promise<ExecuteResult>) {}
  execute(_code: string, options?: ExecuteOptions) {
    this.calls.push(options)
    this.executions += 1
    return Effect.promise(() => this.script(this))
  }
  /** Resolves when the sandbox is aborted, as a Playwright call rejects when its connection closes. */
  playwrightCall(): Promise<never> {
    return new Promise((_, reject) => this.abortWaiters.push(() => reject(new Error("Target page, context or browser has been closed"))))
  }
  stopRealm() {
    this.realmStops += 1
  }
  disconnectSettled() {
    this.aborted += 1
    for (const waiter of this.abortWaiters.splice(0)) waiter()
    return Effect.void
  }
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

function manager(script: (sandbox: FakeSandbox) => Promise<ExecuteResult>, options: {
  readonly handoffs?: HandoffRegistry
  readonly executeTimeoutMs?: number
  readonly onSessionDeleted?: (sessionId: string) => void
  readonly onStoppingExecute?: () => Effect.Effect<void>
  readonly browser?: { readonly id: string; readonly key: string }
  readonly checkBrowserResponsive?: () => Effect.Effect<void, Error>
} = {}) {
  const sandboxes: FakeSandbox[] = []
  const browser = options.browser
  const checkBrowserResponsive = options.checkBrowserResponsive
  const sessions = new OpenCodeBrowserSessions("http://127.0.0.1:0", () => {
    const sandbox = new FakeSandbox(script)
    sandboxes.push(sandbox)
    return sandbox
  }, {
    stopGraceMs: 300,
    lifecycleTimeoutMs: 5_000,
    ...(options.executeTimeoutMs === undefined ? {} : { executeTimeoutMs: options.executeTimeoutMs }),
    ...(options.onSessionDeleted ? { onSessionDeleted: options.onSessionDeleted } : {}),
    ...(options.onStoppingExecute ? { onStoppingExecute: options.onStoppingExecute } : {}),
    ...(browser ? { resolveBrowser: () => browser } : {}),
    ...(checkBrowserResponsive ? { checkBrowserResponsive } : {}),
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

  test("a stop stops the realm, then cancels the pending navigation, then closes the connection", async () => {
    const calls: string[] = []
    const { sessions, sandboxes } = manager(async (sandbox) => {
      if (sandbox.executions === 1) await sandbox.playwrightCall()
      return ok("next")
    }, {
      onStoppingExecute: () => Effect.sync(() => {
        calls.push(`cancel realmStops=${sandboxes[0]?.realmStops} connections=${sandboxes[0]?.aborted}`)
      }),
    })
    const { response } = await startExecute(sessions, "nav")
    expect(sessions.stopExecution("nav", "stop")).toBe(true)
    expect((await response).result.isError).toBe(true)
    for (let i = 0; i < 100 && sandboxes[0]?.aborted !== 1; i++) await Bun.sleep(5)
    // User code stopped before the cancel, and the browser connection closing that the script awaits comes last.
    expect(calls).toEqual(["cancel realmStops=1 connections=0"])
    expect(sandboxes[0]?.realmStops).toBe(1)
    expect(sandboxes[0]?.aborted).toBe(1)
  })

  test("a timeout cancels the session's pending navigation too", async () => {
    let calls = 0
    const { sessions, sandboxes } = manager(async (sandbox) => {
      if (sandbox.executions === 1) await sandbox.playwrightCall()
      return ok("next")
    }, { onStoppingExecute: () => Effect.sync(() => { calls += 1 }) })
    const timedOut = await run(sessions.execute({ sessionId: "nav-timeout", code: "...", createIfMissing: true, timeoutMs: 20 }))
    expect(timedOut.result.diagnostic).toBe("execute-timeout")
    for (let i = 0; i < 100 && sandboxes[0]?.aborted !== 1; i++) await Bun.sleep(5)
    expect(calls).toBe(1)
  })
})

describe("delete and reset while busy", () => {
  test("delete reports the session to the deleted hook", async () => {
    const deleted: string[] = []
    const { sessions } = manager(async () => ok("x"), { onSessionDeleted: (sessionId) => { deleted.push(sessionId) } })

    await run(sessions.execute({ sessionId: "d0", code: "...", createIfMissing: true }))
    expect(await run(sessions.delete("d0"))).toEqual({ deleted: true })
    expect(deleted).toEqual(["d0"])
  })

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

describe("execute result size", () => {
  test("a result under the limit passes through untouched", () => {
    expect(boundExecuteResult("ok", { a: 1 }, true)).toEqual({ text: "ok", value: { a: 1 }, hasValue: true })
  })

  test("a huge result keeps the start of its text, drops the value, and says how to save all of it", () => {
    const big = "x".repeat(maxExecuteResultChars * 3)
    const bounded = boundExecuteResult(big, big, true)
    expect(bounded.hasValue).toBe(false)
    expect(bounded.text.length).toBeLessThan(maxExecuteResultChars + 100)
    expect(bounded.text).toContain("[truncated")
    expect(bounded.warning).toContain("files.write")
    // A large JSON value with a short inspected text is capped as well.
    const rows = Array.from({ length: 20_000 }, (_, i) => ({ row: i, text: "lorem ipsum dolor" }))
    expect(boundExecuteResult("[ ... 20000 items ]", rows, true).hasValue).toBe(false)
  })
})

describe("execute JSON value warning", () => {
  const warningFor = (value: unknown) => jsonValueWarning(value, toJsonSafeValue(value))

  test("code that returns nothing gets no warning", () => {
    expect(warningFor(undefined)).toBeUndefined()
  })

  test("a returned class instance still says why it has no JSON value", () => {
    class Locator {}
    expect(warningFor(new Locator())).toBe("Execute result could not be represented as JSON value: class instance")
  })
})

describe("execute timeouts, disconnects, one-shot cleanup, and idle reaping", () => {
  const rootTab = (id: string, sessionId: string | undefined, owner: "relay" | "user" = "relay"): ConnectedTarget => ({
    tabId: id.length,
    sessionId: `cdp-${id}`,
    owner,
    ...(sessionId ? { opencodeBrowserSessionId: sessionId } : {}),
    targetInfo: { targetId: id, type: "page", title: id, url: "about:blank", attached: true, canAccessOpener: false },
  })

  test("timeoutMs stops a hung script with execute-timeout and frees the session", async () => {
    const { sessions, sandboxes } = manager(async (sandbox) => {
      if (sandbox.executions === 1) await sandbox.playwrightCall()
      return ok("recovered")
    })
    const timedOut = await run(sessions.execute({ sessionId: "t1", code: "...", createIfMissing: true, timeoutMs: 40 }))
    expect(timedOut.result.isError).toBe(true)
    expect(timedOut.result.diagnostic).toBe("execute-timeout")
    expect(timedOut.result.text).toContain("Execute timed out after 40ms")
    expect(sandboxes[0]?.aborted).toBe(1)

    const next = await run(sessions.execute({ sessionId: "t1", code: "...", createIfMissing: false, timeoutMs: 1_000 }))
    expect(next.result.text).toBe("recovered")
  })

  test("a queued execute's own timeout runs while it waits for the session's execute lock", async () => {
    const { sessions, sandboxes } = manager(async (sandbox) => {
      if (sandbox.executions === 1) await sandbox.playwrightCall()
      return ok("second")
    })
    const first = run(sessions.execute({ sessionId: "t-queued", code: "first", createIfMissing: true, timeoutMs: 0 }))
    for (let i = 0; i < 50 && !sessions.isExecuting("t-queued"); i++) await Bun.sleep(5)
    expect(sessions.isExecuting("t-queued")).toBe(true)

    const started = Date.now()
    const second = await Promise.race([
      run(sessions.execute({ sessionId: "t-queued", code: "second", createIfMissing: false, timeoutMs: 40 })),
      Bun.sleep(2_000).then(() => "still waiting" as const),
    ])
    expect(second).not.toBe("still waiting")
    if (second === "still waiting") throw new Error("queued execute ignored its timeout")
    expect(second.result.diagnostic).toBe("execute-queued-timeout")
    expect(second.result.text).toContain("while this session was still busy with another execute; this code did not run")
    expect(Date.now() - started).toBeLessThan(2_000)
    // User code never ran under the expired call.
    expect(sandboxes[0]?.executions).toBe(1)

    sessions.stopExecution("t-queued", "stop")
    expect((await first).result.isError).toBe(true)
  })

  test("a timeout during the browser responsiveness check never dispatches the code", async () => {
    const { sessions, sandboxes } = manager(async () => ok("ran"), {
      browser: { id: "b1", key: "b1" },
      checkBrowserResponsive: () => Effect.sleep("500 millis"),
    })
    const started = Date.now()
    const timedOut = await run(sessions.execute({ sessionId: "t-check", code: "...", createIfMissing: true, timeoutMs: 20 }))
    expect(timedOut.result.isError).toBe(true)
    expect(timedOut.result.diagnostic).toBe("execute-timeout")
    expect(timedOut.result.text).toContain("Execute timed out after 20ms")
    expect(Date.now() - started).toBeLessThan(400)
    // The check finishes long after the caller was answered; the stopped call must not start its script.
    await Bun.sleep(550)
    expect(sandboxes[0]?.executions).toBe(0)
    expect(sessions.isExecuting("t-check")).toBe(false)
  })

  test("pauseExecutionTimeout suspends the execute deadline while waiting on a handoff", async () => {
    const { sessions } = manager(async () => {
      const resume = sessions.pauseExecutionTimeout("t-pause")
      await Bun.sleep(90)
      resume()
      await Bun.sleep(10)
      return ok("finished after handoff")
    })
    const done = await run(sessions.execute({ sessionId: "t-pause", code: "...", createIfMissing: true, timeoutMs: 50 }))
    expect(done.result.isError).toBe(false)
    expect(done.result.text).toBe("finished after handoff")
  })

  test("a chosen timeoutMs is the action budget too, never below 30s", async () => {
    const { sessions, sandboxes } = manager(async () => ok("done"))
    await run(sessions.execute({ sessionId: "t-actions", code: "...", createIfMissing: true, timeoutMs: 240_000 }))
    await run(sessions.execute({ sessionId: "t-actions", code: "...", createIfMissing: false, timeoutMs: 5_000 }))
    await run(sessions.execute({ sessionId: "t-actions", code: "...", createIfMissing: false, timeoutMs: 0 }))
    expect(sandboxes[0]?.calls.map((options) => options?.actionTimeoutMs)).toEqual([240_000, 30_000, 0])
  })

  test("without a chosen timeout, actions keep Playwright's 30s default", async () => {
    const { sessions, sandboxes } = manager(async () => ok("done"))
    await run(sessions.execute({ sessionId: "t-default", code: "...", createIfMissing: true }))
    expect(sandboxes[0]?.calls[0]?.actionTimeoutMs).toBeUndefined()
  })

  test("the relay's executeTimeoutMs is the action budget, and a per-call timeoutMs wins", async () => {
    const { sessions, sandboxes } = manager(async () => ok("done"), { executeTimeoutMs: 120_000 })
    await run(sessions.execute({ sessionId: "t-hook", code: "...", createIfMissing: true }))
    await run(sessions.execute({ sessionId: "t-hook", code: "...", createIfMissing: false, timeoutMs: 60_000 }))
    expect(sandboxes[0]?.calls.map((options) => options?.actionTimeoutMs)).toEqual([120_000, 60_000])
  })

  test("disconnecting a caller while execute runs aborts the script and frees the lock", async () => {
    const { sessions, sandboxes } = manager(async (sandbox) => {
      if (sandbox.executions === 1) await sandbox.playwrightCall()
      return ok("next caller")
    })
    const fiber = Effect.runFork(sessions.execute({ sessionId: "disc", code: "...", createIfMissing: true }))
    for (let i = 0; i < 50 && !sessions.isExecuting("disc"); i++) await Bun.sleep(5)
    expect(sessions.isExecuting("disc")).toBe(true)

    await run(Fiber.interrupt(fiber))
    for (let i = 0; i < 50 && sessions.isExecuting("disc"); i++) await Bun.sleep(5)
    expect(sandboxes[0]?.aborted).toBe(1)
    expect(sessions.isExecuting("disc")).toBe(false)

    const second = await run(sessions.execute({ sessionId: "disc", code: "...", createIfMissing: false }))
    expect(second.result.text).toBe("next caller")
  })

  test("removeAfterExecute (--rm) closes all session tabs and deletes the session", async () => {
    const closed: string[] = []
    const targets: ConnectedTarget[] = []
    const sessions = new OpenCodeBrowserSessions("http://127.0.0.1:0", (id) => {
      targets.push(rootTab("first", id), rootTab("popup", id))
      return new FakeSandbox(async () => ok("one-shot"))
    }, {
      lifecycleTimeoutMs: 5_000,
      getTargets: () => targets,
      onReleaseRelayTarget: (id) => Effect.sync(() => { closed.push(id) }),
    })

    const out = await run(sessions.execute({ code: "return 1", createIfMissing: true, removeAfterExecute: true }))
    expect(out.result.text).toBe("one-shot")
    expect(closed).toEqual(["first", "popup"])
    expect(sessions.listSummaries()).toEqual([])
  })

  test("reapIdleSessions deletes idle auto-named sessions and never touches explicit sessions", async () => {
    const closed: string[] = []
    const targets = [rootTab("agent-tab", "oc-ses_abc"), rootTab("mcp-tab", "mcp-12345678"), rootTab("named-tab", "named")]
    const sessions = new OpenCodeBrowserSessions("http://127.0.0.1:0", () => new FakeSandbox(async () => ok("x")), {
      lifecycleTimeoutMs: 5_000,
      getTargets: () => targets,
      onReleaseRelayTarget: (id) => Effect.sync(() => { closed.push(id) }),
    })
    for (const id of ["oc-ses_abc", "mcp-12345678", "named"]) await run(sessions.execute({ sessionId: id, code: "...", createIfMissing: true }))
    sessions.noteClient("named", 4242)
    for (const session of sessions.sessions.values()) session.updatedAt = new Date(0).toISOString()

    // A session id with six hex characters is not one of the eight MCP makes up, so it is explicit and stays.
    await run(sessions.execute({ sessionId: "mcp-abcdef", code: "...", createIfMissing: true }))
    sessions.sessions.get("mcp-abcdef")!.updatedAt = new Date(0).toISOString()

    expect(await run(sessions.reapIdleSessions({ maxIdleMs: 100, now: 101, isTargetBusy: (id) => id === "mcp-tab" }))).toEqual(["oc-ses_abc"])
    expect(sessions.sessions.has("oc-ses_abc")).toBe(false)
    expect(sessions.sessions.has("mcp-12345678")).toBe(true)
    expect(sessions.sessions.has("named")).toBe(true)

    expect(await run(sessions.reapIdleSessions({ maxIdleMs: 100, now: 101 }))).toEqual(["mcp-12345678"])
    expect(closed).toEqual(["agent-tab", "mcp-tab"])
    expect(sessions.sessions.get("named")?.clientPid).toBe(4242)

    // A user-requested reset keeps the client pid so orphan collection still knows who owns it.
    expect(await run(sessions.reset("named"))).toMatchObject({ session: { id: "named" } })
    expect(sessions.sessions.get("named")?.clientPid).toBe(4242)
  })

  test("sweepOrphanedRelayTargets closes only relay-owned targets without a session", async () => {
    const closed: string[] = []
    const sessions = new OpenCodeBrowserSessions("http://127.0.0.1:0", () => new FakeSandbox(async () => ok("x")), {
      getTargets: () => [rootTab("orphan", "gone"), rootTab("live", "live"), rootTab("user", "gone", "user"), rootTab("raw", undefined)],
      onReleaseRelayTarget: (id) => Effect.sync(() => { closed.push(id) }),
    })
    await run(sessions.execute({ sessionId: "live", code: "...", createIfMissing: true }))
    await run(sessions.sweepOrphanedRelayTargets())
    expect(closed).toEqual(["orphan"])
  })
})


