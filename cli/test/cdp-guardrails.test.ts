import { afterEach, describe, expect, test } from "bun:test"
import { guardCdpMethod, scopeCdpResult } from "../src/cdp-guardrails.ts"

const pageUrls = () => ["https://app.example.com/dashboard", "chrome://newtab/"]
const cookies = [
  { name: "a", domain: "app.example.com" },
  { name: "b", domain: ".example.com" },
  { name: "c", domain: "bank.test" },
  { name: "d", domain: ".other.example.com" },
]

afterEach(() => {
  delete process.env.OPENCODE_BROWSER_ALLOW_ALL_STORAGE
  delete process.env.OPENCODE_BROWSER_ALLOW_FILE_URLS
  delete process.env.OPENCODE_BROWSER_ALLOW_ALL_COOKIES
  delete process.env.OPENCODE_BROWSER_ALLOW_FOREGROUND
})

describe("guardCdpMethod", () => {
  test("always blocks methods that destroy browser data", () => {
    for (const method of ["Network.clearBrowserCookies", "Storage.clearCookies", "Network.deleteCookies", "Storage.clearDataForOrigin", "Storage.clearDataForStorageKey", "Browser.close"]) {
      expect(guardCdpMethod({ method, readOnly: false })).toContain(`blocked ${method}`)
    }
  })

  test("blocks Page.bringToFront unless the relay allows foreground", () => {
    expect(guardCdpMethod({ method: "Page.bringToFront", readOnly: false })).toContain("Page.bringToFront")
    process.env.OPENCODE_BROWSER_ALLOW_FOREGROUND = "1"
    expect(guardCdpMethod({ method: "Page.bringToFront", readOnly: false })).toBeNull()
  })

  test("lets ordinary and custom relay methods through", () => {
    expect(guardCdpMethod({ method: "Page.navigate", readOnly: false })).toBeNull()
    expect(guardCdpMethod({ method: "Runtime.evaluate", readOnly: false })).toBeNull()
    expect(guardCdpMethod({ method: "OpenCodeBrowser.ghostCursor", readOnly: false })).toBeNull()
  })

  test("read-only sessions cannot dispatch input", () => {
    expect(guardCdpMethod({ method: "Input.dispatchMouseEvent", readOnly: true, sessionId: "look" })).toContain("Session look is read-only")
    expect(guardCdpMethod({ method: "Input.dispatchMouseEvent", readOnly: false })).toBeNull()
    expect(guardCdpMethod({ method: "Page.captureScreenshot", readOnly: true })).toBeNull()
  })

  test("cookie writes are limited to the hosts of the session's pages", () => {
    const allowed = { method: "Network.setCookie", readOnly: false, pageUrls, params: { name: "x", value: "1", domain: ".example.com" } }
    expect(guardCdpMethod(allowed)).toBeNull()
    expect(guardCdpMethod({ ...allowed, params: { name: "x", value: "1", url: "https://app.example.com/" } })).toBeNull()
    expect(guardCdpMethod({ ...allowed, params: { name: "x", value: "1", domain: "bank.test" } })).toContain("bank.test")
    expect(guardCdpMethod({ ...allowed, params: { name: "x", value: "1" } })).toContain("without a domain")
    const batch = { method: "Storage.setCookies", readOnly: false, pageUrls, params: { cookies: [{ name: "x", domain: "app.example.com" }, { name: "y", domain: "evil.test" }] } }
    expect(guardCdpMethod(batch)).toContain("evil.test")
  })

  test("OPENCODE_BROWSER_ALLOW_ALL_COOKIES lifts the cookie write scope", () => {
    process.env.OPENCODE_BROWSER_ALLOW_ALL_COOKIES = "1"
    expect(guardCdpMethod({ method: "Network.setCookie", readOnly: false, pageUrls, params: { name: "x", domain: "bank.test" } })).toBeNull()
  })
})

describe("site storage scope", () => {
  const guard = (method: string, params?: Record<string, unknown>) => guardCdpMethod({ method, readOnly: false, pageUrls, ...(params ? { params } : {}) })

  test("storage of the session's page hosts is allowed", () => {
    expect(guard("IndexedDB.requestDatabaseNames", { securityOrigin: "https://app.example.com" })).toBeNull()
    expect(guard("IndexedDB.requestData", { storageKey: "https://app.example.com/", databaseName: "db", objectStoreName: "s", indexName: "", skipCount: 0, pageSize: 10 })).toBeNull()
    expect(guard("IndexedDB.getMetadata", { storageBucket: { storageKey: "https://app.example.com/", name: "default" }, databaseName: "db", objectStoreName: "s" })).toBeNull()
    expect(guard("CacheStorage.requestCacheNames", { storageKey: "https://app.example.com/" })).toBeNull()
    expect(guard("CacheStorage.requestEntries", { cacheId: "https://app.example.com/|v1", skipCount: 0, pageSize: 5 })).toBeNull()
    expect(guard("DOMStorage.getDOMStorageItems", { storageId: { securityOrigin: "https://app.example.com", isLocalStorage: true } })).toBeNull()
    expect(guard("Storage.getUsageAndQuota", { origin: "https://app.example.com" })).toBeNull()
    expect(guard("Storage.trackIndexedDBForStorageKey", { storageKey: "https://app.example.com/^0https://example.com" })).toBeNull()
    expect(guard("Storage.getStorageKeyForFrame", { frameId: "F" })).toBeNull()
    expect(guard("IndexedDB.enable")).toBeNull()
  })

  test("other origins' storage is refused", () => {
    expect(guard("IndexedDB.requestDatabaseNames", { securityOrigin: "https://bank.test" })).toContain("bank.test")
    // Exact hosts: storage is per origin, so a sibling or parent domain is another site's storage.
    expect(guard("IndexedDB.requestDatabaseNames", { securityOrigin: "https://example.com" })).toContain("blocked")
    expect(guard("IndexedDB.requestData", { storageKey: "https://bank.test/", databaseName: "db" })).toContain("blocked")
    expect(guard("IndexedDB.deleteDatabase", { storageBucket: { storageKey: "https://bank.test/", name: "default" }, databaseName: "db" })).toContain("blocked")
    expect(guard("CacheStorage.requestEntries", { cacheId: "https://bank.test/|v1" })).toContain("blocked")
    expect(guard("DOMStorage.getDOMStorageItems", { storageId: { storageKey: "https://bank.test/", isLocalStorage: true } })).toContain("blocked")
    expect(guard("Storage.getUsageAndQuota", { origin: "https://bank.test" })).toContain("blocked")
    expect(guard("Storage.trackCacheStorageForOrigin", { origin: "https://bank.test" })).toContain("blocked")
    expect(guard("Storage.getSharedStorageEntries", { ownerOrigin: "https://bank.test" })).toContain("blocked")
    expect(guard("Storage.getInterestGroupDetails", { ownerOrigin: "https://ads.test", name: "x" })).toContain("blocked")
    expect(guard("ServiceWorker.unregister", { scopeURL: "https://bank.test/" })).toContain("blocked")
    // A mixed request (the session's origin in one field, another in another) is refused too.
    expect(guard("IndexedDB.requestDatabaseNames", { securityOrigin: "https://app.example.com", storageKey: "https://bank.test/" })).toContain("blocked")
    // So is one that names no origin, and one that reads every origin.
    expect(guard("IndexedDB.requestDatabaseNames", {})).toContain("names no origin")
    expect(guard("Storage.getTrustTokens")).toContain("every site")
    expect(guard("Storage.setInterestGroupTracking", { enable: true })).toContain("blocked")
  })

  test("a session without web pages reaches no storage, unless the relay allows it", () => {
    expect(guardCdpMethod({ method: "IndexedDB.requestDatabaseNames", readOnly: false, pageUrls: () => ["about:blank"], params: { securityOrigin: "https://app.example.com" } })).toContain("none")
    process.env.OPENCODE_BROWSER_ALLOW_ALL_STORAGE = "1"
    expect(guard("IndexedDB.requestDatabaseNames", { securityOrigin: "https://bank.test" })).toBeNull()
    expect(guard("Storage.getTrustTokens")).toBeNull()
  })

  test("DevTools' resource loader reaches only the session's page hosts", () => {
    expect(guard("Network.loadNetworkResource", { frameId: "F", url: "https://app.example.com/app.js.map", options: {} })).toBeNull()
    expect(guard("Network.loadNetworkResource", { frameId: "F", url: "https://bank.test/api/me", options: {} })).toContain("blocked")
    expect(guard("Network.loadNetworkResource", { frameId: "F", url: "file:///etc/passwd", options: {} })).toContain("blocked")
  })

  test("cookie methods keep their own scope", () => {
    expect(guard("Storage.getCookies")).toBeNull()
    expect(guard("Storage.setCookies", { cookies: [{ name: "x", domain: "app.example.com" }] })).toBeNull()
  })
})

describe("navigation scope", () => {
  const navigate = (method: string, url: string) => guardCdpMethod({ method, readOnly: false, params: { url } })

  test("browser-internal pages, other extensions, DevTools and files are refused", () => {
    for (const url of [
      "file:///etc/passwd",
      "FILE:///Users/someone/.ssh/id_rsa",
      " file:///etc/hosts",
      "chrome://settings",
      "chrome-extension://aaaabbbbccccddddeeeeffffgggghhhh/popup.html",
      "chrome-untrusted://terminal/",
      "devtools://devtools/bundled/inspector.html",
      "view-source:https://example.com/",
      "edge://settings",
    ]) {
      expect(navigate("Page.navigate", url)).toContain("blocked Page.navigate")
      expect(navigate("Target.createTarget", url)).toContain("blocked Target.createTarget")
    }
  })

  test("web, data and about URLs are allowed", () => {
    for (const url of ["https://example.com/", "http://localhost:3000/", "data:text/html,<h1>hi</h1>", "about:blank", "blob:https://example.com/x"]) {
      expect(navigate("Page.navigate", url)).toBeNull()
      expect(navigate("Target.createTarget", url)).toBeNull()
    }
  })

  test("OPENCODE_BROWSER_ALLOW_FILE_URLS allows file: only", () => {
    process.env.OPENCODE_BROWSER_ALLOW_FILE_URLS = "1"
    expect(navigate("Page.navigate", "file:///tmp/report.html")).toBeNull()
    expect(navigate("Page.navigate", "chrome://settings")).toContain("blocked")
  })
})

describe("scopeCdpResult", () => {
  test("cookie reads return only cookies sent to the session's pages", () => {
    for (const method of ["Storage.getCookies", "Network.getAllCookies", "Network.getCookies"]) {
      const result = scopeCdpResult({ method, result: { cookies }, pageUrls })
      expect(result.cookies.map((cookie) => cookie.name)).toEqual(["a", "b"])
    }
  })

  test("a session without web pages sees no cookies", () => {
    expect(scopeCdpResult({ method: "Storage.getCookies", result: { cookies }, pageUrls: () => ["about:blank"] }).cookies).toEqual([])
  })

  test("other results and the escape hatch pass through", () => {
    const result = { cookies }
    expect(scopeCdpResult({ method: "Page.getFrameTree", result, pageUrls })).toBe(result)
    process.env.OPENCODE_BROWSER_ALLOW_ALL_COOKIES = "1"
    expect(scopeCdpResult({ method: "Storage.getCookies", result, pageUrls }).cookies).toHaveLength(4)
  })
})
