import type { JsonObject } from "../../agent-relay/protocol"
import { AgentWindow } from "../agent-window"
import { TabCleanup } from "../tab-cleanup"
import { text, type AgentRelayLog } from "./helpers"

export function installPopupAdoption(deps: {
  readonly log: AgentRelayLog
  readonly relayTabs: Set<number>
  readonly send: (message: JsonObject) => void
  readonly countShared: (groupId: number) => Promise<void>
}) {
  /** The active tab of each window and the one before it, to give a window back its tab after an agent popup. */
  const activeTabs = new Map<number, { current: number; previous?: number }>()
  chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
    const entry = activeTabs.get(windowId)
    if (entry?.current !== tabId) activeTabs.set(windowId, { current: tabId, ...(entry ? { previous: entry.current } : {}) })
  })
  chrome.windows.onRemoved.addListener((windowId) => activeTabs.delete(windowId))
  /** The focused window and the one focused before it, to tell whether an agent's popup took focus. */
  const focus: { current?: number; previous?: number; at: number } = { at: 0 }
  chrome.windows.onFocusChanged.addListener((windowId) => {
    if (windowId === chrome.windows.WINDOW_ID_NONE || windowId === focus.current) return
    focus.previous = focus.current
    focus.current = windowId
    focus.at = Date.now()
  })
  void chrome.tabs.query({ active: true }).then((tabs) => {
    for (const tab of tabs) if (tab.id !== undefined && !activeTabs.has(tab.windowId)) activeTabs.set(tab.windowId, { current: tab.id })
  })
  /**
   * A tab an agent's page opened (target=_blank, window.open): it belongs with the agent's tabs. It closes when idle
   * like them and joins the opener's group. If it took over a window's active tab, the user gets their tab back there.
   * It stays in the window it opened in, unless its opener is in the agent window (agent tabs in a separate window):
   * then it moves there. A popup window can't be moved, so it only gives up focus, as does the agent window when the
   * popup's activation focused it. (The opener comes from webNavigation: a tab's openerTabId names the window's active
   * tab, not the background agent tab that clicked the link.)
   */
  const adoptOpened = async (tabId: number, opener: number) => {
    if (!(await TabCleanup.isTracked(opener))) return
    const tab = await chrome.tabs.get(tabId).catch(() => undefined)
    if (!tab) return
    void chrome.tabs.update(tabId, { autoDiscardable: false }).catch(() => undefined)
    const [agentWindow, openerWindow] = await Promise.all([
      AgentWindow.id(),
      chrome.tabs.get(opener).then((openerTab) => openerTab.windowId, () => undefined),
    ])
    const window = await chrome.windows.get(tab.windowId).catch(() => undefined)
    const separate = agentWindow !== undefined && openerWindow === agentWindow
    deps.log.add("tab.opened", { tabId, opener, window: window?.type, agentWindow: tab.windowId === agentWindow, separate })
    // Focus that just moved to the agent window came from the popup, not from the user going there.
    const justFocused = focus.current !== agentWindow || Date.now() - focus.at < 2_000
    if (window?.focused && tab.windowId === agentWindow && justFocused) {
      await chrome.windows.update(tab.windowId, { focused: false }).catch(() => undefined)
    }
    if (window && tab.windowId !== agentWindow) {
      if (window.type === "normal") {
        const entry = activeTabs.get(tab.windowId)
        const previous = entry?.current === tabId ? entry.previous : entry?.current
        if (separate) await chrome.tabs.move(tabId, { windowId: agentWindow, index: -1 }).catch(() => undefined)
        if (tab.active && previous !== undefined && previous !== tabId)
          await chrome.tabs.update(previous, { active: true }).catch(() => undefined)
      } else if (window.focused) {
        await chrome.windows.update(tab.windowId, { focused: false }).catch(() => undefined)
      }
    }
    const [current, openerTab] = await Promise.all([
      chrome.tabs.get(tabId).catch(() => undefined),
      chrome.tabs.get(opener).catch(() => undefined),
    ])
    if (
      current &&
      openerTab &&
      openerTab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE &&
      openerTab.windowId === current.windowId &&
      current.groupId !== openerTab.groupId
    )
      await chrome.tabs.group({ tabIds: [tabId], groupId: openerTab.groupId }).then(
        () => deps.countShared(openerTab.groupId),
        () => undefined,
      )
    // After the move and grouping, which would otherwise read as the user claiming the tab.
    TabCleanup.track(tabId)
  }

  chrome.webNavigation.onCreatedNavigationTarget.addListener(({ sourceTabId, tabId }) => {
    void adoptOpened(tabId, sourceTabId)
      .catch((error: unknown) => deps.log.add("tab.opened.error", { error: text(error) }))
      // Once it's moved and grouped: the relay attaches it as a page of the opener's session, so the agent's
      // Playwright sees it (page.waitForEvent("popup"), context.pages()).
      .finally(() => {
        if (deps.relayTabs.has(sourceTabId)) deps.send({ method: "tabs.opened", params: { tabId, openerTabId: sourceTabId } })
      })
  })
}
