import { expect, test } from "bun:test"
import { installChrome, settle } from "../chrome-stub"

// A tab's browse id lives in chrome.storage.session by tab id, so it outlives a service worker restart within a
// browser session. A browser restart clears session storage along with the tab ids. Run by ../isolated.test.ts in a
// process of its own.

const stub = installChrome()
const { TabIdentity } = await import("../../src/background/tab-identity")
const { TabCleanup } = await import("../../src/background/tab-cleanup")

const user = await stub.chrome.windows.create({ url: "https://user.example/", focused: true })
const named = await stub.chrome.tabs.create({ windowId: user.id, url: "https://mail.example/", active: false })
const plain = await stub.chrome.tabs.create({ windowId: user.id, url: "https://plain.example/", active: false })
const namedId = named.id!
const plainId = plain.id!

test("a tab's id is made once and kept for the browser session", async () => {
  const browseId = await TabIdentity.ensure(namedId, { agent: true, chosen: "work-mail" })
  expect(typeof browseId).toBe("string")
  expect(await TabIdentity.browseId(namedId)).toBe(browseId)
  expect(await TabIdentity.ensure(namedId, { agent: true })).toBe(browseId)
  expect(await TabIdentity.chosen(namedId)).toBe("work-mail")
  expect(await TabIdentity.isAgent(namedId)).toBe(true)
})

test("a service worker restart keeps the id, the chosen id and whether it is an agent tab", async () => {
  const before = await TabIdentity.browseId(namedId)
  // A fresh module instance reads the same chrome.storage.session, as the worker that starts after this one stops.
  const specifier = "../../src/background/tab-identity?restarted"
  const restarted = (await import(specifier)) as typeof TabIdentity
  expect(await restarted.browseId(namedId)).toBe(before!)
  expect(await restarted.chosen(namedId)).toBe("work-mail")
  expect(await restarted.isAgent(namedId)).toBe(true)
  expect(await restarted.ensure(namedId, { agent: true })).toBe(before!)
})

test("a browser restart has no restored ids: session storage goes with the session", async () => {
  expect(await TabIdentity.restored()).toEqual([])
})

test("idle cleanup never closes a chosen-id tab, and still closes the others", async () => {
  TabCleanup.track(namedId)
  TabCleanup.track(plainId)
  const closed = await TabCleanup.cleanup({ minutes: 0 })
  expect(closed.some((tab) => tab.tabId === namedId)).toBe(false)
  expect(closed.some((tab) => tab.tabId === plainId)).toBe(true)
  expect(stub.state.tabs.has(namedId)).toBe(true)
})

test("closing a tab drops its values", async () => {
  await stub.chrome.tabs.remove(namedId)
  await settle()
  expect(await TabIdentity.browseId(namedId)).toBeUndefined()
  expect(await TabIdentity.chosen(namedId)).toBeUndefined()
  expect(await TabIdentity.isAgent(namedId)).toBeUndefined()
})

test("clearing the values frees the tab for a new id", async () => {
  const tab = await stub.chrome.tabs.create({ windowId: user.id, url: "https://other.example/", active: false })
  const before = await TabIdentity.ensure(tab.id!, { agent: true, chosen: "other" })
  await TabIdentity.clear(tab.id!)
  expect(await TabIdentity.browseId(tab.id!)).toBeUndefined()
  expect(await TabIdentity.chosen(tab.id!)).toBeUndefined()
  expect(await TabIdentity.ensure(tab.id!, { agent: true })).not.toBe(before)
})
