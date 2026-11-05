import { runtimeLayout, switchVersion, versionEntry } from "../src/update/auto-update.ts"
import * as RelayHarness from "./relay-harness.ts"
import { afterAll, describe, expect, test } from "bun:test"
import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { bundleCli } from "../bundle.ts"
import { startRelay, stopRelay } from "./relay-harness.ts"
import { freePort } from "./support/ports.ts"

// The real MCP server over stdio, answering a pre-2026 client (initialize) and a 2026-07-28 client (request metadata).
const home = fs.mkdtempSync(path.join(os.tmpdir(), "browse-mcp-protocol-"))
afterAll(() => fs.rmSync(home, { recursive: true, force: true }))

const modernMeta = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "test", version: "0" },
}

function server(command = [process.execPath, path.join(import.meta.dir, "..", "src", "main.ts")], port?: number) {
  const child = spawn(command[0]!, [...command.slice(1), "mcp"], {
    stdio: ["pipe", "pipe", "ignore"],
    env: { ...process.env, HOME: home, OPENCODE_BROWSER_HOME: home, ...(port ? { OPENCODE_BROWSER_PORT: String(port) } : {}), OPENCODE_BROWSER_AUTOSTART: "false", OPENCODE_BROWSER_UPDATE_CHECK: "0" },
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

describe("binary auto-update", () => {
  test("an installed binary switches MCP builds between tool calls on the same connection", async () => {
    const layout = runtimeLayout(home)
    const versions = ["1.0.0", "1.0.1"] as const
    // Build under a throwaway package root so neither the checkout's version nor its dist-bin is touched.
    const cli = path.join(home, "cli")
    fs.cpSync(path.join(import.meta.dir, "../script"), path.join(cli, "script"), { recursive: true })
    for (const name of ["node_modules", "src", "tsconfig.json"]) fs.symlinkSync(path.join(import.meta.dir, "..", name), path.join(cli, name))
    const target = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`
    for (const version of versions) {
      const outfile = versionEntry(layout, version, true)
      fs.mkdirSync(path.dirname(outfile), { recursive: true })
      fs.writeFileSync(path.join(cli, "package.json"), JSON.stringify({ version }))
      await Bun.$`${process.execPath} ${path.join(cli, "script/compile.ts")} ${target}`.quiet()
      fs.renameSync(path.join(cli, "dist-bin", `browse-${target}`, "bin", path.basename(outfile)), outfile)
    }
    const binary = path.join(home, path.basename(versionEntry(layout, versions[0], true)))
    // An earlier npm install left this stable entry in an agent's config. The new version contains only a binary.
    fs.mkdirSync(path.dirname(layout.shim), { recursive: true })
    fs.writeFileSync(layout.shim, `await import(${JSON.stringify(pathToFileURL(versionEntry(layout, versions[0], false)).href)})`)
    switchVersion(layout, versions[0], undefined, binary)
    const port = await RelayHarness.freePort()
    const env = { ...process.env, HOME: home, OPENCODE_BROWSER_HOME: home, OPENCODE_BROWSER_PORT: String(port), OPENCODE_BROWSER_MANAGED_RELAY: "1", OPENCODE_BROWSER_UPDATE_CHECK: "0" }
    const relay = spawn(binary, ["serve"], { env, stdio: "ignore" })
    const relayVersion = () => fetch(`http://127.0.0.1:${port}/version`).then(r => r.json() as Promise<{ version: string; pid: number }>)
    const mcp = server([binary], port)
    let replacement: number | undefined
    let extension: RelayHarness.FakeExtension | undefined
    try {
      for (let n = 0; n < 100 && !await relayVersion().catch(() => false); n++) await Bun.sleep(50)
      extension = new RelayHarness.FakeExtension(home, port)
      expect(await extension.pair()).toBe(true)
      const shimVersion = spawnSync("node", [layout.shim, "--version"], { env, encoding: "utf8", timeout: 5000 })
      expect(shimVersion.stdout.trim(), shimVersion.stderr).toBe(versions[0])
      const legacy = server(["node", layout.shim], port)
      try {
        await legacy.request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "legacy", version: "0" } })
        legacy.notify("notifications/initialized")
        expect((await legacy.request("tools/list")).result?.tools).toHaveLength(29)
      } finally { legacy.close() }
      await mcp.request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "0" } })
      mcp.notify("notifications/initialized")
      // A warm relay may still be populating tool descriptions on older builds.
      for (let n = 0; n < 100; n++) {
        if (((await mcp.request("tools/list")).result?.tools as unknown[])?.length) break
        await Bun.sleep(10)
      }
      const create = (id: string) => mcp.request("tools/call", { name: "session_new", arguments: { id } })
      const first = await create("before-update")
      expect(first.result?.isError, JSON.stringify(first)).toBe(false)
      const update = await Bun.$`${binary} runtime-switch ${versions[1]}`.env(env).quiet().nothrow()
      expect(update.exitCode, update.text()).toBe(0)
      const running = await relayVersion()
      replacement = running.pid
      expect(running.version).toBe(versions[1])
      extension = new RelayHarness.FakeExtension(home, port)
      expect(await extension.pair()).toBe(true)
      const next = await create("after-update")
      expect(next.result?.structuredContent, JSON.stringify(next)).toMatchObject({ session: { id: "after-update" } })
    } finally { extension?.close(); mcp.close(); relay.kill(); if (replacement) process.kill(replacement) }
  }, 60_000)
})

describe("MCP protocol versions", () => {
  test("the first session_new and bound execute survive a worker reconnect", async () => {
    const relay = await startRelay(home)
    const mcp = server(undefined, relay.port)
    const attach = () => new RelayHarness.FakeExtension(home, relay.port)
      .on("tabs.create", () => ({ tabId: 7 }))
      .on("Target.getTargetInfo", () => ({ targetInfo: { targetId: "RECONNECTED", type: "page", title: "", url: "about:blank", attached: true, browserContextId: "CTX" } }))
      .on("Page.getFrameTree", () => ({ frameTree: { frame: { id: "RECONNECTED", loaderId: "L", url: "about:blank", securityOrigin: "null", mimeType: "text/html" } } }))
    let extension = attach()
    try {
      expect(await extension.pair()).toBe(true)
      await mcp.request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "0" } })
      mcp.notify("notifications/initialized")
      for (const [name, args] of [["session_new", { id: "survivor" }], ["execute", { session: "survivor", code: "return 42" }]] as const) {
        extension.close()
        expect(await RelayHarness.until(() => extension.closeCode !== undefined)).toBe(true)
        const first = mcp.request("tools/call", { name, arguments: args })
        await Bun.sleep(350)
        extension = attach()
        expect(await extension.pair()).toBe(true)
        const { result } = await first
        expect(result?.isError, JSON.stringify(result)).toBe(false)
        expect(result?.structuredContent).toMatchObject({ session: { id: "survivor" }, ...(name === "execute" ? { value: 42 } : {}) })
      }
    } finally { extension.close(); mcp.close(); await stopRelay(relay.child) }
  }, 15_000)

  test("advertises all tools on the first handshake, without waiting for browser discovery", async () => {
    const relay = await startRelay(home)
    const proxy = Bun.serve({
      hostname: "127.0.0.1", port: await freePort(),
      async fetch(request) {
        const pathname = new URL(request.url).pathname
        if (pathname === "/extension/status") await Bun.sleep(750)
        return fetch(`http://127.0.0.1:${relay.port}${pathname}`, { headers: { authorization: `Bearer ${relay.token}` } })
      },
    })
    try {
      fs.symlinkSync(path.join(import.meta.dir, "../node_modules"), path.join(home, "node_modules"), "junction")
      const entry = await bundleCli({ outdir: path.join(home, "dist"), version: "0.0.1" })
      const binary = process.env.BROWSE_TEST_BINARY
      for (const command of [["node", entry], ...(binary ? [[binary]] : [])]) {
        const mcp = server(command, proxy.port!)
        try {
          const init = await mcp.request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "0" } })
          expect(init.result?.capabilities).toHaveProperty("tools")
          mcp.notify("notifications/initialized")
          expect((await mcp.request("tools/list")).result?.tools).toHaveLength(29)
        } finally { mcp.close() }
      }
    } finally {
      await proxy.stop(true)
      await stopRelay(relay.child)
    }
  }, 30_000)

  test("a foreign listener leaves tools available and explains the port conflict", async () => {
    const other = Bun.serve({ hostname: "127.0.0.1", port: await freePort(), fetch: () => new Response("Not Found", { status: 404 }) })
    const mcp = server(undefined, other.port!)
    try {
      await mcp.request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "0" } })
      mcp.notify("notifications/initialized")
      const call = await mcp.request("tools/call", { name: "execute", arguments: { code: "return 1" } })
      expect(call.result?.isError).toBe(true)
      expect(JSON.stringify(call.result?.content)).toContain(`port ${other.port} is in use by another program`)
    } finally {
      mcp.close()
      await other.stop(true)
    }
  }, 30_000)

  test("a silent relay returns a tool error instead of hanging an MCP call", async () => {
    const silent = Bun.serve({ hostname: "127.0.0.1", port: await freePort(), fetch: () => new Promise<Response>(() => {}) })
    const mcp = server(undefined, silent.port!)
    try {
      await mcp.request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "0" } })
      mcp.notify("notifications/initialized")
      const call = await Promise.race([mcp.request("tools/call", { name: "status", arguments: {} }),
        Bun.sleep(9000).then(() => { throw new Error("tools/call never answered") })])
      expect(call.result?.isError).toBe(true)
      expect(JSON.stringify(call.result?.content)).toContain(`relay on port ${silent.port} isn't answering`)
    } finally {
      mcp.close()
      await silent.stop(true)
    }
  }, 12_000)

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
