import { afterAll, beforeAll, expect, test } from "bun:test"
import type { ChildProcess } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import WebSocket from "ws"
import { cdpCall, collect, connectCdp, FakeExtension, startRelay, stopRelay, until } from "./relay-harness.ts"

// A tab Chrome closed without the extension saying so (#153): Chrome answers "No tab with given id" for it. The relay
// drops the target the way a reported close does, so a client's page closes instead of hanging, and no later session
// is handed a page that no longer exists.

const home = fs.mkdtempSync(path.join(os.tmpdir(), "browse-missing-tab-"))
let port = 0
let relay: ChildProcess | undefined
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

/** A paired extension whose agent tab `tabId` can vanish, and a session's CDP client attached to it. */
async function scene(session: string, tabId: number) {
  const targetId = `TARGET-${tabId}`
  const state = { gone: false }
  const missing = () => {
    throw new Error(`No tab with given id ${tabId}.`)
  }
  const extension = new FakeExtension(home, port)
    .on("tabs.create", () => ({ tabId }))
    .on("Target.getTargetInfo", () => state.gone ? missing() : { targetInfo: { targetId, type: "page", title: "Example", url: "https://example.com/", attached: true, browserContextId: "CTX" } })
    .on("tabs.remove", () => {
      if (state.gone) throw new Error(`No tab with id: ${tabId}.`)
    })
  expect(await extension.pair()).toBe(true)
  const socket = await connectCdp(`ws://127.0.0.1:${port}/devtools/browser/test?opencodeBrowserSessionId=${session}`, { authorization: `Bearer ${token}` })
  if (!(socket instanceof WebSocket)) throw new Error("CDP connection refused")
  const events = collect(socket)
  await cdpCall(socket, 1, "Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })
  expect((await cdpCall(socket, 2, "Target.createTarget", { url: "about:blank" })).result?.targetId).toBe(targetId)
  const attached = events.find((event) => event.method === "Target.attachedToTarget" && (event.params?.targetInfo as { targetId?: string } | undefined)?.targetId === targetId)
  const sessionId = String(attached?.params?.sessionId)
  const listed = async () => ((await cdpCall(socket, 900 + events.length, "Target.getTargets")).result?.targetInfos as Array<{ targetId: string }>).some((info) => info.targetId === targetId)
  const detached = () => events.some((event) => event.method === "Target.detachedFromTarget" && event.params?.sessionId === sessionId)
  return { extension, socket, state, missing, targetId, sessionId, listed, detached }
}

test("a command that finds its tab gone drops the target, closes the page and fails what still waits on it", async () => {
  const { extension, socket, state, missing, sessionId, listed, detached } = await scene("missing-tab", 91)
  try {
    expect(await listed()).toBe(true)
    // One command hangs on the tab (as a page that never answers does) while the next finds it gone.
    extension.on("DOM.getDocument", () => new Promise(() => {}))
    extension.on("Page.getLayoutMetrics", () => missing())
    const pending = cdpCall(socket, 10, "DOM.getDocument", {}, sessionId)
    expect(await until(() => extension.commands.some((command) => command.params?.method === "DOM.getDocument"))).toBe(true)
    state.gone = true
    expect((await cdpCall(socket, 11, "Page.getLayoutMetrics", {}, sessionId)).error?.message).toContain("No tab with given id 91")
    expect(await until(detached)).toBe(true)
    expect(await listed()).toBe(false)
    expect((await pending).error?.message).toContain("Target closed")
  } finally {
    socket.close()
    extension.close()
  }
}, 20_000)

test("an error that isn't about the tab keeps the target", async () => {
  const { extension, socket, sessionId, listed, detached } = await scene("other-error", 92)
  try {
    extension.on("Page.getLayoutMetrics", () => {
      throw new Error("Cannot find context with specified id")
    })
    expect((await cdpCall(socket, 10, "Page.getLayoutMetrics", {}, sessionId)).error?.message).toContain("Cannot find context")
    await Bun.sleep(100)
    expect(detached()).toBe(false)
    expect(await listed()).toBe(true)
  } finally {
    socket.close()
    extension.close()
  }
}, 20_000)

test("closing a page whose tab is already gone succeeds and closes it", async () => {
  const { extension, socket, state, targetId, listed, detached } = await scene("close-gone", 93)
  try {
    state.gone = true
    expect((await cdpCall(socket, 10, "Target.closeTarget", { targetId })).result?.success).toBe(true)
    expect(await until(detached)).toBe(true)
    expect(await listed()).toBe(false)
  } finally {
    socket.close()
    extension.close()
  }
}, 20_000)
