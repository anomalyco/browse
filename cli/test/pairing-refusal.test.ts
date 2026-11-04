import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { type ChildProcess } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import WebSocket from "ws"
import { extensionProtocolVersion } from "../src/protocol.ts"
import { browserToken, mintPairingCode, pairingCodeKey, pairingCodesPath } from "../src/relay/browser-pairing.ts"
import { clearPairingRefusal, notePairingRefusal, pairingRefusalActive } from "../src/relay/extension-handshake.ts"
import { stableUnpackedExtensionOrigin } from "../src/relay/helpers.ts"
import { FakeExtension, pairWithCode, startRelay, stopRelay } from "./relay-harness.ts"

// The refusal is process-wide (one relay per process), so bun test sharing one process means every test clears it.
beforeEach(clearPairingRefusal)
afterEach(clearPairingRefusal)

const key = (character: string) => character.repeat(64)

describe("pairing refusal state", () => {
  test("nothing refused is not active", () => {
    expect(pairingRefusalActive({ codes: [] })).toBe(false)
  })

  test("a refusal stands after the codes it was made against expire", () => {
    const refusal = notePairingRefusal("wrong pairing code", { now: 1_000, codes: [key("a")] })
    expect(refusal).toMatchObject({ at: 1_000, reason: "wrong pairing code" })
    expect(pairingRefusalActive({ now: 2_000_000, codes: [] })).toBe(true)
    expect(pairingRefusalActive({ now: 2_000_000, codes: [key("a")] })).toBe(true)
  })

  test("a code minted since the refusal ends it, and it never re-arms once that code is used", () => {
    notePairingRefusal("wrong pairing code", { codes: [key("a")] })
    expect(pairingRefusalActive({ codes: [key("a"), key("b")] })).toBe(false)
    // The newer code was consumed or expired: the old snapshot must not bring the refusal back.
    expect(pairingRefusalActive({ codes: [key("a")] })).toBe(false)
    expect(pairingRefusalActive({ codes: [] })).toBe(false)
  })

  test("a refusal made without pending codes ends with the first code minted", () => {
    notePairingRefusal("wrong pairing code", { codes: [] })
    expect(pairingRefusalActive({ codes: [key("a")] })).toBe(false)
    expect(pairingRefusalActive({ codes: [] })).toBe(false)
  })

  test("clearing ends an active refusal, and a later one is active again", () => {
    notePairingRefusal("pairing failed", { codes: [key("a")] })
    expect(pairingRefusalActive({ codes: [key("a")] })).toBe(true)
    clearPairingRefusal()
    expect(pairingRefusalActive({ codes: [key("a")] })).toBe(false)
    notePairingRefusal("pairing failed", { codes: [key("a")] })
    expect(pairingRefusalActive({ codes: [key("a")] })).toBe(true)
  })

  test("a new refusal replaces the old snapshot instead of carrying it forward", () => {
    notePairingRefusal("wrong pairing code", { codes: [key("a")] })
    notePairingRefusal("pairing failed", { codes: [] })
    // `a` is now a key the newer refusal never saw, so it counts as newly minted and ends the refusal.
    expect(pairingRefusalActive({ codes: [key("a")] })).toBe(false)
  })
})

// A relay from source with its own data root: the refusal has to survive the codes file changing underneath it.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "browse-refusal-"))
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

const status = async () =>
  (await (await fetch(`${base}/extension/status`, { headers: { authorization: `Bearer ${token}` } })).json()) as { connected: boolean; pairingState?: string }
const pairingState = async () => (await status()).pairingState

/** Waits for the relay to report a connection, since the close event can reach the client before the relay settles. */
const connected = async () => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await status()).connected) return true
    await Bun.sleep(20)
  }
  return false
}

const unpairedPresence = () => new Promise<void>((resolve) => {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/extension`, { origin: stableUnpackedExtensionOrigin })
  socket.on("open", () => socket.send(JSON.stringify({ method: "protocol", params: { unpaired: true, protocolVersion: extensionProtocolVersion } })))
  socket.on("close", () => resolve())
})

const writeCodes = (codes: Array<{ key: string; expiresAt: number }>) => {
  fs.writeFileSync(pairingCodesPath(home), JSON.stringify({ codes, failures: 0 }))
}

describe("pairing refusal on the relay", () => {
  test("a refusal stands until a new code is minted or a browser pairs", async () => {
    const code = mintPairingCode(home)
    // An earlier unpaired presence is reported, but a refusal made after it wins.
    await unpairedPresence()
    expect(await pairingState()).toBe("unpaired")

    const wrong = code === "00000000" ? "11111111" : "00000000"
    const refused = await pairWithCode(port, wrong, "refused-1")
    expect(refused.token).toBeUndefined()
    expect(refused.closeCode).toBe(4006)
    expect(await pairingState()).toBe("refused")

    // The code that was pending at the refusal expires: a refusal doesn't need a live code to stand.
    writeCodes([{ key: pairingCodeKey(code), expiresAt: Date.now() - 1_000 }])
    expect(await pairingState()).toBe("refused")

    // A code minted since the refusal ends it.
    mintPairingCode(home)
    expect(await pairingState()).not.toBe("refused")

    // ...and it must not come back once that code is gone.
    writeCodes([])
    expect(await pairingState()).not.toBe("refused")

    const paired = await pairWithCode(port, mintPairingCode(home), "paired-1")
    expect(paired.open).toBe(true)
    expect(paired.token).toBeDefined()
    expect(browserToken("paired-1", home)).toBe(paired.token!)
    expect(await pairingState()).not.toBe("refused")
  }, 20_000)

  test("a real connection ends a refusal", async () => {
    expect(await pairingState()).not.toBe("refused")
    const wrong = await pairWithCode(port, "00000000", "refused-2")
    expect(wrong.closeCode).toBe(4006)
    expect(await pairingState()).toBe("refused")

    const extension = new FakeExtension(home, port)
    expect(await extension.pair({ hello: { profileId: "paired-1" } })).toBe(true)
    expect(await connected()).toBe(true)
    expect(await pairingState()).not.toBe("refused")
    extension.close()
  }, 20_000)
})
