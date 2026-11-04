import fs from "node:fs/promises"
import path from "node:path"
import type { JsonObject } from "../protocol.ts"
import { getNumber, getObject, getString } from "../relay/helpers.ts"
import { prepareCdpScreencastViewport, startFfmpegVideoEncoder, startScreenshotFallback } from "./ffmpeg-encoder.ts"
import {
  cdpArtifactType,
  cdpJpegQuality,
  defaultCdpFrameRate,
  maxPendingCdpFrames,
  recordingQuality,
  type ActiveRecording,
  type CdpRecording,
  type CdpVideoFrame,
  type RecordingStartOptions,
  type RecordingStartResult,
  type RecordingStopResult,
  type SendDebuggerCommand,
  type StartingRecording,
  type StartVideoEncoder,
  type VideoEncoder,
} from "./types.ts"

export type CdpCaptureContext = {
  readonly activeRecordings: Map<number, ActiveRecording>
  readonly sendDebuggerCommand: SendDebuggerCommand
  readonly startVideoEncoder?: StartVideoEncoder
  readonly now: () => number
  readonly monotonicNow: () => number
  readonly recordingChanged: (tabId: number) => void
  readonly armMaxDuration: (recording: ActiveRecording, requestedMaxDurationMs: number | undefined) => void
  readonly onFallbackFrame: (tabId: number, params: JsonObject) => void
}

export function handleCdpScreencastFrame(
  context: CdpCaptureContext,
  recording: CdpRecording,
  options: { readonly tabId: number; readonly params: JsonObject | undefined },
): boolean {
  const frameSessionId = getNumber(options.params, "sessionId")
  if (frameSessionId !== undefined) {
    recording.screencastFrameSeen = true
    void context.sendDebuggerCommand({
      tabId: recording.tabId,
      method: "Page.screencastFrameAck",
      params: { sessionId: frameSessionId },
    }).catch((error: unknown) => {
      if (!recording.stopped && !recording.stopping) console.error("CDP recording frame acknowledgement failed", error)
    })
  }
  const frameData = getString(options.params, "data")
  if (recording.stopped || recording.stopping || frameData === undefined) {
    return true
  }
  const metadata = getObject(options.params?.metadata)
  recording.sourceFrameCount += 1
  if (recording.pendingFrameCount >= maxPendingCdpFrames || recording.writeError) {
    recording.droppedFrameCount += 1
    return true
  }
  const deviceWidth = getNumber(metadata, "deviceWidth")
  const deviceHeight = getNumber(metadata, "deviceHeight")
  if (deviceWidth !== undefined) recording.sourceWidth = deviceWidth
  if (deviceHeight !== undefined) recording.sourceHeight = deviceHeight
  const buffer = Buffer.from(frameData, "base64")
  const receivedAt = context.monotonicNow()
  const rawFramePosition = ((receivedAt - recording.startedMonotonicAt) / 1_000) * recording.frameRate
  let frameNumber = recording.sourceFrameCount === 1
    ? 0
    : Math.max(0, Math.floor(rawFramePosition))
  if (recording.lastFrame && frameNumber === recording.lastFrame.frameNumber && rawFramePosition - frameNumber >= 0.5) {
    frameNumber = recording.lastFrame.frameNumber + 1
  }
  recording.pendingFrameCount += 1
  recording.writePromise = recording.writePromise.then(async () => {
    if (recording.lastFrame && frameNumber !== recording.lastFrame.frameNumber) {
      await writeSourceFrame(recording, recording.lastFrame, frameNumber)
    } else if (recording.lastFrame) {
      recording.coalescedFrameCount += 1
    }
    recording.lastFrame = {
      buffer,
      frameNumber,
      ...(deviceWidth !== undefined ? { surfaceWidth: deviceWidth } : {}),
    }
  }).catch((error: unknown) => {
    recording.writeError = error instanceof Error ? error : new Error(String(error))
  }).finally(() => {
    recording.pendingFrameCount -= 1
  })
  return true
}

export async function startCdpRecording(
  context: CdpCaptureContext,
  options: RecordingStartOptions,
  starting: StartingRecording,
): Promise<RecordingStartResult> {
  const cancelledResult = (): RecordingStartResult => ({ success: false, error: "Recording was cancelled while starting" })
  if (options.audio === true) {
    return { success: false, error: "CDP recording captures video frames only; audio is not supported" }
  }
  const artifactType = cdpArtifactType(options.outputPath)
  if (!artifactType) {
    return { success: false, error: "CDP recording output path must end in .webm or .mp4" }
  }
  await fs.mkdir(path.dirname(options.outputPath), { recursive: true })
  if (starting.cancelled) return cancelledResult()
  const frameRate = options.frameRate ?? defaultCdpFrameRate
  let size: { readonly width: number; readonly height: number }
  try {
    size = await prepareCdpScreencastViewport(context.sendDebuggerCommand, options.tabId)
  } catch (error) {
    return { success: false, error: `Could not prepare the page for recording: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (starting.cancelled) return cancelledResult()
  let encoder: VideoEncoder
  try {
    encoder = await (context.startVideoEncoder ?? startFfmpegVideoEncoder)({
      outputPath: options.outputPath,
      artifactType,
      frameRate,
      width: size.width,
      height: size.height,
    })
  } catch (error) {
    return { success: false, error: `Could not start CDP video encoder: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (starting.cancelled) {
    await encoder.cancel()
    return cancelledResult()
  }
  const startedAt = context.now()
  const startedMonotonicAt = context.monotonicNow()
  const recording: CdpRecording = {
    tabId: options.tabId,
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    outputPath: options.outputPath,
    mode: "cdp",
    artifactType,
    startedAt,
    frameRate,
    encoder,
    frameCount: 0,
    sourceFrameCount: 0,
    encodedSourceFrameCount: 0,
    coalescedFrameCount: 0,
    droppedFrameCount: 0,
    pendingFrameCount: 0,
    width: size.width,
    height: size.height,
    stopped: false,
    stopping: false,
    startedMonotonicAt,
    writePromise: Promise.resolve(),
    fallbackFrameCount: 0,
  }
  context.activeRecordings.set(options.tabId, recording)
  try {
    await context.sendDebuggerCommand({
      tabId: recording.tabId,
      method: "Page.startScreencast",
      params: {
        format: "jpeg",
        quality: cdpJpegQuality,
        everyNthFrame: 1,
      },
    })
  } catch (error) {
    await cleanupCdpRecording(context, recording)
    return { success: false, error: `Could not start CDP screencast: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (starting.cancelled || context.activeRecordings.get(recording.tabId) !== recording) {
    await cleanupCdpRecording(context, recording)
    return { success: false, error: "Recording was cancelled while starting" }
  }
  recording.stopFallback = startScreenshotFallback({
    sendDebuggerCommand: context.sendDebuggerCommand,
    tabId: recording.tabId,
    frameRate,
    quality: cdpJpegQuality,
    hasScreencastFrames: () => recording.screencastFrameSeen === true,
    active: () => context.activeRecordings.get(recording.tabId) === recording && !recording.stopped && !recording.stopping,
    onFrame: (params) => {
      recording.fallbackFrameCount += 1
      context.onFallbackFrame(recording.tabId, params)
    },
  })
  context.armMaxDuration(recording, options.maxDurationMs)
  return {
    success: true,
    tabId: options.tabId,
    startedAt,
    path: options.outputPath,
    mimeType: artifactType === "mp4" ? "video/mp4" : "video/webm",
    mode: "cdp",
    artifactType,
    frameRate,
  }
}

export async function stopCdpRecording(context: CdpCaptureContext, recording: CdpRecording): Promise<RecordingStopResult> {
  if (recording.stopPromise) return recording.stopPromise
  recording.stopping = true
  recording.stopFallback?.()
  if (recording.maxDurationTimer) clearTimeout(recording.maxDurationTimer)
  const stopPromise = finishCdpRecording(context, recording).finally(() => {
    if (context.activeRecordings.get(recording.tabId) === recording) {
      context.activeRecordings.delete(recording.tabId)
      context.recordingChanged(recording.tabId)
    }
    recording.stopped = true
  })
  recording.stopPromise = stopPromise
  return stopPromise
}

export async function cancelCdpRecording(context: CdpCaptureContext, recording: CdpRecording): Promise<void> {
  if (recording.stopPromise) {
    await recording.stopPromise.catch(() => {})
    return
  }
  await cleanupCdpRecording(context, recording)
}

async function finishCdpRecording(context: CdpCaptureContext, recording: CdpRecording): Promise<RecordingStopResult> {
  const stoppedAt = context.now()
  const stoppedMonotonicAt = context.monotonicNow()
  try {
    await context.sendDebuggerCommand({ tabId: recording.tabId, method: "Page.stopScreencast", params: {} }).catch(() => {})
    await recording.writePromise
    if (recording.writeError) throw recording.writeError
    if (!recording.lastFrame) {
      const screenshot = await context.sendDebuggerCommand({
        tabId: recording.tabId,
        method: "Page.captureScreenshot",
        params: { format: "jpeg", quality: cdpJpegQuality, fromSurface: true, captureBeyondViewport: false },
      })
      const screenshotData = getString(screenshot, "data")
      if (screenshotData === undefined) throw new Error("No video frames were captured")
      recording.lastFrame = { buffer: Buffer.from(screenshotData, "base64"), frameNumber: 0 }
    }
    const durationMs = Math.max(0, stoppedMonotonicAt - recording.startedMonotonicAt)
    const expectedFrameCount = Math.max(1, Math.round((durationMs / 1_000) * recording.frameRate))
    const endFrameNumber = Math.max(recording.lastFrame.frameNumber + 1, expectedFrameCount)
    await writeSourceFrame(recording, recording.lastFrame, endFrameNumber)
    recording.frameCount = endFrameNumber
    await recording.encoder.finish()

    const stat = await fs.stat(recording.outputPath)
    const quality = recordingQuality(recording, durationMs)
    const metadata = {
      mode: "cdp",
      artifactType: recording.artifactType,
      tabId: recording.tabId,
      ...(recording.sessionId ? { sessionId: recording.sessionId } : {}),
      startedAt: new Date(recording.startedAt).toISOString(),
      stoppedAt: new Date(stoppedAt).toISOString(),
      durationMs,
      frameCount: recording.frameCount,
      ...quality,
      mimeType: recording.artifactType === "mp4" ? "video/mp4" : "video/webm",
    }
    await fs.writeFile(`${recording.outputPath}.json`, `${JSON.stringify(metadata, null, 2)}\n`, "utf8")
    return {
      success: true,
      tabId: recording.tabId,
      duration: durationMs,
      path: recording.outputPath,
      size: stat.size,
      mode: "cdp",
      artifactType: recording.artifactType,
      frameCount: recording.frameCount,
      quality,
    }
  } catch (error) {
    await recording.encoder.cancel().catch(() => {})
    return { success: false, error: `CDP video encoding failed: ${error instanceof Error ? error.message : String(error)}` }
  }
}

export function cleanupCdpRecording(context: CdpCaptureContext, recording: CdpRecording): Promise<void> {
  if (recording.cleanupPromise) return recording.cleanupPromise
  recording.stopped = true
  recording.stopFallback?.()
  if (recording.maxDurationTimer) clearTimeout(recording.maxDurationTimer)
  recording.cleanupPromise = (async () => {
    await Promise.all([
      context.sendDebuggerCommand({ tabId: recording.tabId, method: "Page.stopScreencast", params: {} }).catch(() => {}),
      recording.encoder.cancel().catch(() => {}),
    ])
    await recording.writePromise.catch(() => {})
    if (context.activeRecordings.get(recording.tabId) === recording) {
      context.activeRecordings.delete(recording.tabId)
      context.recordingChanged(recording.tabId)
    }
  })()
  return recording.cleanupPromise
}

async function writeSourceFrame(recording: CdpRecording, frame: CdpVideoFrame, endFrameNumber: number): Promise<void> {
  const timestampMs = Math.round((frame.frameNumber * 1_000) / recording.frameRate)
  const durationMs = Math.max(1, Math.round(((endFrameNumber - frame.frameNumber) * 1_000) / recording.frameRate))
  await recording.encoder.write(frame.buffer, timestampMs, durationMs, frame.surfaceWidth)
  recording.encodedSourceFrameCount += 1
}
