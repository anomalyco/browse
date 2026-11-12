import { expect, test } from "bun:test"
import { installChrome, settle } from "../chrome-stub"

// A pending pairing code is only sent to the port it was given for (19988 without a hint). When 19988 belongs to
// another program and the relay is found on a fallback port by scanning, the code stays put: a wrong relay would
// refuse it, and a refusal spends it. Once the link names the port, the code goes there. Run by ../isolated.test.ts.

const stub = installChrome()
;(globalThis as { __OPENCODE_BROWSER_BUILD__?: string }).__OPENCODE_BROWSER_BUILD__ = "test"

const CODE = "0123ABCD"
const DEFAULT_PORT = 19988
const BROWSER_PORT = 19990

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
  readonly sent: string[] = []
  constructor(readonly url: string) {
    FakeWebSocket.made.push(this)
    const port = Number(/:(\d+)\//.exec(url)?.[1])
    setTimeout(() => {
      if (this.readyState === FakeWebSocket.CLOSED) return
      if (port === BROWSER_PORT) {
        this.readyState = FakeWebSocket.OPEN
        this.onopen?.({})
      } else {
        this.readyState = FakeWebSocket.CLOSED
        this.onclose?.({ code: 1006, reason: "", wasClean: true })
      }
    }, 0)
  }
  send(data: string) {
    this.sent.push(data)
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
  return port === BROWSER_PORT
    ? Response.json({ version: "0.0.2", instanceId: "abc" })
    : new Response("not found", { status: 404 })
}) as unknown as typeof fetch
;(globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket

await stub.chrome.storage.local.set({ agentRelayPairingCode: CODE })
const { createAgentRelay } = await import("../../src/background/agent-relay")
const relay = createAgentRelay({ changed: () => {}, badgesChanged: () => {} })
const socketsAt = (port: number) => FakeWebSocket.made.filter((socket) => socket.url === `ws://127.0.0.1:${port}/extension`)
async function until(check: () => boolean) {
  for (let i = 0; i < 400 && !check(); i++) await settle()
  expect(check()).toBe(true)
}

test("a code is never sent to a port only a scan found", async () => {
  await until(() => relay.state().relay.address === "localhost:19988" && socketsAt(BROWSER_PORT).length > 0)
  expect((await stub.chrome.storage.local.get("agentRelayDiscoveredPort")).agentRelayDiscoveredPort).toBe(BROWSER_PORT)
  const scanned = socketsAt(BROWSER_PORT)[0]!
  await until(() => scanned.sent.length > 0)
  // Presence only: no hello, so the code (and this browser's identity) never reaches it.
  expect(scanned.sent.map((data) => JSON.parse(data))).toEqual([
    { method: "protocol", params: { protocolVersion: 3, unpaired: true } },
  ])
  expect(scanned.sent.join("")).not.toContain(CODE)
  expect(relay.state().pairing).toBe("none")
})

test("a link that names the port lets the code go there", async () => {
  const before = socketsAt(BROWSER_PORT).length
  expect(await relay.pairLink(CODE, BROWSER_PORT)).toBe(true)
  // One write records the code and the port it is for; there is no moment where the code exists without its port.
  expect((await stub.chrome.storage.local.get("agentRelayCodePort")).agentRelayCodePort).toBe(BROWSER_PORT)
  await until(() => socketsAt(BROWSER_PORT).length > before)
  const hinted = socketsAt(BROWSER_PORT).at(-1)!
  await until(() => hinted.sent.some((data) => JSON.parse(data).method === "hello"))
  const hello = hinted.sent.map((data) => JSON.parse(data)).find((message) => message.method === "hello")
  expect(hello.params.pairing.mode).toBe("code")
  expect(relay.state().pairing).toBe("code")
})

test("a link without a port clears the port it was on and points the code at 19988", async () => {
  const before = socketsAt(DEFAULT_PORT).length
  expect(await relay.pairLink(CODE)).toBe(true)
  await until(() => socketsAt(DEFAULT_PORT).length > before)
  expect((await stub.chrome.storage.local.get("agentRelayCodePort")).agentRelayCodePort).toBe(DEFAULT_PORT)
  expect((await stub.chrome.storage.local.get("agentRelayDiscoveredPort")).agentRelayDiscoveredPort).toBeUndefined()
  expect(socketsAt(DEFAULT_PORT).at(-1)!.url).toBe(`ws://127.0.0.1:${DEFAULT_PORT}/extension`)
})
