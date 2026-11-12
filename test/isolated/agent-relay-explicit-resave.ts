import { expect, test } from "bun:test"
import { installChrome, settle } from "../chrome-stub"

// An explicit relay address is explicit even when it happens to be the port already in use: re-saving the form must not
// silently turn it back into the automatic address (which a fallback relay may move). The pairing code stays bound to
// port 20000. Run by ../isolated.test.ts in its own process.

const stub = installChrome()
;(globalThis as { __OPENCODE_BROWSER_BUILD__?: string }).__OPENCODE_BROWSER_BUILD__ = "test"

const EXPLICIT_PORT = 20000
const CODE = "ZZZZZZZZ"

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
      if (this.readyState === FakeWebSocket.CLOSED) return
      this.readyState = FakeWebSocket.CLOSED
      this.onclose?.({ code: 1006, reason: "", wasClean: true })
    }, 0)
  }
  send() {}
  close(code = 1000, reason = "") {
    if (this.readyState === FakeWebSocket.CLOSED) return
    this.readyState = FakeWebSocket.CLOSED
    queueMicrotask(() => this.onclose?.({ code, reason, wasClean: false }))
  }
}

globalThis.fetch = (async () => new Response("not found", { status: 404 })) as unknown as typeof fetch
;(globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket

await stub.chrome.storage.local.set({ agentRelayAddress: `127.0.0.1:${EXPLICIT_PORT}` })
const { createAgentRelay } = await import("../../src/background/agent-relay")
const relay = createAgentRelay({ changed: () => {}, badgesChanged: () => {} })
const stored = async (key: string): Promise<unknown> => (await stub.chrome.storage.local.get(key))[key]
async function until(check: () => boolean) {
  for (let i = 0; i < 400 && !check(); i++) await settle()
  expect(check()).toBe(true)
}

test("re-saving an explicit localhost port keeps it explicit, and the code for that port", async () => {
  const url = `ws://127.0.0.1:${EXPLICIT_PORT}/extension`
  await until(() => FakeWebSocket.made.some((socket) => socket.url === url && socket.readyState === FakeWebSocket.CLOSED))
  const before = FakeWebSocket.made.length
  const outcome = relay.connectTo(`localhost:${EXPLICIT_PORT}`, CODE)
  await until(() => FakeWebSocket.made.length > before)
  expect(await stored("agentRelayAddress")).toBe(`127.0.0.1:${EXPLICIT_PORT}`)
  expect(await stored("agentRelayCodePort")).toBe(EXPLICIT_PORT)
  expect(await stored("agentRelayPairingCode")).toBe(CODE)
  expect(FakeWebSocket.made.at(-1)!.url).toBe(url)
  // The attempt ends when the fake socket closes; the saved address is unchanged.
  expect((await outcome).status).not.toBe("invalid-address")
  expect(await stored("agentRelayAddress")).toBe(`127.0.0.1:${EXPLICIT_PORT}`)
})
