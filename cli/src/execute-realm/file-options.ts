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
    if (includeMethodKeys && method !== "addInitScript") {
      throw new ExecuteFileAccessError(`${method}: function arguments cannot be used as options`)
    }
    for (const key of allFileOptionKeys) {
      if (key in value) throw new ExecuteFileAccessError(`${method}: function arguments cannot carry the ${key} file option`)
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
  for (const [key, item] of Object.entries(value)) {
    if (forbiddenOptionKeys.has(key)) throw new ExecuteFileAccessError(`${method}: the ${key} option is not available in execute code`)
    if (typeof item === "string" && (alwaysFileOptionKeys.has(key) || (includeMethodKeys && fileOptionKeys.has(key)))) {
      const resolved = checkPath(item, `${method}({ ${key} })`)
      if (depth === 0 && isFileOutputOption(method, key)) candidates.push({ path: resolved })
      Reflect.set(value, key, resolved)
    } else {
      checkFileOptions(item, method, includeMethodKeys, candidates, checkPath, depth + 1)
    }
  }
}
