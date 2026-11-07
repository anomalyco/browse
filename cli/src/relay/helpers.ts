import { Option, Predicate, Schema } from "effect"
import type { WebSocket } from "ws"
import type { ExecuteTargetSelection } from "../execute.ts"
import type { CdpEvent, CdpResponse, JsonObject, TargetInfo } from "../protocol.ts"
import type { OpenCodeBrowserSession } from "./types.ts"
import { HttpRouteError } from "./http.ts"

// Origins and HTTP plumbing were split out of this module; re-exported so existing importers keep working.
export {
  chromeExtensionOriginForPath,
  parseAdditionalExtensionOrigins,
  stableUnpackedExtensionOrigin,
  validateBrowserFetchSite,
  validateHostHeader,
  validateWebSocketOrigin,
} from "./origins.ts"
export {
  closeHttpServer,
  closeWebSocketServer,
  formatHostForUrl,
  HttpRouteError,
  listenHttpServer,
  logCloseError,
  readJsonBody,
  sendJson,
} from "./http.ts"

export const defaultHost = "127.0.0.1"
/** Not Browser Control's 19989, so an old relay can't hold browse's port. Keep in step with the extension. */
export const defaultPort = 19988

const RawTargetSelection = Schema.Struct({
  urlIncludes: Schema.optionalKey(Schema.String),
  index: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
})
const decodeRawTargetSelection = Schema.decodeUnknownOption(RawTargetSelection)

const RawTargetInfo = Schema.Struct({
  targetId: Schema.String,
  type: Schema.Literals(["page", "iframe", "worker"]),
  title: Schema.optionalKey(Schema.String),
  url: Schema.String,
  canAccessOpener: Schema.optionalKey(Schema.Boolean),
  browserContextId: Schema.optionalKey(Schema.String),
  openerId: Schema.optionalKey(Schema.String),
  parentFrameId: Schema.optionalKey(Schema.String),
})
const decodeRawTargetInfo = Schema.decodeUnknownOption(RawTargetInfo)

export function optionalSessionId(value: JsonObject[string] | undefined): string | undefined {
  if (!Predicate.isString(value) || !value.trim()) {
    return undefined
  }
  const id = value.trim()
  if (!isValidSessionId(id)) {
    throw new HttpRouteError({
      message: "Session ids must use lowercase letters, numbers, and dashes, and be at most 63 characters",
      status: 400,
      code: "invalid-request",
    })
  }
  return id
}

export function isValidSessionId(id: string): boolean {
  if (id.length < 1 || id.length > 63 || id === "." || id === "..") return false
  if (/[A-Z/\\:\0-\x1f\x7f]/.test(id)) return false
  return /^(?:[\p{Extended_Pictographic}\u200d\ufe0f]+\s*)?[a-z0-9][a-z0-9\p{Extended_Pictographic}\u200d\ufe0f\s_-]*$/u.test(id)
}

export function requiredSessionId(value: JsonObject[string] | undefined): string {
  const id = optionalSessionId(value)
  if (!id) {
    throw new HttpRouteError({ message: "sessionId is required", status: 400, code: "invalid-request" })
  }
  return id
}

export function parseTargetSelection(value: JsonObject[string] | undefined): ExecuteTargetSelection | undefined {
  if (value === undefined) {
    return undefined
  }
  if (!getObject(value)) {
    throw new HttpRouteError({ message: "targetSelection must be an object", status: 400, code: "invalid-request" })
  }
  const decoded = decodeRawTargetSelection(value)
  if (Option.isNone(decoded)) {
    throw new HttpRouteError({ message: "targetSelection.index must be a non-negative integer", status: 400, code: "invalid-request" })
  }
  const urlIncludes = decoded.value.urlIncludes ? decoded.value.urlIncludes : undefined
  const index = decoded.value.index
  if (urlIncludes && index !== undefined) {
    throw new HttpRouteError({ message: "Use only one target selector", status: 400, code: "invalid-request" })
  }
  return {
    ...(urlIncludes ? { urlIncludes } : {}),
    ...(index !== undefined ? { index } : {}),
  }
}

export function generateSessionId(existing: ReadonlyMap<string, OpenCodeBrowserSession>): string {
  const adjectives = ["amber", "brisk", "calm", "clever", "cosmic", "gentle", "lucky", "quiet", "rapid", "tidy"]
  const nouns = ["badger", "comet", "falcon", "otter", "panda", "raven", "sparrow", "tiger", "walrus", "wombat"]
  for (let attempt = 0; attempt < 100; attempt++) {
    const adjective = adjectives[Math.floor(Math.random() * adjectives.length)] ?? "calm"
    const noun = nouns[Math.floor(Math.random() * nouns.length)] ?? "otter"
    const suffix = String(Math.floor(Math.random() * 1000)).padStart(3, "0")
    const id = `${adjective}-${noun}-${suffix}`
    if (!existing.has(id)) {
      return id
    }
  }
  return `session-${Date.now().toString(36)}`
}

export function sendCdpResponse(socket: WebSocket, response: CdpResponse): void {
  socket.send(JSON.stringify(response))
}

export function sendCdpEvent(socket: Pick<WebSocket, "send">, event: CdpEvent): void {
  socket.send(JSON.stringify(event))
}

export function getObject(value: unknown): JsonObject | undefined {
  return Predicate.isObject(value) ? (value as JsonObject) : undefined
}

export function getString(object: JsonObject | undefined, key: string): string | undefined {
  const value = object?.[key]
  return Predicate.isString(value) ? value : undefined
}

/** Target.createTarget's url, with Chrome's about:blank default for a missing or empty one. */
export function createTargetUrl(params: JsonObject | undefined): string {
  const url = getString(params, "url")
  return url === undefined || url === "" ? "about:blank" : url
}

export function getNumber(object: JsonObject | undefined, key: string): number | undefined {
  const value = object?.[key]
  return Predicate.isNumber(value) ? value : undefined
}

export function getIdText(object: JsonObject | undefined, key: string): string | undefined {
  const value = object?.[key]
  return Predicate.isNumber(value) || Predicate.isString(value) ? String(value) : undefined
}

export function headerValue(value: string | string[] | undefined): string | undefined {
  if (!Predicate.isString(value) || !value) return undefined
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

export function getTargetInfo(value: unknown): TargetInfo | undefined {
  return Option.match(decodeRawTargetInfo(value), {
    onNone: () => undefined,
    onSome: (info) => ({
      targetId: info.targetId,
      type: info.type,
      title: info.title ?? info.url,
      url: info.url,
      attached: true,
      canAccessOpener: info.canAccessOpener ?? false,
      ...(info.browserContextId === undefined ? {} : { browserContextId: info.browserContextId }),
      ...(info.openerId === undefined ? {} : { openerId: info.openerId }),
      ...(info.parentFrameId === undefined ? {} : { parentFrameId: info.parentFrameId }),
    }),
  })
}

export function isRestrictedTarget(targetInfo: TargetInfo): boolean {
  if (targetInfo.type !== "page" && targetInfo.type !== "iframe" && targetInfo.type !== "worker") {
    return true
  }
  return isRestrictedUrl(targetInfo.url)
}

const restrictedUrlPrefixes = ["chrome://", "chrome-extension://", "chrome-untrusted://", "devtools://", "edge://", "brave://"]

/** Browser-internal or other-extension documents that `chrome.debugger` refuses to expose. */
export function isRestrictedUrl(url: string | undefined): boolean {
  if (!url) {
    return false
  }
  return restrictedUrlPrefixes.some((prefix) => url.startsWith(prefix))
}

/**
 * The HTML that shows a data: URL's content: HTML as is, text and JSON as preformatted text, images as an image.
 * Undefined for other types (PDF, downloads), which Chromium would not render as a page either.
 */
export async function dataUrlDocument(url: string): Promise<string | undefined> {
  const response = await fetch(url)
  const type = (response.headers.get("content-type") ?? "text/plain").split(";")[0]?.trim().toLowerCase() ?? "text/plain"
  if (type === "text/html" || type === "application/xhtml+xml") return await response.text()
  if (type.startsWith("text/") || type === "application/json" || type.endsWith("+json") || type === "application/javascript") {
    const text = (await response.text()).replace(/[&<>]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[char] ?? char)
    return `<html><head><meta name="color-scheme" content="light dark"></head><body><pre style="word-wrap: break-word; white-space: pre-wrap;">${text}</pre></body></html>`
  }
  if (type.startsWith("image/")) {
    return `<html><body style="margin: 0; display: grid; place-items: center; min-height: 100vh;"><img src="${url.replace(/"/g, "%22")}"></body></html>`
  }
  return undefined
}
