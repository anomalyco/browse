import { Predicate } from "effect"

/** What a scrubbed credential is replaced with, in artifacts and execute output. */
export const redactedPlaceholder = "[redacted]"
/** A URL-safe stand-in while a captured value is being rebuilt, so URL encoding leaves it intact. */
const redactionSentinel = "__browse_redacted__"

const secretNamePattern = /auth(?:orization)?|cookie|credential|csrf|xsrf|token|secret|session|password|passwd|pwd|passcode|otp|(?:^|[-_.])code(?:$|[-_.])|(?:api|access|refresh)[-_.]?key|signature|(?:^|[-_.])sig(?:$|[-_.])/i
// Values typed into these fields (passwords, one-time codes) are redacted at any length.
const oneTimeFieldPattern = /pass(?:word|wd|code|phrase)|(?:^|[-_.])pwd(?:$|[-_.])|otp|totp|(?:^|[-_.])(?:mfa_?|2fa_?|verification_?|auth_?)?code(?:$|[-_.])|(?:^|[-_.])pin(?:$|[-_.])/i
/**
 * Known values shorter than this are not replaced inside unrelated output or
 * captured text: short strings collide with ordinary text. A whole value that
 * equals the known value is still replaced.
 */
export const minimumKnownSubstringLength = 8
const secretHeaders = new Set([
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "api-key",
  "x-csrf-token",
  "csrf-token",
  "x-xsrf-token",
])
// HTTP/2 pseudo-headers (except :path, which is protected like a request URL) and standard CORS
// response headers carry routing and policy, not credentials, and must never be scrubbed.
const nonSecretHeaders = new Set([
  ":authority",
  ":method",
  ":scheme",
  ":status",
  ":protocol",
  "access-control-allow-credentials",
  "access-control-allow-origin",
  "access-control-allow-methods",
  "access-control-allow-headers",
  "access-control-expose-headers",
  "access-control-max-age",
  "access-control-request-method",
  "access-control-request-headers",
  "access-control-allow-private-network",
  "access-control-request-private-network",
])

/**
 * Scrubs credential-shaped fields out of captured exchanges, and known values out of execute output.
 * Scrubbed values are remembered so the same credential is also replaced where it shows up under a
 * name that does not look secret.
 */
export class SecretRedactor {
  private readonly knownValues = new Set<string>()
  // Passwords and one-time codes are replaced at any length, unlike short reusable captures.
  private readonly alwaysRedacted = new Set<string>()

  protectHeaders(headers: readonly { readonly name: string; readonly value: string }[]): Array<{ name: string; value: string }> {
    return headers.map(({ name, value }) => ({ name, value: restoreRedactionPlaceholders(this.protectHeader(name, value)) }))
  }

  protectUrl(rawUrl: string): string {
    const fragmentStart = rawUrl.indexOf("#")
    const base = fragmentStart < 0 ? rawUrl : rawUrl.slice(0, fragmentStart)
    const protectQuery = (name: string, value: string) => value ? this.scrub(value, name) : value
    const protectPath = (pathname: string) => protectPathSegments(pathname, (segment) => this.scrub(segment))
    let protectedUrl: string
    try {
      const url = new URL(base)
      url.pathname = protectPath(url.pathname)
      url.search = protectSearchParams(url.searchParams, protectQuery).toString()
      protectedUrl = url.toString()
    } catch {
      protectedUrl = protectRelativeUrl(base, protectQuery, protectPath)
    }
    protectedUrl = restoreRedactionPlaceholders(protectedUrl)
    if (fragmentStart < 0) return protectedUrl
    const fragment = restoreRedactionPlaceholders(protectFragment(rawUrl.slice(fragmentStart + 1), (name, value) =>
      value ? this.scrub(value, name) : value))
    return `${protectedUrl}#${fragment}`
  }

  protectBody(body: string, contentType: string | undefined): string | undefined {
    const type = contentType?.toLowerCase() ?? ""
    if (type.includes("json")) {
      try {
        return restoreRedactionPlaceholders(JSON.stringify(this.protectJson(JSON.parse(body), "open")))
      } catch {
        return undefined
      }
    }
    if (type.includes("application/x-www-form-urlencoded")) {
      const protectedParams = protectSearchParams(new URLSearchParams(body), (name, value) =>
        value ? this.scrub(value, name) : value)
      return restoreRedactionPlaceholders(protectedParams.toString())
    }
    if (type.includes("multipart/form-data")) {
      const protectedBody = this.protectMultipart(body, contentType ?? "")
      return protectedBody === undefined ? undefined : restoreRedactionPlaceholders(protectedBody)
    }
    return undefined
  }

  redactText(text: string): string {
    // Output that is exactly a credential is intentional credential output, whatever its length.
    if (this.knownValues.has(text)) return redactedPlaceholder
    return this.redactKnown(text, (value) => value.length >= minimumKnownSubstringLength || this.alwaysRedacted.has(value))
  }

  redactUrl(url: string): string {
    return this.redactText(this.protectUrl(url))
  }

  redactValue(value: unknown): unknown {
    const redactString = (text: string) => this.redactText(text)
    const visit = (item: unknown, depth: number): unknown => {
      if (Predicate.isString(item)) return redactString(item)
      if (Predicate.isNumber(item) || Predicate.isBoolean(item)) {
        const text = String(item)
        return this.knownValues.has(text) || this.alwaysRedacted.has(text) ? redactedPlaceholder : item
      }
      if (depth > 32 || item === null || typeof item !== "object" || Buffer.isBuffer(item)) return item
      if (Array.isArray(item)) return item.map((entry) => visit(entry, depth + 1))
      const prototype = Object.getPrototypeOf(item)
      if (prototype !== Object.prototype && prototype !== null) return item
      return Object.fromEntries(Object.entries(item).map(([key, entry]) => [
        key,
        secretNamePattern.test(key) ? redactSecretValue(entry) : visit(entry, depth + 1),
      ]))
    }
    return visit(value, 0)
  }

  redactKnownSubstrings(text: string, minimumLength: number): string {
    return this.redactKnown(text, (value) => value.length >= minimumLength || this.alwaysRedacted.has(value))
  }

  /** Remember `value` for redaction everywhere; nothing is stored on disk. */
  addRedactionOnly(value: string): void {
    if (value) {
      this.alwaysRedacted.add(value)
      this.knownValues.add(value)
    }
  }

  private redactKnown(text: string, include: (value: string) => boolean): string {
    const entries: Array<{ value: string; encoded?: string }> = []
    for (const value of this.knownValues) {
      if (!include(value)) continue
      entries.push({ value })
      const encoded = encodeURIComponent(value)
      if (encoded !== value) entries.push({ value: encoded })
    }
    return entries
      .sort((left, right) => right.value.length - left.value.length)
      .reduce((output, entry) => output.split(entry.value).join(redactedPlaceholder), text)
  }

  /** Mark a credential-shaped field value and remember it for later passes. */
  private scrub(value: string, fieldName = ""): string {
    if (!value) return value
    this.knownValues.add(value)
    if (oneTimeFieldPattern.test(fieldName)) this.alwaysRedacted.add(value)
    return redactionSentinel
  }

  private protectHeader(name: string, value: string): string {
    if (!value) return value
    const lower = name.toLowerCase()
    // :path carries the request path and query, so protect it exactly like the request URL.
    if (lower === ":path") return this.protectUrl(value)
    if (nonSecretHeaders.has(lower)) return value
    if (lower === "cookie" || lower === "set-cookie") {
      const protectLine = (line: string) => line.split(/;\s*/).map((part, index) => {
        const separator = part.indexOf("=")
        if (separator < 1) return part
        const cookieName = part.slice(0, separator).trim()
        const cookieValue = part.slice(separator + 1)
        if (lower === "set-cookie" && index > 0 && /^(domain|path|expires|max-age|samesite|priority|partitioned|secure|httponly)$/i.test(cookieName)) {
          return part
        }
        if (!cookieValue) return part
        return `${cookieName}=${this.scrub(cookieValue)}`
      }).join("; ")
      // Raw headers can arrive as one value with each cookie on its own line.
      return lower === "set-cookie" ? value.split("\n").map(protectLine).join("\n") : protectLine(value)
    }
    if (lower === "location" || lower === "referer" || lower === "referrer") {
      return this.protectUrl(value)
    }
    if (lower === "authorization" || lower === "proxy-authorization") {
      const match = /^(\S+)\s+(.+)$/.exec(value)
      if (match) return `${match[1]} ${this.scrub(match[2] ?? "")}`
    }
    if (secretHeaders.has(lower) || secretNamePattern.test(lower)) {
      return this.scrub(value)
    }
    return value
  }

  private protectJson(value: unknown, field: JsonField, fieldName = ""): unknown {
    if (Array.isArray(value)) {
      // Only direct string elements of a DocC codeListing `code` array are content; everything else is secret.
      if (field === "codeListing") {
        return value.map((item) => Predicate.isString(item) ? item : this.protectJson(item, "secret", fieldName))
      }
      return value.map((item) => this.protectJson(item, field, fieldName))
    }
    if (Predicate.isObject(value)) {
      // DocC content never reaches nested objects: everything below a `code` object is secret.
      const inherited = field === "codeListing" || field === "codeVoice" ? "secret" : field
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [
        key,
        this.protectJson(item, jsonField(key, inherited, value.type, item), key),
      ]))
    }
    if (field === "open" || value === null || value === "") return value
    if (field === "codeVoice" && Predicate.isString(value)) return value
    return this.scrub(String(value), fieldName)
  }

  private protectMultipart(body: string, contentType: string): string | undefined {
    const boundary = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType)?.slice(1).find(Boolean)
    if (!boundary) return undefined
    const delimiter = `--${boundary}`
    const parts = body.split(delimiter)
    if (parts.length < 3) return undefined
    for (let index = 1; index < parts.length - 1; index += 1) {
      const part = parts[index]
      if (!part?.startsWith("\r\n")) return undefined
      const headerEnd = part.indexOf("\r\n\r\n")
      if (headerEnd < 0 || !part.endsWith("\r\n")) return undefined
      const headers = part.slice(2, headerEnd)
      const disposition = headers.split("\r\n").find((line) => /^content-disposition:/i.test(line))
      if (!disposition || /;\s*filename\*?=/i.test(disposition)) return undefined
      const name = /;\s*name="([^"]+)"/i.exec(disposition)?.[1]
      if (!name) return undefined
      const valueStart = headerEnd + 4
      const valueEnd = part.length - 2
      const value = part.slice(valueStart, valueEnd)
      if (!value || !secretNamePattern.test(name)) continue
      parts[index] = `${part.slice(0, valueStart)}${this.scrub(value, name)}${part.slice(valueEnd)}`
    }
    return parts.join(delimiter)
  }
}

function restoreRedactionPlaceholders(value: string): string {
  return value.replaceAll(redactionSentinel, redactedPlaceholder)
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type JsonField = "open" | "secret" | "codeListing" | "codeVoice"

/**
 * Only a DocC codeListing/codeVoice `code` value is content. Every other secret-looking key, including
 * a bare `code` in requests and responses, stays secret exactly as before.
 */
function jsonField(key: string, inherited: JsonField, type: unknown, value: unknown): JsonField {
  if (inherited === "secret") return "secret"
  if (!secretNamePattern.test(key)) return inherited
  if (key !== "code") return "secret"
  if (type === "codeListing" && Array.isArray(value)) return "codeListing"
  if (type === "codeVoice" && Predicate.isString(value)) return "codeVoice"
  return "secret"
}

/** Path segments that look like credentials: JWTs, long hex, and long high-entropy base64/base64url. */
export function looksLikeTokenSegment(segment: string): boolean {
  if (segment.length < 24 || uuidPattern.test(segment) || segment.includes("${")) return false
  if (/^eyJ[\w-]+\.[\w-]+\.[\w-]*$/.test(segment)) return true
  if (/^[0-9a-f]{32,}$/i.test(segment)) return true
  if (!/^[A-Za-z0-9_~+/-]+={0,2}$/.test(segment)) return false
  // Slugs such as "how-to-install-the-extension" are words, not tokens.
  if (/^[a-z]+(?:[-_][a-z]+)+$/i.test(segment)) return false
  const hasDigit = /\d/.test(segment)
  const hasLower = /[a-z]/.test(segment)
  const hasUpper = /[A-Z]/.test(segment)
  return new Set(segment).size >= 12 && hasDigit && (hasLower || hasUpper) && (hasLower && hasUpper || segment.length >= 32)
}

function protectPathSegments(pathname: string, protect: (segment: string) => string): string {
  return pathname.split("/").map((segment) => {
    let decoded: string
    try {
      decoded = decodeURIComponent(segment)
    } catch {
      decoded = segment
    }
    return looksLikeTokenSegment(decoded) ? protect(decoded) : segment
  }).join("/")
}

/** Protect the query of a fragment-free URL that `new URL` cannot parse. */
function protectRelativeUrl(
  rawUrl: string,
  protect: (name: string, value: string) => string,
  protectPath: (pathname: string) => string,
): string {
  const queryStart = rawUrl.indexOf("?")
  if (queryStart < 0) return protectPath(rawUrl)
  const protectedQuery = protectSearchParams(new URLSearchParams(rawUrl.slice(queryStart + 1)), protect).toString()
  return restoreRedactionPlaceholders(`${protectPath(rawUrl.slice(0, queryStart))}?${protectedQuery}`)
}

function protectSearchParams(
  params: URLSearchParams,
  protect: (name: string, value: string) => string,
): URLSearchParams {
  const result = new URLSearchParams()
  for (const [name, value] of params) {
    result.append(name, value && secretNamePattern.test(name) ? protect(name, value) : value)
  }
  return result
}

function protectFragment(
  fragment: string,
  protect: (name: string, value: string) => string,
): string {
  return fragment.split("&").map((part) => {
    const separator = part.indexOf("=")
    if (separator < 1) return part
    const entry = new URLSearchParams(part).entries().next().value
    if (!entry) return part
    const [name, value] = entry
    // Recognize parameter names, not route/anchor text containing token-like words.
    if (!/^[\w.-]+$/.test(name) || !secretNamePattern.test(name)) return part
    return value ? `${part.slice(0, separator + 1)}${protect(name, value)}` : part
  }).join("&")
}

function redactSecretValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecretValue)
  if (Predicate.isObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactSecretValue(item)]))
  }
  return value === null || value === "" ? value : redactedPlaceholder
}
