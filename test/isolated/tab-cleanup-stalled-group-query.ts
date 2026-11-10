import { expect, test } from "bun:test"
import { installChrome } from "../chrome-stub"

// restore() reads the open tabs and their groups before trusting stored agent-tab ids. Dia's tab-group API can never
// settle, which used to wedge restore() for the worker's whole life (and every create's endCreate with it): the query
// now has a short bound and counts as no groups, like a failed query. Run by ../isolated.test.ts in a process of its
// own, so the module's first restore starts from this test's storage.

const stub = installChrome()
const MARKER = "\u2063"

test("restore treats a tab-group query that never settles as no groups", async () => {
  const window = await stub.chrome.windows.create({ url: "https://user.example/", focused: true })
  const tab = await stub.chrome.tabs.create({ windowId: window.id, url: "https://agent.example/", active: false })
  const group = await stub.chrome.tabs.group({ tabIds: [tab.id!] })
  await stub.chrome.tabGroups.update(group, { title: `Agent${MARKER}` })

  const touched = Date.now()
  await stub.chrome.storage.session.remove("tabCleanupSession")
  await stub.chrome.storage.local.set({ tabCleanup: { [tab.id!]: { touched } } })

  const query = stub.chrome.tabGroups.query
  stub.chrome.tabGroups.query = () => new Promise<never>(() => {})
  const started = Date.now()
  try {
    const { TabCleanup } = await import("../../src/background/tab-cleanup")
    expect(await TabCleanup.isTracked(tab.id!)).toBe(false)
    expect(Date.now() - started).toBeLessThan(5_000)
  } finally {
    stub.chrome.tabGroups.query = query
  }
  // Same as a failed query: without its groups the stored list isn't trusted, and the tab stays open.
  expect((await stub.chrome.storage.local.get("tabCleanup")).tabCleanup).toEqual({})
  expect(stub.state.tabs.has(tab.id!)).toBe(true)
})
