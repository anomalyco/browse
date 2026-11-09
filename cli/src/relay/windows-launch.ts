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
    }
  }
}

const createNewProcessGroup = 0x00000200
const createUnicodeEnvironment = 0x00000400
const createNoWindow = 0x08000000

const startupInfoSize = 104
const processInformationSize = 24

/**
 * Starts `launch` with kernel32 CreateProcessW, without inheriting this process's handles and without a console window.
 * Returns false when this isn't Bun, bun:ffi is unavailable, or CreateProcessW fails; the caller then uses the
 * PowerShell Start-Process fallback.
 */
export function launchWindowsRelay(launch: WindowsRelayLaunch, env: NodeJS.ProcessEnv): boolean {
  if (!process.versions.bun) return false
  let started = false
  try {
    // Bun resolves this built-in synchronously in source, compiled binaries and bundling; the bundler rewrites it to
    // a createRequire call for the Node package, and the process.versions.bun guard keeps Node from ever running it.
    const ffi = require("bun:ffi") as FfiModule
    const kernel32 = ffi.dlopen("kernel32.dll", {
      CreateProcessW: {
        args: [ffi.FFIType.ptr, ffi.FFIType.ptr, ffi.FFIType.ptr, ffi.FFIType.ptr, ffi.FFIType.i32, ffi.FFIType.u32,
          ffi.FFIType.ptr, ffi.FFIType.ptr, ffi.FFIType.ptr, ffi.FFIType.ptr],
        returns: ffi.FFIType.i32,
      },
      CloseHandle: { args: [ffi.FFIType.ptr], returns: ffi.FFIType.i32 },
    })

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
      wideZ(launch.executable),
      wideZ(windowsCommandLine(launch.executable, launch.args)),
      null,
      null,
      0,
      createNoWindow | createNewProcessGroup | createUnicodeEnvironment,
      Buffer.from(windowsEnvironmentBlock(env), "utf16le"),
      null,
      startupInfo,
      processInformation,
    )
    if (!created) return false
    // From here the relay is running; a failure to close these handles must not start a second one.
    started = true
    const info = new DataView(processInformation.buffer)
    kernel32.symbols.CloseHandle(info.getBigUint64(0, true))
    kernel32.symbols.CloseHandle(info.getBigUint64(8, true))
    return true
  } catch {
    return started
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
 * A Windows environment block: `NAME=value` entries sorted case-insensitively by name (the order the system expects),
 * each followed by NUL and the whole block by another NUL. Undefined values are omitted.
 */
export function windowsEnvironmentBlock(env: NodeJS.ProcessEnv): string {
  const entries = Object.entries(env)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .sort(([left], [right]) => {
      const a = left.toUpperCase()
      const b = right.toUpperCase()
      return a < b ? -1 : a > b ? 1 : 0
    })
  return `${entries.map(([name, value]) => `${name}=${value}\0`).join("")}\0`
}

function wideZ(value: string): Buffer {
  return Buffer.from(`${value}\0`, "utf16le")
}
