import { Effect, Schema } from "effect"
import type { BrowserContext, Page } from "patchright-core"
import type { HandoffOutcome } from "../session-manager/handoff.ts"
import { cliCommand } from "../paths.ts"
import { runtimeFailureKind } from "../update/runtime-diagnostics.ts"

export const playwrightCloseTimeoutMs = 2_000
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

export const downloadCapabilityErrorMessage = "Downloads are unavailable in Browse extension-backed tabs: Chromium blocks Browser.setDownloadBehavior and Page.setDownloadBehavior through chrome.debugger, so Playwright cannot retain an artifact for download.saveAs(). Fetch the response in the page and save the returned bytes with files.write() when the site exposes them."
const downloadGuardedPages = new WeakSet<Page>()
const downloadGuardedContexts = new WeakSet<BrowserContext>()
const viewportZoomGuardedPages = new WeakSet<Page>()

const explicitMediaOptions = [
  ["colorScheme", "prefers-color-scheme"],
  ["reducedMotion", "prefers-reduced-motion"],
  ["forcedColors", "forced-colors"],
  ["contrast", "prefers-contrast"],
] as const

export const defaultPageClosedWarning = "The session default page was closed; created a new page. References to the old page in state are stale."
export const defaultPageRecoveredWarning = "The session default page was unresponsive; created a new page. References to the old page in state are stale."
export const defaultPageCrashedWarning = "The session default page target crashed; checking it before the next execute."
export const defaultPageRepairedWarning = "The session default page stopped answering automation; Browse reconnected and re-resolved the same tab. References to the old page in state are stale."
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

export type ExecuteTargetSelection = {
  readonly urlIncludes?: string
  readonly index?: number
}

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

export class TargetSelectionError extends Schema.TaggedError<TargetSelectionError>()(
  "Execute.TargetSelectionError",
  {
    message: Schema.String,
    reason: Schema.Literals(["invalid", "not-found", "ambiguous"]),
  },
) {}

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
    // The user finished the handoff; only Browse's view of the page is stale. Keep that
    // distinction visible and let the next execute health-check and repair the same tab.
    throw new Error(
      `Handoff resolved (${options.message}), but the page execution context did not become available within ${contextTimeoutMs}ms: ${error instanceof Error ? error.message : String(error)}. The tab was kept; run a short follow-up execute so Browse can re-check it.`,
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

export function installDownloadCapabilityGuard(page: Page): void {
  if (downloadGuardedPages.has(page)) {
    return
  }
  const waitForEvent = page.waitForEvent.bind(page) as (event: string, ...args: unknown[]) => Promise<unknown>
  Object.defineProperty(page, "waitForEvent", {
    configurable: true,
    value: (event: string, ...args: unknown[]) => {
      if (event === "download") {
        return Promise.reject(new Error(downloadCapabilityErrorMessage))
      }
      return waitForEvent(event, ...args)
    },
  })
  downloadGuardedPages.add(page)
}

export function installDownloadCapabilityGuards(context: BrowserContext): void {
  if (downloadGuardedContexts.has(context)) {
    return
  }
  for (const page of context.pages()) {
    installDownloadCapabilityGuard(page)
  }
  context.on("page", installDownloadCapabilityGuard)
  downloadGuardedContexts.add(context)
}

export function hasExplicitTargetSelection(selection: ExecuteTargetSelection | undefined): boolean {
  return Boolean(selection?.urlIncludes) || selection?.index !== undefined
}

export function selectTarget<T>({
  targets,
  selection,
  getUrl,
  getIndex,
}: {
  readonly targets: readonly T[]
  readonly selection: ExecuteTargetSelection
  readonly getUrl: (target: T) => string
  readonly getIndex?: (target: T, fallbackIndex: number) => number
}): T | undefined {
  if (selection.urlIncludes && selection.index !== undefined) {
    throw new TargetSelectionError({ reason: "invalid", message: "Use only one target selector: --target-url or --target-index" })
  }
  if (selection.urlIncludes) {
    const matches = targets.filter((candidate) => {
      return getUrl(candidate).includes(selection.urlIncludes ?? "")
    })
    if (matches.length === 0) {
      throw new TargetSelectionError({
        reason: "not-found",
        message: `No existing attached page URL includes ${selection.urlIncludes}. Target selectors do not navigate or open pages: use page.goto() in the session page, or attach the intended user tab with the Browse toolbar first.`,
      })
    }
    if (matches.length > 1) {
      const candidates = targets.flatMap((candidate, index) => matches.includes(candidate) ? [`[${getIndex ? getIndex(candidate, index) : index}] ${getUrl(candidate)}`] : [])
      throw new TargetSelectionError({
        reason: "ambiguous",
        message: `Multiple attached pages (${matches.length}) match URL ${selection.urlIncludes}; use a more specific --target-url or --target-index. Matches: ${candidates.join(", ")}`,
      })
    }
    return matches[0]
  }
  if (selection.index !== undefined) {
    if (selection.index < 0) {
      throw new TargetSelectionError({ reason: "invalid", message: "Target index must be a non-negative integer" })
    }
    const target = targets[selection.index]
    if (!target) {
      throw new TargetSelectionError({
        reason: "not-found",
        message: `No existing attached page at index ${selection.index}; ${targets.length} page(s) available. Target selectors do not create pages.`,
      })
    }
    return target
  }
  if (targets.length === 0) {
    throw new TargetSelectionError({
      reason: "not-found",
      message: "No attached pages available. Attach the intended user tab with the Browse toolbar first.",
    })
  }
  if (targets.length > 1) {
    const candidates = targets.map((candidate, index) => `[${getIndex ? getIndex(candidate, index) : index}] ${getUrl(candidate)}`)
    throw new TargetSelectionError({
      reason: "ambiguous",
      message: `Multiple attached pages (${targets.length}); use --target-url or --target-index to choose one. Matches: ${candidates.join(", ")}`,
    })
  }
  return targets[0]
}

export function selectPage({ pages, selection }: { readonly pages: readonly Page[]; readonly selection: ExecuteTargetSelection }): Page | undefined {
  return selectTarget({ targets: pages, selection, getUrl: (page) => page.url() })
}

export async function resolvePageTargetId(page: Page): Promise<string | undefined> {
  return await Effect.runPromise(
    runPlaywrightOperation({
      label: "Resolve session page target id",
      timeoutMs: playwrightCloseTimeoutMs,
      run: () => pageTargetId(page),
    }).pipe(
      Effect.match({
        onFailure: () => undefined,
        onSuccess: (targetId) => targetId,
      }),
    ),
  )
}

export async function pageTargetId(page: Page): Promise<string> {
  if (page.isClosed()) {
    throw new Error("Cannot identify the CDP target for a closed page")
  }
  const session = await page.context().newCDPSession(page)
  try {
    const result = await session.send("Target.getTargetInfo")
    const targetId = result.targetInfo?.targetId
    if (!targetId) {
      throw new Error("Target.getTargetInfo did not return a target id for the handoff page")
    }
    return targetId
  } finally {
    await session.detach()
  }
}

export function safePageUrl(page: Page): string | null {
  try {
    return page.isClosed() ? null : page.url()
  } catch {
    return null
  }
}

export function installClosedPageReplacementGuard(page: Page, clearRecreatedFromClosedUrl: () => void): void {
  page.setDefaultTimeout?.(2_500)
  const restoreTimeout = () => {
    clearRecreatedFromClosedUrl()
    page.setDefaultTimeout?.(30_000)
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

export async function applyExplicitMediaFeatures(
  page: Page,
  explicitMedia: string | undefined,
  explicitMediaFeatures: ReadonlyMap<string, string>,
): Promise<void> {
  try {
    const cdp = await page.context().newCDPSession(page)
    try {
      await cdp.send("Emulation.setEmulatedMedia", {
        ...(explicitMedia ? { media: explicitMedia } : {}),
        features: [
          ...Array.from(explicitMediaFeatures, ([name, value]) => ({ name, value })),
          { name: "__bc_explicit__", value: "1" },
        ],
      })
    } finally {
      await cdp.detach().catch(() => {})
    }
  } catch {}
}

export function installViewportZoomGuard(options: {
  readonly page: Page
  readonly explicitMediaFeatures: Map<string, string>
  readonly getExplicitMedia: () => string | undefined
  readonly setExplicitMedia: (media: string | undefined) => void
  readonly addWarningOnce: (warning: string) => void
}): void {
  const { page, explicitMediaFeatures } = options
  if (viewportZoomGuardedPages.has(page)) return
  if (typeof page.emulateMedia === "function") {
    const originalEmulateMedia = page.emulateMedia.bind(page)
    Object.defineProperty(page, "emulateMedia", {
      configurable: true,
      value: async (mediaOptions?: Parameters<Page["emulateMedia"]>[0]) => {
        for (const [option, feature] of explicitMediaOptions) {
          if (!mediaOptions || !(option in mediaOptions)) continue
          const value = mediaOptions[option]
          if (typeof value === "string") explicitMediaFeatures.set(feature, value)
          else explicitMediaFeatures.delete(feature)
        }
        if (mediaOptions && "media" in mediaOptions) options.setExplicitMedia(mediaOptions.media ?? undefined)
        await originalEmulateMedia(mediaOptions)
        if (explicitMediaFeatures.size > 0) {
          await applyExplicitMediaFeatures(page, options.getExplicitMedia(), explicitMediaFeatures)
        }
      },
    })
  }
  if (typeof page.setViewportSize === "function") {
    const originalSetViewportSize = page.setViewportSize.bind(page)
    Object.defineProperty(page, "setViewportSize", {
      configurable: true,
      value: async (size: { width: number; height: number }) => {
        await originalSetViewportSize(size)
        try {
          const measured = await withTimeout(
            page.evaluate(() => ({
              innerWidth: window.innerWidth,
              innerHeight: window.innerHeight,
              dpr: window.devicePixelRatio,
            })),
            1_000,
          )
          if (
            measured !== timedOut
            && (Math.abs(measured.innerWidth - size.width) > 2 || Math.abs(measured.innerHeight - size.height) > 2)
          ) {
            options.addWarningOnce(
              `Viewport size ${size.width}x${size.height} resulted in CSS viewport ${measured.innerWidth}x${measured.innerHeight} (devicePixelRatio=${Number(measured.dpr.toFixed(3))}) due to browser zoom on this origin.`,
            )
          }
        } catch {}
      },
    })
  }
  viewportZoomGuardedPages.add(page)
}
