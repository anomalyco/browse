import type { JsonObject } from "./protocol.ts"
import http from "node:http"
import { Effect, Match, Predicate, Schema } from "effect"
import * as AuthProfile from "./auth-profile.ts"
import { AuthenticatedOriginError } from "./authenticated-origin.ts"
import { NetworkCaptureError } from "./network-capture.ts"
import {
  HttpRouteError,
  formatHostForUrl,
  headerValue,
  optionalSessionId,
  readJsonBody,
  requiredSessionId,
  sendJson,
  validateBrowserFetchSite,
  validateHostHeader,
} from "./relay-helpers.ts"
import { selectTarget, TargetSelectionError } from "./execute.ts"
import type { FlightRecorderRelay } from "./flight-recorder.ts"
import {
  AuthProfileRequest,
  AuthenticatedJsonRequest,
  AuthRefreshRequest,
  AuthRunRequest,
  ExecuteRequest,
  FlightRecorderSaveRequest,
  FlightRecorderStartRequest,
  NetworkSessionRequest,
  NetworkStartRequest,
  NetworkStopRequest,
  RecordingStartRequest,
  RecordingTargetRequest,
  type RelayErrorCode,
  RelayShutdownRequest,
  SessionAdoptRequest,
  SessionIdRequest,
  SessionAllowlistRequest,
  SessionEnsureRequest,
  SessionNewRequest,
  type ExtensionStatus,
  type TargetSummary,
} from "./relay-schema.ts"
import { SessionError, type OpenCodeBrowserSessions } from "./session-manager.ts"
import { normalizeOriginPatterns, OriginPatternError } from "./domain-policy.ts"
import type { RecordingRelay, RecordingStartOptions, RecordingTargetOptions } from "./recording-relay.ts"
import { TargetOwnershipError, type TargetRegistry } from "./target-registry.ts"
import { opencodeBrowserBuildId, opencodeBrowserVersion } from "./version.ts"
import { relayTokenQueryParam, secretsEqual } from "./relay-secrets.ts"
import { RelayShutdown, RelayShutdownError } from "./relay-shutdown.ts"

export function createHttpRequestHandler(options: {
  readonly host: string
  readonly port: number
  readonly browserId: string
  /** This install's relay token (relay-secrets.ts); every route but the version probe requires it. */
  readonly authToken: string
  readonly relayInstance: { readonly id: string; readonly startedAt: string; readonly pid: number; readonly managed: boolean }
  readonly shutdown: RelayShutdown
  readonly extensionStatus: () => Pick<ExtensionStatus,
    "connected" | "version" | "build" | "origin" | "protocolVersion" | "protocolCompatible" | "protocolLegacy" | "rejectedConnections" | "pairingFailures" | "cdpClients" | "processFaults"
  >
  readonly recordingRelay: RecordingRelay
  readonly flightRecorder: FlightRecorderRelay
  readonly registry: TargetRegistry
  readonly sessions: OpenCodeBrowserSessions
  /** Asks the extension to close agent-opened tabs idle for `idleMinutes` (its setting when omitted). */
  readonly cleanupTabs: (idleMinutes: number | undefined) => Effect.Effect<JsonObject, Error>
  /** Reloads the extension so an unpacked install picks up files `install` just replaced. */
  readonly reloadExtension: () => Effect.Effect<JsonObject, Error>
  /** The user's settings (user-settings.ts), read and written through the extension. */
  readonly settings: {
    readonly get: () => Effect.Effect<object, Error>
    readonly set: (changes: unknown) => Effect.Effect<object, Error>
  }
}): (request: http.IncomingMessage, response: http.ServerResponse) => void {
  options.sessions.setUserAttachedPageUrlsProvider(() =>
    options.registry.listRootTargets()
      .filter((target) => target.owner === "user")
      .map((target) => target.targetInfo.url || "about:blank")
  )
  return (request, response) => {
    const hostError = validateHostHeader({ hostHeader: request.headers.host, host: options.host, port: options.port })
    if (hostError) {
      sendJson(response, { error: hostError }, 403)
      return
    }
    const fetchSiteError = validateBrowserFetchSite(request)
    if (fetchSiteError) {
      sendJson(response, { error: fetchSiteError }, 403)
      return
    }
    const requestUrl = new URL(request.url ?? "/", `http://${formatHostForUrl(options.host)}:${options.port}`)
    const pathname = requestUrl.pathname.replace(/\/$/, "") || "/"
    // The version probe stays open: it reveals nothing sensitive and lets clients of another build or install tell
    // which relay holds the port before they send a token it would reject.
    if (pathname !== "/" && pathname !== "/version" && !hasRelayToken(request, options.authToken)) {
      sendJson(response, { error: "Missing or invalid Browse relay token", code: "unauthorized" }, 401)
      return
    }
    const observational = request.method === "GET" || pathname === "/network/status" || pathname === "/auth/status"
    const run = (effect: Effect.Effect<void, Error>, settle = false): void => {
      runRequestEffect(response, observational ? effect : options.shutdown.track(settle ? Effect.uninterruptible(effect) : effect))
    }
    if (pathname === "/" || pathname === "/version") {
      sendJson(response, {
        version: opencodeBrowserVersion,
        buildId: opencodeBrowserBuildId,
        instanceId: options.relayInstance.id,
        startedAt: options.relayInstance.startedAt,
        pid: options.relayInstance.pid,
        managed: options.relayInstance.managed,
        shutdownProtocol: 2,
      })
      return
    }
    if (pathname === "/shutdown" && request.method === "POST") {
      runRequestEffect(response, Effect.gen(function* () {
        const body = yield* decodeRequest(RelayShutdownRequest, yield* readJsonBody(request), "relay shutdown")
        yield* options.shutdown.request(body)
        sendJson(response, { stopping: true })
      }))
      return
    }
    if (pathname === "/json/version") {
      const opencodeBrowserSessionId = headerValue(request.headers["opencode-browser-session-id"])
      const webSocketDebuggerUrl = new URL(`ws://${formatHostForUrl(options.host)}:${options.port}/devtools/browser/${options.browserId}`)
      if (opencodeBrowserSessionId) {
        webSocketDebuggerUrl.searchParams.set("opencodeBrowserSessionId", opencodeBrowserSessionId)
      }
      // The caller already proved it has the token; clients that connect to this URL without headers need it too.
      webSocketDebuggerUrl.searchParams.set(relayTokenQueryParam, options.authToken)
      sendJson(response, {
        Browser: `OpenCode-Browser/${opencodeBrowserVersion}`,
        "Protocol-Version": "1.3",
        webSocketDebuggerUrl: webSocketDebuggerUrl.toString(),
      })
      return
    }
    if (pathname === "/extension/reload" && request.method === "POST") {
      run(Effect.gen(function* () {
        sendJson(response, yield* options.reloadExtension())
      }))
      return
    }
    if (pathname === "/tabs/cleanup" && request.method === "POST") {
      run(Effect.gen(function* () {
        const body = yield* readJsonBody(request)
        const idleMinutes = typeof body === "object" && body !== null && "idleMinutes" in body && typeof body.idleMinutes === "number"
          ? Math.max(0, body.idleMinutes)
          : undefined
        sendJson(response, yield* options.cleanupTabs(idleMinutes))
      }))
      return
    }
    if (pathname === "/settings" && request.method === "GET") {
      run(Effect.gen(function* () {
        sendJson(response, yield* options.settings.get())
      }))
      return
    }
    if (pathname === "/settings" && request.method === "POST") {
      run(Effect.gen(function* () {
        const body = yield* readJsonBody(request)
        sendJson(response, yield* options.settings.set(typeof body === "object" && body !== null && "set" in body ? body.set : undefined))
      }))
      return
    }
    if (pathname === "/json/list") {
      sendJson(response, targetSummaries(options.registry))
      return
    }
    if (pathname === "/extension/status") {
      const extensionStatus = options.extensionStatus()
      sendJson(response, {
        connected: extensionStatus.connected,
        version: extensionStatus.version,
        ...(extensionStatus.build === undefined ? {} : { build: extensionStatus.build }),
        ...(extensionStatus.origin === undefined ? {} : { origin: extensionStatus.origin }),
        ...(extensionStatus.protocolVersion === undefined ? {} : { protocolVersion: extensionStatus.protocolVersion }),
        ...(extensionStatus.protocolCompatible === undefined ? {} : { protocolCompatible: extensionStatus.protocolCompatible }),
        ...(extensionStatus.protocolLegacy === undefined ? {} : { protocolLegacy: extensionStatus.protocolLegacy }),
        ...(extensionStatus.rejectedConnections === undefined ? {} : { rejectedConnections: extensionStatus.rejectedConnections }),
        ...(extensionStatus.cdpClients === undefined ? {} : { cdpClients: extensionStatus.cdpClients }),
        ...(extensionStatus.pairingFailures === undefined ? {} : { pairingFailures: extensionStatus.pairingFailures }),
        ...(extensionStatus.processFaults === undefined ? {} : { processFaults: extensionStatus.processFaults }),
        activeTargets: options.registry.rootTargetCount(),
        childTargets: options.registry.childTargets.size,
        sessions: options.sessions.listSummaries(),
        targets: targetSummaries(options.registry),
      })
      return
    }
    if (pathname.startsWith("/recording/")) {
      run(handleRecordingRequest({ request, response, pathname, requestUrl, registry: options.registry, recordingRelay: options.recordingRelay }), true)
      return
    }
    if (pathname.startsWith("/flight-recorder/")) {
      run(handleFlightRecorderRequest({ request, response, pathname, requestUrl, registry: options.registry, flightRecorder: options.flightRecorder }), true)
      return
    }
    if (pathname.startsWith("/network/")) {
      run(handleNetworkRequest({ request, response, pathname, sessions: options.sessions }))
      return
    }
    if (pathname.startsWith("/auth/")) {
      run(handleAuthRequest({ request, response, pathname, sessions: options.sessions }), pathname === "/auth/run")
      return
    }
    if (pathname.startsWith("/v1/")) {
      run(handleClientRequest({
        request,
        response,
        pathname,
        sessions: options.sessions,
      }))
      return
    }
    if (pathname.startsWith("/cli/")) {
      run(handleCliRequest({
        request,
        response,
        pathname,
        sessions: options.sessions,
        registry: options.registry,
      }))
      return
    }
    response.writeHead(404)
    response.end("Not found")
  }
}

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

/**
 * The MCP server names its process (OpenCode-Browser-Client-Pid) on session requests; the relay remembers it per
 * session so a capture or an implicit session outlives its MCP server only briefly (relay.ts, collectOrphans).
 */
function noteClient(request: http.IncomingMessage, sessions: OpenCodeBrowserSessions, sessionId: string): void {
  const pid = Number(headerValue(request.headers["opencode-browser-client-pid"]))
  if (Number.isSafeInteger(pid) && pid > 0) sessions.noteClient(sessionId, pid)
}

/** Whether a request carries the relay token as `Authorization: Bearer <token>`, compared in constant time. */
export function hasRelayToken(request: http.IncomingMessage, token: string): boolean {
  const header = request.headers.authorization
  const match = /^Bearer\s+(\S+)$/i.exec(header ?? "")
  return secretsEqual(token, match?.[1])
}

function handleClientRequest(options: {
  readonly request: http.IncomingMessage
  readonly response: http.ServerResponse
  readonly pathname: string
  readonly sessions: OpenCodeBrowserSessions
}): Effect.Effect<void, Error> {
  return Effect.gen(function* () {
    if (options.pathname === "/v1/sessions/ensure" && options.request.method === "POST") {
      const request = yield* decodeRequest(SessionEnsureRequest, yield* readJsonBody(options.request), "session ensure")
      const session = yield* options.sessions.ensure(request.id, {
        ...(request.readOnly === undefined ? {} : { readOnly: request.readOnly }),
      })
      noteClient(options.request, options.sessions, session.id)
      sendJson(options.response, { session })
      return
    }
    if (options.pathname === "/v1/authenticated-origin/json" && options.request.method === "POST") {
      const request = yield* decodeRequest(AuthenticatedJsonRequest, yield* readJsonBody(options.request), "authenticated origin")
      options.response.setHeader("cache-control", "no-store")
      sendJson(options.response, yield* options.sessions.authenticatedJson(request))
      return
    }
    options.response.writeHead(404)
    options.response.end("Not found")
  })
}

function handleNetworkRequest(options: {
  readonly request: http.IncomingMessage
  readonly response: http.ServerResponse
  readonly pathname: string
  readonly sessions: OpenCodeBrowserSessions
}): Effect.Effect<void, Error> {
  return Effect.gen(function* () {
    if (options.pathname === "/network/start" && options.request.method === "POST") {
      const request = yield* decodeRequest(NetworkStartRequest, yield* readJsonBody(options.request), "network start")
      const { sessionId, ...captureOptions } = request
      noteClient(options.request, options.sessions, sessionId)
      const result = yield* options.sessions.networkStart(sessionId, captureOptions)
      sendJson(options.response, result)
      return
    }
    if (options.pathname === "/network/status" && options.request.method === "POST") {
      const request = yield* decodeRequest(NetworkSessionRequest, yield* readJsonBody(options.request), "network status")
      sendJson(options.response, yield* options.sessions.networkStatus(request.sessionId))
      return
    }
    if (options.pathname === "/network/stop" && options.request.method === "POST") {
      const request = yield* decodeRequest(NetworkStopRequest, yield* readJsonBody(options.request), "network stop")
      const { sessionId, ...stopOptions } = request
      sendJson(options.response, yield* options.sessions.networkStop(sessionId, stopOptions))
      return
    }
    if (options.pathname === "/network/cancel" && options.request.method === "POST") {
      const request = yield* decodeRequest(NetworkSessionRequest, yield* readJsonBody(options.request), "network cancel")
      sendJson(options.response, yield* options.sessions.networkCancel(request.sessionId))
      return
    }
    options.response.writeHead(404)
    options.response.end("Not found")
  })
}

function handleAuthRequest(options: {
  readonly request: http.IncomingMessage
  readonly response: http.ServerResponse
  readonly pathname: string
  readonly sessions: OpenCodeBrowserSessions
}): Effect.Effect<void, Error> {
  return Effect.gen(function* () {
    if (options.pathname === "/auth/status" && options.request.method === "POST") {
      const request = yield* decodeRequest(AuthProfileRequest, yield* readJsonBody(options.request), "auth status")
      sendJson(options.response, yield* AuthProfile.status(request.name))
      return
    }
    if (options.pathname === "/auth/refresh" && options.request.method === "POST") {
      const request = yield* decodeRequest(AuthRefreshRequest, yield* readJsonBody(options.request), "auth refresh")
      const { sessionId, ...refreshOptions } = request
      sendJson(options.response, yield* options.sessions.authRefresh(sessionId, refreshOptions))
      return
    }
    if (options.pathname === "/auth/run" && options.request.method === "POST") {
      const request = yield* decodeRequest(AuthRunRequest, yield* readJsonBody(options.request), "auth run")
      sendJson(options.response, yield* AuthProfile.run(request))
      return
    }
    options.response.writeHead(404)
    options.response.end("Not found")
  })
}

function runRequestEffect(response: http.ServerResponse, effect: Effect.Effect<void, Error>): void {
  const controller = new AbortController()
  const onClose = () => controller.abort()
  response.once("close", onClose)
  Effect.runPromise(effect, { signal: controller.signal }).catch((error: unknown) => {
    if (response.destroyed || response.writableEnded) return
    const routeError = relayHttpError(error)
    sendJson(response, {
      error: routeError.message,
      code: routeError.code,
    }, routeError.status)
  }).finally(() => {
    response.off("close", onClose)
  })
}

function handleRecordingRequest(options: {
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
      const result = yield* tryRecordingPromise("recording status", () => options.recordingRelay.statusRecording(target))
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

function handleFlightRecorderRequest(options: {
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
      sendJson(options.response, options.flightRecorder.status(recordingTargetFromQuery({ registry: options.registry, searchParams: options.requestUrl.searchParams })))
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

function handleCliRequest(options: {
  readonly request: http.IncomingMessage
  readonly response: http.ServerResponse
  readonly pathname: string
  readonly sessions: OpenCodeBrowserSessions
  readonly registry: TargetRegistry
}): Effect.Effect<void, Error> {
  return Effect.gen(function* () {
    if (options.pathname === "/cli/sessions" && options.request.method === "GET") {
      sendJson(options.response, { sessions: options.sessions.listSummaries() })
      return
    }
    if (options.pathname === "/cli/session/new" && options.request.method === "POST") {
      const body = yield* readJsonBody(options.request)
      const request = yield* decodeRequest(SessionNewRequest, body, "session new")
      const allowedOrigins = request.allowedOrigins === undefined ? undefined : yield* originPatterns(request.allowedOrigins)
      const session = yield* options.sessions.create(optionalSessionId(request.id), {
        readOnly: request.readOnly === true,
        ...(allowedOrigins ? { allowedOrigins } : {}),
      })
      noteClient(options.request, options.sessions, session.id)
      sendJson(options.response, { session: options.sessions.summary(session.id) })
      return
    }
    if (options.pathname === "/cli/session/allowlist" && options.request.method === "POST") {
      const request = yield* decodeRequest(SessionAllowlistRequest, yield* readJsonBody(options.request), "session allowlist")
      const id = requiredSessionId(request.id)
      const allowedOrigins = yield* originPatterns(request.allowedOrigins)
      sendJson(options.response, { session: yield* options.sessions.setAllowedOrigins(id, allowedOrigins) })
      return
    }
    if (options.pathname === "/cli/session/delete" && options.request.method === "POST") {
      const body = yield* readJsonBody(options.request)
      const request = yield* decodeRequest(SessionIdRequest, body, "session delete")
      const id = requiredSessionId(request.id)
      const { deleted, stopped } = yield* options.sessions.delete(id)
      sendJson(options.response, { deleted, id, ...(stopped ? { stopped } : {}) })
      return
    }
    if (options.pathname === "/cli/session/reset" && options.request.method === "POST") {
      const body = yield* readJsonBody(options.request)
      const request = yield* decodeRequest(SessionIdRequest, body, "session reset")
      const id = requiredSessionId(request.id)
      const reset = yield* options.sessions.reset(id)
      if (!reset) {
        sendJson(options.response, { error: `Session not found: ${id}`, code: "session-not-found" }, 404)
        return
      }
      sendJson(options.response, reset)
      return
    }
    if (options.pathname === "/cli/session/adopt" && options.request.method === "POST") {
      const body = yield* readJsonBody(options.request)
      const request = yield* decodeRequest(SessionAdoptRequest, body, "session adopt")
      const requestedSessionId = optionalSessionId(request.sessionId)
      const allTargets = options.registry.listRootTargets()
      const byTab = request.tabId === undefined ? undefined : allTargets.find((target) => target.tabId === request.tabId)
      if (request.tabId !== undefined && !byTab)
        throw new Error(`Tab ${request.tabId} is not available to agents. Ask the user to click the Browse toolbar button on that tab.`)
      const candidates = byTab ? [byTab] : request.targetSelection
        ? allTargets
        : (() => {
            const adoptableUserTargets = allTargets.filter((target) =>
              target.owner === "user" && (!target.opencodeBrowserSessionId || target.opencodeBrowserSessionId === requestedSessionId)
            )
            return adoptableUserTargets.length > 0 ? adoptableUserTargets : allTargets
          })()
      const selectedTarget = selectTarget({
        targets: candidates,
        selection: request.targetSelection ?? {},
        getUrl: (target) => target.targetInfo.url,
        getIndex: (target) => allTargets.indexOf(target),
      })
      if (!selectedTarget) {
        throw new Error("No page matched target selection")
      }
      const adoptedTargetId = selectedTarget.targetInfo.targetId
      const { session, adoptedUrl } = yield* options.sessions.adopt({
        ...(requestedSessionId ? { sessionId: requestedSessionId } : {}),
        createIfMissing: request.createIfMissing,
        targetId: adoptedTargetId,
        targetUrl: selectedTarget.targetInfo.url,
      })
      sendJson(options.response, { session, adoptedUrl, adoptedTargetId })
      return
    }
    if (options.pathname === "/cli/execute" && options.request.method === "POST") {
      const body = yield* readJsonBody(options.request)
      const request = yield* decodeRequest(ExecuteRequest, body, "execute")
      const requestedSessionId = optionalSessionId(request.sessionId)
      if (requestedSessionId) noteClient(options.request, options.sessions, requestedSessionId)
      const { result, session } = yield* options.sessions.execute({
        ...(requestedSessionId ? { sessionId: requestedSessionId } : {}),
        code: request.code,
        createIfMissing: request.createIfMissing,
        ...(request.targetSelection ? { targetSelection: request.targetSelection } : {}),
      })
      const { setupFailed: _setupFailed, ...wireResult } = result
      noteClient(options.request, options.sessions, session.id)
      sendJson(options.response, { ...wireResult, session })
      return
    }
    options.response.writeHead(404)
    options.response.end("Not found")
  })
}

function targetSummaries(registry: TargetRegistry): TargetSummary[] {
  return registry.listRootTargets().map((target) => {
      return {
        id: target.targetInfo.targetId,
        type: target.targetInfo.type,
        title: target.targetInfo.title,
        url: target.targetInfo.url,
        tabId: target.tabId,
        sessionId: target.sessionId,
        ...(target.opencodeBrowserSessionId ? { opencodeBrowserSessionId: target.opencodeBrowserSessionId } : {}),
        owner: target.owner,
        ...(target.crashed ? { crashed: true } : {}),
        ...(target.protectedUi ? { protectedUi: true } : {}),
      }
  })
}

function decodeRequest<A>(schema: Schema.ConstraintDecoder<A>, body: unknown, label: string): Effect.Effect<A, Error> {
  return Schema.decodeUnknownEffect(schema)(body).pipe(
    Effect.mapError((cause) => new HttpRouteError({
      message: `Invalid ${label} request: ${cause.message}`,
      status: 400,
      code: "invalid-request",
    })),
  )
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

function optionalInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) {
    return undefined
  }
  if (!Predicate.isNumber(value) || !Number.isInteger(value)) {
    throw new HttpRouteError({ message: `${field} must be an integer`, status: 400, code: "invalid-request" })
  }
  return value
}

function relayHttpError(error: unknown): HttpRouteError {
  const routeError = (message: string, status: number, code: RelayErrorCode) =>
    new HttpRouteError({ message, status, code })
  if (error instanceof RelayShutdownError) {
    return routeError(error.message, 409, error.reason === "busy" ? "relay-busy" : "invalid-request")
  }
  if (error instanceof HttpRouteError) {
    return error
  }
  if (error instanceof SessionError) {
    const [status, code] = Match.value(error.reason).pipe(
      Match.when("already-exists", () => [409, "session-already-exists"] as const),
      Match.when("inactive", () => [409, "session-inactive"] as const),
      Match.when("invalid-request", () => [400, "invalid-request"] as const),
      Match.when("not-found", () => [404, "session-not-found"] as const),
      Match.when("target-owned", () => [409, "target-owned"] as const),
      Match.when("timeout", () => [409, "session-timeout"] as const),
      Match.when("setup-failed", () => [500, "setup-failed"] as const),
      Match.exhaustive,
    )
    return routeError(error.message, status, code)
  }
  if (error instanceof NetworkCaptureError) {
    const [status, code] = Match.value(error.reason).pipe(
      Match.when("invalid-options", () => [400, "invalid-request"] as const),
      Match.when("already-active", () => [409, "capture-conflict"] as const),
      Match.when("inactive", () => [409, "capture-conflict"] as const),
      Match.orElse(() => [500, "internal"] as const),
    )
    return routeError(error.message, status, code)
  }
  if (error instanceof AuthProfile.AuthProfileError) {
    const [status, code] = Match.value(error.reason).pipe(
      Match.when("invalid-name", () => [400, "invalid-request"] as const),
      Match.when("not-found", () => [404, "auth-profile-not-found"] as const),
      Match.orElse(() => [500, "internal"] as const),
    )
    return routeError(error.message, status, code)
  }
  if (error instanceof AuthenticatedOriginError) {
    return routeError(
      error.message,
      error.reason === "invalid-request" ? 400 : 500,
      error.reason === "invalid-request" ? "invalid-request" : "setup-failed",
    )
  }
  if (error instanceof TargetSelectionError) {
    const [status, code] = Match.value(error.reason).pipe(
      Match.when("invalid", () => [400, "invalid-request"] as const),
      Match.when("not-found", () => [404, "target-not-found"] as const),
      Match.when("ambiguous", () => [409, "target-ambiguous"] as const),
      Match.exhaustive,
    )
    return routeError(error.message, status, code)
  }
  if (error instanceof TargetOwnershipError) {
    const [status, code] = Match.value(error.reason).pipe(
      Match.when("not-found", () => [404, "target-not-found"] as const),
      Match.when("owned", () => [409, "target-owned"] as const),
      Match.when("generation-changed", () => [409, "target-changed"] as const),
      Match.exhaustive,
    )
    return routeError(error.message, status, code)
  }
  return routeError(error instanceof Error ? error.message : String(error), 500, "internal")
}

/** Normalize allowed-origin patterns, failing with a 400-style message on an invalid one. */
function originPatterns(raw: readonly string[]): Effect.Effect<readonly string[], Error> {
  return Effect.try({
    try: () => normalizeOriginPatterns(raw),
    catch: (cause) => cause instanceof OriginPatternError ? new Error(cause.message) : new Error("Invalid origin patterns", { cause }),
  })
}
