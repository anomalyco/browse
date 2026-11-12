import { expect, test } from "bun:test"
import { pairingProof, randomNonce } from "../../src/background/pairing"
import { installChrome, settle } from "../chrome-stub"

// A proven port that now fails its proof must lose that record once another candidate answers, so it can't stay the
// preferred port. Run by ../isolated.test.ts.

const stub = installChrome()
;(globalThis as { __OPENCODE_BROWSER_BUILD__?: string }).__OPENCODE_BROWSER_BUILD__ = "test"

const SPOOF_PORT = 19990
const OTHER_PORT = 19991
const SPOOF_TOKEN = "spoof-token-0123456789abcdefghijklmnopqrstuv"

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
  constructor(readonly url: string) {
    FakeWebSocket.made.push(this)
    setTimeout(() => {
      this.readyState = FakeWebSocket.OPEN
      this.onopen?.({})
    }, 0)
  }
  send(data: string) {
    const message = JSON.parse(data) as Message
    if (message.method !== "hello" || !this.url.includes(`:${SPOOF_PORT}/`)) return
    const nonce = randomNonce()
    const extensionNonce = (message.params?.pairing as { nonce: string }).nonce
    void pairingProof("not-the-token", "relay", SPOOF_PORT, nonce, extensionNonce).then((proof) =>
      this.onmessage?.({ data: JSON.stringify({ method: "auth.challenge", params: { nonce, proof } }) }),
    )
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
  return port === SPOOF_PORT || port === OTHER_PORT
    ? Response.json({ version: "0.0.2", instanceId: `listener-${port}`, pid: 1 })
    : new Response("not found", { status: 404 })
}) as unknown as typeof fetch
;(globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket

await stub.chrome.storage.local.set({
  agentRelayDiscoveredPort: SPOOF_PORT,
  agentRelayDiscoveredKind: "scan",
  agentRelayProvenPort: SPOOF_PORT,
  agentRelayTokens: { [`127.0.0.1:${SPOOF_PORT}`]: SPOOF_TOKEN },
})
const { createAgentRelay } = await import("../../src/background/agent-relay")
const relay = createAgentRelay({ changed: () => {}, badgesChanged: () => {} })
const stored = async (key: string): Promise<unknown> => (await stub.chrome.storage.local.get(key))[key]
async function until(check: () => boolean) {
  for (let i = 0; i < 400 && !check(); i++) await settle()
  expect(check()).toBe(true)
}

test("a failed proven port loses its record when another candidate answers", async () => {
  await until(() => FakeWebSocket.made.some((socket) => socket.url.includes(`:${OTHER_PORT}/`)))
  expect(await stored("agentRelayDiscoveredPort")).toBe(OTHER_PORT)
  expect(await stored("agentRelayProvenPort")).toBeUndefined()
  // The other port hasn't proved itself yet, so the form still shows the default.
  expect(relay.state().relay).toEqual({ address: "localhost:19988", remote: false })
})
