import http from "node:http"
import { Effect } from "effect"
import * as AuthProfile from "../auth/profile.ts"
import { selectTarget } from "../execute.ts"
import {
  HttpRouteError,
  optionalSessionId,
  readJsonBody,
  requiredSessionId,
  sendJson,
} from "../relay/helpers.ts"
import {
  AuthenticatedJsonRequest,
  AuthProfileRequest,
  AuthRefreshRequest,
  AuthRunRequest,
  ExecuteRequest,
  NetworkSessionRequest,
  NetworkStartRequest,
  NetworkStopRequest,
  SessionAdoptRequest,
  SessionAllowlistRequest,
  SessionEnsureRequest,
  SessionIdRequest,
  SessionNewRequest,
} from "../relay/schema.ts"
import type { OpenCodeBrowserSessions } from "../session-manager.ts"
import type { TargetRegistry } from "../cdp/target-registry.ts"
import { decodeRequest, noteClient, originPatterns, sendNotFound } from "./errors.ts"

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
    sendNotFound(options.response)
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
    sendNotFound(options.response)
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
    sendNotFound(options.response)
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
        ...(request.keepVisible === true ? { keepVisible: true } : {}),
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
        throw new Error(`Tab ${request.tabId} is not available to agents. Ask the user to click the browse toolbar button on that tab.`)
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
    sendNotFound(options.response)
  })
}
