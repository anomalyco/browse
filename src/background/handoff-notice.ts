export * as HandoffNotice from "./handoff-notice"

import type { PageStatus } from "../agent-relay/protocol"

// A recording must show only the page, so a handoff on a tab being recorded draws no card there. The toolbar badge
// says WAIT, and a system notification tells the user which agent needs them where; clicking it shows the tab
// (the user's choice, so it may take focus). Clicking the toolbar button on the tab finishes the handoff as usual.
//
// When the notification can't be shown (notifications are turned off for the extension, or creating it failed), the
// card is drawn after all, and the recording shows it: a handoff nobody hears about would keep the agent waiting
// until it times out, which is worse than a card in the video. A notification the OS hides after Chrome showed it
// (macOS Focus, Chrome's notifications turned off in System Settings) can't be detected; the badge still says WAIT.

const PREFIX = "opencode-browser-handoff:"
/** The handoff each notification is for, by tab, so a repeated status (or one the user dismissed) doesn't notify twice. */
const shown = new Map<number, string>()
/** Tabs whose handoff couldn't be announced by a notification: their page shows the card even while recorded. */
const unnotified = new Set<number>()

/** What the tab's page-status script gets: a waiting handoff without its card while the tab is recorded and notified. */
export function forPage(tabId: number, page: PageStatus): PageStatus {
  if (page.state !== "waiting" || !page.recording) return page
  if (unnotified.has(tabId)) {
    const { recording: _recording, ...card } = page
    return card
  }
  return {
    state: "attached",
    owner: page.owner,
    ...(page.sessionId ? { sessionId: page.sessionId } : {}),
    ...(page.readOnly ? { readOnly: true } : {}),
    recording: true,
  }
}

/**
 * Shows or clears the tab's notification for its current page status (undefined: none). Call it before sending the
 * page its status: when no notification can be shown, `forPage` then gives the page its card.
 */
export async function sync(tabId: number, page: PageStatus | undefined, sessionName: (sessionId?: string) => string) {
  const handoffId = page?.state === "waiting" && page.recording ? page.handoffId : undefined
  if (!handoffId) return clear(tabId)
  if (shown.get(tabId) === handoffId) return
  shown.set(tabId, handoffId)
  unnotified.delete(tabId)
  const level = await chrome.notifications.getPermissionLevel().catch(() => "denied" as const)
  if (level !== "granted") {
    unnotified.add(tabId)
    return
  }
  const tab = await chrome.tabs.get(tabId).catch(() => undefined)
  const origin = originOf(tab?.url)
  await chrome.notifications
    .create(PREFIX + tabId, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon-128.png"),
      title: "OpenCode Browser",
      message: `${sessionName(page?.sessionId)} needs you on ${origin}`,
      ...(page?.message ? { contextMessage: page.message } : {}),
      requireInteraction: true,
      priority: 2,
    })
    .catch(() => unnotified.add(tabId))
}

export async function clear(tabId: number) {
  unnotified.delete(tabId)
  if (!shown.delete(tabId)) return
  await chrome.notifications.clear(PREFIX + tabId).catch(() => undefined)
}

function originOf(url: string | undefined) {
  if (!url) return "a page"
  try {
    const parsed = new URL(url)
    return parsed.origin !== "null" ? parsed.host || parsed.origin : url
  } catch {
    return "a page"
  }
}

chrome.notifications?.onClicked.addListener((id) => {
  if (!id.startsWith(PREFIX)) return
  const tabId = Number(id.slice(PREFIX.length))
  void chrome.notifications.clear(id).catch(() => undefined)
  void chrome.tabs.update(tabId, { active: true }).then(
    (tab) => (tab?.windowId === undefined ? undefined : chrome.windows.update(tab.windowId, { focused: true })),
    () => undefined,
  )
})
