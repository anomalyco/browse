import { Effect } from "effect"
import path from "node:path"
import {
  FlightRecorderCancelResponse,
  FlightRecorderSaveResponse,
  FlightRecorderStatusResponse,
  RecordingCancelResponse,
  RecordingStartResponse,
  RecordingStatusResponse,
  RecordingStopResponse,
} from "../relay/schema.ts"
import { registerMcpTools } from "./registry.ts"
import {
  objectSchema,
  optionalBooleanField,
  optionalPositiveIntegerField,
  optionalStringField,
  requiredStringField,
  requireObject,
  sessionOnlyInputSchema,
  sessionSchemaProperty,
} from "./schema.ts"

registerMcpTools({
  order: 400,
  build: (ctx) => [
    {
      name: "recording_start",
      description:
        "Start recording the current session tab. CDP mode records video to WebM or MP4; tab-capture mode supports WebM and optional audio.",
      inputSchema: objectSchema(
        {
          session: sessionSchemaProperty,
          outputPath: {
            type: "string",
            description: "Recording artifact path, resolved against the MCP process working directory.",
          },
          mode: {
            type: "string",
            enum: ["auto", "tab-capture", "cdp"],
            description: "Recording backend. Defaults to auto.",
          },
          audio: { type: "boolean", description: "Capture tab audio in tab-capture mode." },
          frameRate: { type: "integer", minimum: 1, maximum: 60, description: "Requested frame rate." },
          maxDurationMs: { type: "integer", minimum: 1, description: "Maximum recording duration in milliseconds." },
          cursor: {
            type: "boolean",
            description:
              "Draw the ghost cursor in the recording, for demo videos. Off by default: recordings show only the page, with nothing from browse in the frame.",
          },
        },
        ["outputPath"],
      ),
      readOnly: false,
      destructive: false,
      idempotent: false,
      outputSchema: RecordingStartResponse,
      handle: (input) => {
        const object = requireObject(input)
        const mode = optionalStringField(object, "mode")
        if (mode !== undefined && mode !== "auto" && mode !== "tab-capture" && mode !== "cdp") {
          return Effect.fail(new Error("mode must be auto, tab-capture, or cdp"))
        }
        const frameRate = optionalPositiveIntegerField(object, "frameRate")
        if (frameRate !== undefined && frameRate > 60) return Effect.fail(new Error("frameRate must be at most 60"))
        const maxDurationMs = optionalPositiveIntegerField(object, "maxDurationMs")
        const audio = optionalBooleanField(object, "audio")
        const cursor = optionalBooleanField(object, "cursor")
        return ctx.relay.recordingStart({
          sessionId: ctx.resolveSessionId(object),
          outputPath: path.resolve(requiredStringField(object, "outputPath")),
          ...(mode ? { mode } : {}),
          ...(audio === undefined ? {} : { audio }),
          ...(frameRate === undefined ? {} : { frameRate }),
          ...(maxDurationMs === undefined ? {} : { maxDurationMs }),
          ...(cursor === undefined ? {} : { cursor }),
        })
      },
    },
    {
      name: "recording_stop",
      description: "Stop the active recording for a session and finalize its artifact.",
      inputSchema: sessionOnlyInputSchema,
      readOnly: false,
      destructive: false,
      idempotent: false,
      outputSchema: RecordingStopResponse,
      handle: (input) => ctx.relay.recordingStop({ sessionId: ctx.resolveSessionId(input) }),
    },
  ],
})

registerMcpTools({
  order: 500,
  build: (ctx) => [
    {
      name: "recording_status",
      requiresRelayCompatibility: false,
      description: "Return bounded status and quality counters for a session recording.",
      inputSchema: sessionOnlyInputSchema,
      readOnly: true,
      destructive: false,
      idempotent: true,
      outputSchema: RecordingStatusResponse,
      handle: (input) => ctx.relay.recordingStatus({ sessionId: ctx.resolveSessionId(input) }),
    },
    {
      name: "recording_cancel",
      description: "Cancel a session recording and discard its unfinished artifact.",
      inputSchema: sessionOnlyInputSchema,
      readOnly: false,
      destructive: true,
      idempotent: true,
      outputSchema: RecordingCancelResponse,
      handle: (input) => ctx.relay.recordingCancel({ sessionId: ctx.resolveSessionId(input) }),
    },
    {
      name: "flight_recorder_start",
      description:
        "Start a rolling in-memory video buffer for the current session tab. Saving a clip does not stop buffering.",
      inputSchema: objectSchema({
        session: sessionSchemaProperty,
        retentionMs: {
          type: "integer",
          minimum: 1000,
          maximum: 120000,
          description: "Rolling retention window. Defaults to 60000.",
        },
        frameRate: {
          type: "integer",
          minimum: 1,
          maximum: 60,
          description: "Saved clip frame rate. Defaults to 60.",
        },
        cursor: { type: "boolean", description: "Draw the ghost cursor in the buffered video. Off by default." },
      }),
      readOnly: false,
      destructive: false,
      idempotent: false,
      outputSchema: FlightRecorderStatusResponse,
      handle: (input) => {
        const object = requireObject(input)
        const retentionMs = optionalPositiveIntegerField(object, "retentionMs")
        const frameRate = optionalPositiveIntegerField(object, "frameRate")
        const cursor = optionalBooleanField(object, "cursor")
        return ctx.relay.flightRecorderStart({
          sessionId: ctx.resolveSessionId(object),
          ...(retentionMs === undefined ? {} : { retentionMs }),
          ...(frameRate === undefined ? {} : { frameRate }),
          ...(cursor === undefined ? {} : { cursor }),
        })
      },
    },
    {
      name: "flight_recorder_status",
      requiresRelayCompatibility: false,
      description: "Return bounded rolling-buffer duration, frame, byte, and drop counters.",
      inputSchema: sessionOnlyInputSchema,
      readOnly: true,
      destructive: false,
      idempotent: true,
      outputSchema: FlightRecorderStatusResponse,
      handle: (input) => ctx.relay.flightRecorderStatus({ sessionId: ctx.resolveSessionId(input) }),
    },
    {
      name: "flight_recorder_save_last",
      description: "Encode and save the most recent buffered browser video without stopping the flight recorder.",
      inputSchema: objectSchema(
        {
          session: sessionSchemaProperty,
          outputPath: {
            type: "string",
            description: "Fresh .webm or .mp4 path, resolved against the MCP process working directory.",
          },
          durationMs: {
            type: "integer",
            minimum: 1,
            description: "Recent duration to save. Defaults to 30000 and cannot exceed retention.",
          },
        },
        ["outputPath"],
      ),
      readOnly: false,
      destructive: false,
      idempotent: false,
      outputSchema: FlightRecorderSaveResponse,
      handle: (input) => {
        const object = requireObject(input)
        const durationMs = optionalPositiveIntegerField(object, "durationMs")
        return ctx.relay.flightRecorderSaveLast({
          sessionId: ctx.resolveSessionId(object),
          outputPath: path.resolve(requiredStringField(object, "outputPath")),
          ...(durationMs === undefined ? {} : { durationMs }),
        })
      },
    },
    {
      name: "flight_recorder_cancel",
      description: "Stop and discard a session's rolling video buffer.",
      inputSchema: sessionOnlyInputSchema,
      readOnly: false,
      destructive: true,
      idempotent: true,
      outputSchema: FlightRecorderCancelResponse,
      handle: (input) => ctx.relay.flightRecorderCancel({ sessionId: ctx.resolveSessionId(input) }),
    },
  ],
})
