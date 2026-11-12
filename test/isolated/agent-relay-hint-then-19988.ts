import { expect, test } from "bun:test"
import { installChrome, settle } from "../chrome-stub"

// A relay address typed as localhost:<fallback port> with a code is a hint, not a pin: the address stays automatic, the
// code goes to that port, and when that port later fails a scan can move back to 19988. Run by ../isolated.test.ts.

const stub = installChrome()
;(globalThis as { __OPENCODE_BROWSER_BUILD__?: string }).__OPENCODE_BROWSER_BUILD__ = "test"

const HINT_PORT = 19990
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
  return port === HINT_PORT || port === DEFAULT_PORT
    ? Response.json({ version: "0.0.2", instanceId: `listener-${port}`, pid: 1 })
    : new Response("not found", { status: 404 })
}) as unknown as typeof fetch
;(globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket

const { createAgentRelay } = await import("../../src/background/agent-relay")
const relay = createAgentRelay({ changed: () => {}, badgesChanged: () => {} })
const stored = async (key: string): Promise<unknown> => (await stub.chrome.storage.local.get(key))[key]
const at = (port: number) => FakeWebSocket.made.filter((socket) => socket.url.includes(`:${port}/`))
async function until(check: () => boolean) {
  for (let i = 0; i < 400 && !check(); i++) await settle()
  expect(check()).toBe(true)
}

test("localhost:19990 with a code is a hint; a later failure scans back to 19988", async () => {
  await until(() => at(DEFAULT_PORT).some((socket) => socket.received.length > 0))
  void relay.connectTo(`localhost:${HINT_PORT}`, CODE)
  await until(() => at(HINT_PORT).some((socket) => socket.received.some((message) => message.method === "hello")))
  // The code goes to the port the user named, but the saved address stays automatic.
  expect(at(HINT_PORT).at(-1)!.received.find((message) => message.method === "hello")?.params?.pairing).toMatchObject({ mode: "code" })
  expect(await stored("agentRelayAddress")).toBe("")
  expect(await stored("agentRelayDiscoveredPort")).toBe(HINT_PORT)
  expect(await stored("agentRelayDiscoveredKind")).toBe("hint")
  expect(await stored("agentRelayCodePort")).toBe(HINT_PORT)
  // Now the hint port fails, and a scan finds 19988.
  at(HINT_PORT).at(-1)!.close(1006)
  await until(() => at(DEFAULT_PORT).length > 1 && at(DEFAULT_PORT).at(-1)!.readyState === FakeWebSocket.OPEN)
  expect(await stored("agentRelayDiscoveredPort")).toBe(DEFAULT_PORT)
  expect(await stored("agentRelayAddress")).toBe("")
  expect(relay.state().relay).toEqual({ address: `localhost:${DEFAULT_PORT}`, remote: false })
  // The code stayed with its own port: 19988 got presence only.
  const last = at(DEFAULT_PORT).at(-1)!
  expect(last.received.map((message) => message.method)).toEqual(["protocol"])
  expect(last.received).not.toContainEqual(expect.objectContaining({ method: "hello" }))
})
