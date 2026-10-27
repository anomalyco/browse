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
 * callbacks that keep the loop busy more than half the time (over a window of
 * three slices) are stopped too. Native work inside one host call (a large zlib
 * *Sync call, allocating a huge Buffer) and memory use are not bounded this way.
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

export const executeSliceEnvironmentVariable = "OPENCODE_BROWSER_EXECUTE_SLICE_MS"

/**
 * Longest synchronous run of execute JavaScript (one VM entry: the initial code, a callback,
 * a timer, a promise continuation, plus its microtasks) before the realm is stopped. Every
 * session shares the relay's event loop, so this is how long a runaway loop can stall them.
 * 2s fits multi-MB JSON, large sorts and returning ~10 MB of data with headroom on slower machines.
 */
export function executeSliceMs(): number {
  const configured = Number.parseInt(process.env[executeSliceEnvironmentVariable] ?? "", 10)
  return Number.isFinite(configured) ? Math.min(Math.max(configured, 50), 60_000) : 2_000
}

export const executeAllowsNode = (): boolean => process.env[allowNodeEnvironmentVariable] === "1"
export const executeAllowsForeground = (): boolean => process.env[allowForegroundEnvironmentVariable] === "1"

export const bringToFrontBlockedMessage = "page.bringToFront() is blocked: it raises the user's browser window over their work. Use handoff(message) when the user needs to act in the tab, or set OPENCODE_BROWSER_ALLOW_FOREGROUND=1 for the relay to allow it."

/** Harmless compute modules available as `modules.*` and top-level aliases in sandboxed execute code. */
export const sandboxModules = { path, url, util, crypto, buffer, zlib, events, stream }

// ---- execute file roots -----------------------------------------------------------------------------

// Each process gets one private directory in TMPDIR, named with its pid: opencode-browser-files-<pid>-XXXXXX. Files
// stay readable after execute returns (agents read screenshots they saved), so the directory goes when the process
// exits, and a relay starting up removes the ones whose process is gone (killed, or crashed before its exit hook).
const filesDirectoryPrefix = "opencode-browser-files-"
const filesDirectoryPattern = /^opencode-browser-files-(\d+)-[A-Za-z0-9]{6}$/

/** Directory `files.write(name, ...)` uses for relative names. */
let filesDirectory: string | undefined
let filesDirectoryExitHook = false
export function executeFilesDirectory(): string {
  if (filesDirectory === undefined) {
    filesDirectory = fs.mkdtempSync(path.join(os.tmpdir(), `${filesDirectoryPrefix}${process.pid}-`))
    if (!filesDirectoryExitHook) {
      filesDirectoryExitHook = true
      process.once("exit", removeExecuteFilesDirectory)
    }
  }
  const stat = fs.lstatSync(filesDirectory)
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700))) {
    throw new ExecuteFileAccessError("files.dir must be an owned, private directory, not a symlink")
  }
  return fs.realpathSync(filesDirectory)
}

/** Removes this process's files directory and everything execute code saved in it. */
export function removeExecuteFilesDirectory(): void {
  const directory = filesDirectory
  filesDirectory = undefined
  if (directory === undefined) return
  try {
    const stat = fs.lstatSync(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink()) return
    fs.rmSync(directory, { recursive: true, force: true })
  } catch {
    // Already gone, or not ours to remove.
  }
}

const processAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: the pid exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

/**
 * Removes files directories left by processes that are gone: owned by this user, named with a pid that no longer runs.
 * Directories of live processes (another relay, a running CLI), of other users, and older unnamed ones stay.
 */
export function pruneStaleExecuteFilesDirectories(tmp = os.tmpdir()): readonly string[] {
  const removed: string[] = []
  let entries: string[]
  try {
    entries = fs.readdirSync(tmp)
  } catch {
    return removed
  }
  for (const entry of entries) {
    const match = filesDirectoryPattern.exec(entry)
    if (!match) continue
    const pid = Number(match[1])
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid || processAlive(pid)) continue
    const directory = path.join(tmp, entry)
    try {
      const stat = fs.lstatSync(directory)
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue
      if (process.getuid && stat.uid !== process.getuid()) continue
      fs.rmSync(directory, { recursive: true, force: true })
      removed.push(directory)
    } catch {
      // Raced with another relay's prune, or not removable; leave it.
    }
  }
  return removed
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
  // Playwright reopens file paths itself. Only allow private, owned directories so
  // another OS user cannot replace a component between this check and its open.
  const root = roots.filter((root) => isInside(resolved, root)).sort((a, b) => b.length - a.length)[0]!
  const rootStat = fs.statSync(root)
  if (process.getuid && (rootStat.mode & 0o022) !== 0 && (rootStat.mode & 0o1000) === 0) {
    throw new ExecuteFileAccessError(`${operation}: shared writable roots must have the sticky bit set`)
  }
  let spelling = path.resolve(target)
  for (;;) {
    try {
      const stat = fs.lstatSync(spelling)
      if (stat.isSymbolicLink()) {
        const real = fs.realpathSync(spelling)
        // macOS's root-owned /tmp and /var aliases are not attacker-controlled.
        if (stat.uid !== 0 || !roots.some((root) => isInside(root, real))) {
          throw new ExecuteFileAccessError(`${operation}: symlink paths are not available in execute code`)
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    const parent = path.dirname(spelling)
    if (parent === spelling) break
    spelling = parent
  }
  let current = resolved
  while (isInside(current, root)) {
    let stat: fs.Stats | undefined
    try { stat = fs.lstatSync(current) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    if (stat?.isSymbolicLink()) throw new ExecuteFileAccessError(`${operation}: symlink paths are not available in execute code`)
    if (stat && current !== root && process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o022) !== 0)) {
      throw new ExecuteFileAccessError(`${operation}: file paths must use owned directories and files without group/world write access`)
    }
    if (stat && !stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1)) {
      throw new ExecuteFileAccessError(`${operation}: expected a regular file with no hard links`)
    }
    if (current === root) break
    current = path.dirname(current)
  }
  const parent = path.dirname(resolved)
  if (parent === root && process.getuid) {
    const stat = fs.statSync(parent)
    if (stat.uid !== process.getuid() || (stat.mode & 0o022) !== 0) {
      throw new ExecuteFileAccessError(`${operation}: use a private subdirectory such as files.dir, not a shared temporary directory`)
    }
  }
  return resolved
}

async function openExecuteFile(target: string, write: boolean): Promise<fsPromises.FileHandle> {
  const operation = write ? "files.write" : "files.read"
  const resolved = assertExecuteFilePath(target, operation)
  if (write) await fsPromises.mkdir(path.dirname(resolved), { recursive: true, mode: 0o700 })
  assertExecuteFilePath(resolved, operation)
  // Never truncate until the open descriptor has been checked. O_NOFOLLOW closes
  // the final-component symlink race; inode comparison detects parent replacement.
  const handle = await fsPromises.open(resolved, fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK | (write ? fs.constants.O_WRONLY | fs.constants.O_CREAT : fs.constants.O_RDONLY), 0o600)
  try {
    const stat = await handle.stat()
    const current = await fsPromises.lstat(resolved)
    assertExecuteFilePath(resolved, operation)
    if (!stat.isFile() || stat.nlink !== 1 || current.isSymbolicLink() || stat.ino !== current.ino || stat.dev !== current.dev || (process.getuid && stat.uid !== process.getuid())) {
      throw new ExecuteFileAccessError(`${operation}: file changed while opening it`)
    }
    // Linux exposes the actual descriptor destination, independent of path races.
    if (process.platform === "linux") assertExecuteFilePath(await fsPromises.realpath(`/proc/self/fd/${handle.fd}`), operation)
    return handle
  } catch (error) {
    await handle.close()
    throw error
  }
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
      return assertExecuteFilePath(resolved, "files.path")
    },
    write: async (target, data) => {
      const resolved = resolveTarget(target)
      const bytes = typeof data === "string" ? data : data instanceof ArrayBuffer ? Buffer.from(data) : Buffer.from(data.buffer, data.byteOffset, data.byteLength)
      const handle = await openExecuteFile(resolved, true)
      try {
        await handle.truncate(0)
        await handle.writeFile(bytes)
      } finally {
        await handle.close()
      }
      return resolved
    },
    read: async (target, encoding) => {
      const resolved = resolveTarget(target)
      const handle = await openExecuteFile(resolved, false)
      try {
        return encoding ? await handle.readFile(encoding) : await handle.readFile()
      } finally {
        await handle.close()
      }
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
const forbiddenOptionKeys = new Set(["executablePath", "recordHar", "recordVideo"])

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
      Reflect.set(value, key, assertExecuteFilePath(item, `${method}({ ${key} })`))
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
  if (receiver !== null && typeof receiver === "object") {
    const constructor = Reflect.getOwnPropertyDescriptor(receiver, "constructor")?.value
    if (typeof constructor === "function" && constructor.prototype === receiver) {
      throw new Error("Calling host methods on a shared prototype is not available in execute code")
    }
  }
  if (name === "fetch" || name === "routeFromHAR" || (name === "fulfill" && args.some((arg) => arg !== null && typeof arg === "object" && "response" in arg))) {
    throw new Error(`${name}: Node-side requests and response/HAR replay are not available in execute code; use browser requests or route.fulfill({ body })`)
  }
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
  [util.inspect, "host object inspection"],
  [util.format, "host object formatting"],
  [util.formatWithOptions, "host object formatting"],
  [crypto.setEngine, "loading native crypto engines"],
  [events.setMaxListeners, "changing shared event-emitter defaults or prototypes"],
  // Native work the CPU budget cannot interrupt until it returns; the async versions run off the event loop.
  ...[crypto.pbkdf2Sync, crypto.scryptSync, crypto.hkdfSync, crypto.generateKeyPairSync, crypto.generateKeySync, crypto.generatePrimeSync, crypto.checkPrimeSync]
    .map((fn) => [fn, `crypto.${fn.name} (blocks the relay; use the async version)`] as const),
])

// Playwright classes that launch local processes or make Node-side HTTP requests.
const deniedHostClasses = new Map<string, string>([
  ["APIRequest", "Playwright's Node-side HTTP client is not available in execute code"],
  ["APIResponse", "Playwright's Node-side HTTP responses are not available in execute code"],
  ["APIRequestContext", "Playwright's Node-side HTTP client (page.request / context.request) is not available in execute code; use page.evaluate(() => fetch(...)) for requests with the page's cookies"],
  ["Tracing", "Playwright tracing performs Node-side file I/O and is not available in execute code"],
  ["Download", "Playwright download file access is not available in execute code; use browser fetch and files.write()"],
  ["Video", "Playwright video file access is not available in execute code"],
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

// Promise rejections originating in execute must not become relay process faults.
// Creation is tracked without inspecting attacker-controlled promise prototypes.
let activeRealm: ExecuteRealm | undefined
const promiseRealms = new WeakMap<Promise<unknown>, ExecuteRealm>()
// The hook is installed only while execute JavaScript runs: promise hooks slow every await in the
// process. The relay runs under Node; Bun runs the outer tests and has no promiseHooks.
let stopPromiseHook: (() => void) | undefined

function trackPromisesOf(realm: ExecuteRealm): () => void {
  const previous = activeRealm
  activeRealm = realm
  if (!stopPromiseHook && !process.versions.bun) {
    stopPromiseHook = v8.promiseHooks.createHook({ init(promise: Promise<unknown>) {
      if (activeRealm) promiseRealms.set(promise, activeRealm)
    } }) as () => void
  }
  return () => {
    activeRealm = previous
    if (!activeRealm && stopPromiseHook) {
      stopPromiseHook()
      stopPromiseHook = undefined
    }
  }
}

export function handleExecuteRealmRejection(promise: Promise<unknown>): boolean {
  const realm = promiseRealms.get(promise)
  if (!realm) return false
  realm.dispose(new Error("Unhandled execute rejection; JavaScript state will reset before the next execute"))
  return true
}

// Errors execute callbacks throw into host code. A host caller that does not catch them
// (a timer or event emitter outside the realm's own wrappers) would otherwise crash the relay.
const thrownByRealm = new WeakMap<object, ExecuteRealm>()

export function handleExecuteRealmException(error: unknown): boolean {
  const realm = isObjectLike(error) ? thrownByRealm.get(error) : undefined
  if (!realm) return false
  realm.dispose(new Error("Uncaught exception in an execute callback; JavaScript state will reset before the next execute"))
  return true
}

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
  private readonly sandboxAwait: Function
  private readonly sandboxIntrinsics: Record<string, unknown>
  private readonly hostToSandboxIntrinsic = new Map<unknown, unknown>()
  private readonly sandboxProxyByHost = new WeakMap<object, object>()
  private readonly hostBySandboxProxy = new WeakMap<object, object>()
  private readonly hostProxyBySandbox = new WeakMap<object, object>()
  private readonly sandboxByHostProxy = new WeakMap<object, object>()
  private readonly guardedHostFunctions = new WeakMap<Function, Function>()
  private readonly forceProxy = new WeakSet<object>()
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>()
  private nextTimer = 0
  private entryDepth = 0
  private readonly sliceMs = executeSliceMs()
  // Sliding window of VM time: the realm's slices may use at most half of the last three slice
  // lengths of wall time (3 s of 6 s by default), so a busy setInterval stops within a few
  // seconds while one full slice, or a few heavy operations back to back, still pass.
  private readonly busyWindowMs = this.sliceMs * 3
  private readonly busySlices: Array<{ readonly start: number; readonly end: number }> = []
  private stopped: Error | undefined
  private readonly pendingRuns = new Set<(error: Error) => void>()
  private readonly entryKey = `__execute_${crypto.randomUUID().replaceAll("-", "")}`
  private readonly entryScript: vm.Script
  private readonly global: Record<string, unknown>

  constructor() {
    const importModuleDynamically = () => {
      throw new this.SandboxError("import() is not available in execute code")
    }
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
    const host = hostIntrinsics()
    for (const name of Object.keys(host)) {
      const hostValue = host[name]
      const sandboxValue = sandboxIntrinsics[name]
      if (!isObjectLike(hostValue) || !isObjectLike(sandboxValue)) continue
      this.hostToSandboxIntrinsic.set(hostValue, sandboxValue)
      const hostPrototype = (hostValue as { prototype?: unknown }).prototype
      const sandboxPrototype = (sandboxValue as { prototype?: unknown }).prototype
      if (typeof hostValue === "function" && isObjectLike(hostPrototype) && isObjectLike(sandboxPrototype)) {
        this.hostToSandboxIntrinsic.set(hostPrototype, sandboxPrototype)
      }
      // Intrinsic invocation must retain the sandbox proxy as its target. In particular,
      // a host Function.prototype.call/apply/bind would otherwise unwrap the function
      // and invoke it without the membrane's apply trap (and checkHostCall).
      // Brand-checking intrinsics (e.g. TypedArray.prototype.every on Buffer)
      // need their host receiver; callback arguments still get guarded below.
      for (const [from, to] of ["Object", "Function", "Reflect"].includes(name) ? [[hostValue, sandboxValue], [hostPrototype, sandboxPrototype]] : []) {
        if (!isObjectLike(from) || !isObjectLike(to)) continue
        for (const key of Reflect.ownKeys(from)) {
          const source = Reflect.getOwnPropertyDescriptor(from, key)?.value
          const destination = Reflect.getOwnPropertyDescriptor(to, key)?.value
          if (typeof source === "function" && typeof destination === "function") {
            this.hostToSandboxIntrinsic.set(source, destination)
          }
        }
      }
    }
    const sandboxObject = sandboxIntrinsics.Object as ObjectConstructor
    this.sandboxObjectPrototype = sandboxObject.prototype
    this.sandboxFunctionPrototype = (sandboxIntrinsics.Function as FunctionConstructor).prototype
    this.sandboxArrayPrototype = (sandboxIntrinsics.Array as ArrayConstructor).prototype
    this.SandboxPromise = sandboxIntrinsics.Promise as PromiseConstructor
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
    this.installGlobals()
    for (const module of Object.values(sandboxModules)) this.forceProxy.add(module)
  }

  private installGlobals(): void {
    const global = this.global
    const schedule = (repeat: boolean, callback: (...args: unknown[]) => unknown, delay = 0, ...args: unknown[]) => {
      // A string callback would be code generation; refuse it rather than failing later.
      if (typeof callback !== "function") throw new TypeError("The timer callback must be a function")
      const id = ++this.nextTimer
      if (this.stopped) return id
      const fire = () => {
        if (!repeat) this.timers.delete(id)
        if (this.stopped) return
        try { callback(...args) } catch {
          this.dispose(new Error("Execute timer callback failed; JavaScript state will reset before the next execute"))
        }
      }
      this.timers.set(id, (repeat ? setInterval : setTimeout)(fire, delay))
      return id
    }
    const clear = (id: number) => {
      const timer = this.timers.get(id)
      if (timer) clearTimeout(timer)
      this.timers.delete(id)
    }
    const hostGlobals: Record<string, unknown> = {
      setTimeout: (callback: (...args: unknown[]) => unknown, delay?: number, ...args: unknown[]) => schedule(false, callback, delay, ...args),
      setInterval: (callback: (...args: unknown[]) => unknown, delay?: number, ...args: unknown[]) => schedule(true, callback, delay, ...args),
      setImmediate: (callback: (...args: unknown[]) => unknown, ...args: unknown[]) => schedule(false, callback, 0, ...args),
      clearTimeout: clear, clearInterval: clear, clearImmediate: clear,
      atob, btoa, URL, URLSearchParams, TextEncoder, TextDecoder, Buffer, AbortController,
      AbortSignal, Blob, Event, EventTarget, performance, crypto: globalThis.crypto,
    }
    for (const [name, value] of Object.entries(hostGlobals)) {
      if (value === undefined) continue
      Reflect.defineProperty(global, name, { value: this.toSandbox(value), writable: true, configurable: true, enumerable: false })
    }
    new vm.Script("{ const then = Promise.prototype.then; const ready = Promise.resolve(); globalThis.queueMicrotask = callback => Reflect.apply(then, ready, [callback]); }").runInContext(this.context)
  }

  /** Pending realm timers, for tests and diagnostics. */
  get pendingTimers(): number {
    return this.timers.size
  }

  /** Revoke callbacks and timers when execution is stopped or its CPU budget is exhausted. */
  dispose(error = new Error("Execute stopped")): void {
    if (this.stopped) return
    this.stopped = error
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    for (const reject of this.pendingRuns) reject(error)
    this.pendingRuns.clear()
  }

  get isStopped(): boolean {
    return this.stopped !== undefined
  }

  private enter<T>(entry: () => T): T {
    if (this.stopped) throw this.stopped
    if (this.entryDepth > 0) return entry()
    if (!Reflect.defineProperty(this.global, this.entryKey, { value: entry, configurable: true })) {
      this.dispose(new Error("Execute made its global non-extensible; JavaScript state will reset before the next execute"))
      throw this.stopped
    }
    const untrack = trackPromisesOf(this)
    this.entryDepth += 1
    const startedAt = performance.now()
    try {
      return this.entryScript.runInContext(this.context, { timeout: this.sliceMs }) as T
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ERR_SCRIPT_EXECUTION_TIMEOUT") {
        this.dispose(new Error(
          `Execute exceeded its synchronous CPU budget: JavaScript ran for over ${this.sliceMs}ms without yielding, which stalls every session on the relay. ` +
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
      this.chargeBusyTime(performance.now() - startedAt)
    }
  }

  private chargeBusyTime(elapsedMs: number): void {
    const now = performance.now()
    const windowStart = now - this.busyWindowMs
    this.busySlices.push({ start: now - elapsedMs, end: now })
    while (this.busySlices.length > 0 && this.busySlices[0]!.end <= windowStart) this.busySlices.shift()
    let busyMs = 0
    for (const slice of this.busySlices) busyMs += slice.end - Math.max(slice.start, windowStart)
    if (busyMs > this.busyWindowMs / 2 && !this.stopped) {
      this.dispose(new Error(
        "Execute exceeded its sustained CPU budget: its callbacks and timers kept the relay's JavaScript busy more than half the time, which stalls every session on the relay. " +
        "Do heavy work in the page with page.evaluate(), or wait longer between timer or event callbacks. JavaScript state will reset before the next execute.",
      ))
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
    const importModuleDynamically = () => {
      throw new this.SandboxError("import() is not available in execute code")
    }
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
      const result = this.enter(() => {
        const fn = new vm.Script(options.source, { filename: options.filename, importModuleDynamically } as vm.ScriptOptions).runInContext(this.context)
        const args = options.args.map((value, index) => options.sandboxArgs?.has(index) ? options.sandboxArgs.get(index) : this.toSandbox(value))
        return this.toHost(Reflect.apply(fn as Function, undefined, args))
      })
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

  private sandboxError(message: string): Error {
    return new this.SandboxError(message)
  }

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
        (value) => {
          if (this.stopped) return
          try {
            this.enter(() => resolve(this.toSandbox(value)))
          } catch (error) {
            if (!this.stopped) this.enter(() => reject(this.toSandboxThrown(error)))
          }
          this.drainMicrotasks()
        },
        (error: unknown) => {
          if (this.stopped) return
          try { this.enter(() => reject(this.toSandboxThrown(error))) } catch (failure) {
            this.dispose(failure instanceof Error ? failure : new Error("Execute promise callback failed"))
          }
          this.drainMicrotasks()
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
    if (host) {
      if (typeof host !== "function") return host
      let guarded = this.guardedHostFunctions.get(host)
      if (!guarded) {
        // Functions passed to host helpers (promisify/callbackify, streams, event
        // listeners, etc.) must keep their policy even when the helper calls them
        // later. Merely checking Function.prototype.call is not sufficient.
        guarded = new Proxy(host, {
          apply(target, receiver, args) {
            checkHostCall(target, receiver, args)
            return Reflect.apply(target, receiver, args)
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
    if (!thrownByRealm.has(value)) thrownByRealm.set(value, this)
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
