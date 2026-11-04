import { Predicate } from "effect"
import type { Locator, Page } from "patchright-core"
import type {
  GhostCursorCalloutOptions,
  GhostCursorCalloutPayload,
  GhostCursorCaptionOptions,
  GhostCursorCaptionPayload,
  GhostCursorClientOptions,
  GhostCursorKeysPayload,
  GhostCursorOperation,
  GhostCursorRect,
  GhostCursorSpotlightOptions,
  GhostCursorSpotlightPayload,
  GhostCursorZoomOptions,
  GhostCursorZoomPayload,
} from "./types.ts"

/** The relay answers this CDP method itself (GhostCursorTabs.command); execute's helpers send it over a CDP session. */
export const ghostCursorCommandMethod = "OpenCodeBrowser.ghostCursor"

async function runGhostCursorOperation(page: Page, op: GhostCursorOperation, payload?: unknown): Promise<void> {
  const session = await page.context().newCDPSession(page)
  try {
    // The relay handles this method; Chromium never sees it.
    await (session.send as (method: string, params: object) => Promise<unknown>)(ghostCursorCommandMethod, {
      op,
      ...(payload === undefined ? {} : { payload }),
    })
  } finally {
    await session.detach().catch(() => {})
  }
}

async function resolveTargetBox(page: Page, target: Locator | string): Promise<GhostCursorRect | null> {
  const locator = Predicate.isString(target) ? page.locator(target) : target
  return await locator.first().boundingBox()
}

export async function showGhostCursor(options: { readonly page: Page; readonly cursorOptions?: GhostCursorClientOptions }): Promise<void> {
  await runGhostCursorOperation(options.page, "show", options.cursorOptions ?? {})
}

export async function hideGhostCursor(options: { readonly page: Page }): Promise<void> {
  await runGhostCursorOperation(options.page, "hide")
}

export async function setGhostCursorCaption(options: {
  readonly page: Page
  readonly title: string | null
  readonly captionOptions?: GhostCursorCaptionOptions
}): Promise<void> {
  const payload: GhostCursorCaptionPayload | null = options.title
    ? { title: options.title, ...(options.captionOptions ? { options: options.captionOptions } : {}) }
    : null
  await runGhostCursorOperation(options.page, "setCaption", payload)
}

export async function showGhostCursorCallout(options: {
  readonly page: Page
  readonly target: Locator | string
  readonly label: string
  readonly calloutOptions?: GhostCursorCalloutOptions
}): Promise<void> {
  const box = await resolveTargetBox(options.page, options.target)
  if (!box) return
  const payload: GhostCursorCalloutPayload = {
    rect: box,
    label: options.label,
    ...(options.calloutOptions ? { options: options.calloutOptions } : {}),
  }
  await runGhostCursorOperation(options.page, "showCallout", payload)
}

export async function clearGhostCursorCallouts(options: { readonly page: Page }): Promise<void> {
  await runGhostCursorOperation(options.page, "clearCallouts")
}

export async function zoomGhostCursorCamera(options: {
  readonly page: Page
  readonly target: Locator | string | { readonly x: number; readonly y: number } | null
  readonly zoomOptions?: GhostCursorZoomOptions
}): Promise<void> {
  let rect: GhostCursorRect | null = null
  if (options.target !== null) {
    rect = (Predicate.isString(options.target) || "boundingBox" in options.target)
      ? await resolveTargetBox(options.page, options.target)
      : { x: options.target.x, y: options.target.y, width: 1, height: 1 }
  }
  const payload: GhostCursorZoomPayload = {
    rect,
    scale: options.target === null ? 1 : (options.zoomOptions?.scale ?? 1.75),
    durationMs: options.zoomOptions?.durationMs ?? 360,
  }
  await runGhostCursorOperation(options.page, "zoomTo", payload)
}

export async function setGhostCursorSpotlight(options: {
  readonly page: Page
  readonly target: Locator | string | null
  readonly spotlightOptions?: GhostCursorSpotlightOptions
}): Promise<void> {
  const rect = options.target !== null ? await resolveTargetBox(options.page, options.target) : null
  const payload: GhostCursorSpotlightPayload = {
    rect,
    ...(options.spotlightOptions ? { options: options.spotlightOptions } : {}),
  }
  await runGhostCursorOperation(options.page, "setSpotlight", payload)
}

export async function showGhostCursorKeys(options: {
  readonly page: Page
  readonly keys: string | readonly string[]
  readonly label?: string
}): Promise<void> {
  const keys = Predicate.isString(options.keys) ? options.keys.split("+").map((k) => k.trim()).filter(Boolean) : options.keys
  const payload: GhostCursorKeysPayload = {
    keys,
    ...(options.label ? { label: options.label } : {}),
  }
  await runGhostCursorOperation(options.page, "showKeys", payload)
}
