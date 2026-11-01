import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import type http from "node:http"
import os from "node:os"
import path from "node:path"
import * as ExtensionPairing from "../../src/background/pairing.ts"
import { hasRelayToken } from "../src/http-api.ts"
import {
  stableUnpackedExtensionOrigin,
  validateBrowserFetchSite,
  validateHostHeader,
  validateWebSocketOrigin,
} from "../src/relay-helpers.ts"
import {
  browserTokensPath,
  consumePairingCode,
  ecdhExchange,
  formatPairingCode,
  issueBrowserToken,
  maxPairingFailures,
  mintPairingCode,
  pairingCodeKey,
  pairingCodesPath,
  pairingProof,
  pairingSessionKey,
  pendingPairingCodeKeys,
  readBrowserPairings,
  recordPairingFailure,
  revokeBrowserToken,
  sessionProof,
  wrapToken,
  writeExtensionPairing,
} from "../src/browser-pairing.ts"
import { relayToken, secretsEqual } from "../src/relay-secrets.ts"

const home = fs.mkdtempSync(path.join(os.tmpdir(), "browse-auth-"))
afterAll(() => fs.rmSync(home, { recursive: true, force: true }))

const request = (headers: http.IncomingHttpHeaders) => ({ headers }) as http.IncomingMessage

describe("relay token", () => {
  test("is created once, private, and stable", () => {
    const token = relayToken(home)
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(relayToken(home)).toBe(token)
    expect(fs.statSync(path.join(home, "relay-token")).mode & 0o777).toBe(0o600)
  })

  test("HTTP requests need the exact bearer token", () => {
    const token = relayToken(home)
    expect(hasRelayToken(request({ authorization: `Bearer ${token}` }), token)).toBe(true)
    expect(hasRelayToken(request({ authorization: `bearer ${token}` }), token)).toBe(true)
    expect(hasRelayToken(request({}), token)).toBe(false)
    expect(hasRelayToken(request({ authorization: token }), token)).toBe(false)
    expect(hasRelayToken(request({ authorization: `Bearer ${token}x` }), token)).toBe(false)
    expect(hasRelayToken(request({ authorization: `Bearer ${token.slice(0, -1)}` }), token)).toBe(false)
  })

  test("secretsEqual compares whole values", () => {
    expect(secretsEqual("abc", "abc")).toBe(true)
    expect(secretsEqual("abc", "abcd")).toBe(false)
    expect(secretsEqual("abc", undefined)).toBe(false)
  })
})

describe("Host, Origin and Sec-Fetch-Site checks", () => {
  test("accept loopback hosts on the relay's port only", () => {
    for (const hostHeader of ["127.0.0.1:19988", "localhost:19988", "[::1]:19988", "127.0.0.1"]) {
      expect(validateHostHeader({ hostHeader, host: "127.0.0.1", port: 19988 })).toBeUndefined()
    }
    expect(validateHostHeader({ hostHeader: "127.0.0.1:1234", host: "127.0.0.1", port: 19988 })).toBe("Invalid Host header port")
    expect(validateHostHeader({ hostHeader: "evil.test:19988", host: "127.0.0.1", port: 19988 })).toBe("Invalid Host header")
    expect(validateHostHeader({ hostHeader: undefined, host: "127.0.0.1", port: 19988 })).toBe("Invalid Host header")
  })

  test("refuse cross-site browser requests", () => {
    expect(validateBrowserFetchSite(request({}))).toBeUndefined()
    expect(validateBrowserFetchSite(request({ "sec-fetch-site": "same-origin" }))).toBeUndefined()
    expect(validateBrowserFetchSite(request({ "sec-fetch-site": "cross-site" }))).toBeDefined()
    expect(validateBrowserFetchSite(request({ "sec-fetch-site": "same-site" }))).toBeDefined()
  })

  test("the extension link accepts the unpacked id and configured store items only", () => {
    const store = "chrome-extension://abcdefghijklmnopabcdefghijklmnop"
    expect(validateWebSocketOrigin({ origin: stableUnpackedExtensionOrigin, requireChromeExtension: true })).toBeUndefined()
    expect(validateWebSocketOrigin({ origin: store, requireChromeExtension: true })).toBeDefined()
    expect(validateWebSocketOrigin({ origin: store, requireChromeExtension: true, additionalChromeExtensionOrigins: new Set([store]) })).toBeUndefined()
    // The store ID earlier builds hard-coded is accepted only once a release configures it.
    expect(validateWebSocketOrigin({ origin: "chrome-extension://mfnicocicmmlkpjnaffgihfjhdgjkdjg", requireChromeExtension: true })).toBeDefined()
    expect(validateWebSocketOrigin({ origin: "chrome-extension://aaaabbbbccccddddeeeeffffgggghhhh", requireChromeExtension: true })).toBeDefined()
    expect(validateWebSocketOrigin({ origin: undefined, requireChromeExtension: true })).toBeDefined()
    expect(validateWebSocketOrigin({ origin: "https://evil.test" })).toBeDefined()
    // CDP clients outside a browser (Playwright, the CLI) send no Origin; they carry the token instead.
    expect(validateWebSocketOrigin({ origin: undefined })).toBeUndefined()
  })
})

describe("pairing codes", () => {
  const root = () => fs.mkdtempSync(path.join(home, "codes-"))

  test("are short, typed loosely, stored only as a slow hash, privately", () => {
    const dir = root()
    const code = mintPairingCode(dir)
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/)
    expect(formatPairingCode(code)).toBe(`${code.slice(0, 4)}-${code.slice(4)}`)
    expect(ExtensionPairing.normalizePairingCode(formatPairingCode(code).toLowerCase())).toEqual({ code, legacy: false })
    const file = fs.readFileSync(pairingCodesPath(dir), "utf8")
    expect(file).not.toContain(code)
    expect(pendingPairingCodeKeys(dir)).toEqual([pairingCodeKey(code)])
    expect(fs.statSync(pairingCodesPath(dir)).mode & 0o777).toBe(0o600)
  })

  test("the extension derives the same key", async () => {
    const code = mintPairingCode(root())
    expect(await ExtensionPairing.pairingCodeMaterial({ code, legacy: false })).toBe(pairingCodeKey(code))
  })

  test("work once", () => {
    const dir = root()
    const first = mintPairingCode(dir)
    const second = mintPairingCode(dir)
    consumePairingCode(pairingCodeKey(first), dir)
    expect(pendingPairingCodeKeys(dir)).toEqual([pairingCodeKey(second)])
  })

  test("expire after ten minutes (an hour for the one install writes into an unpacked build)", () => {
    const dir = root()
    const now = Date.now()
    const code = mintPairingCode(dir, { now })
    const bundled = mintPairingCode(dir, { now, ttlMs: 60 * 60_000 })
    expect(pendingPairingCodeKeys(dir, now + 9 * 60_000)).toHaveLength(2)
    expect(pendingPairingCodeKeys(dir, now + 11 * 60_000)).toEqual([pairingCodeKey(bundled)])
    expect(pendingPairingCodeKeys(dir, now + 61 * 60_000)).toEqual([])
    expect(code).not.toBe(bundled)
  })

  test("are all thrown away after five wrong guesses", () => {
    const dir = root()
    mintPairingCode(dir)
    for (let attempt = 1; attempt < maxPairingFailures; attempt++) expect(recordPairingFailure(dir)).toBe(false)
    expect(pendingPairingCodeKeys(dir)).toHaveLength(1)
    expect(recordPairingFailure(dir)).toBe(true)
    expect(pendingPairingCodeKeys(dir)).toEqual([])
    // A new code gets the full allowance again.
    mintPairingCode(dir)
    expect(recordPairingFailure(dir)).toBe(false)
  })
})

describe("browser tokens", () => {
  test("are per browser, private, and revocable", () => {
    const dir = fs.mkdtempSync(path.join(home, "tokens-"))
    const work = issueBrowserToken("work", dir)
    const personal = issueBrowserToken("personal", dir)
    expect(work).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(work).not.toBe(personal)
    expect(fs.statSync(browserTokensPath(dir)).mode & 0o777).toBe(0o600)
    expect(revokeBrowserToken("work", dir)).toBe(true)
    expect(Object.keys(readBrowserPairings(dir))).toEqual(["personal"])
    expect(revokeBrowserToken("work", dir)).toBe(false)
  })
})

describe("code exchange", () => {
  test("the extension and the relay agree on the session key, and the token unmasks only with it", async () => {
    const port = 19988
    const code = mintPairingCode(fs.mkdtempSync(path.join(home, "exchange-")))
    const extensionKeys = await ExtensionPairing.ecdhKeyPair()
    const relay = ecdhExchange(extensionKeys.publicKey)!
    const transcript = { port, extensionNonce: ExtensionPairing.randomNonce(), relayNonce: ExtensionPairing.randomNonce(), extensionKey: extensionKeys.publicKey, relayKey: relay.publicKey }
    const relaySession = pairingSessionKey(pairingCodeKey(code), relay.secret, transcript)
    const secret = (await extensionKeys.secret(relay.publicKey))!
    const extensionSession = await ExtensionPairing.pairingSessionKey(await ExtensionPairing.pairingCodeMaterial({ code, legacy: false }), secret, transcript)
    expect(Buffer.from(extensionSession).equals(relaySession)).toBe(true)
    expect(await ExtensionPairing.sessionProof(extensionSession, "extension")).toBe(sessionProof(relaySession, "extension"))
    const token = issueBrowserToken("x", fs.mkdtempSync(path.join(home, "exchange-")))
    const wrapped = wrapToken(relaySession, token)
    expect(wrapped).not.toBe(token)
    expect(await ExtensionPairing.unwrapToken(extensionSession, wrapped)).toBe(token)
    // Someone who knows the code but not the ECDH secret (a passive observer who guessed it) gets nothing.
    const guessed = pairingSessionKey(pairingCodeKey(code), Buffer.alloc(32), transcript)
    expect(await ExtensionPairing.unwrapToken(guessed, wrapped)).not.toBe(token)
  })

  test("a relay public key that isn't one is refused", async () => {
    expect(ecdhExchange("not-a-key")).toBeUndefined()
    expect(await (await ExtensionPairing.ecdhKeyPair()).secret("x")).toBeUndefined()
  })
})

describe("token handshake", () => {
  const code = issueBrowserToken("test", home)
  const relayNonce = ExtensionPairing.randomNonce()
  const extensionNonce = ExtensionPairing.randomNonce()
  const port = 19988

  test("the extension accepts the relay's proof, and the relay the extension's", async () => {
    // Relay → extension: the relay proves it knows the code over both nonces.
    const relayProof = pairingProof(code, "relay", port, relayNonce, extensionNonce)
    expect(ExtensionPairing.sameSecret(await ExtensionPairing.pairingProof(code, "relay", port, relayNonce, extensionNonce), relayProof)).toBe(true)
    // Extension → relay.
    const extensionProof = await ExtensionPairing.pairingProof(code, "extension", port, extensionNonce, relayNonce)
    expect(secretsEqual(pairingProof(code, "extension", port, extensionNonce, relayNonce), extensionProof)).toBe(true)
  })

  test("a wrong code, swapped role or replayed nonce is refused", async () => {
    const other = issueBrowserToken("other", fs.mkdtempSync(path.join(home, "other-")))
    expect(other).not.toBe(code)
    const relayProof = pairingProof(other, "relay", port, relayNonce, extensionNonce)
    expect(ExtensionPairing.sameSecret(await ExtensionPairing.pairingProof(code, "relay", port, relayNonce, extensionNonce), relayProof)).toBe(false)
    const extensionProof = await ExtensionPairing.pairingProof(other, "extension", port, extensionNonce, relayNonce)
    expect(secretsEqual(pairingProof(code, "extension", port, extensionNonce, relayNonce), extensionProof)).toBe(false)
    // A relay can't answer the extension with the extension's own proof (reflection) or an old nonce.
    expect(secretsEqual(pairingProof(code, "relay", port, relayNonce, extensionNonce), pairingProof(code, "extension", port, relayNonce, extensionNonce))).toBe(false)
    expect(secretsEqual(pairingProof(code, "relay", port, relayNonce, extensionNonce), pairingProof(code, "relay", port, relayNonce, ExtensionPairing.randomNonce()))).toBe(false)
  })

  test("a proof made for another relay port is refused", async () => {
    // A listener on another port that passes the handshake through to this relay: the extension proves for the port
    // it dialled, the relay checks against its own.
    const forwardedExtensionProof = await ExtensionPairing.pairingProof(code, "extension", 19989, extensionNonce, relayNonce)
    expect(secretsEqual(pairingProof(code, "extension", port, extensionNonce, relayNonce), forwardedExtensionProof)).toBe(false)
    const forwardedRelayProof = pairingProof(code, "relay", port, relayNonce, extensionNonce)
    expect(ExtensionPairing.sameSecret(await ExtensionPairing.pairingProof(code, "relay", 19989, relayNonce, extensionNonce), forwardedRelayProof)).toBe(false)
    expect(ExtensionPairing.pairingEndpoint(port)).toBe("127.0.0.1:19988/extension")
  })

  test("install writes a one-time code into an unpacked extension folder", () => {
    const extension = fs.mkdtempSync(path.join(home, "extension-"))
    const pending = mintPairingCode(fs.mkdtempSync(path.join(home, "install-")))
    writeExtensionPairing(extension, pending)
    const file = path.join(extension, "relay-pairing.json")
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ code: pending })
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
  })
})
