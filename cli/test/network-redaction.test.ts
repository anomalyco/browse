import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { finishCapture } from "../src/network-capture/har-redaction.ts"
import { looksLikeTokenSegment, SecretRedactor } from "../src/network-capture/redaction.ts"
import type { ActiveCapture, CapturedEntry } from "../src/network-capture/types.ts"

// The HAR export protects each entry structurally (names that look secret), then replaces known values wherever
// else they appear in URLs and headers (network-capture.ts redactEntryKnownValues, minimum length 8).
const knownValueMinimum = 8
const redacted = "[redacted]"

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
    liveRedactor: new SecretRedactor(),
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

describe("SecretRedactor", () => {
  test("replaces a token in a query string and leaves the rest of the URL alone", () => {
    const redactor = new SecretRedactor()
    const url = redactor.protectUrl("https://api.example.com/v1/items?access_token=tok_live_ABCDEF1234567890&page=2")
    expect(url).not.toContain("tok_live_ABCDEF1234567890")
    expect(url).toContain(`access_token=${redacted}`)
    expect(url).toContain("page=2")
  })

  test("keeps the scheme of an Authorization header and hides its credential", () => {
    const redactor = new SecretRedactor()
    const [authorization, accept] = redactor.protectHeaders([
      { name: "Authorization", value: "Bearer sk_test_SECRETVALUE1234567890" },
      { name: "Accept", value: "application/json" },
    ])
    expect(authorization).toEqual({ name: "Authorization", value: `Bearer ${redacted}` })
    expect(accept).toEqual({ name: "Accept", value: "application/json" })
  })

  test("redacts each cookie value but keeps cookie names and attributes", () => {
    const redactor = new SecretRedactor()
    const [cookie] = redactor.protectHeaders([{ name: "Set-Cookie", value: "sid=abcdef123456; Path=/; HttpOnly" }])
    expect(cookie?.value).toBe(`sid=${redacted}; Path=/; HttpOnly`)
  })

  test("never redacts hosts, CORS header values or cookie attributes", () => {
    const redactor = new SecretRedactor()
    const [authority, authorization, xAuthToken] = redactor.protectHeaders([
      { name: ":authority", value: "jsonplaceholder.typicode.com" },
      { name: "authorization", value: "Bearer ctl-bearer-value-0001" },
      { name: "x-auth-token", value: "ctl-xauth-value-0002" },
    ])
    expect(authority?.value).toBe("jsonplaceholder.typicode.com")
    expect(authorization?.value).toBe(`Bearer ${redacted}`)
    expect(xAuthToken?.value).toBe(redacted)
    const [cors, setCookie] = redactor.protectHeaders([
      { name: "access-control-allow-credentials", value: "true" },
      { name: "set-cookie", value: "probe=secretvalue123; Max-Age=0; Priority=High; Partitioned; Secure; HttpOnly" },
    ])
    expect(cors?.value).toBe("true")
    expect(setCookie?.value).toBe(`probe=${redacted}; Max-Age=0; Priority=High; Partitioned; Secure; HttpOnly`)
    const executeOutput = '{"host":"jsonplaceholder.typicode.com","completed":true,"note":"untrue: High tide"}'
    expect(redactor.redactText(executeOutput)).toBe(executeOutput)
    expect(redactor.redactKnownSubstrings("https://jsonplaceholder.typicode.com/posts/1", knownValueMinimum))
      .toBe("https://jsonplaceholder.typicode.com/posts/1")
    expect(redactor.redactText("ctl-bearer-value-0001 ctl-xauth-value-0002 secretvalue123"))
      .toBe(`${redacted} ${redacted} ${redacted}`)
  })

  test("does not replace short captured values inside unrelated execute output", () => {
    const redactor = new SecretRedactor()
    const url = redactor.protectUrl("https://api.example.com/v1/orders?session=42&page=2")
    expect(url).toBe(`https://api.example.com/v1/orders?session=${redacted}&page=2`)

    // "42" is a captured credential, but it is too short to replace inside ordinary text.
    expect(redactor.redactText("order 1423 at 4:42")).toBe("order 1423 at 4:42")
    expect(redactor.redactValue("order 1423 at 4:42")).toBe("order 1423 at 4:42")
    expect(redactor.redactValue({ echoed: "42", text: "order 1423 at 4:42" })).toEqual({
      echoed: redacted,
      text: "order 1423 at 4:42",
    })

    // A whole value that is exactly the captured credential is still redacted.
    expect(redactor.redactText("42")).toBe(redacted)
    expect(redactor.redactValue("42")).toBe(redacted)
  })

  test("keeps replacing short one-time request values inside unrelated execute output", () => {
    const redactor = new SecretRedactor()
    const form = redactor.protectBody("username=bob&password=hunter1", "application/x-www-form-urlencoded")
    expect(form).toBe(`username=bob&password=${redacted}`)
    const json = redactor.protectBody(JSON.stringify({ otp: "123456" }), "application/json")
    expect(JSON.parse(json ?? "{}")).toEqual({ otp: redacted })

    // Passwords and one-time codes are replaced at any length.
    expect(redactor.redactText("username=bob&password=hunter1")).toBe(`username=bob&password=${redacted}`)
    expect(redactor.redactText("code 123456 ok")).toBe(`code ${redacted} ok`)
    expect(redactor.redactText("username=bob&password=hunter1")).not.toContain("hunter1")
    expect(redactor.redactText("code 123456 ok")).not.toContain("123456")
  })

  test("keeps replacing long captured values inside unrelated execute output", () => {
    const redactor = new SecretRedactor()
    redactor.protectUrl("https://api.example.com/v1/orders?session=42&access_token=tok_live_ABCDEF1234567890")
    expect(redactor.redactText("order 1423 at 4:42 token tok_live_ABCDEF1234567890 end"))
      .toBe(`order 1423 at 4:42 token ${redacted} end`)
  })

  test("keeps custom access-control headers and cookie values secret", () => {
    const redactor = new SecretRedactor()
    const [custom] = redactor.protectHeaders([{ name: "access-control-token", value: "ctl-acctoken-value-0003" }])
    expect(custom?.value).toBe(redacted)
    const [requestCookie] = redactor.protectHeaders([{ name: "Cookie", value: "priority=ctlcookie01; secure=ctlcookie02" }])
    expect(requestCookie?.value).toBe(`priority=${redacted}; secure=${redacted}`)
    const [setCookie] = redactor.protectHeaders([{ name: "Set-Cookie", value: "secure=ctlcookie03; Path=/" }])
    expect(setCookie?.value).toBe(`secure=${redacted}; Path=/`)
    const [attributes] = redactor.protectHeaders(
      [{ name: "Set-Cookie", value: "sid=ctlcookie04; Secure=true; HttpOnly=true; Partitioned=true" }],
    )
    expect(attributes?.value).toBe(`sid=${redacted}; Secure=true; HttpOnly=true; Partitioned=true`)
  })

  test("keeps booleans in redacted values", () => {
    const redactor = new SecretRedactor()
    redactor.protectHeaders([{ name: "authorization", value: "Bearer ctl-bearer-value-0001" }])
    redactor.protectHeaders([{ name: "access-control-allow-credentials", value: "true" }])
    expect(redactor.redactValue({ flag: true, token: "ctl-bearer-value-0001" })).toEqual({ flag: true, token: redacted })
  })

  test("protects every newline-joined set-cookie line", () => {
    const redactor = new SecretRedactor()
    const [cookies] = redactor.protectHeaders(
      [{ name: "Set-Cookie", value: "a=ctlcookie05; Priority=High\nb=ctlcookie06; Path=/" }],
    )
    expect(cookies?.value).toBe(`a=${redacted}; Priority=High\nb=${redacted}; Path=/`)
  })

  test("protects :path query values under the request URL", async () => {
    const directory = await mkdtemp(join(tmpdir(), "browse-har-path-"))
    const outputPath = join(directory, "capture.har")
    try {
      const short = capturedEntry("short", {})
      const encoded = capturedEntry("encoded", {})
      await Effect.runPromise(finishCapture(
        activeCapture([
          {
            ...short,
            request: {
              ...short.request,
              url: "https://docs.example.com/callback?code=492817&x=1",
              headers: [{ name: ":path", value: "/callback?code=492817&x=1" }, { name: ":authority", value: "docs.example.com" }],
            },
          },
          {
            ...encoded,
            request: {
              ...encoded.request,
              url: "https://docs.example.com/callback?code=4%2f0ax4xfwi6abcdef789",
              headers: [{ name: ":path", value: "/callback?code=4%2f0ax4xfwi6abcdef789" }, { name: ":authority", value: "docs.example.com" }],
            },
          },
        ]),
        { outputPath },
      ))
      const har = JSON.parse(await readFile(outputPath, "utf8")) as {
        log: { entries: Array<{ request: { url: string; headers: Array<{ name: string; value: string }> } }> }
      }
      const [shortEntry, encodedEntry] = har.log.entries
      expect(shortEntry?.request.url).toBe(`https://docs.example.com/callback?code=${redacted}&x=1`)
      expect(shortEntry?.request.headers).toContainEqual({ name: ":path", value: `/callback?code=${redacted}&x=1` })
      expect(shortEntry?.request.headers).toContainEqual({ name: ":authority", value: "docs.example.com" })
      expect(encodedEntry?.request.url).toBe(`https://docs.example.com/callback?code=${redacted}`)
      expect(encodedEntry?.request.headers).toContainEqual({ name: ":path", value: `/callback?code=${redacted}` })
      expect(encodedEntry?.request.headers).toContainEqual({ name: ":authority", value: "docs.example.com" })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("finds a known secret again under a header or URL that does not look secret", () => {
    const redactor = new SecretRedactor()
    redactor.protectHeaders([{ name: "Authorization", value: "Bearer sk_test_SECRETVALUE1234567890" }])
    const header = redactor.redactKnownSubstrings("debug sk_test_SECRETVALUE1234567890 end", knownValueMinimum)
    const url = redactor.redactKnownSubstrings("https://example.com/cb?state=sk_test_SECRETVALUE1234567890", knownValueMinimum)
    expect(header).toBe(`debug ${redacted} end`)
    expect(url).toBe(`https://example.com/cb?state=${redacted}`)
  })

  test("finds a percent-encoded known secret", () => {
    const redactor = new SecretRedactor()
    redactor.protectUrl("https://example.com/?token=a%2Fb%2Bc1234567890")
    expect(redactor.redactKnownSubstrings("next=a%2Fb%2Bc1234567890", knownValueMinimum)).toBe(`next=${redacted}`)
  })

  test("hides token-like path segments", () => {
    const redactor = new SecretRedactor()
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"
    const url = redactor.protectUrl(`https://example.com/reset/${jwt}/confirm`)
    expect(url).toBe(`https://example.com/reset/${redacted}/confirm`)
    expect(redactor.redactText(`see ${jwt}`)).toBe(`see ${redacted}`)
  })

  test("leaves ordinary path segments alone", () => {
    expect(looksLikeTokenSegment("how-to-install-the-extension")).toBe(false)
    expect(looksLikeTokenSegment("123e4567-e89b-12d3-a456-426614174000")).toBe(false)
    expect(looksLikeTokenSegment("0123456789abcdef0123456789abcdef")).toBe(true)
  })

  test("redacts typed passwords and one-time codes", () => {
    const redactor = new SecretRedactor()
    const form = redactor.protectBody("username=ada&password=correct-horse-battery&otp=492817", "application/x-www-form-urlencoded")
    expect(form).toBe(`username=ada&password=${redacted}&otp=${redacted}`)
    const json = redactor.protectBody(JSON.stringify({ user: "ada", passcode: "9988-7766" }), "application/json")
    expect(JSON.parse(json ?? "{}")).toEqual({ user: "ada", passcode: redacted })
    // The values are still redacted wherever they appear later, whatever their length.
    expect(redactor.redactKnownSubstrings("echo correct-horse-battery", knownValueMinimum)).toBe(`echo ${redacted}`)
  })

  test("redacts reusable credentials from a JSON body", () => {
    const redactor = new SecretRedactor()
    const body = redactor.protectBody(JSON.stringify({ data: { access_token: "at_1234567890abcdef", name: "ada" } }), "application/json")
    expect(JSON.parse(body ?? "{}")).toEqual({ data: { access_token: redacted, name: "ada" } })
    expect(redactor.redactKnownSubstrings("token at_1234567890abcdef", knownValueMinimum)).toBe(`token ${redacted}`)
  })

  test("keeps documentation code listings and inline code in a response", () => {
    const redactor = new SecretRedactor()
    const listing = { type: "codeListing", syntax: "swift", code: ["struct MyView: View {", "    var body: some View {", "}", "", "UInt8"] }
    const inline = { inlineContent: [{ type: "codeVoice", code: "some View" }, { type: "codeVoice", code: "UInt8" }] }
    expect(JSON.parse(redactor.protectBody(JSON.stringify(listing), "application/json") ?? "{}")).toEqual(listing)
    expect(JSON.parse(redactor.protectBody(JSON.stringify(inline), "application/json") ?? "{}")).toEqual(inline)
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
      const body = new SecretRedactor().protectBody(JSON.stringify({ code: value }), "application/json") ?? "{}"
      expect(JSON.parse(body)).toEqual({ code: redacted })
    }
    expect(JSON.parse(new SecretRedactor().protectBody(JSON.stringify({ code: ["WDJB MJHT", "dG9rZW4x=="] }), "application/json") ?? "{}"))
      .toEqual({ code: [redacted, redacted] })
    expect(JSON.parse(new SecretRedactor().protectBody(JSON.stringify({ Code: "dG9rZW5fMTIzNDU2Nzg=" }), "application/json") ?? "{}"))
      .toEqual({ Code: redacted })
    expect(JSON.parse(new SecretRedactor().protectBody(JSON.stringify({ code: 492817 }), "application/json") ?? "{}"))
      .toEqual({ code: redacted })
    expect(JSON.parse(new SecretRedactor().protectBody(
      JSON.stringify({ user_code: "WDJB-MJHT", device_code: "GmRhmhcxhwAzkoEqiMEg_DnyEysNkuNhszIySk9eS" }),
      "application/json",
    ) ?? "{}")).toEqual({ user_code: redacted, device_code: redacted })
    // Objects and arrays under a bare `code` stay secret for every descendant.
    expect(JSON.parse(new SecretRedactor().protectBody(JSON.stringify({ code: { value: "a7k2m9" } }), "application/json") ?? "{}"))
      .toEqual({ code: { value: redacted } })
    expect(JSON.parse(new SecretRedactor().protectBody(JSON.stringify({ code: [{ value: "a7k2m9" }] }), "application/json") ?? "{}"))
      .toEqual({ code: [{ value: redacted }] })

    // DocC context requires the exact lowercase key and the matching value shape.
    expect(JSON.parse(new SecretRedactor().protectBody(JSON.stringify({ type: "codeVoice", CODE: "secret" }), "application/json") ?? "{}"))
      .toEqual({ type: "codeVoice", CODE: redacted })
    expect(JSON.parse(new SecretRedactor().protectBody(JSON.stringify({ type: "codeVoice", code: ["a7k2m9"] }), "application/json") ?? "{}"))
      .toEqual({ type: "codeVoice", code: [redacted] })
    expect(JSON.parse(new SecretRedactor().protectBody(JSON.stringify({ type: "codeListing", code: "a7k2m9" }), "application/json") ?? "{}"))
      .toEqual({ type: "codeListing", code: redacted })
    expect(JSON.parse(new SecretRedactor().protectBody(
      JSON.stringify({ type: "codeListing", code: ["ok line", { value: "a7k2m9" }] }),
      "application/json",
    ) ?? "{}")).toEqual({ type: "codeListing", code: ["ok line", { value: redacted }] })
    expect(JSON.parse(new SecretRedactor().protectBody(
      JSON.stringify({ type: "codeVoice", code: "x", token: "abc" }),
      "application/json",
    ) ?? "{}")).toEqual({ type: "codeVoice", code: "x", token: redacted })

    const request = new SecretRedactor()
    expect(JSON.parse(request.protectBody(JSON.stringify({ code: "K4B7X" }), "application/json") ?? "{}"))
      .toEqual({ code: redacted })
    expect(request.protectBody("grant_type=authorization_code&code=4%2F0AX4XfWi6abcDEF789", "application/x-www-form-urlencoded"))
      .toBe(`grant_type=authorization_code&code=${redacted}`)
    expect(request.protectUrl("https://auth.example.com/callback?code=4%2F0AX4XfWi6abcDEF789"))
      .toBe(`https://auth.example.com/callback?code=${redacted}`)
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
      expect(listingText).not.toContain(redacted)
      expect(JSON.parse(otpText || "{}")).toEqual({ code: redacted })

      const echoRequestText = echoEntry?.request.postData?.text ?? ""
      const echoResponseText = echoEntry?.response.content.text ?? ""
      expect(echoRequestText).toBe(echoResponseText)
      expect(echoRequestText).not.toContain("a7k2m9")
      expect(JSON.parse(echoRequestText || "{}")).toEqual({ code: redacted })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
