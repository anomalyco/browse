import { Effect, Predicate } from "effect"
import { registerMcpTools } from "./registry.ts"
import {
  emptyInputSchema,
  ensureSessionExists,
  objectSchema,
  optionalBooleanField,
  optionalStringArrayField,
  optionalStringField,
  parseAdoptArguments,
  requiredStringField,
  requireObject,
  sessionAliasSchemaProperty,
  sessionSchemaProperty,
} from "./schema.ts"

registerMcpTools({
  order: 200,
  build: (ctx) => [
    {
      name: "session_new",
      listsBrowsers: true,
      description: `Create a browse session and make it current for this MCP server.${ctx.browserNote}`,
      inputSchema: objectSchema({
        browser: ctx.browserProperty,
        id: { type: "string", description: "Optional lowercase session id." },
        readOnly: {
          type: "boolean",
          description:
            "Create a read-only session: the relay rejects input-dispatching CDP so scripts can inspect but not click or type.",
        },
        allowedOrigins: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional domain allowlist: hosts or origins this session's tabs may load (example.com, *.example.com, https://app.example.com, http://localhost:3000). Navigations elsewhere are refused or sent back to about:blank; private and loopback addresses need an exact entry.",
        },
      }),
      readOnly: false,
      destructive: false,
      idempotent: false,
      handle: (input) =>
        Effect.gen(function* () {
          const requestedId = optionalStringField(input, "id")
          const readOnly = optionalBooleanField(input, "readOnly")
          const allowedOrigins = optionalStringArrayField(input, "allowedOrigins")
          const browser = optionalStringField(input, "browser")
          const session = yield* ctx.relay.sessionNew(requestedId, {
            ...(readOnly ? { readOnly: true } : {}),
            ...(allowedOrigins ? { allowedOrigins } : {}),
            ...(browser ? { browser } : {}),
          })
          ctx.establishCurrentSession(session.id)
          return { session }
        }),
    },
    {
      name: "session_allowlist",
      description:
        "Set the domain allowlist of a session (the current one by default): the hosts or origins its tabs may load. Pass an empty list to remove it. Use it before typing secrets or working on sites with untrusted content.",
      inputSchema: objectSchema(
        {
          session: { type: "string", description: "Session id; defaults to the current session." },
          allowedOrigins: {
            type: "array",
            items: { type: "string" },
            description:
              "Patterns: example.com, *.example.com, https://app.example.com, http://localhost:3000. Empty removes the allowlist.",
          },
        },
        ["allowedOrigins"],
      ),
      readOnly: false,
      destructive: false,
      idempotent: true,
      handle: (input) =>
        Effect.gen(function* () {
          const sessionId = ctx.resolveSessionId(input)
          const allowedOrigins = requireObject(input).allowedOrigins
          if (!Array.isArray(allowedOrigins) || !allowedOrigins.every((item) => Predicate.isString(item))) {
            return yield* Effect.fail(new Error("allowedOrigins must be an array of strings"))
          }
          return { session: yield* ctx.relay.sessionAllowlist(sessionId, allowedOrigins) }
        }),
    },
    {
      name: "session_list",
      requiresRelayCompatibility: false,
      description: "List browse sessions.",
      inputSchema: emptyInputSchema,
      readOnly: true,
      destructive: false,
      idempotent: false,
      handle: () => ctx.relay.sessions.pipe(Effect.map((sessions) => ({ sessions }))),
    },
    {
      name: "session_current",
      requiresRelayCompatibility: false,
      description: "Return this MCP server's current browse session id.",
      inputSchema: emptyInputSchema,
      readOnly: true,
      destructive: false,
      idempotent: true,
      handle: () => Effect.succeed({ currentSession: ctx.currentSession.id }),
    },
    {
      name: "session_use",
      description: "Set this MCP server's current browse session id.",
      inputSchema: objectSchema(
        {
          id: { type: "string", description: "Existing browse session id." },
        },
        ["id"],
      ),
      readOnly: false,
      destructive: false,
      idempotent: true,
      handle: (input) =>
        Effect.gen(function* () {
          const id = yield* Effect.try(() => requiredStringField(input, "id"))
          yield* ensureSessionExists(ctx.relay, id)
          ctx.establishCurrentSession(id)
          return { currentSession: ctx.currentSession.id }
        }),
    },
    {
      name: "session_reset",
      description: "Reset a browse session's state and page.",
      inputSchema: objectSchema({
        id: sessionSchemaProperty,
        session: sessionAliasSchemaProperty,
      }),
      readOnly: false,
      destructive: true,
      idempotent: false,
      handle: (input) =>
        Effect.gen(function* () {
          const id = ctx.resolveSessionId(input, "id")
          const reset = yield* ctx.relay.sessionReset(id)
          ctx.establishCurrentSession(id)
          return reset
        }),
    },
    {
      name: "session_delete",
      description: "Delete a browse session.",
      inputSchema: objectSchema({
        id: sessionSchemaProperty,
        session: sessionAliasSchemaProperty,
      }),
      readOnly: false,
      destructive: true,
      idempotent: true,
      handle: (input) =>
        Effect.gen(function* () {
          const id = ctx.resolveSessionId(input, "id")
          const result = yield* ctx.relay.sessionDelete(id)
          if (ctx.currentSession.id === id) {
            ctx.currentSession.id = `mcp-${crypto.randomUUID().slice(0, 8)}`
            ctx.currentSession.established = false
          }
          return { ...result, currentSession: ctx.currentSession.id }
        }),
    },
    {
      name: "session_adopt",
      description:
        "Make an attached tab the browse session's default page for subsequent bare execute calls. Omit targetUrl and targetIndex when only one user-attached tab is available.",
      inputSchema: objectSchema({
        session: {
          type: "string",
          description:
            "Optional existing browse session id. Explicit ids must already exist; omit this field to use the MCP server's current session, which is created when needed.",
        },
        targetUrl: {
          type: "string",
          description:
            "Adopt an existing attached page whose URL contains this text. Omit when only one user-attached tab is available. This does not navigate or open a URL.",
        },
        targetIndex: {
          type: "integer",
          minimum: 0,
          description: "Adopt the attached page at this zero-based target index.",
        },
        tabId: {
          type: "integer",
          description: "Adopt the user's tab with this Chrome tab id (the tab= value in status).",
        },
      }),
      readOnly: false,
      destructive: false,
      idempotent: false,
      handle: (input) =>
        Effect.gen(function* () {
          const args = yield* Effect.try(() => parseAdoptArguments(input))
          const sessionId = args.session ?? ctx.currentSession.id
          const result = yield* ctx.relay.sessionAdopt({
            sessionId,
            createIfMissing: !args.session,
            ...(args.targetSelection ? { targetSelection: args.targetSelection } : {}),
            ...(args.tabId === undefined ? {} : { tabId: args.tabId }),
          })
          ctx.establishCurrentSession(sessionId)
          return {
            ...result,
            confirmation: `Adopted session '${result.session.id}' default page: ${result.adoptedUrl}`,
          }
        }),
    },
  ],
})
