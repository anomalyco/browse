// Two real Chrome profiles in one disposable, named Linux network namespace. Run with its environment from lib/env.ts:
// node stress/multi-soak.ts <id,CDP-port,systemd-unit> <id,CDP-port,systemd-unit> <second browser's relay IPv4>
// Both units must restart on failure. Only local fixtures; never inject chaos outside this process's network namespace.
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import net from "node:net"
import { execFileSync } from "node:child_process"
import { BrowserCdp } from "./lib/cdp.ts"
import { fixturePort, relayJson, relayPort, runDir, sleep } from "./lib/env.ts"
import { startFixtures } from "./lib/fixtures.ts"
import { McpClient } from "./lib/mcp.ts"
import { relayPid } from "./lib/metrics.ts"
import { Jsonl, oneLine, percentile } from "./lib/results.ts"

const lanes = process.argv.slice(2, 4).map(spec => {
  const [id, port, unit] = spec.split(",")
  assert(id && Number(port) > 0 && unit && unit.startsWith("browse-"))
  return { id, port: Number(port), unit }
})
const remote = process.argv[4] ?? ""
assert(lanes.length === 2 && lanes[0]!.id !== lanes[1]!.id && net.isIPv4(remote) && !remote.startsWith("127."))
const sudo = (...args: string[]) => execFileSync("sudo", ["-n", ...args], { encoding: "utf8" }).trim()
const ns = sudo("ip", "netns", "identify", String(process.pid))
assert(ns && !sudo("ip", "route", "show", "default"), "requires a named namespace without a default route")
function killTestPid(pid: number | undefined) {
  assert(pid && pid > 1 && sudo("ip", "netns", "identify", String(pid)) === ns, "not a test namespace process")
  process.kill(pid, "SIGKILL")
}
const pages = async (lane: number): Promise<{ url: string; id: string }[]> => {
  const res = await fetch(`http://127.0.0.1:${lanes[lane]!.port}/json/list`, { signal: AbortSignal.timeout(3000) })
  assert(res.ok)
  return (await res.json() as { type: string; url: string; id: string }[]).filter(t => t.type === "page").map(({ url, id }) => ({ url, id }))
}
const clients = Array.from({ length: 4 }, () => new McpClient())
await Promise.all(clients.map(c => c.initialize()))
const fx = await startFixtures(fixturePort)
const dir = runDir("multi-soak"), tasks = new Jsonl(dir, "tasks.jsonl"), events = new Jsonl(dir, "chaos.jsonl")
const started = Date.now(), end = started + 30 * 60_000
const before = await Promise.all([pages(0), pages(1)])
const own = `multi-${started.toString(36)}-`
const latest = [0, 0, 0, 0], pending = new Set<string>()
const history: { w: number; from: number; to: number; ok: boolean; crossed: boolean }[] = []
const windows: { type: string; lane: number | null; from: number; to: number; recovered: boolean }[] = []
console.log(`results=${dir} started=${new Date(started).toISOString()}`)

async function worker(c: McpClient, w: number) {
  const lane = w % 2, browser = lanes[lane]!.id
  for (let n = 0; Date.now() < end; n++) {
    const session = `${own}${w}-${n}`, url = fx.url(`/form?lane=${lane}&session=${session}`), from = Date.now()
    let crossed = false, error = "", checked = false
    try {
      pending.add(session)
      const fresh = await c.call("session_new", { id: session, browser }, 30_000)
      if (fresh.isError) throw Error(fresh.text)
      const r = await c.call("execute", { session, timeoutMs: 15_000, code: `await page.goto(${JSON.stringify(url)}); await page.getByLabel('Name').fill('${session}'); await page.getByText('Save',{exact:true}).click(); return { value:await page.locator('output').textContent(), pages:context.pages().map(p=>p.url()) }` }, 30_000)
      if (r.isError) throw Error(r.text)
      const v = r.data?.value
      const both = await Promise.allSettled([pages(0), pages(1)])
      const here = both[lane]!, other = both[1 - lane]!
      crossed = v?.pages?.some((p: string) => p.includes("session=") && p !== url) || (other.status === "fulfilled" && other.value.some(p => p.url === url)) || (v?.value?.startsWith(own) && v.value !== session) || false
      assert(!crossed, "crossed browser/session boundary")
      assert(v?.value === session && v?.pages?.length === 1 && v.pages[0] === url, "session marker mismatch")
      assert(here.status === "fulfilled" && here.value.some(p => p.url === url), "page missing from expected physical Chrome")
      checked = true
    } catch (e) { error = oneLine(e) }
    try {
      const del = await c.call("session_delete", { id: session }, 30_000)
      if (!del.isError || /session not found/i.test(del.text)) pending.delete(session)
      if (del.isError && !error) error = oneLine(del.text)
    } catch (e) { if (!error) error = oneLine(e) }
    const row = { w, from, to: Date.now(), ok: !error && checked, crossed }
    if (row.ok) latest[w] = from
    history.push(row); tasks.write({ ...row, session, browser, checked, error })
    await sleep(500)
  }
}

// Fixed schedule ensures every requested fault actually occurs. Scope calm exclusions to the affected browser(s).
async function chaos() {
  for (const [minute, type, lane] of [[2,"chrome-kill",1],[7,"relay-kill",null],[12,"sw-stop",0],[17,"network-drop",1],[22,"chrome-kill",0],[27,"sw-stop",1]] as const) {
    await sleep(Math.max(0, started + minute * 60_000 - Date.now()))
    const from = Date.now(); let detail = "", error = ""
    try {
      if (type === "chrome-kill") killTestPid(Number(sudo("systemctl", "show", "-p", "MainPID", "--value", lanes[lane]!.unit)))
      if (type === "relay-kill") killTestPid(await relayPid())
      if (type === "sw-stop") {
        const c = await BrowserCdp.connect(5000, lanes[lane]!.port)
        try { detail = await c.stopExtensionWorker(); assert(["closeTarget", "stopAllWorkers"].includes(detail)) } finally { c.close() }
      }
      if (type === "network-drop") {
        const rule = ["OUTPUT", "-d", remote, "-p", "tcp", "--dport", String(relayPort), "-m", "comment", "--comment", own, "-j", "DROP"]
        sudo("iptables", "-I", ...rule)
        try { await sleep(12_000); detail = sudo("iptables", "-nvxL", "OUTPUT").split("\n").find(l => l.includes(own)) ?? ""; assert(Number(detail.trim().split(/\s+/)[0]) > 0, "drop had no traffic") }
        finally { sudo("iptables", "-D", ...rule) }
      }
    } catch (e) { error = oneLine(e) }
    const after = Date.now(), recovered = () => latest.every((t, w) => (lane !== null && w % 2 !== lane) || t >= after)
    while (Date.now() < from + 120_000 && !recovered()) await sleep(200)
    const row = { from, to: Date.now(), lane, type, recovered: !error && recovered() && Date.now() - from <= 120_000 }
    events.write({ ...row, detail, error }); windows.push(row)
  }
}

await Promise.all([chaos(), ...clients.map(worker)])
for (const id of pending) await clients[0]!.call("session_delete", { id }).catch(() => {})
await Promise.all(clients.map(c => c.close())); await fx.close(); await sleep(5000)
const after = await Promise.all([pages(0), pages(1)])
const leaked = after.flatMap((ps, lane) => ps.filter(p => !before[lane]!.some(b => b.url === p.url)))
const targets = await relayJson<any[]>("/json/list"), residual = targets.filter(t => t.opencodeBrowserSessionId?.startsWith(own))
const calm = history.filter(t => !windows.some(e => (e.lane === null || t.w % 2 === e.lane) && t.from < e.to && t.to > e.from))
const rate = calm.filter(t => t.ok).length / calm.length
const summary = { started, lastTask: Math.max(...history.map(t => t.to)), before, after, leaked, residual, total: history.length, successes: history.filter(t=>t.ok).length, calm: calm.length, calmFailures: calm.filter(t=>!t.ok).length, rate, crossings: history.filter(t=>t.crossed).length, p95Ms: percentile(calm.filter(t=>t.ok).map(t=>t.to-t.from),95), windows }
fs.writeFileSync(path.join(dir,"summary.json"), JSON.stringify(summary,null,2)+"\n"); console.log(JSON.stringify(summary))
process.exitCode = rate >= .995 && !summary.crossings && !leaked.length && !residual.length && windows.every(e=>e.recovered) ? 0 : 1
