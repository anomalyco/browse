import { Effect } from "effect"
import path from "node:path"
import * as SiteSecrets from "../auth/site-secrets.ts"
import { cliCommand } from "../paths.ts"
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
  build: (ctx) => [
    {
      name: "secrets_list",
      requiresRelayCompatibility: false,
      description:
        `List what agents may type without seeing: site secrets the user stored (names, kinds and allowed origins; type them with secrets.type(target, name) in execute; only the user adds them with \`${cliCommand("secrets add")}\`).`,
      inputSchema: sessionOnlyInputSchema,
      readOnly: true,
      destructive: false,
      idempotent: true,
      handle: () =>
        Effect.gen(function* () {
          const secrets = yield* SiteSecrets.listSecrets()
          return { secrets }
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
