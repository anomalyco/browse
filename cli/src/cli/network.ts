import { Console, Effect, Option } from "effect"
import { Command, Flag } from "effect/cli"
import * as RelayClient from "../relay/client.ts"
import type { NetworkStatusResponse, NetworkStopResponse } from "../relay/schema.ts"
import {
  ensureCliRelay,
  ensureCliRelayAndExtension,
  jsonFlag,
  networkSession,
  printOr,
  sessionFlag,
} from "./context.ts"
import { registerCliCommand } from "./registry.ts"

function formatNetworkStatus(status: NetworkStatusResponse): string {
  if (!status.active)
    return status.ended
      ? `Network capture: inactive (the last one ended because ${status.ended})`
      : "Network capture: inactive"
  return `Network capture: active entries=${status.entryCount} responses=${status.responseCount} failures=${status.failureCount} bodyBytes=${status.capturedBodyBytes} truncated=${status.truncatedBodyCount} dropped=${status.droppedEntryCount} startedAt=${status.startedAt ?? "unknown"}${status.endsAt ? ` endsAt=${status.endsAt}` : ""}`
}

function formatNetworkResult(result: NetworkStopResponse): string {
  return `Network capture stopped: exchanges=${result.exchanges.length} entries=${result.entryCount} responses=${result.responseCount} failures=${result.failureCount} bodyBytes=${result.capturedBodyBytes} truncated=${result.truncatedBodyCount} dropped=${result.droppedEntryCount}`
}

const networkStart = Command.make(
  "start",
  {
    session: sessionFlag("Capture the default page for this browse session"),
    urlFilter: Flag.String("url").pipe(
      Flag.optional,
      Flag.withDescription("Capture only requests whose URL contains this text"),
    ),
    json: jsonFlag,
  },
  Effect.fn("Cli.networkStart")(function* ({ session, urlFilter, json }) {
    const relay = yield* RelayClient.Service
    yield* ensureCliRelayAndExtension()
    const sessionId = yield* networkSession(session)
    const result = yield* relay.networkStart({
      sessionId,
      ...(Option.isSome(urlFilter) ? { urlFilter: urlFilter.value } : {}),
    })
    yield* printOr(json, result, formatNetworkStatus(result))
  }),
).pipe(Command.withDescription("Start session-scoped network capture"))

const networkStatus = Command.make(
  "status",
  {
    session: sessionFlag(),
    json: jsonFlag,
  },
  Effect.fn("Cli.networkStatus")(function* ({ session, json }) {
    const relay = yield* RelayClient.Service
    const sessionId = yield* networkSession(session)
    yield* ensureCliRelay()
    const result = yield* relay.networkStatus({ sessionId })
    yield* printOr(json, result, formatNetworkStatus(result))
  }),
).pipe(Command.withDescription("Show session-scoped network capture status"))

const networkStop = Command.make(
  "stop",
  {
    session: sessionFlag(),
    json: jsonFlag,
  },
  Effect.fn("Cli.networkStop")(function* ({ session, json }) {
    const relay = yield* RelayClient.Service
    const sessionId = yield* networkSession(session)
    yield* ensureCliRelay()
    const result = yield* relay.networkStop({ sessionId })
    yield* printOr(json, result, formatNetworkResult(result))
  }),
).pipe(Command.withDescription("Stop capture and return the redacted exchanges"))

const networkCancel = Command.make(
  "cancel",
  { session: sessionFlag() },
  Effect.fn("Cli.networkCancel")(function* ({ session }) {
    const relay = yield* RelayClient.Service
    const sessionId = yield* networkSession(session)
    yield* ensureCliRelay()
    const result = yield* relay.networkCancel({ sessionId })
    yield* Console.log(result.cancelled ? "Network capture cancelled" : "Network capture was not active")
  }),
).pipe(Command.withDescription("Cancel capture without returning its exchanges"))

const network = Command.make("network").pipe(
  Command.withDescription("Capture authenticated network exchanges for direct client derivation"),
  Command.withSubcommands([networkStart, networkStatus, networkStop, networkCancel]),
)

registerCliCommand(600, () => network)
