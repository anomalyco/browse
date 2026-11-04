import { performance } from "node:perf_hooks"
import { Predicate } from "effect"
import type { JsonObject } from "../protocol.ts"
import { getNumber, getObject, getString } from "../relay/helpers.ts"
import {
  fallbackCdpHeight,
  fallbackCdpWidth,
  type SendDebuggerCommand,
} from "./types.ts"

/**
 * The size to record at. Never brings the tab to the front: that raises the browser window over the user's work.
 * A background tab keeps rendering through focus emulation (set at attach); when the screencast still sends no
 * frames, startScreenshotFallback fills in.
 */
export async function prepareCdpScreencastViewport(
  sendDebuggerCommand: SendDebuggerCommand,
  tabId: number,
): Promise<{ readonly width: number; readonly height: number }> {
  const metrics = await sendDebuggerCommand({ tabId, method: "Page.getLayoutMetrics", params: {} })
  return cdpRecordingSize(metrics)
}

/** How long a screencast may stay silent before screenshots stand in for it. */
const screencastFallbackGraceMs = 1_500
/** Screenshots are slower than screencast frames; this many per second at most. */
const maxFallbackFrameRate = 10

/**
 * Chrome sends no screencast frames for a tab it doesn't paint (a background tab in some builds, an occluded window).
 * Once a screencast has been silent for a moment, polls Page.captureScreenshot and hands each image to `onFrame` as
 * screencast frame params (without a sessionId, so nothing is acknowledged), until a real frame arrives or the
 * recording ends. Returns a stop function.
 */
export function startScreenshotFallback(options: {
  readonly sendDebuggerCommand: SendDebuggerCommand
  readonly tabId: number
  readonly frameRate: number
  readonly quality: number
  readonly hasScreencastFrames: () => boolean
  readonly active: () => boolean
  readonly onFrame: (params: JsonObject) => void
}): () => void {
  let stopped = false
  const running = () => !stopped && options.active() && !options.hasScreencastFrames()
  const intervalMs = Math.round(1_000 / Math.max(1, Math.min(options.frameRate, maxFallbackFrameRate)))
  void (async () => {
    await sleep(screencastFallbackGraceMs)
    while (running()) {
      const started = performance.now()
      const screenshot = await options.sendDebuggerCommand({
        tabId: options.tabId,
        method: "Page.captureScreenshot",
        params: { format: "jpeg", quality: options.quality, fromSurface: true, captureBeyondViewport: false },
      }).catch(() => undefined)
      const data = screenshot ? getString(screenshot, "data") : undefined
      if (data !== undefined && running()) options.onFrame({ data, metadata: {} })
      await sleep(Math.max(0, intervalMs - (performance.now() - started)))
    }
  })()
  return () => {
    stopped = true
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function cdpRecordingSize(metrics: JsonObject): { readonly width: number; readonly height: number } {
  const viewport = getObject(metrics.cssVisualViewport) ?? getObject(metrics.visualViewport)
  const viewportWidth = Predicate.isNumber(viewport?.clientWidth) ? viewport.clientWidth : fallbackCdpWidth
  const viewportHeight = Predicate.isNumber(viewport?.clientHeight) ? viewport.clientHeight : fallbackCdpHeight
  return {
    width: Math.max(2, Math.floor(viewportWidth) & ~1),
    height: Math.max(2, Math.floor(viewportHeight) & ~1),
  }
}

/** A Page.screencastFrame's fields, read once so both recorders treat a frame the same way. */
export type ScreencastFrame = {
  /** Present on real screencast frames; a fallback screenshot has none and is never acknowledged. */
  readonly sessionId?: number
  /** Base64 JPEG data, when the frame carries one. */
  readonly data?: string
  readonly deviceWidth?: number
  readonly deviceHeight?: number
}

export function parseScreencastFrame(params: JsonObject | undefined): ScreencastFrame {
  const sessionId = getNumber(params, "sessionId")
  const data = getString(params, "data")
  const metadata = getObject(params?.metadata)
  const deviceWidth = getNumber(metadata, "deviceWidth")
  const deviceHeight = getNumber(metadata, "deviceHeight")
  return {
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(data === undefined ? {} : { data }),
    ...(deviceWidth === undefined ? {} : { deviceWidth }),
    ...(deviceHeight === undefined ? {} : { deviceHeight }),
  }
}

/**
 * Marks a real frame as seen and acknowledges it, fire-and-forget. Callers own the error handling: a recording that
 * stopped logs nothing, while a live one reports the failure.
 */
export function acknowledgeScreencastFrame(options: {
  readonly sendDebuggerCommand: SendDebuggerCommand
  readonly tabId: number
  readonly frame: ScreencastFrame
  readonly onSeen: () => void
  readonly onError?: (error: unknown) => void
}): void {
  if (options.frame.sessionId === undefined) return
  options.onSeen()
  void options.sendDebuggerCommand({
    tabId: options.tabId,
    method: "Page.screencastFrameAck",
    params: { sessionId: options.frame.sessionId },
  }).catch((error: unknown) => {
    options.onError?.(error)
  })
}

/**
 * Starts the tab's screencast and then, once it runs, the screenshot fallback for tabs Chrome never paints. Pass
 * `shouldContinue` to abandon a start that was cancelled between the two steps; undefined means it was abandoned.
 */
export async function startCdpScreencast(options: {
  readonly sendDebuggerCommand: SendDebuggerCommand
  readonly tabId: number
  readonly frameRate: number
  readonly quality: number
  readonly hasScreencastFrames: () => boolean
  readonly active: () => boolean
  readonly onFrame: (params: JsonObject) => void
  readonly shouldContinue?: () => boolean
}): Promise<(() => void) | undefined> {
  await options.sendDebuggerCommand({
    tabId: options.tabId,
    method: "Page.startScreencast",
    params: {
      format: "jpeg",
      quality: options.quality,
      everyNthFrame: 1,
    },
  })
  if (options.shouldContinue?.() === false) return undefined
  return startScreenshotFallback({
    sendDebuggerCommand: options.sendDebuggerCommand,
    tabId: options.tabId,
    frameRate: options.frameRate,
    quality: options.quality,
    hasScreencastFrames: options.hasScreencastFrames,
    active: options.active,
    onFrame: options.onFrame,
  })
}
