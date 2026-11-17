import { beforeEach, describe, expect, test } from "bun:test"
import { installChrome, settle, type StubEvent } from "./chrome-stub"

// The debugging bar's cancel notice: one notification for the burst of detaches its button causes, saying how to lend
// a tab again, and a click that just dismisses it.

const stub = installChrome()
const { DebuggingBarNotice } = await import("../src/background/debugging-bar-notice")

const ID = "opencode-browser-debugging-bar"
const notice = () => stub.state.notifications.get(ID) as { title: string; message: string } | undefined

beforeEach(() => {
  stub.state.permissionLevel = "granted"
  stub.state.notificationsFail = false
  stub.state.notifications.clear()
})

describe("DebuggingBarNotice", () => {
  test("a burst of cancels leaves one notification that says what happened", async () => {
    await Promise.all([DebuggingBarNotice.canceled(), DebuggingBarNotice.canceled(), DebuggingBarNotice.canceled()])
    expect(stub.state.notifications.size).toBe(1)
    expect(notice()?.title).toBe("browse stopped using your tabs")
    expect(notice()?.message).toContain("disconnects browse from every tab")
    expect(notice()?.message).toContain("click the browse button on it")
  })

  test("with notifications turned off, nothing is shown and nothing throws", async () => {
    stub.state.permissionLevel = "denied"
    await DebuggingBarNotice.canceled()
    expect(stub.state.notifications.size).toBe(0)
  })

  test("a notification Chrome refuses is not an error", async () => {
    stub.state.notificationsFail = true
    await DebuggingBarNotice.canceled()
    expect(stub.state.notifications.size).toBe(0)
  })

  test("clicking the notification dismisses it", async () => {
    await DebuggingBarNotice.canceled()
    expect(notice()).toBeDefined()
    ;(chrome.notifications.onClicked as unknown as StubEvent).emit(ID, false)
    await settle()
    expect(stub.state.notifications.size).toBe(0)
  })
})
