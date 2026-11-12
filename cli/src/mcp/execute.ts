import { Effect } from "effect"
import * as RelayClient from "../relay/client.ts"
import * as RelayLifecycle from "../relay/lifecycle.ts"
import { registerMcpTools } from "./registry.ts"
import { executeToolResult, objectSchema, parseExecuteArguments } from "./schema.ts"

registerMcpTools({
  order: 100,
  build: (ctx) => [
    {
      name: "execute",
      description: `Execute Playwright JavaScript against the browse session. Code runs in a restricted JavaScript realm on the relay without process, require, import(), fs, child_process, http/https or Node fetch; save and read files with the files helper inside the execute file roots (file paths, including Playwright options like screenshot({ path }), must be in folders you own without group/world write access; files.path(name) gives a safe one), and cookie access is limited to the session's pages. Synchronous code stops after about 2 seconds. It is not a security boundary, so treat code as running as the user. The result includes console logs, warnings, a bounded execution-context diagnostic when relevant, and an aftermath summary (URL movement, navigations, error counts, handoffs, and a bot challenge or block page when one appears: hand interactive ones to the user with handoff(), never solve or retry-loop them).`,
      inputSchema: objectSchema(
        {
          code: {
            type: "string",
            description:
              'JavaScript code to execute. It receives browser, context, page, state, modules (path, url, util, crypto, buffer, zlib, events, stream), files (dir and roots properties; path(name), write(target, data), read(target, encoding?)), fillInput, fillInputs, snapshot(options?) for compact semantic outlines of the page and the content of its iframes (options: find to search them, diff or delta for changes, frames: false to leave iframe content out), persistent compatible ref(id) locators that resolve inside the frame they came from, webmcp (list/call), screenshotWithLabels(options?) and screenshotDiff(options) for screenshots, ariaSnapshot for Playwright\'s YAML tree followed by a labelled block per iframe with its content, ghostCursor, handoff, demonstrate, network (start/status/stop/cancel), pageConsole (start/stop capturing the page\'s own console messages and errors, off by default because pages can detect it), and secrets.type(locator, name) to type a stored site secret (see secrets_list) only on its allowed origins, without seeing it. There is no location, document or fetch global (they belong to the page: use page.url() or page.evaluate(...)), and no structuredClone.',
          },
          session: {
            type: "string",
            description:
              "Optional existing browse session id. Explicit ids must already exist; omit this field to use your current session (per agent when the client names it; see `status`), which is created when needed.",
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
              "Optional overall script timeout in milliseconds (paused while handoff() waits on the user); defaults to 60000, 0 disables. It includes time spent waiting behind another execute on the same session, and that call's handoff does not pause it. When set, it is also the timeout for Playwright actions and navigations in the code, at least 30 seconds; 0 removes those too.",
          },
        },
        ["code"],
      ),
      readOnly: false,
      destructive: true,
      idempotent: false,
      openWorld: true,
      // No outputSchema: clients that validate one reject image results, which carry no structured content.
      result: executeToolResult,
      handle: (input) =>
        Effect.gen(function* () {
          const args = yield* Effect.try(() => parseExecuteArguments(input))
          const caller = yield* ctx.caller
          const sessionId = args.session ?? caller.id
          const connected = RelayLifecycle.ensureExtensionConnected({ relay: ctx.relay, sessionId, waitForReconnect: true })
          yield* connected
          const run = ctx.relay.execute({
            sessionId,
            code: args.code,
            createIfMissing: !args.session,
            ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
            ...(args.targetSelection ? { targetSelection: args.targetSelection } : {}),
            ...(args.browser ? { browser: args.browser } : {}),
          })
          // The status check and the call race the browser's link closing (a worker restart): when the relay answers
          // that the session's browser isn't connected, wait for it once more and run once more.
          const result = yield* run.pipe(Effect.catchIf(
            (error): error is RelayClient.RelayRejected => error instanceof RelayClient.RelayRejected && error.code === "browser-unavailable",
            () => connected.pipe(Effect.andThen(run)),
          ))
          const recreated = !args.session && caller.established && result.session.created === true
          ctx.establishCurrentSession(caller, sessionId)
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
