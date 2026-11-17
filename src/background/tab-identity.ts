export * as TabIdentity from "./tab-identity"
import { ownedGroup, TIMED_OUT, withTimeout } from "./agent-relay/wire"
import { serialQueue } from "./serial"

// A tab's stable browse id while the browser runs, kept in chrome.storage.local by tab id. Chrome has no values per
// tab (chrome.sessions is Firefox's tab-values API), and local storage outlives an extension update or reload along
// with the tab ids. Without a session marker only ids on tabs in browse's groups survive that, so an agent tab with
// grouping on keeps its id but a lent or ungrouped tab does not. A browser restart gives every tab a new id: onStartup
// drops the lot, and the session check below does when that event never came (the extension was disabled at shutdown).
//
// Values written here:
// - browseId: an opaque id, made the first time browse attaches or opens the tab.
// - browseAgent: "1" while the tab is one an agent opened (idle cleanup closes it), "0" for a tab the user lent.
// - browseChosen: the id the caller chose (`work-mail`), if any: such a tab is never idle-closed.

export const BROWSE_ID_KEY = "browseId"
export const BROWSE_AGENT_KEY = "browseAgent"
export const BROWSE_CHOSEN_KEY = "browseChosen"

/** A read that timed out: the answer is unknown, not absent. Truthy, so a never-close guard fails safe. */
export const UNKNOWN = Symbol("unknown")
export type ReadValue = string | undefined | typeof UNKNOWN

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
let prepared: Promise<boolean> | undefined
let session: Promise<boolean | undefined> | undefined

/** One at a time: every change reads the stored map, so one mustn't write over a change to another tab. */
const writes = serialQueue()

/** A value from a browser call, or undefined when it timed out. */
async function within<T>(work: Promise<T>): Promise<T | undefined> {
  const result = await withTimeout(work, TIMEOUT_MS)
  return result === TIMED_OUT ? undefined : result
}

/** Whether a browser call finished before its timeout; its value doesn't matter. */
async function finished(work: Promise<unknown>) {
  return (await withTimeout(work.catch(() => undefined), TIMEOUT_MS)) !== TIMED_OUT
}

/** The stored map, or undefined when reading it timed out: writing then would drop the other tabs' values. */
async function stored(): Promise<Stored | undefined> {
  const all = await within(chrome.storage.local.get(STORAGE_KEY).catch(() => ({} as Record<string, unknown>)))
  if (all === undefined) return undefined
  const value = all[STORAGE_KEY]
  return value && typeof value === "object" ? (value as Stored) : {}
}

async function save(all: Stored) {
  return finished(chrome.storage.local.set({ [STORAGE_KEY]: all }))
}

async function clearStored() {
  return finished(chrome.storage.local.remove(STORAGE_KEY))
}

/** Whether the stored values were written in the browser session still running; undefined when that can't be read. */
function sessionMarker() {
  session ??= (async () => {
    const marker = await within(chrome.storage.session.get(SESSION_KEY).catch(() => ({} as Record<string, unknown>)))
    // A timed-out read says nothing: retry later instead of calling it a new browser session.
    if (marker === undefined) return undefined
    return marker[SESSION_KEY] === true
  })().then((value) => {
    if (value === undefined) session = undefined
    return value
  })
  return session
}

/**
 * Once per worker: drops values from an older browser session. Session storage is cleared by a browser restart and
 * an extension reload or update alike, so without the marker only ids still on unpinned tabs in browse's groups
 * survive; that is the rule tab-cleanup uses, and it keeps grouping-on agent tabs but not lent or ungrouped ones.
 * Answers false when a read timed out, so the caller retries instead of trusting an unknown map.
 */
async function reconcile(): Promise<boolean> {
  const mine = generation
  const known = await sessionMarker()
  if (known === undefined) return false
  if (known) return true
  const all = await stored()
  if (!all || mine !== generation) return false
  // Nothing stored to lose: mark this session and let the next tab event go without waiting for a check.
  if (!Object.keys(all).length) {
    session = undefined
    await finished(chrome.storage.session.set({ [SESSION_KEY]: true }))
    return true
  }
  const tabs = await within(chrome.tabs.query({}).catch(() => [] as chrome.tabs.Tab[]))
  if (!tabs || mine !== generation) return false
  const groups = await within(chrome.tabGroups.query({}).catch(() => [] as chrome.tabGroups.TabGroup[]))
  if (!groups || mine !== generation) return false
  const open = new Map(tabs.filter((tab) => tab.id !== undefined).map((tab) => [tab.id!, tab]))
  const owned = new Set(groups.filter((group) => ownedGroup(group.title)).map((group) => group.id))
  const kept: Stored = {}
  for (const [tabId, values] of Object.entries(all)) {
    const tab = open.get(Number(tabId))
    if (!tab || tab.pinned || !owned.has(tab.groupId)) continue
    kept[tabId] = values
  }
  const wrote = Object.keys(kept).length ? await save(kept) : await clearStored()
  if (!wrote || mine !== generation) return false
  session = undefined
  await finished(chrome.storage.session.set({ [SESSION_KEY]: true }))
  return true
}

/** Runs the session check once; a check that couldn't decide is forgotten so the next call tries again. */
function prepare(): Promise<boolean> {
  if (prepared) return prepared
  let running: Promise<boolean> | undefined
  running = writes(reconcile).then((settled) => {
    // A check that couldn't decide is retried, unless a browser start already replaced it with the wipe.
    if (!settled && prepared === running) prepared = undefined
    return settled
  })
  prepared = running
  return running
}

const ABORT = Symbol("abort")

function mutate<T>(tabId: number, change: (values: Values) => T | typeof ABORT | Promise<T | typeof ABORT>): Promise<T | undefined> {
  return writes(async () => {
    const mine = generation
    const all = await stored()
    if (!all || mine !== generation) return undefined
    const values = all[tabId] ?? {}
    const result = await change(values)
    if (result === ABORT || mine !== generation) return undefined
    if (Object.keys(values).length) all[tabId] = values
    else delete all[tabId]
    if (!(await save(all))) return undefined
    return result
  })
}

/**
 * The tab's stable browse id, made and stored the first time. `agent` says who opened the tab, and is stored only
 * while the tab has no answer yet: setAgent is what changes it, so a lend can't lose to a racing attach.
 */
export async function ensure(tabId: number, options: { agent?: boolean; chosen?: string } = {}): Promise<string | undefined> {
  if (!(await prepare())) return undefined
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
export async function ensureOwned(tabId: number, tracked: () => boolean | Promise<boolean>): Promise<{ browseId: string; agent: boolean } | undefined> {
  if (!(await prepare())) return undefined
  return mutate(tabId, async (values) => {
    values[BROWSE_ID_KEY] ??= crypto.randomUUID()
    let agent: boolean
    if (values[BROWSE_AGENT_KEY] === undefined) {
      const answer = await withTimeout(Promise.resolve().then(tracked).catch(() => TIMED_OUT), TIMEOUT_MS)
      if (typeof answer === "symbol") return ABORT
      agent = answer
    } else {
      agent = values[BROWSE_AGENT_KEY] === "1"
    }
    values[BROWSE_AGENT_KEY] = agent ? "1" : "0"
    return { browseId: values[BROWSE_ID_KEY]!, agent }
  })
}

export async function read(tabId: number, key: string): Promise<ReadValue> {
  if (!(await prepare())) return UNKNOWN
  const all = await stored()
  if (!all) return UNKNOWN
  const value = all[tabId]?.[key]
  return typeof value === "string" && value ? value : undefined
}

export async function browseId(tabId: number) {
  return read(tabId, BROWSE_ID_KEY)
}

export async function chosen(tabId: number) {
  return read(tabId, BROWSE_CHOSEN_KEY)
}

export async function isAgent(tabId: number): Promise<boolean | undefined | typeof UNKNOWN> {
  const value = await read(tabId, BROWSE_AGENT_KEY)
  if (value === UNKNOWN) return UNKNOWN
  return value === undefined ? undefined : value === "1"
}

export async function setAgent(tabId: number, agent: boolean) {
  if (!(await prepare())) return
  await mutate(tabId, (values) => {
    values[BROWSE_AGENT_KEY] = agent ? "1" : "0"
  })
}

/** Forgets the tab's id: it is no longer an agent's (or lent) tab, or it has closed. */
export async function clear(tabId: number) {
  if (!(await prepare())) return
  await writes(async () => {
    const mine = generation
    const all = await stored()
    if (!all || mine !== generation) return
    if (!(tabId in all)) return
    delete all[tabId]
    await save(all)
  })
}

/** Drops every stored id on a browser start, then marks the new session so later tasks trust what they write. */
function wipe(): Promise<boolean> {
  return writes(async () => {
    await clearStored()
    await finished(chrome.storage.session.set({ [SESSION_KEY]: true }))
    return true
  })
}

// Tab ids are new after a browser restart: drop every stored id, and let a task that began before this land nowhere.
chrome.runtime.onStartup.addListener(() => {
  generation += 1
  session = undefined
  prepared = wipe()
})
