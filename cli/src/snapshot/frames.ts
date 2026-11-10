import { Effect } from "effect"
import type { Frame, Locator } from "patchright-core"
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
/** Resolving one iframe element is a local DOM query; it must not eat the snapshot's deadline. */
const frameAttachTimeoutMs = 2_000

export type SnapshotFrame = {
  /** The child frame, or undefined when the iframe element has no frame attached. */
  readonly frame?: Frame
  readonly capture: SnapshotCaptureResult
  /** Frames under this frame's own entries, keyed by entry index. */
  readonly children: ReadonlyMap<number, SnapshotFrame>
  /** One short sentence, rendered under the iframe line when its document could not be captured. */
  readonly note?: string
}

export type SnapshotFrameBudget = {
  /** Frames left to capture across the whole snapshot. Mutated as frames are claimed. */
  frames: number
  /** Iframes left uncaptured because the budget ran out. */
  skipped: number
}

/**
 * Capture the documents of the iframes among `entries`, depth first, bounded by the frame budget and the
 * snapshot deadline. A frame that detaches, navigates or refuses to answer becomes a note on its iframe entry;
 * it never fails the snapshot.
 */
export async function captureSnapshotFrames(options: {
  /** The frame that owns `entries` (the snapshot's capture root or a parent iframe). */
  readonly frame: Frame
  readonly entries: readonly SnapshotEntry[]
  readonly settings: SnapshotCaptureSettings
  readonly deadline: number
  readonly budget: SnapshotFrameBudget
  readonly depth: number
}): Promise<ReadonlyMap<number, SnapshotFrame>> {
  const frames = new Map<number, SnapshotFrame>()
  for (const [index, entry] of options.entries.entries()) {
    if (!entry.iframe || !entry.selector) continue
    if (options.depth > maxSnapshotFrameDepth) {
      frames.set(index, {
        capture: { entries: [], truncated: false },
        children: new Map(),
        note: `content not captured (frames nested deeper than ${maxSnapshotFrameDepth})`,
      })
      continue
    }
    if (options.budget.frames <= 0) {
      options.budget.skipped += 1
      continue
    }
    options.budget.frames -= 1
    const frame = await contentFrameOf(options.frame, entry.selector, options.deadline)
    if (!frame) {
      frames.set(index, {
        capture: { entries: [], truncated: false },
        children: new Map(),
        note: "content not captured (the iframe is gone or has no frame attached)",
      })
      continue
    }
    const settings = childSettings(options.settings, entry.depth)
    try {
      const capture = await Effect.runPromise(runPlaywrightOperation({
        label: "Frame snapshot",
        timeoutMs: remainingMs(options.deadline),
        run: () => frame.evaluate(browserCapture, settings),
      }))
      const children = await captureSnapshotFrames({
        frame,
        entries: capture.entries,
        settings,
        deadline: options.deadline,
        budget: options.budget,
        depth: options.depth + 1,
      })
      frames.set(index, { frame, capture, children })
    } catch (error) {
      frames.set(index, {
        frame,
        capture: { entries: [], truncated: false },
        children: new Map(),
        note: `content not captured (${frameFailureNote(error)})`,
      })
    }
  }
  return frames
}

/** The frame of a `within` locator, so a snapshot scoped inside an iframe reads and registers refs there. */
export async function frameOfLocator(locator: Locator, timeoutMs: number): Promise<Frame> {
  const handle = await locator.elementHandle({ timeout: Math.max(1, timeoutMs) })
  if (!handle) throw new Error("snapshot within target did not resolve to an element")
  try {
    const frame = await handle.ownerFrame()
    if (!frame) throw new Error("snapshot within target is not attached to a frame")
    return frame
  } finally {
    await handle.dispose().catch(() => {})
  }
}

/** Every frame nested under `frame`, depth first, without duplicates. */
export function frameDescendants(frame: Frame): Frame[] {
  const descendants: Frame[] = []
  const visit = (parent: Frame): void => {
    for (const child of parent.childFrames()) {
      if (child === frame || descendants.includes(child)) continue
      descendants.push(child)
      visit(child)
    }
  }
  visit(frame)
  return descendants
}

async function contentFrameOf(parent: Frame, selector: string, deadline: number): Promise<Frame | undefined> {
  const timeout = Math.max(1, Math.min(frameAttachTimeoutMs, deadline - Date.now()))
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

function frameFailureNote(cause: unknown): string {
  switch (runtimeFailureKind(cause)) {
    case "context-destroyed":
    case "context-missing":
    case "target-closed":
      return "the frame changed while capturing"
    case "timeout":
      return "the frame did not answer before the snapshot deadline"
    default:
      return "the frame could not be read"
  }
}

function remainingMs(deadline: number): number {
  return Math.max(100, deadline - Date.now())
}
