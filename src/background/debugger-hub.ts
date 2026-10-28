export * as DebuggerHub from "./debugger-hub"

// One chrome.debugger attachment per tab, shared by everything in this extension that drives tabs:
// today only the OpenCode Browser relay's agents. Chrome allows a single attachment
// per extension per tab, so each user registers as an owner and the tab detaches when the last one leaves.

const owners = new Map<number, Set<string>>()
const pending = new Map<number, Promise<void>>()
const RELAY_KEY = "agentRelayAttached"

/** Attaches `owner` to the tab, attaching the debugger only for the first owner. */
export async function attach(tabId: number, owner: string) {
  const current = owners.get(tabId)
  if (current?.size) {
    current.add(owner)
    return
  }
  const inflight = pending.get(tabId)
  if (inflight) {
    await inflight
    owners.get(tabId)?.add(owner)
    return
  }
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
      owners.set(tabId, new Set([...(owners.get(tabId) ?? []), owner]))
    })
    .finally(() => pending.delete(tabId))
  pending.set(tabId, attaching)
  await attaching
  void persist()
}

/** Removes `owner`; the debugger detaches once no owner remains. */
export async function detach(tabId: number, owner: string) {
  const current = owners.get(tabId)
  current?.delete(owner)
  void persist()
  if (current?.size) return
  owners.delete(tabId)
  await chrome.debugger.detach({ tabId }).catch(() => undefined)
}

export function tabsOwnedBy(owner: string) {
  return Array.from(owners, ([tabId, set]) => (set.has(owner) ? tabId : undefined)).filter(
    (tabId): tabId is number => tabId !== undefined,
  )
}

/**
 * Restores relay ownership after a service worker restart (Chrome keeps the attachments, the worker's memory
 * does not) or an extension reload or update (the attachments are gone too, so the tabs are attached again).
 * Either way the relay gets its sessions' tabs back instead of losing them.
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
        await attach(tabId, "relay").catch(() => undefined)
        return
      }
      // Tab ids restart with the browser; only re-attach the same page, never a stranger that reused the id.
      if (!url || tab.url !== url) return
      await attach(tabId, "relay").catch(() => undefined)
    }),
  )
  void persist()
}

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId === undefined) return
  owners.delete(source.tabId)
  void persist()
})

/** Set while the extension reloads itself: the detaches that follow mustn't erase the tabs it re-attaches. */
let frozen = false

/** Keeps the stored attachments as they are until the worker goes away (an extension reload). */
export function freeze() {
  frozen = true
}

let persisting: Promise<unknown> = Promise.resolve()

/**
 * Stores the relay's tabs. Writes run one at a time, each with the tabs as they are when its turn comes: side by side,
 * a slower write with an older list could land last and drop tabs attached meanwhile, which a worker restart then lost.
 */
function persist() {
  persisting = persisting
    .then(async () => {
      if (frozen) return
      const tabs = await Promise.all(
        tabsOwnedBy("relay").map(async (tabId) => ({ tabId, url: (await chrome.tabs.get(tabId).catch(() => undefined))?.url })),
      )
      if (!frozen) await chrome.storage.local.set({ [RELAY_KEY]: tabs })
    })
    .catch(() => undefined)
  return persisting
}

// Tab ids don't survive a browser restart.
chrome.runtime.onStartup.addListener(() => void chrome.storage.local.remove(RELAY_KEY))
// The stored URL identifies the page on re-attach, so keep it current.
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.url && owners.get(tabId)?.has("relay")) void persist()
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
