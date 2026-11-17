import { expect, test } from "bun:test"
import { installChrome, settle } from "../chrome-stub"

// An extension update or reload keeps the tab ids and chrome.storage.local but clears chrome.storage.session. Without
// the marker only ids on tabs in browse's groups survive, so a grouped agent tab keeps its id while a lent ungrouped
// tab does not. Run by ../isolated.test.ts in a process of its own.

const stub = installChrome()
const MARKER = "\u2063"

test("an extension reload keeps a grouped chosen-id tab and drops a lent ungrouped one", async () => {
  const window = await stub.chrome.windows.create({ url: "https://user.example/", focused: true })
  const create = (url: string) => stub.chrome.tabs.create({ windowId: window.id, url, active: false })
  const grouped = await create("https://mail.example/")
  const group = await stub.chrome.tabs.group({ tabIds: [grouped.id!] })
  await stub.chrome.tabGroups.update(group, { title: `Agent${MARKER}` })
  const lent = await create("https://lent.example/")
  const { TabIdentity } = await import("../../src/background/tab-identity")
  const { TabCleanup } = await import("../../src/background/tab-cleanup")
  const groupedId = await TabIdentity.ensure(grouped.id!, { agent: true, chosen: "work-mail" })
  const lentId = await TabIdentity.ensure(lent.id!, { agent: false })
  TabCleanup.track(grouped.id!)
  await TabCleanup.isTracked(grouped.id!)
  await settle()

  // The reload: session storage is empty and both modules start fresh; local storage and the tab ids stay.
  const session = await stub.chrome.storage.session.get(null)
  await stub.chrome.storage.session.remove(Object.keys(session))
  const identitySpecifier = "../../src/background/tab-identity?reloaded"
  const cleanupSpecifier = "../../src/background/tab-cleanup?reloaded"
  const reloadedIdentity = (await import(identitySpecifier)) as typeof TabIdentity
  const reloadedCleanup = (await import(cleanupSpecifier)) as typeof TabCleanup

  expect(await reloadedIdentity.browseId(grouped.id!)).toBe(groupedId!)
  expect(await reloadedIdentity.chosen(grouped.id!)).toBe("work-mail")
  expect(await reloadedIdentity.browseId(lent.id!)).toBeUndefined()
  expect(await reloadedCleanup.isTracked(grouped.id!)).toBe(true)
  expect(await reloadedCleanup.cleanup({ minutes: 0 })).toEqual([])
  expect(stub.state.tabs.has(grouped.id!)).toBe(true)
})
