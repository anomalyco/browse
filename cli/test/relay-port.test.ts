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
  configuredRelayPort,
  endpointForPort,
  lastRelayPortPath,
  liveRelayPort,
  probeRelayPort,
  readLastRelayPort,
  readRelayState,
  relayPortCandidates,
  relayStatePath,
  verifiedRelayEndpoint,
  writeLastRelayPort,
  writeRelayState,
} from "../src/relay/port.ts"
import { readRelayConfig, writeRelayConfig } from "../src/relay/config.ts"
import { startRelay } from "../src/relay.ts"
import { extensionStatus } from "../src/setup/commands.ts"
import { relayToken } from "../src/relay/secrets.ts"
import { freePort } from "./support/ports.ts"
import type { RelayVersion } from "../src/relay/schema.ts"

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
        // The reply the issue reporter captured: version, pid and activeExecutes, but not browse's buildId or startedAt.
        return Response.json({ version: "0.12.0", pid: 75049, activeExecutes: 0 })
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

  test("only browse's /version shape counts, not a foreign relay with version and instanceId", async () => {
    const port = await freePortOutsideBrowseRange()
    let reply: Record<string, unknown> = {
      version: "0.0.17",
      buildId: "build",
      instanceId: "instance",
      startedAt: "2026-01-01T00:00:00.000Z",
      shutdownProtocol: 2,
    }
    using fake = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => Response.json(reply) })
    expect(await probeRelayPort(port)).toBe("browse")
    // The reported Playwriter 0.12.0 reply, without an instanceId.
    reply = { version: "0.12.0", pid: 75049, activeExecutes: 0 }
    expect(await probeRelayPort(port)).toBe("other")
    // Some Playwriter replies also carry an instanceId.
    reply = { version: "0.12.0", pid: 75049, instanceId: "6f1c2a44-3b5d-4d6e-9a8f-0c1d2e3f4a5b", activeExecutes: 0 }
    expect(await probeRelayPort(port)).toBe("other")
    reply = { version: "0.12.0", instanceId: "6f1c2a44-3b5d-4d6e-9a8f-0c1d2e3f4a5b" }
    expect(await probeRelayPort(port)).toBe("other")
    reply = { version: "0.12.0" }
    expect(await probeRelayPort(port)).toBe("other")
  })

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
          ? Response.json({ version: "9.9.9", buildId: "fake-build", instanceId: "fake-relay", startedAt: "2026-01-01T00:00:00.000Z", shutdownProtocol: 2 })
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

  test("a Playwriter-shaped listener is another program: version() rejects it and ensureRelay decides to start a relay", async () => {
    const held = await freePortOutsideBrowseRange()
    const fallback = await freePortOutsideBrowseRange()
    let mine = false
    const instanceId = "browse-after-start"
    // The harder Playwriter variant, with an instanceId: still no browse build or start time.
    using other = Bun.serve({
      hostname: "127.0.0.1",
      port: held,
      fetch: (request) => new URL(request.url).pathname === "/version"
        ? Response.json(mine
            ? { version: "9.9.9", buildId: "browse-build", instanceId, startedAt: "2026-01-01T00:00:00.000Z", shutdownProtocol: 2 }
            : { version: "0.12.0", pid: 75049, instanceId: "6f1c2a44-3b5d-4d6e-9a8f-0c1d2e3f4a5b", activeExecutes: 0 })
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
      fetch: () => Response.json({ version: "9.9.9", buildId: "recorded-build", instanceId: "recorded-instance", startedAt: "2026-01-01T00:00:00.000Z", shutdownProtocol: 2 }),
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

  test("an unpinned restart with only a foreign listener starts a new relay", async () => {
    const newRelay = {
      version: "0.0.15",
      buildId: "2026-11-06T00:00:00Z",
      instanceId: "new-relay",
      managed: true,
      shutdownProtocol: 2 as const,
    }
    let calls = 0
    let started = 0
    const relay = {
      endpoint: "http://127.0.0.1:19988",
      version: Effect.suspend(() => {
        calls++
        if (calls === 1) return Effect.fail(new RelayClient.RelayDecodeFailed({
          message: "in use by another program (not a browse /version response)",
          path: "/version",
          cause: { version: "0.10.0" },
        }))
        return Effect.succeed(newRelay)
      }),
    } as unknown as RelayClient.Interface
    const readiness = await Effect.runPromise(restartRelay({
      relay,
      buildId: newRelay.buildId,
      start: Effect.sync(() => {
        started++
      }),
      retryTimes: 2,
      retryDelayMs: 1,
    }))
    expect(started).toBe(1)
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
      versionReply = { version: "9.9.9", buildId: "answered-build", instanceId: "answered-instance", startedAt: "2026-01-01T00:00:00.000Z", shutdownProtocol: 2 }
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

  test("a pinned-port drain retries a /version cut off while relay.json still names the old relay", async () => {
    const port = await freePortOutsideBrowseRange()
    const previousPort = process.env.OPENCODE_BROWSER_PORT
    process.env.OPENCODE_BROWSER_PORT = String(port)
    const old = {
      version: "0.0.15",
      buildId: "2026-11-06T00:00:00Z",
      instanceId: "old-relay",
      managed: true,
      shutdownProtocol: 2 as const,
    }
    const replacement = { ...old, instanceId: "new-relay" }
    try {
      writeRelayState({ port, configuredPort: port, pid: process.pid, instanceId: old.instanceId, startedAt: new Date().toISOString() })
      let calls = 0
      const draining = {
        endpoint: endpointForPort(port),
        version: Effect.suspend(() => {
          calls++
          // The old relay answers twice, then cuts the drain probe as it stops; relay.json still names it. The next
          // probe finds the replacement on the pinned port.
          if (calls <= 2) return Effect.succeed(old)
          if (calls === 3) return Effect.fail(new RelayClient.RelayDecodeFailed({
            message: "in use by another program (not a browse /version response)",
            path: "/version",
            cause: { version: "0.10.0" },
          }))
          return Effect.succeed(replacement)
        }),
        shutdown: () => Effect.succeed({ stopping: true as const }),
      } as unknown as RelayClient.Interface
      const readiness = await Effect.runPromise(restartRelay({
        relay: draining,
        buildId: old.buildId,
        retryTimes: 1,
        retryDelayMs: 1,
      }))
      expect(calls).toBe(4)
      expect(readiness.started).toBe(false)
      expect(readiness.version.instanceId).toBe("new-relay")
      expect(readiness.waitForReconnect).toBe(true)
    } finally {
      fs.rmSync(relayStatePath(), { force: true })
      if (previousPort === undefined) delete process.env.OPENCODE_BROWSER_PORT
      else process.env.OPENCODE_BROWSER_PORT = previousPort
    }
  })

  test("a pinned-port drain whose relay.json is gone keeps a cut /version a hard error", async () => {
    const port = await freePortOutsideBrowseRange()
    const previousPort = process.env.OPENCODE_BROWSER_PORT
    process.env.OPENCODE_BROWSER_PORT = String(port)
    const old = {
      version: "0.0.15",
      buildId: "2026-11-06T00:00:00Z",
      instanceId: "old-relay",
      managed: true,
      shutdownProtocol: 2 as const,
    }
    let calls = 0
    let started = 0
    const draining = {
      endpoint: endpointForPort(port),
      version: Effect.suspend(() => {
        calls++
        if (calls <= 2) return Effect.succeed(old)
        // The old relay and its record are gone together: a listener on the pinned port is not ours to wait for.
        fs.rmSync(relayStatePath(), { force: true })
        return Effect.fail(new RelayClient.RelayDecodeFailed({
          message: "in use by another program (not a browse /version response)",
          path: "/version",
          cause: { version: "0.10.0" },
        }))
      }),
      shutdown: () => Effect.succeed({ stopping: true as const }),
    } as unknown as RelayClient.Interface
    try {
      writeRelayState({ port, configuredPort: port, pid: process.pid, instanceId: old.instanceId, startedAt: new Date().toISOString() })
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
      expect(calls).toBe(3)
    } finally {
      fs.rmSync(relayStatePath(), { force: true })
      if (previousPort === undefined) delete process.env.OPENCODE_BROWSER_PORT
      else process.env.OPENCODE_BROWSER_PORT = previousPort
    }
  })

  test("a pinned-port restart waits out a confirmed /version cut off by another drain", async () => {
    const port = await freePortOutsideBrowseRange()
    const previousPort = process.env.OPENCODE_BROWSER_PORT
    process.env.OPENCODE_BROWSER_PORT = String(port)
    const old = {
      version: "0.0.15",
      buildId: "2026-11-06T00:00:00Z",
      instanceId: "old-relay",
      managed: true,
      shutdownProtocol: 2 as const,
    }
    const replacement = { ...old, instanceId: "new-relay" }
    let calls = 0
    const draining = {
      endpoint: endpointForPort(port),
      version: Effect.suspend(() => {
        calls++
        if (calls === 1) return Effect.succeed(old)
        if (calls === 2) return Effect.fail(new RelayClient.RelayDecodeFailed({
          message: "in use by another program (not a browse /version response)",
          path: "/version",
          cause: { version: "0.10.0" },
        }))
        return Effect.succeed(calls === 3 ? old : replacement)
      }),
      shutdown: () => Effect.succeed({ stopping: true as const }),
    } as unknown as RelayClient.Interface
    try {
      writeRelayState({ port, configuredPort: port, pid: process.pid, instanceId: old.instanceId, startedAt: new Date().toISOString() })
      const readiness = await Effect.runPromise(restartRelay({
        relay: draining,
        buildId: old.buildId,
        retryTimes: 1,
        retryDelayMs: 1,
      }))
      expect(calls).toBe(4)
      expect(readiness.started).toBe(false)
      expect(readiness.version.instanceId).toBe("new-relay")
      expect(readiness.waitForReconnect).toBe(true)
    } finally {
      fs.rmSync(relayStatePath(), { force: true })
      if (previousPort === undefined) delete process.env.OPENCODE_BROWSER_PORT
      else process.env.OPENCODE_BROWSER_PORT = previousPort
    }
  })

  test("a pinned ensureRelay starts one relay after a drain ends without a replacement", async () => {
    const port = await freePortOutsideBrowseRange()
    const previousPort = process.env.OPENCODE_BROWSER_PORT
    process.env.OPENCODE_BROWSER_PORT = String(port)
    const old = {
      version: "0.0.15",
      buildId: "2026-11-06T00:00:00Z",
      instanceId: "old-relay",
      managed: true,
      shutdownProtocol: 2 as const,
    }
    const startedRelay = { ...old, instanceId: "started-relay" }
    let calls = 0
    let starts = 0
    const relay = {
      endpoint: endpointForPort(port),
      version: Effect.suspend((): Effect.Effect<RelayVersion, RelayClient.RelayClientError> => {
        calls++
        if (calls === 1) return Effect.fail(new RelayClient.RelayDecodeFailed({
          message: "in use by another program (not a browse /version response)",
          path: "/version",
          cause: { version: "0.10.0" },
        }))
        if (calls === 2) {
          // The other process's drain finished and removed the record without starting a replacement.
          fs.rmSync(relayStatePath(), { force: true })
          return Effect.fail(new RelayClient.RelayUnreachable({
            message: "relay is gone",
            endpoint: endpointForPort(port),
            path: "/version",
            cause: undefined,
          }))
        }
        return Effect.succeed(startedRelay)
      }),
    } as unknown as RelayClient.Interface
    try {
      writeRelayState({ port, configuredPort: port, pid: process.pid, instanceId: old.instanceId, startedAt: new Date().toISOString() })
      const readiness = await Effect.runPromise(ensureRelay({
        relay,
        start: Effect.sync(() => {
          starts++
        }),
        retryTimes: 1,
        retryDelayMs: 1,
      }))
      expect(calls).toBe(3)
      expect(starts).toBe(1)
      expect(readiness.started).toBe(true)
      expect(readiness.version.instanceId).toBe("started-relay")
    } finally {
      fs.rmSync(relayStatePath(), { force: true })
      if (previousPort === undefined) delete process.env.OPENCODE_BROWSER_PORT
      else process.env.OPENCODE_BROWSER_PORT = previousPort
    }
  })

  test("an unpinned ensureRelay starts past a drain on a stale live record", async () => {
    const recordedPort = await freePortOutsideBrowseRange()
    const previousPort = process.env.OPENCODE_BROWSER_PORT
    delete process.env.OPENCODE_BROWSER_PORT
    const stale = {
      version: "0.0.15",
      buildId: "2026-11-06T00:00:00Z",
      instanceId: "stale-relay",
      managed: true,
      shutdownProtocol: 2 as const,
    }
    const startedRelay = { ...stale, instanceId: "started-relay" }
    let calls = 0
    let starts = 0
    const decode = () => new RelayClient.RelayDecodeFailed({
      message: "in use by another program (not a browse /version response)",
      path: "/version",
      cause: { version: "0.10.0" },
    })
    const relay = {
      endpoint: endpointForPort(recordedPort),
      version: Effect.suspend((): Effect.Effect<RelayVersion, RelayClient.RelayClientError> => {
        calls++
        return calls <= 3 ? Effect.fail(decode()) : Effect.succeed(startedRelay)
      }),
    } as unknown as RelayClient.Interface
    try {
      writeRelayState({ port: recordedPort, configuredPort: configuredRelayPort(), pid: process.pid, instanceId: stale.instanceId, startedAt: new Date().toISOString() })
      const readiness = await Effect.runPromise(ensureRelay({
        relay,
        start: Effect.sync(() => {
          starts++
        }),
        retryTimes: 1,
        retryDelayMs: 1,
      }))
      expect(calls).toBe(4)
      expect(starts).toBe(1)
      expect(readiness.started).toBe(true)
      expect(readiness.version.instanceId).toBe("started-relay")
    } finally {
      fs.rmSync(relayStatePath(), { force: true })
      if (previousPort === undefined) delete process.env.OPENCODE_BROWSER_PORT
      else process.env.OPENCODE_BROWSER_PORT = previousPort
    }
  })

  test("an unpinned restart starts past a drain on a stale live record", async () => {
    const recordedPort = await freePortOutsideBrowseRange()
    const previousPort = process.env.OPENCODE_BROWSER_PORT
    delete process.env.OPENCODE_BROWSER_PORT
    const stale = {
      version: "0.0.15",
      buildId: "2026-11-06T00:00:00Z",
      instanceId: "stale-relay",
      managed: true,
      shutdownProtocol: 2 as const,
    }
    const startedRelay = { ...stale, instanceId: "started-relay" }
    let calls = 0
    let starts = 0
    const decode = () => new RelayClient.RelayDecodeFailed({
      message: "in use by another program (not a browse /version response)",
      path: "/version",
      cause: { version: "0.10.0" },
    })
    const relay = {
      endpoint: endpointForPort(recordedPort),
      version: Effect.suspend((): Effect.Effect<RelayVersion, RelayClient.RelayClientError> => {
        calls++
        return calls <= 3 ? Effect.fail(decode()) : Effect.succeed(startedRelay)
      }),
    } as unknown as RelayClient.Interface
    try {
      writeRelayState({ port: recordedPort, configuredPort: configuredRelayPort(), pid: process.pid, instanceId: stale.instanceId, startedAt: new Date().toISOString() })
      const readiness = await Effect.runPromise(restartRelay({
        relay,
        buildId: stale.buildId,
        start: Effect.sync(() => {
          starts++
        }),
        retryTimes: 1,
        retryDelayMs: 1,
      }))
      expect(calls).toBe(4)
      expect(starts).toBe(1)
      expect(readiness.started).toBe(true)
      expect(readiness.version.instanceId).toBe("started-relay")
    } finally {
      fs.rmSync(relayStatePath(), { force: true })
      if (previousPort === undefined) delete process.env.OPENCODE_BROWSER_PORT
      else process.env.OPENCODE_BROWSER_PORT = previousPort
    }
  })

  test("a pinned port with a live-looking relay.json and another program fails with the port error", async () => {
    const port = await freePortOutsideBrowseRange()
    const previousPort = process.env.OPENCODE_BROWSER_PORT
    process.env.OPENCODE_BROWSER_PORT = String(port)
    const stale = {
      version: "0.0.15",
      buildId: "2026-11-06T00:00:00Z",
      instanceId: "stale-relay",
      managed: true,
      shutdownProtocol: 2 as const,
    }
    let calls = 0
    let starts = 0
    const decode = () => new RelayClient.RelayDecodeFailed({
      message: "in use by another program (not a browse /version response)",
      path: "/version",
      cause: { version: "0.10.0" },
    })
    const relay = {
      endpoint: endpointForPort(port),
      version: Effect.suspend(() => {
        calls++
        return Effect.fail(decode())
      }),
      shutdown: () => Effect.succeed({ stopping: true as const }),
    } as unknown as RelayClient.Interface
    try {
      writeRelayState({ port, configuredPort: port, pid: process.pid, instanceId: stale.instanceId, startedAt: new Date().toISOString() })
      const restart = await Effect.runPromise(restartRelay({
        relay,
        buildId: stale.buildId,
        start: Effect.sync(() => {
          starts++
        }),
        retryTimes: 1,
        retryDelayMs: 1,
      }).pipe(Effect.flip))
      expect(restart).toBeInstanceOf(RelayClient.RelayDecodeFailed)
      expect(calls).toBe(3)
      calls = 0
      const ensure = await Effect.runPromise(ensureRelay({
        relay,
        start: Effect.sync(() => {
          starts++
        }),
        retryTimes: 1,
        retryDelayMs: 1,
      }).pipe(Effect.flip))
      expect(ensure).toBeInstanceOf(RelayClient.RelayDecodeFailed)
      expect(calls).toBe(3)
      expect(starts).toBe(0)
    } finally {
      fs.rmSync(relayStatePath(), { force: true })
      if (previousPort === undefined) delete process.env.OPENCODE_BROWSER_PORT
      else process.env.OPENCODE_BROWSER_PORT = previousPort
    }
  })

  test("a pinned-port drain that keeps answering as the old relay stays RelayStillRunning", async () => {
    const port = await freePortOutsideBrowseRange()
    const previousPort = process.env.OPENCODE_BROWSER_PORT
    process.env.OPENCODE_BROWSER_PORT = String(port)
    const old = {
      version: "0.0.15",
      buildId: "2026-11-06T00:00:00Z",
      instanceId: "old-relay",
      managed: true,
      shutdownProtocol: 2 as const,
    }
    let calls = 0
    const relay = {
      endpoint: endpointForPort(port),
      version: Effect.suspend(() => {
        calls++
        return Effect.succeed(old)
      }),
      shutdown: () => Effect.succeed({ stopping: true as const }),
    } as unknown as RelayClient.Interface
    try {
      writeRelayState({ port, configuredPort: port, pid: process.pid, instanceId: old.instanceId, startedAt: new Date().toISOString() })
      const error = await Effect.runPromise(restartRelay({
        relay,
        buildId: old.buildId,
        retryTimes: 1,
        retryDelayMs: 1,
      }).pipe(Effect.flip))
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toContain("still draining")
      expect(calls).toBe(4)
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
      fetch: () => Response.json({ version: "9.9.9", buildId: "live-build", instanceId: "live-relay", startedAt: "2026-01-01T00:00:00.000Z", shutdownProtocol: 2 }),
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

  test("a remote listen keeps the last port record; a loopback one ignores it", async () => {
    const configured = await freePortOutsideBrowseRange()
    const recordedPort = await freePortOutsideBrowseRange()
    const candidate = await freePortOutsideBrowseRange()
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "browse-relay-last-port-"))
    try {
      writeLastRelayPort(recordedPort, root, configured)
      expect(readLastRelayPort(root, configured)).toBe(recordedPort)
      expect(await chooseRelayPort({ configuredPort: configured, pinned: false, host: "0.0.0.0", candidates: [candidate], root })).toBe(recordedPort)
      expect(await chooseRelayPort({ configuredPort: configured, pinned: false, host: "127.0.0.1", candidates: [candidate], root })).toBe(candidate)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("a remote relay starts on the same port again after shutdown", async () => {
    const previousConfig = readRelayConfig()
    writeRelayConfig({ hostname: "0.0.0.0" })
    const first = await freePortOutsideBrowseRange()
    const second = await freePortOutsideBrowseRange()
    fs.rmSync(lastRelayPortPath(), { force: true })
    try {
      const started = await Effect.runPromise(Effect.gen(function* () {
        const relay = yield* startRelay({ portCandidates: [first, second] })
        return relay.url
      }).pipe(Effect.scoped))
      expect(new URL(started).port).toBe(String(first))
      // relay.json is gone after shutdown; last-port.json is not.
      expect(readRelayState()).toBeUndefined()
      expect(readLastRelayPort()).toBe(first)
      expect(JSON.parse(fs.readFileSync(lastRelayPortPath(), "utf8"))).toEqual({ port: first })
      if (process.platform !== "win32") expect(fs.statSync(lastRelayPortPath()).mode & 0o777).toBe(0o600)
      const restarted = await Effect.runPromise(Effect.gen(function* () {
        const relay = yield* startRelay({ portCandidates: [second] })
        return relay.url
      }).pipe(Effect.scoped))
      expect(new URL(restarted).port).toBe(String(first))
    } finally {
      writeRelayConfig(previousConfig)
    }
  }, 30_000)

  test("a lookalike endpoint is refused while a live relay.json names another port", async () => {
    const configured = await freePortOutsideBrowseRange()
    const lookalike = await freePortOutsideBrowseRange()
    const recorded = await freePortOutsideBrowseRange()
    const previousPort = process.env.OPENCODE_BROWSER_PORT
    process.env.OPENCODE_BROWSER_PORT = String(configured)
    const sent: Array<string | undefined> = []
    using fake = Bun.serve({
      hostname: "127.0.0.1",
      port: lookalike,
      fetch: (request) => {
        sent.push(header(request, "authorization"))
        return new URL(request.url).pathname === "/version"
          ? Response.json({ version: "9.9.9", buildId: "lookalike-build", instanceId: "lookalike", startedAt: "2026-01-01T00:00:00.000Z", shutdownProtocol: 2 })
          : Response.json({ connected: true })
      },
    })
    try {
      writeRelayState({
        port: recorded,
        configuredPort: configured,
        pid: process.pid,
        instanceId: "the-real-relay",
        startedAt: new Date().toISOString(),
      })
      await Effect.runPromise(Effect.gen(function* () {
        const client = yield* RelayClient.make({ endpoint: endpointForPort(lookalike) })
        const version = yield* Effect.result(client.version)
        expect(version._tag).toBe("Failure")
        if (version._tag === "Failure") expect(version.failure).toBeInstanceOf(RelayClient.RelayDecodeFailed)
        const status = yield* Effect.result(client.extensionStatus)
        expect(status._tag).toBe("Failure")
        if (status._tag === "Failure") expect(status.failure).toBeInstanceOf(RelayClient.RelayDecodeFailed)
      }).pipe(Effect.provide(NodeHttpClient.layerNodeHttp)))
      expect(sent.length).toBeGreaterThan(0)
      expect(sent.every((value) => value === undefined)).toBe(true)
      // Verification also resolves the port from that same record, not from the lookalike.
      expect(await verifiedRelayEndpoint()).toBeUndefined()
    } finally {
      fs.rmSync(relayStatePath(), { force: true })
      if (previousPort === undefined) delete process.env.OPENCODE_BROWSER_PORT
      else process.env.OPENCODE_BROWSER_PORT = previousPort
    }
  }, 30_000)

  test("relay.json with an empty instance or another configured port is not a relay", async () => {
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
      fs.writeFileSync(relayStatePath(root, configured), JSON.stringify({
        port: await freePortOutsideBrowseRange(),
        configuredPort: configured + 1,
        pid: process.pid,
        instanceId: "wrong-configured-port",
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
