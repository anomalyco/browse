import { Effect } from "effect"
import path from "node:path"
import { registerMcpTools } from "./registry.ts"
import {
  FlightRecorderToolOutput,
  RecordingToolOutput,
  objectSchema,
  optionalBooleanField,
  optionalPositiveIntegerField,
  optionalStringField,
  requiredAction,
  requiredStringField,
  requireObject,
  sessionSchemaProperty,
} from "./schema.ts"

const recordingActions = ["start", "stop", "status", "cancel"] as const
const flightRecorderActions = ["start", "status", "save_last", "cancel"] as const

registerMcpTools({
  order: 400,
  build: (ctx) => [
    {
      name: "recording",
      description:
        "Record the current session tab. Actions: start begins recording (CDP mode records WebM or MP4; native agent-tab MP4 fits the visible tab surface within the viewport bounds without padding; tab-capture supports WebM and optional audio; outputPath is required); stop finalizes the artifact; status returns bounded status and quality counters when available; cancel discards the unfinished artifact.",
      inputSchema: objectSchema(
        {
          action: {
            type: "string",
            enum: [...recordingActions],
            description: "start begins, stop finalizes, status reports, cancel discards the recording.",
          },
          session: sessionSchemaProperty,
          outputPath: {
            type: "string",
            description: "For start: recording artifact path, resolved against the MCP process working directory.",
          },
          mode: {
            type: "string",
            enum: ["auto", "tab-capture", "cdp"],
            description: "For start: recording backend. Defaults to auto.",
          },
          audio: { type: "boolean", description: "For start: capture tab audio in tab-capture mode." },
          frameRate: { type: "integer", minimum: 1, maximum: 60, description: "For start: requested frame rate." },
          maxDurationMs: {
            type: "integer",
            minimum: 1,
            description: "For start: maximum recording duration in milliseconds.",
          },
          cursor: {
            type: "boolean",
            description:
              "For start: draw the ghost cursor in the recording, for demo videos. Off by default: recordings show only the page, with nothing from browse in the frame.",
          },
        },
        ["action"],
      ),
      readOnly: false,
      destructive: true,
      idempotent: false,
      openWorld: false,
      requiresRelayCompatibility: (input) => optionalStringField(input, "action") !== "status",
      outputSchema: RecordingToolOutput,
      handle: (input) =>
        Effect.gen(function* () {
          const action = yield* Effect.try(() => requiredAction(input, recordingActions))
          const object = requireObject(input)
          const sessionId = yield* ctx.resolveSessionId(object)
          if (action === "status") {
            return { action, session: sessionId, ...(yield* ctx.relay.recordingStatus({ sessionId })) }
          }
          if (action === "cancel") {
            return { action, session: sessionId, ...(yield* ctx.relay.recordingCancel({ sessionId })) }
          }
          if (action === "stop") {
            return { action, session: sessionId, ...(yield* ctx.relay.recordingStop({ sessionId })) }
          }
          const mode = optionalStringField(object, "mode")
          if (mode !== undefined && mode !== "auto" && mode !== "tab-capture" && mode !== "cdp") {
            return yield* Effect.fail(new Error("mode must be auto, tab-capture, or cdp"))
          }
          const frameRate = optionalPositiveIntegerField(object, "frameRate")
          if (frameRate !== undefined && frameRate > 60) return yield* Effect.fail(new Error("frameRate must be at most 60"))
          const maxDurationMs = optionalPositiveIntegerField(object, "maxDurationMs")
          const audio = optionalBooleanField(object, "audio")
          const cursor = optionalBooleanField(object, "cursor")
          return {
            action,
            session: sessionId,
            ...(yield* ctx.relay.recordingStart({
              sessionId,
              outputPath: path.resolve(requiredStringField(object, "outputPath")),
              ...(mode ? { mode } : {}),
              ...(audio === undefined ? {} : { audio }),
              ...(frameRate === undefined ? {} : { frameRate }),
              ...(maxDurationMs === undefined ? {} : { maxDurationMs }),
              ...(cursor === undefined ? {} : { cursor }),
            })),
          }
        }),
    },
  ],
})

registerMcpTools({
  order: 500,
  build: (ctx) => [
    {
      name: "flight_recorder",
      description:
        "Keep a rolling in-memory video buffer for the current session tab. Actions: start begins buffering; status returns bounded rolling-buffer duration, frame, byte and drop counters; save_last encodes and saves the most recent buffered video without stopping the buffer (outputPath is required); cancel stops and discards the buffer.",
      inputSchema: objectSchema(
        {
          action: {
            type: "string",
            enum: [...flightRecorderActions],
            description: "start begins buffering, status reports, save_last saves a clip, cancel discards the buffer.",
          },
          session: sessionSchemaProperty,
          retentionMs: {
            type: "integer",
            minimum: 1000,
            maximum: 120000,
            description: "For start: rolling retention window. Defaults to 60000.",
          },
          frameRate: {
            type: "integer",
            minimum: 1,
            maximum: 60,
            description: "For start: saved clip frame rate. Defaults to 60.",
          },
          cursor: {
            type: "boolean",
            description: "For start: draw the ghost cursor in the buffered video. Off by default.",
          },
          outputPath: {
            type: "string",
            description:
              "For save_last: fresh .webm or .mp4 path, resolved against the MCP process working directory.",
          },
          durationMs: {
            type: "integer",
            minimum: 1,
            description: "For save_last: recent duration to save. Defaults to 30000 and cannot exceed retention.",
          },
        },
        ["action"],
      ),
      readOnly: false,
      destructive: true,
      idempotent: false,
      openWorld: false,
      requiresRelayCompatibility: (input) => optionalStringField(input, "action") !== "status",
      outputSchema: FlightRecorderToolOutput,
      handle: (input) =>
        Effect.gen(function* () {
          const action = yield* Effect.try(() => requiredAction(input, flightRecorderActions))
          const object = requireObject(input)
          const sessionId = yield* ctx.resolveSessionId(object)
          if (action === "status") {
            return { action, session: sessionId, ...(yield* ctx.relay.flightRecorderStatus({ sessionId })) }
          }
          if (action === "cancel") {
            return { action, session: sessionId, ...(yield* ctx.relay.flightRecorderCancel({ sessionId })) }
          }
          if (action === "save_last") {
            const durationMs = optionalPositiveIntegerField(object, "durationMs")
            return {
              action,
              session: sessionId,
              ...(yield* ctx.relay.flightRecorderSaveLast({
                sessionId,
                outputPath: path.resolve(requiredStringField(object, "outputPath")),
                ...(durationMs === undefined ? {} : { durationMs }),
              })),
            }
          }
          const retentionMs = optionalPositiveIntegerField(object, "retentionMs")
          const frameRate = optionalPositiveIntegerField(object, "frameRate")
          const cursor = optionalBooleanField(object, "cursor")
          return {
            action,
            session: sessionId,
            ...(yield* ctx.relay.flightRecorderStart({
              sessionId,
              ...(retentionMs === undefined ? {} : { retentionMs }),
              ...(frameRate === undefined ? {} : { frameRate }),
              ...(cursor === undefined ? {} : { cursor }),
            })),
          }
        }),
    },
  ],
})
