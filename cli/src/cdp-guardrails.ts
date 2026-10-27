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
 * Site storage is scoped the same way: IndexedDB, Cache Storage, DOM storage,
 * shared storage, interest groups and the other Storage/ServiceWorker methods
 * that name an origin or storage key are handled in the browser process for
 * any origin, so they are refused unless that origin is one of the session's
 * page hosts (OPENCODE_BROWSER_ALLOW_ALL_STORAGE=1 lifts it). Methods that
 * observe or read every origin's state at once are refused outright.
 *
 * Navigations to browser-internal and local documents (file:, chrome:,
 * chrome-extension:, devtools:, view-source:, ...) are refused for
 * Page.navigate and Target.createTarget; OPENCODE_BROWSER_ALLOW_FILE_URLS=1
 * allows file: only. (Page script can't reach them either: Chromium refuses
 * renderer-initiated navigations from web pages to those schemes.)
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

export const allowAllStorageEnvironmentVariable = "OPENCODE_BROWSER_ALLOW_ALL_STORAGE"
const allowsAllStorage = (): boolean => process.env[allowAllStorageEnvironmentVariable] === "1"
export const allowFileUrlsEnvironmentVariable = "OPENCODE_BROWSER_ALLOW_FILE_URLS"
const allowsFileUrls = (): boolean => process.env[allowFileUrlsEnvironmentVariable] === "1"

/** Domains whose methods address site storage by origin or storage key. */
const storageDomains = ["IndexedDB.", "CacheStorage.", "DOMStorage.", "Storage.", "ServiceWorker."] as const
/** Storage methods that name no origin and touch only the attached page (or nothing site-specific). */
const storageMethodsWithoutOrigin = new Set([
  "IndexedDB.enable", "IndexedDB.disable",
  "CacheStorage.enable", "CacheStorage.disable",
  "DOMStorage.enable", "DOMStorage.disable",
  "ServiceWorker.enable", "ServiceWorker.disable", "ServiceWorker.setForceUpdateOnPageLoad",
  "Storage.getStorageKeyForFrame", "Storage.getStorageKey", "Storage.getRelatedWebsiteSets",
  "Storage.getAffectedUrlsForThirdPartyCookieMetadata",
])
/** Methods that read, observe or reset every origin's state at once. */
const storageMethodsForAllOrigins = new Map<string, string>([
  ["Storage.getTrustTokens", "it reads the private state tokens of every site"],
  ["Storage.setInterestGroupTracking", "it reports every site's interest groups"],
  ["Storage.setInterestGroupAuctionTracking", "it reports every site's ad auctions"],
  ["Storage.setSharedStorageTracking", "it reports every site's shared storage"],
  ["Storage.runBounceTrackingMitigations", "it deletes state of sites in the user's browser"],
  ["Storage.setProtectedAudienceKAnonymity", "it changes ad state of every site"],
  ["ServiceWorker.stopAllWorkers", "it stops every site's service workers"],
])
/** Parameter names that carry an origin, a storage key (serialized "https://host/^0..."), or a URL in one. */
const originParamNames = ["securityOrigin", "storageKey", "origin", "ownerOrigin", "issuerOrigin", "scopeURL", "topLevelSite"] as const

/** The host a serialized origin, storage key or URL belongs to; undefined when it can't be read. */
function storageHost(value: string): string | undefined {
  // A storage key's first part is its origin; partitioned keys append "^0<top-level site>" and similar.
  const origin = value.split("^")[0] ?? ""
  try {
    const parsed = new URL(origin)
    return parsed.hostname ? parsed.hostname.toLowerCase() : undefined
  } catch {
    return undefined
  }
}

/** Every origin-like value a storage command addresses. */
function storageOrigins(params: Record<string, unknown> | undefined): string[] {
  if (!params) return []
  const values: string[] = []
  const collect = (object: unknown) => {
    if (object === null || typeof object !== "object") return
    for (const name of originParamNames) {
      const value = (object as Record<string, unknown>)[name]
      if (typeof value === "string" && value) values.push(value)
    }
  }
  collect(params)
  // DOMStorage.* storageId, IndexedDB/CacheStorage storageBucket, Storage.deleteStorageBucket bucket.
  collect(params.storageId)
  collect(params.storageBucket)
  collect(params.bucket)
  // Cache ids are "<storage key>|<cache name>".
  if (typeof params.cacheId === "string") values.push(params.cacheId.split("|")[0] ?? "")
  return values
}

function guardStorageAccess(context: GuardContext): string | null {
  if (!storageDomains.some((domain) => context.method.startsWith(domain))) return null
  if (allowsAllStorage()) return null
  const everyOrigin = storageMethodsForAllOrigins.get(context.method)
  if (everyOrigin) {
    return `OpenCode Browser blocked ${context.method}: ${everyOrigin}. Set ${allowAllStorageEnvironmentVariable}=1 on the relay to allow it.`
  }
  if (storageMethodsWithoutOrigin.has(context.method)) return null
  const hosts = pageHosts(context.pageUrls?.() ?? [])
  const origins = storageOrigins(context.params)
  const outside = origins.length === 0
    ? "a request that names no origin or storage key"
    : origins.find((origin) => {
        const host = storageHost(origin)
        return host === undefined || !hosts.includes(host)
      })
  if (outside === undefined) return null
  return `OpenCode Browser blocked ${context.method}: site storage can only be used for the hosts of this session's attached pages (${hosts.length > 0 ? hosts.join(", ") : "none"}), not ${outside}. Set ${allowAllStorageEnvironmentVariable}=1 on the relay to allow it.`
}

/** Schemes agents can't open: browser-internal pages, other extensions, DevTools, and local files. */
const restrictedNavigationSchemes = new Set([
  "file:", "chrome:", "chrome-extension:", "chrome-untrusted:", "chrome-search:", "devtools:", "view-source:",
  "edge:", "brave:", "opera:", "vivaldi:", "filesystem:",
])

function guardNavigation(context: GuardContext): string | null {
  if (context.method !== "Page.navigate" && context.method !== "Target.createTarget") return null
  const url = context.params?.url
  if (typeof url !== "string") return null
  let scheme: string
  try {
    // WHATWG parsing strips the whitespace and control characters a browser would ignore too.
    scheme = new URL(url).protocol.toLowerCase()
  } catch {
    return null
  }
  if (!restrictedNavigationSchemes.has(scheme)) return null
  if (scheme === "file:" && allowsFileUrls()) return null
  const hint = scheme === "file:"
    ? ` Set ${allowFileUrlsEnvironmentVariable}=1 on the relay to allow file: URLs.`
    : ""
  return `OpenCode Browser blocked ${context.method} to a ${scheme} URL: agents can't open browser-internal pages, other extensions, DevTools or local files.${hint}`
}

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
  if (!cookieReadMethods.has(context.method) && context.method !== "Storage.setCookies") {
    const rejection = guardStorageAccess(context)
    if (rejection) return rejection
  }
  const navigation = guardNavigation(context)
  if (navigation) return navigation
  if (context.method === "Network.loadNetworkResource" && !allowsAllStorage()) {
    // DevTools' resource loader fetches from the browser process with the user's credentials and no same-origin policy.
    const url = context.params?.url
    const hosts = pageHosts(context.pageUrls?.() ?? [])
    const host = typeof url === "string" ? pageHosts([url])[0] : undefined
    if (host === undefined || !hosts.includes(host)) {
      return `OpenCode Browser blocked Network.loadNetworkResource: it loads URLs with the user's credentials outside the page's same-origin policy, so only the hosts of this session's attached pages (${hosts.length > 0 ? hosts.join(", ") : "none"}) are allowed. Set ${allowAllStorageEnvironmentVariable}=1 on the relay to allow it.`
    }
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
