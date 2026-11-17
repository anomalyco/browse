export * as DebuggingBarNotice from "./debugging-bar-notice"

// The browser's "browse started debugging this browser" bar has one button (Cancel in Chrome, OK in Dia), and it drops
// the debugger from every tab at once. Users take it for dismissing a message, so a tab they lent going back to them,
// or an agent's tab staying open with nothing using it, comes as a surprise. Say what happened.
//
// Chromium detaches one tab at a time, nearly together, so one click is many calls: the create already on its way is
// shared, and calls just after it are part of the same burst. Creating the notification again for each tab would
// replace it in place, which can pop and sound it again. Like the other notices this is best effort, since
// notifications can be turned off for the extension.

const ID = "opencode-browser-debugging-bar"
/** How long after a notice a repeated cancel is the same burst: Chromium detaches one tab at a time, in milliseconds. */
const BURST_MS = 5_000
/** When a notice was last created, so the rest of its burst doesn't create it again. */
let shownAt: number | undefined
/** The create on its way, shared by the cases of a burst that arrive while it runs. */
let creating: Promise<void> | undefined

/** Tells the user the debugging bar's button disconnected browse from every tab; one notice covers the whole burst. */
export function canceled(): Promise<void> {
  if (creating !== undefined) return creating
  if (shownAt !== undefined && Date.now() - shownAt < BURST_MS) return Promise.resolve()
  // Never rejects: a browser without notifications has nothing to show and nothing to report.
  const attempt = show().catch(() => undefined)
  creating = attempt
  const done = () => {
    if (creating === attempt) creating = undefined
  }
  void attempt.then(done, done)
  return attempt
}

async function show() {
  const notifications = chrome.notifications
  if (!notifications) return
  if ((await notifications.getPermissionLevel()) !== "granted") return
  await notifications.create(ID, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/icon-128.png"),
    title: "browse stopped using your tabs",
    message: "The debugging bar's button disconnects browse from every tab. Click the browse button on a tab to lend it again.",
    requireInteraction: true,
    priority: 2,
  })
  shownAt = Date.now()
}

chrome.notifications?.onClicked.addListener((id) => {
  if (id === ID) void chrome.notifications.clear(id).catch(() => undefined)
})
