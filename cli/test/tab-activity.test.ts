import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { ConnectedTarget } from "../src/relay/types.ts"
import { TabActivity } from "../src/cdp/tab-activity.ts"

const target = (tabId: number, owner: "relay" | "user"): ConnectedTarget => ({
  tabId,
  sessionId: `cdp-${tabId}`,
  owner,
  targetInfo: {
    targetId: `target-${tabId}`,
    type: "page",
    title: `tab-${tabId}`,
    url: "https://example.test/",
    attached: true,
    canAccessOpener: false,
  },
})

describe("TabActivity", () => {
  test("focus enables emulation once per tab across sessions and disables when the last session finishes", async () => {
    const calls: Array<{ readonly tabId: number; readonly enabled: boolean }> = []
    const activity = new TabActivity((tabId, enabled) => Effect.sync(() => {
      calls.push({ tabId, enabled })
    }))

    await Effect.runPromise(activity.focus(10, "s1"))
    await Effect.runPromise(activity.focus(10, "s2"))
    await Effect.runPromise(activity.focus(10, "s1"))
    expect(activity.isFocused(10)).toBe(true)
    expect(calls).toEqual([{ tabId: 10, enabled: true }])

    await Effect.runPromise(activity.finish("s1"))
    expect(activity.isFocused(10)).toBe(true)
    expect(calls).toEqual([{ tabId: 10, enabled: true }])

    await Effect.runPromise(activity.finish("s2"))
    expect(activity.isFocused(10)).toBe(false)
    expect(calls).toEqual([{ tabId: 10, enabled: true }, { tabId: 10, enabled: false }])
  })

  test("idleUserTargets returns only unfocused user tabs past the idle threshold", async () => {
    const activity = new TabActivity(() => Effect.void)
    activity.touch(1, 1_000)
    activity.touch(2, 1_000)
    activity.touch(3, 5_500)
    activity.touch(4, 1_000)
    await Effect.runPromise(activity.focus(4, "busy"))

    const idle = activity.idleUserTargets([
      target(1, "user"),
      target(2, "relay"),
      target(3, "user"),
      target(4, "user"),
    ], 6_000, 5_000)

    expect(idle.map((item) => item.tabId)).toEqual([1])
  })

  test("a kept tab stays enabled after finish while the session's other tabs are disabled", async () => {
    const calls: Array<{ readonly tabId: number; readonly enabled: boolean }> = []
    const activity = new TabActivity((tabId, enabled) => Effect.sync(() => {
      calls.push({ tabId, enabled })
    }))

    await Effect.runPromise(activity.focus(10, "s1"))
    await Effect.runPromise(activity.focus(11, "s1"))
    await Effect.runPromise(activity.finish("s1", { keep: (tabId) => tabId === 10 }))

    expect(activity.isFocused(10)).toBe(true)
    expect(activity.isFocused(11)).toBe(false)
    expect(calls).toEqual([{ tabId: 10, enabled: true }, { tabId: 11, enabled: true }, { tabId: 11, enabled: false }])

    // A later execute that keeps nothing turns the kept tab off too.
    await Effect.runPromise(activity.finish("s1"))
    expect(activity.isFocused(10)).toBe(false)
    expect(calls.at(-1)).toEqual({ tabId: 10, enabled: false })
  })

  test("releasing a session turns off every tab it kept", async () => {
    const calls: Array<{ readonly tabId: number; readonly enabled: boolean }> = []
    const activity = new TabActivity((tabId, enabled) => Effect.sync(() => {
      calls.push({ tabId, enabled })
    }))

    await Effect.runPromise(activity.focus(10, "s1"))
    await Effect.runPromise(activity.finish("s1", { keep: () => true }))
    expect(calls).toEqual([{ tabId: 10, enabled: true }])

    await Effect.runPromise(activity.release("s1"))
    expect(activity.isFocused(10)).toBe(false)
    expect(calls).toEqual([{ tabId: 10, enabled: true }, { tabId: 10, enabled: false }])
  })

  test("another session finishing does not disable a kept tab", async () => {
    const calls: Array<{ readonly tabId: number; readonly enabled: boolean }> = []
    const activity = new TabActivity((tabId, enabled) => Effect.sync(() => {
      calls.push({ tabId, enabled })
    }))

    await Effect.runPromise(activity.focus(10, "s1"))
    await Effect.runPromise(activity.finish("s1", { keep: () => true }))
    await Effect.runPromise(activity.focus(10, "s2"))
    await Effect.runPromise(activity.finish("s2"))

    expect(activity.isFocused(10)).toBe(true)
    expect(calls).toEqual([{ tabId: 10, enabled: true }])

    await Effect.runPromise(activity.release("s1"))
    expect(activity.isFocused(10)).toBe(false)
    expect(calls).toEqual([{ tabId: 10, enabled: true }, { tabId: 10, enabled: false }])
  })

  test("releasing one of two owners leaves the tab enabled until the last one goes", async () => {
    const calls: Array<{ readonly tabId: number; readonly enabled: boolean }> = []
    const activity = new TabActivity((tabId, enabled) => Effect.sync(() => {
      calls.push({ tabId, enabled })
    }))

    await Effect.runPromise(activity.focus(10, "s1"))
    await Effect.runPromise(activity.focus(10, "s2"))
    await Effect.runPromise(activity.release("s1"))

    expect(activity.isFocused(10)).toBe(true)
    expect(calls).toEqual([{ tabId: 10, enabled: true }])

    await Effect.runPromise(activity.release("s2"))
    expect(activity.isFocused(10)).toBe(false)
    expect(calls).toEqual([{ tabId: 10, enabled: true }, { tabId: 10, enabled: false }])
  })
})
