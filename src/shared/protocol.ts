// Messages between the extension's status page (welcome.html) and the background service worker. The page holds
// one `chrome.runtime.connect({ name: STATUS_PORT })` port and watches the relay connection through it.

import type { PageStatus } from "../agent-relay/protocol"

/** The link to the Browse relay, which runs agent sessions for the browse MCP server and CLI. */
export type AgentRelayStatus =
  /** No relay is running yet; the CLI or MCP server starts one on demand. */
  | "offline"
  | "connecting"
  | "connected"
  /** Browse in another browser or profile holds the relay's connection. */
  | "conflict"
  /** The relay speaks another protocol version; updating both fixes it. */
  | "incompatible"
  /** No pairing code yet: a Chrome Web Store build needs the one `opencode-browser pair` prints. */
  | "unpaired"
  /** The relay on the port didn't pair: a different code, an older relay, or another program posing as one. */
  | "untrusted"

/** Where the pairing code comes from: written into an unpacked build by install, or typed on the status page. */
export type PairingSource = "bundled" | "stored" | "none"

export type AgentRelayState = {
  status: AgentRelayStatus
  pairing: PairingSource
  /** Tabs agents use, with their page status when an agent is working or waiting for the user. */
  tabs: { tabId: number; status?: PageStatus }[]
  /** A newer browse on the clone's remote branch, as the relay's update check found it, and the command to update. */
  update?: AgentRelayUpdate
  /** Settings the connected relay's environment variables fix (OPENCODE_BROWSER_AGENT_WINDOW, …). */
  overrides?: RelayOverrides
  /** How the connected relay's install updates (cli/src/auto-update.ts), as it reported it in `relay.settings`. */
  autoUpdate?: RelayAutoUpdate
  /** With status "incompatible": which side is behind, when the relay said (its protocol range, or the 4003 reason). */
  skew?: ProtocolSkew
  /** The relay refused install's one-time pairing link (expired or already used). */
  ticketRejected?: boolean
  /** Where the extension connects, `host:port`, and whether that's another computer (the status page's relay address). */
  relay: { address: string; remote: boolean }
  /** What the connected relay calls this browser; agents pass `id` to use it when several are connected. */
  browser?: { id: string; name: string }
}

/** chrome.storage.local, set on the status page: this browser's name for agents. Unset: "<browser> on <computer>". */
export const BROWSER_NAME_KEY = "browserName"

/** chrome.storage.local, set on the status page: a relay on another computer, `host` or `host:port`. Unset: this one. */
export const RELAY_ADDRESS_KEY = "agentRelayAddress"
export type RelayAddress = { host: string; port?: number }
/**
 * A typed or stored relay address (`100.64.0.2`, `devbox.tailnet.ts.net:19988`, `[fd7a::1]`, an optional `ws://`), or
 * undefined when it isn't one. Empty means this computer: `{ host: "127.0.0.1" }`.
 */
export function relayAddress(input: unknown): RelayAddress | undefined {
  if (input === undefined || input === null) return { host: "127.0.0.1" }
  if (typeof input !== "string") return undefined
  const value = input.trim().replace(/^wss?:\/\//i, "").replace(/\/(extension)?$/, "")
  if (value === "") return { host: "127.0.0.1" }
  try {
    const url = new URL(`ws://${value}`)
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash || !url.hostname) return undefined
    return url.port ? { host: url.hostname, port: Number(url.port) } : { host: url.hostname }
  } catch {
    return undefined
  }
}

/** update-cli: this extension is newer than the relay; update-extension: it's older than the relay supports. */
export type ProtocolSkew = "update-cli" | "update-extension"

export type AutoUpdateMode = "on" | "notify" | "off"
export const autoUpdateMode = (value: unknown): AutoUpdateMode | undefined => (value === "on" || value === "notify" || value === "off" ? value : undefined)
/** The relay's update state: an npm install updates itself; a checkout updates with `update`. */
export type RelayAutoUpdate = {
  install: "npm" | "checkout" | "other"
  mode: AutoUpdateMode
  effective: AutoUpdateMode
  overriddenBy?: string
  version?: string
  channel?: string
  latest?: string
  pending?: string
  previous?: string
}

export type AgentRelayUpdate = { summary: string; command: string }

/** chrome.runtime.sendMessage request from an extension page; the worker answers with `{ text }`. */
export const AGENT_DIAGNOSTICS = "agents.diagnostics"

/** chrome.storage.local, set on the status page: where agents open new tabs, "current" (default) or "separate". */
export const AGENT_WINDOW_KEY = "agentTabsWindow"

// The status page's other settings, all in chrome.storage.local. Each applies from the moment it changes (new tabs,
// the next cleanup, the next handoff or input); a missing or unknown value reads as the default.

/** How agent tabs are grouped: one group per agent session (default), one shared group for every agent, or none. */
export const AGENT_GROUPING_KEY = "agentTabsGrouping"
export type AgentGrouping = "session" | "shared" | "none"
export const agentGrouping = (value: unknown): AgentGrouping => (value === "shared" || value === "none" ? value : "session")

/** Minutes an agent tab may sit untouched before it closes; 0 never closes them automatically. */
export const IDLE_MINUTES_KEY = "tabCleanupIdleMinutes"
export const DEFAULT_IDLE_MINUTES = 10

/** Whether the relay draws the agent (ghost) cursor on agent tabs outside recordings: "off" (default) or "always". */
export const AGENT_CURSOR_KEY = "agentCursor"
export type AgentCursor = "off" | "always"
export const agentCursor = (value: unknown): AgentCursor => (value === "always" ? "always" : "off")

/** Whether the relay sends human-like input (curved paths, paced keys): "on" (default) or "off". */
export const HUMAN_INPUT_KEY = "humanInput"
export type HumanInput = "on" | "off"
export const humanInput = (value: unknown): HumanInput => (value === "off" ? "off" : "on")

/** When a handoff shows a system notification: only on a recorded tab (default), or on every handoff. */
export const HANDOFF_NOTIFICATIONS_KEY = "handoffNotifications"
export type HandoffNotifications = "recording" | "always"
export const handoffNotifications = (value: unknown): HandoffNotifications => (value === "always" ? "always" : "recording")

/** The settings the relay applies, sent to it after pairing and whenever they change (the `settings` event). */
export type RelaySettings = { cursor: AgentCursor; humanInput: HumanInput }

/** Settings the relay's environment fixes, whatever the status page says (the relay's `relay.settings` answer). */
export type RelayOverrides = { agentWindow?: "current" | "separate"; cursor?: AgentCursor; humanInput?: HumanInput }

export const STATUS_PORT = "opencode-browser.status"

export type ToStatusPage =
  | { type: "agents"; state: AgentRelayState }
  | { type: "pairing.result"; ok: boolean }
  | { type: "pairing.ticket.result"; ok: boolean }
  /** The outcome of `relay.connect`: the status the new connection settled on, or why nothing was tried. */
  | { type: "relay.result"; status: AgentRelayStatus | "invalid-address" | "invalid-code"; address?: string }
export type FromStatusPage =
  /** Save the relay address (empty: this computer) and, when given, a pairing code; reconnect and report how it went. */
  | { type: "relay.connect"; address: string; code: string }
  | { type: "agents.reconnect" }
  | { type: "tabs.cleanup" }
  | { type: "pairing.set"; code: string }
  | { type: "pairing.ticket"; ticket: string }
  | { type: "autoUpdate.set"; mode: AutoUpdateMode }
