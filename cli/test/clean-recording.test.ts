import { describe, expect, test } from "bun:test"
import { FlightRecorderRelay } from "../src/flight-recorder.ts"
import { makePageStatus } from "../src/protocol.ts"
import type { SendDebuggerCommand } from "../src/recording-relay.ts"

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
