import { afterAll, beforeAll, expect, test } from "bun:test"
import type { ChildProcess } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import WebSocket from "ws"
import { cdpCall, collect, connectCdp, FakeExtension, startRelay, stopRelay, until } from "./relay-harness.ts"

// A popup an allowlisted session's page opens attaches before its first navigation commits, so the relay sees no URL
// yet (or the initial about:blank). That is not a violation: the popup stays fresh and its first real document is
// checked, while navigations after an allowed first document are blanked like any other tab.

const home = fs.mkdtempSync(path.join(os.tmpdir(), "browse-allowlist-popup-"))
let port = 0
let relay: ChildProcess | undefined
let base = ""
let token = ""

const allowed = "https://127.0.0.1:8443"

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

const targetInfo = (tabId: number, url: string) => ({ targetId: `TARGET-${tabId}`, type: "page", title: url, url, attached: true, browserContextId: "CTX" })

/** A paired fake extension and a CDP client for one allowlisted session, with per-tab URLs and recorded commands. */
async function createScene(id: string, openerTabId: number) {
  const urls = new Map<number, string>()
  const navigations: Array<{ readonly tabId: number; readonly url: string }> = []
  const removed: number[] = []
  const extension = new FakeExtension(home, port)
    .on("tabs.create", () => ({ tabId: openerTabId }))
    .on("Target.getTargetInfo", (command) => {
      const tabId = Number(command.params?.tabId)
      return { targetInfo: targetInfo(tabId, urls.get(tabId) ?? "") }
    })
    .on("Page.navigate", (command) => {
      const tabId = Number(command.params?.tabId)
      const url = String((command.params?.params as { url?: string } | undefined)?.url)
      navigations.push({ tabId, url })
      urls.set(tabId, url)
      return { frameId: `TARGET-${tabId}`, loaderId: `L-${navigations.length}` }
    })
    .on("Page.stopLoading", () => ({}))
    .on("tabs.remove", (command) => {
      removed.push(Number(command.params?.tabId))
      return {}
    })
  expect(await extension.pair()).toBe(true)
  const response = await api("/cli/session/new", { id, allowedOrigins: [allowed] })
  expect(response.status).toBe(200)
  const socket = await connectCdp(`ws://127.0.0.1:${port}/devtools/browser/test?opencodeBrowserSessionId=${id}`, { authorization: `Bearer ${token}` })
  if (!(socket instanceof WebSocket)) throw new Error(`CDP connection refused: ${socket}`)
  expect((await cdpCall(socket, 1, "Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })).error).toBeUndefined()
  let calls = 2
  return {
    extension,
    socket,
    urls,
    navigations,
    removed,
    /** Opens the opener tab the popups come from. */
    async openOpener() {
      const created = await cdpCall(socket, calls++, "Target.createTarget", { url: `${allowed}/start` })
      expect(created.result?.targetId).toBe(`TARGET-${openerTabId}`)
    },
    /** The URL the relay publishes for a tab. */
    async publishedUrl(tabId: number) {
      const targets = (await cdpCall(socket, calls++, "Target.getTargets")).result?.targetInfos as Array<{ targetId: string; url: string }> | undefined
      return targets?.find((target) => target.targetId === `TARGET-${tabId}`)?.url
    },
    emitFrameNavigated(tabId: number, url: string, loaderId: string) {
      urls.set(tabId, url)
      extension.emit("debugger.event", { tabId, method: "Page.frameNavigated", params: { frame: { id: `TARGET-${tabId}`, loaderId, url } } })
    },
    close() {
      socket.close()
      extension.close()
    },
  }
}

/** The relay's own line for a tab's violation; `popup=true` means it closed the popup instead of blanking it. */
function violationLog(tabId: number) {
  const log = path.join(home, "logs/relay.log")
  if (!fs.existsSync(log)) return undefined
  return fs.readFileSync(log, "utf8")
    .split("\n")
    .find((line) => line.includes("allowlist.violation") && line.includes(`tabId=${tabId}`))
}

test.each([["no URL yet", ""], ["the initial about:blank", "about:blank"]])("a popup attached with %s is not a violation", async (_label, attachUrl) => {
  const tabId = attachUrl === "" ? 302 : 303
  const scene = await createScene(`guarded-popup-${tabId}`, 301)
  try {
    const events = collect(scene.socket)
    await scene.openOpener()
    scene.urls.set(tabId, attachUrl)
    scene.extension.emit("tabs.opened", { tabId, openerTabId: 301 })
    const announced = () => events.some((event) => event.method === "Target.attachedToTarget" && (event.params?.targetInfo as { targetId?: string } | undefined)?.targetId === `TARGET-${tabId}`)
    expect(await until(announced)).toBe(true)
    await Bun.sleep(200)
    expect(scene.removed).not.toContain(tabId)
    expect(violationLog(tabId)).toBeUndefined()

    scene.emitFrameNavigated(tabId, `${allowed}/landed`, "OK-1")
    await Bun.sleep(150)
    expect(await scene.publishedUrl(tabId)).toBe(`${allowed}/landed`)
    expect(scene.removed).not.toContain(tabId)
    expect(violationLog(tabId)).toBeUndefined()
  } finally {
    scene.close()
  }
}, 20_000)

test.each([["no URL yet", ""], ["the initial about:blank", "about:blank"]])("a popup attached with %s whose first navigation is disallowed is still closed", async (_label, attachUrl) => {
  const tabId = attachUrl === "" ? 312 : 313
  const scene = await createScene(`guarded-popup-first-${tabId}`, 311)
  try {
    const events = collect(scene.socket)
    await scene.openOpener()
    scene.urls.set(tabId, attachUrl)
    scene.extension.emit("tabs.opened", { tabId, openerTabId: 311 })
    const announced = () => events.some((event) => event.method === "Target.attachedToTarget" && (event.params?.targetInfo as { targetId?: string } | undefined)?.targetId === `TARGET-${tabId}`)
    expect(await until(announced)).toBe(true)
    scene.emitFrameNavigated(tabId, "https://evil.test/", "EVIL-1")
    expect(await until(() => scene.removed.includes(tabId))).toBe(true)
    expect(violationLog(tabId)).toContain("popup=true")
  } finally {
    scene.close()
  }
}, 20_000)

test("a navigation out of the allowlist after an allowed first document is blanked, not closed", async () => {
  const scene = await createScene("guarded-popup-later", 321)
  try {
    const events = collect(scene.socket)
    await scene.openOpener()
    scene.extension.emit("tabs.opened", { tabId: 322, openerTabId: 321 })
    const announced = () => events.some((event) => event.method === "Target.attachedToTarget" && (event.params?.targetInfo as { targetId?: string } | undefined)?.targetId === "TARGET-322")
    expect(await until(announced)).toBe(true)
    scene.emitFrameNavigated(322, `${allowed}/landed`, "OK-1")
    await Bun.sleep(150)
    expect(await scene.publishedUrl(322)).toBe(`${allowed}/landed`)
    scene.emitFrameNavigated(322, "https://evil.test/", "EVIL-1")
    expect(await until(() => scene.navigations.some((navigation) => navigation.tabId === 322 && navigation.url === "about:blank"))).toBe(true)
    expect(scene.removed).not.toContain(322)
    expect(violationLog(322)).toContain("popup=false")
  } finally {
    scene.close()
  }
}, 20_000)
