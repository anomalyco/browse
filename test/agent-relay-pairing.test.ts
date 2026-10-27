import { expect, test } from "bun:test"
import type { AgentRelayState } from "../src/shared/protocol"
import { installChrome, settle, type StubEvent } from "./chrome-stub"

// The bundled pairing file (relay-pairing.json, written into an unpacked build by `install`) is looked for again
// while the extension is unpaired, and re-read on Reconnect and when the stored code changes. No relay: WebSocket is
// a fake that never opens unless told to. The fakes stay installed after this file: the relay it creates keeps its
// timers for the rest of the run, and must never reach a real port.

const stub = installChrome()
;(globalThis as { __OPENCODE_BROWSER_BUILD__?: string }).__OPENCODE_BROWSER_BUILD__ = "test"

class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static readonly made: FakeWebSocket[] = []
  readyState = FakeWebSocket.CONNECTING
  onopen: ((event: unknown) => void) | null = null
  onmessage: ((event: unknown) => void) | null = null
  onclose: ((event: unknown) => void) | null = null
  constructor(readonly url: string) {
    FakeWebSocket.made.push(this)
  }
  send() {}
  close(code = 1006, reason = "") {
    if (this.readyState === FakeWebSocket.CLOSED) return
    this.readyState = FakeWebSocket.CLOSED
    queueMicrotask(() => this.onclose?.({ code, reason, wasClean: false }))
  }
}

const CODE = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
const OTHER = "ZYXWVTSRQPNMKJHGFEDCBA9876543210"
let bundled: string | undefined
const reads: string[] = []
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: string | URL) => {
  const url = String(input)
  if (!url.endsWith("/relay-pairing.json")) return realFetch(input)
  reads.push(url)
  return bundled === undefined ? new Response("not found", { status: 404 }) : Response.json({ code: bundled })
}) as typeof fetch
;(globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket

await stub.chrome.storage.local.set({ agentRelayPort: 19925 })
const { createAgentRelay } = await import("../src/background/agent-relay")
const states: AgentRelayState[] = []
const relay = createAgentRelay({ changed: (state) => states.push(state), badgesChanged: () => {} })
const until = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) await settle()
  expect(check()).toBe(true)
}
const alarm = () => (chrome.alarms.onAlarm as unknown as StubEvent).emit({ name: "opencode-browser-relay" })

test("without a pairing file, the extension waits unpaired and doesn't connect", async () => {
  await until(() => relay.state().status === "unpaired")
  expect(relay.state().pairing).toBe("none")
  expect(FakeWebSocket.made).toHaveLength(0)
  expect(reads.length).toBeGreaterThan(0)
})

test("a pairing file written later (bun run setup) is found on the next attempt, without a worker restart", async () => {
  const before = reads.length
  bundled = CODE
  alarm()
  await until(() => FakeWebSocket.made.length === 1)
  expect(reads.length).toBe(before + 1)
  expect(relay.state().pairing).toBe("bundled")
  expect(FakeWebSocket.made[0]!.url).toBe("ws://127.0.0.1:19925/extension")
})

test("a found file is cached between attempts, and read again on Reconnect", async () => {
  // The relay isn't there: the attempt closes and backs off.
  FakeWebSocket.made[0]!.close()
  await settle()
  const before = reads.length
  alarm()
  await settle()
  // A retry is scheduled, so the alarm leaves it alone; either way nothing re-reads a found file.
  expect(reads.length).toBe(before)
  bundled = OTHER
  relay.reconnect()
  await until(() => FakeWebSocket.made.length === 2)
  expect(reads.length).toBe(before + 1)
})

test("a pairing change re-reads the file", async () => {
  const before = reads.length
  bundled = undefined
  await stub.chrome.storage.local.set({ agentRelayPairingCode: CODE })
  await until(() => reads.length === before + 1)
  // No file now; the stored code takes over.
  await until(() => relay.state().pairing === "stored")
})
