import { expect, test } from "bun:test"
import { installChrome, settle } from "../chrome-stub"

// A pairing file that names a port browse never uses (19989 is Browser Control's) is ignored like any other bad
// value: the extension still dials 19988 and doesn't move. Run by ../isolated.test.ts in its own process.

const stub = installChrome()
;(globalThis as { __OPENCODE_BROWSER_BUILD__?: string }).__OPENCODE_BROWSER_BUILD__ = "test"

const CODE = "0123ABCD"
const OTHER_PORT = 19989

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
    setTimeout(() => {
      this.readyState = FakeWebSocket.OPEN
      this.onopen?.({})
    }, 0)
  }
  send(data: string) {
    this.sent.push(data)
  }
  close() {}
}

globalThis.fetch = (async (input: string | URL) => {
  const url = String(input)
  if (url.endsWith("/relay-pairing.json")) return Response.json({ code: CODE, port: OTHER_PORT })
  return new Response("not found", { status: 404 })
}) as unknown as typeof fetch
;(globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket

const { createAgentRelay } = await import("../../src/background/agent-relay")
const relay = createAgentRelay({ changed: () => {}, badgesChanged: () => {} })
const stored = async (key: string): Promise<unknown> => (await stub.chrome.storage.local.get(key))[key]
async function until(check: () => boolean) {
  for (let i = 0; i < 400 && !check(); i++) await settle()
  expect(check()).toBe(true)
}

test("a port outside the browse range in the pairing file is ignored", async () => {
  await until(() => FakeWebSocket.made.length > 0)
  expect(FakeWebSocket.made[0]!.url).toBe("ws://127.0.0.1:19988/extension")
  await until(() => relay.state().pairing === "code")
  expect(await stored("agentRelayDiscoveredPort")).toBeUndefined()
  // The file's code is still usable on the default port it applies to.
  await until(() => FakeWebSocket.made[0]!.sent.length >= 2)
  expect(FakeWebSocket.made[0]!.sent.map((data) => JSON.parse(data).method)).toEqual(["protocol", "hello"])
})
