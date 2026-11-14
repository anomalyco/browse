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
import { parseSettingChanges, settingSpecs, SettingsInputError } from "../src/relay/user-settings.ts"

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

/** The JSON type of a value. Integer and number are one type: JSON Schema matches either against both. */
function jsonType(value: unknown): string {
  return typeof value === "number" ? "number" : value === null ? "null" : typeof value
}

/** Every `enum` and `const` in a JSON Schema, with its path and the `type` declared beside it, if any. */
function literals(schema: unknown): Array<{ path: string; type: string | undefined; values: readonly unknown[] }> {
  const found: Array<{ path: string; type: string | undefined; values: readonly unknown[] }> = []
  const visit = (node: unknown, path: string) => {
    if (Array.isArray(node)) return node.forEach((item, index) => visit(item, `${path}[${index}]`))
    if (node === null || typeof node !== "object") return
    const record = node as Record<string, unknown>
    const type = typeof record.type === "string" ? record.type : undefined
    if (Array.isArray(record.enum)) found.push({ path: `${path}.enum`, type, values: record.enum })
    if ("const" in record) found.push({ path: `${path}.const`, type, values: [record.const] })
    for (const [key, value] of Object.entries(record)) visit(value, `${path}.${key}`)
  }
  visit(schema, "")
  return found
}

function matchesJsonType(type: string, value: unknown): boolean {
  switch (type) {
    case "integer": return typeof value === "number" && Number.isInteger(value)
    case "number": return typeof value === "number"
    case "string": return typeof value === "string"
    case "boolean": return typeof value === "boolean"
    case "null": return value === null
    case "array": return Array.isArray(value)
    case "object": return typeof value === "object" && value !== null && !Array.isArray(value)
    default: return true
  }
}

/** Every JSON Schema the MCP server advertises: each tool's input, and its structured result's output. */
function advertisedSchemas(): Array<{ name: string; json: unknown }> {
  return specs().flatMap((spec) => [
    { name: `${spec.name} input`, json: spec.inputSchema },
    ...(spec.outputSchema ? [{ name: `${spec.name} output`, json: toolOutputJson(spec.outputSchema) }] : []),
  ])
}

describe("tool output schemas", () => {
  test("the main tools advertise an object-root output schema", () => {
    const byName = new Map(specs().map((spec) => [spec.name, spec]))
    const expected = [
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

  test("execute advertises no output schema, so a client that validates one accepts its image results", () => {
    const execute = specs().find((spec) => spec.name === "execute")!
    expect(execute.outputSchema).toBeUndefined()
    const result = executeToolResult(executeResponse({
      text: "Returned 1 image",
      media: [{ type: "image", mimeType: "image/png", data: Buffer.from("png").toString("base64"), size: 3 }],
    }))
    expect(result.structuredContent).toBeUndefined()
    expect(result.content.map((item) => item.type)).toEqual(["text", "image"])
    // The MCP SDK client rejects a non-error result without structured content from a tool that declares an output
    // schema. Every screenshot hit that while execute declared one.
    const rejected = execute.outputSchema !== undefined && result.structuredContent === undefined && !result.isError
    expect(rejected).toBe(false)
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

  test("execute errors put their warnings, diagnostic, page movement and logs in the text, with no structured content", () => {
    const result = executeToolResult(executeResponse({
      text: "Error: boom\n    at script:1:1",
      isError: true,
      logs: [{ source: "script", type: "log", text: "step 1" }, { source: "page", type: "error", text: "bad", repeatCount: 3 }],
      warnings: ["the page navigated"],
      diagnostic: "execution-context/context-destroyed; pageClosed=false; urlChanged=true; mainFrameNavigations=1",
      aftermath: {
        startUrl: "https://example.com/one",
        endUrl: "https://example.com/two",
        navigations: ["https://example.com/two"],
        consoleErrorCount: 1,
        pageErrorCount: 0,
        handoffs: 0,
      },
    }))
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toBeUndefined()
    expect(textBlocks(result)).toEqual([[
      "Error: boom\n    at script:1:1",
      "Warnings:\n- the page navigated",
      "Diagnostic: execution-context/context-destroyed; pageClosed=false; urlChanged=true; mainFrameNavigations=1",
      "Page: moved from https://example.com/one to https://example.com/two; 1 navigation; 1 console error",
      "Logs (2):\n[log] step 1\n[page error] bad (×3)",
    ].join("\n\n")])
  })

  test("a bare execute error stays just the message", () => {
    const result = executeToolResult(executeResponse({ text: "Error: boom\n    at script:1:1", isError: true }))
    expect(textBlocks(result)).toEqual(["Error: boom\n    at script:1:1"])
  })

  test("execute error text stays under 10,000 characters and keeps its warnings", () => {
    const result = executeToolResult(executeResponse({
      text: `locator.click: Timeout 30000ms exceeded.\nCall log:\n${"  - retrying click action\n".repeat(2000)}    at execute.js:5:1`,
      isError: true,
      logs: Array.from({ length: 500 }, (_, index) => ({ source: "script" as const, type: "log", text: `line ${index} ${"x".repeat(400)}` })),
      warnings: ["Pointer action was blocked"],
    }))
    const text = textBlocks(result).join("")
    expect(text.length).toBeLessThan(10_000)
    expect(text).toStartWith("locator.click: Timeout 30000ms exceeded.")
    expect(text).toContain("at execute.js:5:1")
    expect(text).toContain("Warnings:\n- Pointer action was blocked")
    expect(text).toContain("line 499")
    expect(text).not.toContain("line 479 ")
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

describe("advertised tool schemas", () => {
  // Some MCP clients (Kimi, for one) reject a tool whose enum or const mixes JSON types, and fail the whole tool list
  // over it. Each variant must keep its own type, through anyOf or otherwise.
  test("every enum and const keeps one JSON type", () => {
    const problems: string[] = []
    for (const { name, json } of advertisedSchemas()) {
      for (const { path, type, values } of literals(json)) {
        const types = new Set(values.map((value) => jsonType(value)))
        if (types.size > 1) problems.push(`${name}${path} mixes ${[...types].join(", ")}: ${JSON.stringify(values)}`)
        if (type) {
          const mismatched = values.filter((value) => !matchesJsonType(type, value))
          if (mismatched.length > 0) problems.push(`${name}${path} declares type ${type} but holds ${JSON.stringify(mismatched)}`)
        }
      }
    }
    expect(problems).toEqual([])
  })

  test("settings idleMinutes splits its minutes and 'never' into single-typed enums", () => {
    const input = specs().find((spec) => spec.name === "settings")!.inputSchema
    const set = (input.properties as Record<string, { properties: Record<string, unknown> }>).set!
    expect(set.properties.idleMinutes).toEqual({
      anyOf: [
        { type: "integer", enum: [10, 30, 60] },
        { type: "string", enum: ["never"] },
      ],
      description: settingSpecs.idleMinutes.label,
    })
  })

  test("settings idleMinutes still decodes every value it advertises", () => {
    expect(parseSettingChanges({ idleMinutes: 10 })).toEqual({ idleMinutes: 10 })
    expect(parseSettingChanges({ idleMinutes: "never" })).toEqual({ idleMinutes: "never" })
    // 0 and numeric strings are the CLI's other spellings of the same values.
    expect(parseSettingChanges({ idleMinutes: 0 })).toEqual({ idleMinutes: "never" })
    expect(parseSettingChanges({ idleMinutes: "30" })).toEqual({ idleMinutes: 30 })
    expect(() => parseSettingChanges({ idleMinutes: 15 })).toThrow(SettingsInputError)
  })
})
