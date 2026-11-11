import { Effect } from "effect"
import { autoUpdateStatus } from "../update/auto-update.ts"
import { getObject } from "../relay/helpers.ts"
import * as RelayLifecycle from "../relay/lifecycle.ts"
import { updateJson } from "../update.ts"
import { securityVariables, settingSpecs, type SettingReport } from "../relay/user-settings.ts"
import { TabsCleanupResponse } from "../relay/schema.ts"
import { registerMcpTools } from "./registry.ts"
import { agentSettingKeys, emptyInputSchema, objectSchema, SettingsToolOutput, StatusToolOutput, valuesSchema } from "./schema.ts"

/** The settings report without update behaviour: agents may see its value in status but never read or change it here. */
const agentSettings = (settings: Record<string, SettingReport>) =>
  Object.fromEntries(agentSettingKeys.map((key) => [key, settings[key]!]))

registerMcpTools({
  order: 110,
  build: (ctx) => [
    {
      name: "status",
      requiresRelayCompatibility: false,
      description: "Return relay, extension, target, session, and connected browser status.",
      inputSchema: emptyInputSchema,
      readOnly: true,
      destructive: false,
      idempotent: true,
      openWorld: false,
      outputSchema: StatusToolOutput,
      handle: () =>
        Effect.gen(function* () {
          const [version, status] = yield* Effect.all([ctx.relay.version, ctx.relay.extensionStatus])
          const caller = yield* ctx.caller
          const buildProblem = RelayLifecycle.relayBuildProblem(version)
          const available = updateJson(ctx.update())
          return {
            endpoint: ctx.relay.endpoint,
            currentSession: caller.id,
            sharedSession: caller.shared,
            version,
            status,
            ...(buildProblem ? { buildProblem } : {}),
            ...(available ? { update: available } : {}),
            autoUpdate: autoUpdateStatus(),
          }
        }),
    },
  ],
})

registerMcpTools({
  order: 420,
  build: (ctx) => [
    {
      name: "tabs_cleanup",
      description:
        "Close tabs agents opened that nobody has used for a while (no agent command and not visited by the user). Tabs the user shared or pinned, the active tab, tabs playing audio, recording, or waiting for a handoff stay open. `idleMinutes` applies to the sessions the calling agent made current; when the client doesn't name agents, that is every session made current over this server, so agents sharing one should not use `idleMinutes: 0` unless the user asks. Every other agent tab closes only once idle for the user's setting too. To finish your own work, `session_reset` or `session_delete` is more direct. browse also does this automatically after the user's idle setting (10 minutes unless they changed it).",
      inputSchema: objectSchema({
        idleMinutes: {
          type: "integer",
          minimum: 0,
          description:
            "Close the calling agent's own sessions' tabs idle at least this long; 0 closes all of them. When the client doesn't name agents, every session made current over this server counts, so only use 0 when the user asks. Defaults to the user's setting (10 minutes; still 10 when the user set automatic cleanup to never).",
        },
      }),
      readOnly: false,
      destructive: true,
      idempotent: true,
      openWorld: false,
      outputSchema: TabsCleanupResponse,
      handle: (input) =>
        Effect.gen(function* () {
          const value =
            typeof input === "object" && input !== null && "idleMinutes" in input ? input.idleMinutes : undefined
          const caller = yield* ctx.caller
          return yield* ctx.relay.tabsCleanup(typeof value === "number" && value >= 0 ? value : undefined, [...caller.sessions])
        }),
    },
    {
      name: "settings",
      description: `Read or change the user's browse settings from the extension's options page: where agent tabs open (window), how they're grouped (grouping), when untouched agent tabs close (idleMinutes), the agent cursor (cursor), human-like input (humanInput) and handoff notifications (handoffNotifications). Update behaviour is not available here: only the user changes it, with \`browse settings\` or the extension's options page, and \`status\` reports its current value. Use this tool only when the user asks to change how browse behaves, never on your own initiative. Without \`set\` it returns each setting's stored value, the value in effect, and the relay environment variable that overrides it, if any. With \`set\` it validates every value strictly, applies the change at once (the options page updates live) and returns what changed: tell the user what you changed. A setting an environment variable fixes is not changed, and the result says so. Security switches (${securityVariables.join(", ")}) are environment-only and can never be read or changed here.`,
      inputSchema: objectSchema({
        set: {
          type: "object",
          description: "Settings to change; omit to only read them.",
          properties: Object.fromEntries(
            agentSettingKeys.map((key) => [key, valuesSchema(settingSpecs[key].values, settingSpecs[key].label)]),
          ),
          additionalProperties: false,
        },
      }),
      readOnly: false,
      destructive: false,
      idempotent: true,
      openWorld: false,
      outputSchema: SettingsToolOutput,
      handle: (input) => {
        const set = getObject(input)?.set
        if (set === undefined) {
          return ctx.relay.settingsGet.pipe(Effect.map((result) => ({ ...result, settings: agentSettings(result.settings) })))
        }
        const changes = getObject(set)
        if (!changes) {
          return Effect.fail(new Error('set must be an object, for example { "grouping": "shared" }'))
        }
        if ("autoUpdate" in changes) {
          return Effect.fail(new Error(
            "autoUpdate can't be read or changed from MCP. The user can change it with `browse settings set autoUpdate=...` or the extension's options page; `status` reports the current value.",
          ))
        }
        return ctx.relay.settingsSet(changes).pipe(Effect.map((result) => ({ ...result, settings: agentSettings(result.settings) })))
      },
    },
  ],
})
