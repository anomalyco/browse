// Isolated headless integration check of the execute sandbox against a real browser:
//   bun build.ts && node --no-warnings test/execute-realm-browser.ts [--browser <chromium executable>]
// The browser is --browser, else PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, else patchright-core's own Chromium
// (`node node_modules/patchright-core/cli.js install chromium`). Ports come from BROWSE_TEST_RELAY_PORT and
// BROWSE_TEST_FIXTURE_PORT, or are free ports. Never uses the installed relay, its data or the user's profile.
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import net from "node:net"
import { spawn, spawnSync } from "node:child_process"
import { parseArgs } from "node:util"
import { chromium } from "patchright-core"
import { relayToken } from "../src/relay-secrets.ts"

async function freePort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve) })
  const { port } = server.address() as net.AddressInfo
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}
async function portFromEnv(name: string): Promise<number> {
  const value = process.env[name]
  if (!value) return await freePort()
  const port = Number(value)
  assert.ok(Number.isInteger(port) && port > 0 && port < 65536, `${name} must be a port number`)
  return port
}

const { values: options } = parseArgs({ options: { browser: { type: "string" } } })
const executablePath = options.browser || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || chromium.executablePath()
assert.ok(fs.existsSync(executablePath), `No Chromium at ${executablePath}: pass --browser, set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH or run \`node node_modules/patchright-core/cli.js install chromium\``)
const tmp = path.join(fs.realpathSync(os.tmpdir()), "opencode")
fs.mkdirSync(tmp, { recursive: true })
const root = fs.mkdtempSync(path.join(tmp, "realm3-browser-"))
const home = path.join(root, "home")
const runtime = path.join(root, "runtime")
const extension = path.join(home, "extension")
const cliRoot = path.resolve(import.meta.dirname, "..")
const port = await portFromEnv("BROWSE_TEST_RELAY_PORT")
const fixturePort = await portFromEnv("BROWSE_TEST_FIXTURE_PORT")
const fixtureUrl = `http://127.0.0.1:${fixturePort}`
const base = `http://127.0.0.1:${port}`
const env: NodeJS.ProcessEnv = { ...process.env, HOME: root, OPENCODE_BROWSER_HOME: home, OPENCODE_BROWSER_PORT: String(port) }
delete env.OPENCODE_BROWSER_ALLOW_NODE
delete env.OPENCODE_BROWSER_ALLOW_FOREGROUND
fs.mkdirSync(path.join(runtime, "dist"), { recursive: true })
fs.cpSync(path.join(cliRoot, "extension"), extension, { recursive: true })
fs.copyFileSync(path.join(cliRoot, "dist/cli.mjs"), path.join(runtime, "dist/cli.mjs"))
fs.symlinkSync(path.join(cliRoot, "node_modules"), path.join(runtime, "node_modules"), "dir")
for (const entry of fs.readdirSync(extension, { recursive: true })) {
  const file = path.join(extension, String(entry))
  if (/\.(js|json)$/.test(file)) fs.writeFileSync(file, fs.readFileSync(file, "utf8").replaceAll("19988", String(port)))
}
const cli = path.join(runtime, "dist/cli.mjs")
assert.equal(spawnSync("node", [cli, "pair"], { env, stdio: "ignore" }).status, 0)
assert.ok(fs.existsSync(path.join(extension, "relay-pairing.json")))
const log = fs.openSync(path.join(root, "relay.log"), "w", 0o600)
const relay = spawn("node", [cli, "serve"], { env, stdio: ["ignore", log, log] })
let browser: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined
const fixture = http.createServer((request, response) => {
  response.setHeader("Content-Type", request.url === "/data" ? "application/json" : "text/html")
  response.end(request.url === "/data" ? '{"ok":true}' : '<title>Realm fixture</title><label>Name<input id="name"></label><button onclick="document.querySelector(\'output\').textContent=document.querySelector(\'input\').value">Save</button><output></output>')
})
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
let authorization = ""
async function api(route: string, body?: unknown) {
  const response = await fetch(`${base}${route}`, {
    ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
    headers: { authorization, "content-type": "application/json" },
  })
  assert.equal(response.status, 200, route)
  return await response.json() as Record<string, any>
}
async function execute(code: string, sessionId = "realm-e2e") {
  return await api("/cli/execute", { sessionId, code, createIfMissing: false })
}
function cliExecute(code: string): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [cli, "execute", "--session", "realm-e2e", "--json", code], { env, stdio: ["ignore", "pipe", "pipe"] })
    let output = ""
    child.stdout.on("data", data => { output += data })
    child.on("error", reject)
    child.on("exit", () => {
      try { resolve(JSON.parse(output)) } catch { reject(new Error("CLI returned no JSON")) }
    })
  })
}
try {
  await new Promise<void>((resolve, reject) => { fixture.once("error", reject); fixture.listen(fixturePort, "127.0.0.1", resolve) })
  for (let i = 0; i < 100; i++) {
    if (await fetch(`${base}/version`).then(r => r.ok, () => false)) break
    await pause(50)
  }
  authorization = `Bearer ${relayToken(home)}`
  browser = await chromium.launchPersistentContext(path.join(root, "profile"), {
    executablePath,
    headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  })
  for (let i = 0; i < 100; i++) {
    const status = await api("/extension/status")
    if (status.connected) break
    await pause(100)
  }
  assert.equal((await api("/extension/status")).connected, true)
  await api("/cli/session/new", { id: "realm-e2e" })
  const normal = await cliExecute(`
    await page.goto(${JSON.stringify(fixtureUrl)});
    await page.getByLabel('Name').fill('sandbox');
    await page.getByRole('button',{name:'Save'}).click();
    const outline = await snapshot();
    state.count = 1;
    state.locator = page.locator('output');
    state.console = [];
    page.on('console', message => state.console.push(message.text()));
    await pageConsole.start();
    await page.evaluate(value => console.log(value), 'console-probe');
    await page.route('**/mock', route => route.fulfill({body:'mocked',contentType:'text/plain'}));
    const routed = await page.evaluate(() => fetch('/mock').then(r=>r.text()));
    await network.start();
    await page.evaluate(() => fetch('/data').then(r=>r.json()));
    const capture = await network.stop();
    const bytes = await page.screenshot();
    await page.screenshot({path:files.path('e2e.png')});
    const saved = await files.read(files.path('e2e.png'));
    return {outline, routed, output:await state.locator.textContent(), count:state.count,
      console:state.console, screenshot:Buffer.isBuffer(bytes), saved:saved.length>0,
      evaluated:await page.evaluate(({n})=>n+1,{n:41}), capture};
  `)
  assert.equal(normal.ok, true, normal.text)
  assert.equal(normal.value.output, "sandbox")
  assert.equal(normal.value.routed, "mocked")
  assert.equal(normal.value.evaluated, 42)
  assert.equal(normal.value.screenshot, true)
  assert.equal(normal.value.saved, true)
  assert.deepEqual(normal.value.console, ["console-probe"])
  assert.ok(normal.logs.some((entry: { text: string }) => entry.text.includes("console-probe")))
  const persisted = await cliExecute("return {count:++state.count, output:await state.locator.textContent()}")
  assert.deepEqual(persisted.value, { count: 2, output: "sandbox" })
  const handoff = await cliExecute("await handoff('Headless timeout check', {timeoutMs:50})")
  assert.equal(handoff.isError, true)
  assert.match(handoff.text, /Handoff timed out/)
  const escapes = [
    "'use strict'; Object.getPrototypeOf(page).goto = ()=>{}",
    "'use strict'; modules.events.prototype.emit = ()=>{}",
    "await page.screenshot.call(page, {path:'/etc/realm-denied.png'})",
    "await page.screenshot.apply(page, [{path:'/etc/realm-denied.png'}])",
    "await page.screenshot.bind(page)({path:'/etc/realm-denied.png'})",
    "await Reflect.apply(context.storageState,context,[{path:'/etc/realm-denied'}])",
    "await page.getByLabel('Name').setInputFiles.call(page.getByLabel('Name'),'/etc/hosts')",
    "await page.bringToFront.call(page)",
    "return page.request",
    "return context.request",
    "return context.tracing",
    "await page.route('**/denied', async route => { try { await route.fetch() } catch(error) { state.denied=error.message; await route.fulfill({body:'denied'}) } }); await page.evaluate(()=>fetch('/denied')); if(!state.denied) throw Error('Route.fetch escaped'); return state.denied",
    "await page.route('**/response-denied', async route => { try { await route.fulfill({response:{}}) } catch(error) { state.fulfillDenied=error.message; await route.fulfill({body:'denied'}) } }); await page.evaluate(()=>fetch('/response-denied')); if(!state.fulfillDenied) throw Error('Route.fulfill escaped'); return state.fulfillDenied",
  ]
  for (let i = 0; i < escapes.length; i++) {
    const result = await cliExecute(escapes[i]!)
    if (i < escapes.length - 2) assert.equal(result.isError, true, `escape ${i}: ${result.text}`)
    else { assert.equal(result.isError, false, result.text); assert.match(result.value, /Node-side requests/) }
  }
  await api("/cli/session/new", { id: "realm-loop" })
  await execute("return 1", "realm-loop")
  const started = Date.now()
  const looping = execute("await Promise.resolve(); while(true){}", "realm-loop")
  const [loop, healthy, health] = await Promise.all([looping, execute("return 42"), api("/extension/status")])
  assert.equal(loop.isError, true, JSON.stringify(loop))
  assert.match(loop.text, /CPU budget/)
  assert.equal(healthy.value, 42)
  assert.equal(health.connected, true)
  assert.ok(Date.now() - started < 5_000)
  const concurrentCpuTimeoutMs = Date.now() - started
  const recovered = await execute("return 42", "realm-loop")
  assert.equal(recovered.value, 42)
  assert.ok(recovered.warnings.some((warning: string) => warning.includes("state and pending callbacks were reset")))
  const rejected = await execute("Promise.reject(new Error('isolated rejection')); await new Promise(()=>{})", "realm-loop")
  assert.equal(rejected.isError, true)
  assert.match(rejected.text, /Unhandled execute rejection/)
  assert.equal((await api("/extension/status")).connected, true)
  assert.equal((await execute("return 42", "realm-loop")).value, 42)
  // A loop in a Playwright event handler (dispatched from the relay's WebSocket, outside any execute call).
  await execute(`await page.goto(${JSON.stringify(fixtureUrl)})`, "realm-loop")
  const handlerStarted = Date.now()
  const handlerLoop = execute("page.on('request', () => { while(true){} }); await page.evaluate(() => fetch('/data')); await new Promise(r => setTimeout(r, 10_000))", "realm-loop")
  await pause(200)
  const [handlerResult, otherSession, versionDuringLoop] = await Promise.all([handlerLoop, execute("return await page.title()"), fetch(`${base}/version`).then(r => r.status)])
  assert.equal(handlerResult.isError, true, JSON.stringify(handlerResult))
  assert.match(handlerResult.text, /CPU budget/)
  assert.equal(otherSession.value, "Realm fixture")
  assert.equal(versionDuringLoop, 200)
  const handlerCpuTimeoutMs = Date.now() - handlerStarted
  assert.ok(handlerCpuTimeoutMs < 5_000)
  assert.equal((await execute("return 7", "realm-loop")).value, 7)
  console.log(JSON.stringify({ normal: "PASS", persistence: "PASS", handoffTimeout: "PASS", escapes: escapes.length, concurrentCpuTimeoutMs, handlerCpuTimeoutMs, rejectionIsolation: "PASS", recovery: "PASS", root }))
} finally {
  await browser?.close()
  relay.kill("SIGTERM")
  await new Promise<void>(resolve => fixture.close(() => resolve()))
  fs.closeSync(log)
}
