import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { installChrome, settle, type StubEvent } from "./chrome-stub"

// The status page's "Close tabs agents haven't touched for" setting (tab-cleanup.ts): 10 minutes by default, 30, 60,
// or never (0). The periodic alarm closes idle agent tabs by it; guarded tabs (a script running, a handoff waiting, a
// recording) stay open whatever the setting.

const stub = installChrome()
const { TabCleanup } = await import("../src/background/tab-cleanup")

const realNow = Date.now
let now = realNow()
Date.now = () => now
afterAll(() => {
  Date.now = realNow
})

const ALARM = "opencode-browser-tab-cleanup"
const alarm = () => (chrome.alarms.onAlarm as unknown as StubEvent).emit({ name: ALARM })
const guarded = new Set<number>()
TabCleanup.guard((tabId) => guarded.has(tabId))

let window = 0
/** An agent tab in the background of the user's window, touched `minutesAgo`. */
async function agentTab(minutesAgo: number) {
  const tab = await stub.chrome.tabs.create({ windowId: window, url: "https://example.com/", active: false })
  now -= minutesAgo * 60_000
  TabCleanup.track(tab.id)
  now += minutesAgo * 60_000
  return tab.id
}
const open = (tabId: number) => stub.state.tabs.has(tabId)
async function runAlarm() {
  alarm()
  for (let i = 0; i < 20; i++) await settle()
}

beforeEach(async () => {
  stub.state.tabs.clear()
  stub.state.windows.clear()
  guarded.clear()
  window = (await stub.chrome.windows.create({ url: "https://user.example/", focused: true })).id
  await stub.chrome.storage.local.remove("tabCleanupIdleMinutes")
})

describe("idle tab cleanup", () => {
  test("by default closes agent tabs untouched for 10 minutes", async () => {
    const stale = await agentTab(11)
    const fresh = await agentTab(5)
    expect(await TabCleanup.idleMinutes()).toBe(10)
    await runAlarm()
    expect(open(stale)).toBe(false)
    expect(open(fresh)).toBe(true)
  })

  test("set to 30 minutes, a tab idle for 15 stays and one idle for 31 closes", async () => {
    await stub.chrome.storage.local.set({ tabCleanupIdleMinutes: 30 })
    const fifteen = await agentTab(15)
    const thirtyOne = await agentTab(31)
    await runAlarm()
    expect(open(fifteen)).toBe(true)
    expect(open(thirtyOne)).toBe(false)
  })

  test("set to never, the alarm closes nothing, however long a tab sat", async () => {
    await stub.chrome.storage.local.set({ tabCleanupIdleMinutes: 0 })
    const day = await agentTab(24 * 60)
    await runAlarm()
    expect(open(day)).toBe(true)
  })

  test("set to never, an agent's cleanup without a time closes only tabs idle for 10 minutes", async () => {
    await stub.chrome.storage.local.set({ tabCleanupIdleMinutes: 0 })
    const stale = await agentTab(11)
    const fresh = await agentTab(2)
    const closed = await TabCleanup.cleanup()
    expect(closed.map((tab) => tab.tabId)).toEqual([stale])
    expect(open(fresh)).toBe(true)
  })

  test("a guarded tab (running, waiting or recording) stays open past the time", async () => {
    await stub.chrome.storage.local.set({ tabCleanupIdleMinutes: 10 })
    const busy = await agentTab(60)
    guarded.add(busy)
    await runAlarm()
    expect(open(busy)).toBe(true)
    guarded.delete(busy)
    await runAlarm()
    expect(open(busy)).toBe(false)
  })

  test("an invalid stored value reads as the default", async () => {
    await stub.chrome.storage.local.set({ tabCleanupIdleMinutes: "soon" })
    expect(await TabCleanup.idleMinutes()).toBe(10)
    await stub.chrome.storage.local.set({ tabCleanupIdleMinutes: -5 })
    expect(await TabCleanup.idleMinutes()).toBe(10)
  })
})

describe("a tab the worker was opening when it stopped", () => {
  test("is closed on the next worker start; tracked tabs and the user's tabs stay", async () => {
    const before = await agentTab(0)
    await TabCleanup.beginCreate("about:blank")
    // The worker stopped here: Chrome finished creating the tab, nobody tracked it.
    const lost = (await stub.chrome.tabs.create({ windowId: window, url: "about:blank", active: false })).id
    const user = (await stub.chrome.tabs.create({ windowId: window, url: "about:blank", active: true })).id
    const closed = await TabCleanup.reconcileCreates(() => false)
    expect(closed.map((tab) => tab.tabId)).toEqual([lost])
    expect(open(before)).toBe(true)
    expect(open(user)).toBe(true)
    // Nothing is pending any more.
    expect(await TabCleanup.reconcileCreates(() => false)).toEqual([])
  })

  test("a creation that finished leaves nothing to reconcile", async () => {
    const token = await TabCleanup.beginCreate("about:blank")
    const tab = (await stub.chrome.tabs.create({ windowId: window, url: "about:blank", active: false })).id
    TabCleanup.track(tab)
    await TabCleanup.endCreate(token)
    expect(await TabCleanup.reconcileCreates(() => false)).toEqual([])
    expect(open(tab)).toBe(true)
  })
})

describe("tracked tabs the relay doesn't have after a worker restart", () => {
  test("are closed; attached ones stay", async () => {
    const kept = await agentTab(0)
    const lost = await agentTab(0)
    const closed = await TabCleanup.closeUnattached((tabId) => tabId === kept)
    expect(closed.map((tab) => tab.tabId)).toEqual([lost])
    expect(open(kept)).toBe(true)
    expect(await TabCleanup.isTracked(lost)).toBe(false)
  })
})

