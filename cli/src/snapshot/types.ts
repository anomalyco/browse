import { Predicate } from "effect"
import type { Locator, Page } from "patchright-core"
import { ariaSnapshotWithoutTextControlValues } from "./aria-snapshot.ts"

export type AriaSnapshotTarget = Locator | string

export type AriaSnapshotOptions = {
  readonly timeout?: number
}

export type AriaSnapshotHelper = (target?: AriaSnapshotTarget, options?: AriaSnapshotOptions) => Promise<string>

export type SnapshotOptions = {
  /**
   * Scope the snapshot to a selector string or a locator. A string with more than one match snapshots the first
   * visible one, and a string with no match snapshots the whole page; either case adds a note to the output. A
   * locator keeps Playwright's strict requirement that it resolves to one element.
   */
  readonly within?: AriaSnapshotTarget
  readonly interactive?: boolean
  readonly compact?: boolean
  readonly diff?: boolean
  readonly delta?: boolean
  readonly find?: string | RegExp
  readonly context?: number
  readonly depth?: number
  readonly maxItems?: number
  readonly timeout?: number
}

export type SnapshotHelper = (options?: SnapshotOptions) => Promise<string>
export type SnapshotRefHelper = (id: string) => Locator

export type SnapshotEntry = {
  readonly depth: number
  readonly baseDepth?: number
  readonly key?: string
  readonly parentKeys?: readonly string[]
  readonly role: string
  readonly name: string
  readonly identityName?: string
  readonly details?: string
  readonly selector?: string
  readonly selectorRole?: string
  readonly priority: number
}

export type SnapshotRefRegistry = {
  page?: Page
  url?: string
  selectors: Map<string, { readonly selector: string; readonly role: string; readonly name?: string }>
  previousSnapshot?: SnapshotBaseline
  nextRef?: number
  locatorScopes?: WeakMap<Locator, number>
  nextLocatorScope?: number
  removeNavigationListener?: () => void
}

export type SnapshotRenderedEntry = {
  readonly prefix: string
  readonly details?: string
  readonly selector?: string
  readonly role?: string
  readonly identityName?: string
  readonly refId?: string
}

export type SnapshotBaseline = {
  readonly page: Page
  readonly signature: string
  readonly entries: readonly SnapshotRenderedEntry[]
}

export type SnapshotCaptureSettings = {
  readonly compact: boolean
  readonly depth: number
  readonly interactive: boolean
  readonly maxCandidates: number
  readonly maxItems: number
  readonly rootSelector: string | undefined
  readonly rootRole: string | undefined
  readonly rootName: string | undefined
  /** Set for a `within` selector, never for a ref: report an ambiguous or empty root in the snapshot output. */
  readonly reportRootFallback?: boolean
}

export type SnapshotCaptureResult = {
  readonly entries: readonly SnapshotEntry[]
  readonly truncated: boolean
  readonly needsSettle?: boolean
  /** Plain sentences describing how a `within` scope resolved, shown above the snapshot lines. */
  readonly notes?: readonly string[]
}

export type InputTarget = AriaSnapshotTarget

export const defaultAriaSnapshotTimeoutMs = 5_000
export const defaultSnapshotTimeoutMs = 10_000
export const snapshotRetryDelayMs = 25

export type InputField = {
  readonly selector: InputTarget
  readonly value: string
}

export type ScreenshotWithLabelsOptions = {
  readonly page?: Page
  readonly path?: string
  readonly registry?: SnapshotRefRegistry
  /**
   * Draw the labels onto the screenshot image instead of into the page, so a recording of the tab never shows them.
   * The relay sets it while the tab is recorded.
   */
  readonly offPage?: boolean
}

export type ScreenshotWithLabelsResult = {
  readonly path?: string
  readonly image?: Buffer
  readonly size: number
  readonly labelCount: number
  readonly labels: readonly ScreenshotLabel[]
}

export type ScreenshotLabel = {
  readonly ref: string
  readonly selector: string
  readonly role: string
  readonly text: string
  readonly context?: string
  readonly tagName: string
  readonly rect: ScreenshotLabelRect
}

export type ScreenshotLabelRect = {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export function createAriaSnapshotHelper(page: Pick<Page, "locator">): AriaSnapshotHelper {
  return async (target, options) => {
    const locator = target === undefined ? page.locator("body") : Predicate.isString(target) ? page.locator(target) : target
    return await ariaSnapshotWithoutTextControlValues(locator, {
      timeout: options?.timeout ?? defaultAriaSnapshotTimeoutMs,
    })
  }
}

/** Refs and diff baselines never survive the document they were captured from. */
export function invalidateSnapshotDocument(registry: SnapshotRefRegistry): void {
  registry.selectors.clear()
  delete registry.page
  delete registry.url
  delete registry.previousSnapshot
}
