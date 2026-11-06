import { expect, test } from "bun:test"
import { Effect } from "effect"
import { WebSocket } from "ws"
import { ExtensionRpc } from "../src/relay/rpc.ts"

test("an evaluate that awaits a page promise times out instead of hanging the relay", async () => {
  const rpc = new ExtensionRpc({ awaitPromiseTimeoutMs: 25, livenessProbeTimeoutMs: 1 })
  const socket = {
    readyState: WebSocket.OPEN,
    send: () => {},
    on: () => {},
    off: () => {},
    close: () => {},
    ping: () => {},
  } as unknown as WebSocket
  rpc.replaceSocket(socket)
  rpc.protocolCompatible = true
  rpc.protocolLegacy = false
  rpc.markReady()

  const error = await Effect.runPromise(Effect.flip(rpc.send({
    method: "debugger.sendCommand",
    params: { tabId: 1, method: "Runtime.evaluate", params: { expression: "new Promise(() => {})", awaitPromise: true } },
  })))
  expect(error.message).toContain("timed out after 25ms")
})
