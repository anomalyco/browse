// The extension's half of pairing (cli/src/browser-pairing.ts has the relay's, and the whole protocol; keep the
// formats in step). A short code from `pair` is exchanged once, over ephemeral ECDH, for a token of this browser's own;
// every later connection proves the token with an HMAC over fresh nonces and the relay link's endpoint (its port), so
// a program on another port can't pass the handshake through to the real relay.

const CONTEXT = "opencode-browser-pairing-v3"
const CROCKFORD = "[0-9A-HJKMNP-TV-Z]"
/** `pair` prints 8 characters (shown as XXXX-XXXX); earlier versions shared one of 32. */
const CODE = new RegExp(`^${CROCKFORD}{8}$`)
const LEGACY_CODE = new RegExp(`^${CROCKFORD}{32}$`)
const encoder = new TextEncoder()

export type PairingCode = { code: string; legacy: boolean }

/** A typed or bundled code in canonical form, or undefined when it can't be a pairing code. */
export function normalizePairingCode(input: unknown): PairingCode | undefined {
  if (typeof input !== "string") return undefined
  const code = input.toUpperCase().replace(/[\s-]/g, "").replace(/[IL]/g, "1").replace(/O/g, "0")
  if (CODE.test(code)) return { code, legacy: false }
  if (LEGACY_CODE.test(code)) return { code, legacy: true }
  return undefined
}

export function randomNonce() {
  return base64url(crypto.getRandomValues(new Uint8Array(32)))
}

/** The relay link the proofs are bound to. */
export function pairingEndpoint(port: number) {
  return `127.0.0.1:${port}/extension`
}

/** The token proof `role` sends: HMAC(token, context | role | endpoint | peer's nonce | own nonce). */
export async function pairingProof(token: string, role: "relay" | "extension", port: number, ownNonce: string, peerNonce: string) {
  return base64url(await hmac(encoder.encode(token), `${CONTEXT}|${role}|${pairingEndpoint(port)}|${peerNonce}|${ownNonce}`))
}

/** Compares a proof without returning early on the first difference. */
export function sameSecret(expected: string, actual: unknown) {
  if (typeof actual !== "string" || actual.length !== expected.length) return false
  let difference = 0
  for (let index = 0; index < expected.length; index++) difference |= expected.charCodeAt(index) ^ actual.charCodeAt(index)
  return difference === 0
}

/** The key material a code stands for: a short code's PBKDF2 (hex, as the relay stores it), or the old code itself. */
export async function pairingCodeMaterial(code: PairingCode) {
  if (code.legacy) return code.code
  const key = await crypto.subtle.importKey("raw", encoder.encode(code.code), "PBKDF2", false, ["deriveBits"])
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: encoder.encode(`${CONTEXT}|code`), iterations: 100_000 }, key, 256)
  return Array.from(new Uint8Array(bits), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

/** This side of an ephemeral ECDH exchange (P-256): the public key to send, and how to derive the shared secret. */
export async function ecdhKeyPair() {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"])
  const publicKey = base64url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)))
  return {
    publicKey,
    /** The shared secret with the relay's public key, or undefined when it isn't one. */
    async secret(peer: unknown) {
      if (typeof peer !== "string" || !/^[A-Za-z0-9_-]{87}$/.test(peer)) return undefined
      try {
        const key = await crypto.subtle.importKey("raw", fromBase64url(peer), { name: "ECDH", namedCurve: "P-256" }, false, [])
        return new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: key }, pair.privateKey, 256))
      } catch {
        return undefined
      }
    },
  }
}

export type HandshakeTranscript = { port: number; extensionNonce: string; relayNonce: string; extensionKey: string; relayKey: string }

/** The key a code exchange runs under (browser-pairing.ts pairingSessionKey). */
export async function pairingSessionKey(material: string, secret: Uint8Array, transcript: HandshakeTranscript) {
  const text = encoder.encode(
    `${CONTEXT}|session|${pairingEndpoint(transcript.port)}|${transcript.extensionNonce}|${transcript.relayNonce}|${transcript.extensionKey}|${transcript.relayKey}|`,
  )
  const message = new Uint8Array(text.length + secret.length)
  message.set(text)
  message.set(secret, text.length)
  return hmac(encoder.encode(material), message)
}

export async function sessionProof(sessionKey: Uint8Array, role: "relay" | "extension") {
  return base64url(await hmac(sessionKey, `${CONTEXT}|proof|${role}`))
}

/** The token the relay masked under the session key (browser-pairing.ts wrapToken), or undefined. */
export async function unwrapToken(sessionKey: Uint8Array, wrapped: unknown) {
  if (typeof wrapped !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(wrapped)) return undefined
  const mask = await hmac(sessionKey, `${CONTEXT}|wrap`)
  return base64url(fromBase64url(wrapped).map((byte, index) => byte ^ mask[index]!))
}

async function hmac(key: Uint8Array, message: string | Uint8Array) {
  const imported = await crypto.subtle.importKey("raw", key as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  return new Uint8Array(await crypto.subtle.sign("HMAC", imported, (typeof message === "string" ? encoder.encode(message) : message) as BufferSource))
}

function fromBase64url(text: string) {
  return Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (char) => char.charCodeAt(0))
}

function base64url(bytes: Uint8Array) {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}
