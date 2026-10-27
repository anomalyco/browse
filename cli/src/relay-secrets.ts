// The relay's two local secrets, both in the data root (paths.ts) and readable only by this user:
//   relay-token         a bearer token every HTTP API request and CDP WebSocket must carry. The CLI, the MCP server
//                       and the relay's own Playwright connections read it from here.
//   extension-pairing   the code shared with the browser extension. The relay and the extension prove to each other
//                       that they know it (an HMAC over fresh nonces) before the extension obeys any command.
//                       `install` writes it into the unpacked extension (relay-pairing.json); a Chrome Web Store
//                       build gets it typed into its status page (`opencode-browser pair` prints it).
// Whoever needs a secret first creates it; creation is atomic, so a concurrent reader never sees a partial file.
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { dataRoot } from "./paths.ts"

export const relayTokenHeader = "authorization"
/** Query parameter that carries the token on CDP WebSocket URLs, for clients that can't set headers. */
export const relayTokenQueryParam = "opencodeBrowserToken"
/** The pairing file inside an unpacked extension; fetched by the extension with chrome.runtime.getURL. */
export const extensionPairingFileName = "relay-pairing.json"
const pairingContext = "opencode-browser-pairing-v1"
const crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
const pairingCodeLength = 32
const tokenPattern = /^[A-Za-z0-9_-]{43}$/
const pairingPattern = new RegExp(`^[${crockford}]{${pairingCodeLength}}$`)

export function relayTokenPath(root = dataRoot()): string {
  return path.join(root, "relay-token")
}

export function pairingCodePath(root = dataRoot()): string {
  return path.join(root, "extension-pairing")
}

/** The install's relay token, created on first use. */
export function relayToken(root = dataRoot()): string {
  return readOrCreateSecret(relayTokenPath(root), () => crypto.randomBytes(32).toString("base64url"), (value) => tokenPattern.test(value))
}

/** The install's extension pairing code (32 Crockford base32 characters, 160 bits), created on first use. */
export function pairingCode(root = dataRoot()): string {
  return readOrCreateSecret(pairingCodePath(root), generatePairingCode, (value) => pairingPattern.test(value))
}

/** `Authorization` header value for relay requests. */
export function relayAuthorization(root = dataRoot()): string {
  return `Bearer ${relayToken(root)}`
}

/** Groups a pairing code for display: ABCD-EFGH-... */
export function formatPairingCode(code: string): string {
  return code.match(/.{1,4}/g)?.join("-") ?? code
}

/** HMAC-SHA256 proof over the handshake nonces, base64url. `role` is who proves: "relay" or "extension". */
export function pairingProof(code: string, role: "relay" | "extension", ownNonce: string, peerNonce: string): string {
  return crypto.createHmac("sha256", code).update(`${pairingContext}|${role}|${peerNonce}|${ownNonce}`).digest("base64url")
}

/** Constant-time comparison of two secrets (or proofs) of any length. */
export function secretsEqual(expected: string, actual: string | undefined): boolean {
  if (actual === undefined) return false
  const a = crypto.createHash("sha256").update(expected).digest()
  const b = crypto.createHash("sha256").update(actual).digest()
  return crypto.timingSafeEqual(a, b) && expected.length === actual.length
}

/** Writes the pairing file an unpacked extension reads. Never part of a published package or store zip. */
export function writeExtensionPairing(extensionDirectory: string, code = pairingCode()): void {
  const file = path.join(extensionDirectory, extensionPairingFileName)
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify({ code })}\n`, { mode: 0o600 })
  fs.renameSync(temporary, file)
}

function generatePairingCode(): string {
  const bytes = crypto.randomBytes(pairingCodeLength)
  let code = ""
  for (const byte of bytes) code += crockford[byte & 31]
  return code
}

function readOrCreateSecret(file: string, generate: () => string, valid: (value: string) => boolean): string {
  const existing = readSecret(file)
  if (existing !== undefined && valid(existing)) return existing
  ensurePrivateDirectory(path.dirname(file))
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
  fs.writeFileSync(temporary, `${generate()}\n`, { mode: 0o600 })
  try {
    if (existing === undefined) {
      // link fails when another process created the file first; theirs wins.
      try {
        fs.linkSync(temporary, file)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      }
    } else {
      fs.renameSync(temporary, file)
    }
  } finally {
    fs.rmSync(temporary, { force: true })
  }
  const created = readSecret(file)
  if (created === undefined || !valid(created)) throw new Error(`Could not create ${file}`)
  return created
}

function readSecret(file: string): string | undefined {
  try {
    const stat = fs.statSync(file)
    if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) fs.chmodSync(file, 0o600)
    return fs.readFileSync(file, "utf8").trim()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

/** Creates the data root (or tightens it) so only this user can read it. */
export function ensurePrivateDirectory(directory = dataRoot()): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  if (process.platform !== "win32") fs.chmodSync(directory, 0o700)
}
