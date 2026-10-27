// The extension's half of the relay pairing handshake (cli/src/relay-secrets.ts has the relay's). Both sides prove
// they know the pairing code with an HMAC-SHA256 over the two fresh nonces; keep the message format in step.

const CONTEXT = "opencode-browser-pairing-v1"
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

/** The proof `role` sends: HMAC(code, context | role | peer's nonce | own nonce). */
export async function pairingProof(code: string, role: "relay" | "extension", ownNonce: string, peerNonce: string) {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey("raw", encoder.encode(code), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(`${CONTEXT}|${role}|${peerNonce}|${ownNonce}`))
  return base64url(new Uint8Array(signature))
}

/** Compares a proof without returning early on the first difference. */
export function sameSecret(expected: string, actual: unknown) {
  if (typeof actual !== "string" || actual.length !== expected.length) return false
  let difference = 0
  for (let index = 0; index < expected.length; index++) difference |= expected.charCodeAt(index) ^ actual.charCodeAt(index)
  return difference === 0
}

function base64url(bytes: Uint8Array) {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}
