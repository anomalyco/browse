import { expect, test } from "bun:test"
import { installChrome } from "../chrome-stub"

// An extension reload keeps tab ids but clears session storage, so a missing marker keeps only entries whose tab is
// still in a browse-owned group. Run by ../isolated.test.ts in a process of its own, so the module's listener and first
// restore start from this test's storage.

const stub = installChrome()
const MARKER = "\u2063"

test("an extension reload keeps stored ids only while their tab is still in a browse group", async () => {
  const window = await stub.chrome.windows.create({ url: "https://user.example/", focused: true })
  const userTab = window.tabs[0]!.id
  const create = (url: string) => stub.chrome.tabs.create({ windowId: window.id, url, active: false })

  const owned = await create("https://owned.example/")
  const ownedGroup = await stub.chrome.tabs.group({ tabIds: [owned.id!] })
  await stub.chrome.tabGroups.update(ownedGroup, { title: `Agent${MARKER}` })

  // In a browse group but never tracked: recovery must not adopt it.
  const unstored = await create("https://unstored.example/")
  await stub.chrome.tabs.group({ tabIds: [unstored.id!], groupId: ownedGroup })

  const ungrouped = await create("https://ungrouped.example/")
  const userGrouped = await create("https://user-group.example/")
  const userGroup = await stub.chrome.tabs.group({ tabIds: [userGrouped.id!] })
  await stub.chrome.tabGroups.update(userGroup, { title: "Work" })

  const pinned = await create("https://pinned.example/")
  const pinnedGroup = await stub.chrome.tabs.group({ tabIds: [pinned.id!] })
  await stub.chrome.tabGroups.update(pinnedGroup, { title: `Pinned${MARKER}` })
  await stub.chrome.tabs.update(pinned.id!, { pinned: true })

  const touched = Date.now()
  await stub.chrome.storage.session.remove("tabCleanupSession")
  await stub.chrome.storage.local.set({
    tabCleanup: {
      [owned.id!]: { touched },
      [ungrouped.id!]: { touched },
      [userGrouped.id!]: { touched },
      [pinned.id!]: { touched },
      "999999": { touched },
    },
    tabCleanupCreating: [{ id: "pending", url: "about:blank", after: 0, at: touched }],
  })

  const { TabCleanup } = await import("../../src/background/tab-cleanup")

  expect(await TabCleanup.isTracked(owned.id!)).toBe(true)
  for (const tab of [unstored, ungrouped, userGrouped, pinned]) expect(await TabCleanup.isTracked(tab.id!)).toBe(false)
  expect(await TabCleanup.isTracked(999999)).toBe(false)

  const filtered = (await stub.chrome.storage.local.get("tabCleanup")).tabCleanup as Record<string, unknown>
  expect(Object.keys(filtered)).toEqual([String(owned.id!)])
  expect((await stub.chrome.storage.local.get("tabCleanupCreating")).tabCleanupCreating).toBeUndefined()

  expect((await TabCleanup.cleanup({ minutes: 0 })).map((tab) => tab.tabId)).toEqual([owned.id!])
  expect(stub.state.tabs.has(owned.id!)).toBe(false)
  for (const tabId of [userTab, unstored.id!, ungrouped.id!, userGrouped.id!, pinned.id!]) expect(stub.state.tabs.has(tabId)).toBe(true)
})
