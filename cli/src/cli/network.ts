import { Console, Effect, Option } from "effect"
import { Command, Flag } from "effect/cli"
import path from "node:path"
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

const parseNetworkContent = Effect.fnUntraced(function* (content: Option.Option<string>) {
  const value = Option.getOrUndefined(content)
  if (value === undefined || value === "embed" || value === "omit") return value
  return yield* Effect.fail(new Error("Network content must be embed or omit"))
})

function formatNetworkStatus(status: NetworkStatusResponse): string {
  if (!status.active)
    return status.ended
      ? `Network capture: inactive (the last one ended because ${status.ended})`
      : "Network capture: inactive"
  return `Network capture: active entries=${status.entryCount} responses=${status.responseCount} failures=${status.failureCount} bodyBytes=${status.capturedBodyBytes} truncated=${status.truncatedBodyCount} dropped=${status.droppedEntryCount} startedAt=${status.startedAt ?? "unknown"}${status.endsAt ? ` endsAt=${status.endsAt}` : ""}`
}

function formatNetworkResult(result: NetworkStopResponse): string {
  const output = result.outputPath ? ` output=${result.outputPath}` : ""
  const profile = result.authProfile ? ` secrets=${result.authProfile.name}(${result.authProfile.slotCount})` : ""
  return `Network capture stopped: entries=${result.entryCount} responses=${result.responseCount} failures=${result.failureCount} bodyBytes=${result.capturedBodyBytes} truncated=${result.truncatedBodyCount} dropped=${result.droppedEntryCount}${output}${profile}`
}

const networkStart = Command.make(
  "start",
  {
    session: sessionFlag("Capture the default page for this Browse session"),
    urlFilter: Flag.String("url").pipe(
      Flag.optional,
      Flag.withDescription("Capture only requests whose URL contains this text"),
    ),
    resourceTypes: Flag.String("resource-type").pipe(
      Flag.atMost(50),
      Flag.withDescription("Capture this Playwright resource type; repeat for multiple types"),
    ),
    content: Flag.String("content").pipe(
      Flag.optional,
      Flag.withDescription("Response and request body mode: embed (default) or omit"),
    ),
    maxBodyBytes: Flag.Int("max-body-bytes").pipe(
      Flag.optional,
      Flag.withDescription("Maximum captured bytes per body, defaults to 1000000"),
    ),
    maxTotalBodyBytes: Flag.Int("max-total-body-bytes").pipe(
      Flag.optional,
      Flag.withDescription("Maximum captured body bytes for the whole capture, defaults to 25000000"),
    ),
    maxEntries: Flag.Int("max-entries").pipe(
      Flag.optional,
      Flag.withDescription("Maximum request entries, defaults to 1000"),
    ),
    maxDuration: Flag.Int("max-duration-ms").pipe(
      Flag.optional,
      Flag.withDescription("End the capture by itself (discarding it) after this long, defaults to 1800000 (30 minutes)"),
    ),
    json: jsonFlag,
  },
  Effect.fn("Cli.networkStart")(function* ({
    session,
    urlFilter,
    resourceTypes,
    content,
    maxBodyBytes,
    maxTotalBodyBytes,
    maxEntries,
    maxDuration,
    json,
  }) {
    const relay = yield* RelayClient.Service
    yield* ensureCliRelayAndExtension()
    const sessionId = yield* networkSession(session)
    const contentValue = yield* parseNetworkContent(content)
    const result = yield* relay.networkStart({
      sessionId,
      ...(Option.isSome(urlFilter) ? { urlFilter: urlFilter.value } : {}),
      ...(resourceTypes.length === 0 ? {} : { resourceTypes }),
      ...(contentValue === undefined ? {} : { content: contentValue }),
      ...(Option.isSome(maxBodyBytes) ? { maxBodyBytes: maxBodyBytes.value } : {}),
      ...(Option.isSome(maxTotalBodyBytes) ? { maxTotalBodyBytes: maxTotalBodyBytes.value } : {}),
      ...(Option.isSome(maxEntries) ? { maxEntries: maxEntries.value } : {}),
      ...(Option.isSome(maxDuration) ? { maxDurationMs: maxDuration.value } : {}),
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
    output: Flag.String("output").pipe(
      Flag.optional,
      Flag.withAlias("o"),
      Flag.withDescription("Write a credential-redacted HAR artifact to this path"),
    ),
    secrets: Flag.String("secrets").pipe(
      Flag.optional,
      Flag.withDescription("Store captured credentials under this reusable profile name"),
    ),
    json: jsonFlag,
  },
  Effect.fn("Cli.networkStop")(function* ({ session, output, secrets, json }) {
    const relay = yield* RelayClient.Service
    const outputValue = Option.getOrUndefined(output)
    const secretsValue = Option.getOrUndefined(secrets)
    if (!outputValue && !secretsValue) {
      return yield* Effect.fail(new Error("network stop requires --output, --secrets, or both"))
    }
    const sessionId = yield* networkSession(session)
    yield* ensureCliRelay()
    const result = yield* relay.networkStop({
      sessionId,
      ...(outputValue ? { outputPath: path.resolve(outputValue) } : {}),
      ...(secretsValue ? { secrets: secretsValue } : {}),
    })
    yield* printOr(json, result, formatNetworkResult(result))
  }),
).pipe(Command.withDescription("Stop capture and write a redacted artifact or reusable secret profile"))

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
).pipe(Command.withDescription("Cancel capture without writing an artifact"))

const network = Command.make("network").pipe(
  Command.withDescription("Capture authenticated network exchanges for direct client derivation"),
  Command.withSubcommands([networkStart, networkStatus, networkStop, networkCancel]),
)

registerCliCommand(600, () => network)
