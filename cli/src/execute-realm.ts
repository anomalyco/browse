/**
 * The execute sandbox realm.
 *
 * Agent code passed to `execute` is untrusted: a page can prompt-inject the
 * agent that writes it. By default it runs in a separate `node:vm` context
 * whose global object holds only ECMAScript built-ins plus a small set of
 * harmless host utilities (timers, URL, TextEncoder, Buffer, ...). There is no
 * `process`, `require`, `import()`, `fs`, `child_process`, `http`/`https` or
 * Node-side `fetch`.
 *
 * Host objects the agent needs (Playwright's `page`, `context`, the OpenCode
 * Browser helpers) cross into the context through a membrane:
 *
 * - Host objects and functions are wrapped in proxies whose every result is
 *   wrapped again, so sandbox code never holds a raw host object. Host
 *   intrinsics (`Function`, `AsyncFunction`, `Object`, `Error`, ...) map to the
 *   context's own, so `page.constructor.constructor("return process")()`
 *   compiles in the context and finds no `process`.
 * - Plain host data (evaluate results, option objects) is copied across, so
 *   it behaves like ordinary local data.
 * - Sandbox functions handed to the host (callbacks, evaluate functions) are
 *   wrapped in proxies that convert their arguments and results.
 * - Underscore-prefixed members (Playwright internals such as `_connection`
 *   and `_platform`, which reach Node's fs) are hidden; capability objects
 *   (`process`, `fs`, `child_process`, network modules) never cross; Playwright
 *   APIs that launch processes or make Node-side HTTP requests are refused;
 *   Playwright file options (`path`, `setInputFiles`, `saveAs`, ...) must stay
 *   inside the execute file roots.
 *
 * Residual risk: this is defence in depth, not a security boundary as strong
 * as a separate process. A bug in this membrane or a Playwright API that
 * reaches the host in a way not covered here could still escape, and the
 * agent keeps everything the browser itself can do (navigate anywhere, read
 * any attached page, exfiltrate through page requests). Set
 * OPENCODE_BROWSER_ALLOW_NODE=1 to run execute code with full Node access.
 */
import fs from "node:fs"
import fsPromises from "node:fs/promises"
import childProcess from "node:child_process"
import cluster from "node:cluster"
import dgram from "node:dgram"
import dns from "node:dns"
import http from "node:http"
import http2 from "node:http2"
import https from "node:https"
import inspector from "node:inspector"
import module from "node:module"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import tls from "node:tls"
import url from "node:url"
import util from "node:util"
import v8 from "node:v8"
import vm from "node:vm"
import workerThreads from "node:worker_threads"
import crypto from "node:crypto"
import events from "node:events"
import stream from "node:stream"
import buffer from "node:buffer"
import zlib from "node:zlib"
import * as acorn from "acorn"
import { dataRoot } from "./paths.ts"

export const allowNodeEnvironmentVariable = "OPENCODE_BROWSER_ALLOW_NODE"
export const allowForegroundEnvironmentVariable = "OPENCODE_BROWSER_ALLOW_FOREGROUND"
export const fileRootsEnvironmentVariable = "OPENCODE_BROWSER_FILE_ROOTS"

export const executeAllowsNode = (): boolean => process.env[allowNodeEnvironmentVariable] === "1"
export const executeAllowsForeground = (): boolean => process.env[allowForegroundEnvironmentVariable] === "1"

export const bringToFrontBlockedMessage = "page.bringToFront() is blocked: it raises the user's browser window over their work. Use handoff(message) when the user needs to act in the tab, or set OPENCODE_BROWSER_ALLOW_FOREGROUND=1 for the relay to allow it."

/** Harmless compute modules available as `modules.*` and top-level aliases in sandboxed execute code. */
export const sandboxModules = { path, url, util, crypto, buffer, zlib, events, stream }

// ---- execute file roots -----------------------------------------------------------------------------

/** Directory `files.write(name, ...)` uses for relative names. */
export function executeFilesDirectory(): string {
  return path.join(os.tmpdir(), "opencode-browser-files")
}

function realpathOrSelf(target: string): string {
  try {
    return fs.realpathSync(target)
  } catch {
    return path.resolve(target)
  }
}

/** Directories execute code may read and write through Playwright file options and `files`. */
export function executeFileRoots(): readonly string[] {
  const extra = (process.env[fileRootsEnvironmentVariable] ?? "").split(path.delimiter).filter((entry) => path.isAbsolute(entry))
  const roots = [os.tmpdir(), ...(process.platform === "win32" ? [] : ["/tmp"]), ...extra]
  return [...new Set(roots.map(realpathOrSelf))]
}

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

/** Resolve the real location a path refers to (following an existing symlink, or the nearest existing parent). */
function realTarget(target: string): string {
  let current = path.resolve(target)
  const rest: string[] = []
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...rest.reverse())
    } catch {
      const parent = path.dirname(current)
      if (parent === current) return path.join(current, ...rest.reverse())
      rest.push(path.basename(current))
      current = parent
    }
  }
}

export class ExecuteFileAccessError extends Error {
  override readonly name = "ExecuteFileAccessError"
}

/** Throw unless `target` is an absolute path inside the execute file roots and outside OpenCode Browser's data. */
export function assertExecuteFilePath(target: unknown, operation: string): string {
  if (typeof target !== "string" || target.length === 0) {
    throw new ExecuteFileAccessError(`${operation}: file paths must be non-empty strings`)
  }
  const roots = executeFileRoots()
  const describeRoots = () => `${roots.join(", ")} (add more with ${fileRootsEnvironmentVariable})`
  if (!path.isAbsolute(target)) {
    throw new ExecuteFileAccessError(`${operation}: use an absolute path inside ${describeRoots()}, for example files.path("name.png")`)
  }
  const resolved = realTarget(target)
  const data = realTarget(dataRoot())
  if (isInside(resolved, data)) {
    throw new ExecuteFileAccessError(`${operation}: ${target} is inside OpenCode Browser's data directory, which execute code cannot access`)
  }
  if (!roots.some((root) => isInside(resolved, root))) {
    throw new ExecuteFileAccessError(`${operation}: ${target} is outside the execute file roots ${describeRoots()}. Set ${allowNodeEnvironmentVariable}=1 for unrestricted file access.`)
  }
  return resolved
}

export type ExecuteFiles = {
  readonly dir: string
  readonly roots: readonly string[]
  readonly path: (name: string) => string
  readonly write: (target: string, data: string | Uint8Array | ArrayBuffer) => Promise<string>
  readonly read: (target: string, encoding?: BufferEncoding) => Promise<Buffer | string>
}

/** The narrow file helper execute code gets instead of `fs`. */
export function createExecuteFiles(): ExecuteFiles {
  const dir = executeFilesDirectory()
  const resolveTarget = (target: string) => path.isAbsolute(target) ? target : path.join(dir, target)
  return {
    dir,
    roots: executeFileRoots(),
    path: (name) => {
      const resolved = resolveTarget(name)
      assertExecuteFilePath(resolved, "files.path")
      return resolved
    },
    write: async (target, data) => {
      const resolved = resolveTarget(target)
      assertExecuteFilePath(resolved, "files.write")
      await fsPromises.mkdir(path.dirname(resolved), { recursive: true, mode: 0o700 })
      const bytes = typeof data === "string" ? data : data instanceof ArrayBuffer ? Buffer.from(data) : Buffer.from(data.buffer, data.byteOffset, data.byteLength)
      await fsPromises.writeFile(resolved, bytes, { mode: 0o600 })
      return resolved
    },
    read: async (target, encoding) => {
      const resolved = resolveTarget(target)
      assertExecuteFilePath(resolved, "files.read")
      return encoding ? await fsPromises.readFile(resolved, encoding) : await fsPromises.readFile(resolved)
    },
  }
}

// Playwright methods whose options name files on disk, and the option keys that do.
const fileOptionMethods = new Set([
  "screenshot", "pdf", "storageState", "start", "stop", "startChunk", "stopChunk", "startTracing", "stopTracing",
  "addScriptTag", "addStyleTag", "addInitScript", "fulfill", "newContext", "newPage", "routeFromHAR",
  "screenshotWithLabels", "screenshotDiff",
])
const fileOptionKeys = new Set(["path", "dir", "har", "storageState"])
// Keys that name files wherever they appear.
const alwaysFileOptionKeys = new Set(["outputPath", "baseline", "certPath", "keyPath", "pfxPath", "tracesDir", "downloadsPath"])
const forbiddenOptionKeys = new Set(["executablePath"])

function checkFileOptions(value: unknown, method: string, includeMethodKeys: boolean, depth = 0): void {
  if (depth > 4 || value === null || typeof value !== "object") return
  if (Array.isArray(value)) {
    for (const item of value) checkFileOptions(item, method, includeMethodKeys, depth + 1)
    return
  }
  // Option bags are plain objects; Playwright objects passed as arguments (a page, a locator) are not options.
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return
  for (const [key, item] of Object.entries(value)) {
    if (forbiddenOptionKeys.has(key)) throw new ExecuteFileAccessError(`${method}: the ${key} option is not available in execute code`)
    if (typeof item === "string" && (alwaysFileOptionKeys.has(key) || (includeMethodKeys && fileOptionKeys.has(key)))) {
      assertExecuteFilePath(item, `${method}({ ${key} })`)
    } else {
      checkFileOptions(item, method, includeMethodKeys, depth + 1)
    }
  }
}

function checkFileStrings(value: unknown, method: string): void {
  if (typeof value === "string") assertExecuteFilePath(value, method)
  else if (Array.isArray(value)) for (const item of value) if (typeof item === "string") assertExecuteFilePath(item, method)
}

const promiseReturningNames = new Set([...fileOptionMethods, "setInputFiles", "setFiles", "saveAs", "bringToFront", "send"])

function returnsPromise(fn: Function): boolean {
  return util.types.isAsyncFunction(fn) || promiseReturningNames.has(typeof fn.name === "string" ? fn.name.replace(/^bound /, "") : "")
}

/** Enforce the execute file roots and refused APIs for one host call made by sandboxed code. */
export function checkHostCall(fn: Function, receiver: unknown, args: readonly unknown[]): void {
  const name = typeof fn.name === "string" ? fn.name.replace(/^bound /, "") : ""
  if ((name === "bringToFront" || (name === "send" && args[0] === "Page.bringToFront")) && !executeAllowsForeground()) {
    throw new Error(bringToFrontBlockedMessage)
  }
  if (name === "setInputFiles") {
    const isFrameLike = receiver !== null && typeof receiver === "object" && typeof (receiver as { goto?: unknown }).goto === "function"
    checkFileStrings(isFrameLike ? args[1] : args[0], "setInputFiles")
  } else if (name === "setFiles" || name === "saveAs" || name === "routeFromHAR") {
    checkFileStrings(args[0], name)
  }
  const includeMethodKeys = fileOptionMethods.has(name)
  for (const arg of args) checkFileOptions(arg, name || "call", includeMethodKeys)
}

// ---- membrane ---------------------------------------------------------------------------------------

const deniedHostValues = new Map<unknown, string>([
  [process, "process"],
  [globalThis, "the relay's global object"],
  [fs, "fs"],
  [fsPromises, "fs/promises"],
  [fs.promises, "fs/promises"],
  [childProcess, "child_process"],
  [cluster, "cluster"],
  [dgram, "dgram"],
  [dns, "dns"],
  [http, "http"],
  [http2, "http2"],
  [https, "https"],
  [inspector, "inspector"],
  [module, "module"],
  [net, "net"],
  [os, "os"],
  [tls, "tls"],
  [v8, "v8"],
  [vm, "vm"],
  [workerThreads, "worker_threads"],
  [globalThis.fetch, "Node fetch"],
  [eval, "eval"],
])

// Playwright classes that launch local processes or make Node-side HTTP requests.
const deniedHostClasses = new Map<string, string>([
  ["APIRequestContext", "Playwright's Node-side HTTP client (page.request / context.request) is not available in execute code; use page.evaluate(() => fetch(...)) for requests with the page's cookies"],
  ["BrowserType", "browser.browserType() can launch local processes and is not available in execute code"],
  ["Playwright", "the Playwright root object is not available in execute code"],
  ["Android", "Playwright Android is not available in execute code"],
  ["Electron", "Playwright Electron is not available in execute code"],
  ["LocalUtils", "Playwright local utilities are not available in execute code"],
])

const intrinsicNames = [
  "Object", "Function", "Array", "Number", "String", "Boolean", "Symbol", "BigInt", "Date", "RegExp",
  "Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "EvalError", "URIError", "AggregateError",
  "Promise", "Map", "Set", "WeakMap", "WeakSet", "WeakRef", "ArrayBuffer", "DataView",
  "Uint8Array", "Int8Array", "Uint16Array", "Int16Array", "Uint32Array", "Int32Array", "Float32Array", "Float64Array",
  "Uint8ClampedArray", "BigInt64Array", "BigUint64Array", "JSON", "Math", "Reflect", "Proxy", "Intl", "Atomics",
] as const

const intrinsicSource = `(() => {
  const named = { ${intrinsicNames.map((name) => `${name}: typeof ${name} === "undefined" ? undefined : ${name}`).join(", ")} }
  named.AsyncFunction = (async function () {}).constructor
  named.GeneratorFunction = (function* () {}).constructor
  named.AsyncGeneratorFunction = (async function* () {}).constructor
  named.IteratorPrototype = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()))
  named.AsyncIteratorPrototype = Object.getPrototypeOf(Object.getPrototypeOf((async function* () {}).prototype))
  named.TypedArray = Object.getPrototypeOf(Uint8Array)
  named.eval = eval
  return named
})()`

function hostIntrinsics(): Record<string, unknown> {
  // Evaluated with indirect eval so the values are this (host) realm's.
  return (0, eval)(intrinsicSource) as Record<string, unknown>
}

function containsDynamicImport(source: string): boolean {
  let ast: acorn.Node
  try {
    ast = acorn.parse(source, { ecmaVersion: "latest", sourceType: "script", allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true })
  } catch {
    // vm.Script reports the syntax error.
    return false
  }
  const pending: unknown[] = [ast]
  while (pending.length > 0) {
    const node = pending.pop()
    if (node === null || typeof node !== "object") continue
    if (Array.isArray(node)) {
      pending.push(...node)
      continue
    }
    const type = (node as { type?: unknown }).type
    if (type === "ImportExpression" || (type === "MetaProperty" && (node as { meta?: { name?: unknown } }).meta?.name === "import")) return true
    for (const value of Object.values(node)) if (value !== null && typeof value === "object") pending.push(value)
  }
  return false
}

function isObjectLike(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function"
}

const isHiddenKey = (key: PropertyKey): boolean => typeof key === "string" && key.startsWith("_")

/** A shadow target with no non-configurable own properties, so the proxy can report the host object's shape freely. */
function shadowFor(value: object): object {
  if (typeof value === "function") return (function () {}).bind(undefined)
  return {}
}

export class ExecuteRealm {
  readonly context: vm.Context
  /** Persistent `state` object, created in the sandbox realm. */
  readonly state: Record<string, unknown>
  private readonly sandboxObjectPrototype: object
  private readonly sandboxFunctionPrototype: object
  private readonly sandboxArrayPrototype: object
  private readonly SandboxPromise: PromiseConstructor
  private readonly SandboxError: ErrorConstructor
  private readonly sandboxPromiseThen: Function
  private readonly sandboxIntrinsics: Record<string, unknown>
  private readonly hostToSandboxIntrinsic = new Map<unknown, unknown>()
  private readonly sandboxToHostIntrinsic = new Map<unknown, unknown>()
  private readonly sandboxProxyByHost = new WeakMap<object, object>()
  private readonly hostBySandboxProxy = new WeakMap<object, object>()
  private readonly hostProxyBySandbox = new WeakMap<object, object>()
  private readonly sandboxByHostProxy = new WeakMap<object, object>()
  private readonly forceProxy = new WeakSet<object>()

  constructor() {
    const importModuleDynamically = () => {
      throw new this.SandboxError("import() is not available in execute code")
    }
    const dontContextify = (vm.constants as unknown as { readonly DONT_CONTEXTIFY?: unknown } | undefined)?.DONT_CONTEXTIFY
    this.context = vm.createContext((dontContextify ?? Object.create(null)) as vm.Context, {
      name: "opencode-browser-execute",
      // No eval/new Function in the sandbox, so the static import() check in run() sees all code.
      codeGeneration: { strings: false, wasm: false },
      ...({ importModuleDynamically } as object),
    })
    const sandboxIntrinsics = new vm.Script(intrinsicSource, { importModuleDynamically } as vm.ScriptOptions).runInContext(this.context) as Record<string, unknown>
    this.sandboxIntrinsics = sandboxIntrinsics
    const host = hostIntrinsics()
    for (const name of Object.keys(host)) {
      const hostValue = host[name]
      const sandboxValue = sandboxIntrinsics[name]
      if (!isObjectLike(hostValue) || !isObjectLike(sandboxValue)) continue
      this.hostToSandboxIntrinsic.set(hostValue, sandboxValue)
      this.sandboxToHostIntrinsic.set(sandboxValue, hostValue)
      const hostPrototype = (hostValue as { prototype?: unknown }).prototype
      const sandboxPrototype = (sandboxValue as { prototype?: unknown }).prototype
      if (typeof hostValue === "function" && isObjectLike(hostPrototype) && isObjectLike(sandboxPrototype)) {
        this.hostToSandboxIntrinsic.set(hostPrototype, sandboxPrototype)
        this.sandboxToHostIntrinsic.set(sandboxPrototype, hostPrototype)
      }
    }
    const sandboxObject = sandboxIntrinsics.Object as ObjectConstructor
    this.sandboxObjectPrototype = sandboxObject.prototype
    this.sandboxFunctionPrototype = (sandboxIntrinsics.Function as FunctionConstructor).prototype
    this.sandboxArrayPrototype = (sandboxIntrinsics.Array as ArrayConstructor).prototype
    this.SandboxPromise = sandboxIntrinsics.Promise as PromiseConstructor
    this.SandboxError = sandboxIntrinsics.Error as ErrorConstructor
    this.sandboxPromiseThen = this.SandboxPromise.prototype.then
    this.state = Object.create(this.sandboxObjectPrototype) as Record<string, unknown>
    // Stack-trace callbacks receive call sites that can expose functions of sloppy host frames.
    new vm.Script(
      "Object.defineProperty(Error, 'prepareStackTrace', { value: undefined, writable: false, configurable: false })",
    ).runInContext(this.context)
    this.installGlobals()
  }

  private installGlobals(): void {
    const global = new vm.Script("globalThis").runInContext(this.context) as Record<string, unknown>
    const hostGlobals: Record<string, unknown> = {
      setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, clearImmediate, queueMicrotask,
      structuredClone, atob, btoa, URL, URLSearchParams, TextEncoder, TextDecoder, Buffer, AbortController,
      AbortSignal, Blob, Event, EventTarget, performance, crypto: globalThis.crypto,
    }
    for (const [name, value] of Object.entries(hostGlobals)) {
      if (value === undefined) continue
      Reflect.defineProperty(global, name, { value: this.toSandbox(value), writable: true, configurable: true, enumerable: false })
    }
  }

  /** Make a host object cross as a proxy even when it is plain data (module objects, helper namespaces). */
  proxyAsObject<T extends object>(value: T): T {
    this.forceProxy.add(value)
    return value
  }

  /**
   * Compile `source` (a function expression) in the sandbox and call it with
   * `bindings`. Values are converted through the membrane; the result comes
   * back as host data.
   */
  async run(options: {
    readonly source: string
    readonly filename: string
    readonly args: readonly unknown[]
    /** Sandbox-realm values passed through unchanged (for example `state`). */
    readonly sandboxArgs?: ReadonlyMap<number, unknown>
  }): Promise<unknown> {
    const importModuleDynamically = () => {
      throw new this.SandboxError("import() is not available in execute code")
    }
    // Node rejects import() in a vm context with an error created in the relay's realm, which would hand the
    // sandbox the relay's Function constructor. With code generation from strings off, a static check sees all code.
    if (containsDynamicImport(options.source)) {
      throw new Error("import() is not available in execute code. Set OPENCODE_BROWSER_ALLOW_NODE=1 on the relay for full Node access.")
    }
    let fn: unknown
    try {
      fn = new vm.Script(options.source, { filename: options.filename, importModuleDynamically } as vm.ScriptOptions).runInContext(this.context)
    } catch (error) {
      throw this.toHostThrown(error)
    }
    const args = options.args.map((value, index) => options.sandboxArgs?.has(index) ? options.sandboxArgs.get(index) : this.toSandbox(value))
    let result: unknown
    try {
      result = this.toHost(Reflect.apply(fn as Function, undefined, args))
    } catch (error) {
      throw this.toHostThrown(error)
    }
    return await result
  }

  // ---- host → sandbox -----------------------------------------------------------------------------

  private isSandboxNative(value: object): boolean {
    let current: object | null = value
    for (let depth = 0; current !== null && depth < 64; depth += 1) {
      if (current === this.sandboxObjectPrototype || current === this.sandboxFunctionPrototype) return true
      if (this.hostBySandboxProxy.has(current)) return false
      try {
        current = Reflect.getPrototypeOf(current)
      } catch {
        return false
      }
    }
    return false
  }

  private sandboxError(message: string): Error {
    return new this.SandboxError(message)
  }

  toSandbox(value: unknown, seen: Map<object, unknown> = new Map()): unknown {
    if (!isObjectLike(value)) return value
    if (this.hostBySandboxProxy.has(value)) return value
    const unwrapped = this.sandboxByHostProxy.get(value)
    if (unwrapped) return unwrapped
    if (this.hostToSandboxIntrinsic.has(value)) return this.hostToSandboxIntrinsic.get(value)
    const existing = this.sandboxProxyByHost.get(value)
    if (existing) return existing
    const copied = seen.get(value)
    if (copied !== undefined) return copied
    const denied = deniedHostValues.get(value)
    if (denied) throw this.sandboxError(`${denied} is not available in execute code. Set ${allowNodeEnvironmentVariable}=1 for full Node access.`)
    if (this.isSandboxNative(value)) return value
    if (util.types.isPromise(value)) return this.toSandboxPromise(value as Promise<unknown>)
    // Binary data other than Buffer (which keeps its host API) is copied into the sandbox's own typed arrays.
    if (util.types.isArrayBuffer(value)) {
      const SandboxUint8Array = this.sandboxIntrinsics.Uint8Array as Uint8ArrayConstructor
      return new SandboxUint8Array(new Uint8Array(value as ArrayBuffer)).buffer
    }
    if (util.types.isTypedArray(value) && !Buffer.isBuffer(value)) {
      const name = Object.prototype.toString.call(value).slice(8, -1)
      const Constructor = (this.sandboxIntrinsics[name] ?? this.sandboxIntrinsics.Uint8Array) as new (source: unknown) => unknown
      return new Constructor(value)
    }
    const deniedClass = this.deniedClass(value)
    if (deniedClass) throw this.sandboxError(deniedClass)
    if (!this.forceProxy.has(value) && typeof value === "object") {
      const prototype = Reflect.getPrototypeOf(value)
      if (Array.isArray(value) && prototype === Array.prototype) {
        const output: unknown[] = []
        Reflect.setPrototypeOf(output, this.sandboxArrayPrototype)
        seen.set(value, output)
        for (let index = 0; index < value.length; index += 1) output[index] = this.toSandbox(value[index], seen)
        return output
      }
      if ((prototype === Object.prototype || prototype === null) && !Object.hasOwn(value, "constructor") && !util.types.isProxy(value)) {
        const output = Object.create(prototype === null ? null : this.sandboxObjectPrototype) as Record<string, unknown>
        seen.set(value, output)
        for (const key of Object.keys(value)) {
          Reflect.defineProperty(output, key, {
            value: this.toSandbox((value as Record<string, unknown>)[key], seen),
            writable: true,
            enumerable: true,
            configurable: true,
          })
        }
        return output
      }
    }
    return this.sandboxProxy(value)
  }

  private deniedClass(value: object): string | undefined {
    try {
      const prototype = Reflect.getPrototypeOf(value) as { constructor?: { name?: unknown } } | null
      const name = prototype?.constructor?.name
      // Bundlers may suffix class names (APIRequestContext2).
      return typeof name === "string" ? deniedHostClasses.get(name.replace(/\d+$/, "")) : undefined
    } catch {
      return undefined
    }
  }

  private toSandboxPromise(promise: Promise<unknown>): Promise<unknown> {
    return new this.SandboxPromise((resolve, reject) => {
      promise.then(
        (value) => {
          try {
            resolve(this.toSandbox(value))
          } catch (error) {
            reject(this.toSandboxThrown(error))
          }
        },
        (error: unknown) => {
          reject(this.toSandboxThrown(error))
        },
      )
    })
  }

  /** Convert anything thrown on the host side into a value safe to throw in the sandbox. */
  private toSandboxThrown(error: unknown): unknown {
    if (!isObjectLike(error)) return error
    try {
      return this.toSandbox(error)
    } catch (conversionError) {
      if (isObjectLike(conversionError) && this.isSandboxNative(conversionError)) return conversionError
      return this.sandboxError(error instanceof Error ? error.message : "Host operation failed")
    }
  }

  /** Values thrown by sandbox-side conversion code: keep sandbox values, replace anything else. */
  private sanitizeThrown(error: unknown): unknown {
    if (!isObjectLike(error)) return error
    if (this.hostBySandboxProxy.has(error) || this.isSandboxNative(error)) return error
    const original = this.sandboxByHostProxy.get(error)
    if (original) return original
    if (error instanceof Error) return this.toSandboxThrown(error)
    return this.sandboxError("Execute operation failed")
  }

  private sandboxProxy(target: object): object {
    const realm = this
    const handler: ProxyHandler<object> = {
      get(_shadow, key) {
        if (isHiddenKey(key)) return undefined
        let value: unknown
        try {
          value = Reflect.get(target, key)
        } catch (error) {
          throw realm.toSandboxThrown(error)
        }
        try {
          return realm.toSandbox(value)
        } catch (error) {
          throw realm.sanitizeThrown(error)
        }
      },
      set(_shadow, key, value) {
        if (isHiddenKey(key)) return false
        const hostValue = realm.toHost(value)
        try {
          return Reflect.set(target, key, hostValue)
        } catch (error) {
          throw realm.toSandboxThrown(error)
        }
      },
      has(_shadow, key) {
        if (isHiddenKey(key)) return false
        try {
          return Reflect.has(target, key)
        } catch (error) {
          throw realm.toSandboxThrown(error)
        }
      },
      deleteProperty(_shadow, key) {
        if (isHiddenKey(key)) return true
        try {
          return Reflect.deleteProperty(target, key)
        } catch (error) {
          throw realm.toSandboxThrown(error)
        }
      },
      ownKeys() {
        let keys: (string | symbol)[]
        try {
          keys = Reflect.ownKeys(target)
        } catch (error) {
          throw realm.toSandboxThrown(error)
        }
        return keys.filter((key) => !isHiddenKey(key))
      },
      getOwnPropertyDescriptor(_shadow, key) {
        if (isHiddenKey(key)) return undefined
        let descriptor: PropertyDescriptor | undefined
        try {
          descriptor = Reflect.getOwnPropertyDescriptor(target, key)
        } catch (error) {
          throw realm.toSandboxThrown(error)
        }
        if (!descriptor) return undefined
        try {
          return "value" in descriptor || !("get" in descriptor || "set" in descriptor)
            ? { value: realm.toSandbox(descriptor.value), writable: descriptor.writable ?? false, enumerable: descriptor.enumerable ?? false, configurable: true }
            : { get: realm.toSandbox(descriptor.get) as () => unknown, set: realm.toSandbox(descriptor.set) as (value: unknown) => void, enumerable: descriptor.enumerable ?? false, configurable: true }
        } catch (error) {
          throw realm.sanitizeThrown(error)
        }
      },
      defineProperty(_shadow, key, descriptor) {
        if (isHiddenKey(key) || descriptor.configurable === false) return false
        const hostDescriptor: PropertyDescriptor = { ...descriptor }
        if ("value" in descriptor) hostDescriptor.value = realm.toHost(descriptor.value)
        if (descriptor.get) hostDescriptor.get = realm.toHost(descriptor.get) as () => unknown
        if (descriptor.set) hostDescriptor.set = realm.toHost(descriptor.set) as (value: unknown) => void
        try {
          return Reflect.defineProperty(target, key, hostDescriptor)
        } catch (error) {
          throw realm.toSandboxThrown(error)
        }
      },
      getPrototypeOf() {
        let prototype: object | null
        try {
          prototype = Reflect.getPrototypeOf(target)
        } catch (error) {
          throw realm.toSandboxThrown(error)
        }
        if (prototype === null) return null
        try {
          return realm.toSandbox(prototype) as object
        } catch {
          return realm.sandboxObjectPrototype
        }
      },
      setPrototypeOf() {
        return false
      },
      preventExtensions() {
        return false
      },
      apply(_shadow, thisArgument, args) {
        const hostThis = realm.toHost(thisArgument)
        const hostArgs = args.map((arg) => realm.toHost(arg))
        try {
          checkHostCall(target as Function, hostThis, hostArgs)
        } catch (error) {
          // Refusals of promise-returning APIs reject, so `.catch()` in agent code sees them.
          if (returnsPromise(target as Function)) return realm.SandboxPromise.reject(realm.toSandboxThrown(error))
          throw realm.toSandboxThrown(error)
        }
        let result: unknown
        try {
          result = Reflect.apply(target as Function, hostThis, hostArgs)
        } catch (error) {
          throw realm.toSandboxThrown(error)
        }
        try {
          return realm.toSandbox(result)
        } catch (error) {
          throw realm.sanitizeThrown(error)
        }
      },
      construct(_shadow, args, newTarget) {
        if (newTarget !== proxy && !realm.hostBySandboxProxy.has(newTarget)) {
          throw realm.sandboxError("Extending host classes is not supported in execute code")
        }
        const hostArgs = args.map((arg) => realm.toHost(arg))
        let result: object
        try {
          checkHostCall(target as Function, undefined, hostArgs)
          result = Reflect.construct(target as Function, hostArgs, newTarget === proxy ? target as Function : realm.hostBySandboxProxy.get(newTarget) as Function)
        } catch (error) {
          throw realm.toSandboxThrown(error)
        }
        try {
          return realm.toSandbox(result) as object
        } catch (error) {
          throw realm.sanitizeThrown(error)
        }
      },
    }
    const proxy = new Proxy(shadowFor(target), handler)
    this.sandboxProxyByHost.set(target, proxy)
    this.hostBySandboxProxy.set(proxy, target)
    return proxy
  }

  // ---- sandbox → host -----------------------------------------------------------------------------

  /** Convert a sandbox value for the host: unwrap host proxies, copy data, wrap functions. */
  toHost(value: unknown, seen: Map<object, unknown> = new Map()): unknown {
    if (!isObjectLike(value)) return value
    if (this.sandboxByHostProxy.has(value)) return value
    const host = this.hostBySandboxProxy.get(value)
    if (host) return host
    if (this.sandboxToHostIntrinsic.has(value)) return this.sandboxToHostIntrinsic.get(value)
    const wrapped = this.hostProxyBySandbox.get(value)
    if (wrapped) return wrapped
    const copied = seen.get(value)
    if (copied !== undefined) return copied
    if (typeof value === "function") return this.hostProxy(value)
    try {
      return this.copyToHost(value, seen)
    } catch (error) {
      if (isObjectLike(error) && (this.isSandboxNative(error) || this.hostBySandboxProxy.has(error))) throw error
      throw this.sandboxError(error instanceof Error ? error.message : "Could not convert an execute value")
    }
  }

  private copyToHost(value: object, seen: Map<object, unknown>): unknown {
    if (util.types.isPromise(value)) return this.toHostPromise(value as Promise<unknown>)
    if (util.types.isDate(value)) return new Date(Date.prototype.getTime.call(value))
    if (util.types.isRegExp(value)) {
      const source = Reflect.get(value, "source")
      const flags = Reflect.get(value, "flags")
      return new RegExp(String(source), String(flags))
    }
    if (util.types.isNativeError(value) || value instanceof this.SandboxError) {
      const name = String(Reflect.get(value, "name") ?? "Error")
      const output = new Error(String(Reflect.get(value, "message") ?? ""))
      seen.set(value, output)
      Object.defineProperty(output, "name", { value: name, configurable: true, writable: true, enumerable: false })
      const stack = Reflect.get(value, "stack")
      if (typeof stack === "string") output.stack = stack
      for (const key of Object.keys(value)) {
        if (key === "name" || key === "message" || key === "stack") continue
        ;(output as unknown as Record<string, unknown>)[key] = this.toHost(Reflect.get(value, key), seen)
      }
      const cause = Reflect.get(value, "cause")
      if (cause !== undefined) Object.defineProperty(output, "cause", { value: this.toHost(cause, seen), configurable: true, writable: true })
      return output
    }
    if (util.types.isMap(value)) {
      const output = new Map<unknown, unknown>()
      seen.set(value, output)
      Map.prototype.forEach.call(value, (item: unknown, key: unknown) => output.set(this.toHost(key, seen), this.toHost(item, seen)))
      return output
    }
    if (util.types.isSet(value)) {
      const output = new Set<unknown>()
      seen.set(value, output)
      Set.prototype.forEach.call(value, (item: unknown) => output.add(this.toHost(item, seen)))
      return output
    }
    if (util.types.isArrayBuffer(value)) return new Uint8Array(new Uint8Array(value as ArrayBuffer)).buffer
    if (util.types.isTypedArray(value)) {
      const name = Object.prototype.toString.call(value).slice(8, -1)
      const Constructor = (globalThis as unknown as Record<string, new (source: ArrayLike<number> | ArrayLike<bigint>) => unknown>)[name] ?? Uint8Array
      return new Constructor(value as unknown as ArrayLike<number>)
    }
    if (Array.isArray(value)) {
      const output: unknown[] = []
      seen.set(value, output)
      const length = value.length
      for (let index = 0; index < length; index += 1) output[index] = this.toHost(value[index], seen)
      return output
    }
    const output: Record<string, unknown> = {}
    seen.set(value, output)
    for (const key of Object.keys(value)) output[key] = this.toHost((value as Record<string, unknown>)[key], seen)
    return output
  }

  private toHostPromise(promise: Promise<unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      Reflect.apply(this.sandboxPromiseThen, promise, [
        (value: unknown) => {
          try {
            resolve(this.toHost(value))
          } catch (error) {
            reject(this.toHostThrown(error))
          }
        },
        (error: unknown) => {
          reject(this.toHostThrown(error))
        },
      ])
    })
  }

  /** Convert anything thrown by sandbox code into a host value. */
  toHostThrown(error: unknown): unknown {
    if (isObjectLike(error) && !this.hostBySandboxProxy.has(error) && !this.isSandboxNative(error) && error instanceof Error) return error
    try {
      return this.toHost(error)
    } catch {
      return new Error("Execute code threw a value that could not be converted")
    }
  }

  private hostProxy(target: object): object {
    const realm = this
    const handler: ProxyHandler<object> = {
      apply(_shadow, thisArgument, args) {
        try {
          const sandboxThis = realm.toSandbox(thisArgument)
          const sandboxArgs = args.map((arg) => realm.toSandbox(arg))
          return realm.toHost(Reflect.apply(target as Function, sandboxThis, sandboxArgs))
        } catch (error) {
          throw realm.toHostThrown(error)
        }
      },
      construct(_shadow, args) {
        try {
          return realm.toHost(Reflect.construct(target as Function, args.map((arg) => realm.toSandbox(arg)))) as object
        } catch (error) {
          throw realm.toHostThrown(error)
        }
      },
      get(_shadow, key) {
        try {
          return realm.toHost(Reflect.get(target, key))
        } catch (error) {
          throw realm.toHostThrown(error)
        }
      },
      set(_shadow, key, value) {
        try {
          return Reflect.set(target, key, realm.toSandbox(value))
        } catch (error) {
          throw realm.toHostThrown(error)
        }
      },
      has(_shadow, key) {
        try {
          return Reflect.has(target, key)
        } catch (error) {
          throw realm.toHostThrown(error)
        }
      },
    }
    const proxy = new Proxy(shadowFor(target), handler)
    this.hostProxyBySandbox.set(target, proxy)
    this.sandboxByHostProxy.set(proxy, target)
    return proxy
  }
}
