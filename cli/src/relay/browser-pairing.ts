// Pairing the relay with browsers (the extension's half is src/background/pairing.ts; keep the formats in step).
//
// `pair` prints a short code: 8 Crockford base32 characters (40 bits), single use, valid for 10 minutes. The relay
// keeps only a slow hash of each pending code (pairing-codes.json): up to five may be pending at once (`pair`, the code
// `install` writes into an unpacked build, the one in install's link for a store build), and five wrong guesses in a
// row throw them all away, so guessing one is hopeless.
//
// An extension with a code exchanges it during the handshake for a token of its own (32 random bytes), which both keep:
// the relay in browser-tokens.json, keyed by the extension's profile id, the extension in chrome.storage.local. The
// exchange runs over ephemeral ECDH (P-256), so someone watching the connection learns neither the code nor the token:
//   extension -> hello        { pairing: { mode: "code", nonce, ecdh } }
//   relay     -> challenge    { nonce, ecdh }
//   extension -> auth.code    { proof }            HMAC(session key, "extension"): proves it knows a pending code
//   relay     -> auth.token   { proof, wrapped }   proves it knows the same code; the token masked with the session key
//   extension -> auth.response{ proof }            proves it unmasked the token (the usual token proof)
// The session key is HMAC(PBKDF2(code), ECDH secret, both nonces, both public keys and the endpoint). The slow hash
// means a program posing as either side that saw one proof can't search all 2^40 codes before the code expires.
//
// Every later connection proves the token with HMAC over fresh nonces, relay first, as before; the token never goes on
// the wire. `pair --revoke` deletes a browser's token and the relay drops its connection.
//
// Earlier versions shared one long code (extension-pairing). An extension holding it is issued a token the same way
// (mode "legacy": the relay proves the old code and hands over a wrapped token); an extension too old to take a token
// still pairs with it the old way. Nothing creates that file anymore; `pair --revoke legacy` deletes it.
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { writePrivateJsonFileSync } from "../fs-durability.ts"
import { dataRoot, stateRoot } from "../paths.ts"

const legacyContext = "opencode-browser-pairing-v2"
const context = "opencode-browser-pairing-v3"
export { context as pairingScheme }
const crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
const pairingCodeLength = 8
/** PBKDF2 over the code: one key costs both sides a few milliseconds, every possible code a search that can't finish. */
const codeKeyIterations = 100_000
const codeKeySalt = `${context}|code`

/** How long a code from `pair` (or install's link) stays valid. */
export const pairingCodeTtlMs = 10 * 60_000
/** A code install writes into an unpacked build: loading the extension may take a while after install printed the steps. */
export const bundledPairingCodeTtlMs = 60 * 60_000
/** Wrong codes in a row after which every pending code is thrown away. */
export const maxPairingFailures = 5
const maxPendingCodes = 5

/** The pairing file inside an unpacked extension; fetched by the extension with chrome.runtime.getURL. */
const extensionPairingFileName = "relay-pairing.json"

export const pairingCodesPath = (root = stateRoot()) => path.join(root, "pairing-codes.json")
export const browserTokensPath = (root = dataRoot()) => path.join(root, "browser-tokens.json")
/** The one code earlier versions shared with every extension. */
export const legacyPairingCodePath = (root = dataRoot()) => path.join(root, "extension-pairing")

// ---- codes -----------------------------------------------------------------------------------------------------

type PendingCodes = { codes: { key: string; expiresAt: number; receipt?: string }[]; failures: number }

/** A typed code in canonical form (8 characters, I/L read as 1, O as 0), or undefined. */
export function normalizePairingCode(input: string): string | undefined {
  const code = input.toUpperCase().replace(/[\s-]/g, "").replace(/[IL]/g, "1").replace(/O/g, "0")
  return new RegExp(`^[${crockford}]{${pairingCodeLength}}$`).test(code) ? code : undefined
}

/** ABCD-EFGH */
export function formatPairingCode(code: string): string {
  return code.match(/.{1,4}/g)?.join("-") ?? code
}

/** The slow hash of a code both sides derive and the relay stores: PBKDF2-SHA256, hex. */
export function pairingCodeKey(code: string): string {
  return crypto.pbkdf2Sync(code, codeKeySalt, codeKeyIterations, 32, "sha256").toString("hex")
}

function readPendingCodes(root: string, now: number): PendingCodes {
  try {
    const value = JSON.parse(fs.readFileSync(pairingCodesPath(root), "utf8")) as Partial<PendingCodes>
    const codes = Array.isArray(value.codes)
      ? value.codes.filter((entry) => typeof entry?.key === "string" && /^[0-9a-f]{64}$/.test(entry.key) && typeof entry.expiresAt === "number" && entry.expiresAt >= now)
      : []
    return { codes, failures: typeof value.failures === "number" ? value.failures : 0 }
  } catch {
    return { codes: [], failures: 0 }
  }
}

function writePendingCodes(root: string, pending: PendingCodes): void {
  if (pending.codes.length === 0 && pending.failures === 0) {
    fs.rmSync(pairingCodesPath(root), { force: true })
    return
  }
  writePrivateJsonFileSync(pairingCodesPath(root), pending, { ensureParent: true })
}

/** A new single-use code; only its slow hash is stored. The oldest pending codes go past five. */
export function mintPairingCode(root = stateRoot(), options: { readonly now?: number; readonly ttlMs?: number; readonly receipt?: string } = {}): string {
  const now = options.now ?? Date.now()
  const code = Array.from(crypto.randomBytes(pairingCodeLength), (byte) => crockford[byte & 31]).join("")
  const pending = readPendingCodes(root, now)
  pending.codes.push({ key: pairingCodeKey(code), expiresAt: now + (options.ttlMs ?? pairingCodeTtlMs), ...(options.receipt ? { receipt: options.receipt } : {}) })
  // A fresh code gets the full allowance of attempts.
  writePendingCodes(root, { codes: pending.codes.slice(-maxPendingCodes), failures: 0 })
  return code
}

/** The keys of the codes that are pending and unexpired. */
export function pendingPairingCodeKeys(root = stateRoot(), now = Date.now()): string[] {
  return readPendingCodes(root, now).codes.map((entry) => entry.key)
}

/** Uses up a code once an extension proved it; the failure count starts over. */
export function consumePairingCode(key: string, root = stateRoot(), now = Date.now()): string | undefined {
  const pending = readPendingCodes(root, now)
  writePendingCodes(root, { codes: pending.codes.filter((entry) => entry.key !== key), failures: 0 })
  return pending.codes.find(entry => entry.key === key)?.receipt
}

/** Counts a wrong code; at the limit every pending code is thrown away. Returns whether that happened. */
export function recordPairingFailure(root = stateRoot(), now = Date.now()): boolean {
  const pending = readPendingCodes(root, now)
  const failures = pending.failures + 1
  const exhausted = failures >= maxPairingFailures
  writePendingCodes(root, exhausted ? { codes: [], failures: 0 } : { codes: pending.codes, failures })
  return exhausted && pending.codes.length > 0
}

/** Writes a fresh code into an unpacked extension, which exchanges it once for its token. Never in a package or zip. */
export function writeExtensionPairing(extensionDirectory: string, code: string, port?: number): void {
  writePrivateJsonFileSync(path.join(extensionDirectory, extensionPairingFileName), {
    code,
    ...(port === undefined ? {} : { port }),
  })
}

// ---- tokens ----------------------------------------------------------------------------------------------------

export type BrowserPairing = {
  readonly token: string
  readonly pairedAt: number
  /** A local correlation id, not key material; lets a waiting `pair` recognize its own redemption. */
  readonly receipt?: string
  readonly lastSeen?: number
  /** What the relay called the browser when it last connected (browser-links.ts). */
  readonly id?: string
  readonly name?: string
}

/** Paired browsers by profile key. */
export function readBrowserPairings(root = dataRoot()): Record<string, BrowserPairing> {
  try {
    const value = JSON.parse(fs.readFileSync(browserTokensPath(root), "utf8")) as unknown
    if (value === null || typeof value !== "object" || Array.isArray(value)) return {}
    return Object.fromEntries(
      Object.entries(value as Record<string, BrowserPairing>).filter(([, entry]) => typeof entry?.token === "string" && /^[A-Za-z0-9_-]{43}$/.test(entry.token)),
    )
  } catch {
    return {}
  }
}

function writeBrowserPairings(root: string, pairings: Record<string, BrowserPairing>): void {
  writePrivateJsonFileSync(browserTokensPath(root), pairings, { ensureParent: true })
}

export function browserToken(key: string, root = dataRoot()): string | undefined {
  return readBrowserPairings(root)[key]?.token
}

export const newBrowserToken = () => crypto.randomBytes(32).toString("base64url")

/** A new token for the browser with this profile key (or the given one), replacing any it had. */
export function issueBrowserToken(key: string, root = dataRoot(), now = Date.now(), token = newBrowserToken(), receipt?: string): string {
  const pairings = readBrowserPairings(root)
  writeBrowserPairings(root, { ...pairings, [key]: { token, pairedAt: now, ...(receipt ? { receipt } : {}) } })
  return token
}

/** Records a paired browser's connection: when, and what the relay calls it. */
export function touchBrowserPairing(key: string, seen: { readonly id: string; readonly name: string }, root = dataRoot(), now = Date.now()): void {
  const pairings = readBrowserPairings(root)
  const entry = pairings[key]
  if (!entry) return
  writeBrowserPairings(root, { ...pairings, [key]: { ...entry, lastSeen: now, id: seen.id, name: seen.name } })
}

/** Deletes a browser's token; true when it had one. */
export function revokeBrowserToken(key: string, root = dataRoot()): boolean {
  const pairings = readBrowserPairings(root)
  if (!(key in pairings)) return false
  delete pairings[key]
  writeBrowserPairings(root, pairings)
  return true
}

// ---- the old shared code ---------------------------------------------------------------------------------------

/** The code earlier versions shared, while it's still accepted. */
export function legacyPairingCode(root = dataRoot()): string | undefined {
  try {
    const code = fs.readFileSync(legacyPairingCodePath(root), "utf8").trim()
    return new RegExp(`^[${crockford}]{32}$`).test(code) ? code : undefined
  } catch {
    return undefined
  }
}

export function removeLegacyPairingCode(root = dataRoot()): boolean {
  const existed = legacyPairingCode(root) !== undefined
  fs.rmSync(legacyPairingCodePath(root), { force: true })
  return existed
}

/** The old handshake's proof (HMAC with the shared code), for extensions too old to take a token. */
export function legacyPairingProof(code: string, role: "relay" | "extension", port: number, ownNonce: string, peerNonce: string): string {
  return crypto.createHmac("sha256", code).update(`${legacyContext}|${role}|${pairingEndpoint(port)}|${peerNonce}|${ownNonce}`).digest("base64url")
}

// ---- the handshake ---------------------------------------------------------------------------------------------

/** The relay link the proofs are bound to: a listener on another port can't pass the handshake through. */
function pairingEndpoint(port: number): string {
  return `127.0.0.1:${port}/extension`
}

/** The token proof `role` sends on every connection: HMAC(token, context | role | endpoint | peer nonce | own nonce). */
export function pairingProof(token: string, role: "relay" | "extension", port: number, ownNonce: string, peerNonce: string): string {
  return crypto.createHmac("sha256", token).update(`${context}|${role}|${pairingEndpoint(port)}|${peerNonce}|${ownNonce}`).digest("base64url")
}

/** The relay's half of an ephemeral ECDH exchange: its public key (uncompressed P-256, base64url) and the shared secret. */
export function ecdhExchange(peerPublicKey: string): { readonly publicKey: string; readonly secret: Buffer } | undefined {
  const peer = Buffer.from(peerPublicKey, "base64url")
  if (peer.length !== 65 || peer[0] !== 4) return undefined
  const ecdh = crypto.createECDH("prime256v1")
  const publicKey = ecdh.generateKeys().toString("base64url")
  try {
    return { publicKey, secret: ecdh.computeSecret(peer) }
  } catch {
    return undefined
  }
}

export type HandshakeTranscript = {
  readonly port: number
  readonly extensionNonce: string
  readonly relayNonce: string
  readonly extensionKey: string
  readonly relayKey: string
}

/**
 * The key a code exchange runs under: HMAC keyed by the code's key material (a pending code's PBKDF2 hex, or the old
 * shared code) over the ECDH secret and everything both sides sent.
 */
export function pairingSessionKey(material: string, secret: Buffer, transcript: HandshakeTranscript): Buffer {
  return crypto
    .createHmac("sha256", material)
    .update(`${context}|session|${pairingEndpoint(transcript.port)}|${transcript.extensionNonce}|${transcript.relayNonce}|${transcript.extensionKey}|${transcript.relayKey}|`)
    .update(secret)
    .digest()
}

export function sessionProof(sessionKey: Buffer, role: "relay" | "extension"): string {
  return crypto.createHmac("sha256", sessionKey).update(`${context}|proof|${role}`).digest("base64url")
}

/** A token masked for the extension: its 32 bytes XOR HMAC(session key, "wrap"), base64url. */
export function wrapToken(sessionKey: Buffer, token: string): string {
  const mask = crypto.createHmac("sha256", sessionKey).update(`${context}|wrap`).digest()
  return Buffer.from(Buffer.from(token, "base64url").map((byte, index) => byte ^ mask[index]!)).toString("base64url")
}
