import { beforeEach, describe, expect, test } from "bun:test"
import { pairingProof, randomNonce } from "../../src/background/pairing"
import { installChrome, settle, type StubEvent } from "../chrome-stub"

// Where agent tabs open (tabs.create, tabs.group) and popup adoption (agent-relay.ts adoptOpened): a tab an agent's
// page opens joins the agent's tabs, and the relay hears of it (tabs.opened) once it is in place. Both with agent tabs
// in the user's window (the default) and in a separate agent window. Run by ../isolated.test.ts in a process of its own: the
// relay it creates registers chrome listeners and a WebSocket that must not meet the other files' relays.

const stub = installChrome()
;(globalThis as { __OPENCODE_BROWSER_BUILD__?: string }).__OPENCODE_BROWSER_BUILD__ = "test"
const CODE = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
const PORT = 19907
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

async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await settle()
  expect(check()).toBe(true)
}
const event = (path: string) => path.split(".").reduce<any>((value, key) => value[key], stub.chrome) as StubEvent
const socket = () => FakeRelaySocket.current!
let nextCommand = 1
async function command(method: string, params: Record<string, unknown>) {
  const id = nextCommand++
  socket().deliver({ id, method, params })
  await until(() => socket().received.some((message) => message.id === id))
  return socket().received.find((message) => message.id === id)!
}
const opened = () => socket().received.filter((message) => message.method === "tabs.opened").map((message) => message.params)

/** The user's focused window with their active tab, the agent window with the agent's tab (grouped), attached and tracked. */
async function scene() {
  const user = await stub.chrome.windows.create({ url: "https://user.example/", focused: true })
  const userTab = user.tabs[0]!.id
  event("tabs.onActivated").emit({ tabId: userTab, windowId: user.id })
  const agent = await stub.chrome.windows.create({ url: "https://agent.example/", focused: false })
  await stub.chrome.storage.session.set({ agentWindowId: agent.id })
  const agentTab = agent.tabs[0]!.id
  await stub.chrome.tabs.group({ tabIds: [agentTab], groupId: 7 })
  expect((await command("debugger.attach", { tabId: agentTab })).error).toBeUndefined()
  TabCleanup.track(agentTab)
  return { user, userTab, agent, agentTab }
}

/** The user's focused window with their active tab, and the agent's background tab in it (grouped), attached and tracked. */
async function sharedScene() {
  const user = await stub.chrome.windows.create({ url: "https://user.example/", focused: true })
  const userTab = user.tabs[0]!.id
  event("tabs.onActivated").emit({ tabId: userTab, windowId: user.id })
  const agentTab = (await stub.chrome.tabs.create({ windowId: user.id, url: "https://agent.example/", active: false })).id
  await stub.chrome.tabs.group({ tabIds: [agentTab], groupId: 8 })
  expect((await command("debugger.attach", { tabId: agentTab })).error).toBeUndefined()
  TabCleanup.track(agentTab)
  return { user, userTab, agentTab }
}

/** Neither a window focused nor a tab activated other than giving the user back `userTab`. */
function nothingActivated(userTab?: number) {
  expect(stub.state.activations.filter((item) => !("tabId" in item && item.tabId === userTab))).toEqual([])
}

beforeEach(async () => {
  stub.state.windows.clear()
  stub.state.tabs.clear()
  stub.state.groups.clear()
  stub.state.activations.length = 0
  stub.state.focusedWindowId = undefined
  socket().received.length = 0
  await stub.chrome.storage.local.remove("agentTabsWindow")
  await stub.chrome.storage.session.remove("agentWindowId")
})

await until(() => relay.state().status === "connected")

describe("tabs.create", () => {
  test("by default opens a background tab in the user's window, grouped and collapsed at the start", async () => {
    const user = await stub.chrome.windows.create({ url: "https://user.example/", focused: true })
    const userTab = user.tabs[0]!.id
    event("tabs.onActivated").emit({ tabId: userTab, windowId: user.id })
    const windows = stub.state.created.length
    const created = await command("tabs.create", { url: "https://example.com/", active: false })
    const tabId = (created.result as { tabId: number }).tabId
    const tab = stub.state.tabs.get(tabId)!
    expect(tab.windowId).toBe(user.id)
    expect(tab.active).toBe(false)
    expect(stub.state.created).toHaveLength(windows)
    const grouped = await command("tabs.group", { tabId, sessionId: "github" })
    const groupId = (grouped.result as { groupId: number }).groupId
    expect(stub.state.groups.get(groupId)).toMatchObject({ windowId: user.id, title: "github\u2063", collapsed: true })
    expect(stub.state.tabs.get(userTab)!.active).toBe(true)
    expect(stub.state.focusedWindowId).toBe(user.id)
    expect(await TabCleanup.isTracked(tabId)).toBe(true)
    nothingActivated()
  })

  test("with the separate setting opens it in the agent window, unfocused", async () => {
    await stub.chrome.storage.local.set({ agentTabsWindow: "separate" })
    const user = await stub.chrome.windows.create({ url: "https://user.example/", focused: true })
    const created = await command("tabs.create", { url: "https://example.com/", active: false })
    const tabId = (created.result as { tabId: number }).tabId
    const agentWindow = await stub.chrome.storage.session.get("agentWindowId")
    expect(stub.state.tabs.get(tabId)!.windowId).toBe(agentWindow.agentWindowId as number)
    expect(stub.state.tabs.get(tabId)!.windowId).not.toBe(user.id)
    const grouped = await command("tabs.group", { tabId, sessionId: "github" })
    expect(stub.state.groups.get((grouped.result as { groupId: number }).groupId)!.windowId).toBe(stub.state.tabs.get(tabId)!.windowId)
    expect(stub.state.focusedWindowId).toBe(user.id)
    nothingActivated()
  })

  test("the relay's window param (OPENCODE_BROWSER_AGENT_WINDOW) overrides the setting", async () => {
    const user = await stub.chrome.windows.create({ url: "https://user.example/", focused: true })
    const separate = await command("tabs.create", { url: "https://example.com/", active: false, window: "separate" })
    expect(stub.state.tabs.get((separate.result as { tabId: number }).tabId)!.windowId).not.toBe(user.id)
    await stub.chrome.storage.local.set({ agentTabsWindow: "separate" })
    const current = await command("tabs.create", { url: "https://example.com/", active: false, window: "current" })
    expect(stub.state.tabs.get((current.result as { tabId: number }).tabId)!.windowId).toBe(user.id)
    expect(stub.state.focusedWindowId).toBe(user.id)
    nothingActivated()
  })
})

describe("adoptOpened, agent tabs in the user's window", () => {
  test("a popup that took over the user's window stays there, gives the user their tab back and joins the group", async () => {
    const { user, userTab, agentTab } = await sharedScene()
    const popup = await stub.chrome.tabs.create({ windowId: user.id, url: "https://popup.example/", active: true })
    event("tabs.onActivated").emit({ tabId: popup.id, windowId: user.id })
    event("webNavigation.onCreatedNavigationTarget").emit({ sourceTabId: agentTab, tabId: popup.id })
    await until(() => opened().length === 1)
    const adopted = stub.state.tabs.get(popup.id)!
    expect(adopted.windowId).toBe(user.id)
    expect(adopted.groupId).toBe(8)
    expect(adopted.active).toBe(false)
    expect(stub.state.tabs.get(userTab)!.active).toBe(true)
    expect(stub.state.focusedWindowId).toBe(user.id)
    expect(await TabCleanup.isTracked(popup.id)).toBe(true)
    expect(opened()).toEqual([{ tabId: popup.id, openerTabId: agentTab }])
    nothingActivated(userTab)
  })

  test("a background popup stays where it opened and joins the group, activating nothing", async () => {
    const { user, userTab, agentTab } = await sharedScene()
    const popup = await stub.chrome.tabs.create({ windowId: user.id, url: "https://popup.example/", active: false })
    event("webNavigation.onCreatedNavigationTarget").emit({ sourceTabId: agentTab, tabId: popup.id })
    await until(() => opened().length === 1)
    expect(stub.state.tabs.get(popup.id)).toMatchObject({ windowId: user.id, groupId: 8, active: false })
    expect(stub.state.tabs.get(userTab)!.active).toBe(true)
    nothingActivated()
  })

  test("a popup window gives up focus and stays where it is", async () => {
    const { agentTab } = await sharedScene()
    const window = await stub.chrome.windows.create({ type: "popup", url: "https://popup.example/", focused: true })
    const popup = window.tabs[0]!.id
    event("webNavigation.onCreatedNavigationTarget").emit({ sourceTabId: agentTab, tabId: popup })
    await until(() => opened().length === 1)
    expect(stub.state.windows.get(window.id)!.focused).toBe(false)
    expect(stub.state.tabs.get(popup)!.windowId).toBe(window.id)
  })

  test("with an agent window open from the separate setting, a popup from a tab in the user's window still stays", async () => {
    const { user, agentTab } = await sharedScene()
    const agent = await stub.chrome.windows.create({ url: "https://other-agent.example/", focused: false })
    await stub.chrome.storage.session.set({ agentWindowId: agent.id })
    await stub.chrome.storage.local.set({ agentTabsWindow: "separate" })
    const popup = await stub.chrome.tabs.create({ windowId: user.id, url: "https://popup.example/", active: false })
    event("webNavigation.onCreatedNavigationTarget").emit({ sourceTabId: agentTab, tabId: popup.id })
    await until(() => opened().length === 1)
    expect(stub.state.tabs.get(popup.id)).toMatchObject({ windowId: user.id, groupId: 8 })
  })
})

describe("adoptOpened, agent tabs in a separate window", () => {
  test("a tab that took over the user's window moves to the agent window, gives the user their tab back and joins the group", async () => {
    await stub.chrome.storage.local.set({ agentTabsWindow: "separate" })
    const { user, userTab, agent, agentTab } = await scene()
    const popup = await stub.chrome.tabs.create({ windowId: user.id, url: "https://popup.example/", active: true })
    event("tabs.onActivated").emit({ tabId: popup.id, windowId: user.id })
    event("webNavigation.onCreatedNavigationTarget").emit({ sourceTabId: agentTab, tabId: popup.id })
    await until(() => opened().length === 1)
    const moved = stub.state.tabs.get(popup.id)!
    expect(moved.windowId).toBe(agent.id)
    expect(moved.groupId).toBe(7)
    expect(stub.state.tabs.get(userTab)!.active).toBe(true)
    expect(await TabCleanup.isTracked(popup.id)).toBe(true)
    // Only once it's in place does the relay hear of it.
    expect(opened()).toEqual([{ tabId: popup.id, openerTabId: agentTab }])
  })

  test("a popup window gives up focus but stays where it is", async () => {
    const { agentTab } = await scene()
    const window = await stub.chrome.windows.create({ type: "popup", url: "https://popup.example/", focused: true })
    const popup = window.tabs[0]!.id
    event("webNavigation.onCreatedNavigationTarget").emit({ sourceTabId: agentTab, tabId: popup })
    await until(() => opened().length === 1)
    expect(stub.state.windows.get(window.id)!.focused).toBe(false)
    expect(stub.state.tabs.get(popup)!.windowId).toBe(window.id)
    expect(opened()).toEqual([{ tabId: popup, openerTabId: agentTab }])
  })

  test("a tab opened from a lent tab stays the user's, and the relay still hears of it", async () => {
    const { user, userTab } = await scene()
    expect((await command("debugger.attach", { tabId: userTab })).error).toBeUndefined()
    const popup = await stub.chrome.tabs.create({ windowId: user.id, url: "https://popup.example/", active: true })
    event("webNavigation.onCreatedNavigationTarget").emit({ sourceTabId: userTab, tabId: popup.id })
    await until(() => opened().length === 1)
    expect(stub.state.tabs.get(popup.id)!.windowId).toBe(user.id)
    expect(await TabCleanup.isTracked(popup.id)).toBe(false)
    expect(opened()).toEqual([{ tabId: popup.id, openerTabId: userTab }])
  })

  test("a tab opened from a tab the relay doesn't drive is left alone and not reported", async () => {
    const { user, userTab } = await scene()
    const popup = await stub.chrome.tabs.create({ windowId: user.id, url: "https://popup.example/", active: true })
    event("webNavigation.onCreatedNavigationTarget").emit({ sourceTabId: userTab, tabId: popup.id })
    for (let i = 0; i < 20; i++) await settle()
    expect(stub.state.tabs.get(popup.id)!.windowId).toBe(user.id)
    expect(opened()).toEqual([])
  })
})
