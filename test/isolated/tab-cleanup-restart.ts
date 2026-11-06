import { expect, test } from "bun:test"
import { installChrome } from "../chrome-stub"

// Tab ids don't survive a browser restart, and Chrome reuses them: a list saved before the restart may name the
// user's tabs now, so it must not be restored in the new session. Run by ../isolated.test.ts in a process of its own,
// so the module's listener and first restore (which happen once per worker) start from this test's storage.

const stub = installChrome()

test("ids saved before a browser restart are discarded instead of closing user tabs", async () => {
  const window = await stub.chrome.windows.create({ url: "https://user.example/", focused: true })
  const tab = await stub.chrome.tabs.create({ windowId: window.id, url: "https://user.example/saved-from-last-session", active: true })
  await stub.chrome.storage.session.remove("tabCleanupSession")
  await stub.chrome.storage.local.set({ tabCleanup: { [tab.id!]: { touched: Date.now() } } })

  const { TabCleanup } = await import("../../src/background/tab-cleanup")
  expect(await TabCleanup.isTracked(tab.id!)).toBe(false)
  expect(await TabCleanup.closeUnattached(() => false)).toEqual([])
  expect(stub.state.tabs.has(tab.id!)).toBe(true)
  expect((await stub.chrome.storage.local.get("tabCleanup")).tabCleanup).toBeUndefined()
})
