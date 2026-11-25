export * as AgentWindow from "./window"
import { AGENT_WINDOW_KEY as PLACEMENT_KEY } from "../../shared/protocol"
import { TabCleanup } from "../tab-cleanup"
import { TIMED_OUT, withTimeout } from "./wire"

// Where agents' new tabs open. By default ("current") in the window the user last focused when it is a normal window
// holding one of the user's tabs, in the background (`active: false`), where the session's tab group keeps them
// collapsed at the start of the tab strip (agent-groups.ts). Some Chromium browsers keep windows the user never sees,
// so a minimized or agents-only window is passed over for the normal window with the user's most recently used tab.
// The status page offers "separate" instead: one window of the agents' own, created unfocused and placed beside the
// user's window. The relay can override the setting per tab (OPENCODE_BROWSER_AGENT_WINDOW). Changing it affects new
// tabs only. Tabs the user lends agents stay where they are.
//
// A task can also say where it goes, before the setting. An agent asks for a new window for one task (`newWindow`),
// made like the agent window but not remembered as it, or for the window of a tab it names (`beside`). And a tab
// whose label already has open tabs goes in the window of the one the user used last (the relay sends their ids as
// `follow`), whichever setting is chosen: a task the user moved to a window of its own keeps going there, and with
// "separate" a task's tabs stay in the agent window unless the user moves them. The relay sends no `follow` while
// OPENCODE_BROWSER_AGENT_WINDOW fixes the placement. The window ids a label spans come back (`windows`), so the agent
// can ask the user when they are in several.
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

type Bounds = { left: number; top: number; width: number; height: number }

/** How open() picked the window the tab went in, for the relay's log. */
export type WindowRule =
  | "last-focused"
  | "most-recent-user-tab"
  | "fallback"
  | "created"
  | "separate"
  | "followed"
  | "beside"
  | "new-window"

/** A tab open() made, where it put it, and what it chose by. */
export type Opened = {
  readonly tab: chrome.tabs.Tab
  /** A new window was made for the tab. */
  readonly created: boolean
  readonly rule: WindowRule
  /** getLastFocused's answer in the "current" placement: "id=7 focused=false state=normal", "failed" or "timed out". */
  readonly lastFocused?: string
  /** Normal windows getAll found, when it ran. */
  readonly normalWindows?: number
  /** With `follow`: the windows the label's tabs are in that the tab could go to, the one it went to first. */
  readonly windows?: readonly number[]
}

type LastFocused =
  | { readonly status: "window"; readonly window: chrome.windows.Window }
  | { readonly status: "failed" | "timed out" }

type Choice = {
  readonly window?: chrome.windows.Window
  readonly rule: Exclude<WindowRule, "separate" | "followed" | "beside" | "new-window">
  readonly normalWindows?: number
}

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

/**
 * Opens a background tab for an agent. `newWindow` puts it in a new window of its own, `beside` in the window of that
 * tab, and `follow` (the tabs with the new tab's label) beside them, wherever the user moved them. Otherwise
 * `override`, else the setting, decides.
 */
export async function open(
  url: string,
  options: {
    active?: boolean
    override?: Placement
    follow?: readonly number[]
    beside?: number
    newWindow?: boolean
  } = {},
): Promise<Opened> {
  if (options.newWindow) return openInNewWindow(url)
  if (options.beside !== undefined) return openNextTo(url, options.beside, options)
  if (options.follow?.length) {
    const followed = await openBeside(url, options.follow, options)
    if (followed) return followed
  }
  const where = options.override ?? (await placement())
  return where === "separate" ? openTab(url, options) : openInUserWindow(url, options)
}

/** The window `tabId` is in, when it's a normal window tabs can open in. */
async function windowOf(tabId: number) {
  const tab = await withTimeout(chrome.tabs.get(tabId), WINDOW_QUERY_MS).catch(() => undefined)
  if (tab === undefined || tab === TIMED_OUT) return undefined
  const window = await withTimeout(chrome.windows.get(tab.windowId), WINDOW_QUERY_MS).catch(() => undefined)
  if (window === undefined || window === TIMED_OUT || window.type !== "normal") return undefined
  return { tab, window }
}

/** Opens `url` in the window `tabId` is in, which the agent named: a minimized one too. */
function openNextTo(url: string, tabId: number, options: { active?: boolean }): Promise<Opened> {
  return serially(async () => {
    const found = await windowOf(tabId)
    if (!found) throw new Error("The tab named for the window is gone or in a window tabs can't open in")
    return {
      tab: await chrome.tabs.create({ windowId: found.tab.windowId, url, active: options.active === true }),
      created: false,
      rule: "beside",
    }
  })
}

/**
 * Opens `url` in the window of the `follow` tab the user used last, when one is still in a normal window that isn't
 * minimized (a minimized window's tabs can't be screenshot). The task's window is whatever window its tabs are in,
 * so moving them moves where the next ones go. `windows` lists every window it could have taken, best first.
 * Undefined when there is no such tab.
 */
function openBeside(url: string, follow: readonly number[], options: { active?: boolean }): Promise<Opened | undefined> {
  return serially(async () => {
    const found = await Promise.all(follow.map(windowOf))
    const windows = new Map<number, number>()
    for (const item of found) {
      if (!item || item.window.state === "minimized") continue
      windows.set(item.tab.windowId, Math.max(windows.get(item.tab.windowId) ?? 0, item.tab.lastAccessed ?? 0))
    }
    const ranked = [...windows].sort((a, b) => b[1] - a[1]).map(([windowId]) => windowId)
    const windowId = ranked[0]
    if (windowId === undefined) return undefined
    return {
      tab: await chrome.tabs.create({ windowId, url, active: options.active === true }),
      created: false,
      rule: "followed" as const,
      windows: ranked,
    }
  })
}

/** The window each of `tabIds` is in, by tab id; a tab that's gone is left out. */
export async function windowsOf(tabIds: readonly number[]): Promise<Record<string, number>> {
  const tabs = await Promise.all(
    tabIds.map((tabId) => withTimeout(chrome.tabs.get(tabId), WINDOW_QUERY_MS).catch(() => undefined)),
  )
  const windows: Record<string, number> = {}
  for (const tab of tabs) if (tab && tab !== TIMED_OUT && tab.id !== undefined) windows[tab.id] = tab.windowId
  return windows
}

/**
 * Opens `url` in a new window for one task, unfocused and placed beside the user's window like the agent window. It
 * isn't the agent window: the setting and the "separate" window are left as they are.
 */
export function openInNewWindow(url: string): Promise<Opened> {
  return serially(async () => {
    const last = await lastFocused()
    const window = await create(url, last.status === "window" ? last.window : undefined)
    return { tab: await firstTab(window), created: true, rule: "new-window", lastFocused: describe(last) }
  })
}

/**
 * Opens `url` in a new tab of a normal window the user has a tab in: the last-focused one when it can be theirs,
 * else the one with their most recently used tab, else the last-focused or any normal window. Without a normal window
 * (only popups or app windows, or none at all) one is made unfocused rather than appearing over what the user is doing.
 */
export function openInUserWindow(url: string, options: { active?: boolean } = {}): Promise<Opened> {
  return serially(async () => {
    const last = await lastFocused()
    const choice = await chooseWindow(last)
    const diagnostics = {
      lastFocused: describe(last),
      ...(choice.normalWindows === undefined ? {} : { normalWindows: choice.normalWindows }),
    }
    if (choice.window?.id !== undefined)
      return {
        tab: await chrome.tabs.create({ windowId: choice.window.id, url, active: options.active === true }),
        created: false,
        rule: choice.rule,
        ...diagnostics,
      }
    const window = await create(url, undefined)
    return { tab: await firstTab(window), created: true, rule: "created", ...diagnostics }
  })
}

/** Opens `url` in a new tab of the agent window, making the window (unfocused) when there is none. */
export function openTab(url: string, options: { active?: boolean } = {}): Promise<Opened> {
  return serially(async () => {
    const windowId = await id()
    if (windowId !== undefined)
      return {
        tab: await chrome.tabs.create({ windowId, url, active: options.active === true }),
        created: false,
        rule: "separate",
      }
    const last = await lastFocused()
    const window = await create(url, last.status === "window" ? last.window : undefined)
    if (window?.id === undefined) throw new Error("Could not open the agent window")
    await chrome.storage.session.set({ [KEY]: window.id })
    return { tab: await firstTab(window), created: true, rule: "created" }
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
 * The window to open the tab in. The last-focused one is taken when it is not minimized and holds a tab the user
 * opened, whatever its `focused` (false whenever the browser isn't the frontmost app). Otherwise every normal window
 * is scored by the lastAccessed of its newest tab the user opened, and a minimized or agents-only window is passed
 * over. With no such window, the last-focused or any normal window is taken before one is made.
 */
async function chooseWindow(last: LastFocused): Promise<Choice> {
  if (last.status === "window" && last.window.state !== "minimized") {
    const full = await populated(last.window)
    if (full && (await userTabs(full)).length) return { window: full, rule: "last-focused" }
  }
  const queried = await withTimeout(
    chrome.windows.getAll({ windowTypes: ["normal"], populate: true }),
    WINDOW_QUERY_MS,
  ).catch(() => undefined)
  if (queried === undefined || queried === TIMED_OUT)
    return last.status === "window" ? { window: last.window, rule: "fallback" } : { rule: "created" }
  const windows = queried.filter((window) => window.id !== undefined)
  if (!windows.length)
    return last.status === "window" ? { window: last.window, rule: "fallback" } : { rule: "created" }
  let best: { window: chrome.windows.Window; at: number } | undefined
  for (const window of windows) {
    if (window.state === "minimized") continue
    const user = await userTabs(window)
    if (!user.length) continue
    const at = user.reduce((latest, tab) => Math.max(latest, tab.lastAccessed ?? 0), 0)
    if (!best || at > best.at) best = { window, at }
  }
  if (best) return { window: best.window, rule: "most-recent-user-tab", normalWindows: windows.length }
  const fallback = last.status === "window" ? last.window : windows.find((window) => window.state !== "minimized") ?? windows[0]
  return fallback ? { window: fallback, rule: "fallback", normalWindows: windows.length } : { rule: "created", normalWindows: windows.length }
}

/** getLastFocused's normal window, or why it gave none. */
async function lastFocused(): Promise<LastFocused> {
  const result = await withTimeout(
    chrome.windows.getLastFocused({ windowTypes: ["normal"] }),
    WINDOW_QUERY_MS,
  ).catch(() => undefined)
  if (result === undefined) return { status: "failed" }
  if (result === TIMED_OUT) return { status: "timed out" }
  return { status: "window", window: result }
}

function describe(last: LastFocused) {
  return last.status === "window"
    ? `id=${last.window.id} focused=${last.window.focused} state=${last.window.state ?? "unknown"}`
    : last.status
}

/** The window with its tabs, if it doesn't carry them already. */
async function populated(window: chrome.windows.Window): Promise<chrome.windows.Window | undefined> {
  if (window.tabs) return window
  if (window.id === undefined) return undefined
  const result = await withTimeout(chrome.windows.get(window.id, { populate: true }), WINDOW_QUERY_MS).catch(() => undefined)
  return result === undefined || result === TIMED_OUT ? undefined : result
}

/** The window's tabs the user opened: a window holding only an agent's tabs is the agent's, not the user's. */
async function userTabs(window: chrome.windows.Window) {
  const user: chrome.tabs.Tab[] = []
  for (const tab of window.tabs ?? []) {
    const id = tab.id
    if (id !== undefined && !(await TabCleanup.isTracked(id))) user.push(tab)
  }
  return user
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

async function create(url: string, anchor: chrome.windows.Window | undefined) {
  const base = { url, focused: false, state: "normal", type: "normal" } as const
  // A minimized or fullscreen window's bounds say nothing useful about where the user is looking.
  const user = anchor?.state === "normal" || anchor?.state === "maximized" ? anchor : undefined
  for (const bounds of placements(user)) {
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
