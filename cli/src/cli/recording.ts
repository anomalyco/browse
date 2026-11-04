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
  parseRecordingModeOption,
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
      Argument.withDescription("Path to write the recording artifact; tabCapture requires .webm, CDP accepts .webm or .mp4"),
    ),
    session: sessionFlag("Record the page for this Browse or CDP session id"),
    tabId: tabIdFlag("Record this attached Chrome tab id"),
    mode: Flag.String("mode").pipe(
      Flag.optional,
      Flag.withDescription(
        "Recording mode: auto, tab-capture, or cdp. auto uses CDP for relay-owned tabs and tabCapture for user-owned tabs",
      ),
    ),
    audio: Flag.Boolean("audio").pipe(Flag.withDefault(false), Flag.withDescription("Include tab audio")),
    frameRate: Flag.Int("frame-rate").pipe(
      Flag.optional,
      Flag.withDescription("Output frame rate, integer 1..60; defaults to 30 for tab-capture and 60 for CDP"),
    ),
    maxDurationMs: Flag.Int("max-duration-ms").pipe(
      Flag.optional,
      Flag.withDescription("Auto-stop guard in milliseconds, defaults to 900000"),
    ),
    cursor: Flag.Boolean("cursor").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Draw the ghost cursor in the recording (off by default: only the page is recorded)"),
    ),
    json: jsonFlag,
  },
  Effect.fn("Cli.recordingStart")(function* ({
    outputPath,
    session,
    tabId,
    mode,
    audio,
    frameRate,
    maxDurationMs,
    cursor,
    json,
  }) {
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
    yield* printOr(
      json,
      result,
      `Recording started: ${result.path ?? resolvedOutputPath} tab=${result.tabId ?? "unknown"} mode=${result.mode ?? "tab-capture"} artifact=${result.artifactType ?? "webm"} mime=${result.mimeType ?? "video/webm"} fps=${result.frameRate ?? "unknown"}`,
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
      `Recording saved: ${result.path ?? "unknown"} (${result.size ?? 0} bytes, ${result.duration ?? 0}ms, mode=${result.mode ?? "tab-capture"}, artifact=${result.artifactType ?? "webm"}${frames})`,
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
      `Recording: active tab=${result.tabId ?? "unknown"} mode=${result.mode ?? "tab-capture"} artifact=${result.artifactType ?? "webm"} path=${result.path ?? "unknown"} size=${result.size ?? 0}${frames} startedAt=${result.startedAt ?? "unknown"}`,
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

const flightRecorderStart = Command.make(
  "start",
  {
    session: sessionFlag("Buffer the tab owned by this session"),
    tabId: tabIdFlag("Buffer this attached Chrome tab id"),
    retentionMs: Flag.Int("retention-ms").pipe(
      Flag.optional,
      Flag.withDescription("Ring-buffer duration in milliseconds (1000..120000; default 60000)"),
    ),
    frameRate: Flag.Int("frame-rate").pipe(Flag.optional, Flag.withDescription("Output frame rate from 1 to 60")),
    cursor: Flag.Boolean("cursor").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Draw the ghost cursor in the buffered video (off by default)"),
    ),
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
    yield* printOr(json, result, `Flight recorder buffering tab ${result.tabId}; retention=${result.retentionMs}ms`)
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
    if (json) return yield* emitJson(result)
    if (!result.active) return yield* Console.log("Flight recorder inactive")
    yield* Console.log(
      `Flight recorder tab=${result.tabId} frames=${result.bufferedFrames} retained=${result.retainedDurationMs}ms bytes=${result.bufferedBytes}`,
    )
  }),
).pipe(Command.withDescription("Show rolling flight-recorder status"))

const flightRecorderSaveLast = Command.make(
  "save-last",
  {
    outputPath: Argument.String("output-path").pipe(Argument.withDescription("Fresh .webm or .mp4 artifact path")),
    session: sessionFlag(),
    tabId: tabIdFlag(),
    durationMs: Flag.Int("duration-ms").pipe(
      Flag.optional,
      Flag.withDescription("How much recent history to save; defaults to 30 seconds"),
    ),
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
    yield* printOr(
      json,
      result,
      `Saved ${result.durationMs}ms flight recorder clip (${result.frameCount} frames) to ${result.path}`,
    )
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
  Command.withSubcommands([
    flightRecorderStart,
    flightRecorderStatus,
    flightRecorderSaveLast,
    flightRecorderCancel,
  ]),
)

registerCliCommand(700, () => recording)
registerCliCommand(710, () => flightRecorder)
