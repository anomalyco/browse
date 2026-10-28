// Harness-only CDP client for Chrome's own --remote-debugging-port (127.0.0.1:9222). browse never uses this port; the
// runners use it for what a person or the OS would do: click Continue on a handoff card, stop the extension's service
// worker, and read ground truth (tabs, groups, debugger attachments) from the extension itself.
import { chromeDebugPort, sleep } from "./env.ts"

export const EXTENSION_ID = "afeafocngkodbmaipcngoamamfmekgfo"

type Pending = { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }

export class BrowserCdp {
  private ws: WebSocket
  private nextId = 1
  private pending = new Map<number, Pending>()
  private listeners = new Set<(message: any) => void>()
  closed = false

  private constructor(ws: WebSocket) {
    this.ws = ws
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data))
      if (typeof message.id === "number") {
        const entry = this.pending.get(message.id)
        if (!entry) return
        this.pending.delete(message.id)
        clearTimeout(entry.timer)
        if (message.error) entry.reject(new Error(`${message.error.message}`))
        else entry.resolve(message.result)
      } else for (const listener of this.listeners) listener(message)
    })
    ws.addEventListener("close", () => {
      this.closed = true
      for (const [, entry] of this.pending) { clearTimeout(entry.timer); entry.reject(new Error("CDP closed")) }
      this.pending.clear()
    })
  }

  static async connect(timeoutMs = 10_000): Promise<BrowserCdp> {
    const version = await fetch(`http://127.0.0.1:${chromeDebugPort}/json/version`, { signal: AbortSignal.timeout(timeoutMs) }).then((r) => r.json()) as { webSocketDebuggerUrl: string }
    const ws = new WebSocket(version.webSocketDebuggerUrl)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP connect timeout")), timeoutMs)
      ws.addEventListener("open", () => { clearTimeout(timer); resolve() }, { once: true })
      ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("CDP connect failed")) }, { once: true })
    })
    return new BrowserCdp(ws)
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 15_000): Promise<any> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error("CDP closed"))
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)) }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
  }

  on(listener: (message: any) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener) }

  close() { try { this.ws.close() } catch {} }

  async targets(): Promise<any[]> {
    return (await this.send("Target.getTargets")).targetInfos as any[]
  }

  async extensionWorker(): Promise<any | undefined> {
    return (await this.targets()).find((t) => t.type === "service_worker" && t.url.startsWith(`chrome-extension://${EXTENSION_ID}/`))
  }

  /** Evaluates an expression in the extension's service worker (chrome.* APIs available). */
  async evalInExtension<T = any>(expression: string, timeoutMs = 10_000): Promise<T> {
    const worker = await this.extensionWorker()
    if (!worker) throw new Error("extension service worker not running")
    const { sessionId } = await this.send("Target.attachToTarget", { targetId: worker.targetId, flatten: true })
    try {
      const result = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId, timeoutMs)
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
      return result.result.value as T
    } finally {
      await this.send("Target.detachFromTarget", { sessionId }).catch(() => undefined)
    }
  }

  /** Tabs, groups and windows as the extension sees them. */
  async extensionView(): Promise<{ tabs: { id: number; url: string; groupId: number; windowId: number; active: boolean }[]; groups: { id: number; title: string; windowId: number }[]; windows: number }> {
    return await this.evalInExtension(`(async () => {
      const tabs = (await chrome.tabs.query({})).map(t => ({ id: t.id, url: t.url || t.pendingUrl || "", groupId: t.groupId, windowId: t.windowId, active: t.active }))
      const groups = (await chrome.tabGroups.query({})).map(g => ({ id: g.id, title: g.title || "", windowId: g.windowId }))
      const windows = (await chrome.windows.getAll()).length
      return { tabs, groups, windows }
    })()`)
  }

  /**
   * Stops the extension's service worker the way Chrome does when it goes idle. Target.closeTarget on a worker target
   * terminates it (what Puppeteer's worker.close() does); the ServiceWorker domain is the fallback.
   */
  async stopExtensionWorker(): Promise<string> {
    const worker = await this.extensionWorker()
    if (!worker) return "not-running"
    try {
      const result = await this.send("Target.closeTarget", { targetId: worker.targetId })
      if (result?.success !== false) return "closeTarget"
    } catch {}
    const page = (await this.targets()).find((t) => t.type === "page")
    if (!page) return "no-page"
    const { sessionId } = await this.send("Target.attachToTarget", { targetId: page.targetId, flatten: true })
    try {
      await this.send("ServiceWorker.enable", {}, sessionId)
      await this.send("ServiceWorker.stopAllWorkers", {}, sessionId)
      return "stopAllWorkers"
    } finally {
      await this.send("Target.detachFromTarget", { sessionId }).catch(() => undefined)
    }
  }

  /**
   * Clicks the handoff card's Continue button like a person: switches to the tab, finds the button inside the closed
   * shadow root (DOM.getDocument pierces it), and sends a trusted mouse click at its centre. The host exists (hidden)
   * before the handoff waits, so it keeps clicking every `everyMs` until `done()` says the handoff finished.
   */
  async clickHandoffContinue(targetId: string, done: () => boolean, timeoutMs = 60_000, everyMs = 1500): Promise<number> {
    await this.send("Target.activateTarget", { targetId })
    const { sessionId } = await this.send("Target.attachToTarget", { targetId, flatten: true })
    let clicks = 0
    try {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline && !done()) {
        try {
          const { root } = await this.send("DOM.getDocument", { depth: -1, pierce: true }, sessionId)
          const nodeId = findNode(root, (node) => attribute(node, "id") === "continue" && node.nodeName === "BUTTON")
          if (nodeId !== undefined) {
            const { model } = await this.send("DOM.getBoxModel", { backendNodeId: nodeId }, sessionId)
            const [x1, y1, , , x3, y3] = model.content as number[]
            const x = (x1! + x3!) / 2
            const y = (y1! + y3!) / 2
            await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, sessionId)
            await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 }, sessionId)
            await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 }, sessionId)
            clicks++
          }
        } catch {
          // Not laid out yet (hidden card) or the document changed; try again.
        }
        await sleep(everyMs)
      }
      return clicks
    } finally {
      await this.send("Target.detachFromTarget", { sessionId }).catch(() => undefined)
    }
  }
}

function attribute(node: any, name: string): string | undefined {
  const attributes: string[] = node.attributes ?? []
  for (let i = 0; i < attributes.length; i += 2) if (attributes[i] === name) return attributes[i + 1]
  return undefined
}

function findNode(node: any, match: (node: any) => boolean): number | undefined {
  if (match(node)) return node.backendNodeId
  for (const list of [node.children, node.shadowRoots, node.contentDocument ? [node.contentDocument] : undefined]) {
    for (const child of list ?? []) {
      const found = findNode(child, match)
      if (found !== undefined) return found
    }
  }
  return undefined
}
