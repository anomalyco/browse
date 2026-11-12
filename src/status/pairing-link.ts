// install's pairing link (welcome.html#code=…, see cli/src/setup/guidance.ts pairStoreExtension): a one-time code
// and, when the relay isn't on 19988, the port it listens on.
import { relayPortHint } from "../agent-relay/protocol"

export type PairingLink = { readonly code: string; readonly port?: number }

/** What a `#code=…&port=…` fragment carries, or undefined when it isn't a pairing link this version understands. */
export function pairingLink(hash: string): PairingLink | undefined {
  const fragment = new URLSearchParams(hash.replace(/^#/, ""))
  const code = fragment.get("code")
  if (code === null || !/^[0-9A-Za-z-]{8,9}$/.test(code)) return undefined
  const port = relayPortHint(Number(fragment.get("port")))
  return { code, ...(port !== undefined ? { port } : {}) }
}
