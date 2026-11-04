export * as DebuggerHub from "./debugger-hub"

import { serialQueue } from "./serial"

// The chrome.debugger attachments this extension holds, one per tab, for everything in it that drives tabs: today
// only the Browse relay's agents. Chrome allows a single attachment per extension per tab, so a tab is either
// attached or not.

const attached = new Set<number>()
const pending = new Map<number, Promise<void>>()
const RELAY_KEY = "agentRelayAttached"

/** Attaches the debugger to the tab; a tab this worker already attached is left as it is. */
export async function attach(tabId: number) {
  if (attached.has(tabId)) return
  const inflight = pending.get(tabId)
  if (inflight) return inflight
  const attaching = chrome.debugger
    .attach({ tabId }, "1.3")
    .catch(async (error: unknown) => {
      // After a service worker restart this extension's earlier attachment survives; probing proves it.
      if (!/already attached/i.test(message(error)) || !(await ownedByUs(tabId)))
        throw new Error(
          /already attached/i.test(message(error))
            ? "Another debugger (DevTools or another extension) is attached to this tab. Ask the user to close it, then retry."
            : `Could not attach to this tab: ${message(error)}`,
        )
    })
    .then(() => {
      attached.add(tabId)
    })
    .finally(() => pending.delete(tabId))
  pending.set(tabId, attaching)
  await attaching
  void persist()
}

/** Detaches the debugger from the tab; the tab's debugger does not need to be attached by this call. */
export async function detach(tabId: number) {
  attached.delete(tabId)
  void persist()
  await chrome.debugger.detach({ tabId }).catch(() => undefined)
}

/** The tabs this worker holds a debugger attachment on. */
export function attachedTabs() {
  return Array.from(attached)
}

/**
 * Restores the attachments after a service worker restart (Chrome keeps them, the worker's memory does not) or an
 * extension reload or update (the attachments are gone too, so the tabs are attached again). Either way the relay
 * gets its sessions' tabs back instead of losing them.
 *
 * An attachment that outlived the worker is replaced by a fresh one: whatever the old worker left half done on it
 * (a dialog or a paused child target nobody answered while no worker ran, which left every later command on the tab
 * timing out) goes with it, and the relay sets the tab up again from scratch anyway.
 */
export async function restore() {
  const stored = ((await chrome.storage.local.get(RELAY_KEY))[RELAY_KEY] ?? []) as unknown[]
  await Promise.all(
    stored.map(async (item) => {
      // Earlier versions stored bare tab ids.
      const { tabId, url } = typeof item === "number" ? { tabId: item, url: undefined } : (item as { tabId: number; url?: string })
      const tab = await chrome.tabs.get(tabId).catch(() => undefined)
      if (!tab) return
      if (await ownedByUs(tabId)) {
        await chrome.debugger.detach({ tabId }).catch(() => undefined)
        await attach(tabId).catch(() => undefined)
        return
      }
      // Tab ids restart with the browser; only re-attach the same page, never a stranger that reused the id.
      if (!url || tab.url !== url) return
      await attach(tabId).catch(() => undefined)
    }),
  )
  void persist()
}

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId === undefined) return
  attached.delete(source.tabId)
  void persist()
})

/** Set while the extension reloads itself: the detaches that follow mustn't erase the tabs it re-attaches. */
let frozen = false

/** Keeps the stored attachments as they are until the worker goes away (an extension reload). */
export function freeze() {
  frozen = true
}

const persistQueue = serialQueue()

/**
 * Stores the attached tabs. Writes run one at a time, each with the tabs as they are when its turn comes: side by
 * side, a slower write with an older list could land last and drop tabs attached meanwhile, which a worker restart
 * then lost.
 */
function persist() {
  return persistQueue(async () => {
    if (frozen) return
    const tabs = await Promise.all(
      attachedTabs().map(async (tabId) => ({ tabId, url: (await chrome.tabs.get(tabId).catch(() => undefined))?.url })),
    )
    if (!frozen) await chrome.storage.local.set({ [RELAY_KEY]: tabs })
  }).catch(() => undefined)
}

// Tab ids don't survive a browser restart.
chrome.runtime.onStartup.addListener(() => void chrome.storage.local.remove(RELAY_KEY))
// The stored URL identifies the page on re-attach, so keep it current.
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.url && attached.has(tabId)) void persist()
})

/** Chrome's attached flag includes DevTools and other extensions; a command only succeeds for ours. */
async function ownedByUs(tabId: number) {
  return chrome.debugger.sendCommand({ tabId }, "Target.getTargetInfo").then(
    () => true,
    () => false,
  )
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
