import fs from "node:fs"
import path from "node:path"
import readline from "node:readline"
import { root, type History } from "./results.ts"
import { percentile, slope } from "../lib/results.ts"

const rows: History[] = [], now = Date.now(), hour = 3_600_000
const file = path.join(root, "history.jsonl")
if (fs.existsSync(file)) for await (const line of readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity })) {
  if (!line) continue
  const row: History = JSON.parse(line)
  if (Date.parse(row.started) >= now - 7 * 24 * hour) rows.push(row)
}
const release = rows.findLastIndex(r => r.check === "released-extension")
if (release >= 0) {
  const build = rows[release]!, cycle = rows.slice(release).filter(r => r.version === build.version)
  console.log(`## Latest release cycle · ${build.version} · ${build.started}\n`)
  for (const check of ["released-extension", "scenarios-core", "soak-release"]) console.log(`- ${check}: ${cycle.find(r => r.check === check)?.status ?? "not recorded"}`)
  console.log(`\nLocal incidents: ${path.join(root, "ALERTS.md")}\n`)
}
for (const hours of [24, 168]) {
  const recent = rows.filter(r => Date.parse(r.started) >= now - hours * hour)
  console.log(`## Canary · last ${hours === 24 ? "24 h" : "7 d"}\n\n| Check | Pass / runs | Pass rate | Flaky | Skipped |\n|---|---:|---:|---:|---:|`)
  for (const check of [...new Set(recent.map(r => r.check))].sort()) {
    const checks = recent.filter(r => r.check === check), n = checks.filter(r => r.status !== "skipped").length, pass = checks.filter(r => r.status === "pass").length
    const known = checks.filter(r => r.knownIssue)
    console.log(`| ${check}${known.length ? ` ([${known.length} known failure${known.length > 1 ? "s" : ""}](${known.at(-1)!.knownIssue}))` : ""} | ${pass}/${n} | ${n ? (pass / n * 100).toFixed(1) + "%" : "—"} | ${checks.filter(r => r.status === "flaky").length} | ${checks.length - n} |`)
  }
  const durations = (prefix: string, key: "updateMs" | "recoveryMs", forced?: boolean) => {
    const ms = recent.flatMap(r => !r.check.startsWith(prefix) || r.metrics[key] === undefined || (forced !== undefined && !!r.metrics.forced !== forced) ? [] : [r.metrics[key]!])
    return ms.length ? `p50 ${(percentile(ms, 50) / 1000).toFixed(1)} s, max ${(Math.max(...ms) / 1000).toFixed(1)} s (${ms.length})` : "no observations"
  }
  const rss: [number, number][] = recent.flatMap(r => r.metrics.relayRssMb === undefined ? [] : [[(Date.parse(r.started) - now) / hour, r.metrics.relayRssMb]])
  console.log(`\nRecovery (incidents): ${durations("browser-recovered", "recoveryMs")}; worst event per soak: ${durations("soak-", "recoveryMs")}.\n\nUpdate latency (automatic): ${durations("auto-update", "updateMs", false)}; assisted: ${durations("auto-update", "updateMs", true)}.\n\nRelay RSS: ${rss.length < 2 ? "insufficient samples" : `${rss[0]![1]} → ${rss.at(-1)![1]} MB; ${slope(rss).toFixed(2)} MB/h across ${rss.length} samples`}.\n`)
}
