import { afterAll, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { clearedQueuedTimerProbe, concurrentNodeRealmRunner, cpuQueueProbe, nodeRealmRunner, values } from "./support/node-realm.ts"

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "browse-realm-cpu-"))
const runInNode = nodeRealmRunner(path.join(scratch, "home"))
const runConcurrently = concurrentNodeRealmRunner(path.join(scratch, "home"))
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }))

test("the sustained budget charges CPU time, not slices stretched by a loaded machine or other sessions", () => {
  const sliceMs = 100
  // host.stall keeps the relay thread off the CPU mid-slice, as a descheduled thread or a page fault does.
  const setup = `
    const stallCell = new Int32Array(new SharedArrayBuffer(4))
    host.stall = (ms) => { Atomics.wait(stallCell, 0, 0, ms) }
    host.later = () => new Promise((resolve) => setTimeout(resolve, 1))
    host.busyOtherSession = () => { const other = setInterval(() => { const end = performance.now() + 40; while (performance.now() < end) {} }, 10); setTimeout(() => clearInterval(other), 1500) }
  `
  const outcomes = runInNode([
    `for (let i = 0; i < 40; i++) { host.stall(${sliceMs * 0.05}); await host.later() } return "short stalls"`,
    `for (let i = 0; i < 6; i++) { host.stall(${sliceMs * 0.6}); await host.later() } return "long stalls"`,
    `host.busyOtherSession(); for (let i = 0; i < 40; i++) await host.later(); return "busy relay"`,
  ], setup, { OPENCODE_BROWSER_EXECUTE_SLICE_MS: String(sliceMs) })
  expect(values(outcomes)).toEqual([{ value: "short stalls" }, { value: "long stalls" }, { value: "busy relay" }])
}, 30_000)

test("sessions share one CPU budget and take turns when together they want more", () => {
  const sliceMs = 100
  const realms = 6
  // Each realm alone stays under half its own window (60-80ms of work per ~320ms), but together
  // they want the relay thread more than all of the time.
  const body = (wait: string) => `
    const deadline = performance.now() + 1500
    let iterations = 0
    while (performance.now() < deadline) {
      host.busy(60 + Math.random() * 20)
      iterations += 1
      ${wait}
    }
    return iterations
  `
  const outcomes = runConcurrently(
    Array.from({ length: realms }, (_, index) => body(index % 2 === 0 ? "await new Promise(resolve => setTimeout(resolve, 240))" : "await host.sleep(240)")),
    "",
    { OPENCODE_BROWSER_EXECUTE_SLICE_MS: String(sliceMs) },
  )
  const stopped = outcomes.outcomes.map((outcome) => outcome.stopped ?? outcome.error)
  expect(stopped, "no realm is stopped by its own budget").toEqual(Array(realms).fill(undefined))
  const progress = outcomes.outcomes.map((outcome) => outcome.value)
  expect(progress.every((value) => typeof value === "number" && value > 0), `iterations: ${JSON.stringify(progress)}`).toBe(true)
  // The relay thread is not pinned: sandbox work takes about half of it, plus scheduling overhead.
  expect(outcomes.cpuMs / outcomes.wallMs).toBeLessThan(0.7)
  // No single slice or queue wait keeps the loop from its timers longer than one slice plus noise.
  expect(outcomes.maxStallMs).toBeLessThan(sliceMs + 250)
}, 30_000)

test("a granted turn that runs no sandbox code hands the queue on", () => {
  const sliceMs = 100
  const { cancelWaitMs, releaseWaitMs } = cpuQueueProbe(path.join(scratch, "home"), sliceMs)
  // The fallback timer would add a full slice to each wait.
  expect(cancelWaitMs).toBeLessThan(sliceMs / 2)
  expect(releaseWaitMs).toBeLessThan(sliceMs / 2)
}, 30_000)

test("a timer cleared while it waits for a turn does not delay the next timer by a slice", () => {
  const sliceMs = 300
  const { firstRan, secondDelayMs } = clearedQueuedTimerProbe(path.join(scratch, "home"), sliceMs)
  expect(firstRan, "the cleared timer never ran").toBe(false)
  expect(secondDelayMs).not.toBeNull()
  // About one and a half slices until the relay budget frees; the fallback would add another full slice.
  expect(secondDelayMs!).toBeLessThan(sliceMs * 1.9)
}, 30_000)
