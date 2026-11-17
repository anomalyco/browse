import { expect, test } from "bun:test"
import { installChrome, settle, type StubEvent } from "../chrome-stub"

// An extension update or reload keeps the tab ids and chrome.storage.local, but clears chrome.storage.session. The
// worker that starts after it must keep every id it had, including a lent tab and an ungrouped chosen one, and
// onInstalled with reason "update" is what says the browser session didn't change. Run by ../isolated.test.ts in a
// process of its own.

const stub = installChrome()
const MARKER = "\u2063"

test("an extension update keeps lent and ungrouped chosen tab ids", async () => {
  const window = await stub.chrome.windows.create({ url: "https://user.example/", focused: true })
  const create = (url: string) => stub.chrome.tabs.create({ windowId: window.id, url, active: false })
  const grouped = await create("https://mail.example/")
  const group = await stub.chrome.tabs.group({ tabIds: [grouped.id!] })
  await stub.chrome.tabGroups.update(group, { title: `Agent${MARKER}` })
  const lent = await create("https://lent.example/")
  const side = await create("https://side.example/")
  const { TabIdentity } = await import("../../src/background/tab-identity")
  const { TabCleanup } = await import("../../src/background/tab-cleanup")
  const groupedId = await TabIdentity.ensure(grouped.id!, { agent: true, chosen: "work-mail" })
  const lentId = await TabIdentity.ensure(lent.id!, { agent: false })
  const sideId = await TabIdentity.ensure(side.id!, { agent: true, chosen: "side-mail" })
  TabCleanup.track(grouped.id!)
  await TabCleanup.isTracked(grouped.id!)
  await settle()

  // The update: session storage is empty and both modules start fresh; local storage and the tab ids stay.
  const session = await stub.chrome.storage.session.get(null)
  await stub.chrome.storage.session.remove(Object.keys(session))
  const identitySpecifier = "../../src/background/tab-identity?updated"
  const cleanupSpecifier = "../../src/background/tab-cleanup?updated"
  const updatedIdentity = (await import(identitySpecifier)) as typeof TabIdentity
  const updatedCleanup = (await import(cleanupSpecifier)) as typeof TabCleanup

  // A prepare() that starts before the install event waits briefly for it instead of treating it as a restart.
  const lentRead = updatedIdentity.browseId(lent.id!)
  await Bun.sleep(20)
  ;(stub.chrome.runtime as unknown as { onInstalled: StubEvent }).onInstalled.emit({ reason: "update", previousVersion: "0.0.1" })
  expect(await lentRead).toBe(lentId!)
  expect(await updatedIdentity.browseId(side.id!)).toBe(sideId!)
  expect(await updatedIdentity.chosen(side.id!)).toBe("side-mail")
  expect(await updatedIdentity.browseId(grouped.id!)).toBe(groupedId!)
  expect((await stub.chrome.storage.session.get("tabIdentitySession")).tabIdentitySession).toBe(true)

  expect(await updatedCleanup.isTracked(grouped.id!)).toBe(true)
  expect(await updatedCleanup.cleanup({ minutes: 0 })).toEqual([])
  expect(stub.state.tabs.has(grouped.id!)).toBe(true)
})
