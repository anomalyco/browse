import { afterAll, beforeAll, expect, test } from "bun:test"
import { spawn, type ChildProcess } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import WebSocket from "ws"
import { cdpCall, collect, connectCdp, FakeExtension, startRelay, stopRelay, until } from "./relay-harness.ts"

// Target.createTarget for a session with a domain allowlist: the tab is created at about:blank, the debugger is
// attached there, and only then is the requested URL navigated to, so the allowlist observes the real load. The URL
// the tab actually has after that is checked too, closing it when a load beat the guard's events.

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

test("Target.createTarget in an allowlisted session creates at about:blank, attaches, then navigates", async () => {
  const tabId = 201
  const targetId = "TARGET-201"
  let current = "about:blank"
  const extension = new FakeExtension(home, port)
    .on("tabs.create", () => ({ tabId }))
    .on("Target.getTargetInfo", () => ({ targetInfo: targetInfo(targetId, current) }))
    .on("Page.navigate", () => {
      current = "https://127.0.0.1:8443/start"
      return { frameId: targetId, loaderId: "L1" }
    })
  expect(await extension.pair()).toBe(true)
  const sessionId = await allowlistedSession("guarded-create")
  const socket = await connectCdp(`ws://127.0.0.1:${port}/devtools/browser/test?opencodeBrowserSessionId=${sessionId}`, { authorization: `Bearer ${token}` })
  if (!(socket instanceof WebSocket)) throw new Error(`CDP connection refused: ${socket}`)
  try {
    const events = collect(socket)
    const created = await cdpCall(socket, 1, "Target.createTarget", { url: "https://127.0.0.1:8443/start" })
    expect(created.error).toBeUndefined()
    expect(created.result?.targetId).toBe(targetId)

    const methods = extension.commands.map((command) => command.method === "debugger.sendCommand" ? command.params?.method : command.method)
    expect(extension.commands.find((command) => command.method === "tabs.create")?.params?.url).toBe("about:blank")
    expect(methods.indexOf("debugger.attach")).toBeGreaterThan(methods.indexOf("tabs.create"))
    expect(methods.indexOf("Page.navigate")).toBeGreaterThan(methods.indexOf("debugger.attach"))
    expect(extension.commands.find((command) => command.params?.method === "Page.navigate")?.params?.params).toEqual({ url: "https://127.0.0.1:8443/start" })

    // The target is announced before the navigation, as Playwright's newPage and createTarget expect.
    expect(events.some((event) => event.method === "Target.attachedToTarget" && (event.params?.targetInfo as { targetId?: string } | undefined)?.targetId === targetId)).toBe(true)
  } finally {
    socket.close()
    extension.close()
  }
}, 20_000)

test("a URL outside the allowlist found after attach closes the new tab", async () => {
  const tabId = 202
  const targetId = "TARGET-202"
  let current = "about:blank"
  const extension = new FakeExtension(home, port)
    .on("tabs.create", () => ({ tabId }))
    .on("Target.getTargetInfo", () => ({ targetInfo: targetInfo(targetId, current) }))
    .on("Page.navigate", () => {
      // The requested page redirects before any frame event reaches the relay: only the post-attach check sees it.
      current = "https://evil.test/"
      return { frameId: targetId, loaderId: "L2" }
    })
  expect(await extension.pair()).toBe(true)
  const sessionId = await allowlistedSession("guarded-redirect")
  const socket = await connectCdp(`ws://127.0.0.1:${port}/devtools/browser/test?opencodeBrowserSessionId=${sessionId}`, { authorization: `Bearer ${token}` })
  if (!(socket instanceof WebSocket)) throw new Error(`CDP connection refused: ${socket}`)
  try {
    const created = await cdpCall(socket, 1, "Target.createTarget", { url: "https://127.0.0.1:8443/start" })
    expect(created.result?.targetId).toBe(targetId)
    expect(await until(() => extension.commands.some((command) => command.method === "tabs.remove" && command.params?.tabId === tabId))).toBe(true)
  } finally {
    socket.close()
    extension.close()
  }
}, 20_000)
