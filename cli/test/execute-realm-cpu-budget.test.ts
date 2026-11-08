import { afterAll, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { nodeRealmRunner, values } from "./support/node-realm.ts"

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "browse-realm-cpu-"))
const runInNode = nodeRealmRunner(path.join(scratch, "home"))
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
