export * as TabIdentity from "./tab-identity"
import { serialQueue } from "./serial"

// A tab's stable browse id for this browser session, kept in chrome.storage.session by tab id. Chrome has no values
// per tab (chrome.sessions is Firefox's tab-values API), and session storage outlives a service worker restart, so a
// tab keeps the id agents know it by while the browser runs. A browser restart (or an extension reload) clears it
// along with the tab ids: nothing can be reclaimed then.
//
// Values written here:
// - browseId: an opaque id, made the first time browse attaches or opens the tab.
// - browseAgent: "1" while the tab is one an agent opened (idle cleanup closes it), "0" for a tab the user lent.
// - browseChosen: the id the caller chose (`work-mail`), if any: such a tab is never idle-closed.

export const BROWSE_ID_KEY = "browseId"
export const BROWSE_AGENT_KEY = "browseAgent"
export const BROWSE_CHOSEN_KEY = "browseChosen"

export type RestoredTab = { readonly tabId: number; readonly browseId: string; readonly agent: boolean; readonly chosen?: string }

const PREFIX = "tabIdentity:"
const storageKey = (tabId: number, key: string) => `${PREFIX}${tabId}:${key}`

export async function read(tabId: number, key: string): Promise<string | undefined> {
  const name = storageKey(tabId, key)
  const stored = await chrome.storage.session.get(name).catch(() => ({}) as Record<string, unknown>)
  const value = stored[name]
  return typeof value === "string" && value ? value : undefined
}

async function write(tabId: number, key: string, value: string) {
  // The browser may be shutting down, which drops session storage anyway.
  await chrome.storage.session.set({ [storageKey(tabId, key)]: value }).catch(() => undefined)
}

/** One at a time, so two callers can't read no id and each make one for the same tab. */
const ensureQueue = serialQueue()

/** The tab's stable browse id, made and stored the first time. */
export function ensure(tabId: number, options: { agent?: boolean; chosen?: string } = {}): Promise<string | undefined> {
  return ensureQueue(async () => {
    let browseId = await read(tabId, BROWSE_ID_KEY)
    if (!browseId) {
      browseId = crypto.randomUUID()
      await write(tabId, BROWSE_ID_KEY, browseId)
    }
    if (options.agent !== undefined) await write(tabId, BROWSE_AGENT_KEY, options.agent ? "1" : "0")
    if (options.chosen) await write(tabId, BROWSE_CHOSEN_KEY, options.chosen)
    return browseId
  })
}

export async function browseId(tabId: number) {
  return read(tabId, BROWSE_ID_KEY)
}

export async function chosen(tabId: number) {
  return read(tabId, BROWSE_CHOSEN_KEY)
}

export async function isAgent(tabId: number) {
  const value = await read(tabId, BROWSE_AGENT_KEY)
  return value === undefined ? undefined : value === "1"
}

export async function setAgent(tabId: number, agent: boolean) {
  await write(tabId, BROWSE_AGENT_KEY, agent ? "1" : "0")
}

/** Forgets the tab's id: it is no longer an agent's (or lent) tab, or it has closed. */
export async function clear(tabId: number) {
  const keys = [BROWSE_ID_KEY, BROWSE_AGENT_KEY, BROWSE_CHOSEN_KEY].map((key) => storageKey(tabId, key))
  await chrome.storage.session.remove(keys).catch(() => undefined)
}

/**
 * Tabs a browser restart brought back with a browse id on them. Chrome keeps no values on a tab and clears session
 * storage with the browser session, so a restored tab has no id to bring back: this finds none.
 */
export async function restored(): Promise<RestoredTab[]> {
  return []
}
