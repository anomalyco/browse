import { beforeEach, describe, expect, test } from "bun:test"
import { pairingProof, randomNonce } from "../../src/background/pairing"
import { installChrome, settle, type StubEvent } from "../chrome-stub"

// The status page's Grouping setting (agent-relay.ts group, agent-groups.ts): one group per session (the default), one
// shared "Agents · N" group for every agent, or none; with popups, handoffs, the toolbar's kill switch (the relay
// detaching a tab) and both window modes. Also the relay-side settings the extension sends (cursor, human input) and
// the environment overrides the relay reports back. Run by ../isolated.test.ts in a process of its own.

const stub = installChrome()
;(globalThis as { __OPENCODE_BROWSER_BUILD__?: string }).__OPENCODE_BROWSER_BUILD__ = "test"
const CODE = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
const PORT = 19908
const MARKER = "\u2063"
type Message = { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown }

/** The relay's side of the link: answers the pairing handshake, records what the extension sends. */
class FakeRelaySocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static current: FakeRelaySocket | undefined
  readonly received: Message[] = []
  readyState = FakeRelaySocket.CONNECTING
  onopen: ((event: unknown) => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: ((event: unknown) => void) | null = null
  constructor(readonly url: string) {
    FakeRelaySocket.current = this
    setTimeout(() => {
      this.readyState = FakeRelaySocket.OPEN
      this.onopen?.({})
    }, 0)
  }
  send(data: string) {
    const message = JSON.parse(data) as Message
    this.received.push(message)
    if (message.method === "hello") void this.challenge(String((message.params?.pairing as { nonce: string }).nonce))
  }
  private async challenge(extensionNonce: string) {
    const nonce = randomNonce()
    this.deliver({ method: "auth.challenge", params: { nonce, proof: await pairingProof(CODE, "relay", PORT, nonce, extensionNonce) } })
  }
  deliver(message: Message) {
    this.onmessage?.({ data: JSON.stringify(message) })
  }
  close() {}
}

globalThis.fetch = (async (input: string | URL) =>
  String(input).endsWith("/relay-pairing.json") ? Response.json({ code: CODE }) : new Response("not found", { status: 404 })) as typeof fetch
;(globalThis as { WebSocket: unknown }).WebSocket = FakeRelaySocket

await stub.chrome.storage.local.set({ agentRelayPort: PORT })
const { createAgentRelay } = await import("../../src/background/agent-relay")
const { TabCleanup } = await import("../../src/background/tab-cleanup")
const relay = createAgentRelay({ changed: () => {}, badgesChanged: () => {} })

async function until(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 300 && !(await check()); i++) await settle()
  expect(await check()).toBe(true)
}
const event = (path: string) => path.split(".").reduce<any>((value, key) => value[key], stub.chrome) as StubEvent
const socket = () => FakeRelaySocket.current!
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

const group = (groupId: number) => stub.state.groups.get(groupId)
const tab = (tabId: number) => stub.state.tabs.get(tabId)!

beforeEach(async () => {
  stub.state.windows.clear()
  stub.state.tabs.clear()
  stub.state.groups.clear()
  stub.state.activations.length = 0
  stub.state.focusedWindowId = undefined
  socket().received.length = 0
  await stub.chrome.storage.local.remove(["agentTabsWindow", "agentTabsGrouping", "agentCursor", "humanInput"])
  await stub.chrome.storage.session.remove("agentWindowId")
})

await until(() => relay.state().status === "connected")

describe("grouping: one group per session (default)", () => {
  test("each session gets its own collapsed group named after it", async () => {
    const { user, userTab } = await userWindow()
    const first = await agentTab("github")
    const second = await agentTab("linear")
    const again = await agentTab("github")
    expect(first.groupId).not.toBe(second.groupId)
    expect(again.groupId).toBe(first.groupId)
    expect(group(first.groupId)).toMatchObject({ windowId: user.id, title: `github${MARKER}`, collapsed: true })
    expect(group(second.groupId)).toMatchObject({ windowId: user.id, title: `linear${MARKER}`, collapsed: true })
    expect(tab(userTab).active).toBe(true)
  })
})

describe("grouping: one shared group for all agents", () => {
  test("two sessions share one collapsed group that counts its tabs", async () => {
    await stub.chrome.storage.local.set({ agentTabsGrouping: "shared" })
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
    await userWindow()
    const before = await agentTab("github")
    await stub.chrome.storage.local.set({ agentTabsGrouping: "none" })
    expect((await command("tabs.group", { tabId: before.tabId, sessionId: "github" })).groupId).toBe(before.groupId)
    expect(tab(before.tabId).groupId).toBe(before.groupId)
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
    first.readyState = FakeRelaySocket.CLOSED
    first.onclose?.({ code: 1006, reason: "", wasClean: false })
    expect(relay.state().overrides).toBeUndefined()
    relay.reconnect()
    await until(() => socket() !== first && relay.state().status === "connected")
    // The new connection gets the settings right after pairing.
    await until(() => settings().length >= 1)
  })
})
