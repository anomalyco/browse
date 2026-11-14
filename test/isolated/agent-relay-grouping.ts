import { beforeEach, describe, expect, test } from "bun:test"
import { installChrome, settle, type StubEvent } from "../chrome-stub"
import { installFakeRelaySocket } from "../relay-stub"

// The status page's Grouping setting (agent-relay.ts group, agent-groups.ts): one shared "Agents · N" group for every
// agent (the default), one group per session, or none; with popups, handoffs, the toolbar's kill switch (the relay
// detaching a tab) and both window modes. Also the relay-side settings the extension sends (cursor, human input) and
// the environment overrides the relay reports back, and the relay's settings tool reading and writing them
// (settings.get / settings.set). Run by ../isolated.test.ts in a process of its own.

const stub = installChrome()
;(globalThis as { __OPENCODE_BROWSER_BUILD__?: string }).__OPENCODE_BROWSER_BUILD__ = "test"
/** This browser's token for the relay, as a code exchange left it. */
const TOKEN = "test-token-0123456789abcdefghijklmnopqrstuv"
const PORT = 19908
const MARKER = "\u2063"
const socket = installFakeRelaySocket({ port: PORT, token: TOKEN })

await stub.chrome.storage.local.set({ agentRelayPort: PORT, agentRelayTokens: { [`127.0.0.1:${PORT}`]: TOKEN } })
const { createAgentRelay } = await import("../../src/background/agent-relay")
const { TabCleanup } = await import("../../src/background/tab-cleanup")
const relay = createAgentRelay({ changed: () => {}, badgesChanged: () => {} })

async function until(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 300 && !(await check()); i++) await settle()
  expect(await check()).toBe(true)
}
const event = (path: string) => path.split(".").reduce<any>((value, key) => value[key], stub.chrome) as StubEvent
let nextCommand = 1
async function command(method: string, params: Record<string, unknown>) {
  const id = nextCommand++
  socket().deliver({ id, method, params })
  await until(() => socket().received.some((message) => message.id === id))
  const reply = socket().received.find((message) => message.id === id)!
  expect(reply.error).toBeUndefined()
  return reply.result as Record<string, unknown>
}
const opened = () => socket().received.filter((message) => message.method === "tabs.opened")
const settings = () => socket().received.filter((message) => message.method === "settings").map((message) => message.params)

/** The user's focused window with their active tab. */
async function userWindow() {
  const user = await stub.chrome.windows.create({ url: "https://user.example/", focused: true })
  const userTab = user.tabs[0]!.id
  event("tabs.onActivated").emit({ tabId: userTab, windowId: user.id })
  return { user, userTab }
}

/** An agent tab as the relay opens one: tabs.create, debugger.attach, tabs.group for its session. */
async function agentTab(sessionId: string, url = "https://example.com/") {
  const { tabId } = (await command("tabs.create", { url, active: false })) as { tabId: number }
  await command("debugger.attach", { tabId })
  const { groupId } = (await command("tabs.group", { tabId, sessionId })) as { groupId: number }
  return { tabId, groupId }
}

/** Waits until the extension finished releasing every tab Chromium detached at once. */
async function canceledAtOnce(tabIds: readonly number[]) {
  await until(() =>
    tabIds.every((tabId) =>
      socket().received.some((message) =>
        message.method === "debugger.detached" && message.params?.tabId === tabId && message.params?.reason === "canceled_by_user") &&
      relay.badge(tabId) === undefined &&
      !relay.state().tabs.some((entry) => entry.tabId === tabId),
    ),
  )
}

/** What the relay sends after a debugger detach: clear the status, ungroup, reset the badge. */
async function relayDetachFollowUp(tabId: number) {
  await command("tabs.ungroup", { tabId })
  await command("pageStatus.clear", { tabId })
  await command("action.setAttached", { tabId, attached: false })
}

/** What the relay sends after a toolbar lend: attach, ungroup (a user tab has no session), status and badge. */
async function relayLendFollowUp(tabId: number) {
  await command("debugger.attach", { tabId })
  await command("tabs.ungroup", { tabId })
  await command("pageStatus.set", { tabId, status: { state: "attached", owner: "user" } })
  await command("action.setAttached", { tabId, attached: true })
}

/** Waits until the extension asked the relay to toggle the tab this many times. */
async function toolbarClicked(tabId: number, atLeast = 1) {
  await until(() => socket().received.filter((message) => message.method === "toolbar.clicked" && message.params?.tabId === tabId).length >= atLeast)
}

const group = (groupId: number) => stub.state.groups.get(groupId)
const tab = (tabId: number) => stub.state.tabs.get(tabId)!

beforeEach(async () => {
  stub.state.windows.clear()
  stub.state.tabs.clear()
  stub.state.groups.clear()
  stub.state.calls.length = 0
  stub.state.activations.length = 0
  stub.state.focusedWindowId = undefined
  socket().received.length = 0
  await stub.chrome.storage.local.remove(["agentTabsWindow", "agentTabsGrouping", "agentCursor", "humanInput", "tabCleanupIdleMinutes", "handoffNotifications"])
  await stub.chrome.storage.session.remove("agentWindowId")
})

await until(() => relay.state().status === "connected")

describe("grouping: one group per session", () => {
  beforeEach(() => stub.chrome.storage.local.set({ agentTabsGrouping: "session" }))
  test("each session gets its own collapsed group named after it", async () => {
    const { user, userTab } = await userWindow()
    const first = await agentTab("github")
    const second = await agentTab("linear")
    const again = await agentTab("github")
    const auto = await agentTab("oc-ses_123abc")
    expect(first.groupId).not.toBe(second.groupId)
    expect(again.groupId).toBe(first.groupId)
    expect(group(first.groupId)).toMatchObject({ windowId: user.id, title: `github${MARKER}`, collapsed: true })
    expect(group(second.groupId)).toMatchObject({ windowId: user.id, title: `linear${MARKER}`, collapsed: true })
    expect(group(auto.groupId)).toMatchObject({ windowId: user.id, title: `Agent · example.com${MARKER}`, collapsed: true })
    expect(tab(userTab).active).toBe(true)
  })

  test("a separate popup window joins the session without creating or replacing its tab group", async () => {
    const { user } = await userWindow()
    const opener = await agentTab("reports")
    const window = await stub.chrome.windows.create({ type: "popup", url: "https://popup.example/", focused: true })
    const tabId = window.tabs[0]!.id
    event("webNavigation.onCreatedNavigationTarget").emit({ sourceTabId: opener.tabId, tabId })
    await until(() => opened().length === 1)
    // Root attachment asks the extension to group the popup just like any other new session page.
    await command("debugger.attach", { tabId })
    expect(await command("tabs.group", { tabId, sessionId: "reports" })).toEqual({ groupId: -1 })
    expect(tab(tabId).groupId).toBe(-1)
    const next = await stub.chrome.tabs.create({ windowId: user.id, url: "about:blank", active: false })
    expect(await command("tabs.group", { tabId: next.id, sessionId: "reports" })).toEqual({ groupId: opener.groupId })
    expect(stub.state.groups.size).toBe(1)
  })

  test("ping calls chrome.runtime.getPlatformInfo to keep the MV3 service worker awake without logging noise", async () => {
    let platformCalls = 0
    const orig = stub.chrome.runtime.getPlatformInfo
    stub.chrome.runtime.getPlatformInfo = async () => {
      platformCalls += 1
      return orig()
    }
    try {
      expect(await command("ping", {})).toEqual({})
      expect(platformCalls).toBe(1)
      expect(await relay.diagnostics()).not.toContain("method=ping")
    } finally {
      stub.chrome.runtime.getPlatformInfo = orig
    }
  })
})

describe("grouping across a service worker restart", () => {
  beforeEach(() => stub.chrome.storage.local.set({ agentTabsGrouping: "session" }))
  test("a session whose group the worker forgot keeps using the group its tab is in, and remembers it", async () => {
    const { user } = await userWindow()
    // A tab already in a session group, as after a restart: the relay re-announces it, then groups it.
    const tabId = ((await command("tabs.create", { url: "https://example.com/", active: false })) as { tabId: number }).tabId
    const kept = await stub.chrome.tabs.group({ tabIds: [tabId] })
    await stub.chrome.tabGroups.update(kept, { title: `restarted${MARKER}` })
    await command("debugger.attach", { tabId })
    expect(((await command("tabs.group", { tabId, sessionId: "restarted" })) as { groupId: number }).groupId).toBe(kept)
    // The session's next tab joins it instead of making a second group.
    const next = await agentTab("restarted")
    expect(next.groupId).toBe(kept)
    expect(group(kept)).toMatchObject({ windowId: user.id, title: `restarted${MARKER}` })
    expect(((await stub.chrome.storage.local.get("agentSessionGroups")).agentSessionGroups as Record<string, number>).restarted).toBe(kept)
  })

  test("an agent tab stays tracked for idle cleanup while its agent keeps sending commands", async () => {
    await userWindow()
    const { tabId } = await agentTab("busy")
    // Every CDP command touches the tab; the tracked list still reaches storage at once.
    await until(async () => {
      TabCleanup.touch(tabId)
      return String(tabId) in (((await stub.chrome.storage.local.get("tabCleanup")).tabCleanup ?? {}) as Record<string, unknown>)
    })
  })
})

describe("grouping: one shared group for all agents (default)", () => {
  test("two sessions share one collapsed group that counts its tabs", async () => {
    const { user, userTab } = await userWindow()
    const first = await agentTab("github")
    const second = await agentTab("linear")
    expect(second.groupId).toBe(first.groupId)
    expect(tab(first.tabId).groupId).toBe(first.groupId)
    expect(tab(second.tabId).groupId).toBe(first.groupId)
    expect(group(first.groupId)).toMatchObject({ windowId: user.id, title: `Agents · 2${MARKER}${MARKER}`, collapsed: true })
    expect([...stub.state.groups.values()]).toHaveLength(1)
    expect(tab(userTab).active).toBe(true)
    // A tab closing counts down.
    await stub.chrome.tabs.remove(second.tabId)
    await until(() => group(first.groupId)?.title === `Agents · 1${MARKER}${MARKER}`)
  })

  test("the relay removing two tabs of one group concurrently ungroups each before removing it", async () => {
    await userWindow()
    const first = await agentTab("github")
    const second = await agentTab("linear")
    expect(second.groupId).toBe(first.groupId)
    stub.state.calls.length = 0
    await Promise.all([
      command("tabs.remove", { tabId: first.tabId }),
      command("tabs.remove", { tabId: second.tabId }),
    ])
    for (const tabId of [first.tabId, second.tabId]) {
      const ungroup = stub.state.calls.indexOf(`ungroup:${tabId}`)
      const remove = stub.state.calls.indexOf(`remove:${tabId}`)
      expect(ungroup).toBeGreaterThanOrEqual(0)
      expect(remove).toBeGreaterThan(ungroup)
    }
    expect(stub.state.calls.filter((call) => call.startsWith("ungroup:"))).toHaveLength(2)
    expect(stub.state.groups.size).toBe(0)
  })

  test("concurrent sessions still make one group", async () => {
    await stub.chrome.storage.local.set({ agentTabsGrouping: "shared" })
    await userWindow()
    const created = await Promise.all(["a-session", "b-session", "c-session"].map(async (sessionId) => {
      const { tabId } = (await command("tabs.create", { url: "https://example.com/", active: false })) as { tabId: number }
      return { tabId, sessionId }
    }))
    const groups = await Promise.all(created.map(({ tabId, sessionId }) => command("tabs.group", { tabId, sessionId })))
    expect(new Set(groups.map((result) => result.groupId)).size).toBe(1)
    expect(group(groups[0]!.groupId as number)!.title).toBe(`Agents · 3${MARKER}${MARKER}`)
  })

  test("a popup joins the shared group and counts; a handoff expands it, and it folds again after", async () => {
    await stub.chrome.storage.local.set({ agentTabsGrouping: "shared" })
    const { user, userTab } = await userWindow()
    const agent = await agentTab("github")
    TabCleanup.track(agent.tabId)
    const popup = await stub.chrome.tabs.create({ windowId: user.id, url: "https://popup.example/", active: false })
    event("webNavigation.onCreatedNavigationTarget").emit({ sourceTabId: agent.tabId, tabId: popup.id })
    await until(() => opened().length === 1)
    expect(tab(popup.id).groupId).toBe(agent.groupId)
    expect(group(agent.groupId)!.title).toBe(`Agents · 2${MARKER}${MARKER}`)
    await command("pageStatus.set", { tabId: agent.tabId, status: { state: "waiting", owner: "session", sessionId: "github", handoffId: "h1", message: "Sign in" } })
    await until(() => group(agent.groupId)!.collapsed === false)
    await command("pageStatus.set", { tabId: agent.tabId, status: { state: "attached", owner: "session", sessionId: "github" } })
    await until(() => group(agent.groupId)!.collapsed === true)
    expect(tab(userTab).active).toBe(true)
  })

  test("in a separate agent window the shared group lives there", async () => {
    await stub.chrome.storage.local.set({ agentTabsGrouping: "shared", agentTabsWindow: "separate" })
    const { user } = await userWindow()
    const first = await agentTab("github")
    const second = await agentTab("linear")
    expect(second.groupId).toBe(first.groupId)
    const windowId = group(first.groupId)!.windowId
    expect(windowId).not.toBe(user.id)
    expect(tab(first.tabId).windowId).toBe(windowId)
    expect(group(first.groupId)!.title).toBe(`Agents · 2${MARKER}${MARKER}`)
  })

  test("switching modes leaves existing tabs in their groups; new tabs follow the new mode", async () => {
    await stub.chrome.storage.local.set({ agentTabsGrouping: "session" })
    await userWindow()
    const before = await agentTab("github")
    await stub.chrome.storage.local.set({ agentTabsGrouping: "shared" })
    // The relay regroups tabs it already has (after a reconnect, say): it stays in its session group.
    expect((await command("tabs.group", { tabId: before.tabId, sessionId: "github" })).groupId).toBe(before.groupId)
    const after = await agentTab("github")
    expect(after.groupId).not.toBe(before.groupId)
    expect(group(after.groupId)!.title).toBe(`Agents · 1${MARKER}${MARKER}`)
    expect(group(before.groupId)!.title).toBe(`github${MARKER}`)
    await stub.chrome.storage.local.set({ agentTabsGrouping: "session" })
    expect((await command("tabs.group", { tabId: after.tabId, sessionId: "github" })).groupId).toBe(after.groupId)
  })

  test("the relay detaching a tab (toolbar kill switch) closes an agent's tab and gives a lent tab back", async () => {
    await stub.chrome.storage.local.set({ agentTabsGrouping: "shared" })
    const { userTab } = await userWindow()
    const agent = await agentTab("github")
    await command("debugger.attach", { tabId: userTab })
    expect((await command("tabs.group", { tabId: userTab, sessionId: "github" })).groupId).toBe(agent.groupId)
    await command("debugger.detach", { tabId: agent.tabId })
    expect(stub.state.tabs.has(agent.tabId)).toBe(false)
    await command("debugger.detach", { tabId: userTab })
    expect(tab(userTab).groupId).toBe(-1)
  })

  test("a released agent tab stays open, ungrouped and off idle cleanup", async () => {
    await stub.chrome.storage.local.set({ agentTabsGrouping: "shared" })
    await userWindow()
    const agent = await agentTab("github")
    expect(await TabCleanup.isTracked(agent.tabId)).toBe(true)
    // A relay that can't identify the tab's session releases it instead of closing it.
    await command("debugger.detach", { tabId: agent.tabId, release: true })
    expect(stub.state.tabs.has(agent.tabId)).toBe(true)
    expect(tab(agent.tabId).groupId).toBe(-1)
    expect(await TabCleanup.isTracked(agent.tabId)).toBe(false)
  })

  test("a debugging bar cancel leaves agent tabs grouped and tracked, and releases a lent tab", async () => {
    await stub.chrome.storage.local.set({ agentTabsGrouping: "shared" })
    const { userTab } = await userWindow()
    const first = await agentTab("github")
    const second = await agentTab("linear")
    await command("debugger.attach", { tabId: userTab })
    expect((await command("tabs.group", { tabId: userTab, sessionId: "github" })).groupId).toBe(first.groupId)
    const canceled = [first.tabId, second.tabId, userTab]
    for (const tabId of canceled) await command("action.setBadge", { tabId, text: "RUN" })
    // Chromium detaches every tab at once when the bar's button is clicked.
    for (const tabId of canceled) event("debugger.onDetach").emit({ tabId }, "canceled_by_user")
    await canceledAtOnce(canceled)
    // Then the relay follows each detach with what it sends today.
    for (const tabId of canceled) await relayDetachFollowUp(tabId)
    // Tabs the agent opened stay open, in the shared group, and on the idle timer.
    for (const agent of [first, second]) {
      expect(stub.state.tabs.has(agent.tabId)).toBe(true)
      expect(tab(agent.tabId).groupId).toBe(first.groupId)
      expect(await TabCleanup.isTracked(agent.tabId)).toBe(true)
    }
    // The tab the user lent is theirs again: open, out of the group, untracked.
    expect(stub.state.tabs.has(userTab)).toBe(true)
    expect(tab(userTab).groupId).toBe(-1)
    expect(await TabCleanup.isTracked(userTab)).toBe(false)
    for (const tabId of canceled) expect(relay.badge(tabId)).toBeUndefined()
    // Idle cleanup still closes the agent's tabs, never the user's.
    const closed = await TabCleanup.cleanup({ minutes: 0 })
    expect(closed.map((tab) => tab.tabId).sort()).toEqual([first.tabId, second.tabId].sort())
    expect(stub.state.tabs.has(userTab)).toBe(true)
  })

  test("a debugging bar cancel leaves a lent tab in one of the user's own groups where it is", async () => {
    const { userTab } = await userWindow()
    const ownGroup = await stub.chrome.tabs.group({ tabIds: [userTab] })
    await stub.chrome.tabGroups.update(ownGroup, { title: "Work" })
    await command("debugger.attach", { tabId: userTab })
    event("debugger.onDetach").emit({ tabId: userTab }, "canceled_by_user")
    await canceledAtOnce([userTab])
    await relayDetachFollowUp(userTab)
    expect(tab(userTab).groupId).toBe(ownGroup)
    expect(group(ownGroup)!.title).toBe("Work")
    expect(stub.state.tabs.has(userTab)).toBe(true)
    expect(await TabCleanup.isTracked(userTab)).toBe(false)
  })

  test("lending a canceled agent tab makes it a normal lent tab, and taking it back keeps it", async () => {
    await stub.chrome.storage.local.set({ agentTabsGrouping: "shared" })
    await userWindow()
    const stillMarked = await agentTab("github")
    const markerGone = await agentTab("linear")
    for (const tabId of [stillMarked.tabId, markerGone.tabId]) event("debugger.onDetach").emit({ tabId }, "canceled_by_user")
    await canceledAtOnce([stillMarked.tabId, markerGone.tabId])
    // An old relay follows the cancel with an ungroup, which consumes the mark; a new relay does not, so the mark is
    // still there when the user lends the tab. Both must make the lend a normal lent tab.
    await relayDetachFollowUp(markerGone.tabId)
    for (const tabId of [stillMarked.tabId, markerGone.tabId]) {
      await relay.attachTab(tabId)
      await toolbarClicked(tabId)
      await relayLendFollowUp(tabId)
      // Lending hands the tab to the user: open, out of the agent group, and no longer closed by idle cleanup.
      expect(stub.state.tabs.has(tabId)).toBe(true)
      expect(tab(tabId).groupId).toBe(-1)
      expect(await TabCleanup.isTracked(tabId)).toBe(false)
      // Taking it back with the toolbar leaves it open too.
      await relay.attachTab(tabId)
      await toolbarClicked(tabId, 2)
      await command("debugger.detach", { tabId })
      await command("pageStatus.clear", { tabId })
      await command("action.setAttached", { tabId, attached: false })
      expect(stub.state.tabs.has(tabId)).toBe(true)
      expect(await TabCleanup.isTracked(tabId)).toBe(false)
    }
  })

  test("a debugging bar cancel keeps each session's tabs in its own group", async () => {
    await stub.chrome.storage.local.set({ agentTabsGrouping: "session" })
    await userWindow()
    const first = await agentTab("github")
    const second = await agentTab("linear")
    expect(first.groupId).not.toBe(second.groupId)
    const canceled = [first.tabId, second.tabId]
    for (const tabId of canceled) event("debugger.onDetach").emit({ tabId }, "canceled_by_user")
    await canceledAtOnce(canceled)
    for (const tabId of canceled) await relayDetachFollowUp(tabId)
    expect(tab(first.tabId).groupId).toBe(first.groupId)
    expect(tab(second.tabId).groupId).toBe(second.groupId)
    expect(group(first.groupId)!.title).toBe(`github${MARKER}`)
    expect(group(second.groupId)!.title).toBe(`linear${MARKER}`)
    expect(await TabCleanup.isTracked(first.tabId)).toBe(true)
    expect(await TabCleanup.isTracked(second.tabId)).toBe(true)
    expect(await TabCleanup.cleanup({ minutes: 0 })).toHaveLength(2)
  })

  test("with grouping off, a debugging bar cancel keeps agent tabs open and tracked", async () => {
    await stub.chrome.storage.local.set({ agentTabsGrouping: "none" })
    const { userTab } = await userWindow()
    const agent = await agentTab("github")
    expect(agent.groupId).toBe(-1)
    await command("debugger.attach", { tabId: userTab })
    const canceled = [agent.tabId, userTab]
    for (const tabId of canceled) event("debugger.onDetach").emit({ tabId }, "canceled_by_user")
    await canceledAtOnce(canceled)
    for (const tabId of canceled) await relayDetachFollowUp(tabId)
    expect(stub.state.tabs.has(agent.tabId)).toBe(true)
    expect(tab(agent.tabId).groupId).toBe(-1)
    expect(await TabCleanup.isTracked(agent.tabId)).toBe(true)
    expect(stub.state.tabs.has(userTab)).toBe(true)
    expect(await TabCleanup.isTracked(userTab)).toBe(false)
    expect((await TabCleanup.cleanup({ minutes: 0 })).map((tab) => tab.tabId)).toEqual([agent.tabId])
    expect(stub.state.tabs.has(userTab)).toBe(true)
  })
})

describe("grouping: none", () => {
  test("tabs and their popups stay ungrouped in the background of the user's window", async () => {
    await stub.chrome.storage.local.set({ agentTabsGrouping: "none" })
    const { user, userTab } = await userWindow()
    const agent = await agentTab("github")
    expect(agent.groupId).toBe(-1)
    expect(tab(agent.tabId)).toMatchObject({ windowId: user.id, groupId: -1, active: false })
    expect(stub.state.groups.size).toBe(0)
    const popup = await stub.chrome.tabs.create({ windowId: user.id, url: "https://popup.example/", active: true })
    event("tabs.onActivated").emit({ tabId: popup.id, windowId: user.id })
    event("webNavigation.onCreatedNavigationTarget").emit({ sourceTabId: agent.tabId, tabId: popup.id })
    await until(() => opened().length === 1)
    expect(tab(popup.id).groupId).toBe(-1)
    expect(tab(userTab).active).toBe(true)
    expect(await TabCleanup.isTracked(popup.id)).toBe(true)
    // A handoff has no group to open; the page card and badge do the work.
    await command("pageStatus.set", { tabId: agent.tabId, status: { state: "waiting", owner: "session", sessionId: "github", handoffId: "h2", message: "Sign in" } })
    expect(stub.state.groups.size).toBe(0)
  })

  test("the relay ungrouping an ungrouped tab keeps it; detaching it (kill switch) closes it", async () => {
    await stub.chrome.storage.local.set({ agentTabsGrouping: "none" })
    await userWindow()
    const agent = await agentTab("github")
    await command("tabs.ungroup", { tabId: agent.tabId })
    expect(stub.state.tabs.has(agent.tabId)).toBe(true)
    await command("debugger.detach", { tabId: agent.tabId })
    expect(stub.state.tabs.has(agent.tabId)).toBe(false)
  })

  test("a tab still in a session group from before keeps it", async () => {
    await stub.chrome.storage.local.set({ agentTabsGrouping: "session" })
    await userWindow()
    const before = await agentTab("github")
    await stub.chrome.storage.local.set({ agentTabsGrouping: "none" })
    expect((await command("tabs.group", { tabId: before.tabId, sessionId: "github" })).groupId).toBe(before.groupId)
    expect(tab(before.tabId).groupId).toBe(before.groupId)
  })
})

describe("toolbar clicks that can't attach", () => {
  beforeEach(() => {
    stub.state.notifications.clear()
    stub.state.fileAccess = false
  })

  /** Sends the attach the relay makes after a click, with Chrome refusing it. */
  async function failedAttach(tabId: number, message: string) {
    const original = stub.chrome.debugger.attach
    stub.chrome.debugger.attach = async () => {
      throw new Error(message)
    }
    try {
      const id = nextCommand++
      socket().deliver({ id, method: "debugger.attach", params: { tabId } })
      await until(() => socket().received.some((entry) => entry.id === id))
      expect(socket().received.find((entry) => entry.id === id)!.error).toContain(message)
    } finally {
      stub.chrome.debugger.attach = original
    }
  }

  const notice = () => [...stub.state.notifications.values()][0] as { message: string } | undefined

  test("a chrome:// tab clicked while connected still reaches the relay, and a failed attach gets the friendly page message", async () => {
    const { userTab } = await userWindow()
    await stub.chrome.tabs.update(userTab, { url: "chrome://extensions" })
    await relay.attachTab(userTab)
    await toolbarClicked(userTab)
    expect(stub.state.notifications.size).toBe(0)
    await failedAttach(userTab, "Cannot access a chrome:// URL")
    await until(() => stub.state.notifications.size === 1)
    expect(notice()?.message).toBe("browse can't use this page. Chrome doesn't let extensions control browser pages or the Chrome Web Store.")
  })

  test("a chrome:// tab Chrome dropped from the debugger still sends a connected take-back", async () => {
    const { userTab } = await userWindow()
    await command("debugger.attach", { tabId: userTab })
    expect(relay.state().tabs.some((entry) => entry.tabId === userTab)).toBe(true)

    const original = stub.chrome.debugger.attach
    stub.chrome.debugger.attach = async () => {
      throw new Error("Cannot access a chrome:// URL")
    }
    try {
      await stub.chrome.tabs.update(userTab, { url: "chrome://extensions" })
      // Chrome drops the debugger on the navigation; recover can't reattach, so the extension forgets the tab while
      // the relay still has it as a target.
      event("debugger.onDetach").emit({ tabId: userTab }, "target_closed")
      // recover waits 45 ms before trying to attach again.
      await new Promise((resolve) => setTimeout(resolve, 60))
      await until(() => !relay.state().tabs.some((entry) => entry.tabId === userTab))

      await relay.attachTab(userTab)
      await toolbarClicked(userTab)
      expect(stub.state.notifications.size).toBe(0)
    } finally {
      stub.chrome.debugger.attach = original
    }
  })

  test("an attach with no click before it stays quiet", async () => {
    const { userTab } = await userWindow()
    await failedAttach(userTab, "The extensions gallery cannot be scripted.")
    expect(stub.state.notifications.size).toBe(0)
  })

  test("a file page clicked while connected is sent, and a failed attach names the file-access setting", async () => {
    const { userTab } = await userWindow()
    await stub.chrome.tabs.update(userTab, { url: "file:///tmp/report.html" })
    await relay.attachTab(userTab)
    await toolbarClicked(userTab)
    expect(stub.state.notifications.size).toBe(0)
    await failedAttach(userTab, "Cannot navigate to a file URL without local file access.")
    await until(() => stub.state.notifications.size === 1)
    expect(notice()?.message).toContain("Allow access to file URLs")
    expect(notice()?.message).toContain("chrome://extensions")
  })

  test("a file page clicked while the relay is away is refused before it is queued", async () => {
    const { userTab } = await userWindow()
    await stub.chrome.tabs.update(userTab, { url: "file:///tmp/report.html" })
    TabCleanup.track(userTab)
    socket().drop()
    expect(relay.state().status).not.toBe("connected")
    await relay.attachTab(userTab)
    expect(stub.state.notifications.size).toBe(1)
    expect(notice()?.message).toContain("Allow access to file URLs")
    // The click still takes an agent-opened tab off idle cleanup even though its page can't be queued.
    expect(await TabCleanup.isTracked(userTab)).toBe(false)
    relay.reconnect()
    await until(() => relay.state().status === "connected")
    expect(socket().received.some((entry) => entry.method === "toolbar.clicked" && entry.params?.tabId === userTab)).toBe(false)
  })
})

describe("relay settings", () => {
  test("the extension sends the cursor and input settings, again when they change, and never invalid values", async () => {
    // The first connection's settings went out with pairing (before beforeEach cleared the log); ask again.
    await stub.chrome.storage.local.set({ agentCursor: "always" })
    await until(() => settings().length === 1)
    expect(settings()[0]).toEqual({ cursor: "always", humanInput: "on" })
    await stub.chrome.storage.local.set({ humanInput: "off" })
    await until(() => settings().length === 2)
    expect(settings()[1]).toEqual({ cursor: "always", humanInput: "off" })
    await stub.chrome.storage.local.set({ agentCursor: "sometimes", humanInput: 3 })
    await until(() => settings().length === 3)
    expect(settings()[2]).toEqual({ cursor: "off", humanInput: "on" })
  })

  test("the relay's overrides show on the status page; unknown ones are dropped, and they go with the connection", async () => {
    await command("relay.settings", { overrides: { cursor: "always", humanInput: "maybe", agentWindow: "separate", other: 1 } })
    expect(relay.state().overrides).toEqual({ cursor: "always", agentWindow: "separate" })
    await command("relay.settings", { overrides: {} })
    expect(relay.state().overrides).toBeUndefined()
    await command("relay.settings", { overrides: { humanInput: "off" } })
    expect(relay.state().overrides).toEqual({ humanInput: "off" })
    const first = socket()
    first.drop()
    expect(relay.state().overrides).toBeUndefined()
    relay.reconnect()
    await until(() => socket() !== first && relay.state().status === "connected")
    // The new connection gets the settings right after pairing.
    await until(() => settings().length >= 1)
  })
})

describe("the relay's settings tool", () => {
  // What the status page listens to (status.ts bindChoice): every storage change, as it arrives.
  const pageSaw: Record<string, unknown>[] = []
  stub.chrome.storage.onChanged.addListener((changes: Record<string, { newValue?: unknown }>, area: string) => {
    if (area === "local") pageSaw.push(Object.fromEntries(Object.entries(changes).map(([key, change]) => [key, change.newValue])))
  })

  test("settings.get reads every setting, defaults for what was never set", async () => {
    expect(await command("settings.get", {})).toEqual({
      settings: { window: "current", grouping: "shared", idleMinutes: 10, cursor: "off", humanInput: "on", handoffNotifications: "recording" },
    })
  })

  test("settings.set writes storage, which the page and the relay follow, and new tabs use it", async () => {
    pageSaw.length = 0
    const result = await command("settings.set", { values: { grouping: "shared", cursor: "always", idleMinutes: 0, handoffNotifications: "always" } })
    expect(result.settings).toEqual({ window: "current", grouping: "shared", idleMinutes: 0, cursor: "always", humanInput: "on", handoffNotifications: "always" })
    expect(await stub.chrome.storage.local.get(["agentTabsGrouping", "agentCursor", "tabCleanupIdleMinutes", "handoffNotifications"])).toEqual({
      agentTabsGrouping: "shared", agentCursor: "always", tabCleanupIdleMinutes: 0, handoffNotifications: "always",
    })
    expect(pageSaw).toEqual([{ agentTabsGrouping: "shared", agentCursor: "always", tabCleanupIdleMinutes: 0, handoffNotifications: "always" }])
    await until(() => settings().length === 1)
    expect(settings()[0]).toEqual({ cursor: "always", humanInput: "on" })
    await userWindow()
    const agent = await agentTab("github")
    expect(group(agent.groupId)!.title).toBe(`Agents · 1${MARKER}${MARKER}`)
  })

  test("settings.set refuses an unknown setting or value and writes nothing", async () => {
    pageSaw.length = 0
    for (const values of [{ grouping: "Shared" }, { idleMinutes: 45 }, { grouping: "none", allowNode: true }]) {
      const id = nextCommand++
      socket().deliver({ id, method: "settings.set", params: { values } })
      await until(() => socket().received.some((message) => message.id === id))
      expect(socket().received.find((message) => message.id === id)!.error).toBeDefined()
    }
    expect(pageSaw).toEqual([])
    expect((await command("settings.get", {})).settings).toMatchObject({ grouping: "shared" })
  })
})
