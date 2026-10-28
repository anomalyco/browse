type JsonPrimitive = string | number | boolean | null

export type JsonValue = JsonPrimitive | JsonValue[] | { readonly [key: string]: JsonValue }

export type JsonObject = { readonly [key: string]: JsonValue }

export const extensionProtocolVersion = 2
/**
 * The oldest extension protocol this relay still speaks. The store extension and the npm package update on their own
 * schedules, so a relay keeps accepting older extensions for a while: raise this only when dropping support for them,
 * and bump extensionProtocolVersion only for changes an older relay can't handle.
 */
export const minExtensionProtocolVersion = 2

/**
 * Chrome's minimum alarm period. A disconnected extension's MV3 worker sleeps
 * until this alarm fires, so relay clients must wait at least this long.
 */
export const extensionReconnectAlarmPeriodMs = 30_000
const legacyExtensionProtocolVersion = 1

export type ExtensionProtocolCompatibility = {
  readonly version: number | null
  readonly compatible: boolean
  readonly legacy: boolean
}

export function extensionProtocolCompatibility(value: JsonValue | undefined): ExtensionProtocolCompatibility {
  const legacy = value === undefined
  const valid = typeof value === "number" && Number.isSafeInteger(value) && value > 0
  const version = valid ? value : legacy ? legacyExtensionProtocolVersion : null
  return { version, compatible: version !== null && version >= minExtensionProtocolVersion && version <= extensionProtocolVersion, legacy }
}

/** Which side is behind when the protocols don't match: the extension (too old) or this CLI (the extension is newer). */
export function extensionProtocolSkew(version: number | null | undefined): "extension-older" | "extension-newer" | undefined {
  if (typeof version !== "number") return undefined
  if (version > extensionProtocolVersion) return "extension-newer"
  if (version < minExtensionProtocolVersion) return "extension-older"
  return undefined
}

/** What to tell the user about a protocol mismatch: update the side that's behind, with the command. */
export function extensionProtocolAdvice(version: number | null | undefined, commands: { readonly install: string }): string {
  const skew = extensionProtocolSkew(version)
  const versions = `extension protocol ${version ?? "unknown"}, this relay speaks ${minExtensionProtocolVersion === extensionProtocolVersion ? extensionProtocolVersion : `${minExtensionProtocolVersion} to ${extensionProtocolVersion}`}`
  if (skew === "extension-newer")
    return `The Browse extension is newer than this browse CLI (${versions}). Update the CLI: run \`${commands.install}\` (an npm install with automatic updates also catches up by itself within a day), then restart opencode.`
  if (skew === "extension-older")
    return `The Browse extension is older than this browse CLI (${versions}). Update the extension: the Chrome Web Store updates it within a few hours (to update now, open chrome://extensions, turn on Developer mode and click Update); an unpacked extension updates when you run \`${commands.install}\` again.`
  return `The Browse extension and this browse CLI don't speak the same protocol (${versions}). Run \`${commands.install}\` again and update the extension.`
}

export type CdpRequest = {
  readonly id: number
  readonly method: string
  readonly params?: JsonObject
  readonly sessionId?: string
}

export type CdpResponse = {
  readonly id: number
  readonly result?: JsonObject
  readonly error?: {
    readonly message: string
  }
  readonly sessionId?: string
}

export type CdpEvent = {
  readonly method: string
  readonly params?: JsonObject
  readonly sessionId?: string
}

export type TargetInfo = {
  readonly targetId: string
  readonly type: "page" | "iframe" | "worker"
  readonly title: string
  readonly url: string
  readonly attached: boolean
  readonly canAccessOpener: boolean
  readonly browserContextId?: string
  readonly openerId?: string
  readonly parentFrameId?: string
}

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

export function makePageStatus(options: {
  readonly state: PageStatus["state"]
  readonly targetOwner: "relay" | "user"
  readonly sessionId?: string
  readonly readOnly?: boolean
  readonly message?: string
  readonly handoffId?: string
  readonly recording?: boolean
}): PageStatus {
  return {
    state: options.state,
    owner: options.targetOwner === "user" ? "user" : "session",
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    ...(options.sessionId && options.readOnly ? { readOnly: true } : {}),
    ...(options.message ? { message: options.message } : {}),
    ...(options.handoffId ? { handoffId: options.handoffId } : {}),
    ...(options.recording ? { recording: true } : {}),
  }
}

const extensionCommandMethodValues = [
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
  "recording.start",
  "recording.stop",
  "recording.status",
  "recording.cancel",
  "tabs.cleanup",
  "update.notice",
  "relay.settings",
  "settings.get",
  "settings.set",
] as const

const extensionEventMethodValues = [
  "hello",
  "auth.response",
  "ready",
  "toolbar.clicked",
  "handoff.completed",
  "debugger.event",
  "debugger.attached",
  "debugger.detached",
  "tabs.removed",
  "tabs.opened",
  "pong",
  "log",
  "recording.cancelled",
  "pageStatus.requested",
  "settings",
] as const

type ExtensionCommandMethod = typeof extensionCommandMethodValues[number]
type ExtensionEventMethod = typeof extensionEventMethodValues[number]

export type ExtensionCommand = {
  readonly id: number
  readonly method: ExtensionCommandMethod
  readonly params?: JsonObject
}

export type ExtensionResponse = {
  readonly id: number
  readonly result?: JsonObject
  readonly error?: string
}

export type ExtensionEvent = {
  readonly method: ExtensionEventMethod
  readonly params?: JsonObject
}

export function parseJsonObject(input: string): JsonObject {
  const parsed: unknown = JSON.parse(input)
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Expected JSON object")
  }
  return parsed as JsonObject
}

const extensionCommandMethods = new Set<string>(extensionCommandMethodValues)

const extensionEventMethods = new Set<string>(extensionEventMethodValues)

export function parseExtensionCommand(input: string): ExtensionCommand {
  const parsed = parseJsonObject(input)
  if (
    typeof parsed.id !== "number" ||
    typeof parsed.method !== "string" ||
    !extensionCommandMethods.has(parsed.method) ||
    (parsed.params !== undefined && !isJsonObject(parsed.params))
  ) {
    throw new Error("Invalid extension command")
  }
  return parsed as ExtensionCommand
}

export function isCdpRequest(input: JsonObject): input is CdpRequest {
  return typeof input.id === "number" &&
    typeof input.method === "string" &&
    (input.params === undefined || isJsonObject(input.params)) &&
    (input.sessionId === undefined || typeof input.sessionId === "string")
}

export function isExtensionResponse(input: JsonObject): input is ExtensionResponse {
  return typeof input.id === "number" &&
    (input.result === undefined || isJsonObject(input.result)) &&
    (input.error === undefined || typeof input.error === "string") &&
    !(input.result !== undefined && input.error !== undefined)
}

export function isExtensionEvent(input: JsonObject): input is ExtensionEvent {
  return typeof input.method === "string" &&
    extensionEventMethods.has(input.method) &&
    (input.params === undefined || isJsonObject(input.params))
}

export function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
