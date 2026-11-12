import { cliCommand } from "../paths.ts"
import { defaultPort } from "./helpers.ts"
import {
  configuredRelayPort,
  endpointForPort,
  processAlive,
  readRelayState,
  resolveRelayPort,
} from "./port.ts"
import { relayAuthorization } from "./secrets.ts"
import { NodeHttpClient } from "@effect/platform-node"
import { Config, Context, Effect, Layer, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/http"
import {
  type AuthProfileRequest,
  type AuthenticatedJsonRequest,
  AuthenticatedJsonOutcome,
  AuthProfileSummary,
  type AuthRefreshRequest,
  type AuthRunRequest,
  AuthRunResponse,
  ErrorEnvelope,
  type ExecuteRequest,
  ExecuteResponse,
  ExtensionStatus,
  FlightRecorderCancelResponse,
  type FlightRecorderSaveRequest,
  FlightRecorderSaveResponse,
  type FlightRecorderStartRequest,
  FlightRecorderStatusResponse,
  NetworkCancelResponse,
  type NetworkSessionRequest,
  type NetworkStartRequest,
  NetworkStatusResponse,
  type NetworkStopRequest,
  NetworkStopResponse,
  RecordingCancelResponse,
  TabsCleanupResponse,
  SettingsGetResponse,
  SettingsSetResponse,
  type RecordingStartRequest,
  RecordingStartResponse,
  RecordingStatusResponse,
  RecordingStopResponse,
  type RecordingTargetRequest,
  RelayErrorCode,
  type RelayShutdownRequest,
  RelayShutdownResponse,
  RelayVersion,
  SessionAdoptResponse,
  SessionContainer,
  SessionDeleted,
  SessionResetResponse,
  SessionsContainer,
  TargetSummaries,
  type SessionAdoptRequest,
  type SessionSummary,
  type TargetSummary,
} from "./schema.ts"

/**
 * RelayClient is the single typed client for the relay HTTP API, shared by the
 * CLI and the MCP server. All responses are decoded against the shared wire
 * schemas in `src/relay-schema.ts`, and failures are tagged errors that keep
 * the relay's own error message as the top-level message.
 */

export const portConfig = Config.Int("OPENCODE_BROWSER_PORT").pipe(Config.withDefault(defaultPort))

/**
 * Extra `chrome-extension://<id>` origins to allowlist for the extension
 * WebSocket, comma- or whitespace-separated. This supports same-host unpacked
 * installs whose path-derived id cannot match the relay's bundled path. Parsed
 * by `parseAdditionalExtensionOrigins`.
 */
export const extensionOriginsConfig = Config.String("OPENCODE_BROWSER_EXTENSION_ORIGINS").pipe(Config.withDefault(""))

export { endpointForPort } from "./port.ts"

/** How long a read waits before this client has had any answer from the port, and after. See `make`. */
export const unknownRelayReadSeconds = 5
export const busyRelayReadSeconds = 30

export class RelayUnreachable extends Schema.TaggedError<RelayUnreachable>()(
  "RelayClient.RelayUnreachable",
  {
    message: Schema.String,
    endpoint: Schema.String,
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export class RelayRejected extends Schema.TaggedError<RelayRejected>()(
  "RelayClient.RelayRejected",
  {
    message: Schema.String,
    status: Schema.Number,
    path: Schema.String,
    code: Schema.optionalKey(RelayErrorCode),
  },
) {}

export class RelayTimedOut extends Schema.TaggedError<RelayTimedOut>()(
  "RelayClient.RelayTimedOut", { message: Schema.String, path: Schema.String },
) {}

export class RelayDecodeFailed extends Schema.TaggedError<RelayDecodeFailed>()(
  "RelayClient.RelayDecodeFailed",
  {
    message: Schema.String,
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {}

class RelayEncodeFailed extends Schema.TaggedError<RelayEncodeFailed>()(
  "RelayClient.RelayEncodeFailed",
  {
    message: Schema.String,
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export class RelayConfigInvalid extends Schema.TaggedError<RelayConfigInvalid>()(
  "RelayClient.RelayConfigInvalid",
  {
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export type RelayClientError = RelayUnreachable | RelayRejected | RelayDecodeFailed | RelayEncodeFailed | RelayTimedOut

export interface Interface {
  readonly endpoint: string
  readonly version: Effect.Effect<RelayVersion, RelayClientError>
  readonly shutdown: (request: RelayShutdownRequest) => Effect.Effect<RelayShutdownResponse, RelayClientError>
  readonly extensionStatus: Effect.Effect<ExtensionStatus, RelayClientError>
  readonly targets: Effect.Effect<readonly TargetSummary[], RelayClientError>
  readonly sessions: Effect.Effect<readonly SessionSummary[], RelayClientError>
  readonly sessionNew: (id?: string | undefined, options?: { readonly readOnly?: boolean; readonly allowedOrigins?: readonly string[]; readonly browser?: string }) => Effect.Effect<SessionSummary, RelayClientError>
  /** Replace a session's allowed origins; an empty list removes the allowlist. */
  readonly sessionAllowlist: (id: string, allowedOrigins: readonly string[]) => Effect.Effect<SessionSummary, RelayClientError>
  readonly sessionEnsure: (id: string, options?: { readonly readOnly?: boolean }) => Effect.Effect<SessionSummary, RelayClientError>
  readonly sessionReset: (id: string) => Effect.Effect<SessionResetResponse, RelayClientError>
  readonly sessionAdopt: (request: SessionAdoptRequest) => Effect.Effect<SessionAdoptResponse, RelayClientError>
  readonly sessionDelete: (id: string) => Effect.Effect<SessionDeleted, RelayClientError>
  readonly execute: (request: ExecuteRequest) => Effect.Effect<ExecuteResponse, RelayClientError>
  readonly authenticatedJson: (request: AuthenticatedJsonRequest) => Effect.Effect<AuthenticatedJsonOutcome, RelayClientError>
  readonly networkStart: (request: NetworkStartRequest) => Effect.Effect<NetworkStatusResponse, RelayClientError>
  readonly networkStatus: (request: NetworkSessionRequest) => Effect.Effect<NetworkStatusResponse, RelayClientError>
  readonly networkStop: (request: NetworkStopRequest) => Effect.Effect<NetworkStopResponse, RelayClientError>
  readonly networkCancel: (request: NetworkSessionRequest) => Effect.Effect<NetworkCancelResponse, RelayClientError>
  readonly authStatus: (request: AuthProfileRequest) => Effect.Effect<AuthProfileSummary, RelayClientError>
  readonly authRefresh: (request: AuthRefreshRequest) => Effect.Effect<NetworkStopResponse, RelayClientError>
  readonly authRun: (request: AuthRunRequest) => Effect.Effect<AuthRunResponse, RelayClientError>
  readonly recordingStart: (request: RecordingStartRequest) => Effect.Effect<RecordingStartResponse, RelayClientError>
  readonly recordingStop: (target: RecordingTargetRequest) => Effect.Effect<RecordingStopResponse, RelayClientError>
  readonly recordingStatus: (target: RecordingTargetRequest) => Effect.Effect<RecordingStatusResponse, RelayClientError>
  readonly recordingCancel: (target: RecordingTargetRequest) => Effect.Effect<RecordingCancelResponse, RelayClientError>
  /** With `sessions`, `idleMinutes` applies only to those sessions' tabs; other tabs also wait for the user's setting. */
  readonly tabsCleanup: (idleMinutes?: number, sessions?: readonly string[]) => Effect.Effect<TabsCleanupResponse, RelayClientError>
  /** The user's settings (the extension's options page), with env overrides. */
  readonly settingsGet: Effect.Effect<SettingsGetResponse, RelayClientError>
  /** Changes settings; validated strictly by the relay. */
  readonly settingsSet: (changes: Record<string, unknown>) => Effect.Effect<SettingsSetResponse, RelayClientError>
  readonly flightRecorderStart: (request: FlightRecorderStartRequest) => Effect.Effect<FlightRecorderStatusResponse, RelayClientError>
  readonly flightRecorderStatus: (target: RecordingTargetRequest) => Effect.Effect<FlightRecorderStatusResponse, RelayClientError>
  readonly flightRecorderSaveLast: (request: FlightRecorderSaveRequest) => Effect.Effect<FlightRecorderSaveResponse, RelayClientError>
  readonly flightRecorderCancel: (target: RecordingTargetRequest) => Effect.Effect<FlightRecorderCancelResponse, RelayClientError>
}

export class Service extends Context.Service<Service, Interface>()("opencode-browser-cli/RelayClient") {}

const decodeErrorEnvelope = Schema.decodeUnknownOption(ErrorEnvelope)
const decodeErrorMessage = Schema.decodeUnknownOption(Schema.Struct({ error: Schema.String }))

export const make = Effect.fn("RelayClient.make")(function* (options?: {
  readonly endpoint?: string
  /** Sent as OpenCode-Browser-Client-Pid so the relay can end a capture or an implicit session once this process is gone. */
  readonly clientPid?: number
}) {
  // Validate OPENCODE_BROWSER_PORT as before; the endpoint itself is resolved on every request so a relay that moved
  // to a fallback port is found without recreating this client (relay/port.ts).
  yield* portConfig.pipe(
    Effect.mapError((cause) => new RelayConfigInvalid({
      message: `Invalid OPENCODE_BROWSER_PORT configuration: ${cause.message}`,
      cause,
    })),
  )
  const currentEndpoint = (): string => options?.endpoint ?? endpointForPort(resolveRelayPort())
  const httpClient = yield* HttpClient.HttpClient

  const readBody = (
    response: HttpClientResponse.HttpClientResponse,
    path: string,
  ): Effect.Effect<unknown, RelayDecodeFailed> =>
    response.json.pipe(
      Effect.mapError((cause) =>
        new RelayDecodeFailed({
          message: `Relay returned an unreadable response for ${path}`,
          path,
          cause,
        })
      ),
    )

  const handleResponse = <A>(
    response: HttpClientResponse.HttpClientResponse,
    path: string,
    schema: Schema.ConstraintDecoder<A>,
  ): Effect.Effect<A, RelayClientError> =>
    readBody(response, path).pipe(
      Effect.flatMap((body): Effect.Effect<A, RelayClientError> => {
        if (response.status < 200 || response.status >= 300) {
          const envelope = decodeErrorEnvelope(body)
          const message = Option.isSome(envelope)
            ? envelope.value.error
            : Option.getOrElse(Option.map(decodeErrorMessage(body), (value) => value.error), () => `Relay responded with HTTP ${response.status} for ${path}`)
          return Effect.fail(new RelayRejected({
            message,
            status: response.status,
            path,
            ...(Option.isSome(envelope) && envelope.value.code ? { code: envelope.value.code } : {}),
          }))
        }
        return Schema.decodeUnknownEffect(schema)(body).pipe(
          Effect.mapError((cause) =>
            new RelayDecodeFailed({
              message: `Relay response for ${path} did not match the expected shape: ${cause.message}`,
              path,
              cause,
            })
          ),
        )
      }),
    )

  const transportError = (path: string) => (cause: unknown) => {
    const endpoint = currentEndpoint()
    return new RelayUnreachable({
      message: `browse relay is not reachable at ${endpoint}. Relay-backed CLI commands start it automatically; use \`${cliCommand("serve")}\` only for foreground debugging.`,
      endpoint,
      path,
      cause,
    })
  }

  const isRelayClientError = (error: unknown): error is RelayClientError =>
    error instanceof RelayUnreachable ||
    error instanceof RelayRejected ||
    error instanceof RelayDecodeFailed ||
    error instanceof RelayEncodeFailed ||
    error instanceof RelayTimedOut

  // The relay rejects requests without this install's token (relay-secrets.ts). Read once it exists; a relay
  // started by this client creates it, so a failed read is retried on the next request.
  let authorization: string | undefined
  const authorize = (request: HttpClientRequest.HttpClientRequest): HttpClientRequest.HttpClientRequest => {
    try {
      authorization ??= relayAuthorization()
    } catch {
      return request
    }
    const authorized = HttpClientRequest.setHeader(request, "authorization", authorization)
    return options?.clientPid === undefined ? authorized : HttpClientRequest.setHeader(authorized, "opencode-browser-client-pid", String(options.clientPid))
  }

  // Every session's execute code shares the relay's event loop, so under load even /version can wait several seconds
  // for its turn. Until this client has had any answer on the port, a stalled read means a frozen relay or another
  // program, and fails fast. Once the relay has answered, a stalled read is most likely a busy relay, so it waits longer.
  let relayAnswered = false
  // The open version probe never carries the relay token (or this client's pid): another program holding the port
  // must not receive either. See `version` and the fallback probe in relay/port.ts.
  const executeUnauthorized = (path: string, request: HttpClientRequest.HttpClientRequest) =>
    httpClient.execute(request).pipe(
      Effect.mapError(transportError(path)),
      Effect.tap(() => Effect.sync(() => { relayAnswered = true })),
    )

  type VerifiedEndpoint = {
    readonly endpoint: string
    readonly instanceId: string
    /** relay.json's instance when this proof was made, so a file that later disappears forces another probe. */
    readonly recorded: string | undefined
  }
  let verified: VerifiedEndpoint | undefined

  const notBrowse = (endpoint: string, cause: unknown) =>
    new RelayDecodeFailed({
      message: `Relay port ${new URL(endpoint).port} is in use by another program (not a browse /version response).`,
      path: "/version",
      cause,
    })

  /**
   * relay.json for the configured port when its process is alive. One read per verification: a live file naming
   * another port, or another instance, means the endpoint under test is not this install's relay.
   */
  const liveRelayState = () => {
    try {
      const state = readRelayState()
      return state && state.configuredPort === configuredRelayPort() && processAlive(state.pid) ? state : undefined
    } catch {
      return undefined
    }
  }

  // Bearer tokens only go to a port whose open /version proved it is this install's browse relay. Verified once per
  // resolved endpoint (and instance), never for an endpoint that changed underneath this client.
  const verifyEndpoint = (
    endpoint: string,
    state: ReturnType<typeof liveRelayState> = liveRelayState(),
  ): Effect.Effect<VerifiedEndpoint, RelayClientError> =>
    Effect.suspend(() => {
      const seconds = relayAnswered ? busyRelayReadSeconds : unknownRelayReadSeconds
      return executeUnauthorized("/version", HttpClientRequest.get(new URL("/version", endpoint))).pipe(
        Effect.flatMap((response) => readBody(response, "/version").pipe(Effect.map((body) => ({ response, body })))),
        Effect.flatMap(({ response, body }): Effect.Effect<VerifiedEndpoint, RelayClientError> => {
          const reply = typeof body === "object" && body !== null ? body as Record<string, unknown> : undefined
          // A relay that is still starting answers 503 like handleResponse does, not as another program.
          if (response.status === 503 && reply?.code === "relay-starting") {
            const envelope = decodeErrorEnvelope(body)
            return Effect.fail(new RelayRejected({
              message: Option.isSome(envelope) ? envelope.value.error : "Relay responded with HTTP 503 for /version",
              status: 503,
              path: "/version",
              code: "relay-starting",
            }))
          }
          if (
            response.status !== 200 ||
            typeof reply?.version !== "string" ||
            typeof reply.instanceId !== "string"
          ) return Effect.fail(notBrowse(endpoint, body))
          // A live relay.json for this install is authoritative: the verified port and instance must be exactly its.
          if (state !== undefined && (state.port !== Number(new URL(endpoint).port) || state.instanceId !== reply.instanceId))
            return Effect.fail(notBrowse(endpoint, body))
          return Effect.succeed({ endpoint, instanceId: reply.instanceId, recorded: state?.instanceId })
        }),
        Effect.timeoutOrElse({
          duration: `${seconds} seconds`,
          orElse: () => Effect.fail(new RelayTimedOut({
            message: `The relay on port ${new URL(endpoint).port} isn't answering (/version timed out after ${seconds}s).`, path: "/version",
          })),
        }),
      )
    })

  const ensureVerified = (endpoint: string): Effect.Effect<void, RelayClientError> => {
    const state = liveRelayState()
    const port = Number(new URL(endpoint).port)
    // A proof is reused only for the same live relay.json state: a live file for this port and instance, or no live
    // file at proof time and still none. Anything else re-probes (and then fails if the file names another relay).
    if (
      verified?.endpoint === endpoint &&
      ((state !== undefined && state.port === port && state.instanceId === verified.instanceId) ||
        (state === undefined && verified.recorded === undefined))
    ) return Effect.void
    return verifyEndpoint(endpoint, state).pipe(Effect.tap((value) => Effect.sync(() => { verified = value })), Effect.asVoid)
  }

  /**
   * A request that carries the relay token, after the very endpoint in its URL proved itself. The endpoint is never
   * resolved again here: a relay.json change between building the request and sending it must not move the token (or
   * the proof) to another port. A transport failure drops the proof.
   */
  const executeAuthorized = (endpoint: string, path: string, request: HttpClientRequest.HttpClientRequest) =>
    Effect.suspend(() => {
      // The request's own origin is the only place this token may go.
      const target = new URL(request.url).origin
      if (target !== new URL(endpoint).origin) {
        return Effect.fail(new RelayDecodeFailed({
          message: `Refusing to send the relay request for ${path} to ${target}: it was built for ${endpoint}.`,
          path,
          cause: request.url,
        }))
      }
      return ensureVerified(target).pipe(
        Effect.flatMap(() => httpClient.execute(authorize(request))),
        Effect.mapError((error) => isRelayClientError(error) ? error : transportError(path)(error)),
        Effect.tap(() => Effect.sync(() => { relayAnswered = true })),
        Effect.tapError((error) => Effect.sync(() => {
          if (error instanceof RelayUnreachable && verified?.endpoint === target) verified = undefined
        })),
      )
    })

  const requestJson = <A>(
    path: string,
    schema: Schema.ConstraintDecoder<A>,
  ): Effect.Effect<{ readonly value: A; readonly endpoint: string }, RelayClientError> =>
    Effect.suspend(() => {
      const endpoint = currentEndpoint()
      const seconds = relayAnswered ? busyRelayReadSeconds : unknownRelayReadSeconds
      const request = HttpClientRequest.get(new URL(path, endpoint))
      const send = path === "/version" ? executeUnauthorized(path, request) : executeAuthorized(endpoint, path, request)
      return send.pipe(
        Effect.flatMap((response) => handleResponse(response, path, schema).pipe(
          Effect.map((value) => ({ value, endpoint })),
        )),
        Effect.timeoutOrElse({ duration: `${seconds} seconds`, orElse: () => Effect.fail(new RelayTimedOut({
          message: `The relay on port ${new URL(endpoint).port} isn't answering (${path} timed out after ${seconds}s).`, path,
        })) }),
      )
    })

  const getJson = <A>(path: string, schema: Schema.ConstraintDecoder<A>): Effect.Effect<A, RelayClientError> =>
    requestJson(path, schema).pipe(Effect.map(({ value }) => value))

  // Writes can legitimately wait for a human handoff or a command with no deadline. Probe the relay while waiting,
  // rather than shortening those operations or retrying a write whose outcome we don't know.
  const checkWhileWaiting = Effect.sleep(30_000).pipe(Effect.andThen(getJson("/version", RelayVersion)), Effect.forever)

  const postJson = <A>(
    path: string,
    body: Record<string, unknown>,
    schema: Schema.ConstraintDecoder<A>,
  ): Effect.Effect<A, RelayClientError> => Effect.suspend(() => {
    const endpoint = currentEndpoint()
    return HttpClientRequest.post(new URL(path, endpoint)).pipe(
      HttpClientRequest.bodyJson(body),
      Effect.mapError((cause) => new RelayEncodeFailed({
        message: `Could not encode relay request for ${path}`,
        path,
        cause,
      })),
      Effect.flatMap((request) => executeAuthorized(endpoint, path, request).pipe(
        Effect.flatMap((response) => handleResponse(response, path, schema)),
        Effect.raceFirst(checkWhileWaiting),
      )),
    )
  })

  const recordingTargetBody = (target: { readonly sessionId?: string | undefined; readonly tabId?: number | undefined }): Record<string, unknown> => ({
    ...(target.sessionId ? { sessionId: target.sessionId } : {}),
    ...(target.tabId === undefined ? {} : { tabId: target.tabId }),
  })

  const recordingTargetQuery = (target: RecordingTargetRequest): string => {
    const searchParams = new URLSearchParams()
    if (target.sessionId) {
      searchParams.set("sessionId", target.sessionId)
    }
    if (target.tabId !== undefined) {
      searchParams.set("tabId", String(target.tabId))
    }
    const text = searchParams.toString()
    return text ? `?${text}` : ""
  }

  return Service.of({
    get endpoint() {
      return currentEndpoint()
    },
    version: Effect.suspend(() => {
      const state = liveRelayState()
      return requestJson("/version", RelayVersion).pipe(
        // Another product on the port (Playwriter answers `{ version }` alone): without browse's instanceId this is not
        // a browse relay, and must never be mistaken for one. Same path as any other foreign listener.
        Effect.flatMap(({ value: version, endpoint }): Effect.Effect<RelayVersion, RelayClientError> => {
          const instanceId = version.instanceId
          if (typeof instanceId !== "string") return Effect.fail(notBrowse(endpoint, version))
          if (state !== undefined && (state.port !== Number(new URL(endpoint).port) || state.instanceId !== instanceId))
            return Effect.fail(notBrowse(endpoint, version))
          // The open /version just proved this endpoint, so an authorized request may use it without probing again.
          // relay.json's instance is stored with the proof, so its later disappearance forces a new probe.
          return Effect.sync(() => {
            verified = { endpoint, instanceId, recorded: state?.instanceId }
            return version
          })
        }),
        Effect.mapError((error) =>
          error instanceof RelayDecodeFailed || (error instanceof RelayRejected && !error.code && error.status === 404)
            ? new RelayDecodeFailed({ message: `Relay port ${new URL(currentEndpoint()).port} is in use by another program (not a browse /version response).`, path: "/version", cause: error })
            : error),
      )
    }),
    shutdown: (request) => postJson("/shutdown", { ...request }, RelayShutdownResponse),
    extensionStatus: getJson("/extension/status", ExtensionStatus),
    targets: getJson("/json/list", TargetSummaries),
    sessions: getJson("/cli/sessions", SessionsContainer).pipe(Effect.map((container) => container.sessions)),
    sessionNew: (id, options) =>
      postJson("/cli/session/new", {
        ...(id ? { id } : {}),
        ...(options?.readOnly ? { readOnly: true } : {}),
        ...(options?.allowedOrigins && options.allowedOrigins.length > 0 ? { allowedOrigins: [...options.allowedOrigins] } : {}),
        ...(options?.browser ? { browser: options.browser } : {}),
      }, SessionContainer).pipe(Effect.map((container) => container.session)),
    sessionAllowlist: (id, allowedOrigins) =>
      postJson("/cli/session/allowlist", { id, allowedOrigins: [...allowedOrigins] }, SessionContainer).pipe(Effect.map((container) => container.session)),
    sessionEnsure: (id, options) =>
      postJson("/v1/sessions/ensure", {
        id,
        ...(options?.readOnly === undefined ? {} : { readOnly: options.readOnly }),
      }, SessionContainer).pipe(Effect.map((container) => container.session)),
    sessionReset: (id) =>
      postJson("/cli/session/reset", { id }, SessionResetResponse),
    sessionAdopt: ({ sessionId, ...request }) =>
      postJson("/cli/session/adopt", {
        ...request,
        ...(sessionId ? { sessionId } : {}),
      }, SessionAdoptResponse),
    sessionDelete: (id) => postJson("/cli/session/delete", { id }, SessionDeleted),
    execute: ({ sessionId, ...request }) =>
      postJson("/cli/execute", {
        ...request,
        ...(sessionId ? { sessionId } : {}),
      }, ExecuteResponse),
    authenticatedJson: (request) => postJson("/v1/authenticated-origin/json", { ...request }, AuthenticatedJsonOutcome),
    networkStart: (request) => postJson("/network/start", { ...request }, NetworkStatusResponse),
    networkStatus: (request) => postJson("/network/status", { ...request }, NetworkStatusResponse),
    networkStop: (request) => postJson("/network/stop", { ...request }, NetworkStopResponse),
    networkCancel: (request) => postJson("/network/cancel", { ...request }, NetworkCancelResponse),
    authStatus: (request) => postJson("/auth/status", { ...request }, AuthProfileSummary),
    authRefresh: (request) => postJson("/auth/refresh", { ...request }, NetworkStopResponse),
    authRun: (request) => postJson("/auth/run", { ...request }, AuthRunResponse),
    recordingStart: ({ sessionId, tabId, ...request }) =>
      postJson("/recording/start", { ...recordingTargetBody({ sessionId, tabId }), ...request }, RecordingStartResponse),
    recordingStop: (target) => postJson("/recording/stop", recordingTargetBody(target), RecordingStopResponse),
    recordingStatus: (target) => getJson(`/recording/status${recordingTargetQuery(target)}`, RecordingStatusResponse),
    recordingCancel: (target) => postJson("/recording/cancel", recordingTargetBody(target), RecordingCancelResponse),
    tabsCleanup: (idleMinutes, sessions) =>
      postJson("/tabs/cleanup", { ...(idleMinutes === undefined ? {} : { idleMinutes }), ...(sessions ? { sessions } : {}) }, TabsCleanupResponse),
    settingsGet: getJson("/settings", SettingsGetResponse),
    settingsSet: (changes) => postJson("/settings", { set: changes }, SettingsSetResponse),
    flightRecorderStart: ({ sessionId, tabId, ...request }) =>
      postJson("/flight-recorder/start", { ...recordingTargetBody({ sessionId, tabId }), ...request }, FlightRecorderStatusResponse),
    flightRecorderStatus: (target) => getJson(`/flight-recorder/status${recordingTargetQuery(target)}`, FlightRecorderStatusResponse),
    flightRecorderSaveLast: ({ sessionId, tabId, ...request }) =>
      postJson("/flight-recorder/save-last", { ...recordingTargetBody({ sessionId, tabId }), ...request }, FlightRecorderSaveResponse),
    flightRecorderCancel: (target) => postJson("/flight-recorder/cancel", recordingTargetBody(target), FlightRecorderCancelResponse),
  })
})

const layer: Layer.Layer<Service, RelayConfigInvalid, HttpClient.HttpClient> = Layer.effect(Service, make())

/** RelayClient backed by `node:http` (avoiding undici's 5-minute headersTimeout on long handoffs/commands), for standalone CLI/MCP wiring. */
export const layerFetch: Layer.Layer<Service, RelayConfigInvalid> = layer.pipe(Layer.provide(NodeHttpClient.layerNodeHttp))

/**
 * The process the relay watches for this MCP server: the MCP supervisor when it runs one (it outlives
 * the servers it swaps on an update, so the session and its tabs survive), else this process.
 */
function mcpClientPid(): number {
  const shim = Number(process.env.OPENCODE_BROWSER_CLIENT_PID)
  return Number.isSafeInteger(shim) && shim > 1 && shim === process.ppid ? shim : process.pid
}

/** layerFetch for the MCP server, which names its process to the relay (see `make`). */
export const layerFetchMcp: Layer.Layer<Service, RelayConfigInvalid> = Layer.effect(Service, make({ clientPid: mcpClientPid() })).pipe(
  Layer.provide(NodeHttpClient.layerNodeHttp),
)
