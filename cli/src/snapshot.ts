import { Effect, Predicate } from "effect"
import type { Frame, Locator, Page } from "patchright-core"
import { runPlaywrightOperation } from "./execute.ts"
import { runtimeFailureKind } from "./update/runtime-diagnostics.ts"
import { browserCapture, type captureSnapshotInBrowser } from "./snapshot/browser-capture.ts"
import {
  diffSnapshotEntries,
  findSnapshotLines,
  formatSnapshotDiffLine,
  formatSnapshotLine,
  snapshotRefAriaRole,
  snapshotRefIdentity,
} from "./snapshot/diff-and-format.ts"
import {
  captureSnapshotFrames,
  frameOfLocator,
  maxSnapshotFrames,
  type SnapshotFrame,
  type SnapshotFrameBudget,
} from "./snapshot/frames.ts"
import {
  defaultSnapshotTimeoutMs,
  invalidateSnapshotDocument,
  snapshotRetryDelayMs,
  type SnapshotCaptureResult,
  type SnapshotEntry,
  type SnapshotHelper,
  type SnapshotRefHelper,
  type SnapshotRefRegistry,
  type SnapshotRenderedEntry,
} from "./snapshot/types.ts"

export { fillInput, fillInputs } from "./snapshot/input-fill.ts"
export { screenshotWithLabels } from "./snapshot/screenshot-labels.ts"
export {
  createAriaSnapshotHelper,
  defaultAriaSnapshotTimeoutMs,
  invalidateSnapshotDocument,
  type AriaSnapshotHelper,
  type InputField,
  type InputTarget,
  type ScreenshotWithLabelsOptions,
  type ScreenshotWithLabelsResult,
  type SnapshotHelper,
  type SnapshotRefHelper,
  type SnapshotRefRegistry,
} from "./snapshot/types.ts"

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds))

type RenderedCapture = {
  readonly entries: SnapshotRenderedEntry[]
  /** Indentation level of each entry within its own document, after normalizing the capture's minimum to 0. */
  readonly depths: number[]
}

/** Turn a capture's entries into output lines, resolving structural parents to indentation. */
function renderSnapshotCapture(capture: SnapshotCaptureResult): RenderedCapture {
  const structuralEntries = new Map(capture.entries.flatMap((entry) => entry.key ? [[entry.key, entry] as const] : []))
  const resolvedDepths = new Map<SnapshotEntry, number>()
  const resolvedDepth = (entry: SnapshotEntry): number => {
    const cached = resolvedDepths.get(entry)
    if (cached !== undefined) return cached
    const parent = entry.parentKeys?.map((key) => structuralEntries.get(key)).find((candidate) => candidate !== undefined)
    const depth = parent ? resolvedDepth(parent) + 1 : entry.baseDepth ?? entry.depth
    resolvedDepths.set(entry, depth)
    return depth
  }
  const minimumDepth = capture.entries.reduce((minimum, entry) => Math.min(minimum, resolvedDepth(entry)), Number.POSITIVE_INFINITY)
  const depthOffset = Number.isFinite(minimumDepth) ? minimumDepth : 0
  return {
    entries: capture.entries.map((entry) => {
      const name = entry.name.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
      return {
        prefix: `${"  ".repeat(Math.max(0, resolvedDepth(entry) - depthOffset))}- ${entry.role} "${name}"`,
        ...(entry.details ? { details: entry.details } : {}),
        ...(entry.selector ? { selector: entry.selector, role: entry.selectorRole ?? entry.role } : {}),
        ...(entry.identityName ? { identityName: entry.identityName } : {}),
      }
    }),
    depths: capture.entries.map((entry) => Math.max(0, resolvedDepth(entry) - depthOffset)),
  }
}

export function createSnapshotHelpers(page: Page, registry: SnapshotRefRegistry): {
  readonly snapshot: SnapshotHelper
  readonly ref: SnapshotRefHelper
} {
  const refRoots = new WeakMap<Locator, { readonly selector: string; readonly role: string; readonly name?: string; readonly frame?: Frame }>()
  const snapshot: SnapshotHelper = async (options = {}) => {
    const within = options.within
    const withinSelector = Predicate.isString(within) ? within : undefined
    const withinLocator = within !== undefined && !Predicate.isString(within) ? within : undefined
    const refRoot = withinLocator ? refRoots.get(withinLocator) : undefined
    const locator = withinLocator && !refRoot ? withinLocator : undefined
    let locatorScope: number | undefined
    if (locator) {
      const scopes = registry.locatorScopes ??= new WeakMap()
      locatorScope = scopes.get(locator)
      if (locatorScope === undefined) {
        locatorScope = registry.nextLocatorScope ?? 1
        registry.nextLocatorScope = locatorScope + 1
        scopes.set(locator, locatorScope)
      }
    }
    const depth = Math.max(1, Math.min(16, Math.floor(options.depth ?? 10)))
    const maxItems = Math.max(1, Math.min(200, Math.floor(options.maxItems ?? 80)))
    const includeFrames = options.frames !== false
    const timeoutMs = options.timeout ?? defaultSnapshotTimeoutMs
    const deadline = Date.now() + timeoutMs
    const settings = {
      compact: options.compact ?? true,
      depth,
      interactive: options.interactive ?? false,
      maxCandidates: Math.max(1_000, maxItems * 20),
      maxItems,
      rootSelector: withinSelector ?? refRoot?.selector,
      rootRole: refRoot?.role,
      rootName: refRoot?.name,
      ...(withinSelector === undefined ? {} : { reportRootFallback: true }),
    }
    const signature = JSON.stringify({
      compact: settings.compact,
      depth: settings.depth,
      interactive: settings.interactive,
      frames: includeFrames,
      maxItems: settings.maxItems,
      scope: withinSelector !== undefined
        ? { kind: "selector", selector: withinSelector }
        : refRoot
        ? { kind: "ref", selector: refRoot.selector, role: refRoot.role, name: refRoot.name }
        : locator
        ? { kind: "locator", scope: locatorScope }
        : { kind: "page" },
    })
    const previousSnapshot = registry.previousSnapshot
    if (options.diff && options.delta) {
      throw new Error("snapshot() accepts either diff or delta, not both")
    }
    if (options.diff && !previousSnapshot) {
      throw new Error("snapshot({ diff: true }) requires a previous snapshot() baseline in this session")
    }
    if (options.diff && (previousSnapshot?.page !== page || previousSnapshot.signature !== signature)) {
      throw new Error("snapshot({ diff: true }) must use the same page and snapshot options as the previous snapshot")
    }

    // A `within` locator scoped to an iframe captures, and registers refs, in that frame. A ref root remembers
    // the frame it was captured in, so `within: ref("e12")` reads the same document.
    let captureFrame: Frame = refRoot?.frame ?? page.mainFrame()
    if (locator) captureFrame = await frameOfLocator(locator, timeoutMs)

    registry.removeNavigationListener?.()
    registry.selectors.clear()
    delete registry.page
    delete registry.url
    const frameGenerations = registry.frameGenerations ??= new WeakMap()
    let navigatedDuringCapture = false
    const onFrameNavigated = (frame: Frame) => {
      if (frame !== page.mainFrame()) {
        // The frame's document is gone: its refs fail closed, and nothing else changes.
        frameGenerations.set(frame, (frameGenerations.get(frame) ?? 0) + 1)
        return
      }
      navigatedDuringCapture = true
      invalidateSnapshotDocument(registry)
    }
    const removeNavigationListener = () => page.off("framenavigated", onFrameNavigated)
    page.on("framenavigated", onFrameNavigated)
    registry.removeNavigationListener = removeNavigationListener

    let result: Awaited<ReturnType<typeof captureSnapshotInBrowser>>
    if (locator) {
      result = await locator.evaluate(browserCapture, settings, { timeout: timeoutMs })
    } else {
      let captureAttempts = 0
      while (true) {
        navigatedDuringCapture = false
        try {
          result = await Effect.runPromise(runPlaywrightOperation({
            label: "Compact snapshot",
            timeoutMs: Math.max(100, deadline - Date.now()),
            run: () => captureFrame.evaluate(browserCapture, settings),
          }))
          if (navigatedDuringCapture && !options.diff && ++captureAttempts < 3 && Date.now() + snapshotRetryDelayMs < deadline) {
            await delay(snapshotRetryDelayMs)
            continue
          }
          if (result.needsSettle && !options.diff && captureAttempts === 0 && Date.now() + 120 < deadline) {
            captureAttempts++
            await captureFrame.evaluate(`new Promise((resolve) => {
              let quietTimer = window.setTimeout(done, 120);
              const maxTimer = window.setTimeout(done, 550);
              const observer = new MutationObserver(() => {
                window.clearTimeout(quietTimer);
                quietTimer = window.setTimeout(done, 55);
              });
              function done() {
                observer.disconnect();
                window.clearTimeout(quietTimer);
                window.clearTimeout(maxTimer);
                resolve();
              }
              if (document.body) {
                observer.observe(document.body, { childList: true, subtree: true, attributes: true });
              } else {
                done();
              }
            })`).catch(() => {})
            continue
          }
          break
        } catch (error) {
          if (withinSelector !== undefined && /not a valid selector|querySelectorAll/i.test(error instanceof Error ? error.message : String(error))) {
            result = await captureFrame.locator(withinSelector).evaluate(browserCapture, { ...settings, rootSelector: undefined }, { timeout: timeoutMs })
            break
          }
          const kind = runtimeFailureKind(error)
          if ((kind === "context-destroyed" || kind === "context-missing") && !options.diff && Date.now() + snapshotRetryDelayMs < deadline) {
            await delay(snapshotRetryDelayMs)
            continue
          }
          throw error
        }
      }
    }

    if (navigatedDuringCapture) {
      removeNavigationListener()
      delete registry.removeNavigationListener
      throw new Error("Page navigated while snapshot() was capturing; call snapshot() again")
    }
    registry.page = page
    registry.url = page.url()
    registry.selectors.clear()

    const main = renderSnapshotCapture(result)
    const frameBudget: SnapshotFrameBudget = { frames: maxSnapshotFrames, skipped: 0 }
    const frameNodes: ReadonlyMap<number, SnapshotFrame> = includeFrames && result.entries.some((entry) => entry.iframe)
      ? await captureSnapshotFrames({
          frame: captureFrame,
          entries: result.entries,
          settings,
          deadline,
          budget: frameBudget,
          depth: 1,
        })
      : new Map()

    // Merge frame documents under their iframe lines. The main capture already spent part of maxItems; frame
    // content and its nested frames share what is left, so the whole snapshot stays within one budget.
    const entries: SnapshotRenderedEntry[] = []
    const frameObjects = new Map<string, Frame>()
    let remainingItems = Math.max(0, maxItems - main.entries.length)
    let nextFrameKey = 1
    let omittedFrames = false
    const emitFrame = (node: SnapshotFrame, indent: number): void => {
      const indentation = "  ".repeat(indent)
      if (node.note) {
        entries.push({ prefix: `${indentation}- ... ${node.note}` })
        return
      }
      const frame = node.frame
      if (!frame) return
      if (remainingItems <= 0) {
        if (!omittedFrames) {
          entries.push({ prefix: `${indentation}- ... frame content omitted (maxItems reached)` })
          omittedFrames = true
        }
        return
      }
      const frameKey = `f${nextFrameKey++}`
      frameObjects.set(frameKey, frame)
      const child = renderSnapshotCapture(node.capture)
      for (const [index, entry] of child.entries.entries()) {
        if (remainingItems <= 0) {
          if (!omittedFrames) {
            entries.push({ prefix: `${indentation}- ... frame content truncated (maxItems reached)` })
            omittedFrames = true
          }
          break
        }
        const rendered = { ...entry, prefix: `${indentation}${entry.prefix}`, frameKey }
        entries.push(rendered)
        remainingItems -= 1
        const nested = node.children.get(index)
        if (nested) emitFrame(nested, indent + child.depths[index]! + 1)
      }
      if (node.capture.truncated && remainingItems > 0) {
        entries.push({ prefix: `${indentation}- ... frame content truncated after ${maxItems} items` })
      }
    }
    for (const [index, entry] of main.entries.entries()) {
      entries.push(entry)
      const node = frameNodes.get(index)
      if (node) emitFrame(node, main.depths[index]! + 1)
    }
    if (result.truncated) entries.push({ prefix: `- ... truncated after ${maxItems} items` })
    if (frameBudget.skipped > 0) {
      entries.push({ prefix: `- ... ${frameBudget.skipped} iframe ${frameBudget.skipped === 1 ? "content" : "contents"} not captured (${maxSnapshotFrames} at most per snapshot)` })
    }

    const compatiblePrevious = previousSnapshot?.page === page && previousSnapshot.signature === signature
      ? previousSnapshot
      : undefined
    let nextRef = registry.nextRef ?? 1
    const reusableRefs = new Map<string, string[]>()
    for (const entry of compatiblePrevious?.entries ?? []) {
      if (!entry.refId) continue
      const key = snapshotRefIdentity(entry)
      if (!key) continue
      const refs = reusableRefs.get(key) ?? []
      refs.push(entry.refId)
      reusableRefs.set(key, refs)
    }
    const rendered = entries.map((entry): SnapshotRenderedEntry => {
      const key = snapshotRefIdentity(entry)
      if (!key) return entry
      const reused = reusableRefs.get(key)?.shift()
      return { ...entry, refId: reused ?? `e${nextRef++}` }
    })
    registry.nextRef = nextRef

    const registerRef = (entry: SnapshotRenderedEntry, id: string): void => {
      if (!entry.selector || !entry.role) return
      // Entries of a capture rooted inside a frame belong to that frame; nested frames carry their own key.
      const frame = entry.frameKey ? frameObjects.get(entry.frameKey) : captureFrame === page.mainFrame() ? undefined : captureFrame
      registry.selectors.set(id, {
        selector: entry.selector,
        role: entry.role,
        ...(entry.identityName ? { name: entry.identityName } : {}),
        ...(frame ? { frame, frameGeneration: frameGenerations.get(frame) ?? 0 } : {}),
      })
    }

    for (const entry of rendered) {
      if (entry.refId) registerRef(entry, entry.refId)
    }

    const useDiff = options.diff === true || (options.delta === true && compatiblePrevious !== undefined)
    registry.previousSnapshot = { page, signature, entries: rendered }
    if (!useDiff) {
      const lines = [...(result.notes ?? []), ...rendered.map((entry) => formatSnapshotLine(entry, entry.refId))]
      return options.find === undefined
        ? lines.join("\n")
        : findSnapshotLines(lines, options.find, options.context)
    }

    const operations = diffSnapshotEntries(compatiblePrevious?.entries ?? [], rendered)
    const lines: string[] = [...(result.notes ?? [])]
    let additions = 0
    let removals = 0
    let unchanged = 0
    for (const operation of operations) {
      if (operation.kind === "unchanged") {
        unchanged++
        continue
      }
      if (operation.kind === "removed") {
        removals++
        lines.push(formatSnapshotDiffLine("-", operation.entry))
        continue
      }
      additions++
      lines.push(formatSnapshotDiffLine("+", operation.entry, operation.entry.refId))
    }
    lines.push(`${additions} ${additions === 1 ? "addition" : "additions"}, ${removals} ${removals === 1 ? "removal" : "removals"}, ${unchanged} unchanged`)
    return lines.join("\n")
  }

  const ref: SnapshotRefHelper = (id) => {
    if (!Predicate.isString(id) || !id.trim()) {
      throw new Error(`Unknown snapshot ref: ${String(id)}; call snapshot() to get current refs`)
    }
    const normalized = id.startsWith("@") ? id.slice(1) : id
    if (registry.page !== page || registry.url !== page.url()) {
      throw new Error("Snapshot refs are stale after a page change; call snapshot() again")
    }
    const snapshotRef = registry.selectors.get(normalized)
    if (!snapshotRef) {
      throw new Error(`Unknown snapshot ref: ${id}; call snapshot() to get current refs`)
    }
    const frame = snapshotRef.frame
    if (frame) {
      const generation = registry.frameGenerations?.get(frame) ?? 0
      if (frame.isDetached() || (snapshotRef.frameGeneration !== undefined && generation !== snapshotRef.frameGeneration)) {
        throw new Error(`Snapshot ref ${id} was captured in an iframe that has navigated or detached; call snapshot() again`)
      }
    }
    const locator = frame ? frame.locator(snapshotRef.selector) : page.locator(snapshotRef.selector)
    const role = snapshotRefAriaRole(snapshotRef.role)
    const resolved = role
      ? frame
        ? locator.and(frame.getByRole(role, snapshotRef.name ? { name: snapshotRef.name, exact: true } : undefined))
        : locator.and(page.getByRole(role, snapshotRef.name ? { name: snapshotRef.name, exact: true } : undefined))
      : locator
    refRoots.set(resolved, snapshotRef)
    return resolved
  }

  return { snapshot, ref }
}
