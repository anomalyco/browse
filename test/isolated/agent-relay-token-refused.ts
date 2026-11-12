import { expect, test } from "bun:test"
import { pairingProof, randomNonce } from "../../src/background/pairing"
import { installChrome, settle } from "../chrome-stub"

// The fallback token is a guess: the relay on the new port may be someone else's. Its refusal must not touch the
// entry the guess came from (the relay on the old port still trusts it). Run by ../isolated.test.ts.

const stub = installChrome()
;(globalThis as { __OPENCODE_BROWSER_BUILD__?: string }).__OPENCODE_BROWSER_BUILD__ = "test"

const STORED_TOKEN = "this-browser-token-0123456789abcdefghijklmn"
const OTHER_RELAY_TOKEN = "another-relay-token-0123456789abcdefghijklmn"
const OLD_PORT = 19988
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
    setTimeout(() => {
      this.readyState = FakeWebSocket.OPEN
      this.onopen?.({})
    }, 0)
  }
  send(data: string) {
    this.sent.push(data)
    const message = JSON.parse(data) as { method?: string; params?: { pairing?: { nonce: string } } }
    if (message.method !== "hello") return
    const nonce = randomNonce()
    void pairingProof(OTHER_RELAY_TOKEN, "relay", BROWSER_PORT, nonce, message.params!.pairing!.nonce).then((proof) =>
      this.onmessage?.({ data: JSON.stringify({ method: "auth.challenge", params: { nonce, proof } }) }),
    )
  }
  close(code = 1000, reason = "") {
    if (this.readyState === FakeWebSocket.CLOSED) return
    this.readyState = FakeWebSocket.CLOSED
    queueMicrotask(() => this.onclose?.({ code, reason, wasClean: true }))
  }
}

globalThis.fetch = (async () => new Response("not found", { status: 404 })) as unknown as typeof fetch
;(globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket

await stub.chrome.storage.local.set({
  agentRelayDiscoveredPort: BROWSER_PORT,
  agentRelayTokens: { [`127.0.0.1:${OLD_PORT}`]: STORED_TOKEN },
})
const { createAgentRelay } = await import("../../src/background/agent-relay")
const relay = createAgentRelay({ changed: () => {}, badgesChanged: () => {} })
const stored = async (key: string): Promise<unknown> => (await stub.chrome.storage.local.get(key))[key]
async function until(check: () => boolean) {
  for (let i = 0; i < 400 && !check(); i++) await settle()
  expect(check()).toBe(true)
}

test("a refused fallback token leaves the entry it came from alone", async () => {
  await until(() => relay.state().status === "untrusted")
  expect(relay.state().pairing).toBe("token")
  expect(await stored("agentRelayTokens")).toEqual({ [`127.0.0.1:${OLD_PORT}`]: STORED_TOKEN })
  // Nothing authenticated on the discovered port, so the scan forgets it and dialing returns to 19988.
  expect(await stored("agentRelayDiscoveredPort")).toBeUndefined()
})
