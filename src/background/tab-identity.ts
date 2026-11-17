export * as TabIdentity from "./tab-identity"
import { ownedGroup, TIMED_OUT, withTimeout } from "./agent-relay/wire"
import { serialQueue } from "./serial"

// A tab's stable browse id while the browser runs, kept in chrome.storage.local by tab id. Chrome has no values per
// tab (chrome.sessions is Firefox's tab-values API), and local storage outlives an extension update or reload along
// with the tab ids, so an agent keeps the id it knows a tab by across them. A browser restart gives every tab a new
// id: onStartup drops the lot, and the session check below drops it when that event never came (the extension was
// disabled at the last shutdown).
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
/** chrome.storage.session: set once per browser session; a missing marker means a browser restart or extension reload. */
const SESSION_KEY = "tabIdentitySession"
/** A browser call that never settles must not hold the queue or a reconnect. */
const TIMEOUT_MS = 2_000

type Values = Record<string, string | undefined>
type Stored = Record<string, Values>

/** Bumped on browser start: a task that began under an older generation must not write. */
let generation = 0
let prepared: Promise<void> | undefined
let session: Promise<boolean> | undefined

/** One at a time: every change reads the stored map, so one mustn't write over a change to another tab. */
const writes = serialQueue()

async function within<T>(work: Promise<T>): Promise<T | undefined> {
  const result = await withTimeout(work, TIMEOUT_MS)
  return result === TIMED_OUT ? undefined : result
}

/** The stored map, or undefined when reading it timed out: writing then would drop the other tabs' values. */
async function stored(): Promise<Stored | undefined> {
  const all = await within(chrome.storage.local.get(STORAGE_KEY).catch(() => ({} as Record<string, unknown>)))
  if (all === undefined) return undefined
  const value = all[STORAGE_KEY]
  return value && typeof value === "object" ? (value as Stored) : {}
}

async function save(all: Stored) {
  await within(chrome.storage.local.set({ [STORAGE_KEY]: all }).catch(() => undefined))
}

async function clearStored() {
  await within(chrome.storage.local.remove(STORAGE_KEY).catch(() => undefined))
}

/** Whether the stored values were written in the browser session still running. */
function sameBrowserSession() {
  session ??= (async () => {
    const stored = await within(chrome.storage.session.get(SESSION_KEY).catch(() => ({} as Record<string, unknown>)))
    if (stored?.[SESSION_KEY] === true) return true
    await within(chrome.storage.session.set({ [SESSION_KEY]: true }).catch(() => undefined))
    return false
  })()
  return session
}

/**
 * Once per worker: drops values from an older browser session. Session storage is cleared by a browser restart and
 * an extension reload alike, so without the marker only ids still on tabs in browse's groups survive: a reload keeps
 * the tab ids, a restart doesn't. This is the rule tab-cleanup uses for its list.
 */
function prepare(): Promise<void> {
  prepared ??= writes(async () => {
    const mine = generation
    if (await sameBrowserSession()) return
    const [tabs, groups] = await Promise.all([
      within(chrome.tabs.query({}).catch(() => [] as chrome.tabs.Tab[])),
      within(chrome.tabGroups.query({}).catch(() => [] as chrome.tabGroups.TabGroup[])),
    ])
    if (mine !== generation) return
    const open = new Map((tabs ?? []).filter((tab) => tab.id !== undefined).map((tab) => [tab.id!, tab]))
    const owned = new Set((groups ?? []).filter((group) => ownedGroup(group.title)).map((group) => group.id))
    const all = await stored()
    if (!all || mine !== generation) return
    const kept: Stored = {}
    for (const [tabId, values] of Object.entries(all)) {
      const tab = open.get(Number(tabId))
      if (!tab || tab.pinned || !owned.has(tab.groupId)) continue
      kept[tabId] = values
    }
    if (Object.keys(kept).length) await save(kept)
    else await clearStored()
  })
  return prepared
}

function mutate<T>(tabId: number, change: (values: Values) => T | Promise<T>): Promise<T | undefined> {
  return writes(async () => {
    const mine = generation
    const all = await stored()
    if (!all || mine !== generation) return undefined
    const values = all[tabId] ?? {}
    const result = await change(values)
    if (mine !== generation) return undefined
    if (Object.keys(values).length) all[tabId] = values
    else delete all[tabId]
    await save(all)
    return result
  })
}

/**
 * The tab's stable browse id, made and stored the first time. `agent` says who opened the tab, and is stored only
 * while the tab has no answer yet: setAgent is what changes it, so a lend can't lose to a racing attach.
 */
export function ensure(tabId: number, options: { agent?: boolean; chosen?: string } = {}): Promise<string | undefined> {
  return prepare().then(() =>
    mutate(tabId, (values) => {
      values[BROWSE_ID_KEY] ??= crypto.randomUUID()
      if (options.agent !== undefined) values[BROWSE_AGENT_KEY] ??= options.agent ? "1" : "0"
      if (options.chosen) values[BROWSE_CHOSEN_KEY] = options.chosen
      return values[BROWSE_ID_KEY]
    }),
  )
}

/**
 * The tab's stable id and whether an agent owns it, for a relay that connects again. A stored answer wins; `tracked`
 * says who opened the tab when there is none. The read and the write share the queue, so a lend or clear that lands
 * meanwhile isn't undone by a stale answer.
 */
export function ensureOwned(tabId: number, tracked: () => boolean | Promise<boolean>): Promise<{ browseId: string; agent: boolean } | undefined> {
  return prepare().then(() =>
    mutate(tabId, async (values) => {
      values[BROWSE_ID_KEY] ??= crypto.randomUUID()
      const agent = values[BROWSE_AGENT_KEY] === undefined ? await tracked() : values[BROWSE_AGENT_KEY] === "1"
      values[BROWSE_AGENT_KEY] = agent ? "1" : "0"
      return { browseId: values[BROWSE_ID_KEY]!, agent }
    }),
  )
}

export async function read(tabId: number, key: string): Promise<string | undefined> {
  await prepare()
  const value = (await stored())?.[tabId]?.[key]
  return typeof value === "string" && value ? value : undefined
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
  return prepare().then(() =>
    mutate(tabId, (values) => {
      values[BROWSE_AGENT_KEY] = agent ? "1" : "0"
    }),
  )
}

/** Forgets the tab's id: it is no longer an agent's (or lent) tab, or it has closed. */
export function clear(tabId: number) {
  return prepare().then(() =>
    writes(async () => {
      const mine = generation
      const all = await stored()
      if (!all || mine !== generation) return
      if (!(tabId in all)) return
      delete all[tabId]
      await save(all)
    }),
  )
}

// Tab ids are new after a browser restart: drop every stored id, and let a task that began before this land nowhere.
chrome.runtime.onStartup.addListener(() => {
  generation += 1
  prepared = undefined
  session = undefined
  void writes(async () => {
    await clearStored()
    await within(chrome.storage.session.remove(SESSION_KEY).catch(() => undefined))
  })
})
