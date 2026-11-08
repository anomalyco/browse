import { afterEach, describe, expect, test } from "bun:test"
import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createInterface } from "node:readline"
import { bundleCli } from "../bundle.ts"
import { legacyRuntime, settleLegacyHome } from "../src/setup/legacy.ts"
import { adoptLegacyRuntime, legacyEntry } from "../src/setup/legacy-runtime.ts"
import { migrateLegacy } from "../src/setup/migrate.ts"

const homes: string[] = []
afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true })
})

const write = (file: string, text: string, mode = 0o644) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text, { mode })
  fs.chmodSync(file, mode)
}

/** A realistic pre-XDG install: ~/.browse with settings, tokens, logs, the executable and old versions, plus the
 * opencode-browser data root that the last release wrote. */
function legacyHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "browse-migrate-"))
  homes.push(home)
  const old = path.join(home, ".browse")
  const oldData = path.join(home, ".local", "share", "opencode-browser")
  write(path.join(old, "settings.json"), JSON.stringify({ entry: path.join(old, "bin", "browse"), version: "0.0.9" }))
  write(path.join(old, "config.json"), JSON.stringify({ hostname: "127.0.0.1" }))
  write(path.join(old, "browser-tokens.json"), JSON.stringify({ profile: { token: "x", pairedAt: 1 } }), 0o600)
  write(path.join(old, "sessions.json"), JSON.stringify({ version: 1, sessions: [] }))
  write(path.join(old, "logs", "relay.log"), "relay started\n")
  write(path.join(old, "bin", "browse"), "#!/bin/sh\necho old\n", 0o755)
  write(path.join(old, "versions", "0.0.9", "browse"), "old version\n")
  write(path.join(oldData, "relay-token"), "token\n", 0o600)
  write(path.join(oldData, "secrets", "github.json"), "{\"profile\":\"private\"}\n", 0o600)
  write(path.join(oldData, "bin", "opencode-browser.mjs"), "// shim\n")
  return { home, old, oldData }
}

describe("migration from the old layouts", () => {
  test("moves every file, rewrites agent entries, deletes the old roots, and is idempotent", () => {
    const { home, old, oldData } = legacyHome()
    const oldBinary = path.join(old, "bin", "browse")
    const claude = path.join(home, ".claude.json")
    write(claude, JSON.stringify({ mcpServers: { browse: { type: "stdio", command: oldBinary, args: ["mcp"] } } }))
    const opencode = path.join(home, ".config", "opencode", "opencode.json")
    write(opencode, JSON.stringify({
      mcp: { servers: { browse: { type: "local", command: ["/usr/bin/node", path.join(oldData, "bin", "opencode-browser.mjs"), "mcp"] } } },
    }))
    const previousHome = process.env.OPENCODE_BROWSER_HOME
    delete process.env.OPENCODE_BROWSER_HOME
    try {
      const first = migrateLegacy(home)
      expect(first.moved).toBeGreaterThan(0)
      expect(first.rewritten).toBeGreaterThanOrEqual(2)
      expect(fs.existsSync(old)).toBe(false)
      expect(fs.existsSync(oldData)).toBe(false)

      const config = path.join(home, ".config", "browse")
      const data = path.join(home, ".local", "share", "browse")
      const state = path.join(home, ".local", "state", "browse")
      expect(JSON.parse(fs.readFileSync(path.join(config, "settings.json"), "utf8")).version).toBe("0.0.9")
      expect(JSON.parse(fs.readFileSync(path.join(config, "settings.json"), "utf8")).entry).toBe(path.join(home, ".local", "bin", process.platform === "win32" ? "browse.exe" : "browse"))
      expect(fs.readFileSync(path.join(config, "config.json"), "utf8")).toContain("127.0.0.1")
      expect(fs.existsSync(path.join(data, "browser-tokens.json"))).toBe(true)
      expect(fs.existsSync(path.join(data, "sessions.json"))).toBe(true)
      expect(fs.readFileSync(path.join(data, "relay-token"), "utf8")).toBe("token\n")
      expect(fs.existsSync(path.join(data, "secrets", "github.json"))).toBe(true)
      expect(fs.readFileSync(path.join(state, "logs", "relay.log"), "utf8")).toContain("relay started")
      expect(fs.existsSync(path.join(home, ".local", "bin", "browse"))).toBe(true)
      expect(fs.existsSync(path.join(home, ".local", "lib"))).toBe(false)
      if (process.platform !== "win32") {
        expect(fs.statSync(path.join(data, "relay-token")).mode & 0o777).toBe(0o600)
        expect(fs.statSync(path.join(data, "secrets", "github.json")).mode & 0o777).toBe(0o600)
        expect(fs.statSync(path.join(home, ".local", "bin", "browse")).mode & 0o777).toBe(0o755)
      }
      const newBinary = path.join(home, ".local", "bin", process.platform === "win32" ? "browse.exe" : "browse")
      expect(JSON.parse(fs.readFileSync(claude, "utf8")).mcpServers.browse).toEqual({ type: "stdio", command: newBinary, args: ["mcp"] })
      expect(JSON.parse(fs.readFileSync(opencode, "utf8")).mcp.servers.browse.command).toEqual(["browse", "mcp"])

      // A second run finds nothing to move or rewrite.
      expect(migrateLegacy(home)).toMatchObject({ moved: 0, rewritten: 0, removed: [] })
    } finally {
      if (previousHome === undefined) delete process.env.OPENCODE_BROWSER_HOME
      else process.env.OPENCODE_BROWSER_HOME = previousHome
    }
  })

  test("keeps ~/.browse when an agent config still points at the old binary", () => {
    const { home, old } = legacyHome()
    // A malformed agent config can't be rewritten safely; deleting the executable would leave it pointing at nothing.
    write(path.join(home, ".claude.json"), `{"mcpServers":{"browse":{"command":${JSON.stringify(path.join(old, "bin", "browse"))}`)
    const previousHome = process.env.OPENCODE_BROWSER_HOME
    delete process.env.OPENCODE_BROWSER_HOME
    try {
      migrateLegacy(home)
      expect(fs.existsSync(path.join(old, "bin", "browse"))).toBe(true)
      expect(fs.readFileSync(path.join(home, ".claude.json"), "utf8")).toContain(path.join(old, "bin", "browse"))
      // The next run still retries instead of treating the move as finished.
      expect(migrateLegacy(home).removed).not.toContain(old)
      expect(fs.existsSync(path.join(old, "bin", "browse"))).toBe(true)
    } finally {
      if (previousHome === undefined) delete process.env.OPENCODE_BROWSER_HOME
      else process.env.OPENCODE_BROWSER_HOME = previousHome
    }
  })

  test("never overwrites a file the new version already has", () => {
    const { home, old } = legacyHome()
    write(path.join(home, ".config", "browse", "settings.json"), "{\"entry\":\"new\"}\n")
    const previousHome = process.env.OPENCODE_BROWSER_HOME
    delete process.env.OPENCODE_BROWSER_HOME
    try {
      migrateLegacy(home)
      expect(fs.readFileSync(path.join(home, ".config", "browse", "settings.json"), "utf8")).toBe("{\"entry\":\"new\"}\n")
      expect(fs.existsSync(old)).toBe(false)
    } finally {
      if (previousHome === undefined) delete process.env.OPENCODE_BROWSER_HOME
      else process.env.OPENCODE_BROWSER_HOME = previousHome
    }
  })
})

const node = Bun.which("node") ?? "node"

/** A CLI stand-in: prints who it is for a command, or answers every MCP request with it. */
const fakeCli = (label: string) => `import { createInterface } from "node:readline"
const info = { label: ${JSON.stringify(label)}, argv1: process.argv[1], args: process.argv.slice(2), home: process.env.OPENCODE_BROWSER_HOME ?? null }
if (process.argv[2] !== "mcp") {
  console.log(JSON.stringify(info))
  process.exit(0)
}
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line)
  if (message.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: info }) + "\\n")
})
`

/** The self-managed runtime releases before 0.0.11 left (0.0.15-dev.108 under runtime/versions, run by their shim),
 * an opencode entry that runs the shim, and the npm global package a current release installed beside it. */
function oldRuntimeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "browse-takeover-"))
  homes.push(home)
  const oldData = path.join(home, ".local", "share", "opencode-browser")
  const shim = path.join(oldData, "bin", "opencode-browser.mjs")
  write(shim, fs.readFileSync(path.join(import.meta.dir, "fixtures", "legacy-shim.mjs"), "utf8"), 0o755)
  write(path.join(oldData, "runtime", "current.json"), JSON.stringify({ version: "0.0.15-dev.108", previous: "0.0.11-dev.75", channel: "dev" }), 0o600)
  const oldEntry = legacyEntry(oldData, "0.0.15-dev.108")
  write(path.join(path.dirname(path.dirname(oldEntry)), "package.json"), JSON.stringify({ name: "@opencode/browse", version: "0.0.15-dev.108" }))
  write(oldEntry, fakeCli("0.0.15-dev.108"))
  write(path.join(oldData, "relay-token"), "token\n", 0o600)
  const current = path.join(home, "global", "lib", "node_modules", "@opencode", "browse", "dist", "cli.mjs")
  write(path.join(path.dirname(path.dirname(current)), "package.json"), JSON.stringify({ name: "@opencode/browse", version: "0.0.16-dev.130" }))
  write(current, fakeCli("0.0.16-dev.130"))
  const opencode = path.join(home, ".config", "opencode", "opencode.json")
  // Old installs recorded node's absolute path.
  write(opencode, JSON.stringify({ mcp: { servers: { browse: { type: "local", command: [node, shim, "mcp"] } } } }))
  const runtime = { kind: "npm" as const, entry: current, version: "0.0.16-dev.130" }
  return { home, oldData, shim, oldEntry, current, opencode, runtime }
}

describe("taking over the old self-managed runtime", () => {
  test("a relay from a current install takes it over, and the old shim then starts that install", () => {
    const { home, oldData, shim, oldEntry, current, runtime } = oldRuntimeHome()
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
    // The shim still points OPENCODE_BROWSER_HOME at the old folder; once taken over that is no override.
    settleLegacyHome(env, legacyRuntime(home))
    expect(env.OPENCODE_BROWSER_HOME).toBeUndefined()
  })

  test("an agent's running shim moves its session onto the current install once the relay runs it", async () => {
    const { home, shim, current, runtime } = oldRuntimeHome()
    // The current install for real: this checkout bundled as npm's global package.
    const packageDir = path.dirname(path.dirname(current))
    fs.rmSync(path.join(packageDir, "dist"), { recursive: true })
    fs.symlinkSync(path.join(import.meta.dir, "..", "node_modules"), path.join(packageDir, "node_modules"), "junction")
    await bundleCli({ outdir: path.join(packageDir, "dist"), version: runtime.version })
    let relayVersion = "0.0.15-dev.108"
    using relay = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ version: relayVersion }) })
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(XDG_|OPENCODE_BROWSER_)/.test(name)))
    const agent = spawn(node, [shim, "mcp"], {
      env: { ...env, HOME: home, OPENCODE_BROWSER_PORT: String(relay.port), OPENCODE_BROWSER_UPDATE_CHECK: "0" },
      stdio: ["pipe", "pipe", "ignore"],
    })
    try {
      const answers = new Map<number, (message: { result?: Record<string, unknown> }) => void>()
      createInterface({ input: agent.stdout }).on("line", (line) => {
        const message = JSON.parse(line) as { id?: number; result?: Record<string, unknown> }
        if (typeof message.id === "number") answers.get(message.id)?.(message)
      })
      const request = (id: number, method: string, params = {}) => {
        const answer = new Promise<{ result?: Record<string, unknown> }>((resolve) => answers.set(id, resolve))
        agent.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n")
        return answer
      }
      expect((await request(1, "initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "0" } })).result?.label).toBe("0.0.15-dev.108")
      agent.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n")
      adoptLegacyRuntime(legacyRuntime(home), runtime)
      relayVersion = runtime.version
      // The shim starts the current install through the forwarder and replays initialize to it.
      expect((await request(2, "tools/list")).result?.tools).toHaveLength(18)
    } finally {
      agent.kill()
    }
  }, 60_000)

  test("migration waits until agents' running shims have had time to follow, then removes the old folder", () => {
    const { home, oldData, opencode, runtime } = oldRuntimeHome()
    const takenOver = Date.parse("2026-11-08T16:00:00Z")
    adoptLegacyRuntime(legacyRuntime(home), runtime, takenOver)
    const previousHome = process.env.OPENCODE_BROWSER_HOME
    delete process.env.OPENCODE_BROWSER_HOME
    try {
      migrateLegacy(home, takenOver + 60_000)
      expect(JSON.parse(fs.readFileSync(opencode, "utf8")).mcp.servers.browse.command).toEqual(["browse", "mcp"])
      expect(fs.readFileSync(path.join(home, ".local", "share", "browse", "relay-token"), "utf8")).toBe("token\n")
      expect(fs.existsSync(path.join(oldData, "runtime", "current.json"))).toBe(true)
      expect(migrateLegacy(home, takenOver + 11 * 60_000).removed).toEqual([oldData])
      expect(fs.existsSync(oldData)).toBe(false)
    } finally {
      if (previousHome === undefined) delete process.env.OPENCODE_BROWSER_HOME
      else process.env.OPENCODE_BROWSER_HOME = previousHome
    }
  })
})
