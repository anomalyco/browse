import { beforeEach, describe, expect, test } from "bun:test"
import { extensionProtocolVersion } from "../../cli/src/protocol"
import { installChrome, settle, type StubEvent } from "../chrome-stub"
import { installFakeRelaySocket, type RelayWireMessage } from "../relay-stub"

// Toolbar clicks that wait for the relay: the queue in chrome.storage.session, the "…" badge that says so, and what
// happens when an agent's browse starts the relay, the user clicks again, or the worker stops and another one restores
// the queue. Run by ../isolated.test.ts in a process of its own.

const stub = installChrome()
;(globalThis as { __OPENCODE_BROWSER_BUILD__?: string }).__OPENCODE_BROWSER_BUILD__ = "test"
const TOKEN = "test-token-0123456789abcdefghijklmnopqrstuv"
const PORT = 19910
/** The key agent-relay.ts keeps the queue under. */
const KEY = "agentRelayPendingClicks"
const WAITING = {
  text: "…",
  title: "browse is waiting for the relay, which starts when an agent next uses browse. Click again to cancel.",
}
const TAKE_BACK = {
  text: "…",
  title: "browse will take this tab back when the relay connects, which happens when an agent next uses browse. Click again to cancel.",
}

/** Nothing listens on the port: every attempt is refused, as it is while no relay runs. */
class NoRelaySocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  readyState = NoRelaySocket.CLOSED
  onopen: ((event: unknown) => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: ((event: unknown) => void) | null = null
  constructor(readonly url: string) {
    // A microtask, so the close lands after the connection code attached its handlers; nothing is left connecting.
    queueMicrotask(() => this.onclose?.({ code: 1006, reason: "", wasClean: false }))
  }
  send() {}
  close() {
    this.readyState = NoRelaySocket.CLOSED
    this.onclose?.({ code: 1000, reason: "", wasClean: true })
  }
}

/** A port that accepts the socket and never answers: the click waits, and the worker has nothing to do but stop. */
class HungSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  readyState = HungSocket.CONNECTING
  onopen: ((event: unknown) => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: ((event: unknown) => void) | null = null
  constructor(readonly url: string) {}
  send() {}
  close() {
    this.readyState = HungSocket.CLOSED
    this.onclose?.({ code: 1000, reason: "", wasClean: true })
  }
}

const { createAgentRelay } = await import("../../src/background/agent-relay")

async function until(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 400 && !(await check()); i++) await settle()
  expect(await check()).toBe(true)
}

/** The queue as chrome.storage.session has it. */
const queued = async () =>
  ((await stub.chrome.storage.session.get(KEY))[KEY] ?? []) as { tabId: number; lending: boolean }[]

const tab = async (url = "https://example.com/") => (await stub.chrome.windows.create({ url, focused: true })).tabs[0]!.id

let nextCommand = 1
async function command(
  link: () => { deliver(message: RelayWireMessage): void; received: RelayWireMessage[] },
  method: string,
  params: Record<string, unknown>,
) {
  const id = nextCommand++
  link().deliver({ id, method, params })
  await until(() => link().received.some((message) => message.id === id))
}

/** Reconnects until the relay answers: a call made while an attempt is still in flight is a no-op. */
async function connect(relay: ReturnType<typeof createAgentRelay>) {
  for (let i = 0; i < 100 && relay.state().status !== "connected"; i++) {
    relay.reconnect()
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  await until(() => relay.state().status === "connected")
}

beforeEach(async () => {
  stub.state.windows.clear()
  stub.state.tabs.clear()
  stub.state.groups.clear()
  stub.state.focusedWindowId = undefined
  stub.state.lastFocusedWindowId = undefined
  stub.state.notifications.clear()
  stub.state.permissionLevel = "granted"
  globalThis.WebSocket = NoRelaySocket as unknown as typeof WebSocket
  await stub.chrome.storage.session.remove(KEY)
  await stub.chrome.storage.local.set({ agentRelayPort: PORT, agentRelayTokens: { [`127.0.0.1:${PORT}`]: TOKEN } })
})

describe("toolbar clicks that wait for the relay", () => {
  test("a click is queued, shows the badge, survives in storage, and goes once the relay answers", async () => {
    const relay = createAgentRelay({ changed: () => {}, badgesChanged: () => {} })
    await until(() => relay.state().status === "offline")
    const tabId = await tab()
    await relay.attachTab(tabId)
    expect(relay.badge(tabId)).toEqual(WAITING)
    await until(async () => (await queued()).length === 1)
    expect(await queued()).toEqual([{ tabId, lending: true }])

    await settle() // the attempt the click started is refused before the relay appears
    const socket = installFakeRelaySocket({ port: PORT, token: TOKEN })
    await connect(relay)
    await until(() => socket().received.some((message) => message.method === "toolbar.clicked" && message.params?.tabId === tabId))
    expect(socket().received.filter((message) => message.method === "toolbar.clicked" && message.params?.tabId === tabId)).toHaveLength(1)
    expect(relay.badge(tabId)).toBeUndefined()
    await until(async () => (await queued()).length === 0)
  })

  test("a click queued by the worker before is restored, and a tab that closed meanwhile is dropped", async () => {
    // A relay that hangs: the first worker queues the click and stays alive with nothing to do, like a worker that
    // never gets an answer and is stopped before one comes.
    globalThis.WebSocket = HungSocket as unknown as typeof WebSocket
    const first = createAgentRelay({ changed: () => {}, badgesChanged: () => {} })
    const kept = await tab("https://kept.example/")
    const closed = await tab("https://closed.example/")
    await first.attachTab(kept)
    await first.attachTab(closed)
    await until(async () => (await queued()).length === 2)

    // The tab closes while no worker runs: session storage still lists it, and the next worker has to drop it.
    stub.state.tabs.delete(closed)

    globalThis.WebSocket = NoRelaySocket as unknown as typeof WebSocket
    const second = createAgentRelay({ changed: () => {}, badgesChanged: () => {} })
    await until(() => second.badge(kept) !== undefined)
    expect(second.badge(kept)).toEqual(WAITING)
    expect(second.badge(closed)).toBeUndefined()
    await until(async () => (await queued()).length === 1)
    expect(await queued()).toEqual([{ tabId: kept, lending: true }])

    await settle()
    const socket = installFakeRelaySocket({ port: PORT, token: TOKEN })
    await connect(second)
    await until(() => socket().received.some((message) => message.method === "toolbar.clicked" && message.params?.tabId === kept))
    expect(socket().received.some((message) => message.method === "toolbar.clicked" && message.params?.tabId === closed)).toBe(false)
    expect(second.badge(kept)).toBeUndefined()
    await until(async () => (await queued()).length === 0)
  })

  test("a second click while the relay is away cancels the queued one and clears storage", async () => {
    const relay = createAgentRelay({ changed: () => {}, badgesChanged: () => {} })
    await until(() => relay.state().status === "offline")
    const tabId = await tab()
    await relay.attachTab(tabId)
    expect(relay.badge(tabId)).toEqual(WAITING)
    await until(async () => (await queued()).length === 1)

    await relay.attachTab(tabId)
    expect(relay.badge(tabId)).toBeUndefined()
    await until(async () => (await queued()).length === 0)

    await settle()
    const socket = installFakeRelaySocket({ port: PORT, token: TOKEN })
    await connect(relay)
    await settle()
    expect(socket().received.some((message) => message.method === "toolbar.clicked")).toBe(false)
  })

  test("a queued take-back says the tab will be taken back when the relay connects", async () => {
    const socket = installFakeRelaySocket({ port: PORT, token: TOKEN })
    const relay = createAgentRelay({ changed: () => {}, badgesChanged: () => {} })
    await until(() => relay.state().status === "connected")
    const tabId = await tab()
    await command(socket, "debugger.attach", { tabId })

    socket().drop()
    globalThis.WebSocket = NoRelaySocket as unknown as typeof WebSocket
    await relay.attachTab(tabId)
    await settle()
    expect(relay.badge(tabId)).toEqual(TAKE_BACK)
    await until(async () => (await queued()).length === 1)
    expect(await queued()).toEqual([{ tabId, lending: false }])

    const again = installFakeRelaySocket({ port: PORT, token: TOKEN })
    await connect(relay)
    await until(() => again().received.some((message) => message.method === "toolbar.clicked" && message.params?.tabId === tabId))
    expect(relay.badge(tabId)).toBeUndefined()
    await until(async () => (await queued()).length === 0)
  })

  test("a relay on another protocol version drops the queue, since every click goes to the setup page then", async () => {
    const relay = createAgentRelay({ changed: () => {}, badgesChanged: () => {} })
    await until(() => relay.state().status === "offline")
    const tabId = await tab()
    await relay.attachTab(tabId)
    expect(relay.badge(tabId)).toEqual(WAITING)
    await until(async () => (await queued()).length === 1)

    const socket = installFakeRelaySocket({ port: PORT, token: TOKEN })
    // The relay answers with a protocol range this extension is newer than (cli/src/protocol): update-cli.
    const Fake = globalThis.WebSocket as unknown as { prototype: { deliver(message: RelayWireMessage): void } }
    const deliver = Fake.prototype.deliver as (this: unknown, message: RelayWireMessage) => void
    Fake.prototype.deliver = function (this: unknown, message: RelayWireMessage) {
      if (message.method === "auth.challenge" && message.params)
        message.params = { ...message.params, protocol: { version: extensionProtocolVersion - 1 } }
      deliver.call(this, message)
    }
    relay.reconnect()
    // A reconnect while the refused attempt is still in flight is a no-op, so keep asking until it lands.
    for (let i = 0; i < 100 && relay.state().status !== "incompatible"; i++) {
      relay.reconnect()
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    await until(() => relay.state().status === "incompatible")
    expect(relay.state().skew).toBe("update-cli")
    await until(async () => (await queued()).length === 0)
    expect(relay.badge(tabId)).toBeUndefined()
    await settle()
    expect(socket().received.some((message) => message.method === "toolbar.clicked")).toBe(false)
  })

  test("a click that lands while the queue is being flushed takes the queued one back", async () => {
    const relay = createAgentRelay({ changed: () => {}, badgesChanged: () => {} })
    await until(() => relay.state().status === "offline")
    const tabId = await tab()
    await relay.attachTab(tabId)
    await until(async () => (await queued()).length === 1)

    const socket = installFakeRelaySocket({ port: PORT, token: TOKEN })
    // The click lands in the instant between the relay proving itself and the queue going out. The extension has no
    // event for that, so make the click from the socket, while it answers the handshake.
    const Fake = globalThis.WebSocket as unknown as { prototype: { send(data: string): void } }
    const send = Fake.prototype.send as (this: unknown, data: string) => void
    let clicked = false
    Fake.prototype.send = function (this: unknown, data: string) {
      send.call(this, data)
      if (clicked || (JSON.parse(data) as RelayWireMessage).method !== "auth.response") return
      clicked = true
      void relay.attachTab(tabId)
    }
    await connect(relay)
    expect(clicked).toBe(true)
    await until(async () => (await queued()).length === 0)
    expect(relay.badge(tabId)).toBeUndefined()
    await settle()
    expect(socket().received.some((message) => message.method === "toolbar.clicked")).toBe(false)
  })

  test("a queued tab that closes takes its storage entry with it", async () => {
    const relay = createAgentRelay({ changed: () => {}, badgesChanged: () => {} })
    await until(() => relay.state().status === "offline")
    const tabId = await tab()
    await relay.attachTab(tabId)
    await until(async () => (await queued()).length === 1)

    await stub.chrome.tabs.remove(tabId)
    await until(async () => (await queued()).length === 0)
    expect(relay.badge(tabId)).toBeUndefined()
  })

  test("a tab that closes while the queue is restoring isn't queued", async () => {
    const tabId = await tab()
    // A worker that stopped left the click behind; the next one asks Chrome about the tab to see if it is still there.
    await stub.chrome.storage.session.set({ [KEY]: [{ tabId, lending: true }] })
    const get = stub.chrome.tabs.get.bind(stub.chrome.tabs)
    let closed = false
    stub.chrome.tabs.get = async (id: number) => {
      const tab = await get(id)
      if (id === tabId && !closed) {
        closed = true
        // The close lands while the answer is on its way back to the restore.
        ;(stub.chrome.tabs as unknown as { onRemoved: StubEvent }).onRemoved.emit(id, {
          windowId: tab.windowId,
          isWindowClosing: false,
        })
      }
      return tab
    }
    try {
      const relay = createAgentRelay({ changed: () => {}, badgesChanged: () => {} })
      await until(async () => (await queued()).length === 0)
      expect(relay.badge(tabId)).toBeUndefined()
    } finally {
      stub.chrome.tabs.get = get
    }
  })

  test("a click that wakes the worker before it finds the browser unpaired isn't queued", async () => {
    // No token, no code: the connection check that starts with the worker makes it unpaired.
    await stub.chrome.storage.local.remove(["agentRelayTokens", "agentRelayPairingCode"])
    const tabId = await tab()
    // Chrome is slow to answer about the page, so the click is still in flight when the status flips.
    const get = stub.chrome.tabs.get.bind(stub.chrome.tabs)
    stub.chrome.tabs.get = async (id: number) => {
      await new Promise((resolve) => setTimeout(resolve, 50))
      return get(id)
    }
    try {
      const relay = createAgentRelay({ changed: () => {}, badgesChanged: () => {} })
      expect(relay.state().status).toBe("offline")
      await relay.attachTab(tabId)
      await until(() => relay.state().status === "unpaired")
      expect(relay.badge(tabId)).toBeUndefined()
      await settle()
      expect(await queued()).toEqual([])
    } finally {
      stub.chrome.tabs.get = get
    }
  })
})
