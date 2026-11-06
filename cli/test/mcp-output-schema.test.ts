import "../src/mcp.ts"
import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import type { McpSchema } from "effect/ai"
import { buildRegisteredMcpTools, createMcpToolContext, type McpToolSpec } from "../src/mcp/registry.ts"
import {
  ExecuteToolOutput,
  StatusToolOutput,
  executeToolOutput,
  executeToolResult,
  executeToolText,
  toolOutputJson,
  toolResultForValue,
} from "../src/mcp/schema.ts"
import type * as RelayClient from "../src/relay/client.ts"
import type { ExecuteResponse } from "../src/relay/schema.ts"

function executeResponse(overrides: Partial<ExecuteResponse> = {}): ExecuteResponse {
  return {
    text: "undefined",
    isError: false,
    logs: [],
    session: {
      id: "mcp-1234abcd",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      connected: true,
      pageUrl: null,
      stateKeys: [],
    },
    ...overrides,
  }
}

function specs(): readonly McpToolSpec[] {
  return buildRegisteredMcpTools(createMcpToolContext({
    relay: {} as RelayClient.Interface,
    currentSession: { id: "mcp-1234abcd", established: true },
    packageRoot: "/tmp/browse",
  }))
}

function resultJson(result: McpSchema.CallToolResult): string {
  return JSON.stringify(result)
}

function textBlocks(result: McpSchema.CallToolResult): string[] {
  return result.content.flatMap((item) => item.type === "text" ? [item.text] : [])
}

describe("tool output schemas", () => {
  test("the main tools advertise an object-root output schema", () => {
    const byName = new Map(specs().map((spec) => [spec.name, spec]))
    const expected = [
      "execute",
      "status",
      "session_new",
      "session_allowlist",
      "session_list",
      "session_current",
      "session_use",
      "session_reset",
      "session_delete",
      "session_adopt",
      "network_start",
      "network_status",
      "network_stop",
      "network_cancel",
      "recording_start",
      "recording_stop",
      "recording_status",
      "recording_cancel",
      "flight_recorder_start",
      "flight_recorder_status",
      "flight_recorder_save_last",
      "flight_recorder_cancel",
      "tabs_cleanup",
      "settings",
      "secrets_list",
      "secrets_status",
      "secrets_refresh",
      "secrets_run",
    ]
    for (const name of expected) {
      const spec = byName.get(name)
      expect(spec, name).toBeDefined()
      expect(spec?.outputSchema, name).toBeDefined()
      const json = toolOutputJson(spec!.outputSchema!)
      expect(json.type, name).toBe("object")
      expect(json.properties, name).toBeDefined()
    }
  })

  test("settings schema accepts both the read and the change result", () => {
    const spec = specs().find((candidate) => candidate.name === "settings")!
    const setting = { value: "shared", effective: "shared", allowed: ["shared", "window"], description: "Grouping" }
    expect(Schema.is(spec.outputSchema!)({ settings: { grouping: setting }, note: "read" })).toBe(true)
    expect(Schema.is(spec.outputSchema!)({
      changed: [{ key: "grouping", from: "window", to: "shared" }],
      unchanged: [],
      overridden: [],
      settings: { grouping: setting },
      message: "changed",
    })).toBe(true)
  })

  test("execute structured content validates against its schema and carries the value once", () => {
    const snapshot = "button \"Save\" [ref=e1]\ntextbox \"Name\" [ref=e2]"
    const result = executeToolResult(executeResponse({ text: snapshot, value: snapshot }))
    const structured = result.structuredContent as typeof ExecuteToolOutput.Type
    expect(Schema.is(ExecuteToolOutput)(structured)).toBe(true)
    expect(structured).toEqual({ session: "mcp-1234abcd", value: snapshot })
    expect(structured).not.toHaveProperty("text")
    expect(structured).not.toHaveProperty("isError")
    expect(structured).not.toHaveProperty("warnings")
    expect(structured).not.toHaveProperty("logSummary")
    expect(structured).not.toHaveProperty("aftermath")
    expect(textBlocks(result)).toEqual([snapshot])
    // One text block and one structured value: the spec-mandated fallback pair. The old result also held the session
    // record, util.inspect text and a pretty-printed copy of everything.
    const received = JSON.parse(resultJson(result)) as {
      content: Array<{ type: string; text: string }>
      structuredContent: { value: string }
    }
    expect(received.content).toEqual([{ type: "text", text: snapshot }])
    expect(received.structuredContent.value).toBe(snapshot)
  })

  test("execute carries the context only when it has content", () => {
    const result = executeToolResult(executeResponse({
      text: "42",
      value: 42,
      logs: [{ source: "script", type: "log", text: "hello" }],
      logSummary: { totalCount: 1, returnedCount: 1, repeatedCount: 0, omittedCount: 0 },
      warnings: ["careful"],
      aftermath: {
        startUrl: "https://example.com/one",
        endUrl: "https://example.com/two",
        navigations: ["https://example.com/two"],
        consoleErrorCount: 0,
        pageErrorCount: 0,
        handoffs: 0,
      },
    }))
    const structured = result.structuredContent as typeof ExecuteToolOutput.Type
    expect(Schema.is(ExecuteToolOutput)(structured)).toBe(true)
    expect(structured.value).toBe(42)
    expect(structured.logs).toHaveLength(1)
    expect(structured.logSummary?.totalCount).toBe(1)
    expect(structured.warnings).toEqual(["careful"])
    expect(structured.aftermath?.navigations).toEqual(["https://example.com/two"])
    expect(textBlocks(result)).toEqual(["42"])
  })

  test("execute errors are MCP errors and keep diagnostics, not an isError field", () => {
    const result = executeToolResult(executeResponse({
      text: "Error: boom\n    at script:1:1",
      isError: true,
      warnings: ["the page navigated"],
      aftermath: {
        startUrl: "https://example.com/one",
        endUrl: "https://example.com/one",
        navigations: [],
        consoleErrorCount: 1,
        pageErrorCount: 0,
        handoffs: 0,
      },
    }))
    expect(result.isError).toBe(true)
    expect(textBlocks(result)).toEqual(["Error: boom\n    at script:1:1"])
    const structured = result.structuredContent as typeof ExecuteToolOutput.Type
    expect(Schema.is(ExecuteToolOutput)(structured)).toBe(true)
    expect(structured).not.toHaveProperty("isError")
    expect(structured).not.toHaveProperty("value")
    expect(structured.warnings).toEqual(["the page navigated"])
    expect(structured.aftermath?.consoleErrorCount).toBe(1)
  })

  test("status structured content validates and its fallback text is compact", () => {
    const value = {
      endpoint: "http://127.0.0.1:19988",
      currentSession: "mcp-1234abcd",
      version: { version: "0.0.10", pid: 42 },
      status: { connected: true, version: "0.0.10", activeTargets: 1 },
      autoUpdate: { install: "npm", cli: "browse", mode: "auto", effective: "auto" },
    }
    const result = toolResultForValue(value, { outputSchema: StatusToolOutput })
    expect(Schema.is(StatusToolOutput)(result.structuredContent)).toBe(true)
    expect(textBlocks(result)).toEqual([JSON.stringify(value)])
    expect(textBlocks(result)[0]).not.toContain("\n  ")
  })

  test("images keep their content blocks and are not repeated as structured content", () => {
    const result = executeToolResult(executeResponse({
      text: "screenshot taken",
      value: { type: "image", mimeType: "image/png", size: 68 },
      media: [{
        type: "image",
        mimeType: "image/png",
        data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
        size: 68,
      }],
    }))
    expect(result.structuredContent).toBeUndefined()
    expect(result.content.map((item) => item.type)).toEqual(["text", "image"])
    expect(textBlocks(result)).toEqual(["screenshot taken"])
  })

  test("the execute fallback text is readable and the shaping drops an uneventful aftermath", () => {
    const response = executeResponse({
      text: "snapshot text",
      value: "snapshot text",
      aftermath: {
        startUrl: "https://example.com/",
        endUrl: "https://example.com/",
        navigations: [],
        consoleErrorCount: 0,
        pageErrorCount: 0,
        handoffs: 0,
      },
    })
    expect(executeToolText(response)).toBe("snapshot text")
    expect(executeToolOutput(response)).toEqual({ session: "mcp-1234abcd", value: "snapshot text" })
  })

  test("session_adopt no longer repeats the adoption as a confirmation string", async () => {
    const session = {
      id: "mcp-1234abcd",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      connected: true,
      pageUrl: "https://example.com/",
      stateKeys: [],
    }
    const adopted = { session, adoptedUrl: "https://example.com/", adoptedTargetId: "TARGET" }
    const relay = {
      sessionAdopt: () => Effect.succeed(adopted),
    } as unknown as RelayClient.Interface
    const ctx = createMcpToolContext({
      relay,
      currentSession: { id: "mcp-1234abcd", established: true },
      packageRoot: "/tmp/browse",
    })
    const spec = buildRegisteredMcpTools(ctx).find((candidate) => candidate.name === "session_adopt")!
    const value = await Effect.runPromise(spec.handle({}))
    expect(value).toEqual(adopted)
    expect(value).not.toHaveProperty("confirmation")
    expect(Schema.is(spec.outputSchema!)(value)).toBe(true)
  })
})
