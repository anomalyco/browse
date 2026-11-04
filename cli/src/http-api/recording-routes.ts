import http from "node:http"
import { Effect, Predicate } from "effect"
import type { FlightRecorderRelay } from "../flight-recorder.ts"
import { AmbiguousRecordingTargetError, type RecordingRelay, type RecordingStartOptions, type RecordingTargetOptions } from "../recording-relay.ts"
import { HttpRouteError, readJsonBody, sendJson } from "../relay-helpers.ts"
import {
  FlightRecorderSaveRequest,
  FlightRecorderStartRequest,
  RecordingStartRequest,
  RecordingTargetRequest,
} from "../relay-schema.ts"
import type { TargetRegistry } from "../target-registry.ts"
import { decodeRequest, optionalInteger } from "./errors.ts"

/**
 * A recording request that failed because there was nothing to act on (no recording) is the caller's mistake, not
 * the relay's: 404, like an unavailable extension is 503. Only real failures are 500.
 */
function recordingStatusCode(result: { readonly success: boolean; readonly error?: string }): number {
  if (result.success) return 200
  if (/^No active recording/i.test(result.error ?? "")) return 404
  if (/extension is not connected/i.test(result.error ?? "")) return 503
  return 500
}

export function handleRecordingRequest(options: {
  readonly request: http.IncomingMessage
  readonly response: http.ServerResponse
  readonly pathname: string
  readonly requestUrl: URL
  readonly registry: TargetRegistry
  readonly recordingRelay: RecordingRelay
}): Effect.Effect<void, Error> {
  return Effect.gen(function* () {
    if (options.pathname === "/recording/start" && options.request.method === "POST") {
      const body = yield* readJsonBody(options.request)
      const { tabId, sessionId, ...recordingOptions } = yield* decodeRequest(RecordingStartRequest, body, "recording start")
      const target = resolveAttachedRecordingTarget({ registry: options.registry, tabId, sessionId })
      const startOptions: RecordingStartOptions = {
        ...recordingOptions,
        tabId: target.tabId,
        ...(target.sessionId ? { sessionId: target.sessionId } : {}),
        owner: target.owner,
      }
      const result = yield* tryRecordingPromise("start recording", () => options.recordingRelay.startRecording(startOptions))
      sendJson(options.response, result, result.success ? 200 : 500)
      return
    }
    if (options.pathname === "/recording/stop" && options.request.method === "POST") {
      const body = yield* readJsonBody(options.request)
      const request = yield* decodeRequest(RecordingTargetRequest, body, "recording stop")
      const target = recordingTargetFromValues({ registry: options.registry, tabId: request.tabId, sessionId: request.sessionId })
      const result = yield* tryRecordingPromise("stop recording", () => options.recordingRelay.stopRecording(target))
      sendJson(options.response, result, recordingStatusCode(result))
      return
    }
    if (options.pathname === "/recording/status" && options.request.method === "GET") {
      const target = recordingTargetFromQuery({ registry: options.registry, searchParams: options.requestUrl.searchParams })
      const result = yield* readRecordingStatus(options.registry, () => options.recordingRelay.statusRecording(target))
      sendJson(options.response, result)
      return
    }
    if (options.pathname === "/recording/cancel" && options.request.method === "POST") {
      const body = yield* readJsonBody(options.request)
      const request = yield* decodeRequest(RecordingTargetRequest, body, "recording cancel")
      const target = recordingTargetFromValues({ registry: options.registry, tabId: request.tabId, sessionId: request.sessionId })
      const result = yield* tryRecordingPromise("cancel recording", () => options.recordingRelay.cancelRecording(target))
      sendJson(options.response, result, recordingStatusCode(result))
      return
    }
    options.response.writeHead(404)
    options.response.end("Not found")
  })
}

export function handleFlightRecorderRequest(options: {
  readonly request: http.IncomingMessage
  readonly response: http.ServerResponse
  readonly pathname: string
  readonly requestUrl: URL
  readonly registry: TargetRegistry
  readonly flightRecorder: FlightRecorderRelay
}): Effect.Effect<void, Error> {
  return Effect.gen(function* () {
    if (options.pathname === "/flight-recorder/start" && options.request.method === "POST") {
      const request = yield* decodeRequest(FlightRecorderStartRequest, yield* readJsonBody(options.request), "flight recorder start")
      const target = resolveAttachedRecordingTarget({ registry: options.registry, tabId: request.tabId, sessionId: request.sessionId })
      const result = yield* tryRecordingPromise("start flight recorder", () => options.flightRecorder.start({
        tabId: target.tabId,
        ...(target.sessionId ? { sessionId: target.sessionId } : {}),
        ...(request.retentionMs === undefined ? {} : { retentionMs: request.retentionMs }),
        ...(request.frameRate === undefined ? {} : { frameRate: request.frameRate }),
        ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
      }))
      sendJson(options.response, result)
      return
    }
    if (options.pathname === "/flight-recorder/status" && options.request.method === "GET") {
      const target = recordingTargetFromQuery({ registry: options.registry, searchParams: options.requestUrl.searchParams })
      sendJson(options.response, yield* readRecordingStatus(options.registry, () => options.flightRecorder.status(target)))
      return
    }
    if (options.pathname === "/flight-recorder/save-last" && options.request.method === "POST") {
      const request = yield* decodeRequest(FlightRecorderSaveRequest, yield* readJsonBody(options.request), "flight recorder save-last")
      const target = recordingTargetFromValues({ registry: options.registry, tabId: request.tabId, sessionId: request.sessionId })
      const result = yield* tryRecordingPromise("save flight recorder", () => options.flightRecorder.saveLast({
        ...target,
        outputPath: request.outputPath,
        ...(request.durationMs === undefined ? {} : { durationMs: request.durationMs }),
      }))
      sendJson(options.response, result)
      return
    }
    if (options.pathname === "/flight-recorder/cancel" && options.request.method === "POST") {
      const request = yield* decodeRequest(RecordingTargetRequest, yield* readJsonBody(options.request), "flight recorder cancel")
      const target = recordingTargetFromValues({ registry: options.registry, tabId: request.tabId, sessionId: request.sessionId })
      sendJson(options.response, yield* Effect.promise(() => options.flightRecorder.cancel(target)))
      return
    }
    options.response.writeHead(404)
    options.response.end("Not found")
  })
}

function readRecordingStatus<A>(registry: TargetRegistry, read: () => A | Promise<A>): Effect.Effect<A, Error> {
  return Effect.tryPromise({
    try: async () => await read(),
    catch: (cause) => {
      if (!(cause instanceof AmbiguousRecordingTargetError)) return cause instanceof Error ? cause : new Error(String(cause))
      const choices = cause.tabIds.map((tabId) => {
        const target = registry.getRootTargetByTabId(tabId)
        const sessionId = target?.opencodeBrowserSessionId ?? target?.sessionId
        return sessionId ? `sessionId=${sessionId} (tabId=${tabId})` : `tabId=${tabId}`
      })
      return new HttpRouteError({ status: 409, code: "target-ambiguous", message: `${cause.message}: ${choices.join(", ")}` })
    },
  })
}

function tryRecordingPromise<A>(label: string, tryFn: () => Promise<A>): Effect.Effect<A, Error> {
  return Effect.tryPromise({
    try: tryFn,
    catch: (cause) => new Error(formatCauseMessage({ label, cause }), { cause }),
  })
}

function formatCauseMessage(options: { readonly label: string; readonly cause: unknown }): string {
  if (options.cause instanceof Error && options.cause.message) {
    return `${options.label}: ${options.cause.message}`
  }
  if (Predicate.isString(options.cause) && options.cause) {
    return `${options.label}: ${options.cause}`
  }
  return options.label
}

function resolveAttachedRecordingTarget(options: {
  readonly registry: TargetRegistry
  readonly tabId: unknown
  readonly sessionId: unknown
}): { readonly tabId: number; readonly sessionId?: string; readonly owner: "relay" | "user" } {
  const tabId = optionalInteger(options.tabId, "tabId")
  if (tabId !== undefined) {
    const target = options.registry.getRootTargetByTabId(tabId)
    if (!target) {
      throw new HttpRouteError({ message: `No attached tab found for tabId ${tabId}`, status: 404, code: "target-not-found" })
    }
    return { tabId, sessionId: target.sessionId, owner: target.owner }
  }
  const sessionId = Predicate.isString(options.sessionId) && options.sessionId ? options.sessionId : undefined
  if (sessionId) {
    const target = options.registry.getRootTargetBySessionId(sessionId)
    if (!target) {
      throw new HttpRouteError({ message: `No attached tab found for sessionId ${sessionId}`, status: 404, code: "target-not-found" })
    }
    return { tabId: target.tabId, sessionId: target.sessionId, owner: target.owner }
  }
  const targets = options.registry.listRootTargets()
  if (targets.length === 0) {
    throw new HttpRouteError({ message: "No attached tab available for recording", status: 404, code: "target-not-found" })
  }
  if (targets.length > 1) {
    throw new HttpRouteError({ message: "Multiple attached tabs available; provide sessionId or tabId", status: 409, code: "target-ambiguous" })
  }
  const target = targets[0]
  if (!target) {
    throw new HttpRouteError({ message: "No attached tab available for recording", status: 404, code: "target-not-found" })
  }
  return { tabId: target.tabId, sessionId: target.sessionId, owner: target.owner }
}

function recordingTargetFromValues(options: { readonly registry: TargetRegistry; readonly tabId: unknown; readonly sessionId: unknown }): RecordingTargetOptions {
  const tabId = optionalInteger(options.tabId, "tabId")
  const sessionId = Predicate.isString(options.sessionId) && options.sessionId ? options.sessionId : undefined
  const target = sessionId ? options.registry.getRootTargetBySessionId(sessionId) : undefined
  return {
    ...(tabId === undefined ? {} : { tabId }),
    ...(target?.sessionId ? { sessionId: target.sessionId } : sessionId ? { sessionId } : {}),
  }
}

function recordingTargetFromQuery(options: { readonly registry: TargetRegistry; readonly searchParams: URLSearchParams }): RecordingTargetOptions {
  const tabIdText = options.searchParams.get("tabId")
  return recordingTargetFromValues({
    registry: options.registry,
    tabId: tabIdText ? Number(tabIdText) : undefined,
    sessionId: options.searchParams.get("sessionId") ?? undefined,
  })
}
