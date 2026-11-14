import { Schema } from "effect"
import type { Request, Response } from "patchright-core"
import type { SecretRedactor } from "./redaction.ts"

/** What a capture lets the caller narrow. Limits and guards have fixed defaults. */
export type NetworkCaptureOptions = {
  readonly urlFilter?: string
}

/** The recorder's own start options: maxDurationMs is not exposed by the tools, and a test shortens a capture's life. */
export type NetworkCaptureStartOptions = NetworkCaptureOptions & {
  readonly maxDurationMs?: number
}

/** A forgotten capture used to keep `relay restart` and `update` refusing forever. */
export const defaultNetworkCaptureMaxDurationMs = 30 * 60_000
const maxAllowedDurationMs = 24 * 60 * 60_000

export type NetworkCaptureStatus = {
  readonly active: boolean
  readonly startedAt?: string
  readonly entryCount: number
  readonly responseCount: number
  readonly failureCount: number
  readonly capturedBodyBytes: number
  readonly truncatedBodyCount: number
  readonly droppedEntryCount: number
  readonly urlFilter?: string
  /** When the capture ends by itself: when, and the maximum duration it reached (or that its client went away). */
  readonly endsAt?: string
  readonly ended?: string
}

export type NetworkCaptureResult = NetworkCaptureStatus & {
  readonly active: false
  readonly stoppedAt: string
  /** Every captured exchange, with credential-bearing values replaced. */
  readonly exchanges: readonly CapturedEntry[]
}

export class NetworkCaptureError extends Schema.TaggedError<NetworkCaptureError>()(
  "NetworkCapture.Error",
  {
    message: Schema.String,
    operation: Schema.String,
    reason: Schema.Literals(["already-active", "inactive", "invalid-options"]),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

export type Header = { readonly name: string; readonly value: string }

export type CapturedBody = {
  readonly size: number
  readonly mimeType: string
  readonly text?: string
  readonly truncated: boolean
}

export type CapturedEntry = {
  readonly id: string
  readonly startedDateTime: string
  readonly durationMs: number
  readonly request: {
    readonly method: string
    readonly url: string
    readonly headers: readonly Header[]
    readonly resourceType: string
    readonly body?: CapturedBody
    readonly redirectedFrom?: string
  }
  readonly response?: {
    readonly status: number
    readonly statusText: string
    readonly headers: readonly Header[]
    readonly body?: CapturedBody
  }
  readonly failure?: string
}

export type PendingEntry = {
  readonly id: string
  readonly startedAt: number
  readonly startedDateTime: string
  readonly request: Request
  response?: Response
  failure?: string
  finalized: boolean
  epoch: number
}

export type FinalizeWork = {
  readonly pending: PendingEntry
  readonly generation: number
}

export type ActiveCapture = {
  readonly startedAt: string
  readonly options: {
    readonly urlFilter?: string
    readonly maxBodyBytes: number
    readonly maxTotalBodyBytes: number
    readonly maxEntries: number
  }
  readonly pending: Map<Request, PendingEntry>
  readonly entries: CapturedEntry[]
  readonly finalizeQueue: FinalizeWork[]
  readonly finalizeWaiters: Set<() => void>
  readonly liveRedactor: SecretRedactor
  finalizeWorkers: number
  finalizeGeneration: number
  capturedBodyBytes: number
  truncatedBodyCount: number
  droppedEntryCount: number
  stopping: boolean
  cancelled: boolean
  outputUnsafe: boolean
  endsAt?: string
}

export const defaultMaxBodyBytes = 1_000_000
export const defaultMaxTotalBodyBytes = 25_000_000
export const defaultMaxEntries = 1_000
export const maxFinalizeWorkers = 4

export function matches(request: Request, options: ActiveCapture["options"]): boolean {
  return !options.urlFilter || request.url().includes(options.urlFilter)
}

export function validateOptions(options: NetworkCaptureStartOptions): void {
  if (options.maxDurationMs !== undefined) {
    if (!Number.isInteger(options.maxDurationMs) || options.maxDurationMs <= 0 || options.maxDurationMs > maxAllowedDurationMs) {
      throw new NetworkCaptureError({ message: `maxDurationMs must be an integer from 1 to ${maxAllowedDurationMs}`, operation: "start", reason: "invalid-options" })
    }
  }
}

export function formatDuration(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000} hour${ms === 3_600_000 ? "" : "s"}`
  if (ms % 60_000 === 0) return `${ms / 60_000} minute${ms === 60_000 ? "" : "s"}`
  return `${Math.round(ms / 1000)} s`
}
