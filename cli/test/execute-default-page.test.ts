import { describe, expect, test } from "bun:test"
import type { BrowserContext, Frame, Page } from "patchright-core"
import {
  debuggingBarCanceledWarning,
  defaultPageClosedWarning,
  defaultPageRecoveredWarning,
  defaultPageReattachedWarning,
  defaultPageReplacedWarning,
  SessionPageRecoveryError,
} from "../src/execute/page-recovery.ts"
import { DefaultPageHost, type DefaultPageHostOptions, type DefaultPageTarget } from "../src/execute/default-page.ts"

type Listener = (argument?: unknown) => void

/** Enough of a Playwright Page for page binding: listeners, URL, close and the CDP target id probe. */
class FakePage {
  readonly handlers = new Map<string, Set<Listener>>()
  readonly frame: Frame
  currentUrl: string
  targetId: string
  closed = false
  defaultTimeoutMs: number | undefined
  evaluateCalls = 0
  evaluateError: unknown
  readonly emulatedMedia: Array<{ readonly features: readonly unknown[]; readonly media?: string }> = []

  constructor(url = "https://example.com/", targetId = "target-1") {
    this.currentUrl = url
    this.targetId = targetId
    this.frame = { url: () => this.currentUrl } as unknown as Frame
  }

  asPage(): Page {
    return this as unknown as Page
  }

  url(): string {
    return this.currentUrl
  }

  isClosed(): boolean {
    return this.closed
  }

  mainFrame(): Frame {
    return this.frame
  }

  setDefaultTimeout(milliseconds: number): void {
    this.defaultTimeoutMs = milliseconds
  }

  on(event: string, handler: Listener): void {
    const handlers = this.handlers.get(event) ?? new Set<Listener>()
    handlers.add(handler)
    this.handlers.set(event, handlers)
  }

  once(event: string, handler: Listener): void {
    this.on(event, handler)
  }

  off(event: string, handler: Listener): void {
    this.handlers.get(event)?.delete(handler)
  }

  emit(event: string, argument?: unknown): void {
    for (const handler of [...(this.handlers.get(event) ?? [])]) handler(argument)
  }

  listenCount(event: string): number {
    return this.handlers.get(event)?.size ?? 0
  }

  async evaluate(): Promise<false> {
    this.evaluateCalls += 1
    if (this.evaluateError) throw this.evaluateError
    return false
  }

  async close(): Promise<void> {
    this.closed = true
    this.emit("close")
  }

  context(): unknown {
    const page = this
    return {
      async newCDPSession() {
        return {
          async send(method: string, parameters: { features?: readonly unknown[]; media?: string }) {
            if (method === "Emulation.setEmulatedMedia") {
              page.emulatedMedia.push({
                features: parameters.features ?? [],
                ...(parameters.media === undefined ? {} : { media: parameters.media }),
              })
            }
            return { targetInfo: { targetId: page.targetId } }
          },
          async detach() {},
        }
      },
    }
  }
}

const asContext = (context: { readonly pages: () => Page[]; readonly newPage?: () => Promise<Page> }): BrowserContext =>
  context as unknown as BrowserContext

class TestHost extends DefaultPageHost {
  readonly changes: Array<DefaultPageTarget | undefined> = []
  readonly capturedPages: Array<Page | undefined> = []
  snapshotClears = 0

  constructor(options: DefaultPageHostOptions = {}) {
    super({
      ...options,
      onDefaultTargetChange: (target) => {
        this.changes.push(target)
        options.onDefaultTargetChange?.(target)
      },
    })
  }

  protected clearSnapshotRefs(): void {
    this.snapshotClears += 1
  }

  protected bindCaptureToPage(page: Page | undefined): void {
    this.capturedPages.push(page)
  }

  bind(page: Page, targetId: string | undefined, ownsPage: boolean, notify = true): void {
    this.bindDefaultPage(page, targetId, ownsPage, notify)
  }

  unbind(
    targetId: string | undefined,
    options: {
      readonly ownsPage?: boolean
      readonly pageCrashed?: boolean
      readonly pageProtectedUi?: boolean
      readonly rebind?: "replaced" | "repaired"
      readonly notify?: boolean
    } = {},
  ): void {
    this.unbindDefaultPage(targetId, options)
  }

  sessionPage(context: BrowserContext): Promise<Page> {
    return this.getSessionPage({ context })
  }

  boundPage(): Page | undefined {
    return this.page
  }

  targetId(): string | undefined {
    return this.defaultPageTargetId
  }

  rememberedClosedPage(): { readonly targetId: string; readonly ownsPage: boolean } | undefined {
    return this.closedDefaultPage
  }

  ownsBoundPage(): boolean {
    return this.ownsPage
  }

  healthCheckRequired(): boolean {
    return this.pageHealthCheckRequired
  }

  crashed(): boolean {
    return this.pageCrashed
  }

  protectedUi(): boolean {
    return this.pageProtectedUi
  }

  pendingRebind(): "replaced" | "repaired" | undefined {
    return this.pendingTargetRebind
  }

  lastNonBlankUrl(): string | undefined {
    return this.lastKnownNonBlankUrl
  }

  recreatedUrl(): string | undefined {
    return this.recreatedFromClosedUrl
  }

  warnings(): readonly string[] {
    return this.pendingWarnings
  }

  /** Takes the queued warnings, as an execute result does when it finishes. */
  drainWarnings(): string[] {
    const warnings = this.pendingWarnings
    this.pendingWarnings = []
    return warnings
  }

  mediaFeatures(): Map<string, string> {
    return this.explicitMediaFeatures
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("DefaultPageHost binding", () => {
  test("bindDefaultPage records the identity, URL and ownership, then notifies", () => {
    const host = new TestHost()
    const page = new FakePage()

    host.bind(page.asPage(), "target-1", true)

    expect(host.boundPage()).toBe(page.asPage())
    expect(host.targetId()).toBe("target-1")
    expect(host.ownsBoundPage()).toBe(true)
    expect(host.lastNonBlankUrl()).toBe("https://example.com/")
    expect(host.changes).toEqual([{ id: "target-1", owner: "relay" }])
    expect(page.listenCount("close")).toBe(1)
    expect(page.listenCount("framenavigated")).toBe(1)
    // Binding alone does not move the host's capture recorder.
    expect(host.capturedPages).toEqual([])
  })

  test("an adopted tab reports a user owner", () => {
    const host = new TestHost()

    host.bind(new FakePage().asPage(), "target-2", false)

    expect(host.changes).toEqual([{ id: "target-2", owner: "user" }])
  })

  test("unbindDefaultPage clears the binding, the health check and the listeners, and keeps the target", () => {
    const host = new TestHost()
    const page = new FakePage()
    host.bind(page.asPage(), "target-1", true)
    host.markTargetCrashed("target-1")

    host.unbind("target-1", { ownsPage: true, pageCrashed: true, pageProtectedUi: true, rebind: "replaced" })

    expect(host.boundPage()).toBeUndefined()
    expect(host.targetId()).toBe("target-1")
    expect(host.ownsBoundPage()).toBe(true)
    expect(host.healthCheckRequired()).toBe(false)
    expect(host.crashed()).toBe(true)
    expect(host.protectedUi()).toBe(true)
    expect(host.pendingRebind()).toBe("replaced")
    expect(host.snapshotClears).toBe(2)
    expect(page.listenCount("close")).toBe(0)
    expect(page.listenCount("framenavigated")).toBe(0)
    expect(host.capturedPages).toEqual([undefined])
  })

  test("unbinding without a target drops any pending rebind", () => {
    const host = new TestHost()
    host.bind(new FakePage().asPage(), "target-1", true)

    host.unbind(undefined, { rebind: "replaced" })

    expect(host.targetId()).toBeUndefined()
    expect(host.pendingRebind()).toBeUndefined()
  })

  test("a closed relay-owned page is remembered, so the same tab can come back", () => {
    const host = new TestHost()
    const page = new FakePage()
    host.bind(page.asPage(), "target-1", true)

    page.closed = true
    page.emit("close")

    expect(host.boundPage()).toBeUndefined()
    expect(host.rememberedClosedPage()).toEqual({ targetId: "target-1", ownsPage: true })
    expect(host.recreatedUrl()).toBe("https://example.com/")
    expect(host.changes.at(-1)).toBeUndefined()
  })

  test("a crashed page is not remembered for a reattach", () => {
    const host = new TestHost()
    const page = new FakePage()
    host.bind(page.asPage(), "target-1", true)
    host.markTargetCrashed("target-1")

    page.closed = true
    page.emit("close")

    expect(host.rememberedClosedPage()).toBeUndefined()
    expect(host.crashed()).toBe(true)
  })

  test("navigation records the URL, clears the crash and keeps the default timeout", async () => {
    const host = new TestHost()
    const page = new FakePage()
    host.bind(page.asPage(), "target-1", true)
    host.markTargetCrashed("target-1")
    host.mediaFeatures().set("prefers-color-scheme", "dark")

    page.currentUrl = "https://example.com/next"
    page.emit("framenavigated", page.frame)
    await settle()

    expect(host.crashed()).toBe(false)
    expect(host.lastNonBlankUrl()).toBe("https://example.com/next")
    expect(page.defaultTimeoutMs).toBe(30_000)
    expect(page.emulatedMedia.at(-1)?.features).toContainEqual({ name: "prefers-color-scheme", value: "dark" })
  })

  test("a stale page's close event is ignored after a rebind", () => {
    const host = new TestHost()
    const first = new FakePage("https://first.example/")
    const second = new FakePage("https://second.example/", "target-2")
    host.bind(first.asPage(), "target-1", true)
    host.bind(second.asPage(), "target-2", true)

    first.emit("close")

    expect(host.boundPage()).toBe(second.asPage())
    expect(host.rememberedClosedPage()).toBeUndefined()
    expect(host.targetId()).toBe("target-2")
  })
})

describe("DefaultPageHost relay reports", () => {
  test("markTargetCrashed only matches the bound target and warns once", () => {
    const host = new TestHost()
    host.bind(new FakePage().asPage(), "target-1", true)

    expect(host.markTargetCrashed("other")).toBe(false)
    expect(host.markTargetCrashed("target-1")).toBe(true)
    expect(host.markTargetCrashed("target-1")).toBe(true)

    expect(host.healthCheckRequired()).toBe(true)
    expect(host.crashed()).toBe(true)
    expect(host.warnings()).toHaveLength(1)
  })

  test("markTargetProtectedUi only matches the bound target", () => {
    const host = new TestHost()
    host.bind(new FakePage().asPage(), "target-1", true)

    expect(host.markTargetProtectedUi("other", true)).toBe(false)
    expect(host.markTargetProtectedUi("target-1", true)).toBe(true)
    expect(host.protectedUi()).toBe(true)
    expect(host.markTargetProtectedUi("target-1", false)).toBe(true)
    expect(host.protectedUi()).toBe(false)
  })

  test("markTargetDetached unbinds, remembers the last URL and warns", () => {
    const host = new TestHost()
    host.bind(new FakePage().asPage(), "target-1", true)

    expect(host.markTargetDetached("other")).toBe(false)
    expect(host.markTargetDetached("target-1")).toBe(true)

    expect(host.boundPage()).toBeUndefined()
    expect(host.targetId()).toBeUndefined()
    expect(host.recreatedUrl()).toBe("https://example.com/")
    expect(host.warnings()).toEqual([defaultPageClosedWarning])
  })

  test("markTargetDetached for a debugging bar cancel names the release, again when the next page opens", async () => {
    const host = new TestHost()
    host.bind(new FakePage().asPage(), "target-1", true)

    expect(host.markTargetDetached("target-1", { releasedByUser: true })).toBe(true)

    expect(host.targetId()).toBeUndefined()
    expect(host.warnings()).toEqual([debuggingBarCanceledWarning])
    // A stopped script's discarded result can drain the queued warning; the next execute says it again.
    expect(host.drainWarnings()).toEqual([debuggingBarCanceledWarning])
    const created = new FakePage("https://new.example/", "target-8")
    const context = asContext({ pages: () => [], newPage: async () => created.asPage() })

    await host.sessionPage(context)

    expect(host.warnings()).toEqual([debuggingBarCanceledWarning])
  })

  test("markTargetReplaced keeps ownership and asks for the replaced rebind", () => {
    const host = new TestHost()
    host.bind(new FakePage().asPage(), "old", true)

    expect(host.markTargetReplaced("other", "new")).toBe(false)
    expect(host.markTargetReplaced("old", "new")).toBe(true)

    expect(host.targetId()).toBe("new")
    expect(host.ownsBoundPage()).toBe(true)
    expect(host.pendingRebind()).toBe("replaced")
    expect(host.boundPage()).toBeUndefined()
  })

  test("restore rebinds a durable target and queues its warning", () => {
    const host = new TestHost()
    host.restore({ id: "target-9", owner: "relay" }, "handoff warning")

    expect(host.targetId()).toBe("target-9")
    expect(host.ownsBoundPage()).toBe(true)
    expect(host.warnings()).toEqual(["handoff warning"])

    host.restore(undefined)
    expect(host.targetId()).toBe("target-9")
    expect(host.warnings()).toEqual(["handoff warning", "The relay restarted; session JavaScript state and snapshot refs were reset."])
  })
})

describe("DefaultPageHost recovery", () => {
  test("getSessionPage opens and binds a page when the session has none", async () => {
    const host = new TestHost()
    const created = new FakePage("https://new.example/", "target-7")
    const context = asContext({ pages: () => [], newPage: async () => created.asPage() })

    const page = await host.sessionPage(context)

    expect(page).toBe(created.asPage())
    expect(host.boundPage()).toBe(created.asPage())
    expect(host.targetId()).toBe("target-7")
    expect(host.ownsBoundPage()).toBe(true)
    expect(host.changes.at(-1)).toEqual({ id: "target-7", owner: "relay" })
  })

  test("getSessionPage reattaches the closed default page's tab under the same target", async () => {
    const host = new TestHost()
    const closed = new FakePage()
    host.bind(closed.asPage(), "target-1", true)
    closed.closed = true
    closed.emit("close")

    const same = new FakePage("https://example.com/again", "target-1")
    const context = asContext({ pages: () => [same.asPage()] })

    const page = await host.sessionPage(context)

    expect(page).toBe(same.asPage())
    expect(host.boundPage()).toBe(same.asPage())
    expect(host.recreatedUrl()).toBeUndefined()
    expect(host.warnings().at(-1)).toBe(defaultPageReattachedWarning)
  })

  test("getSessionPage recreates a crashed relay-owned page and says so once", async () => {
    const host = new TestHost()
    const crashed = new FakePage()
    host.bind(crashed.asPage(), "target-1", true)
    host.markTargetCrashed("target-1")
    crashed.evaluateError = new Error("Execution context was destroyed")

    const created = new FakePage("about:blank", "target-2")
    const context = asContext({ pages: () => [], newPage: async () => created.asPage() })

    const page = await host.sessionPage(context)

    expect(page).toBe(created.asPage())
    expect(host.boundPage()).toBe(created.asPage())
    expect(host.warnings()).toContain(defaultPageRecoveredWarning)
    expect(host.healthCheckRequired()).toBe(false)
  })

  test("an adopted page that cannot answer is kept and diagnosed", async () => {
    const host = new TestHost({ pageHealthCheckTimeoutMs: 50 })
    const adopted = new FakePage()
    host.bind(adopted.asPage(), "target-1", false)
    host.markTargetCrashed("target-1")
    adopted.evaluateError = new Error("Execution context was destroyed")

    const failure = await host.sessionPage(asContext({ pages: () => [] })).then(() => undefined, (error: unknown) => error)

    expect(failure).toBeInstanceOf(SessionPageRecoveryError)
    expect(failure instanceof SessionPageRecoveryError && failure.reason).toBe("adopted-unresponsive")
    expect(host.boundPage()).toBe(adopted.asPage())
  })

  test("protected extension UI skips the health probe instead of treating the tab as dead", async () => {
    const host = new TestHost()
    const adopted = new FakePage()
    host.bind(adopted.asPage(), "target-1", false)
    host.markTargetCrashed("target-1")
    host.markTargetProtectedUi("target-1", true)

    const page = await host.sessionPage(asContext({ pages: () => [] }))

    expect(page).toBe(adopted.asPage())
    expect(adopted.evaluateCalls).toBe(0)
  })

  test("a replaced target resolves through the rebind and warns about it", async () => {
    const host = new TestHost()
    const page = new FakePage()
    host.bind(page.asPage(), "target-1", true)
    host.markTargetReplaced("target-1", "target-1")
    const replacement = new FakePage("https://example.com/next", "target-1")
    const context = asContext({ pages: () => [replacement.asPage()] })

    const resolved = await host.sessionPage(context)

    expect(resolved).toBe(replacement.asPage())
    expect(host.warnings()).toContain(defaultPageReplacedWarning)
    expect(host.pendingRebind()).toBeUndefined()
  })
})
