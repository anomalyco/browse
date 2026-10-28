// The relay's two local secrets, both in the data root (paths.ts) and readable only by this user:
//   relay-token         a bearer token every HTTP API request and CDP WebSocket must carry. The CLI, the MCP server
//                       and the relay's own Playwright connections read it from here.
//   extension-pairing   the code shared with the browser extension. The relay and the extension prove to each other
//                       that they know it (an HMAC over fresh nonces) before the extension obeys any command.
//                       `install` writes it into the unpacked extension (relay-pairing.json); a Chrome Web Store
//                       build gets it typed into its status page (`opencode-browser pair` prints it).
//   pairing-ticket.json a one-time ticket `install` puts in the URL it opens for a store build (welcome.html#ticket=...):
//                       the relay exchanges it once, within two minutes, for the pairing code over the handshake, so a
//                       ticket seen in a process list is useless after the extension used it (or after it expired).
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
const pairingContext = "opencode-browser-pairing-v2"
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

/** The relay link the pairing proofs are bound to (src/background/pairing.ts builds the same string). */
export function pairingEndpoint(port: number): string {
  return `127.0.0.1:${port}/extension`
}

/**
 * HMAC-SHA256 proof over the handshake nonces and the relay link's endpoint, base64url. `role` is who proves: "relay"
 * or "extension". Binding the port means a listener on another port can't relay the handshake to this relay: the
 * extension computes its proofs for the port it dialled.
 */
export function pairingProof(code: string, role: "relay" | "extension", port: number, ownNonce: string, peerNonce: string): string {
  return crypto.createHmac("sha256", code).update(`${pairingContext}|${role}|${pairingEndpoint(port)}|${peerNonce}|${ownNonce}`).digest("base64url")
}

/** How long a pairing ticket stays valid. */
export const pairingTicketTtlMs = 2 * 60_000

export function pairingTicketPath(root = dataRoot()): string {
  return path.join(root, "pairing-ticket.json")
}

/** The key both sides derive from a ticket: its SHA-256, hex. Only this is stored. */
export function pairingTicketKey(ticket: string): string {
  return crypto.createHash("sha256").update(ticket).digest("hex")
}

/** Creates a one-time pairing ticket (replacing any earlier one) and returns it; only its key is written to disk. */
export function mintPairingTicket(root = dataRoot(), now = Date.now()): string {
  ensurePrivateDirectory(root)
  const ticket = generatePairingCode()
  const file = pairingTicketPath(root)
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify({ key: pairingTicketKey(ticket), expiresAt: now + pairingTicketTtlMs })}\n`, { mode: 0o600 })
  fs.renameSync(temporary, file)
  return ticket
}

/** The current ticket's key when one exists and hasn't expired (an expired one is removed). */
export function peekPairingTicket(root = dataRoot(), now = Date.now()): string | undefined {
  const file = pairingTicketPath(root)
  let record: { key?: unknown; expiresAt?: unknown } | undefined
  try {
    record = JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    return undefined
  }
  const valid = typeof record?.key === "string" && /^[0-9a-f]{64}$/.test(record.key) && typeof record.expiresAt === "number" && now <= record.expiresAt
  if (!valid) fs.rmSync(file, { force: true })
  return valid ? (record!.key as string) : undefined
}

/**
 * Uses up the ticket with this key, once an extension proved it got the code through it. Consuming only then means a
 * program that merely claims a ticket can't burn it; a completed exchange makes it worthless.
 */
export function consumePairingTicket(key: string, root = dataRoot()): void {
  const file = pairingTicketPath(root)
  try {
    if ((JSON.parse(fs.readFileSync(file, "utf8")) as { key?: unknown }).key === key) fs.rmSync(file, { force: true })
  } catch {}
}

/** The pairing code, masked for the extension that proved it holds the ticket: code XOR HMAC(key, nonces), base64url. */
export function wrapPairingCode(key: string, code: string, port: number, extensionNonce: string, relayNonce: string): string {
  const mask = crypto.createHmac("sha256", key).update(`${pairingContext}|wrap|${pairingEndpoint(port)}|${extensionNonce}|${relayNonce}`).digest()
  const bytes = Buffer.from(code, "ascii")
  return Buffer.from(bytes.map((byte, index) => byte ^ mask[index]!)).toString("base64url")
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
