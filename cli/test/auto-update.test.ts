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
import { rolloutBucket } from "../src/update/release-service.ts"

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
      expect(spawned).toEqual([["self-update", "0.0.3", "--channel", "latest"]])
    } finally {
      delete process.env.OPENCODE_BROWSER_HOME
      delete globals.__OPENCODE_BROWSER_TARGET__
    }
  })

  test("keeps the stable executable matching the busy relay and installs and switches only when idle", async () => {
    const home = fakeHome()
    process.env.OPENCODE_BROWSER_HOME = home
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
      })
      await updater.tick()
      expect(installedVersion(runtime)).toBe(runtime.version)
      expect(spawned).toEqual([])
      idle = true
      await updater.tick()
      expect(spawned).toEqual([["self-update", "0.0.2", "--channel", "latest"]])
      expect(installedVersion(runtime)).toBe("0.0.2")
      expect(readState().installing).toMatchObject({ version: "0.0.2" })
      // An agent came back during the install: the restart still needs its own idle check.
      idle = false
      callbacks[0]!(0)
      await Bun.sleep(0)
      expect(spawned).toHaveLength(1)
      idle = true
      await updater.tick()
      expect(spawned[1]).toEqual(["runtime-switch", "0.0.2"])
    } finally {
      delete process.env.OPENCODE_BROWSER_HOME
    }
  })
})

describe("a runtime the old opencode-browser shim starts from runtime/versions", () => {
  const ok = { status: 0, stdout: "", stderr: "" }
  const writePackage = (dir: string, version: string) => {
    fs.mkdirSync(path.join(dir, "dist"), { recursive: true })
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "@opencode/browse", version }))
    fs.writeFileSync(path.join(dir, "dist", "cli.mjs"), "")
    return path.join(dir, "dist", "cli.mjs")
  }
  /** The layout releases before 0.0.11 left: 0.0.15-dev.108 under runtime/versions, and npm's global folder beside it. */
  function oldRuntime() {
    const home = fakeHome()
    const previous = { XDG_DATA_HOME: process.env.XDG_DATA_HOME, LOCALAPPDATA: process.env.LOCALAPPDATA, OPENCODE_BROWSER_HOME: process.env.OPENCODE_BROWSER_HOME }
    process.env.XDG_DATA_HOME = process.env.LOCALAPPDATA = path.join(home, "data")
    process.env.OPENCODE_BROWSER_HOME = home
    const versions = path.join(home, "data", "opencode-browser", "runtime", "versions")
    const runtime: Runtime = { kind: "npm", entry: writePackage(path.join(versions, "0.0.15-dev.108", "node_modules", "@opencode", "browse"), "0.0.15-dev.108"), version: "0.0.15-dev.108" }
    const globalRoot = path.join(home, "global", "lib", "node_modules")
    const npm = (install?: () => void, root = () => true) => async (_command: string, args: readonly string[]) => {
      if (args[0] === "root") return root() ? { ...ok, stdout: `${globalRoot}\n` } : { status: 1, stdout: "", stderr: "npm: not found" }
      install?.()
      return ok
    }
    const restore = () => {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
    return { runtime, global: path.join(globalRoot, "@opencode", "browse"), npm, restore }
  }

  test("npm install -g puts the update in npm's global folder, which is the version it reports", async () => {
    const { runtime, global, npm, restore } = oldRuntime()
    try {
      // 0.0.15's updater read the version back from runtime/versions, which npm never touches, and failed every time.
      const installed = await runInstaller({ runtime, version: "0.0.16-dev.130", run: npm(() => writePackage(global, "0.0.16-dev.130")), env: {} })
      expect(installed).toBe("0.0.16-dev.130")
    } finally {
      restore()
    }
  })

  test("an install it can't find in npm's global folder fails, rather than reporting the version it asked for", async () => {
    const { runtime, npm, restore } = oldRuntime()
    try {
      await expect(runInstaller({ runtime, version: "0.0.16-dev.130", run: npm(undefined, () => false), env: {} })).rejects.toThrow("npm root -g")
      await expect(runInstaller({ runtime, version: "0.0.16-dev.130", run: npm(), env: {} })).rejects.toThrow("isn't there")
    } finally {
      restore()
    }
  })

  test("a failed `npm root -g` is asked again on the next tick, not kept", async () => {
    const { runtime, global, npm, restore } = oldRuntime()
    try {
      const entry = writePackage(global, "0.0.16-dev.130")
      updateState(() => ({ checkedAt: Date.now(), latest: "0.0.16-dev.130" }))
      let rootWorks = false
      const spawned: { args: string[]; from: string }[] = []
      const updater = createAutoUpdater({
        runtime,
        isIdle: () => true,
        log: () => {},
        spawnChild: (args, _onExit, from) => (spawned.push({ args: [...args], from: from.entry }), 2 ** 22 + 12351),
        run: npm(undefined, () => rootWorks),
        env: {},
      })
      await updater.tick()
      expect(spawned).toEqual([])
      rootWorks = true
      await updater.tick()
      expect(spawned).toEqual([{ args: ["runtime-switch", "0.0.16-dev.130"], from: entry }])
    } finally {
      restore()
    }
  })

  test("the relay restarts from npm's global folder once the update is there", async () => {
    const { runtime, global, npm, restore } = oldRuntime()
    try {
      const entry = writePackage(global, "0.0.16-dev.130")
      updateState(() => ({ checkedAt: Date.now(), latest: "0.0.16-dev.130" }))
      const spawned: { args: string[]; from: string }[] = []
      const updater = createAutoUpdater({
        runtime,
        isIdle: () => true,
        log: () => {},
        spawnChild: (args, _onExit, from) => (spawned.push({ args: [...args], from: from.entry }), 2 ** 22 + 12350),
        run: npm(),
        env: {},
      })
      await updater.tick()
      expect(spawned).toEqual([{ args: ["runtime-switch", "0.0.16-dev.130"], from: entry }])
    } finally {
      restore()
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
