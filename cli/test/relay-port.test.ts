import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { NodeHttpClient } from "@effect/platform-node"
import { Effect } from "effect"
import * as RelayClient from "../src/relay/client.ts"
import { chooseRelayPort, probeRelayPort, readRelayState, relayStatePath } from "../src/relay/port.ts"
import { startRelay } from "../src/relay.ts"
import { relayToken } from "../src/relay/secrets.ts"
import { freePort } from "./support/ports.ts"

// Port fallback and relay.json (relay/port.ts). Candidates are passed in so nothing here touches 19988–19997.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "browse-relay-port-"))
const previousHome = process.env.OPENCODE_BROWSER_HOME
const previousPort = process.env.OPENCODE_BROWSER_PORT
process.env.OPENCODE_BROWSER_HOME = home
delete process.env.OPENCODE_BROWSER_PORT
afterAll(() => {
  if (previousHome === undefined) delete process.env.OPENCODE_BROWSER_HOME
  else process.env.OPENCODE_BROWSER_HOME = previousHome
  if (previousPort === undefined) delete process.env.OPENCODE_BROWSER_PORT
  else process.env.OPENCODE_BROWSER_PORT = previousPort
  fs.rmSync(home, { recursive: true, force: true })
})

const header = (request: Request, name: string) => request.headers.get(name) ?? undefined

/** A free port outside browse's real range, so no test here can bind 19988–19997. */
async function freePortOutsideBrowseRange(): Promise<number> {
  for (;;) {
    const port = await freePort()
    if (port < 19988 || port > 19997) return port
  }
}

describe("relay port fallback", () => {
  test("an unpinned relay steps off a port another program holds, records it, and a client finds it", async () => {
    const held = await freePortOutsideBrowseRange()
    const fallback = await freePortOutsideBrowseRange()
    const probes: Array<{ authorization: string | undefined; pid: string | undefined }> = []
    using other = Bun.serve({
      hostname: "127.0.0.1",
      port: held,
      fetch: (request) => {
        probes.push({
          authorization: header(request, "authorization"),
          pid: header(request, "opencode-browser-client-pid"),
        })
        return Response.json({ name: "playwriter" })
      },
    })
    expect(await probeRelayPort(held)).toBe("other")

    await Effect.runPromise(Effect.gen(function* () {
      const relay = yield* startRelay({ portCandidates: [held, fallback] })
      // The relay listens on the fallback, but its state stays keyed by the configured port.
      expect(relay.url).toBe(`http://127.0.0.1:${fallback}`)
      expect(readRelayState()).toMatchObject({
        port: fallback,
        configuredPort: 19988,
        pid: process.pid,
      })
      expect(fs.statSync(relayStatePath()).mode & 0o777).toBe(0o600)

      // A client with no pinned port resolves the fallback through relay.json.
      const client = yield* RelayClient.make()
      const version = yield* client.version
      expect(version.version).toBeString()
      expect(client.endpoint).toBe(`http://127.0.0.1:${fallback}`)
    }).pipe(Effect.scoped, Effect.provide(NodeHttpClient.layerNodeHttp)))

    // Choosing the port probes the holder without credentials.
    expect(probes.length).toBeGreaterThan(0)
    expect(probes.every((probe) => probe.authorization === undefined && probe.pid === undefined)).toBe(true)
    // Shutdown removed the file it wrote.
    expect(readRelayState()).toBeUndefined()
  }, 30_000)

  test("the version probe carries neither the relay token nor the client pid", async () => {
    relayToken(home)
    const port = await freePortOutsideBrowseRange()
    const requests: Array<{ path: string; authorization: string | undefined; pid: string | undefined }> = []
    using fake = Bun.serve({
      hostname: "127.0.0.1",
      port,
      fetch: (request) => {
        const pathname = new URL(request.url).pathname
        requests.push({
          path: pathname,
          authorization: header(request, "authorization"),
          pid: header(request, "opencode-browser-client-pid"),
        })
        return pathname === "/version"
          ? Response.json({ version: "9.9.9", instanceId: "fake-relay" })
          : Response.json({ sessions: [] })
      },
    })
    await Effect.runPromise(Effect.gen(function* () {
      const client = yield* RelayClient.make({ endpoint: `http://127.0.0.1:${port}`, clientPid: process.pid })
      expect((yield* client.version).version).toBe("9.9.9")
      // Other routes still prove the token and name the client, so the absence above is specific to /version.
      expect(yield* client.sessions).toEqual([])
    }).pipe(Effect.provide(NodeHttpClient.layerNodeHttp)))
    const version = requests.find((request) => request.path === "/version")
    expect(version).toMatchObject({ authorization: undefined, pid: undefined })
    const sessions = requests.find((request) => request.path === "/cli/sessions")
    expect(sessions?.authorization).toStartWith("Bearer ")
    expect(sessions?.pid).toBe(String(process.pid))
  }, 30_000)

  test("a pinned port is used as is, with no probing or fallback", async () => {
    const held = await freePortOutsideBrowseRange()
    using other = Bun.serve({ hostname: "127.0.0.1", port: held, fetch: () => new Response("Not Found", { status: 404 }) })
    expect(await chooseRelayPort({ configuredPort: held, pinned: true })).toBe(held)
  })
})
