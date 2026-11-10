import type { BrowserContext, Frame, Locator, Page } from "patchright-core"
import { runtimeFailureKind } from "../update/runtime-diagnostics.ts"
import { frameDescendants } from "./frames.ts"

const redactionCleanupErrorMessage = "browse could not confirm ARIA snapshot value-redaction cleanup"
/** Playwright's AI-mode refs are internal to that snapshot; browse refs are separate and would not resolve them. */
const snapshotRefMarker = / \[ref=(?:f\d+)?e\d+\]/g
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
  readonly pendingTokens: Map<string, { readonly frames: readonly Frame[]; readonly selectorName: string }>
  queue: Promise<void>
}>()

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
  // `mode: "ai"` is what makes Playwright fold iframe documents into the snapshot, including cross-origin ones.
  // The redaction patches are per frame, so cover the target's frame and every frame nested under it before
  // reading: otherwise values typed into an iframe would come back verbatim. Fail closed when one cannot be
  // redacted rather than return a snapshot that may contain them.
  const frames = [frame, ...frameDescendants(frame)].filter((candidate) => !candidate.isDetached())
  let activated: Frame[] = []
  let snapshot: string | undefined
  let captureFailed = false
  let captureError: unknown
  try {
    const activation = await Promise.allSettled(frames.map(async (candidate) => {
      await candidate.locator(`${redactionSelectorName}=on_${token}`).waitFor({ state: "attached", timeout: options.timeout })
      return candidate
    }))
    activated = activation.flatMap((settled) => settled.status === "fulfilled" ? [settled.value] : [])
    for (const settled of activation) {
      if (settled.status === "rejected") throw settled.reason
    }
    snapshot = (await locator
      .locator(`${redactionSelectorName}=on_${token}`)
      .ariaSnapshot({ ...options, mode: "ai" })).replace(snapshotRefMarker, "")
  } catch (error) {
    captureFailed = true
    captureError = error
  }

  try {
    await cleanupRedaction(page, activated, redactionSelectorName, token)
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

async function cleanupRedaction(page: Page, frames: readonly Frame[], redactionSelectorName: string, token: string): Promise<void> {
  let state = pageCleanup.get(page)
  if (!state) {
    state = { pendingTokens: new Map(), queue: Promise.resolve() }
    pageCleanup.set(page, state)
  }
  state.pendingTokens.set(token, { frames, selectorName: redactionSelectorName })

  const cleanup = state.queue.then(async () => {
    const pending = [...state.pendingTokens]
    const outcomes = await Promise.all(pending.map(async ([pendingToken, target]) => {
      const results = await Promise.allSettled(target.frames.map((frame) =>
        frame.locator(`${target.selectorName}=off_${pendingToken}`).waitFor({ state: "attached", timeout: 1_000 })))
      const failures = results.flatMap((result) =>
        result.status === "rejected" && !redactionContextIsGone(result.reason) ? [result.reason] : [])
      return { pendingToken, failures }
    }))
    const failures: unknown[] = []
    for (const outcome of outcomes) {
      if (outcome.failures.length > 0) failures.push(...outcome.failures)
      else state.pendingTokens.delete(outcome.pendingToken)
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
