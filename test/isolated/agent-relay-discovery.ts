import { expect, test } from "bun:test"
import { installChrome, settle } from "../chrome-stub"

// An unlocked (and unpaired) extension with no pairing hint: 19988 is held by something that isn't browse (Playwriter
// does the same), so the connection fails before any browse protocol. The worker scans the candidate ports' /version,
// finds the relay on a fallback port, stores it, and reconnects there. Run by ../isolated.test.ts in its own process.

const stub = installChrome()
;(globalThis as { __OPENCODE_BROWSER_BUILD__?: string }).__OPENCODE_BROWSER_BUILD__ = "test"

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
    const port = Number(/:(\d+)\//.exec(url)?.[1])
    setTimeout(() => {
      // Only the fallback port has a relay; everything else refuses the connection.
      if (this.readyState === FakeWebSocket.CLOSED) return
      if (port === BROWSER_PORT) {
        this.readyState = FakeWebSocket.OPEN
        this.onopen?.({})
      } else {
        this.readyState = FakeWebSocket.CLOSED
        this.onclose?.({ code: 1006, reason: "", wasClean: true })
      }
    }, 0)
  }
  send(data: string) {
    this.sent.push(data)
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
  probes.push(url)
  const port = Number(/127\.0\.0\.1:(\d+)\/version/.exec(url)?.[1])
  return port === BROWSER_PORT
    ? Response.json({ version: "0.0.2", instanceId: "abc", pid: 1 })
    : new Response("not found", { status: 404 })
}) as unknown as typeof fetch
;(globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket

const { createAgentRelay } = await import("../../src/background/agent-relay")
const relay = createAgentRelay({ changed: () => {}, badgesChanged: () => {} })
const stored = async (key: string): Promise<unknown> => (await stub.chrome.storage.local.get(key))[key]
const made = () => FakeWebSocket.made.map((socket) => socket.url)
async function until(check: () => boolean) {
  for (let i = 0; i < 400 && !check(); i++) await settle()
  expect(check()).toBe(true)
}

test("an automatic connection scans a failed port and moves to the browse relay it finds", async () => {
  await until(() => relay.state().relay.address === "localhost:19988" && made().some((url) => url.includes(":19990/")))
  expect(made()).toEqual(["ws://127.0.0.1:19988/extension", "ws://127.0.0.1:19990/extension"])
  expect(await stored("agentRelayDiscoveredPort")).toBe(BROWSER_PORT)
  // The scan asked every candidate, not just the failed port.
  expect(probes.some((url) => url.endsWith(":19988/version"))).toBe(true)
  expect(probes.some((url) => url.endsWith(":19990/version"))).toBe(true)
  // A port only a scan found, with no authenticated connection, isn't offered in the form: it shows the default.
  expect(relay.state().relay).toEqual({ address: "localhost:19988", remote: false })
  // Nothing to pair with yet: the connection is presence-only, and now watches the right port.
  await until(() => FakeWebSocket.made.at(-1)!.sent.length > 0)
  expect(relay.state().status).toBe("unpaired")
  expect(relay.state().pairing).toBe("none")
  expect(FakeWebSocket.made.at(-1)!.sent.map((data) => JSON.parse(data))).toEqual([
    { method: "protocol", params: { protocolVersion: 3, unpaired: true } },
  ])
})

test("saving the automatic address the page shows does not pin it", async () => {
  const before = FakeWebSocket.made.length
  const outcome = relay.connectTo("localhost:19990", "")
  await until(() => FakeWebSocket.made.length > before)
  // Presence-only again, and still on the automatic port: no address was stored.
  FakeWebSocket.made.at(-1)!.close(1000)
  expect(await outcome).toMatchObject({ status: "unpaired" })
  expect((await stub.chrome.storage.local.get("agentRelayAddress")).agentRelayAddress).toBe("")
  expect(relay.state().relay).toEqual({ address: "localhost:19990", remote: false })
})

test("a second failure right after a scan doesn't scan again", async () => {
  const before = probes.length
  FakeWebSocket.made.at(-1)!.close(1006)
  await settle()
  await settle()
  expect(probes).toHaveLength(before)
})
