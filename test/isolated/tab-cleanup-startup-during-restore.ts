import { expect, test } from "bun:test"
import { installChrome, settle, type StubEvent } from "../chrome-stub"

// A browser start that lands while restore() is reading tabs must win: the late restore may not put the old list
// back. Run by ../isolated.test.ts in a process of its own, so the module's first restore starts from this test's
// storage.

const stub = installChrome()
const MARKER = "\u2063"
const event = (path: string) => path.split(".").reduce<any>((value, key) => value[key], stub.chrome) as StubEvent

test("a browser start during restore leaves nothing tracked", async () => {
  const window = await stub.chrome.windows.create({ url: "https://user.example/", focused: true })
  const tab = await stub.chrome.tabs.create({ windowId: window.id, url: "https://agent.example/", active: false })
  const group = await stub.chrome.tabs.group({ tabIds: [tab.id!] })
  await stub.chrome.tabGroups.update(group, { title: `Agent${MARKER}` })

  const touched = Date.now()
  await stub.chrome.storage.session.remove("tabCleanupSession")
  await stub.chrome.storage.local.set({
    tabCleanup: { [tab.id!]: { touched } },
    tabCleanupCreating: [{ id: "pending", url: "about:blank", after: 0, at: touched }],
  })

  const realQuery = stub.chrome.tabs.query
  let started = false
  stub.chrome.tabs.query = async (query) => {
    const tabs = await realQuery(query)
    if (!started) {
      started = true
      event("runtime.onStartup").emit()
    }
    return tabs
  }

  const { TabCleanup } = await import("../../src/background/tab-cleanup")
  expect(await TabCleanup.isTracked(tab.id!)).toBe(false)
  await settle()
  await settle()

  expect(started).toBe(true)
  expect(await TabCleanup.isTracked(tab.id!)).toBe(false)
  expect((await stub.chrome.storage.local.get("tabCleanup")).tabCleanup).toBeUndefined()
  expect((await stub.chrome.storage.local.get("tabCleanupCreating")).tabCleanupCreating).toBeUndefined()
})
