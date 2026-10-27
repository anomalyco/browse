import { describe, expect, test } from "bun:test"
import { HandoffRegistry, resolveExactHandoffTarget, toolbarClickAction } from "../src/handoff.ts"

const target = { tabId: 7, targetId: "T7", targetSessionId: "S7" }

function registry() {
  let next = 0
  return new HandoffRegistry(() => `h${++next}`)
}

describe("HandoffRegistry", () => {
  test("binds a handoff to its session, tab and target", () => {
    const handoffs = registry()
    const wait = handoffs.wait({ sessionId: "github", ...target, message: "Sign in", timeoutMs: 10_000 })
    expect(handoffs.pendingForTab(7)).toEqual({ id: wait.id, sessionId: "github", ...target, message: "Sign in" })
    expect(handoffs.pendingForSession("github")?.id).toBe(wait.id)
    expect(handoffs.pendingForTab(8)).toBeUndefined()
    wait.cancel()
  })

  test("completes only with the matching id and exact target", async () => {
    const handoffs = registry()
    const wait = handoffs.wait({ sessionId: "github", ...target, message: "Sign in", timeoutMs: 10_000 })
    expect(handoffs.complete({ id: "wrong", ...target })).toBe(false)
    expect(handoffs.complete({ id: wait.id, ...target, tabId: 8 })).toBe(false)
    expect(handoffs.complete({ id: wait.id, ...target, targetId: "other" })).toBe(false)
    expect(handoffs.complete({ id: wait.id, ...target, targetSessionId: "other" })).toBe(false)
    expect(handoffs.pendingCount).toBe(1)
    expect(handoffs.complete({ id: wait.id, ...target })).toBe(true)
    expect(await wait.outcome).toBe("resolved")
    expect(handoffs.pendingCount).toBe(0)
  })

  test("times out", async () => {
    const handoffs = registry()
    const wait = handoffs.wait({ sessionId: "github", ...target, message: "Sign in", timeoutMs: 20 })
    expect(await wait.outcome).toBe("timeout")
    expect(handoffs.pendingForTab(7)).toBeUndefined()
  })

  test("follows the tab to a new target and cancels when the target goes", async () => {
    const handoffs = registry()
    const wait = handoffs.wait({ sessionId: "github", ...target, message: "Sign in", timeoutMs: 10_000 })
    expect(handoffs.rebindTarget({ tabId: 7, previousTargetId: "T7", previousTargetSessionId: "S7", targetId: "T7b", targetSessionId: "S7b" })).toBe(true)
    expect(handoffs.complete({ id: wait.id, ...target })).toBe(false)
    expect(handoffs.cancelForTarget({ targetId: "T7b", targetSessionId: "S7b", reason: "target-detached" })).toHaveLength(1)
    expect(await wait.outcome).toEqual({ type: "cancelled", reason: "target-detached" })
  })

  test("a new handoff in the same session ends the previous one", async () => {
    const handoffs = registry()
    const first = handoffs.wait({ sessionId: "github", ...target, message: "one", timeoutMs: 10_000 })
    const second = handoffs.wait({ sessionId: "github", ...target, message: "two", timeoutMs: 10_000 })
    expect(await first.outcome).toBe("timeout")
    expect(handoffs.pendingForTab(7)?.id).toBe(second.id)
    second.cancel()
    expect(await second.outcome).toBe("timeout")
  })

  test("a completion during a held start action waits for the action", async () => {
    const handoffs = registry()
    const wait = handoffs.wait({ sessionId: "github", ...target, message: "Sign in", timeoutMs: 10_000 })
    const release = wait.holdCompletion()
    expect(handoffs.complete({ id: wait.id, ...target })).toBe(true)
    let settled = false
    void wait.outcome.then(() => { settled = true })
    await Bun.sleep(5)
    expect(settled).toBe(false)
    release()
    expect(await wait.outcome).toBe("resolved")
  })
})

describe("toolbarClickAction", () => {
  test("finishes a waiting handoff first, then stops a running script, else toggles", () => {
    expect(toolbarClickAction({ handoffPending: true, sessionExecuting: true })).toBe("complete-handoff")
    expect(toolbarClickAction({ handoffPending: false, sessionExecuting: true })).toBe("stop-execution")
    expect(toolbarClickAction({ handoffPending: false, sessionExecuting: false })).toBe("toggle")
  })
})

describe("resolveExactHandoffTarget", () => {
  const targets = [{ tabId: 7, sessionId: "S7", targetInfo: { targetId: "T7" } }]
  test("returns the visible target", () => {
    expect(resolveExactHandoffTarget({ targetId: "T7", targets, isVisible: () => true })).toBe(targets[0]!)
  })
  test("refuses a missing or invisible target", () => {
    expect(() => resolveExactHandoffTarget({ targetId: "T8", targets, isVisible: () => true })).toThrow()
    expect(() => resolveExactHandoffTarget({ targetId: "T7", targets, isVisible: () => false })).toThrow()
  })
})
