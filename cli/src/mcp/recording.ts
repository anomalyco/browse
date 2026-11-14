import { Effect } from "effect"
import path from "node:path"
import { registerMcpTools } from "./registry.ts"
import {
  RecordingToolOutput,
  objectSchema,
  optionalPositiveIntegerField,
  optionalStringField,
  requiredAction,
  requiredStringField,
  requireObject,
  sessionSchemaProperty,
} from "./schema.ts"

const recordingActions = ["start", "stop", "status", "cancel"] as const

registerMcpTools({
  order: 400,
  build: (ctx) => [
    {
      name: "recording",
      description:
        "Record the current session tab through CDP. Actions: start begins recording video to a WebM or MP4 file (outputPath is required); stop finalizes the artifact; status returns bounded status and quality counters; cancel discards the unfinished artifact.",
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
          frameRate: { type: "integer", minimum: 1, maximum: 60, description: "For start: requested frame rate." },
          maxDurationMs: {
            type: "integer",
            minimum: 1,
            description: "For start: maximum recording duration in milliseconds.",
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
          const frameRate = optionalPositiveIntegerField(object, "frameRate")
          if (frameRate !== undefined && frameRate > 60) return yield* Effect.fail(new Error("frameRate must be at most 60"))
          const maxDurationMs = optionalPositiveIntegerField(object, "maxDurationMs")
          return {
            action,
            session: sessionId,
            ...(yield* ctx.relay.recordingStart({
              sessionId,
              outputPath: path.resolve(requiredStringField(object, "outputPath")),
              ...(frameRate === undefined ? {} : { frameRate }),
              ...(maxDurationMs === undefined ? {} : { maxDurationMs }),
            })),
          }
        }),
    },
  ],
})
