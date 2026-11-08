import { expect, test } from "bun:test"
import { Effect } from "effect"
import type { Page } from "patchright-core"
import { ExecuteSandbox } from "../src/execute.ts"
import { OpenCodeBrowserSessions } from "../src/session-manager.ts"

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
