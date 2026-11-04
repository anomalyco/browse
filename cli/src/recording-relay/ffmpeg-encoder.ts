import { execFile, spawn } from "node:child_process"
import crypto from "node:crypto"
import { once } from "node:events"
import fs from "node:fs/promises"
import { performance } from "node:perf_hooks"
import { Predicate } from "effect"
import { terminateChildProcess } from "../child-process.ts"
import { mjpegMatroskaFrame, mjpegMatroskaHeader } from "../mjpeg-matroska.ts"
import type { JsonObject } from "../protocol.ts"
import { getObject, getString } from "../relay-helpers.ts"
import {
  fallbackCdpHeight,
  fallbackCdpWidth,
  type SendDebuggerCommand,
  type StartVideoEncoder,
  type VideoEncoder,
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

function cdpRecordingSize(metrics: JsonObject): { readonly width: number; readonly height: number } {
  const viewport = getObject(metrics.cssVisualViewport) ?? getObject(metrics.visualViewport)
  const viewportWidth = Predicate.isNumber(viewport?.clientWidth) ? viewport.clientWidth : fallbackCdpWidth
  const viewportHeight = Predicate.isNumber(viewport?.clientHeight) ? viewport.clientHeight : fallbackCdpHeight
  return {
    width: Math.max(2, Math.floor(viewportWidth) & ~1),
    height: Math.max(2, Math.floor(viewportHeight) & ~1),
  }
}

export async function startFfmpegVideoEncoder(options: Parameters<StartVideoEncoder>[0]): Promise<VideoEncoder> {
  // Preserve start-time dependency errors even though geometry arrives later.
  await new Promise<void>((resolve, reject) => {
    execFile("ffmpeg", ["-version"], { timeout: 5_000 }, (error) => error ? reject(error) : resolve())
  })
  // The first compositor frame supplies the backing surface's CSS width. It can
  // differ from both the emulated viewport and the JPEG's Retina pixel width.
  let acquisition: Promise<VideoEncoder> | undefined
  let cancelled = false
  return {
    write: async (frame, timestampMs, durationMs, surfaceWidth) => {
      if (cancelled) throw new Error("ffmpeg recording was cancelled")
      acquisition ??= createFfmpegVideoEncoder({ ...options, surfaceWidth: surfaceWidth ?? options.width })
      const encoder = await acquisition
      if (cancelled) throw new Error("ffmpeg recording was cancelled")
      await encoder.write(frame, timestampMs, durationMs)
    },
    finish: async () => {
      if (!acquisition) throw new Error("No recording frames received")
      await (await acquisition).finish()
    },
    cancel: async () => {
      cancelled = true
      if (acquisition) await (await acquisition).cancel()
    },
  }
}

async function createFfmpegVideoEncoder(options: {
  readonly outputPath: string
  readonly artifactType: "webm" | "mp4"
  readonly frameRate: number
  readonly width: number
  readonly height: number
  readonly surfaceWidth: number
}): Promise<VideoEncoder> {
  const temporaryOutputPath = `${options.outputPath}.partial-${process.pid}-${crypto.randomUUID()}`
  const outputArgs = options.artifactType === "webm"
    ? ["-c:v", "libvpx", "-crf", "4", "-deadline", "good", "-cpu-used", "4", "-b:v", "6M", "-threads", "2"]
    : ["-c:v", "libx264", "-preset", "fast", "-crf", "14", "-tune", "animation", "-pix_fmt", "yuv420p", "-movflags", "+faststart"]
  const child = spawn("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "matroska",
    "-fpsprobesize",
    "0",
    "-probesize",
    "32",
    "-analyzeduration",
    "0",
    "-i",
    "pipe:0",
    "-an",
    "-r",
    String(options.frameRate),
    "-fps_mode",
    "cfr",
    "-vf",
    `scale=min(iw\\,${options.surfaceWidth}):-1:flags=lanczos,pad=ceil(max(iw\\,${options.width})/2)*2:ceil(max(ih\\,${options.height})/2)*2:0:0:gray,crop=${options.width}:${options.height}:0:0`,
    ...outputArgs,
    "-f",
    options.artifactType,
    temporaryOutputPath,
  ], { detached: process.platform !== "win32", stdio: "pipe" })
  let stderr = ""
  child.stderr.setEncoding("utf8")
  child.stderr.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-8_000)
  })
  const exit = new Promise<Error | undefined>((resolve) => {
    child.once("error", (error) => resolve(error))
    child.once("close", (code, signal) => {
      if (code === 0) resolve(undefined)
      else resolve(new Error(`ffmpeg exited with ${code ?? signal ?? "unknown status"}${stderr.trim() ? `: ${stderr.trim()}` : ""}`))
    })
  })
  try {
    await once(child, "spawn")
    await writeStreamChunk(child.stdin, mjpegMatroskaHeader(options.width, options.height))
  } catch (error) {
    await exit
    await fs.rm(temporaryOutputPath, { force: true })
    throw error
  }
  let completed = false
  let finishingPromise: Promise<void> | undefined
  let cancelPromise: Promise<void> | undefined
  const terminate = async () => {
    child.stdin.destroy()
    await terminateChildProcess({ child, exit, graceMs: 2_000 })
  }
  return {
    write: async (frame, timestampMs, durationMs) => {
      if (completed || finishingPromise || cancelPromise) throw new Error("ffmpeg input closed before recording finished")
      const envelope = mjpegMatroskaFrame(timestampMs, durationMs, frame.length)
      try {
        await writeStreamChunk(child.stdin, envelope.header)
        await writeStreamChunk(child.stdin, frame)
        await writeStreamChunk(child.stdin, envelope.trailer)
      } catch (error) {
        throw new Error(`${error instanceof Error ? error.message : String(error)}${stderr.trim() ? `: ${stderr.trim()}` : ""}`)
      }
    },
    finish: async () => {
      if (completed) return
      if (cancelPromise) throw new Error("ffmpeg recording was cancelled")
      if (finishingPromise) return finishingPromise
      finishingPromise = (async () => {
        child.stdin.end()
        const exited = await waitForProcessExit(exit, 30_000)
        if (!exited) {
          await terminate()
          throw new Error("ffmpeg did not finish within 30000ms")
        }
        const error = await exit
        if (error) throw error
        await fs.rename(temporaryOutputPath, options.outputPath)
        completed = true
      })().catch(async (error: unknown) => {
        await fs.rm(temporaryOutputPath, { force: true })
        throw error
      })
      return finishingPromise
    },
    cancel: async () => {
      if (completed) return
      if (cancelPromise) return cancelPromise
      cancelPromise = (async () => {
        await terminate()
        await fs.rm(temporaryOutputPath, { force: true })
      })()
      return cancelPromise
    },
  }
}

async function writeStreamChunk(stream: NodeJS.WritableStream, chunk: Buffer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }
    const onClose = () => {
      cleanup()
      reject(new Error("ffmpeg input closed before recording finished"))
    }
    const cleanup = () => {
      stream.removeListener("error", onError)
      stream.removeListener("close", onClose)
    }
    stream.once("error", onError)
    stream.once("close", onClose)
    stream.write(chunk, (error?: Error | null) => {
      cleanup()
      if (error) reject(error)
      else resolve()
    })
  })
}

async function waitForProcessExit(exit: Promise<Error | undefined>, timeoutMs: number): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<false>((resolve) => {
    timeout = setTimeout(() => resolve(false), timeoutMs)
  })
  const result = await Promise.race([exit.then(() => true as const), timedOut])
  if (timeout) clearTimeout(timeout)
  return result
}
