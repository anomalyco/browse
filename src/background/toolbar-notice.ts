export * as ToolbarNotice from "./toolbar-notice"

// A toolbar click that can't attach says why with the system notification handoffs use. The page can't carry the
// message: the pages this happens on (the Web Store, chrome://, file pages without file access) refuse the page script
// a card would need. A click while the relay is connected always goes through, because the relay may still hold the
// tab as an agent's after Chrome dropped its debugger (a navigation to chrome://, say) and the button must stay a kill
// switch; a failed attach is classified then. Only a click that would queue offline is screened before it is queued.

const PREFIX = "opencode-browser-toolbar:"
/** How long a click's attach may take to answer (the relay gives it 10 s) before the mark is dropped. */
const CLICK_TTL_MS = 15_000
/** Clicked tabs whose attach hasn't answered, so its failure can be shown rather than only returned to the relay. */
const clicked = new Map<number, ReturnType<typeof setTimeout>>()

type Blocked = "file" | "page"
const MESSAGES: Record<Blocked, string> = {
  file: "browse can't use this file. Turn on “Allow access to file URLs” for browse on its details page in chrome://extensions, then click the toolbar button again.",
  page: "browse can't use this page. Chrome doesn't let extensions control browser pages or the Chrome Web Store.",
}

/** Documents `chrome.debugger` refuses: browser internals, other extensions, and the Chrome Web Store. */
const INTERNAL = /^(?:chrome|chrome-untrusted|chrome-extension|chrome-search|devtools|edge|brave|opera|vivaldi):/i
const STORE = /^https:\/\/(?:chromewebstore\.google\.com|chrome\.google\.com\/webstore)(?:[/?#]|$)/i
/** browse's own pages aren't a page an agent could use, but "browse can't use this page" would be confusing there. */
const OWN = chrome.runtime.getURL("")

/** Whether a click can't lend this tab; when it can't, the user is told why and the reason is returned. */
export async function unavailable(tabId: number): Promise<Blocked | undefined> {
  const blocked = await classify(await tabUrl(tabId))
  if (!blocked) return undefined
  await show(tabId, MESSAGES[blocked])
  return blocked
}

/** Why Chrome won't let browse use this page, when it's a kind with advice of its own. */
async function classify(url: string | undefined): Promise<Blocked | undefined> {
  if (!url || url.startsWith(OWN)) return undefined
  if (url.startsWith("file://")) {
    // A browser without the API is left to the relay's attach, which reports Chrome's own reason if it fails.
    const allowed = await Promise.resolve()
      .then(() => chrome.extension?.isAllowedFileSchemeAccess?.())
      .catch(() => true)
    return allowed === false ? "file" : undefined
  }
  return INTERNAL.test(url) || STORE.test(url) ? "page" : undefined
}

/** The page the attach will judge: a tab still loading has only `pendingUrl`. */
async function tabUrl(tabId: number) {
  const tab = await chrome.tabs.get(tabId).catch(() => undefined)
  return tab?.pendingUrl ?? tab?.url
}

/** Marks a lend before its click reaches the relay, so a failed attach there can tell the user why. */
export function expect(tabId: number) {
  const previous = clicked.get(tabId)
  if (previous !== undefined) clearTimeout(previous)
  clicked.set(tabId, setTimeout(() => clicked.delete(tabId), CLICK_TTL_MS))
}

/** Takes the mark for the attach answering a click; false when no click is waiting (an agent's own attach). */
export function take(tabId: number) {
  const timer = clicked.get(tabId)
  if (timer === undefined) return false
  clearTimeout(timer)
  clicked.delete(tabId)
  return true
}

/** Says why the clicked tab's attach failed, with the advice above or Chrome's own reason. */
export async function failed(tabId: number, error: unknown) {
  const blocked = await classify(await tabUrl(tabId))
  if (blocked) return show(tabId, MESSAGES[blocked])
  const text = error instanceof Error ? error.message : String(error)
  if (/another debugger/i.test(text))
    return show(tabId, "browse couldn't use this tab: another debugger (DevTools or another extension) is attached to it. Close that, then click the toolbar button again.")
  const reason = text.replace(/^Could not attach to this tab:\s*/i, "").trim()
  await show(tabId, `browse couldn't use this tab: ${/[.!?]$/.test(reason) ? reason : `${reason}.`}`)
}

/** Drops a click's mark and its notification: the tab attached, or it went away. */
export async function clear(tabId: number) {
  const timer = clicked.get(tabId)
  if (timer !== undefined) {
    clearTimeout(timer)
    clicked.delete(tabId)
  }
  await chrome.notifications.clear(PREFIX + tabId).catch(() => undefined)
}

// Like a handoff notice, this is best effort: when notifications are off there is nowhere on these pages to fall back to.
async function show(tabId: number, message: string) {
  const level = await chrome.notifications.getPermissionLevel().catch(() => "denied" as const)
  if (level !== "granted") return
  await chrome.notifications
    .create(PREFIX + tabId, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon-128.png"),
      title: "browse",
      message,
      requireInteraction: true,
      priority: 2,
    })
    .catch(() => undefined)
}

chrome.notifications?.onClicked.addListener((id) => {
  if (id.startsWith(PREFIX)) void chrome.notifications.clear(id).catch(() => undefined)
})
