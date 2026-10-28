// Soak + chaos: N agents (MCP stdio servers, like N opencode sessions) loop random tasks from the scenario set and a
// few real sites while chaos events hit the relay, the extension, Chrome and the network.
//   node stress/soak.ts [--workers 8] [--minutes 60] [--chaos-every 120] [--chaos relay-kill9,sw-stop,...]
//                       [--no-sites] [--sample-every 30] [--recovery-bound 120] [--only scenario,scenario]
// Writes tasks.jsonl, chaos.jsonl, metrics.jsonl and summary.md under ~/stress-results/<stamp>-soak/.
// Chaos types: relay-kill9, sw-stop, close-agent-tabs, close-windows, chrome-restart, network-drop, session-delete,
// mcp-kill, tabs-cleanup, toolbar-stop (needs an extension built with OPENCODE_BROWSER_TEST_HOOKS=1, as deploy.sh does).
import fs from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { parseArgs } from "node:util"
import { BrowserCdp } from "./lib/cdp.ts"
import { fixturePort, relayJson, runDir, sleep } from "./lib/env.ts"
import { startFixtures } from "./lib/fixtures.ts"
import { exec, McpClient } from "./lib/mcp.ts"
import { relayPid, Sampler, type Sample } from "./lib/metrics.ts"
import { Jsonl, mdEscape, oneLine, percentile, slope } from "./lib/results.ts"
import { scenarios, type Ctx } from "./scenarios.ts"

const ALL_CHAOS = ["relay-kill9", "sw-stop", "close-agent-tabs", "close-windows", "chrome-restart", "network-drop", "session-delete", "mcp-kill", "tabs-cleanup", "toolbar-stop"]
const { values } = parseArgs({ options: {
  workers: { type: "string", default: "8" },
  minutes: { type: "string", default: "60" },
  "chaos-every": { type: "string", default: "120" },
  chaos: { type: "string", default: ALL_CHAOS.join(",") },
  "no-sites": { type: "boolean", default: false },
  "sample-every": { type: "string", default: "30" },
  "recovery-bound": { type: "string", default: "120" },
  "min-success": { type: "string", default: "0.9" },
  only: { type: "string" },
} })
const WORKERS = Number(values.workers)
const DURATION_MS = Number(values.minutes) * 60_000
const CHAOS_MEAN_MS = Number(values["chaos-every"]) * 1000
const CHAOS = values.chaos!.split(",").filter((c) => c && c !== "none")
const RECOVERY_BOUND_MS = Number(values["recovery-bound"]) * 1000
const MIN_SUCCESS = Number(values["min-success"])

const dir = runDir("soak")
const tasksLog = new Jsonl(dir, "tasks.jsonl")
const chaosLog = new Jsonl(dir, "chaos.jsonl")
const metricsLog = new Jsonl(dir, "metrics.jsonl")
const fx = await startFixtures(fixturePort)
const started = Date.now()
const deadline = started + DURATION_MS
let stopping = false

// The harness's Chrome connection; Chrome restarts close it, so it reconnects on demand.
let cdpConnection: BrowserCdp | undefined
async function cdp(): Promise<BrowserCdp> {
  if (cdpConnection && !cdpConnection.closed) return cdpConnection
  cdpConnection = await BrowserCdp.connect()
  return cdpConnection
}

type Window = { from: number; to: number }
const chaosWindows: Window[] = []
const inChaos = (from: number, to: number) => chaosWindows.some((w) => from < w.to && to > w.from)

const SITES: { name: string; code: string }[] = [
  { name: "site:wikipedia", code: `await page.goto('https://en.wikipedia.org/wiki/Special:Random', {waitUntil: 'domcontentloaded', timeout: 45000}); const s = await snapshot(); await page.getByRole('searchbox').first().fill('Chromium'); return { title: await page.title(), len: s.length }` },
  { name: "site:hackernews", code: `await page.goto('https://news.ycombinator.com/', {waitUntil: 'domcontentloaded', timeout: 45000}); const n = await page.locator('.titleline > a').count(); if (n < 10) throw new Error('only ' + n + ' stories'); await page.locator('.morelink').click(); await page.waitForURL(/p=2/); return n` },
  { name: "site:github-explore", code: `await page.goto('https://github.com/explore', {waitUntil: 'domcontentloaded', timeout: 45000}); return (await snapshot()).length` },
  { name: "site:mdn", code: `await page.goto('https://developer.mozilla.org/en-US/docs/Web/JavaScript', {waitUntil: 'domcontentloaded', timeout: 45000}); return { title: await page.title(), shot: (await page.screenshot()).length }` },
  { name: "site:bbc-news", code: `await page.goto('https://www.bbc.com/news', {waitUntil: 'domcontentloaded', timeout: 45000}); await page.mouse.wheel(0, 2500); return (await snapshot({find: 'News'})).length` },
]
const only = values.only?.split(",")
const soakScenarios = scenarios.filter((s) => (only ? only.includes(s.name) : s.tags.includes("soak")))

type Worker = { id: number; client: McpClient; session?: string | undefined; busySince?: number | undefined; task?: string | undefined; iterations: number; leftover: string[] }
const workers: Worker[] = []

function newClient() {
  return new McpClient()
}

async function workerLoop(worker: Worker) {
  while (!stopping && Date.now() < deadline) {
    if (worker.client.exited !== undefined) {
      worker.client = newClient()
      try { await worker.client.initialize() } catch (e) { tasksLog.write({ worker: worker.id, task: "mcp-initialize", ok: false, ms: 0, error: oneLine(e) }); await sleep(2000); continue }
    }
    // A session whose delete failed (its MCP server was killed mid-task) is the harness's to clean up, as a person
    // would close the tabs of an agent that crashed; named sessions outlive their clients by design.
    for (const left of worker.leftover.splice(0)) await worker.client.call("session_delete", { id: left }, 30_000).catch(() => worker.leftover.push(left))
    const useSite = !values["no-sites"] && Math.random() < 0.3
    const site = SITES[Math.floor(Math.random() * SITES.length)]!
    const scenario = soakScenarios[Math.floor(Math.random() * soakScenarios.length)]!
    const name = useSite ? site.name : scenario.name
    const session = `soak-w${worker.id}-${worker.iterations++}`
    worker.session = session
    worker.task = name
    const from = Date.now()
    worker.busySince = from
    let ok = false
    let error: string | undefined
    try {
      const created = await worker.client.call("session_new", { id: session }, 60_000)
      if (created.isError) throw new Error(`session_new: ${created.text.slice(0, 200)}`)
      const ctx: Ctx = { client: worker.client, session, fx, cdp: await cdp(), artifacts: path.join(dir, "artifacts"), exec: (code, timeoutMs) => exec(worker.client, session, code, timeoutMs) }
      const run = useSite ? exec(worker.client, session, site.code, 90_000) : scenario.run(ctx)
      await Promise.race([run, new Promise((_, reject) => setTimeout(() => reject(new Error("task timed out after 150 s")), 150_000))])
      ok = true
    } catch (e) {
      error = oneLine(e)
    } finally {
      const deleted = await worker.client.call("session_delete", { id: session }, 30_000).then((r) => !r.isError, () => false)
      if (!deleted) worker.leftover.push(session)
    }
    const to = Date.now()
    worker.busySince = undefined
    worker.session = undefined
    tasksLog.write({ worker: worker.id, task: name, ok, ms: to - from, from, to, ...(error ? { error } : {}) })
    if (!ok) await sleep(500)
  }
}

// --- chaos --------------------------------------------------------------------------------------------------------
const probe = { client: newClient() }

/** Recovered: an execute through a fresh MCP session works again (it restarts the relay when needed). */
async function waitRecovered(since: number): Promise<{ recovered: boolean; recoveryMs: number; attempts: number }> {
  let attempts = 0
  while (Date.now() - since < RECOVERY_BOUND_MS) {
    attempts++
    try {
      if (probe.client.exited !== undefined) { probe.client = newClient(); await probe.client.initialize() }
      const result = await probe.client.call("execute", { session: "soak-probe", code: "return 1" }, 30_000)
      if (result.isError && /Session not found/.test(result.text)) { await probe.client.call("session_new", { id: "soak-probe" }, 30_000); continue }
      if (!result.isError && result.data?.value === 1) return { recovered: true, recoveryMs: Date.now() - since, attempts }
    } catch {}
    await sleep(1000)
  }
  return { recovered: false, recoveryMs: Date.now() - since, attempts }
}

function sudo(args: string[]) {
  return execFileSync("sudo", ["-n", ...args], { encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] })
}

const NET_RULES = [
  ["OUTPUT", "-p", "tcp", "-m", "multiport", "--dports", "80,443", "-j", "DROP"],
  ["OUTPUT", "-p", "udp", "--dport", "53", "-j", "DROP"],
  ["OUTPUT", "-p", "tcp", "--dport", "53", "-j", "DROP"],
]
function netDown() { for (const rule of NET_RULES) sudo(["iptables", "-I", ...rule]) }
function netUp() { for (const rule of NET_RULES) { try { sudo(["iptables", "-D", ...rule]) } catch {} } }

const chaosActions: Record<string, () => Promise<Record<string, unknown>>> = {
  "relay-kill9": async () => {
    const pid = await relayPid()
    if (pid) process.kill(pid, "SIGKILL")
    return { pid }
  },
  "sw-stop": async () => ({ how: await (await cdp()).stopExtensionWorker() }),
  "close-agent-tabs": async () => {
    const c = await cdp()
    const view = await c.extensionView()
    const agentTabs = view.tabs.filter((t) => t.groupId !== -1 || (!t.active && t.url.includes(`:${fixturePort}`)))
    const victims = agentTabs.filter(() => Math.random() < 0.5)
    if (victims.length) await c.evalInExtension(`chrome.tabs.remove(${JSON.stringify(victims.map((t) => t.id))}).catch(() => undefined)`)
    return { closed: victims.length, of: agentTabs.length }
  },
  "close-windows": async () => {
    const c = await cdp()
    const closed = await c.evalInExtension<number>(`(async () => { const ws = await chrome.windows.getAll(); const focused = ws.find(w => w.focused) ?? ws[0]; let n = 0; for (const w of ws) if (w.id !== focused.id) { await chrome.windows.remove(w.id).catch(() => undefined); n++ } return n })()`)
    return { closed }
  },
  "chrome-restart": async () => {
    sudo(["systemctl", "restart", "browse-chrome"])
    cdpConnection?.close()
    return {}
  },
  "network-drop": async () => {
    const ms = 10_000 + Math.floor(Math.random() * 15_000)
    netDown()
    try { await sleep(ms) } finally { netUp() }
    return { ms }
  },
  "session-delete": async () => {
    const busy = workers.filter((w) => w.session)
    const victim = busy[Math.floor(Math.random() * busy.length)]
    if (!victim?.session) return { skipped: "no busy worker" }
    const result = await relayJson("/cli/session/delete", { id: victim.session }, 30_000).catch((e) => ({ error: oneLine(e) }))
    return { session: victim.session, task: victim.task, result }
  },
  "mcp-kill": async () => {
    const victim = workers[Math.floor(Math.random() * workers.length)]!
    const pid = victim.client.pid
    if (pid) try { process.kill(pid, "SIGKILL") } catch {}
    return { worker: victim.id, pid }
  },
  "tabs-cleanup": async () => ({ result: await relayJson("/tabs/cleanup", { idleMinutes: 0 }, 30_000).catch((e) => ({ error: oneLine(e) })) }),
  // The user clicks the toolbar button on an agent's tab: the kill switch, which stops the agent there.
  "toolbar-stop": async () => {
    const c = await cdp()
    const held = (await relayJson<any[]>("/json/list")).filter((t) => t.opencodeBrowserSessionId?.startsWith("soak-w"))
    const victim = held[Math.floor(Math.random() * held.length)]
    if (!victim) return { skipped: "no agent tab" }
    const hooked = await c.evalInExtension<boolean>(`typeof globalThis.__opencodeBrowserTest?.toolbarClick === "function"`)
    if (!hooked) throw new Error("the extension has no test hooks; build it with OPENCODE_BROWSER_TEST_HOOKS=1 (stress/exe/deploy.sh does)")
    await c.evalInExtension(`globalThis.__opencodeBrowserTest.toolbarClick(${Number(victim.tabId)})`)
    return { tabId: victim.tabId, session: victim.opencodeBrowserSessionId }
  },
}

async function chaosLoop() {
  // First event after a warm-up so the baseline metrics are clean.
  await sleep(Math.min(120_000, CHAOS_MEAN_MS))
  while (!stopping && Date.now() < deadline - 60_000) {
    const type = CHAOS[Math.floor(Math.random() * CHAOS.length)]!
    const at = Date.now()
    let detail: Record<string, unknown> = {}
    let error: string | undefined
    try { detail = await chaosActions[type]!() } catch (e) { error = oneLine(e) }
    const recovery = await waitRecovered(at)
    chaosWindows.push({ from: at, to: Date.now() + 10_000 })
    chaosLog.write({ type, at, ...detail, ...(error ? { error } : {}), ...recovery })
    console.log(`chaos ${type} ${JSON.stringify(detail).slice(0, 120)} -> ${recovery.recovered ? `recovered in ${recovery.recoveryMs} ms` : "NOT RECOVERED"}`)
    const wait = -Math.log(1 - Math.random()) * CHAOS_MEAN_MS
    await sleep(Math.max(20_000, Math.min(wait, CHAOS_MEAN_MS * 3)))
  }
}

// --- metrics ------------------------------------------------------------------------------------------------------
const samples: (Sample & { at: number })[] = []
const pidChanges: { at: number; from: unknown; to: unknown }[] = []
async function metricsLoop() {
  const sampler = new Sampler()
  let lastPid: unknown
  while (!stopping) {
    const at = Date.now()
    let sample: Sample = {}
    try { sample = await sampler.sample(await cdp().catch(() => undefined)) } catch (e) { sample = { error: oneLine(e) } }
    if (sample.relayPid && lastPid && sample.relayPid !== lastPid) pidChanges.push({ at, from: lastPid, to: sample.relayPid })
    if (sample.relayPid) lastPid = sample.relayPid
    const recent = readTasks().filter((t) => t.to > at - Number(values["sample-every"]) * 1000)
    sample.tasksWindow = recent.length
    sample.failuresWindow = recent.filter((t) => !t.ok).length
    sample.busyWorkers = workers.filter((w) => w.busySince).length
    sample.oldestBusyMs = Math.max(0, ...workers.filter((w) => w.busySince).map((w) => at - w.busySince!))
    samples.push({ at, ...sample })
    metricsLog.write({ at, ...sample })
    await sleep(Number(values["sample-every"]) * 1000)
  }
}

function readTasks(): any[] {
  try { return fs.readFileSync(tasksLog.file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) } catch { return [] }
}

// --- run ----------------------------------------------------------------------------------------------------------
const cleanup = () => { try { netUp() } catch {} }
process.on("exit", cleanup)
process.on("SIGINT", () => { stopping = true; cleanup(); process.exit(130) })
process.on("SIGTERM", () => { stopping = true; cleanup(); process.exit(143) })

console.log(`soak: ${WORKERS} workers, ${values.minutes} min, chaos every ~${values["chaos-every"]} s (${CHAOS.join(", ")}), results ${dir}`)
await probe.client.initialize()
await probe.client.call("session_new", { id: "soak-probe" })
for (let i = 0; i < WORKERS; i++) {
  const client = newClient()
  await client.initialize()
  workers.push({ id: i, client, iterations: 0, leftover: [] })
}
const metrics = metricsLoop()
const chaos = CHAOS.length ? chaosLoop() : Promise.resolve()
const loops = workers.map((w) => workerLoop(w))
await chaos
// Workers finish their current task; one that can't within the bound is stuck.
const ended = Date.now()
const settle = await Promise.race([Promise.all(loops).then(() => "settled"), sleep(Math.max(0, deadline - Date.now()) + 180_000).then(() => "timeout")])
stopping = true
const stuck = workers.filter((w) => w.busySince).map((w) => ({ worker: w.id, task: w.task, busyMs: Date.now() - w.busySince! }))
await sleep(1000)
await metrics.catch(() => undefined)
for (const w of workers) for (const left of w.leftover.splice(0)) await w.client.call("session_delete", { id: left }, 30_000).catch(() => undefined)
// Session deletes close their tabs asynchronously.
await sleep(5000)
const finalSample = await new Sampler().sample(await cdp().catch(() => undefined)).catch(() => ({} as Sample))
for (const w of workers) await w.client.close()
await probe.client.call("session_delete", { id: "soak-probe" }).catch(() => undefined)
await probe.client.close()
cdpConnection?.close()
await fx.close()

// --- summary ------------------------------------------------------------------------------------------------------
const tasks = readTasks()
const chaosEvents = fs.existsSync(chaosLog.file) ? fs.readFileSync(chaosLog.file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []
const calm = tasks.filter((t) => !inChaos(t.from, t.to))
const successCalm = calm.length ? calm.filter((t) => t.ok).length / calm.length : NaN
const successAll = tasks.length ? tasks.filter((t) => t.ok).length / tasks.length : NaN
const warm = samples.filter((s) => s.at > started + 5 * 60_000)
const fit = (key: string) => {
  const points = warm.filter((s) => typeof s[key] === "number").map((s) => [(s.at - started) / 3_600_000, s[key] as number] as [number, number])
  const vals = points.map((p) => p[1])
  return { key, perHour: Math.round(slope(points) * 100) / 100, min: Math.min(...vals), max: Math.max(...vals), last: vals.at(-1) ?? NaN, n: points.length }
}
const growth = ["relayRssMb", "relayFds", "relayThreads", "chromeRssMb", "chromeProcesses", "tabs", "groupedTabs", "groups", "debuggerAttached", "relayTargets", "relaySessions", "trackedTabs", "sessionTabs", "orphanTabs", "journalBytes", "relayLogBytes"].map(fit)
const unexplainedRestarts = pidChanges.filter((c) => !chaosEvents.some((e) => (e.type === "relay-kill9") && Math.abs(e.at - c.at) < 60_000 + Number(values["sample-every"]) * 1000))
const byChaos = new Map<string, any[]>()
for (const e of chaosEvents) byChaos.set(e.type, [...(byChaos.get(e.type) ?? []), e])
const byTask = new Map<string, any[]>()
for (const t of tasks) byTask.set(t.task, [...(byTask.get(t.task) ?? []), t])
const errors = new Map<string, number>()
for (const t of calm.filter((t) => !t.ok)) { const key = String(t.error).slice(0, 110); errors.set(key, (errors.get(key) ?? 0) + 1) }

const maxUntracked = Math.max(0, ...samples.map((sample) => Number(sample.untrackedSessionTabs ?? 0)))
const perHour = (key: string) => growth.find((g) => g.key === key)?.perHour ?? 0
const memoryOk = perHour("relayRssMb") < 50 && perHour("relayFds") < 50 && perHour("tabs") < 10
const criteria = [
  { name: `calm success rate >= ${MIN_SUCCESS}`, ok: successCalm >= MIN_SUCCESS, value: successCalm.toFixed(3) },
  { name: `every chaos event recovered within ${RECOVERY_BOUND_MS / 1000} s`, ok: chaosEvents.every((e) => e.recovered), value: `${chaosEvents.filter((e) => e.recovered).length}/${chaosEvents.length}` },
  { name: "no stuck workers after the run", ok: stuck.length === 0 && settle === "settled", value: JSON.stringify(stuck) },
  { name: "no unexplained relay restarts (crash loops)", ok: unexplainedRestarts.length === 0, value: String(unexplainedRestarts.length) },
  { name: "bounded growth (relay RSS < 50 MB/h, fds < 50/h, tabs < 10/h)", ok: memoryOk, value: "" },
  { name: "every session tab tracked for idle cleanup (max untracked over the run)", ok: maxUntracked === 0, value: String(maxUntracked) },
  { name: "no leaked tabs after the run (not held by a session, not a window's active tab)", ok: finalSample.orphanTabs === 0, value: String(finalSample.orphanTabs) },
]
const md = [
  `# Soak + chaos`,
  ``,
  `${WORKERS} workers, ${((ended - started) / 60_000).toFixed(1)} min, ${tasks.length} tasks, ${chaosEvents.length} chaos events. ${new Date().toISOString()}`,
  ``,
  `## Pass criteria`,
  ``,
  `| Criterion | Result | Value |`,
  `| --- | --- | --- |`,
  ...criteria.map((c) => `| ${c.name} | ${c.ok ? "pass" : "**FAIL**"} | ${mdEscape(c.value)} |`),
  ``,
  `Success rate: ${(successCalm * 100).toFixed(1)}% outside chaos windows (${calm.length} tasks), ${(successAll * 100).toFixed(1)}% overall.`,
  ``,
  `## Growth (after 5 min warm-up; slope per hour)`,
  ``,
  `| Metric | Slope/h | Min | Max | Last |`,
  `| --- | ---: | ---: | ---: | ---: |`,
  ...growth.map((g) => `| ${g.key} | ${g.perHour} | ${g.min} | ${g.max} | ${g.last} |`),
  ``,
  `## Chaos recovery`,
  ``,
  `| Event | Count | Recovered | Median ms | Max ms |`,
  `| --- | ---: | ---: | ---: | ---: |`,
  ...[...byChaos].map(([type, list]) => `| ${type} | ${list.length} | ${list.filter((e) => e.recovered).length} | ${percentile(list.map((e) => e.recoveryMs), 50)} | ${Math.max(...list.map((e) => e.recoveryMs))} |`),
  ``,
  `## Tasks (latency over all runs)`,
  ``,
  `| Task | Runs | OK (calm) | p50 ms | p95 ms | p99 ms |`,
  `| --- | ---: | ---: | ---: | ---: | ---: |`,
  ...[...byTask].sort().map(([task, list]) => {
    const calmList = list.filter((t) => !inChaos(t.from, t.to))
    const ms = list.filter((t) => t.ok).map((t) => t.ms)
    return `| ${task} | ${list.length} | ${calmList.filter((t) => t.ok).length}/${calmList.length} | ${percentile(ms, 50)} | ${percentile(ms, 95)} | ${percentile(ms, 99)} |`
  }),
  ``,
  `## Top errors outside chaos windows`,
  ``,
  ...[...errors].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([e, n]) => `- ${n}x ${mdEscape(e)}`),
  ``,
  `## Final state`,
  ``,
  "```json",
  JSON.stringify(finalSample, null, 2),
  "```",
].join("\n")
fs.writeFileSync(path.join(dir, "summary.md"), `${md}\n`)
console.log(md)
process.exit(criteria.every((c) => c.ok) ? 0 : 1)
