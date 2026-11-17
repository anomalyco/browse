export * as TabIdentity from "./tab-identity"
import { serialQueue } from "./serial"

// A tab's stable browse id while the browser runs, kept in chrome.storage.local by tab id. Chrome has no values per
// tab (chrome.sessions is Firefox's tab-values API), and local storage outlives an extension update or reload along
// with the tab ids, so an agent keeps the id it knows a tab by across them. A browser restart gives every tab a new
// id, so onStartup drops the lot.
//
// Values written here:
// - browseId: an opaque id, made the first time browse attaches or opens the tab.
// - browseAgent: "1" while the tab is one an agent opened (idle cleanup closes it), "0" for a tab the user lent.
// - browseChosen: the id the caller chose (`work-mail`), if any: such a tab is never idle-closed.

export const BROWSE_ID_KEY = "browseId"
export const BROWSE_AGENT_KEY = "browseAgent"
export const BROWSE_CHOSEN_KEY = "browseChosen"

/** chrome.storage.local: the values, by tab id. */
const STORAGE_KEY = "tabIdentity"

type Values = Record<string, string | undefined>
type Stored = Record<string, Values>

async function stored(): Promise<Stored> {
  const all = (await chrome.storage.local.get(STORAGE_KEY).catch(() => ({}))) as Record<string, unknown>
  const value = all[STORAGE_KEY]
  return value && typeof value === "object" ? (value as Stored) : {}
}

export async function read(tabId: number, key: string): Promise<string | undefined> {
  const value = (await stored())[tabId]?.[key]
  return typeof value === "string" && value ? value : undefined
}

/** One at a time: every change reads the stored map, so one mustn't write over a change to another tab. */
const writes = serialQueue()

function mutate<T>(tabId: number, change: (values: Values) => T | Promise<T>): Promise<T> {
  return writes(async () => {
    const all = await stored()
    const values = all[tabId] ?? {}
    const result = await change(values)
    if (Object.keys(values).length) all[tabId] = values
    else delete all[tabId]
    await chrome.storage.local.set({ [STORAGE_KEY]: all }).catch(() => undefined)
    return result
  })
}

/**
 * The tab's stable browse id, made and stored the first time. `agent` says who opened the tab, and is stored only
 * while the tab has no answer yet: setAgent is what changes it, so a lend can't lose to a racing attach.
 */
export function ensure(tabId: number, options: { agent?: boolean; chosen?: string } = {}): Promise<string | undefined> {
  return mutate(tabId, (values) => {
    values[BROWSE_ID_KEY] ??= crypto.randomUUID()
    if (options.agent !== undefined) values[BROWSE_AGENT_KEY] ??= options.agent ? "1" : "0"
    if (options.chosen) values[BROWSE_CHOSEN_KEY] = options.chosen
    return values[BROWSE_ID_KEY]
  })
}

/**
 * The tab's stable id and whether an agent owns it, for a relay that connects again. A stored answer wins; `tracked`
 * says who opened the tab when there is none. The read and the write share the queue, so a lend or clear that lands
 * meanwhile isn't undone by a stale answer.
 */
export function ensureOwned(tabId: number, tracked: () => boolean | Promise<boolean>): Promise<{ browseId: string; agent: boolean }> {
  return mutate(tabId, async (values) => {
    values[BROWSE_ID_KEY] ??= crypto.randomUUID()
    const agent = values[BROWSE_AGENT_KEY] === undefined ? await tracked() : values[BROWSE_AGENT_KEY] === "1"
    values[BROWSE_AGENT_KEY] = agent ? "1" : "0"
    return { browseId: values[BROWSE_ID_KEY]!, agent }
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

export function setAgent(tabId: number, agent: boolean) {
  return mutate(tabId, (values) => {
    values[BROWSE_AGENT_KEY] = agent ? "1" : "0"
  })
}

/** Forgets the tab's id: it is no longer an agent's (or lent) tab, or it has closed. */
export function clear(tabId: number) {
  return writes(async () => {
    const all = await stored()
    if (!(tabId in all)) return
    delete all[tabId]
    await chrome.storage.local.set({ [STORAGE_KEY]: all }).catch(() => undefined)
  })
}

// Tab ids are new after a browser restart: the stored ids belong to tabs that no longer exist.
chrome.runtime.onStartup.addListener(() => void chrome.storage.local.remove(STORAGE_KEY))
