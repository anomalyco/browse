import { Effect } from "effect"
import { chromium, errors, type Browser, type BrowserContext, type Frame, type Page } from "patchright-core"
import { registerAriaSnapshotSelector } from "./aria-snapshot.ts"
import * as AuthProfile from "./auth-profile.ts"
import * as AuthenticatedOrigin from "./authenticated-origin.ts"
import { challengeWarning } from "./challenge-detection.ts"
import { executeAllowsNode, ExecuteRealm, pageVisibleApiWarning } from "./execute-realm.ts"
import {
  challengeWaitMs,
  detectChallenge,
  ExecuteCodeError,
  getAutoReturnExpression,
  pageHookCall,
  pageVisibleApiSourceWarnings,
  runUserCode,
  wrapCode,
  type SandboxGlobals,
} from "./execute/code-runner.ts"
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
  applyExplicitMediaFeatures,
  defaultHandoffTimeoutMs,
  defaultPageClosedWarning,
  defaultPageCrashedWarning,
  defaultPageReattachedWarning,
  defaultPageRecoveredWarning,
  defaultPageRepairedWarning,
  defaultPageReplacedWarning,
  downloadCapabilityErrorMessage,
  finishHandoff,
  handoffPageContextTimeoutMs,
  hasExplicitTargetSelection,
  installClosedPageReplacementGuard,
  installDownloadCapabilityGuard,
  installDownloadCapabilityGuards,
  installViewportZoomGuard,
  isDisposableSessionPage,
  isMaskedProtectedUiFailure,
  isSessionPageConnected,
  openPageWithTargetId,
  pageTargetId,
  pdfViewerWarning,
  playwrightCloseTimeoutMs,
  playwrightConnectTimeoutMs,
  protectedExtensionUiDiagnostic,
  protectedExtensionUiWarning,
  recoverSessionPage,
  resolvePageTargetId,
  runPlaywrightOperation,
  runSettledPlaywrightOperation,
  safePageUrl,
  selectPage,
  selectTarget,
  sessionPageHealthCheckTimeoutMs,
  SessionPageRecoveryError,
  SessionPageRepairRequired,
  shouldCloseCurrentPageOnAdopt,
  showsPdf,
  syntheticInputWarning,
  TargetSelectionError,
  waitForExactTarget,
  waitForPageContext,
  waitForPageTarget,
  type ExecuteTargetSelection,
  type HandoffPageTarget,
  type RequestHandoff,
} from "./execute/page-recovery.ts"
import {
  boundExecuteResult,
  extractExecuteMedia,
  maxExecuteResultChars,
  stringifyResult,
  toJsonSafeValue,
} from "./execute/result-formatting.ts"
import { buildSandboxGlobals } from "./execute/sandbox-globals.ts"
import { ExecuteSecretsBridge } from "./execute/secrets-bridge.ts"
import * as NetworkCapture from "./network-capture.ts"
import { installPageReadTimeout } from "./page-read-timeout.ts"
import type { PasskeyChoice } from "./passkey-bridge.ts"
import { tunePatchright } from "./patchright-tuning.ts"
import {
  AuthenticatedJsonOutcome,
  type AuthenticatedJsonRequest,
  type ExecuteAftermath,
  type ExecuteLogEntry,
  type ExecuteLogSummary,
  type ExecuteMedia,
} from "./relay-schema.ts"
import { relayToken } from "./relay-secrets.ts"
import type { SessionTarget } from "./relay-types.ts"
import { executionContextFailureDiagnostic } from "./runtime-diagnostics.ts"
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

export class ExecuteSandbox {
  private browser: Browser | undefined
  private page: Page | undefined
  private defaultPageTargetId: string | undefined
  /** The default page's target when its page object closed; the same tab may come back (see getSessionPage). */
  private closedDefaultPage: { readonly targetId: string; readonly ownsPage: boolean } | undefined
  private ownsPage = false
  private pageHealthCheckRequired = false
  private pageCrashed = false
  private pageProtectedUi = false
  private pendingTargetRebind: "replaced" | "repaired" | undefined
  private lastKnownNonBlankUrl: string | undefined
  private recreatedFromClosedUrl: string | undefined
  /** Media features the agent set with page.emulateMedia; the relay drops Patchright's defaults otherwise. */
  private readonly explicitMediaFeatures = new Map<string, string>()
  private explicitMedia: string | undefined
  /** Full Node access for execute code (OPENCODE_BROWSER_ALLOW_NODE=1); otherwise code runs in a vm realm. */
  private readonly allowNode = executeAllowsNode()
  private readonly snapshotRefs: SnapshotRefRegistry = { selectors: new Map() }
  private readonly networkCapture = new NetworkCapture.Recorder()
  private pendingWarnings: string[] = []
  private readonly secrets: ExecuteSecretsBridge
  private realm: ExecuteRealm | undefined
  private state: Record<string, unknown>
  private boundPageListeners: {
    readonly page: Page
    readonly close: () => void
    readonly navigate: (frame: Frame) => void
  } | undefined

  constructor(readonly options: ExecuteSandboxOptions) {
    this.secrets = new ExecuteSecretsBridge({
      networkCapture: this.networkCapture,
      allowedOrigins: () => this.options.allowedOrigins?.(),
      ...(this.options.passkeys ? { passkeys: this.options.passkeys } : {}),
      addWarningOnce: (warning) => this.addWarningOnce(warning),
    })
    this.realm = this.allowNode ? undefined : this.createRealm()
    this.state = this.realm?.state ?? {}
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

  private addWarningOnce(warning: string | undefined): void {
    if (warning && !this.pendingWarnings.includes(warning)) this.pendingWarnings.push(warning)
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
          jsonSafeResult.serializable ? undefined : `Execute result could not be represented as JSON value: ${jsonSafeResult.reason}`,
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
            text: this.secrets.redactOutputText(error instanceof ExecuteCodeError ? error.stack ?? error.message : error.message),
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

  /** Forget the bound page; a target id is re-resolved exactly on the next execute. */
  private unbindDefaultPage(
    targetId: string | undefined,
    options: {
      readonly ownsPage?: boolean
      readonly pageCrashed?: boolean
      readonly pageProtectedUi?: boolean
      readonly rebind?: "replaced" | "repaired"
      readonly notify?: boolean
    } = {},
  ): void {
    this.clearPageListeners()
    this.page = undefined
    this.defaultPageTargetId = targetId
    this.ownsPage = options.ownsPage ?? false
    this.pageHealthCheckRequired = false
    this.pageCrashed = options.pageCrashed ?? false
    this.pageProtectedUi = options.pageProtectedUi ?? false
    this.pendingTargetRebind = targetId ? options.rebind : undefined
    this.networkCapture.bindPage(undefined)
    if (options.notify) this.notifyDefaultTargetChange()
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

  markTargetCrashed(targetId: string): boolean {
    if (this.defaultPageTargetId !== targetId) {
      return false
    }
    this.pageHealthCheckRequired = true
    this.pageCrashed = true
    if (!this.pendingWarnings.includes(defaultPageCrashedWarning)) {
      this.pendingWarnings.push(defaultPageCrashedWarning)
    }
    return true
  }

  /** Relay report that protected extension UI started or stopped blocking the default page's tab. */
  markTargetProtectedUi(targetId: string, protectedUi: boolean): boolean {
    if (this.defaultPageTargetId !== targetId) {
      return false
    }
    this.pageProtectedUi = protectedUi
    return true
  }

  markTargetDetached(targetId: string): boolean {
    if (this.defaultPageTargetId !== targetId) {
      return false
    }
    if (this.lastKnownNonBlankUrl) {
      this.recreatedFromClosedUrl = this.lastKnownNonBlankUrl
    }
    this.unbindDefaultPage(undefined)
    if (!this.pendingWarnings.includes(defaultPageClosedWarning)) {
      this.pendingWarnings.push(defaultPageClosedWarning)
    }
    return true
  }

  markTargetReplaced(previousTargetId: string, targetId: string): boolean {
    if (this.defaultPageTargetId !== previousTargetId) return false
    this.unbindDefaultPage(targetId, {
      ownsPage: this.ownsPage,
      rebind: "replaced",
    })
    return true
  }

  restore(target: SessionTarget | undefined, warning = "The relay restarted; session JavaScript state and snapshot refs were reset."): void {
    if (target) {
      this.unbindDefaultPage(target.id, { ownsPage: target.owner === "relay" })
    }
    this.pendingWarnings.push(warning)
  }

  private notifyDefaultTargetChange(): void {
    this.options.onDefaultTargetChange?.(this.defaultPageTargetId
      ? { id: this.defaultPageTargetId, owner: this.ownsPage ? "relay" : "user" }
      : undefined)
  }

  private recordNonBlankUrl(url: string | null | undefined): void {
    if (url && url !== "about:blank" && !url.startsWith("chrome-error://")) {
      this.lastKnownNonBlankUrl = url
      this.recreatedFromClosedUrl = undefined
    }
  }

  private bindDefaultPage(page: Page, targetId: string | undefined, ownsPage: boolean, notify: boolean): void {
    this.clearPageListeners()
    this.page = page
    if (targetId === undefined || targetId !== this.defaultPageTargetId) {
      this.pageCrashed = false
      this.pageProtectedUi = false
    }
    this.defaultPageTargetId = targetId
    this.ownsPage = ownsPage
    this.pendingTargetRebind = undefined
    this.recordNonBlankUrl(safePageUrl(page))
    const close = () => {
      if (this.page !== page) return
      if (targetId !== undefined && !this.pageCrashed) this.closedDefaultPage = { targetId, ownsPage: this.ownsPage }
      if (this.lastKnownNonBlankUrl) {
        this.recreatedFromClosedUrl = this.lastKnownNonBlankUrl
      }
      this.unbindDefaultPage(undefined, {
        pageCrashed: this.pageCrashed,
        pageProtectedUi: this.pageProtectedUi,
        notify: true,
      })
    }
    const navigate = (frame: Frame) => {
      if (this.page === page && frame === page.mainFrame()) {
        this.pageCrashed = false
        this.recordNonBlankUrl(frame.url())
        page.setDefaultTimeout?.(30_000)
        if (this.explicitMediaFeatures.size > 0) {
          void applyExplicitMediaFeatures(page, this.explicitMedia, this.explicitMediaFeatures)
        }
      }
    }
    this.boundPageListeners = { page, close, navigate }
    page.once("close", close)
    page.on("framenavigated", navigate)
    if (notify) this.notifyDefaultTargetChange()
  }

  private clearBoundPageListeners(): void {
    const bound = this.boundPageListeners
    if (!bound) return
    bound.page.off("close", bound.close)
    bound.page.off("framenavigated", bound.navigate)
    this.boundPageListeners = undefined
  }

  private clearSnapshotRefs(): void {
    this.snapshotRefs.removeNavigationListener?.()
    delete this.snapshotRefs.removeNavigationListener
    invalidateSnapshotDocument(this.snapshotRefs)
  }

  private clearPageListeners(): void {
    this.clearBoundPageListeners()
    this.clearSnapshotRefs()
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

  private async getSessionPage({ context, targetSelection }: { readonly context: BrowserContext; readonly targetSelection?: ExecuteTargetSelection }): Promise<Page> {
    const selection = targetSelection ?? {}
    if (hasExplicitTargetSelection(selection)) {
      const selected = selectPage({ pages: context.pages(), selection })
      if (!selected) {
        throw new Error("No page matched target selection")
      }
      return selected
    }
    if (!this.page && this.defaultPageTargetId) {
      const targetId = this.defaultPageTargetId
      const rebind = this.pendingTargetRebind
      const replacement = await waitForPageTarget({ context, targetId, timeoutMs: sessionPageHealthCheckTimeoutMs })
      if (!replacement) {
        throw new SessionPageRecoveryError({
          message: `Playwright did not expose session page target ${targetId} after the browser connection or target changed. Retry after the browser transition settles.`,
          reason: "target-unavailable",
          cause: new Error(`Session page target unavailable: ${targetId}`),
        })
      }
      this.bindDefaultPage(replacement, targetId, this.ownsPage, false)
      if (rebind === "replaced") this.pendingWarnings.push(defaultPageReplacedWarning)
      if (rebind === "replaced" && await showsPdf(replacement)) this.pendingWarnings.push(pdfViewerWarning)
      if (rebind !== "repaired") return replacement
      this.pageHealthCheckRequired = true
      const checked = await this.checkSessionPage(replacement, { repaired: true })
      if (checked) {
        this.pendingWarnings.push(defaultPageRepairedWarning)
        return checked
      }
    }
    if (this.page && !this.page.isClosed()) {
      // A tab blocked by protected extension UI cannot answer a probe; the
      // block is named on the next failure instead of treated as a dead page.
      if ((this.pageHealthCheckRequired && !this.pageProtectedUi) || this.page.url().startsWith("chrome-error://")) {
        const page = await this.checkSessionPage(this.page, { repaired: false })
        if (page) return page
      } else {
        return this.page
      }
    }
    // The page object also closes when the relay loses the extension for a moment (its service worker restarted):
    // the tab lives on and comes back under the same target id, so take it back rather than open another tab.
    const closed = this.closedDefaultPage
    this.closedDefaultPage = undefined
    if (closed && (!this.page || this.page.isClosed())) {
      const same = await openPageWithTargetId(context, closed.targetId)
      if (same) {
        this.bindDefaultPage(same, closed.targetId, closed.ownsPage, true)
        this.recreatedFromClosedUrl = undefined
        this.pendingWarnings.push(await showsPdf(same) ? pdfViewerWarning : defaultPageReattachedWarning)
        return same
      }
    }
    if (this.page?.isClosed()) {
      if (this.lastKnownNonBlankUrl) {
        this.recreatedFromClosedUrl = this.lastKnownNonBlankUrl
      }
      this.unbindDefaultPage(undefined, {
        pageCrashed: this.pageCrashed,
        pageProtectedUi: this.pageProtectedUi,
        notify: true,
      })
      this.pendingWarnings.push(defaultPageClosedWarning)
    }
    const page = await context.newPage()
    const targetId = await resolvePageTargetId(page)
    this.bindDefaultPage(page, targetId, true, true)
    if (this.recreatedFromClosedUrl) {
      installClosedPageReplacementGuard(page, () => {
        this.recreatedFromClosedUrl = undefined
      })
    }
    return page
  }

  /** fillInput sets values directly: the page sees untrusted input events without key presses. */
  private warnSyntheticInput(): void {
    if (!this.pendingWarnings.includes(syntheticInputWarning)) this.pendingWarnings.push(syntheticInputWarning)
  }

  /**
   * Health-check the current default page. Returns the page when it is usable,
   * `undefined` after a disposable relay-owned page was closed so the caller
   * recreates it, throws `SessionPageRepairRequired` when a live relay-owned
   * page should be re-resolved over a fresh connection, and otherwise fails
   * with a `SessionPageRecoveryError` diagnosis while keeping the tab.
   */
  private async checkSessionPage(page: Page, options: { readonly repaired: boolean }): Promise<Page | undefined> {
    const timeoutMs = this.options.pageHealthCheckTimeoutMs ?? sessionPageHealthCheckTimeoutMs
    const sandbox = this
    const recovery = await Effect.runPromise(recoverSessionPage({
      ownsPage: this.ownsPage,
      // Read these after the asynchronous probe: navigation may have recovered
      // an error document or cleared the crash while its old context failed.
      get url() { return page.url() },
      timeoutMs,
      get crashed() { return sandbox.pageCrashed },
      repaired: options.repaired,
      healthCheck: () => waitForPageContext({
        timeoutMs,
        evaluate: async () => {
          await page.evaluate(() => true)
        },
      }),
      close: () => page.close(),
    }))
    if (recovery === "use") {
      this.pageHealthCheckRequired = false
      this.pageCrashed = false
      return page
    }
    if (recovery === "repair") {
      throw new SessionPageRepairRequired()
    }
    this.unbindDefaultPage(undefined, { notify: true })
    this.pendingWarnings.push(defaultPageRecoveredWarning)
    return undefined
  }
}
