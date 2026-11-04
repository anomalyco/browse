import type { JsonObject } from "../../agent-relay/protocol"
import type { OffscreenStartRecordingResult } from "../../agent-relay/recording-types"
import { MAX_RECORDING_BUFFER, number, sleep, text } from "./wire"

export function createRelayRecording(deps: {
  readonly open: () => WebSocket | undefined
  readonly currentSocket: () => WebSocket | undefined
}) {
  let offscreen: Promise<void> | undefined

  const ensureOffscreen = async () => {
    const url = chrome.runtime.getURL("offscreen.html")
    const existing = await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
      documentUrls: [url],
    })
    if (existing.length) return
    offscreen ??= chrome.offscreen
      .createDocument({
        url: "offscreen.html",
        reasons: [chrome.offscreen.Reason.USER_MEDIA],
        justification: "Record tabs for agents with chrome.tabCapture and MediaRecorder",
      })
      .finally(() => {
        offscreen = undefined
      })
    await offscreen
  }

  const startRecording = async (params: JsonObject | undefined): Promise<JsonObject> => {
    const tabId = number(params, "tabId")
    await ensureOffscreen()
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }).catch((error: unknown) => {
      const message = text(error)
      throw new Error(
        /invoked|activeTab/i.test(message)
          ? `${message.replace(/\.+$/, "")}. Click the Browse toolbar icon on this tab once before recording.`
          : message,
      )
    })
    const result = (await chrome.runtime.sendMessage({
      action: "recording.start",
      tabId,
      streamId,
      frameRate: typeof params?.frameRate === "number" ? params.frameRate : 30,
      videoBitsPerSecond: typeof params?.videoBitsPerSecond === "number" ? params.videoBitsPerSecond : 2_500_000,
      audioBitsPerSecond: typeof params?.audioBitsPerSecond === "number" ? params.audioBitsPerSecond : 128_000,
      audio: params?.audio === true,
    })) as OffscreenStartRecordingResult
    if (!result.success) return { success: false, error: result.error }
    return { success: true, tabId: result.tabId, startedAt: result.startedAt, mimeType: result.mimeType }
  }

  const recordingCall = async <Result>(action: string, tabId: number) =>
    (await chrome.runtime.sendMessage({ action, tabId })) as Result

  const sendRecordingChunk = async (data: Uint8Array) => {
    const current = deps.open()
    if (!current) throw new Error("The Browse relay is not connected")
    const deadline = Date.now() + 30_000
    while (current.bufferedAmount + data.byteLength > MAX_RECORDING_BUFFER) {
      await sleep(10)
      if (deps.currentSocket() !== current || current.readyState !== WebSocket.OPEN)
        throw new Error("The Browse relay disconnected while receiving recording data")
      if (Date.now() >= deadline) throw new Error("Timed out sending recording data to the Browse relay")
    }
    current.send(new Uint8Array(data))
  }

  return { startRecording, recordingCall, sendRecordingChunk }
}
