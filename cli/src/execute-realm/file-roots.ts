import buffer from "node:buffer"
import crypto from "node:crypto"
import events from "node:events"
import fs from "node:fs"
import fsPromises from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import stream from "node:stream"
import url from "node:url"
import util from "node:util"
import zlib from "node:zlib"
import { cacheRoot, configRoot, dataRoot, installedBinaryPath, stateRoot } from "../paths.ts"

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

/** Browse's own folders, whose contents execute code may not read or write even when they sit inside a file root. */
function browseDirectories(): readonly string[] {
  return [configRoot(), dataRoot(), stateRoot(), cacheRoot()]
}

/**
 * A name the installers and the updater stage beside the installed binary: `browse.new` (install, install.ps1),
 * `browse.<pid>.new` (binary.ts) or `browse.old-<suffix>` (binary.ts and install.ps1 backups).
 */
function isInstallSibling(target: string, binary: string): boolean {
  if (path.dirname(target) !== path.dirname(binary)) return false
  const name = path.basename(binary)
  const sibling = path.basename(target)
  if (!sibling.startsWith(`${name}.`)) return false
  const staged = sibling.slice(name.length + 1)
  return staged === "new" || staged.startsWith("old-") || /^\d+\.new$/.test(staged)
}

/** True for browse's folders, its installed binary and the files installs stage beside it. */
function isBrowseOwned(target: string): boolean {
  if (browseDirectories().some((root) => isInside(target, realTarget(root)))) return true
  const installed = installedBinaryPath()
  const binary = realTarget(installed)
  // Staging happens in the installed binary's folder even when the binary itself is a symlink elsewhere.
  return isInside(target, binary) || isInstallSibling(target, binary) || isInstallSibling(target, path.resolve(installed))
}

/** Throw unless `target` is an absolute path inside the execute file roots and outside browse's own files. */
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
  if (isBrowseOwned(resolved)) {
    throw new ExecuteFileAccessError(`${operation}: ${target} is inside browse's own files, which execute code cannot access`)
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

export function returnsPromise(fn: Function): boolean {
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

/**
 * Playwright APIs that Patchright implements in a way pages can see: init scripts and exposed bindings are injected
 * by intercepting the main document (the page then reads an empty nextHopProtocol, and the injected wrappers show up
 * in Function.prototype.toString), and fulfilling a navigation request replaces the real response the same way.
 * Detectors such as rebrowser's bot-detector check exactly these (documentInterception, exposeFunctionLeak).
 * Returns a warning for the execute result, or undefined. Warnings only: nothing is refused.
 */
export function pageVisibleApiWarningForName(name: string): string | undefined {
  if (name === "addInitScript" || name === "exposeFunction" || name === "exposeBinding") {
    return `${name}() is visible to pages: Patchright injects it by intercepting the main document, which leaves an empty performance nextHopProtocol and readable wrapper functions that bot detectors check. It still works; prefer page.evaluate() after navigation when stealth matters.`
  }
  return undefined
}

export function pageVisibleApiWarning(fn: Function, receiver: unknown, _args: readonly unknown[]): string | undefined {
  const name = typeof fn.name === "string" ? fn.name.replace(/^bound /, "") : ""
  const directWarning = pageVisibleApiWarningForName(name)
  if (directWarning) return directWarning
  if (name === "fulfill" && receiver !== null && typeof receiver === "object") {
    let navigation = false
    try {
      const request = (receiver as { request?: () => { isNavigationRequest?: () => boolean } }).request?.()
      navigation = request?.isNavigationRequest?.() === true
    } catch {
      navigation = false
    }
    if (navigation) {
      return "route.fulfill() on a navigation request is visible to pages: the document no longer comes from the network (empty nextHopProtocol, no real response timing), which bot detectors check. It still works; fulfill subresources only when stealth matters."
    }
  }
  return undefined
}
