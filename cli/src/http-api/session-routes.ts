import http from "node:http"
import { Effect } from "effect"
import * as AuthProfile from "../auth-profile.ts"
import * as Deadbolt from "../deadbolt.ts"
import { checkUrl, parseOriginPatterns } from "../domain-policy.ts"
import { selectTarget } from "../execute.ts"
import {
  HttpRouteError,
  optionalSessionId,
  readJsonBody,
  requiredSessionId,
  sendJson,
} from "../relay-helpers.ts"
import {
  AuthenticatedJsonRequest,
  AuthProfileRequest,
  AuthRefreshRequest,
  AuthRunRequest,
  DeadboltLoginsRequest,
  ExecuteRequest,
  NetworkSessionRequest,
  NetworkStartRequest,
  NetworkStopRequest,
  SessionAdoptRequest,
  SessionAllowlistRequest,
  SessionEnsureRequest,
  SessionIdRequest,
  SessionNewRequest,
} from "../relay-schema.ts"
import type { OpenCodeBrowserSessions } from "../session-manager.ts"
import type { TargetRegistry } from "../target-registry.ts"
import { decodeRequest, noteClient, originPatterns } from "./errors.ts"

export function handleClientRequest(options: {
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

export function handleNetworkRequest(options: {
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

export function handleAuthRequest(options: {
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

export function handleCliRequest(options: {
  readonly request: http.IncomingMessage
  readonly response: http.ServerResponse
  readonly pathname: string
  readonly sessions: OpenCodeBrowserSessions
  readonly registry: TargetRegistry
}): Effect.Effect<void, Error> {
  return Effect.gen(function* () {
    if (options.pathname === "/cli/deadbolt/logins" && options.request.method === "POST") {
      const request = yield* decodeRequest(DeadboltLoginsRequest, yield* readJsonBody(options.request), "deadbolt logins")
      const sessionId = request.sessionId
      const patterns = sessionId ? options.sessions.allowedOrigins(sessionId) : undefined
      // The allowed sites (bare hosts asked about over https), plus the session's open pages, which carry the ports
      // and schemes a bare pattern leaves open (local dev servers).
      const pageOrigins = options.registry.listRootTargets()
        .filter((target) => sessionId !== undefined && target.opencodeBrowserSessionId === sessionId)
        .flatMap((target) => {
          try {
            const url = new URL(target.targetInfo.url)
            const allowed = !patterns || patterns.length === 0 || checkUrl(url.href, parseOriginPatterns(patterns)).allowed
            return (url.protocol === "https:" || url.protocol === "http:") && allowed ? [url.origin] : []
          } catch {
            return []
          }
        })
      const origins = Array.from(new Set([...(patterns && patterns.length > 0 ? Deadbolt.originsFromPatterns(patterns) : []), ...pageOrigins]))
      const listing = yield* Effect.promise(() => Deadbolt.listLogins(origins))
      sendJson(options.response, {
        ...listing,
        origins,
        ...(patterns && patterns.length > 0 ? {} : { note: "This session has no domain allowlist, so only the sites of its open pages were checked. Set one with session_allowlist to see the logins for the sites it may visit." }),
      })
      return
    }
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
        ...(request.browser ? { browser: request.browser } : {}),
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
      const available = yield* options.sessions.targetsForAdoption(requestedSessionId, allTargets)
      const byTab = request.tabId === undefined ? undefined : allTargets.find((target) => target.tabId === request.tabId)
      if (request.tabId !== undefined && !byTab)
        throw new Error(`Tab ${request.tabId} is not available to agents. Ask the user to click the Browse toolbar button on that tab.`)
      if (byTab && !available.includes(byTab)) return yield* new HttpRouteError({ status: 400, code: "invalid-request", message: `Tab ${byTab.tabId} belongs to another browser. Start a new session for that browser.` })
      const candidates = byTab ? [byTab] : request.targetSelection
        ? available
        : (() => {
            const adoptableUserTargets = available.filter((target) =>
              target.owner === "user" && (!target.opencodeBrowserSessionId || target.opencodeBrowserSessionId === requestedSessionId)
            )
            return adoptableUserTargets.length > 0 ? adoptableUserTargets : available
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
        tabId: selectedTarget.tabId,
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
        ...(request.removeAfterExecute ? { removeAfterExecute: true } : {}),
        ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
        ...(request.targetSelection ? { targetSelection: request.targetSelection } : {}),
        ...(request.browser ? { browser: request.browser } : {}),
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
