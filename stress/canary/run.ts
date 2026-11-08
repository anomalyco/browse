// One serial schedule. State survives service restarts; a build is only stamped after both expensive checks finish.
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"
import { binaryPath, cacheDir, chromeDebugPort, dataDir, fixturePort, relayJson, relayPort, sleep, stateDir } from "../lib/env.ts"
import { BrowserCdp } from "../lib/cdp.ts"
import { Sampler } from "../lib/metrics.ts"
import { npxSmoke } from "./npx.ts"
import { command, readJson, record, root, saveJson, type Evidence, type Metrics, type Status } from "./results.ts"

const { values } = parseArgs({ options: { once: { type: "boolean" }, "soak-minutes": { type: "string" } } })
const once = !!values.once, short = Number(values["soak-minutes"] ?? 2), minute = 60_000
const binary = binaryPath, stress = path.resolve(import.meta.dirname, "..")
assert(!process.env.OPENCODE_BROWSER_HOME && process.env.BROWSE_STRESS_BINARY === binary && dataDir === path.join(os.homedir(), ".local/share/browse"), "requires the canary install's XDG paths without OPENCODE_BROWSER_HOME")
assert([relayPort, chromeDebugPort, fixturePort].every(p => Number.isInteger(p) && p >= 19700 && p <= 19799) && new Set([relayPort, chromeDebugPort, fixturePort]).size === 3, "dedicated canary ports required")
assert(once ? fs.realpathSync(os.homedir()).startsWith(path.join(fs.realpathSync(os.tmpdir()), "opencode/browse-canary.")) : os.userInfo().username === "canary", "--once requires a temp opencode/browse-canary.* HOME; service requires user canary")
assert(!once || (Number.isFinite(short) && short > 0 && short <= 30))
assert(process.env.OPENCODE_BROWSER_AUTO_UPDATE === undefined && process.env.OPENCODE_BROWSER_UPDATE_CHECK === "1", "the stored mode must control auto-update, including after MCP respawns the relay")
process.umask(0o077)
const webhook = process.env.CANARY_SLACK_WEBHOOK
delete process.env.CANARY_SLACK_WEBHOOK // never pass it to browsers, fuzz, npm or the product
const node = (name: string, ...args: string[]) => [process.execPath, path.join(stress, name + ".ts"), ...args]
const stateFile = path.join(root, "state.json")
type State = { updatesPaused?: boolean; build?: string; commit?: string; tested?: string; day?: string; site?: number; trafficAt?: number; seen?: { version: string; commit: string; since: number; lagSince?: number; switchedAt?: number; assisted?: boolean; forcedAt?: number }; outage?: { since: number; incident?: boolean; hard?: boolean }; previous: Record<string, Status>; current: Record<string, Status>; alerted: string[] }
fs.mkdirSync(root, { recursive: true, mode: 0o700 })
const state: State = fs.existsSync(stateFile) ? readJson(stateFile) : { previous: {}, current: {}, alerted: [] }
const save = () => saveJson(stateFile, state)
const updateFile = path.join(stateDir, "auto-update.json")
const updateState = () => fs.existsSync(updateFile) ? readJson<{ mode?: string; installing?: { pid: number } }>(updateFile) : {}
const setUpdateMode = (mode: "on" | "off") => saveJson(updateFile, { ...updateState(), mode })
function resumeUpdates() { setUpdateMode("on"); delete state.updatesPaused; save() }
// A service stop or reboot can preempt finally. Undo only a pause this canary owned.
if (state.updatesPaused) resumeUpdates()
assert((updateState().mode ?? "on") === "on", "stored auto-update mode must be on between release suites")
let failed = false, version = state.build ?? "unknown", commit = state.commit ?? ""
async function alert(message: string, id: string) {
  const folder = path.join(root, id), url = process.env.CANARY_RESULTS_URL?.replace(/\/$/, "")
  const text = `Browse canary: ${message} — <${url ? `${url}/${id}/` : `ssh://${os.hostname()}`}|${os.hostname()}:${folder}>`
  console.error(`Browse canary: ${message} — ${folder}`)
  fs.appendFileSync(path.join(root, "ALERTS.md"), `- ${new Date().toISOString()} — ${message} ([run](${id}/summary.md))\n`, { mode: 0o600 })
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
  const installed = spawnSync(binary, ["--version"], { encoding: "utf8", timeout: 15_000 }).stdout?.trim()
  let zipVersion: string | undefined, zipBuild: string | undefined
  try {
    const zip = readJson<{ version: string; build: string }>(path.join(cacheDir, "extension.json"))
    zipVersion = zip.version; zipBuild = zip.build
  } catch { /* files may not exist during a failed update */ }
  const extension: string | undefined = ext?.connected ? ext.build : undefined
  const matched = !!zipBuild && zipVersion === v?.version && installed === zipVersion && !!installed?.includes("-dev.") && zipBuild === extension
  return { version: v?.version, installed, connected: ext?.connected === true, extension, zipVersion, matched }
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
async function poll(s: Awaited<ReturnType<typeof snapshot>>) {
  if (Date.now() < nextPoll) return
  nextPoll = Date.now() + 5 * minute
  await check("dev-tag", async () => {
    const res = await fetch("https://registry.npmjs.org/@opencode%2fbrowse/dev", { signal: AbortSignal.timeout(15_000) })
    assert(res.ok, `registry HTTP ${res.status}`)
    const pkg = await res.json() as { version: string; gitHead?: string }
    assert(/^\d+\.\d+\.\d+-dev\.\d+(\.\d+)?$/.test(pkg.version), "invalid dev dist-tag")
    if (pkg.version === state.tested && pkg.version === s.installed && s.matched && state.seen) { delete state.seen; save() }
    if ((pkg.version !== state.tested || pkg.version !== s.installed) && state.seen?.version !== pkg.version) {
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
      // A moving tag must not buy a stalled install another hour (or reset its retry throttle).
      const prior = state.seen && !state.seen.switchedAt && !(s.matched && s.version === state.seen.version) ? state.seen : undefined
      state.seen = { version: pkg.version, since, commit: head.slice(0, 7), lagSince: prior?.lagSince ?? prior?.since ?? since, forcedAt: prior?.forcedAt, assisted: prior?.assisted }; save()
    }
    const pending = state.seen, age = pending ? Date.now() - (pending.lagSince ?? pending.since) : 0
    const behind = s.installed !== pkg.version
    return { status: behind ? age >= 60 * minute ? "fail" : "skipped" : "pass", note: `npm dev ${pkg.version}; installed ${s.installed || "missing"}${behind ? `; behind for ${Math.floor(age / minute)} min` : ""}` }
  }, { tier: "upgrade", regress: false })
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
        assert(pid > 1 && exe === fs.realpathSync(binary), "refusing to kill an unknown listener")
        process.kill(pid, "SIGKILL"); fs.appendFileSync(path.join(dir, "run.log"), `killed canary relay ${pid}\n`)
      }
      const relay = await command(dir, [binary, "session", "list", "--json"], 2)
      const browser = await command(dir, ["sudo", "-n", "systemctl", "restart", "browse-canary-browser@chrome.service"], 2)
      return browser.status === "fail" ? browser : relay
    }, { incident: "30 min recovery bound exceeded; attempted hard restart" })
  }
}

type Snapshot = Awaited<ReturnType<typeof snapshot>>
const builds = (s: Snapshot) => `relay ${s.version ?? "missing"}, binary ${s.installed || "missing"}, zip ${s.zipVersion ?? "missing"}, connected extension ${s.extension ?? "missing"}`

async function releaseSuite() {
  const skip = async (note: string) => { await check("soak-release", async () => ({ status: "skipped", note })); return false }
  state.updatesPaused = true; save()
  try {
    setUpdateMode("off")
    // A tick that read "on" before our write may still be fetching its manifest (30 s timeout).
    // Drain that tick, then any live installer it started. A dead pid can linger until updates resume.
    await sleep(31_000)
    const deadline = Date.now() + 15 * minute
    for (;;) {
      const pid = updateState().installing?.pid
      if (!pid) break
      assert(Number.isSafeInteger(pid) && pid > 1, "invalid installer pid")
      try { process.kill(pid, 0) } catch (err) { if ((err as NodeJS.ErrnoException).code === "ESRCH") break; throw err }
      if (Date.now() >= deadline) return await skip(`not started: installer ${pid} still running`)
      await sleep(1000)
    }
    const before = await snapshot()
    if (!before.matched || before.version !== version || !before.extension || updateState().mode !== "off") return await skip(`not started: could not pin ${version}; ${builds(before)}`)
    return await suite("release", before.extension)
  } finally { resumeUpdates() }
}

async function suite(kind: "release" | "nightly" | "short", pinnedExtension?: string) {
  // Observe, don't inject traffic or start another run while the harness owns the browser. Interrupt a long
  // soak/fuzz if the extension stays missing for the incident bound, before attempting any recovery.
  const observed = async (dir: string, argv: string[], minutes: number) => {
    const abort = new AbortController(); let missing = 0
    let drift: string | undefined
    const observeBuild = (s: Snapshot) => {
      if (pinnedExtension && ((s.version && s.version !== version) || (s.installed && s.installed !== version) || (s.zipVersion && s.zipVersion !== version) || (s.extension && s.extension !== pinnedExtension))) drift ??= `invalid: build changed during ${version} check; ${builds(s)}`
    }
    const timer = setInterval(async () => {
      const s = await snapshot()
      observeBuild(s)
      if (s.connected) missing = 0
      else if (!missing) missing = Date.now()
      else if (Date.now() - missing >= 6 * minute) abort.abort()
      await poll(s)
      if (state.seen && s.matched && s.version === state.seen.version && !state.seen.switchedAt) { state.seen.switchedAt = Date.now(); save() }
    }, 30_000)
    let e: Evidence
    try { e = await command(dir, argv, minutes, abort.signal) } finally { clearInterval(timer) }
    const after = await snapshot()
    observeBuild(after)
    if (drift) return { ...e, status: "skipped" as const, note: drift }
    if (abort.signal.aborted) {
      await health(false, missing)
      return { ...e, status: "fail" as const, note: "interrupted: browser unreachable for 6 min" }
    }
    if (after.version && version !== after.version) return { ...e, status: "skipped" as const, note: `version changed mid-check to ${after.version}` }
    if (pinnedExtension) {
      if (!after.matched) return { ...e, status: "fail" as const, note: `could not verify build after check: ${builds(after)}` }
      e.note += `; before and after: ${builds(after)}`
    }
    return e
  }
  const core = kind !== "nightly" && await check("scenarios-core", async dir => {
    const argv = node("run-scenarios", "--tag", "core"), first = await observed(dir, argv, 25)
    if (first.status !== "fail" || state.outage) return first
    const retry = await observed(dir, argv, 25)
    return retry.status === "pass" ? { ...retry, status: "flaky", note: "passed on retry in fresh MCP sessions; both attempts retained" } : retry
  })
  if (kind === "release" && core && core.status === "skipped") {
    await check("soak-release", async () => ({ status: "skipped", note: `not started: build changed during ${core.id}` }))
    return false
  }
  if (state.outage) return false
  const duration = kind === "nightly" ? 60 : kind === "release" ? 30 : short
  const args = ["--minutes", String(duration), "--min-success", "0.995"]
  if (kind === "short") args.push("--no-sites", "--workers", "1", "--only", "fill-click", "--chaos", "session-delete", "--chaos-every", "10", "--sample-every", "10")
  if (kind === "release") args.push("--chaos-every", "75")
  let bound = false
  const soak = await check(`soak-${kind}`, async dir => {
    if (pinnedExtension) {
      const s = await snapshot()
      if (!s.matched || s.version !== version || s.extension !== pinnedExtension) return { status: "skipped", note: `not started: expected ${version}; ${builds(s)}` }
    }
    const e = await observed(dir, node("soak", ...args), duration + 12)
    const sub = fs.readdirSync(dir).find(n => n.endsWith("-soak")), file = sub && path.join(dir, sub, "chaos.jsonl")
    if (e.status !== "skipped" && file && fs.existsSync(file)) {
      const events = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l))
      bound = events.some(r => !r.recovered || r.recoveryMs > 120_000)
      if (events.length) e.metrics = { recoveryMs: Math.max(...events.map(r => r.recoveryMs)) }
      if (bound) e.status = "fail"
    }
    return e
  })
  if (bound && soak.status === "fail") await alert("chaos recovery exceeded 120 s", soak.id)
  if (kind !== "nightly" || state.outage) return soak.status !== "skipped"
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
  await poll(s)
  const pending = state.seen
  commit = version === pending?.version ? pending.commit : version === state.build ? state.commit ?? "" : ""
  if (pending && !state.outage && s.matched && version === pending.version) {
    const previous = state.build
    if (previous !== version) {
      state.previous = state.current; state.current = {}; state.alerted = []; state.build = version; state.commit = commit; save()
      if (previous) await check("auto-update", async () => ({ status: pending.assisted ? "fail" : "pass", note: `${previous} → ${version}; relay, installed version and loaded zip agree`, metrics: { updateMs: Math.max(0, (pending.switchedAt ?? start) - pending.since), forced: !!pending.assisted } }), { tier: "upgrade", regress: false })
    }
    await check("released-extension", async () => ({ note: `running relay ${version} and connected extension match the installed dev release`, metrics: await metrics(true) }))
    const tested = once ? await suite("short") : await releaseSuite()
    if (tested && !state.outage) { state.tested = version; if (state.seen?.version === version) delete state.seen; save() }
  } else if (pending && !once && start - (pending.lagSince ?? pending.since) >= 60 * minute && (!pending.forcedAt || start - pending.forcedAt >= 60 * minute)) {
    pending.assisted = true; pending.forcedAt = start; save()
    const note = `update stuck: expected ${pending.version}, installed ${s.installed || "none"}, running ${s.version ?? "none"}; matched zip: ${!!s.matched}`
    await check("update-stuck", async () => ({ status: "fail", note }), { tier: "upgrade", incident: note })
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
  // Leave the updater its 15-minute idle window, but a moving dist-tag must not suppress MCP traffic forever.
  const quiet = !once && !state.outage && s.connected && Date.now() - (state.trafficAt ?? 0) < 20 * minute && (!!state.seen || new Date().getMinutes() >= 42)
  if (!quiet) {
    const trafficStart = Date.now()
    const observe = state.seen ? ["--no-autostart"] : []
    const row = await check("fixture-traffic", async dir => {
      const e = await command(dir, node("canary/traffic", ...observe), 2)
      e.metrics = await metrics(); return e
    })
    // A broken form assertion is a regression, not proof the whole browser is unreachable.
    const reachable = row.status === "pass" || (await check("reachability", dir => command(dir, node("canary/traffic", "--probe", ...observe), 1.5), { regress: false })).status === "pass"
    state.trafficAt = Date.now(); save()
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
