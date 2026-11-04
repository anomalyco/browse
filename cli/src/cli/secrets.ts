import { Console, Effect, Option } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import path from "node:path"
import process from "node:process"
import * as Deadbolt from "../deadbolt.ts"
import * as RelayClient from "../relay-client.ts"
import * as SiteSecrets from "../site-secrets.ts"
import {
  decodeCliOperands,
  emitJson,
  ensureCliRelay,
  ensureCliRelayAndExtension,
  jsonFlag,
  networkSession,
  printOr,
  sessionFlag,
} from "./context.ts"
import { registerCliCommand } from "./registry.ts"

const secretsStatus = Command.make(
  "status",
  {
    name: Argument.String("name"),
    json: jsonFlag,
  },
  Effect.fn("Cli.secretsStatus")(function* ({ name, json }) {
    const relay = yield* RelayClient.Service
    yield* ensureCliRelay()
    const result = yield* relay.authStatus({ name })
    if (json) {
      yield* emitJson(result)
      return
    }
    yield* Console.log(`Secrets profile ${result.name}: slots=${result.slotCount} updatedAt=${result.updatedAt}`)
    yield* Effect.forEach(result.slots, (slot) =>
      Console.log(
        `- ${slot.ref} sources=${slot.sources.join(",")} expired=${slot.expired}${slot.expiresAt ? ` expiresAt=${slot.expiresAt}` : ""}`,
      ),
    )
  }),
).pipe(Command.withDescription("Show secret profile metadata without revealing values"))

const secretsRefresh = Command.make(
  "refresh",
  {
    name: Argument.String("name"),
    session: sessionFlag(),
    urlFilter: Flag.String("url").pipe(
      Flag.optional,
      Flag.withDescription("Observe credentials only on matching request URLs"),
    ),
    timeoutMs: Flag.Int("timeout-ms").pipe(
      Flag.optional,
      Flag.withDescription("Page reload timeout, defaults to 30000"),
    ),
    json: jsonFlag,
  },
  Effect.fn("Cli.secretsRefresh")(function* ({ name, session, urlFilter, timeoutMs, json }) {
    const relay = yield* RelayClient.Service
    yield* ensureCliRelayAndExtension()
    const sessionId = yield* networkSession(session)
    const result = yield* relay.authRefresh({
      sessionId,
      name,
      ...(Option.isSome(urlFilter) ? { urlFilter: urlFilter.value } : {}),
      ...(Option.isSome(timeoutMs) ? { timeoutMs: timeoutMs.value } : {}),
    })
    yield* printOr(
      json,
      result,
      `Secrets profile ${name} refreshed: observed=${result.observedSecretRefs.length} changed=${result.updatedSecretRefs.length}`,
    )
  }),
).pipe(Command.withDescription("Reload a session page and refresh a profile while preserving stable references"))

const secretsRun = Command.make(
  "run",
  {
    name: Argument.String("name"),
    command: Argument.String("command").pipe(Argument.variadic({ min: 1 })),
    cwd: Flag.String("cwd").pipe(Flag.optional, Flag.withDescription("Child process working directory")),
    timeoutMs: Flag.Int("timeout-ms").pipe(
      Flag.optional,
      Flag.withDescription("Child timeout in milliseconds, defaults to 120000"),
    ),
  },
  Effect.fn("Cli.secretsRun")(function* ({ name, command, cwd, timeoutMs }) {
    const relay = yield* RelayClient.Service
    yield* ensureCliRelay()
    const [executable, ...args] = decodeCliOperands(command)
    if (!executable) return yield* Effect.fail(new Error("secrets run requires a command after --"))
    const result = yield* relay.authRun({
      name,
      command: executable,
      args,
      cwd: path.resolve(Option.getOrElse(cwd, () => process.cwd())),
      ...(Option.isSome(timeoutMs) ? { timeoutMs: timeoutMs.value } : {}),
    })
    yield* Effect.sync(() => {
      if (result.stdout) process.stdout.write(result.stdout)
      if (result.stderr) process.stderr.write(result.stderr)
      if (result.stdoutTruncated || result.stderrTruncated)
        process.stderr.write("\nBrowse truncated child output.\n")
      if (result.exitCode !== 0) process.exitCode = result.exitCode
    })
  }),
).pipe(Command.withDescription("Run a command with profile values injected as BC_SECRET_* environment variables"))

/** Read a secret value from stdin (piped) or a hidden prompt, never from argv. */
function readSecretValue(prompt: string): Promise<string> {
  const input = process.stdin
  if (!input.isTTY) {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      input.on("data", (chunk: Buffer) => chunks.push(chunk))
      input.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
      input.once("error", reject)
    })
  }
  return new Promise((resolve, reject) => {
    process.stderr.write(prompt)
    let value = ""
    const finish = (result: string | Error) => {
      input.setRawMode(false)
      input.pause()
      input.off("data", onData)
      process.stderr.write("\n")
      if (result instanceof Error) reject(result)
      else resolve(result)
    }
    const onData = (chunk: Buffer) => {
      for (const char of chunk.toString("utf8")) {
        if (char === "\r" || char === "\n") return finish(value)
        if (char === "\u0003") return finish(new Error("Cancelled"))
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1)
        else value += char
      }
    }
    input.setRawMode(true)
    input.resume()
    input.on("data", onData)
  })
}

const secretsAdd = Command.make(
  "add",
  {
    name: Argument.String("name").pipe(Argument.withDescription('Secret name agents use: secrets.type(locator, "name")')),
    origin: Flag.String("origin").pipe(
      Flag.atLeast(1),
      Flag.withDescription(
        "Origin the secret may be typed on (repeatable): https://example.com, *.example.com (https), http://localhost:3000",
      ),
    ),
    totp: Flag.Boolean("totp").pipe(
      Flag.withDefault(false),
      Flag.withDescription(
        "The value is a TOTP seed (base32 or otpauth:// URI); typing it types the current code. Storing the seed beside the password makes 2FA one factor",
      ),
    ),
    json: jsonFlag,
  },
  Effect.fn("Cli.secretsAdd")(function* ({ name, origin, totp, json }) {
    const value = yield* Effect.tryPromise({
      try: () => readSecretValue(totp ? `TOTP seed for ${name} (hidden): ` : `Value for ${name} (hidden): `),
      catch: (cause) => (cause instanceof Error ? cause : new Error("Could not read the secret value")),
    })
    const result = yield* SiteSecrets.addSecret({
      name,
      value,
      allowedOrigins: origin,
      kind: totp ? "totp" : "password",
    })
    if (json) {
      yield* emitJson(result)
      return
    }
    yield* Console.log(
      `Saved ${result.kind} secret ${result.name}; it can be typed on ${result.allowedOrigins.join(", ")}`,
    )
    if (totp)
      yield* Console.error(
        "Note: with the TOTP seed stored here, anyone who can use these secrets has both factors. Prefer handing 2FA to a person when you can.",
      )
  }),
).pipe(Command.withDescription("Store a secret agents can type only on its origins (value from stdin or a hidden prompt)"))

const secretsList = Command.make(
  "list",
  { json: jsonFlag },
  Effect.fn("Cli.secretsList")(function* ({ json }) {
    const secrets = yield* SiteSecrets.listSecrets()
    if (json) {
      yield* emitJson({ secrets })
      return
    }
    if (secrets.length === 0) {
      yield* Console.log("No site secrets")
      return
    }
    yield* Effect.forEach(secrets, (secret) =>
      Console.log(`${secret.name} ${secret.kind} ${secret.allowedOrigins.join(",")}`),
    )
  }),
).pipe(Command.withDescription("List site secrets (names, kinds and origins, never values)"))

const secretsRemove = Command.make(
  "remove",
  { name: Argument.String("name") },
  Effect.fn("Cli.secretsRemove")(function* ({ name }) {
    const removed = yield* SiteSecrets.removeSecret(name)
    yield* Console.log(removed ? `Removed ${name}` : `No secret named ${name}`)
  }),
).pipe(Command.withDescription("Delete a site secret"))

const secrets = Command.make("secrets").pipe(
  Command.withDescription("Site secrets agents can type without seeing them, and captured credential profiles"),
  Command.withSubcommands([secretsAdd, secretsList, secretsRemove, secretsStatus, secretsRefresh, secretsRun]),
)

const deadboltConnect = Command.make(
  "connect",
  { json: jsonFlag },
  Effect.fn("Cli.deadboltConnect")(function* ({ json }) {
    const paired = yield* Effect.tryPromise({
      try: () => Deadbolt.pair(),
      catch: (cause) => (cause instanceof Error ? cause : new Error("Could not connect to Deadbolt")),
    })
    if (json) {
      yield* emitJson({ connected: true, id: paired.id })
      return
    }
    yield* Console.log(`Connected Browse to Deadbolt as client ${paired.id}.`)
    yield* Console.log(
      "Agents can use only the logins you allow, in Deadbolt: deadbolt agents allow <site> (narrow with --login, --fields, --expires), or deadbolt agents allow --all for every login",
    )
  }),
).pipe(
  Command.withDescription(
    "Pair Browse with Deadbolt (runs `deadbolt agents add-client browse`, which asks you to confirm) and store its client token (0600)",
  ),
)

const deadboltDisconnect = Command.make(
  "disconnect",
  {},
  Effect.fn("Cli.deadboltDisconnect")(function* () {
    const result = yield* Effect.try({
      try: () => Deadbolt.unpair(),
      catch: (cause) => (cause instanceof Error ? cause : new Error("Could not disconnect from Deadbolt")),
    })
    if (!result.removed) {
      yield* Console.log("Browse isn't connected to Deadbolt")
      return
    }
    yield* Console.log(
      result.revoked
        ? "Disconnected: the client is removed in Deadbolt and its token deleted here."
        : "Deleted the client token here. Deadbolt didn't confirm removing the client: check `deadbolt agents clients`.",
    )
  }),
).pipe(Command.withDescription("Remove Browse's Deadbolt client (in Deadbolt and here)"))

const deadboltStatus = Command.make(
  "status",
  { json: jsonFlag },
  Effect.fn("Cli.deadboltStatus")(function* ({ json }) {
    const client = Deadbolt.readClient()
    const socket = Deadbolt.socketPath()
    const status = client
      ? yield* Effect.promise(() =>
          Deadbolt.connect({ client, socket })
            .status()
            .then(
              (value) => ({ reachable: true as const, ...value }),
              (error: unknown) => ({
                reachable: false as const,
                error: error instanceof Error ? error.message : String(error),
              }),
            ),
        )
      : undefined
    const report = {
      connected: client !== undefined,
      ...(client ? { id: client.id } : {}),
      socket,
      ...(status ? { deadbolt: status } : {}),
    }
    if (json) {
      yield* emitJson(report)
      return
    }
    if (!client) {
      yield* Console.log("Not connected to Deadbolt. Run `opencode-browser deadbolt connect`.")
      return
    }
    yield* Console.log(`Connected as Deadbolt client ${client.id}; socket ${socket}`)
    if (status && status.reachable)
      yield* Console.log(
        `Deadbolt ${status.version ?? ""} (protocol ${status.protocol}) is ${status.unlocked ? "unlocked" : "locked: agent sign-ins are paused until you unlock it"}`,
      )
    else if (status) yield* Console.log(`Deadbolt isn't reachable: ${status.error}`)
  }),
).pipe(
  Command.withDescription("Show whether Browse is paired with Deadbolt and whether Deadbolt is reachable and unlocked"),
)

const deadbolt = Command.make("deadbolt").pipe(
  Command.withDescription("Let agents sign in with the Deadbolt logins you grant them, without seeing any value"),
  Command.withSubcommands([deadboltConnect, deadboltDisconnect, deadboltStatus]),
)

registerCliCommand(610, () => secrets)
registerCliCommand(620, () => deadbolt)
