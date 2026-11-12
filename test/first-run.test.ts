import { describe, expect, test } from "bun:test"
import type { AgentRelayState } from "../src/shared/protocol"
import { firstRunStep, shouldProbe } from "../src/status/first-run"
import { relayProbeResult } from "../src/agent-relay/probe"

const state = (overrides: Partial<AgentRelayState> = {}): AgentRelayState => ({
  status: "unpaired",
  pairing: "none",
  tabs: [],
  relay: { address: "localhost:19988", remote: false },
  ...overrides,
})
const remote = { address: "devbox:19988", remote: true }

describe("first-run step", () => {
  test("a store install with nothing set up is told to run install, once the probe has answered", () => {
    expect(firstRunStep(undefined, "unknown")).toEqual({ kind: "checking" })
    expect(firstRunStep(state(), "unknown")).toEqual({ kind: "checking" })
    expect(firstRunStep(state(), "absent")).toEqual({ kind: "install" })
  })

  test("a relay that runs but isn't paired with this browser asks to pair", () => {
    expect(firstRunStep(state(), "found")).toEqual({ kind: "pair", reason: "unpaired", unpacked: false })
    expect(firstRunStep(state({ relay: remote }), "unknown")).toEqual({ kind: "pair", reason: "unpaired", remote: "devbox:19988", unpacked: false })
  })

  test("an active installer needs no second command", () => {
    expect(firstRunStep(state(), "install-waiting")).toEqual({ kind: "finishing" })
    expect(firstRunStep(state({ status: "connected" }), "install-waiting")).toMatchObject({ kind: "connected" })
  })

  test("a refused pairing and a refused code say which", () => {
    expect(firstRunStep(state({ status: "untrusted", pairing: "token" }), "unknown")).toMatchObject({ kind: "pair", reason: "refused" })
    expect(firstRunStep(state({ status: "untrusted", pairing: "code", codeRejected: true }), "unknown")).toMatchObject({ kind: "pair", reason: "code-rejected" })
    // The rejected code was spent: nothing is left to connect with.
    expect(firstRunStep(state({ codeRejected: true }), "found")).toMatchObject({ kind: "pair", reason: "code-rejected" })
    expect(firstRunStep(state({ status: "offline", pairing: "token", codeRejected: true }), "unknown")).toMatchObject({ kind: "pair", reason: "code-rejected" })
  })

  test("paired, or holding a code, while no relay runs waits for one", () => {
    expect(firstRunStep(state({ status: "offline", pairing: "token" }), "unknown")).toEqual({ kind: "waiting", pairing: "token" })
    expect(firstRunStep(state({ status: "offline", pairing: "code" }), "unknown")).toEqual({ kind: "waiting", pairing: "code" })
    expect(firstRunStep(state({ status: "connecting", pairing: "code" }), "unknown")).toEqual({ kind: "connecting", pairing: true })
  })

  test("connected, with the tabs agents use", () => {
    expect(firstRunStep(state({ status: "connected", pairing: "token" }), "unknown")).toEqual({ kind: "connected", tabs: 0 })
    expect(firstRunStep(state({ status: "connected", pairing: "token", tabs: [{ tabId: 4 }], relay: remote }), "unknown")).toEqual({
      kind: "connected",
      tabs: 1,
      remote: "devbox:19988",
    })
  })

  test("a protocol mismatch names the side to update", () => {
    expect(firstRunStep(state({ status: "incompatible", pairing: "token", skew: "update-cli" }), "unknown")).toEqual({ kind: "update-cli" })
    expect(firstRunStep(state({ status: "incompatible", pairing: "token", skew: "update-extension" }), "unknown")).toEqual({ kind: "update-extension", unpacked: false })
    expect(firstRunStep(state({ status: "incompatible", pairing: "token", skew: "update-extension", unpacked: true }), "unknown")).toEqual({
      kind: "update-extension",
      unpacked: true,
    })
    expect(firstRunStep(state({ status: "incompatible", pairing: "token" }), "unknown")).toEqual({ kind: "mismatch" })
    expect(firstRunStep(state({ status: "conflict", pairing: "token" }), "unknown")).toEqual({ kind: "conflict" })
  })
})

describe("relay probe", () => {
  test("only while there's nothing to connect with, for this computer's relay", () => {
    expect(shouldProbe(state())).toBe(true)
    expect(shouldProbe(state({ relay: remote }))).toBe(false)
    expect(shouldProbe(state({ status: "offline", pairing: "token" }))).toBe(false)
    expect(shouldProbe(undefined)).toBe(false)
  })

  test("recognizes browse's own answers and nothing else", () => {
    expect(relayProbeResult(200, { version: "0.0.2", buildId: "x", instanceId: "abc", pid: 1 })).toBe("found")
    expect(relayProbeResult(403, { error: "Cross-origin browser requests are not allowed" })).toBe("found")
    expect(relayProbeResult(403, { error: "Cross-origin browser requests are not allowed", installWaiting: true })).toBe("install-waiting")
    expect(relayProbeResult(200, { version: "1.0" })).toBe("absent")
    expect(relayProbeResult(404, undefined)).toBe("absent")
    expect(relayProbeResult(undefined, undefined)).toBe("absent")
  })
})
