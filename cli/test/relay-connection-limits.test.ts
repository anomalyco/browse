import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { ChildProcess } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import WebSocket from "ws"
import { maxPreAuthMessageBytes, preAuthHandshakeTimeoutMs } from "../src/relay/extension-handshake.ts"
import { stableUnpackedExtensionOrigin } from "../src/relay/helpers.ts"
import { FakeExtension, startRelay, stopRelay } from "./relay-harness.ts"

const home = fs.mkdtempSync(path.join(os.tmpdir(), "browse-relay-limits-"))
let port = 0
let relay: ChildProcess | undefined

beforeAll(async () => {
  const started = await startRelay(home)
  relay = started.child
  port = started.port
}, 20_000)

afterAll(async () => {
  await stopRelay(relay)
  fs.rmSync(home, { recursive: true, force: true })
})

function extensionSocket(): { readonly socket: WebSocket; readonly closed: Promise<{ code: number; reason: string }> } {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/extension`, { origin: stableUnpackedExtensionOrigin })
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    socket.once("close", (code, reason) => resolve({ code, reason: reason.toString() })),
  )
  return { socket, closed }
}

function opened(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("open", () => resolve())
    socket.once("error", reject)
  })
}

describe("unpaired extension sockets", () => {
  test("an oversized message before pairing closes the socket", async () => {
    const { socket, closed } = extensionSocket()
    await opened(socket)
    socket.send("x".repeat(maxPreAuthMessageBytes + 1))
    expect(await closed).toEqual({ code: 1009, reason: "Message too large before pairing" })
  }, 20_000)

  test("a socket that never authenticates is closed after the handshake timeout", async () => {
    const { socket, closed } = extensionSocket()
    const startedAt = Date.now()
    await opened(socket)
    expect(await closed).toEqual({ code: 1008, reason: "Handshake timed out" })
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(preAuthHandshakeTimeoutMs - 500)
  }, 20_000)

  test("a paired socket still accepts messages larger than the pre-auth limit", async () => {
    const extension = new FakeExtension(home, port)
    expect(await extension.pair()).toBe(true)
    extension.emit("settings", { cursor: "off", padding: "x".repeat(1024 * 1024) })
    await Bun.sleep(250)
    expect(extension.socket.readyState).toBe(WebSocket.OPEN)
    extension.close()
  }, 20_000)
})
