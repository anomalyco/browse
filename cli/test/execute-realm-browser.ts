// Isolated headless integration check of the execute sandbox against a real browser:
//   bun run build && (cd cli && bun run build) && node --no-warnings test/execute-realm-browser.ts [--browser <chromium executable>]
// The browser is --browser, else PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, else patchright-core's own Chromium
// (`node node_modules/patchright-core/cli.js install chromium`). The temp root, paired relay, port-patched
// extension and launch come from startBrowserScene; ports come from BROWSE_TEST_RELAY_PORT and
// BROWSE_TEST_FIXTURE_PORT, or are free ports. Never uses the installed relay, its data or the user's profile.
import assert from "node:assert/strict"
import http from "node:http"
import { spawn } from "node:child_process"
import { parseArgs } from "node:util"
import { relayToken } from "../src/relay/secrets.ts"
import { startBrowserScene } from "./support/browser-scene.ts"

const { values: options } = parseArgs({ options: { browser: { type: "string" } } })
const scene = await startBrowserScene({ ...(options.browser === undefined ? {} : { browser: options.browser }), name: "realm3-browser-" })
const { cli, env, base, fixturePort, fixtureUrl } = scene
const authorization = `Bearer ${relayToken(scene.home)}`
const fixture = http.createServer((request, response) => {
  // Never answer: a pending navigation that must be stopped rather than awaited.
  if (request.url === "/hang") return
  response.setHeader("Content-Type", request.url === "/data" ? "application/json" : "text/html")
  response.end(request.url === "/data" ? '{"ok":true}' : '<title>Realm fixture</title><label>Name<input id="name"></label><button onclick="document.querySelector(\'output\').textContent=document.querySelector(\'input\').value">Save</button><output></output>')
})
fixture.headersTimeout = 0
fixture.requestTimeout = 0
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
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
function cliExecute(code: string, sessionId = "realm-e2e"): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [cli, "execute", "--session", sessionId, "--json", code], { env, stdio: ["ignore", "pipe", "pipe"] })
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
  // A stopped execute must not leave a Page.navigate the server never answers pending on its tab: Chromium queues
  // every renderer-bound command behind it, so the next execute (a fresh connectOverCDP) would hang.
  await api("/cli/session/new", { id: "realm-hang" })
  const hangStarted = Date.now()
  const hung = await api("/cli/execute", {
    sessionId: "realm-hang",
    code: `await page.goto(${JSON.stringify(fixtureUrl + "/hang")}); return page.url()`,
    createIfMissing: false,
    timeoutMs: 500,
  })
  assert.equal(hung.isError, true, hung.text)
  assert.equal(hung.diagnostic, "execute-timeout")
  assert.ok(Date.now() - hangStarted < 5_000)
  const afterHang = Date.now()
  const afterHangResult = await cliExecute("return 1", "realm-hang")
  assert.equal(afterHangResult.ok, true, afterHangResult.text)
  assert.equal(afterHangResult.text, "1")
  assert.ok(Date.now() - afterHang < 5_000, `execute after a stopped navigation took ${Date.now() - afterHang}ms`)
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
  console.log(JSON.stringify({ normal: "PASS", persistence: "PASS", handoffTimeout: "PASS", escapes: escapes.length, concurrentCpuTimeoutMs, handlerCpuTimeoutMs, rejectionIsolation: "PASS", recovery: "PASS", root: scene.root }))
} finally {
  await new Promise<void>(resolve => {
    fixture.closeAllConnections()
    fixture.close(() => resolve())
  })
  await scene.stop()
}
