export * as DebuggingBarNotice from "./debugging-bar-notice"

// The browser draws a bar while chrome.debugger is attached ("browse started debugging this browser"), and its button
// detaches every tab at once: Cancel in Chrome, OK in Dia and others. Chrome is silent about what that did, and the
// pages where it would be explained can't be shown without a tab, so the user gets one system notification per press.
// The status page says it again, with a way to dismiss it, and either the notification or a newly lent tab clears both.

const ID = "browse-debugging-bar"
/**
 * One press detaches every tab, so `dismissed` runs once per tab. The same notification id replaces, but creating it
 * repeatedly still redraws it (and can replay the OS banner): after the first call of a press the rest stay quiet.
 */
const BURST_MS = 2_000
let lastShownAt = 0
let closed = false

const MESSAGE =
  "The browser's debugging bar was closed, which disconnects browse from every tab. Tabs you lent are yours again. To lend one again, click the browse toolbar button on it."

/** Whether a debugging-bar press disconnected browse since it was last attached to a tab. */
export function isClosed() {
  return closed
}

/**
 * The browser's debugging bar button was pressed. Shows the notification once for the press (the rest of the
 * detached tabs in the same burst are quiet), and returns true when this is the first tab of it: the status pages
 * have something new to show.
 */
export function dismissed() {
  const first = !closed
  closed = true
  if (Date.now() - lastShownAt < BURST_MS) return first
  lastShownAt = Date.now()
  void show()
  return first
}

/** browse is attached to a tab again, or the user dismissed the notice: drops the notification and the flag. */
export function clear() {
  const wasClosed = closed
  closed = false
  lastShownAt = 0
  void chrome.notifications.clear(ID).catch(() => undefined)
  return wasClosed
}

// Like the other notices, this is best effort: with notifications turned off there is nowhere to fall back to.
async function show() {
  const level = await chrome.notifications.getPermissionLevel().catch(() => "denied" as const)
  if (level !== "granted") return
  await chrome.notifications
    .create(ID, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon-128.png"),
      title: "browse",
      message: MESSAGE,
    })
    .catch(() => undefined)
}

chrome.notifications?.onClicked.addListener((id) => {
  if (id !== ID) return
  void chrome.notifications.clear(id).catch(() => undefined)
  // The options page explains the bar again and how to lend a tab, where the notification only had one line.
  void chrome.runtime.openOptionsPage().catch(() => undefined)
})
