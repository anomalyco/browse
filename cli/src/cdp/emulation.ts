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

/**
 * Tabs with a device-metrics override, and the browse session whose script set it. Generations are
 * monotonic across the relay so an in-flight clear retry can never match a set that replaced it.
 */
export class DeviceMetricsOverrides {
  private nextGeneration = 1
  private readonly entries = new Map<number, { readonly sessionId: string; readonly generation: number }>()

  /** Records a forwarded set and returns its generation. */
  mark(tabId: number, sessionId: string): number {
    const generation = this.nextGeneration++
    this.entries.set(tabId, { sessionId, generation })
    return generation
  }

  generation(tabId: number): number {
    return this.entries.get(tabId)?.generation ?? 0
  }

  /** Removes and returns the tabs whose latest set came from this session. */
  take(sessionId: string): number[] {
    const taken: number[] = []
    for (const [tabId, entry] of this.entries) {
      if (entry.sessionId !== sessionId) continue
      this.entries.delete(tabId)
      taken.push(tabId)
    }
    return taken
  }

  /** Drops a tab after its own clear, unless a newer set replaced it. */
  clear(tabId: number, generation: number): void {
    if (this.entries.get(tabId)?.generation === generation) this.entries.delete(tabId)
  }

  /** Drops a tab when its runtime state goes away, so the map does not grow forever. */
  forget(tabId: number): void {
    this.entries.delete(tabId)
  }
}

/** Tabs an execute end should clear: those this session set, and never for a read-only session. */
export function tabsToClearOnExecuteEnd(options: {
  readonly overrides: DeviceMetricsOverrides
  readonly readOnly: boolean
  readonly sessionId: string
}): number[] {
  return options.readOnly ? [] : options.overrides.take(options.sessionId)
}
