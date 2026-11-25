import { beforeEach, describe, expect, test } from "bun:test"
import { installChrome, settle } from "./chrome-stub"

const stub = installChrome()
const { AgentWindow } = await import("../src/background/agent-relay/window")
const { TabCleanup } = await import("../src/background/tab-cleanup")

/** Agent tabs opened in a test, forgotten before the next one. */
const tracked: number[] = []

/** The user's window, focused, at the given bounds. */
async function userWindow(bounds: { left: number; top: number; width: number; height: number }) {
  const window = await stub.chrome.windows.create({ ...bounds, focused: true })
  stub.state.created.length = 0
  return window
}

beforeEach(async () => {
  for (const tabId of tracked.splice(0)) TabCleanup.forget(tabId)
  stub.state.windows.clear()
  stub.state.tabs.clear()
  stub.state.created.length = 0
  stub.state.activations.length = 0
  stub.state.focusedWindowId = undefined
  stub.state.lastFocusedWindowId = undefined
  stub.state.getAllHangs = false
  stub.state.displays = [{ left: 0, top: 0, width: 1512, height: 982 }]
  await stub.chrome.storage.session.remove("agentWindowId")
  await stub.chrome.storage.local.remove("agentTabsWindow")
})

describe("AgentWindow.open", () => {
  test("by default opens a background tab in the window the user last focused", async () => {
    const user = await userWindow({ left: 0, top: 30, width: 1512, height: 950 })
    const userTab = [...stub.state.tabs.values()].find((tab) => tab.windowId === user.id)!
    const { tab, created, rule, lastFocused } = await AgentWindow.open("https://example.com/")
    expect(tab.windowId).toBe(user.id)
    expect(tab.active).toBe(false)
    expect(created).toBe(false)
    expect(rule).toBe("last-focused")
    expect(lastFocused).toContain(`id=${user.id}`)
    expect(stub.state.created).toHaveLength(0)
    expect(stub.state.tabs.get(userTab.id)!.active).toBe(true)
    expect(stub.state.focusedWindowId).toBe(user.id)
    expect(stub.state.activations).toEqual([])
  })

  test("with only a popup window focused, opens in an unfocused new window, never a focused one", async () => {
    await stub.chrome.windows.create({ type: "popup", focused: true })
    stub.state.created.length = 0
    const { tab, created, rule } = await AgentWindow.open("https://example.com/")
    expect(stub.state.created).toEqual([expect.objectContaining({ focused: false, type: "normal" })])
    expect(stub.state.windows.get(tab.windowId)?.focused).toBe(false)
    expect(created).toBe(true)
    expect(rule).toBe("created")
  })

  test("with no window at all, makes one unfocused", async () => {
    const { tab, rule } = await AgentWindow.open("https://example.com/")
    expect(stub.state.created).toEqual([expect.objectContaining({ focused: false, type: "normal" })])
    expect(stub.state.windows.get(tab.windowId)?.focused).toBe(false)
    expect(rule).toBe("created")
    expect(await AgentWindow.id()).toBeUndefined()
  })

  test("the separate setting opens tabs in the agent window", async () => {
    await stub.chrome.storage.local.set({ agentTabsWindow: "separate" })
    const user = await userWindow({ left: 0, top: 30, width: 600, height: 600 })
    const { tab, rule } = await AgentWindow.open("https://example.com/")
    expect(tab.windowId).not.toBe(user.id)
    expect(tab.windowId).toBe((await AgentWindow.id())!)
    expect(stub.state.created).toEqual([expect.objectContaining({ focused: false })])
    expect(stub.state.focusedWindowId).toBe(user.id)
    expect(stub.state.activations).toEqual([])
    expect(rule).toBe("created")
  })

  test("an override from the relay wins over the setting, and switching affects new tabs only", async () => {
    const user = await userWindow({ left: 0, top: 30, width: 600, height: 600 })
    const separate = (await AgentWindow.open("https://example.com/1", { override: "separate" })).tab
    expect(separate.windowId).not.toBe(user.id)
    await stub.chrome.storage.local.set({ agentTabsWindow: "separate" })
    const current = (await AgentWindow.open("https://example.com/2", { override: "current" })).tab
    expect(current.windowId).toBe(user.id)
    await stub.chrome.storage.local.set({ agentTabsWindow: "current" })
    expect((await AgentWindow.open("https://example.com/3")).tab.windowId).toBe(user.id)
    // The tab already in the agent window stays there.
    expect(stub.state.tabs.get(separate.id!)!.windowId).toBe(separate.windowId)
  })

  test("a labelled tab follows its label's tabs into the window the user moved them to", async () => {
    const user = await userWindow({ left: 0, top: 30, width: 600, height: 600 })
    const first = (await AgentWindow.open("https://example.com/1")).tab
    tracked.push(first.id!)
    TabCleanup.track(first.id!)
    const task = await stub.chrome.windows.create({ focused: false })
    await stub.chrome.tabs.move(first.id!, { windowId: task.id, index: -1 })
    stub.state.created.length = 0
    const { tab, rule, created } = await AgentWindow.open("https://example.com/2", { follow: [first.id!] })
    expect(tab.windowId).toBe(task.id)
    expect(rule).toBe("followed")
    expect(created).toBe(false)
    expect(tab.active).toBe(false)
    expect(stub.state.focusedWindowId).toBe(user.id)
    expect(stub.state.activations).toEqual([])
    // Without the label, the agent-only window is still passed over.
    expect((await AgentWindow.open("https://example.com/3")).tab.windowId).toBe(user.id)
  })

  test("a label split across windows follows the tab the user used last; a minimized window is skipped", async () => {
    await userWindow({ left: 0, top: 30, width: 600, height: 600 })
    const a = await stub.chrome.windows.create({ url: "https://a.example/", focused: false })
    const b = await stub.chrome.windows.create({ url: "https://b.example/", focused: false })
    const tabIn = (id: number) => [...stub.state.tabs.values()].find((tab) => tab.windowId === id)!
    await stub.chrome.tabs.update(tabIn(a.id!).id, { lastAccessed: 100 })
    await stub.chrome.tabs.update(tabIn(b.id!).id, { lastAccessed: 200 })
    const follow = [tabIn(a.id!).id, tabIn(b.id!).id]
    const split = await AgentWindow.open("https://example.com/", { follow })
    expect(split.tab.windowId).toBe(b.id)
    // Both windows come back, the one it went to first, so the relay can tell the agent the label is split.
    expect(split.windows).toEqual([b.id!, a.id!])
    stub.state.windows.get(b.id!)!.state = "minimized"
    const visible = await AgentWindow.open("https://example.com/", { follow })
    expect(visible.tab.windowId).toBe(a.id)
    expect(visible.windows).toEqual([a.id!])
  })

  test("follows nothing when the label's tabs are gone, and falls back to the setting", async () => {
    const user = await userWindow({ left: 0, top: 30, width: 600, height: 600 })
    const { tab, rule } = await AgentWindow.open("https://example.com/", { follow: [9999] })
    expect(tab.windowId).toBe(user.id)
    expect(rule).toBe("last-focused")
  })

  test("follow wins over the separate setting: a task the user moved stays where they put it", async () => {
    await stub.chrome.storage.local.set({ agentTabsWindow: "separate" })
    const user = await userWindow({ left: 0, top: 30, width: 600, height: 600 })
    const first = (await AgentWindow.open("https://example.com/1")).tab
    expect(first.windowId).toBe((await AgentWindow.id())!)
    await stub.chrome.tabs.move(first.id!, { windowId: user.id, index: -1 })
    const { tab, rule } = await AgentWindow.open("https://example.com/2", { follow: [first.id!] })
    expect(tab.windowId).toBe(user.id)
    expect(rule).toBe("followed")
    expect(stub.state.activations).toEqual([])
  })

  test("beside opens in the named tab's window, over the label and the setting, without focusing it", async () => {
    const user = await userWindow({ left: 0, top: 30, width: 600, height: 600 })
    const other = await stub.chrome.windows.create({ url: "https://lent.example/", focused: false })
    const lent = [...stub.state.tabs.values()].find((tab) => tab.windowId === other.id)!
    const labelled = (await AgentWindow.open("https://example.com/1")).tab
    const { tab, rule } = await AgentWindow.open("https://example.com/2", {
      beside: lent.id,
      follow: [labelled.id!],
      override: "separate",
    })
    expect(tab.windowId).toBe(other.id)
    expect(rule).toBe("beside")
    expect(tab.active).toBe(false)
    expect(stub.state.focusedWindowId).toBe(user.id)
    await expect(AgentWindow.open("https://example.com/3", { beside: 9999 })).rejects.toThrow("gone")
  })

  test("windowsOf says which window each tab is in and leaves out tabs that are gone", async () => {
    const a = await stub.chrome.windows.create({ url: "https://a.example/", focused: false })
    const b = await stub.chrome.windows.create({ url: "https://b.example/", focused: false })
    const tabIn = (id: number) => [...stub.state.tabs.values()].find((tab) => tab.windowId === id)!.id
    expect(await AgentWindow.windowsOf([tabIn(a.id!), tabIn(b.id!), 9999])).toEqual({
      [tabIn(a.id!)]: a.id!,
      [tabIn(b.id!)]: b.id!,
    })
  })

  test("newWindow opens an unfocused window for the task without touching the setting or the agent window", async () => {
    const user = await userWindow({ left: 0, top: 30, width: 600, height: 600 })
    const { tab, rule, created } = await AgentWindow.open("https://example.com/", { newWindow: true })
    expect(tab.windowId).not.toBe(user.id)
    expect(created).toBe(true)
    expect(rule).toBe("new-window")
    expect(stub.state.created).toEqual([expect.objectContaining({ focused: false, type: "normal" })])
    expect(stub.state.focusedWindowId).toBe(user.id)
    expect(await AgentWindow.id()).toBeUndefined()
    expect(await AgentWindow.placement()).toBe("current")
  })

  test("an unknown stored value means the default", async () => {
    await stub.chrome.storage.local.set({ agentTabsWindow: "elsewhere" })
    expect(await AgentWindow.placement()).toBe("current")
  })
})

// Some Chromium browsers (Dia) keep windows the user never sees: a profile's window can stay open while another
// profile is on screen. These cases check that the window with the user's tabs wins over those.
describe("AgentWindow.open with windows the browser doesn't show", () => {
  /** A normal window that isn't focused, holding the user's tab last accessed at `at`. */
  async function userTabWindow(at: number, options: { state?: string } = {}) {
    const window = await stub.chrome.windows.create({ url: "https://user.example/", focused: false, ...options })
    const tab = [...stub.state.tabs.values()].find((tab) => tab.windowId === window.id)!
    await stub.chrome.tabs.update(tab.id, { lastAccessed: at })
    stub.state.created.length = 0
    return { window, tab }
  }

  /** A normal window holding only a tab an agent opened, last accessed at `at`. */
  async function agentTabWindow(at: number) {
    const window = await stub.chrome.windows.create({ url: "https://agent.example/", focused: false })
    const tab = [...stub.state.tabs.values()].find((tab) => tab.windowId === window.id)!
    await stub.chrome.tabs.update(tab.id, { lastAccessed: at })
    TabCleanup.track(tab.id)
    tracked.push(tab.id)
    stub.state.created.length = 0
    return { window, tab }
  }

  test("the unfocused last-focused window wins while the browser is in the background", async () => {
    const lastFocused = await userTabWindow(100)
    stub.state.lastFocusedWindowId = lastFocused.window.id
    await userTabWindow(200)

    const { tab, created, rule, normalWindows } = await AgentWindow.open("https://example.com/")
    expect(tab.windowId).toBe(lastFocused.window.id)
    expect(created).toBe(false)
    expect(rule).toBe("last-focused")
    expect(normalWindows).toBeUndefined()
    expect(stub.state.created).toHaveLength(0)
  })

  test("two opens in a row both go to the user's window", async () => {
    const agents = await agentTabWindow(300)
    stub.state.lastFocusedWindowId = agents.window.id
    const user = await userTabWindow(100)

    const first = await AgentWindow.open("https://example.com/1")
    expect(first.tab.windowId).toBe(user.window.id)
    expect(first.rule).toBe("most-recent-user-tab")
    // The relay tracks what it opens, so the next choice doesn't count it as the user's.
    TabCleanup.track(first.tab.id!)
    tracked.push(first.tab.id!)

    const second = await AgentWindow.open("https://example.com/2")
    expect(second.tab.windowId).toBe(user.window.id)
    expect(second.rule).toBe("most-recent-user-tab")
    expect(stub.state.created).toHaveLength(0)
  })

  test("opens a window when getAll times out", async () => {
    stub.state.lastFocusedWindowId = 9_999
    stub.state.getAllHangs = true
    const started = Date.now()
    const { tab, created, rule, lastFocused } = await AgentWindow.open("https://example.com/")
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(lastFocused).toBe("failed")
    expect(created).toBe(true)
    expect(rule).toBe("created")
    expect(stub.state.windows.get(tab.windowId)?.focused).toBe(false)
  }, 10_000)

  test("skips a window holding only agent tabs for one with a user's tab", async () => {
    const agents = await agentTabWindow(200)
    stub.state.lastFocusedWindowId = agents.window.id
    const user = await userTabWindow(100)

    const { tab, rule, normalWindows } = await AgentWindow.open("https://example.com/")
    expect(tab.windowId).toBe(user.window.id)
    expect(rule).toBe("most-recent-user-tab")
    expect(normalWindows).toBe(2)
    expect(stub.state.created).toHaveLength(0)
  })

  test("opens in a normal window when getLastFocused fails", async () => {
    const user = await userTabWindow(100)
    stub.state.lastFocusedWindowId = 9_999

    const { tab, rule } = await AgentWindow.open("https://example.com/")
    expect(tab.windowId).toBe(user.window.id)
    expect(rule).toBe("most-recent-user-tab")
    expect(stub.state.created).toHaveLength(0)
  })

  test("skips a minimized window for one the user can see", async () => {
    const minimized = await userTabWindow(200, { state: "minimized" })
    stub.state.lastFocusedWindowId = minimized.window.id
    const visible = await userTabWindow(100)

    const { tab, rule } = await AgentWindow.open("https://example.com/")
    expect(tab.windowId).toBe(visible.window.id)
    expect(rule).toBe("most-recent-user-tab")
    expect(stub.state.created).toHaveLength(0)
  })

  test("with no normal window, still makes one unfocused", async () => {
    const popup = await stub.chrome.windows.create({ type: "popup", url: "https://popup.example/", focused: false })
    stub.state.lastFocusedWindowId = popup.id
    stub.state.created.length = 0

    const { tab, rule } = await AgentWindow.open("https://example.com/")
    expect(stub.state.created).toEqual([expect.objectContaining({ focused: false, type: "normal" })])
    expect(tab.windowId).not.toBe(popup.id)
    expect(rule).toBe("created")
  })
})

describe("AgentWindow.openTab", () => {
  test("makes one unfocused window beside the user's, then opens background tabs in it", async () => {
    // A second display to the right of the laptop screen.
    stub.state.displays.push({ left: 1512, top: 0, width: 2560, height: 1440 })
    const user = await userWindow({ left: 0, top: 30, width: 1512, height: 950 })

    const first = (await AgentWindow.openTab("https://example.com/")).tab
    expect(stub.state.created).toHaveLength(1)
    expect(stub.state.created[0]).toMatchObject({ focused: false, state: "normal", left: 1512, top: 30, width: 1280, height: 900 })
    expect(first.windowId).not.toBe(user.id)
    expect(stub.state.focusedWindowId).toBe(user.id)

    const second = (await AgentWindow.openTab("https://example.org/")).tab
    expect(stub.state.created).toHaveLength(1)
    expect(second.windowId).toBe(first.windowId)
    expect(second.active).toBe(false)
    expect(await AgentWindow.id()).toBe(first.windowId)
  })

  test("concurrent calls share one new window", async () => {
    await userWindow({ left: 0, top: 30, width: 600, height: 600 })
    const tabs = (await Promise.all([1, 2, 3].map((n) => AgentWindow.openTab(`https://example.com/${n}`)))).map((opened) => opened.tab)
    expect(stub.state.created).toHaveLength(1)
    expect(new Set(tabs.map((tab) => tab.windowId)).size).toBe(1)
  })

  test("makes the window again after the user closes it", async () => {
    await userWindow({ left: 0, top: 30, width: 600, height: 600 })
    const first = (await AgentWindow.openTab("https://example.com/")).tab
    await stub.chrome.windows.remove(first.windowId)
    await settle()
    expect(await AgentWindow.id()).toBeUndefined()
    const again = (await AgentWindow.openTab("https://example.com/")).tab
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
    const { tab } = await AgentWindow.openTab("https://example.com/")
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
