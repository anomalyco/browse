export * as AgentWindow from "./agent-window"

// Agents open their tabs in one window of their own, created unfocused and placed beside the user's window, so their
// work doesn't cover the user's tabs. The window is remembered for the browser session (window ids don't survive a
// restart) and made again when the user closes it. Tabs the user lends agents stay where they are.
//
// Nothing here focuses a window: chrome.windows.create with `focused: false` shows the window inactive, and new tabs
// open in it with `active: false`, which never shows a window. An inactive window can still be ordered above the
// user's (macOS may do that), so it's given explicit bounds next to the window the user last focused: to its right,
// else its left, below or above. Chrome refuses bounds less than half on a screen, which is how a side without room
// (or without another display) is skipped; when no side fits, Chrome places the window itself.
//
// A minimized window was tried instead and isn't usable: Page.captureScreenshot on its active tab never returns and
// its timers are throttled, even with focus emulation.
//
// No extension API can put a window on another macOS Space or keep a tiling window manager from tiling it into the
// user's current one, so the window opens on a pinned page titled TITLE and keeps it until a window manager has had
// time to see that title (macOS gives the window the active tab's title). A rule matching it can then send the window
// to a workspace the user never looks at, where it keeps rendering; the agent's tab opens only after that.

export const TITLE = "OpenCode Browser agents"
const KEY = "agentWindowId"
const SIZE = { width: 1280, height: 900 }
/** How long a window manager gets to see the placeholder's title before the agent's tab replaces it. */
export const timing = { loadMs: 1_500, settleMs: 600 }
let queue: Promise<unknown> = Promise.resolve()

type Bounds = { left: number; top: number; width: number; height: number }

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
    const window = await create(chrome.runtime.getURL("agent-window.html"))
    if (window?.id === undefined) throw new Error("Could not open the agent window")
    await chrome.storage.session.set({ [KEY]: window.id })
    const placeholder = window.tabs?.[0] ?? (await chrome.tabs.query({ windowId: window.id }))[0]
    if (placeholder?.id !== undefined) {
      await chrome.tabs.update(placeholder.id, { pinned: true }).catch(() => undefined)
      await titled(placeholder.id)
    }
    // The window's first agent tab is its active one: a background tab of a window isn't painted.
    return chrome.tabs.create({ windowId: window.id, url, active: true })
  }
  const next = queue.then(run, run)
  queue = next.catch(() => undefined)
  return next
}

/** Places for the agent window next to `user`'s window, best first: right, left, below, above. */
export function placements(user: Partial<Bounds> | undefined, size = SIZE): Bounds[] {
  const { left, top, width, height } = user ?? {}
  if (left === undefined || top === undefined || width === undefined || height === undefined) return []
  return [
    { left: left + width, top, ...size },
    { left: left - size.width, top, ...size },
    { left, top: top + height, ...size },
    { left, top: top - size.height, ...size },
  ]
}

/** Waits for the placeholder to load (so the window carries its title), then gives a window manager time to see it. */
async function titled(tabId: number) {
  const deadline = Date.now() + timing.loadMs
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId).catch(() => undefined)
    if (!tab || tab.status !== "loading") break
    await sleep(50)
  }
  await sleep(timing.settleMs)
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function create(url: string) {
  const base = { url, focused: false, state: "normal", type: "normal" } as const
  const user = await chrome.windows.getLastFocused({ windowTypes: ["normal"] }).catch(() => undefined)
  // A minimized or fullscreen window's bounds say nothing useful about where the user is looking.
  const anchor = user?.state === "normal" || user?.state === "maximized" ? user : undefined
  for (const bounds of placements(anchor)) {
    const window = await chrome.windows.create({ ...base, ...bounds }).catch(() => undefined)
    if (window) return window
  }
  return chrome.windows.create({ ...base, ...SIZE })
}

chrome.windows.onRemoved.addListener((windowId) => {
  void chrome.storage.session.get(KEY).then((stored) => {
    if (stored[KEY] === windowId) return chrome.storage.session.remove(KEY)
  })
})
