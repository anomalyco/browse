// A binary install: the install script (or PowerShell installer) puts the bun-compiled executable in ~/.local/bin
// ($XDG_BIN_HOME when set). Install records that path, puts its folder on PATH, and uninstall takes both back.
import { spawnSync } from "node:child_process"
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { installedBinaryPath } from "../paths.ts"
import { opencodeBrowserVersion } from "../version.ts"
import { configRoot, fail, home, log, readFileOr, tilde } from "./environment.ts"

export const samePath = (left: string, right: string) => {
  try {
    return realpathSync(left) === realpathSync(right)
  } catch {
    return false
  }
}

/**
 * Makes sure this executable is the install's stable one: the installer already put it at ~/.local/bin/browse; an
 * executable someone downloaded and ran is copied there by rename. Returns the path, which stays where it is; updates
 * replace the file in place, so every agent entry keeps working.
 */
export async function installBinaryRuntime(): Promise<{ entry: string; version: string }> {
  const target = installedBinaryPath()
  if (!samePath(target, process.execPath)) {
    try {
      mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 })
      const staged = `${target}.${process.pid}.new`
      rmSync(staged, { force: true })
      copyFileSync(process.execPath, staged)
      chmodSync(staged, 0o755)
      if (process.platform === "win32") {
        for (const name of readdirSync(path.dirname(target))) {
          if (!name.startsWith(`${path.basename(target)}.old-`)) continue
          try { rmSync(path.join(path.dirname(target), name), { force: true }) } catch {}
        }
        if (existsSync(target)) renameSync(target, `${target}.old-${Date.now()}`)
      }
      renameSync(staged, target)
    } catch (error) {
      fail(`Could not install browse ${opencodeBrowserVersion} to ${target}: ${(error as Error).message}`)
    }
  }
  return { entry: target, version: opencodeBrowserVersion }
}

/** A regular file that is provably this install's executable: the running binary, or the same bytes as the managed copy. */
export function isInstallerBinary(candidate: string, managed: string): boolean {
  try {
    if (!lstatSync(candidate).isFile()) return false
  } catch {
    return false
  }
  if (samePath(candidate, process.execPath)) return true
  try {
    return statSync(candidate).size === statSync(managed).size && readFileSync(candidate).equals(readFileSync(managed))
  } catch {
    return false
  }
}

/**
 * A browse binary (the curl or PowerShell installer) puts its folder on PATH, so `browse` works in a new terminal:
 * the user PATH on Windows, else the shell's startup file, as opencode's installer does. Returns where it was added;
 * nothing when PATH already has it or browse runs on Node.
 */
export function addToPath(dir = path.dirname(process.execPath)): string | undefined {
  if (/(^|[\\/])(node|bun)(\.exe)?$/i.test(process.execPath)) return undefined
  if (process.env.GITHUB_ACTIONS === "true" && process.env.GITHUB_PATH) writeFileSync(process.env.GITHUB_PATH, dir + "\n", { flag: "a" })
  if ((process.env.PATH ?? "").split(path.delimiter).some((entry) => path.resolve(entry) === dir)) return undefined
  if (process.platform === "win32") {
    return editWindowsPath(dir, "add") ? "Windows user PATH" : undefined
  }
  const { candidates, line, legacyLine } = shellPath(dir)
  // A new Mac has no ~/.zshrc: create the shell's main file rather than leave browse off PATH.
  const file = candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!
  try {
    const text = existsSync(file) ? readFileSync(file, "utf8") : ""
    if (text.split("\n").includes(line)) return undefined
    if (text.includes(`\n# browse\n${legacyLine}\n`)) {
      writeFileSync(file, text.replace(`\n# browse\n${legacyLine}\n`, () => `\n# browse\n${line}\n`))
      return file
    }
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, `${text && !text.endsWith("\n") ? "\n" : ""}\n# browse\n${line}\n`, { flag: "a" })
    return file
  } catch {
    log(`! Couldn't add browse to your PATH. Add this to ${tilde(file)}: ${line}`)
    return undefined
  }
}

function editWindowsPath(dir: string, action: "add" | "remove"): boolean {
  // Environment.GetEnvironmentVariable expands %VAR% and SetEnvironmentVariable always writes REG_SZ.
  const script = `
    $ErrorActionPreference = 'Stop'
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
    $raw = $key.GetValue('Path', $null, 'DoNotExpandEnvironmentNames')
    $kind = if ($null -eq $raw) { 'ExpandString' } else { $key.GetValueKind('Path') }
    $parts = $raw -split ';'
    $dir = $env:BROWSE_PATH_ENTRY
    ${action === "add" ? `if ($parts -contains $dir) { exit 0 }; $new = if ($raw) { "$raw;$dir" } else { $dir }` : `if ($parts -notcontains $dir) { exit 0 }; $new = ($parts -ne $dir) -join ';'`}
    $key.SetValue('Path', $new, [Microsoft.Win32.RegistryValueKind]$kind)
    $key.Close()
    # Notify Explorer so new shells see the change, as SetEnvironmentVariable(User) did.
    Add-Type -Namespace Browse -Name Env -MemberDefinition '[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessageTimeout(IntPtr hwnd, uint msg, UIntPtr w, string l, uint flags, uint ms, out UIntPtr result);'
    $result = [UIntPtr]::Zero
    [void][Browse.Env]::SendMessageTimeout([IntPtr]65535, 26, [UIntPtr]::Zero, 'Environment', 2, 500, [ref]$result)
    Write-Output 'changed'`
  const done = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    env: { ...process.env, BROWSE_PATH_ENTRY: dir }, windowsHide: true, encoding: "utf8",
  })
  if (done.status !== 0) log(`! Couldn't ${action === "add" ? "add browse to" : "remove browse from"} your Windows user PATH: ${dir}`)
  return done.status === 0 && done.stdout.trim() === "changed"
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
  const fish = shell === "fish"
  const quoted = `'${(fish ? dir.replaceAll("\\", "\\\\") : dir).replaceAll("'", "'\\''")}'`
  return { candidates, line: fish ? `fish_add_path ${quoted}` : `export PATH=${quoted}:"$PATH"`, legacyLine: fish ? `fish_add_path ${dir}` : `export PATH=${dir}:$PATH` }
}

/**
 * Uninstalling a binary install: removes the executable install recorded and the PATH entry addToPath made for its
 * folder (the folder too, once empty). Returns what it couldn't remove.
 */
export function removeBinaryInstall(binary: string): string | undefined {
  const dir = path.dirname(binary)
  if (process.platform === "win32") {
    editWindowsPath(dir, "remove")
  } else {
    const { candidates, line, legacyLine } = shellPath(dir)
    for (const file of candidates) {
      const text = readFileOr(file, "")
      for (const entry of [line, legacyLine]) {
        const block = `\n# browse\n${entry}\n`
        if (text.includes(block)) { writeFileSync(file, text.replace(`\n${block}`, "\n").replace(block, "\n")); break }
      }
    }
  }
  if (!existsSync(dir)) return undefined
  const prefix = path.basename(binary) + ".old-"
  const stale = process.platform !== "win32" ? [] : readdirSync(dir).filter(name =>
    name.startsWith(prefix) && /^(?:[a-f\d]{8}|\d{13})$/i.test(name.slice(prefix.length)))
  const left = []
  for (const file of [binary, ...stale.map(name => path.join(dir, name))]) {
    try { rmSync(file, { force: true }) } catch { left.push(file) } // A running exe may be locked; still clean the others.
  }
  if (readdirSync(dir).length === 0) rmdirSync(dir)
  return left.length ? left.join(", ") : undefined
}
