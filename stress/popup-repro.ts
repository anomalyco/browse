// Isolated native-browser crash probe. Never points at an existing profile or relay.
import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import net from "node:net"
import http from "node:http"
import { setTimeout as sleep } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { mintPairingCode } from "../cli/src/relay/browser-pairing.ts"
import { relayToken } from "../cli/src/relay/secrets.ts"

const checkout = fileURLToPath(new URL("..", import.meta.url))
const bun = process.env.BUN ?? "bun"
const executable = process.env.POPUP_BROWSER ?? "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
// Fail before starting either child when the probe's prerequisites aren't installed.
fs.accessSync(executable, fs.constants.X_OK)
fs.accessSync(path.join(checkout, "dist", "manifest.json"))
if (spawnSync(bun, ["--version"], { stdio: "ignore" }).status !== 0) throw new Error("Bun is required for the source relay")
const root = fs.mkdtempSync(path.join(os.tmpdir(), "browse-popup-"))
const freePort = () => new Promise<number>((resolve) => {
  const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)) })
})
const port = await freePort()
const env = { ...process.env, OPENCODE_BROWSER_HOME: root, OPENCODE_BROWSER_PORT: String(port), OPENCODE_BROWSER_UPDATE_CHECK: "0", OPENCODE_BROWSER_DEBUG: "1", OPENCODE_BROWSER_HUMAN_INPUT: "0" }
const relay = spawn(bun, ["cli/src/main.ts", "serve"], { cwd: checkout, env, stdio: ["ignore", "pipe", "pipe"] })
let relayLog = ""
relay.stdout.on("data", d => { relayLog += d }); relay.stderr.on("data", d => { relayLog += d })
const browser = spawn(executable, ["--headless=new", `--user-data-dir=${root}/profile`, "--remote-debugging-port=0", `--load-extension=${checkout}/dist`, `--disable-extensions-except=${checkout}/dist`, "--no-first-run", "--no-default-browser-check", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] })
let browserLog = ""
browser.stderr.on("data", d => { browserLog += d })
browser.once("exit", (code, signal) => console.log("Browser exit", { code, signal }))
let socket: WebSocket | undefined
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()
let id = 0
function send(method: string, params: object = {}, sessionId?: string): Promise<any> {
  const n = ++id
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(n); reject(new Error(`${method} timeout`)) }, 10000)
    pending.set(n, { resolve, reject, timer }); socket!.send(JSON.stringify({ id: n, method, params, sessionId }))
  })
}
async function until<T>(read: () => Promise<T | undefined>, label: string): Promise<T> {
  for (let i = 0; i < 450; i++) {
    if (browser.exitCode !== null || browser.signalCode) throw new Error(`Browser exited: ${browser.exitCode}/${browser.signalCode}`)
    const result = await read(); if (result) return result
    await sleep(100)
  }
  throw new Error(`${label} not ready`)
}
async function cli(args: string[]) {
  const child = spawn(bun, ["cli/src/main.ts", ...args], { cwd: checkout, env, stdio: ["ignore", "pipe", "pipe"] })
  let out = "", err = ""
  child.stdout.on("data", d => { out += d }); child.stderr.on("data", d => { err += d })
  const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve) })
  if (code) throw new Error(`CLI ${args[0]} failed: ${out} ${err}`)
  return out
}
try {
  const wsUrl = await until(async () => browserLog.match(/DevTools listening on (ws:\/\/\S+)/)?.[1], "browser")
  socket = new WebSocket(wsUrl)
  await new Promise<void>((resolve, reject) => { socket!.onopen = () => resolve(); socket!.onerror = () => reject(new Error("CDP open failed")) })
  socket.onmessage = event => {
    const m = JSON.parse(String(event.data)); const p = pending.get(m.id); if (!p) return
    pending.delete(m.id); clearTimeout(p.timer); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result)
  }
  socket.onclose = () => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error("Browser CDP closed")) }; pending.clear() }
  console.log("Browser", (await send("Browser.getVersion")).product)
  const worker = await until(async () => (await send("Target.getTargets")).targetInfos.find((t: any) => t.type === "service_worker" && t.url === "chrome-extension://afeafocngkodbmaipcngoamamfmekgfo/background.js"), "extension")
  await until(async () => fetch(`http://127.0.0.1:${port}/version`).then(r => r.ok, () => false), "relay")
  const { sessionId } = await send("Target.attachToTarget", { targetId: worker.targetId, flatten: true })
  await until(async () => (await send("Runtime.evaluate", { expression: "typeof chrome !== 'undefined' && !!chrome.storage?.local", returnByValue: true }, sessionId)).result?.value, "extension storage")
  const code = mintPairingCode(root)
  const configured = await send("Runtime.evaluate", { expression: `chrome.storage.local.set({agentRelayPort:${port},agentRelayPairingCode:${JSON.stringify(code)}})`, awaitPromise: true }, sessionId)
  if (configured.exceptionDetails) throw new Error(`Extension configuration failed: ${configured.exceptionDetails.exception?.description?.replaceAll(code, "<redacted>") ?? configured.exceptionDetails.text}`)
  await send("Target.detachFromTarget", { sessionId })
  const token = relayToken(root)
  await until(async () => fetch(`http://127.0.0.1:${port}/extension/status`, { headers: { authorization: `Bearer ${token}` } }).then(r => r.json()).then((s: any) => s.connected), "paired extension")
  const fixture = http.createServer((request, response) => {
    response.setHeader("content-type", "text/html")
    const destination = request.url === "/blocked" ? `http://localhost:${(fixture.address() as net.AddressInfo).port}/auth` : "/auth"
    response.end(request.url === "/auth" ? "<h1>OAuth consent fixture</h1>" : `<button onclick="window.popup=window.open('${destination}','oauth','popup,width=500,height=600')">Connect</button>`)
  })
  await new Promise<void>(resolve => fixture.listen(0, "127.0.0.1", resolve))
  const fixturePort = (fixture.address() as net.AddressInfo).port
  try {
    for (const allowlisted of [false, true]) {
      const session = allowlisted ? "popup-allowed" : "popup-unrestricted"
      await cli(["session", "new", session, ...(allowlisted ? ["--allow-origin", "127.0.0.1"] : [])])
      const result = await cli(["execute", "--json", "--session", session, `await page.goto('http://127.0.0.1:${fixturePort}/'); const [p] = await Promise.all([page.waitForEvent('popup', {timeout:30000}), page.getByRole('button', {name:'Connect'}).click({timeout:30000})]); await p.getByRole('heading', {name:'OAuth consent fixture'}).waitFor({timeout:30000}); return {popup:p.url(),openerAlive:await page.title(),pages:context.pages().length}`])
      const receipt = JSON.parse(result)
      if (!receipt.ok || receipt.value?.pages !== 2) throw new Error(`Popup execute failed: ${result}`)
      console.log("PASS", session, receipt.value, (await send("Browser.getVersion")).product)
      await cli(["session", "delete", session])
    }
    await cli(["session", "new", "popup-blocked", "--allow-origin", "127.0.0.1"])
    const blocked = JSON.parse(await cli(["execute", "--json", "--session", "popup-blocked", `await page.goto('http://127.0.0.1:${fixturePort}/blocked'); await page.getByRole('button', {name:'Connect'}).click(); await page.waitForFunction(() => window.popup?.closed === true, undefined, {timeout:10000}); return {openerAlive:await page.title(),pages:context.pages().length}`]))
    if (!blocked.ok || blocked.value?.pages !== 1 || !blocked.warnings.some((warning: string) => warning.includes("closed the popup"))) throw new Error(`Blocked popup assertion failed: ${JSON.stringify(blocked)}`)
    console.log("PASS popup-blocked", blocked.value, (await send("Browser.getVersion")).product)
    await cli(["session", "delete", "popup-blocked"])
  } finally { fixture.closeAllConnections(); fixture.close() }
} catch (error) {
  console.error(String(error))
  console.error("RELAY TRACE", relayLog.slice(-14000))
  if (fs.existsSync(`${root}/logs/relay.log`)) console.error(fs.readFileSync(`${root}/logs/relay.log`, "utf8").slice(-16000))
  console.error("BROWSER TRACE", browserLog.slice(-6000))
  process.exitCode = 1
} finally {
  socket?.close(); browser.kill("SIGTERM"); relay.kill("SIGTERM")
  await Promise.all([new Promise<void>(r => browser.exitCode !== null || browser.signalCode ? r() : browser.once("exit", () => r())), new Promise<void>(r => relay.exitCode !== null || relay.signalCode ? r() : relay.once("exit", () => r()))])
  fs.rmSync(root, { recursive: true, force: true })
}
