// Service worker: keeps the link to the local browse relay (agent-relay.ts), which drives tabs for agents. The
// toolbar button lets agents use the current tab, or stops them (before setup, it opens the onboarding page). The
// onboarding page (onboarding.html) walks through setup; the settings page (settings.html, the options page) shows the
// connection.
import { AGENT_DIAGNOSTICS, STATUS_PORT, type FromStatusPage, type ToStatusPage } from "../shared/protocol"
import { createAgentRelay } from "./agent-relay"
import { TabCleanup } from "./tab-cleanup"

// Neutral by default; amber while an agent runs, blue while it waits for the user.
const BADGE_COLORS: Record<string, string> = { default: "#3b3b3b", RUN: "#b45309", WAIT: "#2563eb" }
const pages = new Set<chrome.runtime.Port>()
const agents = createAgentRelay({
  changed: (state) => broadcast({ type: "agents", state }),
  badgesChanged: () => void updateBadges(),
})

chrome.action.onClicked.addListener((tab) => {
  // Before setup (or while the relay refuses this browser, or speaks another version) a click can't reach an agent:
  // show the onboarding page, which says what to do, instead of queueing it silently.
  const { status } = agents.state()
  if (status === "unpaired" || status === "untrusted" || status === "incompatible") return void openOnboarding()
  if (tab.id !== undefined) agents.attachTab(tab.id)
})

declare const __OPENCODE_BROWSER_TEST_HOOKS__: boolean
// Test builds only (OPENCODE_BROWSER_TEST_HOOKS=1 when building): the stress harness clicks the toolbar button through
// this worker's DevTools target, as CDP can't click browser UI. Pages can't reach the worker's globals, and other
// builds compile this out.
if (__OPENCODE_BROWSER_TEST_HOOKS__)
  Object.assign(globalThis, { __opencodeBrowserTest: { toolbarClick: (tabId: number) => agents.attachTab(tabId) } })

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== STATUS_PORT || port.sender?.id !== chrome.runtime.id) return
  pages.add(port)
  port.onDisconnect.addListener(() => pages.delete(port))
  port.onMessage.addListener((message: FromStatusPage) => {
    if (message.type === "agents.reconnect") agents.reconnect()
    if (message.type === "tabs.cleanup") void TabCleanup.cleanup({ minutes: 0 })
    if (message.type === "autoUpdate.set") agents.setAutoUpdate(message.mode)
    if (message.type === "pairing.link") void agents.pairLink(message.code).then((ok) => post(port, { type: "pairing.link.result", ok }))
    if (message.type === "relay.connect")
      void agents.connectTo(message.address, message.code).then((result) => post(port, { type: "relay.result", ...result }))
  })
  post(port, { type: "agents", state: agents.state() })
})

// Content scripts (page status, handoffs) and the recording document talk to the relay link; extension pages ask
// it for diagnostics.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const relay = agents.runtimeMessage(message, sender, sendResponse)
  if (relay !== undefined) return relay
  const page = sender.id === chrome.runtime.id && sender.url?.startsWith(`chrome-extension://${chrome.runtime.id}/`)
  if (!page || typeof message !== "object" || message?.action !== AGENT_DIAGNOSTICS) return false
  void agents.diagnostics().then(
    (text) => sendResponse({ text }),
    (error: unknown) => sendResponse({ text: `Diagnostics failed: ${String(error)}` }),
  )
  return true
})

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") void chrome.tabs.create({ url: chrome.runtime.getURL("onboarding.html?first-run") })
})

/** Focuses an open onboarding tab, or opens one. */
async function openOnboarding() {
  const page = chrome.runtime.getURL("onboarding.html")
  const open = (await chrome.tabs.query({}).catch(() => [])).find((tab) => tab.url?.startsWith(page))
  if (open?.id === undefined) return void chrome.tabs.create({ url: page })
  await chrome.tabs.update(open.id, { active: true })
  if (open.windowId !== undefined) await chrome.windows.update(open.windowId, { focused: true })
}

// Tab-specific badges reset when a tab navigates; the relay's state for it doesn't.
chrome.tabs.onUpdated.addListener((_tabId, change, tab) => {
  if (change.url || change.status === "loading") void updateBadges([tab])
})

void chrome.action.setBadgeBackgroundColor({ color: BADGE_COLORS.default })
void chrome.action.setBadgeTextColor?.({ color: "#ffffff" })

/** The toolbar badge shows the agents' state for a tab they use: ON, RUN while one works, WAIT for the user. */
async function updateBadges(tabs?: chrome.tabs.Tab[]) {
  const targets = tabs ?? (await chrome.tabs.query({}))
  await Promise.all(
    targets.map(async (tab) => {
      if (tab.id === undefined) return
      const badge = agents.badge(tab.id)
      await chrome.action.setBadgeText({ tabId: tab.id, text: badge?.text ?? "" }).catch(() => undefined)
      await chrome.action
        .setBadgeBackgroundColor({ tabId: tab.id, color: BADGE_COLORS[badge?.text ?? ""] ?? BADGE_COLORS.default })
        .catch(() => undefined)
      await chrome.action
        .setTitle({ tabId: tab.id, title: badge?.title ?? "Browse · Click to let agents use this tab" })
        .catch(() => undefined)
    }),
  )
}

function broadcast(message: ToStatusPage) {
  pages.forEach((port) => post(port, message))
}

function post(port: chrome.runtime.Port, message: ToStatusPage) {
  try {
    port.postMessage(message)
  } catch {
    pages.delete(port)
  }
}
