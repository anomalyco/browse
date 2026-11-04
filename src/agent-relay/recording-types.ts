// Messages between the background and the recording offscreen document.
export type ChromeTabCaptureAudioConstraints = {
  readonly mandatory: {
    readonly chromeMediaSource: "tab"
    readonly chromeMediaSourceId: string
  }
}

export type ChromeTabCaptureVideoConstraints = {
  readonly mandatory: {
    readonly chromeMediaSource: "tab"
    readonly chromeMediaSourceId: string
    readonly minFrameRate?: number
    readonly maxFrameRate?: number
  }
}

export type OffscreenStartRecordingMessage = {
  readonly action: "recording.start"
  readonly tabId: number
  readonly streamId: string
  readonly frameRate: number
  readonly videoBitsPerSecond: number
  readonly audioBitsPerSecond: number
  readonly audio: boolean
}

export type OffscreenStopRecordingMessage = {
  readonly action: "recording.stop"
  readonly tabId: number
}

export type OffscreenStatusRecordingMessage = {
  readonly action: "recording.status"
  readonly tabId: number
}

type OffscreenCancelRecordingMessage = {
  readonly action: "recording.cancel"
  readonly tabId: number
}

type OffscreenCancelAllRecordingsMessage = {
  readonly action: "recording.cancelAll"
}

export type OffscreenMessage =
  | OffscreenStartRecordingMessage
  | OffscreenStopRecordingMessage
  | OffscreenStatusRecordingMessage
  | OffscreenCancelRecordingMessage
  | OffscreenCancelAllRecordingsMessage

type OffscreenOutcome<T extends Record<string, unknown> = Record<never, never>> =
  | ({ readonly success: true } & T)
  | { readonly success: false; readonly error: string }

export type OffscreenStartRecordingResult = OffscreenOutcome<{
  readonly tabId: number
  readonly startedAt: number
  readonly mimeType: string
}>

export type OffscreenStopRecordingResult = OffscreenOutcome<{
  readonly tabId: number
  readonly duration: number
}>

export type OffscreenStatusRecordingResult = {
  readonly isRecording: boolean
  readonly tabId?: number
  readonly startedAt?: number
}

export type OffscreenCancelRecordingResult = OffscreenOutcome<{
  readonly tabId: number
}>

export type OffscreenCancelAllRecordingsResult = OffscreenOutcome

export type OffscreenResult =
  | OffscreenStartRecordingResult
  | OffscreenStopRecordingResult
  | OffscreenStatusRecordingResult
  | OffscreenCancelRecordingResult
  | OffscreenCancelAllRecordingsResult

type OffscreenRecordingChunkMessage =
  | {
    readonly action: "recording.chunk"
    readonly tabId: number
    readonly sequence: number
    readonly final: false
    readonly dataBase64: string
  }
  | {
    readonly action: "recording.chunk"
    readonly tabId: number
    readonly sequence: number
    readonly final: true
  }

type OffscreenRecordingCancelledMessage = {
  readonly action: "recording.cancelled"
  readonly tabId: number
}

export type OffscreenOutgoingMessage = OffscreenRecordingChunkMessage | OffscreenRecordingCancelledMessage
