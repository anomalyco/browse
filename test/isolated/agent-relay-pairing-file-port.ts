import { expect, test } from "bun:test"
import { installChrome, settle } from "../chrome-stub"

// An unpacked build's relay-pairing.json carries the port the relay bound when it isn't 19988
// (cli/src/relay/browser-pairing.ts writeExtensionPairing). Before dialling, the worker takes it as the discovered
// port, so the first connection goes to the relay instead of scanning for it. Run by ../isolated.test.ts.

const stub = installChrome()
;(globalThis as { __OPENCODE_BROWSER_BUILD__?: string }).__OPENCODE_BROWSER_BUILD__ = "test"

const CODE = "0123ABCD"
const BROWSER_PORT = 19990
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
  if (url.endsWith("/relay-pairing.json")) return Response.json({ code: CODE, port: BROWSER_PORT })
  probes.push(url)
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

test("the pairing file's port is the first port dialled, and the code may go there", async () => {
  await until(() => FakeWebSocket.made.length > 0)
  expect(FakeWebSocket.made[0]!.url).toBe(`ws://127.0.0.1:${BROWSER_PORT}/extension`)
  expect(await stored("agentRelayDiscoveredPort")).toBe(BROWSER_PORT)
  // The code is for that port, so it is sent when the connection opens there.
  await until(() => relay.state().pairing === "code")
  expect(relay.state().unpacked).toBe(true)
  await until(() => FakeWebSocket.made[0]!.sent.length >= 2)
  const sent = FakeWebSocket.made[0]!.sent.map((data) => JSON.parse(data))
  expect(sent.map((message) => message.method)).toEqual(["protocol", "hello"])
  expect(sent[1].params.pairing.mode).toBe("code")
  // No scan was needed: the hint named the relay.
  expect(probes).toEqual([])
})
