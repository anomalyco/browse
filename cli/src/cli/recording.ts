import { Console, Effect, Option } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import path from "node:path"
import * as RelayClient from "../relay/client.ts"
import {
  emitJson,
  ensureCliRelay,
  ensureCliRelayAndExtension,
  formatRecordingQuality,
  jsonFlag,
  printOr,
  recordingTarget,
  sessionFlag,
  tabIdFlag,
} from "./context.ts"
import { registerCliCommand } from "./registry.ts"

const recordingStart = Command.make(
  "start",
  {
    outputPath: Argument.String("output-path").pipe(
      Argument.withDescription("Path to write the video: .webm or .mp4"),
    ),
    session: sessionFlag("Record the page for this browse or CDP session id"),
    tabId: tabIdFlag("Record this attached Chrome tab id"),
    frameRate: Flag.Int("frame-rate").pipe(
      Flag.optional,
      Flag.withDescription("Output frame rate, integer 1..60; defaults to 60"),
    ),
    maxDurationMs: Flag.Int("max-duration-ms").pipe(
      Flag.optional,
      Flag.withDescription("Auto-stop guard in milliseconds, defaults to 900000"),
    ),
    json: jsonFlag,
  },
  Effect.fn("Cli.recordingStart")(function* ({
    outputPath,
    session,
    tabId,
    frameRate,
    maxDurationMs,
    json,
  }) {
    if (Option.isSome(frameRate) && (frameRate.value < 1 || frameRate.value > 60)) {
      return yield* Effect.fail(new Error("Recording frameRate must be an integer from 1 to 60"))
    }
    const relay = yield* RelayClient.Service
    yield* ensureCliRelayAndExtension()
    const target = yield* recordingTarget({ session, tabId })
    const resolvedOutputPath = path.resolve(outputPath)
    const result = yield* relay.recordingStart({
      ...target,
      outputPath: resolvedOutputPath,
      ...(Option.isSome(frameRate) ? { frameRate: frameRate.value } : {}),
      ...(Option.isSome(maxDurationMs) ? { maxDurationMs: maxDurationMs.value } : {}),
    })
    if (!result.success) {
      return yield* Effect.fail(new Error(result.error ?? "Failed to start recording"))
    }
    yield* printOr(
      json,
      result,
      `Recording started: ${result.path ?? resolvedOutputPath} tab=${result.tabId ?? "unknown"} artifact=${result.artifactType ?? "webm"} mime=${result.mimeType ?? "video/webm"} fps=${result.frameRate ?? "unknown"}`,
    )
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
    if (json) return yield* emitJson(result)
    const frames = result.frameCount === undefined ? "" : `, frames=${result.frameCount}`
    yield* Console.log(
      `Recording saved: ${result.path ?? "unknown"} (${result.size ?? 0} bytes, ${result.duration ?? 0}ms, artifact=${result.artifactType ?? "webm"}${frames})`,
    )
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
      yield* emitJson(result)
      return
    }
    if (!result.isRecording) {
      yield* Console.log("Recording: inactive")
      return
    }
    const frames = result.frameCount === undefined ? "" : ` frameCount=${result.frameCount}`
    yield* Console.log(
      `Recording: active tab=${result.tabId ?? "unknown"} artifact=${result.artifactType ?? "webm"} path=${result.path ?? "unknown"} size=${result.size ?? 0}${frames} startedAt=${result.startedAt ?? "unknown"}`,
    )
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

registerCliCommand(700, () => recording)
