import { beforeEach, describe, expect, test } from "bun:test"
import { pairingProof, randomNonce } from "../../src/background/pairing"
import { installChrome, settle, type StubEvent } from "../chrome-stub"

// Popup adoption (agent-relay.ts adoptOpened): a tab an agent's page opens joins the agent's tabs, and the relay
// hears of it (tabs.opened) once it is in place. Run by ../isolated.test.ts in a process of its own: the
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

beforeEach(async () => {
  stub.state.windows.clear()
  stub.state.tabs.clear()
  stub.state.focusedWindowId = undefined
  socket().received.length = 0
})

await until(() => relay.state().status === "connected")

describe("adoptOpened", () => {
  test("a tab that took over the user's window moves to the agent window, gives the user their tab back and joins the group", async () => {
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
