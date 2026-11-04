import { Console, Effect, Option } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import * as RelayClient from "../relay-client.ts"
import { defaultJournalBaseDir, formatJournalEntry, readJournalEntries } from "../session-journal.ts"
import * as SessionStore from "../session-store.ts"
import {
  emitJson,
  ensureCliRelay,
  ensureCliRelayAndExtension,
  ensureSessionExists,
  formatSessionContinuation,
  jsonFlag,
  networkSession,
  resolvePositionalOrFlagSessionId,
  sessionFlag,
  sessionIdConfig,
  tabIdFlag,
} from "./context.ts"
import { registerCliCommand } from "./registry.ts"

/** One line for what delete or reset had to end first. */
function describeStop(stopped: { readonly execute: boolean; readonly handoff: boolean; readonly forced: boolean }): string {
  return (
    [stopped.execute ? "a running execute" : undefined, stopped.handoff ? "a pending handoff" : undefined]
      .filter(Boolean)
      .join(" and ") +
    (stopped.forced ? " (the script did not stop in time and was abandoned with its state)" : "")
  )
}

const sessionNew = Command.make(
  "new",
  {
    name: Argument.String("name").pipe(Argument.optional, Argument.withDescription("Optional lowercase session id")),
    readOnly: Flag.Boolean("read-only").pipe(
      Flag.withDefault(false),
      Flag.withDescription(
        "Create a read-only session: the relay rejects input-dispatching CDP so scripts can inspect but not click or type",
      ),
    ),
    allowOrigin: Flag.String("allow-origin").pipe(
      Flag.atLeast(0),
      Flag.withDescription(
        "Only let this session's tabs load these hosts or origins (repeatable or comma-separated): example.com, *.example.com, https://app.example.com, http://localhost:3000",
      ),
    ),
  },
  Effect.fn("Cli.sessionNew")(function* ({ name, readOnly, allowOrigin }) {
    const relay = yield* RelayClient.Service
    yield* ensureCliRelay()
    const store = yield* SessionStore.Service
    const result = yield* relay.sessionNew(Option.getOrUndefined(name), {
      ...(readOnly ? { readOnly: true } : {}),
      ...(allowOrigin.length > 0 ? { allowedOrigins: allowOrigin } : {}),
    })
    yield* store.write(result.id)
    yield* Console.log(result.id)
  }),
).pipe(Command.withDescription("Create a Browse session and make it current"))

const sessionList = Command.make(
  "list",
  {
    json: jsonFlag,
  },
  Effect.fn("Cli.sessionList")(function* ({ json }) {
    const relay = yield* RelayClient.Service
    yield* ensureCliRelay()
    const store = yield* SessionStore.Service
    const sessions = yield* relay.sessions
    const current = yield* store.read
    if (json) {
      yield* emitJson({ current: current ?? undefined, sessions })
      return
    }
    if (sessions.length === 0) {
      yield* Console.log("No sessions")
      return
    }
    yield* Effect.forEach(sessions, (item) => {
      const marker = item.id === current ? "*" : " "
      const page = item.pageUrl ?? "no page yet"
      const keys = item.stateKeys.length ? ` state=${item.stateKeys.join(",")}` : ""
      const readOnly = item.readOnly ? " read-only" : ""
      const allowed = item.allowedOrigins ? ` allow=${item.allowedOrigins.join(",")}` : ""
      return Console.log(`${marker} ${item.id} ${page}${keys}${readOnly}${allowed}`)
    })
  }),
).pipe(Command.withDescription("List Browse sessions"))

const sessionCurrent = Command.make(
  "current",
  {},
  Effect.fn("Cli.sessionCurrent")(function* () {
    const store = yield* SessionStore.Service
    const current = yield* store.read
    yield* Console.log(current ?? "none")
  }),
).pipe(Command.withDescription("Print the current default session"))

const sessionUse = Command.make(
  "use",
  {
    id: Argument.String("id"),
  },
  Effect.fn("Cli.sessionUse")(function* ({ id }) {
    const store = yield* SessionStore.Service
    yield* ensureSessionExists(id)
    yield* store.write(id)
    yield* Console.log(id)
  }),
).pipe(Command.withDescription("Set the current default session"))

const sessionReset = Command.make(
  "reset",
  {
    id: Argument.String("id").pipe(Argument.optional),
    session: sessionFlag("Reset this Browse session id"),
  },
  Effect.fn("Cli.sessionReset")(function* ({ id, session }) {
    const relay = yield* RelayClient.Service
    const sessionId = yield* resolvePositionalOrFlagSessionId(id, session)
    yield* ensureCliRelay()
    const reset = yield* relay.sessionReset(sessionId)
    if (reset.stopped) yield* Console.error(`Stopped first: ${describeStop(reset.stopped)}`)
    yield* Console.log(reset.session.id)
  }),
).pipe(Command.withDescription("Reset a Browse session state and page"))

const sessionAdopt = Command.make(
  "adopt",
  {
    session: sessionFlag(
      "Adopt into this Browse session, creating it when it does not exist yet; omit to create a fresh readable id",
    ),
    targetUrl: Flag.String("target-url").pipe(
      Flag.optional,
      Flag.withDescription("Adopt the attached page whose URL contains this text"),
    ),
    targetIndex: Flag.Int("target-index").pipe(
      Flag.optional,
      Flag.withDescription("Adopt the attached page at this zero-based target index"),
    ),
    tabId: tabIdFlag("Adopt the user's shared tab with this Chrome tab id (the tab= value in status)"),
  },
  Effect.fn("Cli.sessionAdopt")(function* ({ session, targetUrl, targetIndex, tabId }) {
    const relay = yield* RelayClient.Service
    const explicitSessionId = Option.getOrUndefined(session) ?? Option.getOrUndefined(yield* sessionIdConfig)
    yield* ensureCliRelayAndExtension(explicitSessionId)
    const targetUrlValue = Option.getOrUndefined(targetUrl)
    const targetIndexValue = Option.getOrUndefined(targetIndex)
    if (targetIndexValue !== undefined && targetIndexValue < 0) {
      return yield* Effect.fail(new Error("Target index must be a non-negative integer"))
    }
    const tabIdValue = Option.getOrUndefined(tabId)
    if ([targetUrlValue, targetIndexValue, tabIdValue].filter((value) => value !== undefined).length > 1) {
      return yield* Effect.fail(new Error("Use only one target selector: --target-url, --target-index, or --tab-id"))
    }
    const targetSelection = targetUrlValue
      ? { urlIncludes: targetUrlValue }
      : targetIndexValue !== undefined
        ? { index: targetIndexValue }
        : undefined
    // An explicit id names the session the agent wants to continue with; creating it here
    // mirrors `session new <id>` and never infers identity from shared current-session state.
    const result = yield* relay.sessionAdopt({
      ...(explicitSessionId ? { sessionId: explicitSessionId } : {}),
      createIfMissing: true,
      ...(targetSelection ? { targetSelection } : {}),
      ...(tabIdValue === undefined ? {} : { tabId: tabIdValue }),
    })
    yield* Console.log(
      `${result.session.created ? "Created and adopted" : "Adopted"} session '${result.session.id}' default page: ${result.adoptedUrl}`,
    )
    if (result.session.created) {
      yield* Console.error(formatSessionContinuation(result.session.id))
    }
  }),
).pipe(Command.withDescription("Make an attached tab the session's default page"))

const sessionDelete = Command.make(
  "delete",
  {
    id: Argument.String("id").pipe(Argument.optional),
    session: sessionFlag("Delete this Browse session id"),
  },
  Effect.fn("Cli.sessionDelete")(function* ({ id, session }) {
    const relay = yield* RelayClient.Service
    const store = yield* SessionStore.Service
    const sessionId = yield* resolvePositionalOrFlagSessionId(id, session)
    yield* ensureCliRelay()
    const deleted = yield* relay.sessionDelete(sessionId)
    if (deleted.stopped) yield* Console.error(`Stopped first: ${describeStop(deleted.stopped)}`)
    const current = yield* store.read
    if (current === sessionId) {
      yield* store.clear
    }
    yield* Console.log(sessionId)
  }),
).pipe(Command.withDescription("Delete a Browse session"))

const sessionAllow = Command.make(
  "allow",
  {
    session: sessionFlag(),
    origins: Argument.String("origins").pipe(
      Argument.variadic({ min: 0 }),
      Argument.withDescription(
        "Hosts or origins the session's tabs may load: example.com, *.example.com, https://app.example.com, http://localhost:3000",
      ),
    ),
    clear: Flag.Boolean("clear").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Remove the allowlist: the session may load any site again"),
    ),
    json: jsonFlag,
  },
  Effect.fn("Cli.sessionAllow")(function* ({ session, origins, clear, json }) {
    const relay = yield* RelayClient.Service
    yield* ensureCliRelay()
    if (!clear && origins.length === 0) {
      return yield* Effect.fail(new Error("session allow needs origins, or --clear to remove the allowlist"))
    }
    const id = yield* resolvePositionalOrFlagSessionId(Option.none(), session)
    const result = yield* relay.sessionAllowlist(id, clear ? [] : origins)
    if (json) {
      yield* emitJson(result)
      return
    }
    yield* Console.log(
      result.allowedOrigins
        ? `${result.id} may load: ${result.allowedOrigins.join(", ")}`
        : `${result.id} may load any site`,
    )
  }),
).pipe(Command.withDescription("Set the domain allowlist of a session (the current one by default)"))

const session = Command.make("session").pipe(
  Command.withDescription("Manage Browse sessions"),
  Command.withSubcommands([
    sessionNew,
    sessionList,
    sessionCurrent,
    sessionUse,
    sessionReset,
    sessionAdopt,
    sessionDelete,
    sessionAllow,
  ]),
)

const journal = Command.make(
  "journal",
  {
    session: sessionFlag("Show the journal for this Browse session id"),
    limit: Flag.Int("limit").pipe(
      Flag.optional,
      Flag.withDescription("Number of most recent entries to show, defaults to 20"),
    ),
    json: jsonFlag,
  },
  Effect.fn("Cli.journal")(function* ({ session, limit, json }) {
    const sessionId = yield* networkSession(session)
    const entries = yield* Effect.tryPromise({
      try: () =>
        readJournalEntries({
          baseDir: defaultJournalBaseDir(),
          sessionId,
          limit: Option.getOrUndefined(limit) ?? 20,
        }),
      catch: (cause) => new Error(`read session journal for ${sessionId}`, { cause }),
    })
    if (json) {
      yield* emitJson({ session: sessionId, entries })
      return
    }
    if (entries.length === 0) {
      yield* Console.log(`No journal entries for session ${sessionId}`)
      return
    }
    yield* Console.log(`Journal for ${sessionId} (last ${entries.length}):`)
    yield* Effect.forEach(entries, (entry) => {
      return Console.log(formatJournalEntry(entry))
    })
  }),
).pipe(Command.withDescription("Show what agents did in a Browse session"))

registerCliCommand(300, () => session)
registerCliCommand(800, () => journal)
