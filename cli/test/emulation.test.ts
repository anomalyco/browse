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
    const generation = overrides.generation(1)
    overrides.mark(1) // the set that the repeat would have wiped

    await Effect.runPromise(clearDeviceMetricsOverride(recorder(sent), {
      retry: () => overrides.generation(1) === generation,
    }))

    expect(sent).toEqual([clearMethod])
  })
})

describe("DeviceMetricsOverrides", () => {
  test("marks tabs and takes only the ones asked for", () => {
    const overrides = new DeviceMetricsOverrides()
    overrides.mark(1)
    overrides.mark(3)

    expect(overrides.take([2, 3])).toEqual([3])
    expect(overrides.take([1, 2, 3])).toEqual([1])
    expect(overrides.take([1, 2, 3])).toEqual([])
  })

  test("a new mark changes the generation and taking does not reset it", () => {
    const overrides = new DeviceMetricsOverrides()
    expect(overrides.generation(4)).toBe(0)
    expect(overrides.mark(4)).toBe(1)
    expect(overrides.mark(4)).toBe(2)
    expect(overrides.take([4])).toEqual([4])
    expect(overrides.generation(4)).toBe(2)
    expect(overrides.mark(4)).toBe(3)
    expect(overrides.take([4])).toEqual([4])
  })

  test("an old clear retry cannot match a set that followed an execute-end take", () => {
    const overrides = new DeviceMetricsOverrides()
    overrides.mark(9)
    const captured = overrides.generation(9)
    overrides.take([9])
    overrides.mark(9)

    expect(overrides.generation(9)).not.toBe(captured)
  })
})

describe("tabsToClearOnExecuteEnd", () => {
  test("clears only tabs that had a device-metrics override, once", () => {
    const overrides = new DeviceMetricsOverrides()
    overrides.mark(7)

    expect(tabsToClearOnExecuteEnd({ overrides, readOnly: false, tabIds: [6, 7, 8] })).toEqual([7])
    expect(tabsToClearOnExecuteEnd({ overrides, readOnly: false, tabIds: [6, 7, 8] })).toEqual([])
  })

  test("does not clear, or consume marks, for a read-only session", () => {
    const overrides = new DeviceMetricsOverrides()
    overrides.mark(7)

    expect(tabsToClearOnExecuteEnd({ overrides, readOnly: true, tabIds: [7] })).toEqual([])
    expect(tabsToClearOnExecuteEnd({ overrides, readOnly: false, tabIds: [7] })).toEqual([7])
  })
})
