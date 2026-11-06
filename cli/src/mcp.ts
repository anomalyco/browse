import { NodeStdio } from "@effect/platform-node"
import { Config, Context, Effect, Layer, Option, Schedule } from "effect"
import { McpProtocol, McpSchema, McpServer } from "effect/ai"
import path from "node:path"
import { fileURLToPath } from "node:url"
import "./mcp/browser.ts"
import "./mcp/execute.ts"
import "./mcp/network.ts"
import "./mcp/recording.ts"
import "./mcp/secrets.ts"
import "./mcp/session.ts"
import {
  buildRegisteredMcpTools,
  createMcpToolContext,
  type McpToolSpec,
} from "./mcp/registry.ts"
import {
  browsersNote,
  mcpErrorMessage,
  mcpUpdateNote,
  toolOutputJson,
  toolResult,
  toolResultForValue,
  type BrowserSummary,
  type CurrentSession,
} from "./mcp/schema.ts"
import * as RelayClient from "./relay/client.ts"
import * as RelayLifecycle from "./relay/lifecycle.ts"
import { createUpdateWatcher } from "./update.ts"
import { opencodeBrowserVersion } from "./version.ts"

export {
  browsersNote,
  mcpErrorMessage,
  mcpUpdateNote,
  toolResultForValue,
}

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/** The implicit session the shim's MCP supervisor picked (auto-update.ts shimSource), when valid. */
function shimSession(): string | undefined {
  const value = process.env.OPENCODE_BROWSER_MCP_SESSION
  return value && /^mcp-[0-9a-f]{8}$/.test(value) ? value : undefined
}

const registerTools = Effect.gen(function* () {
  const server = yield* McpServer.McpServer
  const relay = yield* RelayClient.Service
  const configuredSession = Option.getOrUndefined(yield* Config.option(Config.String("OPENCODE_BROWSER_SESSION")))
  const currentSession: CurrentSession = {
    // Under the auto-update shim, every server it starts for one opencode session keeps the same implicit session.
    id: configuredSession || shimSession() || `mcp-${crypto.randomUUID().slice(0, 8)}`,
    established: Boolean(configuredSession),
  }
  // Checks for a newer browse in the background (cached; never delays a tool call). The first tool result after one
  // is found carries a note for the agent to pass on, once per MCP server, i.e. once per opencode session.
  const updates = createUpdateWatcher()
  void updates.refresh()
  let updateNoted = false
  const withUpdateNote = (name: string, result: McpSchema.CallToolResult) => {
    void updates.refresh()
    const notice = updates.current
    if (!notice || updateNoted) return result
    updateNoted = true
    if (name === "status") return result
    return new McpSchema.CallToolResult({
      ...result,
      content: [...result.content, McpSchema.TextContent.make({ text: mcpUpdateNote(notice) })],
    })
  }
  const register = (spec: McpToolSpec) =>
    server.addTool({
      tool: new McpSchema.Tool({
        name: spec.name,
        description: spec.description,
        inputSchema: spec.inputSchema,
        ...(spec.outputSchema ? { outputSchema: toolOutputJson(spec.outputSchema) } : {}),
        annotations: {
          readOnlyHint: spec.readOnly,
          destructiveHint: spec.destructive,
          idempotentHint: spec.idempotent,
          openWorldHint: true,
        },
      }),
      annotations: Context.empty(),
      handle: (payload: unknown) => {
        const operation = spec.requiresRelayCompatibility !== false
          ? RelayLifecycle.ensureRelay({ relay }).pipe(
              Effect.flatMap((readiness) =>
                readiness.buildProblem ? Effect.fail(new Error(readiness.buildProblem)) : spec.handle(payload),
              ),
            )
          : spec.handle(payload)
        return operation.pipe(
          Effect.match({
            onFailure: (error) => toolResult({ text: mcpErrorMessage(spec.name, error.message), isError: true }),
            onSuccess: (value) =>
              spec.result ? spec.result(value) : toolResultForValue(value, spec.outputSchema ? { outputSchema: spec.outputSchema } : {}),
          }),
          Effect.map((result) => withUpdateNote(spec.name, result)),
        )
      },
    })
  // The connected browsers, as the descriptions of execute and session_new list them. The relay is asked every few
  // seconds; when the browsers change, those two tools are registered again, which tells the client (list_changed).
  const connectedBrowsers = relay.extensionStatus.pipe(
    Effect.map((status): readonly BrowserSummary[] =>
      (status.browsers ?? []).map(({ id, name, default: isDefault }) => ({ id, name, default: isDefault })),
    ),
    Effect.orElseSucceed((): readonly BrowserSummary[] => []),
  )
  let browsers: readonly BrowserSummary[] = []
  const buildSpecs = (currentBrowsers: readonly BrowserSummary[]) =>
    buildRegisteredMcpTools(
      createMcpToolContext({
        relay,
        currentSession,
        packageRoot,
        update: () => updates.current,
        browsers: currentBrowsers,
      }),
    )
  yield* Effect.forEach(buildSpecs(browsers), register, { discard: true })
  const refreshBrowsers = Effect.gen(function* () {
    const next = yield* connectedBrowsers
    if (browsersNote(next) === browsersNote(browsers)) return
    browsers = next
    const specs = buildSpecs(browsers).filter((spec) => spec.listsBrowsers === true)
    yield* Effect.forEach(specs, register, { discard: true })
  })
  yield* refreshBrowsers.pipe(Effect.repeat(Schedule.spaced("5 seconds")), Effect.forkScoped)
})

export const mcpServerLayer = McpServer.layerStdio({
  name: "browse",
  version: opencodeBrowserVersion,
  protocols: [McpProtocol.v2026_07_28, McpProtocol.v2025_11_25, McpProtocol.v2025_06_18, McpProtocol.v2025_03_26, McpProtocol.v2024_11_05],
})

export const mcpToolsLayer = Layer.effectDiscard(registerTools)

export const runMcpServer: Effect.Effect<never, Error> = Layer.launch(
  mcpServerLayer.pipe(
    // Populate the shared McpServer before stdio can answer initialize or server/discover.
    Layer.provide(mcpToolsLayer.pipe(Layer.provide(McpServer.McpServer.layer))),
    Layer.provide(NodeStdio.layer),
    Layer.provide(RelayClient.layerFetchMcp),
  ),
)
