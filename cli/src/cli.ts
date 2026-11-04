#!/usr/bin/env node
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Console, Effect, Layer } from "effect"
import { CliError, Command } from "effect/cli"
import path from "node:path"
import process from "node:process"
import { fileURLToPath, pathToFileURL } from "node:url"
import { ExitCode, failure } from "./cli-output.ts"
import "./cli/browser.ts"
import {
  agentDefaultSessionId,
  emitJson,
  exitCodeForError,
  exitWith,
  formatRecordingQuality,
  formatSessionContinuation,
  hoistJsonFlag,
  normalizeCliArguments,
  resolveExplicitSessionSelector,
  stderrLine,
} from "./cli/context.ts"
import { executeJsonEnvelope } from "./cli/execute.ts"
import "./cli/network.ts"
import "./cli/recording.ts"
import { buildRegisteredCliCommands } from "./cli/registry.ts"
import "./cli/relay.ts"
import "./cli/secrets.ts"
import "./cli/session.ts"
import * as RelayClient from "./relay-client.ts"
import * as SessionStore from "./session-store.ts"
import { opencodeBrowserVersion } from "./version.ts"

export {
  agentDefaultSessionId,
  executeJsonEnvelope,
  exitCodeForError,
  formatRecordingQuality,
  formatSessionContinuation,
  hoistJsonFlag,
  normalizeCliArguments,
  resolveExplicitSessionSelector,
}

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

export const opencodeBrowser = Command.make("opencode-browser").pipe(
  Command.withDescription("Control the user's existing browser through the Browse extension"),
  Command.withSubcommands(buildRegisteredCliCommands({ packageRoot })),
)

const mainLayer = Layer.mergeAll(RelayClient.layerFetch, SessionStore.layer).pipe(
  // CLI commands consume FileSystem directly in addition to SessionStore, so
  // Node services intentionally remain exposed downstream.
  Layer.provideMerge(NodeServices.layer),
)

export function runCli(rawArgs: ReadonlyArray<string> = process.argv.slice(2)): void {
  const cliArgs = hoistJsonFlag(rawArgs)
  const subcommand = cliArgs.argv.find((arg) => !arg.startsWith("-"))
  const commandName = subcommand ? `opencode-browser ${subcommand}` : "opencode-browser"

  // Effect CLI parse errors exit 2 and, in --json mode, print a structured failure envelope.
  const reportUsageError = (error: CliError.CliError) =>
    Effect.gen(function* () {
      const errors = error._tag === "ShowHelp" ? error.errors : [error]
      if (errors.length === 0) return
      const message = errors.map((e) => e.message).join("; ")
      if (cliArgs.json) {
        yield* emitJson(failure(commandName, "usage", message, { exitCode: ExitCode.usage }))
        yield* stderrLine(message)
      }
      yield* exitWith(ExitCode.usage)
    })

  // Command failures not handled in place: a failure envelope in --json mode, stderr message, exit 1 or 4.
  const reportFailure = (error: unknown) =>
    Effect.gen(function* () {
      const message = error instanceof Error ? error.message : String(error)
      const exitCode = exitCodeForError(error)
      if (cliArgs.json) {
        yield* emitJson(
          failure(commandName, exitCode === ExitCode.host ? "relay_unavailable" : "error", message, { exitCode }),
        )
        yield* stderrLine(message)
      } else {
        yield* Console.error(message)
      }
      yield* exitWith(exitCode)
    })

  const silent = () => {}
  const askedForHelp = cliArgs.argv.some((arg) => arg === "--help" || arg === "-h")
  const quietJson = cliArgs.json && !askedForHelp

  Command.runWith(opencodeBrowser, { version: opencodeBrowserVersion, renderErrors: !quietJson })(
    normalizeCliArguments(cliArgs.argv),
  ).pipe(
    quietJson ? Effect.provideService(Console.Console, { ...globalThis.console, log: silent }) : (effect) => effect,
    Effect.catchIf(CliError.isCliError, reportUsageError),
    Effect.catch(reportFailure),
    Effect.provide(mainLayer),
    NodeRuntime.runMain,
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli()
}
