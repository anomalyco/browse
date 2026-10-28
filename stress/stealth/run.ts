// Stealth check for browse on a real browser (a Mac with Chrome or Helium), never in CI: it opens public detector
// sites. Drives browse the way an agent does, through the MCP server (session_new + execute):
//
// 1. The local probe (probe.html, served on 127.0.0.1) records CDP-specific tells while browse moves the mouse,
//    clicks and types: screenX/screenY vs clientX/clientY, empty coalesced/predicted events, event timing, document
//    vs subresource nextHopProtocol, window vs worker navigator values, window sizes and focus, non-native
//    Function.prototype.toString, automation globals and DOM artifacts, foreign main-world call stacks.
// 2. Public detectors (bot.sannysoft.com, BrowserScan, CreepJS, rebrowser's bot-detector, deviceandbrowserinfo,
//    pixelscan, fingerprint.com's demo, a reCAPTCHA v3 score page): a screenshot plus a best-effort verdict each.
//
//   node stress/stealth/run.ts [--probe-only | --sites-only] [--sites sannysoft,creepjs] [--sites-file sites.json]
//                              [--out dir] [--wait-ms 8000] [--session stealth] [--keep-session]
//
// Results go to <out>/ (default ~/stress-results/<time>-stealth/): results.json, summary.md, probe.json and PNGs.
// The CLI is this checkout's cli/dist/cli.mjs (or $BROWSE_REPO's); OPENCODE_BROWSER_HOME / OPENCODE_BROWSER_PORT pick
// the relay, as for every browse command. Run it on a dedicated browser profile when you can (see stress/README.md).
import fs from "node:fs"
import http from "node:http"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"
import { McpClient, type ToolResult } from "../lib/mcp.ts"
import { mdEscape, oneLine } from "../lib/results.ts"

type Site = {
  readonly id: string
  readonly url: string
  /** Extra settle time after DOMContentLoaded, for sites that compute their verdict over seconds. */
  readonly waitMs?: number
  /** Body of an async function run in the page (Patchright's isolated world reads the DOM): returns the verdict. */
  readonly extract: string
}

const genericExtract = `return { title: document.title, text: document.body ? document.body.innerText.slice(0, 1500) : "" }`

const defaultSites: readonly Site[] = [
  {
    id: "sannysoft",
    url: "https://bot.sannysoft.com/",
    waitMs: 4_000,
    extract: `
      const cells = Array.from(document.querySelectorAll("td"))
      const failed = cells.filter((td) => /failed/i.test(td.className)).map((td) => (td.previousElementSibling?.textContent || td.textContent || "").trim().slice(0, 60))
      const warn = cells.filter((td) => /warn/i.test(td.className)).map((td) => (td.previousElementSibling?.textContent || "").trim().slice(0, 60))
      const passed = cells.filter((td) => /passed/i.test(td.className)).length
      return { passed, failed, warn }`,
  },
  {
    id: "browserscan",
    url: "https://www.browserscan.net/bot-detection",
    waitMs: 8_000,
    extract: `
      const text = document.body.innerText
      const result = /Test Results?:?\\s*\\n?\\s*([^\\n]+)/i.exec(text)?.[1]
      const abnormal = Array.from(document.querySelectorAll("*")).filter((el) => el.children.length === 0 && /^(abnormal|bot)$/i.test(el.textContent.trim())).length
      return { result: result || null, abnormalMarks: abnormal, excerpt: text.slice(0, 800) }`,
  },
  {
    id: "creepjs",
    url: "https://abrahamjuliot.github.io/creepjs/",
    waitMs: 15_000,
    extract: `
      const text = document.body.innerText
      const pick = (pattern) => pattern.exec(text)?.[1] ?? null
      return {
        headless: pick(/(\\d+%)\\s*headless/i),
        likeHeadless: pick(/(\\d+%)\\s*like headless/i),
        stealth: pick(/(\\d+%)\\s*stealth/i),
        trustScore: pick(/trust score:?\\s*([\\d.]+%?)/i),
        lies: pick(/lies\\s*\\(?(\\d+)\\)?/i),
      }`,
  },
  {
    id: "rebrowser",
    url: "https://bot-detector.rebrowser.net/",
    waitMs: 6_000,
    extract: `
      const rows = Array.from(document.querySelectorAll("tr")).map((tr) => Array.from(tr.cells, (cell) => cell.innerText.trim().replace(/\\s+/g, " ").slice(0, 120)))
      const tests = rows.filter((cells) => cells.length >= 2 && cells[0]).map((cells) => ({ test: cells[1] || cells[0], status: cells[0], detail: cells.slice(2).join(" ").slice(0, 160) }))
      return { tests: tests.slice(0, 40) }`,
  },
  {
    id: "deviceandbrowserinfo",
    url: "https://deviceandbrowserinfo.com/are_you_a_bot",
    waitMs: 6_000,
    extract: `
      const text = document.body.innerText
      return { verdict: /You are (?:a )?(human|bot)/i.exec(text)?.[0] ?? null, excerpt: text.slice(0, 600) }`,
  },
  {
    id: "pixelscan",
    url: "https://pixelscan.net/",
    waitMs: 12_000,
    extract: `
      const text = document.body.innerText
      return { consistent: /fingerprint is (consistent|inconsistent)/i.exec(text)?.[1] ?? null, bot: /(no automation framework detected|automation framework detected|bot(?:s)? detected)/i.exec(text)?.[0] ?? null, excerpt: text.slice(0, 600) }`,
  },
  {
    id: "fingerprint-demo",
    url: "https://demo.fingerprint.com/bot-firewall",
    waitMs: 8_000,
    extract: `
      const text = document.body.innerText
      return { bot: /(bad bot|good bot|not detected|no bot)[^\\n]*/i.exec(text)?.[0] ?? null, excerpt: text.slice(0, 600) }`,
  },
  {
    id: "recaptcha-v3",
    url: "https://antcpt.com/score_detector/",
    waitMs: 8_000,
    extract: `
      const text = document.body.innerText
      return { score: /score is:?\\s*([\\d.]+)/i.exec(text)?.[1] ?? null, excerpt: text.slice(0, 400) }`,
  },
]

const { values: args } = parseArgs({
  options: {
    "probe-only": { type: "boolean", default: false },
    "sites-only": { type: "boolean", default: false },
    sites: { type: "string" },
    "sites-file": { type: "string" },
    out: { type: "string" },
    "wait-ms": { type: "string" },
    session: { type: "string" },
    "keep-session": { type: "boolean", default: false },
  },
})

const here = import.meta.dirname
const repo = process.env.BROWSE_REPO ?? path.resolve(here, "../..")
const cli = path.join(repo, "cli/dist/cli.mjs")
if (!fs.existsSync(cli)) throw new Error(`No browse CLI at ${cli}: build it (cd cli && bun build.ts) or set BROWSE_REPO`)
const stamp = new Date().toISOString().replace(/[:.]/g, "-")
const out = path.resolve(args.out ?? path.join(process.env.BROWSE_STRESS_RESULTS ?? path.join(os.homedir(), "stress-results"), `${stamp}-stealth`))
fs.mkdirSync(out, { recursive: true })
const extraWaitMs = args["wait-ms"] ? Number(args["wait-ms"]) : undefined
const session = args.session ?? `stealth-${Date.now().toString(36)}`

function chooseSites(): readonly Site[] {
  if (args["sites-file"]) {
    const custom = JSON.parse(fs.readFileSync(args["sites-file"], "utf8")) as Array<Partial<Site> & { id: string; url: string }>
    return custom.map((site) => ({ ...site, extract: site.extract ?? defaultSites.find((known) => known.id === site.id)?.extract ?? genericExtract }))
  }
  if (!args.sites) return defaultSites
  const wanted = args.sites.split(",").map((id) => id.trim()).filter(Boolean)
  const unknown = wanted.filter((id) => !defaultSites.some((site) => site.id === id))
  if (unknown.length) throw new Error(`Unknown sites: ${unknown.join(", ")} (known: ${defaultSites.map((site) => site.id).join(", ")})`)
  return defaultSites.filter((site) => wanted.includes(site.id))
}

// ---- local probe server -------------------------------------------------------------------------------

const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64")
const serviceWorker = `importScripts("/snapshot.js")
self.addEventListener("install", () => self.skipWaiting())
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()))
self.addEventListener("message", (event) => {
  self.__probeSnapshot().then((value) => event.ports[0].postMessage(value), (error) => event.ports[0].postMessage({ error: String(error) }))
})`

async function startProbeServer(): Promise<{ readonly url: string; readonly close: () => Promise<void> }> {
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname
    const send = (type: string, body: string | Buffer) => { response.writeHead(200, { "content-type": type, "cache-control": "no-store" }); response.end(body) }
    if (pathname === "/" || pathname === "/probe.html") return send("text/html; charset=utf-8", fs.readFileSync(path.join(here, "probe.html")))
    if (pathname === "/snapshot.js") return send("text/javascript", fs.readFileSync(path.join(here, "snapshot.js")))
    if (pathname === "/probe-sw.js") return send("text/javascript", serviceWorker)
    if (pathname === "/probe-pixel.png") return send("image/png", pixel)
    response.writeHead(404)
    response.end()
  })
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve) })
  const { port } = server.address() as net.AddressInfo
  return { url: `http://127.0.0.1:${port}/probe.html`, close: () => new Promise((resolve) => server.close(() => resolve())) }
}

// ---- browse through MCP -------------------------------------------------------------------------------

const client = new McpClient([process.execPath, cli, "mcp"])

async function execute(code: string, timeoutMs = 120_000): Promise<{ readonly value: any; readonly result: ToolResult }> {
  const result = await client.call("execute", { session, code }, timeoutMs)
  if (result.isError) throw new Error(`execute failed: ${result.text.slice(0, 800)}`)
  return { value: result.data?.value, result }
}

function copyArtifact(from: unknown, name: string): string | undefined {
  if (typeof from !== "string" || !fs.existsSync(from)) return undefined
  const target = path.join(out, name)
  fs.copyFileSync(from, target)
  return target
}

async function runProbe(): Promise<Record<string, unknown>> {
  const server = await startProbeServer()
  try {
    await execute(`await page.goto(${JSON.stringify(server.url)}, { waitUntil: "load" }); await page.locator('#ready[data-ready="1"]').waitFor()`)
    // Human-shaped activity through browse's normal input path: moves, hovers, clicks, typing, a scroll.
    await execute(`
      const box = async (selector) => (await page.locator(selector).boundingBox())
      for (const selector of ['#pad-a', '#pad-c', '#pad-b', '#target']) {
        const b = await box(selector)
        await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2)
        await page.waitForTimeout(150)
      }
      await page.hover('#pad-a')
      await page.click('#target')
      await page.click('#text')
      await page.keyboard.type('The quick brown fox jumps over the lazy dog')
      await page.mouse.wheel(0, 200)
      await page.waitForTimeout(300)
      await page.mouse.wheel(0, -200)
      return true`)
    // What a main-world evaluate looks like to the page (execute's default page.evaluate runs in an isolated world).
    const mainWorld = await execute(`return await page.evaluate(() => window.__stealthProbeStack ? window.__stealthProbeStack() : null, undefined, undefined, false)`)
      .then(({ value }) => value, (error) => ({ error: oneLine(error) }))
    const finished = await execute(`
      await page.click('#finish')
      await page.locator('#report[data-done="1"]').waitFor({ timeout: 20000 })
      await page.screenshot({ path: files.path('stealth-probe.png'), fullPage: true })
      return { report: JSON.parse(await page.locator('#report').textContent()), screenshot: files.path('stealth-probe.png') }`)
    const report = { ...finished.value.report, mainWorldEvaluateStack: mainWorld, executeWarnings: finished.result.data?.warnings ?? [] }
    fs.writeFileSync(path.join(out, "probe.json"), `${JSON.stringify(report, null, 2)}\n`)
    copyArtifact(finished.value.screenshot, "probe.png")
    return report
  } finally {
    await server.close()
  }
}

async function runSite(site: Site): Promise<Record<string, unknown>> {
  const waitMs = extraWaitMs ?? site.waitMs ?? 6_000
  const started = Date.now()
  try {
    const { value, result } = await execute(`
      let navigationError = null
      const response = await page.goto(${JSON.stringify(site.url)}, { waitUntil: "domcontentloaded", timeout: 30000 }).catch((error) => { navigationError = error.message; return null })
      await page.waitForTimeout(${waitMs})
      const verdict = await page.evaluate(async () => { ${site.extract} }).catch((error) => ({ extractError: error.message }))
      const shot = files.path(${JSON.stringify(`stealth-${site.id}.png`)})
      await page.screenshot({ path: shot, fullPage: false }).catch(() => {})
      return { status: response ? response.status() : null, finalUrl: page.url(), title: await page.title().catch(() => ""), navigationError, verdict, screenshot: shot }`, waitMs + 90_000)
    const screenshot = copyArtifact(value.screenshot, `${site.id}.png`)
    return { id: site.id, url: site.url, ms: Date.now() - started, ...value, screenshot, challenge: result.data?.aftermath?.challenge ?? null }
  } catch (error) {
    return { id: site.id, url: site.url, ms: Date.now() - started, error: oneLine(error) }
  }
}

function probeHighlights(report: any): string[] {
  if (!report || report.error) return [`probe failed: ${report?.error ?? "no report"}`]
  const input = report.input ?? {}
  const lines = [
    `screen==client on ${input.screenEqualsClient ?? "n/a"} of mouse events (x only ${input.screenXEqualsClientX ?? "n/a"}, y only ${input.screenYEqualsClientY ?? "n/a"}); expected offset ${JSON.stringify(input.expectedScreenOffset?.dx)}, ${JSON.stringify(input.expectedScreenOffset?.dy)}; seen median ${input.screenOffset?.dx?.median ?? "n/a"}, ${input.screenOffset?.dy?.median ?? "n/a"}`,
    `empty getCoalescedEvents on ${input.coalescedEmpty ?? "n/a"} of pointermoves; empty getPredictedEvents on ${input.predictedEmpty ?? "n/a"}`,
    `untrusted events: ${input.untrusted ?? "n/a"}; click detail ${JSON.stringify(input.clickDetail ?? [])}`,
    `mousemove interval ms ${JSON.stringify(input.mousemoveIntervalMs)}; key interval ms ${JSON.stringify(input.keyIntervalMs)}; key dwell ms ${JSON.stringify(input.keyDwellMs)}`,
    `document nextHopProtocol ${JSON.stringify(report.navigation?.documentNextHopProtocol)}; subresources ${JSON.stringify((report.navigation?.subresources ?? []).map((entry: any) => entry.nextHopProtocol))}`,
    `window/worker mismatches: ${JSON.stringify(report.workers?.mismatches ?? [])}`,
    `outer-inner ${JSON.stringify(report.window?.outerMinusInner)}; visibility ${report.window?.visibilityState}; hasFocus ${report.window?.hasFocus}`,
    `non-native functions: ${JSON.stringify(Object.entries(report.native ?? {}).filter(([, value]) => value !== "native").map(([key]) => key))}`,
    `automation globals ${JSON.stringify(report.artifacts?.automationGlobals ?? [])}; extra globals ${JSON.stringify(report.artifacts?.extraGlobals ?? [])}; unexpected nodes ${JSON.stringify(report.artifacts?.unexpectedNodes ?? [])}`,
    `foreign main-world calls ${JSON.stringify(report.artifacts?.trappedForeignCalls ?? [])}; console serialized an Error stack (Runtime.enable) ${report.artifacts?.consoleSerializedStack}`,
    `main-world evaluate stack ${JSON.stringify(report.mainWorldEvaluateStack)}`,
    `navigator.webdriver ${report.misc?.webdriver}; plugins ${report.misc?.pluginsLength}; WebGL ${JSON.stringify(report.misc?.webgl)}`,
  ]
  return lines
}

const results: Record<string, unknown> = { startedAt: new Date().toISOString(), session, cli, host: os.hostname(), platform: `${os.platform()} ${os.release()}` }
try {
  await client.initialize()
  const status = await client.call("status", {}, 60_000)
  results.status = status.data ?? status.text.slice(0, 2000)
  const created = await client.call("session_new", { id: session }, 60_000)
  if (created.isError) throw new Error(`session_new failed: ${created.text}`)
  if (!args["sites-only"]) {
    results.probe = await runProbe().catch((error) => ({ error: oneLine(error) }))
  }
  if (!args["probe-only"]) {
    const sites: Record<string, unknown>[] = []
    for (const site of chooseSites()) {
      console.error(`stealth: ${site.id}`)
      sites.push(await runSite(site))
    }
    results.sites = sites
  }
} finally {
  if (!args["keep-session"]) await client.call("session_delete", { session }, 60_000).catch(() => undefined)
  await client.close()
  results.finishedAt = new Date().toISOString()
  fs.writeFileSync(path.join(out, "results.json"), `${JSON.stringify(results, null, 2)}\n`)
  const summary = [
    `# browse stealth run ${results.startedAt}`,
    "",
    `Session \`${session}\`, CLI \`${cli}\`, ${results.platform}.`,
    "",
    ...(results.probe ? ["## Local probe", "", ...probeHighlights(results.probe).map((line) => `- ${mdEscape(line)}`), "", "Full report: `probe.json`, screenshot `probe.png`.", ""] : []),
    ...(Array.isArray(results.sites) ? [
      "## Detector sites",
      "",
      "| Site | Status | Verdict | Challenge | Screenshot |",
      "| --- | --- | --- | --- | --- |",
      ...(results.sites as any[]).map((site) => `| ${site.id} | ${site.error ? `error: ${mdEscape(site.error)}` : site.status ?? site.navigationError ?? ""} | ${mdEscape(JSON.stringify(site.verdict ?? null).slice(0, 300))} | ${site.challenge ? `${site.challenge.vendor} ${site.challenge.kind} ${site.challenge.status}` : ""} | ${site.screenshot ? path.basename(site.screenshot) : ""} |`),
      "",
    ] : []),
  ].join("\n")
  fs.writeFileSync(path.join(out, "summary.md"), `${summary}\n`)
  console.log(out)
}
