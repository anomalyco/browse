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

// The user switching to a tab counts as using it; a tab the user moves out of the agent's group is theirs now.
// Kept in local storage so an extension reload or update doesn't forget which tabs agents opened; tab ids
// don't survive a browser restart, so the list starts over then.
chrome.runtime.onStartup.addListener(() => {
  tracked.clear()
  void chrome.storage.local.remove(STORAGE_KEY)
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
