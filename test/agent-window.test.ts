import { beforeEach, describe, expect, test } from "bun:test"
import { installChrome, settle } from "./chrome-stub"

const stub = installChrome()
const { AgentWindow } = await import("../src/background/agent-window")

/** The user's window, focused, at the given bounds. */
async function userWindow(bounds: { left: number; top: number; width: number; height: number }) {
  const window = await stub.chrome.windows.create({ ...bounds, focused: true })
  stub.state.created.length = 0
  return window
}

beforeEach(async () => {
  stub.state.windows.clear()
  stub.state.tabs.clear()
  stub.state.created.length = 0
  stub.state.activations.length = 0
  stub.state.focusedWindowId = undefined
  stub.state.displays = [{ left: 0, top: 0, width: 1512, height: 982 }]
  await stub.chrome.storage.session.remove("agentWindowId")
  await stub.chrome.storage.local.remove("agentTabsWindow")
})

describe("AgentWindow.open", () => {
  test("by default opens a background tab in the window the user last focused", async () => {
    const user = await userWindow({ left: 0, top: 30, width: 1512, height: 950 })
    const userTab = [...stub.state.tabs.values()].find((tab) => tab.windowId === user.id)!
    const tab = await AgentWindow.open("https://example.com/")
    expect(tab.windowId).toBe(user.id)
    expect(tab.active).toBe(false)
    expect(stub.state.created).toHaveLength(0)
    expect(stub.state.tabs.get(userTab.id)!.active).toBe(true)
    expect(stub.state.focusedWindowId).toBe(user.id)
    expect(stub.state.activations).toEqual([])
  })

  test("with only a popup window focused, opens in an unfocused new window, never a focused one", async () => {
    await stub.chrome.windows.create({ type: "popup", focused: true })
    stub.state.created.length = 0
    const tab = await AgentWindow.open("https://example.com/")
    expect(stub.state.created).toEqual([expect.objectContaining({ focused: false, type: "normal" })])
    expect(stub.state.windows.get(tab.windowId)?.focused).toBe(false)
  })

  test("with no window at all, makes one unfocused", async () => {
    const tab = await AgentWindow.open("https://example.com/")
    expect(stub.state.created).toEqual([expect.objectContaining({ focused: false, type: "normal" })])
    expect(stub.state.windows.get(tab.windowId)?.focused).toBe(false)
    expect(await AgentWindow.id()).toBeUndefined()
  })

  test("the separate setting opens tabs in the agent window", async () => {
    await stub.chrome.storage.local.set({ agentTabsWindow: "separate" })
    const user = await userWindow({ left: 0, top: 30, width: 600, height: 600 })
    const tab = await AgentWindow.open("https://example.com/")
    expect(tab.windowId).not.toBe(user.id)
    expect(tab.windowId).toBe((await AgentWindow.id())!)
    expect(stub.state.created).toEqual([expect.objectContaining({ focused: false })])
    expect(stub.state.focusedWindowId).toBe(user.id)
    expect(stub.state.activations).toEqual([])
  })

  test("an override from the relay wins over the setting, and switching affects new tabs only", async () => {
    const user = await userWindow({ left: 0, top: 30, width: 600, height: 600 })
    const separate = await AgentWindow.open("https://example.com/1", { override: "separate" })
    expect(separate.windowId).not.toBe(user.id)
    await stub.chrome.storage.local.set({ agentTabsWindow: "separate" })
    const current = await AgentWindow.open("https://example.com/2", { override: "current" })
    expect(current.windowId).toBe(user.id)
    await stub.chrome.storage.local.set({ agentTabsWindow: "current" })
    expect((await AgentWindow.open("https://example.com/3")).windowId).toBe(user.id)
    // The tab already in the agent window stays there.
    expect(stub.state.tabs.get(separate.id!)!.windowId).toBe(separate.windowId)
  })

  test("an unknown stored value means the default", async () => {
    await stub.chrome.storage.local.set({ agentTabsWindow: "elsewhere" })
    expect(await AgentWindow.placement()).toBe("current")
  })
})

describe("AgentWindow.openTab", () => {
  test("makes one unfocused window beside the user's, then opens background tabs in it", async () => {
    // A second display to the right of the laptop screen.
    stub.state.displays.push({ left: 1512, top: 0, width: 2560, height: 1440 })
    const user = await userWindow({ left: 0, top: 30, width: 1512, height: 950 })

    const first = await AgentWindow.openTab("https://example.com/")
    expect(stub.state.created).toHaveLength(1)
    expect(stub.state.created[0]).toMatchObject({ focused: false, state: "normal", left: 1512, top: 30, width: 1280, height: 900 })
    expect(first.windowId).not.toBe(user.id)
    expect(stub.state.focusedWindowId).toBe(user.id)

    const second = await AgentWindow.openTab("https://example.org/")
    expect(stub.state.created).toHaveLength(1)
    expect(second.windowId).toBe(first.windowId)
    expect(second.active).toBe(false)
    expect(await AgentWindow.id()).toBe(first.windowId)
  })

  test("concurrent calls share one new window", async () => {
    await userWindow({ left: 0, top: 30, width: 600, height: 600 })
    const tabs = await Promise.all([1, 2, 3].map((n) => AgentWindow.openTab(`https://example.com/${n}`)))
    expect(stub.state.created).toHaveLength(1)
    expect(new Set(tabs.map((tab) => tab.windowId)).size).toBe(1)
  })

  test("makes the window again after the user closes it", async () => {
    await userWindow({ left: 0, top: 30, width: 600, height: 600 })
    const first = await AgentWindow.openTab("https://example.com/")
    await stub.chrome.windows.remove(first.windowId)
    await settle()
    expect(await AgentWindow.id()).toBeUndefined()
    const again = await AgentWindow.openTab("https://example.com/")
    expect(again.windowId).not.toBe(first.windowId)
    expect(stub.state.created).toHaveLength(2)
  })

  test("a stored id of a window that's gone (another browser session) isn't reused", async () => {
    await stub.chrome.storage.session.set({ agentWindowId: 9999 })
    await userWindow({ left: 0, top: 30, width: 600, height: 600 })
    await AgentWindow.openTab("https://example.com/")
    expect(stub.state.created).toHaveLength(1)
  })

  test("tries the left when there's no room on the right", async () => {
    stub.state.displays = [{ left: 0, top: 0, width: 2560, height: 1440 }]
    await userWindow({ left: 1500, top: 100, width: 1060, height: 1000 })
    await AgentWindow.openTab("https://example.com/")
    // Right: entirely off the screen, refused by Chrome; left fits.
    expect(stub.state.created.map(({ left, top }) => ({ left, top }))).toEqual([
      { left: 2560, top: 100 },
      { left: 220, top: 100 },
    ])
  })

  test("lets Chrome place it when no side has room (one screen the user's window fills)", async () => {
    await userWindow({ left: 0, top: 30, width: 1512, height: 950 })
    const tab = await AgentWindow.openTab("https://example.com/")
    expect(stub.state.created).toHaveLength(5)
    expect(stub.state.created.at(-1)).toMatchObject({ focused: false, width: 1280, height: 900 })
    expect(stub.state.created.at(-1)?.left).toBeUndefined()
    expect(stub.state.windows.get(tab.windowId)?.focused).toBe(false)
  })

  test("without a focused window, opens with its size only", async () => {
    await AgentWindow.openTab("https://example.com/")
    expect(stub.state.created).toEqual([expect.objectContaining({ focused: false, width: 1280, height: 900 })])
    expect(stub.state.created[0]?.left).toBeUndefined()
  })
})

describe("AgentWindow.placements", () => {
  test("right, left, below, above the user's window", () => {
    expect(AgentWindow.placements({ left: 100, top: 50, width: 800, height: 600 }, { width: 400, height: 300 })).toEqual([
      { left: 900, top: 50, width: 400, height: 300 },
      { left: -300, top: 50, width: 400, height: 300 },
      { left: 100, top: 650, width: 400, height: 300 },
      { left: 100, top: -250, width: 400, height: 300 },
    ])
    expect(AgentWindow.placements({ left: 0 })).toEqual([])
  })
})
