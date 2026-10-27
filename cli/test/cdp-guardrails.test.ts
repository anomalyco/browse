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
