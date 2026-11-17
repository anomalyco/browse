import { afterAll, beforeEach, describe, expect, setSystemTime, test } from "bun:test"
import { installChrome, settle, type StubEvent } from "./chrome-stub"

// The debugging bar's cancel notice: one create for the burst of detaches its button causes, saying how to lend a tab
// again, and a click that just dismisses it.

const stub = installChrome()
const { DebuggingBarNotice } = await import("../src/background/debugging-bar-notice")

const ID = "opencode-browser-debugging-bar"
const notice = () => stub.state.notifications.get(ID) as { title: string; message: string } | undefined

beforeEach(() => {
  // Each test starts past the notice the one before it showed, without waiting out the burst window.
  setSystemTime(Date.now() + 60_000)
  stub.state.permissionLevel = "granted"
  stub.state.notificationsFail = false
  stub.state.notifications.clear()
  stub.state.notificationCreates = 0
})

afterAll(() => setSystemTime())

describe("DebuggingBarNotice", () => {
  test("a burst creates one notification, and a cancel after the window creates another", async () => {
    const now = Date.now()
    await Promise.all([DebuggingBarNotice.canceled(), DebuggingBarNotice.canceled(), DebuggingBarNotice.canceled()])
    expect(stub.state.notificationCreates).toBe(1)
    expect(stub.state.notifications.size).toBe(1)
    expect(notice()?.title).toBe("browse stopped using your tabs")
    expect(notice()?.message).toBe(
      "The debugging bar's button disconnects browse from every tab. Click the browse button on a tab to lend it again.",
    )
    // The rest of the same click is one notice, not one per tab.
    await DebuggingBarNotice.canceled()
    expect(stub.state.notificationCreates).toBe(1)
    // Once the window has passed, a new cancel says it again.
    setSystemTime(now + 6_000)
    await DebuggingBarNotice.canceled()
    expect(stub.state.notificationCreates).toBe(2)
  })

  test("a clock that went backward doesn't silence the next cancel", async () => {
    const now = Date.now()
    await DebuggingBarNotice.canceled()
    expect(stub.state.notificationCreates).toBe(1)
    // Time moved back past the notice: that is not a burst still in progress.
    setSystemTime(now - 60_000)
    await DebuggingBarNotice.canceled()
    expect(stub.state.notificationCreates).toBe(2)
  })

  test("with notifications turned off, nothing is shown and nothing throws", async () => {
    stub.state.permissionLevel = "denied"
    await DebuggingBarNotice.canceled()
    expect(stub.state.notificationCreates).toBe(0)
  })

  test("a notification Chrome refuses is not an error", async () => {
    stub.state.notificationsFail = true
    await DebuggingBarNotice.canceled()
    expect(stub.state.notificationCreates).toBe(1)
    expect(stub.state.notifications.size).toBe(0)
  })

  test("a browser without notifications says nothing and doesn't throw", async () => {
    const notifications = stub.chrome.notifications
    ;(stub.chrome as unknown as { notifications?: unknown }).notifications = undefined
    try {
      await DebuggingBarNotice.canceled()
      expect(stub.state.notificationCreates).toBe(0)
    } finally {
      ;(stub.chrome as unknown as { notifications: unknown }).notifications = notifications
    }
  })

  test("clicking the notification dismisses it", async () => {
    await DebuggingBarNotice.canceled()
    expect(notice()).toBeDefined()
    ;(chrome.notifications.onClicked as unknown as StubEvent).emit(ID, false)
    await settle()
    expect(stub.state.notifications.size).toBe(0)
  })
})
