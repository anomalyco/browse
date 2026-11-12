import { expect, test } from "bun:test"
import { installChrome, settle } from "../chrome-stub"

// A pairing code typed without a port must never be carried to a port only a scan found: someone else can answer
// /version like browse there. It goes to 19988 instead, and the scanned port is forgotten so the next attempt starts
// from the default. Run by ../isolated.test.ts in its own process.

const stub = installChrome()
;(globalThis as { __OPENCODE_BROWSER_BUILD__?: string }).__OPENCODE_BROWSER_BUILD__ = "test"

const SCANNED_PORT = 19990
const DEFAULT_PORT = 19988
const CODE = "ZZZZZZZZ"

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
      if (this.readyState === FakeWebSocket.CLOSED) return
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
})
const { createAgentRelay } = await import("../../src/background/agent-relay")
const relay = createAgentRelay({ changed: () => {}, badgesChanged: () => {} })
const stored = async (key: string): Promise<unknown> => (await stub.chrome.storage.local.get(key))[key]
const at = (port: number) => FakeWebSocket.made.filter((socket) => socket.url.includes(`:${port}/`))
async function until(check: () => boolean) {
  for (let i = 0; i < 400 && !check(); i++) await settle()
  expect(check()).toBe(true)
}

test("a code entered while the discovered port is scan-only goes to 19988, not the scanned port", async () => {
  await until(() => at(SCANNED_PORT).some((socket) => socket.received.length > 0))
  // A scan-only port no connection has authenticated is not offered in the form.
  expect(relay.state().relay).toEqual({ address: `localhost:${DEFAULT_PORT}`, remote: false })
  const scannedBefore = at(SCANNED_PORT).length
  void relay.connectTo(`localhost:${DEFAULT_PORT}`, CODE)
  await until(() => at(DEFAULT_PORT).some((socket) => socket.received.some((message) => message.method === "hello")))
  const hello = at(DEFAULT_PORT).at(-1)!.received.find((message) => message.method === "hello")
  expect(hello?.params?.pairing).toMatchObject({ mode: "code" })
  expect(await stored("agentRelayPairingCode")).toBe(CODE)
  expect(await stored("agentRelayCodePort")).toBe(DEFAULT_PORT)
  expect(await stored("agentRelayAddress")).toBe("")
  // The scanned port is forgotten (or re-established as the default), and it never got the code.
  expect(await stored("agentRelayDiscoveredPort")).not.toBe(SCANNED_PORT)
  expect(at(SCANNED_PORT).length).toBe(scannedBefore)
  expect(at(SCANNED_PORT).every((socket) => socket.received.every((message) => message.method !== "hello"))).toBe(true)
})
