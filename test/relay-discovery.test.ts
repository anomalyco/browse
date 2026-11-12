import { afterEach, describe, expect, test } from "bun:test"
import { relayPortHint, relayPorts } from "../src/agent-relay/protocol"
import { chooseRelayPort, relayTarget, scanRelayPorts } from "../src/background/agent-relay/discovery"
import { pairingLink } from "../src/status/pairing-link"

// Where an automatic connection looks for the relay, and what a pairing hint may say. No chrome and no network: the
// scan's fetch is mocked per test, and the rest is pure.

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

describe("pairing link fragment", () => {
  test("takes the code and the relay port when it is one browse uses", () => {
    expect(pairingLink("#code=ABCD1234&port=19990")).toEqual({ code: "ABCD1234", port: 19990 })
    expect(pairingLink("#code=ABCD1234&port=19988")).toEqual({ code: "ABCD1234", port: 19988 })
    expect(pairingLink("#code=ABCD1234")).toEqual({ code: "ABCD1234" })
  })

  test("ignores a port that isn't a browse relay's", () => {
    expect(pairingLink("#code=ABCD1234&port=19989")).toEqual({ code: "ABCD1234" })
    expect(pairingLink("#code=ABCD1234&port=19987")).toEqual({ code: "ABCD1234" })
    expect(pairingLink("#code=ABCD1234&port=19999")).toEqual({ code: "ABCD1234" })
    expect(pairingLink("#code=ABCD1234&port=abc")).toEqual({ code: "ABCD1234" })
  })

  test("isn't a link without a usable code", () => {
    expect(pairingLink("#code=short")).toBeUndefined()
    expect(pairingLink("#ticket=ABCD1234")).toBeUndefined()
    expect(pairingLink("")).toBeUndefined()
  })

  test("the accepted ports are the default and its fallbacks, and nothing else", () => {
    expect(relayPorts).toEqual([19988, 19990, 19991, 19992, 19993, 19994, 19995, 19996, 19997])
    for (const port of relayPorts) expect(relayPortHint(port)).toBe(port)
    for (const value of [19989, 19987, 19998, 0, Number.NaN, "19990", null, undefined])
      expect(relayPortHint(value)).toBeUndefined()
  })
})

describe("relay target", () => {
  test("nothing stored dials the default port automatically", () => {
    expect(relayTarget({})).toEqual({ host: "127.0.0.1", port: 19988, automatic: true })
    expect(relayTarget({ agentRelayAddress: "" })).toEqual({ host: "127.0.0.1", port: 19988, automatic: true })
    expect(relayTarget({ agentRelayAddress: "localhost" })).toEqual({ host: "127.0.0.1", port: 19988, automatic: true })
  })

  test("an automatic connection dials the discovered port", () => {
    expect(relayTarget({ agentRelayDiscoveredPort: 19993 })).toEqual({ host: "127.0.0.1", port: 19993, automatic: true })
    // A discovered value that isn't a browse port is ignored, like an unknown setting.
    expect(relayTarget({ agentRelayDiscoveredPort: 19989 })).toEqual({ host: "127.0.0.1", port: 19988, automatic: true })
    expect(relayTarget({ agentRelayDiscoveredPort: "19993" })).toEqual({ host: "127.0.0.1", port: 19988, automatic: true })
  })

  test("an address with a port, or another computer, is explicit and never scans", () => {
    expect(relayTarget({ agentRelayAddress: "devbox:19990" })).toEqual({ host: "devbox", port: 19990, automatic: false })
    expect(relayTarget({ agentRelayAddress: "100.64.0.2" })).toEqual({ host: "100.64.0.2", port: 19988, automatic: false })
    // Even a loopback address with a port was pinned by the user.
    expect(relayTarget({ agentRelayAddress: "localhost:19991" })).toEqual({ host: "127.0.0.1", port: 19991, automatic: false })
  })

  test("the PORT_KEY dev pin is explicit, and the discovered port doesn't override its address", () => {
    expect(relayTarget({ agentRelayPort: 19925 })).toEqual({ host: "127.0.0.1", port: 19925, automatic: false })
    expect(relayTarget({ agentRelayPort: 19990, agentRelayDiscoveredPort: 19993 })).toEqual({
      host: "127.0.0.1",
      port: 19990,
      automatic: false,
    })
    expect(relayTarget({ agentRelayAddress: "devbox", agentRelayPort: 19925 })).toEqual({
      host: "devbox",
      port: 19925,
      automatic: false,
    })
  })
})

describe("relay scan", () => {
  test("asks every candidate at once and keeps the browse answers in dial order", async () => {
    const asked: string[] = []
    globalThis.fetch = (async (input: string | URL) => {
      asked.push(String(input))
      const port = Number(/127\.0\.0\.1:(\d+)\/version/.exec(String(input))?.[1])
      return port === 19988 || port === 19992
        ? Response.json({ version: "0.0.2", instanceId: "abc" })
        : new Response("not found", { status: 404 })
    }) as typeof fetch
    expect(await scanRelayPorts()).toEqual([19988, 19992])
    expect(asked).toHaveLength(relayPorts.length)
  })

  test("nothing answering as browse is an empty scan, not an error", async () => {
    globalThis.fetch = (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch
    expect(await scanRelayPorts()).toEqual([])
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED")
    }) as unknown as typeof fetch
    expect(await scanRelayPorts()).toEqual([])
  })

  test("prefers a port this browser already holds a token for", () => {
    expect(chooseRelayPort([19990, 19991], (port) => port === 19991)).toBe(19991)
    expect(chooseRelayPort([19990, 19991], () => false)).toBe(19990)
    expect(chooseRelayPort([], () => true)).toBeUndefined()
  })
})
