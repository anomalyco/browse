import path from "node:path"
import { Effect, Semaphore } from "effect"
import type { Page, Request, Response } from "patchright-core"
import type { ExecuteAftermath, ExecuteLogEntry } from "./relay/schema.ts"
import {
  bodyCanFit,
  bodyWithTimeout,
  captureBuffer,
  contentType,
  declaredBodySize,
  finishCapture,
  notifyFinalizersSettled,
  protectEntry,
  safeHeaders,
  safeValue,
  settleFinalizers,
  truncatedBody,
} from "./network-capture/har-redaction.ts"
import {
  defaultNetworkCaptureMaxDurationMs,
  formatDuration,
  matches,
  maxFinalizeWorkers,
  NetworkCaptureError,
  validateOptions,
  type ActiveCapture,
  type CapturedBody,
  type CapturedEntry,
  type NetworkCaptureOptions,
  type NetworkCaptureResult,
  type NetworkCaptureStatus,
  type NetworkCaptureStopOptions,
  type PendingEntry,
} from "./network-capture/types.ts"
import { SecretRedactor } from "./network-capture/redaction.ts"

export {
  defaultNetworkCaptureMaxDurationMs,
  NetworkCaptureError,
  type NetworkCaptureOptions,
  type NetworkCaptureResult,
  type NetworkCaptureStatus,
  type NetworkCaptureStopOptions,
} from "./network-capture/types.ts"

export class Recorder {
  private active: ActiveCapture | undefined
  private expiry: ReturnType<typeof setTimeout> | undefined
  /** Why the last capture ended without a stop, shown by status and by a stop that comes too late. */
  private ended: string | undefined
  private page: Page | undefined
  private pageEpoch = 0
  private readonly transition = Semaphore.makeUnsafe(1)

  constructor(private readonly recorderOptions: {
    readonly outputSettleTimeoutMs?: number
  } = {}) {}

  start(page: Page, options: NetworkCaptureOptions = {}): Effect.Effect<NetworkCaptureStatus, NetworkCaptureError> {
    const capture = this
    return this.transition.withPermit(Effect.try({
      try: () => {
        validateOptions(options)
        if (capture.active) {
          throw new NetworkCaptureError({ message: "Network capture is already active for this session", operation: "start", reason: "already-active" })
        }
        const maxDurationMs = options.maxDurationMs ?? defaultNetworkCaptureMaxDurationMs
        capture.ended = undefined
        capture.active = {
          startedAt: new Date().toISOString(),
          options: {
            ...options,
            content: options.content ?? "embed",
            maxBodyBytes: options.maxBodyBytes ?? 1_000_000,
            maxTotalBodyBytes: options.maxTotalBodyBytes ?? 25_000_000,
            maxEntries: options.maxEntries ?? 1_000,
          },
          pending: new Map(),
          entries: [],
          finalizeQueue: [],
          finalizeWaiters: new Set(),
          liveRedactor: new SecretRedactor(),
          finalizeWorkers: 0,
          finalizeGeneration: 0,
          capturedBodyBytes: 0,
          truncatedBodyCount: 0,
          droppedEntryCount: 0,
          stopping: false,
          cancelled: false,
          outputUnsafe: false,
        }
        capture.bindPage(page)
        const active = capture.active
        clearTimeout(capture.expiry)
        capture.expiry = setTimeout(() => {
          if (capture.active !== active) return
          Effect.runFork(capture.end(`it reached its maximum duration of ${formatDuration(maxDurationMs)} (maxDurationMs)`))
        }, maxDurationMs)
        capture.expiry.unref?.()
        active.endsAt = new Date(Date.now() + maxDurationMs).toISOString()
        return capture.status()
      },
      catch: (cause) => cause instanceof NetworkCaptureError
        ? cause
        : new NetworkCaptureError({ message: "Invalid network capture options", operation: "start", reason: "invalid-options", cause }),
    }))
  }

  status(): NetworkCaptureStatus {
    const active = this.active
    if (!active) {
      return {
        active: false,
        ...(this.ended ? { ended: this.ended } : {}),
        entryCount: 0,
        responseCount: 0,
        failureCount: 0,
        capturedBodyBytes: 0,
        truncatedBodyCount: 0,
        droppedEntryCount: 0,
      }
    }
    let responseCount = 0
    let failureCount = 0
    for (const entry of active.entries) {
      if (entry.response) responseCount += 1
      if (entry.failure) failureCount += 1
    }
    return {
      active: true,
      startedAt: active.startedAt,
      entryCount: active.entries.length + active.pending.size,
      responseCount,
      failureCount,
      capturedBodyBytes: active.capturedBodyBytes,
      truncatedBodyCount: active.truncatedBodyCount,
      droppedEntryCount: active.droppedEntryCount,
      ...(active.options.urlFilter ? { urlFilter: active.options.urlFilter } : {}),
      ...(active.options.resourceTypes ? { resourceTypes: [...active.options.resourceTypes] } : {}),
      content: active.options.content,
      ...(active.endsAt ? { endsAt: active.endsAt } : {}),
    }
  }

  /** Ends the capture without a result (its data is discarded), saying why on the next status or stop. */
  end(reason: string): Effect.Effect<{ readonly cancelled: boolean }> {
    return this.cancel().pipe(Effect.tap(({ cancelled }) => Effect.sync(() => {
      if (cancelled) this.ended = reason
    })))
  }

  stop(options: NetworkCaptureStopOptions = {}): Effect.Effect<NetworkCaptureResult, NetworkCaptureError> {
    const capture = this
    return this.transition.withPermit(Effect.gen(function* () {
      const active = capture.active
      if (!active) {
        return yield* new NetworkCaptureError({
          message: capture.ended
            ? `Network capture is not active for this session: it ended because ${capture.ended}, and what it captured was discarded. Start a new one.`
            : "Network capture is not active for this session",
          operation: "stop",
          reason: "inactive",
        })
      }
      const boundPage = capture.page
      active.stopping = true
      capture.unbindPage()
      const operation = Effect.gen(function* () {
        for (const pending of [...active.pending.values()]) {
          if (!pending.finalized) {
            pending.failure ??= "Capture stopped before request completed"
            delete pending.response
          }
          capture.scheduleFinalize(pending)
        }
        const settled = yield* Effect.promise(() => settleFinalizers(active, 5_000))
        if (!settled) {
          active.droppedEntryCount += active.pending.size
          capture.discardFinalizers(active)
        }

        const finished = yield* finishCapture(active, options)
        const { endsAt: _endsAt, ...finalStatus } = capture.status()
        capture.active = undefined
        clearTimeout(capture.expiry)
        return {
          ...finalStatus,
          truncatedBodyCount: finalStatus.truncatedBodyCount + finished.redactionOmissionCount,
          active: false as const,
          stoppedAt: new Date().toISOString(),
          ...(options.outputPath ? { outputPath: path.resolve(options.outputPath) } : {}),
          ...(finished.endpoints.length > 0 ? { endpoints: finished.endpoints } : {}),
        }
      }).pipe(
        Effect.tapError(() => Effect.sync(() => {
          active.stopping = false
          if (capture.active === active) capture.bindPage(boundPage)
        })),
      )
      return yield* operation
    })).pipe(Effect.uninterruptible)
  }

  cancel(): Effect.Effect<{ readonly cancelled: boolean }> {
    const capture = this
    return this.transition.withPermit(Effect.gen(function* () {
      const active = capture.active
      if (!active) return { cancelled: false }
      active.stopping = true
      active.cancelled = true
      capture.unbindPage()
      capture.discardFinalizers(active)
      yield* Effect.promise(() => settleFinalizers(active, 5_000))
      if (capture.active === active) {
        capture.active = undefined
        clearTimeout(capture.expiry)
      }
      capture.ended = undefined
      return { cancelled: true }
    })).pipe(Effect.uninterruptible)
  }

  bindPage(page: Page | undefined): void {
    const active = this.active
    if (!active || active.stopping || this.page === page) return
    if (this.page) {
      for (const pending of active.pending.values()) {
        if (pending.epoch !== this.pageEpoch || pending.finalized) continue
        pending.failure ??= "Page changed before request completed"
        delete pending.response
        this.scheduleFinalize(pending)
      }
    }
    this.unbindPage()
    if (!page || page.isClosed()) return
    this.page = page
    this.pageEpoch += 1
    page.on("request", this.onRequest)
    page.on("response", this.onResponse)
    page.on("requestfinished", this.onRequestFinished)
    page.on("requestfailed", this.onRequestFailed)
  }

  async settleForOutput(): Promise<void> {
    const active = this.active
    if (!active) return
    active.outputUnsafe = !await settleFinalizers(active, this.recorderOptions.outputSettleTimeoutMs ?? 5_000)
  }

  redactText(text: string): string {
    const active = this.active
    if (!active) return text
    return active.outputUnsafe ? "[REDACTED: network capture finalization pending]" : active.liveRedactor.redactText(text)
  }

  redactValue(value: unknown): unknown {
    const active = this.active
    if (!active) return value
    return active.outputUnsafe ? "[REDACTED: network capture finalization pending]" : active.liveRedactor.redactValue(value)
  }

  redactUrl(url: string): string {
    const active = this.active
    if (!active) return url
    if (active.outputUnsafe) return "[REDACTED: network capture finalization pending]"
    return active.liveRedactor.redactUrl(url)
  }

  redactCaptureLogs(logs: readonly ExecuteLogEntry[]): readonly ExecuteLogEntry[] {
    return logs.map((log) => ({
      ...log,
      text: this.redactText(log.text),
      ...(log.location ? {
        location: { ...log.location, url: this.redactUrl(log.location.url) },
      } : {}),
    }))
  }

  redactCaptureAftermath(aftermath: ExecuteAftermath): ExecuteAftermath {
    return {
      ...aftermath,
      startUrl: aftermath.startUrl ? this.redactUrl(aftermath.startUrl) : aftermath.startUrl,
      endUrl: aftermath.endUrl ? this.redactUrl(aftermath.endUrl) : aftermath.endUrl,
      navigations: aftermath.navigations.map((url) => this.redactUrl(url)),
      ...(aftermath.challenge ? { challenge: { ...aftermath.challenge, url: this.redactUrl(aftermath.challenge.url) } } : {}),
    }
  }

  private readonly onRequest = (request: Request): void => {
    const active = this.active
    if (!active || !matches(request, active.options)) return
    if (active.entries.length + active.pending.size >= active.options.maxEntries) {
      active.droppedEntryCount += 1
      return
    }
    active.pending.set(request, {
      id: `request-${active.entries.length + active.pending.size + 1}`,
      startedAt: Date.now(),
      startedDateTime: new Date().toISOString(),
      request,
      finalized: false,
      epoch: this.pageEpoch,
    })
  }

  private readonly onResponse = (response: Response): void => {
    const pending = this.active?.pending.get(response.request())
    if (pending) pending.response = response
  }

  private readonly onRequestFinished = (request: Request): void => {
    const pending = this.active?.pending.get(request)
    if (pending) this.scheduleFinalize(pending)
  }

  private readonly onRequestFailed = (request: Request): void => {
    const pending = this.active?.pending.get(request)
    if (!pending) return
    pending.failure = request.failure()?.errorText ?? "Request failed"
    this.scheduleFinalize(pending)
  }

  private scheduleFinalize(pending: PendingEntry): void {
    const active = this.active
    if (!active || pending.finalized) return
    pending.finalized = true
    active.finalizeQueue.push({ pending, generation: active.finalizeGeneration })
    this.pumpFinalizers(active)
  }

  private pumpFinalizers(active: ActiveCapture): void {
    if (active.cancelled) active.finalizeQueue.length = 0
    while (!active.cancelled && active.finalizeWorkers < maxFinalizeWorkers) {
      const work = active.finalizeQueue.shift()
      if (!work) break
      active.finalizeWorkers += 1
      void this.finalize(work.pending, active, work.generation).catch(() => {}).finally(() => {
        active.finalizeWorkers -= 1
        this.pumpFinalizers(active)
        notifyFinalizersSettled(active)
      })
    }
    notifyFinalizersSettled(active)
  }

  private discardFinalizers(active: ActiveCapture): void {
    active.finalizeGeneration += 1
    active.finalizeQueue.length = 0
    active.pending.clear()
    notifyFinalizersSettled(active)
  }

  private async finalize(pending: PendingEntry, active: ActiveCapture, generation: number): Promise<void> {
    const request = pending.request
    try {
      const requestHeaders = await safeHeaders(() => request.headersArray())
      const requestLimit = Math.min(active.options.maxBodyBytes, active.options.maxTotalBodyBytes - active.capturedBodyBytes)
      const requestSize = declaredBodySize(requestHeaders)
      const requestMayHaveBody = requestSize !== undefined
        ? requestSize > 0
        : contentType(requestHeaders) !== undefined && !/^(GET|HEAD)$/i.test(request.method())
      const requestBody = active.options.content === "embed" && requestMayHaveBody
        ? bodyCanFit(requestHeaders, requestLimit)
          ? captureBuffer(request.postDataBuffer(), contentType(requestHeaders), active)
          : truncatedBody(contentType(requestHeaders), active, requestSize ?? 0)
        : undefined
      const response = pending.response
      const responseHeaders = response ? await safeHeaders(() => response.headersArray()) : []
      const shouldCaptureResponseBody = response && active.options.content === "embed"
      const hasBodyBudget = active.capturedBodyBytes < active.options.maxTotalBodyBytes
      let responseBody: CapturedBody | undefined
      if (shouldCaptureResponseBody) {
        if (hasBodyBudget) {
          const responseBuffer = bodyCanFit(responseHeaders, Math.min(active.options.maxBodyBytes, active.options.maxTotalBodyBytes - active.capturedBodyBytes))
            ? await bodyWithTimeout(response, 1_000)
            : null
          responseBody = responseBuffer === null
            ? truncatedBody(contentType(responseHeaders), active, declaredBodySize(responseHeaders) ?? 0)
            : captureBuffer(responseBuffer, contentType(responseHeaders), active)
        } else {
          responseBody = truncatedBody(contentType(responseHeaders), active)
        }
      }
      const redirectedFrom = request.redirectedFrom()?.url()
      this.recordEntry(active, generation, {
        id: pending.id,
        startedDateTime: pending.startedDateTime,
        durationMs: Math.max(0, Date.now() - pending.startedAt),
        request: {
          method: request.method(),
          url: request.url(),
          headers: requestHeaders,
          resourceType: request.resourceType(),
          ...(requestBody ? { body: requestBody } : {}),
          ...(redirectedFrom ? { redirectedFrom } : {}),
        },
        ...(response ? {
          response: {
            status: response.status(),
            statusText: response.statusText(),
            headers: responseHeaders,
            ...(responseBody ? { body: responseBody } : {}),
          },
        } : {}),
        ...(pending.failure ? { failure: pending.failure } : {}),
      })
    } catch {
      this.recordEntry(active, generation, {
        id: pending.id,
        startedDateTime: pending.startedDateTime,
        durationMs: Math.max(0, Date.now() - pending.startedAt),
        request: {
          method: safeValue(() => request.method(), "UNKNOWN"),
          url: safeValue(() => request.url(), ""),
          headers: [],
          resourceType: safeValue(() => request.resourceType(), "unknown"),
        },
        failure: "Capture finalization failed",
      })
    } finally {
      active.pending.delete(request)
    }
  }

  private recordEntry(active: ActiveCapture, generation: number, entry: CapturedEntry): void {
    if (active.cancelled || generation !== active.finalizeGeneration) return
    active.entries.push(entry)
    void protectEntry(entry, active.liveRedactor)
  }

  private unbindPage(): void {
    const page = this.page
    this.page = undefined
    if (!page) return
    page.off("request", this.onRequest)
    page.off("response", this.onResponse)
    page.off("requestfinished", this.onRequestFinished)
    page.off("requestfailed", this.onRequestFailed)
  }
}
