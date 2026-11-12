import { expect, test } from "bun:test"
import { pairingProof, randomNonce } from "../../src/background/pairing"
import { installChrome, settle } from "../chrome-stub"

// Two listeners answer /version like browse: the spoofer cannot complete the HMAC proof, the real relay can. The scan
// must skip the port that just failed its proof and move to the real one. Run by ../isolated.test.ts.

const stub = installChrome()
;(globalThis as { __OPENCODE_BROWSER_BUILD__?: string }).__OPENCODE_BROWSER_BUILD__ = "test"

const SPOOF_PORT = 19990
const REAL_PORT = 19991
const SPOOF_TOKEN = "spoof-token-0123456789abcdefghijklmnopqrstuv"
const REAL_TOKEN = "real-token-0123456789abcdefghijklmnopqrstuv"

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
    const message = JSON.parse(data) as Message
    this.received.push(message)
    if (message.method !== "hello") return
    const nonce = randomNonce()
    const extensionNonce = (message.params?.pairing as { nonce: string }).nonce
    const port = Number(/:(\d+)\//.exec(this.url)?.[1])
    void pairingProof(port === SPOOF_PORT ? "not-the-token" : REAL_TOKEN, "relay", port, nonce, extensionNonce).then((proof) =>
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
  return port === SPOOF_PORT || port === REAL_PORT
    ? Response.json({ version: "0.0.2", instanceId: `listener-${port}`, pid: 1 })
    : new Response("not found", { status: 404 })
}) as unknown as typeof fetch
;(globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket

await stub.chrome.storage.local.set({
  agentRelayDiscoveredPort: SPOOF_PORT,
  agentRelayDiscoveredKind: "scan",
  agentRelayProvenPort: SPOOF_PORT,
  agentRelayTokens: {
    [`127.0.0.1:${SPOOF_PORT}`]: SPOOF_TOKEN,
    [`127.0.0.1:${REAL_PORT}`]: REAL_TOKEN,
  },
})
const { createAgentRelay } = await import("../../src/background/agent-relay")
const relay = createAgentRelay({ changed: () => {}, badgesChanged: () => {} })
const stored = async (key: string): Promise<unknown> => (await stub.chrome.storage.local.get(key))[key]
async function until(check: () => boolean) {
  for (let i = 0; i < 400 && !check(); i++) await settle()
  expect(check()).toBe(true)
}

test("a spoofed port that fails the proof is skipped for the real relay", async () => {
  await until(() => relay.state().status === "connected")
  expect(FakeWebSocket.made.at(-1)!.url).toBe(`ws://127.0.0.1:${REAL_PORT}/extension`)
  expect(await stored("agentRelayDiscoveredPort")).toBe(REAL_PORT)
  expect(await stored("agentRelayProvenPort")).toBe(REAL_PORT)
  // The spoofer got a token proof attempt, not the extension's work.
  const spoof = FakeWebSocket.made.find((socket) => socket.url.includes(`:${SPOOF_PORT}/`))!
  expect(spoof.received.some((message) => message.method === "hello")).toBe(true)
  expect(spoof.received.some((message) => message.method === "ready")).toBe(false)
})
