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
  setStoredMode,
  updateState,
  type Runtime,
} from "../src/update/auto-update.ts"
import { rolloutBucket } from "../src/update/release-service.ts"
import { runSelfUpdate } from "../src/update/runtime-update.ts"

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

/** An installer stand-in that replaces the executable with one reporting `version`. */
function installerWriting(version: string) {
  return `#!/bin/sh\ncat > "$HOME/.local/bin/browse" <<'EOF'\n#!/bin/sh\nif [ "$1" = "--version" ]; then echo ${version}; exit 0; fi\nexit 0\nEOF\nchmod 755 "$HOME/.local/bin/browse"\n`
}

/** The same, for `entry`, with no HOME needed. */
function installerReplacing(entry: string, version: string) {
  return `#!/bin/sh\ncat > "${entry}" <<'EOF'\n#!/bin/sh\nif [ "$1" = "--version" ]; then echo ${version}; exit 0; fi\nexit 0\nEOF\nchmod 755 "${entry}"\n`
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
    expect(channelOf("0.2.1-beta.2")).toBe("beta")
  })

  test("the rollout bucket is drawn once and kept", () => {
    const root = fakeHome()
    const first = rolloutBucket(root)
    expect(first).toBeGreaterThanOrEqual(0)
    expect(first).toBeLessThan(100)
    expect(rolloutBucket(root)).toBe(first)
    fs.writeFileSync(path.join(root, "rollout-bucket"), "42\n")
    expect(rolloutBucket(root)).toBe(42)
    fs.writeFileSync(path.join(root, "rollout-bucket"), "250\n")
    expect(rolloutBucket(root)).toBeLessThan(100)
  })

  test("dev builds sort by run, above the release before them and below the one they lead to", () => {
    const ordered = ["0.2.0-dev.40", "0.2.0", "0.2.1-dev.57", "0.2.1-dev.57.2", "0.2.1-dev.58", "0.2.1", "0.2.2-dev.60"]
    for (let index = 1; index < ordered.length; index++) {
      expect(compareVersions(ordered[index]!, ordered[index - 1]!)).toBe(1)
      expect(compareVersions(ordered[index - 1]!, ordered[index]!)).toBe(-1)
    }
    expect(compareVersions("0.2.1-dev.57", "0.2.1-dev.57")).toBe(0)
    expect(compareVersions("0.2.1-beta.9", "0.2.0")).toBe(1)
    expect(compareVersions("0.2.1-dev.9", "0.2.1-beta.1")).toBe(-1)
    expect(compareVersions("0.2.1-beta.1", "0.2.1")).toBe(-1)
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
    // OPENCODE_BROWSER_INSTALL_SCRIPT points the updater at this fake in place of the script baked into the binary: it
    // replaces the executable and ignores the version arguments it is given.
    const installer = path.join(home, "install")
    fs.writeFileSync(installer, installerWriting("0.0.2"))
    const installed = await runInstaller({
      runtime,
      version: "0.0.2",
      env: { ...process.env, HOME: home, OPENCODE_BROWSER_INSTALL_SCRIPT: installer },
    })
    expect(installed).toBe("0.0.2")
    expect(installedVersion(runtime)).toBe("0.0.2")
    expect(fs.readdirSync(path.join(home, ".local/bin"))).toEqual(["browse"])
  })

  test("a binary install runs the installer that shipped with the release, not one fetched at update time", async () => {
    const home = fakeHome()
    const runtime = runtimeAt(home, "0.0.1")
    let fetches = 0
    const dev = installerWriting("0.0.3")
    const installed = await runInstaller({
      runtime,
      version: "0.0.2",
      installer: installerWriting("0.0.2"),
      fetch: (async () => {
        fetches++
        return new Response(dev)
      }) as unknown as typeof fetch,
      env: { ...process.env, HOME: home, OPENCODE_BROWSER_INSTALL_SCRIPT: "" },
    })
    expect(installed).toBe("0.0.2")
    expect(installedVersion(runtime)).toBe("0.0.2")
    expect(fetches).toBe(0)
  })

  test("a binary install with no installer fails before touching the executable", async () => {
    const home = fakeHome()
    const runtime = runtimeAt(home, "0.0.1")
    const before = fs.readFileSync(runtime.entry, "utf8")
    let ran = false
    const operation = runInstaller({
      runtime,
      version: "0.0.2",
      run: async () => ((ran = true), { status: 0, stdout: "", stderr: "" }),
      env: { ...process.env, HOME: home, OPENCODE_BROWSER_INSTALL_SCRIPT: "" },
    })
    await expect(operation).rejects.toThrow("no installer to run")
    expect(ran).toBe(false)
    expect(fs.readFileSync(runtime.entry, "utf8")).toBe(before)
    expect(installedVersion(runtime)).toBe("0.0.1")
  })

  test("a channel update runs the installer with --channel and --no-setup", async () => {
    const home = fakeHome()
    const runtime = runtimeAt(home, "0.0.1")
    const calls: string[][] = []
    await runInstaller({
      runtime,
      channel: "dev",
      installer: installerWriting("0.0.2"),
      run: async (command, args) => (calls.push([command, ...args]), { status: 0, stdout: "", stderr: "" }),
      env: { ...process.env, HOME: home, OPENCODE_BROWSER_INSTALL_SCRIPT: "" },
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]![0]).toBe("sh")
    expect(calls[0]!.slice(1)).toEqual([expect.stringContaining("browse-install-"), "--channel", "dev", "--no-setup"])
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

describe("the relay's self-update child", () => {
  test("records lastUpdate with the version it replaced", async () => {
    const home = fakeHome()
    process.env.OPENCODE_BROWSER_HOME = home
    try {
      const runtime = runtimeAt(home, "0.0.1")
      const installer = path.join(home, "install")
      fs.writeFileSync(installer, installerReplacing(runtime.entry, "0.0.2"))
      process.env.OPENCODE_BROWSER_INSTALL_SCRIPT = installer
      updateState(() => ({ lastUpdate: { from: "0.0.0", to: "0.0.1", at: "2026-01-01T00:00:00.000Z" } }))
      await runSelfUpdate(["0.0.2", "--channel", "latest"], runtime)
      const state = readState()
      expect(state.lastUpdate).toMatchObject({ from: "0.0.1", to: "0.0.2" })
      expect(new Date(state.lastUpdate!.at).toISOString()).toBe(state.lastUpdate!.at)
    } finally {
      delete process.env.OPENCODE_BROWSER_INSTALL_SCRIPT
      delete process.env.OPENCODE_BROWSER_HOME
    }
  })

  test("records the running relay's version when the build on disk is newer", async () => {
    const home = fakeHome()
    process.env.OPENCODE_BROWSER_HOME = home
    try {
      // A refused switch left the relay on 0.0.1 while 0.0.2 is the build on disk, so the child starts as 0.0.2.
      const runtime = runtimeAt(home, "0.0.2")
      const installer = path.join(home, "install")
      fs.writeFileSync(installer, installerReplacing(runtime.entry, "0.0.3"))
      process.env.OPENCODE_BROWSER_INSTALL_SCRIPT = installer
      await runSelfUpdate(["0.0.3", "--channel", "latest", "--from", "0.0.1"], runtime)
      expect(readState().lastUpdate).toMatchObject({ from: "0.0.1", to: "0.0.3" })
    } finally {
      delete process.env.OPENCODE_BROWSER_INSTALL_SCRIPT
      delete process.env.OPENCODE_BROWSER_HOME
    }
  })

  test("a failed install leaves lastUpdate untouched", async () => {
    const home = fakeHome()
    process.env.OPENCODE_BROWSER_HOME = home
    const exitCode = process.exitCode ?? 0
    try {
      const runtime = runtimeAt(home, "0.0.1")
      const installer = path.join(home, "install")
      fs.writeFileSync(installer, "#!/bin/sh\nexit 1\n", { mode: 0o755 })
      process.env.OPENCODE_BROWSER_INSTALL_SCRIPT = installer
      await runSelfUpdate(["0.0.2", "--channel", "latest"], runtime)
      expect(readState().lastUpdate).toBeUndefined()
      expect(readState().lastError).toMatchObject({ version: "0.0.2" })

      const previous = { from: "0.0.0", to: "0.0.1", at: "2026-01-01T00:00:00.000Z" }
      updateState((state) => ({ ...state, lastUpdate: previous }))
      await runSelfUpdate(["0.0.2", "--channel", "latest"], runtime)
      expect(readState().lastUpdate).toEqual(previous)
    } finally {
      process.exitCode = exitCode
      delete process.env.OPENCODE_BROWSER_INSTALL_SCRIPT
      delete process.env.OPENCODE_BROWSER_HOME
    }
  })

  test("an install that leaves the same version leaves lastUpdate unchanged", async () => {
    const home = fakeHome()
    process.env.OPENCODE_BROWSER_HOME = home
    try {
      const runtime = runtimeAt(home, "0.0.1")
      const installer = path.join(home, "install")
      fs.writeFileSync(installer, "#!/bin/sh\nexit 0\n", { mode: 0o755 })
      process.env.OPENCODE_BROWSER_INSTALL_SCRIPT = installer
      const previous = { from: "0.0.0", to: "0.0.1", at: "2026-01-01T00:00:00.000Z" }
      updateState(() => ({ lastUpdate: previous }))
      await runSelfUpdate(["0.0.1", "--channel", "latest"], runtime)
      expect(readState().lastUpdate).toEqual(previous)
      expect(readState().lastError).toBeUndefined()
    } finally {
      delete process.env.OPENCODE_BROWSER_INSTALL_SCRIPT
      delete process.env.OPENCODE_BROWSER_HOME
    }
  })
})

describe("the relay's updater", () => {
  const SHA = "a".repeat(64)
  const manifest = (options: { version: string; rollout?: number; required?: boolean; channel?: string }) =>
    JSON.stringify({
      schema: 1,
      app: "browse",
      artifact: "cli",
      channel: options.channel ?? "stable",
      sequence: 2,
      published_at: "2026-11-07T00:00:00Z",
      release: {
        version: options.version,
        rollout_percent: options.rollout ?? 100,
        ...(options.required ? { required: true } : {}),
        targets: {
          "linux-x64": { url: `/release/browse/files/${SHA}/opencode-browse-linux-x64-${options.version}.tgz`, size: 1, sha256: SHA },
        },
        distributions: [{ kind: "direct" }],
      },
    })

  test("a binary install reads its channel's release service manifest with the protocol's User-Agent and ETag", async () => {
    const home = fakeHome()
    process.env.OPENCODE_BROWSER_HOME = home
    const globals = globalThis as { __OPENCODE_BROWSER_TARGET__?: string }
    globals.__OPENCODE_BROWSER_TARGET__ = "linux-x64"
    try {
      const runtime = runtimeAt(home, "0.0.1")
      updateState(() => ({}))
      const requests: { url: string; headers: Headers }[] = []
      let time = 1_000_000
      const fetcher: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers)
        requests.push({ url: String(input), headers })
        const response = requests.length === 1 ? manifest({ version: "0.0.2" }) : null
        return response ? new Response(response, { status: 200, headers: { etag: '"one"' } }) : new Response(null, { status: 304 })
      }) as unknown as typeof fetch
      const spawned: string[][] = []
      const updater = createAutoUpdater({
        runtime,
        isIdle: () => true,
        log: () => {},
        spawnChild: (args) => (spawned.push([...args]), 2 ** 22 + 12346),
        env: { OPENCODE_BROWSER_AUTO_UPDATE: "notify" },
        fetch: fetcher,
        now: () => time,
      })
      await updater.tick()
      expect(requests[0]!.url).toBe("https://anoma.ly/release/browse/cli/stable.json")
      expect(requests[0]!.headers.get("user-agent")).toBe("browse/stable/0.0.1/cli")
      expect(requests[0]!.headers.get("if-none-match")).toBeNull()
      expect(readState()).toMatchObject({ latest: "0.0.2", etag: '"one"' })
      expect(spawned).toEqual([])

      // An hour later the check runs again with If-None-Match; 304 keeps the answer and changes nothing.
      time += 60 * 60 * 1000
      await updater.tick()
      expect(requests[1]!.headers.get("if-none-match")).toBe('"one"')
      expect(readState()).toMatchObject({ latest: "0.0.2", etag: '"one"' })
    } finally {
      delete process.env.OPENCODE_BROWSER_HOME
      delete globals.__OPENCODE_BROWSER_TARGET__
    }
  })

  test("checks at least hourly, and respects rollout and required before installing", async () => {
    const home = fakeHome()
    process.env.OPENCODE_BROWSER_HOME = home
    const globals = globalThis as { __OPENCODE_BROWSER_TARGET__?: string }
    globals.__OPENCODE_BROWSER_TARGET__ = "linux-x64"
    try {
      const runtime = runtimeAt(home, "0.0.1")
      updateState(() => ({ checkedAt: 1_000_000 }))
      let calls = 0
      const fetcher: typeof fetch = (async () => {
        calls++
        return new Response(manifest({ version: "0.0.2", rollout: 0 }), { status: 200 })
      }) as unknown as typeof fetch
      const spawned: string[][] = []
      const updater = createAutoUpdater({
        runtime,
        isIdle: () => true,
        log: () => {},
        spawnChild: (args) => (spawned.push([...args]), 2 ** 22 + 12347),
        env: {},
        fetch: fetcher,
        now: () => 1_000_000 + 30 * 60 * 1000,
      })
      await updater.tick()
      expect(calls).toBe(0)
      expect(spawned).toEqual([])

      // 61 minutes later: check, but a halted rollout installs nothing.
      const later = createAutoUpdater({
        runtime,
        isIdle: () => true,
        log: () => {},
        spawnChild: (args) => (spawned.push([...args]), 2 ** 22 + 12348),
        env: {},
        fetch: fetcher,
        now: () => 1_000_000 + 61 * 60 * 1000,
      })
      await later.tick()
      expect(calls).toBe(1)
      expect(spawned).toEqual([])
      expect(readState().latest).toBeUndefined()

      // A required release bypasses the rollout.
      updateState(() => ({}))
      const required = createAutoUpdater({
        runtime,
        isIdle: () => true,
        log: () => {},
        spawnChild: (args) => (spawned.push([...args]), 2 ** 22 + 12349),
        env: {},
        fetch: (async () => new Response(manifest({ version: "0.0.3", rollout: 0, required: true }), { status: 200 })) as unknown as typeof fetch,
      })
      await required.tick()
      expect(spawned).toEqual([["self-update", "0.0.3", "--channel", "latest", "--from", "0.0.1"]])
    } finally {
      delete process.env.OPENCODE_BROWSER_HOME
      delete globals.__OPENCODE_BROWSER_TARGET__
    }
  })

  test("keeps the stable executable matching the busy relay and installs and switches only when idle", async () => {
    const home = fakeHome()
    process.env.OPENCODE_BROWSER_HOME = home
    const globals = globalThis as { __OPENCODE_BROWSER_TARGET__?: string }
    globals.__OPENCODE_BROWSER_TARGET__ = "linux-x64"
    try {
      const runtime = runtimeAt(home, "0.0.1")
      updateState(() => ({ checkedAt: Date.now(), latest: "0.0.2" }))
      const spawned: string[][] = []
      const callbacks: ((code: number | null) => void)[] = []
      let idle = false
      const updater = createAutoUpdater({
        runtime,
        isIdle: () => idle,
        log: () => {},
        spawnChild: (args, onExit) => {
          if (args[0] === "self-update") executable(runtime.entry, args[1]!)
          spawned.push([...args])
          callbacks.push(onExit)
          return process.pid
        },
        env: {},
        fetch: (async () => new Response(manifest({ version: "0.0.2" }), { status: 200 })) as unknown as typeof fetch,
      })
      await updater.tick()
      expect(installedVersion(runtime)).toBe(runtime.version)
      expect(spawned).toEqual([])
      idle = true
      await updater.tick()
      expect(spawned).toEqual([["self-update", "0.0.2", "--channel", "latest", "--from", "0.0.1"]])
      expect(installedVersion(runtime)).toBe("0.0.2")
      expect(readState().installing).toMatchObject({ version: "0.0.2" })
      // An agent came back during the install: the restart still needs its own idle check.
      idle = false
      callbacks[0]!(0)
      await Bun.sleep(10)
      expect(spawned).toHaveLength(1)
      idle = true
      await updater.tick()
      expect(spawned[1]).toEqual(["runtime-switch", "0.0.2"])
    } finally {
      delete process.env.OPENCODE_BROWSER_HOME
      delete globals.__OPENCODE_BROWSER_TARGET__
    }
  })

  test("the relay keeps the lastUpdate the installer child wrote", async () => {
    const home = fakeHome()
    process.env.OPENCODE_BROWSER_HOME = home
    const globals = globalThis as { __OPENCODE_BROWSER_TARGET__?: string }
    globals.__OPENCODE_BROWSER_TARGET__ = "linux-x64"
    try {
      const time = Date.parse("2026-11-08T12:00:00.000Z")
      const runtime = runtimeAt(home, "0.0.1")
      updateState(() => ({ checkedAt: time, latest: "0.0.2", lastUpdate: { from: "0.0.0", to: "0.0.1", at: new Date(time - 60_000).toISOString() } }))
      const callbacks: ((code: number | null) => void)[] = []
      const spawned: string[][] = []
      let switched!: () => void
      const switchSpawned = new Promise<void>((resolve) => (switched = resolve))
      const updater = createAutoUpdater({
        runtime,
        isIdle: () => true,
        log: () => {},
        spawnChild: (args, onExit) => {
          if (args[0] === "runtime-switch") switched()
          spawned.push([...args])
          callbacks.push(onExit)
          return process.pid
        },
        env: {},
        fetch: (async () => new Response(manifest({ version: "0.0.2" }), { status: 200 })) as unknown as typeof fetch,
        now: () => time,
      })
      await updater.tick()
      expect(spawned).toEqual([["self-update", "0.0.2", "--channel", "latest", "--from", "0.0.1"]])
      // The installer child runs for real and writes lastUpdate before the relay sees it exit.
      const installer = path.join(home, "install")
      fs.writeFileSync(installer, installerReplacing(runtime.entry, "0.0.2"))
      process.env.OPENCODE_BROWSER_INSTALL_SCRIPT = installer
      await runSelfUpdate(spawned[0]!.slice(1), runtime)
      expect(readState().lastUpdate).toMatchObject({ from: "0.0.1", to: "0.0.2" })
      callbacks[0]!(0)
      // The immediate recheck runs before it switches; waiting for that spawn proves it finished.
      await switchSpawned
      expect(spawned).toEqual([["self-update", "0.0.2", "--channel", "latest", "--from", "0.0.1"], ["runtime-switch", "0.0.2"]])
      expect(callbacks).toHaveLength(2)
      expect(readState().lastUpdate).toMatchObject({ from: "0.0.1", to: "0.0.2" })
    } finally {
      delete process.env.OPENCODE_BROWSER_INSTALL_SCRIPT
      delete process.env.OPENCODE_BROWSER_HOME
      delete globals.__OPENCODE_BROWSER_TARGET__
    }
  })

  test("a 304 check with the channel's release already running doesn't restart the relay", async () => {
    const home = fakeHome()
    process.env.OPENCODE_BROWSER_HOME = home
    const globals = globalThis as { __OPENCODE_BROWSER_TARGET__?: string }
    globals.__OPENCODE_BROWSER_TARGET__ = "linux-x64"
    try {
      const runtime = runtimeAt(home, "0.0.15")
      updateState(() => ({ checkedAt: 1_000_000, latest: "0.0.15", etag: '"one"', lastError: { message: "the installer failed", at: new Date(1_000_000).toISOString(), version: "0.0.15", attempts: 2 } }))
      const spawned: string[][] = []
      const updater = createAutoUpdater({
        runtime,
        isIdle: () => true,
        log: () => {},
        spawnChild: (args) => (spawned.push([...args]), 2 ** 22 + 12350),
        env: {},
        fetch: (async () => new Response(null, { status: 304 })) as unknown as typeof fetch,
        now: () => 1_000_000 + 61 * 60 * 1000,
      })
      await updater.tick()
      expect(spawned).toEqual([])
      expect(readState()).toMatchObject({ latest: "0.0.15", etag: '"one"' })
      // The release it once failed to install is the build this relay runs, so the failure is stale.
      expect(readState().lastError).toBeUndefined()
    } finally {
      delete process.env.OPENCODE_BROWSER_HOME
      delete globals.__OPENCODE_BROWSER_TARGET__
    }
  })

  test("a release that differs from the running build still restarts the relay when it is installed", async () => {
    const home = fakeHome()
    process.env.OPENCODE_BROWSER_HOME = home
    try {
      const runtime = runtimeAt(home, "0.0.14")
      executable(runtime.entry, "0.0.15")
      updateState(() => ({ checkedAt: Date.now(), latest: "0.0.15" }))
      const spawned: string[][] = []
      const updater = createAutoUpdater({
        runtime,
        isIdle: () => true,
        log: () => {},
        spawnChild: (args) => (spawned.push([...args]), 2 ** 22 + 12351),
        env: {},
      })
      await updater.tick()
      expect(spawned).toEqual([["runtime-switch", "0.0.15"]])
    } finally {
      delete process.env.OPENCODE_BROWSER_HOME
    }
  })

  test("one failed self-update counts as one attempt", async () => {
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
        spawnChild: (args, onExit) => {
          // runSelfUpdate in runtime-update.ts records its failure before exiting; the parent must not count it again.
          if (args[0] === "self-update") {
            const version = args[1]!
            updateState((state) => ({
              ...state,
              lastError: { message: "the installer failed: boom", at: new Date().toISOString(), version, attempts: 1 + (state.lastError?.version === version ? state.lastError.attempts ?? 1 : 0) },
            }))
          }
          spawned.push([...args])
          callbacks.push(onExit)
          return process.pid
        },
        env: {},
      })
      await updater.tick()
      expect(spawned).toEqual([["self-update", "0.0.2", "--channel", "latest", "--from", "0.0.1"]])
      callbacks[0]!(1)
      await Bun.sleep(0)
      expect(readState().lastError).toMatchObject({ version: "0.0.2", attempts: 1 })
    } finally {
      delete process.env.OPENCODE_BROWSER_HOME
    }
  })

  test("a failed check keeps the last failure and drops the etag", async () => {
    const home = fakeHome()
    process.env.OPENCODE_BROWSER_HOME = home
    const globals = globalThis as { __OPENCODE_BROWSER_TARGET__?: string }
    globals.__OPENCODE_BROWSER_TARGET__ = "linux-x64"
    try {
      const runtime = runtimeAt(home, "0.0.15")
      const failure = { message: "the installer failed", at: new Date(1_000_000).toISOString(), version: "0.0.16", attempts: 1 }
      updateState(() => ({ checkedAt: 1_000_000, latest: "0.0.16", etag: '"one"', lastError: failure }))
      const spawned: string[][] = []
      const updater = createAutoUpdater({
        runtime,
        isIdle: () => true,
        log: () => {},
        spawnChild: (args) => (spawned.push([...args]), 2 ** 22 + 12360),
        env: {},
        fetch: (async () => {
          throw new Error("offline")
        }) as unknown as typeof fetch,
        now: () => 1_000_000 + 61 * 60 * 1000,
      })
      await updater.tick()
      expect(spawned).toEqual([])
      const state = readState()
      // No etag, or the next check gets a 304 for a manifest whose latest this failed check threw away.
      expect(state).toMatchObject({ failed: "offline" })
      expect(state.etag).toBeUndefined()
      expect(state.latest).toBeUndefined()
      expect(state.lastError).toEqual(failure)
    } finally {
      delete process.env.OPENCODE_BROWSER_HOME
      delete globals.__OPENCODE_BROWSER_TARGET__
    }
  })

  test("the parent counts a failure when the child wrote no record", async () => {
    const home = fakeHome()
    process.env.OPENCODE_BROWSER_HOME = home
    try {
      const runtime = runtimeAt(home, "0.0.1")
      const time = 1_000_000
      updateState(() => ({ checkedAt: time - 10 * 60_000, latest: "0.0.2", lastError: { message: "old", at: new Date(time - 2 * 60 * 60_000).toISOString(), version: "0.0.2", attempts: 2 } }))
      const spawned: string[][] = []
      const callbacks: ((code: number | null) => void)[] = []
      const updater = createAutoUpdater({
        runtime,
        isIdle: () => true,
        log: () => {},
        // The child exits non-zero without recording a failure of its own.
        spawnChild: (args, onExit) => (spawned.push([...args]), callbacks.push(onExit), process.pid),
        env: {},
        now: () => time,
      })
      await updater.tick()
      expect(spawned).toEqual([["self-update", "0.0.2", "--channel", "latest", "--from", "0.0.1"]])
      callbacks[0]!(1)
      expect(readState().lastError).toMatchObject({ message: "the installer failed", version: "0.0.2", attempts: 3 })
    } finally {
      delete process.env.OPENCODE_BROWSER_HOME
    }
  })

  test("a successful self-update clears the failure and rechecks before deciding", async () => {
    const home = fakeHome()
    process.env.OPENCODE_BROWSER_HOME = home
    const globals = globalThis as { __OPENCODE_BROWSER_TARGET__?: string }
    globals.__OPENCODE_BROWSER_TARGET__ = "linux-x64"
    try {
      const runtime = runtimeAt(home, "0.0.15")
      const time = 1_000_000
      updateState(() => ({ checkedAt: time - 10 * 60_000, latest: "0.0.16", etag: '"one"', lastError: { message: "old", at: new Date(time - 20 * 60_000).toISOString(), version: "0.0.16", attempts: 1 } }))
      const spawned: string[][] = []
      const callbacks: ((code: number | null) => void)[] = []
      let idle = true
      const updater = createAutoUpdater({
        runtime,
        isIdle: () => idle,
        log: () => {},
        spawnChild: (args, onExit) => {
          // The channel moved on: this install follows it and lands 0.0.17, not the cached 0.0.16.
          if (args[0] === "self-update") executable(runtime.entry, "0.0.17")
          spawned.push([...args])
          callbacks.push(onExit)
          return process.pid
        },
        env: {},
        fetch: (async () => new Response(manifest({ version: "0.0.17" }), { status: 200 })) as unknown as typeof fetch,
        now: () => time,
      })
      await updater.tick()
      expect(spawned).toEqual([["self-update", "0.0.16", "--channel", "latest", "--from", "0.0.15"]])
      // Not idle for the recheck, so it stops before switching; the install itself already happened.
      idle = false
      callbacks[0]!(0)
      expect(readState().lastError).toBeUndefined()
      expect(readState().checkedAt).toBeUndefined()
      expect(readState().etag).toBeUndefined()
      expect(readState().installing).toBeUndefined()
      // The immediate tick re-reads the manifest, learns the real release and does not download 0.0.16 again.
      await Bun.sleep(10)
      expect(readState().latest).toBe("0.0.17")
      expect(readState().checkedAt).toBeDefined()
      expect(spawned).toHaveLength(1)
    } finally {
      delete process.env.OPENCODE_BROWSER_HOME
      delete globals.__OPENCODE_BROWSER_TARGET__
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
      expect(describeAutoUpdate(status)).toContain("0.0.2 available; the installer runs when no agent is using the browser")
      setStoredMode("notify")
      const notify = autoUpdateStatus({ runtime, env: {} })
      expect(notify.effective).toBe("notify")
      expect(describeAutoUpdate(notify)).toContain(`0.0.2 available; run \`${notify.cli} update\` to install it`)
      expect(describeAutoUpdate(notify)).not.toContain("installer runs")
      expect(describeAutoUpdate(autoUpdateStatus({ runtime: { ...runtime, kind: "npx" }, env: {} }))).toContain("npx resolves")
    } finally {
      delete process.env.OPENCODE_BROWSER_HOME
    }
  })
})
