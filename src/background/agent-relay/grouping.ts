import { isJsonObject } from "../../agent-relay/protocol"
import { AgentGroups } from "./groups"
import { serialQueue } from "../serial"
import { TabCleanup } from "../tab-cleanup"
import {
  autoNamed,
  GROUP_COLOR,
  groupTitle,
  ownedGroup,
  SESSION_GROUPS_KEY,
  sharedGroup,
  sharedTitle,
  type AgentRelayLog,
} from "./wire"

export function createRelayGrouping(deps: {
  readonly log: AgentRelayLog
  readonly relayTabs: Set<number>
  readonly currentSocket: () => WebSocket | undefined
  readonly isReloading: () => boolean
}) {
  /**
   * Each agent session's tab group, so a session keeps one group while its display name changes. Stored, so a service
   * worker restart doesn't put a session's next tab in a second group. Group ids don't survive a browser restart.
   */
  const sessionGroups = new Map<string, number>()
  let sessionGroupsRestored: Promise<void> | undefined
  let recount: ReturnType<typeof setTimeout> | undefined

  const restoreSessionGroups = () =>
    (sessionGroupsRestored ??= chrome.storage.local
      .get(SESSION_GROUPS_KEY)
      .then((stored) => {
        const saved = stored[SESSION_GROUPS_KEY]
        if (!isJsonObject(saved)) return
        for (const [key, groupId] of Object.entries(saved))
          if (typeof groupId === "number" && !sessionGroups.has(key)) sessionGroups.set(key, groupId)
      })
      .catch(() => undefined))

  const setSessionGroup = (key: string, groupId: number) => {
    if (sessionGroups.get(key) === groupId) return
    sessionGroups.set(key, groupId)
    void chrome.storage.local.set({ [SESSION_GROUPS_KEY]: Object.fromEntries(sessionGroups) }).catch(() => undefined)
  }

  const serially = serialQueue()

  /** Keeps a shared group's title counting its tabs. */
  const countShared = async (groupId: number) => {
    const item = await chrome.tabGroups.get(groupId).catch(() => undefined)
    if (!item || !sharedGroup(item.title)) return
    const count = (await chrome.tabs.query({ groupId }).catch(() => [])).length
    if (count && item.title !== sharedTitle(count))
      await chrome.tabGroups.update(groupId, { title: sharedTitle(count) }).catch(() => undefined)
  }

  /** Recounts every shared group soon: tabs closed, moved, or left or joined a group. */
  const recountShared = () => {
    clearTimeout(recount)
    recount = setTimeout(() => {
      void chrome.tabGroups
        .query({})
        .then(async (groups) => {
          for (const item of groups) if (sharedGroup(item.title)) await countShared(item.id)
        })
        .catch(() => undefined)
    }, 100)
  }

  /**
   * The shared group: one per window ("Agents · 3"), for every agent session's tabs, collapsed like a session's group.
   * Run one at a time so concurrent sessions find the group the first one made instead of each making one.
   */
  const groupShared = async (tabId: number, current: WebSocket) => {
    const tab = await chrome.tabs.get(tabId)
    const target = (await chrome.tabGroups.query({ windowId: tab.windowId })).find(
      (item) => item.windowId === tab.windowId && sharedGroup(item.title),
    )
    let groupId = target?.id
    if (groupId !== undefined) {
      if (tab.groupId !== groupId) await chrome.tabs.group({ tabIds: [tabId], groupId })
    } else {
      if (deps.currentSocket() !== current) throw new Error("The relay reconnected while grouping the tab")
      groupId = await chrome.tabs.group({ tabIds: [tabId], createProperties: { windowId: tab.windowId } })
      if (deps.currentSocket() !== current) {
        await chrome.tabs.ungroup(tabId).catch(() => undefined)
        throw new Error("The relay reconnected while grouping the tab")
      }
      await chrome.tabGroups.update(groupId, { title: sharedTitle(1), color: GROUP_COLOR })
    }
    await countShared(groupId)
    await AgentGroups.adopt(groupId)
    return groupId
  }

  /**
   * Puts an agent's tab in its group, by the Grouping setting: the window's shared group (the default), the
   * session's group, or none. A tab already in an agent group of another kind (the setting changed since) stays where it is:
   * new tabs follow the new setting, and tabs aren't moved around under the user.
   */
  const group = async (tabId: number, sessionId: string | undefined, current: WebSocket) => {
    const tab = await chrome.tabs.get(tabId)
    // window.open(..., "popup") has no tab strip. A group here can't join the opener's group; creating
    // and naming a separate saved group needlessly blocks Chrome's UI thread during concurrent opens.
    if ((await chrome.windows.get(tab.windowId)).type === "popup") return chrome.tabGroups.TAB_GROUP_ID_NONE
    const mode = await AgentGroups.mode()
    const existing =
      tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE ? undefined : await chrome.tabGroups.get(tab.groupId).catch(() => undefined)
    if (existing && ownedGroup(existing.title) && (mode === "none" || sharedGroup(existing.title) !== (mode === "shared"))) {
      await AgentGroups.adopt(existing.id)
      return existing.id
    }
    if (mode === "none") return chrome.tabGroups.TAB_GROUP_ID_NONE
    if (mode === "shared") return serially(() => groupShared(tabId, current))
    const title = groupTitle(sessionId, tab.url)
    const key = sessionId ?? ""
    await restoreSessionGroups()
    const known = sessionGroups.get(key)
    let target = known === undefined ? undefined : await chrome.tabGroups.get(known).catch(() => undefined)
    // The tab is already in a session group of ours the session has no record of (a worker restart lost it): it is
    // the session's group, so its other tabs join it rather than a new one.
    if ((!target || target.windowId !== tab.windowId) && existing && ownedGroup(existing.title) && !sharedGroup(existing.title)) {
      target = existing
      setSessionGroup(key, existing.id)
    }
    if (target && target.windowId === tab.windowId && ownedGroup(target.title)) {
      if (tab.groupId !== target.id) await chrome.tabs.group({ tabIds: [tabId], groupId: target.id })
      if (target.title !== title) await chrome.tabGroups.update(target.id, { title, color: GROUP_COLOR })
      await AgentGroups.adopt(target.id)
      return target.id
    }
    if (deps.currentSocket() !== current) throw new Error("The relay reconnected while grouping the tab")
    const groupId = await chrome.tabs.group({ tabIds: [tabId], createProperties: { windowId: tab.windowId } })
    // chrome.tabs.group changes the tab before it resolves, so a stale command undoes its anonymous group.
    if (deps.currentSocket() !== current) {
      await chrome.tabs.ungroup(tabId).catch(() => undefined)
      throw new Error("The relay reconnected while grouping the tab")
    }
    await chrome.tabGroups.update(groupId, { title, color: GROUP_COLOR })
    setSessionGroup(key, groupId)
    await AgentGroups.adopt(groupId)
    return groupId
  }

  /** Auto-named sessions take their group name from the site the agent is on, so it follows navigation. */
  const renameForPage = async (tabId: number, url: string | undefined) => {
    const tab = await chrome.tabs.get(tabId).catch(() => undefined)
    if (!tab || tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE) return
    await restoreSessionGroups()
    const sessionId = Array.from(sessionGroups).find(([, id]) => id === tab.groupId)?.[0]
    if (sessionId === undefined || !autoNamed(sessionId)) return
    const current = await chrome.tabGroups.get(tab.groupId).catch(() => undefined)
    const title = groupTitle(sessionId, url)
    if (current && ownedGroup(current.title) && current.title !== title)
      await chrome.tabGroups.update(current.id, { title }).catch(() => undefined)
  }

  /**
   * The relay is done with a tab. A tab an agent opened closes with its group rather than spilling into the
   * user's tabs; a tab the user lent an agent just leaves the group. With grouping off an agent's tab has no group:
   * it closes when the relay detaches it (`finished`, the toolbar button on it) like a grouped one does. A tab in a
   * group of the user's own is theirs and stays.
   */
  const ungroup = async (tabId: number, options: { finished?: boolean } = {}) => {
    const tab = await chrome.tabs.get(tabId).catch(() => undefined)
    if (!tab) return
    const grouped = tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE
    if (!grouped && !options.finished) return
    const current = grouped ? await chrome.tabGroups.get(tab.groupId).catch(() => undefined) : undefined
    if (grouped && !ownedGroup(current?.title)) return
    if (!deps.isReloading() && (await TabCleanup.isTracked(tabId))) {
      deps.log.add("tab.closed", { tabId, reason: "agent finished with it" })
      await chrome.tabs.remove(tabId).catch(() => undefined)
      return
    }
    if (grouped) await chrome.tabs.ungroup(tabId).catch(() => undefined)
  }

  /**
   * After a restart, relay groups may hold tabs the relay no longer uses. Tabs an agent opened stay in their group
   * (the relay reclaims a named session's tabs, and idle cleanup closes the rest), so a restart never leaves loose
   * agent tabs behind; a tab the user lent an agent goes back to being an ordinary tab.
   */
  const ungroupStale = async () => {
    const groups = (await chrome.tabGroups.query({})).filter((item) => ownedGroup(item.title))
    for (const item of groups)
      for (const tab of await chrome.tabs.query({ groupId: item.id }))
        if (tab.id !== undefined && !deps.relayTabs.has(tab.id) && !(await TabCleanup.isTracked(tab.id)))
          await chrome.tabs.ungroup(tab.id).catch(() => undefined)
  }

  const onGroupRemoved = (removed: chrome.tabGroups.TabGroup) => {
    void restoreSessionGroups().then(() => {
      const keys = Array.from(sessionGroups)
        .filter(([, groupId]) => groupId === removed.id)
        .map(([key]) => key)
      if (!keys.length) return
      keys.forEach((key) => sessionGroups.delete(key))
      void chrome.storage.local.set({ [SESSION_GROUPS_KEY]: Object.fromEntries(sessionGroups) }).catch(() => undefined)
    })
  }

  const onBrowserStartup = () => {
    sessionGroups.clear()
    void chrome.storage.local.remove(SESSION_GROUPS_KEY)
  }

  return {
    group,
    countShared,
    recountShared,
    renameForPage,
    ungroup,
    ungroupStale,
    onGroupRemoved,
    onBrowserStartup,
  }
}
