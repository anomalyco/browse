import { describe, expect, test } from "bun:test"
import type { ConnectedTarget } from "../src/relay/types.ts"
import { keepsTabVisible } from "../src/relay/tab-presentation.ts"

const target = (owner: "relay" | "user", opencodeBrowserSessionId?: string): ConnectedTarget => ({
  tabId: 10,
  sessionId: "cdp-10",
  owner,
  ...(opencodeBrowserSessionId ? { opencodeBrowserSessionId } : {}),
  targetInfo: {
    targetId: "target-10",
    type: "page",
    title: "tab-10",
    url: "https://example.test/",
    attached: true,
    canAccessOpener: false,
  },
})

describe("keepsTabVisible", () => {
  test("a keepVisible session keeps only the relay-owned tabs it opened itself", () => {
    expect(keepsTabVisible("s1", true, target("relay", "s1"))).toBe(true)
    // A tab the user lent it, another session's tab, and a tab that is no longer attached are not kept.
    expect(keepsTabVisible("s1", true, target("user", "s1"))).toBe(false)
    expect(keepsTabVisible("s1", true, target("relay", "s2"))).toBe(false)
    expect(keepsTabVisible("s1", true, undefined)).toBe(false)
  })

  test("without keepVisible nothing is kept", () => {
    expect(keepsTabVisible("s1", false, target("relay", "s1"))).toBe(false)
  })
})
