import { Console, Effect } from "effect"
import { Command, Flag } from "effect/cli"
import { cliCommand } from "../paths.ts"
import * as RelayClient from "../relay/client.ts"
import * as RelayLifecycle from "../relay/lifecycle.ts"
import { registerCliCommand } from "./registry.ts"

const serve = Command.make(
  "serve",
  {},
  Effect.fn("Cli.serve")(function* () {
    const [{ startRelay }, { parseAdditionalExtensionOrigins }] = yield* Effect.promise(() =>
      Promise.all([import("../relay.ts"), import("../relay/helpers.ts")]),
    )
    const port = yield* RelayClient.portConfig
    const additionalExtensionOrigins = parseAdditionalExtensionOrigins(yield* RelayClient.extensionOriginsConfig)
    yield* Effect.scoped(
      Effect.gen(function* () {
        const relay = yield* startRelay({ port, additionalExtensionOrigins })
        yield* Console.log(`browse relay listening at ${relay.url}`)
        yield* Console.log(
          `browse connects automatically while the browser runs. Run \`${cliCommand("status")}\` to check.`,
        )
        yield* Effect.never
      }),
    )
  }),
).pipe(Command.withDescription("Start the local browse relay"))

const relayRestart = Command.make(
  "restart",
  {
    force: Flag.Boolean("force").pipe(
      Flag.withDefault(false),
      Flag.withDescription(
        "End network captures and recordings (discarding them) and disconnect raw CDP clients instead of refusing to restart",
      ),
    ),
  },
  Effect.fn("Cli.relayRestart")(function* ({ force }) {
    const relay = yield* RelayClient.Service
    yield* Console.error("Restarting the relay leaves browser tabs open but resets in-memory JavaScript state.")
    const readiness = yield* RelayLifecycle.restartRelay({ relay, clientKind: "cli", force })
    yield* Console.log(
      `${readiness.started ? "Started" : "Reused concurrent replacement"} browse relay at ${relay.endpoint} (${readiness.version.buildId})`,
    )
  }),
).pipe(Command.withDescription("Explicitly drain and restart the managed relay using this installation"))

const relay = Command.make("relay").pipe(
  Command.withDescription("Manage the local relay lifecycle"),
  Command.withSubcommands([relayRestart]),
)

registerCliCommand(100, () => serve)
registerCliCommand(110, () => relay)
