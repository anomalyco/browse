export * as UserSettings from "./user-settings"
import type { JsonObject } from "../agent-relay/protocol"
import { SETTING_LOCAL_KEYS, readAllSettings, readManagedAll, type PolicySettingKey } from "../shared/policy"

// The status page's settings for the relay's settings tool (`settings.get`, `settings.set`; cli/src/user-settings.ts).
// They live in chrome.storage.local like the page's own changes, so the page follows them live and the background
// applies them (and sends input to the relay) exactly as if the user had chosen them there. Browser-managed policy
// (chrome.storage.managed) fixes any key it sets without touching chrome.storage.local.

/** The values the page offers; anything else is refused. idleMinutes 0 is never. */
const values: Record<PolicySettingKey, readonly (string | number)[]> = {
  window: ["current", "separate"],
  grouping: ["session", "shared", "none"],
  groupCollapse: ["auto", "off"],
  idleMinutes: [10, 30, 60, 0],
  humanInput: ["on", "off"],
  muteTabs: ["on", "off"],
  handoffNotifications: ["recording", "always"],
}

/** Every setting as the background reads it (policy over local over default), plus which keys policy fixes. */
export async function read(): Promise<JsonObject> {
  const { settings, managed } = await readAllSettings()
  return {
    settings,
    ...(managed.length ? { managed } : {}),
  }
}

/** Stores the given settings after checking every one (none is written if any is invalid); skips policy-managed keys. */
export async function write(changes: JsonObject | undefined): Promise<JsonObject> {
  const policy = await readManagedAll()
  const items: Record<string, string | number> = {}
  for (const [key, value] of Object.entries(changes ?? {})) {
    if (!(key in SETTING_LOCAL_KEYS)) throw new Error(`Unknown setting: ${key}`)
    const settingKey = key as PolicySettingKey
    if ((typeof value !== "string" && typeof value !== "number") || !values[settingKey].includes(value))
      throw new Error(`Invalid value for ${key}: ${JSON.stringify(value)}`)
    if (policy[settingKey] === undefined) items[SETTING_LOCAL_KEYS[settingKey]] = value
  }
  if (Object.keys(items).length) await chrome.storage.local.set(items)
  return read()
}
