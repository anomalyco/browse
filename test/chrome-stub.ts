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
type Tab = { id: number; windowId: number; url: string; active: boolean; index: number; groupId: number }
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
  const onChanged = new StubEvent()
  const state = {
    windows,
    tabs,
    /** The displays chrome.windows.create bounds are checked against. */
    displays: [{ left: 0, top: 0, width: 1512, height: 982 }] as Bounds[],
    focusedWindowId: undefined as number | undefined,
    created: [] as CreateWindow[],
    permissionLevel: "granted" as "granted" | "denied",
    notificationsFail: false,
    notifications: new Map<string, unknown>(),
  }
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
    async get(id: number) {
      const window = windows.get(id)
      if (!window) throw new Error(`No window with id: ${id}.`)
      return { ...window }
    },
    async getLastFocused() {
      const window = state.focusedWindowId === undefined ? undefined : windows.get(state.focusedWindowId)
      if (!window) throw new Error("No last-focused window")
      return { ...window }
    },
    async update(id: number, change: { focused?: boolean }) {
      const window = windows.get(id)
      if (!window) throw new Error(`No window with id: ${id}.`)
      if (change.focused === true) {
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
    },
  })
  const addTab = (windowId: number, url: string, active: boolean) => {
    const tab: Tab = { id: nextId++, windowId, url, active, index: [...tabs.values()].filter((tab) => tab.windowId === windowId).length, groupId: -1 }
    tabs.set(tab.id, tab)
    return tab
  }
  const chrome = lenient({
    runtime: lenient({
      id: "stubextensionid",
      lastError: undefined,
      getURL: (file: string) => `chrome-extension://stubextensionid/${file.replace(/^\//, "")}`,
      getManifest: () => ({ version: "0.0.0-test" }),
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
      async query(query: { windowId?: number } = {}) {
        return [...tabs.values()].filter((tab) => query.windowId === undefined || tab.windowId === query.windowId).map((tab) => ({ ...tab }))
      },
      async update(id: number, change: Partial<Tab>) {
        const tab = tabs.get(id)
        if (!tab) throw new Error(`No tab with id: ${id}.`)
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
        const id = groupId ?? nextId++
        for (const tabId of Array.isArray(tabIds) ? tabIds : [tabIds]) {
          const tab = tabs.get(tabId)
          if (!tab) throw new Error(`No tab with id: ${tabId}.`)
          tab.groupId = id
        }
        return id
      },
    }),
    tabGroups: lenient({ TAB_GROUP_ID_NONE: -1 }),
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
  return { chrome, state }
}

export type Stub = ReturnType<typeof createChrome>

/**
 * The stub every test file shares: bun runs test files in one process with one module cache, and background modules
 * register their listeners when first imported. Install it before importing them, and reset what a test needs
 * instead of replacing the stub.
 */
export function installChrome(): Stub {
  const global = globalThis as { chrome?: unknown; __chromeStub?: Stub }
  global.__chromeStub ??= createChrome()
  global.chrome = global.__chromeStub.chrome
  return global.__chromeStub
}

/** Lets pending promise callbacks run. */
export const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
