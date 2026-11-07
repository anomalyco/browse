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
import { cacheRoot, configRoot, dataRoot, defaultRoots, installedBinaryPath, installerBinaryPath, stateRoot } from "../paths.ts"
import { legacyRoots } from "../setup/legacy.ts"

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

/** Windows paths use win32 rules; everywhere else, macOS included, POSIX rules. */
const pathFlavor = (platform: NodeJS.Platform) => platform === "win32" ? path.win32 : path.posix

/** Windows and macOS compare paths case-insensitively; Linux keeps them case-sensitive. */
const foldCase = (value: string, platform: NodeJS.Platform): string =>
  platform === "win32" || platform === "darwin" ? value.toLowerCase() : value

/** Whether `child` is `parent` or inside it, following the platform's case rules. */
export function isInside(child: string, parent: string, platform: NodeJS.Platform = process.platform): boolean {
  const paths = pathFlavor(platform)
  const relative = paths.relative(foldCase(parent, platform), foldCase(child, platform))
  // A child literally named `..bypass` is inside; only `..` and `..<sep>` climb out.
  return relative === "" || (!paths.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${paths.sep}`))
}

/** Whether two paths name the same place under the platform's case rules. */
function isSamePath(a: string, b: string): boolean {
  return isInside(a, b) && isInside(b, a)
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

/**
 * Browse's own folders, whose contents execute code may not read or write even when they sit inside a file root.
 * The default roots cover an everyday install while OPENCODE_BROWSER_HOME points this relay elsewhere, and the legacy
 * roots count too: migration copies them into the live roots on the next run.
 */
function browseDirectories(): readonly string[] {
  return [...new Set([
    configRoot(), dataRoot(), stateRoot(), cacheRoot(),
    ...Object.values(defaultRoots()),
    ...legacyRoots(),
  ])]
}

/**
 * Whether `target` is a staging name beside `binary`, or inside one: `browse.new` (install, install.ps1),
 * `browse.<pid>.new` (binary.ts), `browse.old-<suffix>` (binary.ts and install.ps1 backups) or `browse.migrate-<pid>`
 * (migrate.ts). Such a name must not be created as a directory, and nothing below it may be written either.
 */
export function isInstallSibling(target: string, binary: string, platform: NodeJS.Platform = process.platform): boolean {
  const paths = pathFlavor(platform)
  const folder = foldCase(paths.dirname(binary), platform)
  const relative = paths.relative(folder, foldCase(target, platform))
  if (relative === "" || paths.isAbsolute(relative)) return false
  const [first] = relative.split(paths.sep)
  const name = foldCase(paths.basename(binary), platform)
  if (!first?.startsWith(`${name}.`)) return false
  const staged = first.slice(name.length + 1)
  return staged === "new" || staged.startsWith("old-") || staged.startsWith("migrate-") || /^\d+\.new$/.test(staged)
}

/** Whether `target` is a binary, or a staging file installs and migration place in its folder. */
function isBinaryOrStaging(target: string, binary: string, platform: NodeJS.Platform): boolean {
  const resolved = realTarget(binary)
  // Staging happens in the binary's folder even when the binary, or a folder leading to it, is a symlink.
  const stagedAt = path.join(realTarget(path.dirname(binary)), path.basename(binary))
  return isInside(target, resolved, platform) || isInside(target, stagedAt, platform) ||
    isInstallSibling(target, resolved, platform) || isInstallSibling(target, stagedAt, platform)
}

/** True for browse's folders, its binaries and the files installs stage beside them. */
function isBrowseOwned(target: string, platform: NodeJS.Platform = process.platform): boolean {
  if (browseDirectories().some((root) => isInside(target, realTarget(root), platform))) return true
  // The installer and updater write the installer binary even when OPENCODE_BROWSER_HOME points the CLI elsewhere.
  return [installedBinaryPath(), installerBinaryPath()].some((binary) => isBinaryOrStaging(target, binary, platform))
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

/** A file or download folder a permitted host call will write, before its folder is prepared and its prior state recorded. */
export type ExecuteFileOutputCandidate = {
  readonly path: string
  /** A folder the call writes into, such as a CDP download path, rather than a single file. */
  readonly directory?: boolean
}

/** startTracing's path, recorded when preparing because Playwright stores it before awaiting. */
type ExecuteTraceStart = {
  readonly receiver: object
  /** Undefined when the call had no string path, which clears a previous one. */
  readonly path: string | undefined
}

/** What checkHostCall found: the files a call will write and any tracing memory it changes. */
export type ExecuteHostCall = {
  readonly outputs: readonly ExecuteFileOutputCandidate[]
  readonly trace?: ExecuteTraceStart
  /** stopTracing: the receiver whose remembered path is an output and is forgotten when the call resolves. */
  readonly traceStop?: object
}

/** A file an allowed host call wrote, and whether it already existed before the call. */
export type ExecuteFileOutput = {
  readonly path: string
  /** False when this call created the file; only those are reset to 0600, so a user's own file keeps its mode. */
  readonly existed: boolean
}

/** The files checkHostCall found after preparation, plus trace memory to drop when the call resolves. */
export type PreparedExecuteFileOutputs = {
  readonly outputs: readonly ExecuteFileOutput[]
  /** stopTracing only: forget the remembered path once the stop call resolves. */
  readonly forgetTrace?: () => void
}

/** Traces started by browser.startTracing(...), keyed by the browser whose stopTracing writes them. */
const startedTraces = new WeakMap<object, string>()

const isObject = (value: unknown): value is object => value !== null && typeof value === "object"

function fileExists(target: string): boolean {
  try {
    fs.lstatSync(target)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
}

function outputDirectoryError(directory: string): ExecuteFileAccessError {
  return new ExecuteFileAccessError(`file outputs must use real, owned directories without group/world write access, not ${directory}`)
}

/** Pins a directory this call created to 0700 through its descriptor, never through its path. */
function pinPrivateDirectory(directory: string, uid: number): void {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
  try {
    const opened = fs.fstatSync(descriptor)
    const current = fs.lstatSync(directory)
    if (!opened.isDirectory() || opened.uid !== uid || current.isSymbolicLink() || current.dev !== opened.dev || current.ino !== opened.ino) {
      throw outputDirectoryError(directory)
    }
    if ((opened.mode & 0o777) !== 0o700) fs.fchmodSync(descriptor, 0o700)
  } finally {
    fs.closeSync(descriptor)
  }
}

/**
 * Creates the folders an output file needs as 0700, like files.write. Playwright makes them with the
 * process umask instead, so under 0002 a screenshot would create 0775 folders and 0664 files, which
 * assertExecuteFilePath then refuses on the very next files.path/read/write. A shared root such as
 * /tmp can have a symlink raced in anywhere, so this first walks from the target folder up to the
 * matching allowed root and refuses any existing component that is a symlink or, below the root,
 * owned by someone else or group/world writable. Only then does it create the missing components
 * top-down, one at a time. Callers re-run the guard afterwards.
 */
function ensureExecuteOutputDirectory(directory: string): void {
  const resolved = path.resolve(directory)
  const roots = executeFileRoots()
  const root = roots.filter((candidate) => isInside(resolved, candidate)).sort((a, b) => b.length - a.length)[0]
  if (root === undefined) throw outputDirectoryError(resolved)
  const uid = process.getuid?.()
  const missing: string[] = []
  let current = resolved
  for (;;) {
    let stat: fs.Stats | undefined
    try {
      stat = fs.lstatSync(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    if (stat) {
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw outputDirectoryError(current)
      if (!isSamePath(current, root) && uid !== undefined && (stat.uid !== uid || (stat.mode & 0o022) !== 0)) throw outputDirectoryError(current)
    } else if (isSamePath(current, root)) {
      throw outputDirectoryError(current)
    } else {
      missing.push(current)
    }
    if (isSamePath(current, root)) break
    const parent = path.dirname(current)
    if (parent === current) throw outputDirectoryError(current)
    current = parent
  }
  for (const step of missing.reverse()) {
    let created = false
    try {
      fs.mkdirSync(step, { mode: 0o700 })
      created = true
    } catch (error) {
      // A racing creator is fine only after the same checks as a folder made by this call.
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    }
    // Default ACLs can add group write despite mkdir's mode, so pin a folder this call made first.
    if (created && uid !== undefined && process.platform !== "win32") pinPrivateDirectory(step, uid)
    const stat = fs.lstatSync(step)
    if (!stat.isDirectory() || stat.isSymbolicLink() || (uid !== undefined && (stat.uid !== uid || (stat.mode & 0o022) !== 0))) {
      throw outputDirectoryError(step)
    }
  }
}

/**
 * Resets files this host call created to 0600. Opens read-only through O_NOFOLLOW and checks the
 * inode against the path like openExecuteFile, so a symlink or replacement swapped in meanwhile is
 * left alone. The folder chain is re-checked through a child that does not exist before the chmod,
 * and the file path and, on Linux, the descriptor's real target are checked after it: the guard
 * rejects the group-writable mode the umask gave the new file, so only then can the file pass.
 */
function secureExecuteFileOutputs(outputs: readonly ExecuteFileOutput[]): void {
  const uid = process.getuid?.()
  if (uid === undefined) return
  const operation = "execute file output"
  for (const output of outputs) {
    if (output.existed) continue
    try {
      const before = fs.lstatSync(output.path)
      if (!before.isFile() || before.uid !== uid || before.nlink !== 1) continue
      const descriptor = fs.openSync(output.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
      try {
        const opened = fs.fstatSync(descriptor)
        const current = fs.lstatSync(output.path)
        if (!opened.isFile() || opened.uid !== uid || opened.nlink !== 1 || current.isSymbolicLink() || current.dev !== opened.dev || current.ino !== opened.ino) continue
        assertExecuteFilePath(path.join(path.dirname(output.path), `.execute-output-${crypto.randomUUID()}`), operation)
        fs.fchmodSync(descriptor, 0o600)
        assertExecuteFilePath(output.path, operation)
        if (process.platform === "linux") assertExecuteFilePath(fs.realpathSync(`/proc/self/fd/${descriptor}`), operation)
      } finally {
        fs.closeSync(descriptor)
      }
    } catch {
      // The call may have failed before writing, removed its output itself, or a check refused it.
    }
  }
}

/**
 * Prepares what checkHostCall found: records startTracing's path as Playwright does before awaiting,
 * then creates each output file's folders (or the output folder itself for a download path) and
 * records whether its file existed before the call. Every candidate is checked before the folders are
 * touched and again afterwards. stopTracing's memory stays until the stop call resolves. Only the
 * realm's apply paths call this, after the whole check succeeded and before the host call runs, so
 * checks and construct traps stay side-effect free.
 */
export function prepareExecuteFileOutputs(call: ExecuteHostCall): PreparedExecuteFileOutputs {
  const trace = call.trace
  if (trace !== undefined) {
    // Playwright sets its path at the top of startTracing, before the first await: mirror it here.
    if (trace.path === undefined) startedTraces.delete(trace.receiver)
    else startedTraces.set(trace.receiver, trace.path)
  }
  const outputs: ExecuteFileOutput[] = []
  for (const candidate of call.outputs) {
    assertExecuteFilePath(candidate.path, "execute file output")
    ensureExecuteOutputDirectory(candidate.directory === true ? candidate.path : path.dirname(candidate.path))
    const resolved = assertExecuteFilePath(candidate.path, "execute file output")
    if (candidate.directory === true) continue
    outputs.push({ path: resolved, existed: fileExists(resolved) })
  }
  const stop = call.traceStop
  return stop === undefined ? { outputs } : { outputs, forgetTrace: () => startedTraces.delete(stop) }
}

/**
 * Makes the files a host call created owner-only once it settles, and forgets stopTracing's path only
 * when the stop resolves: Playwright keeps its path after a rejection, so the memory must too.
 */
export function completeExecuteFileOutputs(result: unknown, prepared: PreparedExecuteFileOutputs): unknown {
  const settle = (resolved: boolean) => {
    if (resolved) prepared.forgetTrace?.()
    secureExecuteFileOutputs(prepared.outputs)
  }
  if (prepared.outputs.length === 0 && prepared.forgetTrace === undefined) return result
  if (!util.types.isPromise(result)) {
    settle(true)
    return result
  }
  return (result as Promise<unknown>).then(
    (value) => {
      settle(true)
      return value
    },
    (error: unknown) => {
      settle(false)
      throw error
    },
  )
}

/**
 * Validates the file paths in a call's options and collects the ones the call will write. Only a
 * path on the top-level options object counts as an output, because only those are Playwright file
 * destinations; nothing here touches the filesystem beyond stat calls.
 */
function checkFileOptions(value: unknown, method: string, includeMethodKeys: boolean, candidates: ExecuteFileOutputCandidate[], depth = 0): void {
  if (depth > 4 || value === null || typeof value !== "object") return
  if (Array.isArray(value)) {
    for (const item of value) checkFileOptions(item, method, includeMethodKeys, candidates, depth + 1)
    return
  }
  // Option bags are plain objects; Playwright objects passed as arguments (a page, a locator) are not options.
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return
  for (const [key, item] of Object.entries(value)) {
    if (forbiddenOptionKeys.has(key)) throw new ExecuteFileAccessError(`${method}: the ${key} option is not available in execute code`)
    if (typeof item === "string" && (alwaysFileOptionKeys.has(key) || (includeMethodKeys && fileOptionKeys.has(key)))) {
      const resolved = assertExecuteFilePath(item, `${method}({ ${key} })`)
      if (depth === 0 && isFileOutputOption(method, key)) candidates.push({ path: resolved })
      Reflect.set(value, key, resolved)
    } else {
      checkFileOptions(item, method, includeMethodKeys, candidates, depth + 1)
    }
  }
}

function checkFileStrings(value: unknown, method: string): string | undefined {
  if (typeof value === "string") return assertExecuteFilePath(value, method)
  if (Array.isArray(value)) for (const item of value) if (typeof item === "string") assertExecuteFilePath(item, method)
  return undefined
}

/**
 * Raw CDP commands that name files on the browser's machine, which CDPSession.send reaches without
 * Playwright's file options. Inputs are checked like setInputFiles; a download path is an output
 * folder checked like saveAs. Commands that would carry more CDP or run local code are refused.
 */
const cdpFileInputParameters = new Map<string, (params: Record<string, unknown>) => unknown>([
  ["DOM.setFileInputFiles", (params) => params.files],
  ["Input.dispatchDragEvent", (params) => isObject(params.data) ? (params.data as Record<string, unknown>).files : undefined],
  ["PWA.launchFilesInApp", (params) => params.files],
])
const cdpDownloadPathMethods = new Set(["Browser.setDownloadBehavior", "Page.setDownloadBehavior"])
const cdpRefusedMethods = new Map<string, string>([
  ["Extensions.loadUnpacked", "loading an unpacked extension runs local code in the browser"],
  ["Target.sendMessageToTarget", "forwarding a raw CDP message would bypass these file checks"],
  ["Target.exposeDevToolsProtocol", "exposing raw CDP to page script would bypass these file checks"],
])

function checkCdpFileParameters(method: string, value: unknown, candidates: ExecuteFileOutputCandidate[]): void {
  const refusal = cdpRefusedMethods.get(method)
  if (refusal !== undefined) throw new ExecuteFileAccessError(`${method}: ${refusal}, so it is not available in execute code`)
  if (!isObject(value) || Array.isArray(value)) return
  const params = value as Record<string, unknown>
  const inputParameter = cdpFileInputParameters.get(method)
  if (inputParameter !== undefined) checkFileStrings(inputParameter(params), method)
  if (!cdpDownloadPathMethods.has(method) || typeof params.downloadPath !== "string") return
  const downloadPath = assertExecuteFilePath(params.downloadPath, `${method}({ downloadPath })`)
  if (executeFileRoots().some((root) => isSamePath(downloadPath, root))) {
    throw new ExecuteFileAccessError(`${method}: use a private subdirectory inside the execute file roots for downloads, not the root itself`)
  }
  if (params.behavior === "allow" || params.behavior === "allowAndName") candidates.push({ path: downloadPath, directory: true })
}

const promiseReturningNames = new Set([...fileOptionMethods, "setInputFiles", "setFiles", "saveAs", "bringToFront", "send"])

export function returnsPromise(fn: Function): boolean {
  return util.types.isAsyncFunction(fn) || promiseReturningNames.has(typeof fn.name === "string" ? fn.name.replace(/^bound /, "") : "")
}

/**
 * Enforce the execute file roots and refused APIs for one host call made by sandboxed code, and
 * return the files the call may write plus any tracing memory it changes. This is side-effect free:
 * it only validates arguments and reads startTracing's remembered path. The realm hands the result
 * to prepareExecuteFileOutputs after this returns and to completeExecuteFileOutputs once it settles.
 */
export function checkHostCall(fn: Function, receiver: unknown, args: readonly unknown[]): ExecuteHostCall {
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
  const candidates: ExecuteFileOutputCandidate[] = []
  if (name === "send") {
    if (typeof args[0] === "string") checkCdpFileParameters(args[0], args[1], candidates)
  } else if (name === "setInputFiles") {
    const isFrameLike = receiver !== null && typeof receiver === "object" && typeof (receiver as { goto?: unknown }).goto === "function"
    checkFileStrings(isFrameLike ? args[1] : args[0], "setInputFiles")
  } else if (name === "saveAs") {
    // download.saveAs(path) and video.saveAs(path) copy the artifact to a new file, parents included.
    const target = checkFileStrings(args[0], name)
    if (target !== undefined) candidates.push({ path: target })
  } else if (name === "setFiles" || name === "routeFromHAR") {
    checkFileStrings(args[0], name)
  }
  const includeMethodKeys = fileOptionMethods.has(name)
  for (const arg of args) checkFileOptions(arg, name || "call", includeMethodKeys, candidates)
  if (name === "startTracing" && isObject(receiver)) {
    // startTracing only records the path; stopTracing later writes it and takes no arguments.
    const path = isObject(args[1]) ? Reflect.get(args[1], "path") : undefined
    const trace = typeof path === "string" ? assertExecuteFilePath(path, "startTracing({ path })") : undefined
    return { outputs: candidates, trace: { receiver, path: trace } }
  }
  if (name === "stopTracing" && isObject(receiver)) {
    const remembered = startedTraces.get(receiver)
    if (remembered === undefined) return { outputs: candidates }
    // Playwright keeps the path until stopTracing runs, so a path that now fails the guard must
    // keep refusing every stop rather than let a later call write it unguarded.
    return { outputs: [...candidates, { path: assertExecuteFilePath(remembered, "stopTracing()") }], traceStop: receiver }
  }
  return { outputs: candidates }
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
