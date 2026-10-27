/**
 * Relay-level CDP guardrails.
 *
 * The relay refuses a small set of CDP methods that would destroy the user's
 * real browser state (OpenCode Browser drives the user's own browser, with
 * their real logins). Read-only sessions additionally refuse input-dispatching
 * methods so "go look at X" tasks cannot click or type.
 *
 * Cookies are scoped to the client's attached pages: cookie reads return only
 * cookies that apply to those pages' hosts, and cookie writes are refused for
 * any other host, so a prompt-injected script cannot dump or plant the
 * profile's cookies for every site. OPENCODE_BROWSER_ALLOW_ALL_COOKIES=1 on
 * the relay lifts the scope.
 *
 * Pure module: given a method and session context, return a rejection message
 * or null. The relay turns a rejection into a normal CDP error response for
 * that command id, so the calling script fails loudly without breaking the
 * connection.
 */

const alwaysBlocked = new Map<string, string>([
  ["Network.clearBrowserCookies", "it would log the user out of every site in their browser"],
  ["Network.clearBrowserCache", "it would clear the user's entire browser cache"],
  ["Storage.clearCookies", "it would log the user out of every site in their browser"],
  ["Network.deleteCookies", "it would delete the user's cookies and can log them out"],
  ["Storage.clearDataForOrigin", "it would erase a site's cookies and stored data in the user's browser"],
  ["Storage.clearDataForStorageKey", "it would erase a site's stored data in the user's browser"],
  ["Browser.close", "it would close the user's browser"],
])

const readOnlyBlockedPrefixes = ["Input."] as const

export type GuardContext = {
  readonly method: string
  readonly readOnly: boolean
  readonly sessionId?: string | undefined
  readonly params?: Record<string, unknown> | undefined
  /** URLs of the pages the client can see; cookie access is limited to their hosts. */
  readonly pageUrls?: () => readonly string[]
}

export const allowAllCookiesEnvironmentVariable = "OPENCODE_BROWSER_ALLOW_ALL_COOKIES"
const allowsAllCookies = (): boolean => process.env[allowAllCookiesEnvironmentVariable] === "1"
const allowsForeground = (): boolean => process.env.OPENCODE_BROWSER_ALLOW_FOREGROUND === "1"

const cookieReadMethods = new Set(["Storage.getCookies", "Network.getAllCookies", "Network.getCookies"])

function pageHosts(urls: readonly string[]): string[] {
  const hosts: string[] = []
  for (const url of urls) {
    try {
      const parsed = new URL(url)
      if ((parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.hostname) hosts.push(parsed.hostname.toLowerCase())
    } catch {
      // Ignore unparsable target URLs.
    }
  }
  return hosts
}

/** True when a cookie for `cookieDomain` is sent to `host` (domain cookies match subdomains). */
function cookieAppliesToHost(cookieDomain: string, host: string): boolean {
  const domain = cookieDomain.toLowerCase().replace(/^\./, "")
  return domain.length > 0 && (host === domain || host.endsWith(`.${domain}`))
}

function cookieDomainOf(cookie: unknown): string | undefined {
  if (cookie === null || typeof cookie !== "object") return undefined
  const { domain, url } = cookie as { readonly domain?: unknown; readonly url?: unknown }
  if (typeof url === "string") {
    try {
      return new URL(url).hostname
    } catch {
      return undefined
    }
  }
  return typeof domain === "string" ? domain : undefined
}

function guardCookieWrite(context: GuardContext): string | null {
  const cookies = context.method === "Network.setCookie"
    ? [context.params]
    : Array.isArray(context.params?.cookies) ? context.params.cookies as unknown[] : []
  const hosts = pageHosts(context.pageUrls?.() ?? [])
  for (const cookie of cookies) {
    const domain = cookieDomainOf(cookie)
    if (!domain || !hosts.some((host) => cookieAppliesToHost(domain, host))) {
      return `OpenCode Browser blocked ${context.method}: cookies can only be set for the hosts of this session's attached pages (${hosts.length > 0 ? hosts.join(", ") : "none"}), not ${domain ?? "a cookie without a domain or url"}. Set ${allowAllCookiesEnvironmentVariable}=1 on the relay to allow it.`
    }
  }
  return null
}

/**
 * Returns a human-readable rejection message when the method must be blocked,
 * or null when the command may be forwarded to the browser.
 */
export function guardCdpMethod(context: GuardContext): string | null {
  const reason = alwaysBlocked.get(context.method)
  if (reason) {
    return `OpenCode Browser blocked ${context.method}: ${reason}. This command is always blocked by the relay.`
  }
  if (context.method === "Page.bringToFront" && !allowsForeground()) {
    return "OpenCode Browser blocked Page.bringToFront: it raises the user's browser window over their work. Use handoff() when the user needs to act in the tab, or set OPENCODE_BROWSER_ALLOW_FOREGROUND=1 on the relay to allow it."
  }
  if ((context.method === "Storage.setCookies" || context.method === "Network.setCookies" || context.method === "Network.setCookie") && !allowsAllCookies()) {
    const rejection = guardCookieWrite(context)
    if (rejection) return rejection
  }
  if (context.readOnly && readOnlyBlockedPrefixes.some((prefix) => context.method.startsWith(prefix))) {
    const session = context.sessionId ? `Session ${context.sessionId}` : "This session"
    return `${session} is read-only: ${context.method} is blocked. Use a session created without --read-only to interact with pages.`
  }
  return null
}

/**
 * Narrow a forwarded command's result to what the client may see: cookie
 * reads keep only cookies that apply to the hosts of the client's pages.
 */
export function scopeCdpResult<Result>(options: {
  readonly method: string
  readonly result: Result
  readonly pageUrls: () => readonly string[]
}): Result {
  if (!cookieReadMethods.has(options.method) || allowsAllCookies()) return options.result
  const result = options.result
  if (result === null || typeof result !== "object" || !Array.isArray((result as { cookies?: unknown }).cookies)) return result
  const hosts = pageHosts(options.pageUrls())
  const cookies = ((result as unknown as { cookies: unknown[] }).cookies).filter((cookie) => {
    const domain = cookieDomainOf(cookie)
    return domain !== undefined && hosts.some((host) => cookieAppliesToHost(domain, host))
  })
  return { ...result, cookies } as Result
}
