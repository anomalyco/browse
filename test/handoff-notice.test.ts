import { beforeEach, describe, expect, test } from "bun:test"
import type { PageStatus } from "../src/agent-relay/protocol"
import { installChrome } from "./chrome-stub"

const stub = installChrome()
const { HandoffNotice } = await import("../src/background/handoff-notice")

const name = () => "An agent"
const tab = await (async () => {
  const window = await stub.chrome.windows.create({ url: "https://bank.example/login" })
  return window.tabs[0]!.id
})()
let handoff = 0
const waiting = (recording: boolean): PageStatus => ({
  state: "waiting",
  owner: "session",
  sessionId: "github",
  handoffId: `handoff-${++handoff}`,
  message: "Sign in",
  ...(recording ? { recording: true } : {}),
})

beforeEach(async () => {
  await HandoffNotice.clear(tab)
  stub.state.permissionLevel = "granted"
  stub.state.notificationsFail = false
  stub.state.notifications.clear()
})

describe("HandoffNotice", () => {
  test("a recorded tab gets a notification and no card", async () => {
    const page = waiting(true)
    await HandoffNotice.sync(tab, page, name)
    expect(stub.state.notifications.size).toBe(1)
    expect(HandoffNotice.forPage(tab, page)).toEqual({ state: "attached", owner: "session", sessionId: "github", recording: true })
  })

  test("a tab that isn't recorded gets the card and no notification", async () => {
    const page = waiting(false)
    await HandoffNotice.sync(tab, page, name)
    expect(stub.state.notifications.size).toBe(0)
    expect(HandoffNotice.forPage(tab, page)).toEqual(page)
  })

  test("with notifications turned off, a recorded tab shows the card after all", async () => {
    stub.state.permissionLevel = "denied"
    const page = waiting(true)
    await HandoffNotice.sync(tab, page, name)
    expect(stub.state.notifications.size).toBe(0)
    const shown = HandoffNotice.forPage(tab, page)
    expect(shown.state).toBe("waiting")
    expect(shown.handoffId).toBe(page.handoffId)
    // The page script hides the card only while `recording` is set.
    expect(shown.recording).toBeUndefined()
  })

  test("when the notification can't be created, the card shows", async () => {
    stub.state.notificationsFail = true
    const page = waiting(true)
    await HandoffNotice.sync(tab, page, name)
    expect(HandoffNotice.forPage(tab, page).state).toBe("waiting")
  })

  test("the fallback ends with the handoff", async () => {
    stub.state.permissionLevel = "denied"
    await HandoffNotice.sync(tab, waiting(true), name)
    await HandoffNotice.sync(tab, { state: "attached", owner: "session", recording: true }, name)
    stub.state.permissionLevel = "granted"
    const next = waiting(true)
    await HandoffNotice.sync(tab, next, name)
    expect(HandoffNotice.forPage(tab, next).state).toBe("attached")
    expect(stub.state.notifications.size).toBe(1)
  })
})
