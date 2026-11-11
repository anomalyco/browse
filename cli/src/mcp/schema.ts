import { Effect, Option, Predicate, Schema } from "effect"
import { McpSchema } from "effect/ai"
import type { JsonObject } from "../protocol.ts"
import * as RelayClient from "../relay/client.ts"
import { getObject, getString, parseTargetSelection } from "../relay/helpers.ts"
import {
  AuthProfileSummary,
  ExecuteAftermath,
  ExecuteLogEntry,
  ExecuteLogSummary,
  ExtensionStatus,
  RecordingQuality,
  RelayVersion,
  SessionDeleted,
  SettingsGetResponse,
  SettingsSetResponse,
  type ExecuteResponse,
  type TargetSelection,
} from "../relay/schema.ts"
import { settingKeys, type SettingKey, type SettingValue } from "../relay/user-settings.ts"
import type { UpdateNotice } from "../update.ts"

export type CurrentSession = { id: string; established: boolean }

/**
 * An agent calling the tools: its current session, every session it has made current, whether it shares them with
 * every other unnamed caller, and whether it saw the update note.
 */
export type Caller = CurrentSession & { readonly sessions: Set<string>; readonly shared: boolean; updateNoted: boolean }

export type ExecuteArguments = {
  readonly code: string
  readonly session?: string | undefined
  readonly timeoutMs?: number | undefined
  readonly targetSelection?: TargetSelection
  readonly browser?: string
}

export type AdoptArguments = {
  readonly session?: string | undefined
  readonly targetSelection?: TargetSelection
  readonly tabId?: number
}

/** The one-time note on a tool result: what to tell the user, and that the agent may run the update itself. */
export function mcpUpdateNote(notice: Pick<UpdateNotice, "summary" | "command">): string {
  return `Note: browse has an update: ${notice.summary}. Tell the user they can run \`${notice.command}\` and then restart opencode, or ask you to run it for them.`
}

export function objectSchema(properties: JsonObject, required: readonly string[] = []): JsonObject {
  return {
    type: "object",
    properties,
    required: [...required],
    additionalProperties: false,
  }
}

/**
 * A property accepting exactly `values`, as one single-typed `enum` per JSON type. Settings are the one place a tool
 * schema mixes numbers and strings (`idleMinutes` is 10, 30, 60 or "never"), and some MCP clients reject an `enum`
 * whose values have different types, which fails their whole tool list.
 */
export function valuesSchema(values: readonly SettingValue[], description: string): JsonObject {
  const groups = new Map<string, SettingValue[]>()
  for (const value of values) {
    const type = typeof value === "number" ? (Number.isInteger(value) ? "integer" : "number") : "string"
    groups.set(type, [...(groups.get(type) ?? []), value])
  }
  const variants = [...groups].map(([type, items]) => ({ type, enum: items }))
  return variants.length === 1 ? { ...variants[0]!, description } : { anyOf: variants, description }
}

export const emptyInputSchema = objectSchema({})
export const sessionSchemaProperty = {
  type: "string",
  description: "Optional session id. Defaults to your current session.",
} as const
export const sessionAliasSchemaProperty = { type: "string", description: "Same as id." } as const
export const sessionOnlyInputSchema = objectSchema({
  session: sessionSchemaProperty,
})

/**
 * The execute tool's structured result. The agent's return value appears once (as `value`), and only context that has
 * content is included: no empty warnings, zero-count log summaries or uneventful aftermath.
 */
export const ExecuteToolOutput = Schema.Struct({
  session: Schema.String,
  value: Schema.optionalKey(Schema.Unknown),
  logs: Schema.optionalKey(Schema.Array(ExecuteLogEntry)),
  logSummary: Schema.optionalKey(ExecuteLogSummary),
  warnings: Schema.optionalKey(Schema.Array(Schema.String)),
  diagnostic: Schema.optionalKey(Schema.String),
  aftermath: Schema.optionalKey(ExecuteAftermath),
  notice: Schema.optionalKey(Schema.String),
})

export const StatusToolOutput = Schema.Struct({
  endpoint: Schema.String,
  currentSession: Schema.String,
  sharedSession: Schema.Boolean,
  version: RelayVersion,
  status: ExtensionStatus,
  buildProblem: Schema.optionalKey(Schema.String),
  update: Schema.optionalKey(Schema.Json),
  autoUpdate: Schema.Json,
})

export const CurrentSessionToolOutput = Schema.Struct({
  currentSession: Schema.String,
})

export const SessionDeleteToolOutput = SessionDeleted.pipe(Schema.fieldsAssign({
  currentSession: Schema.String,
}))

/**
 * The result of any `network` action: one object root with the fields the chosen action returns. Action-specific
 * fields are optional so structuredContent validates for every action.
 */
export const NetworkToolOutput = Schema.Struct({
  action: Schema.Literals(["start", "status", "stop", "cancel"]),
  session: Schema.String,
  active: Schema.optionalKey(Schema.Boolean),
  startedAt: Schema.optionalKey(Schema.String),
  entryCount: Schema.optionalKey(Schema.Number),
  responseCount: Schema.optionalKey(Schema.Number),
  failureCount: Schema.optionalKey(Schema.Number),
  capturedBodyBytes: Schema.optionalKey(Schema.Number),
  truncatedBodyCount: Schema.optionalKey(Schema.Number),
  droppedEntryCount: Schema.optionalKey(Schema.Number),
  urlFilter: Schema.optionalKey(Schema.String),
  resourceTypes: Schema.optionalKey(Schema.Array(Schema.String)),
  content: Schema.optionalKey(Schema.Literals(["omit", "embed"])),
  secrets: Schema.optionalKey(Schema.String),
  endsAt: Schema.optionalKey(Schema.String),
  ended: Schema.optionalKey(Schema.String),
  stoppedAt: Schema.optionalKey(Schema.String),
  outputPath: Schema.optionalKey(Schema.String),
  authProfile: Schema.optionalKey(AuthProfileSummary),
  updatedSecretRefs: Schema.optionalKey(Schema.Array(Schema.String)),
  observedSecretRefs: Schema.optionalKey(Schema.Array(Schema.String)),
  endpoints: Schema.optionalKey(Schema.Array(Schema.Struct({
    method: Schema.String,
    url: Schema.String,
    status: Schema.optionalKey(Schema.Number),
    count: Schema.Number,
    requestHeaders: Schema.optionalKey(Schema.Array(Schema.String)),
    requestKeys: Schema.optionalKey(Schema.Array(Schema.String)),
    responseKeys: Schema.optionalKey(Schema.Array(Schema.String)),
  }))),
  cancelled: Schema.optionalKey(Schema.Boolean),
})

/** The result of any `recording` action, with action-specific fields optional. */
export const RecordingToolOutput = Schema.Struct({
  action: Schema.Literals(["start", "stop", "status", "cancel"]),
  session: Schema.String,
  success: Schema.optionalKey(Schema.Boolean),
  tabId: Schema.optionalKey(Schema.Number),
  startedAt: Schema.optionalKey(Schema.Number),
  path: Schema.optionalKey(Schema.String),
  mimeType: Schema.optionalKey(Schema.String),
  mode: Schema.optionalKey(Schema.Literals(["tab-capture", "cdp"])),
  artifactType: Schema.optionalKey(Schema.Literals(["webm", "mp4"])),
  frameRate: Schema.optionalKey(Schema.Number),
  duration: Schema.optionalKey(Schema.Number),
  size: Schema.optionalKey(Schema.Number),
  frameCount: Schema.optionalKey(Schema.Number),
  quality: Schema.optionalKey(RecordingQuality),
  isRecording: Schema.optionalKey(Schema.Boolean),
  error: Schema.optionalKey(Schema.String),
})

/** The result of any `flight_recorder` action, with action-specific fields optional. */
export const FlightRecorderToolOutput = Schema.Struct({
  action: Schema.Literals(["start", "status", "save_last", "cancel"]),
  session: Schema.String,
  active: Schema.optionalKey(Schema.Boolean),
  tabId: Schema.optionalKey(Schema.Number),
  sessionId: Schema.optionalKey(Schema.String),
  startedAt: Schema.optionalKey(Schema.Number),
  retentionMs: Schema.optionalKey(Schema.Number),
  retainedDurationMs: Schema.optionalKey(Schema.Number),
  frameRate: Schema.optionalKey(Schema.Number),
  bufferedFrames: Schema.optionalKey(Schema.Number),
  bufferedBytes: Schema.optionalKey(Schema.Number),
  sourceFrameCount: Schema.optionalKey(Schema.Number),
  droppedFrameCount: Schema.optionalKey(Schema.Number),
  saving: Schema.optionalKey(Schema.Boolean),
  path: Schema.optionalKey(Schema.String),
  durationMs: Schema.optionalKey(Schema.Number),
  frameCount: Schema.optionalKey(Schema.Number),
  cancelled: Schema.optionalKey(Schema.Boolean),
})

/** Settings the MCP tool may read and change. Update behaviour is the user's to set, never an agent's. */
export type AgentSettingKey = Exclude<SettingKey, "autoUpdate">
export const agentSettingKeys: readonly AgentSettingKey[] = settingKeys.filter(
  (key): key is AgentSettingKey => key !== "autoUpdate",
)
const AgentSettingValue = Schema.Union([Schema.String, Schema.Number])
const AgentSettingReport = Schema.Struct({
  value: AgentSettingValue,
  effective: AgentSettingValue,
  allowed: Schema.Array(AgentSettingValue),
  description: Schema.String,
  overriddenBy: Schema.optionalKey(Schema.String),
})
export const AgentSettings = Schema.Record(Schema.Literals(agentSettingKeys), AgentSettingReport)

/** Either the read result or the change result, with a single object root so older MCP clients still see the schema. */
export const SettingsToolOutput = Schema.Struct({
  settings: AgentSettings,
  note: Schema.optionalKey(SettingsGetResponse.fields.note),
  changed: Schema.optionalKey(SettingsSetResponse.fields.changed),
  unchanged: Schema.optionalKey(SettingsSetResponse.fields.unchanged),
  overridden: Schema.optionalKey(SettingsSetResponse.fields.overridden),
  message: Schema.optionalKey(SettingsSetResponse.fields.message),
})

export const SecretsListToolOutput = Schema.Struct({
  secrets: Schema.Array(Schema.Struct({
    name: Schema.String,
    kind: Schema.Literals(["password", "totp"]),
    allowedOrigins: Schema.Array(Schema.String),
    createdAt: Schema.String,
    updatedAt: Schema.String,
  })),
})

/** The JSON Schema a tool advertises from its Effect Schema (the same conversion Effect's McpServer uses). */
export function toolOutputJson(schema: Schema.Constraint): JsonObject {
  const document = Schema.toJsonSchemaDocument(schema)
  const json = Object.keys(document.definitions).length === 0
    ? document.schema
    : { ...document.schema, $defs: document.definitions }
  return json as unknown as JsonObject
}

function logSummaryHasContent(summary: ExecuteLogSummary | undefined): boolean {
  return summary !== undefined && (
    summary.totalCount > 0 || summary.returnedCount > 0 || summary.repeatedCount > 0 || summary.omittedCount > 0
  )
}

function aftermathHasContent(aftermath: ExecuteAftermath | undefined): boolean {
  return aftermath !== undefined && (
    aftermath.startUrl !== aftermath.endUrl ||
    aftermath.navigations.length > 0 ||
    aftermath.consoleErrorCount > 0 ||
    aftermath.pageErrorCount > 0 ||
    aftermath.handoffs > 0 ||
    aftermath.challenge !== undefined
  )
}

export function executeToolOutput(result: ExecuteResponse & { readonly notice?: string }): typeof ExecuteToolOutput.Type {
  return {
    session: result.session.id,
    ...(result.value === undefined ? {} : { value: result.value }),
    ...(result.logs.length > 0 ? { logs: result.logs } : {}),
    ...(logSummaryHasContent(result.logSummary) ? { logSummary: result.logSummary } : {}),
    ...(result.warnings && result.warnings.length > 0 ? { warnings: result.warnings } : {}),
    ...(result.diagnostic ? { diagnostic: result.diagnostic } : {}),
    ...(aftermathHasContent(result.aftermath) ? { aftermath: result.aftermath } : {}),
    ...(result.notice ? { notice: result.notice } : {}),
  }
}

/**
 * The text fallback for an execute. A string return is the agent's own readable text, not JSON; a structured return is
 * its compact JSON value. That keeps one copy of the value outside the structured result.
 */
export function executeToolText(result: ExecuteResponse & { readonly notice?: string }): string {
  const text = result.isError
    ? result.text
    : Predicate.isString(result.value)
      ? result.value
      : result.value === undefined
        ? result.text
        : JSON.stringify(result.value)
  return result.notice ? `${text}\n\n${result.notice}` : text
}

/** The MCP result for one execute: images keep their content blocks and text, everything else gets structured output. */
export function executeToolResult(value: unknown): McpSchema.CallToolResult {
  const result = value as ExecuteResponse & { readonly notice?: string }
  if (result.media && result.media.length > 0) {
    return new McpSchema.CallToolResult({
      content: [
        McpSchema.TextContent.make({ text: result.text }),
        ...result.media.map((image) => McpSchema.ImageContent.make({
          data: new Uint8Array(Buffer.from(image.data, "base64")),
          mimeType: image.mimeType,
        })),
      ],
      isError: result.isError,
    })
  }
  return toolResultForValue(executeToolOutput(result), {
    outputSchema: ExecuteToolOutput,
    text: executeToolText(result),
    isError: result.isError,
  })
}

export const ensureSessionExists = Effect.fnUntraced(function* (relay: RelayClient.Interface, id: string) {
  const sessions = yield* relay.sessions
  const exists = sessions.some((session) => {
    return session.id === id
  })
  if (!exists) {
    return yield* Effect.fail(new Error(`Session not found: ${id}`))
  }
})

export function parseExecuteArguments(input: unknown): ExecuteArguments {
  const object = requireObject(input)
  const code = requiredStringField(object, "code")
  const session = optionalStringField(object, "session")
  const timeoutMs = optionalNonNegativeIntegerField(object, "timeoutMs")
  const targetSelection = parseMcpTargetSelection(object)
  const browser = optionalStringField(object, "browser")
  return {
    code,
    ...(session ? { session } : {}),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(targetSelection ? { targetSelection } : {}),
    ...(browser ? { browser } : {}),
  }
}

export function parseAdoptArguments(input: unknown): AdoptArguments {
  const object = requireObject(input)
  const session = optionalStringField(object, "session")
  const targetSelection = parseMcpTargetSelection(object)
  const tabId = typeof object.tabId === "number" && Number.isInteger(object.tabId) ? object.tabId : undefined
  if (tabId !== undefined && targetSelection) throw new Error("Use only one of tabId, targetUrl, or targetIndex")
  return {
    ...(session ? { session } : {}),
    ...(targetSelection ? { targetSelection } : {}),
    ...(tabId === undefined ? {} : { tabId }),
  }
}

export function parseMcpTargetSelection(input: JsonObject): TargetSelection | undefined {
  const urlIncludes = optionalStringField(input, "targetUrl")
  const selection = parseTargetSelection({
    ...(urlIncludes ? { urlIncludes } : {}),
    ...(input.targetIndex === undefined ? {} : { index: input.targetIndex }),
  })
  return selection?.urlIncludes || selection?.index !== undefined ? selection : undefined
}

export function requiredStringField(input: unknown, field: string): string {
  const value = optionalStringField(input, field)
  if (!value) {
    throw new Error(`${field} is required`)
  }
  return value
}

/** The `action` of a merged tool, validated against the actions that tool has. */
export function requiredAction<const Action extends string>(input: unknown, actions: readonly Action[]): Action {
  const action = optionalStringField(input, "action")
  if (!action || !(actions as readonly string[]).includes(action)) {
    throw new Error(`action must be one of ${actions.join(", ")}`)
  }
  return action as Action
}

export function optionalStringField(input: unknown, field: string): string | undefined {
  const value = getString(requireObject(input), field)
  return value ? value : undefined
}

export function optionalBooleanField(input: unknown, field: string): boolean | undefined {
  const value = requireObject(input)[field]
  return Predicate.isBoolean(value) ? value : undefined
}

export function optionalPositiveIntegerField(input: unknown, field: string): number | undefined {
  const value = requireObject(input)[field]
  if (value === undefined) return undefined
  if (!Predicate.isNumber(value) || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer`)
  }
  return value
}

export function optionalNonNegativeIntegerField(input: unknown, field: string): number | undefined {
  const value = requireObject(input)[field]
  if (value === undefined) return undefined
  if (!Predicate.isNumber(value) || !Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer`)
  }
  return value
}

export function optionalStringArrayField(input: unknown, field: string): readonly string[] | undefined {
  const value = requireObject(input)[field]
  if (value === undefined) return undefined
  if (!Array.isArray(value) || !value.every((item): item is string => Predicate.isString(item) && item.length > 0)) {
    throw new Error(`${field} must be an array of non-empty strings`)
  }
  return value
}

export function requireObject(input: unknown): JsonObject {
  const object = getObject(input)
  if (!object) {
    throw new Error("Expected arguments object")
  }
  return object
}

function stringifyResult(value: unknown): string {
  if (Predicate.isString(value)) {
    return value
  }
  // Compact, not pretty-printed: this text block is only the backwards-compatible fallback for structuredContent.
  return JSON.stringify(value)
}

function encodedStructuredContent(value: unknown, schema: Schema.ConstraintEncoder<unknown, never> | undefined): unknown {
  if (!schema) return value
  const encoded = Schema.encodeUnknownOption(schema)(value)
  return Option.isSome(encoded) ? encoded.value : undefined
}

export type ToolResultOptions = {
  readonly outputSchema?: Schema.ConstraintEncoder<unknown, never>
  readonly text?: string
  readonly isError?: boolean
}

export function toolResultForValue(value: unknown, options: ToolResultOptions = {}): McpSchema.CallToolResult {
  const object = getObject(value)
  const isError = options.isError ?? object?.isError === true
  const media = Array.isArray(object?.media)
    ? object.media.flatMap((item) => {
        const image = getObject(item)
        const mimeType = getString(image, "mimeType")
        const data = getString(image, "data")
        return image?.type === "image" && mimeType !== undefined && data !== undefined
          ? [{ data, mimeType }]
          : []
      })
    : []
  const errorText = isError ? getString(object, "text") : undefined
  if (media.length > 0) {
    const { media: _media, ...rest } = object ?? {}
    const text = options.text ?? errorText ?? stringifyResult(rest)
    // No structuredContent here: some MCP clients send only structuredContent to the model when it is set, dropping the images.
    return new McpSchema.CallToolResult({
      content: [
        McpSchema.TextContent.make({ text }),
        ...media.map((image) =>
          McpSchema.ImageContent.make({
            data: new Uint8Array(Buffer.from(image.data, "base64")),
            mimeType: image.mimeType,
          }),
        ),
      ],
      isError,
    })
  }
  const text = options.text ?? errorText ?? stringifyResult(value)
  const structuredContent = object ? encodedStructuredContent(object, options.outputSchema) : undefined
  return toolResult({
    text,
    ...(structuredContent === undefined ? {} : { structuredContent }),
    isError,
  })
}

export function mcpErrorMessage(tool: string, message: string): string {
  if (!message.startsWith("Session not found:")) {
    return message
  }
  return tool === "execute" || tool === "session_adopt"
    ? `${message} Create it with session_new first, or omit the explicit session id to use the MCP current session.`
    : `${message} Create it with session_new first.`
}

export function toolResult(options: {
  readonly text: string
  readonly structuredContent?: unknown
  readonly isError: boolean
}): McpSchema.CallToolResult {
  return new McpSchema.CallToolResult({
    content: [McpSchema.TextContent.make({ text: options.text })],
    structuredContent: options.structuredContent,
    isError: options.isError,
  })
}
