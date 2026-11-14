import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
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

  test("never stores hosts, CORS header values or cookie attributes as secrets", () => {
    const collector = new SecretCollector()
    const [authority, authorization, xAuthToken] = collector.protectHeaders(
      [
        { name: ":authority", value: "jsonplaceholder.typicode.com" },
        { name: "authorization", value: "Bearer ctl-bearer-value-0001" },
        { name: "x-auth-token", value: "ctl-xauth-value-0002" },
      ],
      "request",
    )
    expect(authority?.value).toBe("jsonplaceholder.typicode.com")
    expect(authorization?.value).toBe("Bearer ${BC_SECRET_1}")
    expect(xAuthToken?.value).toBe("${BC_SECRET_2}")
    const [cors, setCookie] = collector.protectHeaders(
      [
        { name: "access-control-allow-credentials", value: "true" },
        { name: "set-cookie", value: "probe=secretvalue123; Max-Age=0; Priority=High; Partitioned; Secure; HttpOnly" },
      ],
      "response",
    )
    expect(cors?.value).toBe("true")
    expect(setCookie?.value).toBe("probe=${BC_SECRET_3}; Max-Age=0; Priority=High; Partitioned; Secure; HttpOnly")
    expect(collector.slots().map((slot) => slot.value)).toEqual(["ctl-bearer-value-0001", "ctl-xauth-value-0002", "secretvalue123"])
    const executeOutput = '{"host":"jsonplaceholder.typicode.com","completed":true,"note":"untrue: High tide"}'
    expect(collector.redactText(executeOutput)).toBe(executeOutput)
    expect(collector.redactKnownSubstrings("https://jsonplaceholder.typicode.com/posts/1", knownValueMinimum))
      .toBe("https://jsonplaceholder.typicode.com/posts/1")
    expect(collector.redactText("ctl-bearer-value-0001 ctl-xauth-value-0002 secretvalue123"))
      .toBe("${BC_SECRET_1} ${BC_SECRET_2} ${BC_SECRET_3}")
  })

  test("never classifies HTTP/2 pseudo-headers as credentials", () => {
    const collector = new SecretCollector()
    const headers = [
      { name: ":authority", value: "jsonplaceholder.typicode.com" },
      { name: ":method", value: "GET" },
      { name: ":scheme", value: "https" },
      { name: ":status", value: "200" },
      { name: ":protocol", value: "h2" },
    ]
    expect(collector.protectHeaders(headers, "request")).toEqual(headers)
    expect(collector.slots()).toEqual([])
    const output = '{"host":"jsonplaceholder.typicode.com","status":200}'
    expect(collector.redactText(output)).toBe(output)
  })

  test("redacts short captured values in place without storing them", () => {
    const collector = new SecretCollector()
    const url = collector.protectUrl("https://api.example.com/v1/orders?session=42&page=2")
    expect(url).toBe("https://api.example.com/v1/orders?session=${BC_REDACTED_1}&page=2")
    expect(collector.slots()).toEqual([])

    // "42" was redacted in place, but it is too short to become a reusable slot.
    expect(collector.redactText("order 1423 at 4:42")).toBe("order 1423 at 4:42")
    expect(collector.redactValue("order 1423 at 4:42")).toBe("order 1423 at 4:42")
    expect(collector.redactValue({ echoed: "42", text: "order 1423 at 4:42" })).toEqual({
      echoed: "${BC_REDACTED_1}",
      text: "order 1423 at 4:42",
    })

    // A whole value that is exactly the captured credential is still redacted.
    expect(collector.redactText("42")).toBe("${BC_REDACTED_1}")
    expect(collector.redactValue("42")).toBe("${BC_REDACTED_1}")
  })

  test("does not store short cookie values as secret slots", () => {
    const collector = new SecretCollector()
    const [cookie] = collector.protectHeaders(
      [{ name: "Cookie", value: "a=B; b=1; sid=abcdef123456" }],
      "request",
    )
    expect(cookie?.value).toBe("a=${BC_REDACTED_1}; b=${BC_REDACTED_2}; sid=${BC_SECRET_1}")
    expect(collector.slots().map((slot) => slot.value)).toEqual(["abcdef123456"])

    // One-character values must not corrupt the literal references they resemble.
    const output = "BC_SECRET_1 and B and 1"
    expect(collector.redactText(output)).toBe(output)
  })

  test("keeps replacing short one-time request values inside unrelated execute output", () => {
    const collector = new SecretCollector()
    const form = collector.protectBody("username=bob&password=hunter1", "application/x-www-form-urlencoded", "request")
    expect(form).toBe("username=bob&password=${BC_REDACTED_1}")
    const json = collector.protectBody(JSON.stringify({ otp: "123456" }), "application/json", "request")
    expect(JSON.parse(json ?? "{}")).toEqual({ otp: "${BC_REDACTED_2}" })

    // Passwords and one-time codes are replaced at any length, unlike short reusable captures.
    expect(collector.redactText("username=bob&password=hunter1")).toBe("username=bob&password=${BC_REDACTED_1}")
    expect(collector.redactText("code 123456 ok")).toBe("code ${BC_REDACTED_2} ok")
    expect(collector.redactText("username=bob&password=hunter1")).not.toContain("hunter1")
    expect(collector.redactText("code 123456 ok")).not.toContain("123456")
  })

  test("keeps replacing long captured values inside unrelated execute output", () => {
    const collector = new SecretCollector()
    collector.protectUrl("https://api.example.com/v1/orders?session=42&access_token=tok_live_ABCDEF1234567890")
    expect(collector.slots().map((slot) => slot.value)).toEqual(["tok_live_ABCDEF1234567890"])
    expect(collector.redactText("order 1423 at 4:42 token tok_live_ABCDEF1234567890 end"))
      .toBe("order 1423 at 4:42 token ${BC_SECRET_1} end")
  })

  test("keeps replacing explicitly typed secrets of any length in execute output", () => {
    const collector = new SecretCollector()
    collector.addRedactionOnly("p@ss")
    expect(collector.redactText("say p@ss now")).toBe("say ${BC_REDACTED_1} now")
    expect(collector.redactValue({ echoed: "p@ss" })).toEqual({ echoed: "${BC_REDACTED_1}" })
  })

  test("keeps custom access-control headers and cookie values secret", () => {
    const collector = new SecretCollector()
    const [custom] = collector.protectHeaders([{ name: "access-control-token", value: "ctl-acctoken-value-0003" }], "response")
    expect(custom?.value).toBe("${BC_SECRET_1}")
    const [requestCookie] = collector.protectHeaders([{ name: "Cookie", value: "priority=ctlcookie01; secure=ctlcookie02" }], "request")
    expect(requestCookie?.value).toBe("priority=${BC_SECRET_2}; secure=${BC_SECRET_3}")
    const [setCookie] = collector.protectHeaders([{ name: "Set-Cookie", value: "secure=ctlcookie03; Path=/" }], "response")
    expect(setCookie?.value).toBe("secure=${BC_SECRET_4}; Path=/")
    const [attributes] = collector.protectHeaders(
      [{ name: "Set-Cookie", value: "sid=ctlcookie04; Secure=true; HttpOnly=true; Partitioned=true" }],
      "response",
    )
    expect(attributes?.value).toBe("sid=${BC_SECRET_5}; Secure=true; HttpOnly=true; Partitioned=true")
    expect(collector.slots().map((slot) => slot.value)).toEqual([
      "ctl-acctoken-value-0003",
      "ctlcookie01",
      "ctlcookie02",
      "ctlcookie03",
      "ctlcookie04",
    ])
  })

  test("keeps booleans in redacted values", () => {
    const collector = new SecretCollector()
    collector.protectHeaders([{ name: "authorization", value: "Bearer ctl-bearer-value-0001" }], "request")
    collector.protectHeaders([{ name: "access-control-allow-credentials", value: "true" }], "response")
    expect(collector.redactValue({ flag: true, token: "ctl-bearer-value-0001" })).toEqual({ flag: true, token: "[REDACTED]" })
  })

  test("protects every newline-joined set-cookie line", () => {
    const collector = new SecretCollector()
    const [cookies] = collector.protectHeaders(
      [{ name: "Set-Cookie", value: "a=ctlcookie05; Priority=High\nb=ctlcookie06; Path=/" }],
      "response",
    )
    expect(cookies?.value).toBe("a=${BC_SECRET_1}; Priority=High\nb=${BC_SECRET_2}; Path=/")
    expect(collector.slots().map((slot) => slot.value)).toEqual(["ctlcookie05", "ctlcookie06"])
  })

  test("protects :path query values under the request URL's references", async () => {
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
        undefined,
        {},
      ))
      const har = JSON.parse(await readFile(outputPath, "utf8")) as {
        log: { entries: Array<{ request: { url: string; headers: Array<{ name: string; value: string }> } }> }
      }
      const [shortEntry, encodedEntry] = har.log.entries
      expect(shortEntry?.request.url).toBe("https://docs.example.com/callback?code=${BC_REDACTED_1}&x=1")
      expect(shortEntry?.request.headers).toContainEqual({ name: ":path", value: "/callback?code=${BC_REDACTED_1}&x=1" })
      expect(shortEntry?.request.headers).toContainEqual({ name: ":authority", value: "docs.example.com" })
      expect(encodedEntry?.request.url).toBe("https://docs.example.com/callback?code=${BC_REDACTED_2}")
      expect(encodedEntry?.request.headers).toContainEqual({ name: ":path", value: "/callback?code=${BC_REDACTED_2}" })
      expect(encodedEntry?.request.headers).toContainEqual({ name: ":authority", value: "docs.example.com" })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("heals a profile polluted with a pseudo-header hostname and a one-character cookie", async () => {
    const directory = await mkdtemp(join(tmpdir(), "browse-har-authority-"))
    const outputPath = join(directory, "capture.har")
    const baseDir = join(directory, "secrets")
    const profilePath = join(baseDir, "pseudo.json")
    const requestUrl = "https://jsonplaceholder.typicode.com/posts/B"
    const source = `GET ${requestUrl}`
    try {
      await mkdir(baseDir, { recursive: true })
      await writeFile(profilePath, JSON.stringify({
        version: 1,
        name: "pseudo",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        slots: [
          { ref: "BC_SECRET_1", value: "jsonplaceholder.typicode.com", sources: [`${source}.request.header.:authority`] },
          { ref: "BC_SECRET_2", value: "B", sources: [`${source}.request.header.cookie.probe`] },
          { ref: "BC_SECRET_3", value: "tok_live_ABCDEF1234567890", sources: [`${source}.request.header.authorization`] },
        ],
      }))
      const entry = capturedEntry("posts", {})
      await Effect.runPromise(finishCapture(
        activeCapture([{
          ...entry,
          request: {
            ...entry.request,
            url: requestUrl,
            headers: [
              { name: ":authority", value: "jsonplaceholder.typicode.com" },
              { name: ":method", value: "GET" },
              { name: ":path", value: "/posts/B" },
              { name: ":scheme", value: "https" },
              { name: "cookie", value: "probe=B" },
            ],
          },
        }]),
        { outputPath },
        "pseudo",
        { baseDir },
      ))
      const har = JSON.parse(await readFile(outputPath, "utf8")) as {
        log: { entries: Array<{ request: { url: string; headers: Array<{ name: string; value: string }> } }> }
      }
      const request = har.log.entries[0]?.request
      expect(request?.url).toBe("https://jsonplaceholder.typicode.com/posts/B")
      expect(request?.headers).toContainEqual({ name: ":authority", value: "jsonplaceholder.typicode.com" })
      expect(request?.headers).toContainEqual({ name: "cookie", value: "probe=${BC_REDACTED_1}" })
      const profile = JSON.parse(await readFile(profilePath, "utf8")) as {
        slots: Array<{ ref: string; value: string; sources: string[] }>
      }
      expect(profile.slots).toEqual([{ ref: "BC_SECRET_3", value: "tok_live_ABCDEF1234567890", sources: [`${source}.request.header.authorization`] }])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("never reuses a ref held by a dropped slot", async () => {
    const directory = await mkdtemp(join(tmpdir(), "browse-har-refs-"))
    const baseDir = join(directory, "secrets")
    const profilePath = join(baseDir, "refs.json")
    try {
      await mkdir(baseDir, { recursive: true })
      await writeFile(profilePath, JSON.stringify({
        version: 1,
        name: "refs",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        slots: [
          { ref: "BC_SECRET_1", value: "tok_live_KEPT1234567890", sources: ["GET https://docs.example.com.request.header.authorization"] },
          { ref: "BC_SECRET_2", value: "docs.example.com", sources: ["GET https://docs.example.com.request.header.:authority"] },
        ],
      }))
      const entry = capturedEntry("ref", {})
      const finished = await Effect.runPromise(finishCapture(
        activeCapture([{
          ...entry,
          request: {
            ...entry.request,
            url: "https://docs.example.com/ref?access_token=tok_new_ABCDEF1234567890",
          },
        }]),
        {},
        "refs",
        { baseDir },
      ))
      expect(finished.authProfile?.slots.map((slot) => slot.ref)).toEqual(["BC_SECRET_1", "BC_SECRET_3"])
      const stored = JSON.parse(await readFile(profilePath, "utf8")) as {
        nextRef?: number
        slots: Array<{ ref: string }>
      }
      expect(stored.slots.map((slot) => slot.ref)).toEqual(["BC_SECRET_1", "BC_SECRET_3"])
      expect(stored.nextRef).toBe(4)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("starts new refs at a stored high-water mark", async () => {
    const directory = await mkdtemp(join(tmpdir(), "browse-har-next-ref-"))
    const baseDir = join(directory, "secrets")
    const profilePath = join(baseDir, "refs.json")
    try {
      await mkdir(baseDir, { recursive: true })
      await writeFile(profilePath, JSON.stringify({
        version: 1,
        name: "refs",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        nextRef: 9,
        slots: [
          { ref: "BC_SECRET_1", value: "tok_live_KEPT1234567890", sources: ["GET https://docs.example.com.request.header.authorization"] },
        ],
      }))
      const entry = capturedEntry("ref", {})
      const finished = await Effect.runPromise(finishCapture(
        activeCapture([{
          ...entry,
          request: {
            ...entry.request,
            url: "https://docs.example.com/ref?access_token=tok_new_ABCDEF1234567890",
          },
        }]),
        {},
        "refs",
        { baseDir },
      ))
      expect(finished.authProfile?.slots.map((slot) => slot.ref)).toEqual(["BC_SECRET_1", "BC_SECRET_9"])
      const stored = JSON.parse(await readFile(profilePath, "utf8")) as { nextRef?: number }
      expect(stored.nextRef).toBe(10)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
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
      .toEqual({ code: { value: "${BC_REDACTED_1}" } })
    expect(JSON.parse(new SecretCollector().protectBody(JSON.stringify({ code: [{ value: "a7k2m9" }] }), "application/json", "response") ?? "{}"))
      .toEqual({ code: [{ value: "${BC_REDACTED_1}" }] })

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
    ) ?? "{}")).toEqual({ type: "codeListing", code: ["ok line", { value: "${BC_REDACTED_1}" }] })
    expect(JSON.parse(new SecretCollector().protectBody(
      JSON.stringify({ type: "codeVoice", code: "x", token: "abc" }),
      "application/json",
      "response",
    ) ?? "{}")).toEqual({ type: "codeVoice", code: "x", token: "${BC_REDACTED_1}" })

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
