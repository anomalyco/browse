// Fuzzes the relay: its HTTP API (with and without the token), the CDP WebSocket (authenticated), the /extension
// endpoint (unpaired, must never be obeyed nor displace the real extension) and the MCP server's tool inputs. The relay
// must never crash, hang or leak memory, and nothing may get past authentication.
//   node stress/fuzz.ts [--minutes 15] [--seed 1]
// Writes fuzz.jsonl (anomalies and per-round stats), metrics.jsonl and summary.md under ~/stress-results/<stamp>-fuzz/.
import fs from "node:fs"
import net from "node:net"
import { createRequire } from "node:module"
import path from "node:path"
import { parseArgs } from "node:util"
import { BrowserCdp } from "./lib/cdp.ts"
import { relayBase, relayJson, relayPort, relayToken, repo, runDir, sleep } from "./lib/env.ts"
import { McpClient } from "./lib/mcp.ts"
import { relayPid, Sampler } from "./lib/metrics.ts"
import { Jsonl, mdEscape, oneLine, slope } from "./lib/results.ts"

const { values } = parseArgs({ options: { minutes: { type: "string", default: "15" }, seed: { type: "string", default: String(Date.now() % 100000) } } })
const DURATION_MS = Number(values.minutes) * 60_000
const dir = runDir("fuzz")
const log = new Jsonl(dir, "fuzz.jsonl")
const metricsLog = new Jsonl(dir, "metrics.jsonl")
// Node's WebSocket can't set an Origin header; the relay's own `ws` dependency can.
const WsCtor = createRequire(path.join(repo, "cli/package.json"))("ws") as any

// Deterministic PRNG so a failing round can be replayed with --seed.
let state = Number(values.seed) >>> 0 || 1
const rand = () => { state ^= state << 13; state >>>= 0; state ^= state >>> 17; state ^= state << 5; state >>>= 0; return state / 4294967296 }
const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)]!
const int = (max: number) => Math.floor(rand() * max)

const ROUTES = ["/", "/version", "/json/version", "/json/list", "/json", "/extension/status", "/extension/reload", "/tabs/cleanup", "/settings",
  "/cli/sessions", "/cli/session/new", "/cli/session/delete", "/cli/session/reset", "/cli/session/adopt", "/cli/execute", "/v1/sessions/ensure",
  "/v1/authenticated-origin/json", "/network/start", "/network/status", "/network/stop", "/network/cancel", "/auth/status", "/auth/refresh",
  "/recording/start", "/recording/stop", "/recording/status", "/recording/cancel", "/flight-recorder/start", "/flight-recorder/status",
  "/flight-recorder/save-last", "/flight-recorder/cancel", "/cli/../shutdown", "/%2e%2e/shutdown", "/cli/execute/../../shutdown"]
// Never fuzzed with the token: they would end the run (shutdown), run commands (auth/run) or wipe settings by design.
const AUTH_EXCLUDED = new Set(["/shutdown", "/auth/run", "/extension/reload"])

function randomString(max = 64): string {
  const alphabets = ["abcdefghijklmnopqrstuvwxyz0123456789", "\u0000\u0001\u001f\u007f\"'\\`{}[]<>\n\r\t", "😀𝔘ñ中文\u202e\ud800", "../../etc/passwd", "%00%2e%2e%2f"]
  let out = ""
  const n = int(max)
  for (let i = 0; i < n; i++) { const a = pick(alphabets); out += a[int(a.length)] ?? "" }
  return out
}

function randomValue(depth = 0): unknown {
  const kinds = depth > 4 ? 6 : 9
  switch (int(kinds)) {
    case 0: return null
    case 1: return rand() < 0.5
    case 2: return pick([0, -1, 1e308, -1e308, 2 ** 53 + 1, 0.5, NaN, 4294967296])
    case 3: return randomString()
    case 4: return "x".repeat(pick([1, 1000, 100_000, 1_000_000]))
    case 5: return pick(["session", "test", "../x", "", " ", "fuzz-" + int(5), "soak-probe", "a".repeat(300)])
    case 6: return [randomValue(depth + 1), randomValue(depth + 1)]
    default: {
      const object: Record<string, unknown> = {}
      for (let i = int(5); i >= 0; i--) object[pick(["id", "sessionId", "session", "code", "url", "outputPath", "tabId", "idleMinutes", "set", "targetUrl", "targetIndex", "mode", "__proto__", "constructor", randomString(12)])] = randomValue(depth + 1)
      return object
    }
  }
}

function randomBody(): string {
  switch (int(8)) {
    case 0: return ""
    case 1: return "{"
    case 2: return "[".repeat(10_000) + "]".repeat(10_000)
    case 3: return JSON.stringify({ a: "x".repeat(8_000_000) })
    case 4: return Buffer.from(Array.from({ length: 2000 }, () => int(256))).toString("latin1")
    case 5: return `{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}`
    default: return JSON.stringify(randomValue())
  }
}

const stats = { http: 0, httpStatus: {} as Record<string, number>, unauth: 0, cdp: 0, extension: 0, mcp: 0, raw: 0, anomalies: 0 }
function anomaly(kind: string, detail: Record<string, unknown>) {
  stats.anomalies++
  log.write({ anomaly: kind, ...detail })
  console.log(`ANOMALY ${kind} ${JSON.stringify(detail).slice(0, 300)}`)
}

async function health(context: string): Promise<boolean> {
  const t = Date.now()
  try {
    const r = await fetch(`${relayBase}/version`, { signal: AbortSignal.timeout(5000) })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const ms = Date.now() - t
    if (ms > 2000) anomaly("slow-version", { context, ms })
    return true
  } catch (e) {
    anomaly("relay-unreachable", { context, error: oneLine(e) })
    return false
  }
}

async function fuzzHttp(token: string, authorized: boolean) {
  const route = authorized ? pick(ROUTES.filter((r) => !AUTH_EXCLUDED.has(r))) : pick([...ROUTES, "/shutdown", "/auth/run", "/extension/reload"])
  const method = pick(["GET", "POST", "POST", "POST", "PUT", "DELETE", "OPTIONS"])
  const headers: Record<string, string> = { "content-type": pick(["application/json", "text/plain", "application/x-www-form-urlencoded", ""]) }
  if (authorized) headers.authorization = `Bearer ${token}`
  else {
    const variant = int(5)
    if (variant === 1) headers.authorization = `Bearer ${token.slice(0, -1)}x`
    if (variant === 2) headers.authorization = `Basic ${Buffer.from(`x:${token}`).toString("base64")}`
    if (variant === 3) headers.origin = "https://evil.example"
  }
  if (rand() < 0.1) headers.origin = pick(["https://evil.example", "null", "chrome-extension://abcdefghijklmnop", "http://127.0.0.1:1"])
  if (rand() < 0.05) headers["x-long"] = "y".repeat(60_000)
  const body = method === "GET" ? undefined : randomBody()
  try {
    const response = await fetch(`${relayBase}${route}${rand() < 0.1 ? `?${randomString(20)}` : ""}`, { method, headers, body, signal: AbortSignal.timeout(20_000) })
    const text = await response.text()
    const key = `${authorized ? "auth" : "noauth"}:${response.status}`
    stats.httpStatus[key] = (stats.httpStatus[key] ?? 0) + 1
    if (!authorized) {
      stats.unauth++
      const open = route === "/" || route === "/version"
      if (!open && response.status < 400) anomaly("auth-bypass", { route, method, status: response.status, body: text.slice(0, 200) })
    } else stats.http++
    if (response.status >= 500 && !/not connected|Session not found/i.test(text)) log.write({ note: "5xx", route, method, status: response.status, body: text.slice(0, 200) })
  } catch (e) {
    const message = oneLine(e)
    if (/timeout|aborted/i.test(message)) anomaly("http-timeout", { route, method, authorized, bodyBytes: body?.length ?? 0 })
  }
}

async function fuzzHostHeader(token: string) {
  // A foreign Host header must be refused (DNS rebinding); raw socket because fetch won't send a custom Host.
  const host = pick(["evil.example", `evil.example:${relayPort}`, "localhost.evil.example", `127.0.0.1.nip.io:${relayPort}`])
  const response = await rawRequest(`GET /json/list HTTP/1.1\r\nHost: ${host}\r\nAuthorization: Bearer ${token}\r\nConnection: close\r\n\r\n`)
  stats.raw++
  const status = Number(response.match(/^HTTP\/1\.1 (\d+)/)?.[1] ?? 0)
  if (status !== 0 && status < 400) anomaly("foreign-host-accepted", { host, status })
}

function rawRequest(payload: string, holdMs = 0): Promise<string> {
  return new Promise((resolve) => {
    const socket = net.connect(relayPort, "127.0.0.1")
    let out = ""
    socket.setTimeout(15_000, () => { socket.destroy(); resolve(out) })
    socket.on("data", (d) => { out += d })
    socket.on("error", () => resolve(out))
    socket.on("close", () => resolve(out))
    socket.on("connect", async () => {
      if (holdMs) { socket.write(payload.slice(0, payload.length / 2)); await sleep(holdMs); socket.write(payload.slice(payload.length / 2)) } else socket.write(payload)
    })
  })
}

async function fuzzRaw(token: string) {
  stats.raw++
  const payload = pick([
    `POST /cli/execute HTTP/1.1\r\nHost: 127.0.0.1:${relayPort}\r\nAuthorization: Bearer ${token}\r\nContent-Length: 100000\r\n\r\n{"code":`,
    `GET / HTTP/1.1\r\n${"X: y\r\n".repeat(5000)}\r\n`,
    `\u0000\u0001garbage\r\n\r\n`,
    `POST /cli/session/new HTTP/1.1\r\nHost: 127.0.0.1:${relayPort}\r\nAuthorization: Bearer ${token}\r\nTransfer-Encoding: chunked\r\n\r\nffffffff\r\n`,
    `GET /devtools/browser/x HTTP/1.1\r\nHost: 127.0.0.1:${relayPort}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==\r\n\r\n`,
  ])
  // Slowloris-style: half a request, held open.
  await rawRequest(payload, rand() < 0.3 ? 3000 : 0)
}

function openWs(url: string, headers: Record<string, string> = {}): Promise<WebSocket | string> {
  return new Promise((resolve) => {
    const ws = new WsCtor(url, { headers })
    const timer = setTimeout(() => { ws.terminate(); resolve("timeout") }, 10_000)
    ws.on("open", () => { clearTimeout(timer); resolve(ws as unknown as WebSocket) })
    ws.on("unexpected-response", (_req: unknown, res: { statusCode: number }) => { clearTimeout(timer); resolve(`HTTP ${res.statusCode}`) })
    ws.on("error", (e: Error) => { clearTimeout(timer); resolve(`error ${e.message}`) })
  })
}

async function fuzzCdp(token: string) {
  stats.cdp++
  const unauth = rand() < 0.2
  const url = `ws://127.0.0.1:${relayPort}/devtools/browser/fuzz${unauth ? "" : `?opencodeBrowserToken=${token}`}${rand() < 0.3 ? `&opencodeBrowserSessionId=fuzz-${int(3)}` : ""}`
  const ws = await openWs(url, rand() < 0.1 ? { origin: "https://evil.example" } : {})
  if (typeof ws === "string") {
    if (!unauth && !/403|503/.test(ws)) anomaly("cdp-connect-failed", { result: ws })
    return
  }
  const sock = ws as any
  if (unauth) { anomaly("cdp-auth-bypass", { url: url.replace(token, "<token>") }); sock.close(); return }
  const methods = ["Target.getTargets", "Target.createTarget", "Target.attachToTarget", "Target.closeTarget", "Browser.close", "Browser.getVersion", "Runtime.evaluate",
    "Page.navigate", "Storage.clearDataForOrigin", "Network.clearBrowserCookies", "Network.getAllCookies", "Input.dispatchMouseEvent", "Target.setAutoAttach",
    "Target.setDiscoverTargets", "Browser.setDownloadBehavior", "SystemInfo.getProcessInfo", "Fuzz.nothing", randomString(20)]
  const n = 5 + int(30)
  for (let i = 0; i < n; i++) {
    let frame: string | Buffer
    switch (int(6)) {
      case 0: frame = randomString(200); break
      case 1: frame = Buffer.from(Array.from({ length: 500 }, () => int(256))); break
      case 2: frame = JSON.stringify({ id: "x".repeat(1_000_000), method: "Target.getTargets" }); break
      default: frame = JSON.stringify({ id: rand() < 0.9 ? i : randomValue(), method: pick(methods), params: rand() < 0.7 ? randomValue() : { url: pick(["chrome://settings", "file:///etc/passwd", "javascript:alert(1)", "about:blank", "data:text/html,x"]), targetId: randomString(32) }, ...(rand() < 0.3 ? { sessionId: pick(["bc-tab-1", randomString(16), ""]) } : {}) })
    }
    try { sock.send(frame) } catch { break }
    if (rand() < 0.3) await sleep(int(50))
  }
  await sleep(200)
  if (rand() < 0.5) sock.terminate(); else sock.close()
}

async function fuzzExtensionEndpoint() {
  stats.extension++
  const origin = pick(["chrome-extension://afeafocngkodbmaipcngoamamfmekgfo", "chrome-extension://mfnicocicmmlkpjnaffgihfjhdgjkdjg", "chrome-extension://evilevilevilevilevilevilevilevil", "https://evil.example", ""])
  const ws = await openWs(`ws://127.0.0.1:${relayPort}/extension`, origin ? { origin } : {})
  // The old store ID is no longer built in (store items are release configuration), so it must be refused too.
  const allowed = origin.includes("afeafocngkodbmaipcngoamamfmekgfo")
  if (typeof ws === "string") {
    if (allowed) log.write({ note: "extension-endpoint refused allowed origin", origin, result: ws })
    return
  }
  const sock = ws as any
  if (!allowed) anomaly("extension-origin-accepted", { origin })
  const messages = [
    JSON.stringify({ method: "hello", params: { version: "9.9.9", protocolVersion: 2, nonce: randomString(32), profileName: "fuzz" } }),
    JSON.stringify({ method: "auth.response", params: { proof: randomString(64) } }),
    JSON.stringify({ method: "debugger.event", params: { tabId: 1, method: "Page.frameNavigated", params: {} } }),
    JSON.stringify({ id: 1, result: { tabId: 999 } }),
    randomString(300),
    JSON.stringify(randomValue()),
  ]
  let closed = ""
  sock.on("close", (code: number, reason: Buffer) => { closed = `${code} ${reason}` })
  for (let i = 0; i < 3 + int(6); i++) { try { sock.send(pick(messages)) } catch { break } }
  await sleep(300)
  sock.terminate()
  // The real extension must still be the connected one.
  const status = await relayJson("/extension/status", undefined, 5000).catch(() => undefined)
  if (status && status.connected !== true) anomaly("extension-displaced", { origin, closed })
}

const TOOLS = ["execute", "status", "session_new", "session_list", "session_current", "session_use", "session_reset", "session_delete", "session_adopt",
  "network_start", "network_status", "network_stop", "network_cancel", "recording_start", "recording_stop", "recording_status", "recording_cancel",
  "flight_recorder_start", "flight_recorder_status", "flight_recorder_save_last", "flight_recorder_cancel", "secrets_status", "secrets_refresh",
  "tabs_cleanup", "skill", "settings", "no_such_tool"]
let mcp: McpClient | undefined
async function fuzzMcp() {
  stats.mcp++
  if (!mcp || mcp.exited !== undefined) {
    if (mcp?.exited !== undefined) anomaly("mcp-server-exited", { code: mcp.exited, stderr: mcp.stderr.slice(-300) })
    mcp = new McpClient()
    await mcp.initialize()
  }
  const tool = pick(TOOLS)
  if (rand() < 0.1) {
    mcp.raw(pick(["{", "null", "[]", `{"jsonrpc":"2.0","id":"x","method":"tools/call","params":null}`, `{"jsonrpc":"2.0","id":1e400,"method":"tools/list"}`, "x".repeat(2_000_000), `{"jsonrpc":"2.0","method":"tools/call","params":{"name":"execute","arguments":{"code":"return 1"}}}`]))
    return
  }
  let args = randomValue() as any
  if (typeof args !== "object" || args === null || Array.isArray(args)) args = { value: args }
  // Keep the fuzz inside the box's throwaway sessions and paths, and settings to valid-or-garbage keys only.
  if (tool === "execute" && rand() < 0.5) args = { code: pick(["return 1", "throw new Error('x')", "while(true){}", "await new Promise(() => {})", randomString(200), "return page.url()", "return 'y'.repeat(3e6)"]), session: pick([undefined, "fuzz-0", "fuzz-1"]) }
  if (tool === "settings" && args.set) args = { set: { grouping: pick(["session", "shared", "none", randomString(8)]), [randomString(8)]: randomString(8) } }
  if ("outputPath" in args) args.outputPath = path.join(dir, "artifacts", `fuzz-${int(1000)}`)
  try {
    await mcp.call(tool, args, 45_000)
  } catch (e) {
    const message = oneLine(e)
    if (/timed out/.test(message) && !(tool === "execute")) anomaly("mcp-call-timeout", { tool, args: JSON.stringify(args).slice(0, 200) })
    else if (/exited/.test(message)) anomaly("mcp-server-exited", { tool, args: JSON.stringify(args).slice(0, 200), stderr: mcp.stderr.slice(-300) })
  }
}

// --- run ----------------------------------------------------------------------------------------------------------
const token = relayToken()
const startPid = await relayPid()
if (!startPid) throw new Error("relay is not running: run any CLI command (e.g. `node cli/dist/cli.mjs session list`) first")
const started = Date.now()
const samples: { at: number; rss: number; fds: number }[] = []
const sampler = new Sampler()
let cdp: BrowserCdp | undefined
try { cdp = await BrowserCdp.connect() } catch {}
let stop = false
const metrics = (async () => {
  while (!stop) {
    const sample = await sampler.sample(cdp).catch(() => ({} as Record<string, any>))
    metricsLog.write({ at: Date.now(), ...sample, stats: { ...stats, httpStatus: undefined } })
    if (typeof sample.relayRssMb === "number") samples.push({ at: Date.now(), rss: sample.relayRssMb as number, fds: sample.relayFds as number })
    if (sample.relayPid && sample.relayPid !== startPid) anomaly("relay-restarted", { from: startPid, to: sample.relayPid })
    await sleep(15_000)
  }
})()
console.log(`fuzz: ${values.minutes} min, seed ${values.seed}, relay pid ${startPid}, results ${dir}`)
let round = 0
while (Date.now() - started < DURATION_MS) {
  round++
  const kind = pick(["http", "http", "http", "unauth", "unauth", "host", "raw", "cdp", "cdp", "extension", "mcp", "mcp", "mcp"])
  const t = Date.now()
  try {
    if (kind === "http") await Promise.all(Array.from({ length: 1 + int(8) }, () => fuzzHttp(token, true)))
    if (kind === "unauth") await Promise.all(Array.from({ length: 1 + int(8) }, () => fuzzHttp(token, false)))
    if (kind === "host") await fuzzHostHeader(token)
    if (kind === "raw") await fuzzRaw(token)
    if (kind === "cdp") await fuzzCdp(token)
    if (kind === "extension") await fuzzExtensionEndpoint()
    if (kind === "mcp") await fuzzMcp()
  } catch (e) {
    log.write({ round, kind, harnessError: oneLine(e) })
  }
  if (round % 10 === 0 || Date.now() - t > 10_000) {
    const ok = await health(`round ${round} (${kind})`)
    if (!ok) {
      // Give it a moment; a crashed relay is a finding, then restart it so the run continues.
      await sleep(3000)
      if (!(await health("recheck"))) {
        anomaly("relay-down", { round, kind, pid: await relayPid() })
        await new McpClient().initialize().catch(() => undefined)
      }
    }
  }
}
stop = true
await metrics
await mcp?.close()
cdp?.close()
const endPid = await relayPid()
log.write({ done: true, rounds: round, stats })
const points = samples.filter((s) => s.at > started + 60_000)
const rssSlope = slope(points.map((s) => [(s.at - started) / 3_600_000, s.rss]))
const fdSlope = slope(points.map((s) => [(s.at - started) / 3_600_000, s.fds]))
const anomalies = fs.readFileSync(log.file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.anomaly)
const kinds = new Map<string, number>()
for (const a of anomalies) kinds.set(a.anomaly, (kinds.get(a.anomaly) ?? 0) + 1)
const fiveXX = fs.readFileSync(log.file, "utf8").split("\n").filter((l) => l.includes('"5xx"')).length
const md = [
  `# Fuzz`,
  ``,
  `${values.minutes} min, seed ${values.seed}, ${round} rounds. Relay pid ${startPid} -> ${endPid ?? "down"} (${startPid === endPid ? "never restarted" : "**restarted**"}). ${new Date().toISOString()}`,
  ``,
  `| Surface | Requests/rounds |`,
  `| --- | ---: |`,
  `| HTTP API with token | ${stats.http} |`,
  `| HTTP API without/with a wrong token | ${stats.unauth} |`,
  `| Raw sockets (foreign Host, malformed, slowloris) | ${stats.raw} |`,
  `| CDP WebSocket sessions | ${stats.cdp} |`,
  `| /extension (unpaired) | ${stats.extension} |`,
  `| MCP tool calls / raw lines | ${stats.mcp} |`,
  ``,
  `Relay RSS ${points.length ? `${Math.min(...points.map((p) => p.rss))}-${Math.max(...points.map((p) => p.rss))} MB, slope ${rssSlope.toFixed(1)} MB/h` : "n/a"}; fds slope ${fdSlope.toFixed(1)}/h. 5xx answers to garbage: ${fiveXX}.`,
  ``,
  `HTTP statuses: ${Object.entries(stats.httpStatus).sort().map(([k, v]) => `${k}=${v}`).join(", ")}`,
  ``,
  `## Anomalies (${anomalies.length})`,
  ``,
  ...(anomalies.length ? [...kinds].map(([k, n]) => `- ${k}: ${n}`) : ["None."]),
  ``,
  ...anomalies.slice(0, 20).map((a) => `- \`${mdEscape(JSON.stringify(a).slice(0, 300))}\``),
].join("\n")
fs.writeFileSync(path.join(dir, "summary.md"), `${md}\n`)
console.log(md)
process.exit(anomalies.length ? 1 : 0)
