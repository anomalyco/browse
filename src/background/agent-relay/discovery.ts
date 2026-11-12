// Finding this computer's relay when it isn't on the default port. An unpinned relay steps to a fallback port when
// another program (Playwriter) holds 19988 (cli/src/relay/port.ts) and tells the extension where it went when it
// pairs; without that hint, a failed connection scans the candidates' open /version for a browse relay.
import { defaultRelayPort, isJsonObject, relayPortHint, relayPorts } from "../../agent-relay/protocol"
import { probeRelayPort } from "../../agent-relay/probe"
import { RELAY_ADDRESS_KEY, relayAddress } from "../../shared/protocol"
import { DISCOVERED_KIND_KEY, DISCOVERED_PORT_KEY, PORT_KEY, PROVEN_PORT_KEY, TOKENS_KEY, type AgentRelayLog } from "./wire"

/** Where the next connection dials. */
export type RelayTarget = {
  readonly host: string
  readonly port: number
  /** No address was set and no dev port pinned: the relay may move, so a failed connection may scan for it. */
  readonly automatic: boolean
}

/**
 * The relay address to dial. An address the user set (one with a port, or another computer) and the PORT_KEY dev pin
 * are explicit and dialled exactly as given. Everything else is automatic: the port a pairing hint or a scan found,
 * else 19988.
 */
export function relayTarget(stored: Record<string, unknown>): RelayTarget {
  const address = relayAddress(stored[RELAY_ADDRESS_KEY]) ?? { host: "127.0.0.1" }
  const override = Number(stored[PORT_KEY]) || undefined
  if (address.port !== undefined || address.host !== "127.0.0.1" || override !== undefined)
    return { host: address.host, port: address.port ?? override ?? defaultRelayPort, automatic: false }
  return { host: "127.0.0.1", port: relayPortHint(stored[DISCOVERED_PORT_KEY]) ?? defaultRelayPort, automatic: true }
}

/** The port a pending pairing code is for: the hint it came with, else the default port. */
export const codePort = (value: unknown): number => relayPortHint(value) ?? defaultRelayPort

/** How long one /version probe waits; a scan asks every candidate at once, so the whole scan takes about this long. */
export const PROBE_TIMEOUT_MS = 800
/** At most one scan per this long: a relay that isn't running must not be hunted for on every retry. */
export const SCAN_INTERVAL_MS = 30_000

/** The candidate ports whose /version answered as a browse relay, in dial order. */
export async function scanRelayPorts(timeoutMs = PROBE_TIMEOUT_MS): Promise<number[]> {
  const answers = await Promise.all(
    relayPorts.map(async (port) => ((await probeRelayPort(port, timeoutMs)) === "absent" ? undefined : port)),
  )
  return answers.filter((port): port is number => port !== undefined)
}

/** The port to move to: the proven port, then a port with a token, then 19988, then the rest in dial order. */
export function chooseRelayPort(
  found: readonly number[],
  options: { readonly proven?: number; readonly tokenFor: (port: number) => boolean },
): number | undefined {
  if (found.length === 0) return undefined
  if (options.proven !== undefined && found.includes(options.proven)) return options.proven
  const token = found.find(options.tokenFor)
  if (token !== undefined) return token
  return found.includes(defaultRelayPort) ? defaultRelayPort : found[0]
}

/**
 * The worker's scan after a failed connection. Automatic connections only, and at most one scan per
 * SCAN_INTERVAL_MS; a found port is stored as the discovered port and the connection moves there.
 */
export function createRelayDiscovery(deps: {
  readonly log: AgentRelayLog
  /** The port the failed attempt dialled, and whether that connection was automatic. */
  readonly current: () => { readonly port: number; readonly automatic: boolean }
  /** Connects again, now that the discovered port is stored. */
  readonly reconnect: (reason: string) => void
}) {
  let lastScan = 0
  /** Ports that answered /version but closed without the relay's proof since the last successful authentication. */
  const unproven = new Set<number>()

  const scan = async (missed: () => void) => {
    const failed = deps.current().port
    const stored = await chrome.storage.local.get([TOKENS_KEY, DISCOVERED_PORT_KEY, DISCOVERED_KIND_KEY, PROVEN_PORT_KEY])
    const proven = relayPortHint(stored[PROVEN_PORT_KEY])
    // A port only a scan found and no connection ever proved is a hint at best: forget it before looking again, so a
    // listener that mimics browse's /version can't keep the next attempt on itself. A proven port is just restarting.
    if (
      failed !== proven &&
      stored[DISCOVERED_KIND_KEY] !== "hint" &&
      relayPortHint(stored[DISCOVERED_PORT_KEY]) === failed
    ) await chrome.storage.local.remove([DISCOVERED_PORT_KEY, DISCOVERED_KIND_KEY])
    const found = await scanRelayPorts()
    // Every candidate refused, or none is browse (the usual "no relay is running"): keep the normal backoff.
    if (found.length === 0) return missed()
    // Skip ports that failed their proof while others answered; the proven port is never skipped. If that excludes
    // everything, one success since reset proves nothing about the rest, so start over with all of them.
    let usable = found.filter((port) => port === proven || !unproven.has(port))
    if (usable.length === 0) {
      unproven.clear()
      usable = [...found]
    }
    const tokens = isJsonObject(stored[TOKENS_KEY]) ? stored[TOKENS_KEY] : {}
    const next = chooseRelayPort(usable, {
      proven,
      tokenFor: (port) => typeof tokens[`127.0.0.1:${port}`] === "string",
    })
    // The port that just failed is already the right one: back off and try it again later.
    if (next === undefined || next === failed) return missed()
    deps.log.add("relay.discovery", { found: found.join(","), port: next })
    await chrome.storage.local.set({ [DISCOVERED_PORT_KEY]: next, [DISCOVERED_KIND_KEY]: "scan" })
    deps.reconnect("discovery")
  }

  return {
    /** A connection completed the relay's proof: no candidate is suspect anymore, and a close may scan at once. */
    noteAuthenticated() {
      unproven.clear()
      lastScan = 0
    },
    /**
     * A connection closed. Returns true when a scan was started: it reconnects on a find, or calls `missed` (the
     * normal backoff) when nothing answered. A port that closed without the proof stays suspect until a connection
     * authenticates somewhere; the pairing gate in handshake.ts stays the only thing that decides what is obeyed.
     */
    afterClose(closed: { readonly trusted: boolean; readonly deliberate: boolean; readonly code: number }, missed: () => void): boolean {
      if (!deps.current().automatic) return false
      if (closed.deliberate) return false
      if (!closed.trusted) unproven.add(deps.current().port)
      const now = Date.now()
      if (now - lastScan < SCAN_INTERVAL_MS) return false
      lastScan = now
      void scan(missed).catch(() => missed())
      return true
    },
  }
}
