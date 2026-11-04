import type { BrowserContext, Page } from "patchright-core"
import { timedOut, withTimeout } from "./page-recovery.ts"

export const downloadCapabilityErrorMessage = "Downloads are unavailable in browse extension-backed tabs: Chromium blocks Browser.setDownloadBehavior and Page.setDownloadBehavior through chrome.debugger, so Playwright cannot retain an artifact for download.saveAs(). Fetch the response in the page and save the returned bytes with files.write() when the site exposes them."
const downloadGuardedPages = new WeakSet<Page>()
const downloadGuardedContexts = new WeakSet<BrowserContext>()
const viewportZoomGuardedPages = new WeakSet<Page>()

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
    Object.defineProperty(page, "setViewportSize", {
      configurable: true,
      value: async (size: { width: number; height: number }) => {
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
  }
  viewportZoomGuardedPages.add(page)
}
