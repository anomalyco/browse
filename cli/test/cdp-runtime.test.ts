import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { CdpClientPool } from "../src/cdp/client-pool.ts"
import { CdpRuntime } from "../src/cdp/runtime.ts"
import type { TargetRegistry } from "../src/cdp/target-registry.ts"
import type { CdpEvent } from "../src/protocol.ts"
import type { ChildTarget, ConnectedTarget } from "../src/relay/types.ts"

// Fetch interception belongs to the tab, not to the client that enabled it: leaving it on after the last client that
// could answer Fetch.requestPaused goes pauses every request on the page. The pool tracks the clients that enabled it;
// the runtime releases the tab's root and child sessions when that set empties.

type Sent = {
  readonly tabId: number
  readonly sessionId?: string
  readonly method: string
}

const pageInfo = (targetId: string, url = "https://example.com/"): ConnectedTarget["targetInfo"] => ({
  targetId,
  type: "page",
  title: "",
  url,
  attached: true,
  canAccessOpener: false,
})

const frameInfo = (targetId: string): ChildTarget["targetInfo"] => ({
  targetId,
  type: "iframe",
  title: "",
  url: "https://example.com/frame",
  attached: true,
  canAccessOpener: false,
})

const root = (tabId: number): ConnectedTarget => ({
  tabId,
  sessionId: `bc-tab-${tabId}`,
  owner: "user",
  targetInfo: pageInfo(`TARGET-${tabId}`),
})

const child = (tabId: number): ChildTarget => ({
  tabId,
  sessionId: `bc-tab-${tabId}-child`,
  parentSessionId: `bc-tab-${tabId}`,
  targetInfo: frameInfo(`FRAME-${tabId}`),
  waitingForDebugger: false,
})

/** The parts of TargetRegistry the idle cleanup reads. */
function fakeRegistry(roots: ConnectedTarget[], children: ChildTarget[] = []): TargetRegistry {
  const bySession = new Map(roots.map((target) => [target.sessionId, target]))
  const byTab = new Map(roots.map((target) => [target.tabId, target]))
  return {
    targets: bySession,
    tabTargets: byTab,
    targetsByTargetId: new Map(roots.map((target) => [target.targetInfo.targetId, target])),
    childTargets: new Map(children.map((target) => [target.sessionId, target])),
    childTargetsByTargetId: new Map(children.map((target) => [target.targetInfo.targetId, target])),
    listRootTargets: () => roots,
    routingRootTarget: (tabId: number) => byTab.get(tabId),
  } as unknown as TargetRegistry
}

function makeRuntime(registry: TargetRegistry, sent: Sent[]) {
  return new CdpRuntime<object>({
    registry,
    generation: () => 1,
    send: (command) => Effect.sync(() => {
      sent.push({
        tabId: command.tabId,
        ...(command.sessionId === undefined ? {} : { sessionId: command.sessionId }),
        method: command.method,
      })
      return {}
    }),
    sendEvent: () => {},
  })
}

function makePool(emptied: number[]) {
  const events: CdpEvent[] = []
  return new CdpClientPool<object>(
    (_client, event) => { events.push(event) },
    () => {},
    (tabId) => { emptied.push(tabId) },
  )
}

const sorted = (sent: Sent[]) => [...sent].sort((a, b) => (a.sessionId ?? "").localeCompare(b.sessionId ?? ""))

describe("releasing a departing client's Fetch interception", () => {
  test("disables Fetch on the released tab's root and child sessions, and nowhere else", async () => {
    const sent: Sent[] = []
    const registry = fakeRegistry([root(7), root(8)], [child(7), child(8)])

    await Effect.runPromise(makeRuntime(registry, sent).releaseInterception([7], () => true))

    expect(sorted(sent)).toEqual([
      { tabId: 7, method: "Fetch.disable" },
      { tabId: 7, sessionId: "bc-tab-7-child", method: "Fetch.disable" },
    ])
  })

  test("leaves a tab whose owner came back alone", async () => {
    const sent: Sent[] = []
    const registry = fakeRegistry([root(7), root(8)], [child(7), child(8)])

    await Effect.runPromise(makeRuntime(registry, sent).releaseInterception([7, 8], (tabId) => tabId === 8))

    expect(sorted(sent)).toEqual([
      { tabId: 8, method: "Fetch.disable" },
      { tabId: 8, sessionId: "bc-tab-8-child", method: "Fetch.disable" },
    ])
  })

  test("rechecks before the child send and skips it when an owner appeared", async () => {
    const sent: Sent[] = []
    const runtime = makeRuntime(fakeRegistry([root(7)], [child(7)]), sent)

    // The root command runs while the set is empty; afterwards an owner has appeared, so the child must be skipped.
    await Effect.runPromise(runtime.releaseInterception([7], () => sent.length === 0))

    expect(sent).toEqual([{ tabId: 7, method: "Fetch.disable" }])
  })

  test("sends nothing for tabs that are not in the registry", async () => {
    const sent: Sent[] = []
    const runtime = makeRuntime(fakeRegistry([root(7)], [child(7)]), sent)

    await Effect.runPromise(runtime.releaseInterception([8], () => true))

    expect(sent).toEqual([])
  })

  test("keeps the whole-pool idle cleanup to Runtime.disable", async () => {
    const sent: Sent[] = []

    await Effect.runPromise(makeRuntime(fakeRegistry([root(7)], [child(7)]), sent).disableIdle(() => true))

    expect(sent).toEqual([
      { tabId: 7, method: "Runtime.disable" },
      { tabId: 7, sessionId: "bc-tab-7-child", method: "Runtime.disable" },
    ])
  })
})

describe("CdpClientPool Fetch-interception owners", () => {
  test("a tab is released only when its last owner goes", () => {
    const emptied: number[] = []
    const clients = makePool(emptied)
    const first = {}
    const second = {}
    clients.register(first)
    clients.register(second)

    clients.markInterceptionOwner(first, 7)
    clients.markInterceptionOwner(second, 7)
    expect(clients.hasInterceptionOwners(7)).toBe(true)

    clients.unregister(first)
    expect(emptied).toEqual([])
    expect(clients.hasInterceptionOwners(7)).toBe(true)

    clients.unregister(second)
    expect(emptied).toEqual([7])
    expect(clients.hasInterceptionOwners(7)).toBe(false)
  })

  test("clearing one session leaves the other client's ownership and the tab", () => {
    const emptied: number[] = []
    const clients = makePool(emptied)
    const first = {}
    const second = {}
    clients.register(first)
    clients.register(second)

    clients.markInterceptionOwner(first, 7)
    clients.markInterceptionOwner(second, 7)
    clients.clearInterceptionOwner(first, 7, undefined, false)
    expect(clients.hasInterceptionOwner(7, undefined)).toBe(true)
    expect(clients.hasInterceptionOwners(7)).toBe(true)
    expect(emptied).toEqual([])

    clients.clearInterceptionOwner(second, 7, undefined, false)
    expect(clients.hasInterceptionOwner(7, undefined)).toBe(false)
    expect(clients.hasInterceptionOwners(7)).toBe(false)
    // An explicit Fetch.disable is the release; it must not schedule a tab-wide release too.
    expect(emptied).toEqual([])
  })

  test("child target removal drops that session's owners and releases when the tab empties", () => {
    const emptied: number[] = []
    const clients = makePool(emptied)
    const client = {}
    clients.register(client)
    clients.announce(client, root(7))
    clients.announce(client, child(7))
    clients.markInterceptionOwner(client, 7, "bc-tab-7-child")

    clients.detachTarget(child(7))
    expect(clients.hasInterceptionOwner(7, "bc-tab-7-child")).toBe(false)
    expect(emptied).toEqual([7])
  })

  test("removing the root announcement drops every session owner for that tab", () => {
    const emptied: number[] = []
    const clients = makePool(emptied)
    const client = {}
    clients.register(client)
    clients.announce(client, root(7))
    clients.announce(client, child(7))
    clients.markInterceptionOwner(client, 7)
    clients.markInterceptionOwner(client, 7, "bc-tab-7-child")

    clients.detach(client, "bc-tab-7-child")
    expect(emptied).toEqual([])
    expect(clients.hasInterceptionOwner(7, "bc-tab-7-child")).toBe(true)

    clients.detach(client, "bc-tab-7")
    expect(emptied).toEqual([7])
    expect(clients.hasInterceptionOwners(7)).toBe(false)
  })

  test("marking twice keeps one owner, and a tab no client enabled is never released", () => {
    const emptied: number[] = []
    const clients = makePool(emptied)
    const client = {}
    clients.register(client)
    clients.announce(client, root(7))

    clients.markInterceptionOwner(client, 7)
    clients.markInterceptionOwner(client, 7)
    clients.unregister(client)
    expect(emptied).toEqual([7])

    const untouched = {}
    clients.register(untouched)
    clients.announce(untouched, root(8))
    clients.unregister(untouched)
    expect(emptied).toEqual([7])
  })

  test("pruning an invisible root drops the owner", () => {
    const emptied: number[] = []
    const clients = makePool(emptied)
    const client = {}
    clients.register(client)
    clients.announce(client, root(7))
    clients.markInterceptionOwner(client, 7)

    clients.pruneInvisible(client, () => false)
    expect(emptied).toEqual([7])
  })

  test("a tab target going away drops its owners", () => {
    const emptied: number[] = []
    const clients = makePool(emptied)
    const client = {}
    clients.register(client)
    clients.announce(client, root(7))
    clients.markInterceptionOwner(client, 7)

    clients.detachTab(7)
    expect(emptied).toEqual([7])
    expect(clients.hasInterceptionOwners(7)).toBe(false)
  })
})
