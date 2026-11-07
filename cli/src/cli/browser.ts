import { Console, Effect, Option, Result } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { autoUpdateStatus } from "../update/auto-update.ts"
import { ExitCode } from "./output.ts"
import { createDoctorReport, formatDoctorReport, formatTargetSummary } from "../doctor.ts"
import { cliCommand, installCommand } from "../paths.ts"
import { extensionProtocolAdvice } from "../protocol.ts"
import * as RelayClient from "../relay/client.ts"
import * as RelayLifecycle from "../relay/lifecycle.ts"
import type { SettingsGetResponse } from "../relay/schema.ts"
import * as SessionStore from "../session-manager/store.ts"
import { formatUpdateNotice, updateJson, updateNotice } from "../update.ts"
import { formatSettings, settingKeys, type SettingKey, type SettingReport } from "../relay/user-settings.ts"
import { emitJson, ensureCliRelay, exitWith, failExit, jsonFlag, stderrLine } from "./context.ts"
import { registerCliCommand } from "./registry.ts"

const tabsCleanup = Command.make(
  "cleanup",
  {
    idleMinutes: Flag.Int("idle-minutes").pipe(
      Flag.optional,
      Flag.withDescription(
        "Close agent tabs idle at least this long; 0 closes every eligible agent tab (default: the extension's setting, 10; still 10 when it is set to never)",
      ),
    ),
    json: jsonFlag,
  },
  Effect.fn("Cli.tabsCleanup")(function* ({ idleMinutes, json }) {
    const relay = yield* RelayClient.Service
    yield* ensureCliRelay()
    const result = yield* relay.tabsCleanup(Option.getOrUndefined(idleMinutes))
    if (json) return yield* emitJson(result)
    if (!result.closed.length) return yield* Console.log("No idle agent tabs to close.")
    for (const tab of result.closed) yield* Console.log(`Closed ${tab.title} (idle ${tab.idleMinutes}m)`)
  }),
).pipe(Command.withDescription("Close tabs agents opened that nobody has used for a while"))

const tabs = Command.make("tabs").pipe(
  Command.withDescription("Manage the tabs agents open"),
  Command.withSubcommands([tabsCleanup]),
)

const printSettings = (settings: SettingsGetResponse["settings"]) =>
  Effect.forEach(
    formatSettings(settings as Record<SettingKey, SettingReport>),
    (line) => Console.log(line),
    { discard: true },
  )

const settingsGet = Command.make(
  "get",
  { json: jsonFlag },
  Effect.fn("Cli.settingsGet")(function* ({ json }) {
    const relay = yield* RelayClient.Service
    yield* ensureCliRelay()
    const result = yield* relay.settingsGet
    if (json) return yield* emitJson(result)
    yield* printSettings(result.settings)
    yield* Console.log(result.note)
  }),
).pipe(
  Command.withDescription(
    "Show each setting's value, the value in effect, and any relay environment variable overriding it",
  ),
)

const settingsSet = Command.make(
  "set",
  {
    assignments: Argument.String("key=value").pipe(
      Argument.variadic({ min: 1 }),
      Argument.withDescription(`Settings to change: ${settingKeys.join(", ")}`),
    ),
    json: jsonFlag,
  },
  Effect.fn("Cli.settingsSet")(function* ({ assignments, json }) {
    const changes: Record<string, string> = {}
    for (const assignment of assignments) {
      const index = assignment.indexOf("=")
      if (index <= 0)
        return yield* Effect.fail(
          new Error(`Expected key=value, got "${assignment}". Settings: ${settingKeys.join(", ")}.`),
        )
      changes[assignment.slice(0, index)] = assignment.slice(index + 1)
    }
    const relay = yield* RelayClient.Service
    yield* ensureCliRelay()
    const result = yield* relay.settingsSet(changes)
    if (json) return yield* emitJson(result)
    yield* Console.log(result.message)
    yield* printSettings(result.settings)
  }),
).pipe(Command.withDescription("Change settings (validated strictly; the extension's options page updates live)"))

const settings = Command.make("settings").pipe(
  Command.withDescription(
    "Read or change the user's settings (the extension's options page). Security switches are environment-only",
  ),
  Command.withSubcommands([settingsGet, settingsSet]),
)

const status = Command.make(
  "status",
  {
    json: jsonFlag,
  },
  Effect.fn("Cli.status")(function* ({ json }) {
    const relay = yield* RelayClient.Service
    const store = yield* SessionStore.Service
    const [relayResult, update] = yield* Effect.all(
      [Effect.result(relay.version), Effect.promise(() => updateNotice())],
      { concurrency: 2 },
    )
    const updateLine = update ? formatUpdateNotice(update) : undefined
    if (Result.isFailure(relayResult)) {
      if (!(relayResult.failure instanceof RelayClient.RelayUnreachable)) {
        if (json) {
          yield* emitJson({
            endpoint: relay.endpoint,
            relay: { running: false, error: relayResult.failure.message },
            extension: null,
            sessions: [],
            targets: [],
            update: updateJson(update),
          })
        }
        yield* stderrLine(`Relay status failed: ${relayResult.failure.message}`)
        yield* exitWith(ExitCode.host)
        return
      }
      const stopped = RelayLifecycle.stoppedRelayStatus(relay.endpoint)
      if (json) {
        yield* emitJson({ ...stopped, update: updateJson(update), autoUpdate: autoUpdateStatus() })
        yield* stderrLine(`relay is not running at ${relay.endpoint}`)
      } else {
        yield* Console.log(`Relay: stopped (${relay.endpoint})`)
        yield* Console.log(`Run \`${cliCommand("execute")}\` (or any relay-backed command) to start it automatically.`)
        if (updateLine) yield* Console.log(updateLine)
      }
      yield* exitWith(ExitCode.host)
      return
    }
    const version = relayResult.success
    const buildProblem = RelayLifecycle.relayBuildProblem(version)
    const [extensionStatus, current] = yield* Effect.all([relay.extensionStatus, store.read])
    const collections = RelayLifecycle.statusCollections(extensionStatus)
    const [sessions, targets] = collections
      ? [collections.sessions, collections.targets]
      : yield* Effect.all([relay.sessions, relay.targets])
    if (json) {
      yield* emitJson({
        endpoint: relay.endpoint,
        relay: {
          running: true,
          version: version.version,
          buildId: version.buildId ?? null,
          stale: buildProblem !== undefined,
        },
        extension: extensionStatus,
        currentSession: current ?? null,
        sessions,
        targets,
        update: updateJson(update),
        autoUpdate: autoUpdateStatus(),
      })
      if (buildProblem) {
        yield* stderrLine(buildProblem)
        yield* failExit
      }
      return
    }
    if (updateLine) yield* Console.log(updateLine)
    yield* Console.log(`Relay: ${relay.endpoint} (${version.version})`)
    if (buildProblem) {
      yield* Console.log(`Warning: ${buildProblem}`)
    }
    yield* Console.log(
      `Extension: ${extensionStatus.connected ? "connected" : "disconnected"}${extensionStatus.version ? ` (${extensionStatus.version})` : ""}`,
    )
    if ((extensionStatus.rejectedConnections ?? 0) > 0) {
      yield* Console.log(
        `Warning: ${extensionStatus.rejectedConnections} competing browser/profile connection attempt(s) rejected; the active connection was preserved. The relay is an older browse that connects one browser at a time; update browse on the computer running the relay, or close the other browser.`,
      )
    }
    if (extensionStatus.nextStep) yield* Console.log(extensionStatus.nextStep)
    else if ((extensionStatus.pairingFailures ?? 0) > 0 && !extensionStatus.connected) {
      yield* Console.log(
        `Warning: ${extensionStatus.pairingFailures} extension connection(s) failed pairing. Update the extension, or run \`${cliCommand("pair")}\` and enter the code on its status page.`,
      )
    }
    if ((extensionStatus.processFaults?.suppressed ?? 0) > 0) {
      const faults = extensionStatus.processFaults!
      yield* Console.log(
        `Warning: the relay survived ${faults.suppressed} process fault(s)${faults.lastAt ? `, last at ${faults.lastAt}` : ""}${faults.lastMessage ? `: ${faults.lastMessage}` : ""}. See the relay log.`,
      )
    }
    if (extensionStatus.protocolVersion !== undefined && extensionStatus.protocolVersion !== null) {
      const compatibility = extensionStatus.protocolCompatible === false ? "incompatible" : "compatible"
      const legacy = extensionStatus.protocolLegacy === true ? ", inferred from legacy hello" : ""
      yield* Console.log(`Extension protocol: ${extensionStatus.protocolVersion} (${compatibility}${legacy})`)
      if (extensionStatus.protocolCompatible === false && !extensionStatus.nextStep)
        yield* Console.log(extensionProtocolAdvice(extensionStatus.protocolVersion, { install: installCommand() }))
    }
    yield* Console.log(`Active targets: ${extensionStatus.activeTargets}`)
    if (extensionStatus.childTargets !== undefined) {
      yield* Console.log(`Child targets: ${extensionStatus.childTargets}`)
    }
    if (extensionStatus.cdpClients !== undefined) {
      yield* Console.log(`CDP clients: ${extensionStatus.cdpClients}`)
    }
    yield* Console.log(`Current session: ${current ?? "none"}`)
    if (sessions.length === 0) {
      yield* Console.log("Sessions: none")
    } else {
      yield* Console.log("Sessions:")
      const activeSessions = sessions.filter(
        (item) =>
          item.id === current ||
          item.connected ||
          item.pageUrl !== null ||
          item.stateKeys.length > 0 ||
          item.readOnly,
      )
      const idleSessions = sessions.filter((item) => !activeSessions.includes(item))
      const shownSessions = activeSessions.length > 0 ? activeSessions : idleSessions.slice(0, 5)
      const omittedIdleCount =
        activeSessions.length > 0 ? idleSessions.length : Math.max(0, idleSessions.length - shownSessions.length)
      yield* Effect.forEach(shownSessions, (item) => {
        const marker = item.id === current ? "*" : " "
        return Console.log(`${marker} ${item.id} ${item.pageUrl ?? "no page yet"}`)
      })
      if (omittedIdleCount > 0) {
        yield* Console.log(
          `  (${omittedIdleCount} idle session(s) with no page omitted; run ${cliCommand("session list")} to view all)`,
        )
      }
    }
    if (targets.length === 0) {
      yield* Console.log("Targets: none")
    } else {
      yield* Console.log("Targets:")
      yield* Effect.forEach(targets, (target, index) => {
        return Console.log(`- [${index}] ${formatTargetSummary(target, { includeSession: true })}`)
      })
    }
    if (buildProblem) {
      yield* failExit
    }
  }),
).pipe(Command.withDescription("Show relay, extension, and target status"))

const mcp = Command.make(
  "mcp",
  {},
  Effect.fn("Cli.mcp")(function* () {
    const { runMcpServer } = yield* Effect.promise(() => import("../mcp.ts"))
    yield* runMcpServer
  }),
).pipe(Command.withDescription("Run the browse MCP server over stdio"))

registerCliCommand(400, () => tabs)
registerCliCommand(410, () => settings)
registerCliCommand(500, () => status)
registerCliCommand(810, ({ packageRoot }) =>
  Command.make(
    "doctor",
    {
      json: jsonFlag,
    },
    Effect.fn("Cli.doctor")(function* ({ json }) {
      const update = yield* Effect.promise(() => updateNotice())
      const report = yield* createDoctorReport({ packageRoot, update: updateJson(update) })
      if (json) {
        yield* emitJson(report)
      } else {
        yield* Console.log(formatDoctorReport(report))
      }
      if (report.status === "fail") {
        yield* failExit
      }
    }),
  ).pipe(Command.withDescription("Diagnose the local browse install and runtime")),
)
registerCliCommand(820, () =>
  Command.make(
    "skill",
    {},
    Effect.fn("Cli.skill")(function* () {
      const { skillText } = yield* Effect.promise(() => import("../skill-text.ts"))
      yield* Console.log(skillText.trimEnd())
    }),
  ).pipe(Command.withDescription("Print the browse agent skill text")),
)
registerCliCommand(900, () => mcp)
