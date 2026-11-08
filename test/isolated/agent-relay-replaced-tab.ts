import { expect, test } from "bun:test"
import { installChrome, settle, type StubEvent } from "../chrome-stub"
import { installFakeRelaySocket } from "../relay-stub"

// A tab Chrome swaps for another (a discard, a prerender) fires tabs.onReplaced with a new id and no onRemoved for the
// old one. The relay hears that the old tab is gone, as for a closed tab, or it keeps a target Chrome answers "No tab
// with given id" for (#153). Run by ../isolated.test.ts in a process of its own.

const stub = installChrome()
;(globalThis as { __OPENCODE_BROWSER_BUILD__?: string }).__OPENCODE_BROWSER_BUILD__ = "test"
const TOKEN = "test-token-0123456789abcdefghijklmnopqrstuv"
const PORT = 19909
const socket = installFakeRelaySocket({ port: PORT, token: TOKEN })

await stub.chrome.storage.local.set({ agentRelayPort: PORT, agentRelayTokens: { [`127.0.0.1:${PORT}`]: TOKEN } })
const { createAgentRelay } = await import("../../src/background/agent-relay")
const relay = createAgentRelay({ changed: () => {}, badgesChanged: () => {} })

async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await settle()
  expect(check()).toBe(true)
}
const event = (path: string) => path.split(".").reduce<any>((value, key) => value[key], stub.chrome) as StubEvent

await until(() => relay.state().status === "connected")

test("a replaced tab is reported removed and forgotten", async () => {
  const window = await stub.chrome.windows.create({ url: "https://agent.example/", focused: false })
  const tabId = window.tabs[0]!.id
  socket().deliver({ id: 1, method: "debugger.attach", params: { tabId } })
  await until(() => relay.state().tabs.some((tab) => tab.tabId === tabId))
  event("tabs.onReplaced").emit(tabId + 1000, tabId)
  await until(() => socket().received.some((message) => message.method === "tabs.removed" && message.params?.tabId === tabId))
  expect(relay.state().tabs.some((tab) => tab.tabId === tabId)).toBe(false)
})
