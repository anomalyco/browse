import { describe, expect, test } from "bun:test"
import type { BrowserContext, Page } from "patchright-core"
import {
  applyExplicitMediaFeatures,
  downloadCapabilityErrorMessage,
  installDownloadCapabilityGuard,
  installDownloadCapabilityGuards,
  installViewportZoomGuard,
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
