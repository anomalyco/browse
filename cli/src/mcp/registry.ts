import { createHash } from "node:crypto"
import { Effect, Option, type Schema } from "effect"
import { McpSchema } from "effect/ai"
import type { JsonObject } from "../protocol.ts"
import type * as RelayClient from "../relay/client.ts"
import type { UpdateNotice } from "../update.ts"
import { optionalStringField, type Caller, type CurrentSession } from "./schema.ts"

export type McpToolSpec = {
  readonly name: string
  readonly description: string
  readonly inputSchema: JsonObject
  readonly readOnly: boolean
  readonly destructive: boolean
  readonly idempotent: boolean
  /** Whether the tool reaches arbitrary web pages, as opposed to only browse's own state. */
  readonly openWorld: boolean
  readonly requiresRelayCompatibility?: boolean | ((input: unknown) => boolean)
  readonly handle: (input: unknown) => Effect.Effect<unknown, Error>
  /** The Effect schema of this tool's structured result, advertised to clients as a JSON Schema. */
  readonly outputSchema?: Schema.ConstraintEncoder<unknown, never>
  /** Overrides the generic tool result (execute shapes its value and context itself). */
  readonly result?: (value: unknown) => McpSchema.CallToolResult
}

export type McpToolContext = {
  readonly relay: RelayClient.Interface
  readonly packageRoot: string
  readonly update: () => UpdateNotice | undefined
  readonly browserProperty: { readonly type: "string"; readonly description: string }
  /** The agent making this tool call, with its own current session. */
  readonly caller: Effect.Effect<Caller>
  /** The session a call names (`session`, or `field`), or else the caller's current one. */
  readonly resolveSessionId: (input: unknown, field?: string) => Effect.Effect<string>
  readonly establishCurrentSession: (caller: Caller, id: string) => void
  readonly forgetSession: (id: string) => void
}

type RegisteredMcpGroup = {
  readonly order: number
  readonly build: (ctx: McpToolContext) => readonly McpToolSpec[]
}

const groups: RegisteredMcpGroup[] = []
const maxRememberedCallers = 1024

/**
 * Register MCP tools from a feature module rather than appending to a central array.
 * Entries are sorted deterministically by `order`.
 */
export function registerMcpTools(options: {
  readonly order: number
  readonly build: (ctx: McpToolContext) => readonly McpToolSpec[]
}): void {
  groups.push({
    order: options.order,
    build: options.build,
  })
}

/** The `tools/call` `_meta` key OpenCode sets to the calling agent's session id. */
export const opencodeSessionMetaKey = "ai.opencode/sessionID"

/** The implicit browse session of an OpenCode agent session: the same in every server, so it survives an update. */
export function callerSessionId(opencodeSessionId: string): string {
  return `mcp-${createHash("sha256").update(opencodeSessionId).digest("hex").slice(0, 8)}`
}

export function createMcpToolContext(options: {
  readonly relay: RelayClient.Interface
  /** The session of calls that don't say who is calling. */
  readonly currentSession: CurrentSession
  readonly packageRoot: string
  readonly update?: () => UpdateNotice | undefined
}): McpToolContext {
  const browserProperty = {
    type: "string",
    description:
      "Optional browser id for a new session's tabs; omit for the default browser. A session stays in its browser. Call status to list the connected browsers.",
  } as const
  const newCaller = (session: CurrentSession): Caller => ({ ...session, sessions: new Set(session.established ? [session.id] : []), updateNoted: false })
  // One MCP server can serve many agents: OpenCode runs one per server config and process, shared by every agent
  // session and subagent, and names the caller in each call's _meta. Each caller keeps its own current session, so one
  // agent's bare execute or session_use never moves another's page. Calls without a caller id share the server's.
  const shared = newCaller(options.currentSession)
  const callers = new Map<string, Caller>()
  const caller = Effect.serviceOption(McpSchema.McpRequestContext).pipe(Effect.map((context) => {
    const meta = Option.getOrUndefined(context)?.requestMetadata
    const id = meta && opencodeSessionMetaKey in meta ? meta[opencodeSessionMetaKey] : undefined
    if (typeof id !== "string" || id === "") return shared
    const known = callers.get(id)
    if (known) {
      callers.delete(id)
      callers.set(id, known)
      return known
    }
    if (callers.size >= maxRememberedCallers) callers.delete(callers.keys().next().value!)
    // A session the user pinned for this server (OPENCODE_BROWSER_SESSION) stays every caller's starting session.
    const created = newCaller(options.currentSession.established ? options.currentSession : { id: callerSessionId(id), established: false })
    callers.set(id, created)
    return created
  }))
  // session_reset and session_delete name the session `id`; `session`, as every other tool calls it, means the same
  // there. Ignoring it used to reset or delete the current session instead of the one asked for.
  const resolveSessionId = (input: unknown, field = "session") =>
    caller.pipe(Effect.map((current) =>
      optionalStringField(input, field) ??
      (field === "id" ? optionalStringField(input, "session") : undefined) ??
      current.id
    ))
  const establishCurrentSession = (current: Caller, id: string) => {
    current.id = id
    current.established = true
    current.sessions.add(id)
  }
  return {
    relay: options.relay,
    packageRoot: options.packageRoot,
    update: options.update ?? (() => undefined),
    browserProperty,
    caller,
    resolveSessionId,
    establishCurrentSession,
    forgetSession: (id) => {
      shared.sessions.delete(id)
      for (const current of callers.values()) current.sessions.delete(id)
    },
  }
}

export function buildRegisteredMcpTools(ctx: McpToolContext): readonly McpToolSpec[] {
  return [...groups]
    .sort((left, right) => left.order - right.order)
    .flatMap((group) => group.build(ctx))
}
