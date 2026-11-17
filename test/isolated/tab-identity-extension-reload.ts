import { expect, test } from "bun:test"
import { installChrome, settle } from "../chrome-stub"

// An extension update or reload keeps the tab ids and chrome.storage.local, but clears chrome.storage.session. The
// worker that starts after it must still know a tracked chosen-id tab, or idle cleanup closes it. Run by
// ../isolated.test.ts in a process of its own.

const stub = installChrome()
const MARKER = "\u2063"

test("an extension reload keeps a tracked chosen-id tab out of idle cleanup", async () => {
  const window = await stub.chrome.windows.create({ url: "https://user.example/", focused: true })
  const tab = await stub.chrome.tabs.create({ windowId: window.id, url: "https://mail.example/", active: false })
  const group = await stub.chrome.tabs.group({ tabIds: [tab.id!] })
  await stub.chrome.tabGroups.update(group, { title: `Agent${MARKER}` })
  const { TabIdentity } = await import("../../src/background/tab-identity")
  const { TabCleanup } = await import("../../src/background/tab-cleanup")
  const browseId = await TabIdentity.ensure(tab.id!, { agent: true, chosen: "work-mail" })
  TabCleanup.track(tab.id!)
  await TabCleanup.isTracked(tab.id!)
  await settle()
  const stored = (await stub.chrome.storage.local.get("tabCleanup")).tabCleanup as Record<string, unknown>
  expect(Object.keys(stored)).toEqual([String(tab.id!)])

  // The reload: session storage is empty and both modules start fresh; local storage and the tab id stay.
  const session = await stub.chrome.storage.session.get(null)
  await stub.chrome.storage.session.remove(Object.keys(session))
  const identitySpecifier = "../../src/background/tab-identity?reloaded"
  const cleanupSpecifier = "../../src/background/tab-cleanup?reloaded"
  const reloadedIdentity = (await import(identitySpecifier)) as typeof TabIdentity
  const reloadedCleanup = (await import(cleanupSpecifier)) as typeof TabCleanup

  expect(await reloadedIdentity.browseId(tab.id!)).toBe(browseId!)
  expect(await reloadedIdentity.chosen(tab.id!)).toBe("work-mail")
  expect(await reloadedCleanup.isTracked(tab.id!)).toBe(true)
  expect(await reloadedCleanup.cleanup({ minutes: 0 })).toEqual([])
  expect(stub.state.tabs.has(tab.id!)).toBe(true)
})
