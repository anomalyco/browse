import { Effect } from "effect"
import * as RelayLifecycle from "../relay/lifecycle.ts"
import { registerMcpTools } from "./registry.ts"
import { objectSchema, parseExecuteArguments } from "./schema.ts"

registerMcpTools({
  order: 100,
  build: (ctx) => [
    {
      name: "execute",
      listsBrowsers: true,
      description: `Execute Playwright JavaScript against the Browse session. Code runs in a sandbox on the relay without process, require, import(), fs, child_process, http/https or Node fetch; save and read files with the files helper inside the execute file roots, and cookie access is limited to the session's pages. The result includes console logs, warnings, a bounded execution-context diagnostic when relevant, and an aftermath summary (URL movement, navigations, error counts, handoffs, and a bot challenge or block page when one appears: hand interactive ones to the user with handoff(), never solve or retry-loop them).${ctx.browserNote}`,
      inputSchema: objectSchema(
        {
          code: {
            type: "string",
            description:
              'JavaScript code to execute. It receives browser, context, page, state, modules (path, url, util, crypto, buffer, zlib, events, stream), files (dir, path, write, read), fillInput, fillInputs, snapshot(options?) for compact semantic outlines, search, explicit diffs, or automatic deltas, persistent compatible ref(id) locators, webmcp (list/call), screenshot helpers, ariaSnapshot, ghostCursor, handoff, demonstrate, network capture, pageConsole (start/stop capturing the page\'s own console messages and errors, off by default because pages can detect it), secrets.type(locator, name) to type a stored site secret or a granted Deadbolt login ("deadbolt:<site>[/<username>]", { field: "username" }, or a password/code with { submit: true }; see secrets_list) only on its allowed origins, without seeing it, secrets.signIn({ site?, username? }) for a whole sign-in (same as the signin tool), and secrets.usePasskey({ site, username }) to pick the passkey account for the tab\'s next passkey request.',
          },
          session: {
            type: "string",
            description:
              "Optional existing Browse session id. Explicit ids must already exist; omit this field to use the MCP server's current session, which is created when needed.",
          },
          targetUrl: {
            type: "string",
            description:
              "Optional URL substring selecting an existing attached page. This does not navigate or open a URL; use page.goto() for that.",
          },
          targetIndex: {
            type: "integer",
            minimum: 0,
            description: "Optional zero-based attached page index selector.",
          },
          browser: ctx.browserProperty,
          timeoutMs: {
            type: "integer",
            minimum: 0,
            description:
              "Optional overall script timeout in milliseconds (paused while handoff() waits on the user); defaults to 60000, 0 disables.",
          },
        },
        ["code"],
      ),
      readOnly: false,
      destructive: true,
      idempotent: false,
      handle: (input) =>
        Effect.gen(function* () {
          const args = yield* Effect.try(() => parseExecuteArguments(input))
          const sessionId = args.session ?? ctx.currentSession.id
          yield* RelayLifecycle.ensureExtensionConnected({ relay: ctx.relay, sessionId, waitForReconnect: true })
          const result = yield* ctx.relay.execute({
            sessionId,
            code: args.code,
            createIfMissing: !args.session,
            ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
            ...(args.targetSelection ? { targetSelection: args.targetSelection } : {}),
            ...(args.browser ? { browser: args.browser } : {}),
          })
          const recreated = !args.session && ctx.currentSession.established && result.session.created === true
          ctx.establishCurrentSession(sessionId)
          return {
            ...result,
            ...(recreated
              ? { notice: `Recreated session '${sessionId}' — relay had no such session; page and state were reset.` }
              : {}),
          }
        }),
    },
  ],
})
