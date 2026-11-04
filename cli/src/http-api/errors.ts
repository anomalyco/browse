import http from "node:http"
import { Effect, Match, Predicate, Schema } from "effect"
import * as AuthProfile from "../auth-profile.ts"
import { AuthenticatedOriginError } from "../authenticated-origin.ts"
import { normalizeOriginPatterns, OriginPatternError } from "../domain-policy.ts"
import { TargetSelectionError } from "../execute.ts"
import { NetworkCaptureError } from "../network-capture.ts"
import { headerValue, HttpRouteError, sendJson } from "../relay-helpers.ts"
import type { RelayErrorCode, TargetSummary } from "../relay-schema.ts"
import { secretsEqual } from "../relay-secrets.ts"
import { RelayShutdownError } from "../relay-shutdown.ts"
import { SessionError, type OpenCodeBrowserSessions } from "../session-manager.ts"
import { TargetOwnershipError, type TargetRegistry } from "../target-registry.ts"

/**
 * The MCP server names its process (OpenCode-Browser-Client-Pid) on session requests; the relay remembers it per
 * session so a capture or an implicit session outlives its MCP server only briefly (relay.ts, collectOrphans).
 */
export function noteClient(request: http.IncomingMessage, sessions: OpenCodeBrowserSessions, sessionId: string): void {
  const pid = Number(headerValue(request.headers["opencode-browser-client-pid"]))
  if (Number.isSafeInteger(pid) && pid > 0) sessions.noteClient(sessionId, pid)
}

/** Whether a request carries the relay token as `Authorization: Bearer <token>`, compared in constant time. */
export function hasRelayToken(request: http.IncomingMessage, token: string): boolean {
  const header = request.headers.authorization
  const match = /^Bearer\s+(\S+)$/i.exec(header ?? "")
  return secretsEqual(token, match?.[1])
}

export function runRequestEffect(response: http.ServerResponse, effect: Effect.Effect<void, Error>): void {
  const controller = new AbortController()
  const onClose = () => {
    if (!response.writableEnded) controller.abort()
  }
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

export function targetSummaries(registry: TargetRegistry): TargetSummary[] {
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

export function decodeRequest<A>(schema: Schema.ConstraintDecoder<A>, body: unknown, label: string): Effect.Effect<A, Error> {
  return Schema.decodeUnknownEffect(schema)(body).pipe(
    Effect.mapError((cause) => new HttpRouteError({
      message: `Invalid ${label} request: ${cause.message}`,
      status: 400,
      code: "invalid-request",
    })),
  )
}

export function optionalInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) {
    return undefined
  }
  if (!Predicate.isNumber(value) || !Number.isInteger(value)) {
    throw new HttpRouteError({ message: `${field} must be an integer`, status: 400, code: "invalid-request" })
  }
  return value
}

export function relayHttpError(error: unknown): HttpRouteError {
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
      Match.when("browser-unavailable", () => [503, "browser-unavailable"] as const),
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
export function originPatterns(raw: readonly string[]): Effect.Effect<readonly string[], Error> {
  return Effect.try({
    try: () => normalizeOriginPatterns(raw),
    catch: (cause) => cause instanceof OriginPatternError ? new Error(cause.message) : new Error("Invalid origin patterns", { cause }),
  })
}
