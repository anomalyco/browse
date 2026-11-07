import util from "node:util"
import { ExecuteFileAccessError } from "./errors.ts"

/** The paths a raw CDP command may name, checked against the execute file roots. */
export type CdpFileCheck = {
  /** Validate a local file the browser will read and return its resolved path. */
  readonly fileInput: (target: string, operation: string) => string
  /** Validate a folder the browser will write downloads into and return its resolved path. */
  readonly downloadDirectory: (target: string, operation: string) => string
}

/** What a permitted CDP command will write. */
export type CdpSendCheck = {
  readonly downloadDirectory?: string
}

const cdpMethodPattern = /^[A-Z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*$/

/** Whether `value` looks like a CDP method name: `Domain.method`. */
export function isCdpMethodName(value: string): boolean {
  return cdpMethodPattern.test(value)
}

/**
 * Whether `receiver` is a CDPSession. Playwright's class is `CDPSession` (a bundler may suffix
 * it), and every session also has `send` and `detach`; nothing else execute code can reach has both.
 */
export function isCdpSession(receiver: unknown): boolean {
  if (receiver === null || (typeof receiver !== "object" && typeof receiver !== "function")) return false
  try {
    const prototype = Object.getPrototypeOf(receiver) as { constructor?: { name?: unknown } } | null
    const name = prototype?.constructor?.name
    if (typeof name === "string" && name.replace(/\d+$/, "") === "CDPSession") return true
    return typeof Reflect.get(receiver, "detach") === "function" && typeof Reflect.get(receiver, "send") === "function"
  } catch {
    return false
  }
}

function invalidCdpParameters(operation: string, why: string): ExecuteFileAccessError {
  return new ExecuteFileAccessError(`${operation}: CDP parameters must be plain JSON data, ${why}`)
}

/** Copy a JSON-plain value for a raw CDP send, refusing anything JSON.stringify could reinterpret. */
export function copyCdpParameters(value: unknown, operation: string): unknown {
  return copyJsonValue(value, operation, new Set())
}

function copyJsonValue(value: unknown, operation: string, stack: Set<object>): unknown {
  if (value === null) return null
  if (typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw invalidCdpParameters(operation, "which cannot contain non-finite numbers")
    return value
  }
  if (typeof value !== "object") throw invalidCdpParameters(operation, "which cannot contain functions, symbols or undefined values")
  if (util.types.isProxy(value)) throw invalidCdpParameters(operation, "which cannot contain proxies")
  if (stack.has(value)) throw invalidCdpParameters(operation, "which cannot be cyclical")
  stack.add(value)
  try {
    if (Array.isArray(value)) return copyJsonArray(value, operation, stack)
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw invalidCdpParameters(operation, "which cannot contain class instances, dates, maps or other host objects")
    }
    const copy: Record<string, unknown> = {}
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") throw invalidCdpParameters(operation, "which cannot contain symbol keys")
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key)
      if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
        throw invalidCdpParameters(operation, "which cannot contain getters, setters or non-enumerable properties")
      }
      Object.defineProperty(copy, key, {
        value: copyJsonValue(descriptor.value, operation, stack),
        writable: true,
        enumerable: true,
        configurable: true,
      })
    }
    if (typeof Reflect.get(value, "toJSON") === "function") throw invalidCdpParameters(operation, "which cannot contain toJSON")
    return copy
  } finally {
    stack.delete(value)
  }
}

function copyJsonArray(value: readonly unknown[], operation: string, stack: Set<object>): unknown[] {
  const copy = new Array<unknown>(value.length)
  let count = 0
  for (const key of Reflect.ownKeys(value)) {
    if (key === "length") continue
    if (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length) {
      throw invalidCdpParameters(operation, "whose arrays cannot have extra properties")
    }
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key)
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw invalidCdpParameters(operation, "which cannot contain getters, setters or non-enumerable properties")
    }
    copy[Number(key)] = copyJsonValue(descriptor.value, operation, stack)
    count += 1
  }
  if (count !== value.length) throw invalidCdpParameters(operation, "whose arrays cannot have holes")
  if (typeof Reflect.get(value, "toJSON") === "function") throw invalidCdpParameters(operation, "which cannot contain toJSON")
  return copy
}

const cdpFileInputMethods = new Set(["DOM.setFileInputFiles", "PWA.launchFilesInApp"])
const cdpDownloadPathMethods = new Set(["Browser.setDownloadBehavior", "Page.setDownloadBehavior"])
const cdpRefusedMethods = new Map<string, string>([
  ["PWA.install", "installing a web app"],
  ["DOM.getFileInfo", "revealing local file paths"],
  ["Target.sendMessageToTarget", "forwarding a raw CDP message would bypass these file checks"],
  ["Target.exposeDevToolsProtocol", "exposing raw CDP to page script would bypass these file checks"],
])

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function requireParamsObject(method: string, value: unknown): Record<string, unknown> {
  if (!isPlainRecord(value)) throw new ExecuteFileAccessError(`${method}: params must be an object`)
  return value
}

function checkCdpFiles(container: Record<string, unknown>, key: string, method: string, check: CdpFileCheck): void {
  if (!Object.hasOwn(container, key)) return
  const files = container[key]
  if (!Array.isArray(files) || !files.every((file) => typeof file === "string")) {
    throw new ExecuteFileAccessError(`${method}: ${key} must be an array of file paths`)
  }
  const resolved = files.map((file) => check.fileInput(file, `${method}({ ${key} })`))
  Reflect.set(container, key, resolved)
}

/** Validate the paths in one raw CDP command and return the download folder it will use. */
export function checkCdpSend(method: string, params: unknown, check: CdpFileCheck): CdpSendCheck {
  if (method.startsWith("Extensions.")) {
    throw new ExecuteFileAccessError(`${method}: extension control is not available in execute code`)
  }
  const refusal = cdpRefusedMethods.get(method)
  if (refusal !== undefined) throw new ExecuteFileAccessError(`${method}: ${refusal}, so it is not available in execute code`)
  if (cdpFileInputMethods.has(method)) {
    checkCdpFiles(requireParamsObject(method, params), "files", method, check)
    return {}
  }
  if (method === "Input.dispatchDragEvent") {
    const object = requireParamsObject(method, params)
    if (Object.hasOwn(object, "data")) {
      const data = object.data
      if (!isPlainRecord(data)) throw new ExecuteFileAccessError(`${method}: data must be an object`)
      checkCdpFiles(data, "files", method, check)
    }
    return {}
  }
  if (!cdpDownloadPathMethods.has(method)) return {}
  const object = requireParamsObject(method, params)
  const behavior = object.behavior
  const downloadPath = object.downloadPath
  if (downloadPath !== undefined && typeof downloadPath !== "string") {
    throw new ExecuteFileAccessError(`${method}: downloadPath must be a string`)
  }
  if (behavior === "default") {
    throw new ExecuteFileAccessError(`${method}: default downloads go outside the execute file roots; use behavior "allow" with a downloadPath`)
  }
  if (behavior !== "allow" && behavior !== "allowAndName" && behavior !== "deny") {
    throw new ExecuteFileAccessError(`${method}: behavior must be allow, allowAndName or deny in execute code`)
  }
  if (downloadPath === undefined) {
    if (behavior !== "deny") throw new ExecuteFileAccessError(`${method}: behavior ${behavior} requires a downloadPath`)
    return {}
  }
  const resolved = check.downloadDirectory(downloadPath, `${method}({ downloadPath })`)
  Reflect.set(object, "downloadPath", resolved)
  return behavior === "deny" ? {} : { downloadDirectory: resolved }
}
