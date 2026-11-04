import { afterAll, describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

// The real MCP server over stdio, answering a pre-2026 client (initialize) and a 2026-07-28 client (request metadata).
const home = fs.mkdtempSync(path.join(os.tmpdir(), "browse-mcp-protocol-"))
afterAll(() => fs.rmSync(home, { recursive: true, force: true }))

const modernMeta = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "test", version: "0" },
}

function server() {
  const child = spawn(process.execPath, [path.join(import.meta.dir, "..", "src", "main.ts"), "mcp"], {
    stdio: ["pipe", "pipe", "ignore"],
    env: { ...process.env, OPENCODE_BROWSER_HOME: home, OPENCODE_BROWSER_AUTOSTART: "false", OPENCODE_BROWSER_UPDATE_CHECK: "0" },
  })
  const pending = new Map<number, (message: { result?: Record<string, unknown>; error?: unknown }) => void>()
  let buffer = ""
  let id = 0
  child.stdout.on("data", (chunk) => {
    buffer += chunk
    for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
      const message = JSON.parse(buffer.slice(0, index))
      buffer = buffer.slice(index + 1)
      pending.get(message.id)?.(message)
    }
  })
  const request = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<{ result?: Record<string, unknown>; error?: unknown }>((resolve) => {
      pending.set(++id, resolve)
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n")
    })
  return { request, notify: (method: string) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n"), close: () => child.kill() }
}

describe("MCP protocol versions", () => {
  test("a client that initializes with 2025-11-25 lists and calls tools", async () => {
    const mcp = server()
    const init = await mcp.request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "0" } })
    expect(init.result?.protocolVersion).toBe("2025-11-25")
    mcp.notify("notifications/initialized")
    expect(((await mcp.request("tools/list")).result?.tools as unknown[]).length).toBeGreaterThan(0)
    expect((await mcp.request("tools/call", { name: "session_current", arguments: {} })).result?.isError).toBe(false)
    mcp.close()
  }, 30_000)

  test("a 2026-07-28 client discovers the server and calls tools without initializing", async () => {
    const mcp = server()
    const discover = await mcp.request("server/discover", { _meta: modernMeta })
    expect(discover.result?.supportedVersions).toContain("2026-07-28")
    expect(((await mcp.request("tools/list", { _meta: modernMeta })).result?.tools as unknown[]).length).toBeGreaterThan(0)
    const first = await mcp.request("tools/call", { name: "session_current", arguments: {}, _meta: modernMeta })
    const second = await mcp.request("tools/call", { name: "session_current", arguments: {}, _meta: modernMeta })
    expect(first.result?.isError).toBe(false)
    // Without protocol sessions, the server's implicit browse session still lasts for the connection.
    expect(second.result?.structuredContent).toEqual(first.result?.structuredContent)
    mcp.close()
  }, 30_000)
})
