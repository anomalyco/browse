import { expect, test } from "bun:test"
import type { AgentRelayState } from "../src/shared/protocol"
import { installChrome, settle, type StubEvent } from "./chrome-stub"

// The bundled pairing file (relay-pairing.json, the one-time code `install` writes into an unpacked build) is looked
// for again while the extension is unpaired, and re-read on Reconnect and when the entered code changes. No relay: WebSocket is
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
  sent: string[] = []
  send(message: string) { this.sent.push(message) }
  close(code = 1006, reason = "") {
    if (this.readyState === FakeWebSocket.CLOSED) return
    this.readyState = FakeWebSocket.CLOSED
    queueMicrotask(() => this.onclose?.({ code, reason, wasClean: false }))
  }
}

const CODE = "0123ABCD"
const OTHER = "ZYXW9876"
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

test("without a pairing file, the extension sends only anonymous protocol presence", async () => {
  await until(() => relay.state().status === "unpaired")
  expect(relay.state().pairing).toBe("none")
  const socket = FakeWebSocket.made[0]!
  socket.readyState = FakeWebSocket.OPEN
  socket.onopen?.({})
  expect(socket.sent.map(s => JSON.parse(s))).toEqual([{ method: "protocol", params: { protocolVersion: 3, unpaired: true } }])
  socket.close(1000, "Waiting for pairing")
  await settle()
  expect(reads.length).toBeGreaterThan(0)
})

test("a pairing file written later (bun run setup) is found on the next attempt, without a worker restart", async () => {
  const before = reads.length
  bundled = CODE
  alarm()
  await until(() => FakeWebSocket.made.length === 2)
  expect(reads.length).toBe(before + 1)
  expect(relay.state().pairing).toBe("code")
  expect(relay.state().unpacked).toBe(true)
  expect(FakeWebSocket.made.at(-1)!.url).toBe("ws://127.0.0.1:19925/extension")
})

test("a found file is cached between attempts, and read again on Reconnect", async () => {
  // The relay isn't there: the attempt closes and backs off.
  FakeWebSocket.made.at(-1)!.close()
  await settle()
  const before = reads.length
  alarm()
  await settle()
  // A retry is scheduled, so the alarm leaves it alone; either way nothing re-reads a found file.
  expect(reads.length).toBe(before)
  bundled = OTHER
  relay.reconnect()
  await until(() => FakeWebSocket.made.length === 3)
  expect(reads.length).toBe(before + 1)
})

test("a pairing change re-reads the file", async () => {
  const before = reads.length
  bundled = undefined
  await stub.chrome.storage.local.set({ agentRelayPairingCode: CODE })
  await until(() => reads.length === before + 1)
  // No file now; the entered code takes over.
  await until(() => relay.state().pairing === "code" && relay.state().unpacked !== true)
})

test("a relay address that isn't one is refused, and nothing is saved", async () => {
  const before = FakeWebSocket.made.length
  expect(await relay.connectTo("host/path", "")).toEqual({ status: "invalid-address" })
  expect(await relay.connectTo("100.64.0.2", "not a pairing code")).toEqual({ status: "invalid-code" })
  // The long code earlier versions printed isn't one to type anymore.
  expect(await relay.connectTo("100.64.0.2", "0123")).toEqual({ status: "invalid-code" })
  expect((await stub.chrome.storage.local.get("agentRelayAddress")).agentRelayAddress).toBeUndefined()
  expect(FakeWebSocket.made).toHaveLength(before)
})

test("Connect dials the relay address, a typed code wins over the bundled one there, and the outcome comes back", async () => {
  bundled = OTHER
  const before = FakeWebSocket.made.length
  const outcome = relay.connectTo("100.64.0.2", CODE)
  await until(() => FakeWebSocket.made.length > before && FakeWebSocket.made.at(-1)!.url === "ws://100.64.0.2:19925/extension")
  expect(relay.state().relay).toEqual({ address: "100.64.0.2:19925", remote: true })
  expect(relay.state().pairing).toBe("code")
  // No relay answers there.
  FakeWebSocket.made.at(-1)!.close()
  expect(await outcome).toEqual({ status: "offline", address: "100.64.0.2:19925" })
  expect((await stub.chrome.storage.local.get("agentRelayAddress")).agentRelayAddress).toBe("100.64.0.2")
})

test("localhost (as the page shows it) goes back to this computer's relay and its bundled code", async () => {
  await stub.chrome.storage.local.remove("agentRelayPairingCode")
  for (const address of ["localhost:19925", "", "127.0.0.1"]) {
    await stub.chrome.storage.local.set({ agentRelayAddress: "100.64.0.2" })
    await settle()
    const before = FakeWebSocket.made.length
    const outcome = relay.connectTo(address, "")
    await until(() => FakeWebSocket.made.length > before && FakeWebSocket.made.at(-1)!.url === "ws://127.0.0.1:19925/extension")
    expect(relay.state().relay).toEqual({ address: "localhost:19925", remote: false })
    await until(() => relay.state().unpacked === true)
    expect((await stub.chrome.storage.local.get("agentRelayAddress")).agentRelayAddress).toBe("")
    FakeWebSocket.made.at(-1)!.close()
    expect((await outcome).status).toBe("offline")
  }
})
