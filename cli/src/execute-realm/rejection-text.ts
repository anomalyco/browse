import util from "node:util"

const placeholder = "a non-Error value"

/**
 * A rejection can be any sandbox value, including objects whose `toString`, `stack` or `message` runs sandbox code.
 * Describing one on the host must not invoke any of that. Only a non-proxy host Error is inspected, and only through
 * its own data property, so a getter or a Proxy trap never runs. Everything else gets a fixed placeholder.
 */
export function safeErrorMessage(value: unknown, maxLength = 300): string {
  if (!isSafeHostError(value)) return placeholder
  const message = ownDataProperty(value, "message")
  return typeof message === "string" && message.length > 0 ? message.slice(0, maxLength) : placeholder
}

/** The stack of a non-proxy host Error, or undefined for anything that could run sandbox code. */
export function safeErrorStack(value: unknown): string | undefined {
  if (!isSafeHostError(value)) return undefined
  const stack = ownDataProperty(value, "stack")
  return typeof stack === "string" ? stack : undefined
}

export function isSafeHostError(value: unknown): value is Error {
  return typeof value === "object" && value !== null && !util.types.isProxy(value) && value instanceof Error
}

function ownDataProperty(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined
}
