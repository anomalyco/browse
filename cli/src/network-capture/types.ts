import { Schema } from "effect"
import type { Request, Response } from "patchright-core"
import type { SecretRedactor } from "./redaction.ts"

export type NetworkCaptureOptions = {
  readonly urlFilter?: string
  readonly resourceTypes?: readonly string[]
  readonly content?: "omit" | "embed"
  readonly maxBodyBytes?: number
  readonly maxTotalBodyBytes?: number
  readonly maxEntries?: number
  /** The capture ends by itself (its data discarded) after this long; it holds the relay busy for restarts meanwhile. */
  readonly maxDurationMs?: number
}

/** A forgotten capture used to keep `relay restart` and `update` refusing forever. */
export const defaultNetworkCaptureMaxDurationMs = 30 * 60_000
const maxAllowedDurationMs = 24 * 60 * 60_000

export type NetworkCaptureStopOptions = {
  readonly outputPath?: string
}

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
  readonly resourceTypes?: readonly string[]
  readonly content?: "omit" | "embed"
  /** When the capture ends by itself: when, and the maximum duration it reached (or that its client went away). */
  readonly endsAt?: string
  readonly ended?: string
}

export type NetworkEndpointDigest = {
  readonly method: string
  readonly url: string
  readonly status?: number
  readonly count: number
  readonly requestHeaders?: readonly string[]
  readonly requestKeys?: readonly string[]
  readonly responseKeys?: readonly string[]
}

export type NetworkCaptureResult = NetworkCaptureStatus & {
  readonly active: false
  readonly stoppedAt: string
  readonly outputPath?: string
  readonly endpoints?: readonly NetworkEndpointDigest[]
}

export class NetworkCaptureError extends Schema.TaggedError<NetworkCaptureError>()(
  "NetworkCapture.Error",
  {
    message: Schema.String,
    operation: Schema.String,
    reason: Schema.Literals(["already-active", "inactive", "invalid-options", "finalize-failed", "persistence-failed"]),
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
  readonly options: Required<Pick<NetworkCaptureOptions, "content" | "maxBodyBytes" | "maxTotalBodyBytes" | "maxEntries">> & NetworkCaptureOptions
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

const maxAllowedBodyBytes = 10_000_000
const maxAllowedTotalBodyBytes = 100_000_000
const maxAllowedEntries = 10_000
const maxAllowedResourceTypes = 50
export const maxFinalizeWorkers = 4

export function matches(request: Request, options: ActiveCapture["options"]): boolean {
  if (options.urlFilter && !request.url().includes(options.urlFilter)) return false
  return !options.resourceTypes || options.resourceTypes.includes(request.resourceType())
}

export function validateOptions(options: NetworkCaptureOptions): void {
  if (options.content !== undefined && options.content !== "embed" && options.content !== "omit") {
    throw new NetworkCaptureError({ message: "Network content must be embed or omit", operation: "start", reason: "invalid-options" })
  }
  validateLimit("maxBodyBytes", options.maxBodyBytes, maxAllowedBodyBytes)
  validateLimit("maxTotalBodyBytes", options.maxTotalBodyBytes, maxAllowedTotalBodyBytes)
  validateLimit("maxEntries", options.maxEntries, maxAllowedEntries)
  validateLimit("maxDurationMs", options.maxDurationMs, maxAllowedDurationMs)
  if (options.resourceTypes && options.resourceTypes.length > maxAllowedResourceTypes) {
    throw new NetworkCaptureError({ message: `resourceTypes cannot contain more than ${maxAllowedResourceTypes} values`, operation: "start", reason: "invalid-options" })
  }
}

export function formatDuration(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000} hour${ms === 3_600_000 ? "" : "s"}`
  if (ms % 60_000 === 0) return `${ms / 60_000} minute${ms === 60_000 ? "" : "s"}`
  return `${Math.round(ms / 1000)} s`
}

function validateLimit(name: string, value: number | undefined, maximum: number): void {
  if (value === undefined) return
  if (!Number.isInteger(value) || value <= 0 || value > maximum) {
    throw new NetworkCaptureError({ message: `${name} must be an integer from 1 to ${maximum}`, operation: "start", reason: "invalid-options" })
  }
}
