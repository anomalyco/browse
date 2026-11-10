import { Predicate } from "effect"
import type { Frame, FrameLocator, Locator, Page } from "patchright-core"
import { ariaSnapshotWithFrames } from "./aria-snapshot.ts"

export type AriaSnapshotTarget = Locator | string
/** A `within` scope: a selector, a locator in some frame, or a FrameLocator for that frame's whole document. */
export type SnapshotScope = Locator | FrameLocator | string

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
  readonly within?: SnapshotScope
  readonly interactive?: boolean
  readonly compact?: boolean
  readonly diff?: boolean
  readonly delta?: boolean
  readonly find?: string | RegExp
  readonly context?: number
  readonly depth?: number
  readonly maxItems?: number
  readonly timeout?: number
  /**
   * Capture the content of visible iframes and frames too, nested under their `iframe` line, and let refs from
   * that content resolve in the frame. Defaults to true; turn it off for a page whose embeds are irrelevant or
   * expensive.
   */
  readonly frames?: boolean
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
  /** The element is an `<iframe>`/`<frame>`; its document is captured separately and nested under this entry. */
  readonly iframe?: boolean
  /** The capture root, rendered as an entry of its own; its descendants sit at least one level below it. */
  readonly root?: boolean
  readonly priority: number
}

/** Where a snapshot ref lives: the session page or the frame it was captured in. */
export type SnapshotRefTarget = {
  readonly selector: string
  readonly role: string
  readonly name?: string
  /** Set when the element is inside a frame; refs then resolve with `frame.locator`, not `page.locator`. */
  readonly frame?: Frame
  /** The frame's generation when the ref was captured; a navigation bumps it and makes the ref stale. */
  readonly frameGeneration?: number
}

export type SnapshotRefRegistry = {
  page?: Page
  url?: string
  selectors: Map<string, SnapshotRefTarget>
  previousSnapshot?: SnapshotBaseline
  nextRef?: number
  locatorScopes?: WeakMap<object, number>
  nextLocatorScope?: number
  /** Stable ids for frames, so a ref is never reused for an element in a different frame. */
  frameIds?: WeakMap<Frame, string>
  nextFrameId?: number
  removeNavigationListener?: () => void
  /** Per-frame document generations, bumped on `framenavigated`, so frame refs fail closed after a navigation. */
  frameGenerations?: WeakMap<Frame, number>
}

export type SnapshotRenderedEntry = {
  readonly prefix: string
  readonly details?: string
  readonly selector?: string
  readonly role?: string
  readonly identityName?: string
  readonly refId?: string
  /** Identifies the captured frame the entry came from, so identical selectors in two frames never share a ref. */
  readonly frameKey?: string
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
    return await ariaSnapshotWithFrames(locator, {
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
