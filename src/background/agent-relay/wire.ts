import { defaultRelayPort, isJsonObject, type JsonObject } from "../../agent-relay/protocol"
import { autoUpdateMode, BROWSER_NAME_KEY, type RelayAutoUpdate } from "../../shared/protocol"
import type { createAgentRelayLog } from "./log"
import type { ecdhKeyPair, PairingCode } from "../pairing"

export type AgentRelayLog = ReturnType<typeof createAgentRelayLog>

/** Badge text the relay asked for, by tab. */
export type AgentBadge = { text: string; title?: string }

/** What a connection pairs with: this browser's token for the relay, or a code to exchange for one. */
export type Credential = { kind: "token"; token: string } | { kind: "code"; code: PairingCode; source: "entered" | "bundled" }

export type Handshake = {
  nonce: string
  port: number
  credential: Credential
  protocol?: JsonObject
  ecdh?: Awaited<ReturnType<typeof ecdhKeyPair>>
  /** A code exchange after this extension proved the code: the session key and the relay's nonce. */
  session?: { key: Uint8Array; relayNonce: string }
}

export const OWNER = "relay"
/** Overrides the relay port, for development and isolated tests. */
export const PORT_KEY = "agentRelayPort"
export const PROFILE_KEY = "agentRelayProfile"
/** chrome.storage.local: each agent session's tab group, so a worker restart keeps a session's tabs in one group. */
export const SESSION_GROUPS_KEY = "agentSessionGroups"
/**
 * chrome.storage.local: a pairing code to exchange for a token on the next connection, typed on the status page or
 * brought by install's link (welcome.html#code=…). Earlier versions kept their long shared code here; it's exchanged
 * the same way, once.
 */
export const PAIRING_KEY = "agentRelayPairingCode"
/** chrome.storage.local: this browser's token for each relay it paired with, by `host:port` (cli/src/browser-pairing.ts). */
export const TOKENS_KEY = "agentRelayTokens"
/** chrome.storage.local: codes already tried, so a used or refused one (install's, in the folder) isn't tried again. */
export const SPENT_KEY = "agentRelaySpentCodes"
/** Written next to the manifest by `install` for unpacked builds: a one-time code (cli/src/browser-pairing.ts). */
export const PAIRING_FILE = "relay-pairing.json"
export const ALARM = "opencode-browser-relay"
// Relay tab groups end with this marker, which Chrome renders without width: they read like the session
// groups ("opencode", or the agent session's name) but stay distinguishable for cleanup. The shared group (the
// "One shared group for all agents" setting) ends with it twice.
export const GROUP_MARKER = "\u2063"
export const SHARED_MARKER = GROUP_MARKER + GROUP_MARKER
export const GROUP_COLOR = "grey"
export const MAX_RECORDING_BUFFER = 16 * 1024 * 1024
/** The largest message the relay accepts, in bytes (256 MiB, as Playwright's CDP client); kept a little under. */
export const MAX_MESSAGE = 255 * 1024 * 1024
export const CONNECT_TIMEOUT = 10_000
export const KEEPALIVE = 20_000
export const BACKOFF_BASE = 500
export const BACKOFF_CAP = 15_000
/** A connection that lasted this long was healthy; the next failure starts the backoff over. */
export const STABLE_AFTER = 5_000
/** CDP commands are frequent; only slow or failed ones go to the log. */
export const SLOW_CDP = 2_000
// Another extension's frame in the page (1Password, LastPass, Bitwarden) makes Chrome refuse commands or
// drop the debugger; evicting the frame and re-attaching recovers.
export const FOREIGN_FRAME = /Cannot access a chrome-extension:\/\/ URL|Debugger is not attached to the tab/i
export const ATTACHED_TITLE = "Browse · Agents can use this tab. Click to stop."
export const DEFAULT_PORT = defaultRelayPort

export const CLOSE_CODES: Record<number, string> = {
  1000: "normal",
  1001: "going away",
  1006: "abnormal (no relay, or the connection dropped)",
  1011: "handshake failed",
  4001: "replaced by a newer connection",
  4002: "hello missing or liveness probe failed",
  4003: "protocol incompatible",
  4004: "another browser or profile is connected",
  4005: "relay requires pairing (this extension is too old)",
  4006: "pairing failed",
}

/** The browser's own name for the relay to name it by: Chrome, Edge, Brave, Opera or Chromium. */
export function browserBrand(): string {
  const brands = (navigator as Navigator & { userAgentData?: { brands?: { brand: string }[] } }).userAgentData?.brands?.map((entry) => entry.brand) ?? []
  const known: [string, string][] = [["Microsoft Edge", "Edge"], ["Brave", "Brave"], ["Opera", "Opera"], ["Google Chrome", "Chrome"], ["Chromium", "Chromium"]]
  return known.find(([brand]) => brands.includes(brand))?.[1] ?? "Chrome"
}

/** The name set on the status page, if any. */
export async function browserName(): Promise<string | undefined> {
  const value = (await chrome.storage.local.get(BROWSER_NAME_KEY))[BROWSER_NAME_KEY]
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 60) : undefined
}

/**
 * JSON for the relay, or undefined when it's larger than the relay accepts (or too large for V8 to serialize at
 * all). Measuring UTF-8 is costly, so it only happens when the text could be over the limit.
 */
export function serialize(message: JsonObject) {
  const data = (() => {
    try {
      return JSON.stringify(message)
    } catch {
      return undefined
    }
  })()
  if (data === undefined) return undefined
  // Each UTF-16 unit is 1-3 UTF-8 bytes, so only the window in between needs measuring.
  if (data.length * 3 <= MAX_MESSAGE) return data
  if (data.length > MAX_MESSAGE) return undefined
  return new TextEncoder().encode(data).byteLength <= MAX_MESSAGE ? data : undefined
}

/** How a handoff notification names the agent: its session's chosen name, else "An agent". */
export function sessionName(sessionId?: string) {
  return autoNamed(sessionId) ? "An agent" : `Agent “${sessionId!.trim()}”`
}

/** Session ids the relay or MCP server made up (mcp-1a2b3c4d, oc-ses_..., quiet-falcon-333), rather than an agent's chosen name. */
export function autoNamed(sessionId: string | undefined) {
  return !sessionId || sessionId.startsWith("oc-") || /^mcp-[0-9a-f]{6,}$/i.test(sessionId) || /^[a-z]+-[a-z]+-\d{3}$/.test(sessionId)
}

/**
 * The tab group's name: the session's name when an agent chose one ("github"), else "Agent · <site>" for the
 * page it is on, else "Agent". The trailing marker identifies the relay's groups.
 */
export function groupTitle(sessionId: string | undefined, url?: string) {
  const host = url && /^https?:/.test(url) ? new URL(url).hostname.replace(/^www\./, "") : undefined
  // Never ending in the marker itself, which would read as the shared group.
  const name = autoNamed(sessionId) ? (host ? `Agent · ${host}` : "Agent") : sessionId!.trim().replace(/\u2063+$/, "")
  return `${name.length > 28 ? `${name.slice(0, 27)}…` : name}${GROUP_MARKER}`
}

export function ownedGroup(title: string | undefined) {
  return !!title?.endsWith(GROUP_MARKER)
}

/** The shared group's title: "Agents · 3", for every agent's tabs in its window. */
export function sharedTitle(count: number) {
  return `Agents · ${count}${SHARED_MARKER}`
}

export function sharedGroup(title: string | undefined) {
  return !!title?.endsWith(SHARED_MARKER)
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function text(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

export function number(params: JsonObject | undefined, key: string) {
  const value = params?.[key]
  if (typeof value !== "number") throw new Error(`Missing number param: ${key}`)
  return value
}

export function string(params: JsonObject | undefined, key: string) {
  const value = params?.[key]
  if (typeof value !== "string") throw new Error(`Missing string param: ${key}`)
  return value
}

/** The relay's update state from `relay.settings`, keeping only known fields and values. */
export function relayAutoUpdate(input: unknown): RelayAutoUpdate | undefined {
  if (!isJsonObject(input)) return undefined
  const install = input.install === "npm" || input.install === "checkout" ? input.install : "other"
  const mode = autoUpdateMode(input.mode)
  const effective = autoUpdateMode(input.effective)
  if (!mode || !effective) return undefined
  const short = (value: unknown) => (typeof value === "string" && value.length <= 100 ? value : undefined)
  const optional = {
    overriddenBy: short(input.overriddenBy),
    version: short(input.version),
    channel: short(input.channel),
    latest: short(input.latest),
    pending: short(input.pending),
    previous: short(input.previous),
  }
  return { install, mode, effective, ...Object.fromEntries(Object.entries(optional).filter(([, value]) => value !== undefined)) }
}
