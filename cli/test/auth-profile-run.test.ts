import { afterAll, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import * as AuthProfile from "../src/auth-profile.ts"

const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "browse-auth-run-"))
const workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "browse-auth-cwd-")))
const missingDir = path.join(baseDir, "missing")

afterAll(() => {
  fs.rmSync(baseDir, { recursive: true, force: true })
  fs.rmSync(workDir, { recursive: true, force: true })
})

const run = (options: Partial<AuthProfile.AuthRunOptions>) =>
  Effect.runPromise(Effect.gen(function* () {
    yield* AuthProfile.write({ name: "p", baseDir, slots: [{ ref: "BC_SECRET_1", value: "secret-value-123", sources: ["s"] }] })
    return yield* AuthProfile.run({ name: "p", baseDir, command: "/bin/sh", args: ["-c", "pwd"], ...options })
  }))

describe("AuthProfile.run", () => {
  test("runs in the requested directory", async () => {
    const result = await run({ cwd: workDir })
    expect(result.stdout.trim()).toBe(workDir)
  })

  test("names a working directory that does not exist on the relay host", async () => {
    await expect(run({ cwd: missingDir })).rejects.toThrow(`Working directory does not exist on the relay host: ${missingDir}`)
  })

  test("includes the cause when the command cannot start", async () => {
    await expect(run({ command: path.join(missingDir, "nope") })).rejects.toThrow(/Could not run command with auth profile p: .*ENOENT/)
  })
})
