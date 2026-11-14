import path from "node:path"
import { Effect, Predicate } from "effect"
import type { Response } from "patchright-core"
import { writeJsonFileAtomically } from "../fs-durability.ts"
import { minimumKnownSubstringLength, SecretRedactor } from "./redaction.ts"
import {
  NetworkCaptureError,
  type ActiveCapture,
  type CapturedBody,
  type CapturedEntry,
  type Header,
  type NetworkCaptureStopOptions,
  type NetworkEndpointDigest,
} from "./types.ts"

export function finishCapture(
  active: ActiveCapture,
  options: NetworkCaptureStopOptions,
): Effect.Effect<{
  readonly redactionOmissionCount: number
  readonly endpoints: readonly NetworkEndpointDigest[]
}, NetworkCaptureError> {
  return Effect.gen(function* () {
    const redactor = new SecretRedactor()
    const protectedEntries = active.entries
      .map((entry) => protectEntry(entry, redactor))
      .map((entry) => redactEntryKnownValues(entry, redactor))
    if (options.outputPath) {
      yield* writeArtifact(options.outputPath, {
        log: {
          version: "1.2",
          creator: { name: "browse", version: "1" },
          entries: protectedEntries.map(toHarEntry),
        },
      })
    }
    return {
      redactionOmissionCount: options.outputPath ? countRedactionOmissions(active.entries, protectedEntries) : 0,
      endpoints: summarizeEndpoints(protectedEntries),
    }
  })
}

function extractTopLevelJsonKeys(body: CapturedBody | undefined): readonly string[] | undefined {
  if (!body?.text || !body.mimeType.toLowerCase().includes("json")) return undefined
  try {
    const parsed: unknown = JSON.parse(body.text)
    if (Predicate.isObject(parsed) && !Array.isArray(parsed)) {
      const keys = Object.keys(parsed).slice(0, 15)
      return keys.length > 0 ? keys : undefined
    }
  } catch {}
  return undefined
}

function summarizeEndpoints(entries: readonly CapturedEntry[]): readonly NetworkEndpointDigest[] {
  const byRoute = new Map<string, NetworkEndpointDigest>()
  for (const entry of entries) {
    if (["image", "stylesheet", "font", "media"].includes(entry.request.resourceType)) continue
    let routePath = entry.request.url
    try {
      const u = new URL(entry.request.url)
      routePath = `${u.origin}${u.pathname}`
    } catch {}
    const key = `${entry.request.method} ${routePath}`
    const existing = byRoute.get(key)
    const notableHeaders = entry.request.headers
      .filter((h) => {
        const lower = h.name.toLowerCase()
        if (lower === "x-client-data" || lower.startsWith("sec-ch-")) return false
        return h.value.includes("[redacted]") || lower === "authorization" || lower.startsWith("x-")
      })
      .slice(0, 8)
      .map((h) => `${h.name}: ${h.value.slice(0, 80)}`)
    const requestKeys = extractTopLevelJsonKeys(entry.request.body)
    const responseKeys = extractTopLevelJsonKeys(entry.response?.body)
    byRoute.set(key, {
      method: entry.request.method,
      url: entry.request.url.slice(0, 240),
      ...(entry.response ? { status: entry.response.status } : existing?.status !== undefined ? { status: existing.status } : {}),
      count: (existing?.count ?? 0) + 1,
      ...(notableHeaders.length > 0 ? { requestHeaders: notableHeaders } : existing?.requestHeaders ? { requestHeaders: existing.requestHeaders } : {}),
      ...(requestKeys ? { requestKeys } : existing?.requestKeys ? { requestKeys: existing.requestKeys } : {}),
      ...(responseKeys ? { responseKeys } : existing?.responseKeys ? { responseKeys: existing.responseKeys } : {}),
    })
    if (byRoute.size >= 30) break
  }
  return [...byRoute.values()]
}

function countRedactionOmissions(original: readonly CapturedEntry[], protectedEntries: readonly CapturedEntry[]): number {
  let count = 0
  for (let index = 0; index < original.length; index += 1) {
    const before = original[index]
    const after = protectedEntries[index]
    if (before?.request.body?.text && !before.request.body.truncated && !after?.request.body?.text) count += 1
    if (before?.response?.body?.text && !before.response.body.truncated && !after?.response?.body?.text) count += 1
  }
  return count
}

export function captureBuffer(buffer: Buffer | null, mimeType: string | undefined, active: ActiveCapture): CapturedBody | undefined {
  if (!buffer) return undefined
  const remaining = Math.max(0, active.options.maxTotalBodyBytes - active.capturedBodyBytes)
  const captureBytes = Math.min(buffer.length, active.options.maxBodyBytes, remaining)
  const truncated = captureBytes < buffer.length
  active.capturedBodyBytes += captureBytes
  const textual = isTextualMimeType(mimeType)
  const omitted = truncated || !textual
  if (omitted) active.truncatedBodyCount += 1
  return {
    size: buffer.length,
    mimeType: mimeType ?? "application/octet-stream",
    ...(!truncated && textual ? { text: buffer.toString("utf8", 0, captureBytes) } : {}),
    truncated: omitted,
  }
}

export function bodyCanFit(headers: readonly Header[], limit: number): boolean {
  if (limit <= 0) return false
  const length = declaredBodySize(headers)
  const encoding = header(headers, "content-encoding")?.trim().toLowerCase()
  const supportedEncoding = !encoding || encoding === "identity" || encoding === "gzip" || encoding === "br" || encoding === "deflate" || encoding === "zstd"
  if (!supportedEncoding) return false
  if (length !== undefined) return length <= limit
  return Boolean(encoding && isTextualMimeType(contentType(headers)))
}

export function declaredBodySize(headers: readonly Header[]): number | undefined {
  const value = header(headers, "content-length")
  if (!value) return undefined
  const length = Number(value)
  return Number.isSafeInteger(length) && length >= 0 ? length : undefined
}

export function truncatedBody(mimeType: string | undefined, active: ActiveCapture, size = 0): CapturedBody {
  active.truncatedBodyCount += 1
  return { size, mimeType: mimeType ?? "application/octet-stream", truncated: true }
}

export function protectEntry(entry: CapturedEntry, redactor: SecretRedactor): CapturedEntry {
  const requestHeaders = redactor.protectHeaders(entry.request.headers)
  const responseHeaders = entry.response ? redactor.protectHeaders(entry.response.headers) : undefined
  const requestBody = protectCapturedBody(entry.request.body, redactor)
  const responseBody = protectCapturedBody(entry.response?.body, redactor)
  return {
    ...entry,
    request: {
      ...entry.request,
      url: redactor.protectUrl(entry.request.url),
      headers: requestHeaders,
      ...(requestBody ? { body: requestBody } : {}),
      ...(entry.request.redirectedFrom ? { redirectedFrom: redactor.protectUrl(entry.request.redirectedFrom) } : {}),
    },
    ...(entry.response ? {
      response: {
        ...entry.response,
        headers: responseHeaders ?? [],
        ...(responseBody ? { body: responseBody } : {}),
      },
    } : {}),
  }
}

function protectCapturedBody(
  body: CapturedBody | undefined,
  redactor: SecretRedactor,
): CapturedBody | undefined {
  if (!body) return undefined
  if (!body.text) {
    return { size: body.size, mimeType: body.mimeType, truncated: true }
  }
  const text = redactor.protectBody(body.text, body.mimeType)
  return text === undefined
    ? { size: body.size, mimeType: body.mimeType, truncated: true }
    : { ...body, text }
}

// Inside JSON string values (a "next" link carrying an access token, an echoed path token) only longer known values
// are replaced: ordinary text rarely contains 16 characters of a credential.
const minimumKnownBodySubstringLength = 16

function redactEntryKnownValues(entry: CapturedEntry, redactor: SecretRedactor): CapturedEntry {
  const redactText = (text: string) => redactor.redactKnownSubstrings(text, minimumKnownSubstringLength)
  const redactHeaders = (headers: readonly Header[]) => headers.map((item) => ({ ...item, value: redactText(item.value) }))
  return {
    ...entry,
    request: {
      ...entry.request,
      url: redactText(entry.request.url),
      headers: redactHeaders(entry.request.headers),
      ...(entry.request.redirectedFrom ? { redirectedFrom: redactText(entry.request.redirectedFrom) } : {}),
      ...(entry.request.body?.text ? { body: redactStructuredBody(entry.request.body, redactor) } : {}),
    },
    ...(entry.response ? {
      response: {
        ...entry.response,
        headers: redactHeaders(entry.response.headers),
        ...(entry.response.body?.text ? { body: redactStructuredBody(entry.response.body, redactor) } : {}),
      },
    } : {}),
  }
}

function redactStructuredBody(body: CapturedBody, redactor: SecretRedactor): CapturedBody {
  if (!body.text || !body.mimeType.toLowerCase().includes("json")) return body
  try {
    return { ...body, text: JSON.stringify(redactKnownScalars(JSON.parse(body.text), redactor)) }
  } catch {
    return { size: body.size, mimeType: body.mimeType, truncated: true }
  }
}

function redactKnownScalars(value: unknown, redactor: SecretRedactor): unknown {
  if (Array.isArray(value)) return value.map((item) => redactKnownScalars(item, redactor))
  if (Predicate.isObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactKnownScalars(item, redactor)]))
  }
  if (Predicate.isString(value)) return redactor.redactKnownSubstrings(value, minimumKnownBodySubstringLength)
  return redactor.redactValue(value)
}

function toHarEntry(entry: CapturedEntry): Record<string, unknown> {
  return {
    startedDateTime: entry.startedDateTime,
    time: entry.durationMs,
    request: {
      method: entry.request.method,
      url: entry.request.url,
      httpVersion: "",
      cookies: [],
      headers: entry.request.headers,
      queryString: queryString(entry.request.url),
      headersSize: -1,
      bodySize: entry.request.body?.size ?? 0,
      ...(entry.request.body?.text ? {
        postData: { mimeType: entry.request.body.mimeType, text: entry.request.body.text },
      } : {}),
    },
    response: entry.response ? {
      status: entry.response.status,
      statusText: entry.response.statusText,
      httpVersion: "",
      cookies: [],
      headers: entry.response.headers,
      content: {
        size: entry.response.body?.size ?? 0,
        mimeType: entry.response.body?.mimeType ?? contentType(entry.response.headers) ?? "application/octet-stream",
        ...(entry.response.body?.text ? { text: entry.response.body.text } : {}),
      },
      redirectURL: header(entry.response.headers, "location") ?? "",
      headersSize: -1,
      bodySize: entry.response.body?.size ?? 0,
    } : { status: 0, statusText: entry.failure ?? "No response", httpVersion: "", cookies: [], headers: [], content: { size: 0, mimeType: "application/octet-stream" }, redirectURL: "", headersSize: -1, bodySize: 0 },
    cache: {},
    timings: { send: 0, wait: entry.durationMs, receive: 0 },
    _opencodeBrowser: {
      id: entry.id,
      resourceType: entry.request.resourceType,
      ...(entry.request.redirectedFrom ? { redirectedFrom: entry.request.redirectedFrom } : {}),
      ...(entry.failure ? { failure: entry.failure } : {}),
      requestBodyTruncated: entry.request.body?.truncated ?? false,
      responseBodyTruncated: entry.response?.body?.truncated ?? false,
    },
  }
}

function writeArtifact(outputPath: string, value: unknown): Effect.Effect<void, NetworkCaptureError> {
  return Effect.tryPromise({
    try: () => writeJsonFileAtomically(path.resolve(outputPath), value),
    catch: (cause) => new NetworkCaptureError({ message: `Could not write network capture: ${outputPath}`, operation: "write", reason: "persistence-failed", cause }),
  })
}

export async function safeHeaders(read: () => Promise<Header[]>): Promise<Header[]> {
  return read().catch(() => [])
}

export async function bodyWithTimeout(response: Response, timeoutMs: number): Promise<Buffer | null> {
  let timeout: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      response.body().catch(() => null),
      new Promise<null>((resolve) => {
        timeout = setTimeout(() => resolve(null), timeoutMs)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

export async function settleFinalizers(active: ActiveCapture, timeoutMs: number): Promise<boolean> {
  if (active.pending.size === 0 && active.finalizeQueue.length === 0 && active.finalizeWorkers === 0) return true
  let timeout: NodeJS.Timeout | undefined
  let waiter: (() => void) | undefined
  try {
    return await Promise.race([
      new Promise<true>((resolve) => {
        waiter = () => resolve(true)
        active.finalizeWaiters.add(waiter)
      }),
      new Promise<false>((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
    if (waiter) active.finalizeWaiters.delete(waiter)
  }
}

export function notifyFinalizersSettled(active: ActiveCapture): void {
  if (active.pending.size > 0 || active.finalizeQueue.length > 0 || active.finalizeWorkers > 0) return
  for (const resolve of active.finalizeWaiters) resolve()
  active.finalizeWaiters.clear()
}

export function safeValue<A>(read: () => A, fallback: A): A {
  try {
    return read()
  } catch {
    return fallback
  }
}

export function contentType(headers: readonly Header[]): string | undefined {
  return header(headers, "content-type")?.trim()
}

function header(headers: readonly Header[], name: string): string | undefined {
  return headers.find((candidate) => candidate.name.toLowerCase() === name)?.value
}

function queryString(rawUrl: string): Array<{ name: string; value: string }> {
  try {
    return Array.from(new URL(rawUrl).searchParams, ([name, value]) => ({ name, value }))
  } catch {
    return []
  }
}

function isTextualMimeType(mimeType: string | undefined): boolean {
  return !mimeType || mimeType.startsWith("text/") || /json|javascript|xml|x-www-form-urlencoded|multipart\/form-data|graphql/.test(mimeType)
}
