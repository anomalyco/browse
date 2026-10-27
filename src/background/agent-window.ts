export * as AgentWindow from "./agent-window"
import { AGENT_WINDOW_KEY as PLACEMENT_KEY } from "../shared/protocol"

// Where agents' new tabs open. By default ("current") in the window the user last focused, in the background
// (`active: false`), where the session's tab group keeps them collapsed at the start of the tab strip
// (agent-groups.ts). The status page offers "separate" instead: one window of the agents' own, created unfocused and
// placed beside the user's window. The relay can override the setting per tab (OPENCODE_BROWSER_AGENT_WINDOW).
// Changing it affects new tabs only. Tabs the user lends agents stay where they are.
//
// Nothing here focuses a window: chrome.windows.create with `focused: false` shows the window inactive, and new tabs
// open with `active: false`, which never shows a window. The agent window is remembered for the browser session
// (window ids don't survive a restart) and made again when the user closes it. An inactive window can still be
// ordered above the user's (macOS may do that), so it's given explicit bounds next to the window the user last
// focused: to its right, else its left, below or above. Chrome refuses bounds less than half on a screen, which is how
// a side without room (or without another display) is skipped; when no side fits, Chrome places the window itself.
//
// A minimized window was tried instead and isn't usable: Page.captureScreenshot on its active tab never returns and
// its timers are throttled, even with focus emulation.

const KEY = "agentWindowId"
export type Placement = "current" | "separate"
const SIZE = { width: 1280, height: 900 }
let queue: Promise<unknown> = Promise.resolve()

type Bounds = { left: number; top: number; width: number; height: number }

export function isPlacement(value: unknown): value is Placement {
  return value === "current" || value === "separate"
}

/** The status page's setting: "current" (the user's window, the default) or "separate". */
export async function placement(): Promise<Placement> {
  const stored = (await chrome.storage.local.get(PLACEMENT_KEY))[PLACEMENT_KEY]
  return isPlacement(stored) ? stored : "current"
}

/** The agent window's id, if it is still open. */
export async function id(): Promise<number | undefined> {
  const stored = (await chrome.storage.session.get(KEY))[KEY]
  if (typeof stored !== "number") return undefined
  const window = await chrome.windows.get(stored).catch(() => undefined)
  return window?.type === "normal" ? stored : undefined
}

/** Opens a background tab for an agent where `override`, else the setting, says. */
export async function open(url: string, options: { active?: boolean; override?: Placement } = {}): Promise<chrome.tabs.Tab> {
  const where = options.override ?? (await placement())
  return where === "separate" ? openTab(url, options) : openInUserWindow(url, options)
}

/**
 * Opens `url` in a new tab of the window the user last focused. Without a normal window (only popups or app windows,
 * or none at all) one is made unfocused rather than appearing over what the user is doing.
 */
export function openInUserWindow(url: string, options: { active?: boolean } = {}): Promise<chrome.tabs.Tab> {
  return serially(async () => {
    const user = await chrome.windows.getLastFocused({ windowTypes: ["normal"] }).catch(() => undefined)
    if (user?.id !== undefined && user.type === "normal")
      return chrome.tabs.create({ windowId: user.id, url, active: options.active === true })
    return firstTab(await create(url))
  })
}

/** Opens `url` in a new tab of the agent window, making the window (unfocused) when there is none. */
export function openTab(url: string, options: { active?: boolean } = {}): Promise<chrome.tabs.Tab> {
  return serially(async () => {
    const windowId = await id()
    if (windowId !== undefined) return chrome.tabs.create({ windowId, url, active: options.active === true })
    const window = await create(url)
    if (window?.id === undefined) throw new Error("Could not open the agent window")
    await chrome.storage.session.set({ [KEY]: window.id })
    return firstTab(window)
  })
}

/** One at a time, so concurrent sessions share one new window instead of each making one. */
function serially<T>(run: () => Promise<T>): Promise<T> {
  const next = queue.then(run, run)
  queue = next.catch(() => undefined)
  return next
}

async function firstTab(window: chrome.windows.Window | undefined) {
  if (window?.id === undefined) throw new Error("Could not open a window for the agent's tab")
  const tab = window.tabs?.[0] ?? (await chrome.tabs.query({ windowId: window.id }))[0]
  if (!tab) throw new Error("The new window has no tab")
  return tab
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
