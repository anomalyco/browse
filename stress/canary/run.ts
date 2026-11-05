// One serial schedule. State survives service restarts; a build is only stamped after both expensive checks finish.
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"
import { chromeDebugPort, dataDir, fixturePort, relayJson, relayPort, sleep } from "../lib/env.ts"
import { BrowserCdp } from "../lib/cdp.ts"
import { Sampler } from "../lib/metrics.ts"
import { npxSmoke } from "./npx.ts"
import { command, readJson, record, root, saveJson, type Evidence, type Metrics, type Status } from "./results.ts"

const { values } = parseArgs({ options: { once: { type: "boolean" }, "soak-minutes": { type: "string" } } })
const once = !!values.once, short = Number(values["soak-minutes"] ?? 2), minute = 60_000
const binary = path.join(os.homedir(), ".browse/bin/browse"), stress = path.resolve(import.meta.dirname, "..")
assert(process.env.BROWSE_STRESS_BINARY === binary && dataDir === path.join(os.homedir(), ".local/share/opencode-browser"), "requires isolated canary install and data HOME")
assert([relayPort, chromeDebugPort, fixturePort].every(p => Number.isInteger(p) && p >= 19700 && p <= 19799) && new Set([relayPort, chromeDebugPort, fixturePort]).size === 3, "dedicated canary ports required")
assert(once ? fs.realpathSync(os.homedir()).startsWith(path.join(fs.realpathSync(os.tmpdir()), "opencode/browse-canary.")) : os.userInfo().username === "canary", "--once requires a temp opencode/browse-canary.* HOME; service requires user canary")
assert(!once || (Number.isFinite(short) && short > 0 && short <= 30))
assert(process.env.OPENCODE_BROWSER_AUTO_UPDATE === "on" && process.env.OPENCODE_BROWSER_UPDATE_CHECK === "1", "auto-update must be enabled")
process.umask(0o077)
const webhook = process.env.CANARY_SLACK_WEBHOOK
delete process.env.CANARY_SLACK_WEBHOOK // never pass it to browsers, fuzz, npm or the product
const node = (name: string, ...args: string[]) => [process.execPath, path.join(stress, name + ".ts"), ...args]
const stateFile = path.join(root, "state.json")
type State = { build?: string; commit?: string; tested?: string; day?: string; site?: number; seen?: { version: string; commit: string; since: number; switchedAt?: number; assisted?: boolean; forcedAt?: number }; outage?: { since: number; incident?: boolean; hard?: boolean }; previous: Record<string, Status>; current: Record<string, Status>; alerted: string[] }
fs.mkdirSync(root, { recursive: true, mode: 0o700 })
const state: State = fs.existsSync(stateFile) ? readJson(stateFile) : { previous: {}, current: {}, alerted: [] }
const save = () => saveJson(stateFile, state)
let failed = false, version = state.build ?? "unknown", commit = state.commit ?? ""
async function alert(message: string, id: string) {
  const folder = path.join(root, id), url = process.env.CANARY_RESULTS_URL?.replace(/\/$/, "")
  const text = `Browse canary: ${message} — <${url ? `${url}/${id}/` : `ssh://${os.hostname()}`}|${os.hostname()}:${folder}>`
  console.error(`Browse canary: ${message} — ${folder}`)
  if (webhook && !once) try {
    const res = await fetch(webhook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }), signal: AbortSignal.timeout(10_000) })
    if (!res.ok) console.error(`Slack delivery failed: HTTP ${res.status}`)
  } catch { console.error("Slack delivery failed; see local incident") }
}
async function check(id: string, run: (dir: string) => Promise<Evidence>, opts: { tier?: string; report?: boolean; incident?: string; regress?: boolean } = {}) {
  const line = await record(id, opts.tier ?? "stress", version, commit, !opts.report, run)
  if (line.blockingFailed.length) failed = true
  if (opts.incident) await alert(opts.incident, line.id)
  else if (opts.regress !== false && line.blockingFailed.length && version === state.build && state.previous[id] === "pass" && !state.alerted.includes(id)) {
    state.alerted.push(id); save(); await alert(`${id} regressed on ${version}`, line.id)
  }
  if (state.build === version) { state.current[id] = line.status; save() }
  return line
}
async function snapshot() {
  // No CLI here: a status command could start the relay and make a failed automatic switch look successful.
  const v = await relayJson<{ version: string }>("/version", undefined, 3000).catch(() => undefined)
  const ext = await relayJson("/extension/status", undefined, 3000).catch(() => undefined)
  let matched = false
  try {
    const zip = readJson<{ version: string; build: string }>(path.join(dataDir, "extension.json"))
    const current = readJson<{ version: string; channel: string }>(path.join(dataDir, "runtime/current.json"))
    matched = !!zip.build && zip.version === v?.version && current.version === zip.version && current.channel === "dev" && ext?.connected && zip.build === ext.build
  } catch { /* files may not exist during a failed update */ }
  return { version: v?.version, connected: ext?.connected === true, matched }
}
async function metrics(idle = false): Promise<Metrics> {
  const cdp = await BrowserCdp.connect(2500).catch(() => undefined)
  try {
    // /json/list on the *relay* resets its idle clock. During quiet periods count page targets using Chrome's
    // own debugging port instead; don't attach to the extension worker or keep it awake.
    const sample = await new Sampler().sample(idle ? undefined : cdp)
    if (idle && cdp) sample.tabs = (await cdp.targets()).filter(t => t.type === "page").length
    return Object.fromEntries(["relayRssMb", "relayFds", "tabs", "chromeRssMb"].filter(k => typeof sample[k] === "number").map(k => [k, sample[k]]))
  } finally { cdp?.close() }
}
let nextPoll = 0
async function poll() {
  if (Date.now() < nextPoll) return
  nextPoll = Date.now() + 5 * minute
  await check("dev-tag", async () => {
    const res = await fetch("https://registry.npmjs.org/@opencode%2fbrowse/dev", { signal: AbortSignal.timeout(15_000) })
    assert(res.ok, `registry HTTP ${res.status}`)
    const pkg = await res.json() as { version: string; gitHead?: string }
    assert(/^\d+\.\d+\.\d+-dev\.\d+(\.\d+)?$/.test(pkg.version), "invalid dev dist-tag")
    if (pkg.version !== state.tested && state.seen?.version !== pkg.version) {
      const since = Date.now()
      // npm's dev metadata often omits gitHead. Its published provenance identifies the product commit, not
      // the checkout from which this particular harness was deployed. Leave it unknown if neither is available.
      let head = pkg.gitHead ?? ""
      if (!head) try {
        const doc = await fetch(`https://registry.npmjs.org/-/npm/v1/attestations/@opencode%2fbrowse@${pkg.version}`, { signal: AbortSignal.timeout(8000) }).then(r => r.json())
        const payload = doc.attestations.find((a: { predicateType: string }) => a.predicateType === "https://slsa.dev/provenance/v1").bundle.dsseEnvelope.payload
        const dep = JSON.parse(Buffer.from(payload, "base64").toString()).predicate.buildDefinition.resolvedDependencies.find((d: { uri: string }) => d.uri === "git+https://github.com/anomalyco/browse@refs/heads/dev")
        if (/^[0-9a-f]{40}$/.test(dep?.digest.gitCommit)) head = dep.digest.gitCommit
      } catch { /* version is still verifiable directly from the running artifact */ }
      state.seen = { version: pkg.version, since, commit: head.slice(0, 7) }; save()
    }
    return { note: pkg.version }
  }, { tier: "upgrade", report: true })
}
async function health(ok: boolean, since: number) {
  if (ok) {
    if (state.outage?.incident) await check("browser-recovered", async () => ({ metrics: { recoveryMs: Date.now() - state.outage!.since } }))
    delete state.outage; save(); return
  }
  state.outage ??= { since }; save()
  const outage = state.outage, age = Date.now() - outage.since
  if (!outage.incident && age >= 6 * minute) {
    outage.incident = true; if (state.seen) state.seen.assisted = true; save()
    await check("browser-incident", async () => ({ status: "fail", note: "browser unreachable for at least six minutes" }), { incident: "browser unreachable for 6 min" })
    await check("user-recovery", dir => command(dir, [binary, "relay", "restart"], 2), { regress: false })
  }
  if (outage.incident && !outage.hard && age >= 30 * minute && !once) {
    outage.hard = true; save()
    await check("hard-recovery", async dir => {
      // A wedged relay may never answer /version or a graceful restart. Match the listener AND its executable
      // before killing anything. This branch cannot run on a developer's Mac or as the checkout's user.
      const listener = spawnSync("lsof", ["-nP", "-a", "-u", "canary", `-iTCP:${relayPort}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8", timeout: 5000 })
      if (listener.error || (listener.status !== 0 && listener.status !== 1)) throw new Error("cannot identify the canary listener")
      if (listener.stdout.trim()) {
        const pid = Number(listener.stdout.trim()), exe = fs.readlinkSync(`/proc/${pid}/exe`).replace(/ \(deleted\)$/, "")
        assert(pid > 1 && (exe === binary || (exe.startsWith(`${dataDir}/runtime/versions/`) && path.basename(exe) === "browse")), "refusing to kill an unknown listener")
        process.kill(pid, "SIGKILL"); fs.appendFileSync(path.join(dir, "run.log"), `killed canary relay ${pid}\n`)
      }
      const relay = await command(dir, [binary, "session", "list", "--json"], 2)
      const browser = await command(dir, ["sudo", "-n", "systemctl", "restart", "browse-canary-browser@chrome.service"], 2)
      return browser.status === "fail" ? browser : relay
    }, { incident: "30 min recovery bound exceeded; attempted hard restart" })
  }
}

async function suite(kind: "release" | "nightly" | "short") {
  // Observe, don't inject traffic or start another run while the harness owns the browser. Interrupt a long
  // soak/fuzz if the extension stays missing for the incident bound, before attempting any recovery.
  const observed = async (dir: string, argv: string[], minutes: number) => {
    const abort = new AbortController(); let missing = 0
    const timer = setInterval(async () => {
      const s = await snapshot()
      if (s.connected) missing = 0
      else if (!missing) missing = Date.now()
      else if (Date.now() - missing >= 6 * minute) abort.abort()
      await poll()
      if (state.seen && s.matched && s.version === state.seen.version && !state.seen.switchedAt) { state.seen.switchedAt = Date.now(); save() }
    }, 30_000)
    let e: Evidence
    try { e = await command(dir, argv, minutes, abort.signal) } finally { clearInterval(timer) }
    if (abort.signal.aborted) {
      await health(false, missing)
      return { ...e, status: "fail" as const, note: "interrupted: browser unreachable for 6 min" }
    }
    const after = await snapshot()
    if (after.version && version !== after.version) return { ...e, status: "skipped" as const, note: `version changed mid-check to ${after.version}` }
    return e
  }
  if (kind !== "nightly") await check("scenarios-core", async dir => {
    const argv = node("run-scenarios", "--tag", "core"), first = await observed(dir, argv, 25)
    if (first.status !== "fail" || state.outage) return first
    const retry = await observed(dir, argv, 25)
    return retry.status === "pass" ? { ...retry, status: "flaky", note: "passed on retry in fresh MCP sessions; both attempts retained" } : retry
  })
  if (state.outage) return
  const duration = kind === "nightly" ? 60 : kind === "release" ? 30 : short
  const args = ["--minutes", String(duration), "--min-success", "0.995"]
  if (kind === "short") args.push("--no-sites", "--workers", "1", "--only", "fill-click", "--chaos", "session-delete", "--chaos-every", "10", "--sample-every", "10")
  if (kind === "release") args.push("--chaos-every", "75")
  let bound = false
  const soak = await check(`soak-${kind}`, async dir => {
    const e = await observed(dir, node("soak", ...args), duration + 12)
    const sub = fs.readdirSync(dir).find(n => n.endsWith("-soak")), file = sub && path.join(dir, sub, "chaos.jsonl")
    if (file && fs.existsSync(file)) {
      const events = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l))
      bound = events.some(r => !r.recovered || r.recoveryMs > 120_000)
      if (events.length) e.metrics = { recoveryMs: Math.max(...events.map(r => r.recoveryMs)) }
      if (bound) e.status = "fail"
    }
    return e
  })
  if (bound) await alert("chaos recovery exceeded 120 s", soak.id)
  if (kind !== "nightly" || state.outage) return
  await check("fuzz", dir => observed(dir, node("fuzz", "--minutes", "15"), 22))
  if (state.outage) return
  await check("npx-smoke", npxSmoke)
  await check("multi-soak", async dir => {
    if (!fs.existsSync("/usr/bin/brave-browser")) return { status: "skipped", note: "Brave stable not installed" }
    try {
      const started = await command(dir, ["sudo", "-n", "systemctl", "start", "browse-canary-browser@brave.service"], 2)
      if (started.status === "fail") return started
      return await observed(dir, node("multi-soak", `canary-chrome,${chromeDebugPort},browse-canary-browser@chrome`, "canary-brave,19773,browse-canary-browser@brave", "--affinity-only"), 38)
    } finally { await command(dir, ["sudo", "-n", "systemctl", "stop", "browse-canary-browser@brave.service"], 2) }
  }, { tier: "matrix" })
}

async function cycle() {
  const s = await snapshot(), start = Date.now()
  version = s.version ?? state.build ?? "unknown"
  await poll()
  const pending = state.seen
  commit = version === pending?.version ? pending.commit : version === state.build ? state.commit ?? "" : ""
  if (pending && !state.outage && s.matched && version === pending.version) {
    const previous = state.build
    if (previous !== version) {
      state.previous = state.current; state.current = {}; state.alerted = []; state.build = version; state.commit = commit; save()
      if (previous) await check("auto-update", async () => ({ status: pending.assisted ? "fail" : "pass", note: `${previous} → ${version}; relay, installed version and loaded zip agree`, metrics: { updateMs: Math.max(0, (pending.switchedAt ?? start) - pending.since), forced: !!pending.assisted } }), { tier: "upgrade", regress: false })
    }
    await check("released-extension", async () => ({ note: `running relay ${version} and connected extension match the installed dev release`, metrics: await metrics(true) }))
    await suite(once ? "short" : "release")
    if (!state.outage) { state.tested = version; if (state.seen?.version === version) delete state.seen; save() }
  } else if (pending && !once && start - pending.since >= 60 * minute && (!pending.forcedAt || start - pending.forcedAt >= 60 * minute)) {
    const first = !pending.forcedAt
    pending.assisted = true; pending.forcedAt = start; save()
    await check("update-stuck", async () => ({ status: "fail", note: `expected ${pending.version}, running ${s.version ?? "none"}; matched zip: ${!!s.matched}` }), { tier: "upgrade", regress: false, ...(first ? { incident: `auto-update stuck on ${pending.version} for 1 h` } : {}) })
    await check("forced-update", dir => command(dir, [binary, "update", "--no-open"], 8), { tier: "upgrade", regress: false })
  } else if (once) {
    if (!s.matched) await check("released-extension", async () => ({ status: "fail", note: "expected connected release matching installed dev version" }))
    if (s.matched) await suite("short")
  }
  // Never wake a dead relay with MCP while timing an automatic switch. Once the health bound is exceeded a
  // user recovery is appropriate, but the switch must then be marked assisted.
  if (!once && state.seen && !s.connected) { await health(false, start); return }

  // During an upgrade leave the live relay idle so its own updater can choose when to switch. Every hour also
  // leave a quiet stretch for idle/reconnect behaviour; an absent browser always gets a real user probe.
  const quiet = !once && !state.outage && s.connected && (!!state.seen || new Date().getMinutes() >= 42)
  if (!quiet) {
    const trafficStart = Date.now()
    const row = await check("fixture-traffic", async dir => {
      const e = await command(dir, node("canary/traffic"), 2)
      e.metrics = await metrics(); return e
    })
    // A broken form assertion is a regression, not proof the whole browser is unreachable.
    const reachable = row.status === "pass" || (await check("reachability", dir => command(dir, node("canary/traffic", "--probe"), 1.5), { regress: false })).status === "pass"
    await health(reachable, trafficStart)
    if (!once && row.status === "pass" && !state.seen && Date.now() - (state.site ?? 0) > 3_600_000) {
      await check("public-traffic", dir => command(dir, node("canary/traffic", "--site"), 2), { report: true }); state.site = Date.now(); save()
    }
  } else await check("idle-observation", async () => ({ metrics: await metrics(true) }), { report: true })
  const now = new Date(), day = now.toLocaleDateString("en-CA")
  if (!once && now.getHours() >= 3 && state.day !== day && !state.seen && !state.outage) {
    await suite("nightly"); state.day = day; save()
  }
}
do { await cycle(); if (!once) await sleep(Math.min(3 * minute, Math.max(1000, nextPoll - Date.now()))) } while (!once)
process.exitCode = failed ? 1 : 0
