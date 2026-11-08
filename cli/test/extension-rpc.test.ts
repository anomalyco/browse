import { expect, test } from "bun:test"
import { Effect } from "effect"
import { WebSocket } from "ws"
import { browserReloading } from "../src/protocol.ts"
import { ExtensionRpc, type ExtensionRpcTimeouts } from "../src/relay/rpc.ts"

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
