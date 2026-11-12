// A small in-memory stand-in for the chrome.* APIs the background modules use, so they can run under bun test.
// Windows, tabs, storage and notifications behave like Chrome's (as far as these tests need); every other API is a
// no-op that resolves to undefined, and every `on*` member is an event whose listeners tests can fire.

type Listener = (...args: any[]) => unknown

export class StubEvent {
  readonly listeners: Listener[] = []
  addListener(listener: Listener) {
    this.listeners.push(listener)
  }
  removeListener(listener: Listener) {
    const index = this.listeners.indexOf(listener)
    if (index !== -1) this.listeners.splice(index, 1)
  }
  hasListener(listener: Listener) {
    return this.listeners.includes(listener)
  }
  emit(...args: unknown[]) {
    for (const listener of [...this.listeners]) listener(...args)
  }
}

type Bounds = { left: number; top: number; width: number; height: number }
type Window = Bounds & { id: number; type: string; state: string; focused: boolean }
type Tab = { id: number; windowId: number; url: string; pendingUrl?: string; active: boolean; index: number; groupId: number; pinned: boolean; lastAccessed: number }
type Group = { id: number; windowId: number; title: string; color: string; collapsed: boolean }
type CreateWindow = Partial<Bounds> & { url?: string; focused?: boolean; state?: string; type?: string }

/** Chromium's check for chrome.windows.create bounds: at least half the window on some display. */
function onScreen(bounds: Bounds, displays: Bounds[]) {
  const area = displays.reduce((sum, display) => {
    const width = Math.min(bounds.left + bounds.width, display.left + display.width) - Math.max(bounds.left, display.left)
    const height = Math.min(bounds.top + bounds.height, display.top + display.height) - Math.max(bounds.top, display.top)
    return sum + Math.max(0, width) * Math.max(0, height)
  }, 0)
  return area >= (bounds.width * bounds.height) / 2
}

function storageArea(name: string, onChanged: StubEvent) {
  const data = new Map<string, unknown>()
  const change = (changes: Record<string, { oldValue?: unknown; newValue?: unknown }>) => {
    if (Object.keys(changes).length) onChanged.emit(changes, name)
  }
  return {
    data,
    async get(keys?: string | string[] | null) {
      const wanted = keys == null ? [...data.keys()] : Array.isArray(keys) ? keys : [keys]
      return Object.fromEntries(wanted.filter((key) => data.has(key)).map((key) => [key, structuredClone(data.get(key))]))
    },
    async set(items: Record<string, unknown>) {
      const changes: Record<string, { oldValue?: unknown; newValue?: unknown }> = {}
      for (const [key, value] of Object.entries(items)) {
        changes[key] = { oldValue: data.get(key), newValue: value }
        data.set(key, structuredClone(value))
      }
      change(changes)
    },
    async remove(keys: string | string[]) {
      const changes: Record<string, { oldValue?: unknown }> = {}
      for (const key of Array.isArray(keys) ? keys : [keys])
        if (data.has(key)) {
          changes[key] = { oldValue: data.get(key) }
          data.delete(key)
        }
      change(changes)
    },
  }
}

/**
 * Fills in what the stub doesn't define. In a namespace, `on*` members are events and anything else an async no-op;
 * at the top (`namespaces`), missing namespaces are such namespaces.
 */
function lenient<T extends object>(target: T, namespaces = false): T {
  return new Proxy(target, {
    get(object, key, receiver) {
      if (typeof key === "symbol" || key in object) return Reflect.get(object, key, receiver)
      const value = namespaces ? lenient({}) : key.startsWith("on") ? new StubEvent() : async () => undefined
      Reflect.set(object, key, value)
      return value
    },
  })
}

export function createChrome() {
  let nextId = 100
  const windows = new Map<number, Window>()
  const tabs = new Map<number, Tab>()
  const groups = new Map<number, Group>()
  const onChanged = new StubEvent()
  const state = {
    windows,
    tabs,
    groups,
    /** Every chrome.windows.update({ focused: true }) and chrome.tabs.update({ active: true }), in order. */
    activations: [] as ({ windowId: number } | { tabId: number })[],
    /** Tab calls that change groups, in order, so tests can check ungroup comes before remove. */
    calls: [] as string[],
    /** The displays chrome.windows.create bounds are checked against. */
    displays: [{ left: 0, top: 0, width: 1512, height: 982 }] as Bounds[],
    focusedWindowId: undefined as number | undefined,
    /** The window getLastFocused answers with: focusedWindowId unless a test makes it answer with another one. */
    lastFocusedWindowId: undefined as number | undefined,
    /** Makes chrome.windows.getAll never settle, like a Chromium call Dia stalls. */
    getAllHangs: false,
    created: [] as CreateWindow[],
    permissionLevel: "granted" as "granted" | "denied",
    /** The extension's "Allow access to file URLs" setting. */
    fileAccess: false,
    notificationsFail: false,
    notifications: new Map<string, unknown>(),
  }
  const tabsOf = (windowId: number) => [...tabs.values()].filter((tab) => tab.windowId === windowId).map((tab) => ({ ...tab }))
  const windowsApi = lenient({
    WINDOW_ID_NONE: -1,
    onRemoved: new StubEvent(),
    async create(options: CreateWindow = {}) {
      state.created.push(options)
      const bounds = { left: options.left ?? 22, top: options.top ?? 22, width: options.width ?? 800, height: options.height ?? 600 }
      if (options.left !== undefined || options.top !== undefined)
        if (!onScreen(bounds, state.displays))
          throw new Error("Invalid value for bounds. Bounds must be at least 50% within visible screen space.")
      const window: Window = { id: nextId++, type: options.type ?? "normal", state: options.state ?? "normal", focused: options.focused !== false, ...bounds }
      windows.set(window.id, window)
      if (window.focused) state.focusedWindowId = window.id
      const tab = addTab(window.id, options.url ?? "about:blank", true)
      return { ...window, tabs: [{ ...tab }] }
    },
    async get(id: number, options: { populate?: boolean } = {}) {
      const window = windows.get(id)
      if (!window) throw new Error(`No window with id: ${id}.`)
      return { ...window, ...(options.populate ? { tabs: tabsOf(window.id) } : {}) }
    },
    async getLastFocused(options: { windowTypes?: string[] } = {}) {
      const id = state.lastFocusedWindowId ?? state.focusedWindowId
      const window = id === undefined ? undefined : windows.get(id)
      if (!window || (options.windowTypes && !options.windowTypes.includes(window.type))) throw new Error("No last-focused window")
      return { ...window }
    },
    async getAll(options: { windowTypes?: string[]; populate?: boolean } = {}) {
      if (state.getAllHangs) return new Promise<never>(() => {})
      return [...windows.values()]
        .filter((window) => !options.windowTypes || options.windowTypes.includes(window.type))
        .map((window) => ({ ...window, ...(options.populate ? { tabs: tabsOf(window.id) } : {}) }))
    },
    async update(id: number, change: { focused?: boolean }) {
      const window = windows.get(id)
      if (!window) throw new Error(`No window with id: ${id}.`)
      if (change.focused === true) {
        state.activations.push({ windowId: id })
        for (const other of windows.values()) other.focused = other === window
        state.focusedWindowId = id
      } else if (change.focused === false && window.focused) {
        window.focused = false
        state.focusedWindowId = undefined
      }
      return { ...window }
    },
    async remove(id: number) {
      if (!windows.delete(id)) throw new Error(`No window with id: ${id}.`)
      for (const tab of tabs.values()) if (tab.windowId === id) tabs.delete(tab.id)
      windowsApi.onRemoved.emit(id)
      dropEmptyGroups()
    },
  })
  const addTab = (windowId: number, url: string, active: boolean, lastAccessed = Date.now()) => {
    if (active) for (const other of tabs.values()) if (other.windowId === windowId) other.active = false
    const tab: Tab = { id: nextId++, windowId, url, active, index: [...tabs.values()].filter((tab) => tab.windowId === windowId).length, groupId: -1, pinned: false, lastAccessed }
    tabs.set(tab.id, tab)
    return tab
  }
  const chrome = lenient({
    extension: lenient({
      isAllowedFileSchemeAccess: async () => state.fileAccess,
    }),
    debugger: lenient({
      onDetach: new StubEvent(),
      async attach() {},
      async detach() {},
      async sendCommand() {
        return {}
      },
    }),
    runtime: lenient({
      id: "stubextensionid",
      lastError: undefined,
      getURL: (file: string) => `chrome-extension://stubextensionid/${file.replace(/^\//, "")}`,
      getManifest: () => ({ version: "0.0.0-test" }),
      getPlatformInfo: async () => ({ os: "mac", arch: "arm64", nacl_arch: "arm64" }),
      sendMessage: async () => undefined,
    }),
    windows: windowsApi,
    tabs: lenient({
      async create(options: { windowId?: number; url?: string; active?: boolean }) {
        const windowId = options.windowId ?? state.focusedWindowId
        if (windowId === undefined || !windows.has(windowId)) throw new Error(`No window with id: ${windowId}.`)
        return { ...addTab(windowId, options.url ?? "about:blank", options.active !== false) }
      },
      async get(id: number) {
        const tab = tabs.get(id)
        if (!tab) throw new Error(`No tab with id: ${id}.`)
        return { ...tab }
      },
      async query(query: { windowId?: number; active?: boolean; groupId?: number } = {}) {
        return [...tabs.values()]
          .filter((tab) => query.windowId === undefined || tab.windowId === query.windowId)
          .filter((tab) => query.active === undefined || tab.active === query.active)
          .filter((tab) => query.groupId === undefined || tab.groupId === query.groupId)
          .map((tab) => ({ ...tab }))
      },
      async update(id: number, change: Partial<Tab>) {
        const tab = tabs.get(id)
        if (!tab) throw new Error(`No tab with id: ${id}.`)
        if (change.active === true) {
          state.activations.push({ tabId: id })
          for (const other of tabs.values()) if (other.windowId === tab.windowId) other.active = false
        }
        Object.assign(tab, change)
        return { ...tab }
      },
      async move(id: number, { windowId, index }: { windowId?: number; index: number }) {
        const tab = tabs.get(id)
        if (!tab) throw new Error(`No tab with id: ${id}.`)
        if (windowId !== undefined && !windows.has(windowId)) throw new Error(`No window with id: ${windowId}.`)
        tab.windowId = windowId ?? tab.windowId
        tab.index = index === -1 ? [...tabs.values()].filter((other) => other.windowId === tab.windowId).length - 1 : index
        return { ...tab }
      },
      async group({ tabIds, groupId }: { tabIds: number | number[]; groupId?: number }) {
        const ids = Array.isArray(tabIds) ? tabIds : [tabIds]
        const id = groupId ?? nextId++
        for (const tabId of ids) {
          const tab = tabs.get(tabId)
          if (!tab) throw new Error(`No tab with id: ${tabId}.`)
          if (tab.groupId !== id) {
            tab.groupId = id
            tabUpdated(tab)
          }
        }
        // Like Chrome, a new group starts expanded, in its tabs' window.
        if (!groups.has(id)) groups.set(id, { id, windowId: tabs.get(ids[0]!)!.windowId, title: "", color: "grey", collapsed: false })
        dropEmptyGroups()
        return id
      },
      async remove(tabIds: number | number[]) {
        for (const tabId of Array.isArray(tabIds) ? tabIds : [tabIds]) {
          const tab = tabs.get(tabId)
          if (!tab) throw new Error(`No tab with id: ${tabId}.`)
          state.calls.push(`remove:${tabId}`)
          tabs.delete(tabId)
          ;((chrome.tabs as unknown as { onRemoved: StubEvent }).onRemoved).emit(tabId, { windowId: tab.windowId, isWindowClosing: false })
        }
        dropEmptyGroups()
      },
      async ungroup(tabIds: number | number[]) {
        for (const tabId of Array.isArray(tabIds) ? tabIds : [tabIds]) {
          const tab = tabs.get(tabId)
          if (tab) {
            state.calls.push(`ungroup:${tabId}`)
            if (tab.groupId !== -1) {
              tab.groupId = -1
              tabUpdated(tab)
            }
          }
        }
        dropEmptyGroups()
      },
    }),
    tabGroups: lenient({
      TAB_GROUP_ID_NONE: -1,
      async get(id: number) {
        const group = groups.get(id)
        if (!group) throw new Error(`No group with id: ${id}.`)
        return { ...group }
      },
      async query(query: { windowId?: number } = {}) {
        return [...groups.values()].filter((group) => query.windowId === undefined || group.windowId === query.windowId).map((group) => ({ ...group }))
      },
      async update(id: number, change: Partial<Group>) {
        const group = groups.get(id)
        if (!group) throw new Error(`No group with id: ${id}.`)
        Object.assign(group, change)
        return { ...group }
      },
      async move(id: number) {
        const group = groups.get(id)
        if (!group) throw new Error(`No group with id: ${id}.`)
        return { ...group }
      },
    }),
    storage: lenient({
      onChanged,
      local: storageArea("local", onChanged),
      session: storageArea("session", onChanged),
    }),
    notifications: lenient({
      async getPermissionLevel() {
        return state.permissionLevel
      },
      async create(id: string, options: unknown) {
        if (state.notificationsFail) throw new Error("Notifications are blocked")
        state.notifications.set(id, options)
        return id
      },
      async clear(id: string) {
        return state.notifications.delete(id)
      },
    }),
  }, true)
  /** Chrome removes a group when its last tab is removed or ungrouped. Saved groups aren't modelled. */
  const dropEmptyGroups = () => {
    for (const group of [...groups.values()]) {
      if ([...tabs.values()].some((tab) => tab.groupId === group.id)) continue
      groups.delete(group.id)
      ;((chrome.tabGroups as unknown as { onRemoved: StubEvent }).onRemoved).emit({ ...group })
    }
  }
  const tabUpdated = (tab: Tab) => {
    ;((chrome.tabs as unknown as { onUpdated: StubEvent }).onUpdated).emit(tab.id, { groupId: tab.groupId }, { ...tab })
  }
  return { chrome, state }
}

export type Stub = ReturnType<typeof createChrome>

/**
 * The stub every test file shares: bun runs test files in one process with one module cache, and background modules
 * register their listeners when first imported. Install it before importing them, and reset what a test needs
 * instead of replacing the stub.
 */
export function installChrome(): Stub {
  const global = globalThis as { chrome?: unknown; __chromeStub?: Stub; __browseFetchStubbed?: boolean }
  // Isolated tests must never reach a real local relay: anything aimed at this computer gets a 404 unless the test
  // installs its own fetch stub first. Other hosts pass through.
  if (!global.__browseFetchStubbed) {
    global.__browseFetchStubbed = true
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const host = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url).hostname
      if (host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]")
        return new Response("not found", { status: 404 })
      return realFetch(input, init)
    }) as typeof fetch
  }
  global.__chromeStub ??= createChrome()
  global.chrome = global.__chromeStub.chrome
  return global.__chromeStub
}

/** Lets pending promise callbacks run. */
export const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
