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

async function createSession(id: string, allowedOrigins?: readonly string[]) {
  const response = await api("/cli/session/new", { id, ...(allowedOrigins ? { allowedOrigins } : {}) })
  expect(response.status).toBe(200)
  return id
}

const targetInfo = (targetId: string, url: string) => ({ targetId, type: "page", title: url, url, attached: true, browserContextId: "CTX" })

type ListedTarget = { targetId: string; url: string; openerId?: string }

async function getTargets(socket: WebSocket, id: number) {
  const result = await cdpCall(socket, id, "Target.getTargets")
  return (result.result?.targetInfos ?? []) as ListedTarget[]
}

/** The relay's own line for an event about a tab. */
function logLine(event: string, tabId: number) {
  return fs.readFileSync(path.join(home, "logs/relay.log"), "utf8")
    .split("\n")
    .find((line) => line.includes(event) && line.includes(`tabId=${tabId}`))
}

/**
 * A session with a registered opener tab, plus a popup that reports no URL until it is registered. The live URL is
 * what Chrome answers to the guard's post-registration re-query. Without `allowedOrigins` the session has no allowlist,
 * and the guard must not ask Chrome at all.
 */
async function popupScene(options: {
  readonly id: string
  readonly openerTabId: number
  readonly popupTabId: number
  readonly liveUrl: string
  readonly allowedOrigins?: readonly string[]
  readonly recheckFails?: boolean
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
      if (state.registered && options.recheckFails) throw new Error(`No tab with id: ${options.popupTabId}.`)
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
  const sessionId = await createSession(options.id, options.allowedOrigins)
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

/** Wait until the relay lists the target at this URL (a positive signal that the registry update landed). */
async function waitForTarget(socket: WebSocket, targetId: string, url: string, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const target = (await getTargets(socket, 2)).find((entry) => entry.targetId === targetId)
    if (target?.url === url) return target
    await Bun.sleep(20)
  }
  return undefined
}

const allowedOrigins = ["https://127.0.0.1:8443"]

test("an off-list URL found by the post-attach re-query closes the popup", async () => {
  const scene = await popupScene({ id: "popup-empty-off-list", openerTabId: 301, popupTabId: 302, liveUrl: "https://evil.test/", allowedOrigins })
  try {
    scene.open()
    expect(await until(() => scene.state.removed)).toBe(true)
    // The attach saw no URL twice; the guard's third query got the committed one.
    expect(scene.state.popupQueries).toEqual(["", "", "https://evil.test/"])
    expect(logLine("allowlist.violation", 302)).toContain("popup=true")
    expect(logLine("allowlist.violation", 302)).toContain("url=https://evil.test/")
    expect((await getTargets(scene.socket, 2)).some((target) => target.targetId === scene.popupTargetId)).toBe(false)
  } finally {
    scene.close()
  }
}, 20_000)

test("an allowed URL found by the post-attach re-query keeps the popup and its opener", async () => {
  const liveUrl = "https://127.0.0.1:8443/app"
  const scene = await popupScene({ id: "popup-empty-allowed", openerTabId: 311, popupTabId: 312, liveUrl, allowedOrigins })
  try {
    scene.open()
    // The registry carries the URL the guard judged, not the empty one reported at attach.
    const target = await waitForTarget(scene.socket, scene.popupTargetId, liveUrl)
    expect(target?.url).toBe(liveUrl)
    expect(target?.openerId).toBe("TARGET-311")
    expect(scene.state.removed).toBe(false)
    expect(scene.state.popupQueries).toEqual(["", "", liveUrl])
    expect(logLine("allowlist.violation", 312)).toBeUndefined()
  } finally {
    scene.close()
  }
}, 20_000)

test("a popup whose re-query fails is closed instead of left unchecked", async () => {
  const scene = await popupScene({ id: "popup-empty-recheck-fails", openerTabId: 321, popupTabId: 322, liveUrl: "https://127.0.0.1:8443/app", allowedOrigins, recheckFails: true })
  try {
    scene.open()
    expect(await until(() => scene.state.removed)).toBe(true)
    expect(scene.state.popupQueries).toEqual(["", "", "https://127.0.0.1:8443/app"])
    expect(logLine("allowlist.close-unverified", 322)).toContain("No tab with id: 322.")
    expect((await getTargets(scene.socket, 2)).some((target) => target.targetId === scene.popupTargetId)).toBe(false)
  } finally {
    scene.close()
  }
}, 20_000)

test("a session without an allowlist never re-queries or closes the popup", async () => {
  const scene = await popupScene({ id: "popup-no-allowlist", openerTabId: 331, popupTabId: 332, liveUrl: "https://127.0.0.1:8443/app" })
  try {
    scene.open()
    const target = await waitForTarget(scene.socket, scene.popupTargetId, "")
    expect(target?.targetId).toBe(scene.popupTargetId)
    expect(scene.state.popupQueries).toEqual(["", ""])
    expect(scene.state.removed).toBe(false)
  } finally {
    scene.close()
  }
}, 20_000)
