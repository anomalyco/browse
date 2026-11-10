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
      retry: () => overrides.isCurrent(1, generation),
    }))

    expect(sent).toEqual([clearMethod])
  })
})

describe("DeviceMetricsOverrides", () => {
  test("take returns generations and keeps them on the tab", () => {
    const overrides = new DeviceMetricsOverrides()
    const generation = overrides.mark(1, "session-a")

    expect(overrides.take("session-a")).toEqual([{ tabId: 1, generation }])
    // Ownership is gone, but the generation stays so a clear can still check it.
    expect(overrides.sessionId(1)).toBeUndefined()
    expect(overrides.generation(1)).toBe(generation)
    expect(overrides.isCurrent(1, generation)).toBe(true)
    expect(overrides.take("session-a")).toEqual([])
  })

  test("a generation check before a clear fails after a newer set", () => {
    const overrides = new DeviceMetricsOverrides()
    const first = overrides.mark(2, "session-a")
    const second = overrides.mark(2, "session-b")

    expect(overrides.isCurrent(2, first)).toBe(false)
    expect(overrides.isCurrent(2, second)).toBe(true)
  })

  test("never takes a tab whose latest set came from another session", () => {
    const overrides = new DeviceMetricsOverrides()
    overrides.mark(3, "session-a")
    overrides.mark(3, "session-b")

    expect(overrides.take("session-a")).toEqual([])
    expect(overrides.take("session-b")).toEqual([{ tabId: 3, generation: expect.any(Number) }])
  })

  test("a tab the session drove without owning it is still taken", () => {
    const overrides = new DeviceMetricsOverrides()
    // Ownership is not part of the tracker: targetUrl/targetIndex tabs are marked the same way.
    const generation = overrides.mark(8, "session-a")

    expect(tabsToClearOnExecuteEnd({
      overrides,
      readOnly: false,
      sessionId: "session-a",
      canSee: () => true,
    })).toEqual([{ tabId: 8, generation }])
  })

  test("a clear by another session does not drop the owner", () => {
    const overrides = new DeviceMetricsOverrides()
    const generation = overrides.mark(4, "session-a")

    overrides.clear(4, generation, "session-b")

    expect(overrides.sessionId(4)).toBe("session-a")
    expect(overrides.take("session-a")).toEqual([{ tabId: 4, generation }])
  })

  test("a raw-client set replaces the owner and bumps the generation", () => {
    const overrides = new DeviceMetricsOverrides()
    const owned = overrides.mark(5, "session-a")
    const raw = overrides.mark(5, undefined)

    expect(overrides.generation(5)).toBe(raw)
    expect(overrides.isCurrent(5, owned)).toBe(false)
    expect(overrides.sessionId(5)).toBeUndefined()
    expect(overrides.take("session-a")).toEqual([])
  })

  test("a clear drops ownership only for the generation it started on", () => {
    const overrides = new DeviceMetricsOverrides()
    const generation = overrides.mark(6, "session-a")
    overrides.clear(6, generation, "session-a")
    expect(overrides.sessionId(6)).toBeUndefined()

    const newer = overrides.mark(7, "session-a")
    overrides.clear(7, newer - 1, "session-a")
    expect(overrides.sessionId(7)).toBe("session-a")
  })

  test("forget drops a tab when its runtime state goes away", () => {
    const overrides = new DeviceMetricsOverrides()
    overrides.mark(9, "session-a")
    overrides.forget(9)

    expect(overrides.generation(9)).toBe(0)
    expect(overrides.take("session-a")).toEqual([])
  })

  test("generations are not reused, so an old retry cannot match a forgotten tab's new set", () => {
    const overrides = new DeviceMetricsOverrides()
    const before = overrides.mark(10, "session-a")
    overrides.forget(10)
    const after = overrides.mark(10, "session-b")

    expect(after).toBeGreaterThan(before)
  })
})

describe("tabsToClearOnExecuteEnd", () => {
  test("clears this session's visible tabs once, with their generations", () => {
    const overrides = new DeviceMetricsOverrides()
    const first = overrides.mark(1, "session-a")
    overrides.mark(2, "session-b")

    expect(tabsToClearOnExecuteEnd({
      overrides,
      readOnly: false,
      sessionId: "session-a",
      canSee: () => true,
    })).toEqual([{ tabId: 1, generation: first }])
    expect(tabsToClearOnExecuteEnd({
      overrides,
      readOnly: false,
      sessionId: "session-a",
      canSee: () => true,
    })).toEqual([])
  })

  test("skips a tab the session can no longer see", () => {
    const overrides = new DeviceMetricsOverrides()
    overrides.mark(3, "session-a")

    expect(tabsToClearOnExecuteEnd({
      overrides,
      readOnly: false,
      sessionId: "session-a",
      canSee: (tabId) => tabId !== 3,
    })).toEqual([])
  })

  test("does not clear, or consume marks, for a read-only session", () => {
    const overrides = new DeviceMetricsOverrides()
    overrides.mark(7, "session-a")

    expect(tabsToClearOnExecuteEnd({
      overrides,
      readOnly: true,
      sessionId: "session-a",
      canSee: () => true,
    })).toEqual([])
    expect(tabsToClearOnExecuteEnd({
      overrides,
      readOnly: false,
      sessionId: "session-a",
      canSee: () => true,
    })).toEqual([{ tabId: 7, generation: expect.any(Number) }])
  })
})
