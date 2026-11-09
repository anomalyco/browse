import "../src/mcp.ts"
import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import type { McpSchema } from "effect/ai"
import { buildRegisteredMcpTools, createMcpToolContext, type McpToolSpec } from "../src/mcp/registry.ts"
import {
  ExecuteToolOutput,
  StatusToolOutput,
  agentSettingKeys,
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
      "session_use",
      "session_reset",
      "session_delete",
      "session_adopt",
      "network",
      "recording",
      "flight_recorder",
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

  test("tool annotations describe what each tool can do", () => {
    const byName = new Map(specs().map((spec) => [spec.name, spec]))
    const annotation = (name: string) => {
      const spec = byName.get(name)!
      return { readOnly: spec.readOnly, destructive: spec.destructive, idempotent: spec.idempotent, openWorld: spec.openWorld }
    }
    expect(annotation("execute")).toEqual({ readOnly: false, destructive: true, idempotent: false, openWorld: true })
    expect(annotation("status")).toEqual({ readOnly: true, destructive: false, idempotent: true, openWorld: false })
    expect(annotation("session_delete")).toEqual({ readOnly: false, destructive: true, idempotent: true, openWorld: false })
    expect(annotation("session_reset")).toEqual({ readOnly: false, destructive: true, idempotent: false, openWorld: false })
    expect(annotation("tabs_cleanup")).toEqual({ readOnly: false, destructive: true, idempotent: true, openWorld: false })
    expect(annotation("network")).toEqual({ readOnly: false, destructive: true, idempotent: false, openWorld: false })
    expect(annotation("secrets_refresh")).toEqual({ readOnly: false, destructive: true, idempotent: false, openWorld: true })
    expect(annotation("settings")).toEqual({ readOnly: false, destructive: false, idempotent: true, openWorld: false })
    for (const spec of specs()) expect(typeof spec.openWorld, spec.name).toBe("boolean")
  })

  test("settings schema accepts both the read and the change result", () => {
    const spec = specs().find((candidate) => candidate.name === "settings")!
    const setting = { value: "shared", effective: "shared", allowed: ["shared", "window"], description: "Grouping" }
    const settings = Object.fromEntries(agentSettingKeys.map((key) => [key, setting]))
    expect(Schema.is(spec.outputSchema!)({ settings, note: "read" })).toBe(true)
    expect(Schema.is(spec.outputSchema!)({
      changed: [{ key: "grouping", from: "window", to: "shared" }],
      unchanged: [],
      overridden: [],
      settings,
      message: "changed",
    })).toBe(true)
  })

  test("merged action tools produce valid structured results for every action", async () => {
    const networkReport = {
      active: true,
      startedAt: "2026-01-01T00:00:00.000Z",
      entryCount: 1,
      responseCount: 1,
      failureCount: 0,
      capturedBodyBytes: 10,
      truncatedBodyCount: 0,
      droppedEntryCount: 0,
      urlFilter: "/api/",
    }
    const quality = {
      width: 1280,
      height: 720,
      frameRate: 30,
      sourceFrameCount: 30,
      encodedSourceFrameCount: 30,
      coalescedFrameCount: 0,
      droppedFrameCount: 0,
      achievedSourceFrameRate: 30,
      achievedEncodedSourceFrameRate: 30,
      screenshotFallback: false,
    }
    const relay = {
      sessions: Effect.succeed([{ id: "mcp-1234abcd" }]),
      sessionEnsure: () => Effect.void,
      extensionStatus: Effect.succeed({ connected: true }),
      networkStart: () => Effect.succeed(networkReport),
      networkStatus: () => Effect.succeed(networkReport),
      networkStop: () => Effect.succeed({
        ...networkReport,
        active: false,
        stoppedAt: "2026-01-01T00:01:00.000Z",
        updatedSecretRefs: [],
        observedSecretRefs: [],
      }),
      networkCancel: () => Effect.succeed({ cancelled: true }),
      recordingStart: () => Effect.succeed({
        success: true,
        tabId: 1,
        startedAt: 1,
        path: "/tmp/a.webm",
        mimeType: "video/webm",
        mode: "tab-capture",
        artifactType: "webm",
        frameRate: 30,
      }),
      recordingStop: () => Effect.succeed({
        success: true,
        tabId: 1,
        duration: 1000,
        path: "/tmp/a.webm",
        size: 100,
        mode: "tab-capture",
        artifactType: "webm",
        frameCount: 2,
        quality,
      }),
      recordingStatus: () => Effect.succeed({ isRecording: false }),
      recordingCancel: () => Effect.succeed({ success: true }),
      flightRecorderStart: () => Effect.succeed({
        active: true,
        tabId: 1,
        sessionId: "mcp-1234abcd",
        startedAt: 1,
        retentionMs: 60_000,
        frameRate: 60,
      }),
      flightRecorderStatus: () => Effect.succeed({
        active: true,
        tabId: 1,
        sessionId: "mcp-1234abcd",
        startedAt: 1,
        retentionMs: 60_000,
        retainedDurationMs: 1000,
        frameRate: 60,
        bufferedFrames: 10,
        bufferedBytes: 1000,
        sourceFrameCount: 10,
        droppedFrameCount: 0,
        saving: false,
      }),
      flightRecorderSaveLast: () => Effect.succeed({
        path: "/tmp/a.webm",
        durationMs: 30_000,
        frameCount: 10,
        sourceFrameCount: 10,
        droppedFrameCount: 0,
      }),
      flightRecorderCancel: () => Effect.succeed({ cancelled: true }),
    } as unknown as RelayClient.Interface
    const ctx = createMcpToolContext({
      relay,
      currentSession: { id: "mcp-1234abcd", established: true },
      packageRoot: "/tmp/browse",
    })
    const byName = new Map(buildRegisteredMcpTools(ctx).map((spec) => [spec.name, spec]))
    const cases: Record<string, ReadonlyArray<{ action: string; [key: string]: unknown }>> = {
      network: [
        { action: "start" },
        { action: "status" },
        { action: "stop", outputPath: "/tmp/a.har" },
        { action: "cancel" },
      ],
      recording: [
        { action: "start", outputPath: "/tmp/a.webm", cursor: true },
        { action: "stop" },
        { action: "status" },
        { action: "cancel" },
      ],
      flight_recorder: [
        { action: "start" },
        { action: "status" },
        { action: "save_last", outputPath: "/tmp/a.webm", durationMs: 30_000 },
        { action: "cancel" },
      ],
    }
    for (const [name, actions] of Object.entries(cases)) {
      const spec = byName.get(name)!
      expect(spec, name).toBeDefined()
      for (const args of actions) {
        const value = await Effect.runPromise(spec.handle({ session: "mcp-1234abcd", ...args }))
        const result = toolResultForValue(value, { outputSchema: spec.outputSchema! })
        expect(result.isError, `${name} ${args.action}`).toBe(false)
        expect(result.structuredContent, `${name} ${args.action}`).toBeDefined()
        expect(Schema.is(spec.outputSchema!)(result.structuredContent), `${name} ${args.action}`).toBe(true)
      }
    }
  })

  test("settings never expose or change update behaviour", async () => {
    const setting = { value: "shared", effective: "shared", allowed: ["shared", "window"], description: "Grouping" }
    const settings = Object.fromEntries(agentSettingKeys.map((key) => [key, setting]))
    const relay = {
      settingsGet: Effect.succeed({
        settings: { ...settings, autoUpdate: { ...setting, allowed: ["on", "notify", "off"] } },
        note: "read",
      }),
    } as unknown as RelayClient.Interface
    const ctx = createMcpToolContext({
      relay,
      currentSession: { id: "mcp-1234abcd", established: true },
      packageRoot: "/tmp/browse",
    })
    const spec = buildRegisteredMcpTools(ctx).find((candidate) => candidate.name === "settings")!
    const read = await Effect.runPromise(spec.handle({}) as Effect.Effect<{ settings: Record<string, unknown> }, Error>)
    expect(read.settings).not.toHaveProperty("autoUpdate")
    expect(Object.keys(read.settings).sort()).toEqual([...agentSettingKeys].sort())
    expect(Schema.is(spec.outputSchema!)(read)).toBe(true)
    const failure = await Effect.runPromise(Effect.flip(spec.handle({ set: { autoUpdate: "notify" } }) as Effect.Effect<unknown, Error>))
    expect(failure.message).toContain("browse settings set autoUpdate")
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
      sharedSession: false,
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
