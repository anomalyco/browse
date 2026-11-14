import { performance } from "node:perf_hooks"
import type { JsonObject } from "./protocol.ts"
import {
  cancelCdpRecording,
  handleCdpScreencastFrame,
  startCdpRecording,
  stopCdpRecording,
  type CdpCaptureContext,
} from "./recording-relay/cdp-capture.ts"
import {
  defaultMaxDurationMs,
  findByRecordingTarget,
  maxRecordingFrameRate,
  recordingQuality,
  type ActiveRecording,
  type RecordingCancelResult,
  type RecordingStartOptions,
  type RecordingStartResult,
  type RecordingStatusResult,
  type RecordingStopResult,
  type RecordingTargetOptions,
  type SendDebuggerCommand,
  type StartingRecording,
  type StartVideoEncoder,
} from "./recording-relay/types.ts"

export {
  prepareCdpScreencastViewport,
  startFfmpegVideoEncoder,
  startScreenshotFallback,
} from "./recording-relay/ffmpeg-encoder.ts"
export {
  AmbiguousRecordingTargetError,
  cdpArtifactType,
  findByRecordingTarget,
  type RecordingCancelResult,
  type RecordingStartOptions,
  type RecordingStartResult,
  type RecordingStatusResult,
  type RecordingStopResult,
  type RecordingTargetOptions,
  type SendDebuggerCommand,
  type StartVideoEncoder,
  type VideoEncoder,
} from "./recording-relay/types.ts"

/** CDP screencast recordings: video frames from the attached tab, encoded with ffmpeg. */
export class RecordingRelay {
  private readonly activeRecordings = new Map<number, ActiveRecording>()
  private readonly startingRecordings = new Map<number, StartingRecording>()
  private readonly cdpContext: CdpCaptureContext

  constructor(readonly options: {
    readonly sendDebuggerCommand: SendDebuggerCommand
    readonly isExtensionConnected: () => boolean
    /**
     * A tab started or stopped being recorded. Awaited before capture starts, so in-page UI the recording must not
     * show (the handoff card) is gone by the first frame.
     */
    readonly onTabRecordingChanged?: (tabId: number) => void | Promise<void>
    readonly startVideoEncoder?: StartVideoEncoder
    readonly now?: () => number
    readonly monotonicNow?: () => number
  }) {
    this.cdpContext = {
      activeRecordings: this.activeRecordings,
      sendDebuggerCommand: options.sendDebuggerCommand,
      ...(options.startVideoEncoder ? { startVideoEncoder: options.startVideoEncoder } : {}),
      now: () => this.now(),
      monotonicNow: () => this.monotonicNow(),
      recordingChanged: (tabId) => this.recordingChanged(tabId),
      armMaxDuration: (recording, maxDurationMs) => this.armMaxDuration(recording, maxDurationMs),
      onFallbackFrame: (tabId, params) => {
        this.handleDebuggerEvent({ tabId, method: "Page.screencastFrame", params })
      },
    }
  }

  hasActiveRecordings(): boolean {
    return this.activeRecordings.size > 0 || this.startingRecordings.size > 0
  }

  /** Tabs being recorded (or starting to be). */
  recordingTabIds(): number[] {
    return Array.from(new Set([...this.activeRecordings.keys(), ...this.startingRecordings.keys()]))
  }

  isRecordingTab(tabId: number): boolean {
    return this.activeRecordings.has(tabId) || this.startingRecordings.has(tabId)
  }

  private recordingChanged(tabId: number): void {
    void Promise.resolve(this.options.onTabRecordingChanged?.(tabId)).catch(() => {})
  }

  async startRecording(options: RecordingStartOptions): Promise<RecordingStartResult> {
    if (options.frameRate !== undefined && (!Number.isInteger(options.frameRate) || options.frameRate < 1 || options.frameRate > maxRecordingFrameRate)) {
      return { success: false, error: "Recording frameRate must be an integer from 1 to 60" }
    }
    if (!this.options.isExtensionConnected()) {
      return { success: false, error: "browse extension is not connected" }
    }
    if (this.activeRecordings.has(options.tabId) || this.startingRecordings.has(options.tabId)) {
      return { success: false, error: "Recording already in progress for this tab" }
    }
    const starting: StartingRecording = {
      tabId: options.tabId,
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      cancelled: false,
    }
    this.startingRecordings.set(options.tabId, starting)
    await Promise.resolve(this.options.onTabRecordingChanged?.(options.tabId)).catch(() => {})
    const promise = startCdpRecording(this.cdpContext, options, starting)
    starting.promise = promise
    try {
      return await promise
    } finally {
      if (this.startingRecordings.get(options.tabId) === starting) {
        this.startingRecordings.delete(options.tabId)
      }
      if (!this.isRecordingTab(options.tabId)) this.recordingChanged(options.tabId)
    }
  }

  async stopRecording(options: RecordingTargetOptions): Promise<RecordingStopResult> {
    if (!this.options.isExtensionConnected()) {
      return { success: false, error: "browse extension is not connected" }
    }
    const recording = this.findRecording(options)
    if (!recording) {
      return { success: false, error: "No active recording found" }
    }
    if (recording.stopPromise) return recording.stopPromise
    if (recording.cleanupPromise) {
      await recording.cleanupPromise
      return { success: false, error: "Recording was cancelled" }
    }
    return stopCdpRecording(this.cdpContext, recording)
  }

  async statusRecording(options: RecordingTargetOptions): Promise<RecordingStatusResult> {
    const recording = this.findRecording(options)
    if (!recording || !this.options.isExtensionConnected()) {
      return { isRecording: false }
    }
    return {
      isRecording: true,
      tabId: recording.tabId,
      startedAt: recording.startedAt,
      path: recording.outputPath,
      artifactType: recording.artifactType,
      quality: recordingQuality(recording, this.monotonicNow() - recording.startedMonotonicAt),
      frameCount: recording.stopping
        ? recording.frameCount
        : Math.max(0, Math.round(((this.monotonicNow() - recording.startedMonotonicAt) / 1_000) * recording.frameRate)),
    }
  }

  async cancelRecording(options: RecordingTargetOptions): Promise<RecordingCancelResult> {
    const starting = this.findStartingRecording(options)
    if (starting) {
      starting.cancelled = true
      await starting.promise?.catch(() => {})
      return { success: true }
    }
    const recording = this.findRecording(options)
    if (!recording) {
      return { success: true }
    }
    if (recording.cleanupPromise) {
      await recording.cleanupPromise
      return { success: true }
    }
    await cancelCdpRecording(this.cdpContext, recording)
    return { success: true }
  }

  async cleanupAll(): Promise<void> {
    const starting = Array.from(this.startingRecordings.values())
    const startingTabIds = new Set(starting.map((recording) => recording.tabId))
    const active = Array.from(this.activeRecordings.values()).filter((recording) => {
      return !startingTabIds.has(recording.tabId)
    })
    for (const recording of starting) recording.cancelled = true
    await Promise.all(starting.map(async (recording) => {
      await recording.promise?.catch(() => {})
    }))
    await Promise.all(active.map(async (recording) => {
      await this.abortActiveRecording(recording)
    }))
  }

  async abortRecordingForTab(tabId: number): Promise<void> {
    const starting = this.startingRecordings.get(tabId)
    if (starting) {
      starting.cancelled = true
      await starting.promise?.catch(() => {})
      return
    }
    const recording = this.activeRecordings.get(tabId)
    if (!recording) {
      return
    }
    await this.abortActiveRecording(recording)
  }

  private async abortActiveRecording(recording: ActiveRecording): Promise<void> {
    if (recording.stopPromise) {
      await recording.stopPromise.catch(() => {})
      return
    }
    await cancelCdpRecording(this.cdpContext, recording)
  }

  handleDebuggerEvent(options: { readonly tabId: number; readonly method: string; readonly params: JsonObject | undefined }): boolean {
    if (options.method !== "Page.screencastFrame") {
      return false
    }
    const recording = this.activeRecordings.get(options.tabId)
    if (!recording) {
      return false
    }
    return handleCdpScreencastFrame(this.cdpContext, recording, options)
  }

  private findRecording(options: RecordingTargetOptions): ActiveRecording | undefined {
    return findByRecordingTarget(this.activeRecordings, options, "Multiple active recordings; provide sessionId or tabId")
  }

  private findStartingRecording(options: RecordingTargetOptions): StartingRecording | undefined {
    return findByRecordingTarget(this.startingRecordings, options, "Multiple recordings are starting; provide sessionId or tabId")
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  private armMaxDuration(recording: ActiveRecording, requestedMaxDurationMs: number | undefined): void {
    const maxDurationMs = requestedMaxDurationMs ?? defaultMaxDurationMs
    if (maxDurationMs <= 0 || !Number.isFinite(maxDurationMs)) return
    recording.maxDurationTimer = setTimeout(() => {
      void this.stopRecording({ tabId: recording.tabId }).catch((error) => {
        console.error("Recording max duration stop failed", error)
      })
    }, maxDurationMs)
  }

  private monotonicNow(): number {
    return this.options.monotonicNow?.() ?? this.options.now?.() ?? performance.now()
  }
}
