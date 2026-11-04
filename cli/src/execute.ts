import { Effect } from "effect"
import { chromium, errors, type Browser, type BrowserContext, type Page } from "patchright-core"
import { registerAriaSnapshotSelector } from "./snapshot/aria-snapshot.ts"
import * as AuthProfile from "./auth/profile.ts"
import * as AuthenticatedOrigin from "./auth/authenticated-origin.ts"
import { challengeWarning } from "./execute/challenge-detection.ts"
import { executeAllowsNode, ExecuteRealm, pageVisibleApiWarning } from "./execute-realm.ts"
import {
  challengeWaitMs,
  detectChallenge,
  ExecuteCodeError,
  getAutoReturnExpression,
  pageHookCall,
  pageVisibleApiSourceWarnings,
  runUserCode,
  userCodeStack,
  wrapCode,
  type SandboxGlobals,
} from "./execute/code-runner.ts"
import { DefaultPageHost } from "./execute/default-page.ts"
import { downloadCapabilityErrorMessage, installDownloadCapabilityGuard, installDownloadCapabilityGuards, installViewportZoomGuard } from "./execute/guards.ts"
import {
  createExecuteLogCapture,
  emptyExecuteLogSummary,
  formatLocatorFailurePageWarning,
  formatLogCompactionWarning,
  formatNodeContextWarning,
  formatPointerInterceptionWarning,
} from "./execute/log-capture.ts"
import {
  adoptedPageConnectTimeoutMs,
  defaultHandoffTimeoutMs,
  defaultPageClosedWarning,
  defaultPageReattachedWarning,
  defaultPageRepairedWarning,
  defaultPageReplacedWarning,
  finishHandoff,
  handoffPageContextTimeoutMs,
  isDisposableSessionPage,
  isMaskedProtectedUiFailure,
  isSessionPageConnected,
  pdfViewerWarning,
  playwrightCloseTimeoutMs,
  playwrightConnectTimeoutMs,
  protectedExtensionUiDiagnostic,
  protectedExtensionUiWarning,
  recoverSessionPage,
  runPlaywrightOperation,
  runSettledPlaywrightOperation,
  SessionPageRecoveryError,
  SessionPageRepairRequired,
  shouldCloseCurrentPageOnAdopt,
  syntheticInputWarning,
  waitForExactTarget,
  waitForPageContext,
  type HandoffPageTarget,
  type RequestHandoff,
} from "./execute/page-recovery.ts"
import {
  hasExplicitTargetSelection,
  pageTargetId,
  safePageUrl,
  selectTarget,
  TargetSelectionError,
  type ExecuteTargetSelection,
} from "./execute/target-selection.ts"
import {
  boundExecuteResult,
  extractExecuteMedia,
  jsonValueWarning,
  maxExecuteResultChars,
  stringifyResult,
  toJsonSafeValue,
} from "./execute/result-formatting.ts"
import { buildSandboxGlobals } from "./execute/sandbox-globals.ts"
import { ExecuteSecretsBridge } from "./execute/secrets-bridge.ts"
import * as NetworkCapture from "./network-capture.ts"
import { installPageReadTimeout } from "./execute/read-timeout.ts"
import type { PasskeyChoice } from "./auth/passkey-bridge.ts"
import { tunePatchright } from "./execute/patchright-tuning.ts"
import {
  AuthenticatedJsonOutcome,
  type AuthenticatedJsonRequest,
  type ExecuteAftermath,
  type ExecuteLogEntry,
  type ExecuteLogSummary,
  type ExecuteMedia,
} from "./relay/schema.ts"
import { relayToken } from "./relay/secrets.ts"
import type { SessionTarget } from "./relay/types.ts"
import { executionContextFailureDiagnostic } from "./update/runtime-diagnostics.ts"
import {
  createAriaSnapshotHelper,
  createSnapshotHelpers,
  defaultAriaSnapshotTimeoutMs,
  fillInputs,
  invalidateSnapshotDocument,
  type SnapshotRefRegistry,
} from "./snapshot.ts"

export {
  boundExecuteResult,
  createAriaSnapshotHelper,
  createExecuteLogCapture,
  createSnapshotHelpers,
  defaultAriaSnapshotTimeoutMs,
  defaultPageClosedWarning,
  defaultPageReattachedWarning,
  defaultPageRepairedWarning,
  defaultPageReplacedWarning,
  detectChallenge,
  downloadCapabilityErrorMessage,
  extractExecuteMedia,
  fillInputs,
  finishHandoff,
  formatNodeContextWarning,
  formatPointerInterceptionWarning,
  getAutoReturnExpression,
  hasExplicitTargetSelection,
  installDownloadCapabilityGuard,
  installDownloadCapabilityGuards,
  isDisposableSessionPage,
  jsonValueWarning,
  isSessionPageConnected,
  maxExecuteResultChars,
  pageHookCall,
  pageTargetId,
  pageVisibleApiSourceWarnings,
  pdfViewerWarning,
  recoverSessionPage,
  runPlaywrightOperation,
  runUserCode,
  selectTarget,
  shouldCloseCurrentPageOnAdopt,
  TargetSelectionError,
  toJsonSafeValue,
  waitForExactTarget,
  waitForPageContext,
  wrapCode,
  type ExecuteTargetSelection,
  type HandoffPageTarget,
  type RequestHandoff,
}

tunePatchright()

type ExecuteSandboxOptions = {
  readonly endpointUrl: string
  /** The relay token for connectOverCDP; read from the data root when omitted. */
  readonly authToken?: string
  readonly sessionId?: string
  readonly requestHandoff?: RequestHandoff
  readonly onDefaultTargetChange?: (target: SessionTarget | undefined) => void
  /** Health-check budget per attempt for a page that failed with an execution-context error. */
  readonly pageHealthCheckTimeoutMs?: number
  /** Whether the page with this target id is being recorded; helpers then draw nothing into it. */
  readonly isRecordingTarget?: (targetId: string) => boolean
  /** The session's domain allowlist patterns (domain-policy.ts), or undefined when it has none. */
  readonly allowedOrigins?: () => readonly string[] | undefined
  /** Allowlist violations the relay saw in this session's tabs since the last execute. */
  readonly drainGuardWarnings?: () => readonly string[]
  /** Passkey account choice in this session's agent tabs (passkey-bridge.ts), by CDP target id. */
  readonly passkeys?: {
    /** Throws when the target isn't an agent tab of this session. An empty username clears the choice. */
    readonly select: (targetId: string, site: string, username: string) => void
    readonly choiceSince: (targetId: string, since: number) => readonly PasskeyChoice[] | undefined
  }
}

export type ExecuteResult = {
  readonly text: string
  readonly value?: unknown
  readonly media?: readonly ExecuteMedia[]
  readonly isError: boolean
  readonly logs: readonly ExecuteLogEntry[]
  readonly logSummary: ExecuteLogSummary
  readonly warnings: readonly string[]
  readonly diagnostic?: string
  readonly aftermath?: ExecuteAftermath
  readonly setupFailed?: true
}

export type ExecuteOptions = {
  readonly targetSelection?: ExecuteTargetSelection
}

export class ExecuteSandbox extends DefaultPageHost {
  private browser: Browser | undefined
  /** Full Node access for execute code (OPENCODE_BROWSER_ALLOW_NODE=1); otherwise code runs in a vm realm. */
  private readonly allowNode = executeAllowsNode()
  private readonly snapshotRefs: SnapshotRefRegistry = { selectors: new Map() }
  private readonly networkCapture = new NetworkCapture.Recorder()
  private readonly secrets: ExecuteSecretsBridge
  private realm: ExecuteRealm | undefined
  private state: Record<string, unknown>

  constructor(readonly options: ExecuteSandboxOptions) {
    super({
      ...(options.onDefaultTargetChange ? { onDefaultTargetChange: options.onDefaultTargetChange } : {}),
      ...(options.pageHealthCheckTimeoutMs === undefined ? {} : { pageHealthCheckTimeoutMs: options.pageHealthCheckTimeoutMs }),
    })
    this.secrets = new ExecuteSecretsBridge({
      networkCapture: this.networkCapture,
      allowedOrigins: () => this.options.allowedOrigins?.(),
      ...(this.options.passkeys ? { passkeys: this.options.passkeys } : {}),
      addWarningOnce: (warning) => this.addWarningOnce(warning),
    })
    this.realm = this.allowNode ? undefined : this.createRealm()
    this.state = this.realm?.state ?? {}
  }

  protected bindCaptureToPage(page: Page | undefined): void {
    this.networkCapture.bindPage(page)
  }

  private createRealm(): ExecuteRealm {
    return new ExecuteRealm({
      onHostCall: (fn, receiver, args) => {
        this.addWarningOnce(pageVisibleApiWarning(fn, receiver, args))
        const hook = pageHookCall(fn, args)
        if (hook) this.secrets.pageHooks.add(hook)
      },
    })
  }

  execute(code: string, options: ExecuteOptions = {}): Effect.Effect<ExecuteResult> {
    return Effect.tryPromise({
      try: async () => {
        if (this.realm?.isStopped) {
          this.realm = this.createRealm()
          this.state = this.realm.state
          this.pendingWarnings.push("The previous execute realm stopped; JavaScript state and pending callbacks were reset.")
        }
        if (!this.realm) for (const warning of pageVisibleApiSourceWarnings(code)) this.addWarningOnce(warning)
        const globals = await this.getGlobals(options)
        const { result, logs, logSummary, aftermath } = await runUserCode({ code, globals, ...(this.realm ? { realm: this.realm } : {}) })
          .then(async (completed) => ({ ...completed, aftermath: await this.withChallenge(globals.page, completed.aftermath, false) }))
          .catch(async (error: unknown) => {
            if (!(error instanceof ExecuteCodeError) || !error.aftermath) throw error
            throw new ExecuteCodeError(error.originalError, error.logs, error.logSummary, await this.withChallenge(globals.page, error.aftermath, true))
          })
        await this.networkCapture.settleForOutput()
        const extracted = extractExecuteMedia(result)
        const redactedValue = this.secrets.redactOutputValue(extracted.value)
        const jsonSafeResult = toJsonSafeValue(redactedValue)
        const bounded = boundExecuteResult(stringifyResult(redactedValue), jsonSafeResult.serializable ? jsonSafeResult.value : undefined, jsonSafeResult.serializable)
        const warnings = this.finalizeWarnings(
          logSummary,
          jsonValueWarning(redactedValue, jsonSafeResult),
          bounded.warning,
        )
        return {
          text: bounded.text,
          ...(bounded.hasValue ? { value: bounded.value } : {}),
          ...(extracted.media.length > 0 ? { media: extracted.media } : {}),
          isError: false,
          logs: this.secrets.redactCaptureLogs(logs),
          logSummary,
          warnings,
          aftermath: this.secrets.redactCaptureAftermath(aftermath),
        }
      },
      catch: (cause) => {
        if (cause instanceof ExecuteCodeError) {
          return cause
        }
        return cause instanceof Error ? cause : new Error("execute sandbox code", { cause })
      },
    }).pipe(
      Effect.uninterruptible,
      Effect.tapError(() => Effect.promise(() => this.networkCapture.settleForOutput())),
      Effect.match({
        onFailure: (error): ExecuteResult => {
          const logSummary = error instanceof ExecuteCodeError ? error.logSummary : emptyExecuteLogSummary()
          const aftermath = error instanceof ExecuteCodeError ? error.aftermath : undefined
          const diagnostic = error instanceof SessionPageRecoveryError
            ? `session-page/${error.reason}`
            : this.pageProtectedUi && isMaskedProtectedUiFailure(error)
            ? protectedExtensionUiDiagnostic
            : executionContextFailureDiagnostic(error, aftermath)
          if (diagnostic?.startsWith("execution-context/")) {
            this.pageHealthCheckRequired = true
          }
          const closedUnderScript = (this.closedDefaultPage !== undefined || this.pendingTargetRebind === "replaced") && /has been closed/i.test(error.message)
          const warnings = this.finalizeWarnings(
            logSummary,
            closedUnderScript ? `${defaultPageReattachedWarning} The tab kept any navigation it made; continue from it in the next execute.` : undefined,
            diagnostic === protectedExtensionUiDiagnostic ? protectedExtensionUiWarning : undefined,
            error instanceof ExecuteCodeError ? formatNodeContextWarning(error.originalError) : undefined,
            error instanceof ExecuteCodeError ? formatPointerInterceptionWarning(error.originalError) : formatPointerInterceptionWarning(error),
            diagnostic === protectedExtensionUiDiagnostic
              ? undefined
              : formatLocatorFailurePageWarning(error instanceof ExecuteCodeError ? error.originalError : error, aftermath, this.recreatedFromClosedUrl),
          )
          return {
            text: this.secrets.redactOutputText(error instanceof ExecuteCodeError ? userCodeStack(error) : error.message),
            isError: true,
            logs: this.secrets.redactCaptureLogs(error instanceof ExecuteCodeError ? error.logs : []),
            logSummary,
            warnings,
            ...(diagnostic ? { diagnostic: this.secrets.redactOutputText(diagnostic) } : {}),
            ...(aftermath ? { aftermath: this.secrets.redactCaptureAftermath(aftermath) } : {}),
            ...(error instanceof ExecuteCodeError ? {} : { setupFailed: true as const }),
          }
        },
        onSuccess: (result) => {
          return result
        },
      }),
    )
  }

  authenticatedJson(
    request: Omit<AuthenticatedJsonRequest, "sessionId">,
  ): Effect.Effect<AuthenticatedJsonOutcome, Error> {
    const sandbox = this
    return Effect.gen(function* () {
      if (request.sensitive === true && sandbox.networkCapture.status().active) {
        return AuthenticatedJsonOutcome.cases.SensitiveCaptureActive.make({})
      }
      const page = yield* sandbox.ensureSessionPage("Set up authenticated origin page")
      const firstOutcome = yield* AuthenticatedOrigin.requestJson(page, request)
      const isAuthFailure =
        firstOutcome._tag === "OriginMismatch" ||
        (firstOutcome._tag === "HttpError" && (firstOutcome.status === 401 || firstOutcome.status === 403)) ||
        (firstOutcome._tag !== "Success" && /\/(?:login|signin|sign-in|auth)\b/i.test(safePageUrl(page) ?? ""))
      if (
        request.handoffOnAuthFailure === true &&
        sandbox.options.requestHandoff !== undefined &&
        isAuthFailure
      ) {
        const requestHandoff = sandbox.options.requestHandoff
        const targetId = yield* Effect.tryPromise(() => pageTargetId(page))
        const message = request.handoffMessage?.trim() || `Sign in to ${request.origin}, then click Continue`
        const outcome = yield* Effect.tryPromise(() =>
          requestHandoff({
            message,
            timeoutMs: defaultHandoffTimeoutMs,
            target: { targetId },
          }),
        )
        yield* Effect.tryPromise(() =>
          finishHandoff({
            outcome,
            message,
            timeoutMs: defaultHandoffTimeoutMs,
            contextTimeoutMs: handoffPageContextTimeoutMs,
            evaluate: async () => {
              await page.evaluate(() => true)
            },
          }),
        )
        const retryPage = yield* sandbox.ensureSessionPage("Re-verify authenticated origin page after handoff")
        return yield* AuthenticatedOrigin.requestJson(retryPage, {
          ...request,
          startUrl: request.startUrl ?? "/",
        })
      }
      return firstOutcome
    }).pipe(Effect.uninterruptible)
  }

  /**
   * After a call that navigated or failed, look for a bot challenge or block page on the session page. A challenge the
   * browser clears by itself is waited out (bounded); an interactive one or a block is reported, never touched.
   */
  private async withChallenge(page: Page, aftermath: ExecuteAftermath, failed: boolean): Promise<ExecuteAftermath> {
    if (!failed && aftermath.navigations.length === 0 && aftermath.startUrl === aftermath.endUrl) return aftermath
    const outcome = await detectChallenge(page, { waitMs: challengeWaitMs() }).catch(() => undefined)
    if (!outcome) return aftermath
    this.addWarningOnce(challengeWarning(outcome))
    return { ...aftermath, challenge: outcome }
  }

  private drainWarnings(): string[] {
    const warnings = this.pendingWarnings
    this.pendingWarnings = []
    for (const warning of this.options.drainGuardWarnings?.() ?? []) if (!warnings.includes(warning)) warnings.push(warning)
    return warnings
  }

  private finalizeWarnings(logSummary: ExecuteLogSummary, ...extraWarnings: Array<string | undefined>): string[] {
    const warnings = this.drainWarnings()
    for (const warning of extraWarnings) {
      if (warning) warnings.push(warning)
    }
    const logCompactionWarning = formatLogCompactionWarning(logSummary)
    if (logCompactionWarning) {
      warnings.push(logCompactionWarning)
    }
    return warnings.map((warning) => this.secrets.redactOutputText(warning))
  }

  redactNetworkCaptureText(text: string): string {
    return this.secrets.redactOutputText(text)
  }

  /**
   * Stops a running script from outside (the toolbar's stop, session delete/reset): closes its browser connection so
   * every Playwright call it makes rejects, and disposes its realm (pending runs reject, timers are revoked; `state` resets).
   * The session manager relies on this hook; keep it when the realm changes.
   */
  abortExecution(): Effect.Effect<void, Error> {
    this.realm?.dispose(new Error("Execute stopped: the session was stopped, deleted or reset"))
    return this.disconnectSettled()
  }

  disconnectSettled(): Effect.Effect<void, Error> {
    const sandbox = this
    return Effect.gen(function* () {
      sandbox.realm?.dispose()
      sandbox.realm = sandbox.allowNode ? undefined : sandbox.createRealm()
      sandbox.state = sandbox.realm?.state ?? {}
      // Routes, listeners, init scripts and CDP sessions belong to the browser connection closed below.
      sandbox.secrets.pageHooks.clear()
      const browser = sandbox.browser
      sandbox.browser = undefined
      sandbox.unbindDefaultPage(sandbox.defaultPageTargetId, {
        ownsPage: sandbox.ownsPage,
        pageCrashed: sandbox.pageCrashed,
        pageProtectedUi: sandbox.pageProtectedUi,
      })
      yield* sandbox.networkCapture.cancel()
      if (browser) {
        yield* runSettledPlaywrightOperation({
          label: "Disconnect sandbox browser after handoff cancellation",
          run: () => browser.close(),
        }).pipe(Effect.ignore)
      }
    })
  }

  closeSettled(options: { readonly clearState?: boolean } = {}): Effect.Effect<void, Error> {
    const sandbox = this
    return Effect.gen(function* () {
      sandbox.realm?.dispose()
      const page = sandbox.page
      const browser = sandbox.browser
      const ownsOpenPage = page !== undefined && sandbox.ownsPage && !page.isClosed()
      sandbox.browser = undefined
      sandbox.closedDefaultPage = undefined
      sandbox.unbindDefaultPage(undefined, { notify: true })
      if (options.clearState) for (const key of Object.keys(sandbox.state)) delete sandbox.state[key]
      yield* sandbox.networkCapture.cancel()

      if (ownsOpenPage) {
        yield* runSettledPlaywrightOperation({
          label: "Close sandbox page after adoption",
          run: () => page.close(),
        }).pipe(Effect.ignore)
      }
      if (browser) {
        yield* runSettledPlaywrightOperation({
          label: "Close sandbox browser connection after adoption",
          run: () => browser.close(),
        }).pipe(Effect.ignore)
      }
    })
  }

  adoptPage(targetId: string): Effect.Effect<void, Error> {
    const sandbox = this
    return Effect.gen(function* () {
      // The manager reserves and validates the exact registry generation. Adoption
      // binds that identity, not renderer readiness: a cold CDP connection waits
      // for every announced page to initialize, which a busy user tab cannot do.
      const currentPage = sandbox.page
      const sameTarget = sandbox.defaultPageTargetId === targetId
      yield* sandbox.networkCapture.cancel()
      if (shouldCloseCurrentPageOnAdopt({
        hasCurrentPage: currentPage !== undefined,
        ownsCurrentPage: sandbox.ownsPage,
        currentPageIsSelected: sameTarget,
        currentPageIsClosed: currentPage?.isClosed() ?? true,
      }) && currentPage) {
        // Keep the old binding until close settles. A failed close must not
        // publish the new identity or orphan an open relay-owned page.
        yield* runSettledPlaywrightOperation({
          label: "Close the previous session page during adoption",
          run: () => currentPage.close(),
        })
      }
      sandbox.unbindDefaultPage(targetId)
    }).pipe(Effect.uninterruptible)
  }

  private async connectContext(): Promise<{ readonly browser: Browser; readonly context: BrowserContext }> {
    if (!this.browser?.isConnected()) {
      const hadBrowser = this.browser !== undefined
      const staleBrowser = this.browser
      if (staleBrowser) {
        await Effect.runPromise(runPlaywrightOperation({
          label: "Close stale browser connection before reconnecting",
          timeoutMs: playwrightCloseTimeoutMs,
          run: () => staleBrowser.close(),
        }).pipe(Effect.ignore))
      }
      const adoptedDefaultTarget = this.defaultPageTargetId !== undefined && !this.ownsPage
      try {
        // Let Playwright own timeout/transport cleanup; never race and abandon
        // a connect promise that could bind a page after reporting failure.
        this.browser = await chromium.connectOverCDP(this.options.endpointUrl, {
          timeout: adoptedDefaultTarget ? adoptedPageConnectTimeoutMs : playwrightConnectTimeoutMs,
          headers: {
            Authorization: `Bearer ${this.options.authToken ?? relayToken()}`,
            ...(this.options.sessionId ? { "OpenCode-Browser-Session-Id": encodeURIComponent(this.options.sessionId), "OpenCode-Browser-Client-Kind": "sandbox" } : {}),
          },
        })
      } catch (cause) {
        if (adoptedDefaultTarget && cause instanceof errors.TimeoutError) {
          throw new SessionPageRecoveryError({
            message: `Automation connection initialization for the adopted tab did not finish within ${adoptedPageConnectTimeoutMs}ms. The tab and exact target were kept; user code did not run. Retry after the browser or page becomes responsive.`,
            reason: "adopted-initialization-timeout",
            cause,
          })
        }
        throw cause
      }
      this.unbindDefaultPage(this.defaultPageTargetId, {
        ownsPage: this.ownsPage,
        pageCrashed: this.pageCrashed,
        pageProtectedUi: this.pageProtectedUi,
        ...(this.pendingTargetRebind ? { rebind: this.pendingTargetRebind } : {}),
      })
      if (hadBrowser) {
        this.pendingWarnings.push("Relay connection was lost and re-established; the session default page was re-resolved.")
      }
    }
    const browser = this.browser
    const context = browser.contexts()[0] ?? (await browser.newContext())
    await registerAriaSnapshotSelector(context)
    installDownloadCapabilityGuards(context)
    return { browser, context }
  }

  /**
   * Drop the Playwright connection but remember the default page target so the
   * next connect re-resolves the same tab with fresh frame and context state.
   * The relay re-enables Runtime for the tab on the new connection, which is the
   * designed recovery for a page whose context events stopped reaching Playwright.
   */
  private async repairSessionPage(): Promise<void> {
    const browser = this.browser
    this.browser = undefined
    this.unbindDefaultPage(this.defaultPageTargetId, {
      ownsPage: this.ownsPage,
      pageCrashed: this.pageCrashed,
      pageProtectedUi: this.pageProtectedUi,
      rebind: "repaired",
    })
    if (browser) {
      await Effect.runPromise(runPlaywrightOperation({
        label: "Close browser connection to repair the session page",
        timeoutMs: playwrightCloseTimeoutMs,
        run: () => browser.close(),
      }).pipe(Effect.ignore))
    }
  }

  private async acquireSessionPage(targetSelection?: ExecuteTargetSelection): Promise<{
    readonly browser: Browser
    readonly context: BrowserContext
    readonly page: Page
  }> {
    let { browser, context } = await this.connectContext()
    let page: Page
    try {
      page = await this.getSessionPage({ context, ...(targetSelection ? { targetSelection } : {}) })
    } catch (error) {
      if (!(error instanceof SessionPageRepairRequired)) throw error
      await this.repairSessionPage()
      ;({ browser, context } = await this.connectContext())
      page = await this.getSessionPage({ context, ...(targetSelection ? { targetSelection } : {}) })
    }
    installPageReadTimeout(page)
    installViewportZoomGuard({
      page,
      explicitMediaFeatures: this.explicitMediaFeatures,
      getExplicitMedia: () => this.explicitMedia,
      setExplicitMedia: (media) => {
        this.explicitMedia = media
      },
      addWarningOnce: (warning) => this.addWarningOnce(warning),
    })
    this.networkCapture.bindPage(this.page)
    return { browser, context, page }
  }

  private ensureSessionPage(label: string): Effect.Effect<Page, Error> {
    return Effect.tryPromise({
      try: async () => (await this.acquireSessionPage()).page,
      catch: (cause) => cause instanceof Error ? cause : new Error(label, { cause }),
    })
  }

  private async getGlobals(options: ExecuteOptions): Promise<SandboxGlobals> {
    const { browser, context, page } = await this.acquireSessionPage(options.targetSelection)
    return buildSandboxGlobals({
      browser,
      context,
      page,
      state: this.state,
      realm: this.realm,
      snapshotRefs: this.snapshotRefs,
      networkCapture: this.networkCapture,
      secrets: this.secrets,
      requestHandoff: this.options.requestHandoff,
      isRecordingTarget: this.options.isRecordingTarget,
      isDefaultPage: (candidate) => candidate === this.page,
      resolveDefaultPage: () => this.getSessionPage({ context }),
      disconnectSettled: () => this.disconnectSettled(),
      warnSyntheticInput: () => this.warnSyntheticInput(),
    })
  }

  protected clearSnapshotRefs(): void {
    this.snapshotRefs.removeNavigationListener?.()
    delete this.snapshotRefs.removeNavigationListener
    invalidateSnapshotDocument(this.snapshotRefs)
  }

  getStatus(): { readonly sessionId?: string; readonly connected: boolean; readonly pageUrl: string | null; readonly stateKeys: string[] } {
    const pageUrl = this.page && !this.page.isClosed() ? this.page.url() : null
    return {
      ...(this.options.sessionId ? { sessionId: this.options.sessionId } : {}),
      connected: isSessionPageConnected({
        browserConnected: Boolean(this.browser?.isConnected()),
        pageUrl,
        healthCheckRequired: this.pageHealthCheckRequired,
      }),
      pageUrl,
      stateKeys: Object.keys(this.state),
    }
  }

  networkStart(options: NetworkCapture.NetworkCaptureOptions = {}): Effect.Effect<NetworkCapture.NetworkCaptureStatus, Error> {
    const sandbox = this
    return Effect.gen(function* () {
      const page = yield* sandbox.ensureSessionPage("Set up page for network capture")
      return yield* sandbox.networkCapture.start(page, options)
    }).pipe(Effect.uninterruptible)
  }

  networkStatus(): NetworkCapture.NetworkCaptureStatus {
    return this.networkCapture.status()
  }

  networkStop(options: NetworkCapture.NetworkCaptureStopOptions = {}): Effect.Effect<NetworkCapture.NetworkCaptureResult, Error> {
    return this.networkCapture.stop(options)
  }

  networkCancel(): Effect.Effect<{ readonly cancelled: boolean }> {
    return this.networkCapture.cancel()
  }

  networkEnd(reason: string): Effect.Effect<{ readonly cancelled: boolean }> {
    return this.networkCapture.end(reason)
  }

  authRefresh(options: {
    readonly name: string
    readonly urlFilter?: string
    readonly timeoutMs?: number
  }): Effect.Effect<NetworkCapture.NetworkCaptureResult, Error> {
    const sandbox = this
    return Effect.gen(function* () {
      const page = yield* sandbox.ensureSessionPage("Set up page for auth refresh")
      yield* AuthProfile.read(options.name).pipe(Effect.asVoid)
      yield* sandbox.networkCapture.start(page, {
        ...(options.urlFilter ? { urlFilter: options.urlFilter } : {}),
      })
      return yield* Effect.gen(function* () {
        yield* Effect.tryPromise({
          try: () => page.reload({ waitUntil: "domcontentloaded", timeout: options.timeoutMs ?? 30_000 }),
          catch: (cause) => cause instanceof Error ? cause : new Error("Refresh auth profile", { cause }),
        })
        yield* Effect.tryPromise({
          try: () => page.waitForLoadState("networkidle", { timeout: Math.min(options.timeoutMs ?? 30_000, 5_000) }).catch(() => {}),
          catch: (cause) => cause instanceof Error ? cause : new Error("Wait for auth refresh network", { cause }),
        })
        return yield* sandbox.networkCapture.stop({ secrets: options.name, requireObservedSecrets: true })
      }).pipe(Effect.ensuring(sandbox.networkCapture.cancel()))
    }).pipe(Effect.uninterruptible)
  }

  /** fillInput sets values directly: the page sees untrusted input events without key presses. */
  private warnSyntheticInput(): void {
    this.addWarningOnce(syntheticInputWarning)
  }
}
