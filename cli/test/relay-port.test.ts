import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { NodeHttpClient } from "@effect/platform-node"
import { Effect } from "effect"
import * as RelayClient from "../src/relay/client.ts"
import { ensureRelay, restartRelay } from "../src/relay/lifecycle.ts"
import {
  chooseRelayPort,
  endpointForPort,
  liveRelayPort,
  probeRelayPort,
  readRelayState,
  relayPortCandidates,
  relayStatePath,
  writeRelayState,
} from "../src/relay/port.ts"
import { startRelay } from "../src/relay.ts"
import { extensionStatus } from "../src/setup/commands.ts"
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
      // State is per configured port, next to that port's lifecycle log, and never the token.
      expect(relayStatePath()).toBe(path.join(home, "relays", "19988", "relay.json"))
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

  test("a version-only listener is another program: version() rejects it and ensureRelay starts past it", async () => {
    const held = await freePortOutsideBrowseRange()
    const fallback = await freePortOutsideBrowseRange()
    let mine = false
    const instanceId = "browse-after-start"
    // Playwriter's relay answers GET /version with just `{ version }`.
    using other = Bun.serve({
      hostname: "127.0.0.1",
      port: held,
      fetch: (request) => new URL(request.url).pathname === "/version"
        ? Response.json(mine ? { version: "9.9.9", instanceId } : { version: "0.10.0" })
        : Response.json({ error: "unauthorized" }, { status: 401 }),
    })
    // A definite non-browse reply is what lets the relay move to a fallback port.
    expect(await chooseRelayPort({ configuredPort: held, pinned: false, candidates: [held, fallback] })).toBe(fallback)
    await Effect.runPromise(Effect.gen(function* () {
      const client = yield* RelayClient.make({ endpoint: endpointForPort(held) })
      const failure = yield* Effect.result(client.version)
      expect(failure._tag).toBe("Failure")
      if (failure._tag === "Failure") expect(failure.failure).toBeInstanceOf(RelayClient.RelayDecodeFailed)
      let started = 0
      const readiness = yield* ensureRelay({
        relay: client,
        start: Effect.sync(() => {
          started++
          mine = true
        }),
        retryTimes: 20,
        retryDelayMs: 10,
      })
      expect(started).toBe(1)
      expect(readiness.started).toBe(true)
      expect(readiness.version.instanceId).toBe(instanceId)
      expect(readiness.buildProblem).toBeString()
    }).pipe(Effect.provide(NodeHttpClient.layerNodeHttp)))
  }, 30_000)

  test("an unpinned relay refuses to start beside a live relay.json instance", async () => {
    const configuredPort = await freePortOutsideBrowseRange()
    const actualPort = await freePortOutsideBrowseRange()
    const free = await freePortOutsideBrowseRange()
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "browse-relay-state-"))
    using live = Bun.serve({
      hostname: "127.0.0.1",
      port: actualPort,
      fetch: () => Response.json({ version: "9.9.9", instanceId: "recorded-instance" }),
    })
    try {
      writeRelayState({
        port: actualPort,
        configuredPort,
        pid: process.pid,
        instanceId: "recorded-instance",
        startedAt: new Date().toISOString(),
      }, root)
      expect(relayStatePath(root, configuredPort)).toBe(path.join(root, "relays", String(configuredPort), "relay.json"))
      await expect(chooseRelayPort({ configuredPort, pinned: false, candidates: [free], root })).rejects.toThrow(
        `listen EADDRINUSE: address already in use 127.0.0.1:${actualPort}`,
      )
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 30_000)

  test("a port held by something that doesn't answer HTTP stops the start instead of starting a second relay", async () => {
    const held = await freePortOutsideBrowseRange()
    const fallback = await freePortOutsideBrowseRange()
    const silent = net.createServer((socket) => socket.on("data", () => undefined))
    await new Promise<void>((resolve) => silent.listen(held, "127.0.0.1", resolve))
    try {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "browse-relay-state-"))
      try {
        await expect(chooseRelayPort({
          configuredPort: held,
          pinned: false,
          candidates: [held, fallback],
          probeTimeoutMs: 200,
          root,
        })).rejects.toThrow(`listen EADDRINUSE: address already in use 127.0.0.1:${held}`)
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
      }
    } finally {
      silent.close()
    }
  }, 30_000)

  test("a slow relay is not taken for a foreign one and replaced by a second relay", async () => {
    let started = 0
    const relay = {
      endpoint: "http://127.0.0.1:19988",
      version: Effect.fail(new RelayClient.RelayTimedOut({
        message: "The relay on port 19988 isn't answering (/version timed out after 5s).",
        path: "/version",
      })),
    } as unknown as RelayClient.Interface
    const exit = await Effect.runPromise(Effect.exit(ensureRelay({
      relay,
      start: Effect.sync(() => {
        started++
      }),
      retryTimes: 1,
      retryDelayMs: 1,
    })))
    expect(exit._tag).toBe("Failure")
    expect(started).toBe(0)
  })

  test("a restart whose old relay leaves a version-only listener at the endpoint starts a new relay", async () => {
    const managed = {
      version: "0.0.15",
      buildId: "2026-11-06T00:00:00Z",
      instanceId: "old-relay",
      managed: true,
      shutdownProtocol: 2 as const,
    }
    let calls = 0
    let started = 0
    const relay = {
      endpoint: "http://127.0.0.1:19988",
      version: Effect.suspend(() => {
        calls++
        // After the old relay's shutdown it removes relay.json; the endpoint falls back to a port Playwriter holds.
        if (calls === 3) return Effect.fail(new RelayClient.RelayDecodeFailed({
          message: "in use by another program (not a browse /version response)",
          path: "/version",
          cause: { version: "0.10.0" },
        }))
        return Effect.succeed(calls >= 4 ? { ...managed, instanceId: "new-relay" } : managed)
      }),
      shutdown: () => Effect.succeed({ stopping: true as const }),
    } as unknown as RelayClient.Interface
    const readiness = await Effect.runPromise(restartRelay({
      relay,
      buildId: managed.buildId,
      start: Effect.sync(() => {
        started++
      }),
      retryTimes: 2,
      retryDelayMs: 1,
    }))
    expect(started).toBe(1)
    expect(readiness.started).toBe(true)
    expect(readiness.version.instanceId).toBe("new-relay")
  })

  test("setup and RelayClient never send the token to a non-browse or mismatched listener", async () => {
    const port = await freePortOutsideBrowseRange()
    const sent: Array<string | undefined> = []
    let versionReply: Record<string, unknown> = { version: "0.10.0" }
    using fake = Bun.serve({
      hostname: "127.0.0.1",
      port,
      fetch: (request) => {
        const pathname = new URL(request.url).pathname
        sent.push(header(request, "authorization"))
        return pathname === "/version"
          ? Response.json(versionReply)
          : Response.json({ connected: true, activeTargets: 0 })
      },
    })
    relayToken(home)
    const previousPort = process.env.OPENCODE_BROWSER_PORT
    process.env.OPENCODE_BROWSER_PORT = String(port)
    try {
      // Playwriter's reply, with no relay.json: setup finds no relay, and the client refuses before the token.
      const noRelay = async () => {
        expect(await extensionStatus()).toBeUndefined()
        await Effect.runPromise(Effect.gen(function* () {
          const client = yield* RelayClient.make({ endpoint: endpointForPort(port) })
          const failure = yield* Effect.result(client.extensionStatus)
          expect(failure._tag).toBe("Failure")
          if (failure._tag === "Failure") expect(failure.failure).toBeInstanceOf(RelayClient.RelayDecodeFailed)
        }).pipe(Effect.provide(NodeHttpClient.layerNodeHttp)))
      }
      await noRelay()
      expect(sent.length).toBeGreaterThan(0)
      expect(sent.every((value) => value === undefined)).toBe(true)

      // relay.json names the port but a different instance: still not this install's relay, so no token.
      versionReply = { version: "9.9.9", instanceId: "answered-instance" }
      sent.length = 0
      writeRelayState({
        port,
        configuredPort: port,
        pid: process.pid,
        instanceId: "some-other-instance",
        startedAt: new Date().toISOString(),
      })
      await noRelay()
      // version() itself refuses a reply that doesn't match the trusted relay.json instance.
      const mismatched = await Effect.runPromise(Effect.gen(function* () {
        const client = yield* RelayClient.make({ endpoint: endpointForPort(port) })
        return yield* Effect.result(client.version)
      }).pipe(Effect.provide(NodeHttpClient.layerNodeHttp)))
      expect(mismatched._tag).toBe("Failure")
      if (mismatched._tag === "Failure") expect(mismatched.failure).toBeInstanceOf(RelayClient.RelayDecodeFailed)
      expect(sent.every((value) => value === undefined)).toBe(true)

      // The recorded instance answers: now the same call may carry the token.
      sent.length = 0
      writeRelayState({
        port,
        configuredPort: port,
        pid: process.pid,
        instanceId: "answered-instance",
        startedAt: new Date().toISOString(),
      })
      expect(await extensionStatus()).toMatchObject({ connected: true })
      expect(sent.some((value) => value?.startsWith("Bearer "))).toBe(true)
    } finally {
      fs.rmSync(path.join(home, "relays", String(port)), { recursive: true, force: true })
      if (previousPort === undefined) delete process.env.OPENCODE_BROWSER_PORT
      else process.env.OPENCODE_BROWSER_PORT = previousPort
    }
  }, 30_000)

  test("a draining relay on a fallback port is not replaced while relay.json still names it", async () => {
    const configured = await freePortOutsideBrowseRange()
    const fallback = await freePortOutsideBrowseRange()
    const previousPort = process.env.OPENCODE_BROWSER_PORT
    process.env.OPENCODE_BROWSER_PORT = String(configured)
    const startedAt = new Date().toISOString()
    const old = {
      version: "0.0.15",
      buildId: "2026-11-06T00:00:00Z",
      instanceId: "old-relay",
      managed: true,
      shutdownProtocol: 2 as const,
    }
    try {
      writeRelayState({ port: fallback, configuredPort: configured, pid: process.pid, instanceId: old.instanceId, startedAt })
      let calls = 0
      let started = 0
      const draining = {
        endpoint: endpointForPort(fallback),
        version: Effect.suspend(() => {
          calls++
          // The old instance answers while it drains. Once it stops, 19988 answers as another program, but relay.json
          // still names the old instance and its process is alive: that is not an exit yet.
          return calls <= 2
            ? Effect.succeed(old)
            : Effect.fail(new RelayClient.RelayDecodeFailed({
              message: "in use by another program (not a browse /version response)",
              path: "/version",
              cause: { version: "0.10.0" },
            }))
        }),
        shutdown: () => Effect.succeed({ stopping: true as const }),
      } as unknown as RelayClient.Interface
      const exit = await Effect.runPromise(Effect.exit(restartRelay({
        relay: draining,
        buildId: old.buildId,
        start: Effect.sync(() => {
          started++
        }),
        retryTimes: 1,
        retryDelayMs: 1,
      })))
      expect(exit._tag).toBe("Failure")
      expect(started).toBe(0)
    } finally {
      fs.rmSync(relayStatePath(), { force: true })
      if (previousPort === undefined) delete process.env.OPENCODE_BROWSER_PORT
      else process.env.OPENCODE_BROWSER_PORT = previousPort
    }
  })

  test("a pairing file names a port only from a live relay.json", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "browse-relay-live-"))
    const port = await freePortOutsideBrowseRange()
    using live = Bun.serve({
      hostname: "127.0.0.1",
      port,
      fetch: () => Response.json({ version: "9.9.9", instanceId: "live-relay" }),
    })
    try {
      expect(await liveRelayPort({ root })).toBeUndefined()
      writeRelayState({
        port,
        configuredPort: 19988,
        pid: process.pid,
        instanceId: "live-relay",
        startedAt: new Date().toISOString(),
      }, root)
      expect(await liveRelayPort({ root })).toBe(port)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("a remote relay keeps the fallback port its relay.json recorded; a local one doesn't", async () => {
    const configured = await freePortOutsideBrowseRange()
    const recordedPort = await freePortOutsideBrowseRange()
    const candidate = await freePortOutsideBrowseRange()
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "browse-relay-sticky-"))
    try {
      writeRelayState({
        port: recordedPort,
        configuredPort: configured,
        pid: process.pid,
        instanceId: "sticky-relay",
        startedAt: new Date().toISOString(),
      }, root)
      expect(await chooseRelayPort({ configuredPort: configured, pinned: false, host: "0.0.0.0", candidates: [candidate], root })).toBe(recordedPort)
      expect(await chooseRelayPort({ configuredPort: configured, pinned: false, host: "127.0.0.1", candidates: [candidate], root })).toBe(candidate)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("relay.json with an empty instance is not a relay", async () => {
    const configured = await freePortOutsideBrowseRange()
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "browse-relay-state-empty-"))
    try {
      fs.mkdirSync(path.dirname(relayStatePath(root, configured)), { recursive: true })
      fs.writeFileSync(relayStatePath(root, configured), JSON.stringify({
        port: await freePortOutsideBrowseRange(),
        configuredPort: configured,
        pid: process.pid,
        instanceId: "",
        startedAt: new Date().toISOString(),
      }))
      expect(readRelayState(root, configured)).toBeUndefined()
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("candidates are the configured port first, then the fallback range", () => {
    expect(relayPortCandidates(19988)).toEqual([19988, 19990, 19991, 19992, 19993, 19994, 19995, 19996, 19997])
  })

  test("a pinned port is used as is, with no probing or fallback", async () => {
    const held = await freePortOutsideBrowseRange()
    using other = Bun.serve({ hostname: "127.0.0.1", port: held, fetch: () => new Response("Not Found", { status: 404 }) })
    expect(await chooseRelayPort({ configuredPort: held, pinned: true })).toBe(held)
  })
})
