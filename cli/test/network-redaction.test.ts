import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { finishCapture } from "../src/network-capture/har-redaction.ts"
import { looksLikeTokenSegment, SecretCollector } from "../src/network-capture/redaction.ts"
import type { ActiveCapture, CapturedEntry } from "../src/network-capture/types.ts"

// The HAR export protects each entry structurally (names that look secret), then replaces known values wherever
// else they appear in URLs and headers (network-capture.ts redactEntryKnownValues, minimum length 8).
const knownValueMinimum = 8

function capturedEntry(id: string, responseBody: unknown, requestBody?: unknown): CapturedEntry {
  const text = JSON.stringify(responseBody)
  const requestText = requestBody === undefined ? undefined : JSON.stringify(requestBody)
  return {
    id,
    startedDateTime: "2026-01-01T00:00:00.000Z",
    durationMs: 1,
    request: {
      method: requestText === undefined ? "GET" : "POST",
      url: `https://docs.example.com/${id}`,
      headers: [
        { name: "accept", value: "application/json" },
        ...(requestText === undefined ? [] : [{ name: "content-type", value: "application/json" }]),
      ],
      resourceType: "xhr",
      ...(requestText === undefined ? {} : { body: { size: requestText.length, mimeType: "application/json", text: requestText, truncated: false } }),
    },
    response: {
      status: 200,
      statusText: "OK",
      headers: [{ name: "content-type", value: "application/json" }],
      body: { size: text.length, mimeType: "application/json", text, truncated: false },
    },
  }
}

function activeCapture(entries: readonly CapturedEntry[]): ActiveCapture {
  return {
    startedAt: "2026-01-01T00:00:00.000Z",
    options: { content: "embed", maxBodyBytes: 1_000_000, maxTotalBodyBytes: 25_000_000, maxEntries: 1_000 },
    pending: new Map(),
    entries: [...entries],
    finalizeQueue: [],
    finalizeWaiters: new Set(),
    liveCollector: new SecretCollector(),
    extraRedactions: new Set<string>(),
    finalizeWorkers: 0,
    finalizeGeneration: 0,
    capturedBodyBytes: 0,
    truncatedBodyCount: 0,
    droppedEntryCount: 0,
    stopping: false,
    cancelled: false,
    outputUnsafe: false,
  }
}

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

  test("keeps documentation code listings and inline code in a response", () => {
    const collector = new SecretCollector()
    const listing = { type: "codeListing", syntax: "swift", code: ["struct MyView: View {", "    var body: some View {", "}", "", "UInt8"] }
    const inline = { inlineContent: [{ type: "codeVoice", code: "some View" }, { type: "codeVoice", code: "UInt8" }] }
    expect(JSON.parse(collector.protectBody(JSON.stringify(listing), "application/json", "response") ?? "{}")).toEqual(listing)
    expect(JSON.parse(collector.protectBody(JSON.stringify(inline), "application/json", "response") ?? "{}")).toEqual(inline)
    expect(collector.slots()).toEqual([])
  })

  test("keeps redacting code values outside DocC context", () => {
    const opaque = [
      "a7k2m9",
      "Xk3pQ9",
      "WDJB-MJHT",
      "ABC-DEF",
      "aB3dE5fG9hJ2kL",
      "4%2F0AX4XfWi6abcDEF789ghi",
      "abcdefghijklmnopqrstuvwx",
      "123 456",
      "123-456",
      "abc123XYZ==",
      "user:pass",
      "key=value",
      "a,b",
      '"a7k2m9"',
      "Basic dXNlcjpwYXNz",
      "a7k2 m9",
      "a7k2m9\n",
      "Your code is 492817",
      "WDJB MJHT",
      "dG9rZW5fMTIzNDU2Nzg=",
      "v1:9f8e7d6c5b4a",
      '{"token":"sk_live_123"}',
      "correct horse battery",
      "x = 1",
    ]
    for (const value of opaque) {
      const body = new SecretCollector().protectBody(JSON.stringify({ code: value }), "application/json", "response") ?? "{}"
      expect(JSON.parse(body)).toEqual({ code: "${BC_REDACTED_1}" })
    }
    expect(JSON.parse(new SecretCollector().protectBody(JSON.stringify({ code: ["WDJB MJHT", "dG9rZW4x=="] }), "application/json", "response") ?? "{}"))
      .toEqual({ code: ["${BC_REDACTED_1}", "${BC_REDACTED_2}"] })
    expect(JSON.parse(new SecretCollector().protectBody(JSON.stringify({ Code: "dG9rZW5fMTIzNDU2Nzg=" }), "application/json", "response") ?? "{}"))
      .toEqual({ Code: "${BC_REDACTED_1}" })
    expect(JSON.parse(new SecretCollector().protectBody(JSON.stringify({ code: 492817 }), "application/json", "response") ?? "{}"))
      .toEqual({ code: "${BC_REDACTED_1}" })
    expect(JSON.parse(new SecretCollector().protectBody(
      JSON.stringify({ user_code: "WDJB-MJHT", device_code: "GmRhmhcxhwAzkoEqiMEg_DnyEysNkuNhszIySk9eS" }),
      "application/json",
      "response",
    ) ?? "{}")).toEqual({ user_code: "${BC_REDACTED_1}", device_code: "${BC_REDACTED_2}" })
    // Objects and arrays under a bare `code` stay secret for every descendant.
    expect(JSON.parse(new SecretCollector().protectBody(JSON.stringify({ code: { value: "a7k2m9" } }), "application/json", "response") ?? "{}"))
      .toEqual({ code: { value: "${BC_SECRET_1}" } })
    expect(JSON.parse(new SecretCollector().protectBody(JSON.stringify({ code: [{ value: "a7k2m9" }] }), "application/json", "response") ?? "{}"))
      .toEqual({ code: [{ value: "${BC_SECRET_1}" }] })

    // DocC context requires the exact lowercase key and the matching value shape.
    expect(JSON.parse(new SecretCollector().protectBody(JSON.stringify({ type: "codeVoice", CODE: "secret" }), "application/json", "response") ?? "{}"))
      .toEqual({ type: "codeVoice", CODE: "${BC_REDACTED_1}" })
    expect(JSON.parse(new SecretCollector().protectBody(JSON.stringify({ type: "codeVoice", code: ["a7k2m9"] }), "application/json", "response") ?? "{}"))
      .toEqual({ type: "codeVoice", code: ["${BC_REDACTED_1}"] })
    expect(JSON.parse(new SecretCollector().protectBody(JSON.stringify({ type: "codeListing", code: "a7k2m9" }), "application/json", "response") ?? "{}"))
      .toEqual({ type: "codeListing", code: "${BC_REDACTED_1}" })
    expect(JSON.parse(new SecretCollector().protectBody(
      JSON.stringify({ type: "codeListing", code: ["ok line", { value: "a7k2m9" }] }),
      "application/json",
      "response",
    ) ?? "{}")).toEqual({ type: "codeListing", code: ["ok line", { value: "${BC_SECRET_1}" }] })
    expect(JSON.parse(new SecretCollector().protectBody(
      JSON.stringify({ type: "codeVoice", code: "x", token: "abc" }),
      "application/json",
      "response",
    ) ?? "{}")).toEqual({ type: "codeVoice", code: "x", token: "${BC_SECRET_1}" })

    const request = new SecretCollector()
    expect(JSON.parse(request.protectBody(JSON.stringify({ code: "K4B7X" }), "application/json", "request") ?? "{}"))
      .toEqual({ code: "${BC_REDACTED_1}" })
    expect(request.protectBody("grant_type=authorization_code&code=4%2F0AX4XfWi6abcDEF789", "application/x-www-form-urlencoded", "request"))
      .toBe("grant_type=authorization_code&code=${BC_REDACTED_2}")
    expect(request.protectUrl("https://auth.example.com/callback?code=4%2F0AX4XfWi6abcDEF789"))
      .toBe("https://auth.example.com/callback?code=${BC_REDACTED_2}")
    expect(request.slots()).toEqual([])
  })

  test("keeps code listings through HAR output while redacting codes in requests and responses", async () => {
    const directory = await mkdtemp(join(tmpdir(), "browse-har-code-"))
    const outputPath = join(directory, "capture.har")
    try {
      const listing = { type: "codeListing", code: ["struct MyView: View {", "}"] }
      const otp = { code: "492817" }
      const echo = { code: "a7k2m9" }
      await Effect.runPromise(finishCapture(
        activeCapture([
          capturedEntry("listing", listing),
          capturedEntry("otp", otp),
          capturedEntry("echo", echo, echo),
        ]),
        { outputPath },
        undefined,
        {},
      ))
      const har = JSON.parse(await readFile(outputPath, "utf8")) as {
        log: { entries: Array<{
          request: { postData?: { text?: string } }
          response: { content: { text?: string } }
        }> }
      }
      const [listingEntry, otpEntry, echoEntry] = har.log.entries
      const listingText = listingEntry?.response.content.text ?? ""
      const otpText = otpEntry?.response.content.text ?? ""
      expect(JSON.parse(listingText || "{}")).toEqual(listing)
      expect(listingText).not.toContain("BC_REDACTED")
      expect(JSON.parse(otpText || "{}")).toEqual({ code: expect.stringMatching(/^\$\{BC_REDACTED_\d+\}$/) })

      const echoRequestText = echoEntry?.request.postData?.text ?? ""
      const echoResponseText = echoEntry?.response.content.text ?? ""
      expect(echoRequestText).toBe(echoResponseText)
      expect(echoRequestText).not.toContain("a7k2m9")
      expect(JSON.parse(echoRequestText || "{}")).toEqual({ code: expect.stringMatching(/^\$\{BC_REDACTED_\d+\}$/) })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
