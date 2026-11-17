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
const MARKER = "\u2063"
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
  stub.state.groups.clear()
  stub.state.calls.length = 0
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

  test("one agent's cleanup at 0 closes its own tabs; other agents' tabs still wait for the setting", async () => {
    const mine = await agentTab(1)
    const theirs = await agentTab(1)
    const theirsStale = await agentTab(11)
    const closed = await TabCleanup.cleanup({ own: { tabIds: [mine], minutes: 0 } })
    expect(closed.map((tab) => tab.tabId).toSorted()).toEqual([mine, theirsStale].toSorted())
    expect(open(theirs)).toBe(true)
  })

  test("one agent's cleanup longer than the setting waits that long for every tab", async () => {
    const mine = await agentTab(15)
    const theirs = await agentTab(15)
    const closed = await TabCleanup.cleanup({ own: { tabIds: [mine], minutes: 30 } })
    expect(closed).toEqual([])
    expect(open(mine) && open(theirs)).toBe(true)
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

  test("keepOpen keeps a tab past the time (and turns off again); a normal tab still closes", async () => {
    const kept = await agentTab(60)
    const normal = await agentTab(60)
    TabCleanup.keepOpen(kept, true)
    expect((await TabCleanup.cleanup({ minutes: 0 })).map((tab) => tab.tabId)).toEqual([normal])
    expect(open(kept)).toBe(true)
    TabCleanup.keepOpen(kept, false)
    expect((await TabCleanup.cleanup({ minutes: 0 })).map((tab) => tab.tabId)).toEqual([kept])
  })
})

describe("closing a tab in an agent group", () => {
  test("ungroups it before removing it, even when other tabs are in the group", async () => {
    const first = await agentTab(0)
    const second = await agentTab(0)
    const groupId = await stub.chrome.tabs.group({ tabIds: [first, second] })
    await stub.chrome.tabGroups.update(groupId, { title: `github${MARKER}` })
    stub.state.calls.length = 0
    const closed = await TabCleanup.cleanup({ minutes: 0 })
    expect(closed.map((tab) => tab.tabId)).toEqual([first, second])
    expect(stub.state.calls).toEqual([
      `ungroup:${first}`,
      `remove:${first}`,
      `ungroup:${second}`,
      `remove:${second}`,
    ])
    expect(stub.state.groups.has(groupId)).toBe(false)
  })
})

describe("closing the last tab of the last window", () => {
  /** A browser start reads the platform again, so tests can switch between macOS and the rest. */
  function usePlatform(os: string) {
    stub.chrome.runtime.getPlatformInfo = async () => ({ os, arch: "x64", nacl_arch: "x64" })
    ;(stub.chrome.runtime as unknown as { onStartup: StubEvent }).onStartup.emit()
  }

  /** `count` agent tabs left as their window's only tabs. */
  async function onlyTabsInWindow(count: number, windowId = window) {
    const tabIds: number[] = []
    for (let i = 0; i < count; i++) {
      const tab = await stub.chrome.tabs.create({ windowId, url: "https://example.com/", active: false })
      TabCleanup.track(tab.id)
      tabIds.push(tab.id)
    }
    for (const tab of await stub.chrome.tabs.query({ windowId }))
      if (!tabIds.includes(tab.id!)) await stub.chrome.tabs.remove(tab.id!)
    return tabIds
  }

  test("opens a plain new tab in the window before closing it", async () => {
    usePlatform("linux")
    const [tabId] = await onlyTabsInWindow(1)
    const created: Array<{ windowId?: number; url?: string }> = []
    const order: string[] = []
    const create = stub.chrome.tabs.create
    const remove = stub.chrome.tabs.remove
    stub.chrome.tabs.create = async (options) => {
      order.push("create")
      created.push(options)
      return create(options)
    }
    stub.chrome.tabs.remove = async (ids) => {
      order.push("remove")
      return remove(ids)
    }
    try {
      await TabCleanup.cleanup({ minutes: 0 })
      expect(order).toEqual(["create", "remove"])
      // No url: the browser's new-tab page, not another agent page.
      expect(created).toEqual([{ windowId: window }])
      expect(open(tabId)).toBe(false)
      const [replacement] = await stub.chrome.tabs.query({ windowId: window })
      expect(replacement!.groupId).toBe(-1)
      expect(await TabCleanup.isTracked(replacement!.id!)).toBe(false)
    } finally {
      stub.chrome.tabs.create = create
      stub.chrome.tabs.remove = remove
    }
  })

  test("with another normal window open, closes it without a new tab", async () => {
    usePlatform("linux")
    const [tabId] = await onlyTabsInWindow(1)
    await stub.chrome.windows.create({ url: "https://other.example/", focused: true })
    const created: Array<{ windowId?: number; url?: string }> = []
    const create = stub.chrome.tabs.create
    stub.chrome.tabs.create = async (options) => {
      created.push(options)
      return create(options)
    }
    try {
      await TabCleanup.cleanup({ minutes: 0 })
      expect(created).toEqual([])
      expect(open(tabId)).toBe(false)
      expect(await stub.chrome.tabs.query({ windowId: window })).toEqual([])
    } finally {
      stub.chrome.tabs.create = create
    }
  })

  test("two closes at once leave one plain new tab", async () => {
    usePlatform("linux")
    const [first, second] = await onlyTabsInWindow(2)
    const created: Array<{ windowId?: number; url?: string }> = []
    const create = stub.chrome.tabs.create
    stub.chrome.tabs.create = async (options) => {
      created.push(options)
      return create(options)
    }
    try {
      await Promise.all([TabCleanup.closeAgentTab(first), TabCleanup.closeAgentTab(second)])
      expect(created).toEqual([{ windowId: window }])
      expect(open(first)).toBe(false)
      expect(open(second)).toBe(false)
      const remaining = await stub.chrome.tabs.query({ windowId: window })
      expect(remaining).toHaveLength(1)
      expect(remaining[0]!.groupId).toBe(-1)
      expect(await TabCleanup.isTracked(remaining[0]!.id!)).toBe(false)
    } finally {
      stub.chrome.tabs.create = create
    }
  })

  test("a replacement that can't be created keeps the tab, its group and its tracking", async () => {
    usePlatform("linux")
    const [tabId] = await onlyTabsInWindow(1)
    const groupId = await stub.chrome.tabs.group({ tabIds: [tabId] })
    await stub.chrome.tabGroups.update(groupId, { title: `github${MARKER}` })
    const create = stub.chrome.tabs.create
    stub.chrome.tabs.create = async () => {
      throw new Error("cannot create a tab")
    }
    try {
      await expect(TabCleanup.closeAgentTab(tabId)).rejects.toThrow("cannot create a tab")
      expect(open(tabId)).toBe(true)
      expect(stub.state.tabs.get(tabId)!.groupId).toBe(groupId)
      expect(stub.state.groups.get(groupId)?.title).toBe(`github${MARKER}`)
      expect(await TabCleanup.isTracked(tabId)).toBe(true)
    } finally {
      stub.chrome.tabs.create = create
    }
  })

  test("a hung Chrome call fails its close and the queue moves on", async () => {
    usePlatform("linux")
    const [hung, other] = await onlyTabsInWindow(2)
    const get = stub.chrome.tabs.get
    stub.chrome.tabs.get = async (id) => {
      if (id === hung) return new Promise<never>(() => {})
      return get(id)
    }
    try {
      const first = TabCleanup.closeAgentTab(hung)
      const second = TabCleanup.closeAgentTab(other)
      await expect(first).rejects.toThrow(`closing tab ${hung} timed out`)
      await second
      expect(open(hung)).toBe(true)
      expect(open(other)).toBe(false)
    } finally {
      stub.chrome.tabs.get = get
    }
  }, 20_000)

  test("a window lookup that hangs counts as the last window, so a new tab is created", async () => {
    usePlatform("linux")
    const [tabId] = await onlyTabsInWindow(1)
    stub.state.getAllHangs = true
    const created: Array<{ windowId?: number }> = []
    const create = stub.chrome.tabs.create
    stub.chrome.tabs.create = async (options) => {
      created.push(options)
      return create(options)
    }
    try {
      await TabCleanup.closeAgentTab(tabId)
      expect(created).toEqual([{ windowId: window }])
      expect(open(tabId)).toBe(false)
    } finally {
      stub.chrome.tabs.create = create
      stub.state.getAllHangs = false
    }
  }, 10_000)

  test("a popup as the last window gets a normal window instead of a tab in the popup", async () => {
    usePlatform("linux")
    const popup = (await stub.chrome.windows.create({ type: "popup", url: "https://popup.example/", focused: false })).id
    const [tabId] = await onlyTabsInWindow(1, popup)
    await stub.chrome.windows.remove(window)
    const tabsCreated: unknown[] = []
    const windowsCreated: Array<{ focused?: boolean; type?: string; url?: string }> = []
    let replacementWindow: number | undefined
    const createTab = stub.chrome.tabs.create
    const createWindow = stub.chrome.windows.create
    stub.chrome.tabs.create = async (options) => {
      tabsCreated.push(options)
      return createTab(options)
    }
    stub.chrome.windows.create = async (options) => {
      windowsCreated.push(options ?? {})
      const created = await createWindow(options)
      replacementWindow = created.id
      return created
    }
    try {
      await TabCleanup.closeAgentTab(tabId)
      expect(tabsCreated).toEqual([])
      expect(windowsCreated).toEqual([{ focused: false, type: "normal" }])
      expect(open(tabId)).toBe(false)
      expect(replacementWindow).not.toBeUndefined()
      expect(replacementWindow).not.toBe(popup)
      const replacement = await stub.chrome.tabs.query({ windowId: replacementWindow! })
      expect(replacement).toHaveLength(1)
      expect(replacement[0]!.groupId).toBe(-1)
      expect(await TabCleanup.isTracked(replacement[0]!.id!)).toBe(false)
      // Not the agent window: only AgentWindow.openTab records that.
      expect(await stub.chrome.storage.session.get("agentWindowId")).toEqual({})
    } finally {
      stub.chrome.tabs.create = createTab
      stub.chrome.windows.create = createWindow
    }
  })

  test("on macOS closing the last tab needs no replacement", async () => {
    usePlatform("mac")
    const [tabId] = await onlyTabsInWindow(1)
    const created: unknown[] = []
    const create = stub.chrome.tabs.create
    stub.chrome.tabs.create = async (options) => {
      created.push(options)
      return create(options)
    }
    try {
      await TabCleanup.closeAgentTab(tabId)
      expect(created).toEqual([])
      expect(open(tabId)).toBe(false)
    } finally {
      stub.chrome.tabs.create = create
    }
  })
})

describe("a tab the relay ungroups itself", () => {
  test("keeps idle tracking, unlike a tab the user drags out of the agent group", async () => {
    const byRelay = await agentTab(0)
    const byUser = await agentTab(0)
    await stub.chrome.tabs.group({ tabIds: [byRelay, byUser] })
    await TabCleanup.relayUngroup(byRelay, () => stub.chrome.tabs.ungroup(byRelay))
    await stub.chrome.tabs.ungroup(byUser)
    expect(await TabCleanup.isTracked(byRelay)).toBe(true)
    expect(await TabCleanup.isTracked(byUser)).toBe(false)
  })

  test("does not keep a mark when no group change arrives, so a later user drag-out still forgets", async () => {
    const tabId = await agentTab(0)
    await stub.chrome.tabs.group({ tabIds: [tabId] })
    // The ungroup failed or the tab was already ungrouped: settle without a group-change event.
    await TabCleanup.relayUngroup(tabId, async () => undefined)
    await settle()
    await stub.chrome.tabs.ungroup(tabId)
    expect(await TabCleanup.isTracked(tabId)).toBe(false)
  })
})

describe("a tab that fails to close", () => {
  test("is put back in its group, stays tracked and is retried by the next cleanup", async () => {
    const tabId = await agentTab(60)
    const other = await stub.chrome.tabs.create({ windowId: window, url: "https://user.example/2", active: false })
    const groupId = await stub.chrome.tabs.group({ tabIds: [tabId, other.id] })
    await stub.chrome.tabGroups.update(groupId, { title: `github${MARKER}` })
    const remove = stub.chrome.tabs.remove
    let failed = false
    stub.chrome.tabs.remove = async (ids) => {
      const list = Array.isArray(ids) ? ids : [ids]
      if (!failed && list.includes(tabId)) {
        failed = true
        throw new Error("Tabs cannot be edited right now (user may be dragging a tab).")
      }
      return remove(ids)
    }
    try {
      expect(await TabCleanup.cleanup({ minutes: 0 })).toEqual([])
      expect(open(tabId)).toBe(true)
      expect(stub.state.tabs.get(tabId)!.groupId).toBe(groupId)
      expect(await TabCleanup.isTracked(tabId)).toBe(true)
      const closed = await TabCleanup.cleanup({ minutes: 0 })
      expect(closed.map((tab) => tab.tabId)).toEqual([tabId])
      expect(open(tabId)).toBe(false)
      expect(await TabCleanup.isTracked(tabId)).toBe(false)
    } finally {
      stub.chrome.tabs.remove = remove
    }
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

