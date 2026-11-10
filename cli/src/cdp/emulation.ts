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

type OverrideEntry = {
  /** The browse session whose client set it, or undefined for a raw client. */
  sessionId: string | undefined
  generation: number
}

/**
 * Tabs with a device-metrics override, the session that most recently set it, and a relay-wide
 * generation. The generation stays on the tab when ownership is taken or cleared, so an in-flight
 * clear can check that the override it started on is still the current one.
 */
export class DeviceMetricsOverrides {
  private nextGeneration = 1
  private readonly entries = new Map<number, OverrideEntry>()

  /** Records a forwarded set and returns its generation. */
  mark(tabId: number, sessionId: string | undefined): number {
    const generation = this.nextGeneration++
    this.entries.set(tabId, { sessionId, generation })
    return generation
  }

  generation(tabId: number): number {
    return this.entries.get(tabId)?.generation ?? 0
  }

  /** The session whose client set the tab's current override, if one is tracked. */
  sessionId(tabId: number): string | undefined {
    return this.entries.get(tabId)?.sessionId
  }

  /** True when the tab still has the override with this generation. */
  isCurrent(tabId: number, generation: number): boolean {
    return this.generation(tabId) === generation
  }

  /** Drops this session's ownership of its tabs, keeping their generations. */
  take(sessionId: string): Array<{ readonly tabId: number; readonly generation: number }> {
    const taken: Array<{ readonly tabId: number; readonly generation: number }> = []
    for (const [tabId, entry] of this.entries) {
      if (entry.sessionId !== sessionId) continue
      entry.sessionId = undefined
      taken.push({ tabId, generation: entry.generation })
    }
    return taken
  }

  /** Drops ownership after a clear, unless a newer set replaced it or another session owns it. */
  clear(tabId: number, generation: number, sessionId: string | undefined): void {
    const entry = this.entries.get(tabId)
    if (!entry || entry.generation !== generation) return
    if (sessionId !== undefined && entry.sessionId !== undefined && entry.sessionId !== sessionId) return
    entry.sessionId = undefined
  }

  /** Drops a tab when its runtime state goes away, so the map does not grow forever. */
  forget(tabId: number): void {
    this.entries.delete(tabId)
  }
}

/** Tabs an execute end should clear: this session's, visible, and never for a read-only session. */
export function tabsToClearOnExecuteEnd(options: {
  readonly overrides: DeviceMetricsOverrides
  readonly readOnly: boolean
  readonly sessionId: string
  readonly canSee: (tabId: number) => boolean
}): Array<{ readonly tabId: number; readonly generation: number }> {
  if (options.readOnly) return []
  return options.overrides.take(options.sessionId).filter(({ tabId }) => options.canSee(tabId))
}
