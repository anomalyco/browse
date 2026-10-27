import { describe, expect, test } from "bun:test"
import { looksLikeTokenSegment, SecretCollector } from "../src/network-redaction.ts"

// The HAR export protects each entry structurally (names that look secret), then replaces known values wherever
// else they appear in URLs and headers (network-capture.ts redactEntryKnownValues, minimum length 8).
const knownValueMinimum = 8

describe("SecretCollector", () => {
  test("replaces a token in a query string with a reusable reference", () => {
    const collector = new SecretCollector()
    const url = collector.protectUrl("https://api.example.com/v1/items?access_token=tok_live_ABCDEF1234567890&page=2")
    expect(url).not.toContain("tok_live_ABCDEF1234567890")
    expect(url).toContain("access_token=${BC_SECRET_1}")
    expect(url).toContain("page=2")
    expect(collector.slots()).toEqual([expect.objectContaining({ ref: "BC_SECRET_1", value: "tok_live_ABCDEF1234567890" })])
  })

  test("keeps the scheme of an Authorization header and hides its credential", () => {
    const collector = new SecretCollector()
    const [authorization, accept] = collector.protectHeaders(
      [
        { name: "Authorization", value: "Bearer sk_test_SECRETVALUE1234567890" },
        { name: "Accept", value: "application/json" },
      ],
      "request",
    )
    expect(authorization).toEqual({ name: "Authorization", value: "Bearer ${BC_SECRET_1}" })
    expect(accept).toEqual({ name: "Accept", value: "application/json" })
  })

  test("redacts each cookie value but keeps cookie names and attributes", () => {
    const collector = new SecretCollector()
    const [cookie] = collector.protectHeaders([{ name: "Set-Cookie", value: "sid=abcdef123456; Path=/; HttpOnly" }], "response")
    expect(cookie?.value).toBe("sid=${BC_SECRET_1}; Path=/; HttpOnly")
  })

  test("finds a known secret again under a header or URL that does not look secret", () => {
    const collector = new SecretCollector()
    collector.protectHeaders([{ name: "Authorization", value: "Bearer sk_test_SECRETVALUE1234567890" }], "request")
    const header = collector.redactKnownSubstrings("debug sk_test_SECRETVALUE1234567890 end", knownValueMinimum)
    const url = collector.redactKnownSubstrings("https://example.com/cb?state=sk_test_SECRETVALUE1234567890", knownValueMinimum)
    expect(header).toBe("debug ${BC_SECRET_1} end")
    expect(url).toBe("https://example.com/cb?state=${BC_SECRET_1}")
  })

  test("finds a percent-encoded known secret", () => {
    const collector = new SecretCollector()
    collector.protectUrl("https://example.com/?token=a%2Fb%2Bc1234567890")
    expect(collector.redactKnownSubstrings("next=a%2Fb%2Bc1234567890", knownValueMinimum)).toBe("next=${BC_SECRET_1}")
  })

  test("hides token-like path segments without storing them", () => {
    const collector = new SecretCollector()
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"
    const url = collector.protectUrl(`https://example.com/reset/${jwt}/confirm`)
    expect(url).toBe("https://example.com/reset/${BC_REDACTED_1}/confirm")
    expect(collector.slots()).toEqual([])
    expect(collector.redactText(`see ${jwt}`)).toBe("see ${BC_REDACTED_1}")
  })

  test("leaves ordinary path segments alone", () => {
    expect(looksLikeTokenSegment("how-to-install-the-extension")).toBe(false)
    expect(looksLikeTokenSegment("123e4567-e89b-12d3-a456-426614174000")).toBe(false)
    expect(looksLikeTokenSegment("0123456789abcdef0123456789abcdef")).toBe(true)
  })

  test("redacts typed passwords and one-time codes but never persists them", () => {
    const collector = new SecretCollector()
    const form = collector.protectBody("username=ada&password=correct-horse-battery&otp=492817", "application/x-www-form-urlencoded", "request")
    expect(form).toBe("username=ada&password=${BC_REDACTED_1}&otp=${BC_REDACTED_2}")
    const json = collector.protectBody(JSON.stringify({ user: "ada", passcode: "9988-7766" }), "application/json", "request")
    expect(JSON.parse(json ?? "{}")).toEqual({ user: "ada", passcode: "${BC_REDACTED_3}" })
    expect(collector.slots()).toEqual([])
    // The values are still redacted wherever they appear later.
    expect(collector.redactKnownSubstrings("echo correct-horse-battery", knownValueMinimum)).toBe("echo ${BC_REDACTED_1}")
  })

  test("stores reusable credentials from a JSON body under secret names", () => {
    const collector = new SecretCollector()
    const body = collector.protectBody(JSON.stringify({ data: { access_token: "at_1234567890abcdef", name: "ada" } }), "application/json", "response")
    expect(JSON.parse(body ?? "{}")).toEqual({ data: { access_token: "${BC_SECRET_1}", name: "ada" } })
    expect(collector.slots().map((slot) => slot.value)).toEqual(["at_1234567890abcdef"])
  })
})
