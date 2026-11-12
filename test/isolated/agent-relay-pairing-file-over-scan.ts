import { expect, test } from "bun:test"
import { installChrome, settle } from "../chrome-stub"

// A pairing file's code belongs to the port the file names: a port only a scan found must not capture it. The file's
// hint wins over a scanned port, and the code is tried there. Run by ../isolated.test.ts in its own process.

const stub = installChrome()
;(globalThis as { __OPENCODE_BROWSER_BUILD__?: string }).__OPENCODE_BROWSER_BUILD__ = "test"

const CODE = "0123ABCD"
const SCANNED_PORT = 19991
const FILE_PORT = 19990

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
  if (url.endsWith("/relay-pairing.json")) return Response.json({ code: CODE, port: FILE_PORT })
  return new Response("not found", { status: 404 })
}) as unknown as typeof fetch
;(globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket

await stub.chrome.storage.local.set({
  agentRelayDiscoveredPort: SCANNED_PORT,
  agentRelayDiscoveredKind: "scan",
})
const { createAgentRelay } = await import("../../src/background/agent-relay")
const relay = createAgentRelay({ changed: () => {}, badgesChanged: () => {} })
const stored = async (key: string): Promise<unknown> => (await stub.chrome.storage.local.get(key))[key]
async function until(check: () => boolean) {
  for (let i = 0; i < 400 && !check(); i++) await settle()
  expect(check()).toBe(true)
}

test("an unspent pairing file's port replaces a scanned one, and its code goes there", async () => {
  await until(() => FakeWebSocket.made.length > 0)
  expect(FakeWebSocket.made[0]!.url).toBe(`ws://127.0.0.1:${FILE_PORT}/extension`)
  expect(await stored("agentRelayDiscoveredPort")).toBe(FILE_PORT)
  expect(await stored("agentRelayDiscoveredKind")).toBe("hint")
  expect(relay.state().pairing).toBe("code")
  await until(() => FakeWebSocket.made[0]!.sent.length >= 2)
  expect(FakeWebSocket.made[0]!.sent.map((data) => JSON.parse(data)).find((message) => message.method === "hello")?.params.pairing.mode).toBe("code")
})
