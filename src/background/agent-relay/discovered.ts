// The automatic relay port the extension currently dials: how it was learned (a pairing hint, or a scan), and the port
// whose relay proved itself with the HMAC handshake. A scanned port no relay ever proved is not offered in the form;
// only a proven port or an explicit hint is this browser's relay.
import { defaultRelayPort, relayPortHint } from "../../agent-relay/protocol"
import { DISCOVERED_KIND_KEY, DISCOVERED_PORT_KEY, PROVEN_PORT_KEY } from "./wire"

export type DiscoveredRelay = {
  readonly kind: "hint" | "scan"
  readonly port: number | undefined
  /** The port a connection here completed the relay's HMAC proof on. */
  readonly proven: number | undefined
}

export const defaultDiscovered: DiscoveredRelay = { kind: "hint", port: undefined, proven: undefined }

/** The storage keys that describe discovery. */
export const discoveredKeys = [DISCOVERED_PORT_KEY, DISCOVERED_KIND_KEY, PROVEN_PORT_KEY] as const

/** What the worker knows about the automatic port after reading `stored`. A missing kind is an older scan. */
export function discoveredRelay(stored: Record<string, unknown>): DiscoveredRelay {
  return {
    kind: stored[DISCOVERED_KIND_KEY] === "hint" ? "hint" : "scan",
    port: relayPortHint(stored[DISCOVERED_PORT_KEY]),
    proven: relayPortHint(stored[PROVEN_PORT_KEY]),
  }
}

/** The address shown in the form: only a proven port or a deliberate hint may be non-default. */
export const shownRelayPort = (automatic: boolean, discovered: DiscoveredRelay, port: number): number =>
  automatic && discovered.kind !== "hint" && discovered.proven !== port ? defaultRelayPort : port

/** A connection on `authenticatedPort` completed the relay's proof; record it for the form and for scans. */
export const provenDiscovered = (discovered: DiscoveredRelay, authenticatedPort: number): DiscoveredRelay =>
  ({ ...discovered, proven: authenticatedPort })

/** A close this worker asked for to reconnect with new settings, not a failed connection to scan away from. */
export const isDeliberateClose = (code: number, reason: string): boolean =>
  code === 1000 && (reason === "Pairing changed" || reason === "Checking the connection")
