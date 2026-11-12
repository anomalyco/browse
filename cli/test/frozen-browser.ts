// Linux chrome-freeze chaos: run against Chrome for Testing after building the extension and CLI.
import assert from "node:assert/strict"
import fs from "node:fs"
import { relayToken } from "../src/relay/secrets.ts"
import { startBrowserScene } from "./support/browser-scene.ts"

const scene = await startBrowserScene({ name: "frozen-browser-" })
const api = async (route: string, body?: unknown) => (await fetch(scene.base + route, {
  headers: { authorization: `Bearer ${relayToken(scene.home)}`, "content-type": "application/json" },
  ...(body ? { method: "POST", body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20_000),
})).json()
const execute = () => api("/cli/execute", { sessionId: "freeze", code: "return await page.title()", createIfMissing: false })
let frozen: number[] = []
try {
  await api("/cli/session/new", { id: "freeze" })
  assert.equal((await execute()).isError, false)
  const cdp = await scene.browser.browser()!.newBrowserCDPSession()
  const { processInfo } = await cdp.send("SystemInfo.getProcessInfo")
  for (const { id } of processInfo) {
    process.kill(id, "SIGSTOP")
    frozen.push(id)
  }
  const start = Date.now()
  const result = await execute()
  assert.match(result.text ?? result.error, /browser isn't answering.*asleep, frozen or very busy/i)
  assert.equal((await api("/extension/status")).connected, false)
  console.log(`Frozen execute: ${Date.now() - start} ms; ${result.text ?? result.error}`)
  for (const pid of frozen) process.kill(pid, "SIGCONT")
  frozen = []
  for (let i = 0; i < 100 && !(await api("/extension/status")).connected; i++) await new Promise(r => setTimeout(r, 100))
  assert.equal((await execute()).isError, false, "same session works after thaw")
  // With no calls in flight the periodic heartbeat, not an execute, must mark the browser offline.
  for (const { id } of (await cdp.send("SystemInfo.getProcessInfo")).processInfo) {
    process.kill(id, "SIGSTOP")
    frozen.push(id)
  }
  const idle = Date.now()
  // One keepalive interval (20 s) plus the ping timeout (10 s), with margin.
  while (Date.now() - idle < 35_000 && (await api("/extension/status")).connected) await new Promise(r => setTimeout(r, 200))
  assert.equal((await api("/extension/status")).connected, false, "idle heartbeat detects a frozen worker")
  console.log(`Idle freeze detected in ${Date.now() - idle} ms`)
} finally {
  for (const pid of frozen) { try { process.kill(pid, "SIGCONT") } catch {} }
  await scene.stop()
  fs.rmSync(scene.root, { recursive: true, force: true })
}
