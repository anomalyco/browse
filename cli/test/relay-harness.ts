import { expect } from "bun:test"
import { spawn, type ChildProcess } from "node:child_process"
import net from "node:net"
import path from "node:path"
import WebSocket from "ws"
import * as ExtensionPairing from "../../src/background/pairing.ts"
import { browserToken, issueBrowserToken, legacyPairingProof, pairingProof } from "../src/browser-pairing.ts"
import { extensionProtocolVersion } from "../src/protocol.ts"
import { stableUnpackedExtensionOrigin } from "../src/relay-helpers.ts"
import { relayToken } from "../src/relay-secrets.ts"

export type Command = { readonly id: number; readonly method: string; readonly params?: Record<string, unknown> }

/**
 * The extension side of the link: the token handshake (with a token for its profile written into the relay's data root
 * `root`, as a code exchange leaves it), then generic answers to the relay's commands.
 */
export class FakeExtension {
  readonly commands: Command[] = []
  readonly socket: WebSocket
  closeCode: number | undefined
  relayProved = false
  private readonly handlers = new Map<string, (command: Command) => unknown>()

  constructor(private readonly root: string, private readonly relayPort: number, host = "127.0.0.1") {
    this.socket = new WebSocket(`ws://${host}:${relayPort}/extension`, { origin: stableUnpackedExtensionOrigin })
    this.socket.on("close", (code) => { this.closeCode = code })
  }

  on(method: string, handler: (command: Command) => unknown) {
    this.handlers.set(method, handler)
    return this
  }

  /**
   * Resolves true once the relay proved the token and accepted the extension's proof. A real extension stops when
   * the relay's proof is wrong; `answerAnyway` sends the extension's proof regardless, as an impostor would. `legacy`
   * speaks the handshake of an extension too old for tokens, with the old shared code.
   */
  async pair(options: { readonly legacy?: string; readonly token?: string; readonly answerAnyway?: boolean; readonly proofPort?: number; readonly settings?: Record<string, unknown>; readonly attachedTabs?: readonly number[]; readonly agentTabs?: readonly number[]; readonly hello?: Record<string, unknown> } = {}): Promise<boolean> {
    await new Promise<void>((resolve, reject) => {
      this.socket.once("open", () => resolve())
      this.socket.once("error", reject)
    })
    const nonce = crypto.randomUUID().replaceAll("-", "")
    const profileId = String(options.hello?.profileId ?? "test")
    const secret = options.legacy ?? options.token ?? browserToken(profileId, this.root) ?? issueBrowserToken(profileId, this.root)
    const proof = options.legacy === undefined ? pairingProof : legacyPairingProof
    const challenge = new Promise<{ nonce: string; proof: string } | undefined>((resolve) => {
      this.socket.once("message", (data) => {
        const message = JSON.parse(String(data)) as { method?: string; params?: { nonce: string; proof: string } }
        resolve(message.method === "auth.challenge" ? message.params : undefined)
      })
      this.socket.once("close", () => resolve(undefined))
    })
    this.socket.send(JSON.stringify({
      method: "hello",
      params: { version: "0.0.0-test", build: "test", protocolVersion: extensionProtocolVersion, profileId: "test", profileName: "Test", ...options.hello, pairing: { nonce, ...(options.legacy === undefined ? { mode: "token" } : {}) } },
    }))
    const params = await challenge
    // The relay must prove it knows the code before the extension obeys it.
    if (!params) return false
    const proofPort = options.proofPort ?? this.relayPort
    this.relayProved = params.proof === proof(secret, "relay", proofPort, params.nonce, nonce)
    if (!this.relayProved && !options.answerAnyway) return false
    this.socket.send(JSON.stringify({ method: "auth.response", params: { proof: proof(secret, "extension", proofPort, nonce, params.nonce) } }))
    this.socket.on("message", (data) => this.answer(JSON.parse(String(data)) as Command))
    // A reconnecting extension announces the tabs it still has attached, then says it's ready.
    for (const tabId of options.attachedTabs ?? []) this.emit("debugger.attached", { tabId, ...(options.agentTabs?.includes(tabId) ? { agent: true } : {}) })
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
export function collect(socket: WebSocket): Array<{ method?: string; params?: Record<string, unknown>; sessionId?: string }> {
  const messages: Array<{ method?: string; params?: Record<string, unknown>; sessionId?: string }> = []
  socket.on("message", (data) => messages.push(JSON.parse(String(data))))
  return messages
}

export async function until(condition: () => boolean, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs
  while (!condition() && Date.now() < deadline) await Bun.sleep(20)
  return condition()
}

export async function freePort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address() as net.AddressInfo
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return address.port
}

/** Opens a CDP WebSocket; resolves with the socket, or the HTTP status the upgrade was refused with. */
export function connectCdp(url: string, headers: Record<string, string> = {}): Promise<WebSocket | number> {
  return new Promise((resolve) => {
    const socket = new WebSocket(url, { headers })
    socket.once("open", () => resolve(socket))
    socket.once("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0))
    socket.once("error", () => resolve(0))
  })
}

export function cdpCall(socket: WebSocket, id: number, method: string, params: Record<string, unknown> = {}, sessionId?: string) {
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
export async function startRelay(root: string, env: Record<string, string> = {}, reusePort?: number) {
  const relayPort = reusePort ?? await freePort()
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

export async function stopRelay(child: ChildProcess | undefined) {
  child?.kill("SIGTERM")
  await Bun.sleep(200)
  child?.kill("SIGKILL")
}

/**
 * The extension's side of a code exchange, with the extension's own crypto (src/background/pairing.ts): ECDH, prove
 * the code, unmask the token, prove the token. Records every frame both ways.
 */
export async function pairWithCode(relayPort: number, code: string, profileId: string) {
  const socket = new WebSocket(`ws://127.0.0.1:${relayPort}/extension`, { origin: stableUnpackedExtensionOrigin })
  const frames: string[] = []
  const send = (message: unknown) => {
    frames.push(JSON.stringify(message))
    socket.send(JSON.stringify(message))
  }
  const inbox: Array<{ method?: string; params?: Record<string, any> }> = []
  let wake = () => {}
  socket.on("message", (data) => {
    frames.push(String(data))
    inbox.push(JSON.parse(String(data)))
    wake()
  })
  const closed = new Promise<number>((resolve) => socket.once("close", (closeCode) => resolve(closeCode)))
  const next = async () => {
    while (inbox.length === 0 && socket.readyState === WebSocket.OPEN) await new Promise<void>((resolve) => { wake = resolve; setTimeout(resolve, 50) })
    return inbox.shift()
  }
  await new Promise<void>((resolve) => socket.once("open", () => resolve()))
  const keys = await ExtensionPairing.ecdhKeyPair()
  const nonce = ExtensionPairing.randomNonce()
  send({ method: "hello", params: { version: "0.0.0-test", build: "test", protocolVersion: extensionProtocolVersion, profileId, profileName: profileId, pairing: { nonce, mode: "code", ecdh: keys.publicKey } } })
  const fail = async () => ({ token: undefined, open: false, closeCode: await closed, wire: frames.join("\n") })
  const challenge = await next()
  if (challenge?.method !== "auth.challenge") return fail()
  const secret = await keys.secret(challenge.params?.ecdh)
  const transcript = { port: relayPort, extensionNonce: nonce, relayNonce: String(challenge.params?.nonce), extensionKey: keys.publicKey, relayKey: String(challenge.params?.ecdh) }
  const session = await ExtensionPairing.pairingSessionKey(await ExtensionPairing.pairingCodeMaterial({ code, legacy: false }), secret!, transcript)
  send({ method: "auth.code", params: { proof: await ExtensionPairing.sessionProof(session, "extension") } })
  const answer = await next()
  if (answer?.method !== "auth.token") return fail()
  expect(answer.params?.proof).toBe(await ExtensionPairing.sessionProof(session, "relay"))
  const token = (await ExtensionPairing.unwrapToken(session, answer.params?.wrapped))!
  send({ method: "auth.response", params: { proof: await ExtensionPairing.pairingProof(token, "extension", relayPort, nonce, transcript.relayNonce) } })
  send({ method: "ready" })
  await Bun.sleep(200)
  const open = socket.readyState === WebSocket.OPEN
  socket.close()
  await closed
  return { token, open, closeCode: undefined, wire: frames.join("\n") }
}
