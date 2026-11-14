// The extension side of the browse relay's protocol (version 2). The relay (cli/src/relay.ts)
// runs agent sessions for the browse MCP server and the browse CLI, and drives tabs through this extension.
// Keep it in step with cli/src/protocol.ts.

type JsonPrimitive = string | number | boolean | null
type JsonValue = JsonPrimitive | JsonValue[] | { readonly [key: string]: JsonValue }
export type JsonObject = { readonly [key: string]: JsonValue }

/** The relay's default port (cli/src/relay/helpers.ts defaultPort). */
export const defaultRelayPort = 19988
/** Optional hello capabilities; an older relay ignores them and an older extension advertises none. */
export const extensionCapabilityTabRelease = "tab-release"

/**
 * The ports an unpinned relay falls back to when another program holds 19988, in the order it tries them. Must match
 * cli/src/relay/port.ts fallbackPorts (19989 is Browser Control's, so it is skipped there and here).
 */
export const relayFallbackPorts = [19990, 19991, 19992, 19993, 19994, 19995, 19996, 19997] as const

/** Every port a browse relay can listen on, in the order the extension dials and scans them. */
export const relayPorts: readonly number[] = [defaultRelayPort, ...relayFallbackPorts]

/** A port that can be a browse relay's: the default or a fallback. Anything else is ignored as a pairing hint. */
export const relayPortHint = (value: unknown): number | undefined =>
  typeof value === "number" && relayPorts.includes(value) ? value : undefined

/**
 * Chrome's minimum alarm period. A disconnected extension's MV3 worker sleeps until this alarm fires, so the
 * relay waits at least this long for the extension to reconnect.
 */
export const extensionReconnectAlarmPeriodMs = 30_000

export type PageStatus = {
  readonly state: "attached" | "running" | "waiting"
  readonly owner: "session" | "user"
  readonly sessionId?: string
  readonly readOnly?: boolean
  readonly message?: string
  readonly handoffId?: string
  /** The tab is being recorded: nothing may be drawn in the page, so a handoff notifies instead of showing a card. */
  readonly recording?: boolean
}

const commandMethods = [
  "ping",
  "debugger.attach",
  "debugger.detach",
  "debugger.sendCommand",
  "tabs.create",
  "tabs.remove",
  "tabs.group",
  "tabs.ungroup",
  "action.setAttached",
  "action.setBadge",
  "pageStatus.set",
  "pageStatus.clear",
  "runtime.reload",
  "tabs.cleanup",
  "update.notice",
  "relay.settings",
  "settings.get",
  "settings.set",
] as const

export type ExtensionCommand = {
  readonly id: number
  readonly method: (typeof commandMethods)[number]
  readonly params?: JsonObject
}

export function parseExtensionCommand(input: string | unknown): ExtensionCommand {
  const parsed: unknown = typeof input === "string" ? JSON.parse(input) : input
  if (
    !isJsonObject(parsed) ||
    typeof parsed.id !== "number" ||
    typeof parsed.method !== "string" ||
    !(commandMethods as readonly string[]).includes(parsed.method) ||
    (parsed.params !== undefined && !isJsonObject(parsed.params))
  )
    throw new Error("Invalid extension command")
  return parsed as ExtensionCommand
}

export function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

export function pageStatusFromJson(value: unknown): PageStatus | undefined {
  if (!isJsonObject(value)) return undefined
  const state = value.state
  const owner = value.owner
  if ((state !== "attached" && state !== "running" && state !== "waiting") || (owner !== "session" && owner !== "user"))
    return undefined
  const message = value.message
  const handoffId = value.handoffId
  if (state === "waiting" && (typeof message !== "string" || typeof handoffId !== "string")) return undefined
  return {
    state,
    owner,
    ...(typeof value.sessionId === "string" ? { sessionId: value.sessionId } : {}),
    ...(value.readOnly === true ? { readOnly: true } : {}),
    ...(typeof message === "string" ? { message } : {}),
    ...(typeof handoffId === "string" ? { handoffId } : {}),
    ...(value.recording === true ? { recording: true } : {}),
  }
}
