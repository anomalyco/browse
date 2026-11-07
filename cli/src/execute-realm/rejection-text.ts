import util from "node:util"

const placeholder = "a non-Error value"

/**
 * A rejection can be any sandbox value, including objects whose `toString`, `stack`, `message` or prototype chain
 * runs sandbox code. Describing one on the host must not invoke any of that. Only a native Error that is not a Proxy
 * is inspected, and only through its own data property: getters, Proxy traps and prototype traversal never run.
 * Everything else gets a fixed placeholder.
 */
export function safeErrorMessage(value: unknown, maxLength = 300): string {
  if (!isSafeHostError(value)) return placeholder
  const message = ownDataProperty(value, "message")
  return typeof message === "string" && message.length > 0 ? message.slice(0, maxLength) : placeholder
}

/** The stack of a relay-realm Error, or undefined for anything that could run sandbox code. */
export function safeErrorStack(value: unknown): string | undefined {
  if (!isSafeHostError(value)) return undefined
  const stack = ownDataProperty(value, "stack")
  return typeof stack === "string" ? stack : undefined
}

/** An Error from any realm, in a form whose own data properties can be read without running code. */
function isSafeNativeError(value: unknown): value is Error {
  return typeof value === "object" && value !== null && !util.types.isProxy(value) && util.types.isNativeError(value)
}

/** An Error from the relay's own realm, safe to rethrow. Stops at a Proxy instead of running its trap. */
export function isSafeHostError(value: unknown): value is Error {
  if (!isSafeNativeError(value)) return false
  let prototype = Object.getPrototypeOf(value) as object | null
  for (let depth = 0; prototype !== null && depth < 32; depth += 1) {
    if (prototype === Error.prototype) return true
    if (util.types.isProxy(prototype)) return false
    prototype = Object.getPrototypeOf(prototype) as object | null
  }
  return false
}

function ownDataProperty(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined
}
