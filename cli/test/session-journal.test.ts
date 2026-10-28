import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { appendJournalEntry, journalPathForSession, makeJournalEntry, pruneSessionJournals, readJournalEntries, redactJournalText } from "../src/session-journal.ts"

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "browse-journal-"))
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }))

describe("journal redaction", () => {
  test("hides typed credentials, assignments, query secrets and tokens", () => {
    const code = [
      `await page.getByLabel("Password").fill("hunter2-hunter2")`,
      `await page.fill("#otp", "492817")`,
      `const apiKey = "abc123def456"`,
      `await page.goto("https://example.com/cb?access_token=tok_123456&next=/home")`,
      `await fetch(url, { headers: { Authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlMTIz" } })`,
      `await page.getByLabel("Email").fill("ada@example.com")`,
    ].join("\n")
    const redacted = redactJournalText(code)
    for (const secret of ["hunter2-hunter2", "492817", "abc123def456", "tok_123456", "eyJhbGciOiJIUzI1NiJ9"]) {
      expect(redacted).not.toContain(secret)
    }
    // Ordinary values stay readable.
    expect(redacted).toContain("ada@example.com")
    expect(redacted).toContain("next=/home")
  })

  test("stays fast on huge results", () => {
    // A 5 MB string of word characters used to make the assignment pattern backtrack quadratically and hang the relay.
    for (const text of ["x".repeat(5_000_000), `password${"a".repeat(2_000_000)}`, `?${"t".repeat(2_000_000)}token`]) {
      const started = performance.now()
      redactJournalText(text)
      expect(performance.now() - started).toBeLessThan(2_000)
    }
    expect(redactJournalText(`const myExtremelyLongAndDescriptiveIdentifierForTheProductionDatabasePassword = "pw-123456"`)).not.toContain("pw-123456")
  })

  test("entries redact code, results and URLs", () => {
    const entry = makeJournalEntry({
      sessionId: "github",
      code: `await page.locator("#password").fill("s3cret-pass")`,
      isError: false,
      durationMs: 12,
      resultText: "token=ghp_abcdefghijklmnop1234",
      logCount: 0,
      startUrl: "https://example.com/?session=abcdef",
      endUrl: null,
    })
    expect(JSON.stringify(entry)).not.toMatch(/s3cret-pass|ghp_abcdefghijklmnop1234|session=abcdef/)
  })
})

describe("journal files", () => {
  test("are private: directories 0700, files 0600", async () => {
    const baseDir = path.join(scratch, "perms")
    const entry = makeJournalEntry({ sessionId: "alpha", code: "1", isError: false, durationMs: 1, resultText: "1", logCount: 0 })
    await appendJournalEntry({ baseDir, entry })
    const file = journalPathForSession(baseDir, "alpha")
    expect(fs.statSync(baseDir).mode & 0o777).toBe(0o700)
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700)
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(await readJournalEntries({ baseDir, sessionId: "alpha", limit: 10 })).toEqual([entry])
  })

  test("retention removes old and excess journals, never live sessions", async () => {
    const baseDir = path.join(scratch, "retention")
    const now = Date.now()
    const day = 24 * 60 * 60 * 1_000
    const make = (id: string, ageDays: number) => {
      const directory = path.join(baseDir, id)
      fs.mkdirSync(directory, { recursive: true, mode: 0o755 })
      fs.writeFileSync(path.join(directory, "journal.jsonl"), "{}\n", { mode: 0o644 })
      const time = new Date(now - ageDays * day)
      fs.utimesSync(path.join(directory, "journal.jsonl"), time, time)
      fs.utimesSync(directory, time, time)
    }
    make("old", 20)
    make("old-live", 30)
    make("recent-a", 3)
    make("recent-b", 2)
    make("recent-c", 1)
    const removed = await pruneSessionJournals({ baseDir, isLive: (id) => id === "old-live", maxCount: 3, now })
    expect(removed.sort()).toEqual(["old", "recent-a"])
    expect(fs.readdirSync(baseDir).sort()).toEqual(["old-live", "recent-b", "recent-c"])
    // Journals that stay are tightened.
    expect(fs.statSync(path.join(baseDir, "recent-b")).mode & 0o777).toBe(0o700)
    expect(fs.statSync(path.join(baseDir, "recent-b", "journal.jsonl")).mode & 0o777).toBe(0o600)
  })
})
