import { afterAll, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  browserToken,
  ecdhExchange,
  issueBrowserToken,
  legacyPairingCodePath,
  mintPairingCode,
  pairingProof,
  pairingSessionKey,
  pendingPairingCodeKeys,
  consumePairingCode,
  sessionProof,
  wrapToken,
  type HandshakeTranscript,
} from "../../cli/src/browser-pairing.ts"
// Its globals (paths.ts reads one), for this project's typecheck.
import type {} from "../../cli/src/version.ts"
import { installChrome, settle } from "../chrome-stub"

// The extension's side of pairing (agent-relay.ts, pairing.ts) against a scripted relay built from the relay's own
// pairing functions (cli/src/browser-pairing.ts): a code is exchanged for a token, which the extension keeps and
// proves from then on; a refused code isn't tried again; the old shared code is upgraded to a token. Run by
// ../isolated.test.ts in a process of its own.

const stub = installChrome()
;(globalThis as { __OPENCODE_BROWSER_BUILD__?: string }).__OPENCODE_BROWSER_BUILD__ = "test"
const PORT = 19907
const ADDRESS = `127.0.0.1:${PORT}`
const root = fs.mkdtempSync(path.join(os.tmpdir(), "browse-exchange-"))
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))
type Message = { id?: number; method?: string; params?: Record<string, any> }

/** The relay's half of the handshake, as cli/src/relay.ts runs it, over a fake WebSocket. */
class ScriptedRelay {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static readonly made: ScriptedRelay[] = []
  static protocol: { min: number; version: number } | undefined
  readonly received: Message[] = []
  readyState = ScriptedRelay.CONNECTING
  onopen: ((event: unknown) => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: ((event: unknown) => void) | null = null
  paired = false
  private key = ""
  private nonces = { extension: "", relay: "" }
  private exchange: { secret: Buffer; transcript: HandshakeTranscript } | undefined
  private expected: string | undefined
  private issue: string | undefined
  constructor(readonly url: string) {
    ScriptedRelay.made.push(this)
    setTimeout(() => {
      this.readyState = ScriptedRelay.OPEN
      this.onopen?.({})
    }, 0)
  }
  send(data: string) {
    const message = JSON.parse(data) as Message
    this.received.push(message)
    const params = message.params ?? {}
    if (message.method === "hello") {
      const pairing = params.pairing as { nonce: string; mode: string; ecdh?: string }
      this.key = String(params.profileId)
      this.nonces = { extension: pairing.nonce, relay: crypto.randomUUID().replaceAll("-", "") }
      if (pairing.mode === "token") {
        const token = browserToken(this.key, root)
        if (!token) return this.close(4006, "Not paired")
        this.expected = pairingProof(token, "extension", PORT, this.nonces.extension, this.nonces.relay)
        return this.deliver({ method: "auth.challenge", params: { nonce: this.nonces.relay, proof: pairingProof(token, "relay", PORT, this.nonces.relay, this.nonces.extension) } })
      }
      const exchange = ecdhExchange(pairing.ecdh!)!
      const transcript = { port: PORT, extensionNonce: this.nonces.extension, relayNonce: this.nonces.relay, extensionKey: pairing.ecdh!, relayKey: exchange.publicKey }
      if (pairing.mode === "code") {
        this.exchange = { secret: exchange.secret, transcript }
        return this.deliver({ method: "auth.challenge", params: { nonce: this.nonces.relay, ecdh: exchange.publicKey, protocol: ScriptedRelay.protocol } })
      }
      const session = pairingSessionKey(fs.readFileSync(legacyPairingCodePath(root), "utf8").trim(), exchange.secret, transcript)
      this.issue = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")
      this.expected = pairingProof(this.issue, "extension", PORT, this.nonces.extension, this.nonces.relay)
      return this.deliver({ method: "auth.challenge", params: { nonce: this.nonces.relay, ecdh: exchange.publicKey, proof: sessionProof(session, "relay"), wrapped: wrapToken(session, this.issue) } })
    }
    if (message.method === "auth.code" && this.exchange) {
      const match = pendingPairingCodeKeys(root)
        .map((codeKey) => ({ codeKey, session: pairingSessionKey(codeKey, this.exchange!.secret, this.exchange!.transcript) }))
        .find(({ session }) => sessionProof(session, "extension") === params.proof)
      if (!match) return this.close(4006, "Pairing failed")
      consumePairingCode(match.codeKey, root)
      const token = issueBrowserToken(this.key, root)
      this.expected = pairingProof(token, "extension", PORT, this.nonces.extension, this.nonces.relay)
      return this.deliver({ method: "auth.token", params: { proof: sessionProof(match.session, "relay"), wrapped: wrapToken(match.session, token) } })
    }
    if (message.method === "auth.response") {
      if (params.proof !== this.expected) return this.close(4006, "Pairing failed")
      if (this.issue) issueBrowserToken(this.key, root, Date.now(), this.issue)
      this.paired = true
    }
  }
  deliver(message: Message) {
    this.onmessage?.({ data: JSON.stringify(message) })
  }
  close(code = 1000, reason = "") {
    if (this.readyState === ScriptedRelay.CLOSED) return
    this.readyState = ScriptedRelay.CLOSED
    setTimeout(() => this.onclose?.({ code, reason, wasClean: true }), 0)
  }
}

globalThis.fetch = (async () => new Response("not found", { status: 404 })) as unknown as typeof fetch
;(globalThis as { WebSocket: unknown }).WebSocket = ScriptedRelay

await stub.chrome.storage.local.set({ agentRelayPort: PORT })
const { createAgentRelay } = await import("../../src/background/agent-relay")
const relay = createAgentRelay({ changed: () => {}, badgesChanged: () => {} })
const last = () => ScriptedRelay.made.at(-1)!
const stored = async (key: string): Promise<any> => (await stub.chrome.storage.local.get(key))[key]
async function until(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 400 && !(await check()); i++) await settle()
  expect(await check()).toBe(true)
}

test("without a token or a code, it waits unpaired", async () => {
  await until(() => relay.state().status === "unpaired")
  await until(() => last()?.received.length === 1)
  expect(last().received[0]).toMatchObject({ method: "protocol", params: { unpaired: true } })
  expect(last().paired).toBe(false)
})

test("an entered code is exchanged for a token, which never crosses the connection in clear", async () => {
  const code = mintPairingCode(root)
  expect((await relay.connectTo("localhost", code.slice(0, 4) + "-" + code.slice(4).toLowerCase())).status).toBe("connected")
  expect(last().paired).toBe(true)
  const token = (await stored("agentRelayTokens"))[ADDRESS]
  const profile = (await stored("agentRelayProfile")).id
  expect(token).toBe(browserToken(profile, root))
  const wire = JSON.stringify(last().received)
  expect(wire).not.toContain(token)
  expect(wire).not.toContain(code)
  // The code did its one job: gone from the relay and from the extension.
  expect(pendingPairingCodeKeys(root)).toHaveLength(0)
  expect(await stored("agentRelayPairingCode")).toBeUndefined()
  expect(last().received.find((message) => message.method === "hello")?.params?.pairing.mode).toBe("code")
})

test("later connections prove the token", async () => {
  const before = ScriptedRelay.made.length
  last().close(1001)
  await until(() => relay.state().status !== "connected")
  relay.reconnect()
  await until(() => ScriptedRelay.made.length > before && last().paired)
  expect(last().received.find((message) => message.method === "hello")?.params?.pairing.mode).toBe("token")
  expect(relay.state().pairing).toBe("token")
})

test("a refused code is reported and not tried again; the token still works", async () => {
  const outcome = await relay.connectTo("", "ZZZZ-ZZZZ")
  expect(outcome.status).toBe("untrusted")
  expect(relay.state().codeRejected).toBe(true)
  expect(await stored("agentRelayPairingCode")).toBeUndefined()
  // The next attempt goes back to the token.
  relay.reconnect()
  await until(() => last().paired && relay.state().status === "connected")
  expect(last().received.find((message) => message.method === "hello")?.params?.pairing.mode).toBe("token")
  expect(relay.state().codeRejected).toBeUndefined()
})

test("a browser still holding the old shared code is upgraded to a token once", async () => {
  const legacy = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
  fs.writeFileSync(legacyPairingCodePath(root), `${legacy}\n`)
  await stub.chrome.storage.local.remove("agentRelayTokens")
  const before = ScriptedRelay.made.length
  await stub.chrome.storage.local.set({ agentRelayPairingCode: legacy })
  await until(() => ScriptedRelay.made.length > before && last().paired)
  expect(last().received.find((message) => message.method === "hello")?.params?.pairing.mode).toBe("legacy")
  const token = (await stored("agentRelayTokens"))[ADDRESS]
  expect(token).toBe(browserToken((await stored("agentRelayProfile")).id, root))
  expect(JSON.stringify(last().received)).not.toContain(legacy)
  expect(await stored("agentRelayPairingCode")).toBeUndefined()
})

test("first code pairing keeps the protocol range from the challenge, not the later auth.token", async () => {
  for (const version of [2, 4]) {
    ScriptedRelay.protocol = { min: version, version }
    const outcome = await relay.connectTo("localhost", mintPairingCode(root))
    expect(outcome.status).toBe("incompatible")
    expect(relay.state().skew).toBe(version === 2 ? "update-cli" : "update-extension")
  }
})
