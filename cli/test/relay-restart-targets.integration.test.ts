import { expect, test } from "bun:test"
import type { ChildProcess } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import WebSocket from "ws"
import { cdpCall, connectCdp, FakeExtension, startRelay } from "./relay-harness.ts"

// A relay restart used to reclaim only a session's default page: every other page and popup it opened became an
// unknown tab, and the next inventory sweep closed it. The catalog now carries every relay-owned target, but only an
// inventory that marks a tab as an agent's may reclaim it, and the session's allowlist still decides before it is
// published. Targets the browser doesn't announce are pruned; deleting a session before the browser reconnects leaves
// a tombstone so its tabs still close.

const targetInfo = (tabId: number, urls: Map<number, string>) => ({
  targetId: `TARGET-${tabId}`,
  type: "page",
  title: "Example",
  url: urls.get(tabId) ?? `https://example.com/${tabId}`,
  attached: true,
  browserContextId: "CTX",
})

async function stopAndWait(child: ChildProcess | undefined) {
  if (!child) return
  const exited = new Promise<void>((resolve) => {
    if (child.exitCode !== null) resolve()
    else child.once("exit", () => resolve())
  })
  child.kill("SIGTERM")
  const exitedInTime = await Promise.race([exited.then(() => true), Bun.sleep(5_000).then(() => false)])
  if (!exitedInTime) child.kill("SIGKILL")
  await Promise.race([exited, Bun.sleep(2_000)])
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return true
    await Bun.sleep(50)
  }
  return check()
}

function catalogTargets(home: string, port: number, sessionId: string): Array<{ readonly id: string }> {
  try {
    const catalog = JSON.parse(fs.readFileSync(path.join(home, "relays", String(port), "sessions.json"), "utf8")) as {
      sessions: Array<{ id: string; targets?: Array<{ id: string }> }>
    }
    return catalog.sessions.find((entry) => entry.id === sessionId)?.targets ?? []
  } catch {
    return []
  }
}

/** Fills a session's catalog with tabs, then stops its relay as an unexpected exit would. */
async function seed(home: string, options: {
  readonly sessionId: string
  readonly tabs: readonly number[]
  readonly urls: Map<number, string>
  readonly allowedOrigins?: readonly string[]
  /** Set after the tabs exist: a session allowlist would otherwise refuse the test's blocked target at creation. */
  readonly allowedOriginsAfter?: readonly string[]
}) {
  let next = Math.min(...options.tabs)
  const relay = await startRelay(home)
  const extension = new FakeExtension(home, relay.port)
    .on("tabs.create", () => ({ tabId: next++ }))
    .on("Target.getTargetInfo", (command) => ({ targetInfo: targetInfo(Number(command.params?.tabId), options.urls) }))
  let socket: WebSocket | undefined
  try {
    expect(await extension.pair()).toBe(true)
    const response = await fetch(`http://127.0.0.1:${relay.port}/cli/session/new`, {
      method: "POST",
      headers: { authorization: `Bearer ${relay.token}`, "content-type": "application/json" },
      body: JSON.stringify({ id: options.sessionId, ...(options.allowedOrigins ? { allowedOrigins: options.allowedOrigins } : {}) }),
    })
    expect(response.ok).toBe(true)
    const connected = await connectCdp(
      `ws://127.0.0.1:${relay.port}/devtools/browser/test?opencodeBrowserSessionId=${options.sessionId}`,
      { authorization: `Bearer ${relay.token}` },
    )
    if (!(connected instanceof WebSocket)) throw new Error(`CDP connection refused: ${connected}`)
    socket = connected
    for (const [index, tabId] of options.tabs.entries()) {
      expect((await cdpCall(socket, index + 1, "Target.createTarget", { url: targetInfo(tabId, options.urls).url })).result?.targetId).toBe(`TARGET-${tabId}`)
    }
    expect(await waitFor(() => catalogTargets(home, relay.port, options.sessionId).length === options.tabs.length)).toBe(true)
    if (options.allowedOriginsAfter) {
      const allowlist = await fetch(`http://127.0.0.1:${relay.port}/cli/session/allowlist`, {
        method: "POST",
        headers: { authorization: `Bearer ${relay.token}`, "content-type": "application/json" },
        body: JSON.stringify({ id: options.sessionId, allowedOrigins: options.allowedOriginsAfter }),
      })
      expect(allowlist.ok).toBe(true)
    }
    return relay
  } finally {
    socket?.close()
    extension.close()
    await stopAndWait(relay.child)
  }
}

async function owners(port: number, token: string) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, { headers: { authorization: `Bearer ${token}` } })
  return (await response.json()) as Array<{ tabId: number; opencodeBrowserSessionId?: string }>
}

test("a fresh relay reclaims agent pages, releases an unclaimed one, and prunes stale hints", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "browse-relay-restart-"))
  const urls = new Map<number, string>()
  let secondChild: ChildProcess | undefined
  let replacement: FakeExtension | undefined
  try {
    const first = await seed(home, { sessionId: "restart-pages", tabs: [300, 301], urls })
    // A signal asks the relay to exit, and it says so before going.
    expect(fs.readFileSync(path.join(home, "logs", "relay.log"), "utf8")).toContain("relay.signal signal=SIGTERM")
    // A stale target from a page that is gone by the time the browser reconnects.
    const catalogPath = path.join(home, "relays", String(first.port), "sessions.json")
    const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8")) as { sessions: Array<{ id: string; targets?: Array<{ id: string; owner: string }> }> }
    const saved = catalog.sessions.find((entry) => entry.id === "restart-pages")
    saved?.targets?.push({ id: "TARGET-399", owner: "relay" })
    fs.writeFileSync(catalogPath, JSON.stringify(catalog))

    const started = await startRelay(home, {}, first.port)
    secondChild = started.child
    replacement = new FakeExtension(home, started.port)
      .on("Target.getTargetInfo", (command) => ({ targetInfo: targetInfo(Number(command.params?.tabId), urls) }))
    // The new relay reclaims all three announced pages; 302 is an agent tab no session claims.
    expect(await replacement.pair({ attachedTabs: [300, 301, 302], agentTabs: [300, 301, 302], capabilities: ["tab-release"] })).toBe(true)
    const reclaimed = () => owners(started.port, first.token).then((targets) =>
      [300, 301].every((tabId) => targets.some((target) => target.tabId === tabId && target.opencodeBrowserSessionId === "restart-pages")))
    expect(await waitFor(reclaimed)).toBe(true)
    const released = () => replacement?.commands.some((command) =>
      command.method === "debugger.detach" && command.params?.tabId === 302 && command.params?.release === true) ?? false
    expect(await waitFor(released)).toBe(true)
    expect(replacement.commands.some((command) => command.method === "tabs.remove" && command.params?.tabId === 302)).toBe(false)
    // TARGET-399 was never announced: it is no longer a hint for the next restart.
    expect(await waitFor(() => catalogTargets(home, first.port, "restart-pages").every((target) => target.id !== "TARGET-399"))).toBe(true)
  } finally {
    replacement?.close()
    await stopAndWait(secondChild)
    fs.rmSync(home, { recursive: true, force: true })
  }
}, 40_000)

test("deleting a session before the browser reconnects still closes its restored tabs", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "browse-relay-delete-"))
  const urls = new Map<number, string>()
  let secondChild: ChildProcess | undefined
  let replacement: FakeExtension | undefined
  try {
    const first = await seed(home, { sessionId: "restart-delete", tabs: [310, 311], urls })
    const started = await startRelay(home, {}, first.port)
    secondChild = started.child
    // No extension is connected yet: the delete only has the catalog's targets to work with.
    const deleted = await fetch(`http://127.0.0.1:${started.port}/cli/session/delete`, {
      method: "POST",
      headers: { authorization: `Bearer ${first.token}`, "content-type": "application/json" },
      body: JSON.stringify({ id: "restart-delete" }),
    })
    expect(deleted.ok).toBe(true)
    replacement = new FakeExtension(home, started.port)
      .on("Target.getTargetInfo", (command) => ({ targetInfo: targetInfo(Number(command.params?.tabId), urls) }))
    expect(await replacement.pair({ attachedTabs: [310, 311], agentTabs: [310, 311], capabilities: ["tab-release"] })).toBe(true)
    const removed = () => [310, 311].every((tabId) =>
      replacement?.commands.some((command) => command.method === "tabs.remove" && command.params?.tabId === tabId))
    expect(await waitFor(removed)).toBe(true)
    expect(replacement.commands.some((command) => command.method === "debugger.detach" && command.params?.release === true)).toBe(false)
  } finally {
    replacement?.close()
    await stopAndWait(secondChild)
    fs.rmSync(home, { recursive: true, force: true })
  }
}, 40_000)

test("a non-agent announcement and a toolbar lend never reclaim a persisted agent target", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "browse-relay-lend-"))
  const urls = new Map<number, string>()
  let secondChild: ChildProcess | undefined
  let replacement: FakeExtension | undefined
  try {
    const first = await seed(home, { sessionId: "restart-lend", tabs: [320, 321], urls })
    const started = await startRelay(home, {}, first.port)
    secondChild = started.child
    replacement = new FakeExtension(home, started.port)
      .on("Target.getTargetInfo", (command) => ({ targetInfo: targetInfo(Number(command.params?.tabId), urls) }))
    // 320 comes back without agent tracking; 321 is not announced at all and the user lends it with the toolbar.
    expect(await replacement.pair({ attachedTabs: [320], deferReady: true, capabilities: ["tab-release"] })).toBe(true)
    expect(await waitFor(async () => (await owners(started.port, first.token)).some((target) => target.tabId === 320))).toBe(true)
    replacement.emit("toolbar.clicked", { tabId: 321 })
    expect(await waitFor(async () => (await owners(started.port, first.token)).some((target) => target.tabId === 321))).toBe(true)
    const listed = await owners(started.port, first.token)
    for (const tabId of [320, 321]) {
      expect(listed.find((target) => target.tabId === tabId)?.opencodeBrowserSessionId).toBeUndefined()
    }
    replacement.sendReady()
    expect(await waitFor(() => catalogTargets(home, first.port, "restart-lend").length === 0)).toBe(true)
  } finally {
    replacement?.close()
    await stopAndWait(secondChild)
    fs.rmSync(home, { recursive: true, force: true })
  }
}, 40_000)

test("a reclaimed page must still pass the session's allowlist before it is published", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "browse-relay-allowlist-"))
  const urls = new Map([[420, "https://blocked.test/"], [421, "https://allowed.test/"]])
  let secondChild: ChildProcess | undefined
  let replacement: FakeExtension | undefined
  try {
    const first = await seed(home, { sessionId: "restart-guarded", tabs: [420, 421], urls, allowedOriginsAfter: ["https://allowed.test"] })
    const started = await startRelay(home, {}, first.port)
    secondChild = started.child
    replacement = new FakeExtension(home, started.port)
      .on("Target.getTargetInfo", (command) => ({ targetInfo: targetInfo(Number(command.params?.tabId), urls) }))
    expect(await replacement.pair({ attachedTabs: [420, 421], agentTabs: [420, 421], capabilities: ["tab-release"] })).toBe(true)
    const allowed = () => owners(started.port, first.token).then((targets) => targets.some((target) =>
      target.tabId === 421 && target.opencodeBrowserSessionId === "restart-guarded"))
    expect(await waitFor(allowed)).toBe(true)
    expect(await waitFor(() => replacement?.commands.some((command) =>
      command.method === "debugger.sendCommand" && command.params?.tabId === 420 && command.params?.method === "Page.navigate" &&
      (command.params?.params as { url?: string } | undefined)?.url === "about:blank") ?? false)).toBe(true)
    const listed = await owners(started.port, first.token)
    expect(listed.find((target) => target.tabId === 420)?.opencodeBrowserSessionId).toBeUndefined()
    expect(await waitFor(() => catalogTargets(home, first.port, "restart-guarded").every((target) => target.id !== "TARGET-420"))).toBe(true)
  } finally {
    replacement?.close()
    await stopAndWait(secondChild)
    fs.rmSync(home, { recursive: true, force: true })
  }
}, 40_000)

test("an older extension without release support still closes an unclaimed agent tab", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "browse-relay-legacy-release-"))
  const urls = new Map<number, string>()
  let secondChild: ChildProcess | undefined
  let replacement: FakeExtension | undefined
  try {
    const first = await seed(home, { sessionId: "restart-legacy", tabs: [430, 431], urls })
    const started = await startRelay(home, {}, first.port)
    secondChild = started.child
    replacement = new FakeExtension(home, started.port)
      .on("Target.getTargetInfo", (command) => ({ targetInfo: targetInfo(Number(command.params?.tabId), urls) }))
    expect(await replacement.pair({ attachedTabs: [430], agentTabs: [430] })).toBe(true)
    // 431 was in the catalog but never announced: prune it. 430 is unclaimed after its session is gone.
    expect(await waitFor(() => catalogTargets(home, first.port, "restart-legacy").every((target) => target.id !== "TARGET-431"))).toBe(true)
    const post = await fetch(`http://127.0.0.1:${started.port}/cli/session/delete`, {
      method: "POST",
      headers: { authorization: `Bearer ${first.token}`, "content-type": "application/json" },
      body: JSON.stringify({ id: "restart-legacy" }),
    })
    expect(post.ok).toBe(true)
    // The extension was paired for this inventory already; reconnecting it sees the deletion.
    replacement.close()
    replacement = new FakeExtension(home, started.port)
      .on("Target.getTargetInfo", (command) => ({ targetInfo: targetInfo(Number(command.params?.tabId), urls) }))
    expect(await replacement.pair({ attachedTabs: [430], agentTabs: [430] })).toBe(true)
    expect(await waitFor(() => replacement?.commands.some((command) =>
      command.method === "tabs.remove" && command.params?.tabId === 430) ?? false)).toBe(true)
    expect(replacement.commands.some((command) => command.method === "debugger.detach" && command.params?.release === true)).toBe(false)
  } finally {
    replacement?.close()
    await stopAndWait(secondChild)
    fs.rmSync(home, { recursive: true, force: true })
  }
}, 40_000)
