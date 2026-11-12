// The automatic relay port the extension currently dials: how it was learned (a pairing hint, or a scan), and whether
// a connection there ever authenticated. A port only a scan found is not offered in the form or used for a pairing
// code until a relay on it proves itself (src/background/agent-relay/discovery.ts, handshake.ts).
import { defaultRelayPort, isJsonObject, relayPortHint } from "../../agent-relay/protocol"
import { DISCOVERED_KIND_KEY, DISCOVERED_PORT_KEY, TOKENS_KEY } from "./wire"

export type DiscoveredRelay = {
  readonly kind: "hint" | "scan"
  readonly port: number | undefined
  readonly trusted: boolean
}

export const defaultDiscovered: DiscoveredRelay = { kind: "hint", port: undefined, trusted: false }

/** The storage keys that describe the discovered port. */
export const discoveredKeys = [DISCOVERED_PORT_KEY, DISCOVERED_KIND_KEY, TOKENS_KEY] as const

/** What the worker knows about the automatic port after reading `stored`. A missing kind is an older scan. */
export function discoveredRelay(stored: Record<string, unknown>, targetPort: number): DiscoveredRelay {
  const tokens = isJsonObject(stored[TOKENS_KEY]) ? stored[TOKENS_KEY] : {}
  return {
    kind: stored[DISCOVERED_KIND_KEY] === "hint" ? "hint" : "scan",
    port: relayPortHint(stored[DISCOVERED_PORT_KEY]),
    // A token under this port was issued by a relay that proved a code, so the port is not "never trusted".
    trusted: typeof tokens[`127.0.0.1:${targetPort}`] === "string",
  }
}

/** The address shown in the form: a scanned port no connection proved is replaced by the default. */
export const shownRelayPort = (automatic: boolean, discovered: DiscoveredRelay, port: number): number =>
  automatic && discovered.kind === "scan" && !discovered.trusted ? defaultRelayPort : port

/** A connection on the discovered port authenticated: it may be shown, and scans may prefer it. */
export const trustDiscovered = (discovered: DiscoveredRelay, authenticatedPort: number): DiscoveredRelay =>
  authenticatedPort === discovered.port ? { ...discovered, trusted: true } : discovered

/** A close this worker asked for to reconnect with new settings, not a failed connection to scan away from. */
export const isDeliberateClose = (code: number, reason: string): boolean =>
  code === 1000 && (reason === "Pairing changed" || reason === "Checking the connection")
