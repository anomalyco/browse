import { ExecuteFileAccessError } from "./errors.ts"
import { isPlainRecord } from "./file-options.ts"

function checkDropFile(value: unknown, checkFile: (target: string, operation: string) => string): unknown {
  if (typeof value === "string") return checkFile(value, "drop")
  if (isPlainRecord(value)) return value
  throw new ExecuteFileAccessError("drop: files must be strings or file payload objects")
}

function checkDropFiles(value: unknown, checkFile: (target: string, operation: string) => string): unknown {
  if (Array.isArray(value)) return value.map((item) => checkDropFile(item, checkFile))
  return checkDropFile(value, checkFile)
}

/** Validate a drop payload and return a fresh shallow plain copy with checked file paths. */
export function checkDropPayload(value: unknown, checkFile: (target: string, operation: string) => string): Record<string, unknown> {
  if (!isPlainRecord(value)) throw new ExecuteFileAccessError("drop: the payload must be a plain object")
  const object = value
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
