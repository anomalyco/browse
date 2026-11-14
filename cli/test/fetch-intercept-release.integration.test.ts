import { afterAll, beforeAll, expect, test } from "bun:test"
import type { ChildProcess } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import WebSocket from "ws"
import { cdpCall, collect, connectCdp, FakeExtension, startRelay, stopRelay, until } from "./relay-harness.ts"

// Patchright enables Fetch on every page it attaches to. A client that enabled it can stop answering for a tab in
// several ways (closing, detaching its root, losing the announcement), and a relay restart keeps the debugger attached.
// The relay tracks who enabled Fetch per tab and releases the tab's root and child sessions when the last owner goes.

const temporaryRoot = path.join(os.homedir(), ".cache", "oc-tmp")
fs.mkdirSync(temporaryRoot, { recursive: true })
// The harness gives the relay its own HOME/OPENCODE_BROWSER_HOME and a free port (never 19988).
const home = fs.mkdtempSync(path.join(temporaryRoot, "browse-fetch-release-"))
let relay: ChildProcess | undefined
let port = 0
let token = ""

beforeAll(async () => {
  const started = await startRelay(home, { OPENCODE_BROWSER_STORE_ID: "b".repeat(32) })
  relay = started.child
  port = started.port
  token = started.token
}, 20_000)

afterAll(async () => {
  await stopRelay(relay)
  fs.rmSync(home, { recursive: true, force: true })
})

const targetInfo = (targetId: string, url: string, type: "page" | "iframe" = "page") => ({
  targetId,
  type,
  title: "",
  url,
  attached: true,
  canAccessOpener: false,
  browserContextId: "CTX",
})

async function openClient(sessionId: string) {
  const socket = await connectCdp(
    `ws://127.0.0.1:${port}/devtools/browser/test?opencodeBrowserSessionId=${sessionId}`,
    { authorization: `Bearer ${token}` },
  )
  if (!(socket instanceof WebSocket)) throw new Error(`CDP connection refused: ${socket}`)
  return socket
}

async function createSession(id: string, readOnly = false) {
  const response = await fetch(`http://127.0.0.1:${port}/cli/session/new`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ id, ...(readOnly ? { readOnly: true } : {}) }),
  })
  if (!response.ok) throw new Error(await response.text())
}

async function api(pathname: string, body: unknown) {
  return fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

function announcedSession(events: Array<{ method?: string; params?: Record<string, unknown> }>, targetId: string) {
  const event = events.find((message) =>
    message.method === "Target.attachedToTarget" &&
    (message.params?.targetInfo as { targetId?: string } | undefined)?.targetId === targetId
  )
  return typeof event?.params?.sessionId === "string" ? event.params.sessionId : undefined
}

/** Announces an attached tab to a client and returns the root session id. */
async function attachTab(socket: WebSocket, events: Array<{ method?: string; params?: Record<string, unknown> }>, targetId: string) {
  const attached = await cdpCall(socket, 1, "Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })
  expect(attached.error).toBeUndefined()
  expect(await until(() => announcedSession(events, targetId) !== undefined)).toBe(true)
  return announcedSession(events, targetId)!
}

const fetches = (extension: FakeExtension, method: "Fetch.enable" | "Fetch.disable") =>
  extension.commands.filter((command) => command.method === "debugger.sendCommand" && command.params?.method === method)

const fetchPatterns = [{ urlPattern: "*", requestStage: "Request" }]
const childSession = (tabId: number) => `frame-${tabId}`
const childTarget = (tabId: number) => targetInfo(`FRAME-${tabId}`, `https://example.com/frame/${tabId}`, "iframe")

function attachedExtension(tabId: number) {
  return new FakeExtension(home, port)
    .on("Target.getTargetInfo", () => ({ targetInfo: targetInfo(`TARGET-${tabId}`, `https://example.com/${tabId}`) }))
}

test("two clients on one shared tab: closing one keeps Fetch, closing the last releases root and child", async () => {
  const tabId = 431
  const extension = attachedExtension(tabId)
  expect(await extension.pair({ attachedTabs: [tabId] })).toBe(true)
  await createSession("shared-a")
  await createSession("shared-b")
  const first = await openClient("shared-a")
  const second = await openClient("shared-b")
  const firstEvents = collect(first)
  const secondEvents = collect(second)
  try {
    const firstRoot = await attachTab(first, firstEvents, `TARGET-${tabId}`)
    const secondRoot = await attachTab(second, secondEvents, `TARGET-${tabId}`)
    expect(secondRoot).toBe(firstRoot)

    extension.emit("debugger.event", {
      tabId,
      method: "Target.attachedToTarget",
      params: { sessionId: childSession(tabId), targetInfo: childTarget(tabId), waitingForDebugger: false },
    })
    expect(await until(() =>
      firstEvents.some((message) => message.params?.sessionId === childSession(tabId)) &&
      secondEvents.some((message) => message.params?.sessionId === childSession(tabId))
    )).toBe(true)

    expect((await cdpCall(first, 2, "Fetch.enable", { patterns: fetchPatterns }, firstRoot)).error).toBeUndefined()
    expect((await cdpCall(second, 2, "Fetch.enable", { patterns: fetchPatterns }, secondRoot)).error).toBeUndefined()
    expect((await cdpCall(second, 3, "Fetch.enable", { patterns: fetchPatterns }, childSession(tabId))).error).toBeUndefined()
    expect(await until(() => fetches(extension, "Fetch.enable").some((command) => command.params?.tabId === tabId && command.params?.sessionId === undefined))).toBe(true)
    expect(await until(() => fetches(extension, "Fetch.enable").some((command) => command.params?.sessionId === childSession(tabId)))).toBe(true)

    first.close()
    await Bun.sleep(300)
    expect(fetches(extension, "Fetch.disable").filter((command) => command.params?.tabId === tabId)).toEqual([])

    second.close()
    const released = () => fetches(extension, "Fetch.disable").filter((command) => command.params?.tabId === tabId)
    expect(await until(() =>
      released().some((command) => command.params?.sessionId === undefined) &&
      released().some((command) => command.params?.sessionId === childSession(tabId)), 5_000
    )).toBe(true)
  } finally {
    first.close()
    second.close()
    extension.close()
  }
}, 20_000)

test("a read-only session on the same tab does not block the release", async () => {
  const tabId = 441
  const extension = attachedExtension(tabId)
  expect(await extension.pair({ attachedTabs: [tabId] })).toBe(true)
  await createSession("writer")
  await createSession("looker", true)
  const writer = await openClient("writer")
  const looker = await openClient("looker")
  const writerEvents = collect(writer)
  const lookerEvents = collect(looker)
  try {
    const writerRoot = await attachTab(writer, writerEvents, `TARGET-${tabId}`)
    const lookerRoot = await attachTab(looker, lookerEvents, `TARGET-${tabId}`)
    expect(lookerRoot).toBe(writerRoot)

    expect((await cdpCall(writer, 2, "Fetch.enable", { patterns: fetchPatterns }, writerRoot)).error).toBeUndefined()
    const refused = await cdpCall(looker, 2, "Fetch.enable", { patterns: fetchPatterns }, lookerRoot)
    expect(refused.error?.message).toContain("this tab is read-only")
    expect(await until(() => fetches(extension, "Fetch.enable").some((command) => command.params?.tabId === tabId))).toBe(true)

    writer.close()
    const released = () => fetches(extension, "Fetch.disable").filter((command) => command.params?.tabId === tabId)
    expect(await until(() => released().some((command) => command.params?.sessionId === undefined), 5_000)).toBe(true)
    expect(looker.readyState).toBe(WebSocket.OPEN)

    // The read-only client was never an owner, so closing it adds nothing.
    looker.close()
    await Bun.sleep(200)
    expect(released().filter((command) => command.params?.sessionId === undefined)).toHaveLength(1)
  } finally {
    writer.close()
    looker.close()
    extension.close()
  }
}, 20_000)

test("Target.detachFromTarget of the root releases Fetch on root and child", async () => {
  const tabId = 451
  const extension = attachedExtension(tabId)
  expect(await extension.pair({ attachedTabs: [tabId] })).toBe(true)
  await createSession("detach-owner")
  const socket = await openClient("detach-owner")
  const events = collect(socket)
  try {
    const rootSession = await attachTab(socket, events, `TARGET-${tabId}`)
    extension.emit("debugger.event", {
      tabId,
      method: "Target.attachedToTarget",
      params: { sessionId: childSession(tabId), targetInfo: childTarget(tabId), waitingForDebugger: false },
    })
    expect(await until(() => events.some((message) => message.params?.sessionId === childSession(tabId)))).toBe(true)
    expect((await cdpCall(socket, 2, "Fetch.enable", { patterns: fetchPatterns }, rootSession)).error).toBeUndefined()
    expect(await until(() => fetches(extension, "Fetch.enable").some((command) => command.params?.tabId === tabId))).toBe(true)

    expect((await cdpCall(socket, 3, "Target.detachFromTarget", { sessionId: rootSession })).error).toBeUndefined()
    const released = () => fetches(extension, "Fetch.disable").filter((command) => command.params?.tabId === tabId)
    expect(await until(() =>
      released().some((command) => command.params?.sessionId === undefined) &&
      released().some((command) => command.params?.sessionId === childSession(tabId)), 5_000
    )).toBe(true)
  } finally {
    socket.close()
    extension.close()
  }
}, 20_000)

test("Fetch.enable without the tab's root announcement is refused and records no owner", async () => {
  const tabId = 481
  const extension = attachedExtension(tabId)
  expect(await extension.pair({ attachedTabs: [tabId] })).toBe(true)
  await createSession("no-root")
  const socket = await openClient("no-root")
  const events = collect(socket)
  try {
    const rootSession = await attachTab(socket, events, `TARGET-${tabId}`)
    extension.emit("debugger.event", {
      tabId,
      method: "Target.attachedToTarget",
      params: { sessionId: childSession(tabId), targetInfo: childTarget(tabId), waitingForDebugger: false },
    })
    expect(await until(() => events.some((message) => message.params?.sessionId === childSession(tabId)))).toBe(true)

    // Drop every announcement, then attach only the child: events still route to the root, which this client lacks.
    expect((await cdpCall(socket, 2, "Target.detachFromTarget", { sessionId: rootSession })).error).toBeUndefined()
    const childOnly = await cdpCall(socket, 3, "Target.attachToTarget", { targetId: `FRAME-${tabId}`, flatten: true })
    expect(childOnly.error).toBeUndefined()
    const childSessionId = String(childOnly.result?.sessionId)

    for (const [id, sessionId] of [[4, childSessionId], [5, rootSession]] as const) {
      const refused = await cdpCall(socket, id, "Fetch.enable", { patterns: fetchPatterns }, sessionId)
      expect(refused.error?.message).toContain("requires this client to be attached to the tab's root target")
    }
    expect(fetches(extension, "Fetch.enable").filter((command) => command.params?.tabId === tabId)).toEqual([])

    socket.close()
    await Bun.sleep(300)
    expect(fetches(extension, "Fetch.disable").filter((command) => command.params?.tabId === tabId)).toEqual([])
  } finally {
    socket.close()
    extension.close()
  }
}, 20_000)

test("one client's Fetch.disable does not clear another owner of the same session", async () => {
  const tabId = 491
  const extension = attachedExtension(tabId)
  expect(await extension.pair({ attachedTabs: [tabId] })).toBe(true)
  await createSession("same-a")
  await createSession("same-b")
  const first = await openClient("same-a")
  const second = await openClient("same-b")
  const firstEvents = collect(first)
  const secondEvents = collect(second)
  try {
    const firstRoot = await attachTab(first, firstEvents, `TARGET-${tabId}`)
    expect(await attachTab(second, secondEvents, `TARGET-${tabId}`)).toBe(firstRoot)
    expect((await cdpCall(first, 2, "Fetch.enable", { patterns: fetchPatterns }, firstRoot)).error).toBeUndefined()
    expect((await cdpCall(second, 2, "Fetch.enable", { patterns: fetchPatterns }, firstRoot)).error).toBeUndefined()
    expect(await until(() => fetches(extension, "Fetch.enable").filter((command) => command.params?.tabId === tabId).length === 2)).toBe(true)

    expect((await cdpCall(first, 3, "Fetch.disable", {}, firstRoot)).error).toBeUndefined()
    await Bun.sleep(300)
    expect(fetches(extension, "Fetch.disable").filter((command) => command.params?.tabId === tabId)).toEqual([])

    first.close()
    await Bun.sleep(300)
    expect(fetches(extension, "Fetch.disable").filter((command) => command.params?.tabId === tabId)).toEqual([])

    second.close()
    const released = () => fetches(extension, "Fetch.disable").filter((command) => command.params?.tabId === tabId)
    expect(await until(() => released().some((command) => command.params?.sessionId === undefined), 5_000)).toBe(true)
  } finally {
    first.close()
    second.close()
    extension.close()
  }
}, 20_000)

test("a single owner's Fetch.disable is forwarded and its disconnect adds no release", async () => {
  const tabId = 492
  const extension = attachedExtension(tabId)
  expect(await extension.pair({ attachedTabs: [tabId] })).toBe(true)
  await createSession("single")
  const socket = await openClient("single")
  const events = collect(socket)
  try {
    const rootSession = await attachTab(socket, events, `TARGET-${tabId}`)
    expect((await cdpCall(socket, 2, "Fetch.enable", { patterns: fetchPatterns }, rootSession)).error).toBeUndefined()
    expect(await until(() => fetches(extension, "Fetch.enable").some((command) => command.params?.tabId === tabId))).toBe(true)

    expect((await cdpCall(socket, 3, "Fetch.disable", {}, rootSession)).error).toBeUndefined()
    const disables = () => fetches(extension, "Fetch.disable").filter((command) => command.params?.tabId === tabId)
    expect(await until(() => disables().some((command) => command.params?.sessionId === undefined))).toBe(true)
    const forwarded = disables().length

    socket.close()
    await Bun.sleep(300)
    expect(disables()).toHaveLength(forwarded)
  } finally {
    socket.close()
    extension.close()
  }
}, 20_000)

test("a client that never enabled Fetch sends no Fetch.disable", async () => {
  const tabId = 461
  const extension = attachedExtension(tabId)
  expect(await extension.pair({ attachedTabs: [tabId] })).toBe(true)
  await createSession("no-fetch")
  const socket = await openClient("no-fetch")
  const events = collect(socket)
  try {
    await attachTab(socket, events, `TARGET-${tabId}`)
    socket.close()
    await Bun.sleep(300)
    expect(fetches(extension, "Fetch.disable").filter((command) => command.params?.tabId === tabId)).toEqual([])
  } finally {
    socket.close()
    extension.close()
  }
}, 20_000)

test("relay shutdown releases Fetch before the extension link closes", async () => {
  const shutdownHome = fs.mkdtempSync(path.join(temporaryRoot, "browse-fetch-shutdown-"))
  const started = await startRelay(shutdownHome, { OPENCODE_BROWSER_MANAGED_RELAY: "1", OPENCODE_BROWSER_STORE_ID: "b".repeat(32) })
  const shutdownRelay = started.child
  const tabId = 421
  const extension = new FakeExtension(shutdownHome, started.port)
    .on("tabs.create", () => ({ tabId }))
    .on("Target.getTargetInfo", () => ({ targetInfo: targetInfo("TARGET-421", "https://example.com/") }))
  let socket: WebSocket | undefined
  try {
    expect(await extension.pair()).toBe(true)
    // A sandbox client doesn't block an explicit restart (a raw CDP client would).
    const connected = await connectCdp(
      `ws://127.0.0.1:${started.port}/devtools/browser/test?opencodeBrowserSessionId=shutdown-a`,
      { authorization: `Bearer ${started.token}`, "opencode-browser-client-kind": "sandbox" },
    )
    if (!(connected instanceof WebSocket)) throw new Error(`CDP connection refused: ${connected}`)
    socket = connected
    const events = collect(socket)
    expect((await cdpCall(socket, 1, "Target.createTarget", { url: "https://example.com/" })).result?.targetId).toBe("TARGET-421")
    expect(await until(() => announcedSession(events, "TARGET-421") !== undefined)).toBe(true)
    const rootSession = announcedSession(events, "TARGET-421")!
    expect((await cdpCall(socket, 2, "Fetch.enable", { patterns: fetchPatterns }, rootSession)).error).toBeUndefined()
    expect(await until(() => fetches(extension, "Fetch.enable").some((command) => command.params?.tabId === tabId))).toBe(true)

    const version = await (await fetch(`http://127.0.0.1:${started.port}/version`)).json() as { instanceId: string }
    const shutdown = await fetch(`http://127.0.0.1:${started.port}/shutdown`, {
      method: "POST",
      headers: { authorization: `Bearer ${started.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        instanceId: version.instanceId,
        requestId: crypto.randomUUID(),
        reason: "explicit-restart",
        client: { kind: "cli", instanceId: "fetch-release-test", buildId: "test" },
      }),
    })
    expect(shutdown.status).toBe(200)

    // The client socket is still open, so this exercises cleanup's shutdown release rather than a client disconnect.
    expect(await until(() => fetches(extension, "Fetch.disable").some((command) => command.params?.tabId === tabId), 5_000)).toBe(true)
  } finally {
    socket?.close()
    extension.close()
    await stopRelay(shutdownRelay)
    fs.rmSync(shutdownHome, { recursive: true, force: true })
  }
}, 20_000)

test("deleting an adopted tab's session still releases when a read-only session is watching", async () => {
  const tabId = 471
  const extension = attachedExtension(tabId)
  expect(await extension.pair({ attachedTabs: [tabId] })).toBe(true)
  await createSession("deleter")
  await createSession("watcher", true)
  const adopted = await api("/cli/session/adopt", { sessionId: "deleter", createIfMissing: false, tabId })
  if (!adopted.ok) throw new Error(await adopted.text())

  const owner = await openClient("deleter")
  const watcher = await openClient("watcher")
  const ownerEvents = collect(owner)
  const watcherEvents = collect(watcher)
  try {
    const ownerRoot = await attachTab(owner, ownerEvents, `TARGET-${tabId}`)
    expect((await cdpCall(owner, 2, "Fetch.enable", { patterns: fetchPatterns }, ownerRoot)).error).toBeUndefined()
    expect(await until(() => fetches(extension, "Fetch.enable").some((command) => command.params?.tabId === tabId))).toBe(true)

    // Session delete releases its ownership and re-announces the now-unowned tab to the read-only session.
    const deleted = await api("/cli/session/delete", { id: "deleter" })
    if (!deleted.ok) throw new Error(await deleted.text())
    expect(await deleted.json()).toMatchObject({ deleted: true, id: "deleter" })
    expect(await until(() => announcedSession(watcherEvents, `TARGET-${tabId}`) !== undefined)).toBe(true)

    // The owner's socket is what release is keyed to. The harness has no sandbox connection of its own, so this
    // client stands in for it and closes here; the read-only watcher must not keep the tab's Fetch interception on.
    owner.close()
    const released = () => fetches(extension, "Fetch.disable").filter((command) => command.params?.tabId === tabId)
    expect(await until(() => released().some((command) => command.params?.sessionId === undefined), 5_000)).toBe(true)
    expect(watcher.readyState).toBe(WebSocket.OPEN)
  } finally {
    owner.close()
    watcher.close()
    extension.close()
  }
}, 20_000)

test("closing one client releases only its tab, not one another client still owns", async () => {
  let nextTabId = 411
  const extension = new FakeExtension(home, port)
    .on("tabs.create", () => ({ tabId: nextTabId++ }))
    .on("Target.getTargetInfo", (command) => {
      const tabId = Number(command.params?.tabId)
      return { targetInfo: targetInfo(`TARGET-${tabId}`, `https://example.com/${tabId}`) }
    })
  expect(await extension.pair()).toBe(true)
  const first = await openClient("fetch-release-b1")
  const second = await openClient("fetch-release-b2")
  const firstEvents = collect(first)
  const secondEvents = collect(second)
  try {
    expect((await cdpCall(first, 1, "Target.createTarget", { url: "https://example.com/411" })).result?.targetId).toBe("TARGET-411")
    expect((await cdpCall(second, 1, "Target.createTarget", { url: "https://example.com/412" })).result?.targetId).toBe("TARGET-412")
    expect(await until(() => announcedSession(firstEvents, "TARGET-411") !== undefined)).toBe(true)
    expect(await until(() => announcedSession(secondEvents, "TARGET-412") !== undefined)).toBe(true)
    const firstSession = announcedSession(firstEvents, "TARGET-411")!
    const secondSession = announcedSession(secondEvents, "TARGET-412")!

    expect((await cdpCall(first, 2, "Fetch.enable", { patterns: fetchPatterns }, firstSession)).error).toBeUndefined()
    expect((await cdpCall(second, 2, "Fetch.enable", { patterns: fetchPatterns }, secondSession)).error).toBeUndefined()
    expect(await until(() => fetches(extension, "Fetch.enable").some((command) => command.params?.tabId === 411))).toBe(true)
    expect(await until(() => fetches(extension, "Fetch.enable").some((command) => command.params?.tabId === 412))).toBe(true)

    first.close()

    const disables = () => fetches(extension, "Fetch.disable")
    expect(await until(() => disables().some((command) => command.params?.tabId === 411 && command.params?.sessionId === undefined), 5_000)).toBe(true)
    await Bun.sleep(300)
    expect(disables().some((command) => command.params?.tabId === 412)).toBe(false)

    second.close()
    expect(await until(() => disables().some((command) => command.params?.tabId === 412 && command.params?.sessionId === undefined), 5_000)).toBe(true)
  } finally {
    first.close()
    second.close()
    extension.close()
  }
}, 20_000)
