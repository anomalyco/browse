/**
 * Site secrets: values (passwords, API keys, optionally TOTP seeds) an agent can type into a page with
 * `secrets.type(target, name)` in execute, without ever seeing them.
 *
 * Each secret declares the origins it may be typed on (domain-policy.ts patterns; a bare host means https only,
 * except local hosts). The relay checks the target field's frame URL, from the CDP frame tree, against that list
 * right before it inserts the value, so a cross-origin iframe or a redirect to another host gets nothing. The value
 * never enters the execute realm, results, logs, journals or HARs (they redact it).
 *
 * Storage: one 0600 JSON file per secret under `<data root>/site-secrets/` (0700), written atomically under the same
 * lock files as secret profiles (auth-profile.ts). Values are added from stdin or a hidden prompt by the CLI, never
 * from argv. A TOTP secret stores the seed and types the current code; storing the seed next to the password turns
 * two factors into one, so it is opt-in per secret.
 */
import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Schema } from "effect"
import * as AuthProfile from "./auth-profile.ts"
import { normalizeOriginPatterns } from "./domain-policy.ts"
import { isNodeError, writeJsonFileAtomically } from "./fs-durability.ts"
import { dataRoot } from "./paths.ts"

const StoredSiteSecret = Schema.Struct({
  version: Schema.Literal(1),
  name: Schema.String,
  kind: Schema.Literals(["password", "totp"]),
  value: Schema.String,
  allowedOrigins: Schema.Array(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
})

type StoredSiteSecret = Schema.Schema.Type<typeof StoredSiteSecret>

export type SiteSecretKind = StoredSiteSecret["kind"]

export type SiteSecretSummary = {
  readonly name: string
  readonly kind: SiteSecretKind
  readonly allowedOrigins: readonly string[]
  readonly createdAt: string
  readonly updatedAt: string
}

export class SiteSecretError extends Schema.TaggedError<SiteSecretError>()("SiteSecret.Error", {
  message: Schema.String,
  reason: Schema.Literals(["invalid-name", "invalid-origins", "invalid-value", "not-found", "read-failed", "write-failed"]),
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

export const defaultSiteSecretsDir = (): string => path.join(dataRoot(), "site-secrets")

const namePattern = /^[a-z0-9][a-z0-9._-]{0,63}$/i

function secretPath(baseDir: string, name: string): Effect.Effect<string, SiteSecretError> {
  return namePattern.test(name)
    ? Effect.succeed(path.join(baseDir, `${name}.json`))
    : Effect.fail(new SiteSecretError({ message: `Invalid secret name: ${name} (letters, digits, ".", "_" and "-", up to 64)`, reason: "invalid-name" }))
}

function summary(secret: StoredSiteSecret): SiteSecretSummary {
  return { name: secret.name, kind: secret.kind, allowedOrigins: [...secret.allowedOrigins], createdAt: secret.createdAt, updatedAt: secret.updatedAt }
}

/** Read a secret with its value. Relay-internal: never hand the result to execute code. */
export const readSecret = Effect.fn("SiteSecrets.read")(function* (name: string, options: { readonly baseDir?: string } = {}) {
  const filePath = yield* secretPath(options.baseDir ?? defaultSiteSecretsDir(), name)
  const text = yield* Effect.tryPromise({
    try: () => fs.readFile(filePath, "utf8"),
    catch: (cause) => isNodeError(cause) && cause.code === "ENOENT"
      ? new SiteSecretError({ message: `Secret not found: ${name}. Ask the user to add it with \`opencode-browser secrets add ${name} --origin <origin>\`.`, reason: "not-found" })
      : new SiteSecretError({ message: `Could not read secret ${name}`, reason: "read-failed", cause }),
  })
  return yield* Effect.try({
    try: () => Schema.decodeUnknownSync(StoredSiteSecret)(JSON.parse(text)),
    catch: (cause) => new SiteSecretError({ message: `Secret ${name} is not a valid secret file`, reason: "read-failed", cause }),
  })
})

export const addSecret = Effect.fn("SiteSecrets.add")(function* (options: {
  readonly name: string
  readonly value: string
  readonly allowedOrigins: readonly string[]
  readonly kind?: SiteSecretKind
  readonly baseDir?: string
}) {
  const baseDir = options.baseDir ?? defaultSiteSecretsDir()
  const filePath = yield* secretPath(baseDir, options.name)
  const kind = options.kind ?? "password"
  const allowedOrigins = yield* Effect.try({
    try: () => normalizeOriginPatterns(options.allowedOrigins),
    catch: (cause) => new SiteSecretError({ message: cause instanceof Error ? cause.message : "Invalid origins", reason: "invalid-origins", cause }),
  })
  if (allowedOrigins.length === 0) {
    return yield* new SiteSecretError({ message: "A secret needs at least one allowed origin (--origin https://example.com)", reason: "invalid-origins" })
  }
  const value = kind === "totp" ? options.value.trim() : options.value.replace(/\r?\n$/, "")
  if (!value) return yield* new SiteSecretError({ message: "The secret value is empty", reason: "invalid-value" })
  if (kind === "totp") yield* Effect.try({
    try: () => totpCode(value),
    catch: (cause) => new SiteSecretError({ message: `Not a TOTP seed or otpauth:// URI: ${cause instanceof Error ? cause.message : "invalid"}`, reason: "invalid-value", cause }),
  })
  const write = Effect.gen(function* () {
    const existing = yield* readSecret(options.name, { baseDir }).pipe(Effect.catchIf((error) => error.reason === "not-found", () => Effect.succeed(undefined)))
    const now = new Date().toISOString()
    const secret: StoredSiteSecret = { version: 1, name: options.name, kind, value, allowedOrigins: [...allowedOrigins], createdAt: existing?.createdAt ?? now, updatedAt: now }
    yield* Effect.tryPromise({
      try: () => writeJsonFileAtomically(filePath, secret, { dirMode: 0o700 }),
      catch: (cause) => new SiteSecretError({ message: `Could not write secret ${options.name}`, reason: "write-failed", cause }),
    })
    return summary(secret)
  })
  return yield* AuthProfile.withLock(options.name, { baseDir }, write).pipe(
    Effect.mapError((error) => error instanceof SiteSecretError ? error : new SiteSecretError({ message: error.message, reason: "write-failed", cause: error })),
  )
})

export const listSecrets = Effect.fn("SiteSecrets.list")(function* (options: { readonly baseDir?: string } = {}) {
  const baseDir = options.baseDir ?? defaultSiteSecretsDir()
  const names = yield* Effect.tryPromise({
    try: () => fs.readdir(baseDir).catch((cause: unknown) => (isNodeError(cause) && cause.code === "ENOENT" ? [] : Promise.reject(cause))),
    catch: (cause) => new SiteSecretError({ message: "Could not list secrets", reason: "read-failed", cause }),
  })
  const secrets: SiteSecretSummary[] = []
  for (const file of names.filter((entry) => entry.endsWith(".json")).sort()) {
    const secret = yield* readSecret(file.slice(0, -".json".length), { baseDir }).pipe(Effect.option)
    if (secret._tag === "Some") secrets.push(summary(secret.value))
  }
  return secrets
})

export const removeSecret = Effect.fn("SiteSecrets.remove")(function* (name: string, options: { readonly baseDir?: string } = {}) {
  const baseDir = options.baseDir ?? defaultSiteSecretsDir()
  const filePath = yield* secretPath(baseDir, name)
  return yield* AuthProfile.withLock(name, { baseDir }, Effect.tryPromise({
    try: () => fs.rm(filePath).then(() => true, (cause: unknown) => (isNodeError(cause) && cause.code === "ENOENT" ? false : Promise.reject(cause))),
    catch: (cause) => new SiteSecretError({ message: `Could not remove secret ${name}`, reason: "write-failed", cause }),
  })).pipe(Effect.mapError((error) => error instanceof SiteSecretError ? error : new SiteSecretError({ message: error.message, reason: "write-failed", cause: error })))
})

// ---- TOTP (RFC 6238) --------------------------------------------------------------------------------

function base32Decode(input: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
  const clean = input.toUpperCase().replace(/[\s=-]/g, "")
  if (!clean || /[^A-Z2-7]/.test(clean)) throw new Error("the seed must be base32")
  let bits = 0
  let value = 0
  const bytes: number[] = []
  for (const char of clean) {
    value = (value << 5) | alphabet.indexOf(char)
    bits += 5
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(bytes)
}

type TotpParameters = { readonly key: Buffer; readonly digits: number; readonly period: number; readonly algorithm: "sha1" | "sha256" | "sha512" }

function totpParameters(seed: string): TotpParameters {
  if (/^otpauth:\/\//i.test(seed)) {
    const url = new URL(seed)
    const secret = url.searchParams.get("secret")
    if (!secret) throw new Error("the otpauth URI has no secret")
    const digits = Number(url.searchParams.get("digits") ?? 6)
    const period = Number(url.searchParams.get("period") ?? 30)
    const algorithm = (url.searchParams.get("algorithm") ?? "SHA1").toLowerCase()
    if (![6, 7, 8].includes(digits) || !Number.isInteger(period) || period <= 0 || !["sha1", "sha256", "sha512"].includes(algorithm)) {
      throw new Error("unsupported otpauth parameters")
    }
    return { key: base32Decode(secret), digits, period, algorithm: algorithm as TotpParameters["algorithm"] }
  }
  return { key: base32Decode(seed), digits: 6, period: 30, algorithm: "sha1" }
}

/** The current TOTP code for a base32 seed or otpauth:// URI. */
export function totpCode(seed: string, now = Date.now()): string {
  const { key, digits, period, algorithm } = totpParameters(seed)
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 1000 / period)))
  const hmac = crypto.createHmac(algorithm, key).update(counter).digest()
  const offset = hmac[hmac.length - 1]! & 15
  const binary = (hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits
  return String(binary).padStart(digits, "0")
}

/** The text to type for a secret: the value, or the current code for a TOTP secret. */
export function secretText(secret: Pick<StoredSiteSecret, "kind" | "value">): string {
  return secret.kind === "totp" ? totpCode(secret.value) : secret.value
}
