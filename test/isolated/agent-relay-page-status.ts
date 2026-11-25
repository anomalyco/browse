import { beforeEach, expect, test } from "bun:test"
import { installChrome, settle, type StubEvent } from "../chrome-stub"
import { installFakeRelaySocket } from "../relay-stub"

// A tab another extension's frame detaches the debugger from: the relay keeps the tab, the extension forgets it, and a
// handoff started afterwards must still show its card on the next page. Run by ../isolated.test.ts in a process of its
// own.

const stub = installChrome()
;(globalThis as { __OPENCODE_BROWSER_BUILD__?: string }).__OPENCODE_BROWSER_BUILD__ = "test"
const TOKEN = "test-token-0123456789abcdefghijklmnopqrstuv"
const PORT = 19912
const socket = installFakeRelaySocket({ port: PORT, token: TOKEN })

await stub.chrome.storage.local.set({ agentRelayPort: PORT, agentRelayTokens: { [`127.0.0.1:${PORT}`]: TOKEN } })
const { createAgentRelay } = await import("../../src/background/agent-relay")
const relay = createAgentRelay({ changed: () => {}, badgesChanged: () => {} })

async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await settle()
  expect(check()).toBe(true)
}
const event = (path: string) => path.split(".").reduce<any>((value, key) => value[key], stub.chrome) as StubEvent
let nextCommand = 1
async function command(method: string, params: Record<string, unknown>) {
  const id = nextCommand++
  socket().deliver({ id, method, params })
  await until(() => socket().received.some((message) => message.id === id))
  return socket().received.find((message) => message.id === id)!
}
const waiting = (handoffId: string) => ({
  state: "waiting",
  owner: "session",
  sessionId: "github",
  message: "Sign in",
  handoffId,
})

const injected: number[] = []
const sent: { tabId: number; message: unknown }[] = []
beforeEach(() => {
  injected.length = 0
  sent.length = 0
  ;(stub.chrome as unknown as { scripting: unknown }).scripting = {
    executeScript: async (options: { target: { tabId: number } }) => {
      injected.push(options.target.tabId)
      return []
    },
  }
  ;(stub.chrome.tabs as unknown as { sendMessage: unknown }).sendMessage = async (tabId: number, message: unknown) => {
    sent.push({ tabId, message })
    return undefined
  }
})

await until(() => relay.state().status === "connected")

/** A waiting handoff whose tab the extension no longer holds: no debugger.attach came after the detach. */
async function waitingTab(handoffId: string) {
  const window = await stub.chrome.windows.create({ url: "https://bank.example/login", focused: true })
  const tabId = window.tabs[0]!.id
  expect((await command("pageStatus.set", { tabId, status: waiting(handoffId) })).error).toBeUndefined()
  expect(relay.state().tabs.some((tab) => tab.tabId === tabId)).toBe(false)
  return tabId
}

test("a waiting tab keeps getting the page script after a navigation, detached or not", async () => {
  const tabId = await waitingTab("handoff-1")
  event("tabs.onUpdated").emit(tabId, { status: "complete" }, { id: tabId })
  await settle()
  expect(injected).toEqual([tabId])
})

test("a tab with no status is left alone after a navigation", async () => {
  const window = await stub.chrome.windows.create({ url: "https://user.example/", focused: true })
  const tabId = window.tabs[0]!.id
  event("tabs.onUpdated").emit(tabId, { status: "complete" }, { id: tabId })
  await settle()
  expect(injected).toEqual([])
})

test("the page script asking for its status gets the stored one, though the relay no longer holds the tab", async () => {
  const tabId = await waitingTab("handoff-2")
  sent.length = 0
  const handled = relay.runtimeMessage({ action: "page-status.ready" }, { tab: { id: tabId } } as chrome.runtime.MessageSender, () => {})
  expect(handled).toBe(false)
  await settle()
  expect(sent).toEqual([{ tabId, message: { action: "page-status.set", status: waiting("handoff-2") } }])
  expect(socket().received.some((message) => message.method === "pageStatus.requested")).toBe(false)
})

test("clearing the status stops the script coming back", async () => {
  const tabId = await waitingTab("handoff-3")
  expect((await command("pageStatus.clear", { tabId })).error).toBeUndefined()
  injected.length = 0
  event("tabs.onUpdated").emit(tabId, { status: "complete" }, { id: tabId })
  await settle()
  expect(injected).toEqual([])
})
