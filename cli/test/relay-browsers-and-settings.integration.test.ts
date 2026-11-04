import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import WebSocket from "ws"
import { revokeBrowserToken } from "../src/browser-pairing.ts"
import { stableUnpackedExtensionOrigin } from "../src/relay-helpers.ts"
import {
  cdpCall,
  collect,
  connectCdp,
  FakeExtension,
  startRelay,
  stopRelay,
  until,
} from "./relay-harness.ts"

const home = fs.mkdtempSync(path.join(os.tmpdir(), "browse-relay-settings-"))
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

describe("several browsers", () => {
  const multiHome = fs.mkdtempSync(path.join(os.tmpdir(), "browse-multi-"))
  let multi: Awaited<ReturnType<typeof startRelay>> | undefined
  beforeAll(async () => {
    multi = await startRelay(multiHome)
  }, 20_000)
  afterAll(async () => {
    await stopRelay(multi?.child)
    fs.rmSync(multiHome, { recursive: true, force: true })
  })

  // Both browsers number their new tab 7, as two Chromes easily do.
  const browser = (targetId: string) => new FakeExtension(multiHome, multi!.port)
    .on("tabs.create", () => ({ tabId: 7 }))
    .on("Target.getTargetInfo", () => ({ targetInfo: { targetId, type: "page", title: targetId, url: "https://example.com/", attached: true, browserContextId: "CTX" } }))
    .on("Page.getFrameTree", () => ({ frameTree: { frame: { id: targetId, loaderId: "L", url: "https://example.com/", domainAndRegistry: "", securityOrigin: "https://example.com", mimeType: "text/html", secureContextType: "Secure", crossOriginIsolatedContextType: "NotIsolated", gatedAPIFeatures: [] } } }))
    .on("Runtime.evaluate", () => ({ result: { type: "string", value: targetId } }))
  const api = (pathname: string, body?: unknown) => fetch(`http://127.0.0.1:${multi!.port}${pathname}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${multi!.token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  /** A session's new tab, opened over CDP, and the answer to an evaluate in it. */
  const openTab = async (session: string) => {
    const socket = await connectCdp(`ws://127.0.0.1:${multi!.port}/devtools/browser/test?opencodeBrowserSessionId=${session}`, { authorization: `Bearer ${multi!.token}` })
    if (!(socket instanceof WebSocket)) throw new Error(`CDP connection refused: ${socket}`)
    const created = await cdpCall(socket, 1, "Target.createTarget", { url: "https://example.com/" })
    const attached = await cdpCall(socket, 2, "Target.attachToTarget", { targetId: String(created.result?.targetId), flatten: true })
    const evaluated = await cdpCall(socket, 3, "Runtime.evaluate", { expression: "1" }, String(attached.result?.sessionId))
    socket.close()
    expect(created.error).toBeUndefined()
    return { targetId: created.result?.targetId, value: (evaluated.result?.result as { value?: string } | undefined)?.value }
  }

  const execute = (sessionId: string, selector?: string) => api("/cli/execute", {
    sessionId, code: "return page.url()", createIfMissing: true, ...(selector ? { browser: selector } : {}),
  })

  test("browser affinity: an implicit execute refuses a switch before running code", async () => {
    const a = browser("IMPLICIT-A")
    let b: FakeExtension | undefined
    try {
      expect(await a.pair({ hello: { profileId: "implicit-a", name: "First Lane" } })).toBe(true)
      b = browser("IMPLICIT-B")
      expect(await b.pair({ hello: { profileId: "implicit-b", name: "Second Lane" } })).toBe(true)
      const id = "implicit-affinity"
      expect(await (await execute(id)).json()).toMatchObject({ isError: false, value: "https://example.com/" })
      const conflict = await api("/cli/execute", { sessionId: id, createIfMissing: true, browser: "second-lane", code: "return (await context.newPage()).url()" })
      expect(conflict.status).toBe(400)
      expect(await conflict.text()).toMatch(/implicit-affinity.*first-lane.*new session/i)
      expect(await (await execute(id, "First Lane")).json()).toMatchObject({ isError: false, session: { browser: "first-lane" } })
      expect(b.commands.filter(cmd => cmd.method === "tabs.create")).toHaveLength(0)
      expect(await (await execute("explicit-affinity", "Second Lane")).json()).toMatchObject({ isError: false, session: { browser: "second-lane" } })
      expect(await (await execute("explicit-affinity")).json()).toMatchObject({ isError: false, session: { browser: "second-lane" } })
      expect(b.commands.filter(cmd => cmd.method === "tabs.create")).toHaveLength(1)
    } finally { a.close(); b?.close() }
  }, 30_000)

  test("browser affinity: disconnect cannot move an existing session, and revocation explains recovery", async () => {
    const a = browser("OFFLINE-A")
    let b: FakeExtension | undefined
    const hello = { profileId: "offline-a", name: "Offline A" }
    const id = "offline-affinity"
    let back: FakeExtension | undefined
    try {
      expect(await a.pair({ hello })).toBe(true)
      b = browser("ONLINE-B")
      expect(await b.pair({ hello: { profileId: "online-b", name: "Online B" } })).toBe(true)
      expect((await api("/cli/session/new", { id })).ok).toBe(true)
      a.close()
      expect(await until(() => a.closeCode !== undefined)).toBe(true)
      const offline = await execute(id)
      expect(offline.status).toBe(503)
      expect(await offline.text()).toMatch(/offline-affinity.*offline.a.*connect.*new session/i)
      expect(b.commands.filter(cmd => cmd.method === "tabs.create")).toHaveLength(0)
      expect(await (await api("/v1/sessions/ensure", { id: "new-default" })).json()).toMatchObject({ session: { browser: "online-b" } })
      expect((await openTab("new-default")).targetId).toBe("ONLINE-B")
      back = browser("RECONNECTED-A")
      expect(await back.pair({ hello: { ...hello, name: "Returned A" } })).toBe(true)
      expect((await openTab(id)).targetId).toBe("RECONNECTED-A")
      expect(revokeBrowserToken(hello.profileId, multiHome)).toBe(true)
      expect((await api("/extension/revoke", { key: hello.profileId })).ok).toBe(true)
      expect(await until(() => back!.closeCode === 4006)).toBe(true)
      expect(await (await execute(id)).text()).toMatch(/offline-affinity.*revoked.*new session/i)
      b.close()
      expect(await until(() => b!.closeCode !== undefined)).toBe(true)
      const cli = spawnSync(process.execPath, [path.join(import.meta.dir, "../src/main.ts"), "execute", "--session", id, "return 1"], {
        env: { PATH: process.env.PATH, HOME: multiHome, OPENCODE_BROWSER_HOME: multiHome, OPENCODE_BROWSER_PORT: String(multi!.port), OPENCODE_BROWSER_UPDATE_CHECK: "0" },
        encoding: "utf8", timeout: 10_000,
      })
      expect(cli.status).toBe(4)
      expect(cli.stderr).toMatch(/offline-affinity.*revoked.*new session/i)
    } finally { a.close(); b?.close(); back?.close() }
  }, 30_000)

  test("browser affinity: shared tabs in another profile cannot be selected or adopted", async () => {
    const a = browser("VISIBLE-A")
    let b: FakeExtension | undefined
    let client: WebSocket | undefined
    try {
      expect(await a.pair({ hello: { profileId: "visible-a", name: "Visible A" } })).toBe(true)
      b = browser("SHARED-B")
      expect(await b.pair({ hello: { profileId: "shared-b", name: "Shared B" }, attachedTabs: [707] })).toBe(true)
      const id = "visible-affinity"
      expect((await api("/cli/session/new", { id })).ok).toBe(true)
      const targets = await (await api("/json/list")).json() as Array<{ id: string; tabId: number }>
      const shared = targets.find(t => t.id === "SHARED-B")
      expect(shared).toBeDefined()
      const socket = await connectCdp(`ws://127.0.0.1:${multi!.port}/devtools/browser/test?opencodeBrowserSessionId=${id}`, { authorization: `Bearer ${multi!.token}` })
      if (!(socket instanceof WebSocket)) throw new Error(`CDP connection refused: ${socket}`)
      client = socket
      expect((await cdpCall(client, 1, "Target.getTargets")).result?.targetInfos).toEqual([])
      const adopt = await api("/cli/session/adopt", { sessionId: id, createIfMissing: false, tabId: shared!.tabId })
      expect(adopt.status).toBe(400)
      expect(await adopt.text()).toMatch(/another browser.*new session/i)
    } finally { a.close(); b?.close(); client?.close() }
  }, 20_000)

  test("browser affinity: relay restart keeps the original browser before any tab was opened", async () => {
    const a = browser("BEFORE-RESTART")
    expect(await a.pair({ hello: { profileId: "restart-a", name: "Restart A" } })).toBe(true)
    const id = "restart-affinity"
    expect((await api("/cli/session/new", { id })).ok).toBe(true)
    a.close()
    await stopRelay(multi!.child)
    multi = await startRelay(multiHome, {}, multi!.port)
    const b = browser("AFTER-RESTART-B")
    let back: FakeExtension | undefined
    try {
      expect(await b.pair({ hello: { profileId: "restart-b", name: "Restart B" } })).toBe(true)
      back = browser("AFTER-RESTART-A")
      expect(await back.pair({ hello: { profileId: "restart-a", name: "Restart A" } })).toBe(true)
      expect((await openTab(id)).targetId).toBe("AFTER-RESTART-A")
    } finally { b.close(); back?.close() }
  }, 30_000)

  test("browsers connect side by side, each named, the first the default; sessions open tabs in theirs", async () => {
    const work = browser("TARGET-WORK")
    expect(await work.pair({ hello: { profileId: "work", name: "Work Chrome" } })).toBe(true)
    const homeBrowser = browser("TARGET-HOME")
    expect(await homeBrowser.pair({ hello: { profileId: "home", name: "Home Brave" } })).toBe(true)
    await Bun.sleep(100)
    // The second browser didn't push the first one out.
    expect(work.socket.readyState).toBe(WebSocket.OPEN)
    const status = await (await api("/extension/status")).json() as { browsers: { id: string; name: string; default: boolean }[] }
    expect(status.browsers.map(({ id, name, default: isDefault }) => ({ id, name, isDefault }))).toEqual([
      { id: "work-chrome", name: "Work Chrome", isDefault: true },
      { id: "home-brave", name: "Home Brave", isDefault: false },
    ])

    const unknown = await api("/cli/session/new", { id: "on-nothing", browser: "nope" })
    expect(unknown.status).toBe(400)
    expect(await unknown.text()).toContain("work-chrome")
    expect((await api("/cli/session/new", { id: "on-home", browser: "home-brave" })).ok).toBe(true)
    expect((await api("/cli/session/new", { id: "on-default" })).ok).toBe(true)

    // Each session's tab opens in its browser, and commands for it go there, with that browser's own tab id.
    expect(await openTab("on-home")).toEqual({ targetId: "TARGET-HOME", value: "TARGET-HOME" })
    expect(await openTab("on-default")).toEqual({ targetId: "TARGET-WORK", value: "TARGET-WORK" })
    expect(homeBrowser.commands.filter((command) => command.method === "tabs.create")).toHaveLength(1)
    expect(work.commands.filter((command) => command.method === "tabs.create")).toHaveLength(1)
    for (const extension of [homeBrowser, work])
      expect(extension.commands.filter((command) => command.method === "debugger.sendCommand").every((command) => command.params?.tabId === 7)).toBe(true)

    // A browser going away takes only its own tabs.
    homeBrowser.close()
    await Bun.sleep(200)
    const targets = await (await api("/json/list")).json() as { id: string }[]
    expect(targets.map((target) => target.id)).toEqual(["TARGET-WORK"])
    const after = await (await api("/extension/status")).json() as { browsers: { id: string }[] }
    expect(after.browsers.map((entry) => entry.id)).toEqual(["work-chrome"])
    work.close()
  }, 20_000)
})

// `set hostname 0.0.0.0`, reached through this machine's own network address: a connection from it isn't loopback,
// so the relay treats it as another computer.
const lanAddress = Object.values(os.networkInterfaces()).flat().find((address) => address?.family === "IPv4" && !address.internal)?.address
describe.skipIf(lanAddress === undefined)("a browser on another computer (hostname 0.0.0.0)", () => {
  const remoteHome = fs.mkdtempSync(path.join(os.tmpdir(), "browse-remote-"))
  let remote: Awaited<ReturnType<typeof startRelay>> | undefined
  beforeAll(async () => {
    fs.writeFileSync(path.join(remoteHome, "config.json"), JSON.stringify({ hostname: "0.0.0.0" }))
    remote = await startRelay(remoteHome)
  }, 20_000)
  afterAll(async () => {
    await stopRelay(remote?.child)
    fs.rmSync(remoteHome, { recursive: true, force: true })
  })

  test("the extension pairs over the network, and a wrong code is refused there too", async () => {
    const extension = new FakeExtension(remoteHome, remote!.port, lanAddress)
    expect(await extension.pair()).toBe(true)
    extension.socket.close()
    await Bun.sleep(100)
    const impostor = new FakeExtension(fs.mkdtempSync(path.join(remoteHome, "other-")), remote!.port, lanAddress)
    expect(await impostor.pair({ answerAnyway: true })).toBe(false)
    await Bun.sleep(100)
    expect(impostor.closeCode).toBe(4006)
  })

  test("only the extension link is served to the network: no HTTP API, no CDP, no web pages", async () => {
    const remoteBase = `http://${lanAddress}:${remote!.port}`
    expect((await fetch(`${remoteBase}/version`)).status).toBe(404)
    expect((await fetch(`${remoteBase}/json/version`, { headers: { authorization: `Bearer ${remote!.token}` } })).status).toBe(404)
    const refused = (url: string, origin?: string) =>
      new Promise<boolean>((resolve) => {
        const socket = new WebSocket(url, { ...(origin ? { origin } : {}), headers: { authorization: `Bearer ${remote!.token}` } })
        socket.once("open", () => {
          socket.close()
          resolve(false)
        })
        socket.once("error", () => resolve(true))
      })
    expect(await refused(`ws://${lanAddress}:${remote!.port}/devtools/browser/x`)).toBe(true)
    expect(await refused(`ws://${lanAddress}:${remote!.port}/extension`, "https://evil.example")).toBe(true)
    const older = new WebSocket(`ws://${lanAddress}:${remote!.port}/extension`, { origin: stableUnpackedExtensionOrigin })
    const frames = collect(older)
    older.once("open", () => older.send(JSON.stringify({ method: "protocol", params: { protocolVersion: 2 } })))
    expect(await new Promise<[number, string]>(resolve => older.once("close", (code, reason) => resolve([code, reason.toString()]))))
      .toEqual([4003, "Extension protocol incompatible: extension-older"])
    expect(frames).toEqual([])
    // This computer's agents still use 127.0.0.1.
    expect((await fetch(`http://127.0.0.1:${remote!.port}/version`)).ok).toBe(true)
  })
})

describe("sessions of MCP servers that went away", () => {
  test("an implicit session is deleted once its MCP server has been gone for the grace period; a named one stays", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "browse-orphans-"))
    const started = await startRelay(root, { OPENCODE_BROWSER_CLIENT_GONE_GRACE_MS: "1000" })
    try {
      expect(await new FakeExtension(root, started.port).pair()).toBe(true)
      const client = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore" })
      const ensure = (id: string) => fetch(`http://127.0.0.1:${started.port}/v1/sessions/ensure`, {
        method: "POST",
        headers: { authorization: `Bearer ${started.token}`, "content-type": "application/json", "opencode-browser-client-pid": String(client.pid) },
        body: JSON.stringify({ id }),
      })
      expect((await ensure("mcp-0123abcd")).ok).toBe(true)
      expect((await ensure("named-work")).ok).toBe(true)
      const ids = async () => ((await (await fetch(`http://127.0.0.1:${started.port}/cli/sessions`, { headers: { authorization: `Bearer ${started.token}` } })).json()) as { sessions: { id: string }[] }).sessions.map((session) => session.id).sort()
      // Alive: nothing happens past the grace period.
      await Bun.sleep(1_800)
      expect(await ids()).toEqual(["mcp-0123abcd", "named-work"])
      client.kill("SIGKILL")
      for (let i = 0; i < 60 && (await ids()).includes("mcp-0123abcd"); i++) await Bun.sleep(100)
      expect(await ids()).toEqual(["named-work"])
    } finally {
      await stopRelay(started.child)
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 30_000)
})

describe("settings from the extension", () => {
  test("cursor and human input follow the extension's settings at runtime; invalid values change nothing", async () => {
    const scene = await settingsScene({ relayPort: port, relayToken: token, code: home, tabId: 81, settings: { cursor: "always", humanInput: "off" } })
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
    const scene = await settingsScene({ relayPort: port, relayToken: token, code: home, tabId: 84, settings: { cursor: "always", humanInput: "off" } })
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
    const first = await settingsScene({ relayPort: port, relayToken: token, code: home, tabId: 82, settings: { cursor: "always", humanInput: "off" } })
    expect(await until(() => first.overrides().length === 1)).toBe(true)
    first.close()
    await Bun.sleep(200)
    const older = await settingsScene({ relayPort: port, relayToken: token, code: home, tabId: 83 })
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
      const scene = await settingsScene({ relayPort: started.port, relayToken: started.token, code: root, tabId: 91, settings: { cursor: "off", humanInput: "on" } })
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

/** A fake extension holding settings the way the real one does (settings.get / settings.set over its storage). */
function settingsExtension(code: string, relayPort = port) {
  const stored: Record<string, unknown> = { window: "current", grouping: "session", idleMinutes: 10, cursor: "off", humanInput: "on", handoffNotifications: "recording" }
  const extension = new FakeExtension(code, relayPort)
    .on("settings.get", () => ({ settings: { ...stored } }))
    .on("settings.set", (command) => {
      Object.assign(stored, command.params?.values as Record<string, unknown>)
      return { settings: { ...stored } }
    })
  return { extension, stored, sets: () => extension.commands.filter((command) => command.method === "settings.set").map((command) => command.params?.values) }
}

async function settingsRequest(relayBase: string, relayToken: string, set?: Record<string, unknown>) {
  const response = await fetch(`${relayBase}/settings`, {
    method: set ? "POST" : "GET",
    headers: { authorization: `Bearer ${relayToken}`, "content-type": "application/json" },
    ...(set ? { body: JSON.stringify({ set }) } : {}),
  })
  return { status: response.status, body: await response.json() as Record<string, any> }
}

describe("the settings tool's relay API", () => {
  test("get and set round-trip through the extension, strictly validated", async () => {
    const { extension, stored, sets } = settingsExtension(home)
    expect(await extension.pair()).toBe(true)
    const got = await settingsRequest(base, token)
    expect(got.status).toBe(200)
    expect(got.body.settings.grouping).toMatchObject({ value: "session", effective: "session", allowed: ["session", "shared", "none"] })
    expect(got.body.settings.cursor.overriddenBy).toBeUndefined()
    expect(got.body.note).toContain("OPENCODE_BROWSER_ALLOW_NODE")

    const set = await settingsRequest(base, token, { grouping: "shared", cursor: "always", idleMinutes: "never", humanInput: "on" })
    expect(set.status).toBe(200)
    expect(sets()).toEqual([{ grouping: "shared", cursor: "always", idleMinutes: 0, humanInput: "on" }])
    expect(stored).toMatchObject({ grouping: "shared", cursor: "always", idleMinutes: 0 })
    expect(set.body.changed).toEqual([
      { key: "grouping", from: "session", to: "shared" },
      { key: "cursor", from: "off", to: "always" },
      { key: "idleMinutes", from: 10, to: "never" },
    ])
    expect(set.body.unchanged).toEqual(["humanInput"])
    expect(set.body.message).toContain("Tell the user what you changed")
    expect((await settingsRequest(base, token)).body.settings.idleMinutes.value).toBe("never")

    // Invalid values, unknown keys and security switches are refused before anything reaches the extension.
    for (const [request, expected] of [
      [{ grouping: "Shared" }, "grouping must be one of session, shared, none"],
      [{ idleMinutes: 45 }, "idleMinutes must be one of 10, 30, 60, never"],
      [{ cursor: true }, "cursor must be one of off, always"],
      [{ colour: "blue" }, "Unknown setting \"colour\""],
      [{ OPENCODE_BROWSER_ALLOW_NODE: "1" }, "security switches"],
      [{ grouping: "none", allowAllCookies: true }, "security switches"],
      [{}, "Nothing to change"],
    ] as const) {
      const refused = await settingsRequest(base, token, request)
      expect(refused.status).toBe(400)
      expect(String(refused.body.error)).toContain(expected)
    }
    expect(sets()).toHaveLength(1)
    extension.close()
    await Bun.sleep(200)
  }, 20_000)

  test("without an extension, or with one too old for settings, the answer says what to do", async () => {
    const missing = await settingsRequest(base, token)
    expect(missing.status).toBeGreaterThanOrEqual(400)
    expect(String(missing.body.error)).toContain("extension isn't connected")
    const older = new FakeExtension(home, port)
      .on("settings.get", () => { throw new Error("Invalid extension command") })
    expect(await older.pair()).toBe(true)
    const tooOld = await settingsRequest(base, token, { grouping: "shared" })
    expect(String(tooOld.body.error)).toContain("too old to read or change settings")
    older.close()
    await Bun.sleep(200)
  }, 20_000)

  test("a setting an environment variable fixes is reported, and not written", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "browse-relay-settings-env-"))
    const started = await startRelay(root, { OPENCODE_BROWSER_GHOST_CURSOR: "0", OPENCODE_BROWSER_AGENT_WINDOW: "separate" })
    try {
      const { extension, sets } = settingsExtension(root, started.port)
      expect(await extension.pair()).toBe(true)
      const relayBase = `http://127.0.0.1:${started.port}`
      const got = await settingsRequest(relayBase, started.token)
      expect(got.body.settings.cursor).toMatchObject({ value: "off", effective: "off", overriddenBy: "OPENCODE_BROWSER_GHOST_CURSOR" })
      expect(got.body.settings.window).toMatchObject({ value: "current", effective: "separate", overriddenBy: "OPENCODE_BROWSER_AGENT_WINDOW" })
      expect(got.body.settings.humanInput.overriddenBy).toBeUndefined()
      const set = await settingsRequest(relayBase, started.token, { cursor: "always", grouping: "none" })
      expect(set.status).toBe(200)
      expect(sets()).toEqual([{ grouping: "none" }])
      expect(set.body.overridden).toEqual([{ key: "cursor", requested: "always", variable: "OPENCODE_BROWSER_GHOST_CURSOR", effective: "off" }])
      expect(set.body.message).toContain("Not changed: cursor is fixed to off by OPENCODE_BROWSER_GHOST_CURSOR")
      expect(set.body.message).toContain("relay restart")
      extension.close()
    } finally {
      await stopRelay(started.child)
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 30_000)
})
