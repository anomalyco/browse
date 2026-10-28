import { describe, expect, test } from "bun:test"
import { checkNavigationUrl, checkUrl, explicitlyAllowsHost, isPrivateAddress, normalizeOriginPatterns, OriginPatternError, parseOriginPatterns } from "../src/domain-policy.ts"

const rules = (...patterns: string[]) => parseOriginPatterns(patterns)

describe("origin patterns", () => {
  test("bare hosts, wildcards, origins and ports", () => {
    const allow = rules("example.com", "*.shop.test", "https://secure.test", "dev.test:8080")
    expect(checkUrl("https://example.com/a", allow).allowed).toBe(true)
    expect(checkUrl("http://example.com:81/", allow).allowed).toBe(true)
    expect(checkUrl("https://www.example.com/", allow).allowed).toBe(false)
    expect(checkUrl("https://shop.test/", allow).allowed).toBe(true)
    expect(checkUrl("https://a.b.shop.test/", allow).allowed).toBe(true)
    expect(checkUrl("https://evilshop.test/", allow).allowed).toBe(false)
    expect(checkUrl("https://secure.test/", allow).allowed).toBe(true)
    expect(checkUrl("http://secure.test/", allow).allowed).toBe(false)
    expect(checkUrl("https://secure.test:444/", allow).allowed).toBe(false)
    expect(checkUrl("http://dev.test:8080/", allow).allowed).toBe(true)
    expect(checkUrl("http://dev.test:8081/", allow).allowed).toBe(false)
  })

  test("about:, data: and blob: documents load nothing remote", () => {
    const allow = rules("example.com")
    expect(checkUrl("about:blank", allow).allowed).toBe(true)
    expect(checkUrl("data:text/html,hi", allow).allowed).toBe(true)
    expect(checkUrl("ftp://example.com/", allow).allowed).toBe(false)
  })

  test("refuses patterns that allow everything or carry paths", () => {
    expect(() => parseOriginPatterns(["*"])).toThrow(OriginPatternError)
    expect(() => parseOriginPatterns(["example.com/path"])).toThrow(OriginPatternError)
    expect(() => parseOriginPatterns(["ftp://example.com"])).toThrow(OriginPatternError)
    expect(() => parseOriginPatterns(["*.com.*"])).toThrow(OriginPatternError)
    expect(() => parseOriginPatterns(["*.10.0.0.1"])).toThrow(OriginPatternError)
    expect(normalizeOriginPatterns(["Example.com, *.Shop.test", "example.com"])).toEqual(["example.com", "*.shop.test"])
  })
})

describe("private addresses", () => {
  test("ranges", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "::ffff:7f00:1"]) {
      expect(isPrivateAddress(ip)).toBe(true)
    }
    for (const ip of ["8.8.8.8", "172.32.0.1", "1.1.1.1", "2606:4700::1111"]) {
      expect(isPrivateAddress(ip)).toBe(false)
    }
  })

  test("wildcards never reach private hosts; naming the exact host does", () => {
    expect(checkUrl("http://web.app.localhost:3000/", rules("*.app.localhost")).allowed).toBe(false)
    expect(checkUrl("http://localhost:3000/", rules("localhost")).allowed).toBe(true)
    expect(checkUrl("http://localhost:3000/", rules("http://localhost:3000")).allowed).toBe(true)
    expect(checkUrl("http://127.0.0.1/", rules("127.0.0.1")).allowed).toBe(true)
    expect(explicitlyAllowsHost(rules("127.0.0.1"), "http://127.0.0.1:9/")).toBe(true)
    expect(explicitlyAllowsHost(rules("*.example.com"), "http://a.example.com/")).toBe(false)
  })

  test("decimal, hex and octal IPv4 spellings normalize before the check", async () => {
    const allow = rules("example.com")
    for (const url of ["http://2130706433/", "http://0x7f000001/", "http://0177.0.0.1/", "http://[::ffff:127.0.0.1]/"]) {
      const decision = checkUrl(url, allow)
      expect(decision.allowed).toBe(false)
    }
    expect((await checkNavigationUrl("http://2130706433/", rules("127.0.0.1"))).allowed).toBe(true)
  })

  test("a name that resolves to a private address needs an exact pattern", async () => {
    const decision = await checkNavigationUrl("http://localhost.:1/", rules("*.example.com"))
    expect(decision.allowed).toBe(false)
  })
})
