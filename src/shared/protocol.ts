// Messages between the extension's status page (welcome.html) and the background service worker. The page holds
// one `chrome.runtime.connect({ name: STATUS_PORT })` port and watches the relay connection through it.

import type { PageStatus } from "../agent-relay/protocol"

/** The link to the OpenCode Browser relay, which runs agent sessions for the browse MCP server and CLI. */
export type AgentRelayStatus =
  /** No relay is running yet; the CLI or MCP server starts one on demand. */
  | "offline"
  | "connecting"
  | "connected"
  /** OpenCode Browser in another browser or profile holds the relay's connection. */
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
}

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

export type ToStatusPage = { type: "agents"; state: AgentRelayState } | { type: "pairing.result"; ok: boolean }
export type FromStatusPage =
  | { type: "agents.reconnect" }
  | { type: "tabs.cleanup" }
  | { type: "pairing.set"; code: string }
  | { type: "autoUpdate.set"; mode: AutoUpdateMode }
