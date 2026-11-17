export * as DebuggingBarNotice from "./debugging-bar-notice"

// The browser's "browse started debugging this browser" bar has one button (Cancel in Chrome, OK in Dia), and it drops
// the debugger from every tab at once. Users take it for dismissing a message, so a tab they lent going back to them,
// or an agent's tab staying open with nothing using it, comes as a surprise. Say what happened.
//
// Chromium detaches one tab at a time, nearly together: the fixed id means a burst replaces the same notification
// instead of stacking one per tab. Like the other notices this is best effort, since notifications can be turned off
// for the extension.

const ID = "opencode-browser-debugging-bar"

/** Tells the user the debugging bar's button disconnected browse from every tab; one notice covers the whole burst. */
export async function canceled() {
  const level = await chrome.notifications.getPermissionLevel().catch(() => "denied" as const)
  if (level !== "granted") return
  await chrome.notifications
    .create(ID, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon-128.png"),
      title: "browse stopped using your tabs",
      message:
        "The browser's debugging bar was dismissed, which disconnects browse from every tab. To let agents use a tab again, click the browse button on it. Next time, click the browse button to take back a tab instead.",
      requireInteraction: true,
      priority: 2,
    })
    .catch(() => undefined)
}

chrome.notifications?.onClicked.addListener((id) => {
  if (id === ID) void chrome.notifications.clear(id).catch(() => undefined)
})
