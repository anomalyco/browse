import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { FlightRecorderRelay } from "../src/recording-relay/flight-recorder.ts"
import { makePageStatus } from "../src/protocol.ts"
import { RecordingRelay, type SendDebuggerCommand } from "../src/recording-relay.ts"

// Recordings show only the page: no ghost cursor unless asked for, and the relay hears about a recording before
// capture starts so it can take the handoff card away first.

function flightRecorder(events: string[]) {
  const send: SendDebuggerCommand = async ({ method }) => {
    events.push(method)
    return method === "Page.getLayoutMetrics" ? { cssVisualViewport: { clientWidth: 800, clientHeight: 600 } } : {}
  }
  let recorder: FlightRecorderRelay
  recorder = new FlightRecorderRelay({
    sendDebuggerCommand: send,
    isExtensionConnected: () => true,
    onTabRecordingChanged: (tabId) => {
      events.push(`changed:${tabId}:${recorder.isActiveTab(tabId)}`)
    },
  })
  return recorder
}

describe("clean recordings", () => {
  test("an extension disconnect drains a pending frame before cancelling ffmpeg", async () => {
    const writing = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const events: string[] = []
    let time = 0
    const relay = new RecordingRelay({
      sendToExtension: async () => ({}), sendDebuggerCommand: async () => ({}), isExtensionConnected: () => true,
      monotonicNow: () => time,
      startVideoEncoder: async () => ({
        write: async () => { writing.resolve(); await release.promise; events.push("wrote") },
        cancel: async () => { events.push("cancelled") }, finish: async () => {},
      }),
    })
    expect((await relay.startRecording({ tabId: 1, owner: "relay", mode: "cdp", outputPath: path.join(os.tmpdir(), "unused.webm") })).success).toBe(true)
    for (time of [0, 100]) relay.handleDebuggerEvent({ tabId: 1, method: "Page.screencastFrame", params: { data: "AA==", sessionId: 1 } })
    await writing.promise
    const cleanup = relay.abortRecordingForTab({ tabId: 1, reason: "Browser disconnected" })
    release.resolve()
    await cleanup
    expect(events).toEqual(["wrote", "cancelled"])
    expect(relay.hasActiveRecordings()).toBe(false)
  })

  test.skipIf(process.platform === "win32")("a broken ffmpeg input rejects the write without crashing the relay process", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "browse-ffmpeg-"))
    try {
      // Read the Matroska header and part of a frame, then close while the rest of the frame is still buffered.
      await fs.writeFile(path.join(dir, "ffmpeg"), '#!/bin/sh\n[ "$1" = -version ] && exit 0\ndd bs=1 count=1024 of=/dev/null 2>/dev/null\nexit 42\n', { mode: 0o755 })
      const build = await Bun.build({ entrypoints: [path.join(import.meta.dir, "../src/recording-relay/ffmpeg-encoder.ts")], outdir: dir, target: "node", naming: "encoder.mjs" })
      expect(build.success).toBe(true)
      const child = spawnSync("node", ["--input-type=module", "-e", `
        import { startFfmpegVideoEncoder } from './encoder.mjs'
        const encoder = await startFfmpegVideoEncoder({ artifactType: 'webm', outputPath: 'out.webm', width: 40, height: 40, frameRate: 30 })
        try { await encoder.write(Buffer.alloc(8 << 20), 0, 33) }
        catch (error) { console.log('write rejected: ' + error.message) }
        finally { await encoder.cancel() }
      `], { cwd: dir, encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, timeout: 10_000 })
      expect(child.status, child.stderr).toBe(0)
      expect(child.stdout).toMatch(/write rejected: /)
    } finally { await fs.rm(dir, { force: true, recursive: true }) }
  })

  test("the flight recorder shows no ghost cursor by default", async () => {
    const events: string[] = []
    const recorder = flightRecorder(events)
    await recorder.start({ tabId: 3 })
    expect(recorder.isActiveTab(3)).toBe(true)
    expect(recorder.showsGhostCursor(3)).toBe(false)
    await recorder.cancel({ tabId: 3 })
  })

  test("cursor: true shows it while the recorder runs", async () => {
    const recorder = flightRecorder([])
    await recorder.start({ tabId: 4, cursor: true })
    expect(recorder.showsGhostCursor(4)).toBe(true)
    await recorder.cancel({ tabId: 4 })
    expect(recorder.showsGhostCursor(4)).toBe(false)
  })

  test("the relay hears about the recording before capture starts, and after it ends", async () => {
    const events: string[] = []
    const recorder = flightRecorder(events)
    await recorder.start({ tabId: 5 })
    expect(events.indexOf("changed:5:true")).toBeGreaterThanOrEqual(0)
    expect(events.indexOf("changed:5:true")).toBeLessThan(events.indexOf("Page.startScreencast"))
    await recorder.cancel({ tabId: 5 })
    expect(events).toContain("changed:5:false")
  })

  test("page statuses carry the recording flag the extension hides the card for", () => {
    expect(makePageStatus({ state: "waiting", targetOwner: "relay", message: "Sign in", handoffId: "h1", recording: true })).toEqual({
      state: "waiting", owner: "session", message: "Sign in", handoffId: "h1", recording: true,
    })
    expect(makePageStatus({ state: "waiting", targetOwner: "relay", message: "Sign in", handoffId: "h1", recording: false })).not.toHaveProperty("recording")
  })
})
