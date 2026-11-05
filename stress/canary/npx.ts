import path from "node:path"
import { command, type Evidence } from "./results.ts"

const issue = "https://github.com/anomalyco/browse/pull/54"

/** Keep the failure and its evidence. Only the specific pre-fix, same-release build skew is nonblocking. */
export async function knownNpxSkew(text: string, npmVersion: string, relay: { version: string; buildId: string }) {
  const skew = text.match(/Running relay build (\S+) (?:is newer than|does not match) CLI build (\S+?);/)
  if (!skew || relay.version !== npmVersion || relay.buildId !== skew[1] || skew[1] === skew[2]) return false
  const built = Math.max(Date.parse(skew[1]!), Date.parse(skew[2]!))
  if (!Number.isFinite(built)) return false
  const pr = await fetch("https://api.github.com/repos/anomalyco/browse/pulls/54", { signal: AbortSignal.timeout(5000) })
    .then(r => r.ok ? r.json() : undefined).catch(() => undefined)
  return pr?.state === "open" || built < Date.parse(pr?.merged_at)
}

export async function npxSmoke(dir: string): Promise<Evidence> {
  const e = await command(dir, [process.execPath, path.join(import.meta.dirname, "traffic.ts"), "--npx"], 5)
  return e.exit === 54 ? { ...e, knownIssue: issue, note: `Same-release npm/binary build ID mismatch: ${issue}` } : e
}
