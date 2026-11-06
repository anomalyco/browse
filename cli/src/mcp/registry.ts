import type { Effect, Schema } from "effect"
import type { McpSchema } from "effect/ai"
import type { JsonObject } from "../protocol.ts"
import type * as RelayClient from "../relay/client.ts"
import type { UpdateNotice } from "../update.ts"
import { optionalStringField, type CurrentSession } from "./schema.ts"

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
  readonly currentSession: CurrentSession
  readonly packageRoot: string
  readonly update: () => UpdateNotice | undefined
  readonly browserProperty: { readonly type: "string"; readonly description: string }
  readonly resolveSessionId: (input: unknown, field?: string) => string
  readonly establishCurrentSession: (id: string) => void
}

type RegisteredMcpGroup = {
  readonly order: number
  readonly build: (ctx: McpToolContext) => readonly McpToolSpec[]
}

const groups: RegisteredMcpGroup[] = []

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

export function createMcpToolContext(options: {
  readonly relay: RelayClient.Interface
  readonly currentSession: CurrentSession
  readonly packageRoot: string
  readonly update?: () => UpdateNotice | undefined
}): McpToolContext {
  const browserProperty = {
    type: "string",
    description:
      "Optional browser id for a new session's tabs; omit for the default browser. A session stays in its browser. Call status to list the connected browsers.",
  } as const
  // session_reset and session_delete name the session `id`; `session`, as every other tool calls it, means the same
  // there. Ignoring it used to reset or delete the current session instead of the one asked for.
  const resolveSessionId = (input: unknown, field = "session") =>
    optionalStringField(input, field) ??
    (field === "id" ? optionalStringField(input, "session") : undefined) ??
    options.currentSession.id
  const establishCurrentSession = (id: string) => {
    options.currentSession.id = id
    options.currentSession.established = true
  }
  return {
    relay: options.relay,
    currentSession: options.currentSession,
    packageRoot: options.packageRoot,
    update: options.update ?? (() => undefined),
    browserProperty,
    resolveSessionId,
    establishCurrentSession,
  }
}

export function buildRegisteredMcpTools(ctx: McpToolContext): readonly McpToolSpec[] {
  return [...groups]
    .sort((left, right) => left.order - right.order)
    .flatMap((group) => group.build(ctx))
}
