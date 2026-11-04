import { Effect } from "effect"
import path from "node:path"
import * as RelayLifecycle from "../relay-lifecycle.ts"
import { registerMcpTools } from "./registry.ts"
import {
  ensureSessionExists,
  objectSchema,
  optionalPositiveIntegerField,
  optionalStringArrayField,
  optionalStringField,
  requireObject,
  sessionOnlyInputSchema,
  sessionSchemaProperty,
} from "./schema.ts"

registerMcpTools({
  order: 300,
  nonCompatibilityTools: ["network_status"],
  build: (ctx) => [
    {
      name: "network_start",
      description:
        "Start session-scoped network capture. Browse records normalized Playwright exchanges; HAR is only the optional export format. Bodies are embedded by default with per-body and total memory limits.",
      inputSchema: objectSchema({
        session: {
          type: "string",
          description: "Optional existing session id. Omit to use or create this MCP server's current session.",
        },
        urlFilter: { type: "string", description: "Capture only request URLs containing this text." },
        resourceTypes: {
          type: "array",
          items: { type: "string" },
          description: "Optional Playwright resource types such as fetch and xhr.",
        },
        content: {
          type: "string",
          enum: ["embed", "omit"],
          description: "Request and response body mode. Defaults to embed.",
        },
        maxBodyBytes: {
          type: "integer",
          minimum: 1,
          description: "Maximum bytes captured from each body. Defaults to 1000000.",
        },
        maxTotalBodyBytes: {
          type: "integer",
          minimum: 1,
          description: "Maximum body bytes retained for the capture. Defaults to 25000000.",
        },
        maxEntries: {
          type: "integer",
          minimum: 1,
          description: "Maximum captured requests. Defaults to 1000.",
        },
        maxDurationMs: {
          type: "integer",
          minimum: 1,
          maximum: 86_400_000,
          description:
            "The capture ends by itself, discarding what it captured, after this long. Defaults to 1800000 (30 minutes). It also ends when this MCP server exits.",
        },
      }),
      readOnly: false,
      destructive: false,
      idempotent: false,
      handle: (input) =>
        Effect.gen(function* () {
          const object = requireObject(input)
          const explicitSession = optionalStringField(object, "session")
          const sessionId = explicitSession ?? ctx.currentSession.id
          if (explicitSession) {
            yield* ensureSessionExists(ctx.relay, sessionId)
          } else {
            yield* ctx.relay.sessionEnsure(sessionId)
            ctx.currentSession.established = true
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
          return { session: sessionId, ...result }
        }),
    },
    {
      name: "network_status",
      requiresRelayCompatibility: false,
      description:
        "Return bounded metadata for a session's active network capture. Captured values are never included.",
      inputSchema: sessionOnlyInputSchema,
      readOnly: true,
      destructive: false,
      idempotent: true,
      handle: (input) => {
        const sessionId = ctx.resolveSessionId(input)
        return ctx.relay.networkStatus({ sessionId }).pipe(Effect.map((result) => ({ session: sessionId, ...result })))
      },
    },
    {
      name: "network_stop",
      description:
        "Stop network capture. Optionally write a credential-redacted HAR and store lossless credential values in a reusable secret profile. At least one of outputPath or secrets is required.",
      inputSchema: objectSchema({
        session: sessionSchemaProperty,
        outputPath: {
          type: "string",
          description:
            "Optional artifact path, resolved against the MCP process working directory. The HAR contains stable ${BC_SECRET_N} references (and redaction-only ${BC_REDACTED_N} for passwords, one-time codes and token-like URL path segments), not captured values.",
        },
        secrets: { type: "string", description: "Optional reusable profile name for captured credential values." },
      }),
      readOnly: false,
      destructive: false,
      idempotent: false,
      handle: (input) =>
        Effect.gen(function* () {
          const sessionId = ctx.resolveSessionId(input)
          const outputPath = optionalStringField(input, "outputPath")
          const secrets = optionalStringField(input, "secrets")
          if (!outputPath && !secrets) {
            return yield* Effect.fail(new Error("network_stop requires outputPath, secrets, or both"))
          }
          return yield* ctx.relay.networkStop({
            sessionId,
            ...(outputPath ? { outputPath: path.resolve(outputPath) } : {}),
            ...(secrets ? { secrets } : {}),
          })
        }),
    },
    {
      name: "network_cancel",
      description: "Cancel a session's network capture and discard its in-memory exchanges.",
      inputSchema: sessionOnlyInputSchema,
      readOnly: false,
      destructive: true,
      idempotent: true,
      handle: (input) => ctx.relay.networkCancel({ sessionId: ctx.resolveSessionId(input) }),
    },
  ],
})
