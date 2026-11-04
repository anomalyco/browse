// A binary install: the install script (or PowerShell installer) put the bun-compiled executable in ~/.browse/bin.
// Install records it, puts its folder on PATH, and uninstall takes both back.
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import {
  compareVersions,
  installVersion,
  pruneVersions,
  readCurrent,
  sameFile,
  switchVersion,
  updateState,
  versionEntry,
} from "../update/auto-update.ts"
import { opencodeBrowserVersion } from "../version.ts"
import { configRoot, fail, home, keepWorking, layout, log, readFileOr, tilde } from "./environment.ts"

/**
 * Records this executable as the one agents run (current.json's `binary`) and keeps a copy of it as its version in
 * runtime/versions, which rollback and the MCP supervisor use. Returns the executable itself, which stays where it is;
 * updates replace it by rename.
 */
export async function installBinaryRuntime(): Promise<{ entry: string; version: string }> {
  const binary = process.execPath
  const version = opencodeBrowserVersion
  const before = readCurrent(layout)
  const existing = versionEntry(layout, version)
  try {
    if (!sameFile(existing, binary)) await installVersion({ layout, version, runningBinary: binary })
  } catch (error) {
    fail(`Could not install browse ${version}: ${(error as Error).message}`)
  }
  const kept = await keepWorking(before, version)
  // The install script already put this executable on PATH: the version that works goes back there.
  if (kept) {
    switchVersion(layout, kept.version, kept.previous, binary)
    return { entry: binary, version: kept.version }
  }
  const previous = before?.version === version ? before.previous : before?.version
  switchVersion(layout, version, previous, binary)
  updateState(layout, ({ pending, skipped, ...state }) => ({
    ...state,
    ...(pending && compareVersions(pending, version) > 0 ? { pending } : {}),
    ...(skipped && skipped !== version ? { skipped } : {}),
  }))
  pruneVersions(layout, [version, previous])
  return { entry: binary, version }
}

/**
 * A browse binary (the curl or PowerShell installer) puts its folder on PATH, so `browse` works in a new terminal:
 * the user PATH on Windows, else the shell's startup file, as opencode's installer does. Returns where it was added;
 * nothing when PATH already has it or browse runs on Node.
 */
export function addToPath(): string | undefined {
  if (/(^|[\\/])(node|bun)(\.exe)?$/i.test(process.execPath)) return undefined
  const dir = path.dirname(process.execPath)
  if (process.env.GITHUB_ACTIONS === "true" && process.env.GITHUB_PATH) writeFileSync(process.env.GITHUB_PATH, dir + "\n", { flag: "a" })
  if ((process.env.PATH ?? "").split(path.delimiter).some((entry) => path.resolve(entry) === dir)) return undefined
  if (process.platform === "win32") {
    const script = `$p=[Environment]::GetEnvironmentVariable('Path','User'); if (-not ($p -split ';' -contains '${dir}')) { [Environment]::SetEnvironmentVariable('Path', ($(if ($p) { "$p;" } else { '' }) + '${dir}'), 'User') }`
    const done = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { stdio: "ignore" })
    return done.status === 0 ? "Windows user PATH" : undefined
  }
  const { candidates, line } = shellPath(dir)
  // A new Mac has no ~/.zshrc: create the shell's main file rather than leave browse off PATH.
  const file = candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!
  try {
    const text = existsSync(file) ? readFileSync(file, "utf8") : ""
    if (text.split("\n").includes(line)) return undefined
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, `${text && !text.endsWith("\n") ? "\n" : ""}\n# browse\n${line}\n`, { flag: "a" })
    return file
  } catch {
    log(`! Couldn't add browse to your PATH. Add this to ${tilde(file)}: ${line}`)
    return undefined
  }
}

/** The shell startup files addToPath picks from, and the line it adds for `dir`. */
function shellPath(dir: string) {
  const shell = path.basename(process.env.SHELL ?? "sh")
  const zdot = process.env.ZDOTDIR ?? home
  const candidates =
    shell === "fish"
      ? [path.join(configRoot, "fish", "config.fish")]
      : shell === "zsh"
        ? [path.join(zdot, ".zshrc"), path.join(zdot, ".zshenv"), path.join(configRoot, "zsh", ".zshrc")]
        : shell === "bash"
          ? [path.join(home, ".bashrc"), path.join(home, ".bash_profile"), path.join(home, ".profile")]
          : [path.join(home, ".profile")]
  return { candidates, line: shell === "fish" ? `fish_add_path ${dir}` : `export PATH=${dir}:$PATH` }
}

/**
 * Uninstalling a binary install: removes the executable install recorded and the PATH entry addToPath made for its
 * folder (the folder too, once empty). Returns what it couldn't remove.
 */
export function removeBinaryInstall(binary: string): string | undefined {
  const dir = path.dirname(binary)
  if (process.platform === "win32") {
    const script = `$p=[Environment]::GetEnvironmentVariable('Path','User'); if ($p) { [Environment]::SetEnvironmentVariable('Path', (($p -split ';' | Where-Object { $_ -and $_ -ne '${dir}' }) -join ';'), 'User') }`
    spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { stdio: "ignore" })
  } else {
    const { candidates, line } = shellPath(dir)
    for (const file of candidates) {
      const text = readFileOr(file, "")
      const block = `\n# browse\n${line}\n`
      if (text.includes(block)) writeFileSync(file, text.replace(`\n${block}`, "\n").replace(block, "\n"))
    }
  }
  try {
    rmSync(binary, { force: true })
    if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true })
    return undefined
  } catch {
    // Windows can't delete an executable while it runs (this one, or an agent's MCP server).
    return binary
  }
}
