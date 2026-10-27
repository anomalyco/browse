import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { spawn, type ChildProcess } from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import WebSocket from "ws"
import { dataUrlDocument, stableUnpackedExtensionOrigin } from "../src/relay-helpers.ts"
import { pairingCode, pairingProof, relayToken } from "../src/relay-secrets.ts"

// A relay from source on a free port with its own data root, and a fake extension that pairs with it and answers
// its commands. No browser.

const home = fs.mkdtempSync(path.join(os.tmpdir(), "browse-relay-"))
let port = 0
let relay: ChildProcess | undefined
let base = ""
let token = ""

type Command = { readonly id: number; readonly method: string; readonly params?: Record<string, unknown> }

/** The extension side of the link: pairing handshake, then generic answers to the relay's commands. */
class FakeExtension {
  readonly commands: Command[] = []
  readonly socket: WebSocket
  closeCode: number | undefined
  relayProved = false
  private readonly handlers = new Map<string, (command: Command) => unknown>()

  constructor(private readonly code: string, private readonly relayPort = port) {
    this.socket = new WebSocket(`ws://127.0.0.1:${relayPort}/extension`, { origin: stableUnpackedExtensionOrigin })
    this.socket.on("close", (code) => { this.closeCode = code })
  }

  on(method: string, handler: (command: Command) => unknown) {
    this.handlers.set(method, handler)
    return this
  }

  /**
   * Resolves true once the relay proved the code and accepted the extension's proof. A real extension stops when
   * the relay's proof is wrong; `answerAnyway` sends the extension's proof regardless, as an impostor would.
   */
  async pair(options: { readonly answerAnyway?: boolean; readonly proofPort?: number; readonly settings?: Record<string, unknown> } = {}): Promise<boolean> {
    await new Promise<void>((resolve, reject) => {
      this.socket.once("open", () => resolve())
      this.socket.once("error", reject)
    })
    const nonce = crypto.randomUUID().replaceAll("-", "")
    const challenge = new Promise<{ nonce: string; proof: string } | undefined>((resolve) => {
      this.socket.once("message", (data) => {
        const message = JSON.parse(String(data)) as { method?: string; params?: { nonce: string; proof: string } }
        resolve(message.method === "auth.challenge" ? message.params : undefined)
      })
      this.socket.once("close", () => resolve(undefined))
    })
    this.socket.send(JSON.stringify({
      method: "hello",
      params: { version: "0.0.0-test", build: "test", protocolVersion: 2, profileId: "test", profileName: "Test", pairing: { nonce } },
    }))
    const params = await challenge
    // The relay must prove it knows the code before the extension obeys it.
    if (!params) return false
    const proofPort = options.proofPort ?? this.relayPort
    this.relayProved = params.proof === pairingProof(this.code, "relay", proofPort, params.nonce, nonce)
    if (!this.relayProved && !options.answerAnyway) return false
    this.socket.send(JSON.stringify({ method: "auth.response", params: { proof: pairingProof(this.code, "extension", proofPort, nonce, params.nonce) } }))
    this.socket.on("message", (data) => this.answer(JSON.parse(String(data)) as Command))
    this.socket.send(JSON.stringify({ method: "ready" }))
    // A current extension sends its status page settings right after; an older one sends none.
    if (options.settings) this.emit("settings", options.settings)
    await Bun.sleep(100)
    return this.relayProved && this.socket.readyState === WebSocket.OPEN
  }

  private answer(command: Command) {
    if (typeof command.id !== "number" || command.id === 0) return
    this.commands.push(command)
    const method = command.method === "debugger.sendCommand" ? String(command.params?.method) : command.method
    const handler = this.handlers.get(method)
    const reply = (result: unknown) => this.socket.send(JSON.stringify({ id: command.id, result: result ?? {} }))
    const fail = (error: unknown) => this.socket.send(JSON.stringify({ id: command.id, error: String(error) }))
    try {
      const result = handler?.(command)
      // A handler may answer later, as Chrome does for slow commands.
      if (result instanceof Promise) result.then(reply, fail)
      else reply(result)
    } catch (error) {
      fail(error)
    }
  }

  /** Sends an extension event, as the real extension does for debugger events and tab changes. */
  emit(method: string, params: Record<string, unknown>) {
    this.socket.send(JSON.stringify({ method, params }))
  }

  close() {
    this.socket.close()
  }
}

/** Every message a CDP client receives, for asserting on events. */
function collect(socket: WebSocket): Array<{ method?: string; params?: Record<string, unknown>; sessionId?: string }> {
  const messages: Array<{ method?: string; params?: Record<string, unknown>; sessionId?: string }> = []
  socket.on("message", (data) => messages.push(JSON.parse(String(data))))
  return messages
}

async function until(condition: () => boolean, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs
  while (!condition() && Date.now() < deadline) await Bun.sleep(20)
  return condition()
}

async function freePort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address() as net.AddressInfo
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return address.port
}

/** Opens a CDP WebSocket; resolves with the socket, or the HTTP status the upgrade was refused with. */
function connectCdp(url: string, headers: Record<string, string> = {}): Promise<WebSocket | number> {
  return new Promise((resolve) => {
    const socket = new WebSocket(url, { headers })
    socket.once("open", () => resolve(socket))
    socket.once("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0))
    socket.once("error", () => resolve(0))
  })
}

function cdpCall(socket: WebSocket, id: number, method: string, params: Record<string, unknown> = {}, sessionId?: string) {
  return new Promise<{ result?: Record<string, unknown>; error?: { message: string } }>((resolve) => {
    const listener = (data: WebSocket.RawData) => {
      const message = JSON.parse(String(data)) as { id?: number }
      if (message.id !== id) return
      socket.off("message", listener)
      resolve(message as { result?: Record<string, unknown>; error?: { message: string } })
    }
    socket.on("message", listener)
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
  })
}

/** Starts a relay from source on a free port with the given data root and extra environment; resolves once it answers. */
async function startRelay(root: string, env: Record<string, string> = {}) {
  const relayPort = await freePort()
  const child = spawn(process.execPath, [path.join(import.meta.dir, "../src/main.ts"), "serve"], {
    env: { PATH: process.env.PATH ?? "", HOME: root, OPENCODE_BROWSER_HOME: root, OPENCODE_BROWSER_PORT: String(relayPort), OPENCODE_BROWSER_UPDATE_CHECK: "0", ...env },
    stdio: "ignore",
  })
  for (let attempt = 0; attempt < 100; attempt++) {
    const ready = await fetch(`http://127.0.0.1:${relayPort}/version`).then((response) => response.ok, () => false)
    if (ready) break
    await Bun.sleep(100)
  }
  return { child, port: relayPort, token: relayToken(root) }
}

async function stopRelay(child: ChildProcess | undefined) {
  child?.kill("SIGTERM")
  await Bun.sleep(200)
  child?.kill("SIGKILL")
}

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

describe("relay", () => {
  test("HTTP API needs the token; the version probe does not", async () => {
    expect((await fetch(`${base}/version`)).status).toBe(200)
    expect((await fetch(`${base}/extension/status`)).status).toBe(401)
    expect((await fetch(`${base}/extension/status`, { headers: { authorization: "Bearer wrong" } })).status).toBe(401)
    expect((await fetch(`${base}/cli/execute`, { method: "POST", body: "{}" })).status).toBe(401)
    expect((await fetch(`${base}/extension/status`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(200)
    // A browser page on another site can't reach it even with a token it doesn't have.
    expect((await fetch(`${base}/extension/status`, { headers: { "sec-fetch-site": "cross-site", authorization: `Bearer ${token}` } })).status).toBe(403)
    expect((await fetch(`${base}/version`, { headers: { host: `evil.test:${port}` } })).status).toBe(403)
  })

  test("CDP WebSocket needs the token in a header or the URL", async () => {
    const url = `ws://127.0.0.1:${port}/devtools/browser/test`
    expect(await connectCdp(url)).toBe(401)
    expect(await connectCdp(`${url}?opencodeBrowserToken=wrong`)).toBe(401)
    const byHeader = await connectCdp(url, { authorization: `Bearer ${token}` })
    const byQuery = await connectCdp(`${url}?opencodeBrowserToken=${token}`)
    expect(byHeader).toBeInstanceOf(WebSocket)
    expect(byQuery).toBeInstanceOf(WebSocket)
    for (const socket of [byHeader, byQuery]) if (socket instanceof WebSocket) socket.close()
  })

  test("an extension with the wrong pairing code is refused", async () => {
    const impostor = new FakeExtension(pairingCode(fs.mkdtempSync(path.join(home, "other-"))))
    expect(await impostor.pair({ answerAnyway: true })).toBe(false)
    // The extension would not have trusted this relay either: its proof is for a different code.
    expect(impostor.relayProved).toBe(false)
    await Bun.sleep(100)
    expect(impostor.closeCode).toBe(4006)
    const status = await (await fetch(`${base}/extension/status`, { headers: { authorization: `Bearer ${token}` } })).json() as { connected: boolean }
    expect(status.connected).toBe(false)
  })

  test("a handshake passed through from another port is refused", async () => {
    // The extension dialled a listener on another port that forwards to this relay: its proofs name that port.
    const forwarded = new FakeExtension(pairingCode(home))
    expect(await forwarded.pair({ answerAnyway: true, proofPort: port + 1 })).toBe(false)
    expect(forwarded.relayProved).toBe(false)
    await Bun.sleep(100)
    expect(forwarded.closeCode).toBe(4006)
  })

  test("a paired extension carries an authenticated CDP command", async () => {
    const tabId = 41
    const targetInfo = { targetId: "TARGET-41", type: "page", title: "Example", url: "https://example.com/", attached: true, browserContextId: "CTX" }
    const extension = new FakeExtension(pairingCode(home))
      .on("tabs.create", () => ({ tabId }))
      .on("Target.getTargetInfo", () => ({ targetInfo }))
      .on("Page.getFrameTree", () => ({ frameTree: { frame: { id: "TARGET-41", loaderId: "L", url: targetInfo.url, domainAndRegistry: "", securityOrigin: "https://example.com", mimeType: "text/html", secureContextType: "Secure", crossOriginIsolatedContextType: "NotIsolated", gatedAPIFeatures: [] } } }))
      .on("Runtime.evaluate", (command) => ({ result: { type: "string", value: `evaluated: ${String((command.params?.params as { expression?: string })?.expression)}` } }))
    expect(await extension.pair()).toBe(true)
    const status = await (await fetch(`${base}/extension/status`, { headers: { authorization: `Bearer ${token}` } })).json() as { connected: boolean }
    expect(status.connected).toBe(true)

    const socket = await connectCdp(`ws://127.0.0.1:${port}/devtools/browser/test`, { authorization: `Bearer ${token}` })
    if (!(socket instanceof WebSocket)) throw new Error(`CDP connection refused: ${socket}`)
    const created = await cdpCall(socket, 1, "Target.createTarget", { url: "https://example.com/" })
    expect(created.error).toBeUndefined()
    expect(created.result?.targetId).toBe("TARGET-41")
    const attached = await cdpCall(socket, 2, "Target.attachToTarget", { targetId: "TARGET-41", flatten: true })
    const sessionId = String(attached.result?.sessionId)
    const evaluated = await cdpCall(socket, 3, "Runtime.evaluate", { expression: "1 + 1", returnByValue: true }, sessionId)
    expect(evaluated.result).toEqual({ result: { type: "string", value: "evaluated: 1 + 1" } })
    expect(extension.commands.some((command) => command.method === "debugger.sendCommand" && command.params?.tabId === tabId && command.params?.method === "Runtime.evaluate")).toBe(true)
    // Guardrails apply on the way through.
    const blocked = await cdpCall(socket, 4, "Storage.clearDataForOrigin", { origin: "https://example.com", storageTypes: "all" }, sessionId)
    expect(blocked.error?.message).toContain("blocked Storage.clearDataForOrigin")
    // Site storage is scoped to the session's page hosts; navigations to local and internal pages are refused.
    const otherOrigin = await cdpCall(socket, 5, "IndexedDB.requestDatabaseNames", { securityOrigin: "https://bank.test" }, sessionId)
    expect(otherOrigin.error?.message).toContain("blocked IndexedDB.requestDatabaseNames")
    const ownOrigin = await cdpCall(socket, 6, "IndexedDB.requestDatabaseNames", { securityOrigin: "https://example.com" }, sessionId)
    expect(ownOrigin.error).toBeUndefined()
    const file = await cdpCall(socket, 7, "Page.navigate", { url: "file:///etc/passwd" }, sessionId)
    expect(file.error?.message).toContain("blocked Page.navigate to a file: URL")
    const internal = await cdpCall(socket, 8, "Target.createTarget", { url: "chrome://settings" })
    expect(internal.error?.message).toContain("blocked Target.createTarget")
    expect(extension.commands.some((command) => command.params?.method === "Page.navigate" || (command.method === "tabs.create" && String(command.params?.url).startsWith("chrome:")))).toBe(false)
    socket.close()
    extension.close()
  }, 20_000)

  test("a popup an agent's page opens becomes the opener session's page, with openerId", async () => {
    const targetInfo = (tabId: number) => ({ targetId: `TARGET-${tabId}`, type: "page", title: "Example", url: `https://example.com/${tabId}`, attached: true, browserContextId: "CTX" })
    const extension = new FakeExtension(pairingCode(home))
      .on("tabs.create", () => ({ tabId: 61 }))
      .on("Target.getTargetInfo", (command) => ({ targetInfo: targetInfo(Number(command.params?.tabId)) }))
    expect(await extension.pair()).toBe(true)
    const socket = await connectCdp(`ws://127.0.0.1:${port}/devtools/browser/test?opencodeBrowserSessionId=popups`, { authorization: `Bearer ${token}` })
    if (!(socket instanceof WebSocket)) throw new Error(`CDP connection refused: ${socket}`)
    const events = collect(socket)
    expect((await cdpCall(socket, 1, "Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true })).error).toBeUndefined()
    expect((await cdpCall(socket, 2, "Target.createTarget", { url: "https://example.com/61" })).result?.targetId).toBe("TARGET-61")

    // Chrome auto-attaches the popup to the opener's debuggee as a paused page child.
    extension.emit("debugger.event", {
      tabId: 61,
      method: "Target.attachedToTarget",
      params: { sessionId: "popup-child", targetInfo: { ...targetInfo(62), openerId: "TARGET-61" }, waitingForDebugger: true },
    })
    const released = () => extension.commands.filter((command) => command.params?.sessionId === "popup-child" || (command.params?.params as { sessionId?: string } | undefined)?.sessionId === "popup-child")
    expect(await until(() => released().some((command) => command.params?.method === "Target.detachFromTarget"))).toBe(true)
    expect(released().some((command) => command.params?.method === "Runtime.runIfWaitingForDebugger")).toBe(true)
    // The client never sees it as a child of the opener.
    expect(events.some((event) => event.method === "Target.attachedToTarget" && (event.params?.sessionId === "popup-child"))).toBe(false)

    // The extension reports the new tab; the relay attaches it as a root of the opener's session.
    extension.emit("tabs.opened", { tabId: 62, openerTabId: 61 })
    const announced = () => events.find((event) => event.method === "Target.attachedToTarget" && (event.params?.targetInfo as { targetId?: string } | undefined)?.targetId === "TARGET-62")
    expect(await until(() => announced() !== undefined)).toBe(true)
    const info = announced()?.params?.targetInfo as { openerId?: string; type?: string }
    expect(info.openerId).toBe("TARGET-61")
    expect(info.type).toBe("page")
    expect(extension.commands.some((command) => command.method === "debugger.attach" && command.params?.tabId === 62)).toBe(true)
    const targets = (await cdpCall(socket, 3, "Target.getTargets")).result?.targetInfos as Array<{ targetId: string }>
    expect(targets.map((target) => target.targetId).sort()).toEqual(["TARGET-61", "TARGET-62"])

    // Another session's client doesn't see it.
    const other = await connectCdp(`ws://127.0.0.1:${port}/devtools/browser/test?opencodeBrowserSessionId=someone-else`, { authorization: `Bearer ${token}` })
    if (!(other instanceof WebSocket)) throw new Error("CDP connection refused")
    const otherTargets = (await cdpCall(other, 1, "Target.getTargets")).result?.targetInfos as Array<{ targetId: string }>
    expect(otherTargets.some((target) => target.targetId === "TARGET-62")).toBe(false)

    // A tab opened from a tab no session uses is left alone.
    extension.emit("tabs.opened", { tabId: 64, openerTabId: 63 })
    await Bun.sleep(200)
    expect(extension.commands.some((command) => command.method === "debugger.attach" && command.params?.tabId === 64)).toBe(false)
    other.close()
    socket.close()
    extension.close()
  }, 20_000)

  test("a popup's root attach waits for the opener's child detach and retries while Chrome still holds it", async () => {
    const targetInfo = (tabId: number) => ({ targetId: `TARGET-${tabId}`, type: "page", title: "Example", url: `https://example.com/${tabId}`, attached: true, browserContextId: "CTX" })
    const order: string[] = []
    let refusals = 1
    const extension = new FakeExtension(pairingCode(home))
      .on("tabs.create", () => ({ tabId: 65 }))
      .on("Target.getTargetInfo", (command) => ({ targetInfo: targetInfo(Number(command.params?.tabId)) }))
      // The child detach answers late; Chrome still holds the popup once more after it.
      .on("Target.detachFromTarget", () => Bun.sleep(300).then(() => { order.push("detached") }))
      .on("debugger.attach", (command) => {
        if (command.params?.tabId !== 66) return {}
        order.push("attach")
        if (refusals-- > 0) throw new Error("Another debugger (DevTools or another extension) is attached to this tab. Ask the user to close it, then retry.")
        return {}
      })
    expect(await extension.pair()).toBe(true)
    const socket = await connectCdp(`ws://127.0.0.1:${port}/devtools/browser/test?opencodeBrowserSessionId=popup-race`, { authorization: `Bearer ${token}` })
    if (!(socket instanceof WebSocket)) throw new Error(`CDP connection refused: ${socket}`)
    const events = collect(socket)
    expect((await cdpCall(socket, 1, "Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true })).error).toBeUndefined()
    expect((await cdpCall(socket, 2, "Target.createTarget", { url: "https://example.com/65" })).result?.targetId).toBe("TARGET-65")
    extension.emit("debugger.event", {
      tabId: 65,
      method: "Target.attachedToTarget",
      params: { sessionId: "race-child", targetInfo: { ...targetInfo(66), openerId: "TARGET-65" }, waitingForDebugger: true },
    })
    // The extension reports the tab right away, before the child detach answers.
    extension.emit("tabs.opened", { tabId: 66, openerTabId: 65 })
    const announced = () => events.some((event) => event.method === "Target.attachedToTarget" && (event.params?.targetInfo as { targetId?: string } | undefined)?.targetId === "TARGET-66")
    expect(await until(announced, 5_000)).toBe(true)
    expect(order).toEqual(["detached", "attach", "attach"])
    socket.close()
    extension.close()
  }, 20_000)

  test("page.goto to a data: URL writes its content into about:blank", async () => {
    const targetInfo = { targetId: "TARGET-71", type: "page", title: "Example", url: "https://example.com/", attached: true, browserContextId: "CTX" }
    const extension = new FakeExtension(pairingCode(home))
    extension
      .on("tabs.create", () => ({ tabId: 71 }))
      .on("Target.getTargetInfo", () => ({ targetInfo }))
      .on("Page.navigate", (command) => {
        const url = String((command.params?.params as { url?: string }).url)
        // Chromium refuses data: navigations from extensions; about:blank commits.
        if (url.startsWith("data:")) return { frameId: "TARGET-71", loaderId: "REFUSED", errorText: "net::ERR_ABORTED" }
        extension.emit("debugger.event", { tabId: 71, method: "Page.frameNavigated", params: { frame: { id: "TARGET-71", loaderId: "BLANK-1", url } } })
        return { frameId: "TARGET-71", loaderId: "BLANK-1" }
      })
    expect(await extension.pair()).toBe(true)
    const socket = await connectCdp(`ws://127.0.0.1:${port}/devtools/browser/test?opencodeBrowserSessionId=data`, { authorization: `Bearer ${token}` })
    if (!(socket instanceof WebSocket)) throw new Error("CDP connection refused")
    await cdpCall(socket, 1, "Target.createTarget", { url: "https://example.com/" })
    const sessionId = String((await cdpCall(socket, 2, "Target.attachToTarget", { targetId: "TARGET-71", flatten: true })).result?.sessionId)
    const navigated = await cdpCall(socket, 3, "Page.navigate", { url: "data:text/html,<h1>hi</h1>" }, sessionId)
    expect(navigated.error).toBeUndefined()
    expect(navigated.result).toEqual({ frameId: "TARGET-71", loaderId: "BLANK-1" })
    const sent = extension.commands.filter((command) => command.params?.tabId === 71 && (command.params?.method === "Page.navigate" || command.params?.method === "Page.setDocumentContent"))
    expect(sent.map((command) => [command.params?.method, command.params?.params])).toEqual([
      ["Page.navigate", { url: "about:blank", frameId: "TARGET-71" }],
      ["Page.setDocumentContent", { frameId: "TARGET-71", html: "<h1>hi</h1>" }],
    ])
    socket.close()
    extension.close()
  }, 20_000)
})

/**
 * A paired fake extension with one agent tab (`tabId`) attached to a CDP session; `mouse()` sends one pointer move
 * through the relay and reports what reached the extension for it: the Input events (one when human-like input is off,
 * a path when it's on) and whether the relay drew the agent cursor (it calls into an isolated world to do so).
 */
async function settingsScene(options: { readonly relayPort: number; readonly relayToken: string; readonly code: string; readonly tabId: number; readonly settings?: Record<string, unknown> }) {
  const targetInfo = { targetId: `TARGET-${options.tabId}`, type: "page", title: "Example", url: "https://example.com/", attached: true, browserContextId: "CTX" }
  const extension = new FakeExtension(options.code, options.relayPort)
    .on("tabs.create", () => ({ tabId: options.tabId }))
    .on("Target.getTargetInfo", () => ({ targetInfo }))
    .on("Page.createIsolatedWorld", () => ({ executionContextId: 7 }))
  expect(await extension.pair(options.settings ? { settings: options.settings } : {})).toBe(true)
  const socket = await connectCdp(`ws://127.0.0.1:${options.relayPort}/devtools/browser/test?opencodeBrowserSessionId=settings-${options.tabId}`, { authorization: `Bearer ${options.relayToken}` })
  if (!(socket instanceof WebSocket)) throw new Error(`CDP connection refused: ${socket}`)
  await cdpCall(socket, 1, "Target.createTarget", { url: "https://example.com/" })
  const sessionId = String((await cdpCall(socket, 2, "Target.attachToTarget", { targetId: targetInfo.targetId, flatten: true })).result?.sessionId)
  let id = 10
  let x = 100
  const sentFor = (method: string) => extension.commands.filter((command) => command.method === "debugger.sendCommand" && command.params?.method === method).length
  return {
    extension,
    socket,
    /** The relay's `relay.settings` answers: what its environment fixes. */
    overrides: () => extension.commands.filter((command) => command.method === "relay.settings").map((command) => command.params?.overrides),
    async mouse() {
      const inputs = sentFor("Input.dispatchMouseEvent")
      const worlds = sentFor("Page.createIsolatedWorld")
      x = x === 100 ? 700 : 100
      const result = await cdpCall(socket, id++, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y: 300 }, sessionId)
      expect(result.error).toBeUndefined()
      await Bun.sleep(150)
      return { inputs: sentFor("Input.dispatchMouseEvent") - inputs, cursor: sentFor("Page.createIsolatedWorld") > worlds }
    },
    close() {
      socket.close()
      extension.close()
    },
  }
}

describe("settings from the extension", () => {
  test("cursor and human input follow the extension's settings at runtime; invalid values change nothing", async () => {
    const scene = await settingsScene({ relayPort: port, relayToken: token, code: pairingCode(home), tabId: 81, settings: { cursor: "always", humanInput: "off" } })
    expect(await until(() => scene.overrides().length === 1)).toBe(true)
    expect(scene.overrides()[0]).toEqual({})
    expect(await scene.mouse()).toEqual({ inputs: 1, cursor: true })
    scene.extension.emit("settings", { cursor: "sometimes", humanInput: 0 })
    expect(await until(() => scene.overrides().length === 2)).toBe(true)
    expect(await scene.mouse()).toEqual({ inputs: 1, cursor: true })
    scene.extension.emit("settings", { cursor: "off", humanInput: "on" })
    expect(await until(() => scene.overrides().length === 3)).toBe(true)
    await Bun.sleep(200)
    const paced = await scene.mouse()
    expect(paced.inputs).toBeGreaterThan(1)
    expect(paced.cursor).toBe(false)
    scene.close()
  }, 20_000)

  test("with the cursor always shown, a recording without cursor: true still leaves it out", async () => {
    const scene = await settingsScene({ relayPort: port, relayToken: token, code: pairingCode(home), tabId: 84, settings: { cursor: "always", humanInput: "off" } })
    expect(await until(() => scene.overrides().length === 1)).toBe(true)
    expect((await scene.mouse()).cursor).toBe(true)
    const post = (pathname: string, body: unknown) =>
      fetch(`${base}${pathname}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) })
    expect((await post("/flight-recorder/start", { tabId: 84 })).ok).toBe(true)
    expect((await scene.mouse()).cursor).toBe(false)
    await post("/flight-recorder/cancel", { tabId: 84 })
    expect((await scene.mouse()).cursor).toBe(true)
    expect((await post("/flight-recorder/start", { tabId: 84, cursor: true })).ok).toBe(true)
    expect((await scene.mouse()).cursor).toBe(true)
    await post("/flight-recorder/cancel", { tabId: 84 })
    scene.close()
  }, 20_000)

  test("an older extension that sends no settings gets the defaults (human input on, no cursor), not the last extension's", async () => {
    const first = await settingsScene({ relayPort: port, relayToken: token, code: pairingCode(home), tabId: 82, settings: { cursor: "always", humanInput: "off" } })
    expect(await until(() => first.overrides().length === 1)).toBe(true)
    first.close()
    await Bun.sleep(200)
    const older = await settingsScene({ relayPort: port, relayToken: token, code: pairingCode(home), tabId: 83 })
    const moved = await older.mouse()
    expect(moved.inputs).toBeGreaterThan(1)
    expect(moved.cursor).toBe(false)
    // It never hears of settings it doesn't know.
    expect(older.overrides()).toEqual([])
    older.close()
  }, 20_000)

  test("environment variables override the settings, and the relay reports them", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "browse-relay-env-"))
    const started = await startRelay(root, { OPENCODE_BROWSER_GHOST_CURSOR: "1", OPENCODE_BROWSER_HUMAN_INPUT: "0", OPENCODE_BROWSER_AGENT_WINDOW: "separate" })
    try {
      const scene = await settingsScene({ relayPort: started.port, relayToken: started.token, code: pairingCode(root), tabId: 91, settings: { cursor: "off", humanInput: "on" } })
      expect(await until(() => scene.overrides().length === 1)).toBe(true)
      expect(scene.overrides()[0]).toEqual({ agentWindow: "separate", cursor: "always", humanInput: "off" })
      expect(await scene.mouse()).toEqual({ inputs: 1, cursor: true })
      expect(scene.extension.commands.find((command) => command.method === "tabs.create")?.params?.window).toBe("separate")
      scene.close()
    } finally {
      await stopRelay(started.child)
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 30_000)
})

describe("dataUrlDocument", () => {
  test("shows HTML as is, text as preformatted text, images as an image", async () => {
    expect(await dataUrlDocument("data:text/html,<p>x</p>")).toBe("<p>x</p>")
    expect(await dataUrlDocument(`data:text/html;base64,${Buffer.from("<b>y</b>").toString("base64")}`)).toBe("<b>y</b>")
    expect(await dataUrlDocument("data:text/plain,a<b")).toContain("<pre")
    expect(await dataUrlDocument("data:text/plain,a<b")).toContain("a&lt;b")
    expect(await dataUrlDocument("data:application/json,{\"a\":1}")).toContain("{\"a\":1}")
    expect(await dataUrlDocument("data:image/png;base64,iVBORw0KGgo=")).toContain('<img src="data:image/png;base64,iVBORw0KGgo=">')
    expect(await dataUrlDocument("data:application/pdf;base64,JVBERi0=")).toBeUndefined()
  })
})
