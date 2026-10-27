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

  constructor(private readonly code: string) {
    this.socket = new WebSocket(`ws://127.0.0.1:${port}/extension`, { origin: stableUnpackedExtensionOrigin })
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
  async pair(options: { readonly answerAnyway?: boolean; readonly proofPort?: number } = {}): Promise<boolean> {
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
    const proofPort = options.proofPort ?? port
    this.relayProved = params.proof === pairingProof(this.code, "relay", proofPort, params.nonce, nonce)
    if (!this.relayProved && !options.answerAnyway) return false
    this.socket.send(JSON.stringify({ method: "auth.response", params: { proof: pairingProof(this.code, "extension", proofPort, nonce, params.nonce) } }))
    this.socket.on("message", (data) => this.answer(JSON.parse(String(data)) as Command))
    this.socket.send(JSON.stringify({ method: "ready" }))
    await Bun.sleep(100)
    return this.relayProved && this.socket.readyState === WebSocket.OPEN
  }

  private answer(command: Command) {
    if (typeof command.id !== "number" || command.id === 0) return
    this.commands.push(command)
    const method = command.method === "debugger.sendCommand" ? String(command.params?.method) : command.method
    try {
      const result = this.handlers.get(method)?.(command) ?? {}
      this.socket.send(JSON.stringify({ id: command.id, result }))
    } catch (error) {
      this.socket.send(JSON.stringify({ id: command.id, error: String(error) }))
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

beforeAll(async () => {
  port = await freePort()
  base = `http://127.0.0.1:${port}`
  relay = spawn(process.execPath, [path.join(import.meta.dir, "../src/main.ts"), "serve"], {
    env: { PATH: process.env.PATH ?? "", HOME: home, OPENCODE_BROWSER_HOME: home, OPENCODE_BROWSER_PORT: String(port) },
    stdio: "ignore",
  })
  for (let attempt = 0; attempt < 100; attempt++) {
    const ready = await fetch(`${base}/version`).then((response) => response.ok, () => false)
    if (ready) break
    await Bun.sleep(100)
  }
  token = relayToken(home)
}, 20_000)

afterAll(async () => {
  relay?.kill("SIGTERM")
  await Bun.sleep(200)
  relay?.kill("SIGKILL")
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
