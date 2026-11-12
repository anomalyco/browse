import { expect, test } from "bun:test"
import { installChrome, settle } from "../chrome-stub"

// A port only a scan found can answer /version like browse and then fail the handshake. That reply is not proof: the
// close must stay eligible for a scan, and the scan prefers 19988 or a port this browser holds a token for, so a fake
// listener can't keep the extension on itself. Run by ../isolated.test.ts in its own process.

const stub = installChrome()
;(globalThis as { __OPENCODE_BROWSER_BUILD__?: string }).__OPENCODE_BROWSER_BUILD__ = "test"

const SCANNED_PORT = 19990
const DEFAULT_PORT = 19988
const SCANNED_TOKEN = "scanned-token-0123456789abcdefghijklmnopqrst"
const DEFAULT_TOKEN = "default-token-0123456789abcdefghijklmnopqrst"

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
  closedWith: number | undefined
  private challenged = false
  constructor(readonly url: string) {
    FakeWebSocket.made.push(this)
    setTimeout(() => {
      if (this.readyState === FakeWebSocket.CLOSED) return
      this.readyState = FakeWebSocket.OPEN
      this.onopen?.({})
    }, 0)
  }
  send(data: string) {
    const message = JSON.parse(data) as Message
    this.received.push(message)
    // Only the scanned listener lies: it speaks the protocol, then proves nothing.
    if (this.url.includes(`:${SCANNED_PORT}/`) && message.method === "hello" && !this.challenged) {
      this.challenged = true
      setTimeout(() => this.onmessage?.({
        data: JSON.stringify({ method: "auth.challenge", params: { nonce: "n".repeat(32), proof: "not-a-proof" } }),
      }), 0)
    }
  }
  close(code = 1000, reason = "") {
    if (this.readyState === FakeWebSocket.CLOSED) return
    this.readyState = FakeWebSocket.CLOSED
    this.closedWith = code
    queueMicrotask(() => this.onclose?.({ code, reason, wasClean: false }))
  }
}

globalThis.fetch = (async (input: string | URL) => {
  const url = String(input)
  if (url.endsWith("/relay-pairing.json")) return new Response("not found", { status: 404 })
  const port = Number(/127\.0\.0\.1:(\d+)\/version/.exec(url)?.[1])
  return port === SCANNED_PORT || port === DEFAULT_PORT
    ? Response.json({ version: "0.0.2", instanceId: `listener-${port}`, pid: 1 })
    : new Response("not found", { status: 404 })
}) as unknown as typeof fetch
;(globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket

await stub.chrome.storage.local.set({
  agentRelayDiscoveredPort: SCANNED_PORT,
  agentRelayDiscoveredKind: "scan",
  agentRelayTokens: {
    [`127.0.0.1:${SCANNED_PORT}`]: SCANNED_TOKEN,
    [`127.0.0.1:${DEFAULT_PORT}`]: DEFAULT_TOKEN,
  },
})
const { createAgentRelay } = await import("../../src/background/agent-relay")
const relay = createAgentRelay({ changed: () => {}, badgesChanged: () => {} })
const stored = async (key: string): Promise<unknown> => (await stub.chrome.storage.local.get(key))[key]
const made = () => FakeWebSocket.made.map((socket) => socket.url)
async function until(check: () => boolean) {
  for (let i = 0; i < 400 && !check(); i++) await settle()
  expect(check()).toBe(true)
}

test("a bogus challenge on a scanned port is not proof, so the next scan moves to 19988", async () => {
  await until(() => FakeWebSocket.made.some((socket) => socket.url.includes(`:${SCANNED_PORT}/`) && socket.received.some((message) => message.method === "hello")))
  const scanned = FakeWebSocket.made.find((socket) => socket.url.includes(`:${SCANNED_PORT}/`))!
  // It answered, challenged, and never proved the token: that close must not pin the extension here.
  expect(scanned.received.find((message) => message.method === "hello")?.params?.pairing).toMatchObject({ mode: "token" })
  await until(() => scanned.closedWith !== undefined)
  expect(scanned.closedWith).toBe(4006)
  await until(() => FakeWebSocket.made.some((socket) => socket.url.includes(`:${DEFAULT_PORT}/`)))
  expect(made().at(-1)).toBe(`ws://127.0.0.1:${DEFAULT_PORT}/extension`)
  expect(await stored("agentRelayDiscoveredPort")).toBe(DEFAULT_PORT)
  expect(relay.state().relay).toEqual({ address: `localhost:${DEFAULT_PORT}`, remote: false })
})
