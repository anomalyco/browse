import util from "node:util"
import { ExecuteFileAccessError } from "./errors.ts"

function checkDropFiles(value: unknown, checkFile: (target: string, operation: string) => string): unknown {
  if (typeof value === "string") return checkFile(value, "drop")
  if (Array.isArray(value)) {
    return value.map((item) => typeof item === "string" ? checkFile(item, "drop") : item)
  }
  return value
}

/** Validate a drop payload and return a fresh shallow plain copy with checked file paths. */
export function checkDropPayload(value: unknown, checkFile: (target: string, operation: string) => string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || util.types.isProxy(value)) {
    throw new ExecuteFileAccessError("drop: the payload must be a plain object")
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ExecuteFileAccessError("drop: the payload must be a plain object")
  }
  const object = value as Record<string, unknown>
  const files = Object.getOwnPropertyDescriptor(object, "files")
  if (files === undefined && "files" in object) {
    throw new ExecuteFileAccessError("drop: files must be an own property of the payload")
  }
  if (files !== undefined && !("value" in files)) {
    throw new ExecuteFileAccessError("drop: files must be a data property")
  }
  const copy: Record<string, unknown> = { ...object }
  if (files !== undefined && files.value !== undefined) copy.files = checkDropFiles(files.value, checkFile)
  return copy
}
