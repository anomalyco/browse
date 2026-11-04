import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createInterface } from "node:readline"
import { compileCli, targets } from "../script/compile.ts"
import { processAlive, readCurrent, runtimeLayout, versionEntry, writeCurrent } from "../src/update/auto-update.ts"
import { freePort } from "./support/ports.ts"

// A binary install in a temporary data root, with two executables compiled from source as 0.0.1 and 0.0.2: bin/browse
// is the executable on PATH that agents' MCP entries run (`browse mcp`), runtime/versions/<version>/browse each
// version's copy. No browser.

const native = targets.find((item) => item.os === process.platform && item.arch === process.arch && !item.abi && item.avx2 !== false)
const root = fs.mkdtempSync(path.join(os.tmpdir(), "browse-binary-it-"))
const compiled = (version: string) => path.join(root, "compiled", version, "browse")
const pids: number[] = []

beforeAll(async () => {
  const build = new Date().toISOString()
  await Promise.all(["0.0.1", "0.0.2"].map((version) => compileCli({ item: native!, outfile: compiled(version), version, build })))
}, 120_000)

afterAll(() => {
  for (const pid of pids) if (processAlive(pid)) process.kill(pid, "SIGKILL")
  fs.rmSync(root, { recursive: true, force: true })
})

/** A data root whose bin/browse and versions/0.0.1/browse are 0.0.1, and current.json names it. */
function install(name: string) {
  const layout = runtimeLayout(path.join(root, name))
  const binary = path.join(layout.root, "bin", "browse")
  for (const file of [binary, versionEntry(layout, "0.0.1", true)]) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.copyFileSync(compiled("0.0.1"), file)
  }
  writeCurrent(layout, { version: "0.0.1", channel: "latest", binary })
  return { layout, binary }
}

describe.skipIf(!native || process.platform === "win32")("a binary install", () => {
  test("`browse mcp`, the command install configures, runs the supervisor, which serves from the current version", async () => {
    const { layout, binary } = install("supervised")
    // The current version's server, as the supervisor would start it: a stand-in that names itself.
    fs.writeFileSync(versionEntry(layout, "0.0.1", true), `#!/usr/bin/env node
import { createInterface } from "node:readline"
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line)
  if (message.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { serverInfo: { name: "supervised", direct: process.env.OPENCODE_BROWSER_MCP_DIRECT } } }) + "\\n")
})
`)
    const mcp = spawn(binary, ["mcp"], { env: { PATH: process.env.PATH ?? "", HOME: layout.root, OPENCODE_BROWSER_HOME: layout.root, OPENCODE_BROWSER_PORT: String(await freePort()) }, stdio: ["pipe", "pipe", "inherit"] })
    try {
      const answer = new Promise<{ result: { serverInfo: { name: string; direct?: string } } }>((resolve) =>
        createInterface({ input: mcp.stdout! }).once("line", (line) => resolve(JSON.parse(line))),
      )
      mcp.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } }) + "\n")
      expect((await answer).result.serverInfo).toEqual({ name: "supervised", direct: "1" })
    } finally {
      mcp.kill("SIGKILL")
    }
  }, 30_000)

  test("a failed `browse update` from PATH puts the old executable back on PATH and brings its relay back", async () => {
    const { layout, binary } = install("restore")
    const port = await freePort()
    const env = { PATH: process.env.PATH ?? "", HOME: layout.root, OPENCODE_BROWSER_HOME: layout.root, OPENCODE_BROWSER_PORT: String(port), OPENCODE_BROWSER_AUTO_UPDATE: "off" }
    // 0.0.2 passes the check before the switch, but its managed relay exits at once.
    fs.mkdirSync(path.dirname(versionEntry(layout, "0.0.2", true)), { recursive: true })
    fs.writeFileSync(versionEntry(layout, "0.0.2", true), `#!/bin/sh
if [ "$1" = serve ] && [ "$OPENCODE_BROWSER_MANAGED_RELAY" = 1 ]; then exit 1; fi
exec "${compiled("0.0.2")}" "$@"
`, { mode: 0o755 })
    const version = () => fetch(`http://127.0.0.1:${port}/version`).then((response) => response.json() as Promise<{ version: string; pid: number }>)
    const relay = spawn(binary, ["serve"], { env: { ...env, OPENCODE_BROWSER_MANAGED_RELAY: "1" }, stdio: "ignore", detached: true })
    pids.push(relay.pid!)
    for (let tries = 0; !(await version().catch(() => undefined)); tries++) {
      if (tries > 200) throw new Error("the 0.0.1 relay didn't start")
      await Bun.sleep(100)
    }

    // What `browse update` does once 0.0.2 is installed, run from the executable on PATH as `browse update` is.
    const result = spawnSync(binary, ["runtime-switch", "0.0.2"], { env, encoding: "utf8", timeout: 90_000 })
    const back = await version()
    pids.push(back.pid)
    expect(result.status).toBe(1)
    expect(result.stdout).toContain("skipping 0.0.2 until a newer version is published")
    expect(spawnSync(binary, ["--version"], { encoding: "utf8" }).stdout.trim()).toBe("0.0.1")
    expect(back.version).toBe("0.0.1")
    expect(readCurrent(layout)).toMatchObject({ version: "0.0.1", binary })
  }, 120_000)
})
