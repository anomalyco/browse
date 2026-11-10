import { Effect } from "effect"
import type { BrowserContext, Frame, Page } from "patchright-core"
import { applyExplicitMediaFeatures } from "./guards.ts"
import {
  debuggingBarDismissedWarning,
  defaultActionTimeoutMs,
  defaultPageClosedWarning,
  defaultPageCrashedWarning,
  defaultPageReattachedWarning,
  defaultPageRecoveredWarning,
  defaultPageRepairedWarning,
  defaultPageReplacedWarning,
  installClosedPageReplacementGuard,
  openPageWithTargetId,
  pdfViewerWarning,
  recoverSessionPage,
  sessionPageHealthCheckTimeoutMs,
  SessionPageRecoveryError,
  SessionPageRepairRequired,
  showsPdf,
  waitForPageContext,
  waitForPageTarget,
} from "./page-recovery.ts"
import {
  hasExplicitTargetSelection,
  resolvePageTargetId,
  safePageUrl,
  selectPage,
  type ExecuteTargetSelection,
} from "./target-selection.ts"

/** The default page's target as the host reports it; structurally relay's SessionTarget. */
export type DefaultPageTarget = {
  readonly id: string
  readonly owner: "relay" | "user"
}

/** The options the page-binding state owns; a host keeps every other option to itself. */
export type DefaultPageHostOptions = {
  readonly onDefaultTargetChange?: (target: DefaultPageTarget | undefined) => void
  /** Health-check budget per attempt for a page that failed with an execution-context error. */
  readonly pageHealthCheckTimeoutMs?: number
}

/**
 * The session default page: its identity, its binding to a Playwright page, and the
 * recovery bookkeeping that survives a closed page object or a replaced target.
 *
 * The host keeps the browser connection. This base only decides which page the
 * session is on, so a host can share the identity rules without owning the
 * connection lifecycle.
 */
export abstract class DefaultPageHost {
  protected page: Page | undefined
  protected defaultPageTargetId: string | undefined
  /** The default page's target when its page object closed; the same tab may come back (see getSessionPage). */
  protected closedDefaultPage: { readonly targetId: string; readonly ownsPage: boolean } | undefined
  protected ownsPage = false
  protected pageHealthCheckRequired = false
  protected pageCrashed = false
  protected pageProtectedUi = false
  protected pendingTargetRebind: "replaced" | "repaired" | undefined
  protected lastKnownNonBlankUrl: string | undefined
  protected recreatedFromClosedUrl: string | undefined
  /** The user released the default page from the browser's debugging bar: say so when the next page is created. */
  protected pageReleasedByDebuggingBar = false
  /** Media features the agent set with page.emulateMedia; the relay drops Patchright's defaults otherwise. */
  protected readonly explicitMediaFeatures = new Map<string, string>()
  protected explicitMedia: string | undefined
  protected pendingWarnings: string[] = []
  /** Playwright's default per-action timeout: raised for a call that asked for a longer execute. */
  protected actionTimeoutMs = defaultActionTimeoutMs
  private readonly actionTimeoutPages = new Set<Page>()
  protected boundPageListeners: {
    readonly page: Page
    readonly close: () => void
    readonly navigate: (frame: Frame) => void
  } | undefined

  private readonly onDefaultTargetChangeOption: ((target: DefaultPageTarget | undefined) => void) | undefined
  private readonly pageHealthCheckTimeoutMsOption: number | undefined

  constructor(options: DefaultPageHostOptions = {}) {
    this.onDefaultTargetChangeOption = options.onDefaultTargetChange
    this.pageHealthCheckTimeoutMsOption = options.pageHealthCheckTimeoutMs
  }

  /** Snapshot navigation state belongs to the host; binding a page only has to clear it. */
  protected abstract clearSnapshotRefs(): void

  /** The host's network recorder follows the bound page. */
  protected abstract bindCaptureToPage(page: Page | undefined): void

  protected addWarningOnce(warning: string | undefined): void {
    if (warning && !this.pendingWarnings.includes(warning)) this.pendingWarnings.push(warning)
  }

  /** Give a page this call's action budget, remembering it so the restore covers every page the call touched. */
  protected applyActionTimeout(page: Page): void {
    page.setDefaultTimeout?.(this.actionTimeoutMs)
    this.actionTimeoutPages.add(page)
  }

  /** Back to the steady-state action timeout on every page this session raised. */
  protected restoreActionTimeout(): void {
    this.actionTimeoutMs = defaultActionTimeoutMs
    for (const page of this.actionTimeoutPages) page.setDefaultTimeout?.(this.actionTimeoutMs)
    this.actionTimeoutPages.clear()
  }

  /** Forget the bound page; a target id is re-resolved exactly on the next execute. */
  protected unbindDefaultPage(
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
    this.bindCaptureToPage(undefined)
    if (options.notify) this.notifyDefaultTargetChange()
  }

  markTargetCrashed(targetId: string): boolean {
    if (this.defaultPageTargetId !== targetId) {
      return false
    }
    this.pageHealthCheckRequired = true
    this.pageCrashed = true
    this.addWarningOnce(defaultPageCrashedWarning)
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

  markTargetDetached(targetId: string, options: { readonly releasedByUser?: boolean } = {}): boolean {
    if (this.defaultPageTargetId !== targetId) {
      return false
    }
    const releasedByUser = options.releasedByUser === true
    // A released page was not closed: don't let a later locator failure say the previous page "was closed".
    if (releasedByUser) this.recreatedFromClosedUrl = undefined
    else if (this.lastKnownNonBlankUrl) this.recreatedFromClosedUrl = this.lastKnownNonBlankUrl
    this.pageReleasedByDebuggingBar = releasedByUser
    this.unbindDefaultPage(undefined)
    this.addWarningOnce(releasedByUser ? debuggingBarDismissedWarning : defaultPageClosedWarning)
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

  restore(target: DefaultPageTarget | undefined, warning = "The relay restarted; session JavaScript state and snapshot refs were reset."): void {
    if (target) {
      this.unbindDefaultPage(target.id, { ownsPage: target.owner === "relay" })
    }
    this.pendingWarnings.push(warning)
  }

  private notifyDefaultTargetChange(): void {
    this.onDefaultTargetChangeOption?.(this.defaultPageTargetId
      ? { id: this.defaultPageTargetId, owner: this.ownsPage ? "relay" : "user" }
      : undefined)
  }

  private recordNonBlankUrl(url: string | null | undefined): void {
    if (url && url !== "about:blank" && !url.startsWith("chrome-error://")) {
      this.lastKnownNonBlankUrl = url
      this.recreatedFromClosedUrl = undefined
    }
  }

  protected bindDefaultPage(page: Page, targetId: string | undefined, ownsPage: boolean, notify: boolean): void {
    this.clearPageListeners()
    this.page = page
    this.applyActionTimeout(page)
    if (targetId === undefined || targetId !== this.defaultPageTargetId) {
      this.pageCrashed = false
      this.pageProtectedUi = false
    }
    this.defaultPageTargetId = targetId
    this.ownsPage = ownsPage
    this.pendingTargetRebind = undefined
    // A rebind (adoption, replacement, the next execute) is not the page the user released, so drop any stale notice.
    this.pageReleasedByDebuggingBar = false
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
        page.setDefaultTimeout?.(this.actionTimeoutMs)
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

  private clearPageListeners(): void {
    this.clearBoundPageListeners()
    this.clearSnapshotRefs()
  }

  protected async getSessionPage({ context, targetSelection }: { readonly context: BrowserContext; readonly targetSelection?: ExecuteTargetSelection }): Promise<Page> {
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
    // The warning was queued when the user released the tab; a stopped script may have drained it, so say it again
    // here rather than let the next execute silently open a new page.
    if (this.pageReleasedByDebuggingBar) {
      this.pageReleasedByDebuggingBar = false
      this.addWarningOnce(debuggingBarDismissedWarning)
    }
    const page = await context.newPage()
    const targetId = await resolvePageTargetId(page)
    this.bindDefaultPage(page, targetId, true, true)
    if (this.recreatedFromClosedUrl) {
      installClosedPageReplacementGuard(page, () => {
        this.recreatedFromClosedUrl = undefined
      }, this.actionTimeoutMs)
    }
    return page
  }

  /**
   * Health-check the current default page. Returns the page when it is usable,
   * `undefined` after a disposable relay-owned page was closed so the caller
   * recreates it, throws `SessionPageRepairRequired` when a live relay-owned
   * page should be re-resolved over a fresh connection, and otherwise fails
   * with a `SessionPageRecoveryError` diagnosis while keeping the tab.
   */
  private async checkSessionPage(page: Page, options: { readonly repaired: boolean }): Promise<Page | undefined> {
    const timeoutMs = this.pageHealthCheckTimeoutMsOption ?? sessionPageHealthCheckTimeoutMs
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
