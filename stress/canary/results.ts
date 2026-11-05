import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { oneLine } from "../lib/results.ts"

export const root = path.join(os.homedir(), "canary")
export type Status = "pass" | "fail" | "flaky" | "skipped"
export type Metrics = { recoveryMs?: number; updateMs?: number; forced?: boolean; relayRssMb?: number; relayFds?: number; tabs?: number; chromeRssMb?: number }
export type History = { id: string; started: string; version: string; check: string; status: Status; metrics: Metrics; knownIssue?: string }
export type Evidence = { status?: Status; note?: string; exit?: number | null; metrics?: Metrics; knownIssue?: string }

export function readJson<T>(file: string): T { return JSON.parse(fs.readFileSync(file, "utf8")) }
export function saveJson(file: string, value: unknown) {
  fs.writeFileSync(`${file}.new`, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 })
  fs.renameSync(`${file}.new`, file)
}

// Children have their own process group: a timed-out scenario mustn't keep the fixture port or start more work.
export async function command(dir: string, argv: string[], minutes: number, signal?: AbortSignal): Promise<Evidence> {
  const log = fs.openSync(path.join(dir, "run.log"), "a", 0o600)
  try {
    const child = spawn(argv[0]!, argv.slice(1), { cwd: os.homedir(), detached: true,
      env: { ...process.env, BROWSE_STRESS_RESULTS: dir }, stdio: ["ignore", log, log] })
    let expired = false
    const kill = (sig: NodeJS.Signals) => { if (child.pid) try { process.kill(-child.pid, sig) } catch {} }
    let hard: NodeJS.Timeout | undefined
    const stop = () => { if (!expired) { expired = true; kill("SIGTERM"); hard = setTimeout(() => kill("SIGKILL"), 3000) } }
    const timer = setTimeout(stop, minutes * 60_000)
    signal?.addEventListener("abort", stop, { once: true })
    try {
      const exit = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve) })
      if (expired || exit !== 0) kill("SIGKILL")
      return { status: !expired && exit === 0 ? "pass" : "fail", exit, note: expired ? "deadline exceeded; see run.log" : `exit ${exit}; see run.log` }
    } finally { clearTimeout(timer); clearTimeout(hard); signal?.removeEventListener("abort", stop) }
  } finally { fs.closeSync(log) }
}

export async function record(check: string, tier: string, version: string, commit: string, blocking: boolean, run: (dir: string) => Promise<Evidence>) {
  const start = new Date(), started = start.toISOString(), id = `${started.replace(/[:.]/g, "-")}-${check}`
  const dir = path.join(root, id)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  let e: Evidence
  try { e = await run(dir) } catch (err) { e = { status: "fail", note: oneLine(err) } }
  const status = e.status ?? "pass", ms = Date.now() - start.getTime()
  if (e.knownIssue) blocking = false
  const line = { id, started, ms, tiers: [tier], commit, dirty: false, version, host: { os: process.platform, arch: process.arch, name: os.hostname(), ci: false },
    counts: Object.fromEntries(["pass", "fail", "flaky", "skipped", "planned"].map(s => [s, Number(s === status)])), blockingFailed: blocking && status === "fail" ? [check] : [],
    check, status, metrics: e.metrics ?? {}, ...(e.knownIssue ? { knownIssue: e.knownIssue } : {}) }
  const result = { id: check, tier, status, ms, exit: e.exit === undefined ? (status === "fail" ? 1 : 0) : e.exit, blocking, note: e.note }
  saveJson(path.join(dir, "result.json"), { ...line, results: [result] })
  fs.appendFileSync(path.join(dir, "run.log"), `${started} ${check} ${status}: ${e.note ?? ""}\n`)
  fs.writeFileSync(path.join(dir, "summary.md"), `# ${check}: ${status}\n\n${version}, ${started}, ${ms} ms. ${e.note ?? ""}\n`)
  fs.appendFileSync(path.join(root, "history.jsonl"), JSON.stringify(line) + "\n")
  console.log(`${check}: ${status} (${ms} ms) ${dir}`)
  return line
}
