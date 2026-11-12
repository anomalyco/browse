import { expect, test } from "bun:test"
import { installChrome, settle } from "../chrome-stub"

// An explicit relay address (here the PORT_KEY dev pin) is dialled exactly as given and never scanned: a user who set
// an address means that one, and a scan could find someone else's relay. Run by ../isolated.test.ts in its own process.

const stub = installChrome()
;(globalThis as { __OPENCODE_BROWSER_BUILD__?: string }).__OPENCODE_BROWSER_BUILD__ = "test"

const PORT_KEY_PORT = 19925
const probes: string[] = []

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
  constructor(readonly url: string) {
    FakeWebSocket.made.push(this)
    // Nothing answers there.
    setTimeout(() => {
      this.readyState = FakeWebSocket.CLOSED
      this.onclose?.({ code: 1006, reason: "", wasClean: true })
    }, 0)
  }
  send() {}
  close() {}
}

globalThis.fetch = (async (input: string | URL) => {
  const url = String(input)
  if (!url.endsWith("/relay-pairing.json")) probes.push(url)
  return new Response("not found", { status: 404 })
}) as unknown as typeof fetch
;(globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket

await stub.chrome.storage.local.set({ agentRelayPort: PORT_KEY_PORT })
const { createAgentRelay } = await import("../../src/background/agent-relay")
const relay = createAgentRelay({ changed: () => {}, badgesChanged: () => {} })
async function until(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) await settle()
  expect(check()).toBe(true)
}

test("an explicit address never scans for a relay on a fallback port", async () => {
  await until(() => FakeWebSocket.made.length > 0)
  await until(() => FakeWebSocket.made[0]!.readyState === FakeWebSocket.CLOSED)
  // Another attempt, to give a (wrong) scan every chance to happen.
  relay.reconnect()
  await until(() => FakeWebSocket.made.length > 1)
  await settle()
  expect(probes).toEqual([])
  expect((await stub.chrome.storage.local.get("agentRelayDiscoveredPort")).agentRelayDiscoveredPort).toBeUndefined()
  expect(FakeWebSocket.made.every((socket) => socket.url === `ws://127.0.0.1:${PORT_KEY_PORT}/extension`)).toBe(true)
  expect(relay.state().relay).toEqual({ address: `localhost:${PORT_KEY_PORT}`, remote: false })
})
