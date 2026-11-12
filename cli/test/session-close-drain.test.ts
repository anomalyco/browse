import { expect, test } from "bun:test"
import { Effect } from "effect"
import type { Page } from "patchright-core"
import { ExecuteSandbox } from "../src/execute.ts"
import type { ExecuteSandboxLike } from "../src/relay/types.ts"
import { OpenCodeBrowserSessions } from "../src/session-manager.ts"
import type { PendingSessionWork } from "../src/session-manager/types.ts"

// A session's close is tracked work, and a relay restart (so every auto-update) waits for tracked work to finish. A page
// whose tab the relay lost track of never reports closed, so its close used to hang forever: the session was already
// gone, so nothing looked busy, yet every later restart timed out with "timed out waiting for accepted work".

/** Enough of a Playwright Page for the sandbox to bind it as the session's own page; its close never settles. */
class NeverClosingPage {
  closeCalls = 0
  url() { return "https://example.com/" }
  isClosed() { return false }
  mainFrame() { return {} }
  on() {}
  once() {}
  off() {}
  close() {
    this.closeCalls += 1
    return new Promise<void>(() => {})
  }
}

class Sandbox extends ExecuteSandbox {
  own(page: Page) {
    this.bindDefaultPage(page, "target-1", true, false)
  }
}

/** Answers the promise or fails the test at the deadline, so a hang is a failure instead of a test timeout. */
function within<A>(promise: Promise<A>, ms: number, label: string): Promise<A> {
  return Promise.race([
    promise,
    Bun.sleep(ms).then(() => {
      throw new Error(`${label} did not finish within ${ms} ms`)
    }),
  ])
}

test("deleting a session whose page never closes doesn't hold the relay's drain", async () => {
  const sandboxes: Sandbox[] = []
  const sessions = new OpenCodeBrowserSessions("http://127.0.0.1:0", () => {
    const sandbox = new Sandbox({ endpointUrl: "http://127.0.0.1:0", authToken: "test" })
    sandboxes.push(sandbox)
    return sandbox
  }, { lifecycleTimeoutMs: 200 })
  await Effect.runPromise(sessions.create("stuck"))
  const page = new NeverClosingPage()
  sandboxes[0]!.own(page as unknown as Page)

  expect((await Effect.runPromise(sessions.delete("stuck"))).deleted).toBe(true)
  expect(page.closeCalls).toBe(1)
  expect(sessions.sessions.has("stuck")).toBe(false)

  await within(Effect.runPromise(sessions.beginDrain()), 5_000, "the drain")
  expect(sessions.isDrained()).toBe(true)
}, 10_000)

/** A sandbox whose script never settles, so an execute keeps holding the session's accepted work. */
class NeverFinishingSandbox implements ExecuteSandboxLike {
  execute() { return Effect.never }
  authenticatedJson(): never { throw new Error("unused") }
  adoptPage() { return Effect.void }
  stopRealm() {}
  disconnectSettled() { return Effect.void }
  closeSettled() { return Effect.void }
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

test("shutdown stops waiting for a session whose work never finishes", async () => {
  const writes: string[][] = []
  const sessions = new OpenCodeBrowserSessions("http://127.0.0.1:0", () => new NeverFinishingSandbox(), {
    executeTimeoutMs: 0,
    lifecycleTimeoutMs: 200,
    onSessionsChanged: async (entries) => {
      // Slower than the stalled wait, so only the shutdown's own flush sees this write finish.
      await Bun.sleep(300)
      writes.push(entries.map((entry) => entry.id))
    },
  })
  // Left pending on purpose: this is the session work that never finishes.
  void Effect.runPromise(sessions.execute({ sessionId: "stuck", code: "...", createIfMissing: true })).catch(() => {})
  for (let attempt = 0; attempt < 50 && !sessions.isExecuting("stuck"); attempt++) await Bun.sleep(5)
  expect(sessions.isExecuting("stuck")).toBe(true)

  // Wait out the write the execute's own session creation queued, so only the next one is pending at shutdown.
  for (let attempt = 0; attempt < 100 && writes.length === 0; attempt++) await Bun.sleep(5)
  expect(writes).toEqual([["stuck"]])

  writes.length = 0
  // A catalog write nothing is awaiting: the shutdown must still flush it before dropping the sessions.
  sessions.noteClient("stuck", 1234)
  const stalled: Array<readonly PendingSessionWork[]> = []
  const started = Date.now()
  await within(
    Effect.runPromise(sessions.closeAll({ timeoutMs: 100, onStalled: (report) => { stalled.push(report) } })),
    2_000,
    "a shutdown waiting for a session that never finishes",
  )

  expect(stalled).toHaveLength(1)
  expect(stalled[0]?.map(({ sessionId }) => sessionId)).toEqual(["stuck"])
  expect(stalled[0]?.[0]?.pending).toBeGreaterThan(0)
  expect(writes).toEqual([["stuck"]])
  expect(Date.now() - started).toBeLessThan(1_000)
  expect(sessions.sessions.size).toBe(0)
}, 10_000)
