import { afterAll, beforeAll, expect, test } from "bun:test"
import type { ChildProcess } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import WebSocket from "ws"
import { cdpCall, connectCdp, FakeExtension, startRelay, stopRelay, until } from "./relay-harness.ts"

// A popup whose first navigation commits before it is staged: Chrome reports no URL to the staging query and the
// commit's Page.frameNavigated is dropped (no routing target yet). Events reach the guard from stageRootTarget on, so
// attach's second Target.getTargetInfo refreshes the staged URL before the popup is published and judged.

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
 * A session with a registered opener tab, plus a popup whose staging query reports no URL. The live URL is what
 * Chrome answers to the attach's second query, once the popup has committed its first navigation. Without
 * `allowedOrigins` the session has no allowlist.
 */
async function popupScene(options: {
  readonly id: string
  readonly openerTabId: number
  readonly popupTabId: number
  readonly liveUrl: string
  readonly allowedOrigins?: readonly string[]
  /** Emit an off-list navigation start while the tab is staged, before the attach's second query answers. */
  readonly startDuringAttach?: string
}) {
  const openerTargetId = `TARGET-${options.openerTabId}`
  const popupTargetId = `TARGET-${options.popupTabId}`
  const state = {
    popupQueries: [] as string[],
    removed: false,
  }
  const extension = new FakeExtension(home, port)
    .on("tabs.create", () => ({ tabId: options.openerTabId }))
    .on("Target.getTargetInfo", (command) => {
      const tabId = Number(command.params?.tabId)
      if (tabId !== options.popupTabId) return { targetInfo: targetInfo(openerTargetId, "https://127.0.0.1:8443/start") }
      // The staging query sees no URL; the commit lands before the attach's second query answers.
      const url = state.popupQueries.length === 0 ? "" : options.liveUrl
      state.popupQueries.push(url)
      if (state.popupQueries.length === 2 && options.startDuringAttach) {
        extension.emit("debugger.event", {
          tabId: options.popupTabId,
          method: "Page.frameStartedNavigating",
          params: { frameId: popupTargetId, url: options.startDuringAttach },
        })
      }
      return { targetInfo: targetInfo(popupTargetId, url) }
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

test("an off-list URL found by the attach refresh closes the popup", async () => {
  const scene = await popupScene({ id: "popup-empty-off-list", openerTabId: 301, popupTabId: 302, liveUrl: "https://evil.test/", allowedOrigins })
  try {
    scene.open()
    expect(await until(() => scene.state.removed)).toBe(true)
    // Staging saw no URL; the attach's second query got the committed one.
    expect(scene.state.popupQueries).toEqual(["", "https://evil.test/"])
    expect(logLine("allowlist.violation", 302)).toContain("popup=true")
    expect(logLine("allowlist.violation", 302)).toContain("url=https://evil.test/")
    expect((await getTargets(scene.socket, 2)).some((target) => target.targetId === scene.popupTargetId)).toBe(false)
  } finally {
    scene.close()
  }
}, 20_000)

test("an allowed URL found by the attach refresh keeps the popup and its opener", async () => {
  const liveUrl = "https://127.0.0.1:8443/app"
  const scene = await popupScene({ id: "popup-empty-allowed", openerTabId: 311, popupTabId: 312, liveUrl, allowedOrigins })
  try {
    scene.open()
    // The registry carries the URL the guard judged, not the empty one reported at attach.
    const target = await waitForTarget(scene.socket, scene.popupTargetId, liveUrl)
    expect(target?.url).toBe(liveUrl)
    expect(target?.openerId).toBe("TARGET-311")
    expect(scene.state.removed).toBe(false)
    expect(scene.state.popupQueries).toEqual(["", liveUrl])
    expect(logLine("allowlist.violation", 312)).toBeUndefined()
  } finally {
    scene.close()
  }
}, 20_000)

test("an off-list navigation seen while the popup is staged closes it", async () => {
  const scene = await popupScene({
    id: "popup-start-during-attach",
    openerTabId: 321,
    popupTabId: 322,
    liveUrl: "https://127.0.0.1:8443/app",
    allowedOrigins,
    startDuringAttach: "https://evil.test/",
  })
  try {
    scene.open()
    expect(await until(() => scene.state.removed)).toBe(true)
    expect(scene.state.popupQueries).toEqual(["", "https://127.0.0.1:8443/app"])
    expect(logLine("allowlist.violation", 322)).toContain("popup=true")
    expect(logLine("allowlist.violation", 322)).toContain("url=https://evil.test/")
    expect((await getTargets(scene.socket, 2)).some((target) => target.targetId === scene.popupTargetId)).toBe(false)
  } finally {
    scene.close()
  }
}, 20_000)

test("a session without an allowlist keeps an empty-then-live popup open", async () => {
  const liveUrl = "https://127.0.0.1:8443/app"
  const scene = await popupScene({ id: "popup-no-allowlist", openerTabId: 331, popupTabId: 332, liveUrl })
  try {
    scene.open()
    const target = await waitForTarget(scene.socket, scene.popupTargetId, liveUrl)
    expect(target?.targetId).toBe(scene.popupTargetId)
    expect(scene.state.popupQueries).toEqual(["", liveUrl])
    expect(scene.state.removed).toBe(false)
  } finally {
    scene.close()
  }
}, 20_000)
