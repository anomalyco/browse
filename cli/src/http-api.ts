import http from "node:http"
import { Effect } from "effect"
import { pairingScheme } from "./relay/browser-pairing.ts"
import type { FlightRecorderRelay } from "./recording-relay/flight-recorder.ts"
import { decodeRequest, hasRelayToken, runRequestEffect, sendNotFound, targetSummaries } from "./http-api/errors.ts"
import { handleFlightRecorderRequest, handleRecordingRequest } from "./http-api/recording-routes.ts"
import { handleAuthRequest, handleCliRequest, handleClientRequest, handleNetworkRequest } from "./http-api/session-routes.ts"
import type { JsonObject } from "./protocol.ts"
import { extensionProtocolVersion, minExtensionProtocolVersion } from "./protocol.ts"
import type { RecordingRelay } from "./recording-relay.ts"
import {
  formatHostForUrl,
  getNumber,
  getObject,
  getString,
  headerValue,
  readJsonBody,
  sendJson,
  validateBrowserFetchSite,
  validateHostHeader,
} from "./relay/helpers.ts"
import { RelayShutdownRequest, type ExtensionStatus } from "./relay/schema.ts"
import { relayTokenQueryParam } from "./relay/secrets.ts"
import type { RelayShutdown } from "./relay/shutdown.ts"
import type { OpenCodeBrowserSessions } from "./session-manager.ts"
import type { TargetRegistry } from "./cdp/target-registry.ts"
import { opencodeBrowserBuildId, opencodeBrowserVersion } from "./version.ts"

export { hasRelayToken } from "./http-api/errors.ts"

export function createHttpRequestHandler(options: {
  readonly host: string
  readonly port: number
  readonly browserId: string
  /** This install's relay token (relay-secrets.ts); every route but the version probe requires it. */
  readonly authToken: string
  readonly relayInstance: { readonly id: string; readonly startedAt: string; readonly pid: number; readonly managed: boolean }
  readonly shutdown: RelayShutdown
  readonly extensionStatus: () => Pick<ExtensionStatus,
    "connected" | "pairingState" | "nextStep" | "version" | "build" | "origin" | "protocolVersion" | "protocolCompatible" | "protocolLegacy" | "browsers" | "rejectedConnections" | "pairingFailures" | "cdpClients" | "processFaults"
  >
  readonly recordingRelay: RecordingRelay
  readonly flightRecorder: FlightRecorderRelay
  readonly registry: TargetRegistry
  readonly sessions: OpenCodeBrowserSessions
  /**
   * Asks the extension to close agent-opened tabs idle for `idleMinutes` (its setting when omitted). With `sessions`,
   * `idleMinutes` applies only to those sessions' tabs, and every other tab also waits for the setting.
   */
  readonly cleanupTabs: (idleMinutes: number | undefined, sessions?: readonly string[]) => Effect.Effect<JsonObject, Error>
  /** Reloads the extension so an unpacked install picks up files `install` just replaced. */
  readonly reloadExtension: () => Effect.Effect<JsonObject, Error>
  /** Drops the connection of the browser with this profile key, whose token `pair --revoke` just deleted. */
  readonly revokeBrowser: (key: string) => boolean
  /** The user's settings (user-settings.ts), read and written through the extension. */
  readonly settings: {
    readonly get: () => Effect.Effect<object, Error>
    readonly set: (changes: unknown) => Effect.Effect<object, Error>
  }
}): (request: http.IncomingMessage, response: http.ServerResponse) => void {
  // A short lease from install's authenticated status polls. Even a killed install stops advertising itself.
  let installWaitingUntil = 0
  return (request, response) => {
    const hostError = validateHostHeader({ hostHeader: request.headers.host, host: options.host, port: options.port })
    if (hostError) {
      sendJson(response, { error: hostError }, 403)
      return
    }
    const compatibility = { extensionProtocol: { min: minExtensionProtocolVersion, version: extensionProtocolVersion }, pairing: pairingScheme }
    const installHint = request.headers["x-browse-install"] === "probe" && Date.now() < installWaitingUntil ? { installWaiting: true } : {}
    const fetchSiteError = validateBrowserFetchSite(request)
    if (fetchSiteError) {
      // Chrome may mark the Options page's probe cross-site. Keep the refusal and disclose only static
      // compatibility and the Options page's optional waiting hint; never return instance metadata or enable CORS.
      sendJson(response, { error: fetchSiteError, ...(request.method === "GET" && request.url === "/version" ? { ...compatibility, ...installHint } : {}) }, 403)
      return
    }
    const requestUrl = new URL(request.url ?? "/", `http://${formatHostForUrl(options.host)}:${options.port}`)
    const pathname = requestUrl.pathname.replace(/\/$/, "") || "/"
    // The version probe stays open: it reveals nothing sensitive and lets clients of another build or install tell
    // which relay holds the port before they send a token it would reject.
    if (pathname !== "/" && pathname !== "/version" && !hasRelayToken(request, options.authToken)) {
      sendJson(response, { error: "Missing or invalid browse relay token", code: "unauthorized" }, 401)
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
        ...compatibility,
        ...installHint,
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
    if (pathname === "/extension/revoke" && request.method === "POST") {
      run(Effect.gen(function* () {
        const key = getString(getObject(yield* readJsonBody(request)), "key")
        if (key === undefined) return sendJson(response, { error: "key is required", code: "invalid-request" }, 400)
        sendJson(response, { dropped: options.revokeBrowser(key) })
      }))
      return
    }
    if (pathname === "/tabs/cleanup" && request.method === "POST") {
      run(Effect.gen(function* () {
        const body = getObject(yield* readJsonBody(request))
        const rawIdleMinutes = getNumber(body, "idleMinutes")
        const idleMinutes = rawIdleMinutes === undefined ? undefined : Math.max(0, rawIdleMinutes)
        const sessions = Array.isArray(body?.sessions) ? body.sessions.filter((id) => typeof id === "string") : undefined
        sendJson(response, yield* options.cleanupTabs(idleMinutes, sessions))
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
        const body = getObject(yield* readJsonBody(request))
        sendJson(response, yield* options.settings.set(body && "set" in body ? body.set : undefined))
      }))
      return
    }
    if (pathname === "/json/list") {
      sendJson(response, targetSummaries(options.registry))
      return
    }
    if (pathname === "/extension/status") {
      if (request.headers["x-browse-install"] === "waiting") installWaitingUntil = Date.now() + 5_000
      sendJson(response, {
        ...options.extensionStatus(),
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
    sendNotFound(response)
  }
}
