// The extension's half of the relay pairing handshake (cli/src/relay-secrets.ts has the relay's). Both sides prove
// they know the pairing code with an HMAC-SHA256 over the two fresh nonces and the relay link's endpoint (its port), so
// a program on another port can't pass the handshake through to the real relay; keep the message format in step.

const CONTEXT = "opencode-browser-pairing-v2"
/** Crockford base32, the alphabet `opencode-browser pair` prints. */
const CODE = /^[0-9A-HJKMNP-TV-Z]{32}$/

/** A typed or bundled code in canonical form, or undefined when it can't be a pairing code. */
export function normalizePairingCode(input: unknown): string | undefined {
  if (typeof input !== "string") return undefined
  const code = input.toUpperCase().replace(/[\s-]/g, "").replace(/[IL]/g, "1").replace(/O/g, "0")
  return CODE.test(code) ? code : undefined
}

export function randomNonce() {
  return base64url(crypto.getRandomValues(new Uint8Array(32)))
}

/** The relay link the proofs are bound to. */
export function pairingEndpoint(port: number) {
  return `127.0.0.1:${port}/extension`
}

/** The proof `role` sends: HMAC(code, context | role | endpoint | peer's nonce | own nonce). */
export async function pairingProof(code: string, role: "relay" | "extension", port: number, ownNonce: string, peerNonce: string) {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey("raw", encoder.encode(code), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  const message = `${CONTEXT}|${role}|${pairingEndpoint(port)}|${peerNonce}|${ownNonce}`
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message))
  return base64url(new Uint8Array(signature))
}

/** Compares a proof without returning early on the first difference. */
export function sameSecret(expected: string, actual: unknown) {
  if (typeof actual !== "string" || actual.length !== expected.length) return false
  let difference = 0
  for (let index = 0; index < expected.length; index++) difference |= expected.charCodeAt(index) ^ actual.charCodeAt(index)
  return difference === 0
}

/** The key a one-time pairing ticket stands for (cli/src/relay-secrets.ts pairingTicketKey): its SHA-256, hex. */
export async function pairingTicketKey(ticket: string) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ticket)))
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")
}

/** The pairing code the relay masked for a ticket holder (relay-secrets.ts wrapPairingCode), or undefined. */
export async function unwrapPairingCode(key: string, wrapped: unknown, port: number, ownNonce: string, relayNonce: string) {
  if (typeof wrapped !== "string" || !/^[A-Za-z0-9_-]{20,64}$/.test(wrapped)) return undefined
  const encoder = new TextEncoder()
  const hmac = await crypto.subtle.importKey("raw", encoder.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  const mask = new Uint8Array(await crypto.subtle.sign("HMAC", hmac, encoder.encode(`${CONTEXT}|wrap|${pairingEndpoint(port)}|${ownNonce}|${relayNonce}`)))
  const bytes = Uint8Array.from(atob(wrapped.replace(/-/g, "+").replace(/_/g, "/")), (char) => char.charCodeAt(0))
  if (bytes.length > mask.length) return undefined
  return normalizePairingCode(String.fromCharCode(...bytes.map((byte, index) => byte ^ mask[index]!)))
}

function base64url(bytes: Uint8Array) {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}
