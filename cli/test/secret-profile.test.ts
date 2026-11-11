import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as AuthProfile from "../src/auth/profile.ts"

const shortSlot = { ref: "BC_SECRET_1", value: "B", sources: ["GET https://example.com.request.header.cookie.b"] }
const authoritySlot = {
  ref: "BC_SECRET_2",
  value: "example.com",
  sources: ["GET https://example.com.request.header.:authority.1"],
}
const whitespaceAuthoritySlot = {
  ref: "BC_SECRET_3",
  value: "example.org",
  sources: ["GET https://example.com.request.header. :authority"],
}
const jsonSlot = {
  ref: "BC_SECRET_4",
  value: "tok_json_ABCDEF1234567890",
  sources: ["GET https://example.com.response.json.header.:token"],
}
const responseStatusSlot = {
  ref: "BC_SECRET_6",
  value: "statusvalue123",
  sources: ["GET https://example.com.response.header.:status"],
}
const jsonPathHeaderSlot = {
  ref: "BC_SECRET_7",
  value: "tok_jsonpath_ABCDEF1234567890",
  sources: ["GET https://example.com/x.response.json.request.header.:x-token"],
}
const queryPathHeaderSlot = {
  ref: "BC_SECRET_8",
  value: "tok_querypath_ABCDEF1234567890",
  sources: ["GET https://example.com/x.query.request.header.:authority"],
}
const jsonUrlAuthoritySlot = {
  ref: "BC_SECRET_9",
  value: "manifest.example",
  sources: ["GET https://example.com/manifest.json.request.header.:authority"],
}
const responseUrlAuthoritySlot = {
  ref: "BC_SECRET_10",
  value: "response.example",
  sources: ["GET https://example.com/app.response.request.header.:authority"],
}
const cookiePathHeaderSlot = {
  ref: "BC_SECRET_11",
  value: "tok_cookiepath_ABCDEF1234567890",
  sources: ["GET https://example.com/x.request.header.cookie.request.header.:authority"],
}
const jsonArrayHeaderSlot = {
  ref: "BC_SECRET_12",
  value: "tok_jsonarray_ABCDEF1234567890",
  sources: ["GET https://example.com/x.response.json.0.request.header.:x"],
}
const trailingWhitespaceAuthoritySlot = {
  ref: "BC_SECRET_13",
  value: "trailing.example",
  sources: ["GET https://example.com.request.header.:authority "],
}
const longSlot = {
  ref: "BC_SECRET_5",
  value: "tok_live_ABCDEF1234567890",
  sources: ["GET https://example.com.request.header.authorization"],
}
const slots = [
  shortSlot,
  authoritySlot,
  whitespaceAuthoritySlot,
  jsonSlot,
  longSlot,
  responseStatusSlot,
  jsonPathHeaderSlot,
  queryPathHeaderSlot,
  jsonUrlAuthoritySlot,
  responseUrlAuthoritySlot,
  cookiePathHeaderSlot,
  jsonArrayHeaderSlot,
  trailingWhitespaceAuthoritySlot,
]

async function writePollutedProfile(baseDir: string): Promise<void> {
  await writeFile(join(baseDir, "polluted.json"), JSON.stringify({
    version: 1,
    name: "polluted",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    slots,
  }))
}

describe("secret profile redaction", () => {
  test("cleans polluted profiles on read and never exports dropped slots", async () => {
    const directory = await mkdtemp(join(tmpdir(), "browse-secret-profile-"))
    const baseDir = join(directory, "secrets")
    try {
      await mkdir(baseDir, { recursive: true })
      await writePollutedProfile(baseDir)
      const profile = await Effect.runPromise(AuthProfile.read("polluted", { baseDir }))
      expect(profile.slots.map((slot) => slot.ref)).toEqual(["BC_SECRET_4", "BC_SECRET_5", "BC_SECRET_7", "BC_SECRET_8", "BC_SECRET_11", "BC_SECRET_12"])
      expect(profile.nextRef).toBe(14)

      const status = await Effect.runPromise(AuthProfile.status("polluted", { baseDir }))
      expect(status.slots.map((slot) => slot.ref)).toEqual(["BC_SECRET_4", "BC_SECRET_5", "BC_SECRET_7", "BC_SECRET_8", "BC_SECRET_11", "BC_SECRET_12"])

      const result = await Effect.runPromise(AuthProfile.run({
        name: "polluted",
        command: "sh",
        args: ["-c", 'echo "[$BC_SECRET_2]"'],
        baseDir,
      }))
      expect(result.stdout).toBe("[]\n")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("separates dropped pseudo-header slots from kept body paths", () => {
    const text = [
      "example.com",
      "example.org",
      "statusvalue123",
      "manifest.example",
      "response.example",
      "trailing.example",
      "BC_SECRET_1",
      "B",
      "tok_json_ABCDEF1234567890",
      "tok_live_ABCDEF1234567890",
      "tok_jsonpath_ABCDEF1234567890",
      "tok_querypath_ABCDEF1234567890",
      "tok_cookiepath_ABCDEF1234567890",
      "tok_jsonarray_ABCDEF1234567890",
    ].join(" ") + "\n"
    expect(AuthProfile.redactRunOutput(text, slots, 1_000).text)
      .toBe([
        "example.com",
        "example.org",
        "statusvalue123",
        "manifest.example",
        "response.example",
        "trailing.example",
        "BC_SECRET_1",
        "B",
        "${BC_SECRET_4}",
        "${BC_SECRET_5}",
        "${BC_SECRET_7}",
        "${BC_SECRET_8}",
        "${BC_SECRET_11}",
        "${BC_SECRET_12}",
      ].join(" ") + "\n")

    // Dropped slots are not matched by value, even when the whole output is that value.
    expect(AuthProfile.redactRunOutput("B", [shortSlot, longSlot], 1_000).text).toBe("B")
    expect(AuthProfile.redactRunOutput("example.com", [authoritySlot, longSlot], 1_000).text).toBe("example.com")
    expect(AuthProfile.redactRunOutput("example.org", [whitespaceAuthoritySlot, longSlot], 1_000).text).toBe("example.org")
    expect(AuthProfile.redactRunOutput("statusvalue123", [responseStatusSlot, longSlot], 1_000).text).toBe("statusvalue123")
    expect(AuthProfile.redactRunOutput("manifest.example", [jsonUrlAuthoritySlot, longSlot], 1_000).text).toBe("manifest.example")
    expect(AuthProfile.redactRunOutput("response.example", [responseUrlAuthoritySlot, longSlot], 1_000).text).toBe("response.example")
    expect(AuthProfile.redactRunOutput("trailing.example", [trailingWhitespaceAuthoritySlot, longSlot], 1_000).text).toBe("trailing.example")

    // Sources whose header-like suffix is really a JSON or query path are kept.
    expect(AuthProfile.redactRunOutput("tok_jsonpath_ABCDEF1234567890", [jsonPathHeaderSlot], 1_000).text)
      .toBe("${BC_SECRET_7}")
    expect(AuthProfile.redactRunOutput("tok_querypath_ABCDEF1234567890", [queryPathHeaderSlot], 1_000).text)
      .toBe("${BC_SECRET_8}")
    expect(AuthProfile.redactRunOutput("tok_cookiepath_ABCDEF1234567890", [cookiePathHeaderSlot], 1_000).text)
      .toBe("${BC_SECRET_11}")
    expect(AuthProfile.redactRunOutput("tok_jsonarray_ABCDEF1234567890", [jsonArrayHeaderSlot], 1_000).text)
      .toBe("${BC_SECRET_12}")
  })

  test("redacts an echoed long credential at the start of a line", () => {
    expect(AuthProfile.redactRunOutput("tok_live_ABCDEF1234567890\n", [longSlot], 1_000).text)
      .toBe("${BC_SECRET_5}\n")
  })
})
