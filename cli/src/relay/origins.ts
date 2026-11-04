import crypto from "node:crypto"
import type http from "node:http"
import { unpackedExtensionId } from "../protocol.ts"

/**
 * The unpacked build (its ID is pinned by the manifest key). The Chrome Web Store items are release configuration
 * (paths.ts storeConfig): the relay adds them to the allowed origins, so no store ID is hard-coded here.
 */
export const stableUnpackedExtensionOrigin = `chrome-extension://${unpackedExtensionId}`

export function chromeExtensionOriginForPath(extensionPath: string, platform: NodeJS.Platform = process.platform): string {
  const normalizedPath = platform === "win32" && /^[a-z]:/.test(extensionPath)
    ? extensionPath.charAt(0).toUpperCase() + extensionPath.slice(1)
    : extensionPath
  const pathBytes = platform === "win32" ? Buffer.from(normalizedPath, "utf16le") : normalizedPath
  const digest = crypto.createHash("sha256").update(pathBytes).digest()
  let extensionId = ""
  for (const byte of digest.subarray(0, 16)) {
    extensionId += String.fromCharCode(97 + (byte >> 4), 97 + (byte & 0x0f))
  }
  return `chrome-extension://${extensionId}`
}

const chromeExtensionOriginPattern = /^chrome-extension:\/\/[a-p]+$/

/**
 * Parses the operator-supplied `OPENCODE_BROWSER_EXTENSION_ORIGINS` value into a
 * de-duplicated list of `chrome-extension://<id>` origins to allowlist in
 * addition to the built-ins. Entries are separated by commas or whitespace;
 * anything that is not a bare `chrome-extension://` origin (web origins, paths,
 * scheme-less ids) is dropped so a malformed value can never widen the origin
 * check to a non-extension origin. Used for same-host unpacked installs where
 * the path-derived id cannot match the relay's own bundled path.
 */
export function parseAdditionalExtensionOrigins(raw: string | undefined): string[] {
  if (!raw) {
    return []
  }
  const seen = new Set<string>()
  const origins: string[] = []
  for (const token of raw.split(/[\s,]+/)) {
    const value = token.trim()
    if (!value || !chromeExtensionOriginPattern.test(value) || seen.has(value)) {
      continue
    }
    seen.add(value)
    origins.push(value)
  }
  return origins
}

export function validateHostHeader(options: {
  readonly hostHeader: string | undefined
  readonly host: string
  readonly port: number
}): string | undefined {
  const parsed = parseHostHeader(options.hostHeader)
  if (!parsed) {
    return "Invalid Host header"
  }
  if (parsed.port !== undefined && parsed.port !== options.port) {
    return "Invalid Host header port"
  }
  const allowedHosts = new Set(["localhost", "127.0.0.1", "::1", normalizeHostname(options.host)])
  if (!allowedHosts.has(parsed.hostname)) {
    return "Invalid Host header"
  }
  return undefined
}

export function validateBrowserFetchSite(request: http.IncomingMessage): string | undefined {
  const secFetchSite = request.headers["sec-fetch-site"]
  const value = Array.isArray(secFetchSite) ? secFetchSite[0] : secFetchSite
  if (!value || value === "same-origin" || value === "none") {
    return undefined
  }
  return "Cross-origin browser requests are not allowed"
}

export function validateWebSocketOrigin(options: {
  readonly origin: string | undefined
  readonly additionalChromeExtensionOrigins?: ReadonlySet<string>
  readonly requireChromeExtension?: boolean
}): string | undefined {
  if (!options.origin) {
    return options.requireChromeExtension ? "Extension WebSocket origin is required" : undefined
  }
  if (
    options.origin === stableUnpackedExtensionOrigin
    || options.additionalChromeExtensionOrigins?.has(options.origin)
  ) {
    return undefined
  }
  if (options.requireChromeExtension) {
    return "Extension WebSocket origin is not allowed"
  }
  return "WebSocket origin is not allowed"
}

function normalizeHostname(host: string): string {
  const value = host.trim().toLowerCase()
  if (value.startsWith("[") && value.endsWith("]")) {
    return value.slice(1, -1)
  }
  return value
}

function parseHostHeader(hostHeader: string | undefined): { readonly hostname: string; readonly port?: number } | undefined {
  const value = hostHeader?.trim().toLowerCase()
  if (!value) {
    return undefined
  }
  if (value.startsWith("[")) {
    const closingBracket = value.indexOf("]")
    if (closingBracket === -1) {
      return undefined
    }
    const hostname = value.slice(1, closingBracket)
    const rest = value.slice(closingBracket + 1)
    if (!hostname) {
      return undefined
    }
    if (!rest) {
      return { hostname }
    }
    if (!rest.startsWith(":")) {
      return undefined
    }
    const port = parsePort(rest.slice(1))
    return port === undefined ? undefined : { hostname, port }
  }
  if (value === "::1") {
    return { hostname: "::1" }
  }
  const colonCount = value.split(":").length - 1
  if (colonCount > 1) {
    return undefined
  }
  if (colonCount === 0) {
    return { hostname: value }
  }
  const [hostname, portText] = value.split(":")
  if (!hostname || portText === undefined) {
    return undefined
  }
  const port = parsePort(portText)
  return port === undefined ? undefined : { hostname, port }
}

function parsePort(value: string): number | undefined {
  if (!/^\d+$/.test(value)) {
    return undefined
  }
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return undefined
  }
  return port
}
