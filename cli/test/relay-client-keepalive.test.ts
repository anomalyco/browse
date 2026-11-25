import { afterAll, expect, test } from "bun:test"
import fs from "node:fs"
import http from "node:http"
import type { AddressInfo } from "node:net"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import * as RelayClient from "../src/relay/client.ts"

// The client reads the relay token from the data folder; keep it away from the real install.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "browse-relay-keepalive-"))
const previousHome = process.env.OPENCODE_BROWSER_HOME
const previousPort = process.env.OPENCODE_BROWSER_PORT
process.env.OPENCODE_BROWSER_HOME = home
afterAll(() => {
  if (previousHome === undefined) delete process.env.OPENCODE_BROWSER_HOME
  else process.env.OPENCODE_BROWSER_HOME = previousHome
  if (previousPort === undefined) delete process.env.OPENCODE_BROWSER_PORT
  else process.env.OPENCODE_BROWSER_PORT = previousPort
  fs.rmSync(home, { recursive: true, force: true })
})

/** A local relay answering /version the way a live one does, counting the TCP connections it accepts. */
async function fakeRelay() {
  let connections = 0
  const server = http.createServer((_request, response) => {
    response.setHeader("content-type", "application/json; charset=utf-8")
    response.end(JSON.stringify({ version: "0.1.5", buildId: "keepalive-build", instanceId: "keepalive-relay", startedAt: "2026-01-01T00:00:00.000Z", shutdownProtocol: 2 }))
  })
  // Hold idle connections open: only a keep-alive client reuses one, and the server never closes it between requests.
  server.keepAliveTimeout = 0
  server.on("connection", () => { connections++ })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port
  return {
    port,
    connections: () => connections,
    async close() {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

test("sequential relay requests reuse one keep-alive connection", async () => {
  const relay = await fakeRelay()
  process.env.OPENCODE_BROWSER_PORT = String(relay.port)
  try {
    const version = await Effect.runPromise(
      Effect.gen(function*() {
        const client = yield* RelayClient.Service
        const first = yield* client.version
        // Let the socket return to the agent's free pool (Node frees it on the next tick) before the next call.
        for (let call = 0; call < 2; call++) {
          yield* Effect.sleep("10 millis")
          yield* client.version
        }
        return first
      }).pipe(Effect.provide(RelayClient.layerFetch)),
    )
    expect(version.instanceId).toBe("keepalive-relay")
    // One socket for all three: the client keeps and reuses it instead of reconnecting each time.
    expect(relay.connections()).toBe(1)
  } finally {
    await relay.close()
  }
})

test("a reset on the wire is named in the unreachable message", async () => {
  const server = http.createServer()
  server.on("connection", (socket) => socket.destroy())
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  process.env.OPENCODE_BROWSER_PORT = String((server.address() as AddressInfo).port)
  try {
    const message = await Effect.runPromise(
      Effect.gen(function*() {
        const client = yield* RelayClient.Service
        return yield* client.version.pipe(
          Effect.match({
            onFailure: (error) => error.message,
            onSuccess: () => "the relay answered",
          }),
        )
      }).pipe(Effect.provide(RelayClient.layerFetch)),
    )
    expect(message).toContain("browse relay is not reachable")
    // A refused port keeps the plain message; a reset names its code, so it is distinguishable from a relay that isn't
    // running.
    expect(message).toContain("(ECONNRESET)")
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
