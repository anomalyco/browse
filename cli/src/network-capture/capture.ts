import { Predicate } from "effect"
import type { Response } from "patchright-core"
import { minimumKnownSubstringLength, SecretRedactor } from "./redaction.ts"
import {
  type ActiveCapture,
  type CapturedBody,
  type CapturedEntry,
  type Header,
} from "./types.ts"

/** Every captured exchange, redacted, for a stop result: the redactor also covers values learned from later entries. */
export function finishCapture(active: ActiveCapture): {
  readonly redactionOmissionCount: number
  readonly exchanges: readonly CapturedEntry[]
} {
  const redactor = new SecretRedactor()
  const exchanges = active.entries
    .map((entry) => protectEntry(entry, redactor))
    .map((entry) => redactEntryKnownValues(entry, redactor))
  return {
    redactionOmissionCount: countRedactionOmissions(active.entries, exchanges),
    exchanges,
  }
}

export function countRedactionOmissions(original: readonly CapturedEntry[], redacted: readonly CapturedEntry[]): number {
  let count = 0
  for (let index = 0; index < original.length; index += 1) {
    const before = original[index]
    const after = redacted[index]
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

function isTextualMimeType(mimeType: string | undefined): boolean {
  return !mimeType || mimeType.startsWith("text/") || /json|javascript|xml|x-www-form-urlencoded|multipart\/form-data|graphql/.test(mimeType)
}
