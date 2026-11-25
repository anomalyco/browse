// Browser-managed policy settings (chrome.storage.managed, declared in public/schema.json).
// When an administrator or NixOS writes a browser policy for browse, each configured key fixes that setting over
// chrome.storage.local without overwriting local storage, so removing a key from policy reverts cleanly.

import {
  AGENT_GROUPING_KEY,
  AGENT_GROUP_COLLAPSE_KEY,
  AGENT_WINDOW_KEY,
  BROWSER_NAME_KEY,
  HANDOFF_NOTIFICATIONS_KEY,
  HUMAN_INPUT_KEY,
  IDLE_MINUTES_KEY,
  MUTE_TABS_KEY,
  RELAY_ADDRESS_KEY,
  agentGroupCollapse,
  agentGrouping,
  agentWindowPlacement,
  handoffNotifications,
  humanInput,
  idleMinutesSetting,
  muteTabs,
  relayAddress,
  type AgentGroupCollapse,
  type AgentGrouping,
  type AgentWindowPlacement,
  type HandoffNotifications,
  type HumanInput,
  type MuteTabs,
} from "./protocol"

export type ManagedSettings = {
  window?: AgentWindowPlacement
  grouping?: AgentGrouping
  groupCollapse?: AgentGroupCollapse
  idleMinutes?: number
  humanInput?: HumanInput
  muteTabs?: MuteTabs
  handoffNotifications?: HandoffNotifications
  browserName?: string
  relayAddress?: string
  autoPairLocalRelay?: boolean
}

export type PolicySettingKey =
  | "window"
  | "grouping"
  | "groupCollapse"
  | "idleMinutes"
  | "humanInput"
  | "muteTabs"
  | "handoffNotifications"

export const POLICY_SETTING_KEYS: readonly PolicySettingKey[] = [
  "window",
  "grouping",
  "groupCollapse",
  "idleMinutes",
  "humanInput",
  "muteTabs",
  "handoffNotifications",
]

export const SETTING_LOCAL_KEYS: Record<PolicySettingKey, string> = {
  window: AGENT_WINDOW_KEY,
  grouping: AGENT_GROUPING_KEY,
  groupCollapse: AGENT_GROUP_COLLAPSE_KEY,
  idleMinutes: IDLE_MINUTES_KEY,
  humanInput: HUMAN_INPUT_KEY,
  muteTabs: MUTE_TABS_KEY,
  handoffNotifications: HANDOFF_NOTIFICATIONS_KEY,
}

export type EffectiveSettings = {
  window: AgentWindowPlacement
  grouping: AgentGrouping
  groupCollapse: AgentGroupCollapse
  idleMinutes: number
  humanInput: HumanInput
  muteTabs: MuteTabs
  handoffNotifications: HandoffNotifications
}

const VALID_IDLE_MINUTES = new Set([0, 10, 30, 60])

/** Parses one managed policy key into its canonical value, or undefined when absent or invalid. */
export function parseManagedValue<K extends keyof ManagedSettings>(key: K, raw: unknown): ManagedSettings[K] {
  switch (key) {
    case "window":
      return (raw === "current" || raw === "separate" ? raw : undefined) as ManagedSettings[K]
    case "grouping":
      return (raw === "shared" || raw === "session" || raw === "none" ? raw : undefined) as ManagedSettings[K]
    case "groupCollapse":
      return (raw === "auto" || raw === "off" ? raw : undefined) as ManagedSettings[K]
    case "idleMinutes":
      return (typeof raw === "number" && VALID_IDLE_MINUTES.has(raw) ? raw : undefined) as ManagedSettings[K]
    case "humanInput":
      return (raw === "on" || raw === "off" ? raw : undefined) as ManagedSettings[K]
    case "muteTabs":
      return (raw === "on" || raw === "off" ? raw : undefined) as ManagedSettings[K]
    case "handoffNotifications":
      return (raw === "recording" || raw === "always" ? raw : undefined) as ManagedSettings[K]
    case "browserName": {
      const value = typeof raw === "string" ? raw.trim().slice(0, 60) : ""
      return (value || undefined) as ManagedSettings[K]
    }
    case "relayAddress": {
      const value = typeof raw === "string" ? raw.trim() : ""
      return (value && relayAddress(value) !== undefined ? value : undefined) as ManagedSettings[K]
    }
    case "autoPairLocalRelay":
      return (typeof raw === "boolean" ? raw : undefined) as ManagedSettings[K]
  }
}

/** Reads chrome.storage.managed safely; browsers without managed storage resolve to {}. */
async function rawManaged(keys?: string | string[] | null): Promise<Record<string, unknown>> {
  const area = chrome.storage?.managed
  if (!area || typeof area.get !== "function") return {}
  try {
    const result = (await (keys === undefined ? area.get(null) : area.get(keys))) as Record<string, unknown> | undefined
    return result && typeof result === "object" ? result : {}
  } catch {
    return {}
  }
}

/** Reads one validated managed policy value, or undefined when not set by policy. */
export async function readManaged<K extends keyof ManagedSettings>(key: K): Promise<ManagedSettings[K]> {
  const stored = await rawManaged(key)
  return parseManagedValue(key, stored[key])
}

/** Reads all valid managed policy values currently set by browser policy. */
export async function readManagedAll(): Promise<ManagedSettings> {
  const stored = await rawManaged()
  const out: ManagedSettings = {}
  const keys: (keyof ManagedSettings)[] = [
    ...POLICY_SETTING_KEYS,
    "browserName",
    "relayAddress",
    "autoPairLocalRelay",
  ]
  for (const key of keys) {
    const parsed = parseManagedValue(key, stored[key])
    if (parsed !== undefined) (out as Record<string, unknown>)[key] = parsed
  }
  return out
}

const localReaders: { [K in PolicySettingKey]: (value: unknown) => EffectiveSettings[K] } = {
  window: agentWindowPlacement,
  grouping: agentGrouping,
  groupCollapse: agentGroupCollapse,
  idleMinutes: idleMinutesSetting,
  humanInput,
  muteTabs,
  handoffNotifications,
}

/** Reads one user setting: browser policy when set, else chrome.storage.local, else the default. */
export async function readSetting<K extends PolicySettingKey>(key: K): Promise<EffectiveSettings[K]> {
  const managed = await readManaged(key)
  if (managed !== undefined) return managed as EffectiveSettings[K]
  const localKey = SETTING_LOCAL_KEYS[key]
  const stored = await chrome.storage.local.get(localKey)
  return localReaders[key](stored[localKey])
}

/** Reads every user setting with its effective value and which keys are fixed by browser policy. */
export async function readAllSettings(): Promise<{ settings: EffectiveSettings; managed: PolicySettingKey[] }> {
  const [policy, stored] = await Promise.all([
    readManagedAll(),
    chrome.storage.local.get(Object.values(SETTING_LOCAL_KEYS)),
  ])
  const managed: PolicySettingKey[] = []
  const pick = <K extends PolicySettingKey>(key: K): EffectiveSettings[K] => {
    const fromPolicy = policy[key]
    if (fromPolicy !== undefined) {
      managed.push(key)
      return fromPolicy as EffectiveSettings[K]
    }
    return localReaders[key](stored[SETTING_LOCAL_KEYS[key]])
  }
  return {
    settings: {
      window: pick("window"),
      grouping: pick("grouping"),
      groupCollapse: pick("groupCollapse"),
      idleMinutes: pick("idleMinutes"),
      humanInput: pick("humanInput"),
      muteTabs: pick("muteTabs"),
      handoffNotifications: pick("handoffNotifications"),
    },
    managed,
  }
}

/** Effective relay address string: managed policy if set, else chrome.storage.local. */
export async function effectiveRelayAddress(localStored?: Record<string, unknown>): Promise<unknown> {
  const managed = await readManaged("relayAddress")
  if (managed !== undefined) return managed
  if (localStored) return localStored[RELAY_ADDRESS_KEY]
  return (await chrome.storage.local.get(RELAY_ADDRESS_KEY))[RELAY_ADDRESS_KEY]
}

/** Effective browser name: managed policy if set, else chrome.storage.local. */
export async function effectiveBrowserName(): Promise<string | undefined> {
  const managed = await readManaged("browserName")
  if (managed !== undefined) return managed
  const value = (await chrome.storage.local.get(BROWSER_NAME_KEY))[BROWSER_NAME_KEY]
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 60) : undefined
}
