// The status page's first-run card: the one thing to do next, from the extension's connection state and a probe of
// this computer's relay port. Without a token or a code the extension doesn't connect at all, so it can't tell "no relay
// yet" from "a relay that hasn't paired with this browser"; the probe (the relay's open /version) tells them apart.
import type { AgentRelayState } from "../shared/protocol"

/** Whether a browse relay answers on this computer's relay port; "unknown" until the first probe ends. */
export type RelayProbe = "unknown" | "absent" | "found"

export type FirstRunStep =
  /** No state from the worker yet, or the probe hasn't answered. */
  | { kind: "checking" }
  /** Nothing set up: run install once. */
  | { kind: "install" }
  /** A relay is there but this browser isn't paired with it (or it refused the pairing): install again, or a code. */
  | { kind: "pair"; reason: "unpaired" | "refused" | "code-rejected"; remote?: string; unpacked: boolean }
  /** Paired (or holding a code) but no relay runs yet; it starts when an agent uses the tools. */
  | { kind: "waiting"; pairing: "token" | "code"; remote?: string }
  | { kind: "connecting"; pairing: boolean; remote?: string }
  | { kind: "connected"; tabs: number; remote?: string }
  | { kind: "update-cli" }
  | { kind: "update-extension"; unpacked: boolean }
  | { kind: "mismatch" }
  | { kind: "conflict" }

export function firstRunStep(state: AgentRelayState | undefined, probe: RelayProbe): FirstRunStep {
  if (!state) return { kind: "checking" }
  const remote = state.relay.remote ? state.relay.address : undefined
  const unpacked = state.unpacked === true
  switch (state.status) {
    case "connected":
      return { kind: "connected", tabs: state.tabs.length, ...(remote ? { remote } : {}) }
    case "incompatible":
      if (state.skew === "update-cli") return { kind: "update-cli" }
      if (state.skew === "update-extension") return { kind: "update-extension", unpacked }
      return { kind: "mismatch" }
    case "conflict":
      return { kind: "conflict" }
    case "untrusted":
      return { kind: "pair", reason: state.codeRejected ? "code-rejected" : "refused", unpacked, ...(remote ? { remote } : {}) }
    case "connecting":
      return { kind: "connecting", pairing: state.pairing === "code", ...(remote ? { remote } : {}) }
    case "offline":
      if (state.codeRejected) return { kind: "pair", reason: "code-rejected", unpacked, ...(remote ? { remote } : {}) }
      if (state.pairing === "none") return { kind: "install" }
      return { kind: "waiting", pairing: state.pairing, ...(remote ? { remote } : {}) }
    case "unpaired":
      if (state.codeRejected) return { kind: "pair", reason: "code-rejected", unpacked, ...(remote ? { remote } : {}) }
      // A relay on another computer was set on purpose; it needs a code from there.
      if (remote) return { kind: "pair", reason: "unpaired", remote, unpacked }
      if (probe === "unknown") return { kind: "checking" }
      return probe === "found" ? { kind: "pair", reason: "unpaired", unpacked } : { kind: "install" }
  }
}

/** Probing is only useful while there's nothing to connect with, for this computer's relay. */
export const shouldProbe = (state: AgentRelayState | undefined) => state?.status === "unpaired" && !state.relay.remote

/**
 * What a GET of the relay's /version answered: found for browse's own reply (`{ version, instanceId }`), or for the
 * relay's refusal of a cross-site browser request; absent for anything else, or no answer.
 */
export function relayProbeResult(status: number | undefined, body: unknown): Exclude<RelayProbe, "unknown"> {
  if (status === undefined || typeof body !== "object" || body === null) return "absent"
  const reply = body as Record<string, unknown>
  if (status === 200 && typeof reply.version === "string" && typeof reply.instanceId === "string") return "found"
  if (status === 403 && typeof reply.error === "string" && /Cross-origin browser requests/.test(reply.error)) return "found"
  return "absent"
}
