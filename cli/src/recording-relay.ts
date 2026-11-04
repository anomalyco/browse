import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { performance } from "node:perf_hooks"
import type { ExtensionCommand, JsonObject } from "./protocol.ts"
import { decodeRecordingFrame } from "./recording-protocol.ts"
import {
  cancelCdpRecording,
  handleCdpScreencastFrame,
  startCdpRecording,
  stopCdpRecording,
  type CdpCaptureContext,
} from "./recording-relay/cdp-capture.ts"
import {
  AmbiguousRecordingTargetError,
  cdpArtifactType,
  defaultMaxDurationMs,
  findByRecordingTarget,
  maxPendingTabCaptureBytes,
  maxRecordingFrameRate,
  maxTabCaptureOutputBytes,
  parseCancelResult,
  parseExtensionStartResult,
  parseExtensionStatusResult,
  parseExtensionStopResult,
  recordingQuality,
  recordingStartParams,
  selectRecordingMode,
  type ActiveRecording,
  type ExtensionStartResult,
  type ExtensionStatusResult,
  type RecordingCancelResult,
  type RecordingStartOptions,
  type RecordingStartResult,
  type RecordingStatusResult,
  type RecordingStopResult,
  type RecordingTargetOptions,
  type SendDebuggerCommand,
  type StartingRecording,
  type StartVideoEncoder,
  type TabCaptureRecording,
} from "./recording-relay/types.ts"
import { getNumber, getObject } from "./relay-helpers.ts"

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

export class RecordingRelay {
  private readonly activeRecordings = new Map<number, ActiveRecording>()
  private readonly startingRecordings = new Map<number, StartingRecording>()
  /** Tabs whose recording asked for the ghost cursor. */
  private readonly cursorTabs = new Set<number>()
  private readonly cdpContext: CdpCaptureContext

  constructor(readonly options: {
    readonly sendToExtension: (command: Omit<ExtensionCommand, "id">) => Promise<JsonObject>
    readonly sendDebuggerCommand: SendDebuggerCommand
    readonly isExtensionConnected: () => boolean
    readonly isTabUnavailable?: (tabId: number) => boolean
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

  /** Whether the tab's recording asked for the ghost cursor (recording_start cursor: true). */
  showsGhostCursor(tabId: number): boolean {
    return this.cursorTabs.has(tabId) && this.isRecordingTab(tabId)
  }

  private recordingChanged(tabId: number): void {
    if (!this.isRecordingTab(tabId)) this.cursorTabs.delete(tabId)
    void Promise.resolve(this.options.onTabRecordingChanged?.(tabId)).catch(() => {})
  }

  async startRecording(options: RecordingStartOptions): Promise<RecordingStartResult> {
    if (options.frameRate !== undefined && (!Number.isInteger(options.frameRate) || options.frameRate < 1 || options.frameRate > maxRecordingFrameRate)) {
      return { success: false, error: "Recording frameRate must be an integer from 1 to 60" }
    }
    if (!this.options.isExtensionConnected()) {
      return { success: false, error: "Browse extension is not connected" }
    }
    if (this.activeRecordings.has(options.tabId) || this.startingRecordings.has(options.tabId)) {
      return { success: false, error: "Recording already in progress for this tab" }
    }
    if (this.options.isTabUnavailable?.(options.tabId)) {
      return { success: false, error: "Stop the active flight recorder before starting a recording" }
    }
    const starting: StartingRecording = {
      tabId: options.tabId,
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      cancelled: false,
    }
    this.startingRecordings.set(options.tabId, starting)
    if (options.cursor === true) this.cursorTabs.add(options.tabId)
    else this.cursorTabs.delete(options.tabId)
    await Promise.resolve(this.options.onTabRecordingChanged?.(options.tabId)).catch(() => {})
    const promise = this.startReservedRecording(options, starting)
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
      return { success: false, error: "Browse extension is not connected" }
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
    if (recording.mode === "cdp") {
      return stopCdpRecording(this.cdpContext, recording)
    }
    const stopPromise = this.stopTabCaptureRecording(recording)
    recording.stopPromise = stopPromise
    return stopPromise
  }

  private async stopTabCaptureRecording(recording: TabCaptureRecording): Promise<RecordingStopResult> {
    let stopTimeout: ReturnType<typeof setTimeout> | undefined
    const finalResult = new Promise<RecordingStopResult>((resolve) => {
      stopTimeout = setTimeout(() => {
        delete recording.resolveStop
        if (this.activeRecordings.get(recording.tabId) === recording && !recording.cleanupPromise && !recording.finalizePromise) {
          const cancel = this.options.isExtensionConnected()
            ? this.options.sendToExtension({ method: "recording.cancel", params: { tabId: recording.tabId } })
            : undefined
          void this.cleanupTabCaptureRecording(recording, cancel)
        }
        resolve({ success: false, error: "Timeout waiting for recording data" })
      }, 30_000)
      recording.resolveStop = (result) => {
        if (stopTimeout) clearTimeout(stopTimeout)
        resolve(result)
      }
    })

    try {
      const result = parseExtensionStopResult(await this.options.sendToExtension({
        method: "recording.stop",
        params: { tabId: recording.tabId },
      }))
      if (!result.success) {
        if (stopTimeout) clearTimeout(stopTimeout)
        delete recording.resolveStop
        await this.failTabCaptureRecording(recording, result.error)
        return result
      }
      return await finalResult
    } catch (error) {
      if (stopTimeout) clearTimeout(stopTimeout)
      delete recording.resolveStop
      const message = error instanceof Error ? error.message : String(error)
      await this.failTabCaptureRecording(recording, message)
      return { success: false, error: message }
    }
  }

  async statusRecording(options: RecordingTargetOptions): Promise<RecordingStatusResult> {
    const recording = this.findRecording(options)
    if (!recording || !this.options.isExtensionConnected()) {
      return { isRecording: false }
    }
    if (recording.mode === "cdp") {
      return {
        isRecording: true,
        tabId: recording.tabId,
        startedAt: recording.startedAt,
        path: recording.outputPath,
        mode: "cdp",
        artifactType: recording.artifactType,
        quality: recordingQuality(recording, this.monotonicNow() - recording.startedMonotonicAt),
        frameCount: recording.stopping
          ? recording.frameCount
          : Math.max(0, Math.round(((this.monotonicNow() - recording.startedMonotonicAt) / 1_000) * recording.frameRate)),
      }
    }
    let result: ExtensionStatusResult | undefined
    try {
      result = parseExtensionStatusResult(await this.options.sendToExtension({
        method: "recording.status",
        params: { tabId: recording.tabId },
      }))
    } catch {
      // A transient status poll failure must not destroy an in-progress
      // recording; report last-known local state instead.
    }
    return {
      isRecording: result?.isRecording ?? true,
      tabId: recording.tabId,
      startedAt: result?.startedAt ?? recording.startedAt,
      path: recording.outputPath,
      size: recording.receivedBytes,
      mode: "tab-capture",
      artifactType: "webm",
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
    if (recording.mode === "cdp") {
      await cancelCdpRecording(this.cdpContext, recording)
      return { success: true }
    }
    if (recording.finalizePromise) {
      await recording.finalizePromise
      return { success: true }
    }
    if (!this.options.isExtensionConnected()) {
      recording.resolveStop?.({ success: false, error: "Recording was cancelled" })
      await this.cleanupRecording(recording.tabId)
      return { success: false, error: "Browse extension is not connected" }
    }
    const result = this.options.sendToExtension({ method: "recording.cancel", params: { tabId: recording.tabId } }).then(
      parseCancelResult,
      (error: unknown) => ({ success: false, error: error instanceof Error ? error.message : String(error) }),
    ).then((result) => {
      recording.resolveStop?.({ success: false, error: "Recording was cancelled" })
      return result
    })
    await this.cleanupTabCaptureRecording(recording, result)
    return result
  }

  async cleanupAll(reason: string): Promise<void> {
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
      await this.abortActiveRecording(recording, reason)
    }))
  }

  async abortRecordingForTab(options: { readonly tabId: number; readonly reason: string }): Promise<void> {
    const starting = this.startingRecordings.get(options.tabId)
    if (starting) {
      starting.cancelled = true
      await starting.promise?.catch(() => {})
      return
    }
    const recording = this.activeRecordings.get(options.tabId)
    if (!recording) {
      return
    }
    await this.abortActiveRecording(recording, options.reason)
  }

  private async abortActiveRecording(recording: ActiveRecording, reason: string): Promise<void> {
    if (recording.mode === "tab-capture" && recording.finalizePromise) {
      await recording.finalizePromise
      return
    }
    recording.resolveStop?.({ success: false, error: reason })
    if (recording.mode === "cdp") {
      await cancelCdpRecording(this.cdpContext, recording)
      return
    }
    await this.cleanupTabCaptureRecording(recording)
  }

  handleRecordingCancelled(message: JsonObject): void {
    const params = getObject(message.params)
    const tabId = getNumber(params, "tabId")
    const recording = tabId === undefined ? undefined : this.activeRecordings.get(tabId)
    if (!recording) {
      return
    }
    void this.abortActiveRecording(recording, "Recording was cancelled")
  }

  handleDebuggerEvent(options: { readonly tabId: number; readonly method: string; readonly params: JsonObject | undefined }): boolean {
    if (options.method !== "Page.screencastFrame") {
      return false
    }
    const recording = this.activeRecordings.get(options.tabId)
    if (!recording || recording.mode !== "cdp") {
      return false
    }
    return handleCdpScreencastFrame(this.cdpContext, recording, options)
  }

  handleBinaryData(data: Buffer): void {
    const frame = decodeRecordingFrame(data)
    const recording = this.activeRecordings.get(frame.tabId)
    if (!recording || recording.mode !== "tab-capture") {
      return
    }
    if (recording.stopping || recording.finalized) return
    if (recording.writeError) {
      void this.failTabCaptureRecording(recording, recording.writeError.message)
      return
    }
    if (frame.sequence !== recording.expectedSequence) {
      void this.failTabCaptureRecording(recording, `Recording frame sequence ${frame.sequence} did not match expected ${recording.expectedSequence}`)
      return
    }
    recording.expectedSequence += 1
    if (frame.final) {
      recording.stopping = true
      if (recording.maxDurationTimer) clearTimeout(recording.maxDurationTimer)
      recording.finalizePromise = this.finishTabCaptureRecording(recording)
      void recording.finalizePromise
      return
    }
    if (recording.receivedBytes + frame.payload.byteLength > maxTabCaptureOutputBytes) {
      void this.failTabCaptureRecording(recording, `Tab capture exceeds ${maxTabCaptureOutputBytes} bytes`)
      return
    }
    if (recording.pendingWriteBytes + frame.payload.byteLength > maxPendingTabCaptureBytes) {
      void this.failTabCaptureRecording(recording, `Tab capture pending writes exceed ${maxPendingTabCaptureBytes} bytes`)
      return
    }
    const payload = frame.payload
    recording.receivedBytes += payload.byteLength
    recording.pendingWriteBytes += payload.byteLength
    recording.writePromise = recording.writePromise.then(async () => {
      const result = await recording.file.write(payload)
      if (result.bytesWritten !== payload.byteLength) throw new Error(`Short recording write: ${result.bytesWritten}/${payload.byteLength}`)
    }).catch((error: unknown) => {
      recording.writeError ??= error instanceof Error ? error : new Error(String(error))
      void this.failTabCaptureRecording(recording, recording.writeError.message)
    }).finally(() => {
      recording.pendingWriteBytes -= payload.byteLength
    })
  }

  private async finishTabCaptureRecording(recording: TabCaptureRecording): Promise<void> {
    try {
      await recording.writePromise
      if (recording.writeError) throw recording.writeError
      if (recording.receivedBytes === 0) throw new Error("No tab capture data was received")
      await recording.file.sync()
      await recording.file.close()
      await fs.rename(recording.temporaryPath, recording.outputPath)
      recording.finalized = true
      recording.resolveStop?.({
        success: true,
        tabId: recording.tabId,
        duration: Date.now() - recording.startedAt,
        path: recording.outputPath,
        size: recording.receivedBytes,
        mode: "tab-capture",
        artifactType: "webm",
      })
    } catch (error) {
      recording.resolveStop?.({ success: false, error: error instanceof Error ? error.message : String(error) })
    } finally {
      await this.cleanupTabCaptureRecording(recording)
    }
  }

  private findRecording(options: RecordingTargetOptions): ActiveRecording | undefined {
    return findByRecordingTarget(this.activeRecordings, options, "Multiple active recordings; provide sessionId or tabId")
  }

  private findStartingRecording(options: RecordingTargetOptions): StartingRecording | undefined {
    return findByRecordingTarget(this.startingRecordings, options, "Multiple recordings are starting; provide sessionId or tabId")
  }

  private async cleanupRecording(tabId: number): Promise<void> {
    const recording = this.activeRecordings.get(tabId)
    if (!recording) return
    if (recording.mode === "cdp") {
      await cancelCdpRecording(this.cdpContext, recording)
      return
    }
    if (recording.finalizePromise) return recording.finalizePromise
    return this.cleanupTabCaptureRecording(recording)
  }

  private cleanupTabCaptureRecording(recording: TabCaptureRecording, cancel?: Promise<unknown>): Promise<void> {
    if (recording.cleanupPromise) return recording.cleanupPromise
    recording.stopping = true
    if (recording.maxDurationTimer) clearTimeout(recording.maxDurationTimer)
    recording.cleanupPromise = (async () => {
      await cancel?.catch(() => {})
      await recording.writePromise.catch(() => {})
      await recording.file.close().catch(() => {})
      if (!recording.finalized) await fs.rm(recording.temporaryPath, { force: true }).catch(() => {})
      if (this.activeRecordings.get(recording.tabId) === recording) {
        this.activeRecordings.delete(recording.tabId)
        this.recordingChanged(recording.tabId)
      }
    })()
    return recording.cleanupPromise
  }

  private async failTabCaptureRecording(recording: TabCaptureRecording, message: string): Promise<void> {
    if (recording.stopping || recording.finalized) return
    recording.stopping = true
    recording.resolveStop?.({ success: false, error: message })
    const cancel = this.options.isExtensionConnected()
      ? this.options.sendToExtension({ method: "recording.cancel", params: { tabId: recording.tabId } })
      : undefined
    await this.cleanupTabCaptureRecording(recording, cancel)
  }

  private async startReservedRecording(options: RecordingStartOptions, starting: StartingRecording): Promise<RecordingStartResult> {
    const mode = selectRecordingMode(options)
    if (mode === "cdp") {
      return startCdpRecording(this.cdpContext, options, starting)
    }
    if (cdpArtifactType(options.outputPath) !== "webm") {
      return { success: false, error: "tabCapture recording output path must end in .webm; use --mode cdp for MP4" }
    }

    await fs.mkdir(path.dirname(options.outputPath), { recursive: true })
    if (starting.cancelled) return { success: false, error: "Recording was cancelled while starting" }
    const temporaryPath = `${options.outputPath}.partial-${process.pid}-${crypto.randomUUID()}`
    const file = await fs.open(temporaryPath, "wx", 0o600)
    const recording: TabCaptureRecording = {
      tabId: options.tabId,
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      outputPath: options.outputPath,
      temporaryPath,
      file,
      mode: "tab-capture",
      artifactType: "webm",
      expectedSequence: 0,
      receivedBytes: 0,
      pendingWriteBytes: 0,
      writePromise: Promise.resolve(),
      stopping: false,
      finalized: false,
      startedAt: this.now(),
    }
    this.activeRecordings.set(options.tabId, recording)
    let result: ExtensionStartResult
    try {
      result = parseExtensionStartResult(await this.options.sendToExtension({
        method: "recording.start",
        params: recordingStartParams(options),
      }))
    } catch (error) {
      await this.cleanupRecording(options.tabId)
      throw error
    }
    if (!result.success || starting.cancelled || result.tabId !== options.tabId || this.activeRecordings.get(options.tabId) !== recording) {
      if (result.success) await this.options.sendToExtension({ method: "recording.cancel", params: { tabId: result.tabId } }).catch(() => {})
      await this.cleanupRecording(options.tabId)
      if (!result.success) return result
      return {
        success: false,
        error: starting.cancelled
          ? "Recording was cancelled while starting"
          : result.tabId !== options.tabId
            ? `Extension started recording tab ${result.tabId} instead of ${options.tabId}`
            : recording.writeError?.message ?? "Recording ended while starting",
      }
    }
    recording.startedAt = result.startedAt
    this.armMaxDuration(recording, options.maxDurationMs)
    return {
      success: true,
      tabId: result.tabId,
      startedAt: result.startedAt,
      frameRate: options.frameRate ?? 30,
      path: options.outputPath,
      mimeType: result.mimeType ?? "video/webm",
      mode: "tab-capture",
      artifactType: "webm",
    }
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
