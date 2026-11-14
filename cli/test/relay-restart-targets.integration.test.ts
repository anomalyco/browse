import { afterAll, expect, test } from "bun:test"
import type { ChildProcess } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import WebSocket from "ws"
import { cdpCall, connectCdp, FakeExtension, startRelay } from "./relay-harness.ts"

// A relay restart used to reclaim only a session's default page: every other page and popup it opened became an
// unknown tab, and the next inventory sweep closed it. The catalog now carries every relay-owned target.

const home = fs.mkdtempSync(path.join(os.tmpdir(), "browse-relay-restart-"))
afterAll(() => fs.rmSync(home, { recursive: true, force: true }))

const targetInfo = (tabId: number) => ({
  targetId: `TARGET-${tabId}`,
  type: "page",
  title: "Example",
  url: `https://example.com/${tabId}`,
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

test("a fresh relay reclaims every relay-owned page a session held", async () => {
  const first = await startRelay(home)
  let next = 300
  const extension = new FakeExtension(home, first.port)
    .on("tabs.create", () => ({ tabId: next++ }))
    .on("Target.getTargetInfo", (command) => ({ targetInfo: targetInfo(Number(command.params?.tabId)) }))
  let secondChild: ChildProcess | undefined
  let secondPort = 0
  let socket: WebSocket | undefined
  let replacement: FakeExtension | undefined
  try {
    expect(await extension.pair()).toBe(true)
    const base = `http://127.0.0.1:${first.port}`
    const session = await fetch(`${base}/cli/session/new`, {
      method: "POST",
      headers: { authorization: `Bearer ${first.token}`, "content-type": "application/json" },
      body: JSON.stringify({ id: "restart-pages" }),
    })
    expect(session.ok).toBe(true)
    const connected = await connectCdp(
      `ws://127.0.0.1:${first.port}/devtools/browser/test?opencodeBrowserSessionId=restart-pages`,
      { authorization: `Bearer ${first.token}` },
    )
    if (!(connected instanceof WebSocket)) throw new Error(`CDP connection refused: ${connected}`)
    socket = connected
    expect((await cdpCall(socket, 1, "Target.createTarget", { url: "https://example.com/300" })).result?.targetId).toBe("TARGET-300")
    expect((await cdpCall(socket, 2, "Target.createTarget", { url: "https://example.com/301" })).result?.targetId).toBe("TARGET-301")

    const catalogPath = path.join(home, "relays", String(first.port), "sessions.json")
    const written = () => {
      try {
        const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8")) as {
          sessions: Array<{ id: string; targets?: Array<{ id: string; owner: string }> }>
        }
        return catalog.sessions.find((entry) => entry.id === "restart-pages")?.targets ?? []
      } catch {
        return []
      }
    }
    for (let attempt = 0; attempt < 100 && written().length < 2; attempt++) await Bun.sleep(50)
    expect(written()).toEqual([
      { id: "TARGET-300", owner: "relay" },
      { id: "TARGET-301", owner: "relay" },
    ])

    extension.close()
    socket.close()
    socket = undefined
    await stopAndWait(first.child)
    // An exit is never silent: the signal and the shutdown it started are in the relay log.
    const log = fs.readFileSync(path.join(home, "logs", "relay.log"), "utf8")
    expect(log).toContain("relay.signal signal=SIGTERM")
    expect(log).toContain("relay.shutdown.start")
    const started = await startRelay(home, {}, first.port)
    secondChild = started.child
    secondPort = started.port

    replacement = new FakeExtension(home, secondPort)
      .on("Target.getTargetInfo", (command) => ({ targetInfo: targetInfo(Number(command.params?.tabId)) }))
    // The new relay knows these tabs only by their persisted target ids; both still belong to the session.
    // 302 is an agent tab no session claims and this relay has no record of: it is released, not closed.
    expect(await replacement.pair({ attachedTabs: [300, 301, 302], agentTabs: [302] })).toBe(true)
    const owners = async () => {
      const response = await fetch(`http://127.0.0.1:${secondPort}/json/list`, { headers: { authorization: `Bearer ${first.token}` } })
      return (await response.json()) as Array<{ tabId: number; opencodeBrowserSessionId?: string }>
    }
    const released = () => replacement?.commands.some((command) =>
      command.method === "debugger.detach" && command.params?.tabId === 302 && command.params?.release === true) ?? false
    for (let attempt = 0; attempt < 100 && !released(); attempt++) await Bun.sleep(50)
    expect(released()).toBe(true)
    expect(replacement.commands.some((command) => command.method === "tabs.remove" && command.params?.tabId === 302)).toBe(false)
    const reclaimed = () => owners().then((targets) =>
      [300, 301].every((tabId) => targets.some((target) => target.tabId === tabId && target.opencodeBrowserSessionId === "restart-pages")))
    for (let attempt = 0; attempt < 100 && !(await reclaimed()); attempt++) await Bun.sleep(50)
    expect(await reclaimed()).toBe(true)
  } finally {
    replacement?.close()
    socket?.close()
    extension.close()
    await stopAndWait(secondChild)
    await stopAndWait(first.child)
  }
}, 40_000)
