import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
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
