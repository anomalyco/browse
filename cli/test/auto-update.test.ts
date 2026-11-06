import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  autoUpdateStatus,
  channelOf,
  compareVersions,
  createAutoUpdater,
  describeAutoUpdate,
  installedVersion,
  installKind,
  readState,
  runInstaller,
  updateState,
  type Runtime,
} from "../src/update/auto-update.ts"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function fakeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "browse-autoupdate-"))
  roots.push(home)
  fs.mkdirSync(path.join(home, ".local/bin"), { recursive: true })
  return home
}

/** A shell executable that reports `version` for --version. */
function executable(file: string, version: string) {
  fs.writeFileSync(file, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo ${version}; exit 0; fi\nexit 0\n`, { mode: 0o755 })
  fs.chmodSync(file, 0o755)
}

function runtimeAt(home: string, version: string): Runtime {
  const entry = path.join(home, ".local/bin", "browse")
  executable(entry, version)
  return { kind: "binary", entry, version }
}

describe("channels and versions", () => {
  test("a version's channel follows its prerelease", () => {
    expect(channelOf("0.2.0")).toBe("latest")
    expect(channelOf("0.2.1-dev.57")).toBe("dev")
  })

  test("dev builds sort by run, above the release before them and below the one they lead to", () => {
    const ordered = ["0.2.0-dev.40", "0.2.0", "0.2.1-dev.57", "0.2.1-dev.57.2", "0.2.1-dev.58", "0.2.1", "0.2.2-dev.60"]
    for (let index = 1; index < ordered.length; index++) {
      expect(compareVersions(ordered[index]!, ordered[index - 1]!)).toBe(1)
      expect(compareVersions(ordered[index - 1]!, ordered[index]!)).toBe(-1)
    }
    expect(compareVersions("0.2.1-dev.57", "0.2.1-dev.57")).toBe(0)
    expect(compareVersions("0.2.1-beta.9", "0.2.0")).toBe(0)
  })
})

describe("where this process runs from", () => {
  test("npx's cache is recognized, and a checkout is not an installed runtime", () => {
    expect(installKind("/home/u/.npm/_npx/abc/node_modules/@opencode/browse/dist/cli.mjs", false)).toBe("npx")
    expect(installKind("/home/u/.local/share/pnpm/global/5/node_modules/@opencode/browse/dist/cli.mjs", false)).toBe("npm")
  })
})

describe("updating reruns the installer", () => {
  test("a binary install runs the install script, which replaces the executable in place", async () => {
    const home = fakeHome()
    const runtime = runtimeAt(home, "0.0.1")
    // The fake install script is a local stand-in for https://opencode.ai/browse/install: it replaces the binary and
    // ignores the version arguments it is given.
    const installer = path.join(home, "install")
    fs.writeFileSync(installer, `#!/bin/sh\ncat > "$HOME/.local/bin/browse" <<'EOF'\n#!/bin/sh\nif [ "$1" = "--version" ]; then echo 0.0.2; exit 0; fi\nexit 0\nEOF\nchmod 755 "$HOME/.local/bin/browse"\n`)
    const installed = await runInstaller({
      runtime,
      version: "0.0.2",
      env: { ...process.env, HOME: home, OPENCODE_BROWSER_INSTALL_SCRIPT: installer },
    })
    expect(installed).toBe("0.0.2")
    expect(installedVersion(runtime)).toBe("0.0.2")
    expect(fs.readdirSync(path.join(home, ".local/bin"))).toEqual(["browse"])
  })

  test("an npm install runs npm install -g at the requested version", async () => {
    const calls: string[][] = []
    const installed = await runInstaller({
      runtime: { kind: "npm", entry: "/prefix/node_modules/@opencode/browse/dist/cli.mjs", version: "1.0.0" },
      version: "1.0.1",
      run: async (command, args) => {
        calls.push([command, ...args])
        return { status: 0, stdout: "", stderr: "" }
      },
      env: {},
    })
    expect(calls).toEqual([["npm", "install", "-g", "@opencode/browse@1.0.1"]])
    // The stub installed nothing, so the caller keeps the version it asked for.
    expect(installed).toBe("1.0.1")
  })

  test("npx is a no-op: npx resolves the package itself", async () => {
    let ran = false
    expect(await runInstaller({ runtime: { kind: "npx", entry: "/tmp/_npx/x/cli.mjs", version: "1.0.0" }, version: "2.0.0", run: async () => ((ran = true), { status: 0, stdout: "", stderr: "" }) })).toBe("1.0.0")
    expect(ran).toBe(false)
  })
})

describe("the relay's updater", () => {
  test("installs with self-update in its own process, then restarts the relay once idle", async () => {
    const home = fakeHome()
    process.env.OPENCODE_BROWSER_HOME = home
    try {
      const runtime = runtimeAt(home, "0.0.1")
      updateState(() => ({ checkedAt: Date.now(), latest: "0.0.2" }))
      const spawned: string[][] = []
      const callbacks: ((code: number | null) => void)[] = []
      const updater = createAutoUpdater({
        runtime,
        isIdle: () => true,
        log: () => {},
        spawnChild: (args, onExit) => (spawned.push([...args]), callbacks.push(onExit), 2 ** 22 + 12345),
        env: {},
      })
      await updater.tick()
      expect(spawned).toEqual([["self-update", "0.0.2", "--channel", "latest"]])
      expect(readState().installing).toMatchObject({ version: "0.0.2" })
      // The installer child finishes and replaces the executable; the next tick restarts the relay from it.
      executable(runtime.entry, "0.0.2")
      callbacks[0]!(0)
      await Bun.sleep(0)
      await updater.tick()
      expect(spawned[1]).toEqual(["runtime-switch", "0.0.2"])
    } finally {
      delete process.env.OPENCODE_BROWSER_HOME
    }
  })
})

describe("status", () => {
  test("says how each install updates", () => {
    const home = fakeHome()
    process.env.OPENCODE_BROWSER_HOME = home
    try {
      const runtime = runtimeAt(home, "0.0.1")
      updateState(() => ({ checkedAt: Date.now(), latest: "0.0.2" }))
      const status = autoUpdateStatus({ runtime, env: {} })
      expect(status.install).toBe("binary")
      expect(status.effective).toBe("on")
      expect(describeAutoUpdate(status)).toContain("0.0.2 available")
      expect(describeAutoUpdate(autoUpdateStatus({ runtime: { ...runtime, kind: "npx" }, env: {} }))).toContain("npx resolves")
    } finally {
      delete process.env.OPENCODE_BROWSER_HOME
    }
  })
})
