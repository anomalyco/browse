import type { BrowserContext, Page } from "patchright-core"
import { delay, timedOut, withTimeout } from "./page-recovery.ts"

export const downloadCapabilityErrorMessage = "Downloads are unavailable in browse extension-backed tabs: Chromium blocks Browser.setDownloadBehavior and Page.setDownloadBehavior through chrome.debugger, so Playwright cannot retain an artifact for download.saveAs(). Fetch the response in the page and save the returned bytes with files.write() when the site exposes them."
const downloadGuardedPages = new WeakSet<Page>()
const downloadGuardedContexts = new WeakSet<BrowserContext>()
const viewportZoomGuardedPages = new WeakSet<Page>()

type ViewportGuard = {
  /**
   * The window size before this script's first change. Only kept when it looked like the real one
   * (inner width no wider than the outer window), and only used to decide whether to retry a clear.
   */
  original: { readonly width: number; readonly height: number } | undefined
  /** Whether a script changed the viewport since the last restore. */
  dirty: boolean
}

const viewportGuards = new WeakMap<Page, ViewportGuard>()

/** How long the end of a script may spend putting the viewport back. */
const viewportRestoreTimeoutMs = 2_000

const explicitMediaOptions = [
  ["colorScheme", "prefers-color-scheme"],
  ["reducedMotion", "prefers-reduced-motion"],
  ["forcedColors", "forced-colors"],
  ["contrast", "prefers-contrast"],
] as const

export function installDownloadCapabilityGuard(page: Page): void {
  if (downloadGuardedPages.has(page)) {
    return
  }
  const waitForEvent = page.waitForEvent.bind(page) as (event: string, ...args: unknown[]) => Promise<unknown>
  Object.defineProperty(page, "waitForEvent", {
    configurable: true,
    value: (event: string, ...args: unknown[]) => {
      if (event === "download") {
        return Promise.reject(new Error(downloadCapabilityErrorMessage))
      }
      return waitForEvent(event, ...args)
    },
  })
  downloadGuardedPages.add(page)
}

export function installDownloadCapabilityGuards(context: BrowserContext): void {
  if (downloadGuardedContexts.has(context)) {
    return
  }
  for (const page of context.pages()) {
    installDownloadCapabilityGuard(page)
  }
  context.on("page", installDownloadCapabilityGuard)
  downloadGuardedContexts.add(context)
}

export async function applyExplicitMediaFeatures(
  page: Page,
  explicitMedia: string | undefined,
  explicitMediaFeatures: ReadonlyMap<string, string>,
): Promise<void> {
  try {
    const cdp = await page.context().newCDPSession(page)
    try {
      await cdp.send("Emulation.setEmulatedMedia", {
        ...(explicitMedia ? { media: explicitMedia } : {}),
        features: [
          ...Array.from(explicitMediaFeatures, ([name, value]) => ({ name, value })),
          { name: "__bc_explicit__", value: "1" },
        ],
      })
    } finally {
      await cdp.detach().catch(() => {})
    }
  } catch {}
}

export function installViewportZoomGuard(options: {
  readonly page: Page
  readonly explicitMediaFeatures: Map<string, string>
  readonly getExplicitMedia: () => string | undefined
  readonly setExplicitMedia: (media: string | undefined) => void
  readonly addWarningOnce: (warning: string) => void
}): void {
  const { page, explicitMediaFeatures } = options
  if (viewportZoomGuardedPages.has(page)) return
  if (typeof page.emulateMedia === "function") {
    const originalEmulateMedia = page.emulateMedia.bind(page)
    Object.defineProperty(page, "emulateMedia", {
      configurable: true,
      value: async (mediaOptions?: Parameters<Page["emulateMedia"]>[0]) => {
        for (const [option, feature] of explicitMediaOptions) {
          if (!mediaOptions || !(option in mediaOptions)) continue
          const value = mediaOptions[option]
          if (typeof value === "string") explicitMediaFeatures.set(feature, value)
          else explicitMediaFeatures.delete(feature)
        }
        if (mediaOptions && "media" in mediaOptions) options.setExplicitMedia(mediaOptions.media ?? undefined)
        await originalEmulateMedia(mediaOptions)
        if (explicitMediaFeatures.size > 0) {
          await applyExplicitMediaFeatures(page, options.getExplicitMedia(), explicitMediaFeatures)
        }
      },
    })
  }
  if (typeof page.setViewportSize === "function") {
    const originalSetViewportSize = page.setViewportSize.bind(page)
    const guard: ViewportGuard = { original: undefined, dirty: false }
    Object.defineProperty(page, "setViewportSize", {
      configurable: true,
      value: async (size: { width: number; height: number }) => {
        // Mark first: a set that fails halfway must still be cleared.
        guard.dirty = true
        if (!guard.original) {
          const before = await withTimeout(
            page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight, outerWidth: window.outerWidth })),
            1_000,
          ).catch(() => timedOut)
          // An emulated viewport can be wider than the window; only accept a real-looking one.
          if (typeof before !== "symbol" && before.width <= before.outerWidth) {
            guard.original = { width: before.width, height: before.height }
          }
        }
        await originalSetViewportSize(size)
        try {
          const measured = await withTimeout(
            page.evaluate(() => ({
              innerWidth: window.innerWidth,
              innerHeight: window.innerHeight,
              dpr: window.devicePixelRatio,
            })),
            1_000,
          )
          if (
            measured !== timedOut
            && (Math.abs(measured.innerWidth - size.width) > 2 || Math.abs(measured.innerHeight - size.height) > 2)
          ) {
            options.addWarningOnce(
              `Viewport size ${size.width}x${size.height} resulted in CSS viewport ${measured.innerWidth}x${measured.innerHeight} (devicePixelRatio=${Number(measured.dpr.toFixed(3))}) due to browser zoom on this origin.`,
            )
          }
        } catch {}
      },
    })
    viewportGuards.set(page, guard)
  }
  viewportZoomGuardedPages.add(page)
}

type InProcessPage = Page & {
  /** Playwright's in-process client-to-server mapping (only present when the server shares this process). */
  readonly _connection?: { readonly toImpl?: (object: unknown) => unknown }
  _viewportSize?: unknown
}

type ServerPage = {
  _emulatedSize?: unknown
  readonly delegate?: { readonly _mainFrameSession?: { _metricsOverride?: unknown } }
}

/**
 * Playwright has no API to forget an emulated viewport. It keeps the emulated size on the server
 * Page (`_emulatedSize`, replayed to a new frame session) and the last metrics it sent on the main
 * frame session (`_metricsOverride`, compared to skip identical calls). Clearing the override
 * through CDP alone would therefore come back on a cross-process navigation and a later
 * setViewportSize of the same size would be skipped. These are the two fields setViewportSize
 * caches; the client copy only backs page.viewportSize().
 */
function forgetPlaywrightViewport(page: Page): void {
  try {
    const client = page as InProcessPage
    client._viewportSize = undefined
    const server = client._connection?.toImpl?.(page) as ServerPage | undefined
    if (!server) return
    server._emulatedSize = undefined
    const mainFrameSession = server.delegate?._mainFrameSession
    if (mainFrameSession) mainFrameSession._metricsOverride = undefined
  } catch {}
}

/**
 * Puts a tab back to the window's real viewport after a script changed it. Playwright only emulates
 * a viewport inside an attached tab (it does not resize the user's window), so leaving the override
 * letterboxes the page. Chrome can drop a clear that races the set, so this clears, waits, and uses
 * the captured window size only as a hint for whether one more clear is needed; the overall wait is
 * bounded so a slow browser cannot turn a finished script into a timeout. Cleaning the cached
 * Playwright state keeps later calls correct.
 */
export async function restoreEmulatedViewport(page: Page): Promise<void> {
  const guard = viewportGuards.get(page)
  if (!guard?.dirty) return
  const original = guard.original
  guard.dirty = false
  guard.original = undefined
  const restore = async () => {
    if (page.isClosed()) return
    const cdp = await page.context().newCDPSession(page)
    try {
      const attempts = original ? 3 : 2
      for (let attempt = 0; attempt < attempts; attempt++) {
        await cdp.send("Emulation.clearDeviceMetricsOverride")
        // The clear is applied by the renderer's next layout; measuring immediately can still read
        // the emulated width, which used to look like a dropped clear. A clear repeated only after
        // this pause also lands after the set's visible-size update, which is what Chrome races.
        await delay(120)
        if (!original) continue
        const measured = await withTimeout(
          page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight })),
          500,
        ).catch(() => timedOut)
        if (typeof measured === "symbol") break
        if (Math.abs(measured.width - original.width) <= 2 && Math.abs(measured.height - original.height) <= 2) break
      }
    } finally {
      await cdp.detach().catch(() => {})
    }
  }
  await withTimeout(restore(), viewportRestoreTimeoutMs).catch(() => timedOut)
  forgetPlaywrightViewport(page)
}

/**
 * Runs one execute and always puts the viewports back afterwards, whether it succeeded or failed.
 * Every page in the context the script could have resized is restored, then the original result or
 * error is returned unchanged.
 */
export async function withRestoredViewports<Result>(options: {
  readonly context: BrowserContext
  readonly page: Page
  readonly run: () => Promise<Result>
}): Promise<Result> {
  try {
    return await options.run()
  } finally {
    let pages: Page[] = [options.page]
    try {
      pages = Array.from(new Set([options.page, ...options.context.pages()]))
    } catch {}
    await Promise.all(pages.map((page) => restoreEmulatedViewport(page)))
  }
}
