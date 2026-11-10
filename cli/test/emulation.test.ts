import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { clearDeviceMetricsOverride, DeviceMetricsOverrides, tabsToClearOnExecuteEnd } from "../src/cdp/emulation.ts"

const clearMethod = "Emulation.clearDeviceMetricsOverride"

const recorder = (sent: string[]) => (method: string) =>
  Effect.sync(() => {
    sent.push(method)
    return {}
  })

describe("clearDeviceMetricsOverride", () => {
  test("sends both clears inline and leaves no retry pending", async () => {
    const sent: string[] = []
    await Effect.runPromise(clearDeviceMetricsOverride(recorder(sent)))

    // Both must be done before the caller's response: a detached retry could wipe a viewport
    // that a later execute sets while it is still pending.
    expect(sent).toEqual([clearMethod, clearMethod])
    await Bun.sleep(250)
    expect(sent).toEqual([clearMethod, clearMethod])
  })

  test("skips the repeat when a newer set arrives during the pause", async () => {
    const sent: string[] = []
    const overrides = new DeviceMetricsOverrides()
    const generation = overrides.mark(1, "session-a")
    overrides.mark(1, "session-a") // the set that the repeat would have wiped

    await Effect.runPromise(clearDeviceMetricsOverride(recorder(sent), {
      retry: () => overrides.generation(1) === generation,
    }))

    expect(sent).toEqual([clearMethod])
  })
})

describe("DeviceMetricsOverrides", () => {
  test("takes only the tabs this session set", () => {
    const overrides = new DeviceMetricsOverrides()
    overrides.mark(1, "session-a")
    overrides.mark(2, "session-b")

    expect(overrides.take("session-a")).toEqual([1])
    expect(overrides.take("session-a")).toEqual([])
    expect(overrides.take("session-b")).toEqual([2])
    expect(overrides.take("session-b")).toEqual([])
  })

  test("never takes a tab whose latest set came from another session", () => {
    const overrides = new DeviceMetricsOverrides()
    overrides.mark(3, "session-a")
    overrides.mark(3, "session-b")

    expect(overrides.take("session-a")).toEqual([])
    expect(overrides.take("session-b")).toEqual([3])
  })

  test("a tab the session drove without owning it is still taken", () => {
    const overrides = new DeviceMetricsOverrides()
    // Ownership is not part of the tracker: targetUrl/targetIndex tabs are marked the same way.
    overrides.mark(8, "session-a")

    expect(tabsToClearOnExecuteEnd({ overrides, readOnly: false, sessionId: "session-a" })).toEqual([8])
  })

  test("a clear drops the tab unless a newer set replaced it", () => {
    const overrides = new DeviceMetricsOverrides()
    const generation = overrides.mark(4, "session-a")
    overrides.clear(4, generation)
    expect(overrides.take("session-a")).toEqual([])

    const next = overrides.mark(5, "session-a")
    overrides.clear(5, next - 1) // stale generation: a newer set owns the tab
    expect(overrides.take("session-a")).toEqual([5])
  })

  test("forget drops a tab when its runtime state goes away", () => {
    const overrides = new DeviceMetricsOverrides()
    overrides.mark(6, "session-a")
    overrides.forget(6)

    expect(overrides.generation(6)).toBe(0)
    expect(overrides.take("session-a")).toEqual([])
  })

  test("generations are not reused, so an old retry cannot match a forgotten tab's new set", () => {
    const overrides = new DeviceMetricsOverrides()
    const before = overrides.mark(7, "session-a")
    overrides.forget(7)
    const after = overrides.mark(7, "session-b")

    expect(after).not.toBe(before)
    expect(after).toBeGreaterThan(before)
  })
})

describe("tabsToClearOnExecuteEnd", () => {
  test("clears only this session's tabs that still have an override, once", () => {
    const overrides = new DeviceMetricsOverrides()
    overrides.mark(1, "session-a")
    overrides.mark(2, "session-b")

    expect(tabsToClearOnExecuteEnd({ overrides, readOnly: false, sessionId: "session-a" })).toEqual([1])
    expect(tabsToClearOnExecuteEnd({ overrides, readOnly: false, sessionId: "session-a" })).toEqual([])
    expect(tabsToClearOnExecuteEnd({ overrides, readOnly: false, sessionId: "session-b" })).toEqual([2])
  })

  test("does not clear, or consume marks, for a read-only session", () => {
    const overrides = new DeviceMetricsOverrides()
    overrides.mark(7, "session-a")

    expect(tabsToClearOnExecuteEnd({ overrides, readOnly: true, sessionId: "session-a" })).toEqual([])
    expect(tabsToClearOnExecuteEnd({ overrides, readOnly: false, sessionId: "session-a" })).toEqual([7])
  })
})
