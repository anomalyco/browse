export * as TabIdentity from "./tab-identity"

// A tab's stable browse id, kept on the tab itself with chrome.sessions: Chrome restores it with the tab after a
// browser restart, when the tab's numeric id and CDP target are both new. The id is what lets the relay give a
// restored tab back under the id agents already know it by (`work-mail`, or the tab id from `tabs new`).
//
// Values written here:
// - browseId: an opaque id, made the first time browse attaches or opens the tab.
// - browseAgent: "1" while the tab is one an agent opened (idle cleanup closes it), "0" for a tab the user lent.
// - browseChosen: the id the caller chose (`work-mail`), if any: such a tab is never idle-closed.

export const BROWSE_ID_KEY = "browseId"
export const BROWSE_AGENT_KEY = "browseAgent"
export const BROWSE_CHOSEN_KEY = "browseChosen"

/** The tab values API (chrome.sessions), which @types/chrome doesn't declare yet. */
type TabValues = {
  getTabValue(tabId: number, key: string): Promise<unknown>
  setTabValue(tabId: number, key: string, value: unknown): Promise<void>
  removeTabValue(tabId: number, key: string): Promise<void>
}

export type RestoredTab = { readonly tabId: number; readonly browseId: string; readonly agent: boolean; readonly chosen?: string }

const values = () => (chrome as unknown as { sessions?: Partial<TabValues> }).sessions

export async function read(tabId: number, key: string): Promise<string | undefined> {
  try {
    const value = await values()?.getTabValue?.(tabId, key)
    return typeof value === "string" && value ? value : undefined
  } catch {
    return undefined
  }
}

async function write(tabId: number, key: string, value: string) {
  try {
    await values()?.setTabValue?.(tabId, key, value)
  } catch {
    // A browser without session tab values still works within this browser session.
  }
}

/** The tab's stable browse id, made and stored on the tab the first time. */
export async function ensure(tabId: number, options: { agent?: boolean; chosen?: string } = {}): Promise<string | undefined> {
  let browseId = await read(tabId, BROWSE_ID_KEY)
  if (!browseId) {
    browseId = crypto.randomUUID()
    await write(tabId, BROWSE_ID_KEY, browseId)
  }
  if (options.agent !== undefined) await write(tabId, BROWSE_AGENT_KEY, options.agent ? "1" : "0")
  if (options.chosen) await write(tabId, BROWSE_CHOSEN_KEY, options.chosen)
  return browseId
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

/** Forgets the tab's id: it is no longer an agent's (or lent) tab. */
export async function clear(tabId: number) {
  const api = values()
  if (!api?.removeTabValue) return
  for (const key of [BROWSE_ID_KEY, BROWSE_AGENT_KEY, BROWSE_CHOSEN_KEY]) {
    try {
      await api.removeTabValue(tabId, key)
    } catch {
      // The tab is already gone, or the browser doesn't keep tab values.
    }
  }
}

/**
 * Tabs Chrome restored with a browse id on them (a browser restart, or a worker that started later): the relay can
 * claim them under their old ids. `agent` says whether idle cleanup may close the tab.
 */
export async function restored(): Promise<RestoredTab[]> {
  const tabs = await chrome.tabs.query({}).catch(() => [] as chrome.tabs.Tab[])
  const found: RestoredTab[] = []
  for (const tab of tabs) {
    if (tab.id === undefined) continue
    const id = await browseId(tab.id)
    if (!id) continue
    const agent = (await isAgent(tab.id)) !== false
    const name = await chosen(tab.id)
    found.push({ tabId: tab.id, browseId: id, agent, ...(name ? { chosen: name } : {}) })
  }
  return found
}
