import { afterAll, beforeAll, expect, test } from "bun:test"
import type { ChildProcess } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import WebSocket from "ws"
import { cdpCall, connectCdp, FakeExtension, startRelay, stopRelay, until } from "./relay-harness.ts"

// A popup whose first navigation commits while it is being registered: Chrome reports no URL at attach, the commit's
// Page.frameNavigated is dropped (the tab is not registered yet), and the stored URL stays "". The guard re-queries
// Chrome once the tab is registered, so its decision still uses the real URL.

const home = fs.mkdtempSync(path.join(os.tmpdir(), "browse-allowlist-popup-"))
let port = 0
let relay: ChildProcess | undefined
let base = ""
let token = ""

beforeAll(async () => {
  const started = await startRelay(home, { OPENCODE_BROWSER_STORE_ID: "b".repeat(32) })
  relay = started.child
  port = started.port
  base = `http://127.0.0.1:${port}`
  token = started.token
}, 20_000)

afterAll(async () => {
  await stopRelay(relay)
  fs.rmSync(home, { recursive: true, force: true })
})

const api = (pathname: string, body: unknown) => fetch(`${base}${pathname}`, {
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify(body),
})

async function allowlistedSession(id: string) {
  const response = await api("/cli/session/new", { id, allowedOrigins: ["https://127.0.0.1:8443"] })
  expect(response.status).toBe(200)
  return id
}

const targetInfo = (targetId: string, url: string) => ({ targetId, type: "page", title: url, url, attached: true, browserContextId: "CTX" })

async function getTargets(socket: WebSocket, id: number) {
  const result = await cdpCall(socket, id, "Target.getTargets")
  return (result.result?.targetInfos ?? []) as Array<{ targetId: string; url: string }>
}

/** The relay's own line for a tab's violation; `popup=true` means it closed the popup. */
function violationLog(tabId: number) {
  return fs.readFileSync(path.join(home, "logs/relay.log"), "utf8")
    .split("\n")
    .find((line) => line.includes("allowlist.violation") && line.includes(`tabId=${tabId}`))
}

/**
 * An allowlisted session with a registered opener tab, plus a popup that reports no URL until it is registered. The
 * live URL is what Chrome answers to the guard's post-registration re-query.
 */
async function popupScene(options: {
  readonly id: string
  readonly openerTabId: number
  readonly popupTabId: number
  readonly liveUrl: string
}) {
  const openerTargetId = `TARGET-${options.openerTabId}`
  const popupTargetId = `TARGET-${options.popupTabId}`
  const state = {
    registered: false,
    popupQueries: [] as string[],
    removed: false,
  }
  const extension = new FakeExtension(home, port)
    .on("tabs.create", () => ({ tabId: options.openerTabId }))
    .on("Target.getTargetInfo", (command) => {
      const tabId = Number(command.params?.tabId)
      if (tabId !== options.popupTabId) return { targetInfo: targetInfo(openerTargetId, "https://127.0.0.1:8443/start") }
      // Before action.setAttached the tab is still being staged: Chrome has no URL for the popup yet.
      const url = state.registered ? options.liveUrl : ""
      state.popupQueries.push(url)
      return { targetInfo: targetInfo(popupTargetId, url) }
    })
    .on("action.setAttached", (command) => {
      if (Number(command.params?.tabId) === options.popupTabId) state.registered = true
      return {}
    })
    .on("tabs.remove", (command) => {
      if (Number(command.params?.tabId) === options.popupTabId) state.removed = true
      return {}
    })
  expect(await extension.pair()).toBe(true)
  const sessionId = await allowlistedSession(options.id)
  const socket = await connectCdp(`ws://127.0.0.1:${port}/devtools/browser/test?opencodeBrowserSessionId=${sessionId}`, { authorization: `Bearer ${token}` })
  if (!(socket instanceof WebSocket)) throw new Error(`CDP connection refused: ${socket}`)

  // Register the opener as a relay tab of this session, then report the tab its page opened.
  const created = await cdpCall(socket, 1, "Target.createTarget", { url: "https://127.0.0.1:8443/start" })
  expect(created.error).toBeUndefined()
  expect(created.result?.targetId).toBe(openerTargetId)

  return {
    extension,
    socket,
    state,
    popupTargetId,
    open() {
      extension.emit("tabs.opened", { tabId: options.popupTabId, openerTabId: options.openerTabId })
    },
    close() {
      socket.close()
      extension.close()
    },
  }
}

test("an off-list URL found by the post-attach re-query closes the popup", async () => {
  const scene = await popupScene({ id: "popup-empty-off-list", openerTabId: 301, popupTabId: 302, liveUrl: "https://evil.test/" })
  try {
    scene.open()
    expect(await until(() => scene.state.removed)).toBe(true)
    // The attach saw no URL twice; the guard's third query got the committed one.
    expect(scene.state.popupQueries).toEqual(["", "", "https://evil.test/"])
    expect(violationLog(302)).toContain("popup=true")
    expect(violationLog(302)).toContain("url=https://evil.test/")
    expect((await getTargets(scene.socket, 2)).some((target) => target.targetId === scene.popupTargetId)).toBe(false)
  } finally {
    scene.close()
  }
}, 20_000)

test("an allowed URL found by the post-attach re-query keeps the popup", async () => {
  const liveUrl = "https://127.0.0.1:8443/app"
  const scene = await popupScene({ id: "popup-empty-allowed", openerTabId: 311, popupTabId: 312, liveUrl })
  try {
    scene.open()
    expect(await until(() => scene.state.popupQueries.length >= 3)).toBe(true)
    await Bun.sleep(50)
    expect(scene.state.removed).toBe(false)
    expect(scene.state.popupQueries).toEqual(["", "", liveUrl])
    // The registry carries the URL the guard judged, not the empty one reported at attach.
    const targets = await getTargets(scene.socket, 2)
    expect(targets.find((target) => target.targetId === scene.popupTargetId)?.url).toBe(liveUrl)
    expect(violationLog(312)).toBeUndefined()
  } finally {
    scene.close()
  }
}, 20_000)
