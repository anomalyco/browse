import { Predicate } from "effect"

export type CredentialSlot = {
  readonly ref: string
  value: string
  readonly sources: readonly string[]
  expiresAt?: string
}

type RedactionSlot = Pick<CredentialSlot, "ref" | "value">
type MutableCredentialSlot = Omit<CredentialSlot, "sources"> & { readonly sources: string[] }

const secretNamePattern = /auth(?:orization)?|cookie|credential|csrf|xsrf|token|secret|session|password|passwd|pwd|passcode|otp|(?:^|[-_.])code(?:$|[-_.])|(?:api|access|refresh)[-_.]?key|signature|(?:^|[-_.])sig(?:$|[-_.])/i
// Values typed into these fields (passwords, one-time codes) are redacted but never stored as reusable slots.
const oneTimeFieldPattern = /pass(?:word|wd|code|phrase)|(?:^|[-_.])pwd(?:$|[-_.])|otp|totp|(?:^|[-_.])(?:mfa_?|2fa_?|verification_?|auth_?)?code(?:$|[-_.])|(?:^|[-_.])pin(?:$|[-_.])/i
const referencePattern = String.raw`BC_(?:SECRET|REDACTED)_\d+`
/**
 * Known values shorter than this are not replaced inside unrelated output or
 * captured text: short strings collide with ordinary text. A whole value that
 * equals the known value is still replaced.
 */
export const minimumKnownSubstringLength = 8
// HTTP/2 pseudo-header sources are `METHOD url.request.header.:name` or
// `METHOD url.response.header.:name`, optionally followed by a duplicate-header occurrence index.
// Older profiles can have whitespace before the colon or after the name. A source grows as
// `<scope>.` followed by query.… or fragment.…, or by (request|response).(header|json|form|multipart).…
// So only query, fragment, request and response can directly follow the scope; json, form, multipart
// and header only appear after request/response. Ambiguous URL paths ending in .query or .fragment
// are kept: wrongly dropping a real secret is worse than keeping a hostname. :path carries the
// request URL and its query slots, so it is usable.
const pseudoHeaderSourcePattern = /^(?:[A-Z]+ (\S+)\.)?(?:request|response)\.header\.[ \t]*:[ \t]*([^.\s]+)[ \t]*(?:\.\d+)?$/
const nonHeaderSourceSegmentPattern = /\.(?:query|fragment)(?:\.|$)|\.(?:request|response)\.(?:json|form|multipart|header)(?:\.|$)/
function isPseudoHeaderSource(source: string): boolean {
  const match = pseudoHeaderSourcePattern.exec(source)
  if (!match) return false
  const scope = match[1]
  return (scope === undefined || !nonHeaderSourceSegmentPattern.test(scope)) && match[2] !== "path"
}
function isPseudoHeaderOnly(sources: readonly string[]): boolean {
  return sources.length > 0 && sources.every(isPseudoHeaderSource)
}
/**
 * Drop slots that cannot be used safely: values too short to replace without
 * corrupting unrelated text, and slots that only ever came from an HTTP/2
 * pseudo-header (an old :authority hostname, for example). Profiles written by
 * older builds are cleaned through this before they are read or written back.
 */
export function cleanCredentialSlots(slots: readonly CredentialSlot[]): readonly CredentialSlot[] {
  return slots.filter((slot) =>
    slot.value.length >= minimumKnownSubstringLength && !isPseudoHeaderOnly(slot.sources))
}
/** The highest BC_SECRET_N number present, or 0. */
export function highestSecretRef(slots: readonly CredentialSlot[]): number {
  return slots.reduce((highest, slot) => {
    const number = /^BC_SECRET_(\d+)$/.exec(slot.ref)?.[1]
    return number === undefined ? highest : Math.max(highest, Number(number))
  }, 0)
}
const secretHeaders = new Set([
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "api-key",
  "x-csrf-token",
  "csrf-token",
  "x-xsrf-token",
])
// Standard CORS response headers carry routing and policy, not credentials, and must never become
// secret slots. HTTP/2 pseudo-headers are skipped structurally in protectHeader.
const nonSecretHeaders = new Set([
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

export class SecretCollector {
  private readonly slotsByRef = new Map<string, MutableCredentialSlot>()
  private readonly refsByValue = new Map<string, string>()
  private readonly refsBySource = new Map<string, string>()
  // Retired values are redaction-only: never include them in persisted profile slots.
  private readonly retiredRefsByValue = new Map<string, string>()
  // Redaction-only references (BC_REDACTED_N) for one-time values and token-like URL path segments.
  private readonly redactedRefsByValue = new Map<string, string>()
  // Values from stored profiles, addRedactionOnly (typed site secrets) and one-time request fields
  // (passwords, codes) are always replaced, whatever their length.
  private readonly alwaysRedacted = new Set<string>()
  private nextRedactedRef = 1
  private nextRef = 1
  private updated = new Set<string>()
  private observed = new Set<string>()

  constructor(existing: readonly CredentialSlot[] = [], nextRef = 1) {
    // Include refs whose slots are dropped: old HARs and scripts can still refer to them.
    this.nextRef = Math.max(this.nextRef, nextRef, highestSecretRef(existing) + 1)
    for (const slot of cleanCredentialSlots(existing)) {
      const copy: MutableCredentialSlot = {
        ref: slot.ref,
        value: slot.value,
        sources: [...slot.sources],
        ...(slot.expiresAt ? { expiresAt: slot.expiresAt } : {}),
      }
      this.slotsByRef.set(copy.ref, copy)
      this.refsByValue.set(copy.value, copy.ref)
      this.alwaysRedacted.add(copy.value)
      for (const source of copy.sources) {
        this.refsBySource.set(source, copy.ref)
      }
      const number = /^BC_SECRET_(\d+)$/.exec(copy.ref)?.[1]
      if (number) this.nextRef = Math.max(this.nextRef, Number(number) + 1)
    }
  }

  protectHeaders(headers: readonly { readonly name: string; readonly value: string }[], location: "request" | "response", requestScope = ""): Array<{ name: string; value: string }> {
    const occurrences = new Map<string, number>()
    return headers.map(({ name, value }) => {
      const lowerName = name.trim().toLowerCase()
      const occurrence = occurrences.get(lowerName) ?? 0
      occurrences.set(lowerName, occurrence + 1)
      return {
        name,
        value: this.protectHeader(name, value, sourceName(requestScope, `${location}.header.${lowerName}`, occurrence), requestScope),
      }
    })
  }

  protectUrl(rawUrl: string, requestScope = ""): string {
    const fragmentStart = rawUrl.indexOf("#")
    const base = fragmentStart < 0 ? rawUrl : rawUrl.slice(0, fragmentStart)
    const protectQuery = (name: string, value: string, occurrence: number) => this.reference(
      value,
      sourceName(requestScope, `query.${name}`, occurrence),
    )
    const protectPath = (pathname: string) => protectPathSegments(pathname, (segment) => this.redactionReference(segment))
    let protectedUrl: string
    try {
      const url = new URL(base)
      url.pathname = protectPath(url.pathname)
      url.search = protectSearchParams(url.searchParams, protectQuery).toString()
      protectedUrl = restoreReferencePlaceholders(url.toString())
    } catch {
      protectedUrl = protectRelativeUrl(base, protectQuery, protectPath)
    }
    if (fragmentStart < 0) return protectedUrl
    const fragment = protectFragment(rawUrl.slice(fragmentStart + 1), (name, value, occurrence) => this.reference(
      value,
      sourceName(requestScope, `fragment.${name}`, occurrence),
    ))
    return `${protectedUrl}#${fragment}`
  }

  protectBody(body: string, contentType: string | undefined, location: "request" | "response", requestScope = ""): string | undefined {
    const type = contentType?.toLowerCase() ?? ""
    if (type.includes("json")) {
      try {
        return JSON.stringify(this.protectJson(JSON.parse(body), sourceName(requestScope, location), location))
      } catch {
        return undefined
      }
    }
    if (type.includes("application/x-www-form-urlencoded")) {
      const protectedParams = protectSearchParams(new URLSearchParams(body), (name, value, occurrence) =>
        this.reference(value, sourceName(requestScope, `${location}.form.${name}`, occurrence)))
      return restoreReferencePlaceholders(protectedParams.toString())
    }
    if (type.includes("multipart/form-data")) {
      return this.protectMultipart(body, contentType ?? "", location, requestScope)
    }
    return undefined
  }

  slots(): readonly CredentialSlot[] {
    return Array.from(this.slotsByRef.values())
      .sort((left, right) => left.ref.localeCompare(right.ref, undefined, { numeric: true }))
      .map((slot) => ({ ...slot, sources: [...slot.sources] }))
  }

  /** The next reusable ref, including refs this collector dropped but the profile has used before. */
  nextSecretRef(): number {
    return this.nextRef
  }

  updatedRefs(): readonly string[] {
    return Array.from(this.updated).sort()
  }

  observedRefs(): readonly string[] {
    return Array.from(this.observed).sort()
  }

  redactText(text: string): string {
    return redactOutputText(text, this.redactionSlots(), this.alwaysRedacted)
  }

  redactValue(value: unknown): unknown {
    return redactOutputValue(value, this.redactionSlots(), this.alwaysRedacted)
  }

  redactExactValue(value: unknown, minimumLength: number): unknown {
    if (!Predicate.isString(value) && !Predicate.isNumber(value) && !Predicate.isBoolean(value)) return value
    const serialized = String(value)
    if (serialized.length < minimumLength) return value
    const ref = this.refsByValue.get(serialized) ?? this.retiredRefsByValue.get(serialized) ?? this.redactedRefsByValue.get(serialized)
    return ref ? `\${${ref}}` : value
  }

  /**
   * Replace known values of at least `minimumLength` characters anywhere in
   * `text` (raw or percent-encoded), for URLs and headers where a credential
   * can appear under a name that does not look secret.
   */
  redactKnownSubstrings(text: string, minimumLength: number): string {
    const slots = this.redactionSlots().filter((slot) => slot.value.length >= minimumLength)
    const encoded = slots.flatMap((slot) => {
      const variant = encodeURIComponent(slot.value)
      return variant === slot.value ? [] : [{ ref: slot.ref, value: variant }]
    })
    return redactKnownValues(text, [...slots, ...encoded])
  }

  private redactionSlots(): readonly RedactionSlot[] {
    return [
      ...this.slotsByRef.values(),
      ...Array.from(this.retiredRefsByValue, ([value, ref]) => ({ ref, value })),
      ...Array.from(this.redactedRefsByValue, ([value, ref]) => ({ ref, value })),
    ]
  }

  /** Redact `value` everywhere from now on under a redaction-only reference (never persisted to a profile). */
  addRedactionOnly(value: string): void {
    if (value) {
      this.alwaysRedacted.add(value)
      this.redactionReference(value)
    }
  }

  /** Replace these values (raw, percent- and form-encoded) under their redaction-only references, at any length. */
  redactValuesEverywhere(text: string, values: Iterable<string>): string {
    const slots: RedactionSlot[] = []
    for (const value of values) {
      if (!value) continue
      const ref = /^\$\{(.+)\}$/.exec(this.redactionReference(value))?.[1] ?? "BC_REDACTED_0"
      for (const variant of new Set([value, encodeURIComponent(value), new URLSearchParams({ v: value }).toString().slice(2)])) {
        slots.push({ ref, value: variant })
      }
    }
    return redactKnownValues(text, slots)
  }

  /** A stable redaction-only reference: kept out of slots() so it is never persisted to a profile. */
  private redactionReference(value: string): string {
    const persisted = this.refsByValue.get(value)
    if (persisted) {
      this.observed.add(persisted)
      return `\${${persisted}}`
    }
    let ref = this.redactedRefsByValue.get(value)
    if (!ref) {
      ref = `BC_REDACTED_${this.nextRedactedRef++}`
      this.redactedRefsByValue.set(value, ref)
    }
    return `\${${ref}}`
  }

  private protectHeader(name: string, value: string, source: string, requestScope = ""): string {
    if (!value) return value
    const lower = name.trim().toLowerCase()
    // :path carries the request path and query, so protect it exactly like the request URL.
    if (lower === ":path") return this.protectUrl(value, requestScope)
    // Every other HTTP/2 pseudo-header is routing or status, never a credential. Checking the prefix
    // matters because secretNamePattern would classify ":authority" as an auth header.
    if (lower.startsWith(":")) return value
    if (nonSecretHeaders.has(lower)) return value
    if (lower === "cookie" || lower === "set-cookie") {
      const cookieOccurrences = new Map<string, number>()
      const protectLine = (line: string) => line.split(/;\s*/).map((part, index) => {
        const separator = part.indexOf("=")
        if (separator < 1) return part
        const cookieName = part.slice(0, separator).trim()
        const cookieValue = part.slice(separator + 1)
        if (lower === "set-cookie" && index > 0 && /^(domain|path|expires|max-age|samesite|priority|partitioned|secure|httponly)$/i.test(cookieName)) {
          return part
        }
        if (!cookieValue) return part
        const occurrence = cookieOccurrences.get(cookieName) ?? 0
        cookieOccurrences.set(cookieName, occurrence + 1)
        return `${cookieName}=${this.reference(cookieValue, sourceName("", `${source}.${cookieName}`, occurrence))}`
      }).join("; ")
      // Raw headers can arrive as one value with each cookie on its own line.
      return lower === "set-cookie" ? value.split("\n").map(protectLine).join("\n") : protectLine(value)
    }
    if (lower === "location" || lower === "referer" || lower === "referrer") {
      return this.protectUrl(value, `${source}.url`)
    }
    if (lower === "authorization" || lower === "proxy-authorization") {
      const match = /^(\S+)\s+(.+)$/.exec(value)
      if (match) return `${match[1]} ${this.reference(match[2] ?? "", source)}`
    }
    if (secretHeaders.has(lower) || secretNamePattern.test(lower)) {
      return this.reference(value, source)
    }
    return value
  }

  private protectJson(value: unknown, location: string, role: "request" | "response", path: readonly string[] = [], field: JsonField = "open"): unknown {
    if (Array.isArray(value)) {
      // Only direct string elements of a DocC codeListing `code` array are content; everything else is secret.
      if (field === "codeListing") {
        return value.map((item, index) => Predicate.isString(item)
          ? item
          : this.protectJson(item, location, role, [...path, String(index)], "secret"))
      }
      return value.map((item, index) => this.protectJson(item, location, role, [...path, String(index)], field))
    }
    if (Predicate.isObject(value)) {
      // DocC content never reaches nested objects: everything below a `code` object is secret.
      const inherited = field === "codeListing" || field === "codeVoice" ? "secret" : field
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [
        key,
        this.protectJson(item, location, role, [...path, key], jsonField(key, inherited, role, value.type, item)),
      ]))
    }
    if (field === "open" || value === null || value === "") return value
    if (field === "codeVoice" && Predicate.isString(value)) return value
    return this.reference(String(value), `${location}.json.${path.join(".")}`)
  }

  private protectMultipart(body: string, contentType: string, location: "request" | "response", requestScope: string): string | undefined {
    const boundary = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType)?.slice(1).find(Boolean)
    if (!boundary) return undefined
    const delimiter = `--${boundary}`
    const parts = body.split(delimiter)
    if (parts.length < 3) return undefined
    const occurrences = new Map<string, number>()
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
      const occurrence = occurrences.get(name) ?? 0
      occurrences.set(name, occurrence + 1)
      const reference = this.reference(value, sourceName(requestScope, `${location}.multipart.${name}`, occurrence))
      parts[index] = `${part.slice(0, valueStart)}${reference}${part.slice(valueEnd)}`
    }
    return parts.join(delimiter)
  }

  private reference(value: string, source: string): string {
    if (oneTimeFieldPattern.test(sourceFieldName(source))) {
      this.alwaysRedacted.add(value)
      return this.redactionReference(value)
    }
    // Short values are redacted where they were captured but never stored as reusable slots:
    // globally replacing "B" or "1" would corrupt unrelated output, including BC_SECRET_n refs.
    if (value.length < minimumKnownSubstringLength) return this.redactionReference(value)
    const sourceRef = this.refsBySource.get(source)
    if (sourceRef) {
      const slot = this.slotsByRef.get(sourceRef)
      if (slot) {
        if (slot.value === value) {
          this.observed.add(sourceRef)
          return `\${${sourceRef}}`
        }
        if (slot.sources.length === 1) {
          this.retiredRefsByValue.set(slot.value, slot.ref)
          if (this.refsByValue.get(slot.value) === sourceRef) this.refsByValue.delete(slot.value)
          slot.value = value
          const expiresAt = jwtExpiration(value)
          if (expiresAt) slot.expiresAt = expiresAt
          else delete slot.expiresAt
          this.refsByValue.set(value, sourceRef)
          this.updated.add(sourceRef)
          this.observed.add(sourceRef)
          return `\${${sourceRef}}`
        }
        const sourceIndex = slot.sources.indexOf(source)
        if (sourceIndex >= 0) slot.sources.splice(sourceIndex, 1)
        const replacementRef = this.refsByValue.get(value)
        if (replacementRef) {
          this.refsBySource.set(source, replacementRef)
          this.addSource(replacementRef, source)
          this.updated.add(replacementRef)
          this.observed.add(replacementRef)
          return `\${${replacementRef}}`
        }
      }
    }
    const valueRef = this.refsByValue.get(value)
    if (valueRef) {
      this.observed.add(valueRef)
      this.addSource(valueRef, source)
      return `\${${valueRef}}`
    }
    const ref = `BC_SECRET_${this.nextRef++}`
    const expiresAt = jwtExpiration(value)
    this.slotsByRef.set(ref, { ref, value, sources: [source], ...(expiresAt ? { expiresAt } : {}) })
    this.refsByValue.set(value, ref)
    this.refsBySource.set(source, ref)
    this.updated.add(ref)
    this.observed.add(ref)
    return `\${${ref}}`
  }

  private addSource(ref: string, source: string): void {
    const slot = this.slotsByRef.get(ref)
    if (!slot || slot.sources.includes(source)) return
    slot.sources.push(source)
    this.refsBySource.set(source, ref)
  }
}

function restoreReferencePlaceholders(value: string): string {
  return value.replace(/(?:%24|\$)%7B(BC_(?:SECRET|REDACTED)_\d+)%7D/gi, (_match, ref: string) => `\${${ref}}`)
}

/** The field a source names: its last segment that is not an occurrence index. */
function sourceFieldName(source: string): string {
  const segments = source.split(".")
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index] ?? ""
    if (!/^\d+$/.test(segment)) return segment
  }
  return ""
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type JsonField = "open" | "secret" | "codeListing" | "codeVoice"

/**
 * Only a DocC codeListing/codeVoice `code` value is content. Every other secret-looking key, including
 * a bare `code` in requests and responses, stays secret exactly as before.
 */
function jsonField(key: string, inherited: JsonField, role: "request" | "response", type: unknown, value: unknown): JsonField {
  if (inherited === "secret") return "secret"
  if (!secretNamePattern.test(key)) return inherited
  if (key !== "code" || role !== "response") return "secret"
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
  protect: (name: string, value: string, occurrence: number) => string,
  protectPath: (pathname: string) => string,
): string {
  const queryStart = rawUrl.indexOf("?")
  if (queryStart < 0) return protectPath(rawUrl)
  const protectedQuery = protectSearchParams(new URLSearchParams(rawUrl.slice(queryStart + 1)), protect).toString()
  return restoreReferencePlaceholders(`${protectPath(rawUrl.slice(0, queryStart))}?${protectedQuery}`)
}

function protectSearchParams(
  params: URLSearchParams,
  protect: (name: string, value: string, occurrence: number) => string,
): URLSearchParams {
  const result = new URLSearchParams()
  const occurrences = new Map<string, number>()
  for (const [name, value] of params) {
    const occurrence = occurrences.get(name) ?? 0
    occurrences.set(name, occurrence + 1)
    result.append(name, value && secretNamePattern.test(name) ? protect(name, value, occurrence) : value)
  }
  return result
}

function protectFragment(
  fragment: string,
  protect: (name: string, value: string, occurrence: number) => string,
): string {
  const occurrences = new Map<string, number>()
  return fragment.split("&").map((part) => {
    const separator = part.indexOf("=")
    if (separator < 1) return part
    const entry = new URLSearchParams(part).entries().next().value
    if (!entry) return part
    const [name, value] = entry
    // Recognize parameter names, not route/anchor text containing token-like words.
    if (!/^[\w.-]+$/.test(name) || !secretNamePattern.test(name)) return part
    const occurrence = occurrences.get(name) ?? 0
    occurrences.set(name, occurrence + 1)
    return value ? `${part.slice(0, separator + 1)}${protect(name, value, occurrence)}` : part
  }).join("&")
}

function sourceName(requestScope: string, location: string, occurrence = 0): string {
  const base = requestScope ? `${requestScope}.${location}` : location
  return occurrence === 0 ? base : `${base}.${occurrence}`
}

export function redactKnownValues(text: string, slots: readonly RedactionSlot[]): string {
  return [...slots]
    .sort((left, right) => right.value.length - left.value.length)
    .reduce((output, slot) => replaceOutsideReferences(output, slot.value, `\${${slot.ref}}`), text)
}

/**
 * Redact output text. Explicitly registered values (typed site secrets,
 * one-time request fields) and known values of at least
 * `minimumKnownSubstringLength` are replaced anywhere. A whole string equal to
 * any known value is replaced even when the value is shorter: output that is
 * exactly a credential is intentional credential output.
 */
export function redactOutputText(
  text: string,
  slots: readonly RedactionSlot[],
  alwaysRedacted: ReadonlySet<string>,
): string {
  return outputStringRedactor(slots, alwaysRedacted)(text)
}

function redactOutputValue(
  value: unknown,
  slots: readonly RedactionSlot[],
  alwaysRedacted: ReadonlySet<string>,
): unknown {
  return redactValueWith(value, slots, outputStringRedactor(slots, alwaysRedacted))
}

function outputStringRedactor(
  slots: readonly RedactionSlot[],
  alwaysRedacted: ReadonlySet<string>,
): (text: string) => string {
  const exact = new Map<string, RedactionSlot>()
  for (const slot of slots) {
    if (slot.value && !exact.has(slot.value)) exact.set(slot.value, slot)
  }
  const referenceText = new RegExp(String.raw`^\$\{${referencePattern}\}$`)
  const substringSlots = slots.filter((slot) =>
    slot.value.length >= minimumKnownSubstringLength || alwaysRedacted.has(slot.value))
  return (text) => {
    const match = text && !referenceText.test(text) ? exact.get(text) : undefined
    return match ? `\${${match.ref}}` : redactKnownValues(text, substringSlots)
  }
}

function redactValueWith(
  value: unknown,
  slots: readonly RedactionSlot[],
  redactString: (text: string) => string,
): unknown {
  if (Predicate.isString(value)) return redactString(value)
  if (Predicate.isNumber(value) || Predicate.isBoolean(value)) {
    const slot = slots.find((candidate) => candidate.value === String(value))
    return slot ? `\${${slot.ref}}` : value
  }
  if (Array.isArray(value)) return value.map((item) => redactValueWith(item, slots, redactString))
  if (!Predicate.isObject(value)) return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    secretNamePattern.test(key) ? redactSecretValue(item) : redactValueWith(item, slots, redactString),
  ]))
}

function redactSecretValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecretValue)
  if (Predicate.isObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactSecretValue(item)]))
  }
  return value === null || value === "" ? value : "[REDACTED]"
}

function replaceOutsideReferences(text: string, value: string, replacement: string): string {
  if (!value) return text
  const references = new RegExp(String.raw`\$\{${referencePattern}\}`, "g")
  let output = ""
  let offset = 0
  for (const match of text.matchAll(references)) {
    const index = match.index ?? 0
    output += text.slice(offset, index).split(value).join(replacement)
    output += match[0]
    offset = index + match[0].length
  }
  return output + text.slice(offset).split(value).join(replacement)
}

function jwtExpiration(value: string): string | undefined {
  const parts = value.split(".")
  if (parts.length !== 3 || !parts[1]) return undefined
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as { exp?: unknown }
    return Predicate.isNumber(payload.exp) ? new Date(payload.exp * 1_000).toISOString() : undefined
  } catch {
    return undefined
  }
}
