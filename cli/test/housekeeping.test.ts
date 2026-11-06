import { expect, test } from "bun:test"
import type { ConnectedTarget, OpenCodeBrowserSession } from "../src/relay/types.ts"
import { tabIsBusy, type TabBusyDependencies } from "../src/relay/housekeeping.ts"

const target = (tabId: number, sessionId: string): ConnectedTarget => ({
  tabId,
  sessionId: `cdp-${tabId}`,
  owner: "relay",
  opencodeBrowserSessionId: sessionId,
  targetInfo: { targetId: `target-${tabId}`, type: "page", title: "", url: "about:blank", attached: true, canAccessOpener: false },
})

const session = (id: string, networkActive = false) => ({
  id,
  sandbox: { networkStatus: () => ({ active: networkActive }) },
}) as unknown as OpenCodeBrowserSession

function dependencies(options: {
  readonly targets?: ConnectedTarget[]
  readonly sessions?: OpenCodeBrowserSession[]
  readonly executing?: string[]
  readonly handoffTab?: number
  readonly recordedTab?: number
}): TabBusyDependencies {
  const sessions = new Map((options.sessions ?? []).map((item) => [item.id, item]))
  return {
    registry: { getRootTargetByTabId: (tabId: number) => (options.targets ?? []).find((item) => item.tabId === tabId) },
    sessions: {
      sessions,
      isExecuting: (id) => (options.executing ?? []).includes(id),
      hasPendingWork: () => false,
    },
    handoffs: { pendingForTab: (tabId: number) => (tabId === options.handoffTab ? { tabId } : undefined) } as unknown as TabBusyDependencies["handoffs"],
    isTabRecorded: (tabId) => tabId === options.recordedTab,
  }
}

test("a running execute only makes the tab it owns busy", () => {
  const deps = dependencies({
    targets: [target(7, "s1"), target(8, "s2")],
    sessions: [session("s1"), session("s2")],
    executing: ["s1"],
  })
  expect(tabIsBusy(7, deps)).toBe(true)
  expect(tabIsBusy(8, deps)).toBe(false)
})

test("no owning session or target means the tab is not busy", () => {
  const deps = dependencies({ sessions: [session("s1")], executing: ["s1"] })
  expect(tabIsBusy(7, deps)).toBe(false)
})

test("network capture, a pending handoff, and a recording keep their tab busy", () => {
  const deps = dependencies({
    targets: [target(7, "s1"), target(8, "s2"), target(9, "s2")],
    sessions: [session("s1", true), session("s2")],
    handoffTab: 8,
    recordedTab: 9,
  })
  expect(tabIsBusy(7, deps)).toBe(true)
  expect(tabIsBusy(8, deps)).toBe(true)
  expect(tabIsBusy(9, deps)).toBe(true)
  expect(tabIsBusy(10, deps)).toBe(false)
})
