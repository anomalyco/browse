import { expect, test } from "bun:test"
import { installChrome, settle } from "../chrome-stub"

// A saved loopback address pins a port outside the browse range (OPENCODE_BROWSER_PORT=9222). A welcome link without
// a browse-range port must keep that pin, and its code must go to 9222. Run by ../isolated.test.ts.

const stub = installChrome()
;(globalThis as { __OPENCODE_BROWSER_BUILD__?: string }).__OPENCODE_BROWSER_BUILD__ = "test"

const PINNED_PORT = 9222
const ADDRESS = `127.0.0.1:${PINNED_PORT}`

type Message = { method?: string; params?: Record<string, unknown> }

class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static readonly made: FakeWebSocket[] = []
  readyState = FakeWebSocket.CONNECTING
  onopen: ((event: unknown) => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: ((event: unknown) => void) | null = null
  readonly received: Message[] = []
  constructor(readonly url: string) {
    FakeWebSocket.made.push(this)
    setTimeout(() => {
      this.readyState = FakeWebSocket.OPEN
      this.onopen?.({})
    }, 0)
  }
  send(data: string) {
    this.received.push(JSON.parse(data) as Message)
  }
  close(code = 1000, reason = "") {
    if (this.readyState === FakeWebSocket.CLOSED) return
    this.readyState = FakeWebSocket.CLOSED
    queueMicrotask(() => this.onclose?.({ code, reason, wasClean: false }))
  }
}

globalThis.fetch = (async () => new Response("not found", { status: 404 })) as unknown as typeof fetch
;(globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket

await stub.chrome.storage.local.set({ agentRelayAddress: ADDRESS })
const { createAgentRelay } = await import("../../src/background/agent-relay")
const relay = createAgentRelay({ changed: () => {}, badgesChanged: () => {} })
const stored = async (key: string): Promise<unknown> => (await stub.chrome.storage.local.get(key))[key]
const atPinned = () => FakeWebSocket.made.filter((socket) => socket.url === `ws://${ADDRESS}/extension`)
async function until(check: () => boolean) {
  for (let i = 0; i < 400 && !check(); i++) await settle()
  expect(check()).toBe(true)
}

test("a link without a browse-range port keeps a saved out-of-range loopback address", async () => {
  await until(() => atPinned().length === 1 && atPinned()[0]!.received.length > 0)
  const before = atPinned().length
  void relay.pairLink("0123ABCD")
  await until(() => atPinned().length > before && atPinned().at(-1)!.received.some((message) => message.method === "hello"))
  expect(await stored("agentRelayAddress")).toBe(ADDRESS)
  expect(atPinned().at(-1)!.received.find((message) => message.method === "hello")?.params?.pairing).toMatchObject({ mode: "code" })
})

test("a link with &port=9222 also keeps it; the code port stays localhost:19988", async () => {
  const before = atPinned().length
  void relay.pairLink("ZYXW9876", PINNED_PORT)
  await until(() => atPinned().length > before && atPinned().at(-1)!.received.some((message) => message.method === "hello"))
  expect(await stored("agentRelayAddress")).toBe(ADDRESS)
  expect(await stored("agentRelayPairingCode")).toBe("ZYXW9876")
  expect(await stored("agentRelayCodePort")).toBe(19988)
})

test("submitting the shown pinned address with a code stays pinned and sends the code there", async () => {
  const before = atPinned().length
  void relay.connectTo(ADDRESS, "ABCD1234")
  await until(() => atPinned().length > before && atPinned().at(-1)!.received.some((message) => message.method === "hello"))
  expect(await stored("agentRelayAddress")).toBe(ADDRESS)
  expect(await stored("agentRelayCodePort")).toBe(PINNED_PORT)
  expect(atPinned().at(-1)!.received.find((message) => message.method === "hello")?.params?.pairing).toMatchObject({ mode: "code" })
})
