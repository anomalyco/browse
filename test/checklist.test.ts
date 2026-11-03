import { describe, expect, test } from "bun:test"
import type { AgentRelayState } from "../src/shared/protocol"
import { checklist, featuredAgents, installCommand, otherAgents, type ChecklistInput } from "../src/status/checklist"
import { agentNames } from "../cli/src/agent-labels"
import { relayResultText, richParts } from "../src/status/describe"

const state = (overrides: Partial<AgentRelayState> = {}): AgentRelayState => ({
  status: "unpaired",
  pairing: "none",
  tabs: [],
  relay: { address: "localhost:19988", remote: false },
  ...overrides,
})
const input = (overrides: Partial<ChecklistInput> = {}): ChecklistInput => ({
  state: state(),
  wasConnected: false,
  pinned: false,
  pinSkipped: false,
  tried: false,
  ...overrides,
})

describe("onboarding checklist", () => {
  test("a fresh install starts on the agent step, with the rest not reached", () => {
    expect(checklist(input())).toEqual({ agent: "active", pin: "upcoming", tryIt: "upcoming", finished: false })
    expect(checklist(input({ state: undefined }))).toMatchObject({ agent: "active" })
  })

  test("connecting the agent moves on to pinning, and pinning (or skipping) to trying it", () => {
    const connected = state({ status: "connected", pairing: "token" })
    expect(checklist(input({ state: connected }))).toEqual({ agent: "done", pin: "active", tryIt: "upcoming", finished: false })
    expect(checklist(input({ state: connected, pinned: true }))).toEqual({ agent: "done", pin: "done", tryIt: "active", finished: false })
    expect(checklist(input({ state: connected, pinSkipped: true }))).toMatchObject({ pin: "done", tryIt: "active" })
  })

  test("an agent tab finishes it", () => {
    const used = state({ status: "connected", pairing: "token", tabs: [{ tabId: 3 }] })
    expect(checklist(input({ state: used, pinned: true }))).toEqual({ agent: "done", pin: "done", tryIt: "done", finished: true })
    expect(checklist(input({ state: state({ status: "connected", pairing: "token" }), pinned: true, tried: true })).finished).toBe(true)
  })

  test("a pin made early shows as done before its turn", () => {
    expect(checklist(input({ pinned: true }))).toMatchObject({ agent: "active", pin: "done", tryIt: "upcoming" })
  })

  test("the agent step stays done while a paired relay stops, not when it refuses the browser", () => {
    expect(checklist(input({ state: state({ status: "offline", pairing: "token" }), wasConnected: true })).agent).toBe("done")
    expect(checklist(input({ state: state({ status: "offline", pairing: "token" }) })).agent).toBe("active")
    expect(checklist(input({ state: state({ status: "untrusted", pairing: "token" }), wasConnected: true })).agent).toBe("active")
  })
})

describe("agent picker", () => {
  test("lists every agent install knows once", () => {
    expect([...featuredAgents, ...otherAgents].sort()).toEqual([...agentNames].sort())
    expect(featuredAgents[0]).toBe("opencode")
  })

  test("names the agent in the install command, except OpenCode, the default", () => {
    expect(installCommand("opencode")).toBe("npx @opencode/browse install")
    expect(installCommand("claude")).toBe("npx @opencode/browse install --agent claude")
  })
})

describe("relay results", () => {
  test("say where, in plain words", () => {
    expect(relayResultText("connected", "devbox:19988", false)).toBe("Connected to the relay at devbox:19988.")
    expect(relayResultText("offline", "localhost:19988", false)).toContain("on this computer (localhost:19988)")
    expect(relayResultText("offline", "devbox:19988", true)).toStartWith("Code saved.")
  })

  test("mark commands as code", () => {
    expect(richParts("run `pair` there")).toEqual([
      { code: false, text: "run " },
      { code: true, text: "pair" },
      { code: false, text: " there" },
    ])
  })
})
