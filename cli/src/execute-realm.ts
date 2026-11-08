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
 * Execute JavaScript shares the relay's event loop with every session, so each
 * synchronous slice (initial code, callback, timer, promise continuation and the
 * microtasks it queues) is cut off after OPENCODE_BROWSER_EXECUTE_SLICE_MS, and
 * callbacks that use the relay thread's CPU more than half the time (over a
 * window of three slices) are stopped too. Async entries are queued fairly
 * between sessions and paced so the relay keeps answering (cpu-scheduler.ts).
 * Native work inside one host call (a large zlib *Sync call, allocating a huge
 * Buffer) and memory use are not bounded this way.
 *
 * The slice timeout is V8's TerminateExecution: it can land anywhere on the
 * stack, including inside a host function the sandbox called synchronously
 * (membrane traps, helpers, timer scheduling). Host functions reachable from
 * the sandbox must therefore stay short and must not leave relay bookkeeping
 * half-updated if cut off midway (update state in one step, or so that a
 * partial update is harmless); a terminated realm is disposed, not resumed.
 *
 * Residual risk: this is defence in depth, not a security boundary as strong
 * as a separate process. A bug in this membrane or a Playwright API that
 * reaches the host in a way not covered here could still escape, and the
 * agent keeps everything the browser itself can do (navigate anywhere, read
 * any attached page, exfiltrate through page requests). Set
 * OPENCODE_BROWSER_ALLOW_NODE=1 to run execute code with full Node access.
 */
import buffer from "node:buffer"
import crypto from "node:crypto"
import util from "node:util"
import vm from "node:vm"
import { ExecuteCpuScheduler } from "./execute-realm/cpu-scheduler.ts"
import {
  allowForegroundEnvironmentVariable,
  allowNodeEnvironmentVariable,
  assertExecuteFilePath,
  bringToFrontBlockedMessage,
  checkHostCall,
  completeExecuteFileOutputs,
  createExecuteFiles,
  executeAllowsForeground,
  executeAllowsNode,
  ExecuteFileAccessError,
  executeFileRoots,
  executeFilesDirectory,
  executeSliceEnvironmentVariable,
  executeSliceMs,
  fileRootsEnvironmentVariable,
  pageVisibleApiWarning,
  pageVisibleApiWarningForName,
  prepareExecuteFileOutputs,
  pruneStaleExecuteFilesDirectories,
  removeExecuteFilesDirectory,
  returnsPromise,
  sandboxModules,
  type ExecuteFiles,
  type PreparedExecuteFileOutputs,
} from "./execute-realm/file-roots.ts"
import { installRealmGlobals, populateHostToSandboxIntrinsics } from "./execute-realm/globals.ts"
import {
  containsDynamicImport,
  deniedHostClasses,
  deniedHostValues,
  handleExecuteRealmException,
  handleExecuteRealmRejection,
  handleRealmUnhandledRejection,
  intrinsicSource,
  isHiddenKey,
  isObjectLike,
  registerRealmPromisePrototype,
  shadowFor,
  tagThrownByRealm,
  trackPromisesOf,
} from "./execute-realm/membrane-policy.ts"

export {
  allowForegroundEnvironmentVariable,
  allowNodeEnvironmentVariable,
  assertExecuteFilePath,
  bringToFrontBlockedMessage,
  checkHostCall,
  createExecuteFiles,
  executeAllowsForeground,
  executeAllowsNode,
  ExecuteFileAccessError,
  executeFileRoots,
  executeFilesDirectory,
  executeSliceEnvironmentVariable,
  executeSliceMs,
  ExecuteCpuScheduler,
  fileRootsEnvironmentVariable,
  handleExecuteRealmException,
  handleExecuteRealmRejection,
  pageVisibleApiWarning,
  pageVisibleApiWarningForName,
  pruneStaleExecuteFilesDirectories,
  removeExecuteFilesDirectory,
  sandboxModules,
  type ExecuteFiles,
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
  private readonly sandboxAwait: Function
  private readonly sandboxIntrinsics: Record<string, unknown>
  private readonly hostToSandboxIntrinsic = new Map<unknown, unknown>()
  // Host value -> the proxy sandbox code sees for it.
  private readonly sandboxProxyByHost = new WeakMap<object, object>()
  // Sandbox-facing proxy -> the host value it stands for.
  private readonly hostBySandboxProxy = new WeakMap<object, object>()
  // Sandbox value -> the host-facing proxy host helpers see for it.
  private readonly hostProxyBySandbox = new WeakMap<object, object>()
  // Host-facing proxy -> the sandbox value it stands for.
  private readonly sandboxByHostProxy = new WeakMap<object, object>()
  // Host function -> the checkHostCall-guarded proxy host helpers receive instead.
  private readonly guardedHostFunctions = new WeakMap<Function, Function>()
  private readonly forceProxy = new WeakSet<object>()
  // Timer state, the scheduler and `stopped` are not private: ./execute-realm/globals.ts schedules timers on them.
  readonly timers = new Map<number, ReturnType<typeof setTimeout>>()
  nextTimer = 0
  readonly scheduler: ExecuteCpuScheduler
  private entryDepth = 0
  stopped: Error | undefined
  private readonly pendingRuns = new Set<(error: Error) => void>()
  private readonly entryKey = `__execute_${crypto.randomUUID().replaceAll("-", "")}`
  private readonly entryScript: vm.Script
  private readonly global: Record<string, unknown>

  /** Called for every host call sandbox code makes, after the call is allowed (execute warnings). */
  private readonly onHostCall: ((fn: Function, receiver: unknown, args: readonly unknown[]) => void) | undefined
  private readonly onUnhandledRejection: ((warning: string) => void) | undefined
  private readonly refuseDynamicImport = () => { throw new this.SandboxError("import() is not available in execute code") }

  constructor(options: {
    readonly onHostCall?: (fn: Function, receiver: unknown, args: readonly unknown[]) => void
    readonly onUnhandledRejection?: (warning: string) => void
    /** The relay's shared scheduler; a standalone realm gets its own. */
    readonly scheduler?: ExecuteCpuScheduler
  } = {}) {
    this.scheduler = options.scheduler ?? new ExecuteCpuScheduler()
    this.onHostCall = options.onHostCall
    this.onUnhandledRejection = options.onUnhandledRejection
    const importModuleDynamically = this.refuseDynamicImport
    const dontContextify = (vm.constants as unknown as { readonly DONT_CONTEXTIFY?: unknown } | undefined)?.DONT_CONTEXTIFY
    this.context = vm.createContext((dontContextify ?? Object.create(null)) as vm.Context, {
      name: "opencode-browser-execute",
      // No eval/new Function in the sandbox, so the static import() check in run() sees all code.
      codeGeneration: { strings: false, wasm: false },
      // Async continuations must drain under runInContext's CPU timeout too.
      microtaskMode: "afterEvaluate",
      ...({ importModuleDynamically } as object),
    })
    const sandboxIntrinsics = new vm.Script(intrinsicSource, { importModuleDynamically } as vm.ScriptOptions).runInContext(this.context) as Record<string, unknown>
    this.sandboxIntrinsics = sandboxIntrinsics
    populateHostToSandboxIntrinsics(this.hostToSandboxIntrinsic, sandboxIntrinsics)
    const sandboxObject = sandboxIntrinsics.Object as ObjectConstructor
    this.sandboxObjectPrototype = sandboxObject.prototype
    this.sandboxFunctionPrototype = (sandboxIntrinsics.Function as FunctionConstructor).prototype
    this.sandboxArrayPrototype = (sandboxIntrinsics.Array as ArrayConstructor).prototype
    this.SandboxPromise = sandboxIntrinsics.Promise as PromiseConstructor
    registerRealmPromisePrototype(this.SandboxPromise.prototype, this)
    this.SandboxError = sandboxIntrinsics.Error as ErrorConstructor
    // Await handles hostile Promise subclasses/species without leaving a rejected
    // original promise unobserved if `.then()` itself throws during conversion.
    this.sandboxAwait = new vm.Script("(async (value, resolve, reject) => { try { resolve(await value) } catch (error) { reject(error) } })").runInContext(this.context) as Function
    this.state = Object.create(this.sandboxObjectPrototype) as Record<string, unknown>
    this.global = new vm.Script("globalThis").runInContext(this.context) as Record<string, unknown>
    // Remove the host entry function before running any untrusted code. It is
    // never exposed to the realm, even while callbacks re-enter it.
    this.entryScript = new vm.Script(`(() => { "use strict"; const entry = this[${JSON.stringify(this.entryKey)}]; delete this[${JSON.stringify(this.entryKey)}]; return entry(); })()`)
    // Stack-trace callbacks receive call sites that can expose functions of sloppy host frames.
    new vm.Script(
      "Object.defineProperty(Error, 'prepareStackTrace', { value: undefined, writable: false, configurable: false }); globalThis.SharedArrayBuffer = undefined; globalThis.Atomics = undefined; globalThis.WeakRef = undefined; globalThis.FinalizationRegistry = undefined",
    ).runInContext(this.context)
    installRealmGlobals(this, this.global)
    for (const module of Object.values(sandboxModules)) this.forceProxy.add(module)
  }

  /** Pending realm timers, for tests and diagnostics. */
  get pendingTimers(): number { return this.timers.size }

  /** Revoke callbacks and timers when execution is stopped or its CPU budget is exhausted. */
  dispose(error = new Error("Execute stopped")): void {
    if (this.stopped) return
    this.stopped = error
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    for (const reject of this.pendingRuns) reject(error)
    this.pendingRuns.clear()
    this.scheduler.forget(this)
  }

  get isStopped(): boolean { return this.stopped !== undefined }

  /** A promise this realm created rejected with no handler; stop it so the relay survives. */
  handleUnhandledRejection(cause: unknown, certain: boolean): void {
    handleRealmUnhandledRejection(this, cause, certain, this.onUnhandledRejection, this.pendingRuns.size > 0)
  }

  /** The host value a sandbox proxy of this realm stands for, if any. A WeakMap lookup runs no sandbox code. */
  hostValueForSandboxValue(value: unknown): object | undefined { return isObjectLike(value) ? this.hostBySandboxProxy.get(value) : undefined }

  private enter<T>(entry: () => T): T {
    if (this.stopped) throw this.stopped
    if (this.entryDepth > 0) return entry()
    if (!Reflect.defineProperty(this.global, this.entryKey, { value: entry, configurable: true })) {
      this.dispose(new Error("Execute made its global non-extensible; JavaScript state will reset before the next execute"))
      throw this.stopped
    }
    const untrack = trackPromisesOf(this)
    this.entryDepth += 1
    this.scheduler.begin()
    const startedAt = process.threadCpuUsage()
    try {
      return this.entryScript.runInContext(this.context, { timeout: this.scheduler.sliceMs }) as T
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ERR_SCRIPT_EXECUTION_TIMEOUT") {
        this.dispose(new Error(
          `Execute exceeded its synchronous CPU budget: JavaScript ran for over ${this.scheduler.sliceMs}ms without yielding, which stalls every session on the relay. ` +
          "Likely causes: a loop that never ends, a slow regular expression, or converting a very large value. " +
          "Split heavy work into chunks separated by `await new Promise(r => setTimeout(r, 0))`, do it in the page with page.evaluate(), or return less data " +
          `(the relay's limit is ${executeSliceEnvironmentVariable}). JavaScript state will reset before the next execute.`,
        ))
        throw this.stopped
      }
      throw error
    } finally {
      this.entryDepth -= 1
      untrack()
      Reflect.deleteProperty(this.global, this.entryKey)
      if (this.scheduler.end(this, process.threadCpuUsage(startedAt)) && !this.stopped) {
        this.dispose(new Error(
          "Execute exceeded its sustained CPU budget: its callbacks and timers kept the relay's JavaScript busy more than half the time, which stalls every session on the relay. " +
          "Do heavy work in the page with page.evaluate(), or wait longer between timer or event callbacks. JavaScript state will reset before the next execute.",
        ))
      }
    }
  }

  private drainMicrotasks(): void {
    if (this.stopped || this.entryDepth > 0) return
    try { this.enter(() => {}) } catch (error) {
      this.dispose(error instanceof Error ? error : new Error("Execute microtask failed"))
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
    const importModuleDynamically = this.refuseDynamicImport
    // Node rejects import() in a vm context with an error created in the relay's realm, which would hand the
    // sandbox the relay's Function constructor. With code generation from strings off, a static check sees all code.
    if (containsDynamicImport(options.source)) {
      throw new Error("import() is not available in execute code. Set OPENCODE_BROWSER_ALLOW_NODE=1 on the relay for full Node access.")
    }
    let rejectRun!: (error: Error) => void
    const stopped = new Promise<never>((_resolve, reject) => { rejectRun = reject })
    // Attach before entering the VM: a synchronous timeout also rejects this promise.
    void stopped.catch(() => {})
    this.pendingRuns.add(rejectRun)
    try {
      if (this.stopped) throw this.stopped
      const result = new Promise((resolve, reject) => this.scheduler.schedule(this, () => {
        try {
          resolve(this.enter(() => {
            const fn = new vm.Script(options.source, { filename: options.filename, importModuleDynamically } as vm.ScriptOptions).runInContext(this.context)
            const args = options.args.map((value, index) => options.sandboxArgs?.has(index) ? options.sandboxArgs.get(index) : this.toSandbox(value))
            return this.toHost(Reflect.apply(fn as Function, undefined, args))
          }))
        } catch (error) { reject(error) }
      }))
      return await Promise.race([result, stopped])
    } catch (error) {
      throw this.toHostThrown(error)
    } finally {
      this.pendingRuns.delete(rejectRun)
    }
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

  private sandboxError(message: string): Error { return new this.SandboxError(message) }

  toSandbox(value: unknown, seen: Map<object, unknown> = new Map()): unknown {
    if (!isObjectLike(value)) return value
    // Uninitialised Buffer storage can contain bytes belonging to the relay.
    if (value === Buffer.allocUnsafe || value === Buffer.allocUnsafeSlow || value === (buffer as unknown as { SlowBuffer?: unknown }).SlowBuffer) return this.toSandbox(Buffer.alloc)
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
    // Small Buffers share a host allocation pool. Exposing `.buffer`/`.parent`
    // must not reveal other bytes in that pool (including relay credentials).
    if (Buffer.isBuffer(value)) {
      const copy = Buffer.alloc(value.length)
      copy.set(value)
      const proxy = this.sandboxProxy(copy)
      this.sandboxProxyByHost.set(value, proxy)
      return proxy
    }
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
      if ((Array.isArray(value) && prototype === Array.prototype) || util.types.isArgumentsObject(value)) {
        const output: unknown[] = []
        Reflect.setPrototypeOf(output, this.sandboxArrayPrototype)
        seen.set(value, output)
        const array = value as ArrayLike<unknown>
        for (let index = 0; index < array.length; index += 1) output[index] = this.toSandbox(array[index], seen)
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
        (value) => this.scheduler.schedule(this, () => {
          if (this.stopped) return
          try {
            this.enter(() => resolve(this.toSandbox(value)))
          } catch (error) {
            if (!this.stopped) this.enter(() => reject(this.toSandboxThrown(error)))
          }
          this.drainMicrotasks()
        }),
        (error: unknown) => this.scheduler.schedule(this, () => {
          if (this.stopped) return
          try { this.enter(() => reject(this.toSandboxThrown(error))) } catch (failure) {
            this.dispose(failure instanceof Error ? failure : new Error("Execute promise callback failed"))
          }
          this.drainMicrotasks()
        }),
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
      set() {
        return false
      },
      has(_shadow, key) {
        if (isHiddenKey(key)) return false
        try {
          return Reflect.has(target, key)
        } catch (error) {
          throw realm.toSandboxThrown(error)
        }
      },
      deleteProperty() {
        return false
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
            ? { value: realm.toSandbox(descriptor.value), writable: false, enumerable: descriptor.enumerable ?? false, configurable: true }
            : { get: realm.toSandbox(descriptor.get) as () => unknown, enumerable: descriptor.enumerable ?? false, configurable: true }
        } catch (error) {
          throw realm.sanitizeThrown(error)
        }
      },
      defineProperty() {
        return false
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
        const hostThis = isObjectLike(thisArgument) && realm.hostBySandboxProxy.has(thisArgument)
          ? realm.hostBySandboxProxy.get(thisArgument)
          : realm.toHost(thisArgument)
        const hostArgs = args.map((arg) => realm.toHost(arg))
        let prepared: PreparedExecuteFileOutputs
        try {
          prepared = prepareExecuteFileOutputs(checkHostCall(target as Function, hostThis, hostArgs))
        } catch (error) {
          // Refusals of promise-returning APIs reject, so `.catch()` in agent code sees them.
          if (returnsPromise(target as Function)) return realm.SandboxPromise.reject(realm.toSandboxThrown(error))
          throw realm.toSandboxThrown(error)
        }
        try {
          realm.onHostCall?.(target as Function, hostThis, hostArgs)
        } catch {
          // Observation only: a failing observer never changes the call.
        }
        let result: unknown
        try {
          result = Reflect.apply(target as Function, hostThis, hostArgs)
        } catch (error) {
          throw realm.toSandboxThrown(error)
        }
        try {
          return realm.toSandbox(completeExecuteFileOutputs(result, prepared))
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
    if (host) {
      if (typeof host !== "function") return host
      let guarded = this.guardedHostFunctions.get(host)
      if (!guarded) {
        // Functions passed to host helpers (promisify/callbackify, streams, event
        // listeners, etc.) must keep their policy even when the helper calls them
        // later. Merely checking Function.prototype.call is not sufficient.
        guarded = new Proxy(host, {
          apply(target, receiver, args) {
            const prepared = prepareExecuteFileOutputs(checkHostCall(target, receiver, args))
            return completeExecuteFileOutputs(Reflect.apply(target, receiver, args), prepared)
          },
          construct(target, args, newTarget) {
            checkHostCall(target, undefined, args)
            return Reflect.construct(target, args, newTarget)
          },
          set: () => false,
          defineProperty: () => false,
          deleteProperty: () => false,
          setPrototypeOf: () => false,
          preventExtensions: () => false,
        })
        this.guardedHostFunctions.set(host, guarded)
        this.sandboxByHostProxy.set(guarded, value)
      }
      return guarded
    }
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
    if (Array.isArray(value) || util.types.isArgumentsObject(value)) {
      const output: unknown[] = []
      seen.set(value, output)
      const array = value as ArrayLike<unknown>
      for (let index = 0; index < array.length; index += 1) output[index] = this.toHost(array[index], seen)
      return output
    }
    const output: Record<string, unknown> = {}
    seen.set(value, output)
    for (const key of Object.keys(value)) {
      Object.defineProperty(output, key, { value: this.toHost((value as Record<string, unknown>)[key], seen), writable: true, enumerable: true, configurable: true })
    }
    return output
  }

  private toHostPromise(promise: Promise<unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      Reflect.apply(this.sandboxAwait, undefined, [promise,
        (value: unknown) => {
          try {
            resolve(this.enter(() => this.toHost(value)))
          } catch (error) {
            reject(this.stopped ?? this.enter(() => this.toHostThrown(error)))
          }
        },
        (error: unknown) => {
          try { reject(this.enter(() => this.toHostThrown(error))) } catch (failure) { reject(failure) }
        },
      ])
    })
  }

  /** Convert anything thrown by sandbox code into a host value. */
  toHostThrown(error: unknown): unknown {
    if (this.stopped) return this.stopped
    if (this.entryDepth === 0) return this.enter(() => this.toHostThrown(error))
    if (isObjectLike(error) && !this.hostBySandboxProxy.has(error) && !this.isSandboxNative(error) && error instanceof Error) return error
    try {
      return this.toHost(error)
    } catch {
      return new Error("Execute code threw a value that could not be converted")
    }
  }

  /** A value thrown from a sandbox callback into host code, tagged so an uncaught one stops only this realm. */
  private thrownToHost(error: unknown): unknown {
    const thrown = this.toHostThrown(error)
    // Primitives cannot be tagged; host callers only see their message.
    const value = isObjectLike(thrown) ? thrown : new Error(String(thrown))
    tagThrownByRealm(value, this)
    return value
  }

  private hostProxy(target: object): object {
    const realm = this
    const handler: ProxyHandler<object> = {
      apply(_shadow, thisArgument, args) {
        if (realm.stopped) return undefined
        try {
          return realm.enter(() => {
            const sandboxThis = realm.toSandbox(thisArgument)
            const sandboxArgs = args.map((arg) => realm.toSandbox(arg))
            return realm.toHost(Reflect.apply(target as Function, sandboxThis, sandboxArgs))
          })
        } catch (error) {
          if (realm.stopped) return undefined
          throw realm.thrownToHost(error)
        }
      },
      construct(_shadow, args) {
        if (realm.stopped) return Object.create(null) as object
        try {
          return realm.enter(() => realm.toHost(Reflect.construct(target as Function, args.map((arg) => realm.toSandbox(arg))))) as object
        } catch (error) {
          throw realm.thrownToHost(error)
        }
      },
      get(_shadow, key) {
        if (realm.stopped) {
          if (key === "apply") return Function.prototype.apply
          if (key === "call") return Function.prototype.call
          if (key === "bind") return Function.prototype.bind
          return undefined
        }
        try {
          return realm.enter(() => realm.toHost(Reflect.get(target, key)))
        } catch (error) {
          throw realm.thrownToHost(error)
        }
      },
      set(_shadow, key, value) {
        if (realm.stopped) return false
        try {
          return realm.enter(() => Reflect.set(target, key, realm.toSandbox(value)))
        } catch (error) {
          throw realm.thrownToHost(error)
        }
      },
      has(_shadow, key) {
        if (realm.stopped) return false
        try {
          return realm.enter(() => Reflect.has(target, key))
        } catch (error) {
          throw realm.thrownToHost(error)
        }
      },
    }
    const proxy = new Proxy(shadowFor(target), handler)
    this.hostProxyBySandbox.set(target, proxy)
    this.sandboxByHostProxy.set(proxy, target)
    return proxy
  }
}
