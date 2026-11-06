import { Effect } from "effect"
import { autoUpdateStatus } from "../update/auto-update.ts"
import { getObject } from "../relay/helpers.ts"
import * as RelayLifecycle from "../relay/lifecycle.ts"
import { updateJson } from "../update.ts"
import { securityVariables, settingKeys, settingSpecs } from "../relay/user-settings.ts"
import { TabsCleanupResponse } from "../relay/schema.ts"
import { registerMcpTools } from "./registry.ts"
import { emptyInputSchema, objectSchema, SettingsToolOutput, StatusToolOutput } from "./schema.ts"

registerMcpTools({
  order: 110,
  build: (ctx) => [
    {
      name: "status",
      requiresRelayCompatibility: false,
      description: "Return relay, extension, target, and session status.",
      inputSchema: emptyInputSchema,
      readOnly: true,
      destructive: false,
      idempotent: false,
      outputSchema: StatusToolOutput,
      handle: () =>
        Effect.gen(function* () {
          const [version, status] = yield* Effect.all([ctx.relay.version, ctx.relay.extensionStatus])
          const buildProblem = RelayLifecycle.relayBuildProblem(version)
          const available = updateJson(ctx.update())
          return {
            endpoint: ctx.relay.endpoint,
            currentSession: ctx.currentSession.id,
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
        "Close tabs agents opened that nobody has used for a while (no agent command and not visited by the user). Tabs the user shared or pinned, the active tab, tabs playing audio, recording, or waiting for a handoff stay open. Call it when you finish a task to leave the user's browser tidy; browse also does this automatically after the user's idle setting (10 minutes unless they changed it).",
      inputSchema: objectSchema({
        idleMinutes: {
          type: "integer",
          minimum: 0,
          description:
            "Close tabs idle at least this long. 0 closes every eligible agent tab. Defaults to the user's setting (10 minutes; still 10 when the user set automatic cleanup to never).",
        },
      }),
      readOnly: false,
      destructive: true,
      idempotent: true,
      outputSchema: TabsCleanupResponse,
      handle: (input) => {
        const value =
          typeof input === "object" && input !== null && "idleMinutes" in input ? input.idleMinutes : undefined
        return ctx.relay.tabsCleanup(typeof value === "number" && value >= 0 ? value : undefined)
      },
    },
    {
      name: "settings",
      description: `Read or change the user's browse settings, the same ones as the extension's options page: where agent tabs open (window), how they're grouped (grouping), when untouched agent tabs close (idleMinutes), the agent cursor (cursor), human-like input (humanInput) and handoff notifications (handoffNotifications). Use it only when the user asks to change how browse behaves, never on your own initiative. Without \`set\` it returns each setting's stored value, the value in effect, and the relay environment variable that overrides it, if any. With \`set\` it validates every value strictly, applies the change at once (the options page updates live) and returns what changed: tell the user what you changed. A setting an environment variable fixes is not changed, and the result says so. Security switches (${securityVariables.join(", ")}) are environment-only and can never be read or changed here.`,
      inputSchema: objectSchema({
        set: {
          type: "object",
          description: "Settings to change; omit to only read them.",
          properties: Object.fromEntries(
            settingKeys.map((key) => [key, { enum: [...settingSpecs[key].values], description: settingSpecs[key].label }]),
          ),
          additionalProperties: false,
        },
      }),
      readOnly: false,
      destructive: false,
      idempotent: true,
      outputSchema: SettingsToolOutput,
      handle: (input) => {
        const set = getObject(input)?.set
        if (set === undefined) return ctx.relay.settingsGet
        const changes = getObject(set)
        return changes
          ? ctx.relay.settingsSet(changes)
          : Effect.fail(new Error('set must be an object, for example { "grouping": "shared" }'))
      },
    },
  ],
})

registerMcpTools({
  order: 700,
  build: (ctx) => [
    {
      name: "skill",
      requiresRelayCompatibility: false,
      description: "Return the browse agent skill instructions.",
      inputSchema: emptyInputSchema,
      readOnly: true,
      destructive: false,
      idempotent: true,
      handle: () =>
        Effect.tryPromise({
          try: () => import("../skill-text.ts").then((module) => module.skillText),
          catch: (cause) => new Error("read browse skill", { cause }),
        }),
    },
  ],
})
