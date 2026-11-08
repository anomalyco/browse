import { afterAll, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { nodeRealmRunner, values } from "./support/node-realm.ts"

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "browse-realm-cpu-"))
const runInNode = nodeRealmRunner(path.join(scratch, "home"))
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }))

// Runs `script` as a Node module with ExecuteRealm and ExecuteCpuScheduler in scope; it prints its result as JSON last.
// `host()` makes a host object with a read-only cpuMs(); `busy(ms)` is sandbox code that burns that much of the
// relay thread's CPU (what the scheduler charges), so a preempted runner can't turn it into less work.
function runScenario<T>(script: string): T {
  const source = `const { ExecuteRealm, ExecuteCpuScheduler } = await import(${JSON.stringify(path.join(import.meta.dir, "../src/execute-realm.ts"))})
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    const host = (extra = {}) => ({ cpuMs: () => { const cpu = process.threadCpuUsage(); return (cpu.user + cpu.system) / 1000 }, ...extra })
    const busy = (ms) => \`{ const end = host.cpuMs() + \${ms}; while (host.cpuMs() < end) { for (let k = 0; k < 4000; k++) {} } }\`
    ${script}`
  const child = spawnSync("node", ["--input-type=module", "--no-warnings", "-e", source], { encoding: "utf8", timeout: 60_000, env: { ...process.env, OPENCODE_BROWSER_HOME: path.join(scratch, "home") } })
  if (child.status !== 0) throw new Error(`node failed: ${child.stderr}`)
  return JSON.parse(child.stdout.trim().split("\n").at(-1) ?? "null") as T
}

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

type Starvation = { readonly p95VersionMs: number; readonly maxVersionMs: number; readonly interactiveMs: number; readonly paceMs: number; readonly errors: readonly string[] }

// Eight sessions chunking heavy work, a light interactive session, an HTTP /version endpoint and a host timer loop
// like human-input's pace(), all on one event loop. `shared` gives every realm the relay's one scheduler; otherwise
// each realm has its own, so nothing is shared between sessions.
const starvation = (shared: boolean) => runScenario<Starvation>(`
  const http = await import("node:http")
  const scheduler = ${shared} ? new ExecuteCpuScheduler() : undefined
  const sessionHost = host({ later: () => new Promise((resolve) => setTimeout(resolve, 1)) })
  const run = (body) => {
    const realm = new ExecuteRealm(scheduler ? { scheduler } : {})
    realm.proxyAsObject(sessionHost)
    const started = performance.now()
    return realm.run({ source: "(async (host) => { " + body + " })", filename: "test.js", args: [sessionHost] })
      .then(() => ({ ms: performance.now() - started }), (error) => ({ ms: performance.now() - started, error: String(error.message) }))
  }
  const server = http.createServer((_request, response) => response.end("{}"))
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const version = () => new Promise((resolve, reject) => {
    const started = performance.now()
    http.get({ host: "127.0.0.1", port: server.address().port, path: "/version", agent: false }, (response) => {
      response.resume()
      response.on("end", () => resolve(performance.now() - started))
    }).on("error", reject)
  })
  let done = false
  const versions = []
  const probing = (async () => { while (!done) { versions.push(await version()); await sleep(10) } })()
  const heavy = Array.from({ length: 8 }, () => run("for (let i = 0; i < 12; i++) { " + busy(40) + " await new Promise((r) => setTimeout(r, 0)) }"))
  // Arrive once every heavy session has had a turn, as an agent's click arrives mid-way through others' work.
  await sleep(600)
  const interactive = run("for (let i = 0; i < 10; i++) await host.later()")
  const paceStarted = performance.now()
  for (let i = 0; i < 20; i++) await sleep(10)
  const paceMs = performance.now() - paceStarted
  const outcomes = [...await Promise.all(heavy), await interactive]
  done = true
  await probing
  server.close()
  const sorted = versions.toSorted((a, b) => a - b)
  console.log(JSON.stringify({
    p95VersionMs: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
    maxVersionMs: sorted.at(-1),
    interactiveMs: outcomes.at(-1).ms,
    paceMs,
    errors: outcomes.flatMap((outcome) => outcome.error ? [outcome.error] : []),
  }))
`)

test("sessions sharing the relay's scheduler keep /version, light sessions and host timers responsive", () => {
  const unshared = starvation(false)
  const shared = starvation(true)
  console.log(JSON.stringify({ unshared, shared }))
  expect(shared.errors).toEqual([])
  // Unshared, a turn of the loop runs every session's due slice back to back (about 8 x 40 ms) before any I/O.
  // Shared, I/O waits for at most one slice and its pacing gap.
  expect(shared.p95VersionMs).toBeLessThan(150)
  expect(shared.p95VersionMs).toBeLessThan(unshared.p95VersionMs / 2)
  expect(shared.interactiveMs).toBeLessThan(unshared.interactiveMs / 2)
  expect(shared.paceMs).toBeLessThan(unshared.paceMs / 2)
}, 60_000)

test("a realm's queued callbacks run in the order they came due", () => {
  // The busy run leaves open time owed, so all twenty timers queue before any runs.
  const order = runScenario<unknown>(`
    const realmHost = host()
    const realm = new ExecuteRealm()
    realm.proxyAsObject(realmHost)
    console.log(JSON.stringify(await realm.run({ filename: "test.js", args: [realmHost], source: "(async (host) => { const order = []; for (let i = 0; i < 20; i++) setTimeout(() => order.push(i), 0); " + busy(40) + " await new Promise((r) => setTimeout(r, 100)); return order })" })))
  `)
  expect(order).toEqual(Array.from({ length: 20 }, (_, index) => index))
}, 30_000)

test("clearing a timer that is already queued cancels it", () => {
  // host.soon calls back after the timers came due and queued, but before the paced queue runs them.
  const fired = runScenario<unknown>(`
    const realm = new ExecuteRealm()
    const realmHost = host({ soon: (callback) => setTimeout(callback, 5) })
    realm.proxyAsObject(realmHost)
    console.log(JSON.stringify(await realm.run({ filename: "test.js", args: [realmHost], source: "(async (host) => { const fired = []; const cancelled = setTimeout(() => fired.push('cancelled'), 0); setTimeout(() => fired.push('kept'), 0); host.soon(() => clearTimeout(cancelled)); " + busy(40) + " await new Promise((r) => setTimeout(r, 100)); return fired })" })))
  `)
  expect(fired).toEqual(["kept"])
}, 30_000)

test("an interval that comes due again while queued runs once, not once per missed period", () => {
  const counts = runScenario<{ readonly ticks: number }>(`
    const scheduler = new ExecuteCpuScheduler()
    const realmHost = host({ ticking: true })
    const heavy = new ExecuteRealm({ scheduler })
    const ticking = new ExecuteRealm({ scheduler })
    for (const realm of [heavy, ticking]) realm.proxyAsObject(realmHost)
    // The heavy realm keeps working until the ticking realm has cleared its interval.
    const working = heavy.run({ filename: "heavy.js", args: [realmHost], source: "(async (host) => { while (host.ticking) { " + busy(60) + " await new Promise((r) => setTimeout(r, 0)) } })" })
    const ticks = await ticking.run({ filename: "ticking.js", args: [], source: "(async () => { let ticks = 0; const id = setInterval(() => { ticks += 1 }, 1); await new Promise((r) => setTimeout(r, 800)); clearInterval(id); return ticks })" })
    realmHost.ticking = false
    await working
    console.log(JSON.stringify({ ticks }))
  `)
  // About one tick per heavy slice (60 ms of work, 30 ms open); without coalescing, every 1 ms period that passes
  // while the tick waits in the queue adds another.
  expect(counts.ticks).toBeGreaterThan(0)
  expect(counts.ticks).toBeLessThan(50)
}, 30_000)

test("disposing a realm drops its queued callbacks and runs", () => {
  // busy(100) owes 50 ms of open time, so the pump waits that long; sleep(0) lets the due timer queue first.
  const outcome = runScenario<unknown>(`
    const scheduler = new ExecuteCpuScheduler()
    const marks = []
    const realmHost = host({ mark: (name) => { marks.push(name) } })
    const timers = new ExecuteRealm({ scheduler })
    const runs = new ExecuteRealm({ scheduler })
    for (const realm of [timers, runs]) realm.proxyAsObject(realmHost)
    await timers.run({ filename: "timers.js", args: [realmHost], source: "((host) => { setTimeout(() => host.mark('timer'), 0); " + busy(100) + " })" })
    const queuedRun = runs.run({ filename: "runs.js", args: [realmHost], source: "((host) => host.mark('run'))" }).then(() => "ran", (error) => error.message)
    await sleep(0)
    const queued = scheduler.pending
    timers.dispose()
    runs.dispose()
    const afterDispose = scheduler.pending
    await sleep(80)
    console.log(JSON.stringify({ queued, afterDispose, run: await queuedRun, marks }))
  `)
  expect(outcome).toEqual({ queued: 2, afterDispose: 0, run: "Execute stopped", marks: [] })
}, 30_000)
