import { describe, expect, test } from "bun:test"
import type { BrowserContext, Page } from "patchright-core"
import {
  applyExplicitMediaFeatures,
  downloadCapabilityErrorMessage,
  installDownloadCapabilityGuard,
  installDownloadCapabilityGuards,
  installViewportZoomGuard,
  restoreEmulatedViewport,
  withRestoredViewports,
} from "../src/execute/guards.ts"

type EmulateMediaOptions = Parameters<Page["emulateMedia"]>[0]

const asPage = (page: Record<string, unknown>): Page => page as unknown as Page
const asContext = (context: Record<string, unknown>): BrowserContext => context as unknown as BrowserContext

function viewportGuardOptions(page: Page, overrides: {
  readonly explicitMediaFeatures?: Map<string, string>
  readonly explicitMedia?: string | undefined
  readonly setExplicitMedia?: (media: string | undefined) => void
  readonly warnings?: string[]
} = {}) {
  const warnings = overrides.warnings ?? []
  return {
    page,
    explicitMediaFeatures: overrides.explicitMediaFeatures ?? new Map<string, string>(),
    getExplicitMedia: () => overrides.explicitMedia,
    setExplicitMedia: overrides.setExplicitMedia ?? (() => {}),
    addWarningOnce: (warning: string) => {
      warnings.push(warning)
    },
  }
}

describe("installDownloadCapabilityGuard", () => {
  test("rejects download events with the capability message and delegates every other event", async () => {
    const delegated: Array<{ event: string; args: unknown[] }> = []
    const page = asPage({
      waitForEvent: async (event: string, ...args: unknown[]) => {
        delegated.push({ event, args })
        return { event }
      },
    })

    installDownloadCapabilityGuard(page)

    const rejection = await page.waitForEvent("download").then(() => undefined, (error: unknown) => error)
    expect(rejection).toBeInstanceOf(Error)
    expect((rejection as Error).message).toBe(downloadCapabilityErrorMessage)
    expect(delegated).toEqual([])

    await page.waitForEvent("response", { timeout: 5 })
    expect(delegated).toEqual([{ event: "response", args: [{ timeout: 5 }] }])
  })

  test("installs once per page", async () => {
    const delegated: string[] = []
    const page = asPage({
      waitForEvent: async (event: string) => {
        delegated.push(event)
        return event
      },
    })

    installDownloadCapabilityGuard(page)
    const installed = page.waitForEvent
    installDownloadCapabilityGuard(page)

    expect(page.waitForEvent).toBe(installed)
    await page.waitForEvent("response")
    expect(delegated).toEqual(["response"])
  })
})

describe("installDownloadCapabilityGuards", () => {
  test("guards existing pages, later pages, and installs one handler per context", async () => {
    const handlers: Array<(page: Page) => void> = []
    const first = asPage({ waitForEvent: async () => undefined })
    const second = asPage({ waitForEvent: async () => undefined })
    const later = asPage({ waitForEvent: async () => undefined })
    const context = asContext({
      pages: () => [first, second],
      on: (event: string, handler: (page: Page) => void) => {
        if (event === "page") handlers.push(handler)
      },
    })

    installDownloadCapabilityGuards(context)
    installDownloadCapabilityGuards(context)

    expect(handlers).toHaveLength(1)
    const guarded = [first, second].map((page) => page.waitForEvent)
    installDownloadCapabilityGuards(context)
    expect([first, second].map((page) => page.waitForEvent)).toEqual(guarded)

    handlers[0]?.(later)
    const rejection = await later.waitForEvent("download").then(() => undefined, (error: unknown) => error)
    expect(rejection).toBeInstanceOf(Error)
    expect((rejection as Error).message).toBe(downloadCapabilityErrorMessage)
  })
})

describe("applyExplicitMediaFeatures", () => {
  test("sends the explicit feature marker and detaches the session", async () => {
    const sent: Array<{ method: string; params: unknown }> = []
    const detachable: string[] = []
    const page = asPage({
      context: () => ({
        newCDPSession: async () => ({
          send: async (method: string, params: unknown) => {
            sent.push({ method, params })
          },
          detach: async () => {
            detachable.push("detached")
          },
        }),
      }),
    })

    await applyExplicitMediaFeatures(page, "print", new Map([["prefers-color-scheme", "dark"]]))

    expect(sent).toEqual([{
      method: "Emulation.setEmulatedMedia",
      params: {
        media: "print",
        features: [
          { name: "prefers-color-scheme", value: "dark" },
          { name: "__bc_explicit__", value: "1" },
        ],
      },
    }])
    expect(detachable).toEqual(["detached"])
  })

  test("swallows CDP failures", async () => {
    const page = asPage({
      context: () => ({
        newCDPSession: async () => {
          throw new Error("chrome.debugger is blocked")
        },
      }),
    })

    await expect(applyExplicitMediaFeatures(page, undefined, new Map())).resolves.toBeUndefined()
  })
})

function guardedPage(options: {
  readonly clearFails?: boolean
  readonly withInternals?: boolean
  readonly setViewportFails?: boolean
} = {}) {
  const sent: string[] = []
  const detached: string[] = []
  const serverPage = {
    _emulatedSize: { viewport: { width: 1200, height: 800 } },
    delegate: { _mainFrameSession: { _metricsOverride: { width: 1200, height: 800 } } },
  }
  const page = asPage({
    setViewportSize: async () => {
      if (options.setViewportFails) throw new Error("target closed")
    },
    evaluate: async () => ({ innerWidth: 990, innerHeight: 0, width: 990, height: 0, outerWidth: 1000, dpr: 1 }),
    isClosed: () => false,
    context: () => ({
      newCDPSession: async () => ({
        send: async (method: string) => {
          if (options.clearFails) throw new Error("chrome.debugger is blocked")
          sent.push(method)
        },
        detach: async () => {
          detached.push("detached")
        },
      }),
    }),
    _connection: options.withInternals === false ? {} : { toImpl: () => serverPage },
    _viewportSize: { width: 1200, height: 800 },
  })
  installViewportZoomGuard(viewportGuardOptions(page))
  return { page, sent, detached, serverPage }
}

describe("installViewportZoomGuard", () => {
  test("records explicit media features and forwards media to the original call", async () => {
    const forwarded: Array<EmulateMediaOptions | undefined> = []
    const explicitMedia: Array<string | undefined> = []
    const features = new Map<string, string>()
    const page = asPage({
      emulateMedia: async (options?: EmulateMediaOptions) => {
        forwarded.push(options)
      },
      setViewportSize: async () => {},
      context: () => ({
        newCDPSession: async () => {
          throw new Error("chrome.debugger is blocked")
        },
      }),
    })

    installViewportZoomGuard(viewportGuardOptions(page, {
      explicitMediaFeatures: features,
      setExplicitMedia: (media) => {
        explicitMedia.push(media)
      },
    }))

    await page.emulateMedia({ colorScheme: "dark", reducedMotion: null, media: "print" })

    expect(forwarded).toEqual([{ colorScheme: "dark", reducedMotion: null, media: "print" }])
    expect(features.get("prefers-color-scheme")).toBe("dark")
    expect(features.has("prefers-reduced-motion")).toBe(false)
    expect(explicitMedia).toEqual(["print"])
  })

  test("installs once per page", async () => {
    const calls: string[] = []
    const page = asPage({
      emulateMedia: async () => {
        calls.push("emulateMedia")
      },
      setViewportSize: async () => {
        calls.push("setViewportSize")
      },
      evaluate: async () => ({ innerWidth: 0, innerHeight: 0, dpr: 1 }),
    })

    installViewportZoomGuard(viewportGuardOptions(page))
    const installedEmulateMedia = page.emulateMedia
    const installedSetViewportSize = page.setViewportSize
    installViewportZoomGuard(viewportGuardOptions(page))

    expect(page.emulateMedia).toBe(installedEmulateMedia)
    expect(page.setViewportSize).toBe(installedSetViewportSize)
    await page.emulateMedia({ colorScheme: "dark" })
    await page.setViewportSize({ width: 800, height: 600 })
    expect(calls).toEqual(["emulateMedia", "setViewportSize"])
  })

  test("warns once when browser zoom changes the CSS viewport", async () => {
    const warnings: string[] = []
    const page = asPage({
      setViewportSize: async () => {},
      evaluate: async () => ({ innerWidth: 1000, innerHeight: 600, dpr: 2 }),
    })

    installViewportZoomGuard(viewportGuardOptions(page, { warnings }))
    await page.setViewportSize({ width: 800, height: 600 })

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("800x600")
    expect(warnings[0]).toContain("1000x600")
  })

  test("does not warn when the measured viewport matches within two pixels", async () => {
    const warnings: string[] = []
    const page = asPage({
      setViewportSize: async () => {},
      evaluate: async () => ({ innerWidth: 801, innerHeight: 599, dpr: 1 }),
    })

    installViewportZoomGuard(viewportGuardOptions(page, { warnings }))
    await page.setViewportSize({ width: 800, height: 600 })

    expect(warnings).toEqual([])
  })
})

describe("restoreEmulatedViewport", () => {
  test("clears the override and forgets Playwright's cached viewport after a script set one", async () => {
    const { page, sent, detached, serverPage } = guardedPage()
    await page.setViewportSize({ width: 1200, height: 800 })

    await restoreEmulatedViewport(page)

    expect(sent).toEqual(["Emulation.clearDeviceMetricsOverride"])
    expect(detached).toEqual(["detached"])
    expect(serverPage._emulatedSize).toBeUndefined()
    expect(serverPage.delegate._mainFrameSession._metricsOverride).toBeUndefined()
    expect((page as unknown as { _viewportSize?: unknown })._viewportSize).toBeUndefined()
  })

  test("does not open a CDP session when the script never changed the viewport", async () => {
    const { page, sent } = guardedPage()

    await restoreEmulatedViewport(page)

    expect(sent).toEqual([])
  })

  test("runs once per script and never throws when the clear fails", async () => {
    const { page, sent, serverPage } = guardedPage({ clearFails: true })
    await page.setViewportSize({ width: 1200, height: 800 })

    await expect(restoreEmulatedViewport(page)).resolves.toBeUndefined()
    await expect(restoreEmulatedViewport(page)).resolves.toBeUndefined()

    expect(sent).toEqual([])
    expect(serverPage._emulatedSize).toBeUndefined()
  })

  test("clears even when Playwright internals are unavailable", async () => {
    const { page, sent } = guardedPage({ withInternals: false })
    await page.setViewportSize({ width: 1200, height: 800 })

    await expect(restoreEmulatedViewport(page)).resolves.toBeUndefined()

    expect(sent).toEqual(["Emulation.clearDeviceMetricsOverride"])
  })

  test("stops clearing when the overall restore times out", async () => {
    const sent: string[] = []
    type FakeSession = { send: (method: string) => Promise<void>; detach: () => Promise<void> }
    let resolveSession: ((session: FakeSession) => void) | undefined
    const page = asPage({
      setViewportSize: async () => {},
      evaluate: async () => ({ innerWidth: 990, innerHeight: 0, width: 990, height: 0, outerWidth: 1000, dpr: 1 }),
      isClosed: () => false,
      context: () => ({
        newCDPSession: () => new Promise<FakeSession>((resolve) => {
          resolveSession = resolve
        }),
      }),
    })
    installViewportZoomGuard(viewportGuardOptions(page))
    await page.setViewportSize({ width: 1200, height: 800 })

    // The session never opens before the ~2s bound; when it does, the cancelled restore must not
    // send a clear over the next script's viewport.
    await restoreEmulatedViewport(page)
    resolveSession?.({ send: async (method: string) => { sent.push(method) }, detach: async () => {} })
    await Bun.sleep(100)

    expect(sent).toEqual([])
  }, 10_000)

  test("retries a clear that Chrome dropped", async () => {
    const sent: string[] = []
    let width = 780
    const page = asPage({
      setViewportSize: async (size: { width: number; height: number }) => {
        width = size.width
      },
      evaluate: async () => ({ innerWidth: width, innerHeight: 800, width, height: 800, outerWidth: 800, dpr: 1 }),
      isClosed: () => false,
      context: () => ({
        newCDPSession: async () => ({
          send: async (method: string) => {
            sent.push(method)
            // The first clear lands too close to the set and Chrome drops it; the next applies.
            if (sent.length === 2) width = 780
          },
          detach: async () => {},
        }),
      }),
    })
    installViewportZoomGuard(viewportGuardOptions(page))
    await page.setViewportSize({ width: 1200, height: 800 })

    await restoreEmulatedViewport(page)

    expect(sent).toEqual(["Emulation.clearDeviceMetricsOverride", "Emulation.clearDeviceMetricsOverride"])
    expect(width).toBe(780)
  })

  test("clears after a set that failed partway", async () => {
    const { page, sent, serverPage } = guardedPage({ setViewportFails: true })

    await expect(page.setViewportSize({ width: 1200, height: 800 })).rejects.toThrow("target closed")
    await restoreEmulatedViewport(page)

    expect(sent).toEqual(["Emulation.clearDeviceMetricsOverride"])
    expect(serverPage._emulatedSize).toBeUndefined()
  })
})

describe("withRestoredViewports", () => {
  const contextOf = (pages: () => Page[]) => asContext({ pages })

  test("restores every page in the context, including one opened during the script", async () => {
    const first = guardedPage()
    const second = guardedPage()
    const opened = guardedPage()
    const pages = [first.page, second.page]
    await first.page.setViewportSize({ width: 1200, height: 800 })
    await opened.page.setViewportSize({ width: 1000, height: 700 })

    const result = await withRestoredViewports({
      context: contextOf(() => pages),
      page: first.page,
      run: async () => {
        pages.push(opened.page)
        return "result"
      },
    })

    expect(result).toBe("result")
    expect(first.sent).toHaveLength(1)
    expect(second.sent).toEqual([])
    expect(opened.sent).toHaveLength(1)
  })

  test("restores on failure and rethrows the same error", async () => {
    const first = guardedPage()
    await first.page.setViewportSize({ width: 1200, height: 800 })
    const failure = new Error("script failed")

    const thrown = await withRestoredViewports({
      context: contextOf(() => [first.page]),
      page: first.page,
      run: async () => {
        throw failure
      },
    }).then(() => undefined, (error: unknown) => error)

    expect(thrown).toBe(failure)
    expect(first.sent).toHaveLength(1)
  })
})
