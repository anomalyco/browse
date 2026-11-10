import { Effect } from "effect"
import type { JsonObject } from "../protocol.ts"

/**
 * Device metrics are per-DevTools-session state, applied only at a tab's top target. In this relay
 * `context.newCDPSession(page)` is an alias onto the tab's chrome.debugger session, so a clear from
 * it already reaches the session Playwright used. What does not work reliably is a single clear:
 * Chrome can silently drop one that lands while the visible-size update from the matching set is
 * still settling. In a headless Chrome test, 8 of 30 back-to-back set/clear pairs kept the emulated
 * viewport, with the clear answering success, and a second clear applied every time.
 *
 * So a clear runs twice, inline before the client's response. The repeat is skipped when a new
 * setDeviceMetricsOverride was forwarded for the tab in the meantime, so a clear can never wipe a
 * viewport that arrived after it started.
 */
export const deviceMetricsClearRetryMs = 100

export function clearDeviceMetricsOverride<Error>(
  send: (method: string, params: JsonObject) => Effect.Effect<unknown, Error>,
  options: { readonly retry?: () => boolean } = {},
): Effect.Effect<void, Error> {
  const clear = send("Emulation.clearDeviceMetricsOverride", {})
  return Effect.gen(function* () {
    yield* clear
    yield* Effect.sleep(deviceMetricsClearRetryMs)
    if (options.retry?.() === false) return
    yield* clear
  })
}

/** Tabs that received Emulation.setDeviceMetricsOverride, with a generation to spot a newer set. */
export class DeviceMetricsOverrides {
  // Generations only grow: a clear retry compares them, so resetting one on take would let an old
  // retry see the same value a new set produced and wipe it.
  private readonly generations = new Map<number, number>()
  private readonly pending = new Set<number>()

  /** Records a forwarded set and returns its generation. */
  mark(tabId: number): number {
    const generation = (this.generations.get(tabId) ?? 0) + 1
    this.generations.set(tabId, generation)
    this.pending.add(tabId)
    return generation
  }

  generation(tabId: number): number {
    return this.generations.get(tabId) ?? 0
  }

  /** Removes and returns the ids among `tabIds` that still have an override. */
  take(tabIds: Iterable<number>): number[] {
    const taken: number[] = []
    for (const tabId of tabIds) {
      if (this.pending.delete(tabId)) taken.push(tabId)
    }
    return taken
  }
}

/** Tabs an execute end should clear: only ones with an override, and never for a read-only session. */
export function tabsToClearOnExecuteEnd(options: {
  readonly overrides: DeviceMetricsOverrides
  readonly readOnly: boolean
  readonly tabIds: readonly number[]
}): number[] {
  return options.readOnly ? [] : options.overrides.take(options.tabIds)
}
