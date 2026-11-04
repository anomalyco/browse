import { expect, test } from "bun:test"
import type { AgentRelayState } from "../../src/shared/protocol"
import { installChrome, settle } from "../chrome-stub"
import { installFakeRelaySocket } from "../relay-stub"

// The update notice: the relay's update check reaches the status page through the extension link (update.notice),
// and an empty notice clears it. Run by ../isolated.test.ts in a process of its own (its relay keeps chrome listeners
// and a WebSocket).

const stub = installChrome()
;(globalThis as { __OPENCODE_BROWSER_BUILD__?: string }).__OPENCODE_BROWSER_BUILD__ = "test"
/** This browser's token for the relay, as a code exchange left it. */
const TOKEN = "test-token-0123456789abcdefghijklmnopqrstuv"
const PORT = 19908
const socket = installFakeRelaySocket({ port: PORT, token: TOKEN })

await stub.chrome.storage.local.set({ agentRelayPort: PORT, agentRelayTokens: { [`127.0.0.1:${PORT}`]: TOKEN } })
const { createAgentRelay } = await import("../../src/background/agent-relay")
const states: AgentRelayState[] = []
const relay = createAgentRelay({ changed: (state) => states.push(state), badgesChanged: () => {} })

async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await settle()
  expect(check()).toBe(true)
}
let nextCommand = 1
async function command(method: string, params?: Record<string, unknown>) {
  const id = nextCommand++
  socket().deliver({ id, method, ...(params ? { params } : {}) })
  await until(() => socket().received.some((message) => message.id === id))
  return socket().received.find((message) => message.id === id)!
}

await until(() => relay.state().status === "connected")

test("no update is shown until the relay reports one", () => {
  expect(relay.state().update).toBeUndefined()
})

test("the relay's notice reaches the status page's state", async () => {
  const notice = { summary: "3 new commits on origin/main", command: "node /src/browse/cli/dist/cli.mjs update" }
  expect((await command("update.notice", notice)).error).toBeUndefined()
  expect(relay.state().update).toEqual(notice)
  expect(states.at(-1)?.update).toEqual(notice)
})

test("an empty notice (updated, or the check turned off) clears it", async () => {
  expect((await command("update.notice")).error).toBeUndefined()
  expect(relay.state().update).toBeUndefined()
  expect(states.at(-1)?.update).toBeUndefined()
})
