export * as AgentWindow from "./window"
import { AGENT_WINDOW_KEY as PLACEMENT_KEY } from "../../shared/protocol"
import { TabCleanup } from "../tab-cleanup"
import { TIMED_OUT, withTimeout } from "./wire"

// Where agents' new tabs open. By default ("current") in the window the user is looking at, in the background
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
/** Dia can stall a Chrome call; choosing a window must not eat the relay's tabs.create budget. */
const WINDOW_QUERY_MS = 2_000
let queue: Promise<unknown> = Promise.resolve()
let last: { windowId?: number; created: boolean } | undefined

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

/** The window the last tab opened in (undefined if that failed), and whether it was made for it: for the relay's log. */
export function lastChoice() {
  return last
}

/**
 * Opens `url` in a new tab of the window the user is looking at. Without a normal window (only popups or app
 * windows, or none at all) one is made unfocused rather than appearing over what the user is doing.
 */
export function openInUserWindow(url: string, options: { active?: boolean } = {}): Promise<chrome.tabs.Tab> {
  return serially(async () => {
    const user = await userWindow()
    if (user?.id !== undefined) {
      last = { windowId: user.id, created: false }
      return chrome.tabs.create({ windowId: user.id, url, active: options.active === true })
    }
    const window = await create(url)
    last = { windowId: window?.id, created: true }
    return firstTab(window)
  })
}

/** Opens `url` in a new tab of the agent window, making the window (unfocused) when there is none. */
export function openTab(url: string, options: { active?: boolean } = {}): Promise<chrome.tabs.Tab> {
  return serially(async () => {
    const windowId = await id()
    if (windowId !== undefined) {
      last = { windowId, created: false }
      return chrome.tabs.create({ windowId, url, active: options.active === true })
    }
    const window = await create(url)
    if (window?.id === undefined) throw new Error("Could not open the agent window")
    last = { windowId: window.id, created: true }
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

/**
 * The normal window the user is looking at: the focused one, else the one with the most recently used tab the user
 * owns. Some Chromium browsers (Dia) keep windows the user never sees, and getLastFocused can return one, so its
 * answer is only trusted while it is focused.
 */
async function userWindow(): Promise<chrome.windows.Window | undefined> {
  const lastFocused = await chrome.windows.getLastFocused({ windowTypes: ["normal"] }).catch(() => undefined)
  if (lastFocused?.focused) return lastFocused
  const queried = await withTimeout(
    chrome.windows.getAll({ windowTypes: ["normal"], populate: true }),
    WINDOW_QUERY_MS,
  ).catch(() => [] as chrome.windows.Window[])
  const windows = (queried === TIMED_OUT ? [] : queried).filter((window) => window.id !== undefined && window.type === "normal")
  const candidates: chrome.windows.Window[] = []
  for (const window of windows) if (window.state !== "minimized" && (await hasUserTab(window))) candidates.push(window)
  const latest = Math.max(0, ...candidates.map(lastAccessed))
  return candidates.find((window) => window.id === lastFocused?.id && lastAccessed(window) === latest)
    ?? candidates.find((window) => lastAccessed(window) === latest)
    ?? (lastFocused?.id !== undefined && lastFocused.type === "normal" ? lastFocused : undefined)
    ?? windows.find((window) => window.state !== "minimized")
    ?? windows[0]
}

/** Whether the window holds a tab an agent didn't open: one holding only agent tabs is the agents' own. */
async function hasUserTab(window: chrome.windows.Window) {
  const tabs = window.tabs ?? (window.id === undefined ? [] : await chrome.tabs.query({ windowId: window.id }).catch(() => []))
  for (const tab of tabs) {
    const id = tab.id
    if (id !== undefined && !(await TabCleanup.isTracked(id))) return true
  }
  return false
}

function lastAccessed(window: chrome.windows.Window) {
  return (window.tabs ?? []).reduce((at, tab) => Math.max(at, tab.lastAccessed ?? 0), 0)
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
  const user = await userWindow()
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
