import { relayJson } from "./env.ts"
import type { Sample } from "./metrics.ts"

// The canary runs one soak at a time on its dedicated relay. Use the relay directly: the timeout
// sends SIGTERM to the whole process group, including the MCP clients we'd otherwise use to clean up.
export async function sweepSoakSessions() {
  const { sessions } = await relayJson<{ sessions: { id: string }[] }>("/cli/sessions")
  const owned = sessions.filter(s => s.id === "soak-probe" || /^soak-w\d+-/.test(s.id))
  const deletes = await Promise.allSettled(owned.map(({ id }) => relayJson("/cli/session/delete", { id }, 30_000)))
  for (const d of deletes) if (d.status === "rejected") throw d.reason
}

export function unexplainedRestarts(changes: { at: number; from: number; to: number }[], events: { at: number; type: string; pid?: number; error?: string }[], sampleMs: number) {
  return changes.filter(c => !events.some(e => e.type === "relay-kill9" && !e.error && e.pid === c.from && e.at <= c.at && c.at - e.at < 60_000 + sampleMs))
}

type TimedSample = Sample & { at: number }

/** Longest observed span of RSS measurements from one relay, excluding that process's startup. */
export function longestRssSegment(samples: TimedSample[]) {
  let pid: number | undefined, started = 0
  let points: TimedSample[] = [], longest: TimedSample[] = [], duration = -1
  for (const s of samples) {
    if (typeof s.relayPid !== "number") { pid = undefined; continue }
    if (s.relayPid !== pid) {
      pid = s.relayPid
      started = typeof s.relayStartedAt === "number" ? s.relayStartedAt : s.at
      points = []
    }
    if (s.at - started < 120_000 || typeof s.relayRssMb !== "number") continue
    points.push(s)
    const span = s.at - points[0]!.at
    if (span > duration) { longest = points; duration = span }
  }
  return { samples: longest, durationMs: Math.max(duration, 0) }
}
