export * as TabCleanup from "./tab-cleanup"
import { DEFAULT_IDLE_MINUTES, IDLE_MINUTES_KEY } from "../shared/protocol"

// Closes tabs agents opened once nobody has touched them for a while, so agent work doesn't leave a trail of
// tabs behind. Only tabs an agent created are tracked (the relay's
// tabs.create); tabs the user shared are never closed. A tab is "touched" when an agent sends it a
// command or the user switches to it. A tab the user claims (pins, or drags out of the agent's group) is
// forgotten. `cleanup()` runs every few minutes from an alarm and on demand (relay `tabs.cleanup`).

type Tracked = { touched: number }

const STORAGE_KEY = "tabCleanup"
/** chrome.storage.local (the status page's "Close idle agent tabs"): minutes a tracked tab may sit unused before it closes; 0 never. */
export { DEFAULT_IDLE_MINUTES, IDLE_MINUTES_KEY }
const ALARM = "opencode-browser-tab-cleanup"

const tracked = new Map<number, Tracked>()
let restored: Promise<void> | undefined
let saveTimer: ReturnType<typeof setTimeout> | undefined
let writes: Promise<unknown> = Promise.resolve()
/** Touches are written at most this often; which tabs are tracked is written at once. */
const TOUCH_SAVE_MS = 2_000
/** Tabs that must stay open whatever their age, for example while a handoff waits for the user or a recording runs. */
const guards: ((tabId: number) => boolean)[] = []

export type Closed = { tabId: number; title: string; idleMinutes: number }

export function track(tabId: number) {
  tracked.set(tabId, { touched: Date.now() })
  save()
}

export function touch(tabId: number) {
  const entry = tracked.get(tabId)
  if (!entry) return
  entry.touched = Date.now()
  save({ soon: true })
}

export function forget(tabId: number) {
  if (tracked.delete(tabId)) save()
}

/** Whether an agent opened this tab (and it hasn't been handed to the user). */
export async function isTracked(tabId: number) {
  await restore()
  return tracked.has(tabId)
}

/** Registers a check that keeps a tab open while it returns true. */
export function guard(check: (tabId: number) => boolean) {
  guards.push(check)
}

/** The setting: minutes before an untouched agent tab closes, 0 for never. */
export async function idleMinutes() {
  const value = (await chrome.storage.local.get(IDLE_MINUTES_KEY))[IDLE_MINUTES_KEY]
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : DEFAULT_IDLE_MINUTES
}

/**
 * Closes tracked tabs idle for at least `minutes` (the setting by default; with the setting at never, an agent's
 * cleanup without a time still closes only tabs idle for the default 10 minutes). Skips a tab that is the active tab
 * of the focused window, is playing audio, or is guarded. `minutes: 0` closes every unguarded tracked tab.
 */
export async function cleanup(options: { minutes?: number } = {}) {
  await restore()
  const minutes = options.minutes ?? ((await idleMinutes()) || DEFAULT_IDLE_MINUTES)
  const now = Date.now()
  const focused = await chrome.windows.getLastFocused().catch(() => undefined)
  const closed: Closed[] = []
  for (const [tabId, entry] of Array.from(tracked)) {
    const idle = now - entry.touched
    if (idle < minutes * 60_000) continue
    const tab = await chrome.tabs.get(tabId).catch(() => undefined)
    if (!tab) {
      tracked.delete(tabId)
      continue
    }
    if (tab.pinned) {
      tracked.delete(tabId)
      continue
    }
    if (tab.active && tab.windowId === focused?.id && focused?.focused) continue
    if (tab.audible || guards.some((check) => check(tabId))) continue
    const removed = await chrome.tabs.remove(tabId).then(
      () => true,
      () => false,
    )
    tracked.delete(tabId)
    if (removed)
      closed.push({ tabId, title: tab.title || tab.url || "Untitled", idleMinutes: Math.round(idle / 60_000) })
  }
  save()
  return closed
}

function restore() {
  restored ??= chrome.storage.local.get(STORAGE_KEY).then((stored) => {
    const saved = (stored[STORAGE_KEY] ?? {}) as Record<string, Tracked>
    for (const [tabId, entry] of Object.entries(saved))
      if (!tracked.has(Number(tabId))) tracked.set(Number(tabId), entry)
  })
  return restored
}

/**
 * Writes the tracked tabs to storage, so a service worker restart (or an extension reload) still knows which tabs
 * agents opened. Tracking a tab or forgetting one is written at once; a touch within a couple of seconds. (A
 * debounce that every touch pushed back never wrote while agents kept sending commands, so a worker restart then
 * forgot nearly every agent tab, and idle cleanup never closed them.) Writes run in order, after the stored list was
 * read back, so an early write can't replace tabs the worker hasn't restored yet.
 */
function save(options: { soon?: boolean } = {}) {
  if (options.soon) {
    saveTimer ??= setTimeout(flush, TOUCH_SAVE_MS)
    return
  }
  flush()
}

function flush() {
  clearTimeout(saveTimer)
  saveTimer = undefined
  writes = writes
    .then(() => restore())
    .then(() => chrome.storage.local.set({ [STORAGE_KEY]: Object.fromEntries(tracked) }))
    .catch(() => undefined)
}

/** Resolves once every pending write has reached storage (tests). */
export async function flushed() {
  if (saveTimer !== undefined) flush()
  await writes
}

const CREATING_KEY = "tabCleanupCreating"
type Creating = { id: string; url: string; after: number; at: number }
let creatingWrites: Promise<unknown> = Promise.resolve()

/**
 * Notes a tab an agent is about to open, before chrome.tabs.create runs. A service worker that stops while the tab is
 * being created (Chrome finishes creating it) never tracks it, and nobody would ever close it: a worker restart left
 * such a tab behind about every other time while agents were busy. `reconcileCreates` finds and closes it.
 */
export async function beginCreate(url: string): Promise<string> {
  const after = Math.max(0, ...(await chrome.tabs.query({}).catch(() => [] as chrome.tabs.Tab[])).map((tab) => tab.id ?? 0))
  const entry: Creating = { id: crypto.randomUUID(), url, after, at: Date.now() }
  await updateCreating((list) => [...list, entry])
  return entry.id
}

/** The tab is tracked (and stored) now, or its creation failed. */
export async function endCreate(id: string) {
  await flushed()
  await updateCreating((list) => list.filter((entry) => entry.id !== id))
}

/**
 * On a worker start: closes tabs a previous worker created for an agent but stopped before tracking. Such a tab is
 * newer than the tabs that existed when its creation began, in the background, opened by no tab, showing the URL it
 * was opened with, and neither tracked nor attached.
 */
export async function reconcileCreates(attached: (tabId: number) => boolean): Promise<Closed[]> {
  await restore()
  const pending = ((await chrome.storage.local.get(CREATING_KEY))[CREATING_KEY] ?? []) as Creating[]
  if (!pending.length) return []
  const tabs = (await chrome.tabs.query({}).catch(() => [] as chrome.tabs.Tab[])).sort((a, b) => (a.id ?? 0) - (b.id ?? 0))
  const closed: Closed[] = []
  const taken = new Set<number>()
  for (const entry of pending) {
    const tab = tabs.find((candidate) =>
      candidate.id !== undefined &&
      candidate.id > entry.after &&
      !taken.has(candidate.id) &&
      !candidate.active &&
      candidate.openerTabId === undefined &&
      [candidate.url, candidate.pendingUrl].includes(entry.url) &&
      !tracked.has(candidate.id) &&
      !attached(candidate.id),
    )
    if (tab?.id === undefined) continue
    taken.add(tab.id)
    if (await chrome.tabs.remove(tab.id).then(() => true, () => false)) closed.push({ tabId: tab.id, title: tab.title || tab.url || "Untitled", idleMinutes: 0 })
  }
  await updateCreating((list) => list.filter((entry) => !pending.some((done) => done.id === entry.id)))
  return closed
}

/**
 * On a worker start: closes tracked agent tabs the relay doesn't have (no debugger attachment survived or came back).
 * The relay attaches every tab it opens right away and closes the ones it lets go, so such a tab is one whose opening
 * the stopped worker never reported, or whose attach it cut short; nothing would use it again.
 */
export async function closeUnattached(attached: (tabId: number) => boolean): Promise<Closed[]> {
  await restore()
  const closed: Closed[] = []
  for (const tabId of Array.from(tracked.keys())) {
    if (attached(tabId)) continue
    const tab = await chrome.tabs.get(tabId).catch(() => undefined)
    tracked.delete(tabId)
    if (!tab || tab.pinned) continue
    if (await chrome.tabs.remove(tabId).then(() => true, () => false)) closed.push({ tabId, title: tab.title || tab.url || "Untitled", idleMinutes: 0 })
  }
  save()
  return closed
}

function updateCreating(change: (list: Creating[]) => Creating[]) {
  const write = creatingWrites.then(async () => {
    const list = ((await chrome.storage.local.get(CREATING_KEY))[CREATING_KEY] ?? []) as Creating[]
    await chrome.storage.local.set({ [CREATING_KEY]: change(list) })
  })
  creatingWrites = write.catch(() => undefined)
  return write.catch(() => undefined)
}

// The user switching to a tab counts as using it; a tab the user moves out of the agent's group is theirs now.
// Kept in local storage so an extension reload or update doesn't forget which tabs agents opened; tab ids
// don't survive a browser restart, so the list starts over then.
chrome.runtime.onStartup.addListener(() => {
  tracked.clear()
  void chrome.storage.local.remove([STORAGE_KEY, CREATING_KEY])
})
chrome.tabs.onActivated.addListener(({ tabId }) => touch(tabId))
chrome.tabs.onRemoved.addListener((tabId) => forget(tabId))
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.pinned) forget(tabId)
  if (change.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE && tracked.has(tabId)) forget(tabId)
})
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM) return
  // Never (0) leaves agent tabs open until their agent or the user closes them.
  void idleMinutes().then((minutes) => {
    if (minutes > 0) return cleanup({ minutes })
  })
})
void chrome.alarms.create(ALARM, { periodInMinutes: 1 })
void restore()
