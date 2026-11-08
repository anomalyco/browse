import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { bundleCli } from "../bundle.ts"
import { mcpStdio, type McpReply } from "./support/mcp-stdio.ts"
import { freePort } from "./support/ports.ts"

// The MCP supervisor swapping servers when the installed version changes, run from the built package as npm installs
// it. A checkout never supervises, so these can't run src/main.ts.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "browse-mcp-supervisor-"))
const build = path.join(home, "build")
beforeAll(() => bundleCli({ outdir: build, version: "0.0.1" }), 30_000)
afterAll(() => {
  for (const server of serversUnder(home)) process.kill(server.pid)
  fs.rmSync(home, { recursive: true, force: true })
})

// The agent's MCP server inherits none of a supervisor's settings from whoever runs the tests.
const clean = { OPENCODE_BROWSER_CLIENT_PID: undefined, OPENCODE_BROWSER_MCP_DIRECT: undefined, OPENCODE_BROWSER_MCP_SESSION: undefined }
const initialize = { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "0" } }

/** Writes the package at `root` as npm lays it out, and returns its CLI bundle. */
function installPackage(root: string, version: string) {
  fs.cpSync(build, path.join(root, "dist"), { recursive: true })
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "@opencode/browse", version }))
  fs.symlinkSync(path.join(import.meta.dir, "../node_modules"), path.join(root, "node_modules"), "junction")
  return path.join(root, "dist", "cli.mjs")
}

/** The `mcp` processes running a CLI under `folder`. */
function serversUnder(folder: string) {
  const listing = spawnSync("ps", ["-Ao", "pid=,args="], { encoding: "utf8" }).stdout ?? ""
  return listing.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line)
    return match && match[2]!.includes(folder) && match[2]!.endsWith(" mcp") ? [{ pid: Number(match[1]), args: match[2]! }] : []
  })
}

const within = (ms: number, reply: Promise<McpReply>, what: string) =>
  Promise.race([reply, Bun.sleep(ms).then((): never => { throw new Error(`${what} wasn't answered within ${ms} ms`) })])

describe("MCP supervisor", () => {
  test("an older install's shim swaps to a version that supervises, and tool calls after the swap are answered", async () => {
    // The shim earlier installs wrote to bin/opencode-browser.mjs, which agents' configs still run until browse migrates
    // them. It supervises each runtime version it starts and replays initialize with the bare replay id.
    const root = path.join(home, "legacy")
    const runtime = path.join(root, "runtime")
    const versions = ["1.0.0", "1.0.1"].map((version) => {
      const folder = path.join(runtime, "versions", version)
      installPackage(path.join(folder, "node_modules", "@opencode", "browse"), version)
      return folder
    })
    const pick = (version: string) => fs.writeFileSync(path.join(runtime, "current.json"), JSON.stringify({ version }))
    pick("1.0.0")
    const shim = path.join(root, "bin", "opencode-browser.mjs")
    fs.mkdirSync(path.dirname(shim), { recursive: true })
    fs.copyFileSync(path.join(import.meta.dir, "fixtures", "legacy-shim.mjs"), shim)
    // Nothing listens on the relay port, so the shim swaps after a few checks instead of waiting for a relay.
    const mcp = mcpStdio({ home, port: await freePort(), command: ["node", shim], env: clean })
    const call = () => mcp.request("tools/call", { name: "secrets_list", arguments: {} })
    try {
      await within(10_000, mcp.request("initialize", initialize), "initialize")
      mcp.notify("notifications/initialized")
      expect((await within(10_000, call(), "the first tools/call")).result?.isError).toBe(false)
      pick("1.0.1")
      expect((await within(15_000, call(), "a tools/call during the swap")).result?.isError).toBe(false)
      expect((await within(5_000, call(), "a tools/call after the swap")).result?.isError).toBe(false)
      // The new version serves under the shim instead of supervising a second server of its own.
      if (process.platform !== "win32") expect(serversUnder(versions[1]!)).toHaveLength(1)
    } finally { mcp.close() }
  }, 40_000)

  test("a supervisor passes a replayed initialize it didn't send through to the client", async () => {
    const entry = installPackage(path.join(home, "npm", "lib", "node_modules", "@opencode", "browse"), "1.0.0")
    const mcp = mcpStdio({ home, port: await freePort(), command: ["node", entry], env: clean })
    try {
      const reply = await within(10_000, mcp.request("initialize", initialize, "opencode-browser-shim-initialize"), "the replayed initialize")
      expect(reply.result?.protocolVersion).toBe("2025-11-25")
    } finally { mcp.close() }
  }, 20_000)

  test("a new server that never answers the replayed initialize still gets the requests held for the swap", async () => {
    const pkg = path.join(home, "stuck", "lib", "node_modules", "@opencode", "browse")
    const entry = installPackage(pkg, "1.0.0")
    const port = await freePort()
    let relayState: "serving" | "draining" | "stopped" = "serving"
    const relay = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => {
      if (relayState === "stopped") return new Response(null, { status: 503 })
      const draining = relayState === "draining"
      if (draining) relayState = "stopped"
      return Response.json({ version: "1.0.0", draining })
    } })
    const mcp = mcpStdio({ home, port, command: ["node", entry], env: clean })
    const call = () => mcp.request("tools/call", { name: "secrets_list", arguments: {} })
    try {
      await within(10_000, mcp.request("initialize", initialize), "initialize")
      mcp.notify("notifications/initialized")
      expect((await within(10_000, call(), "the first tools/call")).result?.isError).toBe(false)
      // npm replaces the package in place with a server that answers everything except initialize.
      fs.writeFileSync(entry, `import { createInterface } from "node:readline"
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line)
  if (message.id === undefined || message.method === "initialize") return
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [], swapped: true } }) + "\\n")
})
`)
      fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "@opencode/browse", version: "1.0.10" }))
      expect((await within(3_000, call(), "a tools/call while the original relay still serves")).result?.isError).toBe(false)
      relayState = "draining"
      expect((await within(15_000, call(), "a tools/call held for the swap")).result?.swapped).toBe(true)
    } finally { mcp.close(); await relay.stop(true) }
  }, 40_000)
})
