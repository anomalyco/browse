import { beforeEach, describe, expect, test } from "bun:test"
import { installChrome, type StubEvent } from "../chrome-stub"

// The in-page handoff card (src/content/page-status.ts) on a minimal hand-rolled DOM: just what the card touches
// (elements, a closed shadow root, events, the popover top layer). Run by ../isolated.test.ts in a process of its
// own, because it installs DOM globals the other files must not see.

type Listener = (event: FakeEvent) => void
type FakeEvent = { type: string; target?: unknown; isTrusted?: boolean; newState?: string }

class FakeEventTarget {
  private readonly listeners = new Map<string, Listener[]>()
  addEventListener(type: string, listener: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }
  removeEventListener(type: string, listener: Listener) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((other) => other !== listener))
  }
  dispatchEvent(event: FakeEvent) {
    for (const listener of this.listeners.get(event.type) ?? []) listener({ target: this, ...event })
  }
}

class Node extends FakeEventTarget {
  parent: Node | undefined
  readonly children: Node[] = []
  get isConnected(): boolean {
    return this instanceof Document || (this.parent?.isConnected ?? false)
  }
  append(child: Node) {
    child.remove()
    child.parent = this
    this.children.push(child)
  }
  remove() {
    if (!this.parent) return
    this.parent.children.splice(this.parent.children.indexOf(this), 1)
    this.parent = undefined
  }
  contains(node: Node): boolean {
    return node === this || this.children.some((child) => child.contains(node))
  }
  querySelectorAll(): Element[] {
    return []
  }
}

class Element extends Node {
  private readonly attributes = new Map<string, string>()
  readonly dataset: Record<string, string> = {}
  textContent = ""
  title = ""
  disabled = false
  id = ""
  shadowRoot: ShadowRoot | null = null
  popoverOpen = false
  /** Open as a modal dialog (:modal). */
  modal = false
  /** Its box; the whole viewport unless a test places it. */
  rect = { left: 0, top: 0, right: 1280, bottom: 800 }
  shown = 0
  hidden = 0
  constructor(readonly tagName: string) {
    super()
  }
  getAttribute(name: string) {
    return this.attributes.get(name) ?? null
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value)
  }
  removeAttribute(name: string) {
    this.attributes.delete(name)
  }
  hasAttribute(name: string) {
    return this.attributes.has(name)
  }
  getAttributeNames() {
    return [...this.attributes.keys()]
  }
  matches(selector: string) {
    if (selector === ":modal") return this.modal
    if (selector !== ":popover-open") throw new Error(`The shim only knows :popover-open and :modal, not ${selector}`)
    return this.popoverOpen
  }
  getBoundingClientRect() {
    return this.rect
  }
  showPopover() {
    if (this.popoverOpen) throw new Error("InvalidStateError: already open")
    this.popoverOpen = true
    this.shown++
    this.dispatchEvent({ type: "toggle", newState: "open" })
  }
  hidePopover() {
    if (!this.popoverOpen) throw new Error("InvalidStateError: not open")
    this.popoverOpen = false
    this.hidden++
    this.dispatchEvent({ type: "toggle", newState: "closed" })
  }
  attachShadow({ mode }: { mode: string }) {
    const shadow = new ShadowRoot(mode)
    this.shadowRoot = mode === "open" ? shadow : null
    shadows.push(shadow)
    return shadow
  }
}

class HTMLElement extends Element {}
class HTMLDialogElement extends HTMLElement {
  open = false
}

class ShadowRoot extends Node {
  private readonly byId = new Map<string, Element>()
  constructor(readonly mode: string) {
    super()
  }
  set innerHTML(html: string) {
    // Elements with an id are all the card looks up.
    for (const [, tag, id] of html.matchAll(/<(\w+)[^>]*\bid="([^"]+)"/g)) {
      const element = new HTMLElement(tag!.toUpperCase())
      element.id = id!
      this.append(element)
      this.byId.set(id!, element)
    }
  }
  getElementById(id: string) {
    return this.byId.get(id) ?? null
  }
}

class Document extends Node {
  readonly documentElement = new HTMLElement("HTML")
  fullscreenElement: Element | null = null
  constructor() {
    super()
    this.append(this.documentElement)
  }
  createElement(tag: string) {
    return new HTMLElement(tag.toUpperCase())
  }
}

class MutationObserver {
  observe() {}
  disconnect() {}
}

const shadows: ShadowRoot[] = []
const document = new Document()
Object.assign(globalThis, { document, Element, HTMLElement, HTMLDialogElement, ShadowRoot, Document, MutationObserver, location: new URL("https://bank.example/login") })

const stub = installChrome()
const sent: Array<Record<string, unknown>> = []
let failSend = false
;(stub.chrome.runtime as { sendMessage: unknown }).sendMessage = async (message: Record<string, unknown>) => {
  sent.push(message)
  if (failSend) throw new Error("The background is gone")
}
// Second-granular rate limit; the tests set the clock.
let now = 1_000
Object.defineProperty(performance, "now", { value: () => now, configurable: true })

await import("../../src/content/page-status")

const tell = (message: unknown) => (chrome.runtime.onMessage as unknown as StubEvent).emit(message, {}, () => {})
let handoff = 0
function waitFor(message = "Sign in") {
  const handoffId = `handoff-${++handoff}`
  tell({ action: "page-status.set", status: { state: "waiting", owner: "session", sessionId: "github", handoffId, message } })
  return handoffId
}
/** The card's host: the element the script put in the page. */
const host = () => document.documentElement.children.find((child) => child instanceof Element && child.getAttribute("popover") === "manual") as Element | undefined
const card = () => shadows.at(-1)!
/** The blue edge around the page: the element the script put in the page that isn't a popover. */
const edge = () => document.documentElement.children.find((child) => child instanceof Element && child !== host() && child.getAttribute("popover") === null) as Element | undefined
/** Places the card and the pill in the bottom right corner, as the stylesheet does in a 1280×800 viewport. */
function placeCard() {
  card().getElementById("card")!.rect = { left: 948, top: 620, right: 1268, bottom: 742 }
  card().getElementById("pill")!.rect = { left: 1150, top: 752, right: 1268, bottom: 778 }
}
/** A popover the page (or another extension) shows at `rect`. */
function popoverAt(rect: Element["rect"]) {
  const popover = new HTMLElement("DIV")
  popover.rect = rect
  return popover
}
const button = () => card().getElementById("continue")!
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  tell({ action: "page-status.clear" })
  sent.length = 0
  failSend = false
  now += 1_000
})

describe("handoff card", () => {
  test("shows in the top layer with the page's origin and the agent's message", () => {
    waitFor("Approve the payment")
    expect(host()?.popoverOpen).toBe(true)
    expect(card().mode).toBe("closed")
    expect(card().getElementById("origin")!.textContent).toBe("https://bank.example")
    expect(card().getElementById("message")!.textContent).toBe("Approve the payment")
    tell({ action: "page-status.clear" })
    expect(host()).toBeUndefined()
  })

  test("only a trusted click completes the handoff, once", async () => {
    const handoffId = waitFor()
    button().dispatchEvent({ type: "click", isTrusted: false })
    expect(sent.filter((message) => message.action === "handoff.complete")).toEqual([])
    button().dispatchEvent({ type: "click", isTrusted: true })
    button().dispatchEvent({ type: "click", isTrusted: true })
    expect(sent.filter((message) => message.action === "handoff.complete")).toEqual([{ action: "handoff.complete", handoffId }])
    expect(button().disabled).toBe(true)
    expect(button().textContent).toBe("Continuing…")
  })

  test("Continue works again when the background can't be reached", async () => {
    waitFor()
    failSend = true
    button().dispatchEvent({ type: "click", isTrusted: true })
    await settle()
    expect(button().disabled).toBe(false)
    failSend = false
    button().dispatchEvent({ type: "click", isTrusted: true })
    expect(sent.filter((message) => message.action === "handoff.complete")).toHaveLength(2)
  })

  test("a recorded tab gets no card", () => {
    tell({ action: "page-status.set", status: { state: "waiting", owner: "session", handoffId: "recorded", message: "Sign in", recording: true } })
    expect(host()).toBeUndefined()
  })

  test("a page that closes the popover or restyles the host gets it back", async () => {
    waitFor()
    const element = host()!
    element.setAttribute("style", "display:none")
    element.hidePopover()
    await settle()
    expect(element.popoverOpen).toBe(true)
    // raise() strips the page's attributes on the next top-layer change.
    element.remove()
    document.dispatchEvent({ type: "toggle", target: new HTMLDialogElement("DIALOG"), newState: "open" })
    expect(host()).toBe(element)
    expect(element.getAttributeNames()).toEqual(["popover"])
  })
})

describe("edge", () => {
  test("the blue edge is drawn outside the top layer, and goes with the card", () => {
    waitFor()
    const element = edge()
    expect(element).toBeDefined()
    expect(element!.popoverOpen).toBe(false)
    expect(element!.shown).toBe(0)
    tell({ action: "page-status.clear" })
    expect(edge()).toBeUndefined()
  })

  test("a page that removes or restyles the edge gets it back with the card", () => {
    waitFor()
    const element = edge()!
    element.setAttribute("style", "display:none")
    element.remove()
    document.dispatchEvent({ type: "toggle", target: new HTMLDialogElement("DIALOG"), newState: "open" })
    expect(edge()).toBe(element)
    expect(element.getAttributeNames()).toEqual([])
  })
})

describe("retop", () => {
  test("a dialog or popover the page opens later puts the card back on top", () => {
    waitFor()
    const element = host()!
    const shown = element.shown
    document.dispatchEvent({ type: "toggle", target: new HTMLDialogElement("DIALOG"), newState: "open" })
    expect(element.hidden).toBe(1)
    expect(element.shown).toBe(shown + 1)
    expect(element.popoverOpen).toBe(true)
  })

  test("closing toggles, the card's own toggles and an exited fullscreen don't re-top", () => {
    waitFor()
    const element = host()!
    document.dispatchEvent({ type: "toggle", target: new HTMLDialogElement("DIALOG"), newState: "closed" })
    document.dispatchEvent({ type: "toggle", target: element, newState: "open" })
    document.dispatchEvent({ type: "fullscreenchange", target: new HTMLElement("VIDEO") })
    expect(element.hidden).toBe(0)
    document.fullscreenElement = new HTMLElement("VIDEO")
    document.dispatchEvent({ type: "fullscreenchange", target: document.fullscreenElement })
    document.fullscreenElement = null
    expect(element.hidden).toBe(1)
  })

  test("at most ten times a second, so a page can't loop with the card", () => {
    waitFor()
    const element = host()!
    const popover = new HTMLElement("DIV")
    for (let i = 0; i < 25; i++) document.dispatchEvent({ type: "toggle", target: popover, newState: "open" })
    expect(element.hidden).toBe(10)
    now += 1_000
    document.dispatchEvent({ type: "toggle", target: popover, newState: "open" })
    expect(element.hidden).toBe(11)
    expect(element.popoverOpen).toBe(true)
  })

  test("a popover away from the card, such as a password manager's menu under a field, stays on top", () => {
    waitFor()
    placeCard()
    const element = host()!
    const menu = popoverAt({ left: 370, top: 252, right: 730, bottom: 374 })
    for (let i = 0; i < 5; i++) document.dispatchEvent({ type: "toggle", target: menu, newState: "open" })
    expect(element.hidden).toBe(0)
    expect(element.popoverOpen).toBe(true)
  })

  test("a popover over the card or its pill, or a modal dialog anywhere, still puts the card back on top", () => {
    waitFor()
    placeCard()
    const element = host()!
    document.dispatchEvent({ type: "toggle", target: popoverAt({ left: 900, top: 700, right: 1000, bottom: 760 }), newState: "open" })
    expect(element.hidden).toBe(1)
    document.dispatchEvent({ type: "toggle", target: popoverAt({ left: 1200, top: 760, right: 1210, bottom: 770 }), newState: "open" })
    expect(element.hidden).toBe(2)
    const dialog = new HTMLDialogElement("DIALOG")
    dialog.modal = true
    dialog.rect = { left: 400, top: 200, right: 800, bottom: 500 }
    document.dispatchEvent({ type: "toggle", target: dialog, newState: "open" })
    expect(element.hidden).toBe(3)
    expect(element.popoverOpen).toBe(true)
  })

  test("the card stops listening once the handoff is over", () => {
    waitFor()
    const element = host()!
    tell({ action: "page-status.set", status: { state: "running", owner: "session" } })
    expect(host()).toBeUndefined()
    document.dispatchEvent({ type: "toggle", target: new HTMLElement("DIV"), newState: "open" })
    expect(element.hidden).toBe(0)
  })
})
