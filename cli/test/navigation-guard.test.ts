import { expect, test } from "bun:test"
import { SessionNavigationGuard, type NavigationGuardTarget } from "../src/session-manager/navigation-guard.ts"

function setup() {
  const closed: number[] = []
  const logs: string[] = []
  const guard = new SessionNavigationGuard({
    allowedOrigins: () => ["*.deel.com", "accounts.google.com"],
    isExecuting: () => false,
    mainFrameId: () => undefined,
    send: async () => undefined,
    closeTab: async (tabId) => closed.push(tabId),
    log: (event) => logs.push(event),
  })
  return { guard, closed, logs }
}

const popup = (url: string): NavigationGuardTarget => ({
  tabId: 7,
  owner: "relay",
  opencodeBrowserSessionId: "deel",
  targetInfo: { targetId: "T7", url },
})

test("a popup that attaches before its first navigation stays open", () => {
  const { guard, closed, logs } = setup()
  guard.popupAttached(popup(""))
  expect(closed).toEqual([])
  expect(logs).toEqual([])
})

test("a popup that then commits a disallowed document is closed", () => {
  const { guard, closed } = setup()
  guard.popupAttached(popup(""))
  guard.observeEvent(popup(""), "Page.frameNavigated", { frame: { id: "T7", url: "https://evil.test/" } })
  expect(closed).toEqual([7])
})

test("a popup that commits an allowed document stays open", () => {
  const { guard, closed } = setup()
  guard.popupAttached(popup(""))
  guard.observeEvent(popup(""), "Page.frameNavigated", { frame: { id: "T7", url: "https://accounts.google.com/o/oauth2/auth" } })
  expect(closed).toEqual([])
})
