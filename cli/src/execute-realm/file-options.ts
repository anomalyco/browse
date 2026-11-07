import buffer from "node:buffer"
import util from "node:util"
import { ExecuteFileAccessError } from "./errors.ts"

// Playwright methods whose options name files on disk, and the option keys that do.
export const fileOptionMethods = new Set([
  "screenshot", "pdf", "storageState", "start", "stop", "startChunk", "stopChunk", "startTracing", "stopTracing",
  "addScriptTag", "addStyleTag", "addInitScript", "fulfill", "newContext", "newPage", "routeFromHAR",
  "screenshotWithLabels", "screenshotDiff",
])
const fileOptionKeys = new Set(["path", "dir", "har", "storageState"])
// Keys that name files wherever they appear.
const alwaysFileOptionKeys = new Set(["outputPath", "baseline", "certPath", "keyPath", "pfxPath", "tracesDir", "downloadsPath"])
const forbiddenOptionKeys = new Set(["executablePath", "recordHar", "recordVideo"])
const allFileOptionKeys = new Set([...fileOptionKeys, ...alwaysFileOptionKeys, ...forbiddenOptionKeys])

/**
 * Methods whose top-level `path` option names a file the call writes, unlike addScriptTag's or
 * setInputFiles' input paths. Tracing's `start`/`startChunk` options only name folders or a prefix
 * for intermediate files, so those are not here. `stop` covers both `tracing.stop({ path })` and
 * browse's `network.stop({ outputPath })`; `pageConsole.stop` takes a Page, not an options object.
 * `startTracing` is special: it only records the path `stopTracing` writes.
 */
const fileOutputMethods = new Set(["screenshot", "pdf", "storageState", "stop", "stopChunk", "screenshotWithLabels", "screenshotDiff"])

/** Outputs that name the file in the call's top-level options object. */
const isFileOutputOption = (method: string, key: string): boolean =>
  (key === "path" && fileOutputMethods.has(method)) || (key === "outputPath" && method === "stop")

/** A file a permitted host call will write. */
export type FileOutputCandidate = { readonly path: string }

const clientCertificatePathKeys = new Set(["certPath", "keyPath", "pfxPath"])

/** A non-Proxy plain object, the only container shape Playwright options are allowed to use. */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || util.types.isProxy(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * Client certificates are read property by property later, so copy the array and require every
 * item to be a plain object with own data properties. Index getters or a later-mutated array can
 * otherwise hand Patchright a different item than the one checked here.
 */
function checkClientCertificates(value: unknown, method: string): unknown[] {
  if (!Array.isArray(value) || util.types.isProxy(value)) {
    throw new ExecuteFileAccessError(`${method}: clientCertificates must be an array of plain objects`)
  }
  const copy = new Array<unknown>(value.length)
  let count = 0
  for (const key of Reflect.ownKeys(value)) {
    if (key === "length" || typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key)) continue
    const index = Number(key)
    if (index >= value.length) continue
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key)!
    if (!("value" in descriptor)) {
      throw new ExecuteFileAccessError(`${method}: clientCertificates entries must be own data properties`)
    }
    copy[index] = descriptor.value
    count += 1
  }
  if (count !== value.length) throw new ExecuteFileAccessError(`${method}: clientCertificates must be a dense array`)
  for (const item of copy) {
    if (item === null || typeof item !== "object" || Array.isArray(item) || util.types.isProxy(item)) {
      throw new ExecuteFileAccessError(`${method}: clientCertificates entries must be plain objects`)
    }
    const prototype = Object.getPrototypeOf(item)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new ExecuteFileAccessError(`${method}: clientCertificates entries must be plain objects`)
    }
    for (const key of Reflect.ownKeys(item)) {
      if (typeof key !== "string") throw new ExecuteFileAccessError(`${method}: clientCertificates entries cannot have symbol properties`)
      const descriptor = Reflect.getOwnPropertyDescriptor(item, key)
      if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
        throw new ExecuteFileAccessError(`${method}: clientCertificates entries must have own enumerable data properties`)
      }
      if (clientCertificatePathKeys.has(key)) {
        const path = descriptor.value
        if (path !== undefined && path !== null && typeof path !== "string") {
          throw new ExecuteFileAccessError(`${method}: clientCertificates ${key} must be a string`)
        }
      }
    }
  }
  return copy
}

/** Validate the file paths in a saveAs/routeFromHAR-style argument. */
export function checkFileStrings(
  value: unknown,
  method: string,
  checkPath: (target: string, operation: string) => string,
): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === "string") return checkPath(value, method)
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item === undefined || item === null) continue
      if (typeof item !== "string") throw new ExecuteFileAccessError(`${method}: file paths must be strings`)
      checkPath(item, method)
    }
    return undefined
  }
  throw new ExecuteFileAccessError(`${method}: file paths must be strings`)
}

/**
 * Validates the file paths in a call's options and collects the ones the call will write. Only a
 * path on the top-level options object counts as an output, because only those are Playwright file
 * destinations; nothing here touches the filesystem beyond stat calls.
 */
export function checkFileOptions(
  value: unknown,
  method: string,
  includeMethodKeys: boolean,
  candidates: FileOutputCandidate[],
  checkPath: (target: unknown, operation: string) => string,
  depth = 0,
): void {
  if (typeof value === "function") {
    if (depth === 0 && includeMethodKeys && method !== "addInitScript") {
      throw new ExecuteFileAccessError(`${method}: function arguments cannot be used as options`)
    }
    // Best effort only: a stateful function or Proxy can change its answers between this check
    // and Playwright's later reads. Plain containers such as clientCertificates are enforced below.
    for (const key of allFileOptionKeys) {
      if (key in value || Reflect.get(value, key) !== undefined) {
        throw new ExecuteFileAccessError(`${method}: function arguments cannot carry the ${key} file option`)
      }
    }
    return
  }
  if (depth > 4 || value === null || typeof value !== "object") return
  if (Array.isArray(value)) {
    for (const item of value) checkFileOptions(item, method, includeMethodKeys, candidates, checkPath, depth + 1)
    return
  }
  // Option bags are plain objects; Playwright objects passed as arguments (a page, a locator) are not options.
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return
  for (const [key, entry] of Object.entries(value)) {
    let item = entry
    if (key === "clientCertificates" && includeMethodKeys && depth === 0 && item !== undefined && item !== null) {
      item = checkClientCertificates(item, method)
      if (!Reflect.set(value, key, item)) throw new ExecuteFileAccessError(`${method}: could not store clientCertificates`)
    }
    if (forbiddenOptionKeys.has(key)) throw new ExecuteFileAccessError(`${method}: the ${key} option is not available in execute code`)
    if (method === "fulfill" && depth === 0 && key === "json") {
      // fulfill serializes json as a response body and never reads it for files.
      checkFileOptions(item, method, false, candidates, checkPath, depth + 1)
      continue
    }
    if (alwaysFileOptionKeys.has(key) || (includeMethodKeys && fileOptionKeys.has(key))) {
      if (item === undefined || item === null) continue
      if (typeof item === "string") {
        const resolved = checkPath(item, `${method}({ ${key} })`)
        if (depth === 0 && isFileOutputOption(method, key)) candidates.push({ path: resolved })
        Reflect.set(value, key, resolved)
        continue
      }
      if (includeMethodKeys && depth === 0) {
        if (key === "baseline" && buffer.Buffer.isBuffer(item)) continue
        if (key === "storageState" && isPlainRecord(item)) {
          checkFileOptions(item, method, false, candidates, checkPath, depth + 1)
          continue
        }
        const allowed = key === "storageState" ? "a path string or inline state object" : key === "baseline" ? "a path string or Buffer" : "a path string"
        throw new ExecuteFileAccessError(`${method}: ${key} must be ${allowed}`)
      }
    }
    checkFileOptions(item, method, includeMethodKeys, candidates, checkPath, depth + 1)
  }
}
