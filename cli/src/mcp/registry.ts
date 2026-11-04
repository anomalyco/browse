import type { Effect } from "effect"
import type { JsonObject } from "../protocol.ts"
import type * as RelayClient from "../relay-client.ts"
import type { UpdateNotice } from "../update.ts"
import { browsersNote, optionalStringField, type BrowserSummary, type CurrentSession } from "./schema.ts"

export type McpToolSpec = {
  readonly name: string
  readonly description: string
  readonly inputSchema: JsonObject
  readonly readOnly: boolean
  readonly destructive: boolean
  readonly idempotent: boolean
  readonly requiresRelayCompatibility?: boolean
  readonly listsBrowsers?: boolean
  readonly handle: (input: unknown) => Effect.Effect<unknown, Error>
}

export type McpToolContext = {
  readonly relay: RelayClient.Interface
  readonly currentSession: CurrentSession
  readonly packageRoot: string
  readonly update: () => UpdateNotice | undefined
  readonly browsers: readonly BrowserSummary[]
  readonly browserNote: string
  readonly browserProperty: { readonly type: "string"; readonly description: string }
  readonly resolveSessionId: (input: unknown, field?: string) => string
  readonly establishCurrentSession: (id: string) => void
}

type RegisteredMcpGroup = {
  readonly order: number
  readonly nonCompatibilityTools: readonly string[]
  readonly build: (ctx: McpToolContext) => readonly McpToolSpec[]
}

const groups: RegisteredMcpGroup[] = []
const nonCompatibilityToolSet = new Set<string>()

/**
 * Register MCP tools from a feature module rather than appending to a central array.
 * Entries are sorted deterministically by `order`.
 */
export function registerMcpTools(options: {
  readonly order: number
  readonly nonCompatibilityTools?: readonly string[]
  readonly build: (ctx: McpToolContext) => readonly McpToolSpec[]
}): void {
  groups.push({
    order: options.order,
    nonCompatibilityTools: options.nonCompatibilityTools ?? [],
    build: options.build,
  })
  for (const name of options.nonCompatibilityTools ?? []) {
    nonCompatibilityToolSet.add(name)
  }
}

export function createMcpToolContext(options: {
  readonly relay: RelayClient.Interface
  readonly currentSession: CurrentSession
  readonly packageRoot: string
  readonly update?: () => UpdateNotice | undefined
  readonly browsers?: readonly BrowserSummary[]
}): McpToolContext {
  const browsers = options.browsers ?? []
  const browserNote = browsersNote(browsers)
  const browserProperty = {
    type: "string",
    description: `Optional browser id for a new session's tabs; omit for the default browser. A session stays in its browser.${browserNote}`,
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
    browsers,
    browserNote,
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

export function mcpToolRequiresRelayCompatibility(name: string): boolean {
  return !nonCompatibilityToolSet.has(name)
}
