import { Config, Console, Effect, Option, Predicate } from "effect"
import { Flag } from "effect/cli"
import process from "node:process"
import { ExitCode, printJson, takeJsonFlag } from "./output.ts"
import { ensureSessionExists as ensureRelaySessionExists } from "../mcp/schema.ts"
import * as RelayClient from "../relay/client.ts"
import { isValidSessionId } from "../relay/helpers.ts"
import * as RelayLifecycle from "../relay/lifecycle.ts"
import type { RecordingQuality } from "../relay/schema.ts"
import * as SessionStore from "../session-manager/store.ts"

export const sessionIdConfig = Config.option(Config.String("OPENCODE_BROWSER_SESSION"))
export const agentSessionIdConfig = Config.option(Config.String("OPENCODE_SESSION_ID"))
export const targetUrlConfig = Config.option(Config.String("OPENCODE_BROWSER_TARGET_URL"))
export const targetIndexConfig = Config.option(Config.Int("OPENCODE_BROWSER_TARGET_INDEX"))
export const encodedCliOperandsMarker = "bc-cli-operands:v1"
export const encodedCliOperandPrefix = "bc-cli-operand:"
export const jsonFlag = Flag.Boolean("json").pipe(
  Flag.withDefault(false),
  Flag.withDescription("Print machine-readable JSON"),
)

export const sessionFlag = (description?: string) => {
  const flag = Flag.String("session").pipe(Flag.optional, Flag.withAlias("s"))
  return description ? flag.pipe(Flag.withDescription(description)) : flag
}

export const tabIdFlag = (description?: string) => {
  const flag = Flag.Int("tab-id").pipe(Flag.optional)
  return description ? flag.pipe(Flag.withDescription(description)) : flag
}

export const failExit = Effect.sync(() => {
  process.exitCode = ExitCode.failure
})

export const exitWith = (code: number) =>
  Effect.sync(() => {
    process.exitCode = code
  })

const hostErrorTags = new Set([
  "RelayClient.RelayUnreachable",
  "RelayLifecycle.RelayStartFailed",
  "RelayLifecycle.ExtensionDisconnected",
])

/** Exit 4 when the relay or extension cannot be reached, otherwise 1. */
export function exitCodeForError(error: unknown): number {
  if (error instanceof RelayClient.RelayRejected && error.code === "browser-unavailable") return ExitCode.host
  const tag = Predicate.isObject(error) && Predicate.hasProperty(error, "_tag") ? error._tag : undefined
  return Predicate.isString(tag) && hostErrorTags.has(tag) ? ExitCode.host : ExitCode.failure
}

/** `--json` may come before the subcommand, which Effect CLI rejects, so move it after the command's own arguments. */
export function hoistJsonFlag(args: ReadonlyArray<string>): {
  readonly json: boolean
  readonly argv: ReadonlyArray<string>
} {
  const delimiter = args.indexOf("--")
  const { json, argv } = takeJsonFlag(delimiter === -1 ? args : args.slice(0, delimiter))
  if (!json) return { json, argv: args }
  return { json, argv: [...argv, "--json", ...(delimiter === -1 ? [] : args.slice(delimiter))] }
}

// Written directly so the line survives --json mode, where Console.log is silenced.
export const stderrLine = (message: string) =>
  Effect.sync(() => {
    process.stderr.write(`opencode-browser: ${message.split("\n")[0]!.slice(0, 300)}\n`)
  })
export const emitJson = (value: unknown) => Effect.sync(() => printJson(value))
export const printOr = (json: boolean, value: unknown, text: string) => (json ? emitJson(value) : Console.log(text))

// OpenCode ids are mixed-case; relay session ids must be lowercase (journal dirs live on case-insensitive disks).
export function agentDefaultSessionId(agentSessionId: string | undefined): string | undefined {
  const id = agentSessionId ? `oc-${agentSessionId.toLowerCase()}` : undefined
  return id && isValidSessionId(id) ? id : undefined
}

export function resolveExplicitSessionSelector(options: {
  readonly positional: string | undefined
  readonly flag: string | undefined
  readonly environment: string | undefined
}): string | undefined {
  if (options.positional && options.flag) {
    throw new Error("Use either a positional session id or --session, not both")
  }
  return options.flag ?? options.positional ?? options.environment
}

export function formatRecordingQuality(quality: RecordingQuality | undefined): string {
  if (!quality) return "Capture quality: unavailable (tab capture or older relay)."
  return [
    `Capture: ${quality.width}×${quality.height}, output ${quality.frameRate} fps; source surface ${quality.sourceWidth ?? "?"}×${quality.sourceHeight ?? "?"} CSS px`,
    `Source frames: ${quality.sourceFrameCount} received (${quality.achievedSourceFrameRate.toFixed(1)}/s), ${quality.encodedSourceFrameCount} retained (${quality.achievedEncodedSourceFrameRate.toFixed(1)}/s), ${quality.coalescedFrameCount} coalesced, ${quality.droppedFrameCount} dropped`,
    quality.screenshotFallback
      ? "WARNING: no compositor frames arrived; this video holds a single stop-time screenshot."
      : "Source counts are compositor events, not a measurement of distinct motion. Inspect the video before sharing.",
  ].join("\n")
}

export function normalizeCliArguments(args: ReadonlyArray<string>): ReadonlyArray<string> {
  const delimiter = args.indexOf("--")
  const secretsRun = args.findIndex((argument, index) => argument === "secrets" && args[index + 1] === "run")
  if (delimiter === -1 || secretsRun === -1 || secretsRun > delimiter) return args
  return [
    ...args.slice(0, delimiter),
    encodedCliOperandsMarker,
    ...args.slice(delimiter + 1).map((operand) => `${encodedCliOperandPrefix}${encodeURIComponent(operand)}`),
  ]
}

export function decodeCliOperands(operands: ReadonlyArray<string>): ReadonlyArray<string> {
  if (operands[0] !== encodedCliOperandsMarker) return operands
  return operands.slice(1).map((operand) => {
    if (!operand.startsWith(encodedCliOperandPrefix)) throw new Error("Invalid encoded secrets run operand")
    return decodeURIComponent(operand.slice(encodedCliOperandPrefix.length))
  })
}

export function formatSessionContinuation(sessionId: string): string {
  return `Session: ${sessionId}. Continue with --session ${sessionId}.`
}

export const ensureCliRelay = Effect.fnUntraced(function* () {
  const relay = yield* RelayClient.Service
  const readiness = yield* RelayLifecycle.ensureRelay({ relay })
  if (readiness.started) {
    yield* Console.error(`Started Browse relay at ${relay.endpoint}`)
  }
  if (readiness.buildProblem) {
    return yield* Effect.fail(new Error(readiness.buildProblem))
  }
  return readiness
})

export const ensureCliRelayAndExtension = Effect.fnUntraced(function* (sessionId?: string) {
  const relay = yield* RelayClient.Service
  const readiness = yield* ensureCliRelay()
  yield* RelayLifecycle.ensureExtensionConnected({
    relay,
    sessionId,
    waitForReconnect: RelayLifecycle.shouldWaitForExtensionReconnect(readiness),
    onWait: Console.error(
      `Waiting up to ${RelayLifecycle.extensionReconnectWaitMs / 1_000}s for the Browse extension to reconnect`,
    ),
  })
})

export const resolveSelectedSessionId = Effect.fnUntraced(function* (explicitSessionId: string | undefined) {
  const store = yield* SessionStore.Service
  const sessionId = explicitSessionId ?? (yield* store.read)
  if (!sessionId) {
    return yield* Effect.fail(new Error("No session provided and no current Browse session exists"))
  }
  return sessionId
})

export const resolvePositionalOrFlagSessionId = Effect.fnUntraced(function* (
  id: Option.Option<string>,
  session: Option.Option<string>,
) {
  return yield* resolveSelectedSessionId(
    resolveExplicitSessionSelector({
      positional: Option.getOrUndefined(id),
      flag: Option.getOrUndefined(session),
      environment: Option.getOrUndefined(yield* sessionIdConfig),
    }),
  )
})

export const ensureSessionExists = Effect.fnUntraced(function* (id: string) {
  const relay = yield* RelayClient.Service
  yield* ensureCliRelay()
  yield* ensureRelaySessionExists(relay, id)
})

export const recordingTarget = Effect.fnUntraced(function* (options: {
  readonly session: Option.Option<string>
  readonly tabId: Option.Option<number>
}) {
  const sessionId = Option.getOrUndefined(options.session)
  const tabId = Option.getOrUndefined(options.tabId)
  if (sessionId && tabId !== undefined) {
    return yield* Effect.fail(new Error("Use only one recording target selector: --session or --tab-id"))
  }
  return {
    ...(sessionId ? { sessionId } : {}),
    ...(tabId === undefined ? {} : { tabId }),
  }
})

export const parseRecordingModeOption = Effect.fnUntraced(function* (value: string | undefined) {
  if (value === undefined) {
    return undefined
  }
  if (value === "auto" || value === "tab-capture" || value === "cdp") {
    return value
  }
  return yield* Effect.fail(new Error("Recording mode must be auto, tab-capture, or cdp"))
})

export const networkSession = Effect.fnUntraced(function* (session: Option.Option<string>) {
  return yield* resolveSelectedSessionId(Option.getOrUndefined(session) ?? Option.getOrUndefined(yield* sessionIdConfig))
})
