import { expect, test } from "bun:test"
import { Effect } from "effect"
import { WebSocket } from "ws"
import { browserReloading, browserUnresponsive } from "../src/protocol.ts"
import {
  configuredTimeoutMs,
  extensionCommandTimeout,
  extensionPingTimeout,
  ExtensionRpc,
  type ExtensionRpcTimeouts,
} from "../src/relay/rpc.ts"

function connectedRpc(timeouts: ExtensionRpcTimeouts) {
  const sent: string[] = []
  const closed: number[] = []
  const socket = {
    readyState: WebSocket.OPEN,
    send: (data: string) => sent.push(data),
    on: () => {},
    off: () => {},
    close: (code: number) => closed.push(code),
    ping: () => {},
  } as unknown as WebSocket
  const rpc = new ExtensionRpc(timeouts)
  rpc.replaceSocket(socket)
  rpc.protocolCompatible = true
  rpc.protocolLegacy = false
  rpc.markReady()
  return { rpc, sent, closed }
}

test("an evaluate that awaits a page promise times out instead of hanging the relay", async () => {
  const { rpc } = connectedRpc({ awaitPromiseTimeoutMs: 25, livenessProbeTimeoutMs: 1 })
  const error = await Effect.runPromise(Effect.flip(rpc.send({
    method: "debugger.sendCommand",
    params: { tabId: 1, method: "Runtime.evaluate", params: { expression: "new Promise(() => {})", awaitPromise: true } },
  })))
  expect(error.message).toContain("timed out after 25ms")
})

test("a worker that keeps sending heartbeats but stops answering pings is reloaded", async () => {
  const { rpc, sent, closed } = connectedRpc({ pingTimeoutMs: 10, wedgedAfterMs: 40 })
  const ping = () => {
    // The worker's own heartbeat event lands while the ping goes unanswered.
    setTimeout(() => rpc.noteResponse(), 2)
    return Effect.runPromise(Effect.result(rpc.send({ method: "ping" })))
  }

  // The heartbeat lets early pings pass, as it did before; that alone doesn't reload anything.
  expect((await ping())._tag).toBe("Success")
  expect(closed).toEqual([])

  const started = Date.now()
  let last = await ping()
  while (last._tag === "Success" && Date.now() - started < 1_000) last = await ping()
  expect(last._tag === "Failure" && last.failure.message).toBe(browserReloading)
  expect(sent.map((data) => JSON.parse(data).method)).toContain("runtime.reload")
  expect(closed).toEqual([4002])
})

test("a command reply between missed pings restarts the wedge window", async () => {
  const { rpc, closed } = connectedRpc({ pingTimeoutMs: 10, wedgedAfterMs: 25 })
  const missedPing = () => Effect.runPromise(Effect.result(rpc.send({ method: "ping" })))

  for (let i = 0; i < 5; i++) {
    expect((await missedPing())._tag).toBe("Failure")
    // A late reply to a timed-out command proves the worker still completes extension calls.
    rpc.handleResponse({ id: 999, result: {} })
  }
  expect(closed).toEqual([])
})

test("a single unanswered ping marks the browser unresponsive without closing the socket", async () => {
  const { rpc, closed } = connectedRpc({ pingTimeoutMs: 10 })
  const failure = await Effect.runPromise(Effect.flip(rpc.send({ method: "ping" })))
  expect(failure.message).toBe(browserUnresponsive)
  expect(rpc.unresponsive).toBe(true)
  expect(rpc.connected).toBe(false)
  expect(closed).toEqual([])

  // Any later reply proves the worker is running again; the socket was open the whole time.
  rpc.handleResponse({ id: 999, result: {} })
  expect(rpc.unresponsive).toBe(false)
  expect(rpc.connected).toBe(true)
})

test("a configured ping timeout is used instead of the default", async () => {
  const { rpc } = connectedRpc({ pingTimeoutMs: 40 })
  const started = Date.now()
  const failure = await Effect.runPromise(Effect.flip(rpc.send({ method: "ping" })))
  expect(failure.message).toBe(browserUnresponsive)
  const elapsed = Date.now() - started
  expect(elapsed).toBeGreaterThanOrEqual(30)
  expect(elapsed).toBeLessThan(1_000)
})

test("a pending ping is reported until it is answered or times out", async () => {
  const answered = connectedRpc({ pingTimeoutMs: 1_000 })
  const reply = Effect.runPromise(Effect.result(answered.rpc.send({ method: "ping" })))
  expect(answered.rpc.pingPending).toBe(true)
  const request = JSON.parse(answered.sent.at(-1)!) as { id: number }
  answered.rpc.handleResponse({ id: request.id, result: {} })
  expect((await reply)._tag).toBe("Success")
  expect(answered.rpc.pingPending).toBe(false)

  const timedOut = connectedRpc({ pingTimeoutMs: 10 })
  expect((await Effect.runPromise(Effect.result(timedOut.rpc.send({ method: "ping" }))))._tag).toBe("Failure")
  expect(timedOut.rpc.pingPending).toBe(false)
})

test("a configured command timeout bounds a slow command and names it", async () => {
  const { rpc, closed } = connectedRpc({ commandTimeoutMs: 10 })
  const error = await Effect.runPromise(Effect.flip(rpc.send({ method: "tabs.create", params: { url: "about:blank" } })))
  expect(error.message).toBe("Extension command timed out after 10ms: tabs.create")
  // Only the command failed: closing is reserved for a websocket that doesn't answer a liveness probe.
  expect(closed).toEqual([])
  rpc.close()
})

test("the timeout environment parser clamps and falls back", () => {
  expect(configuredTimeoutMs(undefined, extensionCommandTimeout)).toBe(30_000)
  expect(configuredTimeoutMs("", extensionCommandTimeout)).toBe(30_000)
  expect(configuredTimeoutMs("not-a-number", extensionCommandTimeout)).toBe(30_000)
  expect(configuredTimeoutMs("1500.5", extensionPingTimeout)).toBe(10_000)
  expect(configuredTimeoutMs("100", extensionCommandTimeout)).toBe(15_000)
  expect(configuredTimeoutMs("1000000", extensionCommandTimeout)).toBe(300_000)
  expect(configuredTimeoutMs("250", extensionPingTimeout)).toBe(1_000)
  expect(configuredTimeoutMs("60000", extensionPingTimeout)).toBe(30_000)
  expect(configuredTimeoutMs(" 20000 ", extensionCommandTimeout)).toBe(20_000)
})
