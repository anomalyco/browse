// Isolated headless check of the guarded-agent features against a real browser: challenge detection, per-session
// domain allowlists, origin-bound secrets and page-visible API warnings.
//   bun build.ts && node --no-warnings test/guarded-agents-browser.ts [--browser <chromium executable>]
// Same isolation as execute-realm-browser.ts: a port-patched copy of the extension in Playwright's Chromium (headless),
// a fresh OPENCODE_BROWSER_HOME and relay port (BROWSE_TEST_RELAY_PORT / BROWSE_TEST_FIXTURE_PORT, else free ports).
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
assert.ok(fs.existsSync(executablePath), `No Chromium at ${executablePath}`)
const tmp = path.join(fs.realpathSync(os.tmpdir()), "opencode")
fs.mkdirSync(tmp, { recursive: true })
const root = fs.mkdtempSync(path.join(tmp, "guarded-browser-"))
const home = path.join(root, "home")
const runtime = path.join(root, "runtime")
const extension = path.join(home, "extension")
const cliRoot = path.resolve(import.meta.dirname, "..")
const port = await portFromEnv("BROWSE_TEST_RELAY_PORT")
const fixturePort = await portFromEnv("BROWSE_TEST_FIXTURE_PORT")
const site = `http://127.0.0.1:${fixturePort}`
const other = `http://localhost:${fixturePort}`
const base = `http://127.0.0.1:${port}`
const secretValue = "s3cr3t-Value!x"
const env: NodeJS.ProcessEnv = {
  ...process.env,
  HOME: root,
  OPENCODE_BROWSER_HOME: home,
  OPENCODE_BROWSER_PORT: String(port),
  OPENCODE_BROWSER_UPDATE_CHECK: "0",
  OPENCODE_BROWSER_CHALLENGE_WAIT_MS: "4000",
  OPENCODE_BROWSER_HUMAN_INPUT: "0",
}
delete env.OPENCODE_BROWSER_ALLOW_NODE
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

const page = (title: string, body: string) => `<!doctype html><title>${title}</title><body>${body}</body>`
let otherHostHits = 0
const fixture = http.createServer((request, response) => {
  const url = new URL(request.url ?? "/", site)
  if (request.headers.host?.startsWith("localhost")) otherHostHits += 1
  const html = (status: number, content: string) => { response.writeHead(status, { "content-type": "text/html" }); response.end(content) }
  switch (url.pathname) {
    case "/": return html(200, page("Home", `<a id="out" href="${other}/login">elsewhere</a><button id="pop" onclick="window.open('${other}/login')">popup</button><p>${"Plain content. ".repeat(10)}</p>`))
    case "/login": return html(200, page("Login", `<form method="post" action="/submit"><input id="user" name="login"><input id="pass" name="login2" type="password"><button>Sign in</button></form><iframe src="${other}/frame" width="300" height="80"></iframe>`))
    case "/frame": return html(200, page("Frame", `<input id="inner" name="inner">`))
    case "/redirect": response.writeHead(302, { location: `${other}/login` }); response.end(); return
    case "/submit": {
      let body = ""
      request.on("data", (chunk) => { body += chunk })
      request.on("end", () => html(200, page("Submitted", `<p id="len">${body.length}</p>`)))
      return
    }
    case "/cf-wait": return html(200, page("Just a moment...", `<div id="challenge-running">Checking your browser</div><script>setTimeout(()=>location.replace('/cleared'),1500)</script>`))
    case "/cf-stuck": return html(200, page("Just a moment...", `<div id="challenge-running">Checking your browser</div>`))
    case "/px": return html(200, page("Access to this page has been denied", `<div id="px-captcha" style="width:300px;height:80px"></div><p>Press &amp; Hold to confirm you are a human (and not a bot).</p>`))
    case "/blocked": return html(403, page("Access Denied", `<h1>Access denied</h1>`))
    case "/cleared": return html(200, page("Shop", `<h1>Welcome</h1><p>${"Real content. ".repeat(20)}</p>`))
    default: return html(404, page("Not found", "nothing"))
  }
})

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
let authorization = ""
async function api(route: string, body?: unknown) {
  const response = await fetch(`${base}${route}`, {
    ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
    headers: { authorization, "content-type": "application/json" },
  })
  const json = await response.json() as Record<string, any>
  assert.equal(response.status, 200, `${route}: ${JSON.stringify(json)}`)
  return json
}
async function execute(sessionId: string, code: string) {
  return await api("/cli/execute", { sessionId, code, createIfMissing: false })
}
function runCli(args: readonly string[], input?: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("node", [cli, ...args], { env, input, encoding: "utf8" })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}
function filesContaining(directory: string, needle: string, skip: string): string[] {
  const found: string[] = []
  for (const entry of fs.readdirSync(directory, { recursive: true })) {
    const file = path.join(directory, String(entry))
    if (file.startsWith(skip) || !fs.statSync(file).isFile()) continue
    if (fs.readFileSync(file).includes(needle)) found.push(file)
  }
  return found
}

const log = fs.openSync(path.join(root, "relay.log"), "w", 0o600)
const relay = spawn("node", [cli, "serve"], { env, stdio: ["ignore", log, log] })
let browser: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined
const report: Record<string, unknown> = { root }
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
    if ((await api("/extension/status")).connected) break
    await pause(100)
  }
  assert.equal((await api("/extension/status")).connected, true)

  // ---- challenge detection ------------------------------------------------------------------------
  await api("/cli/session/new", { id: "guard-challenge" })
  const cleared = await execute("guard-challenge", `await page.goto(${JSON.stringify(`${site}/cf-wait`)}); return await page.title()`)
  assert.equal(cleared.isError, false, cleared.text)
  assert.equal(cleared.aftermath.challenge?.status, "cleared", JSON.stringify(cleared.aftermath))
  assert.equal(cleared.aftermath.challenge.vendor, "cloudflare")
  const stuck = await execute("guard-challenge", `await page.goto(${JSON.stringify(`${site}/cf-stuck`)})`)
  assert.equal(stuck.aftermath.challenge?.status, "blocked", JSON.stringify(stuck.aftermath))
  assert.ok(stuck.aftermath.challenge.waitedMs >= 3_500, JSON.stringify(stuck.aftermath))
  assert.equal(stuck.aftermath.challenge.recommendation, "handoff")
  const px = await execute("guard-challenge", `await page.goto(${JSON.stringify(`${site}/px`)})`)
  assert.deepEqual(
    { vendor: px.aftermath.challenge?.vendor, kind: px.aftermath.challenge?.kind, status: px.aftermath.challenge?.status, recommendation: px.aftermath.challenge?.recommendation, waitedMs: px.aftermath.challenge?.waitedMs },
    { vendor: "perimeterx", kind: "interactive", status: "blocked", recommendation: "handoff", waitedMs: 0 },
  )
  assert.ok(px.warnings.some((warning: string) => warning.includes("handoff(")), JSON.stringify(px.warnings))
  const blocked = await execute("guard-challenge", `await page.goto(${JSON.stringify(`${site}/blocked`)})`)
  assert.equal(blocked.aftermath.challenge?.kind, "block")
  assert.equal(blocked.aftermath.challenge?.recommendation, "stop")
  const failedOnChallenge = await execute("guard-challenge", `await page.goto(${JSON.stringify(`${site}/px`)}); await page.locator('#search').click({timeout: 500})`)
  assert.equal(failedOnChallenge.isError, true)
  assert.equal(failedOnChallenge.aftermath.challenge?.vendor, "perimeterx")
  const normal = await execute("guard-challenge", `await page.goto(${JSON.stringify(`${site}/cleared`)})`)
  assert.equal(normal.aftermath.challenge, undefined)
  report.challenges = { cleared: cleared.aftermath.challenge, stuck: stuck.aftermath.challenge, px: px.aftermath.challenge, blocked: blocked.aftermath.challenge }

  // ---- page-visible API warnings ------------------------------------------------------------------
  const visible = await execute("guard-challenge", `
    await page.addInitScript(() => {});
    await page.route('**/cleared', route => route.fulfill({ body: '<title>Fulfilled</title>', contentType: 'text/html' }));
    await page.goto(${JSON.stringify(`${site}/cleared`)});
    await page.unrouteAll();
    return await page.title()`)
  assert.equal(visible.isError, false, visible.text)
  assert.equal(visible.value, "Fulfilled")
  assert.ok(visible.warnings.some((warning: string) => warning.startsWith("addInitScript() is visible to pages")), JSON.stringify(visible.warnings))
  assert.ok(visible.warnings.some((warning: string) => warning.startsWith("route.fulfill() on a navigation request")), JSON.stringify(visible.warnings))
  const quiet = await execute("guard-challenge", `await page.route('**/data', route => route.fulfill({ body: '{}' })); await page.evaluate(() => fetch('/data')); await page.unrouteAll(); return 1`)
  assert.ok(!quiet.warnings.some((warning: string) => warning.includes("visible to pages")), JSON.stringify(quiet.warnings))
  report.warnings = "PASS"

  // ---- domain allowlist ---------------------------------------------------------------------------
  const created = runCli(["session", "new", "guard-allow", "--allow-origin", "127.0.0.1", "--allow-origin", "*.app.localhost"])
  assert.equal(created.status, 0, created.stderr)
  const listed = runCli(["session", "list"])
  assert.match(listed.stdout, /guard-allow .*allow=127\.0\.0\.1,\*\.app\.localhost/)
  const allowed = await execute("guard-allow", `await page.goto(${JSON.stringify(`${site}/`)}); return page.url()`)
  assert.equal(allowed.isError, false, allowed.text)
  const refused = await execute("guard-allow", `await page.goto(${JSON.stringify(`${other}/login`)})`)
  assert.equal(refused.isError, true)
  assert.match(refused.text, /domain allowlist and localhost:\d+ is not in the allowed origins/)
  const privateIp = await execute("guard-allow", `await page.goto('http://169.254.169.254/latest/meta-data/')`)
  assert.equal(privateIp.isError, true)
  assert.match(privateIp.text, /domain allowlist/)
  const wildcardPrivate = await execute("guard-allow", `await page.goto(${JSON.stringify(`http://web.app.localhost:${fixturePort}/`)})`)
  assert.equal(wildcardPrivate.isError, true)
  assert.match(wildcardPrivate.text, /private, loopback or local address/)
  const decimalIp = await execute("guard-allow", `await page.goto('http://2130706434/')`)
  assert.equal(decimalIp.isError, true, "127.0.0.2 spelled as a decimal must be refused")
  const newTab = await execute("guard-allow", `const tab = await context.newPage(); try { await tab.goto(${JSON.stringify(`${other}/`)}); return 'loaded' } catch (error) { return error.message } finally { await tab.close() }`)
  assert.match(String(newTab.value), /domain allowlist/)
  const hitsBefore = otherHostHits
  const clicked = await execute("guard-allow", `
    await page.goto(${JSON.stringify(`${site}/`)});
    await page.click('#out');
    await page.waitForTimeout(1500);
    return page.url()`)
  assert.equal(clicked.isError, false, clicked.text)
  // Stopped before it committed (the page stays) or replaced after it committed (about:blank); never the other host.
  assert.ok(clicked.value === `${site}/` || clicked.value === "about:blank", clicked.value)
  assert.ok(clicked.warnings.some((warning: string) => warning.startsWith("Domain allowlist: a tab of session guard-allow")), JSON.stringify(clicked.warnings))
  report.inPageLinkRequestReachedServer = otherHostHits > hitsBefore
  const hitsBeforePopup = otherHostHits
  const popup = await execute("guard-allow", `
    await page.goto(${JSON.stringify(`${site}/`)});
    const popupPromise = context.waitForEvent('page', { timeout: 10000 }).catch(() => undefined);
    await page.click('#pop');
    const opened = await popupPromise;
    if (opened && !opened.isClosed()) await opened.waitForEvent('close', { timeout: 10000 });
    return context.pages().map(p => p.url())`)
  assert.equal(popup.isError, false, popup.text)
  assert.ok(!popup.value.some((url: string) => url.startsWith(other)), JSON.stringify(popup.value))
  assert.ok(popup.warnings.some((warning: string) => warning.includes("closed the popup")), JSON.stringify(popup.warnings))
  report.popupRequestReachedServer = otherHostHits > hitsBeforePopup
  const redirect = await execute("guard-allow", `
    const error = await page.goto(${JSON.stringify(`${site}/redirect`)}).then(() => undefined, (error) => error.message);
    await page.waitForURL(url => !url.href.startsWith(${JSON.stringify(other)}), { timeout: 10000 });
    await page.waitForTimeout(500);
    return { url: page.url(), error }`)
  assert.equal(redirect.isError, false, redirect.text)
  assert.equal(redirect.value.url, "about:blank", JSON.stringify(redirect.value))
  assert.ok(redirect.warnings.some((warning: string) => warning.includes("sent the tab back to about:blank")), JSON.stringify(redirect.warnings))
  report.allowlist = { serverRedirect: "PASS", refused: "PASS", privateIp: "PASS", wildcardPrivate: "PASS", decimalIp: "PASS", newTab: "PASS", inPageLink: "PASS", popup: "PASS" }

  // ---- origin-bound secrets -----------------------------------------------------------------------
  const added = runCli(["secrets", "add", "shop", "--origin", site], `${secretValue}\n`)
  assert.equal(added.status, 0, added.stderr)
  assert.ok(!added.stdout.includes(secretValue) && !added.stderr.includes(secretValue))
  const secretList = runCli(["secrets", "list", "--json"])
  assert.deepEqual(JSON.parse(secretList.stdout).secrets.map((secret: { name: string }) => secret.name), ["shop"])
  await api("/cli/session/new", { id: "guard-secrets" })
  const typed = await execute("guard-secrets", `
    await network.start({ content: 'embed' });
    await page.goto(${JSON.stringify(`${site}/login`)});
    const result = await secrets.type('#pass', 'shop');
    const readBack = await page.inputValue('#pass');
    console.log('typed', readBack);
    await Promise.all([page.waitForURL('**/submit'), page.click('button')]);
    const capture = await network.stop({ outputPath: files.path('guarded.har') });
    return { result, readBack, length: await page.textContent('#len'), har: capture.outputPath }`)
  assert.equal(typed.isError, false, typed.text)
  assert.deepEqual(typed.value.result, { typed: true, name: "shop", origin: site, kind: "password" })
  assert.equal(typed.value.readBack, "[secret shop]")
  assert.ok(Number(typed.value.length) > secretValue.length, "the form posted the typed value")
  assert.ok(typed.warnings.some((warning: string) => warning.includes("without a domain allowlist")), JSON.stringify(typed.warnings))
  assert.ok(!JSON.stringify(typed).includes(secretValue), "the execute result must not contain the secret")
  const har = fs.readFileSync(typed.value.har, "utf8")
  assert.ok(har.includes("/submit"), "the HAR has the form post")
  assert.ok(!har.includes(secretValue) && !har.includes(encodeURIComponent(secretValue)), "the HAR must not contain the secret")
  const iframe = await execute("guard-secrets", `await page.goto(${JSON.stringify(`${site}/login`)}); return await secrets.type(page.frameLocator('iframe').locator('#inner'), 'shop')`)
  assert.equal(iframe.isError, true)
  assert.match(iframe.text, /domain_not_allowed: the field's frame is http:\/\/localhost:\d+/)
  const redirected = await execute("guard-secrets", `await page.goto(${JSON.stringify(`${site}/redirect`)}); return await secrets.type('#pass', 'shop')`)
  assert.equal(redirected.isError, true)
  assert.match(redirected.text, /domain_not_allowed: the field's frame is http:\/\/localhost:\d+/)
  const notEditable = await execute("guard-secrets", `await page.goto(${JSON.stringify(`${site}/login`)}); return await secrets.type('button', 'shop')`)
  assert.equal(notEditable.isError, true)
  assert.match(notEditable.text, /target_not_editable/)
  const missing = await execute("guard-secrets", `return await secrets.type('#pass', 'nope')`)
  assert.match(missing.text, /Secret not found: nope/)
  assert.equal(runCli(["session", "allow", "--session", "guard-secrets", "127.0.0.1"]).status, 0)
  const withAllowlist = await execute("guard-secrets", `await page.goto(${JSON.stringify(`${site}/login`)}); return await secrets.type('#user', 'shop')`)
  assert.equal(withAllowlist.isError, false, withAllowlist.text)
  assert.ok(!withAllowlist.warnings.some((warning: string) => warning.includes("without a domain allowlist")), JSON.stringify(withAllowlist.warnings))
  await pause(500)
  // Relay data (journals, logs, session catalog) and the relay log; the browser's own profile is the browser's.
  const leaks = [...filesContaining(home, secretValue, path.join(home, "site-secrets")), ...filesContaining(path.dirname(path.join(root, "relay.log")), secretValue, path.join(root, "profile")).filter((file) => !file.startsWith(home))]
  assert.deepEqual(leaks, [], `the secret leaked into ${leaks.join(", ")}`)
  report.secrets = { typed: "PASS", readBackRedacted: "PASS", harRedacted: "PASS", crossOriginIframe: "PASS", redirect: "PASS", notEditable: "PASS", noLeaksOnDisk: "PASS" }
  console.log(JSON.stringify(report, null, 2))
} finally {
  await browser?.close()
  relay.kill("SIGTERM")
  await new Promise<void>(resolve => fixture.close(() => resolve()))
  fs.closeSync(log)
}
