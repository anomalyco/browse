import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { callerSessionId } from "../src/mcp/registry.ts"
import { FakeExtension, startRelay, stopRelay, until } from "./relay-harness.ts"
import { mcpStdio, type McpReply } from "./support/mcp-stdio.ts"

// OpenCode runs one MCP server per server config and process, shared by every agent session and subagent, and names
// the calling agent in each tools/call's _meta. Each agent gets its own current session; calls that name no agent
// (other MCP clients, which run one server per conversation) share the server's, as before.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "browse-mcp-callers-"))
afterAll(() => fs.rmSync(home, { recursive: true, force: true }))

const modernMeta = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "test", version: "0" },
}
const agent = (sessionID: string) => ({ "ai.opencode/sessionID": sessionID })
const structured = (reply: McpReply) => {
  expect(reply.result?.isError, JSON.stringify(reply)).toBe(false)
  return reply.result?.structuredContent as Record<string, unknown>
}

/** A paired fake browser whose every new tab gets its own id and target, and that records each cleanup it's asked for. */
async function browser(port: number) {
  let next = 10
  const cleanups: Array<Record<string, unknown> | undefined> = []
  const frame = (tabId: unknown) => ({ id: `T${tabId}`, loaderId: "L", url: "about:blank", securityOrigin: "null", mimeType: "text/html" })
  const extension = new FakeExtension(home, port)
    .on("tabs.create", () => ({ tabId: ++next }))
    .on("Target.getTargetInfo", (command) => ({
      targetInfo: { targetId: `T${command.params?.tabId}`, type: "page", title: "", url: "about:blank", attached: true, browserContextId: "CTX" },
    }))
    .on("Page.getFrameTree", (command) => ({ frameTree: { frame: frame(command.params?.tabId) } }))
    .on("tabs.cleanup", (command) => {
      cleanups.push(command.params)
      return { closed: [] }
    })
  expect(await extension.pair()).toBe(true)
  return { extension, cleanups }
}

async function initialized(port: number) {
  const mcp = mcpStdio({ home, port })
  await mcp.request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "opencode", version: "0" } })
  mcp.notify("notifications/initialized")
  return mcp
}

describe("one MCP server shared by several agents", () => {
  test("each agent session has its own current session, derived from its id on every server", async () => {
    const relay = await startRelay(home)
    const servers: Array<ReturnType<typeof mcpStdio>> = []
    try {
      const first = await initialized(relay.port)
      servers.push(first)
      const status = async (mcp: ReturnType<typeof mcpStdio>, meta?: Record<string, unknown>) =>
        structured(await mcp.request("tools/call", { name: "status", arguments: {}, ...(meta ? { _meta: meta } : {}) })).currentSession
      const a = await status(first, agent("ses_agent_a"))
      const b = await status(first, agent("ses_agent_b"))
      const shared = await status(first)
      expect(a).toBe(callerSessionId("ses_agent_a"))
      expect(b).toBe(callerSessionId("ses_agent_b"))
      expect(a).toMatch(/^mcp-[0-9a-f]{8}$/)
      expect(new Set([a, b, shared]).size).toBe(3)
      expect(await status(first)).toBe(shared)
      // A new server (an update swap, or opencode restarting) derives the same session for the same agent.
      const second = mcpStdio({ home, port: relay.port })
      servers.push(second)
      expect(await status(second, { ...modernMeta, ...agent("ses_agent_a") })).toBe(a)
    } finally {
      for (const mcp of servers) mcp.close()
      await stopRelay(relay.child)
    }
  }, 30_000)

  test("bare calls, session_new and tabs_cleanup stay with the calling agent", async () => {
    const relay = await startRelay(home)
    const { extension, cleanups } = await browser(relay.port)
    const mcp = await initialized(relay.port)
    const call = async (name: string, args: Record<string, unknown>, sessionID?: string) =>
      structured(await mcp.request("tools/call", { name, arguments: args, ...(sessionID ? { _meta: agent(sessionID) } : {}) }))
    try {
      // Two agents' bare executes land in two sessions, each on its own tab.
      expect(await call("execute", { code: "return 1" }, "ses_a")).toMatchObject({ session: callerSessionId("ses_a") })
      expect(await call("execute", { code: "return 2" }, "ses_b")).toMatchObject({ session: callerSessionId("ses_b") })
      const tabs = extension.commands.filter((command) => command.method === "tabs.create")
      expect(tabs).toHaveLength(2)

      // One agent's session_new is its own: the other's bare execute stays where it was.
      expect(await call("session_new", { id: "a-work" }, "ses_a")).toMatchObject({ session: { id: "a-work" } })
      expect(await call("execute", { code: "return 3" }, "ses_b")).toMatchObject({ session: callerSessionId("ses_b") })
      expect(await call("execute", { code: "return 4" }, "ses_a")).toMatchObject({ session: "a-work" })

      // Calls that name no agent keep sharing one session, which session_use moves for all of them, as before.
      expect(await call("session_use", { id: "a-work" })).toEqual({ currentSession: "a-work" })
      expect(await call("execute", { code: "return 5" })).toMatchObject({ session: "a-work" })
      expect(await call("execute", { code: "return 6" }, "ses_b")).toMatchObject({ session: callerSessionId("ses_b") })

      // idleMinutes: 0 from agent A covers A's tabs only (its first session's and a-work's); B's wait for the setting.
      await call("tabs_cleanup", { idleMinutes: 0 }, "ses_a")
      expect(await until(() => cleanups.length === 1)).toBe(true)
      const own = cleanups[0]?.own as { tabIds: number[]; idleMinutes?: number }
      expect(cleanups[0]).not.toHaveProperty("idleMinutes")
      expect(own.idleMinutes).toBe(0)
      expect([...own.tabIds].sort((a, b) => a - b)).toEqual([11, 13])
      // The CLI and the status page have no agent: theirs stays a sweep of every agent tab.
      await fetch(`http://127.0.0.1:${relay.port}/tabs/cleanup`, {
        method: "POST",
        headers: { authorization: `Bearer ${relay.token}`, "content-type": "application/json" },
        body: JSON.stringify({ idleMinutes: 0 }),
      })
      expect(await until(() => cleanups.length === 2)).toBe(true)
      expect(cleanups[1]).toEqual({ idleMinutes: 0 })
    } finally {
      extension.close()
      mcp.close()
      await stopRelay(relay.child)
    }
  }, 30_000)
})
