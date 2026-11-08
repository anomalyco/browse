import { expect, test } from "bun:test"
import { Effect } from "effect"
import type { AddressInfo } from "node:net"
import { createRelayTransportServers } from "../src/relay/transport-server.ts"

/** Serves one in-process relay transport server, counting the requests that count as an agent using the browser. */
function relay() {
  const activity: string[] = []
  const { httpServer } = createRelayTransportServers({
    host: "127.0.0.1",
    port: 0,
    endpointUrl: "http://127.0.0.1",
    authToken: "test-token",
    additionalChromeExtensionOrigins: new Set(),
    isReady: () => true,
    onAgentHttpActivity: () => activity.push("agent"),
    relayRequestHandler: (request, response) => {
      response.writeHead(200, { "content-type": "text/plain" }).end(request.url)
    },
    // The transport server hands these to its WebSocket handlers, which this test never opens.
    shutdownControl: {} as never,
    sessions: {} as never,
    cdpClients: {} as never,
    cdpRuntime: {} as never,
    handshake: {} as never,
    recordingRelay: {} as never,
    handleExtensionMessage: () => {},
    handleCdpMessage: () => Effect.void,
    debugLog: undefined,
  })
  return {
    activity,
    start: async () => {
      await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve))
      return `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`
    },
    stop: () => new Promise<void>((resolve) => httpServer.close(() => resolve())),
  }
}

test("lifecycle and status requests leave the auto-updater's idle clock alone", async () => {
  const server = relay()
  const base = await server.start()
  try {
    const send = (path: string, method = "GET") => fetch(`${base}${path}`, { method })
    for (const path of ["/version", "/json/version", "/extension/status", "/cli/sessions", "/json/list", "/settings"] as const) {
      expect((await send(path)).status).toBe(200)
    }
    expect((await send("/shutdown", "POST")).status).toBe(200)
    expect(server.activity).toEqual([])
  } finally {
    await server.stop()
  }
})

test("what an agent does to the browser restarts the idle clock", async () => {
  const server = relay()
  const base = await server.start()
  try {
    for (const path of ["/cli/execute", "/cli/session/new", "/v1/sessions/ensure", "/network/start"]) {
      const response = await fetch(`${base}${path}`, { method: "POST" })
      expect(response.status).toBe(200)
    }
    expect((await fetch(`${base}/settings`, { method: "POST" })).status).toBe(200)
    expect(server.activity).toHaveLength(5)
  } finally {
    await server.stop()
  }
})
