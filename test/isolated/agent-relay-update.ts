import { expect, test } from "bun:test"
import type { AgentRelayState } from "../../src/shared/protocol"
import { pairingProof, randomNonce } from "../../src/background/pairing"
import { installChrome, settle } from "../chrome-stub"

// The update notice: the relay's update check reaches the status page through the extension link (update.notice),
// and an empty notice clears it. Run by ../isolated.test.ts in a process of its own (its relay keeps chrome listeners
// and a WebSocket).

const stub = installChrome()
;(globalThis as { __OPENCODE_BROWSER_BUILD__?: string }).__OPENCODE_BROWSER_BUILD__ = "test"
const CODE = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
const PORT = 19908
type Message = { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown }

/** The relay's side of the link: answers the pairing handshake, records what the extension sends. */
class FakeRelaySocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static current: FakeRelaySocket | undefined
  readonly received: Message[] = []
  readyState = FakeRelaySocket.CONNECTING
  onopen: ((event: unknown) => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: ((event: unknown) => void) | null = null
  constructor(readonly url: string) {
    FakeRelaySocket.current = this
    setTimeout(() => {
      this.readyState = FakeRelaySocket.OPEN
      this.onopen?.({})
    }, 0)
  }
  send(data: string) {
    const message = JSON.parse(data) as Message
    this.received.push(message)
    if (message.method === "hello") void this.challenge(String((message.params?.pairing as { nonce: string }).nonce))
  }
  private async challenge(extensionNonce: string) {
    const nonce = randomNonce()
    this.deliver({ method: "auth.challenge", params: { nonce, proof: await pairingProof(CODE, "relay", PORT, nonce, extensionNonce) } })
  }
  deliver(message: Message) {
    this.onmessage?.({ data: JSON.stringify(message) })
  }
  close() {}
}

globalThis.fetch = (async (input: string | URL) =>
  String(input).endsWith("/relay-pairing.json") ? Response.json({ code: CODE }) : new Response("not found", { status: 404 })) as typeof fetch
;(globalThis as { WebSocket: unknown }).WebSocket = FakeRelaySocket

await stub.chrome.storage.local.set({ agentRelayPort: PORT })
const { createAgentRelay } = await import("../../src/background/agent-relay")
const states: AgentRelayState[] = []
const relay = createAgentRelay({ changed: (state) => states.push(state), badgesChanged: () => {} })

async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await settle()
  expect(check()).toBe(true)
}
const socket = () => FakeRelaySocket.current!
let nextCommand = 1
async function command(method: string, params?: Record<string, unknown>) {
  const id = nextCommand++
  socket().deliver({ id, method, ...(params ? { params } : {}) })
  await until(() => socket().received.some((message) => message.id === id))
  return socket().received.find((message) => message.id === id)!
}

await until(() => relay.state().status === "connected")

test("no update is shown until the relay reports one", () => {
  expect(relay.state().update).toBeUndefined()
})

test("the relay's notice reaches the status page's state", async () => {
  const notice = { summary: "3 new commits on origin/main", command: "node /src/browse/cli/dist/cli.mjs update" }
  expect((await command("update.notice", notice)).error).toBeUndefined()
  expect(relay.state().update).toEqual(notice)
  expect(states.at(-1)?.update).toEqual(notice)
})

test("an empty notice (updated, or the check turned off) clears it", async () => {
  expect((await command("update.notice")).error).toBeUndefined()
  expect(relay.state().update).toBeUndefined()
  expect(states.at(-1)?.update).toBeUndefined()
})
