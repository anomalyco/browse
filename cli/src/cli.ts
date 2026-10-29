#!/usr/bin/env node
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Config, Console, Effect, FileSystem, Layer, Option, Predicate, Result, Schema } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"
import { autoUpdateStatus } from "./auto-update.ts"
import { createDoctorReport, formatDoctorReport, formatTargetSummary } from "./doctor.ts"
import { runMcpServer } from "./mcp.ts"
import { cliCommand } from "./paths.ts"
import * as RelayClient from "./relay-client.ts"
import { parseAdditionalExtensionOrigins } from "./relay-helpers.ts"
import * as RelayLifecycle from "./relay-lifecycle.ts"
import type { ExecuteAftermath, ExecuteLogEntry, ExecuteResponse, NetworkStatusResponse, NetworkStopResponse, RecordingQuality, SettingsGetResponse } from "./relay-schema.ts"
import { startRelay } from "./relay.ts"
import { defaultJournalBaseDir, formatJournalEntry, readJournalEntries } from "./session-journal.ts"
import * as SessionStore from "./session-store.ts"
import * as SiteSecrets from "./site-secrets.ts"
import * as Deadbolt from "./deadbolt.ts"
import { formatUpdateNotice, updateJson, updateNotice } from "./update.ts"
import { formatSettings, settingKeys, type SettingKey, type SettingReport } from "./user-settings.ts"
import { opencodeBrowserVersion } from "./version.ts"

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const sessionIdConfig = Config.option(Config.String("OPENCODE_BROWSER_SESSION"))
const targetUrlConfig = Config.option(Config.String("OPENCODE_BROWSER_TARGET_URL"))
const targetIndexConfig = Config.option(Config.Int("OPENCODE_BROWSER_TARGET_INDEX"))
const encodedCliOperandsMarker = "bc-cli-operands:v1"
const encodedCliOperandPrefix = "bc-cli-operand:"
const jsonFlag = Flag.Boolean("json").pipe(Flag.withDefault(false), Flag.withDescription("Print machine-readable JSON"))
const sessionFlag = (description?: string) => {
  const flag = Flag.String("session").pipe(Flag.optional, Flag.withAlias("s"))
  return description ? flag.pipe(Flag.withDescription(description)) : flag
}
const tabIdFlag = (description?: string) => {
  const flag = Flag.Int("tab-id").pipe(Flag.optional)
  return description ? flag.pipe(Flag.withDescription(description)) : flag
}
const failExit = Effect.sync(() => {
  process.exitCode = 1
})

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

function decodeCliOperands(operands: ReadonlyArray<string>): ReadonlyArray<string> {
  if (operands[0] !== encodedCliOperandsMarker) return operands
  return operands.slice(1).map((operand) => {
    if (!operand.startsWith(encodedCliOperandPrefix)) throw new Error("Invalid encoded secrets run operand")
    return decodeURIComponent(operand.slice(encodedCliOperandPrefix.length))
  })
}

const readExecuteFile = Effect.fnUntraced(function* (filePath: string) {
  const fs = yield* FileSystem.FileSystem
  return yield* fs.readFileString(path.resolve(filePath)).pipe(
    Effect.mapError((cause) => new Error(`read execute file ${filePath}: ${cause.reason.message}`, { cause })),
  )
})

const ensureCliRelay = Effect.fnUntraced(function* () {
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

const ensureCliRelayAndExtension = Effect.fnUntraced(function* () {
  const relay = yield* RelayClient.Service
  const readiness = yield* ensureCliRelay()
  yield* RelayLifecycle.ensureExtensionConnected({
    relay,
    waitForReconnect: RelayLifecycle.shouldWaitForExtensionReconnect(readiness),
    onWait: Console.error(`Waiting up to ${RelayLifecycle.extensionReconnectWaitMs / 1_000}s for the Browse extension to reconnect`),
  })
})

const resolveSelectedSessionId = Effect.fnUntraced(function* (explicitSessionId: string | undefined) {
  const store = yield* SessionStore.Service
  const sessionId = explicitSessionId ?? (yield* store.read)
  if (!sessionId) {
    return yield* Effect.fail(new Error("No session provided and no current Browse session exists"))
  }
  return sessionId
})

const resolvePositionalOrFlagSessionId = Effect.fnUntraced(function* (
  id: Option.Option<string>,
  session: Option.Option<string>,
) {
  return yield* resolveSelectedSessionId(resolveExplicitSessionSelector({
    positional: Option.getOrUndefined(id),
    flag: Option.getOrUndefined(session),
    environment: Option.getOrUndefined(yield* sessionIdConfig),
  }))
})

const ensureSessionExists = Effect.fnUntraced(function* (id: string) {
  const relay = yield* RelayClient.Service
  yield* ensureCliRelay()
  const sessions = yield* relay.sessions
  const exists = sessions.some((session) => {
    return session.id === id
  })
  if (!exists) {
    return yield* Effect.fail(new Error(`Session not found: ${id}`))
  }
})

const recordingTarget = Effect.fnUntraced(function* (options: {
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

const parseRecordingModeOption = Effect.fnUntraced(function* (value: string | undefined) {
  if (value === undefined) {
    return undefined
  }
  if (value === "auto" || value === "tab-capture" || value === "cdp") {
    return value
  }
  return yield* Effect.fail(new Error("Recording mode must be auto, tab-capture, or cdp"))
})

function formatExecuteLogs(logs: readonly ExecuteLogEntry[]): string {
  return [
    "Console logs:",
    ...logs.map((log) => {
      const location = log.location?.url ? ` ${log.location.url}:${log.location.lineNumber}:${log.location.columnNumber}` : ""
      return `[${log.source}:${log.type}]${location} ${log.text}`
    }),
  ].join("\n")
}

/** One-line aftermath summary, or null when nothing interesting happened. */
function formatAftermath(aftermath: ExecuteAftermath): string | null {
  const parts: string[] = []
  if (aftermath.startUrl !== aftermath.endUrl) {
    parts.push(`Page: ${aftermath.startUrl ?? "none"} -> ${aftermath.endUrl ?? "none"}`)
  }
  if (aftermath.navigations.length > 1) {
    parts.push(`navigations=${aftermath.navigations.length}`)
  }
  if (aftermath.pageErrorCount > 0) {
    parts.push(`pageErrors=${aftermath.pageErrorCount}`)
  }
  if (aftermath.handoffs > 0) {
    parts.push(`handoffs=${aftermath.handoffs}`)
  }
  return parts.length > 0 ? parts.join(" ") : null
}

type ExecuteJsonEnvelope = {
  readonly ok: boolean
  readonly isError: boolean
  readonly text: string
  readonly value: unknown | null
  readonly valueUnavailable: boolean
  readonly error?: { readonly _tag: string; readonly message: string }
  readonly logs: readonly ExecuteLogEntry[]
  readonly warnings: readonly string[]
  readonly diagnostic?: string
  readonly aftermath?: ExecuteAftermath
  readonly session?: ExecuteResponse["session"]
}

const ScriptErrorEnvelope = Schema.TaggedStruct("ScriptError", {
  message: Schema.String,
})

export function executeJsonEnvelope(result: ExecuteResponse): ExecuteJsonEnvelope {
  const hasStructuredValue = Object.hasOwn(result, "value") && result.value !== undefined
  return {
    ok: !result.isError,
    isError: result.isError,
    text: result.text,
    value: hasStructuredValue ? result.value : null,
    valueUnavailable: !hasStructuredValue,
    ...(result.isError ? { error: ScriptErrorEnvelope.make({ message: result.text }) } : {}),
    logs: result.logs,
    warnings: result.warnings ?? [],
    ...(result.diagnostic ? { diagnostic: result.diagnostic } : {}),
    ...(result.aftermath ? { aftermath: result.aftermath } : {}),
    session: result.session,
  }
}

export function formatSessionContinuation(sessionId: string): string {
  return `Session: ${sessionId}. Continue with --session ${sessionId}.`
}

function errorJsonEnvelope(error: unknown): ExecuteJsonEnvelope {
  const tag = Predicate.isObject(error) && Predicate.hasProperty(error, "_tag") && Predicate.isString(error._tag) ? error._tag : "Error"
  const message = error instanceof Error ? error.message : String(error)
  const errorValue: { readonly _tag: string; readonly message: string } = Object.assign({ message }, { _tag: tag })
  return { ok: false, isError: true, text: message, value: null, valueUnavailable: true, error: errorValue, logs: [], warnings: [] }
}

const serve = Command.make(
  "serve",
  {},
  Effect.fn("Cli.serve")(function* () {
    const port = yield* RelayClient.portConfig
    const additionalExtensionOrigins = parseAdditionalExtensionOrigins(yield* RelayClient.extensionOriginsConfig)
    yield* Effect.scoped(
      Effect.gen(function* () {
        const relay = yield* startRelay({ port, additionalExtensionOrigins })
        yield* Console.log(`Browse relay listening at ${relay.url}`)
        yield* Console.log(`Browse connects automatically while the browser runs. Run \`${cliCommand("status")}\` to check.`)
        yield* Effect.never
      }),
    )
  }),
).pipe(Command.withDescription("Start the local Browse relay"))

const relayRestart = Command.make(
  "restart",
  {
    force: Flag.Boolean("force").pipe(Flag.withDefault(false), Flag.withDescription("End network captures and recordings (discarding them) and disconnect raw CDP clients instead of refusing to restart")),
  },
  Effect.fn("Cli.relayRestart")(function* ({ force }) {
    const relay = yield* RelayClient.Service
    yield* Console.error("Restarting the relay leaves browser tabs open but resets in-memory JavaScript state.")
    const readiness = yield* RelayLifecycle.restartRelay({ relay, clientKind: "cli", force })
    yield* Console.log(`${readiness.started ? "Started" : "Reused concurrent replacement"} Browse relay at ${relay.endpoint} (${readiness.version.buildId})`)
  }),
).pipe(Command.withDescription("Explicitly drain and restart the managed relay using this installation"))

const relay = Command.make("relay").pipe(
  Command.withDescription("Manage the local relay lifecycle"),
  Command.withSubcommands([relayRestart]),
)

const execute = Command.make(
  "execute",
  {
    code: Argument.String("code").pipe(Argument.variadic({ min: 0 })),
    file: Flag.String("file").pipe(Flag.optional, Flag.withDescription("Read execute code from a file")),
    session: sessionFlag("Continue an existing Browse session; omit to create a fresh one"),
    targetUrl: Flag.String("target-url").pipe(Flag.optional, Flag.withDescription("Use the attached page whose URL contains this text")),
    targetIndex: Flag.Int("target-index").pipe(Flag.optional, Flag.withDescription("Use the attached page at this zero-based index")),
    json: Flag.Boolean("json").pipe(Flag.withDefault(false), Flag.withDescription("Print a machine-readable result envelope: { ok, isError, text, value, valueUnavailable, error?, logs, warnings, diagnostic?, aftermath, session }")),
  },
  Effect.fn("Cli.execute")(function* ({ code, file, session, targetUrl, targetIndex, json }) {
    const run = Effect.gen(function* () {
      const relay = yield* RelayClient.Service
      const filePath = Option.getOrUndefined(file)
      if (code.length > 0 && filePath) {
        return yield* Effect.fail(new Error("Use either positional code or --file, not both"))
      }
      if (code.length === 0 && !filePath) {
        return yield* Effect.fail(new Error("Execute requires positional code or --file <path>"))
      }
      const executeCode = filePath ? yield* readExecuteFile(filePath) : code.join(" ")
      yield* ensureCliRelayAndExtension()
      const explicitSessionId = Option.getOrUndefined(session) ?? Option.getOrUndefined(yield* sessionIdConfig)
      const targetUrlValue = Option.getOrUndefined(targetUrl) ?? Option.getOrUndefined(yield* targetUrlConfig)
      const targetIndexValue = Option.getOrUndefined(targetIndex) ?? Option.getOrUndefined(yield* targetIndexConfig)
      if (targetIndexValue !== undefined && targetIndexValue < 0) {
        return yield* Effect.fail(new Error("Target index must be a non-negative integer"))
      }
      if (targetUrlValue && targetIndexValue !== undefined) {
        return yield* Effect.fail(new Error("Use only one target selector: --target-url/OPENCODE_BROWSER_TARGET_URL or --target-index/OPENCODE_BROWSER_TARGET_INDEX"))
      }
      const result = yield* relay.execute({
        ...(explicitSessionId ? { sessionId: explicitSessionId } : {}),
        code: executeCode,
        createIfMissing: !explicitSessionId,
        ...(targetUrlValue || targetIndexValue !== undefined
          ? {
            targetSelection: {
              ...(targetUrlValue ? { urlIncludes: targetUrlValue } : {}),
              ...(targetIndexValue !== undefined ? { index: targetIndexValue } : {}),
            },
          }
          : {}),
      })
      if (!explicitSessionId) {
        yield* Console.error(formatSessionContinuation(result.session.id))
      }
      return result
    })
    if (json) {
      const envelope = yield* run.pipe(
        Effect.map(executeJsonEnvelope),
        Effect.catch((error) => Effect.succeed(errorJsonEnvelope(error))),
      )
      yield* Console.log(JSON.stringify(envelope, null, 2))
      if (!envelope.ok) {
        yield* failExit
      }
      return
    }
    const outcome = yield* Effect.result(run)
    if (Result.isFailure(outcome)) {
      yield* Console.error(outcome.failure.message)
      yield* failExit
      return
    }
    const result = outcome.success
    const print = result.isError ? Console.error : Console.log
    yield* print(result.text)
    if (result.logs.length > 0) {
      yield* print(formatExecuteLogs(result.logs))
    }
    yield* Effect.forEach(result.warnings ?? [], (warning) => print(`Warning: ${warning}`))
    if (result.diagnostic) {
      yield* print(`Diagnostic: ${result.diagnostic}`)
    }
    const aftermath = result.aftermath ? formatAftermath(result.aftermath) : null
    if (aftermath) {
      yield* print(aftermath)
    }
    if (result.isError) {
      yield* failExit
    }
  }),
).pipe(Command.withDescription("Execute Playwright code against the attached browser"))

const sessionNew = Command.make(
  "new",
  {
    name: Argument.String("name").pipe(Argument.optional, Argument.withDescription("Optional lowercase session id")),
    readOnly: Flag.Boolean("read-only").pipe(Flag.withDefault(false), Flag.withDescription("Create a read-only session: the relay rejects input-dispatching CDP so scripts can inspect but not click or type")),
    allowOrigin: Flag.String("allow-origin").pipe(Flag.atLeast(0), Flag.withDescription("Only let this session's tabs load these hosts or origins (repeatable or comma-separated): example.com, *.example.com, https://app.example.com, http://localhost:3000")),
  },
  Effect.fn("Cli.sessionNew")(function* ({ name, readOnly, allowOrigin }) {
    const relay = yield* RelayClient.Service
    yield* ensureCliRelay()
    const store = yield* SessionStore.Service
    const result = yield* relay.sessionNew(Option.getOrUndefined(name), {
      ...(readOnly ? { readOnly: true } : {}),
      ...(allowOrigin.length > 0 ? { allowedOrigins: allowOrigin } : {}),
    })
    yield* store.write(result.id)
    yield* Console.log(result.id)
  }),
).pipe(Command.withDescription("Create a Browse session and make it current"))

const sessionList = Command.make(
  "list",
  {
    json: jsonFlag,
  },
  Effect.fn("Cli.sessionList")(function* ({ json }) {
    const relay = yield* RelayClient.Service
    yield* ensureCliRelay()
    const store = yield* SessionStore.Service
    const sessions = yield* relay.sessions
    const current = yield* store.read
    if (json) {
      yield* Console.log(JSON.stringify({ current: current ?? undefined, sessions }, null, 2))
      return
    }
    if (sessions.length === 0) {
      yield* Console.log("No sessions")
      return
    }
    yield* Effect.forEach(sessions, (item) => {
      const marker = item.id === current ? "*" : " "
      const page = item.pageUrl ?? "no page yet"
      const keys = item.stateKeys.length ? ` state=${item.stateKeys.join(",")}` : ""
      const readOnly = item.readOnly ? " read-only" : ""
      const allowed = item.allowedOrigins ? ` allow=${item.allowedOrigins.join(",")}` : ""
      return Console.log(`${marker} ${item.id} ${page}${keys}${readOnly}${allowed}`)
    })
  }),
).pipe(Command.withDescription("List Browse sessions"))

const sessionCurrent = Command.make(
  "current",
  {},
  Effect.fn("Cli.sessionCurrent")(function* () {
    const store = yield* SessionStore.Service
    const current = yield* store.read
    yield* Console.log(current ?? "none")
  }),
).pipe(Command.withDescription("Print the current default session"))

const sessionUse = Command.make(
  "use",
  {
    id: Argument.String("id"),
  },
  Effect.fn("Cli.sessionUse")(function* ({ id }) {
    const store = yield* SessionStore.Service
    yield* ensureSessionExists(id)
    yield* store.write(id)
    yield* Console.log(id)
  }),
).pipe(Command.withDescription("Set the current default session"))

const sessionReset = Command.make(
  "reset",
  {
    id: Argument.String("id").pipe(Argument.optional),
    session: sessionFlag("Reset this Browse session id"),
  },
  Effect.fn("Cli.sessionReset")(function* ({ id, session }) {
    const relay = yield* RelayClient.Service
    const sessionId = yield* resolvePositionalOrFlagSessionId(id, session)
    yield* ensureCliRelay()
    const reset = yield* relay.sessionReset(sessionId)
    if (reset.stopped) yield* Console.error(`Stopped first: ${describeStop(reset.stopped)}`)
    yield* Console.log(reset.session.id)
  }),
).pipe(Command.withDescription("Reset a Browse session state and page"))

const sessionAdopt = Command.make(
  "adopt",
  {
    session: sessionFlag("Adopt into this Browse session, creating it when it does not exist yet; omit to create a fresh readable id"),
    targetUrl: Flag.String("target-url").pipe(Flag.optional, Flag.withDescription("Adopt the attached page whose URL contains this text")),
    targetIndex: Flag.Int("target-index").pipe(Flag.optional, Flag.withDescription("Adopt the attached page at this zero-based target index")),
    tabId: tabIdFlag("Adopt the user's shared tab with this Chrome tab id (the tab= value in status)"),
  },
  Effect.fn("Cli.sessionAdopt")(function* ({ session, targetUrl, targetIndex, tabId }) {
    const relay = yield* RelayClient.Service
    yield* ensureCliRelayAndExtension()
    const explicitSessionId = Option.getOrUndefined(session) ?? Option.getOrUndefined(yield* sessionIdConfig)
    const targetUrlValue = Option.getOrUndefined(targetUrl)
    const targetIndexValue = Option.getOrUndefined(targetIndex)
    if (targetIndexValue !== undefined && targetIndexValue < 0) {
      return yield* Effect.fail(new Error("Target index must be a non-negative integer"))
    }
    const tabIdValue = Option.getOrUndefined(tabId)
    if ([targetUrlValue, targetIndexValue, tabIdValue].filter((value) => value !== undefined).length > 1) {
      return yield* Effect.fail(new Error("Use only one target selector: --target-url, --target-index, or --tab-id"))
    }
    const targetSelection = targetUrlValue
      ? { urlIncludes: targetUrlValue }
      : targetIndexValue !== undefined
      ? { index: targetIndexValue }
      : undefined
    // An explicit id names the session the agent wants to continue with; creating it here
    // mirrors `session new <id>` and never infers identity from shared current-session state.
    const result = yield* relay.sessionAdopt({
      ...(explicitSessionId ? { sessionId: explicitSessionId } : {}),
      createIfMissing: true,
      ...(targetSelection ? { targetSelection } : {}),
      ...(tabIdValue === undefined ? {} : { tabId: tabIdValue }),
    })
    yield* Console.log(`${result.session.created ? "Created and adopted" : "Adopted"} session '${result.session.id}' default page: ${result.adoptedUrl}`)
    if (result.session.created) {
      yield* Console.error(formatSessionContinuation(result.session.id))
    }
  }),
).pipe(Command.withDescription("Make an attached tab the session's default page"))

/** One line for what delete or reset had to end first. */
function describeStop(stopped: { readonly execute: boolean; readonly handoff: boolean; readonly forced: boolean }): string {
  return [
    stopped.execute ? "a running execute" : undefined,
    stopped.handoff ? "a pending handoff" : undefined,
  ].filter(Boolean).join(" and ") + (stopped.forced ? " (the script did not stop in time and was abandoned with its state)" : "")
}

const sessionDelete = Command.make(
  "delete",
  {
    id: Argument.String("id").pipe(Argument.optional),
    session: sessionFlag("Delete this Browse session id"),
  },
  Effect.fn("Cli.sessionDelete")(function* ({ id, session }) {
    const relay = yield* RelayClient.Service
    const store = yield* SessionStore.Service
    const sessionId = yield* resolvePositionalOrFlagSessionId(id, session)
    yield* ensureCliRelay()
    const deleted = yield* relay.sessionDelete(sessionId)
    if (deleted.stopped) yield* Console.error(`Stopped first: ${describeStop(deleted.stopped)}`)
    const current = yield* store.read
    if (current === sessionId) {
      yield* store.clear
    }
    yield* Console.log(sessionId)
  }),
).pipe(Command.withDescription("Delete a Browse session"))

const sessionAllow = Command.make(
  "allow",
  {
    session: sessionFlag(),
    origins: Argument.String("origins").pipe(Argument.variadic({ min: 0 }), Argument.withDescription("Hosts or origins the session's tabs may load: example.com, *.example.com, https://app.example.com, http://localhost:3000")),
    clear: Flag.Boolean("clear").pipe(Flag.withDefault(false), Flag.withDescription("Remove the allowlist: the session may load any site again")),
    json: jsonFlag,
  },
  Effect.fn("Cli.sessionAllow")(function* ({ session, origins, clear, json }) {
    const relay = yield* RelayClient.Service
    yield* ensureCliRelay()
    if (!clear && origins.length === 0) {
      return yield* Effect.fail(new Error("session allow needs origins, or --clear to remove the allowlist"))
    }
    const id = yield* resolvePositionalOrFlagSessionId(Option.none(), session)
    const result = yield* relay.sessionAllowlist(id, clear ? [] : origins)
    if (json) {
      yield* Console.log(JSON.stringify(result, null, 2))
      return
    }
    yield* Console.log(result.allowedOrigins ? `${result.id} may load: ${result.allowedOrigins.join(", ")}` : `${result.id} may load any site`)
  }),
).pipe(Command.withDescription("Set the domain allowlist of a session (the current one by default)"))

const session = Command.make("session").pipe(
  Command.withDescription("Manage Browse sessions"),
  Command.withSubcommands([sessionNew, sessionList, sessionCurrent, sessionUse, sessionReset, sessionAdopt, sessionDelete, sessionAllow]),
)

const status = Command.make(
  "status",
  {
    json: jsonFlag,
  },
  Effect.fn("Cli.status")(function* ({ json }) {
    const relay = yield* RelayClient.Service
    const store = yield* SessionStore.Service
    const [relayResult, update] = yield* Effect.all([Effect.result(relay.version), Effect.promise(() => updateNotice())], { concurrency: 2 })
    const updateLine = update ? formatUpdateNotice(update) : undefined
    if (Result.isFailure(relayResult)) {
      if (!(relayResult.failure instanceof RelayClient.RelayUnreachable)) {
        if (json) {
          yield* Console.log(JSON.stringify({
            endpoint: relay.endpoint,
            relay: { running: false, error: relayResult.failure.message },
            extension: null,
            sessions: [],
            targets: [],
            update: updateJson(update),
          }, null, 2))
        } else {
          yield* Console.error(`Relay status failed: ${relayResult.failure.message}`)
        }
        yield* failExit
        return
      }
      const stopped = RelayLifecycle.stoppedRelayStatus(relay.endpoint)
      if (json) {
        yield* Console.log(JSON.stringify({ ...stopped, update: updateJson(update), autoUpdate: autoUpdateStatus() }, null, 2))
      } else {
        yield* Console.log(`Relay: stopped (${relay.endpoint})`)
        yield* Console.log(`Run \`${cliCommand("execute")}\` (or any relay-backed command) to start it automatically.`)
        if (updateLine) yield* Console.log(updateLine)
      }
      yield* failExit
      return
    }
    const version = relayResult.success
    const buildProblem = RelayLifecycle.relayBuildProblem(version)
    const [extensionStatus, current] = yield* Effect.all([relay.extensionStatus, store.read])
    const collections = RelayLifecycle.statusCollections(extensionStatus)
    const [sessions, targets] = collections
      ? [collections.sessions, collections.targets]
      : yield* Effect.all([relay.sessions, relay.targets])
    if (json) {
      yield* Console.log(JSON.stringify({
        endpoint: relay.endpoint,
        relay: { running: true, version: version.version, buildId: version.buildId ?? null, stale: buildProblem !== undefined },
        extension: extensionStatus,
        currentSession: current ?? null,
        sessions,
        targets,
        update: updateJson(update),
        autoUpdate: autoUpdateStatus(),
      }, null, 2))
      if (buildProblem) {
        yield* failExit
      }
      return
    }
    if (updateLine) yield* Console.log(updateLine)
    yield* Console.log(`Relay: ${relay.endpoint} (${version.version})`)
    if (buildProblem) {
      yield* Console.log(`Warning: ${buildProblem}`)
    }
    yield* Console.log(`Extension: ${extensionStatus.connected ? "connected" : "disconnected"}${extensionStatus.version ? ` (${extensionStatus.version})` : ""}`)
    if ((extensionStatus.rejectedConnections ?? 0) > 0) {
      yield* Console.log(`Warning: ${extensionStatus.rejectedConnections} competing browser/profile connection attempt(s) rejected; the active connection was preserved. Use Browse in one browser/profile at a time.`)
    }
    if ((extensionStatus.pairingFailures ?? 0) > 0 && !extensionStatus.connected) {
      yield* Console.log(`Warning: ${extensionStatus.pairingFailures} extension connection(s) failed pairing. Update the extension, or run \`${cliCommand("pair")}\` and enter the code on its status page.`)
    }
    if ((extensionStatus.processFaults?.suppressed ?? 0) > 0) {
      const faults = extensionStatus.processFaults!
      yield* Console.log(`Warning: the relay survived ${faults.suppressed} Playwright fault(s)${faults.lastAt ? `, last at ${faults.lastAt}` : ""}${faults.lastMessage ? `: ${faults.lastMessage}` : ""}. See the relay log.`)
    }
    if (extensionStatus.protocolVersion !== undefined && extensionStatus.protocolVersion !== null) {
      const compatibility = extensionStatus.protocolCompatible === false ? "incompatible" : "compatible"
      const legacy = extensionStatus.protocolLegacy === true ? ", inferred from legacy hello" : ""
      yield* Console.log(`Extension protocol: ${extensionStatus.protocolVersion} (${compatibility}${legacy})`)
    }
    yield* Console.log(`Active targets: ${extensionStatus.activeTargets}`)
    if (extensionStatus.childTargets !== undefined) {
      yield* Console.log(`Child targets: ${extensionStatus.childTargets}`)
    }
    if (extensionStatus.cdpClients !== undefined) {
      yield* Console.log(`CDP clients: ${extensionStatus.cdpClients}`)
    }
    yield* Console.log(`Current session: ${current ?? "none"}`)
    if (sessions.length === 0) {
      yield* Console.log("Sessions: none")
    } else {
      yield* Console.log("Sessions:")
      const activeSessions = sessions.filter((item) => item.id === current || item.connected || item.pageUrl !== null || item.stateKeys.length > 0 || item.readOnly)
      const idleSessions = sessions.filter((item) => !activeSessions.includes(item))
      const shownSessions = activeSessions.length > 0 ? activeSessions : idleSessions.slice(0, 5)
      const omittedIdleCount = activeSessions.length > 0 ? idleSessions.length : Math.max(0, idleSessions.length - shownSessions.length)
      yield* Effect.forEach(shownSessions, (item) => {
        const marker = item.id === current ? "*" : " "
        return Console.log(`${marker} ${item.id} ${item.pageUrl ?? "no page yet"}`)
      })
      if (omittedIdleCount > 0) {
        yield* Console.log(`  (${omittedIdleCount} idle session(s) with no page omitted; run ${cliCommand("session list")} to view all)`)
      }
    }
    if (targets.length === 0) {
      yield* Console.log("Targets: none")
    } else {
      yield* Console.log("Targets:")
      yield* Effect.forEach(targets, (target, index) => {
        return Console.log(`- [${index}] ${formatTargetSummary(target, { includeSession: true })}`)
      })
    }
    if (buildProblem) {
      yield* failExit
    }
  }),
).pipe(Command.withDescription("Show relay, extension, and target status"))

const recordingStart = Command.make(
  "start",
  {
    outputPath: Argument.String("output-path").pipe(Argument.withDescription("Path to write the recording artifact; tabCapture requires .webm, CDP accepts .webm or .mp4")),
    session: sessionFlag("Record the page for this Browse or CDP session id"),
    tabId: tabIdFlag("Record this attached Chrome tab id"),
    mode: Flag.String("mode").pipe(Flag.optional, Flag.withDescription("Recording mode: auto, tab-capture, or cdp. auto uses CDP for relay-owned tabs and tabCapture for user-owned tabs")),
    audio: Flag.Boolean("audio").pipe(Flag.withDefault(false), Flag.withDescription("Include tab audio")),
    frameRate: Flag.Int("frame-rate").pipe(Flag.optional, Flag.withDescription("Output frame rate, integer 1..60; defaults to 30 for tab-capture and 60 for CDP")),
    maxDurationMs: Flag.Int("max-duration-ms").pipe(Flag.optional, Flag.withDescription("Auto-stop guard in milliseconds, defaults to 900000")),
    cursor: Flag.Boolean("cursor").pipe(Flag.withDefault(false), Flag.withDescription("Draw the ghost cursor in the recording (off by default: only the page is recorded)")),
    json: jsonFlag,
  },
  Effect.fn("Cli.recordingStart")(function* ({ outputPath, session, tabId, mode, audio, frameRate, maxDurationMs, cursor, json }) {
    if (Option.isSome(frameRate) && (frameRate.value < 1 || frameRate.value > 60)) {
      return yield* Effect.fail(new Error("Recording frameRate must be an integer from 1 to 60"))
    }
    const relay = yield* RelayClient.Service
    yield* ensureCliRelayAndExtension()
    const target = yield* recordingTarget({ session, tabId })
    const modeValue = yield* parseRecordingModeOption(Option.getOrUndefined(mode))
    const resolvedOutputPath = path.resolve(outputPath)
    const result = yield* relay.recordingStart({
      ...target,
      outputPath: resolvedOutputPath,
      ...(modeValue === undefined ? {} : { mode: modeValue }),
      audio,
      ...(Option.isSome(frameRate) ? { frameRate: frameRate.value } : {}),
      ...(Option.isSome(maxDurationMs) ? { maxDurationMs: maxDurationMs.value } : {}),
      ...(cursor ? { cursor } : {}),
    })
    if (!result.success) {
      return yield* Effect.fail(new Error(result.error ?? "Failed to start recording"))
    }
    yield* Console.log(json ? JSON.stringify(result, null, 2) : `Recording started: ${result.path ?? resolvedOutputPath} tab=${result.tabId ?? "unknown"} mode=${result.mode ?? "tab-capture"} artifact=${result.artifactType ?? "webm"} mime=${result.mimeType ?? "video/webm"} fps=${result.frameRate ?? "unknown"}`)
  }),
).pipe(Command.withDescription("Start recording an attached tab"))

const recordingStop = Command.make(
  "stop",
  {
    session: sessionFlag("Stop recording for this CDP session id"),
    tabId: tabIdFlag("Stop recording for this Chrome tab id"),
    json: jsonFlag,
  },
  Effect.fn("Cli.recordingStop")(function* ({ session, tabId, json }) {
    const relay = yield* RelayClient.Service
    yield* ensureCliRelay()
    const target = yield* recordingTarget({ session, tabId })
    const result = yield* relay.recordingStop(target)
    if (!result.success) {
      return yield* Effect.fail(new Error(result.error ?? "Failed to stop recording"))
    }
    if (json) return yield* Console.log(JSON.stringify(result, null, 2))
    const frames = result.frameCount === undefined ? "" : `, frames=${result.frameCount}`
    yield* Console.log(`Recording saved: ${result.path ?? "unknown"} (${result.size ?? 0} bytes, ${result.duration ?? 0}ms, mode=${result.mode ?? "tab-capture"}, artifact=${result.artifactType ?? "webm"}${frames})`)
    yield* Console.log(formatRecordingQuality(result.quality))
  }),
).pipe(Command.withDescription("Stop recording and write the artifact"))

const recordingStatus = Command.make(
  "status",
  {
    session: sessionFlag("Check recording for this CDP session id"),
    tabId: tabIdFlag("Check recording for this Chrome tab id"),
    json: jsonFlag,
  },
  Effect.fn("Cli.recordingStatus")(function* ({ session, tabId, json }) {
    const relay = yield* RelayClient.Service
    yield* ensureCliRelay()
    const target = yield* recordingTarget({ session, tabId })
    const result = yield* relay.recordingStatus(target)
    if (json) {
      yield* Console.log(JSON.stringify(result, null, 2))
      return
    }
    if (!result.isRecording) {
      yield* Console.log("Recording: inactive")
      return
    }
    const frames = result.frameCount === undefined ? "" : ` frameCount=${result.frameCount}`
    yield* Console.log(`Recording: active tab=${result.tabId ?? "unknown"} mode=${result.mode ?? "tab-capture"} artifact=${result.artifactType ?? "webm"} path=${result.path ?? "unknown"} size=${result.size ?? 0}${frames} startedAt=${result.startedAt ?? "unknown"}`)
    yield* Console.log(formatRecordingQuality(result.quality))
  }),
).pipe(Command.withDescription("Check current recording status"))

const recordingCancel = Command.make(
  "cancel",
  {
    session: sessionFlag("Cancel recording for this CDP session id"),
    tabId: tabIdFlag("Cancel recording for this Chrome tab id"),
  },
  Effect.fn("Cli.recordingCancel")(function* ({ session, tabId }) {
    const relay = yield* RelayClient.Service
    yield* ensureCliRelay()
    const target = yield* recordingTarget({ session, tabId })
    const result = yield* relay.recordingCancel(target)
    if (!result.success) {
      return yield* Effect.fail(new Error(result.error ?? "Failed to cancel recording"))
    }
    yield* Console.log("Recording cancelled")
  }),
).pipe(Command.withDescription("Cancel recording without writing a file"))

const recording = Command.make("recording").pipe(
  Command.withDescription("Record an attached tab to WebM or MP4"),
  Command.withSubcommands([recordingStart, recordingStop, recordingStatus, recordingCancel]),
)

const flightRecorderStart = Command.make(
  "start",
  {
    session: sessionFlag("Buffer the tab owned by this session"),
    tabId: tabIdFlag("Buffer this attached Chrome tab id"),
    retentionMs: Flag.Int("retention-ms").pipe(Flag.optional, Flag.withDescription("Ring-buffer duration in milliseconds (1000..120000; default 60000)")),
    frameRate: Flag.Int("frame-rate").pipe(Flag.optional, Flag.withDescription("Output frame rate from 1 to 60")),
    cursor: Flag.Boolean("cursor").pipe(Flag.withDefault(false), Flag.withDescription("Draw the ghost cursor in the buffered video (off by default)")),
    json: jsonFlag,
  },
  Effect.fn("Cli.flightRecorderStart")(function* ({ session, tabId, retentionMs, frameRate, cursor, json }) {
    const relay = yield* RelayClient.Service
    yield* ensureCliRelayAndExtension()
    const target = yield* recordingTarget({ session, tabId })
    const result = yield* relay.flightRecorderStart({
      ...target,
      ...(Option.isSome(retentionMs) ? { retentionMs: retentionMs.value } : {}),
      ...(Option.isSome(frameRate) ? { frameRate: frameRate.value } : {}),
      ...(cursor ? { cursor } : {}),
    })
    yield* Console.log(json ? JSON.stringify(result) : `Flight recorder buffering tab ${result.tabId}; retention=${result.retentionMs}ms`)
  }),
).pipe(Command.withDescription("Start a rolling in-memory video buffer"))

const flightRecorderStatus = Command.make(
  "status",
  {
    session: sessionFlag(),
    tabId: tabIdFlag(),
    json: jsonFlag,
  },
  Effect.fn("Cli.flightRecorderStatus")(function* ({ session, tabId, json }) {
    const relay = yield* RelayClient.Service
    yield* ensureCliRelay()
    const result = yield* relay.flightRecorderStatus(yield* recordingTarget({ session, tabId }))
    if (json) return yield* Console.log(JSON.stringify(result))
    if (!result.active) return yield* Console.log("Flight recorder inactive")
    yield* Console.log(`Flight recorder tab=${result.tabId} frames=${result.bufferedFrames} retained=${result.retainedDurationMs}ms bytes=${result.bufferedBytes}`)
  }),
).pipe(Command.withDescription("Show rolling flight-recorder status"))

const flightRecorderSaveLast = Command.make(
  "save-last",
  {
    outputPath: Argument.String("output-path").pipe(Argument.withDescription("Fresh .webm or .mp4 artifact path")),
    session: sessionFlag(),
    tabId: tabIdFlag(),
    durationMs: Flag.Int("duration-ms").pipe(Flag.optional, Flag.withDescription("How much recent history to save; defaults to 30 seconds")),
    json: jsonFlag,
  },
  Effect.fn("Cli.flightRecorderSaveLast")(function* ({ outputPath, session, tabId, durationMs, json }) {
    const relay = yield* RelayClient.Service
    yield* ensureCliRelay()
    const result = yield* relay.flightRecorderSaveLast({
      ...(yield* recordingTarget({ session, tabId })),
      outputPath: path.resolve(outputPath),
      ...(Option.isSome(durationMs) ? { durationMs: durationMs.value } : {}),
    })
    yield* Console.log(json ? JSON.stringify(result) : `Saved ${result.durationMs}ms flight recorder clip (${result.frameCount} frames) to ${result.path}`)
  }),
).pipe(Command.withDescription("Save the most recent buffered video without stopping the recorder"))

const flightRecorderCancel = Command.make(
  "cancel",
  {
    session: sessionFlag(),
    tabId: tabIdFlag(),
  },
  Effect.fn("Cli.flightRecorderCancel")(function* ({ session, tabId }) {
    const relay = yield* RelayClient.Service
    yield* ensureCliRelay()
    const result = yield* relay.flightRecorderCancel(yield* recordingTarget({ session, tabId }))
    yield* Console.log(result.cancelled ? "Flight recorder stopped" : "No active flight recorder")
  }),
).pipe(Command.withDescription("Stop and discard the rolling video buffer"))

const flightRecorder = Command.make("flight-recorder").pipe(
  Command.withDescription("Keep and save a rolling buffer of recent browser video"),
  Command.withSubcommands([flightRecorderStart, flightRecorderStatus, flightRecorderSaveLast, flightRecorderCancel]),
)

const networkSession = Effect.fnUntraced(function* (session: Option.Option<string>) {
  return yield* resolveSelectedSessionId(Option.getOrUndefined(session) ?? Option.getOrUndefined(yield* sessionIdConfig))
})

const parseNetworkContent = Effect.fnUntraced(function* (content: Option.Option<string>) {
  const value = Option.getOrUndefined(content)
  if (value === undefined || value === "embed" || value === "omit") return value
  return yield* Effect.fail(new Error("Network content must be embed or omit"))
})

function formatNetworkStatus(status: NetworkStatusResponse): string {
  if (!status.active) return status.ended ? `Network capture: inactive (the last one ended because ${status.ended})` : "Network capture: inactive"
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
    urlFilter: Flag.String("url").pipe(Flag.optional, Flag.withDescription("Capture only requests whose URL contains this text")),
    resourceTypes: Flag.String("resource-type").pipe(Flag.atMost(50), Flag.withDescription("Capture this Playwright resource type; repeat for multiple types")),
    content: Flag.String("content").pipe(Flag.optional, Flag.withDescription("Response and request body mode: embed (default) or omit")),
    maxBodyBytes: Flag.Int("max-body-bytes").pipe(Flag.optional, Flag.withDescription("Maximum captured bytes per body, defaults to 1000000")),
    maxTotalBodyBytes: Flag.Int("max-total-body-bytes").pipe(Flag.optional, Flag.withDescription("Maximum captured body bytes for the whole capture, defaults to 25000000")),
    maxEntries: Flag.Int("max-entries").pipe(Flag.optional, Flag.withDescription("Maximum request entries, defaults to 1000")),
    maxDuration: Flag.Int("max-duration-ms").pipe(Flag.optional, Flag.withDescription("End the capture by itself (discarding it) after this long, defaults to 1800000 (30 minutes)")),
    json: jsonFlag,
  },
  Effect.fn("Cli.networkStart")(function* ({ session, urlFilter, resourceTypes, content, maxBodyBytes, maxTotalBodyBytes, maxEntries, maxDuration, json }) {
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
    yield* Console.log(json ? JSON.stringify(result, null, 2) : formatNetworkStatus(result))
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
    yield* Console.log(json ? JSON.stringify(result, null, 2) : formatNetworkStatus(result))
  }),
).pipe(Command.withDescription("Show session-scoped network capture status"))

const networkStop = Command.make(
  "stop",
  {
    session: sessionFlag(),
    output: Flag.String("output").pipe(Flag.optional, Flag.withAlias("o"), Flag.withDescription("Write a credential-redacted HAR artifact to this path")),
    secrets: Flag.String("secrets").pipe(Flag.optional, Flag.withDescription("Store captured credentials under this reusable profile name")),
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
    yield* Console.log(json ? JSON.stringify(result, null, 2) : formatNetworkResult(result))
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

const secretsStatus = Command.make(
  "status",
  {
    name: Argument.String("name"),
    json: jsonFlag,
  },
  Effect.fn("Cli.secretsStatus")(function* ({ name, json }) {
    const relay = yield* RelayClient.Service
    yield* ensureCliRelay()
    const result = yield* relay.authStatus({ name })
    if (json) {
      yield* Console.log(JSON.stringify(result, null, 2))
      return
    }
    yield* Console.log(`Secrets profile ${result.name}: slots=${result.slotCount} updatedAt=${result.updatedAt}`)
    yield* Effect.forEach(result.slots, (slot) => Console.log(`- ${slot.ref} sources=${slot.sources.join(",")} expired=${slot.expired}${slot.expiresAt ? ` expiresAt=${slot.expiresAt}` : ""}`))
  }),
).pipe(Command.withDescription("Show secret profile metadata without revealing values"))

const secretsRefresh = Command.make(
  "refresh",
  {
    name: Argument.String("name"),
    session: sessionFlag(),
    urlFilter: Flag.String("url").pipe(Flag.optional, Flag.withDescription("Observe credentials only on matching request URLs")),
    timeoutMs: Flag.Int("timeout-ms").pipe(Flag.optional, Flag.withDescription("Page reload timeout, defaults to 30000")),
    json: jsonFlag,
  },
  Effect.fn("Cli.secretsRefresh")(function* ({ name, session, urlFilter, timeoutMs, json }) {
    const relay = yield* RelayClient.Service
    yield* ensureCliRelayAndExtension()
    const sessionId = yield* networkSession(session)
    const result = yield* relay.authRefresh({
      sessionId,
      name,
      ...(Option.isSome(urlFilter) ? { urlFilter: urlFilter.value } : {}),
      ...(Option.isSome(timeoutMs) ? { timeoutMs: timeoutMs.value } : {}),
    })
    yield* Console.log(json ? JSON.stringify(result, null, 2) : `Secrets profile ${name} refreshed: observed=${result.observedSecretRefs.length} changed=${result.updatedSecretRefs.length}`)
  }),
).pipe(Command.withDescription("Reload a session page and refresh a profile while preserving stable references"))

const secretsRun = Command.make(
  "run",
  {
    name: Argument.String("name"),
    command: Argument.String("command").pipe(Argument.variadic({ min: 1 })),
    cwd: Flag.String("cwd").pipe(Flag.optional, Flag.withDescription("Child process working directory")),
    timeoutMs: Flag.Int("timeout-ms").pipe(Flag.optional, Flag.withDescription("Child timeout in milliseconds, defaults to 120000")),
  },
  Effect.fn("Cli.secretsRun")(function* ({ name, command, cwd, timeoutMs }) {
    const relay = yield* RelayClient.Service
    yield* ensureCliRelay()
    const [executable, ...args] = decodeCliOperands(command)
    if (!executable) return yield* Effect.fail(new Error("secrets run requires a command after --"))
    const result = yield* relay.authRun({
      name,
      command: executable,
      args,
      cwd: path.resolve(Option.getOrElse(cwd, () => process.cwd())),
      ...(Option.isSome(timeoutMs) ? { timeoutMs: timeoutMs.value } : {}),
    })
    yield* Effect.sync(() => {
      if (result.stdout) process.stdout.write(result.stdout)
      if (result.stderr) process.stderr.write(result.stderr)
      if (result.stdoutTruncated || result.stderrTruncated) process.stderr.write("\nBrowse truncated child output.\n")
      if (result.exitCode !== 0) process.exitCode = result.exitCode
    })
  }),
).pipe(Command.withDescription("Run a command with profile values injected as BC_SECRET_* environment variables"))

/** Read a secret value from stdin (piped) or a hidden prompt, never from argv. */
function readSecretValue(prompt: string): Promise<string> {
  const input = process.stdin
  if (!input.isTTY) {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      input.on("data", (chunk: Buffer) => chunks.push(chunk))
      input.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
      input.once("error", reject)
    })
  }
  return new Promise((resolve, reject) => {
    process.stderr.write(prompt)
    let value = ""
    const finish = (result: string | Error) => {
      input.setRawMode(false)
      input.pause()
      input.off("data", onData)
      process.stderr.write("\n")
      if (result instanceof Error) reject(result)
      else resolve(result)
    }
    const onData = (chunk: Buffer) => {
      for (const char of chunk.toString("utf8")) {
        if (char === "\r" || char === "\n") return finish(value)
        if (char === "\u0003") return finish(new Error("Cancelled"))
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1)
        else value += char
      }
    }
    input.setRawMode(true)
    input.resume()
    input.on("data", onData)
  })
}

const secretsAdd = Command.make(
  "add",
  {
    name: Argument.String("name").pipe(Argument.withDescription("Secret name agents use: secrets.type(locator, \"name\")")),
    origin: Flag.String("origin").pipe(Flag.atLeast(1), Flag.withDescription("Origin the secret may be typed on (repeatable): https://example.com, *.example.com (https), http://localhost:3000")),
    totp: Flag.Boolean("totp").pipe(Flag.withDefault(false), Flag.withDescription("The value is a TOTP seed (base32 or otpauth:// URI); typing it types the current code. Storing the seed beside the password makes 2FA one factor")),
    json: jsonFlag,
  },
  Effect.fn("Cli.secretsAdd")(function* ({ name, origin, totp, json }) {
    const value = yield* Effect.tryPromise({
      try: () => readSecretValue(totp ? `TOTP seed for ${name} (hidden): ` : `Value for ${name} (hidden): `),
      catch: (cause) => cause instanceof Error ? cause : new Error("Could not read the secret value"),
    })
    const result = yield* SiteSecrets.addSecret({ name, value, allowedOrigins: origin, kind: totp ? "totp" : "password" })
    if (json) {
      yield* Console.log(JSON.stringify(result, null, 2))
      return
    }
    yield* Console.log(`Saved ${result.kind} secret ${result.name}; it can be typed on ${result.allowedOrigins.join(", ")}`)
    if (totp) yield* Console.error("Note: with the TOTP seed stored here, anyone who can use these secrets has both factors. Prefer handing 2FA to a person when you can.")
  }),
).pipe(Command.withDescription("Store a secret agents can type only on its origins (value from stdin or a hidden prompt)"))

const secretsList = Command.make(
  "list",
  { json: jsonFlag },
  Effect.fn("Cli.secretsList")(function* ({ json }) {
    const secrets = yield* SiteSecrets.listSecrets()
    if (json) {
      yield* Console.log(JSON.stringify({ secrets }, null, 2))
      return
    }
    if (secrets.length === 0) {
      yield* Console.log("No site secrets")
      return
    }
    yield* Effect.forEach(secrets, (secret) => Console.log(`${secret.name} ${secret.kind} ${secret.allowedOrigins.join(",")}`))
  }),
).pipe(Command.withDescription("List site secrets (names, kinds and origins, never values)"))

const secretsRemove = Command.make(
  "remove",
  { name: Argument.String("name") },
  Effect.fn("Cli.secretsRemove")(function* ({ name }) {
    const removed = yield* SiteSecrets.removeSecret(name)
    yield* Console.log(removed ? `Removed ${name}` : `No secret named ${name}`)
  }),
).pipe(Command.withDescription("Delete a site secret"))

const secrets = Command.make("secrets").pipe(
  Command.withDescription("Site secrets agents can type without seeing them, and captured credential profiles"),
  Command.withSubcommands([secretsAdd, secretsList, secretsRemove, secretsStatus, secretsRefresh, secretsRun]),
)

const deadboltConnect = Command.make(
  "connect",
  { json: jsonFlag },
  Effect.fn("Cli.deadboltConnect")(function* ({ json }) {
    const paired = yield* Effect.tryPromise({
      try: () => Deadbolt.pair(),
      catch: (cause) => cause instanceof Error ? cause : new Error("Could not connect to Deadbolt"),
    })
    if (json) {
      yield* Console.log(JSON.stringify({ connected: true, id: paired.id, ...(paired.socket ? { socket: paired.socket } : {}) }, null, 2))
      return
    }
    yield* Console.log(`Connected Browse to Deadbolt as client ${paired.id}.`)
    yield* Console.log("Agents can use only the logins you allow, in Deadbolt: deadbolt agents allow <site> (narrow with --login, --fields, --expires), or deadbolt agents allow --all for every login")
  }),
).pipe(Command.withDescription("Pair Browse with Deadbolt (runs `deadbolt agents add-client browse`, which asks you to confirm) and store its client token (0600)"))

const deadboltDisconnect = Command.make(
  "disconnect",
  {},
  Effect.fn("Cli.deadboltDisconnect")(function* () {
    const result = yield* Effect.try({
      try: () => Deadbolt.unpair(),
      catch: (cause) => cause instanceof Error ? cause : new Error("Could not disconnect from Deadbolt"),
    })
    if (!result.removed) {
      yield* Console.log("Browse isn't connected to Deadbolt")
      return
    }
    yield* Console.log(result.revoked ? "Disconnected: the client is removed in Deadbolt and its token deleted here." : "Deleted the client token here. Deadbolt didn't confirm removing the client: check `deadbolt agents clients`.")
  }),
).pipe(Command.withDescription("Remove Browse's Deadbolt client (in Deadbolt and here)"))

const deadboltStatus = Command.make(
  "status",
  { json: jsonFlag },
  Effect.fn("Cli.deadboltStatus")(function* ({ json }) {
    const client = Deadbolt.readClient()
    const socket = Deadbolt.socketPath()
    const status = client
      ? yield* Effect.promise(() => Deadbolt.connect({ client, socket }).status().then(
        (value) => ({ reachable: true as const, ...value }),
        (error: unknown) => ({ reachable: false as const, error: error instanceof Error ? error.message : String(error) }),
      ))
      : undefined
    const report = { connected: client !== undefined, ...(client ? { id: client.id } : {}), socket, ...(status ? { deadbolt: status } : {}) }
    if (json) {
      yield* Console.log(JSON.stringify(report, null, 2))
      return
    }
    if (!client) {
      yield* Console.log("Not connected to Deadbolt. Run `opencode-browser deadbolt connect`.")
      return
    }
    yield* Console.log(`Connected as Deadbolt client ${client.id}; socket ${socket}`)
    if (status && status.reachable) yield* Console.log(`Deadbolt ${status.version ?? ""} (protocol ${status.protocol}) is ${status.unlocked ? "unlocked" : "locked: agent sign-ins are paused until you unlock it"}`)
    else if (status) yield* Console.log(`Deadbolt isn't reachable: ${status.error}`)
  }),
).pipe(Command.withDescription("Show whether Browse is paired with Deadbolt and whether Deadbolt is reachable and unlocked"))

const deadbolt = Command.make("deadbolt").pipe(
  Command.withDescription("Let agents sign in with the Deadbolt logins you grant them, without seeing any value"),
  Command.withSubcommands([deadboltConnect, deadboltDisconnect, deadboltStatus]),
)

const journal = Command.make(
  "journal",
  {
    session: sessionFlag("Show the journal for this Browse session id"),
    limit: Flag.Int("limit").pipe(Flag.optional, Flag.withDescription("Number of most recent entries to show, defaults to 20")),
    json: jsonFlag,
  },
  Effect.fn("Cli.journal")(function* ({ session, limit, json }) {
    const sessionId = yield* networkSession(session)
    const entries = yield* Effect.tryPromise({
      try: () => readJournalEntries({ baseDir: defaultJournalBaseDir(), sessionId, limit: Option.getOrUndefined(limit) ?? 20 }),
      catch: (cause) => new Error(`read session journal for ${sessionId}`, { cause }),
    })
    if (json) {
      yield* Console.log(JSON.stringify({ session: sessionId, entries }, null, 2))
      return
    }
    if (entries.length === 0) {
      yield* Console.log(`No journal entries for session ${sessionId}`)
      return
    }
    yield* Console.log(`Journal for ${sessionId} (last ${entries.length}):`)
    yield* Effect.forEach(entries, (entry) => {
      return Console.log(formatJournalEntry(entry))
    })
  }),
).pipe(Command.withDescription("Show what agents did in a Browse session"))

const doctor = Command.make(
  "doctor",
  {
    json: jsonFlag,
  },
  Effect.fn("Cli.doctor")(function* ({ json }) {
    const update = yield* Effect.promise(() => updateNotice())
    const report = yield* createDoctorReport({ packageRoot, update: updateJson(update) })
    if (json) {
      yield* Console.log(JSON.stringify(report, null, 2))
    } else {
      yield* Console.log(formatDoctorReport(report))
    }
    if (report.status === "fail") {
      yield* failExit
    }
  }),
).pipe(Command.withDescription("Diagnose the local Browse install and runtime"))

const skill = Command.make(
  "skill",
  {},
  Effect.fn("Cli.skill")(function* () {
    const fs = yield* FileSystem.FileSystem
    const text = yield* fs.readFileString(path.join(packageRoot, "skills", "browse", "SKILL.md")).pipe(
      Effect.mapError((cause) => new Error("read opencode-browser skill", { cause })),
    )
    yield* Console.log(text.trimEnd())
  }),
).pipe(Command.withDescription("Print the Browse agent skill text"))

const tabsCleanup = Command.make(
  "cleanup",
  {
    idleMinutes: Flag.Int("idle-minutes").pipe(
      Flag.optional,
      Flag.withDescription("Close agent tabs idle at least this long; 0 closes every eligible agent tab (default: the extension's setting, 10; still 10 when it is set to never)"),
    ),
    json: jsonFlag,
  },
  Effect.fn("Cli.tabsCleanup")(function* ({ idleMinutes, json }) {
    const relay = yield* RelayClient.Service
    yield* ensureCliRelay()
    const result = yield* relay.tabsCleanup(Option.getOrUndefined(idleMinutes))
    if (json) return yield* Console.log(JSON.stringify(result, null, 2))
    if (!result.closed.length) return yield* Console.log("No idle agent tabs to close.")
    for (const tab of result.closed) yield* Console.log(`Closed ${tab.title} (idle ${tab.idleMinutes}m)`)
  }),
).pipe(Command.withDescription("Close tabs agents opened that nobody has used for a while"))

const tabs = Command.make("tabs").pipe(
  Command.withDescription("Manage the tabs agents open"),
  Command.withSubcommands([tabsCleanup]),
)

const printSettings = (settings: SettingsGetResponse["settings"]) =>
  Effect.forEach(formatSettings(settings as Record<SettingKey, SettingReport>), (line) => Console.log(line), { discard: true })

const settingsGet = Command.make(
  "get",
  { json: jsonFlag },
  Effect.fn("Cli.settingsGet")(function* ({ json }) {
    const relay = yield* RelayClient.Service
    yield* ensureCliRelay()
    const result = yield* relay.settingsGet
    if (json) return yield* Console.log(JSON.stringify(result, null, 2))
    yield* printSettings(result.settings)
    yield* Console.log(result.note)
  }),
).pipe(Command.withDescription("Show each setting's value, the value in effect, and any relay environment variable overriding it"))

const settingsSet = Command.make(
  "set",
  {
    assignments: Argument.String("key=value").pipe(Argument.variadic({ min: 1 }), Argument.withDescription(`Settings to change: ${settingKeys.join(", ")}`)),
    json: jsonFlag,
  },
  Effect.fn("Cli.settingsSet")(function* ({ assignments, json }) {
    const changes: Record<string, string> = {}
    for (const assignment of assignments) {
      const index = assignment.indexOf("=")
      if (index <= 0) return yield* Effect.fail(new Error(`Expected key=value, got "${assignment}". Settings: ${settingKeys.join(", ")}.`))
      changes[assignment.slice(0, index)] = assignment.slice(index + 1)
    }
    const relay = yield* RelayClient.Service
    yield* ensureCliRelay()
    const result = yield* relay.settingsSet(changes)
    if (json) return yield* Console.log(JSON.stringify(result, null, 2))
    yield* Console.log(result.message)
    yield* printSettings(result.settings)
  }),
).pipe(Command.withDescription("Change settings (validated strictly; the extension's options page updates live)"))

const settings = Command.make("settings").pipe(
  Command.withDescription("Read or change the user's settings (the extension's options page). Security switches are environment-only"),
  Command.withSubcommands([settingsGet, settingsSet]),
)

const mcp = Command.make(
  "mcp",
  {},
  Effect.fn("Cli.mcp")(function* () {
    yield* runMcpServer
  }),
).pipe(Command.withDescription("Run the Browse MCP server over stdio"))

export const opencodeBrowser = Command.make("opencode-browser").pipe(
  Command.withDescription("Control the user's existing browser through the Browse extension"),
  Command.withSubcommands([serve, relay, execute, session, tabs, settings, status, network, secrets, deadbolt, recording, flightRecorder, journal, doctor, skill, mcp]),
)

const mainLayer = Layer.mergeAll(RelayClient.layerFetch, SessionStore.layer).pipe(
  // CLI commands consume FileSystem directly in addition to SessionStore, so
  // Node services intentionally remain exposed downstream.
  Layer.provideMerge(NodeServices.layer),
)

Command.runWith(opencodeBrowser, { version: opencodeBrowserVersion })(normalizeCliArguments(process.argv.slice(2))).pipe(
  Effect.catchTags({
    "RelayClient.RelayRejected": (error) => Console.error(error.message).pipe(Effect.andThen(failExit)),
    "RelayClient.RelayUnreachable": (error) => Console.error(error.message).pipe(Effect.andThen(failExit)),
    "RelayClient.RelayDecodeFailed": (error) => Console.error(error.message).pipe(Effect.andThen(failExit)),
  }),
  Effect.provide(mainLayer),
  NodeRuntime.runMain,
)
