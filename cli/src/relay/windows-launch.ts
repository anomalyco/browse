import { existsSync } from "node:fs"
import path from "node:path"
import process from "node:process"

// The managed relay on Windows, started with kernel32 CreateProcessW. Bun's spawn (and Node's) asks CreateProcessW to
// inherit handles, so a detached relay keeps copies of the caller's pipes and whoever reads them waits for EOF. The
// ShellExecute path (PowerShell Start-Process) avoids that but gives the console relay a new console through Windows
// Terminal's default-terminal handoff, which flashes a window for a second or two. Here it inherits nothing, and
// CREATE_NO_WINDOW gives it a windowless console that its own console children inherit; DETACHED_PROCESS would leave
// it without one, so they would open visible consoles of their own.

export type WindowsRelayLaunch = {
  readonly executable: string
  readonly args: readonly string[]
}

// The parts of bun:ffi this uses. It is loaded with require() under Bun only, so Node and its bundle never see it.
type FfiModule = {
  readonly FFIType: {
    readonly ptr: number
    readonly i32: number
    readonly u32: number
  }
  readonly dlopen: (
    library: string,
    symbols: {
      readonly CreateProcessW: { readonly args: readonly number[]; readonly returns: number }
      readonly CloseHandle: { readonly args: readonly number[]; readonly returns: number }
      readonly GetLastError: { readonly args: readonly number[]; readonly returns: number }
    },
  ) => {
    readonly symbols: {
      readonly CreateProcessW: (
        applicationName: Uint8Array,
        commandLine: Uint8Array,
        processAttributes: null,
        threadAttributes: null,
        inheritHandles: number,
        creationFlags: number,
        environment: Uint8Array,
        currentDirectory: null,
        startupInfo: Uint8Array,
        processInformation: Uint8Array,
      ) => number
      readonly CloseHandle: (handle: bigint) => number
      readonly GetLastError: () => number
    }
  }
}

type Kernel32 = ReturnType<FfiModule["dlopen"]>

const createNewProcessGroup = 0x00000200
const createUnicodeEnvironment = 0x00000400
const createNoWindow = 0x08000000

const startupInfoSize = 104
const processInformationSize = 24

const windowsAbsolutePath = /^(?:[A-Za-z]:[\\/]|\\\\)/

// Opened once, on the first launch that reaches the FFI path.
let kernel32: Kernel32 | undefined

function kernel32Library(): Kernel32 {
  if (kernel32) return kernel32
  const ffi = require("bun:ffi") as FfiModule
  kernel32 = ffi.dlopen("kernel32.dll", {
    CreateProcessW: {
      args: [ffi.FFIType.ptr, ffi.FFIType.ptr, ffi.FFIType.ptr, ffi.FFIType.ptr, ffi.FFIType.i32, ffi.FFIType.u32,
        ffi.FFIType.ptr, ffi.FFIType.ptr, ffi.FFIType.ptr, ffi.FFIType.ptr],
      returns: ffi.FFIType.i32,
    },
    CloseHandle: { args: [ffi.FFIType.ptr], returns: ffi.FFIType.i32 },
    GetLastError: { args: [], returns: ffi.FFIType.u32 },
  })
  return kernel32
}

/**
 * Resolves the executable CreateProcessW will start. A fully qualified path is used as is; a bare name is looked up
 * only in the absolute directories of `env`'s PATH, trying .exe and .com when it has no extension. CreateProcessW
 * resolves a non-NULL lpApplicationName against the current directory and does not search PATH, so a bare name from
 * opencode-browser-client.ts must arrive here as a full path. `exists` is injectable for tests.
 */
export function resolveWindowsExecutable(
  executable: string,
  env: NodeJS.ProcessEnv,
  exists: (candidate: string) => boolean,
): string | undefined {
  if (!executable || executable.includes("\0")) return undefined
  if (windowsAbsolutePath.test(executable)) return executable
  // A relative path with a separator, or a drive-relative path like C:name, is neither fully qualified nor a bare
  // name; resolving it against the cwd is exactly what CreateProcessW would do wrong here.
  if (/[\\/:]/.test(executable)) return undefined
  const searchPath = windowsPathVariable(env)
  if (!searchPath) return undefined
  const names = path.win32.extname(executable) ? [executable] : [`${executable}.exe`, `${executable}.com`]
  for (const entry of searchPath.split(path.win32.delimiter)) {
    const trimmed = entry.trim()
    const directory = trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1) : trimmed
    if (!windowsAbsolutePath.test(directory)) continue
    for (const name of names) {
      const candidate = path.win32.join(directory, name)
      if (exists(candidate)) return candidate
    }
  }
  return undefined
}

/** The last PATH value in `env`, matched case-insensitively as Windows does. */
function windowsPathVariable(env: NodeJS.ProcessEnv): string | undefined {
  let value: string | undefined
  for (const [name, candidate] of Object.entries(env)) {
    if (name.toUpperCase() === "PATH" && candidate !== undefined) value = candidate
  }
  return value
}

/**
 * The reason this launch can't go to CreateProcessW, or undefined when it can. NUL truncates a UTF-16 string, so a
 * value containing one would silently launch something else. Environment names with NUL, "=" or an empty name are
 * skipped by windowsEnvironmentBlock instead; an environment value with NUL rejects the launch.
 */
export function windowsLaunchProblem(launch: WindowsRelayLaunch, env: NodeJS.ProcessEnv): string | undefined {
  if (!launch.executable) return "the executable is empty"
  if (launch.executable.includes("\0") || launch.args.some((argument) => argument.includes("\0")))
    return "the executable or an argument contains NUL"
  if (Object.values(env).some((value) => value?.includes("\0"))) return "an environment value contains NUL"
  return undefined
}

/**
 * Starts `launch` with kernel32 CreateProcessW, without inheriting this process's handles and without a console window.
 * Returns false when this isn't Bun, bun:ffi is unavailable, the executable can't be resolved, or CreateProcessW fails;
 * the caller then uses the PowerShell Start-Process fallback and may log `onFallback`'s reason.
 */
export function launchWindowsRelay(
  launch: WindowsRelayLaunch,
  env: NodeJS.ProcessEnv,
  onFallback?: (reason: string) => void,
): boolean {
  const fallback = (reason: string) => {
    onFallback?.(reason)
    return false
  }
  const problem = windowsLaunchProblem(launch, env)
  if (problem) return fallback(problem)
  if (!process.versions.bun) return fallback("this process is not running under Bun")
  const executable = resolveWindowsExecutable(launch.executable, env, existsSync)
  if (!executable) return fallback(`could not resolve ${JSON.stringify(launch.executable)} through PATH`)
  let started = false
  try {
    // Bun resolves this built-in synchronously in source, compiled binaries and bundling; the bundler rewrites it to
    // a createRequire call for the Node package, and the process.versions.bun guard keeps Node from ever running it.
    const kernel32 = kernel32Library()

    // STARTUPINFOW on x64: cb 0, lpReserved 8, lpDesktop 16, lpTitle 24, dwX..dwFillAttribute (seven DWORDs) 32-56,
    // dwFlags 60, wShowWindow 64, cbReserved2 66, lpReserved2 72, hStdInput/hStdOutput/hStdError 80/88/96; 104 bytes.
    const startupInfo = new Uint8Array(startupInfoSize)
    const startup = new DataView(startupInfo.buffer)
    startup.setUint32(0, startupInfoSize, true)
    startup.setUint32(60, 0x1, true) // STARTF_USESHOWWINDOW
    startup.setUint16(64, 0, true) // SW_HIDE
    // PROCESS_INFORMATION: hProcess 0, hThread 8, dwProcessId 16, dwThreadId 20; 24 bytes.
    const processInformation = new Uint8Array(processInformationSize)

    const created = kernel32.symbols.CreateProcessW(
      wideZ(executable),
      wideZ(windowsCommandLine(executable, launch.args)),
      null,
      null,
      0,
      createNoWindow | createNewProcessGroup | createUnicodeEnvironment,
      Buffer.from(windowsEnvironmentBlock(env), "utf16le"),
      null,
      startupInfo,
      processInformation,
    )
    if (!created) {
      // Bun FFI may clobber the thread's last error, so this is the best available code rather than a guarantee.
      let code: number | undefined
      try {
        code = kernel32.symbols.GetLastError()
      } catch {
        // Reporting the failure matters more than the code.
      }
      return fallback(`CreateProcessW failed${code === undefined ? "" : ` (GetLastError() = ${code})`}`)
    }
    // From here the relay is running; a failure to close these handles must not start a second one.
    started = true
    const info = new DataView(processInformation.buffer)
    kernel32.symbols.CloseHandle(info.getBigUint64(0, true))
    kernel32.symbols.CloseHandle(info.getBigUint64(8, true))
    return true
  } catch (error) {
    if (started) return true
    return fallback(error instanceof Error ? error.message : String(error))
  }
}

/** One Windows argv element, quoted so CommandLineToArgvW splits the command line back into the same arguments. */
export function quoteWindowsArgument(argument: string): string {
  return `"${argument.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`
}

/** The CreateProcessW command line for an executable and its arguments. */
export function windowsCommandLine(executable: string, args: readonly string[]): string {
  return [executable, ...args].map(quoteWindowsArgument).join(" ")
}

/**
 * A Windows environment block: `NAME=value` entries sorted case-insensitively by name (the order the system expects)
 * and deduplicated case-insensitively with the last value winning, each followed by NUL and the block by another NUL.
 * Undefined values and names that are empty or contain "=" or NUL are skipped. A value containing NUL is rejected by
 * launchWindowsRelay before this runs rather than silently truncating an entry.
 */
export function windowsEnvironmentBlock(env: NodeJS.ProcessEnv): string {
  const entries = new Map<string, readonly [string, string]>()
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || name === "" || name.includes("=") || name.includes("\0")) continue
    entries.set(name.toUpperCase(), [name, value])
  }
  const sorted = [...entries.values()].sort(([left], [right]) => {
    const a = left.toUpperCase()
    const b = right.toUpperCase()
    return a < b ? -1 : a > b ? 1 : 0
  })
  return sorted.length === 0 ? "\0\0" : `${sorted.map(([name, value]) => `${name}=${value}\0`).join("")}\0`
}

function wideZ(value: string): Buffer {
  return Buffer.from(`${value}\0`, "utf16le")
}
