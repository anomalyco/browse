import { expect, test } from "bun:test"
import { installChrome, settle } from "../chrome-stub"

// An already-paired browser keeps listening where it proved itself: a pairing file's newer code must not pull it to
// another port while a token for the current one exists. Run by ../isolated.test.ts.

const stub = installChrome()
;(globalThis as { __OPENCODE_BROWSER_BUILD__?: string }).__OPENCODE_BROWSER_BUILD__ = "test"

const CODE = "0123ABCD"
const PROVEN_PORT = 19990
const FILE_PORT = 19991
const TOKEN = "paired-token-0123456789abcdefghijklmnopqrstuv"

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
  return url.endsWith("/relay-pairing.json")
    ? Response.json({ code: CODE, port: FILE_PORT })
    : new Response("not found", { status: 404 })
}) as unknown as typeof fetch
;(globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket

await stub.chrome.storage.local.set({
  agentRelayDiscoveredPort: PROVEN_PORT,
  agentRelayDiscoveredKind: "hint",
  agentRelayProvenPort: PROVEN_PORT,
  agentRelayTokens: { [`127.0.0.1:${PROVEN_PORT}`]: TOKEN },
})
const { createAgentRelay } = await import("../../src/background/agent-relay")
const relay = createAgentRelay({ changed: () => {}, badgesChanged: () => {} })
const stored = async (key: string): Promise<unknown> => (await stub.chrome.storage.local.get(key))[key]
async function until(check: () => boolean) {
  for (let i = 0; i < 400 && !check(); i++) await settle()
  expect(check()).toBe(true)
}

test("a pairing file does not override an already-paired proof", async () => {
  await until(() => FakeWebSocket.made.length > 0)
  expect(FakeWebSocket.made[0]!.url).toBe(`ws://127.0.0.1:${PROVEN_PORT}/extension`)
  expect(await stored("agentRelayDiscoveredPort")).toBe(PROVEN_PORT)
  expect(relay.state().pairing).toBe("token")
})
