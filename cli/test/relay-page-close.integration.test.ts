import { afterAll, beforeAll, expect, test } from "bun:test"
import type { ChildProcess } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import WebSocket from "ws"
import { cdpCall, collect, connectCdp, FakeExtension, startRelay, stopRelay, until } from "./relay-harness.ts"

// Playwright sends Page.close for page.close({ runBeforeUnload: true }), and context.newCDPSession can send it too.
// Forwarded to chrome.debugger it would close the tab directly, bypassing the ownership checks Target.closeTarget
// applies: a tab the user lent could close, or the browser's last tab. It closes the page's target the same way.

const temporaryRoot = path.join(os.homedir(), ".cache", "oc-tmp")
fs.mkdirSync(temporaryRoot, { recursive: true })
// The harness gives the relay its own HOME/OPENCODE_BROWSER_HOME and a free port (never 19988).
const home = fs.mkdtempSync(path.join(temporaryRoot, "browse-page-close-"))
let relay: ChildProcess | undefined
let port = 0
let token = ""

beforeAll(async () => {
  const started = await startRelay(home, { OPENCODE_BROWSER_STORE_ID: "c".repeat(32) })
  relay = started.child
  port = started.port
  token = started.token
}, 20_000)

afterAll(async () => {
  await stopRelay(relay)
  fs.rmSync(home, { recursive: true, force: true })
})

const info = (tabId: number) => ({
  targetId: `TARGET-${tabId}`,
  type: "page",
  title: "Example",
  url: `https://example.com/${tabId}`,
  attached: true,
  browserContextId: "CTX",
})

async function openClient(session: string) {
  const socket = await connectCdp(
    `ws://127.0.0.1:${port}/devtools/browser/test?opencodeBrowserSessionId=${session}`,
    { authorization: `Bearer ${token}` },
  )
  if (!(socket instanceof WebSocket)) throw new Error("CDP connection refused")
  return socket
}

const attachedSession = (
  events: ReturnType<typeof collect>,
  targetId: string,
) => String(events.find((event) =>
  event.method === "Target.attachedToTarget" &&
  (event.params?.targetInfo as { targetId?: string } | undefined)?.targetId === targetId,
)?.params?.sessionId)

test("Page.close on a tab the user lent releases it instead of closing it", async () => {
  const tabId = 91
  const extension = new FakeExtension(home, port)
    .on("Target.getTargetInfo", () => ({ targetInfo: info(tabId) }))
    .on("tabs.remove", () => {
      throw new Error(`Page.close must not close the user's tab ${tabId}`)
    })
  expect(await extension.pair({ attachedTabs: [tabId] })).toBe(true)
  // The relay attached the lent tab as the user's.
  expect(await until(() => extension.commands.some((command) =>
    command.params?.tabId === tabId && command.params?.method === "Page.enable",
  ))).toBe(true)
  const socket = await openClient("lent")
  try {
    const events = collect(socket)
    await cdpCall(socket, 1, "Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })
    const sessionId = attachedSession(events, `TARGET-${tabId}`)
    expect((await cdpCall(socket, 2, "Page.close", {}, sessionId)).result).toEqual({})
    // Released, not closed: the debugger detaches and no tabs.remove is sent.
    expect(await until(() => extension.commands.some((command) =>
      command.method === "debugger.detach" && command.params?.tabId === tabId,
    ))).toBe(true)
    expect(extension.commands.some((command) => command.method === "tabs.remove" && command.params?.tabId === tabId)).toBe(false)
    expect(extension.commands.some((command) =>
      command.method === "debugger.sendCommand" && command.params?.method === "Page.close",
    )).toBe(false)
    expect((await cdpCall(socket, 3, "Target.getTargets")).result?.targetInfos).not.toContainEqual(
      expect.objectContaining({ targetId: `TARGET-${tabId}` }),
    )
  } finally {
    socket.close()
    extension.close()
  }
}, 20_000)

test("Page.close on an agent tab closes it the way Target.closeTarget does", async () => {
  const tabId = 92
  const extension = new FakeExtension(home, port)
    .on("tabs.create", () => ({ tabId }))
    .on("Target.getTargetInfo", () => ({ targetInfo: info(tabId) }))
  expect(await extension.pair()).toBe(true)
  const socket = await openClient("agent-page")
  try {
    const events = collect(socket)
    await cdpCall(socket, 1, "Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })
    expect((await cdpCall(socket, 2, "Target.createTarget", { url: "https://example.com/" })).result?.targetId).toBe(`TARGET-${tabId}`)
    const sessionId = attachedSession(events, `TARGET-${tabId}`)
    expect((await cdpCall(socket, 3, "Page.close", {}, sessionId)).result).toEqual({})
    expect(extension.commands.some((command) => command.method === "tabs.remove" && command.params?.tabId === tabId)).toBe(true)
    expect(extension.commands.some((command) =>
      command.method === "debugger.sendCommand" && command.params?.method === "Page.close",
    )).toBe(false)
    expect(await until(() => events.some((event) => event.method === "Target.detachedFromTarget"))).toBe(true)
  } finally {
    socket.close()
    extension.close()
  }
}, 20_000)
