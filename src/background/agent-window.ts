export * as AgentWindow from "./agent-window"

// Agents open their tabs in one window of their own, created unfocused, so their work never comes to the front over
// the user's tabs and windows. The window is remembered for the browser session (window ids don't survive a restart)
// and made again when the user closes it. Tabs the user lends agents stay where they are.
//
// Nothing here focuses a window: chrome.windows.create with `focused: false` shows the window inactive (on macOS
// without activating the browser), and new tabs open in it with `active: false`, which never shows a window.

const KEY = "agentWindowId"
const SIZE = { width: 1280, height: 900 }
let queue: Promise<unknown> = Promise.resolve()

/** The agent window's id, if it is still open. */
export async function id(): Promise<number | undefined> {
  const stored = (await chrome.storage.session.get(KEY))[KEY]
  if (typeof stored !== "number") return undefined
  const window = await chrome.windows.get(stored).catch(() => undefined)
  return window?.type === "normal" ? stored : undefined
}

/** Opens `url` in a new tab of the agent window, making the window (unfocused) when there is none. */
export function openTab(url: string, options: { active?: boolean } = {}): Promise<chrome.tabs.Tab> {
  // One at a time, so concurrent sessions share one new window instead of each making one.
  const run = async () => {
    const windowId = await id()
    if (windowId !== undefined) return chrome.tabs.create({ windowId, url, active: options.active === true })
    const window = await chrome.windows.create({ url, focused: false, state: "normal", type: "normal", ...SIZE })
    if (window?.id === undefined) throw new Error("Could not open the agent window")
    await chrome.storage.session.set({ [KEY]: window.id })
    const tab = window.tabs?.[0] ?? (await chrome.tabs.query({ windowId: window.id }))[0]
    if (!tab) throw new Error("The agent window has no tab")
    return tab
  }
  const next = queue.then(run, run)
  queue = next.catch(() => undefined)
  return next
}

chrome.windows.onRemoved.addListener((windowId) => {
  void chrome.storage.session.get(KEY).then((stored) => {
    if (stored[KEY] === windowId) return chrome.storage.session.remove(KEY)
  })
})
