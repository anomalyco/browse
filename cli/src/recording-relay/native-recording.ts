import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import type { CdpCaptureContext } from "./cdp-capture.ts"
import type { NativeRecording, RecordingStartOptions, RecordingStopResult, StartingRecording } from "./types.ts"

export async function tryStartNativeRecording(
  context: CdpCaptureContext,
  options: RecordingStartOptions,
  size: { readonly width: number; readonly height: number },
  frameRate: number,
  starting: StartingRecording,
): Promise<NativeRecording | undefined> {
  const { tabId } = options
  const connection = context.connectionForTab(tabId)
  if (!connection) return undefined
  const known = context.nativeSupport.get(connection)
  if (known && !(await known)) return undefined
  if (starting.cancelled) return undefined
  const send: NativeRecording["send"] = async (method, params = {}) => {
    if (context.connectionForTab(tabId) !== connection) throw new Error("Recording browser disconnected")
    return context.sendDebuggerCommand({ tabId, method, params })
  }
  // The first real start is also the probe. Concurrent starts share only its capability result, never its stream.
  const params = { maxWidth: size.width, maxHeight: size.height, frameRate }
  const start = send("Page.startScreenRecording", params)
  if (!known) context.nativeSupport.set(connection, start.then(() => true, error =>
    !/-32601|method not found|wasn't found|not supported without AV1\/libaom/i.test(String(error))))
  const result = await start.catch(() => undefined)
  if (!result) return undefined
  if (typeof result.stream !== "string" || !result.stream) {
    // A broken implementation acknowledged start but didn't return a handle. Release it before trying screencast.
    const stopped = await send("Page.stopScreenRecording").catch(() => undefined)
    if (typeof stopped?.stream === "string") await send("IO.close", { handle: stopped.stream }).catch(() => {})
    return undefined
  }
  return {
    tabId, ...(options.sessionId ? { sessionId: options.sessionId } : {}), outputPath: options.outputPath,
    mode: "cdp", artifactType: "mp4", stream: result.stream, send, ...params,
    startedAt: context.now(), startedMonotonicAt: context.monotonicNow(),
  }
}

export async function discardNativeRecording(recording: NativeRecording): Promise<void> {
  try {
    await recording.send("Page.stopScreenRecording")
  } catch {
    // The tab may already have detached.
  } finally {
    await recording.send("IO.close", { handle: recording.stream }).catch(() => {})
  }
}

export async function finishNativeRecording(context: CdpCaptureContext, recording: NativeRecording): Promise<RecordingStopResult> {
  const stoppedAt = context.now()
  const duration = Math.max(0, context.monotonicNow() - recording.startedMonotonicAt)
  const { outputPath, tabId, mode, artifactType } = recording
  const temporaryPath = `${outputPath}.partial-${randomUUID()}`
  const handle = recording.stream
  try {
    const stopped = await recording.send("Page.stopScreenRecording")
    if (stopped.stream !== handle) throw new Error("Unexpected screen recording stream at stop")
    const file = await fs.open(temporaryPath, "wx", 0o600)
    let size = 0
    try {
      for (;;) {
        const { data, base64Encoded, eof } = await recording.send("IO.read", { handle, size: 256 * 1024 })
        if (typeof data !== "string" || typeof eof !== "boolean" || (data ? base64Encoded !== true : !eof)) {
          throw new Error("Invalid screen recording stream chunk")
        }
        const chunk = Buffer.from(data, "base64")
        await file.writeFile(chunk)
        size += chunk.length
        if (eof) break
      }
      if (!size) throw new Error("Screen recording stream was empty")
    } finally {
      await file.close()
    }
    await fs.rename(temporaryPath, outputPath)
    // Chrome reports neither actual frame counts nor encoded dimensions. Bounds are not necessarily the file size.
    const metadata = {
      mode, artifactType, tabId, sessionId: recording.sessionId, backend: "Page.startScreenRecording", mimeType: "video/mp4",
      startedAt: new Date(recording.startedAt).toISOString(), stoppedAt: new Date(stoppedAt).toISOString(), durationMs: duration,
      frameRate: recording.frameRate, maxWidth: recording.maxWidth, maxHeight: recording.maxHeight,
    }
    await fs.writeFile(`${outputPath}.json`, `${JSON.stringify(metadata, null, 2)}\n`, "utf8")
    return { success: true, mode, artifactType, tabId, path: outputPath, size, duration }
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => {})
    return { success: false, error: `Could not finish native screen recording: ${error instanceof Error ? error.message : String(error)}` }
  } finally {
    await recording.send("IO.close", { handle }).catch(() => {})
  }
}
