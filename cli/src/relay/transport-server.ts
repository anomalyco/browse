import http from "node:http"
import { Effect } from "effect"
import { type WebSocket, WebSocketServer } from "ws"
import type { BrowserLink } from "../browser-links.ts"
import type { CdpClientPool } from "../cdp-client-pool.ts"
import type { CdpRuntime } from "../cdp-runtime.ts"
import { hasRelayToken } from "../http-api.ts"
import type { RecordingRelay } from "../recording-relay.ts"
import { isLocalPeer } from "../relay-config.ts"
import {
  headerValue,
  sendCdpResponse,
  validateHostHeader,
  validateWebSocketOrigin,
} from "../relay-helpers.ts"
import { relayLog } from "../relay-log.ts"
import { relayTokenQueryParam, secretsEqual } from "../relay-secrets.ts"
import type { RelayShutdown } from "../relay-shutdown.ts"
import type { OpenCodeBrowserSessions } from "../session-manager.ts"
import type { ExtensionHandshake } from "./extension-handshake.ts"
import { sendUpgradeError } from "./process-guard.ts"

export interface TransportServerDeps {
  readonly host: string
  readonly port: number
  readonly endpointUrl: string
  readonly authToken: string
  readonly additionalChromeExtensionOrigins: ReadonlySet<string>
  readonly isReady: () => boolean
  readonly onAgentHttpActivity: () => void
  readonly relayRequestHandler: (request: http.IncomingMessage, response: http.ServerResponse) => void
  readonly shutdownControl: RelayShutdown
  readonly sessions: OpenCodeBrowserSessions
  readonly cdpClients: CdpClientPool<WebSocket>
  readonly cdpRuntime: CdpRuntime<WebSocket>
  readonly handshake: ExtensionHandshake
  readonly recordingRelay: RecordingRelay
  readonly handleExtensionMessage: (link: BrowserLink, raw: string) => void
  readonly handleCdpMessage: (socket: WebSocket, raw: string) => Effect.Effect<void, Error>
  readonly debugLog: ((line: string) => void) | undefined
}

export function createRelayTransportServers(deps: TransportServerDeps): {
  readonly httpServer: http.Server
  readonly websocketServer: WebSocketServer
} {
  const {
    host,
    port,
    endpointUrl,
    authToken,
    additionalChromeExtensionOrigins,
    isReady,
    onAgentHttpActivity,
    relayRequestHandler,
    shutdownControl,
    sessions,
    cdpClients,
    cdpRuntime,
    handshake,
    recordingRelay,
    handleExtensionMessage,
    handleCdpMessage,
    debugLog,
  } = deps

  const httpServer = http.createServer((request, response) => {
    if (!isLocalPeer(request.socket)) {
      response.writeHead(404).end()
      return
    }
    if (!isReady()) {
      response.writeHead(503, { "content-type": "application/json; charset=utf-8", "retry-after": "1" })
      response.end(JSON.stringify({ error: "Browse relay is starting", code: "relay-starting" }))
      return
    }
    const started = performance.now()
    const requestPath = (request.url ?? "").split("?")[0]
    if (requestPath !== "/version" && requestPath !== "/json/version" && requestPath !== "/json/version/" && requestPath !== "/extension/status") {
      onAgentHttpActivity()
    }
    response.once("finish", () => {
      const pathname = (request.url ?? "").split("?")[0]
      if (pathname === "/version" || pathname === "/json/version" || pathname === "/json/version/" || pathname === "/extension/status") return
      relayLog("http", { method: request.method, path: pathname, status: response.statusCode, ms: Math.round(performance.now() - started) })
    })
    relayRequestHandler(request, response)
  })
  httpServer.requestTimeout = 0
  httpServer.timeout = 0
  httpServer.on("error", (error) => relayLog("http.error", { error: error.message, code: (error as NodeJS.ErrnoException).code }))

  const websocketServer = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 * 1024 })

  httpServer.on("upgrade", (request, socket, head) => {
    if (!isReady()) {
      sendUpgradeError({ socket, status: 404, message: "Browse relay is starting" })
      return
    }
    const requestUrl = new URL(request.url ?? "/", endpointUrl)
    const local = isLocalPeer(request.socket)
    if (!local && requestUrl.pathname !== "/extension") {
      socket.destroy()
      return
    }
    const hostError = local ? validateHostHeader({ hostHeader: request.headers.host, host, port }) : undefined
    if (hostError) {
      sendUpgradeError({ socket, status: 403, message: hostError })
      return
    }
    const origin = Array.isArray(request.headers.origin) ? request.headers.origin[0] : request.headers.origin
    if (requestUrl.pathname === "/extension") {
      const originError = validateWebSocketOrigin({
        origin,
        requireChromeExtension: true,
        additionalChromeExtensionOrigins,
      })
      if (originError) {
        sendUpgradeError({ socket, status: 403, message: originError })
        return
      }
      websocketServer.handleUpgrade(request, socket, head, (websocket) => {
        websocketServer.emit("connection", websocket, request)
      })
      return
    }
    if (!hasRelayToken(request, authToken) && !secretsEqual(authToken, requestUrl.searchParams.get(relayTokenQueryParam) ?? undefined)) {
      sendUpgradeError({ socket, status: 401, message: "Missing or invalid Browse relay token" })
      return
    }
    if (requestUrl.pathname.startsWith("/devtools/browser/")) {
      const sessionId = requestUrl.searchParams.get("opencodeBrowserSessionId") ?? headerValue(request.headers["opencode-browser-session-id"])
      if (!shutdownControl.accepting && (headerValue(request.headers["opencode-browser-client-kind"]) !== "sandbox" || !sessionId || !sessions.hasPendingWork(sessionId))) {
        sendUpgradeError({ socket, status: 503, message: "Relay is draining for an explicit restart" })
        return
      }
      const originError = validateWebSocketOrigin({ origin, additionalChromeExtensionOrigins })
      if (originError) {
        sendUpgradeError({ socket, status: 403, message: originError })
        return
      }
      websocketServer.handleUpgrade(request, socket, head, (websocket) => {
        websocketServer.emit("connection", websocket, request)
      })
      return
    }
    socket.destroy()
  })

  websocketServer.on("connection", (socket, request) => {
    const requestUrl = new URL(request.url ?? "/", endpointUrl)
    if (requestUrl.pathname === "/extension") {
      handshake.handleConnection(socket, request, {
        onRecordingBinary: (frame) => recordingRelay.handleBinaryData(frame),
        onMessage: (link, raw) => handleExtensionMessage(link, raw),
      })
      return
    }
    const opencodeBrowserSessionId = requestUrl.searchParams.get("opencodeBrowserSessionId") ?? headerValue(request.headers["opencode-browser-session-id"])
    cdpClients.register(socket, opencodeBrowserSessionId, headerValue(request.headers["opencode-browser-client-kind"]) === "sandbox" ? "sandbox" : "raw")
    debugLog?.(`client+ ${opencodeBrowserSessionId ?? "raw"} total=${cdpClients.size}`)
    socket.on("message", (data) => {
      Effect.runPromise(shutdownControl.trackTransport(handleCdpMessage(socket, data.toString()))).catch((error: unknown) => {
        sendCdpResponse(socket, {
          id: 0,
          error: { message: error instanceof Error ? error.message : String(error) },
        })
      })
    })
    socket.on("error", (error) => {
      relayLog("client.error", { session: cdpClients.sessionId(socket), error: error.message, code: (error as NodeJS.ErrnoException).code })
    })
    socket.on("close", () => {
      debugLog?.(`client- ${cdpClients.sessionId(socket) ?? "raw"} total=${cdpClients.size - 1}`)
      cdpRuntime.disconnect(socket)
      const idleGeneration = cdpClients.unregister(socket)
      if (idleGeneration !== undefined && !shutdownControl.stopping) {
        Effect.runPromise(shutdownControl.trackTransport(cdpRuntime.disableIdle(() => cdpClients.isCurrentIdleGeneration(idleGeneration))).pipe(Effect.ignore)).catch((error: unknown) => {
          console.error("Failed to reset idle runtime domains", error)
        })
      }
    })
  })

  return { httpServer, websocketServer }
}
