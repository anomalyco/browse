import { expect, setSystemTime, test } from "bun:test"
import type { JsonObject } from "../../src/agent-relay/protocol"
import { installChrome } from "../chrome-stub"
import { installFakeRelaySocket } from "../relay-stub"

// The relay attaches a debugger as soon as tabs.create answers; Vivaldi then never answers commands on a tab that was
// still loading, so an about:blank tab's answer waits for it to leave "loading". A tab created at a real URL (an older
// relay) must answer at once, before the page loads and bypasses the relay's allowlist. And Page.navigate to
// about:blank with a fragment crashes Chrome and Vivaldi, so the extension sends plain about:blank instead. A Chrome
// call that never settles (Dia) must not hold the answer past the relay's 15 s RPC timeout. Run by ../isolated.test.ts
// in a process of its own.

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
let getsHang = false
let gets = 0
stub.chrome.tabs.create = async (options) => Object.assign(await realCreate(options), { status })
stub.chrome.tabs.get = async (id) => {
  gets++
  if (getsHang) return new Promise<never>(() => {})
  if (getsFail) throw new Error(`No tab with id: ${id}.`)
  return Object.assign(await realGet(id), { status })
}

test("tabs.create waits while an about:blank tab is loading and answers once it is complete", async () => {
  status = "loading"
  gets = 0
  const id = command("tabs.create", { url: "about:blank", active: false })
  await Bun.sleep(500)
  expect(replyFor(id)).toBeUndefined()
  expect(gets).toBeGreaterThan(1)
  status = "complete"
  const result = await answerFor(id)
  expect(typeof result.tabId).toBe("number")
})

test("tabs.create with a real URL answers without waiting", async () => {
  status = "loading"
  gets = 0
  const started = Date.now()
  const result = await answerFor(command("tabs.create", { url: "https://example.com/", active: false }))
  expect(Date.now() - started).toBeLessThan(1_000)
  expect(gets).toBe(0)
  expect(typeof result.tabId).toBe("number")
})

test("tabs.create gives up after 10s with the tab still loading, logs it, and answers anyway", async () => {
  status = "loading"
  gets = 0
  const now = Date.now()
  setSystemTime(now)
  try {
    const id = command("tabs.create", { url: "about:blank", active: false })
    await until(() => gets > 0)
    setSystemTime(now + 10_001)
    const result = await answerFor(id)
    expect(typeof result.tabId).toBe("number")
    expect(await relay.diagnostics()).toContain("tabs.create.loadingTimeout")
  } finally {
    setSystemTime()
  }
})

test("tabs.create stops waiting when the tab is gone", async () => {
  status = "loading"
  getsFail = true
  gets = 0
  const started = Date.now()
  const id = command("tabs.create", { url: "about:blank", active: false })
  const result = await answerFor(id)
  expect(Date.now() - started).toBeLessThan(1_000)
  expect(gets).toBeGreaterThan(0)
  expect(typeof result.tabId).toBe("number")
  getsFail = false
})

test("tabs.create answers within its budget when tabs.get never settles", async () => {
  status = "loading"
  getsHang = true
  gets = 0
  const now = Date.now()
  const started = performance.now()
  setSystemTime(now)
  try {
    const id = command("tabs.create", { url: "about:blank", active: false })
    await until(() => gets > 0)
    // The first get gets a short slice, then the loop's deadline check gives up.
    setSystemTime(now + 10_001)
    const result = await answerFor(id)
    expect(typeof result.tabId).toBe("number")
    expect(performance.now() - started).toBeLessThan(1_000)
    const diagnostics = await relay.diagnostics()
    expect(diagnostics).toContain("tabs.create.start")
    expect(diagnostics).toContain("tabs.create.loadingTimeout")
  } finally {
    getsHang = false
    setSystemTime()
  }
})

test("tabs.create answers without waiting for tabs.update", async () => {
  status = "complete"
  gets = 0
  const realUpdate = stub.chrome.tabs.update
  let updates = 0
  stub.chrome.tabs.update = () => {
    updates++
    return new Promise<never>(() => {})
  }
  const started = Date.now()
  try {
    const result = await answerFor(command("tabs.create", { url: "about:blank", active: false }))
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(updates).toBe(1)
    expect(typeof result.tabId).toBe("number")
  } finally {
    stub.chrome.tabs.update = realUpdate
  }
})

test("tabs.create answers within its budget when endCreate never settles", async () => {
  // beginCreate's write has finished once the tab opens; a save that never lands from here on is one endCreate
  // waits on. Moving the clock past the deadline leaves it no time, so this doesn't wait 12 real seconds.
  const now = Date.now()
  const createWithStatus = stub.chrome.tabs.create
  const realSet = stub.chrome.storage.local.set
  let savesHang = false
  stub.chrome.tabs.create = async (options) => {
    savesHang = true
    setSystemTime(now + 12_001)
    return createWithStatus(options)
  }
  stub.chrome.storage.local.set = (items) => (savesHang ? new Promise<never>(() => {}) : realSet(items))
  const started = performance.now()
  try {
    const result = await answerFor(command("tabs.create", { url: "https://example.com/", active: false }))
    expect(performance.now() - started).toBeLessThan(1_000)
    expect(typeof result.tabId).toBe("number")
    const diagnostics = await relay.diagnostics()
    expect(diagnostics).toContain("tabs.create.start blank=false active=false")
    expect(diagnostics).not.toContain("https://example.com/")
  } finally {
    stub.chrome.tabs.create = createWithStatus
    stub.chrome.storage.local.set = realSet
    setSystemTime()
  }
})

test("Page.navigate to about:blank with a fragment is sent as about:blank; other urls are untouched", async () => {
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
    const cases: Array<[string, string]> = [
      ["about:blank#section", "about:blank"],
      ["about:blank#", "about:blank"],
      ["ABOUT:blank#x", "about:blank"],
      [" about:blank#x", "about:blank"],
      ["about:BLANK#x", "about:blank"],
      ["https://a/#x", "https://a/#x"],
      ["about:blank", "about:blank"],
      ["about:blank?x#y", "about:blank?x#y"],
    ]
    for (const [input, expected] of cases) {
      const params: JsonObject = { url: input }
      expect(await navigate(params)).toEqual({})
      expect(sent.at(-1)).toEqual({ method: "Page.navigate", params: { url: expected } })
      expect(params).toEqual({ url: input })
    }

    // When a foreign frame blocks CDP, the chrome.tabs.update fallback gets the same rewritten URL.
    const updates: unknown[] = []
    const realUpdate = stub.chrome.tabs.update
    stub.chrome.tabs.update = async (id, change) => {
      updates.push(change)
      return realUpdate(id, change)
    }
    debuggerApi.sendCommand = async () => {
      throw new Error("Cannot access a chrome-extension:// URL of different extension")
    }
    try {
      await navigate({ url: "about:blank#fallback" })
      expect(updates.at(-1)).toEqual({ url: "about:blank" })
    } finally {
      stub.chrome.tabs.update = realUpdate
    }
  } finally {
    debuggerApi.sendCommand = realSend
  }
})
