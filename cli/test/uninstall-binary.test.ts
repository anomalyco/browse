import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const binary = process.platform === "win32" ? "browse.exe" : "browse"

type Home = { home: string; bin: string; root: string; installer: string; managed: string; settings: string }

function makeHome(): Home {
  const home = mkdtempSync(path.join(tmpdir(), "browse-uninstall-binary-"))
  const bin = path.join(home, "xdg-bin")
  const root = path.join(home, "browse-home")
  mkdirSync(bin)
  mkdirSync(root)
  return {
    home,
    bin,
    root,
    installer: path.join(bin, binary),
    managed: path.join(root, "bin", binary),
    settings: path.join(home, ".config", "browse", "settings.json"),
  }
}

function envFor(home: Home): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home.home,
    USERPROFILE: home.home,
    APPDATA: path.join(home.home, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(home.home, "AppData", "Local"),
    CHROME_CONFIG_HOME: path.join(home.home, ".config"),
    XDG_CONFIG_HOME: path.join(home.home, ".config"),
    XDG_DATA_HOME: path.join(home.home, ".local", "share"),
    XDG_STATE_HOME: path.join(home.home, ".local", "state"),
    XDG_CACHE_HOME: path.join(home.home, ".cache"),
    XDG_BIN_HOME: home.bin,
    OPENCODE_BROWSER_HOME: home.root,
    OPENCODE_BROWSER_PORT: "29988",
    OPENCODE_BROWSER_UPDATE_CHECK: "0",
    OPENCODE_BROWSER_AUTOSTART: "0",
    SHELL: "/bin/sh",
    TEST_BINARY: home.installer,
    TEST_MANAGED: home.managed,
  }
  delete env.OPENCODE_BROWSER_PACKAGE
  delete env.GITHUB_ACTIONS
  delete env.GITHUB_PATH
  return env
}

function run(script: string, home: Home) {
  return spawnSync(process.execPath, ["-e", script], {
    cwd: path.join(import.meta.dir, ".."),
    env: envFor(home),
    encoding: "utf8",
    timeout: 30_000,
  })
}

test.skipIf(process.platform === "win32")("uninstall removes the installer's executable when OPENCODE_BROWSER_HOME points elsewhere", () => {
  const home = makeHome()
  try {
    writeFileSync(home.installer, "#!/bin/sh\nexit 0\n", { mode: 0o755 })
    const result = run(
      `
import path from "node:path"
import { installBinaryRuntime, addToPath } from "./src/setup/binary.ts"
import { installedBinaryPath } from "./src/paths.ts"
import { uninstall } from "./src/setup/commands.ts"
globalThis.__OPENCODE_BROWSER_COMPILED__ = true
Object.defineProperty(process, "execPath", { value: process.env.TEST_BINARY })
const managed = installedBinaryPath()
await installBinaryRuntime()
addToPath(path.dirname(managed))
await uninstall(["--yes"])
`,
      home,
    )
    expect(result.status, result.stderr || result.stdout).toBe(0)
    expect(existsSync(home.installer)).toBe(false)
    expect(existsSync(home.managed)).toBe(false)
    expect(readFileSync(path.join(home.home, ".profile"), "utf8")).not.toContain("# browse")
  } finally {
    rmSync(home.home, { recursive: true, force: true })
  }
})

test.skipIf(process.platform === "win32")("uninstall keeps the installer's executable when an everyday install exists", () => {
  const home = makeHome()
  try {
    writeFileSync(home.installer, "#!/bin/sh\nexit 0\n", { mode: 0o755 })
    mkdirSync(path.dirname(home.settings), { recursive: true })
    writeFileSync(home.settings, JSON.stringify({ entry: home.installer }))
    const result = run(
      `
import { installBinaryRuntime } from "./src/setup/binary.ts"
import { uninstall } from "./src/setup/commands.ts"
globalThis.__OPENCODE_BROWSER_COMPILED__ = true
Object.defineProperty(process, "execPath", { value: process.env.TEST_BINARY })
await installBinaryRuntime()
await uninstall(["--yes"])
`,
      home,
    )
    expect(result.status, result.stderr || result.stdout).toBe(0)
    expect(existsSync(home.installer)).toBe(true)
    expect(readFileSync(home.installer, "utf8")).toBe("#!/bin/sh\nexit 0\n")
    expect(existsSync(home.managed)).toBe(false)
    expect(result.stdout).toContain(`! Left ${home.installer}; delete it if you no longer use browse there.`)
  } finally {
    rmSync(home.home, { recursive: true, force: true })
  }
})

test.skipIf(process.platform === "win32")("uninstall removes an installer-path file identical to the managed copy when it is not running", () => {
  const home = makeHome()
  try {
    const bytes = "#!/bin/sh\nexit 0\n"
    mkdirSync(path.dirname(home.managed), { recursive: true })
    writeFileSync(home.installer, bytes, { mode: 0o755 })
    writeFileSync(home.managed, bytes, { mode: 0o755 })
    const result = run(
      `
import { uninstall } from "./src/setup/commands.ts"
globalThis.__OPENCODE_BROWSER_COMPILED__ = true
Object.defineProperty(process, "execPath", { value: process.env.TEST_MANAGED })
await uninstall(["--yes"])
`,
      home,
    )
    expect(result.status, result.stderr || result.stdout).toBe(0)
    expect(existsSync(home.installer)).toBe(false)
    expect(existsSync(home.managed)).toBe(false)
    expect(result.stdout).toContain(`✓ Removed ${home.installer}`)
  } finally {
    rmSync(home.home, { recursive: true, force: true })
  }
})

test.skipIf(process.platform === "win32")("uninstall keeps an installer-path file that is not the running executable or the managed copy", () => {
  const home = makeHome()
  try {
    mkdirSync(path.dirname(home.managed), { recursive: true })
    writeFileSync(home.installer, "not this install's executable\n")
    writeFileSync(home.managed, "the managed executable\n")
    const result = run(
      `
import { uninstall } from "./src/setup/commands.ts"
globalThis.__OPENCODE_BROWSER_COMPILED__ = true
Object.defineProperty(process, "execPath", { value: process.env.TEST_MANAGED })
await uninstall(["--yes"])
`,
      home,
    )
    expect(result.status, result.stderr || result.stdout).toBe(0)
    expect(existsSync(home.installer)).toBe(true)
    expect(readFileSync(home.installer, "utf8")).toBe("not this install's executable\n")
    expect(existsSync(home.managed)).toBe(false)
    expect(result.stdout).toContain(`! Left ${home.installer}`)
  } finally {
    rmSync(home.home, { recursive: true, force: true })
  }
})
