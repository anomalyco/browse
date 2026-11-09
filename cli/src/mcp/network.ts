import { Effect } from "effect"
import path from "node:path"
import * as RelayLifecycle from "../relay/lifecycle.ts"
import { registerMcpTools } from "./registry.ts"
import {
  NetworkToolOutput,
  ensureSessionExists,
  objectSchema,
  optionalPositiveIntegerField,
  optionalStringArrayField,
  optionalStringField,
  requiredAction,
  requireObject,
  sessionSchemaProperty,
} from "./schema.ts"

const actions = ["start", "status", "stop", "cancel"] as const

registerMcpTools({
  order: 300,
  build: (ctx) => [
    {
      name: "network",
      description:
        "Start, inspect, stop, or cancel session-scoped network capture. browse records normalized Playwright exchanges; HAR is only the optional export format. Bodies are embedded by default with per-body and total memory limits. Actions: start begins a capture; status returns bounded metadata for the active capture without captured values; stop ends it and optionally writes a credential-redacted HAR and stores lossless credential values in a reusable secret profile (at least one of outputPath or secrets is required); cancel ends it and discards the in-memory exchanges.",
      inputSchema: objectSchema(
        {
          action: {
            type: "string",
            enum: [...actions],
            description:
              "start begins a capture, status reports its bounded metadata, stop writes a redacted HAR and/or secret profile, cancel discards it.",
          },
          session: {
            type: "string",
            description:
              "Optional session id. Defaults to your current session; start creates it when missing.",
          },
          urlFilter: { type: "string", description: "For start: capture only request URLs containing this text." },
          resourceTypes: {
            type: "array",
            items: { type: "string" },
            description: "For start: optional Playwright resource types such as fetch and xhr.",
          },
          content: {
            type: "string",
            enum: ["embed", "omit"],
            description: "For start: request and response body mode. Defaults to embed.",
          },
          maxBodyBytes: {
            type: "integer",
            minimum: 1,
            description: "For start: maximum bytes captured from each body. Defaults to 1000000.",
          },
          maxTotalBodyBytes: {
            type: "integer",
            minimum: 1,
            description: "For start: maximum body bytes retained for the capture. Defaults to 25000000.",
          },
          maxEntries: {
            type: "integer",
            minimum: 1,
            description: "For start: maximum captured requests. Defaults to 1000.",
          },
          maxDurationMs: {
            type: "integer",
            minimum: 1,
            maximum: 86_400_000,
            description:
              "For start: the capture ends by itself, discarding what it captured, after this long. Defaults to 1800000 (30 minutes). It also ends when this MCP server exits.",
          },
          outputPath: {
            type: "string",
            description:
              "For stop: optional artifact path, resolved against the MCP process working directory. The HAR contains stable ${BC_SECRET_N} references (and redaction-only ${BC_REDACTED_N} for passwords, one-time codes and token-like URL path segments), not captured values.",
          },
          secrets: {
            type: "string",
            description: "For stop: optional reusable profile name for captured credential values.",
          },
        },
        ["action"],
      ),
      readOnly: false,
      destructive: true,
      idempotent: false,
      openWorld: false,
      requiresRelayCompatibility: (input) => optionalStringField(input, "action") !== "status",
      outputSchema: NetworkToolOutput,
      handle: (input) =>
        Effect.gen(function* () {
          const action = yield* Effect.try(() => requiredAction(input, actions))
          const object = requireObject(input)
          if (action === "status") {
            const sessionId = yield* ctx.resolveSessionId(object)
            return { action, session: sessionId, ...(yield* ctx.relay.networkStatus({ sessionId })) }
          }
          if (action === "cancel") {
            const sessionId = yield* ctx.resolveSessionId(object)
            return { action, session: sessionId, ...(yield* ctx.relay.networkCancel({ sessionId })) }
          }
          if (action === "stop") {
            const sessionId = yield* ctx.resolveSessionId(object)
            const outputPath = optionalStringField(object, "outputPath")
            const secrets = optionalStringField(object, "secrets")
            if (!outputPath && !secrets) {
              return yield* Effect.fail(new Error("network stop requires outputPath, secrets, or both"))
            }
            return {
              action,
              session: sessionId,
              ...(yield* ctx.relay.networkStop({
                sessionId,
                ...(outputPath ? { outputPath: path.resolve(outputPath) } : {}),
                ...(secrets ? { secrets } : {}),
              })),
            }
          }
          const explicitSession = optionalStringField(object, "session")
          const caller = yield* ctx.caller
          const sessionId = explicitSession ?? caller.id
          if (explicitSession) {
            yield* ensureSessionExists(ctx.relay, sessionId)
          } else {
            yield* ctx.relay.sessionEnsure(sessionId)
            caller.established = true
          }
          yield* RelayLifecycle.ensureExtensionConnected({ relay: ctx.relay, sessionId, waitForReconnect: true })
          const content = optionalStringField(object, "content")
          if (content !== undefined && content !== "embed" && content !== "omit") {
            return yield* Effect.fail(new Error("content must be embed or omit"))
          }
          const urlFilter = optionalStringField(object, "urlFilter")
          const resourceTypes = optionalStringArrayField(object, "resourceTypes")
          const maxBodyBytes = optionalPositiveIntegerField(object, "maxBodyBytes")
          const maxTotalBodyBytes = optionalPositiveIntegerField(object, "maxTotalBodyBytes")
          const maxEntries = optionalPositiveIntegerField(object, "maxEntries")
          const maxDurationMs = optionalPositiveIntegerField(object, "maxDurationMs")
          const result = yield* ctx.relay.networkStart({
            sessionId,
            ...(urlFilter ? { urlFilter } : {}),
            ...(resourceTypes && resourceTypes.length > 0 ? { resourceTypes } : {}),
            ...(content ? { content } : {}),
            ...(maxBodyBytes === undefined ? {} : { maxBodyBytes }),
            ...(maxTotalBodyBytes === undefined ? {} : { maxTotalBodyBytes }),
            ...(maxEntries === undefined ? {} : { maxEntries }),
            ...(maxDurationMs === undefined ? {} : { maxDurationMs }),
          })
          return { action, session: sessionId, ...result }
        }),
    },
  ],
})
