import { NodeStdio } from "@effect/platform-node"
import { Config, Context, Effect, Layer, Option, Predicate } from "effect"
import { McpProtocol, McpSchema, McpServer } from "effect/ai"
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { JsonObject } from "./protocol.ts"
import { getObject, getString, parseTargetSelection } from "./relay-helpers.ts"
import * as RelayClient from "./relay-client.ts"
import * as RelayLifecycle from "./relay-lifecycle.ts"
import * as SiteSecrets from "./site-secrets.ts"
import * as Deadbolt from "./deadbolt.ts"
import type { TargetSelection } from "./relay-schema.ts"
import { autoUpdateStatus } from "./auto-update.ts"
import { createUpdateWatcher, updateJson, type UpdateNotice } from "./update.ts"
import { securityVariables, settingKeys, settingSpecs } from "./user-settings.ts"
import { opencodeBrowserVersion } from "./version.ts"

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
type CurrentSession = { id: string; established: boolean }

type ToolSpec = {
  readonly name: string
  readonly description: string
  readonly inputSchema: JsonObject
  readonly readOnly: boolean
  readonly destructive: boolean
  readonly idempotent: boolean
  readonly handle: (input: unknown) => Effect.Effect<unknown, Error>
}

type ExecuteArguments = {
  readonly code: string
  readonly session?: string | undefined
  readonly targetSelection?: TargetSelection
}

type AdoptArguments = {
  readonly session?: string | undefined
  readonly targetSelection?: TargetSelection
  readonly tabId?: number
}

const emptyInputSchema = objectSchema({})
const sessionSchemaProperty = {
  type: "string",
  description: "Optional session id. Defaults to this MCP server's current session.",
} as const
const sessionAliasSchemaProperty = { type: "string", description: "Same as id." } as const
const sessionOnlyInputSchema = objectSchema({
  session: sessionSchemaProperty,
})

function makeToolSpecs(relay: RelayClient.Interface, currentSession: CurrentSession, update: () => UpdateNotice | undefined = () => undefined): readonly ToolSpec[] {
  // session_reset and session_delete name the session `id`; `session`, as every other tool calls it, means the same
  // there. Ignoring it used to reset or delete the current session instead of the one asked for.
  const resolveSessionId = (input: unknown, field = "session") =>
    optionalStringField(input, field) ?? (field === "id" ? optionalStringField(input, "session") : undefined) ?? currentSession.id
  const establishCurrentSession = (id: string) => {
    currentSession.id = id
    currentSession.established = true
  }
  return [
    {
      name: "execute",
      description: "Execute Playwright JavaScript against the Browse session. Code runs in a sandbox on the relay without process, require, import(), fs, child_process, http/https or Node fetch; save and read files with the files helper inside the execute file roots, and cookie access is limited to the session's pages. The result includes console logs, warnings, a bounded execution-context diagnostic when relevant, and an aftermath summary (URL movement, navigations, error counts, handoffs, and a bot challenge or block page when one appears: hand interactive ones to the user with handoff(), never solve or retry-loop them).",
      inputSchema: objectSchema({
        code: { type: "string", description: "JavaScript code to execute. It receives browser, context, page, state, modules (path, url, util, crypto, buffer, zlib, events, stream), files (dir, path, write, read), fillInput, fillInputs, snapshot(options?) for compact semantic outlines, search, explicit diffs, or automatic deltas, persistent compatible ref(id) locators, webmcp (list/call), screenshot helpers, ariaSnapshot, ghostCursor, handoff, demonstrate, network capture, pageConsole (start/stop capturing the page's own console messages and errors, off by default because pages can detect it), secrets.type(locator, name) to type a stored site secret or a granted Deadbolt login (\"deadbolt:<site>[/<username>]\", { field: \"username\" }, or a password/code with { submit: true }; see secrets_list) only on its allowed origins, without seeing it, secrets.signIn({ site?, username? }) for a whole sign-in (same as the signin tool), and secrets.usePasskey({ site, username }) to pick the passkey account for the tab's next passkey request." },
        session: { type: "string", description: "Optional existing Browse session id. Explicit ids must already exist; omit this field to use the MCP server's current session, which is created when needed." },
        targetUrl: { type: "string", description: "Optional URL substring selecting an existing attached page. This does not navigate or open a URL; use page.goto() for that." },
        targetIndex: { type: "integer", minimum: 0, description: "Optional zero-based attached page index selector." },
      }, ["code"]),
      readOnly: false,
      destructive: true,
      idempotent: false,
      handle: (input) => Effect.gen(function* () {
        const args = yield* Effect.try(() => parseExecuteArguments(input))
        yield* RelayLifecycle.ensureExtensionConnected({ relay, waitForReconnect: true })
        const sessionId = args.session ?? currentSession.id
        const result = yield* relay.execute({
          sessionId,
          code: args.code,
          createIfMissing: !args.session,
          ...(args.targetSelection ? { targetSelection: args.targetSelection } : {}),
        })
        const recreated = !args.session && currentSession.established && result.session.created === true
        establishCurrentSession(sessionId)
        return {
          ...result,
          ...(recreated ? { notice: `Recreated session '${sessionId}' — relay had no such session; page and state were reset.` } : {}),
        }
      }),
    },
    {
      name: "status",
      description: "Return relay, extension, target, and session status.",
      inputSchema: emptyInputSchema,
      readOnly: true,
      destructive: false,
      idempotent: false,
      handle: () => Effect.gen(function* () {
        const [version, status] = yield* Effect.all([relay.version, relay.extensionStatus])
        const buildProblem = RelayLifecycle.relayBuildProblem(version)
        const available = updateJson(update())
        return { endpoint: relay.endpoint, currentSession: currentSession.id, version, status, ...(buildProblem ? { buildProblem } : {}), ...(available ? { update: available } : {}), autoUpdate: autoUpdateStatus() }
      }),
    },
    {
      name: "session_new",
      description: "Create a Browse session and make it current for this MCP server.",
      inputSchema: objectSchema({
        id: { type: "string", description: "Optional lowercase session id." },
        readOnly: { type: "boolean", description: "Create a read-only session: the relay rejects input-dispatching CDP so scripts can inspect but not click or type." },
        allowedOrigins: { type: "array", items: { type: "string" }, description: "Optional domain allowlist: hosts or origins this session's tabs may load (example.com, *.example.com, https://app.example.com, http://localhost:3000). Navigations elsewhere are refused or sent back to about:blank; private and loopback addresses need an exact entry." },
      }),
      readOnly: false,
      destructive: false,
      idempotent: false,
      handle: (input) => Effect.gen(function* () {
        const requestedId = optionalStringField(input, "id")
        const readOnly = optionalBooleanField(input, "readOnly")
        const allowedOrigins = optionalStringArrayField(input, "allowedOrigins")
        const session = yield* relay.sessionNew(requestedId, {
          ...(readOnly ? { readOnly: true } : {}),
          ...(allowedOrigins ? { allowedOrigins } : {}),
        })
        establishCurrentSession(session.id)
        return { session }
      }),
    },
    {
      name: "session_allowlist",
      description: "Set the domain allowlist of a session (the current one by default): the hosts or origins its tabs may load. Pass an empty list to remove it. Use it before typing secrets or working on sites with untrusted content.",
      inputSchema: objectSchema({
        session: { type: "string", description: "Session id; defaults to the current session." },
        allowedOrigins: { type: "array", items: { type: "string" }, description: "Patterns: example.com, *.example.com, https://app.example.com, http://localhost:3000. Empty removes the allowlist." },
      }, ["allowedOrigins"]),
      readOnly: false,
      destructive: false,
      idempotent: true,
      handle: (input) => Effect.gen(function* () {
        const sessionId = resolveSessionId(input)
        const allowedOrigins = requireObject(input).allowedOrigins
        if (!Array.isArray(allowedOrigins) || !allowedOrigins.every((item) => Predicate.isString(item))) {
          return yield* Effect.fail(new Error("allowedOrigins must be an array of strings"))
        }
        return { session: yield* relay.sessionAllowlist(sessionId, allowedOrigins) }
      }),
    },
    {
      name: "session_list",
      description: "List Browse sessions.",
      inputSchema: emptyInputSchema,
      readOnly: true,
      destructive: false,
      idempotent: false,
      handle: () => relay.sessions.pipe(Effect.map((sessions) => ({ sessions }))),
    },
    {
      name: "session_current",
      description: "Return this MCP server's current Browse session id.",
      inputSchema: emptyInputSchema,
      readOnly: true,
      destructive: false,
      idempotent: true,
      handle: () => Effect.succeed({ currentSession: currentSession.id }),
    },
    {
      name: "session_use",
      description: "Set this MCP server's current Browse session id.",
      inputSchema: objectSchema({
        id: { type: "string", description: "Existing Browse session id." },
      }, ["id"]),
      readOnly: false,
      destructive: false,
      idempotent: true,
      handle: (input) => Effect.gen(function* () {
        const id = yield* Effect.try(() => requiredStringField(input, "id"))
        yield* ensureSessionExists(relay, id)
        establishCurrentSession(id)
        return { currentSession: currentSession.id }
      }),
    },
    {
      name: "session_reset",
      description: "Reset a Browse session's state and page.",
      inputSchema: objectSchema({
        id: sessionSchemaProperty,
        session: sessionAliasSchemaProperty,
      }),
      readOnly: false,
      destructive: true,
      idempotent: false,
      handle: (input) => Effect.gen(function* () {
        const id = resolveSessionId(input, "id")
        const reset = yield* relay.sessionReset(id)
        establishCurrentSession(id)
        return reset
      }),
    },
    {
      name: "session_delete",
      description: "Delete a Browse session.",
      inputSchema: objectSchema({
        id: sessionSchemaProperty,
        session: sessionAliasSchemaProperty,
      }),
      readOnly: false,
      destructive: true,
      idempotent: true,
      handle: (input) => Effect.gen(function* () {
        const id = resolveSessionId(input, "id")
        const result = yield* relay.sessionDelete(id)
        if (currentSession.id === id) {
          currentSession.id = `mcp-${crypto.randomUUID().slice(0, 8)}`
          currentSession.established = false
        }
        return { ...result, currentSession: currentSession.id }
      }),
    },
    {
      name: "session_adopt",
      description: "Make an attached tab the Browse session's default page for subsequent bare execute calls. Omit targetUrl and targetIndex when only one user-attached tab is available.",
      inputSchema: objectSchema({
        session: { type: "string", description: "Optional existing Browse session id. Explicit ids must already exist; omit this field to use the MCP server's current session, which is created when needed." },
        targetUrl: { type: "string", description: "Adopt an existing attached page whose URL contains this text. Omit when only one user-attached tab is available. This does not navigate or open a URL." },
        targetIndex: { type: "integer", minimum: 0, description: "Adopt the attached page at this zero-based target index." },
        tabId: { type: "integer", description: "Adopt the user's tab with this Chrome tab id (the tab= value in status)." },
      }),
      readOnly: false,
      destructive: false,
      idempotent: false,
      handle: (input) => Effect.gen(function* () {
        const args = yield* Effect.try(() => parseAdoptArguments(input))
        const sessionId = args.session ?? currentSession.id
        const result = yield* relay.sessionAdopt({
          sessionId,
          createIfMissing: !args.session,
          ...(args.targetSelection ? { targetSelection: args.targetSelection } : {}),
          ...(args.tabId === undefined ? {} : { tabId: args.tabId }),
        })
        establishCurrentSession(sessionId)
        return { ...result, confirmation: `Adopted session '${result.session.id}' default page: ${result.adoptedUrl}` }
      }),
    },
    {
      name: "network_start",
      description: "Start session-scoped network capture. Browse records normalized Playwright exchanges; HAR is only the optional export format. Bodies are embedded by default with per-body and total memory limits.",
      inputSchema: objectSchema({
        session: { type: "string", description: "Optional existing session id. Omit to use or create this MCP server's current session." },
        urlFilter: { type: "string", description: "Capture only request URLs containing this text." },
        resourceTypes: { type: "array", items: { type: "string" }, description: "Optional Playwright resource types such as fetch and xhr." },
        content: { type: "string", enum: ["embed", "omit"], description: "Request and response body mode. Defaults to embed." },
        maxBodyBytes: { type: "integer", minimum: 1, description: "Maximum bytes captured from each body. Defaults to 1000000." },
        maxTotalBodyBytes: { type: "integer", minimum: 1, description: "Maximum body bytes retained for the capture. Defaults to 25000000." },
        maxEntries: { type: "integer", minimum: 1, description: "Maximum captured requests. Defaults to 1000." },
        maxDurationMs: { type: "integer", minimum: 1, maximum: 86_400_000, description: "The capture ends by itself, discarding what it captured, after this long. Defaults to 1800000 (30 minutes). It also ends when this MCP server exits." },
      }),
      readOnly: false,
      destructive: false,
      idempotent: false,
      handle: (input) => Effect.gen(function* () {
        const object = requireObject(input)
        const explicitSession = optionalStringField(object, "session")
        const sessionId = explicitSession ?? currentSession.id
        if (explicitSession) {
          yield* ensureSessionExists(relay, sessionId)
        } else {
          yield* relay.sessionEnsure(sessionId)
          currentSession.established = true
        }
        yield* RelayLifecycle.ensureExtensionConnected({ relay, waitForReconnect: true })
        const content = optionalStringField(object, "content")
        if (content !== undefined && content !== "embed" && content !== "omit") {
          return yield* Effect.fail(new Error("content must be embed or omit"))
        }
        const urlFilter = optionalStringField(object, "urlFilter")
        const resourceTypes = optionalStringArrayField(object, "resourceTypes")
        const maxBodyBytes = optionalPositiveIntegerField(object, "maxBodyBytes")
        const maxTotalBodyBytes = optionalPositiveIntegerField(object, "maxTotalBodyBytes")
        const maxEntries = optionalPositiveIntegerField(object, "maxEntries")
        const maxDurationMs = optionalPositiveIntegerField(object, "maxDurationMs")
        const result = yield* relay.networkStart({
          sessionId,
          ...(urlFilter ? { urlFilter } : {}),
          ...(resourceTypes && resourceTypes.length > 0 ? { resourceTypes } : {}),
          ...(content ? { content } : {}),
          ...(maxBodyBytes === undefined ? {} : { maxBodyBytes }),
          ...(maxTotalBodyBytes === undefined ? {} : { maxTotalBodyBytes }),
          ...(maxEntries === undefined ? {} : { maxEntries }),
          ...(maxDurationMs === undefined ? {} : { maxDurationMs }),
        })
        return { session: sessionId, ...result }
      }),
    },
    {
      name: "network_status",
      description: "Return bounded metadata for a session's active network capture. Captured values are never included.",
      inputSchema: sessionOnlyInputSchema,
      readOnly: true,
      destructive: false,
      idempotent: true,
      handle: (input) => {
        const sessionId = resolveSessionId(input)
        return relay.networkStatus({ sessionId }).pipe(Effect.map((result) => ({ session: sessionId, ...result })))
      },
    },
    {
      name: "network_stop",
      description: "Stop network capture. Optionally write a credential-redacted HAR and store lossless credential values in a reusable secret profile. At least one of outputPath or secrets is required.",
      inputSchema: objectSchema({
        session: sessionSchemaProperty,
        outputPath: { type: "string", description: "Optional artifact path, resolved against the MCP process working directory. The HAR contains stable ${BC_SECRET_N} references (and redaction-only ${BC_REDACTED_N} for passwords, one-time codes and token-like URL path segments), not captured values." },
        secrets: { type: "string", description: "Optional reusable profile name for captured credential values." },
      }),
      readOnly: false,
      destructive: false,
      idempotent: false,
      handle: (input) => Effect.gen(function* () {
        const sessionId = resolveSessionId(input)
        const outputPath = optionalStringField(input, "outputPath")
        const secrets = optionalStringField(input, "secrets")
        if (!outputPath && !secrets) {
          return yield* Effect.fail(new Error("network_stop requires outputPath, secrets, or both"))
        }
        return yield* relay.networkStop({
          sessionId,
          ...(outputPath ? { outputPath: path.resolve(outputPath) } : {}),
          ...(secrets ? { secrets } : {}),
        })
      }),
    },
    {
      name: "network_cancel",
      description: "Cancel a session's network capture and discard its in-memory exchanges.",
      inputSchema: sessionOnlyInputSchema,
      readOnly: false,
      destructive: true,
      idempotent: true,
      handle: (input) => relay.networkCancel({ sessionId: resolveSessionId(input) }),
    },
    {
      name: "recording_start",
      description: "Start recording the current session tab. CDP mode records video to WebM or MP4; tab-capture mode supports WebM and optional audio.",
      inputSchema: objectSchema({
        session: sessionSchemaProperty,
        outputPath: { type: "string", description: "Recording artifact path, resolved against the MCP process working directory." },
        mode: { type: "string", enum: ["auto", "tab-capture", "cdp"], description: "Recording backend. Defaults to auto." },
        audio: { type: "boolean", description: "Capture tab audio in tab-capture mode." },
        frameRate: { type: "integer", minimum: 1, maximum: 60, description: "Requested frame rate." },
        maxDurationMs: { type: "integer", minimum: 1, description: "Maximum recording duration in milliseconds." },
        cursor: { type: "boolean", description: "Draw the ghost cursor in the recording, for demo videos. Off by default: recordings show only the page, with nothing from Browse in the frame." },
      }, ["outputPath"]),
      readOnly: false,
      destructive: false,
      idempotent: false,
      handle: (input) => {
        const object = requireObject(input)
        const mode = optionalStringField(object, "mode")
        if (mode !== undefined && mode !== "auto" && mode !== "tab-capture" && mode !== "cdp") {
          return Effect.fail(new Error("mode must be auto, tab-capture, or cdp"))
        }
        const frameRate = optionalPositiveIntegerField(object, "frameRate")
        if (frameRate !== undefined && frameRate > 60) return Effect.fail(new Error("frameRate must be at most 60"))
        const maxDurationMs = optionalPositiveIntegerField(object, "maxDurationMs")
        const audio = optionalBooleanField(object, "audio")
        const cursor = optionalBooleanField(object, "cursor")
        return relay.recordingStart({
          sessionId: resolveSessionId(object),
          outputPath: path.resolve(requiredStringField(object, "outputPath")),
          ...(mode ? { mode } : {}),
          ...(audio === undefined ? {} : { audio }),
          ...(frameRate === undefined ? {} : { frameRate }),
          ...(maxDurationMs === undefined ? {} : { maxDurationMs }),
          ...(cursor === undefined ? {} : { cursor }),
        })
      },
    },
    {
      name: "recording_stop",
      description: "Stop the active recording for a session and finalize its artifact.",
      inputSchema: sessionOnlyInputSchema,
      readOnly: false,
      destructive: false,
      idempotent: false,
      handle: (input) => relay.recordingStop({ sessionId: resolveSessionId(input) }),
    },
    {
      name: "tabs_cleanup",
      description: "Close tabs agents opened that nobody has used for a while (no agent command and not visited by the user). Tabs the user shared or pinned, the active tab, tabs playing audio, recording, or waiting for a handoff stay open. Call it when you finish a task to leave the user's browser tidy; Browse also does this automatically after the user's idle setting (10 minutes unless they changed it).",
      inputSchema: objectSchema({
        idleMinutes: { type: "integer", minimum: 0, description: "Close tabs idle at least this long. 0 closes every eligible agent tab. Defaults to the user's setting (10 minutes; still 10 when the user set automatic cleanup to never)." },
      }),
      readOnly: false,
      destructive: true,
      idempotent: true,
      handle: (input) => {
        const value = typeof input === "object" && input !== null && "idleMinutes" in input ? input.idleMinutes : undefined
        return relay.tabsCleanup(typeof value === "number" && value >= 0 ? value : undefined)
      },
    },
    {
      name: "settings",
      description: `Read or change the user's Browse settings, the same ones as the extension's options page: where agent tabs open (window), how they're grouped (grouping), when untouched agent tabs close (idleMinutes), the agent cursor (cursor), human-like input (humanInput) and handoff notifications (handoffNotifications). Use it only when the user asks to change how browse behaves, never on your own initiative. Without \`set\` it returns each setting's stored value, the value in effect, and the relay environment variable that overrides it, if any. With \`set\` it validates every value strictly, applies the change at once (the options page updates live) and returns what changed: tell the user what you changed. A setting an environment variable fixes is not changed, and the result says so. Security switches (${securityVariables.join(", ")}) are environment-only and can never be read or changed here.`,
      inputSchema: objectSchema({
        set: {
          type: "object",
          description: "Settings to change; omit to only read them.",
          properties: Object.fromEntries(settingKeys.map((key) => [key, { enum: [...settingSpecs[key].values], description: settingSpecs[key].label }])),
          additionalProperties: false,
        },
      }),
      readOnly: false,
      destructive: false,
      idempotent: true,
      handle: (input) => {
        const set = getObject(input)?.set
        if (set === undefined) return relay.settingsGet
        const changes = getObject(set)
        return changes ? relay.settingsSet(changes) : Effect.fail(new Error("set must be an object, for example { \"grouping\": \"shared\" }"))
      },
    },
    {
      name: "recording_status",
      description: "Return bounded status and quality counters for a session recording.",
      inputSchema: sessionOnlyInputSchema,
      readOnly: true,
      destructive: false,
      idempotent: true,
      handle: (input) => relay.recordingStatus({ sessionId: resolveSessionId(input) }),
    },
    {
      name: "recording_cancel",
      description: "Cancel a session recording and discard its unfinished artifact.",
      inputSchema: sessionOnlyInputSchema,
      readOnly: false,
      destructive: true,
      idempotent: true,
      handle: (input) => relay.recordingCancel({ sessionId: resolveSessionId(input) }),
    },
    {
      name: "flight_recorder_start",
      description: "Start a rolling in-memory video buffer for the current session tab. Saving a clip does not stop buffering.",
      inputSchema: objectSchema({
        session: sessionSchemaProperty,
        retentionMs: { type: "integer", minimum: 1000, maximum: 120000, description: "Rolling retention window. Defaults to 60000." },
        frameRate: { type: "integer", minimum: 1, maximum: 60, description: "Saved clip frame rate. Defaults to 60." },
        cursor: { type: "boolean", description: "Draw the ghost cursor in the buffered video. Off by default." },
      }),
      readOnly: false,
      destructive: false,
      idempotent: false,
      handle: (input) => {
        const object = requireObject(input)
        const retentionMs = optionalPositiveIntegerField(object, "retentionMs")
        const frameRate = optionalPositiveIntegerField(object, "frameRate")
        const cursor = optionalBooleanField(object, "cursor")
        return relay.flightRecorderStart({
          sessionId: resolveSessionId(object),
          ...(retentionMs === undefined ? {} : { retentionMs }),
          ...(frameRate === undefined ? {} : { frameRate }),
          ...(cursor === undefined ? {} : { cursor }),
        })
      },
    },
    {
      name: "flight_recorder_status",
      description: "Return bounded rolling-buffer duration, frame, byte, and drop counters.",
      inputSchema: sessionOnlyInputSchema,
      readOnly: true,
      destructive: false,
      idempotent: true,
      handle: (input) => relay.flightRecorderStatus({ sessionId: resolveSessionId(input) }),
    },
    {
      name: "flight_recorder_save_last",
      description: "Encode and save the most recent buffered browser video without stopping the flight recorder.",
      inputSchema: objectSchema({
        session: sessionSchemaProperty,
        outputPath: { type: "string", description: "Fresh .webm or .mp4 path, resolved against the MCP process working directory." },
        durationMs: { type: "integer", minimum: 1, description: "Recent duration to save. Defaults to 30000 and cannot exceed retention." },
      }, ["outputPath"]),
      readOnly: false,
      destructive: false,
      idempotent: false,
      handle: (input) => {
        const object = requireObject(input)
        const durationMs = optionalPositiveIntegerField(object, "durationMs")
        return relay.flightRecorderSaveLast({
          sessionId: resolveSessionId(object),
          outputPath: path.resolve(requiredStringField(object, "outputPath")),
          ...(durationMs === undefined ? {} : { durationMs }),
        })
      },
    },
    {
      name: "flight_recorder_cancel",
      description: "Stop and discard a session's rolling video buffer.",
      inputSchema: sessionOnlyInputSchema,
      readOnly: false,
      destructive: true,
      idempotent: true,
      handle: (input) => relay.flightRecorderCancel({ sessionId: resolveSessionId(input) }),
    },
    {
      name: "secrets_list",
      description: "List what agents may type without seeing: site secrets the user stored (names, kinds and allowed origins; type them with secrets.type(target, name) in execute; only the user adds them with `opencode-browser secrets add`), and Deadbolt logins the user granted to Browse for this session's allowed sites (title, username, which values and passkeys, never values; sign in with the signin tool or secrets.signIn(), or type one value with secrets.type(target, \"deadbolt:<site>[/<username>]\", { field })). Passkeys are listed by account (username, displayName). Only the user grants Deadbolt logins, in Deadbolt (`deadbolt agents allow <site>`, or `deadbolt agents allow --all`).",
      inputSchema: sessionOnlyInputSchema,
      readOnly: true,
      destructive: false,
      idempotent: true,
      handle: (input) => Effect.gen(function* () {
        const secrets = yield* SiteSecrets.listSecrets()
        if (!Deadbolt.readClient()) {
          return { secrets, deadbolt: { connected: false, logins: [], passkeys: [], note: "Browse isn't connected to Deadbolt. The user can connect it with `opencode-browser deadbolt connect` and grant logins with `deadbolt agents allow <site>`." } }
        }
        const deadbolt = yield* relay.deadboltLogins({ sessionId: resolveSessionId(input) }).pipe(
          Effect.catch((error) => Effect.succeed({ connected: true, origins: [], logins: [], passkeys: [], error: { code: "unavailable", message: error.message } })),
        )
        return { secrets, deadbolt }
      }),
    },
    {
      name: "signin",
      description: "Sign in to a site in the session's page with a Deadbolt login the user granted to Browse, without seeing any value. The relay does the whole sign-in in one call: username, submit, password, an authenticator (TOTP) code when asked (split boxes too), \"Use password instead\" toggles, and Sign in with Google when a Google login is granted. A username also picks the passkey account when the site signs in with a passkey. Returns only {status: signed_in | needs_user | needs_choice | not_granted | failed, step, reason}; needs_choice comes with choices [{username, displayName}] when several passkeys could sign in: call again with one username. needs_user means a captcha, a code sent by SMS or email, a push approval or a new-device check: hand it to the user with handoff() in execute. not_granted: tell the user what to allow (`deadbolt agents allow <site>`). Navigate to the sign-in page first, or pass site.",
      inputSchema: objectSchema({
        site: { type: "string", description: "The login's site: a host like github.com, or an exact origin. Defaults to the page's site; the page goes there first when it is elsewhere." },
        username: { type: "string", description: "Which login (and which passkey account), when several are granted for the site." },
        session: sessionSchemaProperty,
        timeoutMs: { type: "integer", minimum: 1, description: "Overall limit. Defaults to 90000." },
      }),
      readOnly: false,
      destructive: true,
      idempotent: false,
      handle: (input) => Effect.gen(function* () {
        const object = input === undefined ? {} : requireObject(input)
        const site = optionalStringField(object, "site")
        const username = optionalStringField(object, "username")
        const timeoutMs = optionalPositiveIntegerField(object, "timeoutMs")
        const explicitSession = optionalStringField(object, "session")
        yield* RelayLifecycle.ensureExtensionConnected({ relay, waitForReconnect: true })
        const sessionId = explicitSession ?? currentSession.id
        const options = { ...(site ? { site } : {}), ...(username ? { username } : {}), ...(timeoutMs === undefined ? {} : { timeoutMs }) }
        const result = yield* relay.execute({ sessionId, code: `return await secrets.signIn(${JSON.stringify(options)})`, createIfMissing: !explicitSession })
        establishCurrentSession(sessionId)
        if (result.isError) return yield* Effect.fail(new Error(result.text))
        return { ...(result.value as object), ...(result.aftermath?.endUrl ? { url: result.aftermath.endUrl } : {}), ...(result.warnings?.length ? { warnings: result.warnings } : {}) }
      }),
    },
    {
      name: "secrets_status",
      description: "Return secret profile references, sources, and expiration metadata without revealing credential values.",
      inputSchema: objectSchema({ name: { type: "string", description: "Secret profile name." } }, ["name"]),
      readOnly: true,
      destructive: false,
      idempotent: true,
      handle: (input) => relay.authStatus({ name: requiredStringField(input, "name") }),
    },
    {
      name: "secrets_refresh",
      description: "Reload a session page, observe fresh credentials, and update a secret profile while preserving stable BC_SECRET_N references.",
      inputSchema: objectSchema({
        name: { type: "string", description: "Existing secret profile name." },
        session: sessionSchemaProperty,
        urlFilter: { type: "string", description: "Observe credentials only on matching request URLs." },
        timeoutMs: { type: "integer", minimum: 1, description: "Reload timeout. Defaults to 30000." },
      }, ["name"]),
      readOnly: false,
      destructive: true,
      idempotent: false,
      handle: (input) => {
        const object = requireObject(input)
        const timeoutMs = optionalPositiveIntegerField(object, "timeoutMs")
        const urlFilter = optionalStringField(object, "urlFilter")
        return relay.authRefresh({
          sessionId: resolveSessionId(object),
          name: requiredStringField(object, "name"),
          ...(urlFilter ? { urlFilter } : {}),
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        })
      },
    },
    {
      name: "secrets_run",
      description: "Run a local command with a captured profile injected as BC_SECRET_N environment variables. Known values are replaced with their references in stdout and stderr, which keeps them out of transcripts. The command receives the real values, so redaction does not protect them from a command that deliberately sends or encodes them: run only commands you wrote or trust.",
      inputSchema: objectSchema({
        name: { type: "string", description: "Secret profile name." },
        command: { type: "string", description: "Executable path or command name." },
        args: { type: "array", items: { type: "string" }, description: "Command arguments." },
        cwd: { type: "string", description: "Optional child working directory." },
        timeoutMs: { type: "integer", minimum: 1, description: "Child timeout. Defaults to 120000." },
      }, ["name", "command"]),
      readOnly: false,
      destructive: true,
      idempotent: false,
      handle: (input) => {
        const object = requireObject(input)
        const args = optionalStringArrayField(object, "args")
        const cwd = optionalStringField(object, "cwd")
        const timeoutMs = optionalPositiveIntegerField(object, "timeoutMs")
        return relay.authRun({
          name: requiredStringField(object, "name"),
          command: requiredStringField(object, "command"),
          ...(args ? { args } : {}),
          cwd: path.resolve(cwd ?? process.cwd()),
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        })
      },
    },
    {
      name: "skill",
      description: "Return the Browse agent skill instructions.",
      inputSchema: emptyInputSchema,
      readOnly: true,
      destructive: false,
      idempotent: true,
      handle: () => Effect.tryPromise({
        try: () => fs.readFile(path.join(packageRoot, "skills", "browse", "SKILL.md"), "utf8"),
        catch: (cause) => new Error("read opencode-browser skill", { cause }),
      }),
    },
  ]
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
  yield* Effect.forEach(makeToolSpecs(relay, currentSession, () => updates.current), (spec) => {
    return server.addTool({
      tool: new McpSchema.Tool({
        name: spec.name,
        description: spec.description,
        inputSchema: spec.inputSchema,
        annotations: {
          readOnlyHint: spec.readOnly,
          destructiveHint: spec.destructive,
          idempotentHint: spec.idempotent,
          openWorldHint: true,
        },
      }),
      annotations: Context.empty(),
      handle: (payload: unknown) => {
        const operation = mcpToolRequiresRelayCompatibility(spec.name)
          ? RelayLifecycle.ensureRelay({ relay }).pipe(
            Effect.flatMap((readiness) => readiness.buildProblem
              ? Effect.fail(new Error(readiness.buildProblem))
              : spec.handle(payload)),
          )
          : spec.handle(payload)
        return operation.pipe(
          Effect.match({
            onFailure: (error) => toolResult({ text: mcpErrorMessage(spec.name, error.message), isError: true }),
            onSuccess: (value) => toolResultForValue(value),
          }),
          Effect.map((result) => withUpdateNote(spec.name, result)),
        )
      },
    })
  }, { discard: true })
})

/** The one-time note on a tool result: what to tell the user, and that the agent may run the update itself. */
export function mcpUpdateNote(notice: Pick<UpdateNotice, "summary" | "command">): string {
  return `Note: Browse has an update: ${notice.summary}. Tell the user they can run \`${notice.command}\` and then restart opencode, or ask you to run it for them.`
}

/** The implicit session the shim's MCP supervisor picked (auto-update.ts shimSource), when valid. */
function shimSession(): string | undefined {
  const value = process.env.OPENCODE_BROWSER_MCP_SESSION
  return value && /^mcp-[0-9a-f]{8}$/.test(value) ? value : undefined
}

export function mcpToolRequiresRelayCompatibility(name: string): boolean {
  return !["status", "session_list", "session_current", "network_status", "recording_status", "flight_recorder_status", "secrets_status", "secrets_list", "skill"].includes(name)
}

export const mcpServerLayer = McpServer.layerStdio({
  name: "browse",
  version: opencodeBrowserVersion,
  protocols: [McpProtocol.v2025_06_18, McpProtocol.v2025_11_25, McpProtocol.v2025_03_26, McpProtocol.v2024_11_05],
})

export const mcpToolsLayer = Layer.effectDiscard(registerTools)

export const runMcpServer: Effect.Effect<never, Error> = Layer.launch(
  mcpToolsLayer.pipe(
    Layer.provide(mcpServerLayer),
    Layer.provide(NodeStdio.layer),
    Layer.provide(RelayClient.layerFetchMcp),
  ),
)

const ensureSessionExists = Effect.fnUntraced(function* (relay: RelayClient.Interface, id: string) {
  const sessions = yield* relay.sessions
  const exists = sessions.some((session) => {
    return session.id === id
  })
  if (!exists) {
    return yield* Effect.fail(new Error(`Session not found: ${id}`))
  }
})

function parseExecuteArguments(input: unknown): ExecuteArguments {
  const object = requireObject(input)
  const code = requiredStringField(object, "code")
  const session = optionalStringField(object, "session")
  const targetSelection = parseMcpTargetSelection(object)
  return {
    code,
    ...(session ? { session } : {}),
    ...(targetSelection ? { targetSelection } : {}),
  }
}

function parseAdoptArguments(input: unknown): AdoptArguments {
  const object = requireObject(input)
  const session = optionalStringField(object, "session")
  const targetSelection = parseMcpTargetSelection(object)
  const tabId = typeof object.tabId === "number" && Number.isInteger(object.tabId) ? object.tabId : undefined
  if (tabId !== undefined && targetSelection) throw new Error("Use only one of tabId, targetUrl, or targetIndex")
  return {
    ...(session ? { session } : {}),
    ...(targetSelection ? { targetSelection } : {}),
    ...(tabId === undefined ? {} : { tabId }),
  }
}

function parseMcpTargetSelection(input: JsonObject): TargetSelection | undefined {
  const urlIncludes = optionalStringField(input, "targetUrl")
  const selection = parseTargetSelection({
    ...(urlIncludes ? { urlIncludes } : {}),
    ...(input.targetIndex === undefined ? {} : { index: input.targetIndex }),
  })
  return selection?.urlIncludes || selection?.index !== undefined ? selection : undefined
}

function requiredStringField(input: unknown, field: string): string {
  const value = optionalStringField(input, field)
  if (!value) {
    throw new Error(`${field} is required`)
  }
  return value
}

function optionalStringField(input: unknown, field: string): string | undefined {
  const value = getString(requireObject(input), field)
  return value ? value : undefined
}

function optionalBooleanField(input: unknown, field: string): boolean | undefined {
  const value = requireObject(input)[field]
  return Predicate.isBoolean(value) ? value : undefined
}

function optionalPositiveIntegerField(input: unknown, field: string): number | undefined {
  const value = requireObject(input)[field]
  if (value === undefined) return undefined
  if (!Predicate.isNumber(value) || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer`)
  }
  return value
}

function optionalStringArrayField(input: unknown, field: string): readonly string[] | undefined {
  const value = requireObject(input)[field]
  if (value === undefined) return undefined
  if (!Array.isArray(value) || !value.every((item): item is string => Predicate.isString(item) && item.length > 0)) {
    throw new Error(`${field} must be an array of non-empty strings`)
  }
  return value
}

function requireObject(input: unknown): JsonObject {
  const object = getObject(input)
  if (!object) {
    throw new Error("Expected arguments object")
  }
  return object
}

function stringifyResult(value: unknown): string {
  if (Predicate.isString(value)) {
    return value
  }
  return JSON.stringify(value, null, 2)
}

export function toolResultForValue(value: unknown): McpSchema.CallToolResult {
  const object = getObject(value)
  const isError = object?.isError === true
  const media = Array.isArray(object?.media)
    ? object.media.flatMap((item) => {
      const image = getObject(item)
      const mimeType = getString(image, "mimeType")
      const data = getString(image, "data")
      return image?.type === "image" && mimeType !== undefined && data !== undefined
        ? [{ data, mimeType }]
        : []
    })
    : []
  const errorText = isError ? getString(object, "text") : undefined
  if (media.length > 0) {
    const { media: _media, ...structuredContent } = object ?? {}
    const text = errorText ?? stringifyResult(structuredContent)
    return new McpSchema.CallToolResult({
      content: [
        McpSchema.TextContent.make({ text }),
        ...media.map((image) => McpSchema.ImageContent.make({
          data: new Uint8Array(Buffer.from(image.data, "base64")),
          mimeType: image.mimeType,
        })),
      ],
      structuredContent,
      isError,
    })
  }
  const text = errorText ?? stringifyResult(value)
  return toolResult({ text, ...(object ? { structuredContent: object } : {}), isError })
}

export function mcpErrorMessage(tool: string, message: string): string {
  if (!message.startsWith("Session not found:")) {
    return message
  }
  return tool === "execute" || tool === "session_adopt"
    ? `${message} Create it with session_new first, or omit the explicit session id to use the MCP current session.`
    : `${message} Create it with session_new first.`
}

function toolResult(options: { readonly text: string; readonly structuredContent?: unknown; readonly isError: boolean }): McpSchema.CallToolResult {
  return new McpSchema.CallToolResult({
    content: [McpSchema.TextContent.make({ text: options.text })],
    structuredContent: options.structuredContent,
    isError: options.isError,
  })
}

function objectSchema(properties: JsonObject, required: readonly string[] = []): JsonObject {
  return {
    type: "object",
    properties,
    required: [...required],
    additionalProperties: false,
  }
}
