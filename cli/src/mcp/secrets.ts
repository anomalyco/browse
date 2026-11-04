import { Effect } from "effect"
import path from "node:path"
import * as Deadbolt from "../auth/deadbolt.ts"
import * as RelayLifecycle from "../relay/lifecycle.ts"
import * as SiteSecrets from "../auth/site-secrets.ts"
import { registerMcpTools } from "./registry.ts"
import {
  objectSchema,
  optionalPositiveIntegerField,
  optionalStringArrayField,
  optionalStringField,
  requiredStringField,
  requireObject,
  sessionOnlyInputSchema,
  sessionSchemaProperty,
} from "./schema.ts"

registerMcpTools({
  order: 600,
  nonCompatibilityTools: ["secrets_list", "secrets_status"],
  build: (ctx) => [
    {
      name: "secrets_list",
      requiresRelayCompatibility: false,
      description:
        'List what agents may type without seeing: site secrets the user stored (names, kinds and allowed origins; type them with secrets.type(target, name) in execute; only the user adds them with `opencode-browser secrets add`), and Deadbolt logins the user granted to Browse for this session\'s allowed sites (title, username, which values and passkeys, never values; sign in with the signin tool or secrets.signIn(), or type one value with secrets.type(target, "deadbolt:<site>[/<username>]", { field })). Passkeys are listed by account (username, displayName). Only the user grants Deadbolt logins, in Deadbolt (`deadbolt agents allow <site>`, or `deadbolt agents allow --all`).',
      inputSchema: sessionOnlyInputSchema,
      readOnly: true,
      destructive: false,
      idempotent: true,
      handle: (input) =>
        Effect.gen(function* () {
          const secrets = yield* SiteSecrets.listSecrets()
          if (!Deadbolt.readClient()) {
            return {
              secrets,
              deadbolt: {
                connected: false,
                logins: [],
                passkeys: [],
                note: "Browse isn't connected to Deadbolt. The user can connect it with `opencode-browser deadbolt connect` and grant logins with `deadbolt agents allow <site>`.",
              },
            }
          }
          const deadbolt = yield* ctx.relay.deadboltLogins({ sessionId: ctx.resolveSessionId(input) }).pipe(
            Effect.catch((error) =>
              Effect.succeed({
                connected: true,
                origins: [],
                logins: [],
                passkeys: [],
                error: { code: "unavailable", message: error.message },
              }),
            ),
          )
          return { secrets, deadbolt }
        }),
    },
    {
      name: "signin",
      description:
        'Sign in to a site in the session\'s page with a Deadbolt login the user granted to Browse, without seeing any value. The relay does the whole sign-in in one call: username, submit, password, an authenticator (TOTP) code when asked (split boxes too), "Use password instead" toggles, and Sign in with Google when a Google login is granted. A username also picks the passkey account when the site signs in with a passkey. Returns only {status: signed_in | needs_user | needs_choice | not_granted | failed, step, reason}; needs_choice comes with choices [{username, displayName}] when several passkeys could sign in: call again with one username. needs_user means a captcha, a code sent by SMS or email, a push approval or a new-device check: hand it to the user with handoff() in execute. not_granted: tell the user what to allow (`deadbolt agents allow <site>`). Navigate to the sign-in page first, or pass site.',
      inputSchema: objectSchema({
        site: {
          type: "string",
          description:
            "The login's site: a host like github.com, or an exact origin. Defaults to the page's site; the page goes there first when it is elsewhere.",
        },
        username: {
          type: "string",
          description: "Which login (and which passkey account), when several are granted for the site.",
        },
        session: sessionSchemaProperty,
        timeoutMs: { type: "integer", minimum: 1, description: "Overall limit. Defaults to 90000." },
      }),
      readOnly: false,
      destructive: true,
      idempotent: false,
      handle: (input) =>
        Effect.gen(function* () {
          const object = input === undefined ? {} : requireObject(input)
          const site = optionalStringField(object, "site")
          const username = optionalStringField(object, "username")
          const timeoutMs = optionalPositiveIntegerField(object, "timeoutMs")
          const explicitSession = optionalStringField(object, "session")
          const sessionId = explicitSession ?? ctx.currentSession.id
          yield* RelayLifecycle.ensureExtensionConnected({ relay: ctx.relay, sessionId, waitForReconnect: true })
          const options = {
            ...(site ? { site } : {}),
            ...(username ? { username } : {}),
            ...(timeoutMs === undefined ? {} : { timeoutMs }),
          }
          const outerTimeoutMs = timeoutMs === undefined ? 120_000 : Math.max(60_000, timeoutMs + 10_000)
          const result = yield* ctx.relay.execute({
            sessionId,
            code: `return await secrets.signIn(${JSON.stringify(options)})`,
            createIfMissing: !explicitSession,
            timeoutMs: outerTimeoutMs,
          })
          ctx.establishCurrentSession(sessionId)
          if (result.isError) return yield* Effect.fail(new Error(result.text))
          return {
            ...(result.value as object),
            ...(result.aftermath?.endUrl ? { url: result.aftermath.endUrl } : {}),
            ...(result.warnings?.length ? { warnings: result.warnings } : {}),
          }
        }),
    },
    {
      name: "secrets_status",
      requiresRelayCompatibility: false,
      description:
        "Return secret profile references, sources, and expiration metadata without revealing credential values.",
      inputSchema: objectSchema({ name: { type: "string", description: "Secret profile name." } }, ["name"]),
      readOnly: true,
      destructive: false,
      idempotent: true,
      handle: (input) => ctx.relay.authStatus({ name: requiredStringField(input, "name") }),
    },
    {
      name: "secrets_refresh",
      description:
        "Reload a session page, observe fresh credentials, and update a secret profile while preserving stable BC_SECRET_N references.",
      inputSchema: objectSchema(
        {
          name: { type: "string", description: "Existing secret profile name." },
          session: sessionSchemaProperty,
          urlFilter: { type: "string", description: "Observe credentials only on matching request URLs." },
          timeoutMs: { type: "integer", minimum: 1, description: "Reload timeout. Defaults to 30000." },
        },
        ["name"],
      ),
      readOnly: false,
      destructive: true,
      idempotent: false,
      handle: (input) => {
        const object = requireObject(input)
        const timeoutMs = optionalPositiveIntegerField(object, "timeoutMs")
        const urlFilter = optionalStringField(object, "urlFilter")
        return ctx.relay.authRefresh({
          sessionId: ctx.resolveSessionId(object),
          name: requiredStringField(object, "name"),
          ...(urlFilter ? { urlFilter } : {}),
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        })
      },
    },
    {
      name: "secrets_run",
      description:
        "Run a local command with a captured profile injected as BC_SECRET_N environment variables. Known values are replaced with their references in stdout and stderr, which keeps them out of transcripts. The command receives the real values, so redaction does not protect them from a command that deliberately sends or encodes them: run only commands you wrote or trust.",
      inputSchema: objectSchema(
        {
          name: { type: "string", description: "Secret profile name." },
          command: { type: "string", description: "Executable path or command name." },
          args: { type: "array", items: { type: "string" }, description: "Command arguments." },
          cwd: { type: "string", description: "Optional child working directory." },
          timeoutMs: { type: "integer", minimum: 1, description: "Child timeout. Defaults to 120000." },
        },
        ["name", "command"],
      ),
      readOnly: false,
      destructive: true,
      idempotent: false,
      handle: (input) => {
        const object = requireObject(input)
        const args = optionalStringArrayField(object, "args")
        const cwd = optionalStringField(object, "cwd")
        const timeoutMs = optionalPositiveIntegerField(object, "timeoutMs")
        return ctx.relay.authRun({
          name: requiredStringField(object, "name"),
          command: requiredStringField(object, "command"),
          ...(args ? { args } : {}),
          cwd: path.resolve(cwd ?? process.cwd()),
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        })
      },
    },
  ],
})
