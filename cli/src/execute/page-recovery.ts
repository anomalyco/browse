import { Effect, Schema } from "effect"
import type { BrowserContext, Page } from "patchright-core"
import type { HandoffOutcome } from "../session-manager/handoff.ts"
import { cliCommand } from "../paths.ts"
import { runtimeFailureKind } from "../update/runtime-diagnostics.ts"
import { resolvePageTargetId } from "./target-selection.ts"

export const playwrightCloseTimeoutMs = 2_000
/** The default timeout Playwright actions and navigations get on a session's pages. */
export const defaultActionTimeoutMs = 30_000
export const playwrightConnectTimeoutMs = 15_000
// CdpRuntime can spend two 3s observation windows replaying shared contexts.
// Leave room for that healthy reconnect path while bounding adopted setup.
export const adoptedPageConnectTimeoutMs = 8_000
export const sessionPageHealthCheckTimeoutMs = 3_000
export const sessionPageHealthRetryDelayMs = 100
export const handoffPageContextTimeoutMs = 15_000
export const defaultHandoffTimeoutMs = 10 * 60 * 1_000
export const defaultHandoffMessage = "Complete the requested task, then use the in-page continue control."
export const timedOut = Symbol("timed-out")

export const defaultPageClosedWarning = "The session default page was closed; created a new page. References to the old page in state are stale."
/** The user dismissed the browser's debugging bar, which detaches the debugger from every tab but leaves them open. */
export const debuggingBarDismissedWarning = "The user dismissed the browser's debugging bar (Cancel/OK), which disconnects browse from every tab. Browse no longer controls the session's page; tabs an agent opened stay open until idle cleanup closes them. To use a tab the user lent, ask them to lend it again with the browse toolbar button."
export const debuggingBarDismissedStop = "The user dismissed the browser's debugging bar (Cancel/OK) while this script ran, which disconnects browse from every tab, so it was stopped. The tab may still be open but browse no longer controls it. Run execute again to continue in a new tab; to use a tab the user lent, ask them to lend it again with the browse toolbar button."
export const defaultPageRecoveredWarning = "The session default page was unresponsive; created a new page. References to the old page in state are stale."
export const defaultPageCrashedWarning = "The session default page target crashed; checking it before the next execute."
export const defaultPageRepairedWarning = "The session default page stopped answering automation; browse reconnected and re-resolved the same tab. References to the old page in state are stale."
export const protectedExtensionUiWarning = "Chromium blocked protected extension UI, possibly a password manager. Ask the user to finish or dismiss it in the browser, then retry."
export const protectedExtensionUiDiagnostic = "target/cross-extension-page"
export const syntheticInputWarning = "fillInput/fillInputs set the value with synthetic input events (isTrusted: false, no key presses), which pages and bot protection can tell apart from typing. Prefer locator.fill() or locator.pressSequentially()."
/** The default page's tab came back under the same target after Chrome dropped the debugger (see getSessionPage). */
export const defaultPageReattachedWarning = "Chrome re-attached the debugger to the session default page's tab (it drops it when a tab opens a PDF in its viewer, when another extension's frame appears, or when the extension restarts), which closes the page object; `page` refers to the same tab again. References to the old page in state are stale."
/** How to get a PDF out of Chrome's viewer, whose content isn't in the page's DOM. */
export const pdfViewerWarning = "This tab shows a PDF in Chrome's viewer, whose text isn't in the DOM. page.url() is the file's URL; save the file with: const b64 = await page.evaluate(async () => { const bytes = new Uint8Array(await (await fetch(location.href)).arrayBuffer()); let s = \"\"; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s) }); await files.write(\"file.pdf\", Buffer.from(b64, \"base64\"))"
export const defaultPageReplacedWarning = "The session default page target was replaced; rebound to the same browser tab. References to the old page in state are stale."

export type HandoffPageTarget = {
  readonly targetId: string
}

export type RequestHandoff = (options: {
  readonly message: string
  readonly timeoutMs: number
  readonly target: HandoffPageTarget
  readonly start?: () => unknown | Promise<unknown>
  readonly cancelStart?: () => Promise<void>
}) => Promise<HandoffOutcome>

export class PlaywrightOperationError extends Schema.TaggedError<PlaywrightOperationError>()(
  "Execute.PlaywrightOperationError",
  {
    message: Schema.String,
    operation: Schema.String,
    reason: Schema.Literals(["failed", "timeout"]),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

export class SessionPageRecoveryError extends Schema.TaggedError<SessionPageRecoveryError>()(
  "Execute.SessionPageRecoveryError",
  {
    message: Schema.String,
    reason: Schema.Literals(["adopted-unresponsive", "adopted-initialization-timeout", "owned-unresponsive", "close-failed", "target-unavailable"]),
    cause: Schema.Defect(),
  },
) {}

/** Internal signal: the relay-owned page is alive but Playwright's view of it is stale; reconnect before retrying. */
export class SessionPageRepairRequired extends Error {
  constructor() {
    super("Session page repair required")
  }
}

const unresponsivePageDiagnosis = (options: { readonly ownsPage: boolean; readonly repaired: boolean }): string => [
  `The ${options.ownsPage ? "relay-owned" : "adopted"} session page is unresponsive: the tab is open but its execution context did not answer automation within the health-check budget`,
  options.repaired ? " even after reconnecting to the relay" : "",
  ". The tab was kept and was not replaced. This usually means the page is mid-navigation or its main world is stalled for automation (for example, bot protection). ",
  `Retry after the page settles, navigate the tab with page.goto(), open a fresh tab with context.newPage(), or release it with session_reset (CLI: \`${cliCommand("session reset")}\`).`,
].join("")

const operationFailure = (label: string, cause: unknown): PlaywrightOperationError =>
  new PlaywrightOperationError({
    message: cause instanceof Error ? cause.message : label,
    operation: label,
    reason: "failed",
    cause,
  })

export const runPlaywrightOperation = Effect.fn("Execute.playwrightOperation")(<A>(options: {
  readonly label: string
  readonly timeoutMs: number
  readonly run: () => Promise<A>
}): Effect.Effect<A, Error> => Effect.tryPromise({
    try: options.run,
    catch: (cause) => operationFailure(options.label, cause),
  }).pipe(
    Effect.timeoutOrElse({
      duration: options.timeoutMs,
      orElse: () => Effect.fail(new PlaywrightOperationError({
        message: `${options.label} timed out after ${options.timeoutMs}ms`,
        operation: options.label,
        reason: "timeout",
      })),
    }),
  )
)

export const runSettledPlaywrightOperation = Effect.fn("Execute.settledPlaywrightOperation")(<A>(options: {
  readonly label: string
  readonly run: () => Promise<A>
}): Effect.Effect<A, Error> => Effect.tryPromise({
  try: options.run,
  catch: (cause) => operationFailure(options.label, cause),
}))

/**
 * Decide what to do with a default page that failed or needs a health check.
 *
 * Only a relay-owned page with nothing left to lose (a crashed renderer,
 * `about:blank`, or a `chrome-error://` document) is closed and recreated. Any
 * other live page is kept: an unresponsive execution context is a symptom of
 * Playwright's stale view of the tab or of the page itself, not proof that the
 * tab is gone, and the tab may hold login or form state the user produced.
 */
export const recoverSessionPage = Effect.fn("Execute.recoverSessionPage")(function* (options: {
  readonly ownsPage: boolean
  readonly url: string
  readonly timeoutMs: number
  readonly healthCheck: () => Promise<void>
  readonly close: () => Promise<void>
  readonly crashed?: boolean
  readonly repaired?: boolean
}) {
  const healthFailure = yield* runPlaywrightOperation({
    label: "Session page health check",
    timeoutMs: options.timeoutMs,
    run: options.healthCheck,
  }).pipe(
    Effect.match({
      onFailure: (error) => error,
      onSuccess: () => undefined,
    }),
  )
  if (!healthFailure) {
    return "use" as const
  }
  if (!options.ownsPage) {
    return yield* new SessionPageRecoveryError({
      message: unresponsivePageDiagnosis({ ownsPage: false, repaired: options.repaired === true }),
      reason: "adopted-unresponsive",
      cause: healthFailure,
    })
  }
  if (!isDisposableSessionPage(options)) {
    if (options.repaired) {
      return yield* new SessionPageRecoveryError({
        message: unresponsivePageDiagnosis({ ownsPage: true, repaired: true }),
        reason: "owned-unresponsive",
        cause: healthFailure,
      })
    }
    return "repair" as const
  }
  const closeFailure = yield* runPlaywrightOperation({
    label: "Close unhealthy session page",
    timeoutMs: options.timeoutMs,
    run: options.close,
  }).pipe(
    Effect.match({
      onFailure: (error) => error,
      onSuccess: () => undefined,
    }),
  )
  if (closeFailure) {
    return yield* new SessionPageRecoveryError({
      message: `The unhealthy relay-owned session page could not be closed. Reset the session (session_reset, or \`${cliCommand("session reset")}\`) before continuing.`,
      reason: "close-failed",
      cause: closeFailure,
    })
  }
  return "recreate" as const
})

/** A relay-owned page whose document holds no user-produced state worth preserving. */
export function isDisposableSessionPage(options: { readonly url: string; readonly crashed?: boolean }): boolean {
  // Blank documents can hold setContent output, forms, and opener-written state.
  // An unknown URL is not evidence that the document is safe to discard either.
  return options.crashed === true || options.url.startsWith("chrome-error://")
}

export async function waitForPageContext(options: {
  readonly evaluate: () => Promise<void>
  readonly timeoutMs: number
  readonly retryDelayMs?: number
  readonly delay?: (milliseconds: number) => Promise<void>
}): Promise<void> {
  const retryDelayMs = options.retryDelayMs ?? sessionPageHealthRetryDelayMs
  const deadline = Date.now() + options.timeoutMs
  let lastError: unknown
  while (true) {
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) break
    try {
      const result = await withTimeout(options.evaluate(), remainingMs)
      if (result === timedOut) break
      return
    } catch (error) {
      lastError = error
      const kind = runtimeFailureKind(error)
      if (kind !== "context-destroyed" && kind !== "context-missing") throw error
      const retryInMs = Math.min(retryDelayMs, Math.max(0, deadline - Date.now()))
      if (retryInMs > 0) await (options.delay ?? delay)(retryInMs)
    }
  }
  throw lastError ?? new Error(`Execution context not available: it did not become available within ${options.timeoutMs}ms`)
}

export async function finishHandoff(options: {
  readonly outcome: HandoffOutcome
  readonly message: string
  readonly timeoutMs: number
  readonly evaluate: () => Promise<void>
  readonly contextTimeoutMs?: number
  readonly retryDelayMs?: number
  readonly delay?: (milliseconds: number) => Promise<void>
}): Promise<void> {
  if (options.outcome === "timeout") {
    throw new Error(`Handoff timed out after ${options.timeoutMs}ms waiting for the user: ${options.message}`)
  }
  if (options.outcome !== "resolved" && options.outcome.reason === "session-stopped") {
    throw new Error(`Handoff cancelled because its session was stopped, deleted or reset: ${options.message}`)
  }
  if (options.outcome !== "resolved") {
    const targetEvent = options.outcome.reason === "target-crashed" ? "crashed" : "detached"
    throw new Error(`Handoff cancelled because its target ${targetEvent}: ${options.message}`)
  }
  const contextTimeoutMs = options.contextTimeoutMs ?? sessionPageHealthCheckTimeoutMs
  try {
    await waitForPageContext({
      evaluate: options.evaluate,
      timeoutMs: contextTimeoutMs,
      ...(options.retryDelayMs === undefined ? {} : { retryDelayMs: options.retryDelayMs }),
      ...(options.delay === undefined ? {} : { delay: options.delay }),
    })
  } catch (error) {
    const kind = runtimeFailureKind(error)
    if (kind !== "context-destroyed" && kind !== "context-missing") throw error
    // The user finished the handoff; only browse's view of the page is stale. Keep that
    // distinction visible and let the next execute health-check and repair the same tab.
    throw new Error(
      `Handoff resolved (${options.message}), but the page execution context did not become available within ${contextTimeoutMs}ms: ${error instanceof Error ? error.message : String(error)}. The tab was kept; run a short follow-up execute so browse can re-check it.`,
      { cause: error },
    )
  }
}

export function isSessionPageConnected(options: {
  readonly browserConnected: boolean
  readonly pageUrl: string | null
  readonly healthCheckRequired: boolean
}): boolean {
  return options.browserConnected && options.pageUrl !== null && !options.healthCheckRequired
}

export function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | typeof timedOut> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => resolve(timedOut), timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timeout)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timeout)
        reject(error)
      },
    )
  })
}

/**
 * Playwright rewrites Chrome's "Cannot access a chrome-extension:// URL of
 * different extension" rejection into a generic destroyed-context error and
 * retries locators until they time out. When the relay reports that the tab is
 * blocked by protected extension UI, those masked failures are the block.
 */
export function isMaskedProtectedUiFailure(cause: unknown): boolean {
  const kind = runtimeFailureKind(cause)
  return kind === "context-destroyed" || kind === "context-missing" || kind === "timeout"
}

export const shouldCloseCurrentPageOnAdopt = (options: {
  readonly hasCurrentPage: boolean
  readonly ownsCurrentPage: boolean
  readonly currentPageIsSelected: boolean
  readonly currentPageIsClosed: boolean
}): boolean => {
  return options.hasCurrentPage && options.ownsCurrentPage && !options.currentPageIsSelected && !options.currentPageIsClosed
}

/** Whether the page shows Chrome's PDF viewer. */
export async function showsPdf(page: Page): Promise<boolean> {
  return await Effect.runPromise(runPlaywrightOperation({
    label: "Check for the PDF viewer",
    timeoutMs: playwrightCloseTimeoutMs,
    run: () => page.evaluate(() => document.contentType === "application/pdf"),
  }).pipe(Effect.orElseSucceed(() => false)))
}

/** The open page with this target id right now, without waiting for one to appear. */
export async function openPageWithTargetId(context: BrowserContext, targetId: string): Promise<Page | undefined> {
  const pages = context.pages().filter((page) => !page.isClosed())
  const ids = await Promise.all(pages.map((page) => resolvePageTargetId(page)))
  const index = ids.indexOf(targetId)
  return index === -1 ? undefined : pages[index]
}

export async function waitForPageTarget(options: {
  readonly context: BrowserContext
  readonly targetId: string
  readonly timeoutMs: number
}): Promise<Page | undefined> {
  return await waitForExactTarget({
    targetId: options.targetId,
    timeoutMs: options.timeoutMs,
    candidates: () => options.context.pages(),
    getTargetId: resolvePageTargetId,
  })
}

export async function waitForExactTarget<T>(options: {
  readonly targetId: string
  readonly timeoutMs: number
  readonly candidates: () => readonly T[]
  readonly getTargetId: (candidate: T) => Promise<string | undefined>
  readonly delay?: (milliseconds: number) => Promise<void>
}): Promise<T | undefined> {
  const deadline = Date.now() + options.timeoutMs
  const cachedTargetIds = new Map<T, string | undefined>()
  const inFlightTargetIds = new Map<T, Promise<{ readonly candidate: T; readonly targetId: string | undefined }>>()
  while (true) {
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) return undefined
    const candidates = options.candidates()
    for (const candidate of candidates) {
      const cached = cachedTargetIds.get(candidate)
      if (cached === options.targetId) return candidate
      if (cached !== undefined || inFlightTargetIds.has(candidate)) continue
      inFlightTargetIds.set(candidate, options.getTargetId(candidate).then(
        (targetId) => ({ candidate, targetId }),
        () => ({ candidate, targetId: undefined }),
      ))
    }
    const retryInMs = Math.min(sessionPageHealthRetryDelayMs, Math.max(0, deadline - Date.now()))
    if (retryInMs <= 0) return undefined
    if (inFlightTargetIds.size > 0) {
      const resolved = await withTimeout(Promise.race(inFlightTargetIds.values()), retryInMs)
      if (resolved !== timedOut) {
        inFlightTargetIds.delete(resolved.candidate)
        if (resolved.targetId !== undefined) cachedTargetIds.set(resolved.candidate, resolved.targetId)
        if (resolved.targetId === options.targetId) return resolved.candidate
      }
      continue
    }
    await (options.delay ?? delay)(retryInMs)
  }
}

export function installClosedPageReplacementGuard(
  page: Page,
  clearRecreatedFromClosedUrl: () => void,
  restoreTimeoutMs = defaultActionTimeoutMs,
): void {
  page.setDefaultTimeout?.(2_500)
  const restoreTimeout = () => {
    clearRecreatedFromClosedUrl()
    page.setDefaultTimeout?.(restoreTimeoutMs)
  }
  if (typeof page.goto === "function") {
    const originalGoto = page.goto.bind(page)
    Object.defineProperty(page, "goto", {
      configurable: true,
      value: async (...args: Parameters<Page["goto"]>) => {
        restoreTimeout()
        return await originalGoto(...args)
      },
    })
  }
  if (typeof page.setContent === "function") {
    const originalSetContent = page.setContent.bind(page)
    Object.defineProperty(page, "setContent", {
      configurable: true,
      value: async (...args: Parameters<Page["setContent"]>) => {
        restoreTimeout()
        return await originalSetContent(...args)
      },
    })
  }
}
