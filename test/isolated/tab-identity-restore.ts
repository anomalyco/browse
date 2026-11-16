import { expect, test } from "bun:test"
import { installChrome } from "../chrome-stub"

// A tab's browse id is kept with chrome.sessions, on the tab itself, so Chrome restores it with the tab after a
// browser restart (a new numeric tab id). Run by ../isolated.test.ts in a process of its own.

const stub = installChrome()
const { TabIdentity } = await import("../../src/background/tab-identity")
const { TabCleanup } = await import("../../src/background/tab-cleanup")

const user = await stub.chrome.windows.create({ url: "https://user.example/", focused: true })
const named = await stub.chrome.tabs.create({ windowId: user.id, url: "https://mail.example/", active: false })
const plain = await stub.chrome.tabs.create({ windowId: user.id, url: "https://plain.example/", active: false })
const namedId = named.id!
const plainId = plain.id!

test("a tab's id is made once and kept on the tab", async () => {
  const browseId = await TabIdentity.ensure(namedId, { agent: true, chosen: "work-mail" })
  expect(typeof browseId).toBe("string")
  expect(await TabIdentity.browseId(namedId)).toBe(browseId)
  expect(await TabIdentity.ensure(namedId, { agent: true })).toBe(browseId)
  expect(await TabIdentity.chosen(namedId)).toBe("work-mail")
  expect(await TabIdentity.isAgent(namedId)).toBe(true)
})

test("a restored tab (a new tab id, the same values) keeps the id, the chosen id and whether it is an agent tab", async () => {
  const before = await TabIdentity.browseId(namedId)
  const restored = await stub.chrome.tabs.create({ windowId: user.id, url: "https://mail.example/", active: false })
  const restoredId = restored.id!
  for (const [key, value] of stub.state.tabValues.get(namedId)!) await stub.chrome.sessions.setTabValue(restoredId, key, value)
  const found = await TabIdentity.restored()
  const entry = found.find((tab) => tab.tabId === restoredId)
  expect(entry).toEqual({ tabId: restoredId, browseId: before!, agent: true, chosen: "work-mail" })
  // The id is the tab's, not the numeric id Chrome gave it this time.
  expect(entry!.browseId).toBe(before!)
})

test("idle cleanup never closes a chosen-id tab, and still closes the others", async () => {
  TabCleanup.track(namedId)
  TabCleanup.track(plainId)
  const closed = await TabCleanup.cleanup({ minutes: 0 })
  expect(closed.some((tab) => tab.tabId === namedId)).toBe(false)
  expect(closed.some((tab) => tab.tabId === plainId)).toBe(true)
  expect(stub.state.tabs.has(namedId)).toBe(true)
})

test("clearing the values frees the tab for a new id", async () => {
  const before = await TabIdentity.browseId(namedId)
  await TabIdentity.clear(namedId)
  expect(await TabIdentity.browseId(namedId)).toBeUndefined()
  expect(await TabIdentity.chosen(namedId)).toBeUndefined()
  expect(await TabIdentity.ensure(namedId, { agent: true })).not.toBe(before)
})
