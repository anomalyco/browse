// Asking a port whether a browse relay answers there. The relay's open /version identifies it (cli/src/relay.ts); the
// status page uses this to tell "no relay yet" from "a relay that hasn't paired with this browser", and the worker
// uses it to find a relay that moved to a fallback port.

/** Whether a browse relay answers on this computer's relay port; "unknown" until the first probe ends. */
export type RelayProbe = "unknown" | "absent" | "found" | "install-waiting"

/**
 * What a GET of the relay's /version answered: found for browse's own reply (`{ version, instanceId }`), or for the
 * relay's refusal of a cross-site browser request; absent for anything else, or no answer.
 */
export function relayProbeResult(status: number | undefined, body: unknown): Exclude<RelayProbe, "unknown"> {
  if (status === undefined || typeof body !== "object" || body === null) return "absent"
  const reply = body as Record<string, unknown>
  if ((status === 200 && typeof reply.version === "string" && typeof reply.instanceId === "string") ||
      (status === 403 && typeof reply.error === "string" && /Cross-origin browser requests/.test(reply.error)))
    return reply.installWaiting === true ? "install-waiting" : "found"
  return "absent"
}

/**
 * GETs the relay's open /version on `port` and says what answered. Anything that isn't browse's own reply, or no
 * answer within `timeoutMs`, reads as absent. Sent without credentials: whoever holds the port can't learn anything.
 */
export async function probeRelayPort(port: number, timeoutMs = 2_000): Promise<Exclude<RelayProbe, "unknown">> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/version`, {
      headers: { "x-browse-install": "probe" },
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    })
    return relayProbeResult(response.status, await response.json().catch(() => undefined))
  } catch {
    return "absent"
  }
}
