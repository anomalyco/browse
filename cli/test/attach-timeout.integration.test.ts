import { afterAll, beforeAll, expect, test } from "bun:test"
import type { ChildProcess } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import WebSocket from "ws"
import { cdpCall, connectCdp, FakeExtension, startRelay, stopRelay, until } from "./relay-harness.ts"

// Target.createTarget creates a tab and attaches its debugger before answering. A tab whose commands never answer
// (Vivaldi accepts the attach, then goes quiet) used to hold the create for the full debugger timeout: 60 s for the
// first command, and a restart waiting on the same work failed with 409 "timed out waiting for accepted work". The
// attach now has its own short command timeout, and a create whose attach fails closes the tab it opened.

const home = fs.mkdtempSync(path.join(os.tmpdir(), "browse-attach-timeout-"))
let port = 0
let relay: ChildProcess | undefined
let base = ""
let token = ""

beforeAll(async () => {
  // The harness gives every relay its own temp HOME and an ephemeral port (`freePort`), never 19988.
  const started = await startRelay(home, {
    OPENCODE_BROWSER_MANAGED_RELAY: "1",
    OPENCODE_BROWSER_ATTACH_TIMEOUT_MS: "200",
    OPENCODE_BROWSER_RESTART_TIMEOUT_MS: "1000",
  })
  relay = started.child
  port = started.port
  base = `http://127.0.0.1:${port}`
  token = started.token
}, 20_000)

afterAll(async () => {
  await stopRelay(relay)
  fs.rmSync(home, { recursive: true, force: true })
})

const targetInfo = (targetId: string, url: string) => ({ targetId, type: "page", title: url, url, attached: true, browserContextId: "CTX" })

/** A paired fake extension whose blank tab it created never answers Page.enable, plus the tabs it was asked to close. */
async function hangingAttach(tabId: number, targetId: string) {
  const state = { removed: [] as number[] }
  const extension = new FakeExtension(home, port)
    .on("tabs.create", () => ({ tabId }))
    .on("Target.getTargetInfo", () => ({ targetInfo: targetInfo(targetId, "about:blank") }))
    .on("Page.enable", () => new Promise(() => {}))
    .on("tabs.remove", (command) => {
      state.removed.push(Number(command.params?.tabId))
      return {}
    })
  expect(await extension.pair()).toBe(true)
  return { extension, state }
}

async function openClient(id: string) {
  const socket = await connectCdp(`ws://127.0.0.1:${port}/devtools/browser/test?opencodeBrowserSessionId=${id}`, { authorization: `Bearer ${token}` })
  if (!(socket instanceof WebSocket)) throw new Error(`CDP connection refused: ${socket}`)
  return socket
}

/** Answers the promise or fails the test at the deadline, so a hang is a failure instead of a timeout much later. */
function within<A>(promise: Promise<A>, ms: number, label: string): Promise<A> {
  return Promise.race([
    promise,
    Bun.sleep(ms).then(() => {
      throw new Error(`${label} did not answer within ${ms} ms`)
    }),
  ])
}

/** `until` for an asynchronous condition. */
async function untilAsync(condition: () => Promise<boolean>, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs
  while (!(await condition()) && Date.now() < deadline) await Bun.sleep(20)
  return condition()
}

test("an attach whose command never answers fails createTarget and closes the tab it created", async () => {
  const tabId = 301
  const targetId = "TARGET-301"
  const { extension, state } = await hangingAttach(tabId, targetId)
  const socket = await openClient("attach-timeout-fail")
  try {
    const begin = Date.now()
    // The attach timeout is 200 ms; the failure must not wait the 60 s debugger timeout.
    const created = await within(cdpCall(socket, 1, "Target.createTarget", { url: "https://example.com/" }), 3_000, "Target.createTarget")
    expect(Date.now() - begin).toBeLessThan(1_500)
    expect(created.error?.message).toContain("Page.enable did not answer within 200 ms")
    // The blank tab this createTarget opened is closed again, not left behind unattached.
    expect(await until(() => state.removed.includes(tabId))).toBe(true)
    const targets = (await cdpCall(socket, 2, "Target.getTargets")).result?.targetInfos as Array<{ targetId: string }> | undefined
    expect(targets?.some((target) => target.targetId === targetId) ?? false).toBe(false)
  } finally {
    socket.close()
    extension.close()
  }
}, 20_000)

test("a createTarget whose client disconnected stops blocking relay shutdown once the attach times out", async () => {
  const tabId = 302
  const targetId = "TARGET-302"
  const { extension, state } = await hangingAttach(tabId, targetId)
  const socket = await openClient("attach-timeout-shutdown")
  try {
    // Not awaited: with the fix the client never sees an answer to this create (it disconnected), and the relay must
    // not keep the shutdown waiting for it.
    void cdpCall(socket, 1, "Target.createTarget", { url: "https://example.com/" })
    expect(await until(() => extension.commands.some((command) => command.params?.method === "Page.enable"), 5_000)).toBe(true)
    socket.close()
    // A raw CDP client blocks a restart by itself; wait until the relay has let it go.
    const clientGone = async () => {
      const status = await (await fetch(`${base}/extension/status`, { headers: { authorization: `Bearer ${token}` } })).json() as { cdpClients?: number }
      return status.cdpClients === 0
    }
    expect(await untilAsync(clientGone)).toBe(true)

    const version = await (await fetch(`${base}/version`)).json() as { instanceId: string }
    const shutdown = await within(fetch(`${base}/shutdown`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        instanceId: version.instanceId,
        requestId: crypto.randomUUID(),
        reason: "explicit-restart",
        client: { kind: "cli", instanceId: "attach-timeout-test", buildId: "test" },
      }),
    }), 3_000, "POST /shutdown")
    expect(shutdown.status).toBe(200)
    expect(await shutdown.json()).toEqual({ stopping: true })
    // The failed create still closed its tab on the way out.
    expect(await until(() => state.removed.includes(tabId))).toBe(true)
  } finally {
    socket.close()
    extension.close()
  }
}, 20_000)
