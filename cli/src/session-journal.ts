import { dataRoot } from "./paths.ts"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Option, Schema } from "effect"
import { isNodeError } from "./fs-durability.ts"
import { isValidSessionId } from "./relay-helpers.ts"

/**
 * Session journal: an auditable per-session record of what agents did to the
 * user's browser. The relay appends one JSON line per execute call to
 * `<data root>/sessions/<id>/journal.jsonl` (see paths.ts); the CLI `journal` command
 * reads the file locally and renders a human-readable timeline.
 *
 * Journals hold agent code, which often types credentials, so directories are
 * 0700, files 0600, credential-looking literals are redacted before they are
 * written, and journals of ended sessions are pruned after a retention period.
 */

export const JournalEntry = Schema.Struct({
  ts: Schema.String,
  sessionId: Schema.String,
  code: Schema.String,
  isError: Schema.Boolean,
  durationMs: Schema.Number,
  resultPreview: Schema.String,
  logCount: Schema.Number,
  startUrl: Schema.optionalKey(Schema.NullOr(Schema.String)),
  endUrl: Schema.optionalKey(Schema.NullOr(Schema.String)),
  navigations: Schema.optionalKey(Schema.Array(Schema.String)),
  warnings: Schema.optionalKey(Schema.Array(Schema.String)),
  diagnostic: Schema.optionalKey(Schema.String),
  handoffs: Schema.optionalKey(Schema.Number),
})

export interface JournalEntry extends Schema.Schema.Type<typeof JournalEntry> {}

const decodeJournalEntry = Schema.decodeUnknownOption(JournalEntry)

export const defaultJournalBaseDir = (): string => {
  return path.join(dataRoot(), "sessions")
}

export function journalPathForSession(baseDir: string, sessionId: string): string {
  return path.join(baseDir, sessionId, "journal.jsonl")
}

const maxJournalCodeLength = 2_000
const maxJournalPreviewLength = 400
const maxJournalDiagnosticLength = 240

export function truncateForJournal(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text
  }
  return `${text.slice(0, maxLength)}… [truncated ${text.length - maxLength} chars]`
}

const redacted = "[REDACTED]"
const sensitiveWord = String.raw`(?:pass(?:word|wd|code|phrase)?|pwd|otp|one[-_ ]?time|2fa|mfa|totp|pin|code|token|secret|api[-_]?key|access[-_]?key|private[-_]?key|auth(?:orization)?|credential|session|cookie|bearer|cvv|cvc|card[-_ ]?number)`
const stringLiteral = String.raw`(?:"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|\`(?:[^\`\\]|\\.)*\`)`
// `password: "x"`, `token = 'x'`, `"otp": "x"`
const sensitiveAssignment = new RegExp(String.raw`(["'\`]?[\w$-]*${sensitiveWord}[\w$-]*["'\`]?\s*[:=]\s*)${stringLiteral}`, "gi")
// `getByLabel("Password").fill("x")`, `fill("#otp", "x")`, `fillInput(ref("e3"), "x")` on a line mentioning a credential.
const valueCall = new RegExp(String.raw`(\.(?:fill|type|pressSequentially|setInputValue)\s*\((?:\s*${stringLiteral}\s*,)?\s*|\bfillInput\s*\([^;\n]*?,\s*)${stringLiteral}`, "gi")
const sensitiveLine = new RegExp(sensitiveWord, "i")
// `{ target: "Password", value: "x" }` on a line mentioning a credential.
const valueProperty = new RegExp(String.raw`(\bvalue\s*:\s*)${stringLiteral}`, "gi")
const sensitiveQuery = new RegExp(String.raw`([?&#][\w.-]*${sensitiveWord}[\w.-]*=)[^&#\s"'\`]+`, "gi")
const tokenPatterns = [
  /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, // JWT
  /\b(?:Bearer|Basic)\s+[\w~+/.=-]{12,}/gi,
  /\b(?:sk|pk|rk|ghp|gho|ghs|ghu|github_pat|xox[abprs]|glpat|AKIA|ASIA)[-_][\w-]{12,}/g, // well-known key prefixes
]

/** Redact credential-looking values from journal text: assignments, typed values, query strings, tokens. */
export function redactJournalText(text: string): string {
  let output = text.replace(sensitiveAssignment, `$1"${redacted}"`)
  output = output.split("\n").map((line) => {
    if (!sensitiveLine.test(line)) return line
    return line.replace(valueCall, `$1"${redacted}"`).replace(valueProperty, `$1"${redacted}"`)
  }).join("\n")
  output = output.replace(sensitiveQuery, `$1${redacted}`)
  for (const pattern of tokenPatterns) output = output.replace(pattern, redacted)
  return output
}

export function makeJournalEntry(options: {
  readonly sessionId: string
  readonly code: string
  readonly isError: boolean
  readonly durationMs: number
  readonly resultText: string
  readonly logCount: number
  readonly startUrl?: string | null | undefined
  readonly endUrl?: string | null | undefined
  readonly navigations?: readonly string[] | undefined
  readonly warnings?: readonly string[] | undefined
  readonly diagnostic?: string | undefined
  readonly handoffs?: number | undefined
}): JournalEntry {
  return {
    ts: new Date().toISOString(),
    sessionId: options.sessionId,
    code: truncateForJournal(redactJournalText(options.code), maxJournalCodeLength),
    isError: options.isError,
    durationMs: options.durationMs,
    resultPreview: truncateForJournal(redactJournalText(options.resultText), maxJournalPreviewLength),
    logCount: options.logCount,
    ...(options.startUrl === undefined ? {} : { startUrl: redactNullableUrl(options.startUrl) }),
    ...(options.endUrl === undefined ? {} : { endUrl: redactNullableUrl(options.endUrl) }),
    ...(options.navigations && options.navigations.length > 0 ? { navigations: options.navigations.map(redactJournalText) } : {}),
    ...(options.warnings && options.warnings.length > 0 ? { warnings: options.warnings.map(redactJournalText) } : {}),
    ...(options.diagnostic ? { diagnostic: truncateForJournal(redactJournalText(options.diagnostic), maxJournalDiagnosticLength) } : {}),
    ...(options.handoffs ? { handoffs: options.handoffs } : {}),
  }
}

function redactNullableUrl(url: string | null): string | null {
  return url === null ? null : redactJournalText(url)
}

/**
 * Append a journal entry, creating the session directory if needed. Journal
 * writes are best-effort: failures are reported to the callback (or ignored)
 * and never fail the execute call they describe.
 */
export async function appendJournalEntry(options: {
  readonly baseDir: string
  readonly entry: JournalEntry
}): Promise<void> {
  const filePath = journalPathForSession(options.baseDir, options.entry.sessionId)
  await fs.promises.mkdir(options.baseDir, { recursive: true, mode: 0o700 })
  await fs.promises.chmod(options.baseDir, 0o700)
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 })
  await fs.promises.chmod(path.dirname(filePath), 0o700)
  await fs.promises.appendFile(filePath, `${JSON.stringify(options.entry)}\n`, { encoding: "utf8", mode: 0o600 })
  await fs.promises.chmod(filePath, 0o600)
}

export const defaultJournalRetentionMs = 14 * 24 * 60 * 60 * 1_000
export const defaultJournalMaxCount = 200

/**
 * Delete journals of sessions that are not live: those untouched for longer
 * than `maxAgeMs`, then the oldest beyond `maxCount`. Also tightens the
 * permissions of journals that remain (earlier versions wrote them 0755/0644).
 * Returns the removed session ids.
 */
export async function pruneSessionJournals(options: {
  readonly baseDir: string
  readonly isLive: (sessionId: string) => boolean
  readonly maxAgeMs?: number
  readonly maxCount?: number
  readonly now?: number
}): Promise<string[]> {
  const maxAgeMs = options.maxAgeMs ?? defaultJournalRetentionMs
  const maxCount = options.maxCount ?? defaultJournalMaxCount
  const now = options.now ?? Date.now()
  let names: string[]
  try {
    names = await fs.promises.readdir(options.baseDir)
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return []
    throw error
  }
  await fs.promises.chmod(options.baseDir, 0o700)
  const candidates: { readonly id: string; readonly directory: string; readonly modifiedAt: number }[] = []
  for (const id of names) {
    if (!isValidSessionId(id)) continue
    const directory = path.join(options.baseDir, id)
    const stat = await fs.promises.lstat(directory).catch(() => undefined)
    if (!stat?.isDirectory()) continue
    const journal = await fs.promises.lstat(path.join(directory, "journal.jsonl")).catch(() => undefined)
    candidates.push({ id, directory, modifiedAt: Math.max(stat.mtimeMs, journal?.mtimeMs ?? 0) })
  }
  const removed: string[] = []
  const kept: typeof candidates = []
  for (const candidate of candidates) {
    if (!options.isLive(candidate.id) && now - candidate.modifiedAt > maxAgeMs) removed.push(candidate.id)
    else kept.push(candidate)
  }
  const removable = kept.filter((candidate) => !options.isLive(candidate.id)).sort((left, right) => left.modifiedAt - right.modifiedAt)
  const excess = Math.max(0, kept.length - maxCount)
  const evicted = new Set(removable.slice(0, excess).map((candidate) => candidate.id))
  removed.push(...evicted)
  const removedSet = new Set(removed)
  for (const candidate of candidates) {
    if (removedSet.has(candidate.id)) {
      // Re-check right before deleting: a session may have started since the scan.
      if (options.isLive(candidate.id)) {
        removedSet.delete(candidate.id)
        continue
      }
      await fs.promises.rm(candidate.directory, { recursive: true, force: true })
    } else {
      await fs.promises.chmod(candidate.directory, 0o700).catch(() => {})
      await fs.promises.chmod(path.join(candidate.directory, "journal.jsonl"), 0o600).catch(() => {})
    }
  }
  return removed.filter((id) => removedSet.has(id))
}

const journalPruneIntervalMs = 6 * 60 * 60 * 1_000

/** Prune journals now and every few hours; returns a function that stops the schedule. */
export function startJournalRetention(options: {
  readonly baseDir: string
  readonly isLive: (sessionId: string) => boolean
  readonly onError?: (error: unknown) => void
}): () => void {
  const prune = () => {
    void pruneSessionJournals(options).catch((error: unknown) => options.onError?.(error))
  }
  prune()
  const interval = setInterval(prune, journalPruneIntervalMs)
  interval.unref()
  return () => clearInterval(interval)
}

/** Read the last `limit` journal entries for a session; skips corrupt lines. */
export async function readJournalEntries(options: {
  readonly baseDir: string
  readonly sessionId: string
  readonly limit: number
}): Promise<JournalEntry[]> {
  const filePath = journalPathForSession(options.baseDir, options.sessionId)
  let raw: string
  try {
    raw = await fs.promises.readFile(filePath, "utf8")
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return []
    }
    throw error
  }
  return parseJournalLines(raw).slice(-options.limit)
}

export function parseJournalLines(raw: string): JournalEntry[] {
  const entries: JournalEntry[] = []
  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) {
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      continue
    }
    const decoded = decodeJournalEntry(parsed)
    if (Option.isSome(decoded)) {
      entries.push(decoded.value)
    }
  }
  return entries
}

export function formatJournalEntry(entry: JournalEntry): string {
  const time = entry.ts.slice(11, 19) || entry.ts
  const status = entry.isError ? "ERR" : "ok "
  const codePreview = entry.code.replace(/\s+/g, " ").trim().slice(0, 80)
  const urlPart = entry.endUrl ? ` ${entry.endUrl}` : ""
  const navPart = entry.navigations && entry.navigations.length > 0 ? ` nav=${entry.navigations.length}` : ""
  const handoffPart = entry.handoffs ? ` handoffs=${entry.handoffs}` : ""
  const warningPart = entry.warnings && entry.warnings.length > 0 ? ` warnings=${entry.warnings.length}` : ""
  const diagnosticPart = entry.diagnostic ? ` diagnostic=${entry.diagnostic}` : ""
  return `${time} ${status} ${String(entry.durationMs).padStart(5)}ms${urlPart}${navPart}${handoffPart}${warningPart}${diagnosticPart}  ${codePreview}`
}
