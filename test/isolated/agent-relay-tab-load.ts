import { expect, test } from "bun:test"
import type { JsonObject } from "../../src/agent-relay/protocol"
import { installChrome, settle } from "../chrome-stub"
import { installFakeRelaySocket } from "../relay-stub"

// The relay attaches a debugger as soon as tabs.create answers; Vivaldi then never answers commands on a tab that was
// still loading, so the answer waits for the tab to leave "loading". And Page.navigate from about:blank to
// about:blank#… crashes Chrome and Vivaldi, so the extension sends plain about:blank instead. Run by
// ../isolated.test.ts in a process of its own.

const stub = installChrome()
;(globalThis as { __OPENCODE_BROWSER_BUILD__?: string }).__OPENCODE_BROWSER_BUILD__ = "test"
/** This browser's token for the relay, as a code exchange left it. */
const TOKEN = "test-token-0123456789abcdefghijklmnopqrstuv"
const PORT = 19908
const socket = installFakeRelaySocket({ port: PORT, token: TOKEN })

await stub.chrome.storage.local.set({ agentRelayPort: PORT, agentRelayTokens: { [`127.0.0.1:${PORT}`]: TOKEN } })
const { createAgentRelay } = await import("../../src/background/agent-relay")
const relay = createAgentRelay({ changed: () => {}, badgesChanged: () => {} })

async function until(check: () => boolean) {
  for (let i = 0; i < 1_500 && !check(); i++) await Bun.sleep(10)
  expect(check()).toBe(true)
}
let nextCommand = 1
function command(method: string, params: Record<string, unknown>) {
  const id = nextCommand++
  socket().deliver({ id, method, params })
  return id
}
const replyFor = (id: number) => socket().received.find((message) => message.id === id)
async function answerFor(id: number) {
  await until(() => replyFor(id) !== undefined)
  const reply = replyFor(id)!
  expect(reply.error).toBeUndefined()
  return reply.result as Record<string, unknown>
}

await until(() => relay.state().status === "connected")
const user = await stub.chrome.windows.create({ url: "https://user.example/", focused: true })

const realCreate = stub.chrome.tabs.create
const realGet = stub.chrome.tabs.get
let status: "loading" | "complete" | undefined
let getsFail = false
let gets = 0
stub.chrome.tabs.create = async (options) => Object.assign(await realCreate(options), { status })
stub.chrome.tabs.get = async (id) => {
  gets++
  if (getsFail) throw new Error(`No tab with id: ${id}.`)
  return Object.assign(await realGet(id), { status })
}

test("tabs.create waits while the tab is loading and answers once it is complete", async () => {
  status = "loading"
  gets = 0
  const id = command("tabs.create", { url: "https://example.com/", active: false })
  await Bun.sleep(500)
  expect(replyFor(id)).toBeUndefined()
  expect(gets).toBeGreaterThan(1)
  status = "complete"
  const result = await answerFor(id)
  expect(typeof result.tabId).toBe("number")
})

test("tabs.create gives up after 10s with the tab still loading and answers anyway", async () => {
  status = "loading"
  gets = 0
  const started = Date.now()
  const id = command("tabs.create", { url: "https://example.com/slow", active: false })
  const result = await answerFor(id)
  expect(Date.now() - started).toBeGreaterThanOrEqual(9_800)
  expect(typeof result.tabId).toBe("number")
}, 15_000)

test("tabs.create stops waiting when the tab is gone", async () => {
  status = "loading"
  getsFail = true
  gets = 0
  const started = Date.now()
  const id = command("tabs.create", { url: "https://example.com/gone", active: false })
  const result = await answerFor(id)
  expect(Date.now() - started).toBeLessThan(1_000)
  expect(gets).toBeGreaterThan(0)
  expect(typeof result.tabId).toBe("number")
  getsFail = false
})

test("Page.navigate from about:blank to about:blank#… is sent as about:blank; other urls are untouched", async () => {
  const sent: { method: string; params: unknown }[] = []
  const debuggerApi = (stub.chrome as unknown as {
    debugger: { sendCommand: (debuggee: unknown, method: string, params?: unknown) => Promise<unknown> }
  }).debugger
  const realSend = debuggerApi.sendCommand
  debuggerApi.sendCommand = async (_debuggee, method, params) => {
    sent.push({ method, params })
    return {}
  }
  const { createRelayDebugger } = await import("../../src/background/agent-relay/debugger")
  const { createAgentRelayLog } = await import("../../src/background/agent-relay/log")
  const debuggerOps = createRelayDebugger({
    log: createAgentRelayLog(),
    relayTabs: new Set<number>(),
    notify: () => {},
    forget: () => {},
    send: () => {},
  })
  const navigate = (params: JsonObject) => debuggerOps.sendCommand({ tabId: user.tabs[0]!.id, method: "Page.navigate", params })
  try {
    const fragmented: JsonObject = { url: "about:blank#section" }
    expect(await navigate(fragmented)).toEqual({})
    expect(sent.at(-1)).toEqual({ method: "Page.navigate", params: { url: "about:blank" } })
    expect(fragmented).toEqual({ url: "about:blank#section" })

    await navigate({ url: "https://a/#x" })
    expect(sent.at(-1)).toEqual({ method: "Page.navigate", params: { url: "https://a/#x" } })

    const blank: JsonObject = { url: "about:blank" }
    await navigate(blank)
    expect(sent.at(-1)).toEqual({ method: "Page.navigate", params: { url: "about:blank" } })
    expect(blank).toEqual({ url: "about:blank" })
  } finally {
    debuggerApi.sendCommand = realSend
  }
})
