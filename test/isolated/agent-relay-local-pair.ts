import { afterAll, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  browserToken,
  ecdhExchange,
  issueBrowserToken,
  pairingProof,
  pairingSessionKey,
  sessionProof,
  wrapToken,
} from "../../cli/src/relay/browser-pairing.ts"
import type {} from "../../cli/src/version.ts"
import { installChrome, settle } from "../chrome-stub"

const stub = installChrome()
;(globalThis as { __OPENCODE_BROWSER_BUILD__?: string }).__OPENCODE_BROWSER_BUILD__ = "test"
const PORT = 19918
const ADDRESS = `127.0.0.1:${PORT}`
const root = fs.mkdtempSync(path.join(os.tmpdir(), "browse-local-pair-"))
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))
type Message = { id?: number; method?: string; params?: Record<string, any> }

class LocalPairRelay {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static readonly made: LocalPairRelay[] = []
  static allowLocal = true
  readonly received: Message[] = []
  readyState = LocalPairRelay.CONNECTING
  onopen: ((event: unknown) => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: ((event: unknown) => void) | null = null
  private key = ""
  private nonces = { extension: "", relay: "" }
  private expected: string | undefined
  private issue: string | undefined
  constructor(readonly url: string) {
    LocalPairRelay.made.push(this)
    setTimeout(() => {
      this.readyState = LocalPairRelay.OPEN
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
        return this.deliver({
          method: "auth.challenge",
          params: {
            nonce: this.nonces.relay,
            proof: pairingProof(token, "relay", PORT, this.nonces.relay, this.nonces.extension),
          },
        })
      }
      if (pairing.mode === "local") {
        if (!LocalPairRelay.allowLocal) return this.close(4006, "Local auto-pairing is disabled")
        const exchange = ecdhExchange(pairing.ecdh!)!
        const transcript = {
          port: PORT,
          extensionNonce: this.nonces.extension,
          relayNonce: this.nonces.relay,
          extensionKey: pairing.ecdh!,
          relayKey: exchange.publicKey,
        }
        const session = pairingSessionKey("local", exchange.secret, transcript)
        this.issue = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")
        this.expected = pairingProof(this.issue, "extension", PORT, this.nonces.extension, this.nonces.relay)
        return this.deliver({
          method: "auth.challenge",
          params: {
            nonce: this.nonces.relay,
            ecdh: exchange.publicKey,
            proof: sessionProof(session, "relay"),
            wrapped: wrapToken(session, this.issue),
          },
        })
      }
      return this.close(4006, "Unsupported mode")
    }
    if (message.method === "auth.response") {
      if (params.proof !== this.expected) return this.close(4006, "Wrong proof")
      if (this.issue) issueBrowserToken(this.key, root, Date.now(), this.issue)
      return
    }
  }
  deliver(message: Message) {
    setTimeout(() => {
      if (this.readyState === LocalPairRelay.OPEN) this.onmessage?.({ data: JSON.stringify(message) })
    }, 0)
  }
  close(code = 1000, reason = "") {
    if (this.readyState === LocalPairRelay.CLOSED) return
    this.readyState = LocalPairRelay.CLOSED
    setTimeout(() => this.onclose?.({ code, reason }), 0)
  }
}

;(globalThis as { WebSocket: unknown }).WebSocket = LocalPairRelay
const storage = stub.chrome.storage.local as unknown as {
  set: (items: Record<string, unknown>) => Promise<void>
  get: (keys: string | string[]) => Promise<Record<string, unknown>>
  remove: (keys: string | string[]) => Promise<void>
}
const managed = stub.chrome.storage.managed as unknown as {
  set: (items: Record<string, unknown>) => Promise<void>
  remove: (keys: string | string[]) => Promise<void>
}

await storage.set({ agentRelayPort: PORT })
await managed.set({ autoPairLocalRelay: true })

const { createAgentRelay } = await import("../../src/background/agent-relay")
const { TOKENS_KEY } = await import("../../src/background/agent-relay/wire")

const until = async (check: () => boolean, limit = 120) => {
  for (let attempt = 0; attempt < limit; attempt++) {
    if (check()) return
    await settle()
  }
  throw new Error("condition timed out")
}
const last = () => LocalPairRelay.made.at(-1)!

test("autoPairLocalRelay exchanges ECDH for a per-browser token and uses token auth on reconnect", async () => {
  const relay = createAgentRelay({ changed() {}, badgesChanged() {} })
  await until(() => relay.state().status === "connected")

  const firstHello = last().received.find((message) => message.method === "hello")
  expect(firstHello?.params?.pairing.mode).toBe("local")
  expect(typeof firstHello?.params?.pairing.ecdh).toBe("string")

  const storedTokens = (await storage.get(TOKENS_KEY))[TOKENS_KEY] as Record<string, string>
  expect(typeof storedTokens[ADDRESS]).toBe("string")
  expect(storedTokens[ADDRESS]!.length).toBeGreaterThan(20)

  // Subsequent reconnect uses the issued per-browser token, not mode "local".
  const countBefore = LocalPairRelay.made.length
  last().close(1006)
  await until(() => relay.state().status !== "connected")
  relay.reconnect()
  await until(() => LocalPairRelay.made.length > countBefore && relay.state().status === "connected")
  const secondHello = last().received.find((message) => message.method === "hello")
  expect(secondHello?.params?.pairing.mode).toBe("token")
  expect(relay.state().pairing).toBe("token")

  // If the browser's token is later revoked on the relay, it does NOT silently re-pair with mode "local".
  fs.rmSync(path.join(root, "browser-tokens.json"), { force: true })
  const countBeforeRevoke = LocalPairRelay.made.length
  last().close(1006)
  await until(() => relay.state().status !== "connected")
  relay.reconnect()
  await until(() => LocalPairRelay.made.length > countBeforeRevoke && relay.state().status === "untrusted")
  const revokedHello = last().received.find((message) => message.method === "hello")
  expect(revokedHello?.params?.pairing.mode).toBe("token")

  // Remote relay address never uses autoPairLocalRelay.
  await storage.remove(TOKENS_KEY)
  await managed.set({ relayAddress: "100.64.0.2:19988", autoPairLocalRelay: true })
  await until(() => relay.state().relay.remote && relay.state().status === "unpaired")
  expect(relay.state().pairing).toBe("none")
})
