import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Effect, Fiber, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { TestClock } from "effect/testing"
import * as RelayClient from "../src/relay/client.ts"

// The client reads the relay token from the data folder; keep it away from the real install.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "browse-relay-client-"))
const previousHome = process.env.OPENCODE_BROWSER_HOME
process.env.OPENCODE_BROWSER_HOME = home
afterAll(() => {
  if (previousHome === undefined) delete process.env.OPENCODE_BROWSER_HOME
  else process.env.OPENCODE_BROWSER_HOME = previousHome
  fs.rmSync(home, { recursive: true, force: true })
})

const version = { version: "0.0.15", buildId: "2026-11-06T00:00:00Z" }

/** A relay whose nth /version answer arrives after `versionDelays[n]` test-clock seconds, and POSTs after `postSeconds`. */
function fakeRelay(options: { readonly versionDelays: readonly (number | "never")[]; readonly postSeconds?: number }) {
  let versionCalls = 0
  return HttpClient.make((request, url) => {
    const delay = url.pathname === "/version" ? options.versionDelays[versionCalls++] ?? "never" : options.postSeconds ?? 0
    const body = url.pathname === "/version" ? version : { closed: [] }
    return delay === "never"
      ? Effect.never
      : Effect.sleep(`${delay} seconds`).pipe(Effect.as(HttpClientResponse.fromWeb(request, Response.json(body))))
  })
}

const withRelay = <A, E>(
  relay: HttpClient.HttpClient,
  use: (client: RelayClient.Interface) => Effect.Effect<A, E>,
  elapse: number,
) =>
  Effect.gen(function* () {
    const client = yield* RelayClient.make({ endpoint: "http://127.0.0.1:19988" })
    const fiber = yield* Effect.forkChild(Effect.exit(use(client)))
    yield* TestClock.adjust(`${elapse} seconds`)
    return yield* Fiber.join(fiber)
  }).pipe(
    Effect.provide(Layer.mergeAll(TestClock.layer(), Layer.succeed(HttpClient.HttpClient, relay))),
    Effect.runPromise,
  )

const failureTag = (exit: { readonly _tag: string; readonly cause?: unknown }) =>
  exit._tag === "Failure" ? JSON.stringify(exit.cause) : undefined

describe("RelayClient read timeouts", () => {
  test("a listener that has never answered fails fast", async () => {
    const exit = await withRelay(fakeRelay({ versionDelays: ["never"] }), (client) => client.version, 6)
    expect(exit._tag).toBe("Failure")
    expect(failureTag(exit)).toContain("isn't answering (/version timed out after 5s)")
  })

  test("a relay that answered before gets time to answer while busy", async () => {
    const exit = await withRelay(
      fakeRelay({ versionDelays: [0, 12] }),
      (client) => client.version.pipe(Effect.andThen(client.version)),
      13,
    )
    expect(exit).toMatchObject({ _tag: "Success", value: version })
  })

  test("a relay that answered before and then stops answering still fails, after the longer wait", async () => {
    const exit = await withRelay(
      fakeRelay({ versionDelays: [0, "never"] }),
      (client) => client.version.pipe(Effect.andThen(client.version)),
      31,
    )
    expect(exit._tag).toBe("Failure")
    expect(failureTag(exit)).toContain("isn't answering (/version timed out after 30s)")
  })

  test("a long write survives liveness checks that answer slowly", async () => {
    // Every check during the 70 s write takes 12 s: the relay is busy, not frozen.
    const exit = await withRelay(
      fakeRelay({ versionDelays: [0, 12, 12, 12], postSeconds: 70 }),
      (client) => client.version.pipe(Effect.andThen(client.tabsCleanup())),
      71,
    )
    expect(exit).toMatchObject({ _tag: "Success", value: { closed: [] } })
  })
})
