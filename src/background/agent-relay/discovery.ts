// Finding this computer's relay when it isn't on the default port. An unpinned relay steps to a fallback port when
// another program (Playwriter) holds 19988 (cli/src/relay/port.ts) and tells the extension where it went when it
// pairs; without that hint, a failed connection scans the candidates' open /version for a browse relay.
import { defaultRelayPort, isJsonObject, relayPortHint, relayPorts } from "../../agent-relay/protocol"
import { probeRelayPort } from "../../agent-relay/probe"
import { RELAY_ADDRESS_KEY, relayAddress } from "../../shared/protocol"
import { DISCOVERED_PORT_KEY, PORT_KEY, TOKENS_KEY, type AgentRelayLog } from "./wire"

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

/** The port to move to: the first browse port this browser holds a token for, else the first that answered. */
export function chooseRelayPort(found: readonly number[], tokenFor: (port: number) => boolean): number | undefined {
  return found.find((port) => tokenFor(port)) ?? found[0]
}

// A browse relay sends these itself (wire.ts CLOSE_CODES); any other close that wasn't a pairing refusal came from
// something that may not be the relay at all.
const BROWSE_CLOSE_CODES = new Set([4001, 4002, 4003, 4004, 4005])

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

  const scan = async (missed: () => void) => {
    const failed = deps.current().port
    const found = await scanRelayPorts()
    // Every candidate refused, or none is browse (the usual "no relay is running"): keep the normal backoff.
    if (found.length === 0) return missed()
    const stored = await chrome.storage.local.get([TOKENS_KEY])
    const tokens = isJsonObject(stored[TOKENS_KEY]) ? stored[TOKENS_KEY] : {}
    const next = chooseRelayPort(found, (port) => typeof tokens[`127.0.0.1:${port}`] === "string")
    // The port that just failed answered as browse: it is already the right one, so back off and try it again later.
    if (next === undefined || next === failed) return missed()
    deps.log.add("relay.discovery", { found: found.join(","), port: next })
    await chrome.storage.local.set({ [DISCOVERED_PORT_KEY]: next })
    deps.reconnect("discovery")
  }

  return {
    /**
     * A connection closed. Returns true when a scan was started: it reconnects on a find, or calls `missed` (the
     * normal backoff) when nothing answered. A relay that challenged us, or sent one of browse's close codes, is
     * already the right port. The pairing gate in handshake.ts stays the only thing that decides what is obeyed.
     */
    afterClose(closed: { readonly challenged: boolean; readonly code: number }, missed: () => void): boolean {
      if (!deps.current().automatic) return false
      if (closed.challenged || BROWSE_CLOSE_CODES.has(closed.code)) return false
      const now = Date.now()
      if (now - lastScan < SCAN_INTERVAL_MS) return false
      lastScan = now
      void scan(missed).catch(() => missed())
      return true
    },
  }
}
