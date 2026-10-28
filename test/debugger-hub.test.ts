import { beforeEach, describe, expect, test } from "bun:test"
import { installChrome, settle } from "./chrome-stub"

// The relay's debugger attachments across a service worker restart (debugger-hub.ts): the stored list survives the
// worker, and the new worker replaces each attachment it inherited with a fresh one.

const stub = installChrome()
const calls: string[] = []
/** Tabs this extension holds a debugger attachment on, as Chrome keeps them across a worker restart. */
const attached = new Set<number>()
let slowGet = false
Object.assign((stub.chrome as unknown as { debugger: object }).debugger, {
  async attach({ tabId }: { tabId: number }) {
    calls.push(`attach ${tabId}`)
    if (attached.has(tabId)) throw new Error("Another debugger is already attached to the tab")
    attached.add(tabId)
  },
  async detach({ tabId }: { tabId: number }) {
    calls.push(`detach ${tabId}`)
    attached.delete(tabId)
  },
  async sendCommand({ tabId }: { tabId: number }) {
    if (!attached.has(tabId)) throw new Error("Debugger is not attached to the tab")
    return {}
  },
})
const realGet = stub.chrome.tabs.get
stub.chrome.tabs.get = async (id: number) => {
  // An early write whose tab lookups answer late must not land after a later write.
  if (slowGet) await new Promise((resolve) => setTimeout(resolve, 30))
  return realGet(id)
}
const { DebuggerHub } = await import("../src/background/debugger-hub")

const stored = async () => ((await stub.chrome.storage.local.get("agentRelayAttached")).agentRelayAttached ?? []) as { tabId: number; url?: string }[]
async function settled() {
  for (let i = 0; i < 20; i++) await settle()
}

let window = 0
beforeEach(async () => {
  stub.state.tabs.clear()
  stub.state.windows.clear()
  calls.length = 0
  attached.clear()
  slowGet = false
  await stub.chrome.storage.local.remove("agentRelayAttached")
  window = (await stub.chrome.windows.create({ url: "https://user.example/", focused: true })).id
})

describe("relay attachments across a worker restart", () => {
  test("every attached tab reaches storage, even when attaches overlap", async () => {
    const tabs = await Promise.all([1, 2, 3].map((n) => stub.chrome.tabs.create({ windowId: window, url: `https://example.com/${n}`, active: false })))
    slowGet = true
    await DebuggerHub.attach(tabs[0]!.id, "relay")
    slowGet = false
    await Promise.all(tabs.slice(1).map((tab) => DebuggerHub.attach(tab.id, "relay")))
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect((await stored()).map((item) => item.tabId).sort()).toEqual(tabs.map((tab) => tab.id).sort())
    for (const tab of tabs) await DebuggerHub.detach(tab.id, "relay")
    await settled()
    expect(await stored()).toEqual([])
  })

  test("a new worker replaces an inherited attachment with a fresh one, whatever page the tab shows now", async () => {
    const tab = await stub.chrome.tabs.create({ windowId: window, url: "https://example.com/a", active: false })
    // What the old worker stored; Chrome kept its attachment, and the page navigated while no worker ran.
    await stub.chrome.storage.local.set({ agentRelayAttached: [{ tabId: tab.id, url: "https://example.com/before" }] })
    attached.add(tab.id)
    await DebuggerHub.restore()
    expect(calls).toEqual([`detach ${tab.id}`, `attach ${tab.id}`])
    expect(DebuggerHub.tabsOwnedBy("relay")).toContain(tab.id)
    await DebuggerHub.detach(tab.id, "relay")
  })

  test("after a reload (attachments gone) only the same page is attached again, never a tab that reused the id", async () => {
    const same = await stub.chrome.tabs.create({ windowId: window, url: "https://example.com/same", active: false })
    const other = await stub.chrome.tabs.create({ windowId: window, url: "https://stranger.example/", active: false })
    await stub.chrome.storage.local.set({ agentRelayAttached: [{ tabId: same.id, url: "https://example.com/same" }, { tabId: other.id, url: "https://example.com/gone" }] })
    await DebuggerHub.restore()
    expect(calls).toEqual([`attach ${same.id}`])
    await DebuggerHub.detach(same.id, "relay")
  })
})
