export * as UserSettings from "./user-settings"
import type { JsonObject } from "../agent-relay/protocol"
import {
  AGENT_CURSOR_KEY,
  AGENT_GROUPING_KEY,
  AGENT_WINDOW_KEY,
  DEFAULT_IDLE_MINUTES,
  HANDOFF_NOTIFICATIONS_KEY,
  HUMAN_INPUT_KEY,
  IDLE_MINUTES_KEY,
  agentCursor,
  agentGrouping,
  handoffNotifications,
  humanInput,
} from "../shared/protocol"

// The status page's settings for the relay's settings tool (`settings.get`, `settings.set`; cli/src/user-settings.ts).
// They live in chrome.storage.local like the page's own changes, so the page follows them live and the background
// applies them (and sends cursor and input to the relay) exactly as if the user had chosen them there.

const keys = {
  window: AGENT_WINDOW_KEY,
  grouping: AGENT_GROUPING_KEY,
  idleMinutes: IDLE_MINUTES_KEY,
  cursor: AGENT_CURSOR_KEY,
  humanInput: HUMAN_INPUT_KEY,
  handoffNotifications: HANDOFF_NOTIFICATIONS_KEY,
} as const
type Key = keyof typeof keys

/** The values the page offers; anything else is refused. idleMinutes 0 is never. */
const values: Record<Key, readonly (string | number)[]> = {
  window: ["current", "separate"],
  grouping: ["session", "shared", "none"],
  idleMinutes: [10, 30, 60, 0],
  cursor: ["off", "always"],
  humanInput: ["on", "off"],
  handoffNotifications: ["recording", "always"],
}

/** Every setting as the background reads it (unknown stored values read as the default). */
export async function read(): Promise<JsonObject> {
  const stored = await chrome.storage.local.get(Object.values(keys))
  const idle = stored[IDLE_MINUTES_KEY]
  return {
    settings: {
      window: stored[AGENT_WINDOW_KEY] === "separate" ? "separate" : "current",
      grouping: agentGrouping(stored[AGENT_GROUPING_KEY]),
      idleMinutes: typeof idle === "number" && Number.isFinite(idle) && idle >= 0 ? idle : DEFAULT_IDLE_MINUTES,
      cursor: agentCursor(stored[AGENT_CURSOR_KEY]),
      humanInput: humanInput(stored[HUMAN_INPUT_KEY]),
      handoffNotifications: handoffNotifications(stored[HANDOFF_NOTIFICATIONS_KEY]),
    },
  }
}

/** Stores the given settings after checking every one (none is written if any is invalid); answers with all of them. */
export async function write(changes: JsonObject | undefined): Promise<JsonObject> {
  const items: Record<string, string | number> = {}
  for (const [key, value] of Object.entries(changes ?? {})) {
    if (!(key in keys)) throw new Error(`Unknown setting: ${key}`)
    if ((typeof value !== "string" && typeof value !== "number") || !values[key as Key].includes(value))
      throw new Error(`Invalid value for ${key}: ${JSON.stringify(value)}`)
    items[keys[key as Key]] = value
  }
  if (Object.keys(items).length) await chrome.storage.local.set(items)
  return read()
}
