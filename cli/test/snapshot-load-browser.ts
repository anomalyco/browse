// Isolated headless regression and load check for snapshot() on large DOMs:
//   bun build.ts && node --no-warnings test/snapshot-load-browser.ts [--browser <chromium executable>]
// Uses a port-patched copy of the extension in headless Chromium with --use-mock-keychain, a fresh
// OPENCODE_BROWSER_HOME, and BROWSE_TEST_RELAY_PORT / BROWSE_TEST_FIXTURE_PORT (else free ports).
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import { spawn } from "node:child_process"
import { parseArgs } from "node:util"
import { chromium } from "patchright-core"
import { relayToken } from "../src/relay-secrets.ts"
import { bundledPairingCodeTtlMs, mintPairingCode, writeExtensionPairing } from "../src/browser-pairing.ts"
import { portFromEnv } from "./support/ports.ts"

function summarize(values: readonly number[]) {
  const sorted = [...values].sort((left, right) => left - right)
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))] ?? 0
  const median = sorted.length === 0
    ? 0
    : sorted.length % 2 === 1
    ? sorted[(sorted.length - 1) >> 1]!
    : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2
  return {
    count: sorted.length,
    p50: Number(median.toFixed(1)),
    p95: Number(at(95).toFixed(1)),
    max: Number((sorted.at(-1) ?? 0).toFixed(1)),
  }
}

const { values: options } = parseArgs({ options: { browser: { type: "string" } } })
const executablePath = options.browser || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || chromium.executablePath()
assert.ok(fs.existsSync(executablePath), `No Chromium at ${executablePath}: pass --browser or set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`)

const tmp = path.join(fs.realpathSync(os.tmpdir()), "opencode")
fs.mkdirSync(tmp, { recursive: true })
const root = fs.mkdtempSync(path.join(tmp, "snapshot-load-browser-"))
const home = path.join(root, "home")
const runtime = path.join(root, "runtime")
const extension = path.join(home, "extension")
const cliRoot = path.resolve(import.meta.dirname, "..")
const port = await portFromEnv("BROWSE_TEST_RELAY_PORT")
const fixturePort = await portFromEnv("BROWSE_TEST_FIXTURE_PORT")
const fixtureUrl = `http://127.0.0.1:${fixturePort}`
const base = `http://127.0.0.1:${port}`
const env: NodeJS.ProcessEnv = {
  ...process.env,
  HOME: root,
  OPENCODE_BROWSER_HOME: home,
  OPENCODE_BROWSER_PORT: String(port),
  OPENCODE_BROWSER_UPDATE_CHECK: "0",
  OPENCODE_BROWSER_AUTOSTART: "false",
}
delete env.OPENCODE_BROWSER_ALLOW_NODE
delete env.OPENCODE_BROWSER_ALLOW_FOREGROUND

fs.mkdirSync(path.join(runtime, "dist"), { recursive: true })
fs.cpSync(path.join(cliRoot, "..", "dist"), extension, { recursive: true })
fs.cpSync(path.join(cliRoot, "dist"), path.join(runtime, "dist"), { recursive: true })
fs.symlinkSync(path.join(cliRoot, "node_modules"), path.join(runtime, "node_modules"), "dir")
for (const entry of fs.readdirSync(extension, { recursive: true })) {
  const file = path.join(extension, String(entry))
  if (/\.(js|json)$/.test(file) && fs.statSync(file).isFile()) {
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replaceAll("19988", String(port)))
  }
}
const cli = path.join(runtime, "dist/cli.mjs")
writeExtensionPairing(extension, mintPairingCode(home, { ttlMs: bundledPairingCodeTtlMs }))

const htmlPage = (title: string, body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`
const bigRowsHtml = htmlPage(
  "Big DOM",
  `<table>${Array.from({ length: 5_000 }, (_, i) => `<tr><td>Row ${i}</td><td><a href="#r${i}">link ${i}</a></td><td><button onclick="document.title='acted-${i}'">Act ${i}</button></td></tr>`).join("")}</table>`,
)
const bigDataTableHtml = htmlPage(
  "Big Data Table",
  `<main><nav aria-label="Primary">${Array.from({ length: 10 }, (_, i) => `<a href="/n${i}">Nav ${i}</a>`).join("")}</nav><h1>Orders</h1><table class="orders"><thead><tr><th scope="col">Row</th><th scope="col">Link</th><th scope="col">Action</th></tr></thead><tbody>${Array.from({ length: 5_000 }, (_, i) => `<tr class="order-row"><td class="cell">Row ${i}</td><td class="cell"><a class="order-link" data-testid="${i === 3 ? "unique-row-3" : "shared-row"}" href="#r${i}">link ${i}</a></td><td class="cell"><button class="order-btn" aria-label="Act ${i}" onclick="this.setAttribute('aria-label','Acted ${i}');this.textContent='Acted ${i}'">Act ${i}</button></td></tr>`).join("")}</tbody></table></main>`,
)

const fixture = http.createServer((request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
  response.end(request.url === "/big-table" ? bigDataTableHtml : bigRowsHtml)
})

const log = fs.openSync(path.join(root, "relay.log"), "w", 0o600)
const relay = spawn("node", [cli, "serve"], { env, stdio: ["ignore", log, log] })
let browser: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
let authorization = ""

async function api(route: string, body?: unknown) {
  const response = await fetch(`${base}${route}`, {
    ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
    headers: { authorization, "content-type": "application/json" },
  })
  assert.equal(response.status, 200, route)
  return await response.json() as Record<string, any>
}

async function execute(sessionId: string, code: string) {
  return await api("/cli/execute", { sessionId, code, createIfMissing: false })
}

try {
  await new Promise<void>((resolve, reject) => { fixture.once("error", reject); fixture.listen(fixturePort, "127.0.0.1", resolve) })
  for (let i = 0; i < 100; i++) {
    if (await fetch(`${base}/version`).then((r) => r.ok, () => false)) break
    await pause(50)
  }
  authorization = `Bearer ${relayToken(home)}`
  browser = await chromium.launchPersistentContext(path.join(root, "profile"), {
    executablePath,
    headless: true,
    args: [
      "--use-mock-keychain",
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
    ],
  })
  for (let i = 0; i < 100; i++) {
    if ((await api("/extension/status")).connected) break
    await pause(100)
  }
  assert.equal((await api("/extension/status")).connected, true)

  // Semantics + single-session timings on 5,000-row layout table and 5,000-row data table.
  await api("/cli/session/new", { id: "snap-single" })
  const dataTableCheck = await execute("snap-single", `
    await page.goto(${JSON.stringify(`${fixtureUrl}/big-table`)});
    const out = await snapshot({ maxItems: 100 });
    const rowOut = await snapshot({ within: "tbody > tr:nth-of-type(3)" });
    const act2Ref = rowOut.match(/button "Act 2" \\[ref=(e\\d+)\\]/)?.[1];
    if (!act2Ref) throw new Error('missing Act 2 ref: ' + rowOut);
    await ref(act2Ref).click();
    const diff = await snapshot({ within: "tbody > tr:nth-of-type(3)", diff: true });
    const fresh = await snapshot({ maxItems: 100 });
    const row3Ref = fresh.match(/link "link 3" \\[ref=(e\\d+)\\]/)?.[1];
    if (!row3Ref) throw new Error('missing link 3 ref: ' + fresh.slice(0, 400));
    await ref(row3Ref).click();
    return { out, rowOut, diff, hash: await page.evaluate(() => location.hash) };
  `)
  assert.equal(dataTableCheck.isError, false, dataTableCheck.text)
  assert.match(dataTableCheck.value.out, /- navigation "Primary" \[10 controls\]/)
  assert.match(dataTableCheck.value.out, /- table "Table" \[5001 rows\]/)
  assert.match(dataTableCheck.value.out, /- link "link 0"/)
  assert.match(dataTableCheck.value.rowOut, /- row "Row: Row 2 \| Link: link 2 \| Action: Act 2"/)
  assert.equal(dataTableCheck.value.hash, "#r3")
  assert.match(dataTableCheck.value.diff, /\+\s+button "Acted 2"/)

  await execute("snap-single", `await page.goto(${JSON.stringify(`${fixtureUrl}/big`)})`)
  const singleSamples: number[] = []
  for (let i = 0; i < 5; i++) {
    const single = await execute("snap-single", `
      const t0 = performance.now();
      const s = await snapshot();
      return { ms: performance.now() - t0, len: s.length };
    `)
    assert.equal(single.isError, false, single.text)
    assert.ok(single.value.len > 0 && single.value.len < 200_000)
    singleSamples.push(single.value.ms)
  }
  await api("/cli/session/delete", { id: "snap-single" })

  // 8 concurrent sessions × 3 rounds of big-dom-snapshot and warm snapshot().
  const sessions = Array.from({ length: 8 }, (_, index) => `snap-load-${index}`)
  for (const sessionId of sessions) {
    await api("/cli/session/new", { id: sessionId })
  }

  const scenarioMs: number[] = []
  const perSnapshotMs: number[] = []
  for (let round = 0; round < 3; round++) {
    if (round > 0) {
      await Promise.all(sessions.map((sessionId) => execute(sessionId, `await page.goto('about:blank')`)))
    }
    const batch = await Promise.all(sessions.map(async (sessionId) => {
      const started = performance.now()
      const response = await execute(sessionId, `
        await page.goto(${JSON.stringify(`${fixtureUrl}/big`)});
        const t0 = performance.now();
        const s = await snapshot();
        const t1 = performance.now();
        const f = await snapshot({ find: 'Row 4321' });
        const t2 = performance.now();
        return { len: s.length, find: f, snap1Ms: t1 - t0, snap2Ms: t2 - t1 };
      `)
      return { response, elapsedMs: performance.now() - started }
    }))
    for (const { response, elapsedMs } of batch) {
      assert.equal(response.isError, false, response.text)
      assert.ok(response.value.len > 0 && response.value.len < 200_000)
      assert.ok(String(response.value.find).includes("4321"))
      assert.ok(response.value.snap1Ms < 5_000, `snap1 took ${response.value.snap1Ms}ms`)
      assert.ok(response.value.snap2Ms < 5_000, `snap2 took ${response.value.snap2Ms}ms`)
      scenarioMs.push(elapsedMs)
      perSnapshotMs.push(response.value.snap1Ms, response.value.snap2Ms)
    }
  }

  const warmConcurrentMs: number[] = []
  for (let round = 0; round < 3; round++) {
    const batch = await Promise.all(sessions.map((sessionId) =>
      execute(sessionId, `const t0 = performance.now(); const s = await snapshot(); return { ms: performance.now() - t0, len: s.length }`),
    ))
    for (const response of batch) {
      assert.equal(response.isError, false, response.text)
      assert.ok(response.value.ms < 5_000, `concurrent snapshot took ${response.value.ms}ms`)
      warmConcurrentMs.push(response.value.ms)
    }
  }

  for (const sessionId of sessions) {
    await api("/cli/session/delete", { id: sessionId })
  }

  console.log(JSON.stringify({
    semantics: "PASS",
    singleSnapshotMs: summarize(singleSamples),
    concurrent8x3ScenarioMs: summarize(scenarioMs),
    concurrent8x3PerSnapshotMs: summarize(perSnapshotMs),
    concurrent8x3WarmSnapshotMs: summarize(warmConcurrentMs),
  }))
} finally {
  await browser?.close().catch(() => {})
  relay.kill("SIGTERM")
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => { relay.kill("SIGKILL"); resolve() }, 2_000)
    relay.once("exit", () => { clearTimeout(timer); resolve() })
  })
  await new Promise<void>((resolve) => fixture.close(() => resolve()))
  fs.closeSync(log)
  fs.rmSync(root, { recursive: true, force: true })
}
