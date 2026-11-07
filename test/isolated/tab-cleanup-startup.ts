import { expect, test } from "bun:test"
import { installChrome, settle, type StubEvent } from "../chrome-stub"

// A browser start clears agent-tab tracking even when the tab is still in a browse group marked with the group title
// marker. Run by ../isolated.test.ts in a process of its own, so the module's listener and first restore start from
// this test's storage.

const stub = installChrome()
const MARKER = "\u2063"
const event = (path: string) => path.split(".").reduce<any>((value, key) => value[key], stub.chrome) as StubEvent

test("a browser start clears a stored id even though its tab is in a browse group", async () => {
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

  const { TabCleanup } = await import("../../src/background/tab-cleanup")
  expect(await TabCleanup.isTracked(tab.id!)).toBe(true)

  event("runtime.onStartup").emit()
  await settle()
  await settle()

  expect(await TabCleanup.isTracked(tab.id!)).toBe(false)
  expect((await stub.chrome.storage.local.get("tabCleanup")).tabCleanup).toBeUndefined()
  expect((await stub.chrome.storage.local.get("tabCleanupCreating")).tabCleanupCreating).toBeUndefined()
})
