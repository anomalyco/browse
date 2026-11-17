import { expect, test } from "bun:test"
import { installChrome, settle, type StubEvent } from "../chrome-stub"

// A tab's browse id lives in chrome.storage.local by tab id, so it outlives a service worker restart, an extension
// reload or an update, which all keep the tab ids. A browser restart gives every tab a new id and drops them. Run by
// ../isolated.test.ts in a process of its own.

const stub = installChrome()
const MARKER = "\u2063"
const { TabIdentity } = await import("../../src/background/tab-identity")
const { TabCleanup } = await import("../../src/background/tab-cleanup")

const user = await stub.chrome.windows.create({ url: "https://user.example/", focused: true })
const named = await stub.chrome.tabs.create({ windowId: user.id, url: "https://mail.example/", active: false })
const plain = await stub.chrome.tabs.create({ windowId: user.id, url: "https://plain.example/", active: false })
const namedId = named.id!
const plainId = plain.id!

test("a tab's id is made once and kept while the browser runs", async () => {
  const browseId = await TabIdentity.ensure(namedId, { agent: true, chosen: "work-mail" })
  expect(typeof browseId).toBe("string")
  expect(await TabIdentity.browseId(namedId)).toBe(browseId)
  expect(await TabIdentity.ensure(namedId, { agent: true })).toBe(browseId)
  expect(await TabIdentity.chosen(namedId)).toBe("work-mail")
  expect(await TabIdentity.isAgent(namedId)).toBe(true)
})

test("a service worker restart keeps the id, the chosen id and whether it is an agent tab", async () => {
  const before = await TabIdentity.browseId(namedId)
  expect(typeof before).toBe("string")
  // A fresh module instance reads the same chrome.storage.local, as the worker that starts after this one stops.
  const specifier = "../../src/background/tab-identity?restarted"
  const restarted = (await import(specifier)) as typeof TabIdentity
  expect(await restarted.browseId(namedId)).toBe(before as string)
  expect(await restarted.chosen(namedId)).toBe("work-mail")
  expect(await restarted.isAgent(namedId)).toBe(true)
  expect(await restarted.ensure(namedId, { agent: true })).toBe(before as string)
})

test("a lend lands whichever way it races an ensure", async () => {
  const first = await stub.chrome.tabs.create({ windowId: user.id, url: "https://race-one.example/", active: false })
  await Promise.all([TabIdentity.ensure(first.id!, { agent: true }), TabIdentity.setAgent(first.id!, false)])
  expect(await TabIdentity.isAgent(first.id!)).toBe(false)
  const second = await stub.chrome.tabs.create({ windowId: user.id, url: "https://race-two.example/", active: false })
  await Promise.all([TabIdentity.setAgent(second.id!, false), TabIdentity.ensure(second.id!, { agent: true })])
  expect(await TabIdentity.isAgent(second.id!)).toBe(false)
})

test("a reconnecting relay keeps a lend and takes the tracked answer only when there is none", async () => {
  const lent = await stub.chrome.tabs.create({ windowId: user.id, url: "https://lent.example/", active: false })
  await TabIdentity.setAgent(lent.id!, false)
  expect((await TabIdentity.ensureOwned(lent.id!, () => true))?.agent).toBe(false)
  expect(await TabIdentity.isAgent(lent.id!)).toBe(false)
  const fresh = await stub.chrome.tabs.create({ windowId: user.id, url: "https://fresh.example/", active: false })
  const owned = await TabIdentity.ensureOwned(fresh.id!, () => true)
  expect(owned?.agent).toBe(true)
  expect(typeof owned?.browseId).toBe("string")
  expect(await TabIdentity.browseId(fresh.id!)).toBe(owned?.browseId)
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

test("a browser start drops the stored ids", async () => {
  const tab = await stub.chrome.tabs.create({ windowId: user.id, url: "https://start.example/", active: false })
  expect(typeof (await TabIdentity.ensure(tab.id!, { agent: true, chosen: "start" }))).toBe("string")
  ;(stub.chrome.runtime as unknown as { onStartup: StubEvent }).onStartup.emit()
  await settle()
  await settle()
  expect(await TabIdentity.browseId(tab.id!)).toBeUndefined()
  expect(await TabIdentity.chosen(tab.id!)).toBeUndefined()
  expect(await TabIdentity.isAgent(tab.id!)).toBeUndefined()
  expect((await stub.chrome.storage.local.get("tabIdentity")).tabIdentity).toBeUndefined()
})

test("a clear in flight when the browser starts leaves nothing stored", async () => {
  const clearing = await stub.chrome.tabs.create({ windowId: user.id, url: "https://clearing.example/", active: false })
  const surviving = await stub.chrome.tabs.create({ windowId: user.id, url: "https://surviving.example/", active: false })
  await TabIdentity.ensure(clearing.id!, { agent: true, chosen: "clearing" })
  await TabIdentity.ensure(surviving.id!, { agent: true, chosen: "surviving" })
  const realGet = stub.chrome.storage.local.get
  const realSet = stub.chrome.storage.local.set
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  let block = true
  // Hold the clear's write: its read finished before startup, its write lands after.
  stub.chrome.storage.local.set = async (items) => {
    if (block) {
      block = false
      await held
    }
    return realSet(items)
  }
  try {
    const cleared = TabIdentity.clear(clearing.id!)
    await settle()
    expect(block).toBe(false)
    ;(stub.chrome.runtime as unknown as { onStartup: StubEvent }).onStartup.emit()
    await settle()
    release()
    await cleared
    await settle()
    expect(await TabIdentity.browseId(clearing.id!)).toBeUndefined()
    expect(await TabIdentity.browseId(surviving.id!)).toBeUndefined()
    expect((await realGet("tabIdentity")).tabIdentity).toBeUndefined()
  } finally {
    block = false
    release()
    stub.chrome.storage.local.set = realSet
    stub.chrome.storage.local.get = realGet
  }
})

test("a browser restart without onStartup drops an id before a new tab can reuse it", async () => {
  const old = await stub.chrome.tabs.create({ windowId: user.id, url: "https://old.example/", active: false })
  const group = await stub.chrome.tabs.group({ tabIds: [old.id!] })
  await stub.chrome.tabGroups.update(group, { title: `Agent${MARKER}` })
  await TabIdentity.ensure(old.id!, { agent: true, chosen: "old" })
  // A new browser session: session storage is empty, the old tab is gone, and its numeric id went to a new tab that
  // isn't in one of browse's groups.
  const session = await stub.chrome.storage.session.get(null)
  await stub.chrome.storage.session.remove(Object.keys(session))
  stub.state.tabs.delete(old.id!)
  const replacement = await stub.chrome.tabs.create({ windowId: user.id, url: "https://reused.example/", active: false })
  const moved = stub.state.tabs.get(replacement.id!)!
  stub.state.tabs.delete(replacement.id!)
  moved.id = old.id!
  stub.state.tabs.set(old.id!, moved)
  const specifier = "../../src/background/tab-identity?restart"
  const restarted = (await import(specifier)) as typeof TabIdentity
  expect(await restarted.browseId(old.id!)).toBeUndefined()
  expect(await restarted.chosen(old.id!)).toBeUndefined()
  expect((await stub.chrome.storage.local.get("tabIdentity")).tabIdentity).toBeUndefined()
})

test("idle cleanup keeps a tab whose chosen id can't be read", async () => {
  const tab = await stub.chrome.tabs.create({ windowId: user.id, url: "https://unreadable.example/", active: false })
  TabCleanup.track(tab.id!)
  const realGet = stub.chrome.storage.local.get
  stub.chrome.storage.local.get = async (keys) => {
    if (keys === "tabIdentity") return new Promise<never>(() => {})
    return realGet(keys)
  }
  try {
    expect(await TabCleanup.cleanup({ minutes: 0 })).toEqual([])
    expect(stub.state.tabs.has(tab.id!)).toBe(true)
  } finally {
    stub.chrome.storage.local.get = realGet
  }
}, 15_000)

test("a timed-out session check writes nothing and retries", async () => {
  const tab = await stub.chrome.tabs.create({ windowId: user.id, url: "https://timeout.example/", active: false })
  const group = await stub.chrome.tabs.group({ tabIds: [tab.id!] })
  await stub.chrome.tabGroups.update(group, { title: `Agent${MARKER}` })
  const browseId = await TabIdentity.ensure(tab.id!, { agent: true, chosen: "timeout" })
  const session = await stub.chrome.storage.session.get(null)
  await stub.chrome.storage.session.remove(Object.keys(session))
  const specifier = "../../src/background/tab-identity?timeout"
  const restarted = (await import(specifier)) as typeof TabIdentity
  const realQuery = stub.chrome.tabs.query
  stub.chrome.tabs.query = () => new Promise<never>(() => {})
  try {
    expect(await restarted.browseId(tab.id!)).toBe(restarted.UNKNOWN)
    const stored = (await stub.chrome.storage.local.get("tabIdentity")).tabIdentity as Record<string, unknown>
    expect(stored[String(tab.id!)]).toMatchObject({ browseId: browseId!, browseChosen: "timeout" })
  } finally {
    stub.chrome.tabs.query = realQuery
  }
  expect(await restarted.browseId(tab.id!)).toBe(browseId!)
}, 15_000)
