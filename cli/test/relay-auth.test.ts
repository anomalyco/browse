import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import type http from "node:http"
import os from "node:os"
import path from "node:path"
import * as ExtensionPairing from "../../src/background/pairing.ts"
import { hasRelayToken } from "../src/http-api.ts"
import {
  chromeWebStoreExtensionOrigin,
  stableUnpackedExtensionOrigin,
  validateBrowserFetchSite,
  validateHostHeader,
  validateWebSocketOrigin,
} from "../src/relay-helpers.ts"
import { formatPairingCode, pairingCode, pairingProof, relayToken, secretsEqual, writeExtensionPairing } from "../src/relay-secrets.ts"

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

  test("the extension link accepts only the two known extension ids", () => {
    expect(validateWebSocketOrigin({ origin: chromeWebStoreExtensionOrigin, requireChromeExtension: true })).toBeUndefined()
    expect(validateWebSocketOrigin({ origin: stableUnpackedExtensionOrigin, requireChromeExtension: true })).toBeUndefined()
    expect(validateWebSocketOrigin({ origin: "chrome-extension://aaaabbbbccccddddeeeeffffgggghhhh", requireChromeExtension: true })).toBeDefined()
    expect(validateWebSocketOrigin({ origin: undefined, requireChromeExtension: true })).toBeDefined()
    expect(validateWebSocketOrigin({ origin: "https://evil.test" })).toBeDefined()
    // CDP clients outside a browser (Playwright, the CLI) send no Origin; they carry the token instead.
    expect(validateWebSocketOrigin({ origin: undefined })).toBeUndefined()
  })
})

describe("pairing handshake", () => {
  const code = pairingCode(home)
  const relayNonce = ExtensionPairing.randomNonce()
  const extensionNonce = ExtensionPairing.randomNonce()

  test("the code is private and formatted for typing", () => {
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{32}$/)
    expect(fs.statSync(path.join(home, "extension-pairing")).mode & 0o777).toBe(0o600)
    expect(ExtensionPairing.normalizePairingCode(formatPairingCode(code).toLowerCase())).toBe(code)
  })

  test("the extension accepts the relay's proof, and the relay the extension's", async () => {
    // Relay → extension: the relay proves it knows the code over both nonces.
    const relayProof = pairingProof(code, "relay", relayNonce, extensionNonce)
    expect(ExtensionPairing.sameSecret(await ExtensionPairing.pairingProof(code, "relay", relayNonce, extensionNonce), relayProof)).toBe(true)
    // Extension → relay.
    const extensionProof = await ExtensionPairing.pairingProof(code, "extension", extensionNonce, relayNonce)
    expect(secretsEqual(pairingProof(code, "extension", extensionNonce, relayNonce), extensionProof)).toBe(true)
  })

  test("a wrong code, swapped role or replayed nonce is refused", async () => {
    const other = pairingCode(fs.mkdtempSync(path.join(home, "other-")))
    expect(other).not.toBe(code)
    const relayProof = pairingProof(other, "relay", relayNonce, extensionNonce)
    expect(ExtensionPairing.sameSecret(await ExtensionPairing.pairingProof(code, "relay", relayNonce, extensionNonce), relayProof)).toBe(false)
    const extensionProof = await ExtensionPairing.pairingProof(other, "extension", extensionNonce, relayNonce)
    expect(secretsEqual(pairingProof(code, "extension", extensionNonce, relayNonce), extensionProof)).toBe(false)
    // A relay can't answer the extension with the extension's own proof (reflection) or an old nonce.
    expect(secretsEqual(pairingProof(code, "relay", relayNonce, extensionNonce), pairingProof(code, "extension", relayNonce, extensionNonce))).toBe(false)
    expect(secretsEqual(pairingProof(code, "relay", relayNonce, extensionNonce), pairingProof(code, "relay", relayNonce, ExtensionPairing.randomNonce()))).toBe(false)
  })

  test("install writes the code into an unpacked extension folder", () => {
    const extension = fs.mkdtempSync(path.join(home, "extension-"))
    writeExtensionPairing(extension, code)
    const file = path.join(extension, "relay-pairing.json")
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ code })
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
  })
})
