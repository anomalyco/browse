import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { parse } from "jsonc-parser"
import { legacyRootsLeft, legacyRuntime } from "../src/setup/legacy.ts"
import { adoptLegacyRuntime } from "../src/setup/legacy-runtime.ts"
import { migrateLegacy } from "../src/setup/migrate.ts"
import { node, oldRuntimeHome, withoutHomeOverride } from "./support/legacy-runtime.ts"

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

describe("stored credentials of removed features", () => {
  test("migration removes site secret and secret profile folders, idempotently and without throwing", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "browse-remove-secrets-"))
    homes.push(home)
    const data = path.join(home, ".local", "share", "browse")
    write(path.join(data, "site-secrets", "example.json"), "{}\n", 0o600)
    write(path.join(data, "secrets", "profile.json"), "{}\n", 0o600)
    write(path.join(data, "relay-token"), "token\n", 0o600)
    const previousHome = process.env.OPENCODE_BROWSER_HOME
    delete process.env.OPENCODE_BROWSER_HOME
    try {
      migrateLegacy(home)
      expect(fs.existsSync(path.join(data, "site-secrets"))).toBe(false)
      expect(fs.existsSync(path.join(data, "secrets"))).toBe(false)
      expect(fs.readFileSync(path.join(data, "relay-token"), "utf8")).toBe("token\n")
      // A second run is a no-op and a missing data root is fine.
      expect(migrateLegacy(home)).toMatchObject({ moved: 0, rewritten: 0, removed: [] })
    } finally {
      if (previousHome === undefined) delete process.env.OPENCODE_BROWSER_HOME
      else process.env.OPENCODE_BROWSER_HOME = previousHome
    }
  })
})

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
      // Stored credentials of removed features are not carried over.
      expect(fs.existsSync(path.join(data, "secrets"))).toBe(false)
      expect(fs.readFileSync(path.join(state, "logs", "relay.log"), "utf8")).toContain("relay started")
      expect(fs.existsSync(path.join(home, ".local", "bin", "browse"))).toBe(true)
      expect(fs.existsSync(path.join(home, ".local", "lib"))).toBe(false)
      if (process.platform !== "win32") {
        expect(fs.statSync(path.join(data, "relay-token")).mode & 0o777).toBe(0o600)
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

describe("migration after the old self-managed runtime was taken over", () => {
  const takenOver = Date.parse("2026-11-08T16:00:00Z")
  /** The old runtime once a relay from a current install took it over (legacy-runtime.ts). */
  function takenOverHome() {
    const fixture = oldRuntimeHome(homes)
    adoptLegacyRuntime(legacyRuntime(fixture.home), fixture.runtime, takenOver)
    return fixture
  }

  test("a dev extension the browser loads from the old folder keeps loading, from the folder updates replace", () => {
    const { home, oldData } = takenOverHome()
    write(path.join(oldData, "extension", "manifest.json"), JSON.stringify({ version: "1" }))
    const loaded = path.join(oldData, "extension", "manifest.json")
    const folder = path.join(home, ".cache", "browse", "extension")
    withoutHomeOverride(() => migrateLegacy(home, takenOver + 60_000))
    expect(fs.lstatSync(path.join(oldData, "extension")).isSymbolicLink()).toBe(true)
    // A dev relay updates the extension by swapping the cache folder; the path the browser loaded sees it.
    fs.renameSync(folder, `${folder}-old`)
    write(path.join(folder, "manifest.json"), JSON.stringify({ version: "2" }))
    expect(JSON.parse(fs.readFileSync(loaded, "utf8")).version).toBe("2")
    // Past the grace period everything else in the old folder goes, the link stays, and migration has nothing left.
    withoutHomeOverride(() => migrateLegacy(home, takenOver + 11 * 60_000))
    expect(fs.readdirSync(oldData)).toEqual(["extension"])
    expect(JSON.parse(fs.readFileSync(loaded, "utf8")).version).toBe("2")
    expect(legacyRootsLeft(home)).toBe(false)
  })

  test("a run stopped before its extension link was in place is finished by the next one", () => {
    const { home, oldData } = takenOverHome()
    // The folder already moved to the cache and the old path is gone, but the link never got renamed into place.
    const folder = path.join(home, ".cache", "browse", "extension")
    write(path.join(folder, "manifest.json"), JSON.stringify({ version: "1" }))
    fs.symlinkSync(folder, path.join(oldData, "extension.link-2147483646"), "junction")
    withoutHomeOverride(() => migrateLegacy(home, takenOver + 11 * 60_000))
    expect(fs.readdirSync(oldData)).toEqual(["extension"])
    expect(fs.lstatSync(path.join(oldData, "extension")).isSymbolicLink()).toBe(true)
    expect(JSON.parse(fs.readFileSync(path.join(oldData, "extension", "manifest.json"), "utf8")).version).toBe("1")
  })

  test("browse entries in opencode.jsonc and in configs settings.json recorded move to `browse mcp` before the shim goes", () => {
    const { home, oldData, shim, opencode } = takenOverHome()
    fs.rmSync(opencode)
    const jsonc = path.join(home, ".config", "opencode", "opencode.jsonc")
    const entry = { type: "local", command: [node, shim, "mcp"] }
    write(jsonc, `{\n  // mine\n  "mcp": { "servers": { "browse": ${JSON.stringify(entry)} } }\n}\n`)
    const project = path.join(home, "project", ".opencode", "opencode.jsonc")
    write(project, JSON.stringify({ mcp: { servers: { browse: entry } } }))
    write(path.join(oldData, "settings.json"), JSON.stringify({ opencodeConfigs: [project] }))
    withoutHomeOverride(() => migrateLegacy(home, takenOver + 11 * 60_000))
    for (const file of [jsonc, project]) {
      const server = parse(fs.readFileSync(file, "utf8")).mcp.servers.browse
      expect(server.command).toEqual(["browse", "mcp"])
      expect(server).toMatchObject({ cwd: "~", pool: true })
    }
    expect(fs.readFileSync(jsonc, "utf8")).toContain("// mine")
    expect(fs.existsSync(oldData)).toBe(false)
  })

  test("a file deleted from the new folders during the grace period stays deleted", () => {
    const { home, oldData } = takenOverHome()
    write(path.join(oldData, "browser-tokens.json"), "{}\n", 0o600)
    const secret = path.join(home, ".local", "share", "browse", "browser-tokens.json")
    withoutHomeOverride(() => migrateLegacy(home, takenOver + 60_000))
    expect(fs.existsSync(secret)).toBe(true)
    fs.rmSync(secret)
    withoutHomeOverride(() => migrateLegacy(home, takenOver + 2 * 60_000))
    expect(fs.existsSync(secret)).toBe(false)
    // The shim still finds current.json meanwhile.
    expect(fs.existsSync(path.join(oldData, "runtime", "current.json"))).toBe(true)
  })
})
