import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { Page } from "patchright-core"
import { Recorder } from "../src/network-capture.ts"
import { RelayShutdown, type RelayBusy } from "../src/relay-shutdown.ts"

// A network capture nobody stopped used to keep `relay restart` (and so `update`) refusing forever. Captures now end
// by themselves after a maximum duration, the refusal says what blocks the restart, and a forced restart ends it.

/** Enough of a Playwright page for the recorder to listen to. */
const page = { on() {}, off() {}, isClosed: () => false, url: () => "https://example.com/" } as unknown as Page

describe("network capture lifetime", () => {
  test("a capture ends by itself after maxDurationMs, and a late stop says why", async () => {
    const recorder = new Recorder()
    const started = await Effect.runPromise(recorder.start(page, { maxDurationMs: 50 }))
    expect(started.active).toBe(true)
    expect(started.endsAt).toBeString()
    await Bun.sleep(150)
    expect(recorder.status()).toMatchObject({ active: false, ended: expect.stringContaining("maximum duration") })
    const stop = await Effect.runPromise(Effect.flip(recorder.stop()))
    expect(stop.message).toContain("it ended because it reached its maximum duration")
    // A new capture starts clean.
    await Effect.runPromise(recorder.start(page))
    expect(recorder.status().ended).toBeUndefined()
    await Effect.runPromise(recorder.cancel())
  })

  test("end() discards the capture and records the reason; a capture stopped in time is not ended later", async () => {
    const recorder = new Recorder()
    await Effect.runPromise(recorder.start(page, { maxDurationMs: 80 }))
    expect((await Effect.runPromise(recorder.end("its client (process 1) exited"))).cancelled).toBe(true)
    expect(recorder.status().ended).toBe("its client (process 1) exited")
    await Effect.runPromise(recorder.start(page, { maxDurationMs: 80 }))
    await Effect.runPromise(recorder.stop())
    await Bun.sleep(150)
    expect(recorder.status()).toEqual(expect.objectContaining({ active: false }))
    expect(recorder.status().ended).toBeUndefined()
  })

  test("maxDurationMs is validated", async () => {
    const recorder = new Recorder()
    const error = await Effect.runPromise(Effect.flip(recorder.start(page, { maxDurationMs: 0 })))
    expect(error.message).toContain("maxDurationMs")
  })
})

describe("restarting past a forgotten capture", () => {
  const shutdown = (state: { busy: RelayBusy | undefined; released: number }) => new RelayShutdown({
    instanceId: "relay-1",
    managed: true,
    timeoutMs: 1_000,
    drain: Effect.void,
    resume: () => {},
    busy: () => state.busy,
    release: Effect.sync(() => {
      state.released += 1
      state.busy = undefined
    }),
    settle: Effect.void,
    quiescent: () => true,
    audit: () => Effect.void,
    stop: () => {},
  })
  const request = (force?: boolean) => ({
    instanceId: "relay-1",
    requestId: crypto.randomUUID(),
    reason: "explicit-restart" as const,
    client: { kind: "cli" as const, instanceId: "client-1", buildId: "2026-10-28T00:00:00.000Z" },
    ...(force === undefined ? {} : { force }),
  })

  test("the refusal names what blocks it and how to get through", async () => {
    const state = { busy: { reason: "recordings", detail: "a network capture in session mcp-1a2b3c4d (since 2026-10-28T01:00:00.000Z)" } as RelayBusy | undefined, released: 0 }
    const error = await Effect.runPromise(Effect.flip(shutdown(state).request(request())))
    expect(error.message).toContain("a network capture in session mcp-1a2b3c4d")
    expect(error.message).toContain("relay restart --force")
    expect(state.released).toBe(0)
  })

  test("--force ends it and restarts", async () => {
    const state = { busy: { reason: "recordings", detail: "a recording of tab 7" } as RelayBusy | undefined, released: 0 }
    await Effect.runPromise(shutdown(state).request(request(true)))
    expect(state.released).toBe(1)
  })
})
