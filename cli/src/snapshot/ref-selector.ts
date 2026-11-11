import type { BrowserContext, Frame, Locator, Page } from "patchright-core"
import { snapshotNamingInBrowser } from "./naming.ts"
import type { SnapshotRefTarget } from "./types.ts"

// How long an action waits for a ref that no longer matches its element before failing. Long enough for a brief
// "Saving…" label or a re-mount, far shorter than the 30 s action timeout.
const staleGraceMs = 3_000

// Resolves a snapshot ref: the elements matching its selector that still have the snapshot's role and exact name and
// aren't hidden from assistive technology, as getByRole matched them before. The body is
// `<id>.<call> <act|read> <role> <JSON name> <selector>`. For an `act` body, which only actions use, a ref that
// matches nothing for staleGraceMs throws while Playwright resolves it, so no input is ever sent. Reads such as
// isVisible() and count() use `read` and never throw. A hidden match keeps waiting the normal way.
const refSelectorEngine = (graceMs: number, createNaming: typeof snapshotNamingInBrowser) => {
  const firstMiss = new Map<string, number>()
  const quoted = (value: string): string => {
    const short = value.length > 80 ? `${value.slice(0, 80)}...` : value
    return `"${short.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
  }
  const hiddenFromAria = (element: Element): boolean => {
    if (element.closest("[aria-hidden='true']")) return true
    const visible = (element as Element & { checkVisibility?: (options: object) => boolean }).checkVisibility?.({ visibilityProperty: true })
    if (visible !== undefined) return !visible
    const style = getComputedStyle(element)
    return style.display === "none" || style.visibility === "hidden"
  }
  // Without a stack, so the action error shows the message and not frames from inside the page.
  const stale = (message: string): Error => Object.assign(new Error(message), { stack: message })
  const resolve = (root: Element | Document, body: string): Element[] => {
    const parsed = /^(\S+)\.\d+ (act|read) (\S+) ("(?:[^"\\]|\\.)*") ([\s\S]+)$/.exec(body)
    if (!parsed) throw new Error(`Malformed snapshot ref selector: ${body}`)
    const [, id, mode, role, rawName, selector] = parsed as unknown as [string, string, string, string, string, string]
    const name = JSON.parse(rawName) as string
    const naming = createNaming()
    const bySelector = Array.from(root.querySelectorAll(selector))
    const sameRole = bySelector.filter((element) => naming.roleFor(element) === role)
    const matches = sameRole.filter((element) => !hiddenFromAria(element) && naming.identityNameFor(element, role) === name)
    if (matches.length > 0) {
      firstMiss.delete(body)
      return matches
    }
    // Patchright also queries each closed shadow root as its own root; only the document query judges staleness.
    if (mode !== "act" || root.nodeType !== Node.DOCUMENT_NODE) return []
    if (sameRole.some(hiddenFromAria)) {
      firstMiss.delete(body)
      return []
    }
    const now = Date.now()
    const first = firstMiss.get(body) ?? now
    firstMiss.set(body, first)
    if (now - first < graceMs) return []
    firstMiss.delete(body)
    const was = `${role} ${quoted(name)}`
    const current = bySelector.length === 1 ? bySelector[0]! : undefined
    const change = current
      ? naming.roleFor(current) === role
        ? `now reads ${quoted(naming.identityNameFor(current, role))}`
        : `is now ${naming.roleFor(current)} ${quoted(naming.identityNameFor(current, naming.roleFor(current)))}`
      : bySelector.length === 0
      ? "is gone; the page removed or re-rendered it"
      : `is gone; its selector now matches ${bySelector.length} other elements`
    throw stale(`ref ${id} is stale: ${was} ${change}; call snapshot() again`)
  }
  return {
    query: (root: Element | Document, body: string): Element | null => resolve(root, body)[0] ?? null,
    queryAll: (root: Element | Document, body: string): Element[] => resolve(root, body),
  }
}

// Source text keeps bundler helpers out of the page; `__name` covers names a bundler keeps on inner functions.
const refSelectorSource = `(() => {
  const __name = (target) => target
  return (${refSelectorEngine.toString()})(${staleGraceMs}, ${snapshotNamingInBrowser.toString()})
})()`

const refSelectorName = `browse-ref-${globalThis.crypto.randomUUID().slice(0, 6)}`
const contextSelectors = new WeakMap<BrowserContext, Promise<void>>()
const registeredContexts = new WeakSet<BrowserContext>()
let nextCall = 1

// Locator methods that wait for the element. Each call gets its own `act` selector, so its grace period starts
// fresh. Everything else (isVisible, count, filter, and so on) uses the ref's `read` selector. A call that passes its
// own `timeout` asked to wait that long, so it uses `read` too and waits the normal way. A longer default timeout
// from execute's `timeoutMs` doesn't change the grace: a ref that still matches waits the full timeout either way.
const actions = [
  "blur", "boundingBox", "check", "clear", "click", "dblclick", "dispatchEvent", "dragTo", "fill", "focus",
  "getAttribute", "hover", "innerHTML", "innerText", "inputValue", "isChecked", "isDisabled", "isEditable",
  "isEnabled", "press", "pressSequentially", "scrollIntoViewIfNeeded", "selectOption", "selectText", "setChecked",
  "tap", "textContent", "type", "uncheck", "waitFor",
] as const

/**
 * A locator for a snapshot ref, in the page or the frame it was captured in, whose actions fail within a few seconds
 * once the ref stops matching its element.
 */
export function refLocator(
  page: Page,
  scope: Page | Frame,
  id: string,
  ref: Pick<SnapshotRefTarget, "selector" | "role"> & { readonly name: string },
): Locator | undefined {
  if (!registeredContexts.has(page.context())) return undefined
  const selector = (mode: "act" | "read") =>
    `${refSelectorName}=${id}.${nextCall++} ${mode} ${ref.role} ${JSON.stringify(ref.name)} ${ref.selector}`
  const locator = scope.locator(selector("read"))
  for (const action of actions) {
    // Named like the method it replaces, so execute's per-method checks and warnings treat both alike.
    const method = {
      async [action](...args: unknown[]) {
        const options = args.at(-1)
        const explicitTimeout = typeof options === "object" && options !== null && (options as { timeout?: unknown }).timeout !== undefined
        const acting = scope.locator(selector(explicitTimeout ? "read" : "act")) as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>
        return await acting[action]!(...args)
      },
    }[action]
    Object.defineProperty(locator, action, { value: method, configurable: true, writable: true })
  }
  return locator
}

/** Registers the ref engine on this context only; see selectorForContext in aria-snapshot.ts for why. */
export async function registerRefSelector(context: BrowserContext): Promise<void> {
  const existing = contextSelectors.get(context)
  if (existing) return existing
  const { _channel } = context as BrowserContext & { _channel: {
    registerSelectorEngine(params: { selectorEngine: { name: string; source: string; contentScript: boolean } }, options: { timeout: number }): Promise<void>
  } }
  const registration = _channel.registerSelectorEngine({
    selectorEngine: { name: refSelectorName, source: refSelectorSource, contentScript: true },
  }, { timeout: 0 }).then(() => {
    registeredContexts.add(context)
  }, (error) => {
    contextSelectors.delete(context)
    throw error
  })
  contextSelectors.set(context, registration)
  return registration
}
