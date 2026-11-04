import { Effect, Predicate } from "effect"
import { McpSchema } from "effect/ai"
import type { JsonObject } from "../protocol.ts"
import * as RelayClient from "../relay/client.ts"
import { getObject, getString, parseTargetSelection } from "../relay/helpers.ts"
import type { ConnectedBrowser, TargetSelection } from "../relay/schema.ts"
import type { UpdateNotice } from "../update.ts"

export type CurrentSession = { id: string; established: boolean }

export type BrowserSummary = Pick<ConnectedBrowser, "id" | "name" | "default">

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

/**
 * With more than one browser connected, which ones and which is the default, for the execute and session_new
 * descriptions. With one or none it's empty, so the descriptions (and the agent's prompt cache) stay the same.
 */
export function browsersNote(browsers: readonly BrowserSummary[]): string {
  if (browsers.length < 2) return ""
  const list = browsers.map((browser) => `${browser.id} (${browser.name}${browser.default ? ", default" : ""})`).join(", ")
  return ` Connected browsers: ${list}. Pass browser to use one other than the default.`
}

/** The one-time note on a tool result: what to tell the user, and that the agent may run the update itself. */
export function mcpUpdateNote(notice: Pick<UpdateNotice, "summary" | "command">): string {
  return `Note: Browse has an update: ${notice.summary}. Tell the user they can run \`${notice.command}\` and then restart opencode, or ask you to run it for them.`
}

export function objectSchema(properties: JsonObject, required: readonly string[] = []): JsonObject {
  return {
    type: "object",
    properties,
    required: [...required],
    additionalProperties: false,
  }
}

export const emptyInputSchema = objectSchema({})
export const sessionSchemaProperty = {
  type: "string",
  description: "Optional session id. Defaults to this MCP server's current session.",
} as const
export const sessionAliasSchemaProperty = { type: "string", description: "Same as id." } as const
export const sessionOnlyInputSchema = objectSchema({
  session: sessionSchemaProperty,
})

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
  return JSON.stringify(value, null, 2)
}

export function toolResultForValue(value: unknown): McpSchema.CallToolResult {
  const object = getObject(value)
  const isError = object?.isError === true
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
    const { media: _media, ...structuredContent } = object ?? {}
    const text = errorText ?? stringifyResult(structuredContent)
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
      structuredContent,
      isError,
    })
  }
  const text = errorText ?? stringifyResult(value)
  return toolResult({ text, ...(object ? { structuredContent: object } : {}), isError })
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
