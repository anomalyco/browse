import { expect, test } from "bun:test"
import { installChrome, settle } from "../chrome-stub"
import { installFakeRelaySocket } from "../relay-stub"

// Tokens are stored per `host:port`, but the relay may move to a fallback port. With no token under the new port, the
// worker falls back to the last loopback token it has; the relay's proof is bound to the port, so a wrong relay just
// refuses it. A successful handshake then stores the token under the new port too. Run by ../isolated.test.ts.

const stub = installChrome()
;(globalThis as { __OPENCODE_BROWSER_BUILD__?: string }).__OPENCODE_BROWSER_BUILD__ = "test"

const TOKEN = "test-token-0123456789abcdefghijklmnopqrstuv"
const OLD_PORT = 19988
const BROWSER_PORT = 19990
installFakeRelaySocket({ port: BROWSER_PORT, token: TOKEN })

await stub.chrome.storage.local.set({
  agentRelayDiscoveredPort: BROWSER_PORT,
  agentRelayTokens: { [`127.0.0.1:${OLD_PORT}`]: TOKEN },
})
const { createAgentRelay } = await import("../../src/background/agent-relay")
const relay = createAgentRelay({ changed: () => {}, badgesChanged: () => {} })
const stored = async (key: string): Promise<unknown> => (await stub.chrome.storage.local.get(key))[key]
async function until(check: () => boolean) {
  for (let i = 0; i < 400 && !check(); i++) await settle()
  expect(check()).toBe(true)
}

test("a relay on a new loopback port keeps the token this browser had", async () => {
  await until(() => relay.state().status === "connected")
  expect(relay.state().pairing).toBe("token")
  // Stored under the new key too, with the original entry untouched.
  expect(await stored("agentRelayTokens")).toEqual({
    [`127.0.0.1:${OLD_PORT}`]: TOKEN,
    [`127.0.0.1:${BROWSER_PORT}`]: TOKEN,
  })
})
