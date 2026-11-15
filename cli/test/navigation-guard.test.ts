import { describe, expect, test } from "bun:test"
import { SessionNavigationGuard, type NavigationGuardTarget } from "../src/session-manager/navigation-guard.ts"

// The allowlist guard's popup decisions, without a relay or a browser: a just-attached popup can report an empty URL
// (Chrome hasn't navigated it yet), which must not be judged as a destination. Its first real commit still is, and an
// allowed popup is blanked rather than closed if it later leaves the allowlist.

const session = "guarded"
const settle = () => Bun.sleep(0)

function scene(allowedOrigins: readonly string[] = ["example.com"]) {
  const closed: number[] = []
  const sent: Array<{ readonly tabId: number; readonly method: string; readonly params: Record<string, unknown> }> = []
  const logged: Array<{ readonly event: string; readonly details: Record<string, unknown> }> = []
  const guard = new SessionNavigationGuard({
    allowedOrigins: (sessionId) => sessionId === session ? allowedOrigins : undefined,
    isExecuting: () => true,
    mainFrameId: (tabId) => `TARGET-${tabId}`,
    send: async (tabId, method, params) => {
      sent.push({ tabId, method, params })
    },
    closeTab: async (tabId) => {
      closed.push(tabId)
    },
    log: (event, details) => {
      logged.push({ event, details })
    },
  })
  return { guard, closed, sent, logged }
}

function popup(tabId: number, url: string): NavigationGuardTarget {
  return { tabId, owner: "relay", opencodeBrowserSessionId: session, targetInfo: { targetId: `TARGET-${tabId}`, url } }
}

function commit(guard: SessionNavigationGuard, target: NavigationGuardTarget, url: string, loaderId = "L-1") {
  guard.observeEvent(target, "Page.frameNavigated", { frame: { id: target.targetInfo.targetId, loaderId, url } })
}

describe("SessionNavigationGuard popups", () => {
  test("an empty URL at attach is not a violation, and the real first navigation is checked", async () => {
    const { guard, closed, logged } = scene()
    const target = popup(7, "")

    expect(guard.popupAttached(target)).toBe(true)
    expect(closed).toEqual([])
    expect(guard.drainWarnings(session)).toEqual([])
    expect(logged).toEqual([])

    // The popup's allowed first navigation commits.
    commit(guard, target, "https://example.com/start")
    await settle()
    expect(closed).toEqual([])
    expect(guard.drainWarnings(session)).toEqual([])

    // It is an ordinary tab now: a later off-list navigation is blocked by blanking it, not by closing it.
    commit(guard, target, "https://evil.test/", "L-2")
    await settle()
    expect(closed).toEqual([])
    expect(logged).toContainEqual({
      event: "allowlist.violation",
      details: { tabId: 7, session, url: "https://evil.test/", popup: false },
    })
    expect(guard.drainWarnings(session)).toHaveLength(1)
    expect(guard.drainWarnings(session)).toEqual([])
  })

  test("an off-list navigation starting in a fresh popup closes it instead of stopping a blank tab", async () => {
    const { guard, closed, sent, logged } = scene()
    const target = popup(12, "")

    expect(guard.popupAttached(target)).toBe(true)
    guard.observeEvent(target, "Page.frameStartedNavigating", { frameId: "TARGET-12", url: "https://evil.test/" })
    await settle()

    expect(closed).toEqual([12])
    expect(sent.map((command) => command.method)).not.toContain("Page.stopLoading")
    expect(logged).toContainEqual({
      event: "allowlist.violation",
      details: { tabId: 12, session, url: "https://evil.test/", popup: true },
    })
    expect(guard.drainWarnings(session)[0]).toContain("closed the popup")
  })

  test("a popup marked fresh before attach is closed by an off-list navigation during attach", async () => {
    const { guard, closed, logged, sent } = scene()
    const target = popup(13, "")

    guard.popupOpening(13)
    guard.observeEvent(target, "Page.frameRequestedNavigation", { frameId: "TARGET-13", url: "https://evil.test/" })
    await settle()

    expect(closed).toEqual([13])
    expect(guard.drainWarnings(session)).toHaveLength(1)

    // An attach that fails forgets the mark: the next violation blanks the tab instead of closing it.
    guard.forgetTab(13)
    guard.observeEvent(target, "Page.frameRequestedNavigation", { frameId: "TARGET-13", url: "https://evil.test/" })
    await settle()
    expect(closed).toEqual([13])
    expect(logged.filter((entry) => entry.event === "allowlist.violation")).toHaveLength(1)
    expect(sent.some((command) => command.method === "Page.stopLoading")).toBe(true)
  })

  test("an empty URL at attach does not stop an off-list first navigation from closing the popup", async () => {
    const { guard, closed, sent, logged } = scene()
    const target = popup(8, "")

    expect(guard.popupAttached(target)).toBe(true)
    commit(guard, target, "https://evil.test/")
    await settle()

    expect(closed).toEqual([8])
    expect(sent.map((command) => command.method)).not.toContain("Page.navigate")
    expect(logged).toContainEqual({
      event: "allowlist.violation",
      details: { tabId: 8, session, url: "https://evil.test/", popup: true },
    })
    const warnings = guard.drainWarnings(session)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("closed the popup")
  })

  test("about:blank at attach behaves the same as an empty URL", async () => {
    const { guard, closed } = scene()
    const target = popup(9, "about:blank")

    expect(guard.popupAttached(target)).toBe(true)
    expect(guard.drainWarnings(session)).toEqual([])

    commit(guard, target, "https://example.com/start")
    await settle()
    expect(closed).toEqual([])

    commit(guard, target, "https://evil.test/", "L-2")
    await settle()
    expect(closed).toEqual([])
    expect(guard.drainWarnings(session)[0]).toContain("sent the tab back to about:blank")
  })

  test("an allowlisted URL at attach keeps the popup and later leaves are blanked, not closed", async () => {
    const { guard, closed } = scene()
    const target = popup(10, "https://example.com/start")

    expect(guard.popupAttached(target)).toBe(true)
    expect(guard.drainWarnings(session)).toEqual([])

    commit(guard, target, "https://evil.test/")
    await settle()
    expect(closed).toEqual([])
    expect(guard.drainWarnings(session)[0]).toContain("sent the tab back to about:blank")
  })

  test("an off-list URL at attach is still closed", async () => {
    const { guard, closed } = scene()
    const target = popup(11, "https://evil.test/")

    expect(guard.popupAttached(target)).toBe(false)
    await settle()
    expect(closed).toEqual([11])
    expect(guard.drainWarnings(session)[0]).toContain("closed the popup")
  })
})
