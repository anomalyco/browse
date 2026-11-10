import type { BrowserContext, Frame, Locator, Page } from "patchright-core"
import { runtimeFailureKind } from "../update/runtime-diagnostics.ts"
import { frameCaptureTimeoutMs, frameFailureNote, frameSkipNote, maxSnapshotFrameDepth, maxSnapshotFrames } from "./frames.ts"

const redactionCleanupErrorMessage = "browse could not confirm ARIA snapshot value-redaction cleanup"

/** A document that may still carry redaction patches; `captureFailed` says its content was never captured. */
export class AriaSnapshotRedactionError extends AggregateError {
  constructor(errors: readonly unknown[], readonly captureFailed: boolean) {
    super([...errors], redactionCleanupErrorMessage)
  }
}
/** Reads the body (or frameset) of a document as its snapshot target. */
const documentRootSelector = "body, frameset"
/** Listing iframes is cheap; give it a floor even when the tree read used up the caller's timeout. */
const minFrameListingTimeoutMs = 300
// Keep the engine as source text so bundlers cannot inject Node-only helpers into the browser function.
const redactionSelectorSource = `({
  query(root, body) {
    const separator = body.indexOf("_")
    const action = body.slice(0, separator)
    const token = body.slice(separator + 1)
    const stateKey = "__opencodeBrowserAriaRedactionState__"
    let state = globalThis[stateKey]

    if (action === "on") {
      if (!state) {
        state = {
          tokens: new Set(),
          editableNameAttributes: new Set(["alt", "aria-description", "aria-describedby", "aria-label", "aria-labelledby", "aria-placeholder", "placeholder", "title"]),
          nonTextInputTypes: new Set(["button", "checkbox", "file", "hidden", "image", "radio", "reset", "submit"]),
          valueAttributes: new Set(["aria-valuenow", "aria-valuetext", "value"]),
          valueRoles: new Set(["meter", "progressbar", "scrollbar", "separator", "slider", "spinbutton"]),
          inputValue: Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value"),
          textareaValue: Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value"),
          nodeValue: Object.getOwnPropertyDescriptor(Node.prototype, "nodeValue"),
          textContent: Object.getOwnPropertyDescriptor(Node.prototype, "textContent"),
          innerText: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "innerText"),
          getAttribute: Object.getOwnPropertyDescriptor(Element.prototype, "getAttribute"),
        }
        globalThis[stateKey] = state
        const getAttribute = (element, name) => state.getAttribute.value.call(element, name)
        const explicitEditableState = (element) => {
          const value = getAttribute(element, "contenteditable")
          if (value === null) return undefined
          const normalized = value.trim().toLowerCase()
          if (normalized === "false") return false
          return normalized === "" || normalized === "true" || normalized === "plaintext-only" ? true : undefined
        }
        const composedParent = (node) => {
          if (node.parentNode) return node.parentNode
          const treeRoot = node.getRootNode?.()
          return treeRoot instanceof ShadowRoot ? treeRoot.host : null
        }
        const isInEditableSubtree = (node) => {
          let current = node.nodeType === Node.TEXT_NODE ? node.parentNode : node
          while (current) {
            if (current instanceof Element) {
              const explicit = explicitEditableState(current)
              if (explicit !== undefined) return explicit
              if (current instanceof HTMLElement && current.isContentEditable) return true
            }
            current = composedParent(current)
          }
          return false
        }
        const isEditableDescendant = (element) => explicitEditableState(element) !== true && isInEditableSubtree(element)
        const isNativeTextControl = (element) => element instanceof HTMLTextAreaElement
          || (element instanceof HTMLInputElement && !state.nonTextInputTypes.has(element.type))
        const readOnlyAutocompleteTokens = new Set(["current-password", "new-password", "one-time-code", "cc-number", "cc-csc", "cc-exp", "cc-exp-month", "cc-exp-year"])
        const isReadOnlyTextControl = (element) => {
          if (!isNativeTextControl(element) || !element.readOnly) return false
          if (element instanceof HTMLInputElement && element.type === "password") return false
          const autocomplete = getAttribute(element, "autocomplete")
          return autocomplete === null
            || !autocomplete.trim().toLowerCase().split(/\\s+/).some((token) => readOnlyAutocompleteTokens.has(token))
        }
        const isValueRole = (element) => {
          const role = getAttribute(element, "role")
          return role !== null && role.trim().toLowerCase().split(/\\s+/).some((candidate) => state.valueRoles.has(candidate))
        }
        const hasRedactedText = (node) => isInEditableSubtree(node)
          || (node.nodeType === Node.TEXT_NODE && node.parentElement && isNativeTextControl(node.parentElement))
        Object.defineProperty(HTMLInputElement.prototype, "value", {
          ...state.inputValue,
          get() {
            return isNativeTextControl(this) && !isReadOnlyTextControl(this) ? "" : state.inputValue.get.call(this)
          },
        })
        Object.defineProperty(HTMLTextAreaElement.prototype, "value", {
          ...state.textareaValue,
          get() {
            return isReadOnlyTextControl(this) ? state.textareaValue.get.call(this) : ""
          },
        })
        Object.defineProperty(Node.prototype, "nodeValue", {
          ...state.nodeValue,
          get() {
            return this.nodeType === Node.TEXT_NODE && hasRedactedText(this)
              ? ""
              : state.nodeValue.get.call(this)
          },
        })
        Object.defineProperty(Node.prototype, "textContent", {
          ...state.textContent,
          get() {
            return (this instanceof Element && isNativeTextControl(this)) || hasRedactedText(this)
              ? ""
              : state.textContent.get.call(this)
          },
        })
        Object.defineProperty(HTMLElement.prototype, "innerText", {
          ...state.innerText,
          get() {
            return isNativeTextControl(this) || isInEditableSubtree(this) ? "" : state.innerText.get.call(this)
          },
        })
        Object.defineProperty(Element.prototype, "getAttribute", {
          ...state.getAttribute,
          value(name) {
            const attribute = String(name).toLowerCase()
            if (state.valueAttributes.has(attribute)
              && (isValueRole(this) || isInEditableSubtree(this)
                || (isNativeTextControl(this) && (attribute !== "value" || !isReadOnlyTextControl(this))))) return null
            if (state.editableNameAttributes.has(attribute) && isEditableDescendant(this)) return null
            return state.getAttribute.value.call(this, name)
          },
        })
      }
      state.tokens.add(token)
    } else if (action === "off" && state) {
      state.tokens.delete(token)
      if (state.tokens.size === 0) {
        Object.defineProperty(HTMLInputElement.prototype, "value", state.inputValue)
        Object.defineProperty(HTMLTextAreaElement.prototype, "value", state.textareaValue)
        Object.defineProperty(Node.prototype, "nodeValue", state.nodeValue)
        Object.defineProperty(Node.prototype, "textContent", state.textContent)
        Object.defineProperty(HTMLElement.prototype, "innerText", state.innerText)
        Object.defineProperty(Element.prototype, "getAttribute", state.getAttribute)
        delete globalThis[stateKey]
      }
    }

    return root instanceof Element ? root : document.documentElement
  },
  queryAll(root, body) {
    return [this.query(root, body)]
  },
})`

const redactionModuleId = globalThis.crypto.randomUUID().replaceAll("-", "")
const selectorName = `bcariaredact${redactionModuleId}`
let nextRedactionToken = 0
const contextSelectors = new WeakMap<BrowserContext, Promise<string>>()
const pageCleanup = new WeakMap<Page, {
  readonly pendingTokens: Map<string, { readonly frame: Frame; readonly selectorName: string }>
  queue: Promise<void>
}>()

/**
 * One document's ARIA snapshot with the values of editable fields, password, one-time-code and card fields
 * redacted. Redaction is activated and cleaned up in the target's frame only; frames are snapshotted separately,
 * one call per document, so every document gets the same guarantee.
 */
export async function ariaSnapshotWithoutTextControlValues(
  locator: Locator,
  options: { readonly timeout: number },
): Promise<string> {
  const page = locator.page()
  const redactionSelectorName = await selectorForContext(page.context())
  const token = `${redactionModuleId}${++nextRedactionToken}`
  const handle = await locator.elementHandle({ timeout: options.timeout })
  if (!handle) throw new Error("ARIA snapshot target did not resolve to an element")
  const frame = await handle.ownerFrame().finally(() => handle.dispose())
  if (!frame) throw new Error("ARIA snapshot target is not attached to a frame")
  let snapshot: string | undefined
  let captureFailed = false
  let captureError: unknown
  try {
    snapshot = await locator
      .locator(`${redactionSelectorName}=on_${token}`)
      .ariaSnapshot(options)
  } catch (error) {
    captureFailed = true
    captureError = error
  }

  try {
    await cleanupRedaction(page, frame, redactionSelectorName, token)
  } catch (cleanupError) {
    const cleanupReasons = cleanupError instanceof AggregateError ? cleanupError.errors : [cleanupError]
    throw new AriaSnapshotRedactionError(captureFailed ? [captureError, ...cleanupReasons] : cleanupReasons, captureFailed)
  }

  if (captureFailed) throw captureError
  return snapshot!
}

/**
 * The target's ARIA snapshot plus one labelled block per iframe document, in document order: the tree is left
 * as Playwright produced it (its anonymous `- iframe` lines are never matched to elements) and each frame is
 * appended as `- iframe "<name>" [src=<host>]:` with its own tree indented under it. Every document is read
 * through {@link ariaSnapshotWithoutTextControlValues} with its own token, so redaction is activated and cleaned
 * up in the same frame that is read. A frame that cannot be read becomes a note; a frame whose redaction cannot
 * be confirmed fails the call, exactly as it would for the target document.
 */
export async function ariaSnapshotWithFrames(
  locator: Locator,
  options: { readonly timeout: number },
): Promise<string> {
  const deadline = Date.now() + Math.max(1, options.timeout)
  const page = locator.page()
  const tree = await ariaSnapshotWithoutTextControlValues(locator, { timeout: options.timeout })
  const budget: FrameBudget = { frames: maxSnapshotFrames, skipped: { limit: 0, deadline: 0 } }
  const blocks = await frameBlocks(locator, { page, depth: 1, budget, deadline })
  const lines = tree.split("\n")
  if (blocks.length > 0) lines.push("", ...blocks)
  if (budget.skipped.limit > 0) lines.push(frameSkipNote(budget.skipped.limit, `${maxSnapshotFrames} iframes at most per snapshot`))
  if (budget.skipped.deadline > 0) lines.push(frameSkipNote(budget.skipped.deadline, "snapshot deadline reached"))
  return lines.join("\n")
}

type FrameBudget = { frames: number; skipped: { limit: number; deadline: number } }

type IframeCandidate = {
  readonly frame: Frame | null
  readonly name: string
  readonly src: string
}

/** One labelled block per iframe under `scope`, in document order, each followed by its indented content. */
async function frameBlocks(scope: Locator, options: {
  readonly page: Page
  readonly depth: number
  readonly budget: FrameBudget
  readonly deadline: number
}): Promise<string[]> {
  const blocks: string[] = []
  const listing = await iframeCandidates(scope, options.deadline)
  options.budget.skipped.limit += listing.skipped
  for (const [index, candidate] of listing.candidates.entries()) {
    const content = await frameContent(candidate, {
      ...options,
      framesLeft: Math.min(options.budget.frames, listing.candidates.length - index),
    })
    const label = `- iframe ${JSON.stringify(candidate.name)}${candidate.src ? ` [src=${candidate.src}]` : ""}`
    blocks.push(content.length === 0 ? label : `${label}:`)
    for (const line of content) blocks.push(`  ${line}`)
  }
  return blocks
}

/**
 * Every iframe under `scope` in document order, up to the frame cap. Tiniest frames are skipped before the cap, as
 * `snapshot()` does. Metadata is read from each handle itself, in the same pass that takes its content frame, so a
 * label can never shift onto a different element. Listing is cheap, so it gets a short floor past the deadline: a
 * page with no iframes must never produce a deadline note because its tree read ran long.
 */
async function iframeCandidates(scope: Locator, deadline: number): Promise<{ candidates: IframeCandidate[]; skipped: number }> {
  const listingDeadline = Math.max(deadline, Date.now() + minFrameListingTimeoutMs)
  const handles = await withinDeadline(
    scope.locator("iframe, frame").elementHandles(),
    listingDeadline,
    (late) => { for (const handle of late) void handle.dispose().catch(() => {}) },
  ).catch(() => undefined)
  if (!handles) return { candidates: [], skipped: 0 }
  try {
    const candidates: IframeCandidate[] = []
    let examined = 0
    for (const handle of handles) {
      if (candidates.length >= maxSnapshotFrames) break
      examined += 1
      const info = await withinDeadline(handle.evaluate((node) => {
        const element = node as Element
        const text = (value: string | null) => (value ?? "").trim()
        const rect = element.getBoundingClientRect()
        let src = ""
        const raw = element.getAttribute("src")
        if (raw) {
          try {
            const url = new URL(raw, document.baseURI)
            src = url.host || url.protocol.replace(/:$/, "")
          } catch {
            src = ""
          }
        }
        return {
          name: text(element.getAttribute("title")) || text(element.getAttribute("aria-label")) || text(element.getAttribute("name")),
          src,
          tiny: rect.width < 20 && rect.height < 20,
        }
      }), listingDeadline).catch(() => undefined)
      if (!info || info.tiny) continue
      candidates.push({
        frame: await withinDeadline(handle.contentFrame(), listingDeadline).catch(() => null),
        name: info.name || info.src || "frame",
        src: info.src,
      })
    }
    return { candidates, skipped: Math.max(0, handles.length - examined) }
  } finally {
    await Promise.all(handles.map((handle) => handle.dispose().catch(() => {})))
  }
}

/**
 * A Playwright call with no timeout option of its own, bounded by a deadline. Handlers are always attached: a late
 * resolution is passed to `onLate` (so handles are disposed) and a late rejection is swallowed.
 */
function withinDeadline<T>(promise: Promise<T>, deadline: number, onLate?: (value: T) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error("snapshot deadline reached"))
    }, Math.max(0, deadline - Date.now()))
    promise.then(
      (value) => {
        clearTimeout(timer)
        if (settled) {
          onLate?.(value)
          return
        }
        settled = true
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        if (settled) return
        settled = true
        reject(error)
      },
    )
  })
}

/** One iframe's content, or a note when its document cannot be read. Cleanup failures propagate. */
async function frameContent(candidate: IframeCandidate, options: {
  readonly page: Page
  readonly depth: number
  readonly budget: FrameBudget
  readonly deadline: number
  /** Iframes still to capture from this document, including this one. */
  readonly framesLeft: number
}): Promise<string[]> {
  if (options.depth > maxSnapshotFrameDepth) return [noteLine(`content not captured (frames nested deeper than ${maxSnapshotFrameDepth})`)]
  if (options.budget.frames <= 0) {
    options.budget.skipped.limit += 1
    return []
  }
  const frame = candidate.frame
  if (!frame) return [noteLine("content not captured (the iframe is gone or has no frame attached)")]
  const remaining = options.deadline - Date.now()
  if (remaining <= 0) {
    options.budget.skipped.deadline += 1
    return []
  }
  const timeout = frameCaptureTimeoutMs(remaining, options.framesLeft)
  options.budget.frames -= 1
  // A document that navigates between activation and the read is not patched any more: drop its result.
  let navigated = false
  const onFrameNavigated = (navigatedFrame: Frame) => {
    if (navigatedFrame === frame) navigated = true
  }
  options.page.on("framenavigated", onFrameNavigated)
  try {
    const target = frame.locator(documentRootSelector).first()
    const tree = await ariaSnapshotWithoutTextControlValues(target, { timeout })
    if (navigated) throw new Error("the frame navigated while it was captured")
    const lines = tree.split("\n")
    const nested = await frameBlocks(target, { ...options, depth: options.depth + 1 })
    if (nested.length > 0) lines.push("", ...nested)
    return lines
  } catch (error) {
    if (isRedactionCleanupFailure(error)) throw error
    // Classify the capture error itself; the wrapper only adds the cleanup message.
    const cause = error instanceof AriaSnapshotRedactionError && error.captureFailed ? error.errors[0] : error
    return [noteLine(`content not captured (${frameFailureNote(cause)})`)]
  } finally {
    options.page.off("framenavigated", onFrameNavigated)
  }
}

/**
 * A captured frame whose redaction could not be confirmed. It must fail the whole call (its content may be
 * patched); a frame whose capture also failed is only a note, since nothing trustworthy was read from it.
 */
export function isRedactionCleanupFailure(error: unknown): boolean {
  return error instanceof AriaSnapshotRedactionError && !error.captureFailed
}

function noteLine(reason: string): string {
  return `- ... ${reason}`
}



export async function registerAriaSnapshotSelector(context: BrowserContext): Promise<void> {
  await selectorForContext(context)
}

async function selectorForContext(context: BrowserContext): Promise<string> {
  const existing = contextSelectors.get(context)
  if (existing) return existing

  // Patchright's public selectors.register retains each engine forever and sends it to *all* live contexts.
  // Later connectOverCDP default contexts, unlike newContext(), don't inherit that registration. Use the same
  // context RPC register uses, once per context, without ever adding the engine to the process-wide list.
  const { _channel } = context as BrowserContext & { _channel: {
    registerSelectorEngine(params: { selectorEngine: { name: string; source: string; contentScript: boolean } }, options: { timeout: number }): Promise<void>
  } }
  const registration = _channel.registerSelectorEngine({
    selectorEngine: { name: selectorName, source: redactionSelectorSource, contentScript: true },
  }, { timeout: 0 }).then(() => selectorName, (error) => {
    contextSelectors.delete(context)
    throw error
  })
  contextSelectors.set(context, registration)
  return registration
}

async function cleanupRedaction(page: Page, frame: Frame, redactionSelectorName: string, token: string): Promise<void> {
  let state = pageCleanup.get(page)
  if (!state) {
    state = { pendingTokens: new Map(), queue: Promise.resolve() }
    pageCleanup.set(page, state)
  }
  state.pendingTokens.set(token, { frame, selectorName: redactionSelectorName })

  const cleanup = state.queue.then(async () => {
    const pending = [...state.pendingTokens]
    // Every pending token is retried in parallel, as before. Only the caller's own token can fail this call:
    // another frame's unconfirmed cleanup sits in the queue for its own caller rather than breaking every later
    // frame's snapshot.
    const results = await Promise.allSettled(pending.map(async ([pendingToken, target]) => {
      await target.frame.locator(`${target.selectorName}=off_${pendingToken}`).waitFor({ state: "attached", timeout: 1_000 })
    }))
    const failures: unknown[] = []
    for (let index = 0; index < results.length; index++) {
      const result = results[index]!
      const pendingToken = pending[index]![0]
      if (result.status === "fulfilled" || redactionContextIsGone(result.reason)) {
        state.pendingTokens.delete(pendingToken)
      } else if (pendingToken === token) {
        failures.push(result.reason)
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, redactionCleanupErrorMessage)
  })
  state.queue = cleanup.catch(() => {})
  await cleanup
}

function redactionContextIsGone(cause: unknown): boolean {
  const kind = runtimeFailureKind(cause)
  return kind === "context-destroyed" || kind === "context-missing" || kind === "target-closed"
}
