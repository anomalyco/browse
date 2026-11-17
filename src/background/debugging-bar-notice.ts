export * as DebuggingBarNotice from "./debugging-bar-notice"

// The browser draws a bar while chrome.debugger is attached ("browse started debugging this browser"), and its button
// detaches every tab at once: Cancel in Chrome, OK in Dia and others. Chrome is silent about what that did, and the
// pages where it would be explained can't be shown without a tab, so the user gets one system notification per press.
// The status page says it again with a way to dismiss it, and the flag survives a service worker restart. It clears
// only when a tab the user lent actually attaches, or when the user dismisses the notice.

/** chrome.storage.session: a worker stop keeps the flag; a browser restart or extension reload clears session storage. */
const CLOSED_KEY = "debuggingBarClosed"
/** The id convention of the other notices (handoff-notice.ts, toolbar-notice.ts); one per press, so no suffix. */
const ID = "opencode-browser-debugging-bar"
/**
 * One press detaches every tab, so `dismissed` runs once per tab. The same notification id replaces, but creating it
 * repeatedly still redraws it (and can replay the OS banner): after the first call of a press the rest stay quiet.
 */
const BURST_MS = 2_000
const MESSAGE =
  "The browser's debugging bar was closed, which disconnects browse from every tab. Tabs you lent are yours again. To lend one again, click the browse toolbar button on it."

let closed = false
/** When the current press started, kept across clear() so the press's remaining detaches stay quiet. */
let pressAt = 0
/** Bumped by clear(): a show() waiting on the permission check belongs to a state the user already dismissed. */
let generation = 0
/** Writes run in order and each carries the state it was asked to save, so an older value can't land last. */
let writes: Promise<unknown> = Promise.resolve()

const listeners = new Set<() => void>()
const changed = () => {
  for (const listener of listeners) listener()
}
const save = (value: boolean) => {
  writes = writes
    .then(() => (value ? chrome.storage.session.set({ [CLOSED_KEY]: true }) : chrome.storage.session.remove(CLOSED_KEY)))
    .catch(() => undefined)
}

/** Notices changes the module makes on its own: a restored flag, or a notification click. */
export function onChanged(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Whether the debugging bar was pressed since a tab the user lent last attached. */
export function isClosed() {
  return closed
}

/** Reads the flag a previous worker left. A press or a dismiss that landed first wins over what was stored. */
export async function restore() {
  const mine = generation
  const stored = (await chrome.storage.session.get(CLOSED_KEY).catch(() => ({}))) as Record<string, unknown>
  if (closed || mine !== generation || stored[CLOSED_KEY] !== true) return false
  closed = true
  changed()
  return true
}

/**
 * The browser's debugging bar button was pressed. Shows the notification once for the press (the rest of the
 * detached tabs in the same burst are quiet), and remembers the press independently of clear().
 */
export function dismissed() {
  // A leftover detach of a press the user already dismissed changes nothing, and must not show the notification again.
  if (Date.now() - pressAt < BURST_MS) return
  pressAt = Date.now()
  if (!closed) {
    closed = true
    save(true)
    changed()
  }
  void show(generation)
}

/** A lent tab attached, or the user dismissed the notice: drops the notification and the flag. */
export function clear() {
  const wasClosed = closed
  closed = false
  generation++
  save(false)
  void chrome.notifications.clear(ID).catch(() => undefined)
  if (wasClosed) changed()
}

// Like the other notices, this is best effort: with notifications turned off there is nowhere to fall back to.
async function show(mine: number) {
  const level = await chrome.notifications.getPermissionLevel().catch(() => "denied" as const)
  if (level !== "granted" || mine !== generation) return
  await chrome.notifications
    .create(ID, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon-128.png"),
      title: "browse",
      message: MESSAGE,
    })
    .catch(() => undefined)
  // A clear that landed while create was in flight already ran, before the notification existed: undo the create.
  if (mine !== generation) await chrome.notifications.clear(ID).catch(() => undefined)
}

chrome.notifications?.onClicked.addListener((id) => {
  if (id !== ID) return
  // Clicking is the user's answer to the notice, so it goes everywhere: the flag and the status page with it.
  clear()
  // The options page is where the bar is explained again and the way to lend a tab lives.
  void chrome.runtime.openOptionsPage().catch(() => undefined)
})
