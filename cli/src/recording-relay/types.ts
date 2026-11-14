import path from "node:path"
import type { JsonObject } from "../protocol.ts"
import type { RecordingCancelResponse, RecordingQuality, RecordingStatusResponse, RecordingTargetRequest } from "../relay/schema.ts"

export const defaultMaxDurationMs = 15 * 60 * 1_000
export const defaultCdpFrameRate = 60
export const maxRecordingFrameRate = 60
export const maxPendingCdpFrames = 30
export const fallbackCdpWidth = 1_280
export const fallbackCdpHeight = 720
export const cdpJpegQuality = 100

export type RecordingArtifactType = "webm" | "mp4"

export type SendDebuggerCommand = (options: {
  readonly tabId: number
  readonly sessionId?: string
  readonly method: string
  readonly params: JsonObject
}) => Promise<JsonObject>

export type RecordingStartOptions = {
  readonly tabId: number
  readonly sessionId?: string
  readonly outputPath: string
  readonly frameRate?: number
  readonly maxDurationMs?: number
}

export type RecordingTargetOptions = RecordingTargetRequest

export type RecordingStartResult =
  | {
    readonly success: true
    readonly tabId: number
    readonly startedAt: number
    readonly path: string
    readonly mimeType: string
    readonly artifactType: RecordingArtifactType
    readonly frameRate?: number
  }
  | {
    readonly success: false
    readonly error: string
  }

export type RecordingStopResult =
  | {
    readonly success: true
    readonly tabId: number
    readonly duration: number
    readonly path: string
    readonly size: number
    readonly artifactType: RecordingArtifactType
    readonly frameCount?: number
    readonly quality?: RecordingQuality
  }
  | {
    readonly success: false
    readonly error: string
  }

export type RecordingStatusResult = RecordingStatusResponse

export type RecordingCancelResult = RecordingCancelResponse

export type CdpRecording = {
  tabId: number
  sessionId?: string
  outputPath: string
  startedAt: number
  artifactType: RecordingArtifactType
  maxDurationTimer?: ReturnType<typeof setTimeout>
  cleanupPromise?: Promise<void>
  frameRate: number
  encoder: VideoEncoder
  lastFrame?: CdpVideoFrame
  frameCount: number
  sourceFrameCount: number
  encodedSourceFrameCount: number
  coalescedFrameCount: number
  droppedFrameCount: number
  pendingFrameCount: number
  width: number
  height: number
  sourceWidth?: number
  sourceHeight?: number
  stopped: boolean
  stopping: boolean
  startedMonotonicAt: number
  stopPromise?: Promise<RecordingStopResult>
  writePromise: Promise<void>
  writeError?: Error
  /** A real Page.screencastFrame arrived (it carries a sessionId to acknowledge); screenshots stop then. */
  screencastFrameSeen?: boolean
  /** Frames taken with Page.captureScreenshot because the screencast sent none. */
  fallbackFrameCount: number
  stopFallback?: () => void
}

export type ActiveRecording = CdpRecording

export type CdpVideoFrame = {
  readonly buffer: Buffer
  readonly frameNumber: number
  readonly surfaceWidth?: number
}

export type VideoEncoder = {
  readonly write: (frame: Buffer, timestampMs: number, durationMs: number, surfaceWidth?: number) => Promise<void>
  readonly finish: () => Promise<void>
  readonly cancel: () => Promise<void>
}

export type StartVideoEncoder = (options: {
  readonly outputPath: string
  readonly artifactType: "webm" | "mp4"
  readonly frameRate: number
  readonly width: number
  readonly height: number
}) => Promise<VideoEncoder>

export type StartingRecording = {
  readonly tabId: number
  readonly sessionId?: string
  cancelled: boolean
  promise?: Promise<RecordingStartResult>
}

export class AmbiguousRecordingTargetError extends Error {
  constructor(message: string, readonly tabIds: readonly number[]) {
    super(message)
  }
}

export function findByRecordingTarget<T extends { readonly sessionId?: string }>(
  map: ReadonlyMap<number, T>,
  target: RecordingTargetOptions,
  ambiguousMessage: string,
): T | undefined {
  if (target.tabId !== undefined) return map.get(target.tabId)
  if (target.sessionId) return [...map.values()].find((entry) => entry.sessionId === target.sessionId)
  if (map.size > 1) throw new AmbiguousRecordingTargetError(ambiguousMessage, [...map.keys()])
  return map.values().next().value
}

export function cdpArtifactType(outputPath: string): "webm" | "mp4" | undefined {
  const extension = path.extname(outputPath).toLowerCase()
  if (extension === ".webm") return "webm"
  if (extension === ".mp4") return "mp4"
  return undefined
}

export function recordingQuality(recording: CdpRecording, durationMs: number): RecordingQuality {
  const seconds = Math.max(0.001, durationMs / 1_000)
  return {
    width: recording.width,
    height: recording.height,
    frameRate: recording.frameRate,
    sourceFrameCount: recording.sourceFrameCount,
    encodedSourceFrameCount: recording.encodedSourceFrameCount,
    coalescedFrameCount: recording.coalescedFrameCount,
    droppedFrameCount: recording.droppedFrameCount,
    achievedSourceFrameRate: recording.sourceFrameCount / seconds,
    achievedEncodedSourceFrameRate: recording.encodedSourceFrameCount / seconds,
    screenshotFallback: recording.fallbackFrameCount > 0 || (recording.sourceFrameCount === 0 && recording.encodedSourceFrameCount > 0),
    ...(recording.sourceWidth === undefined ? {} : { sourceWidth: recording.sourceWidth }),
    ...(recording.sourceHeight === undefined ? {} : { sourceHeight: recording.sourceHeight }),
  }
}
