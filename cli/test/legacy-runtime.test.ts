import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { bundleCli } from "../bundle.ts"
import { legacyRuntime, settleLegacyHome } from "../src/setup/legacy.ts"
import { adoptLegacyRuntime, commitLegacyTakeover, currentInstall, prepareLegacyTakeover } from "../src/setup/legacy-runtime.ts"
import { migrateLegacy } from "../src/setup/migrate.ts"
import { node, oldRuntimeHome, relayToken, withoutHomeOverride, write } from "./support/legacy-runtime.ts"
import { mcpStdio, type McpReply } from "./support/mcp-stdio.ts"
import { freePort } from "./support/ports.ts"

// Taking over the self-managed runtime releases before 0.0.11 left (setup/legacy-runtime.ts), with the real old shim.
const homes: string[] = []
afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true })
})
// A real build, which the tests install as npm's global package (a checkout never supervises its MCP server).
const build = fs.mkdtempSync(path.join(os.tmpdir(), "browse-takeover-build-"))
beforeAll(() => bundleCli({ outdir: build, version: "0.0.1" }), 30_000)
afterAll(() => fs.rmSync(build, { recursive: true, force: true }))

/** Puts the real build at `packageDir` as `version`, as npm install -g replaces a package. */
function installBuild(packageDir: string, version: string) {
  fs.rmSync(path.join(packageDir, "dist"), { recursive: true, force: true })
  fs.cpSync(build, path.join(packageDir, "dist"), { recursive: true })
  fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ name: "@opencode/browse", version }))
  if (!fs.existsSync(path.join(packageDir, "node_modules"))) fs.symlinkSync(path.join(import.meta.dir, "../node_modules"), path.join(packageDir, "node_modules"), "junction")
}

/** The environment of a process an agent starts, without the test runner's browse or XDG settings. */
const agentEnv = (home: string, port: number) => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(XDG_|OPENCODE_BROWSER_)/.test(name))),
  HOME: home,
  OPENCODE_BROWSER_PORT: String(port),
  OPENCODE_BROWSER_AUTO_UPDATE: "off",
})

/** The `mcp` processes running a CLI under `folder`. */
function serversUnder(folder: string) {
  const listing = spawnSync("ps", ["-Ao", "pid=,args="], { encoding: "utf8" }).stdout ?? ""
  return listing.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line)
    return match && match[2]!.includes(folder) && match[2]!.endsWith(" mcp") ? [Number(match[1])] : []
  })
}

const within = (ms: number, reply: Promise<McpReply>, what: string) =>
  Promise.race([reply, Bun.sleep(ms).then((): never => { throw new Error(`${what} wasn't answered within ${ms} ms`) })])

const until = async (check: () => boolean, ms = 15_000) => {
  for (const start = Date.now(); Date.now() - start < ms; await Bun.sleep(100)) if (check()) return true
  return check()
}

describe("taking over the old self-managed runtime", () => {
  test("once taken over, the old shim starts the current install, and the old folder is no override", () => {
    const { home, oldData, shim, oldEntry, current, runtime } = oldRuntimeHome(homes)
    // While the old runtime is active, browse shares its folder with the relay the shim started.
    const env: NodeJS.ProcessEnv = {}
    settleLegacyHome(env, legacyRuntime(home))
    expect(env.OPENCODE_BROWSER_HOME).toBe(oldData)
    // A relay running from the old runtime itself has nothing to hand over to.
    expect(adoptLegacyRuntime(legacyRuntime(home), { ...runtime, entry: oldEntry, version: "0.0.15-dev.108" })).toBe(false)

    expect(adoptLegacyRuntime(legacyRuntime(home), runtime, Date.parse("2026-11-08T16:00:00Z"))).toBe(true)
    expect(legacyRuntime(home)).toMatchObject({ version: "0.0.16-dev.130", movedTo: current, switchedAt: "2026-11-08T16:00:00.000Z" })
    const ran = spawnSync(node, [shim, "status"], { encoding: "utf8", env: { ...process.env, OPENCODE_BROWSER_HOME: "" } })
    expect(JSON.parse(ran.stdout)).toMatchObject({ label: "0.0.16-dev.130", argv1: current, args: ["status"] })
    settleLegacyHome(env, legacyRuntime(home))
    expect(env.OPENCODE_BROWSER_HOME).toBeUndefined()
  })

  test("a binary takeover finds the installer's executable, not one under the old folder the shim points at", () => {
    const { home, oldData } = oldRuntimeHome(homes)
    const executable = path.join(home, ".local", "bin", "browse")
    write(executable, "#!/bin/sh\n", 0o755)
    const previous = process.env.OPENCODE_BROWSER_HOME
    process.env.OPENCODE_BROWSER_HOME = oldData
    try {
      expect(currentInstall({ compiled: true, execPath: executable, home })).toMatchObject({ kind: "binary", entry: executable })
      expect(currentInstall({ compiled: true, execPath: path.join(home, "Downloads", "browse"), home })).toBeUndefined()
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_BROWSER_HOME
      else process.env.OPENCODE_BROWSER_HOME = previous
    }
  })

  test("a relay takes over only when it gets the port: the old files win the copy, and current.json moves once it listens", async () => {
    const { home, oldData, opencode, runtime } = oldRuntimeHome(homes)
    const token = path.join(home, ".local", "share", "browse", "relay-token")
    write(token, "stale\n", 0o600)
    const before = fs.readFileSync(path.join(oldData, "runtime", "current.json"), "utf8")
    using busy = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") })
    const busyEnv: NodeJS.ProcessEnv = { OPENCODE_BROWSER_HOME: oldData, OPENCODE_BROWSER_PORT: String(busy.port) }
    expect(await prepareLegacyTakeover(legacyRuntime(home), { install: runtime, env: busyEnv, home })).toBe(false)
    const isolated: NodeJS.ProcessEnv = { OPENCODE_BROWSER_HOME: path.join(home, "isolated"), OPENCODE_BROWSER_PORT: String(await freePort()) }
    expect(await prepareLegacyTakeover(legacyRuntime(home), { install: runtime, env: isolated, home })).toBe(false)
    expect(busyEnv.OPENCODE_BROWSER_HOME).toBe(oldData)
    expect(fs.readFileSync(token, "utf8")).toBe("stale\n")

    const env: NodeJS.ProcessEnv = { OPENCODE_BROWSER_HOME: oldData, OPENCODE_BROWSER_PORT: String(await freePort()) }
    expect(await prepareLegacyTakeover(legacyRuntime(home), { install: runtime, env, home })).toBe(true)
    expect(env.OPENCODE_BROWSER_HOME).toBeUndefined()
    expect(fs.readFileSync(token, "utf8")).toBe(`${relayToken}\n`)
    expect(fs.readFileSync(path.join(oldData, "runtime", "current.json"), "utf8")).toBe(before)
    expect(JSON.parse(fs.readFileSync(opencode, "utf8")).mcp.servers.browse.command).not.toEqual(["browse", "mcp"])

    expect(await withoutHomeOverride(() => commitLegacyTakeover())).toBe(true)
    expect(legacyRuntime(home)).toMatchObject({ version: runtime.version, movedTo: runtime.entry })
    expect(JSON.parse(fs.readFileSync(opencode, "utf8")).mcp.servers.browse.command).toEqual(["browse", "mcp"])
  })

  test("`serve` from the current install leaves the old runtime alone for help, a taken port or another home, and takes it over once it listens", async () => {
    const { home, oldData, packageDir, current, opencode } = oldRuntimeHome(homes)
    installBuild(packageDir, "0.0.16-dev.130")
    const record = path.join(oldData, "runtime", "current.json")
    const before = fs.readFileSync(record, "utf8")
    using busy = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") })
    const serve = (port: number, options: { home?: string; args?: string[]; timeout?: number } = {}) =>
      spawnSync(node, [current, "serve", ...(options.args ?? [])], {
        encoding: "utf8",
        timeout: options.timeout ?? 20_000,
        env: { ...agentEnv(home, port), OPENCODE_BROWSER_HOME: options.home ?? oldData },
      })
    serve(await freePort(), { args: ["--help"] })
    serve(busy.port!)
    // An isolated relay starts and keeps running; a takeover would have been published within moments of listening.
    serve(await freePort(), { home: path.join(home, "isolated"), timeout: 5_000 })
    expect(fs.readFileSync(record, "utf8")).toBe(before)

    const port = await freePort()
    const relay = spawn(node, [current, "serve"], { env: { ...agentEnv(home, port), OPENCODE_BROWSER_HOME: oldData }, stdio: "ignore" })
    try {
      expect(await until(() => legacyRuntime(home)?.movedTo === fs.realpathSync(current))).toBe(true)
      expect(((await (await fetch(`http://127.0.0.1:${port}/version`)).json()) as { pid: number }).pid).toBe(relay.pid!)
      expect(JSON.parse(fs.readFileSync(opencode, "utf8")).mcp.servers.browse.command).toEqual(["browse", "mcp"])
      expect(fs.readFileSync(path.join(home, ".local", "share", "browse", "relay-token"), "utf8")).toBe(`${relayToken}\n`)
    } finally {
      relay.kill()
    }
  }, 60_000)

  test("an agent's running shim moves its session onto the current install, which then follows the next update itself", async () => {
    const { home, shim, packageDir, runtime } = oldRuntimeHome(homes)
    installBuild(packageDir, runtime.version)
    // No relay: the shim and the supervisor swap after a few checks find none, and tools/call answers without one.
    const mcp = mcpStdio({
      home,
      port: await freePort(),
      command: [node, shim],
      env: { OPENCODE_BROWSER_HOME: undefined, OPENCODE_BROWSER_CLIENT_PID: undefined, OPENCODE_BROWSER_MCP_DIRECT: undefined, OPENCODE_BROWSER_MCP_SESSION: undefined },
    })
    const call = () => mcp.request("tools/call", { name: "secrets_list", arguments: {} })
    try {
      expect((await within(10_000, mcp.request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "0" } }), "initialize")).result?.label).toBe("0.0.15-dev.108")
      mcp.notify("notifications/initialized")
      adoptLegacyRuntime(legacyRuntime(home), runtime)
      expect((await within(15_000, call(), "a tools/call after the takeover")).result?.isError).toBe(false)
      // The current install supervises its own server: one server runs from the package, and a later update swaps it.
      expect(await until(() => serversUnder(packageDir).length === 1)).toBe(true)
      const [first] = serversUnder(packageDir)
      installBuild(packageDir, "0.0.16-dev.131")
      expect((await within(15_000, call(), "a tools/call during the next update")).result?.isError).toBe(false)
      expect(await until(() => serversUnder(packageDir).length === 1 && serversUnder(packageDir)[0] !== first)).toBe(true)
      expect((await within(5_000, call(), "a tools/call after the next update")).result?.isError).toBe(false)
    } finally {
      mcp.close()
      for (const pid of serversUnder(home)) process.kill(pid)
    }
  }, 60_000)

  test("migration waits until agents' running shims have had time to follow, then removes the old folder", () => {
    const { home, oldData, opencode, runtime } = oldRuntimeHome(homes)
    const takenOver = Date.parse("2026-11-08T16:00:00Z")
    adoptLegacyRuntime(legacyRuntime(home), runtime, takenOver)
    withoutHomeOverride(() => {
      migrateLegacy(home, takenOver + 60_000)
      expect(JSON.parse(fs.readFileSync(opencode, "utf8")).mcp.servers.browse.command).toEqual(["browse", "mcp"])
      expect(fs.readFileSync(path.join(home, ".local", "share", "browse", "relay-token"), "utf8")).toBe(`${relayToken}\n`)
      expect(fs.existsSync(path.join(oldData, "runtime", "current.json"))).toBe(true)
      expect(migrateLegacy(home, takenOver + 11 * 60_000).removed).toEqual([oldData])
      expect(fs.existsSync(oldData)).toBe(false)
    })
  })
})
