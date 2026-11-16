import { Effect } from "effect"
import type { Frame, FrameLocator, Locator } from "patchright-core"
import { runPlaywrightOperation } from "../execute/page-recovery.ts"
import { runtimeFailureKind } from "../update/runtime-diagnostics.ts"
import { browserCapture } from "./browser-capture.ts"
import type { SnapshotCaptureResult, SnapshotCaptureSettings, SnapshotEntry } from "./types.ts"

/**
 * Iframe documents captured per snapshot: room for a checkout with a payment and a 3-D Secure frame, not every ad
 * slot on a page. The rest are listed as entries but their content is skipped with a note.
 */
export const maxSnapshotFrames = 8
/** Frames nested in frames. A payment page inside a checkout inside a shop is three. */
export const maxSnapshotFrameDepth = 3
/** One frame gets at least this long, even when many frames share a short deadline. */
export const maxSnapshotFrameTimeoutMs = 1_000

/**
 * One frame's slice of the deadline: an even share of what is left across the frames actually still to capture
 * (never the fixed cap), at least a second, and never more than the deadline itself. A hung first frame cannot
 * starve later ones, while a single slow frame gets the time the caller allowed.
 */
export function frameCaptureTimeoutMs(remainingMs: number, framesLeft: number): number {
  return Math.min(remainingMs, Math.max(maxSnapshotFrameTimeoutMs, Math.floor(remainingMs / Math.max(1, framesLeft))))
}

export type SnapshotFrame = {
  /** The child frame, or undefined when the iframe element has no frame attached. */
  readonly frame?: Frame
  readonly capture: SnapshotCaptureResult
  /** Frames under this frame's own entries, keyed by entry index. */
  readonly children: ReadonlyMap<number, SnapshotFrame>
  /** One short sentence, rendered under the iframe line when its document could not be captured. */
  readonly note?: string
  /** The frame's navigation generation when the capture started; refs registered with it fail closed afterwards. */
  readonly generation: number
}

export type SnapshotFrameBudget = {
  /** Frames left to capture across the whole snapshot. Mutated as frames are claimed. */
  frames: number
  /** Snapshot items left to spend on frame content (the main capture already spent part of maxItems). */
  items: number
  /** Frames left uncaptured, by reason, for the notes after the entries. */
  readonly skipped: { budget: number; deadline: number; items: number }
}

/**
 * Capture the documents of the iframes among `entries`, depth first, bounded by the frame and item budgets and
 * the snapshot deadline. A frame that detaches, navigates, refuses to answer or cannot be redacted becomes a note
 * on its iframe entry; it never fails the snapshot.
 */
export async function captureSnapshotFrames(options: {
  /** The frame that owns `entries` (the snapshot's capture root or a parent iframe). */
  readonly frame: Frame
  readonly entries: readonly SnapshotEntry[]
  readonly settings: SnapshotCaptureSettings
  readonly deadline: number
  readonly budget: SnapshotFrameBudget
  readonly depth: number
  readonly frameGenerations: WeakMap<Frame, number>
}): Promise<ReadonlyMap<number, SnapshotFrame>> {
  const frames = new Map<number, SnapshotFrame>()
  for (const [index, entry] of options.entries.entries()) {
    if (!entry.iframe || !entry.selector) continue
    if (options.depth > maxSnapshotFrameDepth) {
      frames.set(index, {
        capture: { entries: [], truncated: false },
        children: new Map(),
        generation: 0,
        note: `content not captured (frames nested deeper than ${maxSnapshotFrameDepth})`,
      })
      continue
    }
    if (options.budget.frames <= 0) {
      options.budget.skipped.budget += 1
      continue
    }
    if (options.budget.items <= 0) {
      options.budget.skipped.items += 1
      continue
    }
    const remaining = options.deadline - Date.now()
    if (remaining <= 0) {
      options.budget.skipped.deadline += 1
      continue
    }
    // Share the deadline across the iframes this document still has, capped by the global frame budget, so a
    // single slow frame gets what the caller allowed instead of one eighth of it.
    const framesAhead = options.entries.slice(index).filter((candidate) => candidate.iframe && candidate.selector).length
    const timeout = frameCaptureTimeoutMs(remaining, Math.min(options.budget.frames, framesAhead))
    // This frame's slice covers its whole subtree: a hung nested frame cannot spend the time reserved for the
    // frame's later siblings.
    const frameDeadline = Math.min(options.deadline, Date.now() + timeout)
    options.budget.frames -= 1
    const frame = await contentFrameOf(options.frame, entry.selector, timeout)
    if (!frame) {
      frames.set(index, {
        capture: { entries: [], truncated: false },
        children: new Map(),
        generation: 0,
        note: "content not captured (the iframe is gone or has no frame attached)",
      })
      continue
    }
    // Recorded before the read: a frame that navigates while it is captured keeps a stale generation, so the
    // refs registered from that document fail closed instead of resolving into the new one.
    const generation = options.frameGenerations.get(frame) ?? 0
    const settings = childSettings(options.settings, entry.depth)
    try {
      const capture = await Effect.runPromise(runPlaywrightOperation({
        label: "Frame snapshot",
        timeoutMs: Math.max(1, frameDeadline - Date.now()),
        run: () => frame.evaluate(browserCapture, settings),
      }))
      options.budget.items = Math.max(0, options.budget.items - capture.entries.length)
      const children = await captureSnapshotFrames({
        frame,
        entries: capture.entries,
        settings,
        deadline: frameDeadline,
        budget: options.budget,
        depth: options.depth + 1,
        frameGenerations: options.frameGenerations,
      })
      frames.set(index, { frame, capture, children, generation })
    } catch (error) {
      frames.set(index, {
        frame,
        capture: { entries: [], truncated: false },
        children: new Map(),
        generation,
        note: `content not captured (${frameFailureNote(error)})`,
      })
    }
  }
  return frames
}

/**
 * The frame of a `within` scope, so a snapshot scoped inside an iframe reads and registers refs there. A
 * FrameLocator scopes to the frame it points at; a Locator scopes to the frame that owns the element.
 */
export async function frameOfScope(scope: Locator | FrameLocator, timeoutMs: number): Promise<Frame> {
  const probe = isFrameLocator(scope) ? scope.locator("html") : scope
  const handle = await probe.elementHandle({ timeout: Math.max(1, timeoutMs) })
  if (!handle) throw new Error("snapshot within target did not resolve to an element")
  try {
    const frame = await handle.ownerFrame()
    if (!frame) throw new Error("snapshot within target is not attached to a frame")
    return frame
  } finally {
    await handle.dispose().catch(() => {})
  }
}

/** A FrameLocator has no elementHandle; every Locator does. */
export function isFrameLocator(value: Locator | FrameLocator): value is FrameLocator {
  return typeof (value as Locator).elementHandle !== "function"
}

async function contentFrameOf(parent: Frame, selector: string, timeoutMs: number): Promise<Frame | undefined> {
  const timeout = Math.max(1, timeoutMs)
  const handle = await parent.locator(selector).elementHandle({ timeout }).catch(() => null)
  if (!handle) return undefined
  try {
    return (await handle.contentFrame()) ?? undefined
  } catch {
    return undefined
  } finally {
    await handle.dispose().catch(() => {})
  }
}

/** A child document keeps the parent's presentation choices, never its root scope, and a bounded budget. */
function childSettings(settings: SnapshotCaptureSettings, iframeDepth: number): SnapshotCaptureSettings {
  const { rootSelector: _selector, rootRole: _role, rootName: _name, reportRootFallback: _fallback, ...inherited } = settings
  return {
    ...inherited,
    depth: Math.max(1, inherited.depth - iframeDepth - 1),
    maxCandidates: Math.max(200, inherited.maxItems * 20),
    rootSelector: undefined,
    rootRole: undefined,
    rootName: undefined,
  }
}

export const frameSkipNote = (count: number, reason: string): string =>
  `- ... ${count} iframe ${count === 1 ? "content" : "contents"} not captured (${reason})`

export function frameFailureNote(cause: unknown): string {
  switch (runtimeFailureKind(cause)) {
    case "context-destroyed":
    case "context-missing":
    case "target-closed":
      return "the frame changed while capturing"
    case "timeout":
      return "the frame did not answer in time"
    default:
      return "the frame could not be read"
  }
}
