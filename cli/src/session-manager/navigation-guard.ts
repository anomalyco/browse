/**
 * Relay-side enforcement of per-session domain allowlists (domain-policy.ts).
 *
 * - Agent navigations (Page.navigate, Target.createTarget) to a host outside the session's allowlist are refused
 *   before they reach the browser, after resolving the host so a public name pointing at a private address is caught.
 * - Navigations the relay only observes (links, redirects, `location` changes, form posts, popups) are checked on the
 *   main frame's CDP events: a disallowed one that starts is stopped (Page.stopLoading; best effort, the request may
 *   already be on its way), and a disallowed document that commits is replaced with about:blank. A popup that opens on
 *   a disallowed host is closed. A main document whose actual remote IP is private, when no allowlist entry names its
 *   host exactly, is replaced too (DNS rebinding).
 * - Subresource requests (images, fetch, XHR, iframes, workers) are not blocked: CDP request interception (Fetch) is
 *   shared with Playwright's page.route() on the same debugger session, so the relay can't own it reliably. The
 *   allowlist therefore limits where the session's tabs go, not every byte a page sends.
 *
 * Tabs a user lent are enforced only while their session runs a script, so the user's own browsing stays theirs.
 * Each violation is reported to the session's next execute result as a warning.
 */
import { checkNavigationUrl, checkUrl, explicitlyAllowsHost, isPrivateAddress, parseOriginPatterns, type OriginRule } from "../auth/domain-policy.ts"
import type { JsonObject } from "../protocol.ts"
import { createTargetUrl, getObject, getString } from "../relay/helpers.ts"

export type NavigationGuardTarget = {
  readonly tabId: number
  readonly owner?: "relay" | "user"
  readonly opencodeBrowserSessionId?: string
  readonly targetInfo: { readonly targetId: string; readonly url: string }
}

export type NavigationGuardDependencies = {
  readonly allowedOrigins: (sessionId: string) => readonly string[] | undefined
  readonly isExecuting: (sessionId: string) => boolean
  readonly mainFrameId: (tabId: number) => string | undefined
  readonly send: (tabId: number, method: string, params: JsonObject) => Promise<unknown>
  /** Close a relay-owned tab (a popup); never a user's tab. */
  readonly closeTab: (tabId: number) => Promise<unknown>
  readonly log: (event: string, details: Record<string, unknown>) => void
}

const maxPendingWarnings = 10

/** Origin and path only: query strings and fragments can carry tokens. */
function shortUrl(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.origin}${parsed.pathname}`.slice(0, 200)
  } catch {
    return url.slice(0, 200)
  }
}

export class SessionNavigationGuard {
  private readonly warnings = new Map<string, string[]>()
  private readonly rulesCache = new Map<string, { readonly key: string; readonly rules: readonly OriginRule[] }>()
  /** Popups that haven't shown an allowed document yet; a violation closes them instead of blanking them. */
  private readonly freshPopups = new Set<number>()
  /** The last refused URL per tab, so the event path and a post-navigation check act once. */
  private readonly handledViolations = new Map<number, string>()

  constructor(private readonly dependencies: NavigationGuardDependencies) {}

  /** The session's parsed rules, or undefined without an allowlist. */
  rules(sessionId: string | undefined): readonly OriginRule[] | undefined {
    if (!sessionId) return undefined
    const patterns = this.dependencies.allowedOrigins(sessionId)
    if (!patterns || patterns.length === 0) return undefined
    const key = patterns.join("\n")
    const cached = this.rulesCache.get(sessionId)
    if (cached?.key === key) return cached.rules
    const rules = parseOriginPatterns(patterns)
    this.rulesCache.set(sessionId, { key, rules })
    return rules
  }

  /** Warnings for the session's next execute result. */
  drainWarnings(sessionId: string): readonly string[] {
    const pending = this.warnings.get(sessionId) ?? []
    this.warnings.delete(sessionId)
    return pending
  }

  /** Refusal message for an agent navigation command, or undefined when it may go ahead. */
  async checkCommand(options: { readonly method: string; readonly params: JsonObject | undefined; readonly sessionId: string | undefined }): Promise<string | undefined> {
    if (options.method !== "Page.navigate" && options.method !== "Target.createTarget") return undefined
    const rules = this.rules(options.sessionId)
    if (!rules) return undefined
    const url = options.method === "Target.createTarget" ? createTargetUrl(options.params) : getString(options.params, "url")
    if (url === undefined) return undefined
    const decision = await checkNavigationUrl(url, rules)
    if (decision.allowed) return undefined
    this.dependencies.log("allowlist.refused", { session: options.sessionId, method: options.method, reason: decision.reason })
    return `browse blocked ${options.method}: session ${options.sessionId} has a domain allowlist and ${decision.reason}. Ask the user before widening it (session_allowlist / \`session allow\`).`
  }

  /** Apply the session's allowlist to a popup the relay just attached. */
  popupAttached(target: NavigationGuardTarget): void {
    if (!this.enforced(target)) return
    this.freshPopups.add(target.tabId)
    this.observeCommittedUrl(target, target.targetInfo.url)
  }

  /**
   * Check a tab the relay created after its first navigation. Unlike a popup, a violation sends it back to
   * about:blank instead of closing it. Returns whether the tab's URL is allowed.
   */
  createdTabNavigated(target: NavigationGuardTarget): boolean {
    if (!this.enforced(target)) return true
    // A violation is already being handled (the tab is on its way back to about:blank): don't publish this URL.
    if (this.handledViolations.has(target.tabId)) return false
    return this.observeCommittedUrl(target, target.targetInfo.url)
  }

  forgetTab(tabId: number): void {
    this.freshPopups.delete(tabId)
    this.handledViolations.delete(tabId)
  }

  /**
   * Observe a root-session CDP event of a tab. Returns false when a main-frame URL was refused, so it is not
   * published as the tab's URL.
   */
  observeEvent(target: NavigationGuardTarget, method: string, params: JsonObject | undefined): boolean {
    if (method !== "Page.frameNavigated" && method !== "Page.frameRequestedNavigation" && method !== "Page.frameStartedNavigating" && method !== "Network.responseReceived") return true
    if (!this.enforced(target)) return true
    const sessionId = target.opencodeBrowserSessionId!
    const rules = this.rules(sessionId)!
    const mainFrameId = this.dependencies.mainFrameId(target.tabId) ?? target.targetInfo.targetId
    if (method === "Page.frameNavigated") {
      const frame = getObject(params?.frame)
      if (getString(frame, "parentId") !== undefined) return true
      const url = getString(frame, "url")
      return url === undefined || this.observeCommittedUrl(target, url)
    }
    if (method === "Network.responseReceived") {
      if (getString(params, "type") !== "Document" || getString(params, "frameId") !== mainFrameId) return true
      const response = getObject(params?.response)
      const address = getString(response, "remoteIPAddress")
      const url = getString(response, "url")
      if (!address || !url || !isPrivateAddress(address) || explicitlyAllowsHost(rules, url)) return true
      this.violation(target, url, `its document came from the private address ${address} (name it exactly in the allowlist to allow it)`, "commit")
      return false
    }
    // A navigation is starting: stop it before the request goes out when we can.
    if (getString(params, "frameId") !== mainFrameId) return true
    const url = getString(params, "url")
    if (url === undefined) return true
    const decision = checkUrl(url, rules)
    if (decision.allowed) return true
    this.dependencies.send(target.tabId, "Page.stopLoading", {}).catch(() => {})
    this.addWarning(sessionId, `Domain allowlist: a tab of session ${sessionId} started to navigate to ${shortUrl(url)}, but ${decision.reason}; browse stopped it. Ask the user before widening the allowlist.`)
    this.dependencies.log("allowlist.stopped", { tabId: target.tabId, session: sessionId, method, reason: decision.reason })
    return false
  }

  private enforced(target: NavigationGuardTarget): boolean {
    const sessionId = target.opencodeBrowserSessionId
    if (!sessionId || !this.rules(sessionId)) return false
    return target.owner !== "user" || this.dependencies.isExecuting(sessionId)
  }

  private observeCommittedUrl(target: NavigationGuardTarget, url: string): boolean {
    const rules = this.rules(target.opencodeBrowserSessionId)
    if (!rules) return true
    const decision = checkUrl(url, rules)
    if (decision.allowed) {
      this.handledViolations.delete(target.tabId)
      if (!/^about:/.test(url)) this.freshPopups.delete(target.tabId)
      return true
    }
    this.violation(target, url, decision.reason, "commit")
    return false
  }

  private violation(target: NavigationGuardTarget, url: string, reason: string, _stage: "commit"): void {
    if (this.handledViolations.get(target.tabId) === url) return
    this.handledViolations.set(target.tabId, url)
    const sessionId = target.opencodeBrowserSessionId!
    const shownUrl = shortUrl(url)
    const popup = this.freshPopups.has(target.tabId) && target.owner === "relay"
    const action = popup ? "closed the popup" : "sent the tab back to about:blank"
    this.addWarning(sessionId, `Domain allowlist: a tab of session ${sessionId} went to ${shownUrl}, but ${reason}; browse ${action}. Ask the user before widening the allowlist.`)
    this.dependencies.log("allowlist.violation", { tabId: target.tabId, session: sessionId, url: shownUrl, popup })
    if (popup) {
      this.freshPopups.delete(target.tabId)
      this.dependencies.closeTab(target.tabId).catch((error: unknown) => {
        this.dependencies.log("allowlist.close-failed", { tabId: target.tabId, error: error instanceof Error ? error.message : String(error) })
      })
      return
    }
    this.dependencies.send(target.tabId, "Page.stopLoading", {})
      .catch(() => {})
      .then(() => this.dependencies.send(target.tabId, "Page.navigate", { url: "about:blank" }))
      .catch(() => {})
  }

  private addWarning(sessionId: string, warning: string): void {
    const pending = this.warnings.get(sessionId) ?? []
    if (!pending.includes(warning) && pending.length < maxPendingWarnings) pending.push(warning)
    this.warnings.set(sessionId, pending)
  }
}
