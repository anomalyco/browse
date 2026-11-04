import util from "node:util"
import { Predicate } from "effect"
import type { ExecuteMedia } from "../relay/schema.ts"

/** The most text (and JSON value) an execute returns; an agent's context can't take more, and the relay copies it. */
export const maxExecuteResultChars = 100_000

/**
 * Caps what an execute returns. A result past the limit keeps the start of its text, drops its JSON value, and says
 * how to keep all of it: write it to a file inside the execute and read the parts needed.
 */
export function boundExecuteResult(text: string, value: unknown, hasValue: boolean): { readonly text: string; readonly value?: unknown; readonly hasValue: boolean; readonly warning?: string } {
  const valueChars = hasValue && value !== null && typeof value === "object" ? safeJsonStringify(value)?.length ?? 0 : typeof value === "string" ? value.length : 0
  const size = Math.max(text.length, valueChars)
  if (size <= maxExecuteResultChars) return { text, value, hasValue }
  const warning = `The result is ${size.toLocaleString("en-US")} characters, more than the ${maxExecuteResultChars.toLocaleString("en-US")} an execute returns: the text shows its start and the JSON value is left out. To keep all of it, write it to a file in the execute (await files.write("result.json", JSON.stringify(data))) and return only what you need, or read parts back later with files.read(files.path("result.json")).`
  return {
    text: text.length > maxExecuteResultChars ? `${text.slice(0, maxExecuteResultChars)}\n… [truncated ${(text.length - maxExecuteResultChars).toLocaleString("en-US")} characters]` : text,
    hasValue: false,
    warning,
  }
}

export function stringifyResult(result: unknown): string {
  if (Predicate.isString(result)) {
    return result
  }
  if (result === undefined) {
    return "undefined"
  }
  return util.inspect(result, { depth: 3, colors: false, maxArrayLength: 50, maxStringLength: 4000 })
}

export type JsonSafeResult =
  | { readonly serializable: true; readonly value: unknown }
  | { readonly serializable: false; readonly reason: string }

const maxJsonSafeDepth = 8
const maxJsonSafeBytes = 32 * 1024

export function extractExecuteMedia(value: unknown): { readonly value: unknown; readonly media: readonly ExecuteMedia[] } {
  const media: ExecuteMedia[] = []
  const seen = new WeakMap<object, unknown>()

  const replace = (item: unknown): unknown => {
    if (Buffer.isBuffer(item)) {
      const mimeType = imageMimeType(item)
      if (!mimeType) return item
      const image = {
        type: "image" as const,
        mimeType,
        data: item.toString("base64"),
        size: item.byteLength,
      }
      media.push(image)
      return { type: image.type, mimeType: image.mimeType, size: image.size }
    }
    if (!Predicate.isObjectOrArray(item)) return item
    const previous = seen.get(item)
    if (previous !== undefined) return previous
    if (Array.isArray(item)) {
      const output: unknown[] = []
      seen.set(item, output)
      for (const value of item) output.push(replace(value))
      return output
    }
    if (item instanceof Map) {
      const output = new Map<unknown, unknown>()
      seen.set(item, output)
      for (const [key, value] of item) output.set(replace(key), replace(value))
      return output
    }
    if (item instanceof Set) {
      const output = new Set<unknown>()
      seen.set(item, output)
      for (const value of item) output.add(replace(value))
      return output
    }
    if (!isPlainJsonContainer(item)) return item
    const output: Record<string, unknown> = {}
    seen.set(item, output)
    for (const key of safeObjectKeys(item) ?? []) {
      try {
        output[key] = replace(item[key as keyof typeof item])
      } catch {
        // Match structured-result conversion: skip inaccessible properties.
      }
    }
    return output
  }

  return { value: replace(value), media }
}

function imageMimeType(value: Buffer): string | undefined {
  if (value.length >= 8 && value.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png"
  }
  if (value.length >= 3 && value[0] === 0xff && value[1] === 0xd8 && value[2] === 0xff) {
    return "image/jpeg"
  }
  if (value.length >= 12 && value.subarray(0, 4).toString("ascii") === "RIFF" && value.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp"
  }
  return undefined
}

/**
 * Best-effort structured execute value for machine consumers.
 *
 * Only plain JSON-ish data is preserved, with Map converted to a plain object
 * when all keys are strings and Set converted to an array. Class instances (for
 * example Playwright Page/Locator/Response objects) are not serialized: a
 * top-level instance omits `value` entirely, while nested instances are omitted
 * from object branches and become `null` in array branches. Throwing proxies or
 * other unexpected conversion failures also omit `value`; throwing getters on
 * otherwise plain objects are skipped property-by-property. Oversized values are
 * also omitted so `value` stays compact for agents; `text` remains the human
 * fallback for every result.
 */
export function toJsonSafeValue(value: unknown): JsonSafeResult {
  try {
    const seen = new WeakSet<object>()
    const converted = convertJsonSafe(value, { seen, depth: 0 })
    if (converted.omit) {
      return { serializable: false, reason: converted.reason }
    }
    const jsonText = safeJsonStringify(converted.value)
    if (jsonText === undefined) {
      return { serializable: false, reason: "JSON serialization failed" }
    }
    if (Buffer.byteLength(jsonText, "utf8") > maxJsonSafeBytes) {
      return { serializable: false, reason: `JSON value exceeds ${maxJsonSafeBytes} bytes` }
    }
    return { serializable: true, value: converted.value }
  } catch (cause) {
    return { serializable: false, reason: cause instanceof Error && cause.message ? cause.message : "JSON conversion failed" }
  }
}

/** Why an execute result has no JSON value, or nothing when it has one or the code returned nothing. */
export function jsonValueWarning(value: unknown, jsonSafe: JsonSafeResult): string | undefined {
  if (jsonSafe.serializable || value === undefined) return undefined
  return `Execute result could not be represented as JSON value: ${jsonSafe.reason}`
}

type JsonSafeConversion =
  | { readonly omit: false; readonly value: unknown }
  | { readonly omit: true; readonly reason: string }

function convertJsonSafe(value: unknown, options: { readonly seen: WeakSet<object>; readonly depth: number }): JsonSafeConversion {
  if (value === null || Predicate.isString(value) || Predicate.isBoolean(value)) {
    return { omit: false, value }
  }
  if (Predicate.isNumber(value)) {
    return { omit: false, value: Number.isFinite(value) ? value : null }
  }
  if (Predicate.isBigInt(value)) {
    return { omit: false, value: value.toString() }
  }
  if (value === undefined) {
    return { omit: true, reason: "undefined" }
  }
  if (Predicate.isFunction(value)) {
    return { omit: true, reason: "function value" }
  }
  if (Predicate.isSymbol(value)) {
    return { omit: true, reason: "symbol value" }
  }
  if (!Predicate.isObjectOrArray(value)) {
    return { omit: true, reason: "unsupported value" }
  }
  const isMap = value instanceof Map
  const isSet = !isMap && value instanceof Set
  if (!isMap && !isSet && !isPlainJsonContainer(value)) {
    return { omit: true, reason: "class instance" }
  }
  if (options.seen.has(value)) {
    return { omit: true, reason: "circular reference" }
  }
  if (options.depth >= maxJsonSafeDepth) {
    return { omit: true, reason: "maximum object depth exceeded" }
  }
  options.seen.add(value)
  try {
    if (isMap) {
      try {
        const output: Record<string, unknown> = {}
        let entries: IterableIterator<[unknown, unknown]>
        try {
          entries = value.entries()
        } catch {
          return { omit: true, reason: "map entries unavailable" }
        }
        for (const [key, item] of entries) {
          if (!Predicate.isString(key)) {
            return { omit: true, reason: "map contains non-string key" }
          }
          const converted = convertJsonSafe(item, { seen: options.seen, depth: options.depth + 1 })
          if (!converted.omit) output[key] = converted.value
        }
        return { omit: false, value: output }
      } catch {
        return { omit: true, reason: "map iteration failed" }
      }
    }
    if (isSet) {
      try {
        const output: unknown[] = []
        let values: IterableIterator<unknown>
        try {
          values = value.values()
        } catch {
          return { omit: true, reason: "set values unavailable" }
        }
        for (const item of values) {
          const converted = convertJsonSafe(item, { seen: options.seen, depth: options.depth + 1 })
          output.push(converted.omit ? null : converted.value)
        }
        return { omit: false, value: output }
      } catch {
        return { omit: true, reason: "set iteration failed" }
      }
    }
    if (Array.isArray(value)) {
      let length: number
      try {
        length = value.length
      } catch {
        return { omit: true, reason: "array length unavailable" }
      }
      const items: unknown[] = []
      for (let index = 0; index < length; index++) {
        let item: unknown
        try {
          item = value[index]
        } catch {
          items.push(null)
          continue
        }
        const converted = convertJsonSafe(item, { seen: options.seen, depth: options.depth + 1 })
        items.push(converted.omit ? null : converted.value)
      }
      return {
        omit: false,
        value: items,
      }
    }
    const output: Record<string, unknown> = {}
    const keys = safeObjectKeys(value)
    if (!keys) {
      return { omit: true, reason: "object keys unavailable" }
    }
    for (const key of keys) {
      let item: unknown
      try {
        item = value[key as keyof typeof value]
      } catch {
        continue
      }
      const converted = convertJsonSafe(item, { seen: options.seen, depth: options.depth + 1 })
      if (!converted.omit) {
        output[key] = converted.value
      }
    }
    return { omit: false, value: output }
  } finally {
    options.seen.delete(value)
  }
}

function isPlainJsonContainer<T extends object>(value: T): boolean {
  if (Array.isArray(value)) {
    return true
  }
  let prototype: unknown
  try {
    prototype = Object.getPrototypeOf(value)
  } catch {
    return false
  }
  return prototype === Object.prototype || prototype === null
}

function safeObjectKeys<T extends object>(value: T): string[] | undefined {
  try {
    return Object.keys(value)
  } catch {
    return undefined
  }
}

function safeJsonStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value)
  } catch {
    return undefined
  }
}
