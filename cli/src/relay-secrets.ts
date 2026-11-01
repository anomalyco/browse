// The relay's local secret, in the data root (paths.ts) and readable only by this user:
//   relay-token   a bearer token every HTTP API request and CDP WebSocket must carry. The CLI, the MCP server and the
//                 relay's own Playwright connections read it from here.
// Pairing with browsers (short codes, per-browser tokens) is in browser-pairing.ts.
// Whoever needs a secret first creates it; creation is atomic, so a concurrent reader never sees a partial file.
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { dataRoot } from "./paths.ts"

export const relayTokenHeader = "authorization"
/** Query parameter that carries the token on CDP WebSocket URLs, for clients that can't set headers. */
export const relayTokenQueryParam = "opencodeBrowserToken"
const tokenPattern = /^[A-Za-z0-9_-]{43}$/

export function relayTokenPath(root = dataRoot()): string {
  return path.join(root, "relay-token")
}

/** The install's relay token, created on first use. */
export function relayToken(root = dataRoot()): string {
  return readOrCreateSecret(relayTokenPath(root), () => crypto.randomBytes(32).toString("base64url"), (value) => tokenPattern.test(value))
}

/** `Authorization` header value for relay requests. */
export function relayAuthorization(root = dataRoot()): string {
  return `Bearer ${relayToken(root)}`
}

/** Constant-time comparison of two secrets (or proofs) of any length. */
export function secretsEqual(expected: string, actual: string | undefined): boolean {
  if (actual === undefined) return false
  const a = crypto.createHash("sha256").update(expected).digest()
  const b = crypto.createHash("sha256").update(actual).digest()
  return crypto.timingSafeEqual(a, b) && expected.length === actual.length
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
