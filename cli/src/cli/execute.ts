import { Console, Effect, FileSystem, Option, Predicate, Result, Schema } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import path from "node:path"
import { ExitCode } from "./output.ts"
import * as RelayClient from "../relay/client.ts"
import type { ExecuteAftermath, ExecuteLogEntry, ExecuteResponse } from "../relay/schema.ts"
import {
  agentDefaultSessionId,
  agentSessionIdConfig,
  emitJson,
  ensureCliRelayAndExtension,
  exitCodeForError,
  exitWith,
  failExit,
  formatSessionContinuation,
  sessionFlag,
  sessionIdConfig,
  stderrLine,
  targetIndexConfig,
  targetUrlConfig,
} from "./context.ts"
import { registerCliCommand } from "./registry.ts"

const readExecuteFile = Effect.fnUntraced(function* (filePath: string) {
  const fs = yield* FileSystem.FileSystem
  return yield* fs.readFileString(path.resolve(filePath)).pipe(
    Effect.mapError((cause) => new Error(`read execute file ${filePath}: ${cause.reason.message}`, { cause })),
  )
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

export type ExecuteJsonEnvelope = {
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

function errorJsonEnvelope(error: unknown): ExecuteJsonEnvelope {
  const tag =
    Predicate.isObject(error) && Predicate.hasProperty(error, "_tag") && Predicate.isString(error._tag)
      ? error._tag
      : "Error"
  const message = error instanceof Error ? error.message : String(error)
  const errorValue: { readonly _tag: string; readonly message: string } = Object.assign({ message }, { _tag: tag })
  return {
    ok: false,
    isError: true,
    text: message,
    value: null,
    valueUnavailable: true,
    error: errorValue,
    logs: [],
    warnings: [],
  }
}

const execute = Command.make(
  "execute",
  {
    code: Argument.String("code").pipe(Argument.variadic({ min: 0 })),
    file: Flag.String("file").pipe(Flag.optional, Flag.withDescription("Read execute code from a file")),
    session: sessionFlag("Continue an existing Browse session; defaults to the OpenCode agent's session"),
    rm: Flag.Boolean("rm").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Use a fresh one-shot session and close its tabs afterward"),
    ),
    timeoutMs: Flag.Int("timeout-ms").pipe(
      Flag.optional,
      Flag.withDescription("Overall script timeout in milliseconds (paused during handoff); defaults to 60000, 0 disables"),
    ),
    targetUrl: Flag.String("target-url").pipe(
      Flag.optional,
      Flag.withDescription("Use the attached page whose URL contains this text"),
    ),
    targetIndex: Flag.Int("target-index").pipe(
      Flag.optional,
      Flag.withDescription("Use the attached page at this zero-based index"),
    ),
    json: Flag.Boolean("json").pipe(
      Flag.withDefault(false),
      Flag.withDescription(
        "Print a machine-readable result envelope: { ok, isError, text, value, valueUnavailable, error?, logs, warnings, diagnostic?, aftermath, session }",
      ),
    ),
  },
  Effect.fn("Cli.execute")(function* ({ code, file, session, rm, timeoutMs, targetUrl, targetIndex, json }) {
    const run = Effect.gen(function* () {
      const relay = yield* RelayClient.Service
      const filePath = Option.getOrUndefined(file)
      if (code.length > 0 && filePath) {
        return yield* Effect.fail(new Error("Use either positional code or --file, not both"))
      }
      if (code.length === 0 && !filePath) {
        return yield* Effect.fail(new Error("Execute requires positional code or --file <path>"))
      }
      const timeoutMsValue = Option.getOrUndefined(timeoutMs)
      if (timeoutMsValue !== undefined && timeoutMsValue < 0) {
        return yield* Effect.fail(new Error("Timeout must be a non-negative integer"))
      }
      const executeCode = filePath ? yield* readExecuteFile(filePath) : code.join(" ")
      const explicitSessionId = Option.getOrUndefined(session) ?? Option.getOrUndefined(yield* sessionIdConfig)
      if (rm && explicitSessionId) {
        return yield* Effect.fail(new Error("Use --rm without --session or OPENCODE_BROWSER_SESSION"))
      }
      const agentWorkSessionId = agentDefaultSessionId(Option.getOrUndefined(yield* agentSessionIdConfig))
      const workSessionId = explicitSessionId ?? (rm ? undefined : agentWorkSessionId)
      yield* ensureCliRelayAndExtension(workSessionId)
      const targetUrlValue = Option.getOrUndefined(targetUrl) ?? Option.getOrUndefined(yield* targetUrlConfig)
      const targetIndexValue = Option.getOrUndefined(targetIndex) ?? Option.getOrUndefined(yield* targetIndexConfig)
      if (targetIndexValue !== undefined && targetIndexValue < 0) {
        return yield* Effect.fail(new Error("Target index must be a non-negative integer"))
      }
      if (targetUrlValue && targetIndexValue !== undefined) {
        return yield* Effect.fail(
          new Error(
            "Use only one target selector: --target-url/OPENCODE_BROWSER_TARGET_URL or --target-index/OPENCODE_BROWSER_TARGET_INDEX",
          ),
        )
      }
      const result = yield* relay.execute({
        ...(workSessionId ? { sessionId: workSessionId } : {}),
        code: executeCode,
        // Idle reaping deletes oc-* sessions, so the agent's own printed --session hint must recreate it.
        createIfMissing: !explicitSessionId || explicitSessionId === agentWorkSessionId,
        ...(rm ? { removeAfterExecute: true } : {}),
        ...(timeoutMsValue === undefined ? {} : { timeoutMs: timeoutMsValue }),
        ...(targetUrlValue || targetIndexValue !== undefined
          ? {
              targetSelection: {
                ...(targetUrlValue ? { urlIncludes: targetUrlValue } : {}),
                ...(targetIndexValue !== undefined ? { index: targetIndexValue } : {}),
              },
            }
          : {}),
      })
      if (!explicitSessionId && !rm) {
        yield* Console.error(formatSessionContinuation(result.session.id))
      }
      return result
    })
    if (json) {
      const outcome = yield* Effect.result(run)
      const envelope = Result.isFailure(outcome)
        ? errorJsonEnvelope(outcome.failure)
        : executeJsonEnvelope(outcome.success)
      yield* emitJson(envelope)
      if (!envelope.ok) {
        yield* stderrLine(envelope.error?.message ?? envelope.text)
        yield* exitWith(Result.isFailure(outcome) ? exitCodeForError(outcome.failure) : ExitCode.failure)
      }
      return
    }
    const outcome = yield* Effect.result(run)
    if (Result.isFailure(outcome)) {
      yield* Console.error(outcome.failure.message)
      yield* exitWith(exitCodeForError(outcome.failure))
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

registerCliCommand(200, () => execute)
