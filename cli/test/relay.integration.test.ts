import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { spawn, type ChildProcess } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import WebSocket from "ws"
import {
  browserToken,
  legacyPairingCodePath,
  maxPairingFailures,
  mintPairingCode,
  readBrowserPairings,
  revokeBrowserToken,
} from "../src/relay/browser-pairing.ts"
import { checkoutReloadPrefix, extensionProtocolVersion, unpackedReloadAdvice } from "../src/protocol.ts"
import { dataUrlDocument, stableUnpackedExtensionOrigin } from "../src/relay/helpers.ts"
import { isBenignClosedSessionRejection, shouldSuppressRelayProcessFault } from "../src/relay.ts"
import {
  cdpCall,
  collect,
  connectCdp,
  FakeExtension,
  pairWithCode,
  startRelay,
  stopRelay,
  until,
} from "./relay-harness.ts"

// A relay from source on a free port with its own data root, and a fake extension that pairs with it and answers
// its commands. No browser.

const home = fs.mkdtempSync(path.join(os.tmpdir(), "browse-relay-"))
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

describe("relay", () => {
  test("HTTP API needs the token; the version probe does not", async () => {
    const compatibility = { extensionProtocol: { min: 3, version: 3 }, pairing: "opencode-browser-pairing-v3" }
    expect(await (await fetch(`${base}/version`)).json()).toMatchObject(compatibility)
    const probe = await fetch(`${base}/version`, { headers: { "sec-fetch-site": "cross-site" } })
    expect(probe.status).toBe(403)
    expect(await probe.json()).toEqual({ ...compatibility, error: "Cross-origin browser requests are not allowed" })
    expect((await fetch(`${base}/extension/status`)).status).toBe(401)
    expect((await fetch(`${base}/extension/status`, { headers: { authorization: "Bearer wrong" } })).status).toBe(401)
    expect((await fetch(`${base}/cli/execute`, { method: "POST", body: "{}" })).status).toBe(401)
    expect((await fetch(`${base}/extension/status`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(200)
    // A browser page on another site can't reach it even with a token it doesn't have.
    expect((await fetch(`${base}/extension/status`, { headers: { "sec-fetch-site": "cross-site", authorization: `Bearer ${token}` } })).status).toBe(403)
    expect((await fetch(`${base}/version`, { headers: { host: `evil.test:${port}` } })).status).toBe(403)
    const waiting = { "x-browse-install": "waiting" }
    const hint = async () => (await fetch(`${base}/version`, { headers: { "sec-fetch-site": "cross-site", "x-browse-install": "probe" } })).json()
    await fetch(`${base}/extension/status`, { headers: waiting })
    expect(await hint()).not.toHaveProperty("installWaiting")
    await fetch(`${base}/extension/status`, { headers: { ...waiting, authorization: `Bearer ${token}` } })
    expect(await hint()).toMatchObject({ installWaiting: true })
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

  test("anonymous unpaired presence changes the next step but grants no browser access", async () => {
    const status = async () => (await fetch(`${base}/extension/status`, { headers: { authorization: `Bearer ${token}` } })).json()
    expect(await status()).toMatchObject({ connected: false, pairingState: "not-seen" })
    const socket = new WebSocket(`ws://127.0.0.1:${port}/extension`, { origin: stableUnpackedExtensionOrigin })
    socket.on("open", () => socket.send(JSON.stringify({ method: "protocol", params: { unpaired: true, protocolVersion: extensionProtocolVersion } })))
    await new Promise<void>(resolve => socket.on("close", () => resolve()))
    expect(await status()).toMatchObject({ connected: false, pairingState: "unpaired", nextStep: expect.stringContaining("installed but not paired"), browsers: [] })
  })

  test("a code is exchanged once for a token of the browser's own, which never crosses the wire", async () => {
    const code = mintPairingCode(home)
    const first = await pairWithCode(port, code, "exchange-1")
    expect(first.open).toBe(true)
    expect(first.token).toBe(browserToken("exchange-1", home))
    // Neither the code nor the token is in anything either side sent.
    expect(first.wire).not.toContain(first.token!)
    expect(first.wire).not.toContain(code)
    // The token pairs from then on.
    const extension = new FakeExtension(home, port)
    expect(await extension.pair({ hello: { profileId: "exchange-1" } })).toBe(true)
    extension.close()
    // Used up: the same code again is refused.
    const again = await pairWithCode(port, code, "exchange-2")
    expect(again.token).toBeUndefined()
    expect(again.closeCode).toBe(4006)
    expect(browserToken("exchange-2", home)).toBeUndefined()
  })

  test.each([2, extensionProtocolVersion + 1])("reports incompatible protocol %i before pairing", async (protocolVersion) => {
    const extension = new FakeExtension(home, port)
    expect(await extension.pair({ hello: { protocolVersion } })).toBe(false)
    expect(extension.closeCode).toBe(4003)
    const status = await (await fetch(`${base}/extension/status`, { headers: { authorization: `Bearer ${token}` } })).json()
    expect(status).toMatchObject({ connected: false, protocolVersion, protocolCompatible: false })
    if (protocolVersion === 2) expect(status.nextStep).toContain(unpackedReloadAdvice)
  })

  test("an older protocol gets only a refusal; only the pinned unpacked origin gets a reload hint", async () => {
    for (const origin of [stableUnpackedExtensionOrigin, `chrome-extension://${"b".repeat(32)}`]) {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/extension`, { origin })
      const frames = collect(socket)
      socket.on("open", () => socket.send(JSON.stringify({ method: "protocol", params: { protocolVersion: 2 } })))
      const [code, reason] = await new Promise<[number, string]>(resolve => socket.on("close", (code, reason) => resolve([code, reason.toString()])))
      expect(code).toBe(4003)
      expect(frames).toEqual([]) // No commands, challenge, or credentials before close.
      expect(reason.startsWith(checkoutReloadPrefix)).toBe(origin === stableUnpackedExtensionOrigin)
      const status = await (await fetch(`${base}/extension/status`, { headers: { authorization: `Bearer ${token}` } })).json()
      expect(status).toMatchObject({ browsers: [], connected: false, origin })
      expect(status.nextStep.includes(unpackedReloadAdvice)).toBe(origin === stableUnpackedExtensionOrigin)
    }
  })

  test("two browsers pairing get different tokens", async () => {
    const one = await pairWithCode(port, mintPairingCode(home), "browser-one")
    const two = await pairWithCode(port, mintPairingCode(home), "browser-two")
    expect(one.open && two.open).toBe(true)
    expect(one.token).not.toBe(two.token)
    expect(readBrowserPairings(home)["browser-one"]?.token).toBe(one.token!)
    expect(readBrowserPairings(home)["browser-two"]?.token).toBe(two.token!)
  })

  test("pair waits for its own code, not a browser that redeemed another code", async () => {
    const pair = spawn(process.execPath, [path.join(import.meta.dir, "../src/main.ts"), "pair", "--wait-seconds", "8"], {
      env: { PATH: process.env.PATH, HOME: home, OPENCODE_BROWSER_HOME: home, OPENCODE_BROWSER_PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"],
    })
    let output = ""
    pair.stdout.on("data", chunk => { output += chunk })
    const exit = new Promise(resolve => pair.once("exit", resolve))
    try {
      expect(await until(() => /Pairing code: (\w+-\w+)/.test(output))).toBe(true)
      const code = /Pairing code: (\w+)-(\w+)/.exec(output)!
      await pairWithCode(port, mintPairingCode(home), "other-browser")
      expect(output).not.toContain("✓ Paired")
      expect((await pairWithCode(port, code[1]! + code[2]!, "wanted-browser")).open).toBe(true)
      expect(await exit).toBe(0)
      expect(output).toContain(`✓ Paired ${readBrowserPairings(home)["wanted-browser"]!.name}`)
    } finally { pair.kill() }
  }, 12_000)

  test("an expired code is refused", async () => {
    const expired = await pairWithCode(port, mintPairingCode(home, { now: Date.now() - 11 * 60_000 }), "late")
    expect(expired.token).toBeUndefined()
    expect(expired.closeCode).toBe(4006)
  })

  test("after five wrong codes even the right one is refused", async () => {
    const code = mintPairingCode(home)
    for (let attempt = 0; attempt < maxPairingFailures; attempt++) {
      const guess = await pairWithCode(port, code === "00000000" ? "11111111" : "00000000", "guesser")
      expect(guess.closeCode).toBe(4006)
    }
    const right = await pairWithCode(port, code, "guesser")
    expect(right.token).toBeUndefined()
    expect(right.closeCode).toBe(4006)
  })

  test("revoking a browser drops its connection, and its token no longer pairs", async () => {
    const extension = new FakeExtension(home, port)
    expect(await extension.pair({ hello: { profileId: "revoked" } })).toBe(true)
    const old = browserToken("revoked", home)!
    expect(revokeBrowserToken("revoked", home)).toBe(true)
    const response = await fetch(`${base}/extension/revoke`, { method: "POST", body: JSON.stringify({ key: "revoked" }), headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } })
    expect(await response.json()).toEqual({ dropped: true })
    expect(await until(() => extension.closeCode !== undefined)).toBe(true)
    expect(extension.closeCode).toBe(4006)
    // Its old token pairs no more.
    const again = new FakeExtension(home, port)
    expect(await again.pair({ hello: { profileId: "revoked" }, token: old, answerAnyway: true })).toBe(false)
    await Bun.sleep(100)
    expect(again.closeCode).toBe(4006)
  })

  test("the old shared code still pairs an extension too old for tokens, until it's retired", async () => {
    const legacy = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
    fs.writeFileSync(legacyPairingCodePath(home), `${legacy}\n`, { mode: 0o600 })
    const old = new FakeExtension(home, port)
    expect(await old.pair({ legacy, hello: { profileId: "old" } })).toBe(true)
    old.close()
    fs.rmSync(legacyPairingCodePath(home))
    const retired = new FakeExtension(home, port)
    expect(await retired.pair({ legacy, hello: { profileId: "old" } })).toBe(false)
    await Bun.sleep(100)
    expect(retired.closeCode).toBe(4006)
  })

  test("an extension with the wrong pairing code is refused", async () => {
    const impostor = new FakeExtension(fs.mkdtempSync(path.join(home, "other-")), port)
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
    const forwarded = new FakeExtension(home, port)
    expect(await forwarded.pair({ answerAnyway: true, proofPort: port + 1 })).toBe(false)
    expect(forwarded.relayProved).toBe(false)
    await Bun.sleep(100)
    expect(forwarded.closeCode).toBe(4006)
  })

  test("a paired extension carries an authenticated CDP command", async () => {
    const tabId = 41
    const targetInfo = { targetId: "TARGET-41", type: "page", title: "Example", url: "https://example.com/", attached: true, browserContextId: "CTX" }
    const extension = new FakeExtension(home, port)
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
    expect(extension.commands.some((command) => command.method === "tabs.create" && String(command.params?.url).startsWith("chrome:"))).toBe(false)
    expect(extension.commands.some((command) => command.params?.method === "Page.navigate" && String((command.params?.params as { url?: string } | undefined)?.url).startsWith("chrome:"))).toBe(false)
    socket.close()
    extension.close()
  }, 20_000)

  test("a popup an agent's page opens becomes the opener session's page, with openerId", async () => {
    const targetInfo = (tabId: number) => ({ targetId: `TARGET-${tabId}`, type: "page", title: "Example", url: `https://example.com/${tabId}`, attached: true, browserContextId: "CTX" })
    const extension = new FakeExtension(home, port)
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
    const extension = new FakeExtension(home, port)
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
    const extension = new FakeExtension(home, port)
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
      ["Page.navigate", { url: "https://example.com/" }],
      ["Page.navigate", { url: "about:blank", frameId: "TARGET-71" }],
      ["Page.setDocumentContent", { frameId: "TARGET-71", html: "<h1>hi</h1>" }],
    ])
    socket.close()
    extension.close()
  }, 20_000)

  test("a tab that can't be attached again is let go instead of failing the whole reconnect", async () => {
    const info = (tabId: number) => ({ targetId: `TARGET-${tabId}`, type: "page", title: "Example", url: `https://example.com/${tabId}`, attached: true, browserContextId: "CTX" })
    const extension = new FakeExtension(home, port)
      .on("Target.getTargetInfo", (command) => ({ targetInfo: info(Number(command.params?.tabId)) }))
      // Tab 92 is wedged: every command to it fails, as when a page hangs mid-navigation.
      .on("Page.enable", (command) => { if (command.params?.tabId === 92) throw new Error("Page.enable timed out"); return {} })
    expect(await extension.pair({ attachedTabs: [91, 92] })).toBe(true)
    const status = async () => await (await fetch(`${base}/extension/status`, { headers: { authorization: `Bearer ${token}` } })).json() as { connected: boolean; targets: Array<{ tabId: number }> }
    for (let i = 0; i < 100 && !(await status()).targets?.some((target) => target.tabId === 91); i++) await Bun.sleep(100)
    await Bun.sleep(500)
    // Before, the relay closed the connection (1011) and the extension never got to work.
    expect(extension.closeCode).toBeUndefined()
    expect((await status()).connected).toBe(true)
    expect((await status()).targets.map((target) => target.tabId)).toEqual([91])
    expect(extension.commands.some((command) => command.method === "debugger.detach" && command.params?.tabId === 92)).toBe(true)
    extension.close()
  }, 20_000)

  test("a wedged tab is let go within seconds when the extension reconnects (one 5 s timeout, no retries)", async () => {
    const info = (tabId: number) => ({ targetId: `TARGET-${tabId}`, type: "page", title: "Example", url: `https://example.com/${tabId}`, attached: true, browserContextId: "CTX" })
    const extension = new FakeExtension(home, port)
      .on("Target.getTargetInfo", (command) => ({ targetInfo: info(Number(command.params?.tabId)) }))
      // Tab 94 never answers, as a tab whose page waits on a dialog nobody saw.
      .on("Page.enable", (command) => command.params?.tabId === 94 ? new Promise(() => {}) : {})
    const started = Date.now()
    expect(await extension.pair({ attachedTabs: [93, 94] })).toBe(true)
    const status = async () => await (await fetch(`${base}/extension/status`, { headers: { authorization: `Bearer ${token}` } })).json() as { connected: boolean; targets: Array<{ tabId: number }> }
    for (let i = 0; i < 300 && !(await status()).connected; i++) await Bun.sleep(100)
    expect((await status()).connected).toBe(true)
    expect(Date.now() - started).toBeLessThan(10_000)
    expect((await status()).targets.map((target) => target.tabId)).toEqual([93])
    expect(extension.commands.some((command) => command.method === "debugger.detach" && command.params?.tabId === 94)).toBe(true)
    extension.close()
  }, 40_000)

  test("an extension reconnect (a service worker restart) keeps every page a session opened its own and grouped", async () => {
    const info = (tabId: number) => ({ targetId: `TARGET-${tabId}`, type: "page", title: "Example", url: `https://example.com/${tabId}`, attached: true, browserContextId: "CTX" })
    let next = 101
    const first = new FakeExtension(home, port)
      .on("tabs.create", () => ({ tabId: next++ }))
      .on("Target.getTargetInfo", (command) => ({ targetInfo: info(Number(command.params?.tabId)) }))
    expect(await first.pair()).toBe(true)
    const post = (route: string, body: unknown) => fetch(`${base}${route}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) })
    expect((await post("/cli/session/new", { id: "keeps-pages" })).ok).toBe(true)
    const socket = await connectCdp(`ws://127.0.0.1:${port}/devtools/browser/test?opencodeBrowserSessionId=keeps-pages`, { authorization: `Bearer ${token}` })
    if (!(socket instanceof WebSocket)) throw new Error(`CDP connection refused: ${socket}`)
    expect((await cdpCall(socket, 1, "Target.createTarget", { url: "https://example.com/101" })).result?.targetId).toBe("TARGET-101")
    expect((await cdpCall(socket, 2, "Target.createTarget", { url: "https://example.com/102" })).result?.targetId).toBe("TARGET-102")
    first.close()
    const owners = async () => (await (await fetch(`${base}/json/list`, { headers: { authorization: `Bearer ${token}` } })).json() as Array<{ tabId: number; opencodeBrowserSessionId?: string }>)
      .filter((target) => target.tabId === 101 || target.tabId === 102)
    for (let i = 0; i < 50 && (await owners()).length > 0; i++) await Bun.sleep(50)

    const second = new FakeExtension(home, port)
      .on("Target.getTargetInfo", (command) => ({ targetInfo: info(Number(command.params?.tabId)) }))
    expect(await second.pair({ attachedTabs: [101, 102] })).toBe(true)
    for (let i = 0; i < 50 && (await owners()).length < 2; i++) await Bun.sleep(50)
    expect((await owners()).map((target) => [target.tabId, target.opencodeBrowserSessionId]).sort()).toEqual([[101, "keeps-pages"], [102, "keeps-pages"]])
    // Only the session sees them; before, the page that wasn't the session's default came back as a user's tab, which
    // every session saw.
    const other = await connectCdp(`ws://127.0.0.1:${port}/devtools/browser/test?opencodeBrowserSessionId=someone-else`, { authorization: `Bearer ${token}` })
    if (!(other instanceof WebSocket)) throw new Error("CDP connection refused")
    const seen = (await cdpCall(other, 1, "Target.getTargets")).result?.targetInfos as Array<{ targetId: string }>
    expect(seen.some((target) => target.targetId === "TARGET-101" || target.targetId === "TARGET-102")).toBe(false)
    // Both go back in the session's group rather than out of it.
    expect(await until(() => [101, 102].every((tabId) => second.commands.some((command) => command.method === "tabs.group" && command.params?.tabId === tabId && command.params?.sessionId === "keeps-pages")))).toBe(true)
    expect(second.commands.some((command) => command.method === "tabs.ungroup")).toBe(false)

    // A session deleted while the extension was away closes its pages once the extension is back.
    second.close()
    for (let i = 0; i < 50 && (await owners()).length > 0; i++) await Bun.sleep(50)
    expect((await post("/cli/session/delete", { id: "keeps-pages" })).ok).toBe(true)
    const third = new FakeExtension(home, port)
      .on("Target.getTargetInfo", (command) => ({ targetInfo: info(Number(command.params?.tabId)) }))
    // 103: an agent's tab the relay never knew (its attach was cut short); 104: a tab the user lent.
    expect(await third.pair({ attachedTabs: [101, 102, 103, 104], agentTabs: [101, 102, 103] })).toBe(true)
    expect(await until(() => [101, 102, 103].every((tabId) => third.commands.some((command) => command.method === "tabs.remove" && command.params?.tabId === tabId)), 5_000)).toBe(true)
    expect(third.commands.some((command) => command.method === "tabs.remove" && command.params?.tabId === 104)).toBe(false)
    other.close()
    socket.close()
    third.close()
  }, 30_000)

  test("the browser's debugging bar dismissal stops the script, keeps agent tabs grouped and warns the next execute", async () => {
    const info = (tabId: number) => ({ targetId: `TARGET-${tabId}`, type: "page", title: "Example", url: "https://example.com/", attached: true, browserContextId: "CTX" })
    const userTab = 240
    let next = 230
    const extension = new FakeExtension(home, port)
      .on("tabs.create", () => ({ tabId: ++next }))
      .on("Target.getTargetInfo", (command) => ({ targetInfo: info(Number(command.params?.tabId)) }))
      .on("Page.getFrameTree", (command) => {
        const targetId = `TARGET-${Number(command.params?.tabId)}`
        return { frameTree: { frame: { id: targetId, loaderId: "L", url: "https://example.com/", domainAndRegistry: "", securityOrigin: "https://example.com", mimeType: "text/html", secureContextType: "Secure", crossOriginIsolatedContextType: "NotIsolated", gatedAPIFeatures: [] } } }
      })
    // A tab the user attached with the toolbar: the relay must still ungroup it for an older extension.
    expect(await extension.pair({ attachedTabs: [userTab] })).toBe(true)
    expect(await until(() => extension.commands.some((command) => command.method === "debugger.sendCommand" && command.params?.method === "Page.enable" && command.params?.tabId === userTab), 10_000)).toBe(true)
    const post = (route: string, body: unknown) => fetch(`${base}${route}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    })
    type Result = { isError: boolean; text: string; warnings: string[] }
    const execute = async (sessionId: string, code: string) =>
      await (await post("/cli/execute", { sessionId, code, createIfMissing: true })).json() as Result
    const ungroups = (tabId: number) => extension.commands.filter((command) => command.method === "tabs.ungroup" && command.params?.tabId === tabId).length
    try {
      // A script that never settles: the user clicks the bar's button while it runs. Chromium detaches every tab,
      // the agent's and the user's, so the relay hears both.
      const runningSession = "debugging-bar-running"
      const running = execute(runningSession, "await new Promise(() => {})")
      expect(await until(() => extension.commands.some((command) => command.method === "pageStatus.set" && (command.params?.status as { state?: string } | undefined)?.state === "running"), 10_000)).toBe(true)
      // Let the session page finish opening so user code is the thing that runs when the user cancels.
      await Bun.sleep(200)
      const runningTab = next
      const userUngroups = ungroups(userTab)
      extension.emit("debugger.detached", { tabId: runningTab, reason: "canceled_by_user" })
      extension.emit("debugger.detached", { tabId: userTab, reason: "canceled_by_user" })
      const stopped = await running
      expect(stopped.isError).toBe(true)
      expect(stopped.text).toContain("dismissed the browser's debugging bar")
      expect(stopped.text).toContain("disconnects browse from every tab")

      // An agent-opened tab keeps its group (an ungroup here would close it in the extension); a tab the user lent
      // is still ungrouped.
      expect(ungroups(runningTab)).toBe(0)
      expect(await until(() => ungroups(userTab) > userUngroups)).toBe(true)

      // The next execute in a session whose page was released that way says so and opens a new page.
      const idleSession = "debugging-bar-idle"
      expect((await execute(idleSession, "return 1")).isError).toBe(false)
      const idleTab = next
      extension.emit("debugger.detached", { tabId: idleTab, reason: "canceled_by_user" })
      expect(await until(() => extension.commands.some((command) => command.method === "pageStatus.clear" && command.params?.tabId === idleTab))).toBe(true)
      expect(ungroups(idleTab)).toBe(0)
      const nextRun = await execute(idleSession, "return 1")
      expect(nextRun.warnings.join("\n")).toContain("dismissed the browser's debugging bar")
      expect(nextRun.warnings.join("\n")).toContain("tabs an agent opened stay open")
      expect(nextRun.warnings.join("\n")).not.toContain("The session default page was closed")
    } finally {
      extension.close()
    }
  }, 30_000)

  test("a tab the extension re-attached after Chrome dropped the debugger (a PDF opening) is set up again", async () => {
    const targetInfo = { targetId: "TARGET-75", type: "page", title: "Doc", url: "https://example.com/doc.pdf", attached: true, browserContextId: "CTX" }
    const extension = new FakeExtension(home, port)
      .on("tabs.create", () => ({ tabId: 75 }))
      .on("Target.getTargetInfo", () => ({ targetInfo }))
    expect(await extension.pair()).toBe(true)
    const socket = await connectCdp(`ws://127.0.0.1:${port}/devtools/browser/test?opencodeBrowserSessionId=pdf`, { authorization: `Bearer ${token}` })
    if (!(socket instanceof WebSocket)) throw new Error("CDP connection refused")
    const events = collect(socket)
    await cdpCall(socket, 1, "Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true })
    await cdpCall(socket, 2, "Target.createTarget", { url: "https://example.com/doc.pdf" })
    const enables = () => extension.commands.filter((command) => command.params?.tabId === 75 && command.params?.method === "Page.enable").length
    const before = enables()
    // Chrome dropped the debugger as the viewer opened; the extension attached again: a new session, no domains on.
    extension.emit("debugger.detached", { tabId: 75, reason: "target_closed", reattached: true })
    expect(await until(() => enables() > before)).toBe(true)
    // Clients see the root replaced (same target), so Playwright sets its page up again instead of waiting forever.
    const attached = () => events.filter((event) => event.method === "Target.attachedToTarget" && (event.params?.targetInfo as { targetId?: string } | undefined)?.targetId === "TARGET-75").length
    expect(await until(() => attached() >= 2 && events.some((event) => event.method === "Target.detachedFromTarget"))).toBe(true)
    socket.close()
    extension.close()
  }, 20_000)

  test("a tab re-attached while its session is executing keeps focus emulation on", async () => {
    const tabId = 76
    const targetInfo = { targetId: "TARGET-76", type: "page", title: "Example", url: "https://example.com/", attached: true, browserContextId: "CTX" }
    const extension = new FakeExtension(home, port)
      .on("tabs.create", () => ({ tabId }))
      .on("Target.getTargetInfo", () => ({ targetInfo }))
      .on("Page.getFrameTree", () => ({ frameTree: { frame: { id: "TARGET-76", loaderId: "L", url: "https://example.com/", domainAndRegistry: "", securityOrigin: "https://example.com", mimeType: "text/html", secureContextType: "Secure", crossOriginIsolatedContextType: "NotIsolated", gatedAPIFeatures: [] } } }))
    expect(await extension.pair()).toBe(true)
    const post = (route: string, body: unknown) => fetch(`${base}${route}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    })
    // A script that never settles: its session stays executing while the tab is re-attached underneath it.
    const running = post("/cli/execute", { sessionId: "reattach-focus", code: "await new Promise(() => {})", createIfMissing: true })
      .then((response) => response.json()) as Promise<{ isError: boolean }>
    expect(await until(() => extension.commands.some((command) => command.method === "pageStatus.set" && (command.params?.status as { state?: string } | undefined)?.state === "running"), 10_000)).toBe(true)
    const focus = (enabled: boolean) => (command: { params?: Record<string, unknown> }) =>
      command.params?.tabId === tabId && command.params?.method === "Emulation.setFocusEmulationEnabled" && (command.params?.params as { enabled?: boolean } | undefined)?.enabled === enabled
    expect(await until(() => extension.commands.some(focus(true)))).toBe(true)
    const enables = () => extension.commands.filter((command) => command.params?.tabId === tabId && command.params?.method === "Page.enable").length
    const before = enables()
    // Chrome dropped the debugger (a PDF opening) and the extension attached the tab again: a fresh session with no domains on.
    extension.emit("debugger.detached", { tabId, reason: "target_closed", reattached: true })
    expect(await until(() => enables() > before)).toBe(true)
    const reattachEnableIndex = extension.commands
      .map((command, index) => ({ command, index }))
      .filter(({ command }) => command.params?.tabId === tabId && command.params?.method === "Page.enable")[before]!.index
    const focusAfterReattach = () => extension.commands.slice(reattachEnableIndex + 1).find((command) =>
      command.params?.tabId === tabId && command.params?.method === "Emulation.setFocusEmulationEnabled")
    expect(await until(() => focusAfterReattach() !== undefined)).toBe(true)
    // Focus was still claimed by the executing session, so the reattach must not turn emulation back off.
    expect((focusAfterReattach()?.params?.params as { enabled?: boolean } | undefined)?.enabled).toBe(true)
    extension.emit("debugger.detached", { tabId, reason: "canceled_by_user" })
    expect((await running).isError).toBe(true)
    extension.close()
  }, 30_000)

  for (const endpoint of ["flight-recorder", "recording"]) test(`${endpoint} status lists the active sessions when a selector is needed`, async () => {
    let nextTab = 180
    const extension = new FakeExtension(home, port)
      .on("tabs.create", () => ({ tabId: ++nextTab }))
      .on("Target.getTargetInfo", ({ params }) => ({ targetInfo: { targetId: `TARGET-${params?.tabId}`, type: "page", title: "Example", url: "https://example.com/", attached: true } }))
      .on("recording.start", ({ params }) => ({ success: true, tabId: params?.tabId, startedAt: Date.now() }))
      .on("recording.status", () => ({ isRecording: true }))
    const sockets: WebSocket[] = []
    const sessions = ["capture-a", "capture-b"]
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" }
    const post = (action: string, body: object) => fetch(`${base}/${endpoint}/${action}`, { method: "POST", headers, body: JSON.stringify(body) })
    try {
      expect(await extension.pair()).toBe(true)
      for (const sessionId of sessions) {
        const socket = await connectCdp(`ws://127.0.0.1:${port}/devtools/browser/test?opencodeBrowserSessionId=${sessionId}`, headers)
        if (!(socket instanceof WebSocket)) throw new Error("CDP connection refused")
        sockets.push(socket)
        expect((await cdpCall(socket, 1, "Target.createTarget", { url: "https://example.com/" })).error).toBeUndefined()
        const options = endpoint === "recording" ? { mode: "tab-capture", outputPath: path.join(home, `${sessionId}.webm`) } : {}
        expect((await post("start", { sessionId, ...options })).status).toBe(200)
        const status = await fetch(`${base}/${endpoint}/status?sessionId=${sessionId}`, { headers })
        expect(status.status).toBe(200)
        expect(await status.json()).toMatchObject({ tabId: nextTab, [endpoint === "recording" ? "isRecording" : "active"]: true })
      }
      const ambiguous = await fetch(`${base}/${endpoint}/status`, { headers })
      expect(ambiguous.status).toBe(409)
      const body = await ambiguous.json() as { error: string; code: string }
      expect(body.code).toBe("target-ambiguous")
      for (const session of sessions) expect(body.error).toContain(session)
    } finally {
      for (const sessionId of sessions) await post("cancel", { sessionId })
      for (const socket of sockets) socket.close()
      extension.close()
    }
  }, 20_000)

  test("stopping or cancelling a recording when none runs is a clean 404, not a 500", async () => {
    const targetInfo = { targetId: "TARGET-77", type: "page", title: "Example", url: "https://example.com/", attached: true, browserContextId: "CTX" }
    const extension = new FakeExtension(home, port)
      .on("tabs.create", () => ({ tabId: 77 }))
      .on("Target.getTargetInfo", () => ({ targetInfo }))
    expect(await extension.pair()).toBe(true)
    const socket = await connectCdp(`ws://127.0.0.1:${port}/devtools/browser/test?opencodeBrowserSessionId=no-recording`, { authorization: `Bearer ${token}` })
    if (!(socket instanceof WebSocket)) throw new Error("CDP connection refused")
    await cdpCall(socket, 1, "Target.createTarget", { url: "https://example.com/" })
    const post = (route: string) => fetch(`${base}${route}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ tabId: 77 }) })
    const stopped = await post("/recording/stop")
    expect(stopped.status).toBe(404)
    expect(((await stopped.json()) as { error?: string }).error).toContain("No active recording")
    expect((await post("/recording/cancel")).status).toBe(200)
    socket.close()
    extension.close()
  }, 20_000)

  for (const [index, shotCase] of [
    { name: "png", params: { format: "png" } },
    { name: "jpeg with a clip", params: { format: "jpeg", quality: 80, clip: { x: 0, y: 0, width: 300, height: 200, scale: 1 } } },
  ].entries()) test(`a screenshot of a hidden tab that doesn't answer is released by a capture with the same params (${shotCase.name})`, async () => {
    const tabId = 79 + index
    const targetInfo = { targetId: `TARGET-${tabId}`, type: "page", title: "Example", url: "https://example.com/", attached: true, browserContextId: "CTX" }
    // Like Chrome on a background tab: a capture waits until another capture reaches the tab. Chromium then resolves
    // every pending surface snapshot with the image of the capture that just completed.
    const captures: Record<string, unknown>[] = []
    let pending: ((image: string) => void) | undefined
    const imageFor = (params: Record<string, unknown>) => JSON.stringify(params)
    const extension = new FakeExtension(home, port)
      .on("tabs.create", () => ({ tabId }))
      .on("Target.getTargetInfo", () => ({ targetInfo }))
      .on("Page.captureScreenshot", (command) => {
        const params = command.params?.params as Record<string, unknown>
        captures.push(params)
        const release = pending
        pending = undefined
        release?.(imageFor(params))
        return new Promise((resolve) => { pending = (image) => resolve({ data: image }) })
      })
    expect(await extension.pair()).toBe(true)
    const socket = await connectCdp(`ws://127.0.0.1:${port}/devtools/browser/test?opencodeBrowserSessionId=shot-${index}`, { authorization: `Bearer ${token}` })
    if (!(socket instanceof WebSocket)) throw new Error("CDP connection refused")
    await cdpCall(socket, 1, "Target.createTarget", { url: "https://example.com/" })
    const sessionId = String((await cdpCall(socket, 2, "Target.attachToTarget", { targetId: `TARGET-${tabId}`, flatten: true })).result?.sessionId)
    const started = Date.now()
    const shot = await cdpCall(socket, 3, "Page.captureScreenshot", shotCase.params, sessionId)
    expect(Date.now() - started).toBeLessThan(3_000)
    // The nudge carried the client's own params, so the pending capture got the full image rather than a 1x1 bitmap.
    expect(captures[0]).toEqual(shotCase.params)
    expect(captures[1]).toEqual(shotCase.params)
    expect(shot.result).toEqual({ data: imageFor(shotCase.params) })
    socket.close()
    extension.close()
  }, 20_000)

  test("a page restored from the back/forward cache is reported loaded, so goBack doesn't wait forever", async () => {
    const targetInfo = { targetId: "TARGET-81", type: "page", title: "Example", url: "https://example.com/b", attached: true, browserContextId: "CTX" }
    const extension = new FakeExtension(home, port)
      .on("tabs.create", () => ({ tabId: 81 }))
      .on("Target.getTargetInfo", () => ({ targetInfo }))
    expect(await extension.pair()).toBe(true)
    const socket = await connectCdp(`ws://127.0.0.1:${port}/devtools/browser/test?opencodeBrowserSessionId=bfcache`, { authorization: `Bearer ${token}` })
    if (!(socket instanceof WebSocket)) throw new Error("CDP connection refused")
    const messages = collect(socket)
    await cdpCall(socket, 1, "Target.createTarget", { url: "https://example.com/b" })
    await cdpCall(socket, 2, "Target.attachToTarget", { targetId: "TARGET-81", flatten: true })
    const lifecycle = () => messages.filter((message) => message.method === "Page.lifecycleEvent").map((message) => message.params?.name)
    // An ordinary navigation: Chrome sends its own lifecycle events, and the relay adds none.
    extension.emit("debugger.event", { tabId: 81, method: "Page.frameNavigated", params: { type: "Navigation", frame: { id: "TARGET-81", loaderId: "L1", url: "https://example.com/b" } } })
    // Chrome restores the previous page from the cache without DOMContentLoaded or load.
    extension.emit("debugger.event", { tabId: 81, method: "Page.frameNavigated", params: { type: "BackForwardCacheRestore", frame: { id: "TARGET-81", loaderId: "L0", url: "https://example.com/a" } } })
    expect(await until(() => lifecycle().length >= 2)).toBe(true)
    await Bun.sleep(100)
    expect(lifecycle()).toEqual(["DOMContentLoaded", "load"])
    const restored = messages.find((message) => message.params?.type === "BackForwardCacheRestore")
    expect(messages.find((message) => message.method === "Page.lifecycleEvent")).toMatchObject({ sessionId: restored?.sessionId, params: { frameId: "TARGET-81", loaderId: "L0" } })
    socket.close()
    extension.close()
  }, 20_000)
})

describe("process faults", () => {
  test("Patchright's unawaited commands on a session that went away are benign; other faults are not", () => {
    const fault = (message: string) => Object.assign(new Error(message), { stack: `Error: ${message}\n    at _CRSession.send (/x/node_modules/patchright-core/lib/coreBundle.js:36966:61)` })
    expect(isBenignClosedSessionRejection(fault("Protocol error (Network.setCacheDisabled): Internal server error, session closed."))).toBe(true)
    expect(isBenignClosedSessionRejection(fault("Protocol error (Network.setCacheDisabled): Extension disconnected"))).toBe(true)
    expect(isBenignClosedSessionRejection(fault("Protocol error (Network.setCacheDisabled): Unknown CDP session bc-tab-12 for Network.setCacheDisabled"))).toBe(true)
    expect(isBenignClosedSessionRejection(fault("Protocol error (Runtime.evaluate): Cannot find context with specified id"))).toBe(false)
    const message = "Protocol error (Network.setCacheDisabled): session closed"
    const relayError = new Error(message)
    expect(isBenignClosedSessionRejection(relayError)).toBe(false)
    expect(shouldSuppressRelayProcessFault(relayError)).toBe(false)
    for (const type of ["error", "closed", "crashed"]) {
      const anonymous = Object.assign(new Error(message), { type, method: "Network.setCacheDisabled", logs: undefined })
      expect(isBenignClosedSessionRejection(anonymous)).toBe(true)
      expect(shouldSuppressRelayProcessFault(anonymous)).toBe(true)
    }
    expect(shouldSuppressRelayProcessFault(Object.assign(relayError, { method: "Network.setCacheDisabled", logs: undefined, type: "other" }))).toBe(false)
  })
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
