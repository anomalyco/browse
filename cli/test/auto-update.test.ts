import { afterEach, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { autoUpdateStatus, channelOf, compareVersions, createAutoUpdater, describeAutoUpdate, installVersion, processAlive, pruneVersions, readCurrent, readState, runtimeLayout, skipBroken, switchVersion, tarFile, updateState, validatePending, verifyStarts, versionEntry, writeCurrent, type Layout } from "../src/update/auto-update.ts"
import { managedRelayLaunch } from "../src/relay/lifecycle.ts"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function layoutWith(versions: string[]): Layout {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "browse-autoupdate-"))
  roots.push(root)
  const layout = runtimeLayout(root)
  for (const version of versions) {
    fs.mkdirSync(path.dirname(versionEntry(layout, version)), { recursive: true })
    fs.writeFileSync(versionEntry(layout, version), "")
  }
  return layout
}

const installed = (layout: Layout) => fs.readdirSync(layout.versions).sort()

test("install keeps the running package and its dependencies when the npx cache disappears", async () => {
  const layout = layoutWith([])
  const cache = path.join(roots.at(-1)!, "cache with spaces", "node_modules")
  const source = path.join(cache, "@opencode/browse")
  fs.mkdirSync(path.join(source, "dist"), { recursive: true })
  fs.writeFileSync(path.join(source, "package.json"), JSON.stringify({ version: "1.2.3", dependencies: { fixture: "1" } }))
  fs.writeFileSync(path.join(source, "dist/cli.mjs"), 'import version from "fixture"; console.log(version)')
  fs.mkdirSync(path.join(cache, "fixture"))
  fs.writeFileSync(path.join(cache, "fixture/package.json"), JSON.stringify({ main: "index.cjs" }))
  fs.writeFileSync(path.join(cache, "fixture/index.cjs"), 'module.exports = "1.2.3"')
  const entry = await installVersion({ layout, version: "1.2.3", runningPackage: source, verify: false })
  fs.rmSync(cache, { recursive: true })
  expect((await Bun.$`node ${entry} --version`.text()).trim()).toBe("1.2.3")
})

describe("a binary install", () => {
  test("reads the executable out of its platform package's tarball", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "browse-tarball-"))
    roots.push(root)
    fs.mkdirSync(path.join(root, "package", "bin"), { recursive: true })
    fs.writeFileSync(path.join(root, "package", "package.json"), "{}")
    fs.writeFileSync(path.join(root, "package", "bin", "browse"), "executable bytes")
    const made = spawnSync("tar", ["czf", path.join(root, "pkg.tgz"), "-C", root, "package"])
    expect(made.status).toBe(0)
    const tgz = fs.readFileSync(path.join(root, "pkg.tgz"))
    expect(tarFile(tgz, "package/bin/browse")?.toString()).toBe("executable bytes")
    expect(tarFile(tgz, "package/bin/browse.exe")).toBeUndefined()
  })

  test("switching puts the version's executable on PATH by rename, and back for rollback", () => {
    const layout = layoutWith([])
    const binary = path.join(layout.root, "bin", "browse")
    fs.mkdirSync(path.dirname(binary), { recursive: true })
    fs.writeFileSync(binary, "old")
    for (const version of ["1.0.0", "1.0.1"]) {
      fs.mkdirSync(path.dirname(versionEntry(layout, version, true)), { recursive: true })
      fs.writeFileSync(versionEntry(layout, version, true), version)
    }
    // A process still running the old executable keeps its file.
    const running = fs.openSync(binary, "r")
    switchVersion(layout, "1.0.1", "1.0.0", binary)
    expect(fs.readFileSync(binary, "utf8")).toBe("1.0.1")
    expect(fs.readFileSync(running, "utf8")).toBe("old")
    fs.closeSync(running)
    expect(readCurrent(layout)).toMatchObject({ version: "1.0.1", previous: "1.0.0", binary })
    // No npm shim for a binary install.
    expect(fs.existsSync(layout.shim)).toBe(false)
    switchVersion(layout, "1.0.0", "1.0.1", binary)
    expect(fs.readFileSync(binary, "utf8")).toBe("1.0.0")
    expect(fs.readdirSync(path.dirname(binary))).toEqual(["browse"])
  })

  test("the relay starts from an executable entry by itself", () => {
    expect(managedRelayLaunch("/home/u/.browse/bin/browse", "/usr/bin/node", ["--flag"])).toEqual({ executable: "/home/u/.browse/bin/browse", args: ["serve"] })
    expect(managedRelayLaunch("/pkg/dist/cli.mjs", "/usr/bin/node", [])).toEqual({ executable: "/usr/bin/node", args: ["/pkg/dist/cli.mjs", "serve"] })
  })
})

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

describe("pruning", () => {
  test("never removes the current, previous or pending version", () => {
    const layout = layoutWith(["0.0.1", "0.0.2", "0.0.3", "0.0.4", "0.0.5"])
    writeCurrent(layout, { version: "0.0.3", previous: "0.0.2", channel: "latest" })
    updateState(layout, (state) => ({ ...state, pending: "0.0.5" }))
    pruneVersions(layout)
    expect(installed(layout)).toEqual(["0.0.2", "0.0.3", "0.0.5"])
  })

  test("keeps another process's install in progress, removes an abandoned one", () => {
    const layout = layoutWith(["0.0.1"])
    writeCurrent(layout, { version: "0.0.1", channel: "latest" })
    const live = `.install-${process.pid}-1`
    // A pid that isn't running: past the usual pid range.
    const dead = `.install-${2 ** 22 + 12345}-1`
    for (const name of [live, dead]) fs.mkdirSync(path.join(layout.versions, name))
    pruneVersions(layout)
    expect(installed(layout)).toEqual([live, "0.0.1"].sort())
  })
})

describe("a pending version whose directory is gone", () => {
  test("is cleared", () => {
    const layout = layoutWith(["0.0.1"])
    updateState(layout, (state) => ({ ...state, pending: "0.0.2" }))
    expect(validatePending(layout).pending).toBeUndefined()
    expect(readState(layout).pending).toBeUndefined()
  })

  test("is installed again instead of failing to switch on every tick", async () => {
    const layout = layoutWith(["0.0.1"])
    writeCurrent(layout, { version: "0.0.1", channel: "latest" })
    updateState(layout, (state) => ({ ...state, checkedAt: Date.now(), latest: "0.0.2", integrity: "sha512-x", pending: "0.0.2" }))
    const spawned: string[][] = []
    const events: string[] = []
    const updater = createAutoUpdater({
      runtime: { layout, version: "0.0.1", current: readCurrent(layout)! },
      isIdle: () => true,
      log: (event) => events.push(event),
      spawnChild: (args) => (spawned.push([...args]), 4242),
      env: {},
    })
    await updater.tick()
    expect(spawned).toEqual([["runtime-install", "0.0.2", "--integrity", "sha512-x"]])
    expect(readState(layout).installing).toMatchObject({ version: "0.0.2", pid: 4242 })
    expect(events).not.toContain("autoupdate.error")
  })
})

describe("the relay's updater", () => {
  const setup = (state: Parameters<typeof updateState>[1], idle = true) => {
    const layout = layoutWith(["0.0.1", "0.0.2"])
    writeCurrent(layout, { version: "0.0.1", channel: "latest" })
    updateState(layout, (rest) => state({ ...rest, checkedAt: Date.now(), latest: "0.0.2", integrity: "sha512-x" }))
    const spawned: string[][] = []
    const events: string[] = []
    const updater = createAutoUpdater({
      runtime: { layout, version: "0.0.1", current: readCurrent(layout)! },
      isIdle: () => idle,
      log: (event) => events.push(event),
      spawnChild: (args) => (spawned.push([...args]), process.pid),
      env: {},
    })
    return { layout, spawned, events, updater }
  }

  test("waits for an installer that is still running", async () => {
    const { spawned, updater } = setup((state) => ({ ...state, installing: { version: "0.0.2", pid: process.pid, startedAt: Date.now() } }))
    await updater.tick()
    expect(spawned).toEqual([])
  })

  test("an installer that died after installing counts as installed, even if its state write was lost", async () => {
    const { layout, updater } = setup((state) => ({ ...state, installing: { version: "0.0.2", pid: 2 ** 22 + 12345, startedAt: Date.now() } }))
    await updater.tick()
    expect(readState(layout).installing).toBeUndefined()
    expect(readState(layout).lastError).toBeUndefined()
    expect(readState(layout).pending).toBe("0.0.2")
  })

  test("records an installer that died without finishing", async () => {
    const { layout, events, updater } = setup((state) => ({ ...state, installing: { version: "0.0.2", pid: 2 ** 22 + 12345, startedAt: Date.now() } }))
    fs.rmSync(path.join(layout.versions, "0.0.2"), { recursive: true })
    await updater.tick()
    expect(events).toContain("autoupdate.installer_gone")
    expect(readState(layout).installing).toBeUndefined()
    expect(readState(layout).lastError?.version).toBe("0.0.2")
  })

  test("switches through a runtime-switch child, never by moving current.json itself", async () => {
    const { layout, spawned, updater } = setup((state) => ({ ...state, pending: "0.0.2" }))
    await updater.tick()
    expect(spawned).toEqual([["runtime-switch", "0.0.2"]])
    expect(readCurrent(layout)?.version).toBe("0.0.1")
  })

  test("tells open status pages once a runtime-switch child exits, so a version it skipped shows", async () => {
    const layout = layoutWith(["0.0.1", "0.0.2"])
    writeCurrent(layout, { version: "0.0.1", channel: "latest" })
    updateState(layout, (state) => ({ ...state, checkedAt: Date.now(), latest: "0.0.2", integrity: "sha512-x", pending: "0.0.2" }))
    let exit: ((code: number | null) => void) | undefined
    let changes = 0
    const updater = createAutoUpdater({
      runtime: { layout, version: "0.0.1", current: readCurrent(layout)! },
      isIdle: () => true,
      log: () => {},
      onChange: () => void changes++,
      spawnChild: (_args, onExit) => ((exit = onExit), process.pid),
      env: {},
    })
    await updater.tick()
    const before = changes
    exit!(1)
    expect(changes).toBe(before + 1)
  })

  test("doesn't switch while an agent uses the browser", async () => {
    const { spawned, updater } = setup((state) => ({ ...state, pending: "0.0.2" }), false)
    await updater.tick()
    expect(spawned).toEqual([])
  })
})

describe("checking a version starts before switching to it", () => {
  // A stand-in CLI: `serve` answers /version as 1.0.1 on OPENCODE_BROWSER_PORT and records how it was started, and `mcp`
  // answers initialize and tools/list over stdio. `options` breaks one part of it.
  const standIn = (mark: string, options: { readonly mcp?: "crash" | "no tools"; readonly busyOnce?: true } = {}) => `
import http from "node:http"
import fs from "node:fs"
import { createInterface } from "node:readline"
const mark = ${JSON.stringify(mark)}
const record = (fields) => fs.appendFileSync(mark, JSON.stringify({ command: process.argv[2], pid: process.pid, ...fields }) + "\\n")
if (process.argv[2] === "serve") {
  if (${options.busyOnce === true} && !fs.existsSync(mark)) {
    record({})
    console.error("listen EADDRINUSE: address already in use 127.0.0.1:" + process.env.OPENCODE_BROWSER_PORT)
    process.exit(1)
  }
  record({ home: process.env.OPENCODE_BROWSER_HOME, tmp: process.env.TMPDIR, autoUpdate: process.env.OPENCODE_BROWSER_AUTO_UPDATE, managed: process.env.OPENCODE_BROWSER_MANAGED_RELAY })
  http.createServer((_, response) => response.end(JSON.stringify({ version: "1.0.1" }))).listen(Number(process.env.OPENCODE_BROWSER_PORT), "127.0.0.1")
} else if (process.argv[2] === "mcp") {
  ${options.mcp === "crash" ? `throw new SyntaxError("The requested module '@effect/ai' does not provide an export named 'McpServer'")` : ""}
  record({ port: process.env.OPENCODE_BROWSER_PORT })
  createInterface({ input: process.stdin }).on("line", (line) => {
    const message = JSON.parse(line)
    if (message.id === undefined) return
    const result = message.method === "initialize" ? { protocolVersion: message.params.protocolVersion } : { tools: ${options.mcp === "no tools" ? "[]" : `[{ name: "execute" }]`} }
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n")
  })
} else process.exit(2)
`
  const records = (mark: string) => fs.readFileSync(mark, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, string | number>)

  test("starts its relay and then its MCP server on a spare port, in a throwaway data root with updates off, and stops both", async () => {
    const layout = layoutWith(["1.0.1"])
    const mark = path.join(layout.root, "mark.jsonl")
    fs.writeFileSync(versionEntry(layout, "1.0.1"), standIn(mark))
    await verifyStarts(versionEntry(layout, "1.0.1"), "1.0.1", { env: { ...process.env, OPENCODE_BROWSER_MANAGED_RELAY: "1" } })
    const [relay, mcp] = records(mark)
    expect(relay).toMatchObject({ command: "serve", autoUpdate: "off" })
    expect(relay!.managed).toBeUndefined()
    expect(relay!.home).not.toBe(layout.root)
    // Its temporary files go in the throwaway root too, never the real temporary directory.
    expect(String(relay!.tmp).startsWith(String(relay!.home))).toBe(true)
    expect(fs.existsSync(String(relay!.home))).toBe(false)
    expect(mcp).toMatchObject({ command: "mcp" })
    for (const started of [relay!, mcp!]) expect(processAlive(Number(started.pid))).toBe(false)
  })

  test("fails with the error a version prints when its relay can't load, though `--version` works", async () => {
    const layout = layoutWith(["1.0.1"])
    fs.writeFileSync(versionEntry(layout, "1.0.1"), `
if (process.argv[2] === "--version") console.log("1.0.1")
else throw new SyntaxError("The requested module '@effect/platform-node-shared' does not provide an export named 'NodeWS'")
`)
    expect(spawnSync(process.execPath, [versionEntry(layout, "1.0.1"), "--version"], { encoding: "utf8" }).stdout.trim()).toBe("1.0.1")
    await expect(verifyStarts(versionEntry(layout, "1.0.1"), "1.0.1")).rejects.toThrow("1.0.1 didn't start: SyntaxError: The requested module '@effect/platform-node-shared' does not provide an export named 'NodeWS'")
  })

  test("fails when the relay starts but the MCP server doesn't load, or lists no tools", async () => {
    const layout = layoutWith(["1.0.1"])
    fs.writeFileSync(versionEntry(layout, "1.0.1"), standIn(path.join(layout.root, "crash.jsonl"), { mcp: "crash" }))
    await expect(verifyStarts(versionEntry(layout, "1.0.1"), "1.0.1")).rejects.toThrow("1.0.1 didn't start: its MCP server exited (SyntaxError: The requested module '@effect/ai' does not provide an export named 'McpServer')")
    fs.writeFileSync(versionEntry(layout, "1.0.1"), standIn(path.join(layout.root, "empty.jsonl"), { mcp: "no tools" }))
    await expect(verifyStarts(versionEntry(layout, "1.0.1"), "1.0.1")).rejects.toThrow("1.0.1 didn't start: its MCP server listed no tools")
  })

  test("tries once more on another port when something else took the spare one", async () => {
    const layout = layoutWith(["1.0.1"])
    const mark = path.join(layout.root, "mark.jsonl")
    fs.writeFileSync(versionEntry(layout, "1.0.1"), standIn(mark, { busyOnce: true }))
    await verifyStarts(versionEntry(layout, "1.0.1"), "1.0.1")
    expect(records(mark).map((started) => started.command)).toEqual(["serve", "serve", "mcp"])
  })

  test("fails when another version answers, or nothing does in time", async () => {
    const layout = layoutWith(["1.0.2", "1.0.3"])
    fs.writeFileSync(versionEntry(layout, "1.0.2"), standIn(path.join(layout.root, "mark.jsonl")))
    fs.writeFileSync(versionEntry(layout, "1.0.3"), "setInterval(() => {}, 1000)")
    await expect(verifyStarts(versionEntry(layout, "1.0.2"), "1.0.2", { timeoutMs: 1_000 })).rejects.toThrow("1.0.2 didn't start: its relay didn't answer within 1s")
    await expect(verifyStarts(versionEntry(layout, "1.0.3"), "1.0.3", { timeoutMs: 1_000 })).rejects.toThrow("1.0.3 didn't start: its relay didn't answer within 1s")
  })
})

describe("a version that didn't start", () => {
  test("is no longer pending, and is skipped until a newer version is published", async () => {
    const layout = layoutWith(["0.0.1", "0.0.2"])
    writeCurrent(layout, { version: "0.0.1", channel: "latest" })
    updateState(layout, (state) => ({ ...state, checkedAt: Date.now(), latest: "0.0.2", integrity: "sha512-x", pending: "0.0.2" }))
    skipBroken(layout, "0.0.2", "0.0.2 didn't start: SyntaxError: boom")
    expect(readState(layout)).toMatchObject({ skipped: "0.0.2", lastError: { version: "0.0.2", message: "0.0.2 didn't start: SyntaxError: boom" } })
    expect(readState(layout).pending).toBeUndefined()
    expect(installed(layout)).toEqual(["0.0.1"])
    const status = autoUpdateStatus({ layout, env: {}, runtime: { layout, version: "0.0.1", current: readCurrent(layout)! } })
    expect(describeAutoUpdate(status)).toContain("skipping 0.0.2 (it didn't start; `update` installs it again)")

    const spawned: string[][] = []
    const updater = () => createAutoUpdater({
      runtime: { layout, version: "0.0.1", current: readCurrent(layout)! },
      isIdle: () => true,
      log: () => {},
      spawnChild: (args) => (spawned.push([...args]), process.pid),
      env: {},
    })
    await updater().tick()
    expect(spawned).toEqual([])
    // A newer version is published: it's installed as usual.
    updateState(layout, (state) => ({ ...state, latest: "0.0.3" }))
    await updater().tick()
    expect(spawned).toEqual([["runtime-install", "0.0.3", "--integrity", "sha512-x"]])
  })
})
