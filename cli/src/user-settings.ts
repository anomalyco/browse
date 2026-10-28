// The user's OpenCode Browser settings: the same ones as the extension's options page (where agent tabs open, how
// they're grouped, when idle ones close, the agent cursor, human-like input, handoff notifications). The extension
// owns them (chrome.storage.local); the relay reads and writes them through it (`settings.get`, `settings.set`) for the
// `settings` MCP tool and CLI command, so the options page updates live and the relay hears of cursor and input changes
// the way it does for changes made on the page. Environment variables on the relay override some of them; security
// switches are environment-only and never settable here. autoUpdate is the relay's own (auto-update.ts keeps it in the
// data root, so it works without the extension); the relay merges it in and never sends it to the extension.
import type { JsonObject } from "./protocol.ts"
import { cliCommand } from "./paths.ts"

export const settingKeys = ["window", "grouping", "idleMinutes", "cursor", "humanInput", "handoffNotifications", "autoUpdate"] as const
/** Settings the relay stores itself rather than in the extension. */
export const relaySettingKeys: readonly SettingKey[] = ["autoUpdate"]
export type SettingKey = (typeof settingKeys)[number]
export type SettingValue = string | number
export type Settings = Record<SettingKey, SettingValue>
/** The settings the relay's environment fixes, by key, with the value in effect. */
export type SettingOverrides = Partial<Record<SettingKey, { readonly variable: string; readonly value: SettingValue }>>

export const settingSpecs: Record<SettingKey, { readonly label: string; readonly values: readonly SettingValue[]; readonly variable?: string }> = {
  window: { label: "Where agents open their tabs (current: the user's window; separate: an unfocused window of their own)", values: ["current", "separate"], variable: "OPENCODE_BROWSER_AGENT_WINDOW" },
  grouping: { label: "How agent tabs are grouped (one group per session, one shared group, or none)", values: ["session", "shared", "none"] },
  idleMinutes: { label: "Close agent tabs untouched for this many minutes", values: [10, 30, 60, "never"] },
  cursor: { label: "Agent cursor on agent tabs outside recordings (pages can detect it)", values: ["off", "always"], variable: "OPENCODE_BROWSER_GHOST_CURSOR" },
  humanInput: { label: "Human-like input (off is faster, but easier for sites to flag)", values: ["on", "off"], variable: "OPENCODE_BROWSER_HUMAN_INPUT" },
  handoffNotifications: { label: "System notification on a handoff (only while recorded, or every handoff)", values: ["recording", "always"] },
  autoUpdate: { label: "npm installs: install updates automatically when idle, only notify, or never check", values: ["on", "notify", "off"], variable: "OPENCODE_BROWSER_AUTO_UPDATE" },
}

/** Environment-only switches that relax a guard or reach the network; the settings tool never touches them. */
export const securityVariables = [
  "OPENCODE_BROWSER_ALLOW_NODE",
  "OPENCODE_BROWSER_ALLOW_ALL_COOKIES",
  "OPENCODE_BROWSER_ALLOW_FOREGROUND",
  "OPENCODE_BROWSER_ALLOW_ALL_STORAGE",
  "OPENCODE_BROWSER_ALLOW_FILE_URLS",
  "OPENCODE_BROWSER_UPDATE_CHECK",
] as const

export class SettingsInputError extends Error {}

const allowed = (key: SettingKey) => settingSpecs[key].values.map(String).join(", ")

/**
 * Parses requested changes strictly: known keys only, each with one of its listed values. idleMinutes also takes the
 * numbers as strings ("30", from the CLI) and 0 for never. Throws with every problem at once.
 */
export function parseSettingChanges(input: unknown): Partial<Settings> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new SettingsInputError("Pass the settings to change as an object, for example { grouping: \"shared\" }.")
  const problems: string[] = []
  const changes: Partial<Settings> = {}
  for (const [key, raw] of Object.entries(input)) {
    if (!(settingKeys as readonly string[]).includes(key)) {
      problems.push(/allow|update|security|node|cookie|foreground|storage|file/i.test(key)
        ? `"${key}" is not a setting: security switches (${securityVariables.join(", ")}) are set only in the relay's environment, never here.`
        : `Unknown setting "${key}". Settings: ${settingKeys.join(", ")}.`)
      continue
    }
    const setting = key as SettingKey
    const value = setting === "idleMinutes" ? idleValue(raw) : raw
    if (value === undefined || !settingSpecs[setting].values.includes(value as SettingValue)) {
      problems.push(`${setting} must be one of ${allowed(setting)} (got ${JSON.stringify(raw)}).`)
      continue
    }
    changes[setting] = value as SettingValue
  }
  if (problems.length) throw new SettingsInputError(problems.join(" "))
  if (!Object.keys(changes).length) throw new SettingsInputError(`Nothing to change. Settings: ${settingKeys.join(", ")}.`)
  return changes
}

function idleValue(raw: unknown): SettingValue | undefined {
  if (raw === "never" || raw === 0 || raw === "0") return "never"
  if (typeof raw === "number") return raw
  if (typeof raw === "string" && /^\d+$/.test(raw)) return Number(raw)
  return undefined
}

/** The extension's answer to settings.get / settings.set (idleMinutes in minutes, 0 for never) as setting values. */
export function settingsFromExtension(wire: JsonObject | undefined): Settings {
  const values = wire && typeof wire.settings === "object" && wire.settings !== null && !Array.isArray(wire.settings) ? (wire.settings as JsonObject) : undefined
  if (!values) throw new Error("The extension answered settings without them")
  const settings = {} as Settings
  for (const key of settingKeys) {
    const value = values[key]
    if (relaySettingKeys.includes(key)) settings[key] = String(settingSpecs[key].values[0])
    else if (key === "idleMinutes") settings[key] = value === 0 ? "never" : typeof value === "number" ? value : 10
    else settings[key] = typeof value === "string" ? value : String(settingSpecs[key].values[0])
  }
  return settings
}

/** Changes in the extension's terms (idleMinutes 0 for never). */
export function settingsToExtension(changes: Partial<Settings>): JsonObject {
  return Object.fromEntries(Object.entries(changes)
    .filter(([key]) => !relaySettingKeys.includes(key as SettingKey))
    .map(([key, value]) => [key, key === "idleMinutes" && value === "never" ? 0 : value]))
}

export type SettingReport = {
  readonly value: SettingValue
  readonly effective: SettingValue
  readonly allowed: readonly SettingValue[]
  readonly description: string
  readonly overriddenBy?: string
}

function report(stored: Settings, overrides: SettingOverrides): Record<SettingKey, SettingReport> {
  return Object.fromEntries(settingKeys.map((key) => {
    const override = overrides[key]
    return [key, {
      value: stored[key],
      effective: override?.value ?? stored[key],
      allowed: settingSpecs[key].values,
      description: settingSpecs[key].label,
      ...(override ? { overriddenBy: override.variable } : {}),
    }]
  })) as Record<SettingKey, SettingReport>
}

const securityNote = `Security switches (${securityVariables.join(", ")}) are environment-only and can't be read or changed here.`

/** `settings get`: each setting's stored value, the value in effect, and the environment variable that fixes it, if any. */
export function describeSettings(stored: Settings, overrides: SettingOverrides) {
  return { settings: report(stored, overrides), note: securityNote }
}

/**
 * `settings set`: what changed, what was already so, and what an environment variable fixes (those aren't written:
 * the change would have no effect), with a line telling the agent to tell the user.
 */
export function describeChanges(options: { readonly before: Settings; readonly after: Settings; readonly requested: Partial<Settings>; readonly overrides: SettingOverrides }) {
  const changed: { key: SettingKey; from: SettingValue; to: SettingValue }[] = []
  const unchanged: SettingKey[] = []
  const overridden: { key: SettingKey; requested: SettingValue; variable: string; effective: SettingValue }[] = []
  for (const [key, value] of Object.entries(options.requested) as [SettingKey, SettingValue][]) {
    const override = options.overrides[key]
    if (override) overridden.push({ key, requested: value, variable: override.variable, effective: override.value })
    else if (options.before[key] === options.after[key]) unchanged.push(key)
    else changed.push({ key, from: options.before[key], to: options.after[key] })
  }
  const lines: string[] = []
  if (changed.length)
    lines.push(`Changed ${changed.map((item) => `${item.key} from ${item.from} to ${item.to}`).join(", ")}. Tell the user what you changed; they can change it back on the extension's options page.`)
  if (unchanged.length) lines.push(`Already set: ${unchanged.map((key) => `${key} is ${options.after[key]}`).join(", ")}.`)
  for (const item of overridden)
    lines.push(`Not changed: ${item.key} is fixed to ${item.effective} by ${item.variable} in the relay's environment, so this setting has no effect. Tell the user; to change it they remove or edit ${item.variable} where opencode starts, then run \`${cliCommand("relay restart")}\`.`)
  return { changed, unchanged, overridden, settings: report(options.after, options.overrides), message: lines.join(" ") }
}

/** The CLI's text for a settings report. */
export function formatSettings(settings: Record<SettingKey, SettingReport>): string[] {
  const width = Math.max(...settingKeys.map((key) => key.length))
  return settingKeys.map((key) => {
    const item = settings[key]
    const override = item.overriddenBy ? `  (in effect: ${item.effective}, set by ${item.overriddenBy} on the relay)` : ""
    return `${key.padEnd(width)}  ${String(item.value).padEnd(9)}  one of ${item.allowed.join(", ")}${override}`
  })
}
