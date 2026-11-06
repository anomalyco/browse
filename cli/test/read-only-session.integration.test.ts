import { afterAll, beforeAll, expect, test } from "bun:test"
import { spawn, type ChildProcess } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import WebSocket from "ws"
import { cdpCall, connectCdp, FakeExtension, startRelay, stopRelay } from "./relay-harness.ts"

// A relay of its own: these tests pair a browser and create sessions, which changes the pairing state shared suites
// inspect at startup.

const home = fs.mkdtempSync(path.join(os.tmpdir(), "browse-readonly-"))
let port = 0
let relay: ChildProcess | undefined
let base = ""
let token = ""

beforeAll(async () => {
  const started = await startRelay(home)
  relay = started.child
  port = started.port
  base = `http://127.0.0.1:${port}`
  token = started.token
}, 20_000)

afterAll(async () => {
  await stopRelay(relay)
  fs.rmSync(home, { recursive: true, force: true })
})

const post = (route: string, body: unknown) => fetch(`${base}${route}`, {
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify(body),
})

async function sessionSocket(sessionId: string): Promise<WebSocket> {
  const socket = await connectCdp(`ws://127.0.0.1:${port}/devtools/browser/test?opencodeBrowserSessionId=${sessionId}`, { authorization: `Bearer ${token}` })
  if (!(socket instanceof WebSocket)) throw new Error("CDP connection refused")
  return socket
}

test("a read-only session can screenshot an adopted tab but cannot navigate it", async () => {
  const targetInfo = { targetId: "TARGET-91", type: "page", title: "Example", url: "https://example.com/", attached: true, browserContextId: "CTX" }
  const extension = new FakeExtension(home, port)
    .on("Target.getTargetInfo", () => ({ targetInfo }))
    .on("Page.captureScreenshot", () => ({ data: "c2hvdA==" }))
    .on("Runtime.evaluate", () => ({ result: { type: "number", value: 2 } }))
  expect(await extension.pair({ attachedTabs: [91] })).toBe(true)
  try {
    const created = await post("/cli/session/new", { id: "look", readOnly: true })
    if (!created.ok) throw new Error(await created.text())
    const adopted = await post("/cli/session/adopt", { sessionId: "look", createIfMissing: false, tabId: 91 })
    if (!adopted.ok) throw new Error(await adopted.text())
    const socket = await sessionSocket("look")
    try {
      const targets = await cdpCall(socket, 1, "Target.getTargets")
      const targetInfos = targets.result?.targetInfos as Array<{ targetId: string }> | undefined
      expect(targetInfos?.some((target) => target.targetId === "TARGET-91")).toBe(true)
      const attached = await cdpCall(socket, 2, "Target.attachToTarget", { targetId: "TARGET-91", flatten: true })
      const sessionId = String(attached.result?.sessionId)
      const shot = await cdpCall(socket, 3, "Page.captureScreenshot", { format: "png" }, sessionId)
      expect(shot.result).toEqual({ data: "c2hvdA==" })
      const evaluated = await cdpCall(socket, 4, "Runtime.evaluate", { expression: "1 + 1", returnByValue: true }, sessionId)
      expect(evaluated.result?.result).toEqual({ type: "number", value: 2 })
      const navigated = await cdpCall(socket, 5, "Page.navigate", { url: "https://example.com/next" }, sessionId)
      expect(navigated.error?.message).toContain("this tab is read-only")
    } finally {
      socket.close()
    }
  } finally {
    extension.close()
  }
})

test("a read-only session refuses navigation, input and cookie writes; permissions are refused for every session", async () => {
  const extension = new FakeExtension(home, port)
  expect(await extension.pair()).toBe(true)
  try {
    const created = await post("/cli/session/new", { id: "read-only-tab", readOnly: true })
    if (!created.ok) throw new Error(await created.text())
    const readOnly = await sessionSocket("read-only-tab")
    try {
      for (const [id, method, params] of [
        [1, "Page.navigate", { url: "https://example.com/" }],
        [2, "Input.dispatchMouseEvent", { type: "mousePressed", x: 10, y: 10 }],
        [3, "Network.setCookie", { name: "x", value: "1", domain: "example.com" }],
        [4, "Target.createTarget", { url: "https://example.com/" }],
      ] as const) {
        const answer = await cdpCall(readOnly, id, method, params)
        expect(answer.error?.message).toContain("this tab is read-only")
      }
      // The read-only allowlist lets this through to routing, which refuses only because the session has no tab.
      const screenshot = await cdpCall(readOnly, 5, "Page.captureScreenshot", { format: "png" })
      expect(screenshot.error?.message).not.toContain("read-only")
    } finally {
      readOnly.close()
    }

    const writableCreated = await post("/cli/session/new", { id: "writable-tab" })
    if (!writableCreated.ok) throw new Error(await writableCreated.text())
    const writable = await sessionSocket("writable-tab")
    try {
      for (const [id, method] of [
        [1, "Browser.grantPermissions"],
        [2, "Browser.setPermission"],
        [3, "Browser.resetPermissions"],
      ] as const) {
        const answer = await cdpCall(writable, id, method, { origin: "https://example.com", permissions: ["geolocation"] })
        expect(answer.error?.message).toContain(`browse blocked ${method}`)
      }
    } finally {
      writable.close()
    }
  } finally {
    extension.close()
  }
})
