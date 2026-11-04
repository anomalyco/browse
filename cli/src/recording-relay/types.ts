import type fs from "node:fs/promises"
import path from "node:path"
import { Option, Predicate, Schema } from "effect"
import type { JsonObject } from "../protocol.ts"
import type { RecordingCancelResponse, RecordingQuality, RecordingStatusResponse, RecordingTargetRequest } from "../relay/schema.ts"
import type { ConnectedTarget } from "../relay/types.ts"

export const defaultMaxDurationMs = 15 * 60 * 1_000
export const defaultCdpFrameRate = 60
export const maxRecordingFrameRate = 60
export const maxPendingCdpFrames = 30
export const fallbackCdpWidth = 1_280
export const fallbackCdpHeight = 720
export const cdpJpegQuality = 100
export const maxPendingTabCaptureBytes = 16 * 1024 * 1024
export const maxTabCaptureOutputBytes = 1024 * 1024 * 1024

export type RecordingMode = "auto" | "tab-capture" | "cdp"
export type ActiveRecordingMode = "tab-capture" | "cdp"
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
  readonly owner: ConnectedTarget["owner"]
  readonly outputPath: string
  readonly mode?: RecordingMode
  readonly frameRate?: number
  readonly audio?: boolean
  readonly videoBitsPerSecond?: number
  readonly audioBitsPerSecond?: number
  readonly maxDurationMs?: number
  /** Draw the ghost cursor in the recorded page (demo videos). Off by default: recordings show only the page. */
  readonly cursor?: boolean
}

export type RecordingTargetOptions = RecordingTargetRequest

export type RecordingStartResult =
  | {
    readonly success: true
    readonly tabId: number
    readonly startedAt: number
    readonly path: string
    readonly mimeType: string
    readonly mode: ActiveRecordingMode
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
    readonly mode: ActiveRecordingMode
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

export type ActiveRecordingBase = {
  tabId: number
  sessionId?: string
  outputPath: string
  startedAt: number
  mode: ActiveRecordingMode
  artifactType: RecordingArtifactType
  maxDurationTimer?: ReturnType<typeof setTimeout>
  resolveStop?: (result: RecordingStopResult) => void
  cleanupPromise?: Promise<void>
}

export type TabCaptureRecording = ActiveRecordingBase & {
  mode: "tab-capture"
  artifactType: "webm"
  temporaryPath: string
  file: Awaited<ReturnType<typeof fs.open>>
  expectedSequence: number
  receivedBytes: number
  pendingWriteBytes: number
  writePromise: Promise<void>
  writeError?: Error
  stopping: boolean
  finalized: boolean
  stopPromise?: Promise<RecordingStopResult>
  finalizePromise?: Promise<void>
}

export type CdpRecording = ActiveRecordingBase & {
  mode: "cdp"
  artifactType: "webm" | "mp4"
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

export type ActiveRecording = TabCaptureRecording | CdpRecording

export type StartingRecording = {
  readonly tabId: number
  readonly sessionId?: string
  cancelled: boolean
  promise?: Promise<RecordingStartResult>
}

export type ExtensionStartResult =
  | {
    readonly success: true
    readonly tabId: number
    readonly startedAt: number
    readonly mimeType?: string
  }
  | {
    readonly success: false
    readonly error: string
  }

export type ExtensionStopResult =
  | {
    readonly success: true
    readonly tabId: number
    readonly duration: number
  }
  | {
    readonly success: false
    readonly error: string
  }

export type ExtensionStatusResult = {
  readonly isRecording: boolean
  readonly tabId?: number
  readonly startedAt?: number
}

export function selectRecordingMode(options: RecordingStartOptions): ActiveRecordingMode {
  if (options.mode === "cdp") {
    return "cdp"
  }
  if (options.mode === "tab-capture") {
    return "tab-capture"
  }
  return options.owner === "relay" ? "cdp" : "tab-capture"
}

export function recordingStartParams(options: RecordingStartOptions): JsonObject {
  return {
    tabId: options.tabId,
    ...(options.frameRate === undefined ? {} : { frameRate: options.frameRate }),
    ...(options.audio === undefined ? {} : { audio: options.audio }),
    ...(options.videoBitsPerSecond === undefined ? {} : { videoBitsPerSecond: options.videoBitsPerSecond }),
    ...(options.audioBitsPerSecond === undefined ? {} : { audioBitsPerSecond: options.audioBitsPerSecond }),
  }
}

const ExtensionStartResultSchema = Schema.Union([
  Schema.Struct({
    success: Schema.Literal(true),
    tabId: Schema.Number,
    startedAt: Schema.Number,
    mimeType: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    success: Schema.Literal(false),
    error: Schema.String,
  }),
])
const decodeExtensionStartResult = Schema.decodeUnknownOption(ExtensionStartResultSchema)

const ExtensionStopResultSchema = Schema.Union([
  Schema.Struct({
    success: Schema.Literal(true),
    tabId: Schema.Number,
    duration: Schema.Number,
  }),
  Schema.Struct({
    success: Schema.Literal(false),
    error: Schema.String,
  }),
])
const decodeExtensionStopResult = Schema.decodeUnknownOption(ExtensionStopResultSchema)

export function parseExtensionStartResult(value: JsonObject): ExtensionStartResult {
  return Option.getOrElse(decodeExtensionStartResult(value), () => ({
    success: false,
    error: "Invalid recording.start response from extension",
  }))
}

export function parseExtensionStopResult(value: JsonObject): ExtensionStopResult {
  return Option.getOrElse(decodeExtensionStopResult(value), () => ({
    success: false,
    error: "Invalid recording.stop response from extension",
  }))
}

export function parseExtensionStatusResult(value: JsonObject): ExtensionStatusResult {
  return {
    isRecording: value.isRecording === true,
    ...(Predicate.isNumber(value.tabId) ? { tabId: value.tabId } : {}),
    ...(Predicate.isNumber(value.startedAt) ? { startedAt: value.startedAt } : {}),
  }
}

export function parseCancelResult(value: JsonObject): RecordingCancelResult {
  return {
    success: value.success === true,
    ...(Predicate.isString(value.error) ? { error: value.error } : {}),
  }
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
