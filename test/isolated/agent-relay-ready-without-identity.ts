import { expect, test } from "bun:test"
import { installChrome } from "../chrome-stub"
import { installFakeRelaySocket } from "../relay-stub"

// A hello must announce every relay tab and always finish with ready, even when a tab's identity can't be read: the
// relay releases a tab it can't match rather than closing it, and a connection that never says ready looks wedged.
// Run by ../isolated.test.ts in a process of its own.

const stub = installChrome()
;(globalThis as { __OPENCODE_BROWSER_BUILD__?: string }).__OPENCODE_BROWSER_BUILD__ = "test"
const TOKEN = "test-token-0123456789abcdefghijklmnopqrstuv"
const PORT = 19909
const socket = installFakeRelaySocket({ port: PORT, token: TOKEN })

await stub.chrome.storage.local.set({ agentRelayPort: PORT, agentRelayTokens: { [`127.0.0.1:${PORT}`]: TOKEN } })
const { createAgentRelay } = await import("../../src/background/agent-relay")
const relay = createAgentRelay({ changed: () => {}, badgesChanged: () => {} })

async function until(check: () => boolean, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (!check() && Date.now() < deadline) await Bun.sleep(10)
  expect(check()).toBe(true)
}

await until(() => relay.state().status === "connected")
const window = await stub.chrome.windows.create({ url: "https://user.example/", focused: true })
const tab = await stub.chrome.tabs.create({ windowId: window.id, url: "https://mail.example/", active: false })

let nextCommand = 1
function command(method: string, params: Record<string, unknown>) {
  const id = nextCommand++
  socket().deliver({ id, method, params })
  return id
}
// Attach the tab through the relay, so the next hello has one to announce.
const attach = command("debugger.attach", { tabId: tab.id! })
await until(() => socket().received.some((message) => message.id === attach))
expect(socket().received.find((message) => message.id === attach)?.error).toBeUndefined()

test("the hello announces the tab and reaches ready when its identity read hangs", async () => {
  const realGet = stub.chrome.storage.local.get
  stub.chrome.storage.local.get = async (keys) => {
    if (keys === "tabIdentity") return new Promise<never>(() => {})
    return realGet(keys)
  }
  try {
    const before = socket()
    before.drop()
    await until(() => socket() !== before)
    const messages = socket().received
    await until(() => messages.some((message) => message.method === "ready"), 12_000)
    const attached = messages.find((message) => message.method === "debugger.attached" && message.params?.tabId === tab.id)
    expect(attached).toBeDefined()
    expect(attached!.params).not.toHaveProperty("browseId")
  } finally {
    stub.chrome.storage.local.get = realGet
  }
}, 20_000)
