import { afterAll, beforeAll, expect, test } from "bun:test"
import type { ChildProcess } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import WebSocket from "ws"
import { cdpCall, collect, connectCdp, FakeExtension, startRelay, stopRelay, until } from "./relay-harness.ts"

// Target.createTarget for a session with a domain allowlist: the tab is created at about:blank, the debugger is
// attached there, and only then is the requested URL navigated to, so the allowlist observes the real load. A
// disallowed load is sent back to about:blank (the tab is not a popup); the URL actually committed is also checked
// and only published when it passes the guard.

const home = fs.mkdtempSync(path.join(os.tmpdir(), "browse-allowlist-create-"))
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

type NavigateOutcome = { readonly result?: Record<string, unknown>; readonly error?: Error; readonly url?: string; readonly delayMs?: number }

/** A paired fake extension and a CDP client for one allowlisted session, with a mutable tab URL. */
async function createScene(id: string, tabId: number, targetId: string) {
  const state = {
    current: "about:blank",
    navigations: [] as string[],
    documentContent: [] as unknown[],
    removed: false,
    onNavigate: undefined as ((url: string) => NavigateOutcome | undefined) | undefined,
    onTargetInfo: undefined as (() => { readonly url?: string; readonly error?: Error } | undefined) | undefined,
  }
  const extension = new FakeExtension(home, port)
    .on("tabs.create", () => ({ tabId }))
    .on("Target.getTargetInfo", () => {
      const override = state.onTargetInfo?.()
      if (override?.error) throw override.error
      return { targetInfo: targetInfo(targetId, override?.url ?? state.current) }
    })
    .on("Page.navigate", (command) => {
      const url = String((command.params?.params as { url?: string } | undefined)?.url)
      state.navigations.push(url)
      const outcome = state.onNavigate?.(url)
      if (outcome?.error) throw outcome.error
      if (outcome?.url !== undefined) state.current = outcome.url
      else state.current = url === "about:blank" ? "about:blank" : url
      const result = outcome?.result ?? { frameId: targetId, loaderId: `L-${state.navigations.length}` }
      return outcome?.delayMs === undefined ? result : Bun.sleep(outcome.delayMs).then(() => result)
    })
    .on("Page.setDocumentContent", (command) => {
      state.documentContent.push(command.params?.params)
      return {}
    })
    .on("tabs.remove", () => {
      state.removed = true
      return {}
    })
  expect(await extension.pair()).toBe(true)
  const sessionId = await allowlistedSession(id)
  const socket = await connectCdp(`ws://127.0.0.1:${port}/devtools/browser/test?opencodeBrowserSessionId=${sessionId}`, { authorization: `Bearer ${token}` })
  if (!(socket instanceof WebSocket)) throw new Error(`CDP connection refused: ${socket}`)
  return {
    extension,
    socket,
    state,
    close() {
      socket.close()
      extension.close()
    },
  }
}

async function getTargets(socket: WebSocket, id: number) {
  const result = await cdpCall(socket, id, "Target.getTargets")
  return (result.result?.targetInfos ?? []) as Array<{ targetId: string; url: string }>
}

/** The relay's own line for a tab's violation; `popup=false` means it blanked the tab instead of closing it. */
function violationLog(tabId: number) {
  return fs.readFileSync(path.join(home, "logs/relay.log"), "utf8")
    .split("\n")
    .find((line) => line.includes("allowlist.violation") && line.includes(`tabId=${tabId}`))
}

test("Target.createTarget in an allowlisted session creates at about:blank, attaches, then navigates", async () => {
  const scene = await createScene("guarded-create", 201, "TARGET-201")
  try {
    const events = collect(scene.socket)
    const created = await cdpCall(scene.socket, 1, "Target.createTarget", { url: "https://127.0.0.1:8443/start" })
    expect(created.error).toBeUndefined()
    expect(created.result?.targetId).toBe("TARGET-201")

    const methods = scene.extension.commands.map((command) => command.method === "debugger.sendCommand" ? command.params?.method : command.method)
    expect(scene.extension.commands.find((command) => command.method === "tabs.create")?.params?.url).toBe("about:blank")
    expect(methods.indexOf("debugger.attach")).toBeGreaterThan(methods.indexOf("tabs.create"))
    expect(methods.indexOf("Page.navigate")).toBeGreaterThan(methods.indexOf("debugger.attach"))
    expect(scene.state.navigations).toEqual(["https://127.0.0.1:8443/start"])

    // The created target is announced to the client, and its real URL is published right away.
    expect(events.some((event) => event.method === "Target.attachedToTarget" && (event.params?.targetInfo as { targetId?: string } | undefined)?.targetId === "TARGET-201")).toBe(true)
    expect((await getTargets(scene.socket, 2)).find((target) => target.targetId === "TARGET-201")?.url).toBe("https://127.0.0.1:8443/start")
  } finally {
    scene.close()
  }
}, 20_000)

test("Target.createTarget with a data: URL writes it into the attached about:blank tab", async () => {
  const scene = await createScene("guarded-data", 202, "TARGET-202")
  try {
    // The data helper waits for about:blank's loader to commit before writing the document.
    scene.state.onNavigate = (url) => {
      const loaderId = `L-${scene.state.navigations.length}`
      scene.extension.emit("debugger.event", { tabId: 202, method: "Page.frameNavigated", params: { frame: { id: "TARGET-202", loaderId, url } } })
      return { result: { frameId: "TARGET-202", loaderId } }
    }
    const created = await cdpCall(scene.socket, 1, "Target.createTarget", { url: "data:text/html,<h1>hi</h1>" })
    expect(created.error).toBeUndefined()
    expect(created.result?.targetId).toBe("TARGET-202")
    expect(scene.state.navigations).toEqual(["about:blank"])
    expect(scene.state.navigations.some((url) => url.startsWith("data:"))).toBe(false)
    expect(scene.state.documentContent).toHaveLength(1)
    expect(scene.state.documentContent[0]).toMatchObject({ frameId: "TARGET-202", html: expect.stringContaining("<h1>hi</h1>") })
    expect(scene.state.removed).toBe(false)
  } finally {
    scene.close()
  }
}, 20_000)

for (const [label, params] of [["empty", { url: "" }], ["missing", {}]] as const) {
  test(`Target.createTarget with a ${label} URL creates about:blank without navigating`, async () => {
    const tabId = label === "empty" ? 203 : 204
    const scene = await createScene(`guarded-${label}`, tabId, `TARGET-${tabId}`)
    try {
      const created = await cdpCall(scene.socket, 1, "Target.createTarget", params)
      expect(created.error).toBeUndefined()
      expect(created.result?.targetId).toBe(`TARGET-${tabId}`)
      expect(scene.extension.commands.find((command) => command.method === "tabs.create")?.params?.url).toBe("about:blank")
      expect(scene.state.navigations).toEqual([])
    } finally {
      scene.close()
    }
  }, 20_000)
}

test("a disallowed committed URL found after attach is sent back to about:blank, not closed", async () => {
  const scene = await createScene("guarded-redirect", 205, "TARGET-205")
  try {
    // The requested page lands somewhere else before any frame event reaches the relay: only the post-attach check sees it.
    scene.state.onNavigate = (url) => url === "about:blank" ? undefined : { url: "https://evil.test/" }
    const created = await cdpCall(scene.socket, 1, "Target.createTarget", { url: "https://127.0.0.1:8443/start" })
    expect(created.result?.targetId).toBe("TARGET-205")
    expect(await until(() => scene.state.navigations.includes("about:blank"))).toBe(true)
    expect(scene.state.navigations).toEqual(["https://127.0.0.1:8443/start", "about:blank"])
    expect(scene.state.removed).toBe(false)
    expect(violationLog(205)).toContain("popup=false")
    // The disallowed URL was never published through the registry.
    expect((await getTargets(scene.socket, 2)).find((target) => target.targetId === "TARGET-205")?.url).toBe("about:blank")
  } finally {
    scene.close()
  }
}, 20_000)

test("a disallowed Page.frameNavigated during the navigation is sent back to about:blank, not closed", async () => {
  const scene = await createScene("guarded-event", 206, "TARGET-206")
  try {
    // The main guard event path handles the commit; the post-attach check must not act on it a second time.
    scene.state.onNavigate = (url) => {
      if (url !== "about:blank") {
        scene.extension.emit("debugger.event", { tabId: 206, method: "Page.frameNavigated", params: { frame: { id: "TARGET-206", loaderId: "EVIL-1", url: "https://evil.test/" } } })
        return undefined
      }
      const loaderId = `L-${scene.state.navigations.length}`
      scene.extension.emit("debugger.event", { tabId: 206, method: "Page.frameNavigated", params: { frame: { id: "TARGET-206", loaderId, url } } })
      // Keep the blanking chain open while the post-attach check runs.
      return { result: { frameId: "TARGET-206", loaderId }, delayMs: 100 }
    }
    const created = await cdpCall(scene.socket, 1, "Target.createTarget", { url: "https://127.0.0.1:8443/start" })
    expect(created.result?.targetId).toBe("TARGET-206")
    expect(await until(() => scene.state.navigations.includes("about:blank"))).toBe(true)
    expect(scene.state.navigations.filter((url) => url === "about:blank")).toHaveLength(1)
    expect(scene.state.removed).toBe(false)
    expect(violationLog(206)).toContain("popup=false")
  } finally {
    scene.close()
  }
}, 20_000)

test("a repeated disallowed commit after blanking settled is blanked again", async () => {
  const scene = await createScene("guarded-repeat", 210, "TARGET-210")
  try {
    expect((await cdpCall(scene.socket, 1, "Target.createTarget", { url: "https://127.0.0.1:8443/start" })).result?.targetId).toBe("TARGET-210")
    const evil = (loaderId: string) => scene.extension.emit("debugger.event", {
      tabId: 210,
      method: "Page.frameNavigated",
      params: { frame: { id: "TARGET-210", loaderId, url: "https://evil.test/" } },
    })
    const blanks = () => scene.state.navigations.filter((url) => url === "about:blank").length
    // about:blank never commits here, so the first blanking chain settles by itself.
    evil("EVIL-1")
    expect(await until(() => blanks() === 1)).toBe(true)
    await Bun.sleep(100)
    evil("EVIL-2")
    expect(await until(() => blanks() === 2)).toBe(true)
    expect(scene.state.removed).toBe(false)
  } finally {
    scene.close()
  }
}, 20_000)

test("a failed post-attach navigation still returns the target and leaves the tab open", async () => {
  const scene = await createScene("guarded-failed", 207, "TARGET-207")
  try {
    scene.state.onNavigate = (url) => url === "about:blank" ? undefined : { error: new Error("Page.navigate failed") }
    const created = await cdpCall(scene.socket, 1, "Target.createTarget", { url: "https://127.0.0.1:8443/start" })
    expect(created.error).toBeUndefined()
    expect(created.result?.targetId).toBe("TARGET-207")
    expect(scene.state.removed).toBe(false)
    expect((await getTargets(scene.socket, 2)).some((target) => target.targetId === "TARGET-207")).toBe(true)
  } finally {
    scene.close()
  }
}, 20_000)

test("a navigation errorText still returns the target and leaves the tab open", async () => {
  const scene = await createScene("guarded-error-text", 208, "TARGET-208")
  try {
    scene.state.onNavigate = (url) => url === "about:blank" ? undefined : { result: { frameId: "TARGET-208", errorText: "net::ERR_FAILED" }, url: "about:blank" }
    const created = await cdpCall(scene.socket, 1, "Target.createTarget", { url: "https://127.0.0.1:8443/start" })
    expect(created.error).toBeUndefined()
    expect(created.result?.targetId).toBe("TARGET-208")
    expect(scene.state.removed).toBe(false)
    expect((await getTargets(scene.socket, 2)).some((target) => target.targetId === "TARGET-208")).toBe(true)
  } finally {
    scene.close()
  }
}, 20_000)

test("a tab closed during the post-attach navigation still answers Target.createTarget", async () => {
  const scene = await createScene("guarded-closed", 209, "TARGET-209")
  try {
    scene.state.onNavigate = (url) => {
      if (url === "about:blank") return undefined
      scene.state.onTargetInfo = () => ({ error: new Error("No tab with id: 209.") })
      return { error: new Error("No tab with id: 209.") }
    }
    const created = await cdpCall(scene.socket, 1, "Target.createTarget", { url: "https://127.0.0.1:8443/start" })
    expect(created.error).toBeUndefined()
    expect(created.result?.targetId).toBe("TARGET-209")
    // The closed tab reaches the client as a later tabs.removed, not as a createTarget failure.
    expect(scene.state.removed).toBe(false)
  } finally {
    scene.close()
  }
}, 20_000)
