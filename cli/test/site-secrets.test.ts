import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { SecretCollector } from "../src/network-redaction.ts"
import { addSecret, listSecrets, readSecret, removeSecret, totpCode } from "../src/site-secrets.ts"

const tempDir = () => fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "guarded-site-secrets-"))

describe("site secrets store", () => {
  test("stores 0600 files, lists without values, removes", async () => {
    const baseDir = path.join(tempDir(), "site-secrets")
    const saved = await Effect.runPromise(addSecret({ name: "shop", value: "hunter2\n", allowedOrigins: ["https://shop.test, *.shop.test"], baseDir }))
    expect(saved).toMatchObject({ name: "shop", kind: "password", allowedOrigins: ["https://shop.test", "*.shop.test"] })
    expect(JSON.stringify(saved)).not.toContain("hunter2")
    expect(fs.statSync(path.join(baseDir, "shop.json")).mode & 0o777).toBe(0o600)
    expect(fs.statSync(baseDir).mode & 0o777).toBe(0o700)
    expect((await Effect.runPromise(readSecret("shop", { baseDir }))).value).toBe("hunter2")
    const listed = await Effect.runPromise(listSecrets({ baseDir }))
    expect(listed.map((secret) => secret.name)).toEqual(["shop"])
    expect(JSON.stringify(listed)).not.toContain("hunter2")
    expect(await Effect.runPromise(removeSecret("shop", { baseDir }))).toBe(true)
    expect(await Effect.runPromise(listSecrets({ baseDir }))).toEqual([])
  })

  test("requires origins and a valid name", async () => {
    const baseDir = tempDir()
    await expect(Effect.runPromise(addSecret({ name: "x", value: "v", allowedOrigins: [], baseDir }))).rejects.toThrow(/at least one allowed origin/)
    await expect(Effect.runPromise(addSecret({ name: "x", value: "v", allowedOrigins: ["*"], baseDir }))).rejects.toThrow(/allows every site/)
    await expect(Effect.runPromise(addSecret({ name: "../x", value: "v", allowedOrigins: ["a.test"], baseDir }))).rejects.toThrow(/Invalid secret name/)
    await expect(Effect.runPromise(addSecret({ name: "otp", value: "not base32!", allowedOrigins: ["a.test"], kind: "totp", baseDir }))).rejects.toThrow(/TOTP/)
  })
})

describe("TOTP", () => {
  test("RFC 6238 SHA-1 test vectors", () => {
    const seed = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
    expect(totpCode(`otpauth://totp/x?secret=${seed}&digits=8`, 59_000)).toBe("94287082")
    expect(totpCode(`otpauth://totp/x?secret=${seed}&digits=8`, 1_111_111_109_000)).toBe("07081804")
    expect(totpCode(seed, 59_000)).toBe("287082")
  })
})

describe("typed-secret redaction", () => {
  test("replaces raw, percent- and form-encoded values at any length", () => {
    const collector = new SecretCollector()
    const text = "user=a&pass=p%40ss+w&raw=p@ss w&json={\"p\":\"p@ss w\"}"
    const redacted = collector.redactValuesEverywhere(text, ["p@ss w"])
    expect(redacted).not.toContain("p@ss w")
    expect(redacted).not.toContain("p%40ss")
    expect(redacted).toContain("${BC_REDACTED_1}")
  })
})
