import { beforeEach, describe, expect, test } from "bun:test"
import type { PageStatus } from "../src/agent-relay/protocol"
import { installChrome, settle, type StubEvent } from "./chrome-stub"

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
  await stub.chrome.storage.local.remove("handoffNotifications")
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

  test("set to every handoff, a tab that isn't recorded gets a notification and keeps its card", async () => {
    await stub.chrome.storage.local.set({ handoffNotifications: "always" })
    const page = waiting(false)
    await HandoffNotice.sync(tab, page, name)
    expect(stub.state.notifications.size).toBe(1)
    expect(HandoffNotice.forPage(tab, page)).toEqual(page)
    // The same handoff doesn't notify twice; its end clears the notification.
    await HandoffNotice.sync(tab, page, name)
    expect(stub.state.notifications.size).toBe(1)
    await HandoffNotice.sync(tab, { state: "attached", owner: "session" }, name)
    expect(stub.state.notifications.size).toBe(0)
  })

  test("set to every handoff, a recorded tab still gets a notification instead of its card", async () => {
    await stub.chrome.storage.local.set({ handoffNotifications: "always" })
    const page = waiting(true)
    await HandoffNotice.sync(tab, page, name)
    expect(stub.state.notifications.size).toBe(1)
    expect(HandoffNotice.forPage(tab, page).state).toBe("attached")
  })

  test("set to every handoff with notifications turned off, every page keeps its card", async () => {
    await stub.chrome.storage.local.set({ handoffNotifications: "always" })
    stub.state.permissionLevel = "denied"
    const plain = waiting(false)
    await HandoffNotice.sync(tab, plain, name)
    expect(stub.state.notifications.size).toBe(0)
    expect(HandoffNotice.forPage(tab, plain)).toEqual(plain)
    const recorded = waiting(true)
    await HandoffNotice.sync(tab, recorded, name)
    expect(HandoffNotice.forPage(tab, recorded).state).toBe("waiting")
  })

  test("an unknown setting reads as only while recording", async () => {
    await stub.chrome.storage.local.set({ handoffNotifications: "loud" })
    await HandoffNotice.sync(tab, waiting(false), name)
    expect(stub.state.notifications.size).toBe(0)
  })

  test("clicking the notification shows the tab and its window", async () => {
    await stub.chrome.storage.local.set({ handoffNotifications: "always" })
    await HandoffNotice.sync(tab, waiting(false), name)
    const [id] = [...stub.state.notifications.keys()]
    stub.state.activations.length = 0
    ;(chrome.notifications.onClicked as unknown as StubEvent).emit(id)
    for (let i = 0; i < 10 && stub.state.activations.length < 2; i++) await settle()
    expect(stub.state.activations).toEqual([{ tabId: tab }, { windowId: stub.state.tabs.get(tab)!.windowId }])
    expect(stub.state.notifications.size).toBe(0)
  })
})
