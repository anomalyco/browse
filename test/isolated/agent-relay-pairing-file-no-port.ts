import { expect, test } from "bun:test"
import { installChrome, settle } from "../chrome-stub"

// A pairing file without a port says nothing about where the relay is: it must not pull a discovered or proven port
// back to 19988. Run by ../isolated.test.ts.

const stub = installChrome()
;(globalThis as { __OPENCODE_BROWSER_BUILD__?: string }).__OPENCODE_BROWSER_BUILD__ = "test"

const CODE = "0123ABCD"
const PORT = 19990

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
    setTimeout(() => {
      this.readyState = FakeWebSocket.OPEN
      this.onopen?.({})
    }, 0)
  }
  send() {}
  close() {}
}

globalThis.fetch = (async (input: string | URL) => {
  const url = String(input)
  return url.endsWith("/relay-pairing.json") ? Response.json({ code: CODE }) : new Response("not found", { status: 404 })
}) as unknown as typeof fetch
;(globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket

await stub.chrome.storage.local.set({
  agentRelayDiscoveredPort: PORT,
  agentRelayDiscoveredKind: "hint",
  agentRelayProvenPort: PORT,
})
const { createAgentRelay } = await import("../../src/background/agent-relay")
const relay = createAgentRelay({ changed: () => {}, badgesChanged: () => {} })
const stored = async (key: string): Promise<unknown> => (await stub.chrome.storage.local.get(key))[key]
async function until(check: () => boolean) {
  for (let i = 0; i < 400 && !check(); i++) await settle()
  expect(check()).toBe(true)
}

test("a pairing file without a port does not override a discovered or proven port", async () => {
  await until(() => FakeWebSocket.made.length > 0)
  expect(FakeWebSocket.made[0]!.url).toBe(`ws://127.0.0.1:${PORT}/extension`)
  expect(await stored("agentRelayDiscoveredPort")).toBe(PORT)
  expect(await stored("agentRelayDiscoveredKind")).toBe("hint")
})
