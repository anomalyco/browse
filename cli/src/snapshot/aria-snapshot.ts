import type { BrowserContext, Frame, Locator, Page } from "patchright-core"
import { runtimeFailureKind } from "../update/runtime-diagnostics.ts"
import { maxSnapshotFrameDepth, maxSnapshotFrames } from "./frames.ts"

const redactionCleanupErrorMessage = "browse could not confirm ARIA snapshot value-redaction cleanup"
/** Reads the body (or frameset) of a document as its snapshot target. */
const documentRootSelector = "body, frameset"
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
    if (captureFailed) {
      const cleanupReasons = cleanupError instanceof AggregateError ? cleanupError.errors : [cleanupError]
      throw new AggregateError([captureError, ...cleanupReasons], redactionCleanupErrorMessage)
    }
    throw cleanupError
  }

  if (captureFailed) throw captureError
  return snapshot!
}

/**
 * The target's ARIA snapshot with each iframe's document folded in, indented under its `- iframe` line. Every
 * document is read through {@link ariaSnapshotWithoutTextControlValues} with its own token, so redaction is
 * activated and cleaned up in the same frame that is read. A frame that cannot be read or redacted becomes a
 * short note; it never fails the target's snapshot or returns its content unredacted.
 */
export async function ariaSnapshotWithFrames(
  locator: Locator,
  options: { readonly timeout: number },
): Promise<string> {
  const deadline = Date.now() + Math.max(1, options.timeout)
  const page = locator.page()
  const tree = await ariaSnapshotWithoutTextControlValues(locator, { timeout: options.timeout })
  const budget = { frames: maxSnapshotFrames, skipped: { limit: 0, deadline: 0 } }
  const lines = await foldIframes({ scope: locator, page, tree, depth: 1, budget, deadline })
  const skipped = budget.skipped.limit + budget.skipped.deadline
  if (skipped > 0) lines.push(`- ... ${skipped} iframe ${skipped === 1 ? "content" : "contents"} not captured (${maxSnapshotFrames} at most per snapshot or the snapshot deadline)`)
  return lines.join("\n")
}

type IframeCandidate = {
  readonly frame: Frame | null
  readonly name: string
  readonly host: string
  readonly visible: boolean
  readonly ariaHidden: boolean
}

/** Fold the iframes of one document's snapshot in, recursively. Returns the document's output lines. */
async function foldIframes(options: {
  readonly scope: Locator
  readonly page: Page
  readonly tree: string
  readonly depth: number
  readonly budget: { frames: number; skipped: { limit: number; deadline: number } }
  readonly deadline: number
}): Promise<string[]> {
  const lines = options.tree.split("\n")
  const iframeLineIndexes = lines.flatMap((line, index) => /^\s*- iframe(?:\s*\[[^\]]*\])?$/.test(line) ? [index] : [])
  // Only iframes the aria tree renders can own a line: an invisible one has no box and no line.
  const candidates = (await iframeCandidates(options.scope)).filter((candidate) => candidate.visible && !candidate.ariaHidden)
  // The aria tree names no iframe, so binding lines to elements is only safe when every element the tree should
  // contain is there, in document order. Otherwise both stay separate and each frame block is labelled.
  const nesting = candidates.length === iframeLineIndexes.length ? iframeLineIndexes : undefined

  if (!nesting) {
    const appended = candidates.length === 0 ? [] : [""]
    for (const candidate of candidates) {
      const content = await iframeContent(candidate, options)
      const name = candidate.name || candidate.host
      const label = name ? ` "${name.replace(/"/g, '\\"')}"` : ""
      appended.push(content.length === 0 ? `- iframe${label}` : `- iframe${label}:`)
      for (const line of content) appended.push(`  ${line}`)
    }
    return [...lines, ...appended]
  }

  const output: string[] = []
  let next = 0
  for (let index = 0; index < lines.length; index++) {
    if (nesting[next] !== index) {
      output.push(lines[index]!)
      continue
    }
    const candidate = candidates[next]!
    next += 1
    const indent = /^\s*/.exec(lines[index]!)![0]
    const content = await iframeContent(candidate, options)
    if (content.length === 0) {
      output.push(lines[index]!)
      continue
    }
    output.push(`${lines[index]!.trimEnd().replace(/:$/, "")}:`)
    for (const line of content) output.push(`${indent}  ${line}`)
  }
  return output
}

/** Every iframe element in the scope, in document order, with what the tree needs to know about it. */
async function iframeCandidates(scope: Locator): Promise<IframeCandidate[]> {
  const handles = await scope.locator("iframe, frame").elementHandles().catch(() => [])
  const candidates: IframeCandidate[] = []
  try {
    for (const handle of handles) {
      candidates.push({
        frame: await handle.contentFrame().catch(() => null),
        name: (await handle.getAttribute("title").catch(() => null))
          ?? (await handle.getAttribute("aria-label").catch(() => null))
          ?? (await handle.getAttribute("name").catch(() => null))
          ?? "",
        host: hostOf(await handle.getAttribute("src").catch(() => null), scope.page().url()),
        visible: await handle.isVisible().catch(() => false),
        ariaHidden: await handle.evaluate((element) => (element as Element).closest('[aria-hidden="true"]') !== null).catch(() => false),
      })
    }
  } finally {
    await Promise.all(handles.map((handle) => handle.dispose().catch(() => {})))
  }
  return candidates
}

/** One iframe's folded content, or a note when its document cannot be read or redacted. */
async function iframeContent(candidate: IframeCandidate, options: {
  readonly page: Page
  readonly depth: number
  readonly budget: { frames: number; skipped: { limit: number; deadline: number } }
  readonly deadline: number
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
  options.budget.frames -= 1
  // A document that navigates between activation and the read is not patched any more: drop its result.
  let navigated = false
  const onFrameNavigated = (navigatedFrame: Frame) => {
    if (navigatedFrame === frame) navigated = true
  }
  options.page.on("framenavigated", onFrameNavigated)
  try {
    const target = frame.locator(documentRootSelector).first()
    const tree = await ariaSnapshotWithoutTextControlValues(target, { timeout: remaining })
    if (navigated) throw new Error("the frame navigated while it was captured")
    return await foldIframes({ ...options, scope: target, tree, depth: options.depth + 1 })
  } catch (error) {
    return [noteLine(`content not captured (${frameFailureNote(error)})`)]
  } finally {
    options.page.off("framenavigated", onFrameNavigated)
  }
}

function noteLine(reason: string): string {
  return `- ... ${reason}`
}

function hostOf(src: string | null, base: string): string {
  if (!src) return ""
  try {
    return new URL(src, base).host
  } catch {
    return ""
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
      return "the frame could not be read or redacted"
  }
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
    let currentFailures: unknown[] = []
    // Other frames' unconfirmed tokens are retried too, but only their own frame's caller hears about them: one
    // frame that cannot be cleaned up must not fail every later frame's snapshot.
    for (const [pendingToken, target] of pending) {
      let failures: unknown[]
      try {
        await target.frame.locator(`${target.selectorName}=off_${pendingToken}`).waitFor({ state: "attached", timeout: 1_000 })
        failures = []
      } catch (error) {
        failures = redactionContextIsGone(error) ? [] : [error]
      }
      if (failures.length === 0) state.pendingTokens.delete(pendingToken)
      else if (pendingToken === token) currentFailures = failures
    }
    if (currentFailures.length > 0) throw new AggregateError(currentFailures, redactionCleanupErrorMessage)
  })
  state.queue = cleanup.catch(() => {})
  await cleanup
}

function redactionContextIsGone(cause: unknown): boolean {
  const kind = runtimeFailureKind(cause)
  return kind === "context-destroyed" || kind === "context-missing" || kind === "target-closed"
}
