import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const cliEntry = path.join(import.meta.dir, "../src/main.ts")

/** Every path under dir with its content: a command that writes or removes anything changes the result. */
function snapshot(dir: string, base = dir): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const full = path.join(dir, entry.name)
      const relative = path.relative(base, full)
      return entry.isDirectory() ? [`${relative}/`, ...snapshot(full, base)] : [`${relative}=${readFileSync(full, "utf8")}`]
    })
    .sort()
}

function isolatedEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    // Built from scratch: variables like CLAUDE_CONFIG_DIR, CODEX_HOME or DISPLAY must not leak in, or a help-detection
    // regression could touch the developer's real agent configs or open a browser.
    PATH: process.env.PATH,
    HOME: home,
    USERPROFILE: home,
    LOCALAPPDATA: path.join(home, "local-appdata"),
    APPDATA: path.join(home, "appdata"),
    XDG_CONFIG_HOME: path.join(home, "xdg-config"),
    XDG_DATA_HOME: path.join(home, "xdg-data"),
    XDG_STATE_HOME: path.join(home, "xdg-state"),
    XDG_CACHE_HOME: path.join(home, "xdg-cache"),
    XDG_BIN_HOME: path.join(home, "xdg-bin"),
    OPENCODE_BROWSER_HOME: path.join(home, "browse"),
    OPENCODE_BROWSER_PORT: "29988",
    OPENCODE_BROWSER_AUTO_UPDATE: "off",
    OPENCODE_BROWSER_UPDATE_CHECK: "0",
    // If help detection regresses, update must not run git against the checkout this test runs from.
    GIT_DIR: path.join(home, "fake-git"),
    GIT_WORK_TREE: path.join(home, "fake-worktree"),
    DISPLAY: "",
    WAYLAND_DISPLAY: "",
  }
  if (process.platform === "win32") {
    for (const key of ["SystemRoot", "ComSpec", "TEMP", "TMP"]) {
      const value = process.env[key]
      if (value !== undefined) env[key] = value
    }
  }
  return env
}

/** A browse root with settings and a secret profile: uninstall deletes all of it. */
function seed(home: string): string {
  const root = path.join(home, "browse")
  mkdirSync(path.join(root, "secrets"), { recursive: true })
  writeFileSync(path.join(root, "settings.json"), '{"entry":"/keep"}\n')
  writeFileSync(path.join(root, "secrets", "prod.json"), '{"token":"keep"}\n')
  writeFileSync(path.join(home, ".profile"), "sentinel\n")
  return root
}

// extension is in the same setup set, but it reads and reveals the checkout's dist/ in a source tree, so it has no
// isolated process test here.
const helpCommands = ["install", "uninstall", "pair", "set", "update"]

test.each(
  helpCommands.flatMap((command) => [
    [command, ["--help"]],
    [command, ["-h"]],
  ] as const),
)("browse %s %s prints help without running the command", (command, flags) => {
  const home = mkdtempSync(path.join(tmpdir(), "browse-setup-help-"))
  try {
    const root = seed(home)
    const before = snapshot(root)
    const result = spawnSync(process.execPath, [cliEntry, command, ...flags], {
      env: isolatedEnv(home),
      encoding: "utf8",
      timeout: 20_000,
    })
    expect(result.stderr, `${command} ${flags.join(" ")}: ${result.stdout}`).toBe("")
    expect(result.status, `${command} ${flags.join(" ")}: ${result.stderr}`).toBe(0)
    expect(result.stdout).toContain("SETUP")
    expect(result.stdout).toContain("USAGE")
    expect(result.stdout).toContain("SUBCOMMANDS")
    expect(snapshot(root)).toEqual(before)
    expect(readFileSync(path.join(home, ".profile"), "utf8")).toBe("sentinel\n")
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}, 30_000)

test("browse install --wait-seconds 10 --help prints help anywhere it appears", () => {
  const home = mkdtempSync(path.join(tmpdir(), "browse-setup-help-"))
  try {
    const root = seed(home)
    const before = snapshot(root)
    const result = spawnSync(process.execPath, [cliEntry, "install", "--wait-seconds", "10", "--help"], {
      env: isolatedEnv(home),
      encoding: "utf8",
      timeout: 20_000,
    })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain("SETUP")
    expect(result.stdout).toContain("SUBCOMMANDS")
    expect(snapshot(root)).toEqual(before)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}, 30_000)

test("browse status --help prints only its own help, not the setup status", () => {
  const home = mkdtempSync(path.join(tmpdir(), "browse-setup-help-"))
  try {
    const result = spawnSync(process.execPath, [cliEntry, "status", "--help"], {
      env: isolatedEnv(home),
      encoding: "utf8",
      timeout: 20_000,
    })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout.startsWith("DESCRIPTION")).toBe(true)
    expect(result.stdout).toContain("browse status [flags]")
    expect(result.stdout).not.toContain("Setup:")
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}, 30_000)
