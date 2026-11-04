// The relay's own config, config.json in the data root, changed with `browse set <key> <value>`. It's the relay's
// alone: not a setting of the extension's options page, and not something the agents' `settings` tool can change.
//   hostname  where the relay listens: 127.0.0.1 (default, this computer only) or 0.0.0.0 (every network, for
//             browsers on other computers). Connections from other computers only ever reach the extension's
//             WebSocket, where pairing applies; agents, the CLI and CDP clients use 127.0.0.1 either way.
import fs from "node:fs"
import path from "node:path"
import { writePrivateJsonFileSync } from "./fs-durability.ts"
import { dataRoot } from "./paths.ts"

export const hostnames = ["127.0.0.1", "0.0.0.0"] as const
export type Hostname = (typeof hostnames)[number]
export type RelayConfig = { hostname?: Hostname }

export const relayConfigPath = (root = dataRoot()) => path.join(root, "config.json")

export function parseHostname(input: unknown): Hostname | undefined {
  if (typeof input !== "string") return undefined
  const value = input.trim().toLowerCase()
  if (value === "127.0.0.1" || value === "localhost") return "127.0.0.1"
  if (value === "0.0.0.0") return "0.0.0.0"
  return undefined
}

export function readRelayConfig(root = dataRoot()): RelayConfig {
  try {
    const value = JSON.parse(fs.readFileSync(relayConfigPath(root), "utf8")) as { hostname?: unknown } | null
    const hostname = parseHostname(value?.hostname)
    return hostname === undefined ? {} : { hostname }
  } catch {
    return {}
  }
}

export function writeRelayConfig(config: RelayConfig, root = dataRoot()) {
  writePrivateJsonFileSync(relayConfigPath(root), config, { ensureParent: true })
}

/** Where the relay listens. */
export const relayHostname = (root = dataRoot()): Hostname => readRelayConfig(root).hostname ?? "127.0.0.1"

/** A connection from this computer, which may use everything the relay serves; others get the extension link only. */
export function isLocalPeer(socket: { readonly remoteAddress?: string | undefined }) {
  const remote = socket.remoteAddress?.replace(/^::ffff:/, "")
  return remote !== undefined && (remote === "::1" || remote.startsWith("127."))
}
