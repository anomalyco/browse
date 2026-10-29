// Isolated headless check of the guarded-agent features against a real browser: challenge detection, per-session
// domain allowlists, origin-bound secrets, page-visible API warnings, and Deadbolt sign-ins and passkeys (against a
// fake Deadbolt socket, test/fake-deadbolt.ts).
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
import { saveClient } from "../src/deadbolt.ts"
import { startFakeDeadbolt } from "./fake-deadbolt.ts"

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

// ---- fake Deadbolt: the relay finds it through OPENCODE_BROWSER_DEADBOLT_SOCKET and the client file in its home.
const dbPassword = "Db-Pa55word!q7"
const dbTotp = "123456"
const fakeDeadbolt = await startFakeDeadbolt({
  directory: path.join(root, "db"),
  logins: [
    { ref: { vault: "v", item: "alice" }, site, title: "Fixture", username: "alice@example.com", values: { username: "alice@example.com", password: dbPassword, totp: dbTotp }, fields: ["username", "password", "totp"], passkeys: true, passkey: { displayName: "Alice" } },
    { ref: { vault: "v", item: "carol" }, site, title: "Fixture (carol)", username: "carol", values: { username: "carol" }, fields: [], passkeys: true, passkey: { displayName: "Carol" } },
    { ref: { vault: "v", item: "bob" }, site, title: "Fixture (bob)", username: "bob", values: { username: "bob", password: "bob-password-x" }, fields: [] },
  ],
})
await saveClient(fakeDeadbolt.client, home)
env.OPENCODE_BROWSER_DEADBOLT_SOCKET = fakeDeadbolt.socket

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
    case "/db/spa": return html(200, page("Sign in", `<div id="app"><label for="email">Email</label><input id="email" type="email" autocomplete="username"><button id="next">Next</button></div>
<script>
next.onclick = () => {
  const user = email.value
  app.innerHTML = '<label for="pw">Password</label><input id="pw" type="password" autocomplete="current-password"><button id="go">Sign in</button>'
  go.onclick = async () => {
    const response = await fetch('/db/check', { method: 'POST', body: JSON.stringify({ user, password: pw.value }) })
    app.innerHTML = (await response.json()).ok ? '<h1>Welcome back</h1><a href="/">Home</a>' : '<p role="alert">Wrong password. Try again.</p><input id="pw" type="password"><button>Sign in</button>'
  }
}
</script>`))
    case "/db/check": {
      let body = ""
      request.on("data", (chunk) => { body += chunk })
      request.on("end", () => {
        const { user, password } = JSON.parse(body)
        response.writeHead(200, { "content-type": "application/json" })
        response.end(JSON.stringify({ ok: user === "alice@example.com" && password === dbPassword }))
      })
      return
    }
    case "/db/two": return html(200, page("Sign in", `<form action="/db/two/password"><label>Username <input name="username" autocomplete="username"></label><button type="submit">Continue</button></form>`))
    case "/db/two/password": return html(200, page("Password", `<form method="post" action="/db/two/otp"><input type="hidden" name="username" value="${url.searchParams.get("username") ?? ""}"><label>Password <input type="password" name="password"></label><button>Log in</button></form>`))
    case "/db/two/otp":
    case "/db/two/done": {
      let body = ""
      request.on("data", (chunk) => { body += chunk })
      request.on("end", () => {
        const form = new URLSearchParams(body)
        if (url.pathname === "/db/two/otp") {
          if (form.get("password") !== dbPassword || form.get("username") !== "alice@example.com") return html(200, page("Password", `<p role="alert">Incorrect password</p>`))
          const boxes = Array.from({ length: 6 }, (_, index) => `<input name="d${index}" maxlength="1" inputmode="numeric" aria-label="Digit ${index + 1}">`).join("")
          return html(200, page("Two-factor", `<p>Enter the 6-digit code from your authenticator app.</p><form id="f" method="post" action="/db/two/done">${boxes}</form>
<script>
const inputs = [...document.querySelectorAll('#f input')]
inputs.forEach((input, index) => input.addEventListener('input', () => {
  if (input.value && inputs[index + 1]) inputs[index + 1].focus()
  if (inputs.every((box) => box.value)) document.getElementById('f').submit()
}))
</script>`))
        }
        const code = Array.from({ length: 6 }, (_, index) => form.get(`d${index}`) ?? "").join("")
        return html(200, page(code === dbTotp ? "Dashboard" : "Two-factor", code === dbTotp ? `<h1>Signed in</h1>` : `<p role="alert">Invalid code</p>`))
      })
      return
    }
    case "/db/captcha": return html(200, page("Sign in", `<form><input type="email" autocomplete="username"><input type="password"><button>Sign in</button></form><iframe src="/recaptcha/api2/anchor?k=x" width="300" height="80"></iframe>`))
    case "/db/sms": return html(200, page("Verify", `<p>We sent a code to your phone ending in 42.</p><input autocomplete="one-time-code" inputmode="numeric"><button>Verify</button>`))
    case "/db/pk-login": return html(200, page("Sign in", `<button id="pk">Sign in with a passkey</button><p id="err"></p>
<script>
pk.onclick = async () => {
  try {
    const credential = await navigator.credentials.get({ publicKey: { challenge: new Uint8Array(32).fill(3), rpId: location.hostname, userVerification: 'preferred' } })
    location.href = '/db/pk-ok?id=' + credential.id
  } catch (error) {
    err.textContent = error.name
  }
}
</script>`))
    case "/db/pk-ok": return html(200, page("Welcome", `<h1>Welcome ${Buffer.from(url.searchParams.get("id") ?? "", "base64url").toString()}</h1>`))
    case "/db/passkey": return html(200, page("Passkey", `<button id="pk">Sign in with a passkey</button><pre id="out"></pre>
<script>
document.title = Object.getOwnPropertyNames(window).some((key) => /^__b[0-9a-f]{24}$/.test(key)) ? 'binding-leaked' : 'Passkey'
pk.onclick = async () => {
  try {
    const credential = await navigator.credentials.get({ publicKey: { challenge: new Uint8Array(32).fill(9), rpId: location.hostname, allowCredentials: [], userVerification: 'preferred' } })
    out.textContent = JSON.stringify({ ok: true, id: credential.id, type: credential.type, isPublicKeyCredential: credential instanceof PublicKeyCredential, clientData: JSON.parse(new TextDecoder().decode(credential.response.clientDataJSON)), signature: credential.response.signature.byteLength, json: credential.toJSON().id })
  } catch (error) {
    out.textContent = JSON.stringify({ ok: false, name: error.name })
  }
}
</script>`))
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

  // ---- Deadbolt logins ----------------------------------------------------------------------------
  await api("/cli/session/new", { id: "guard-db" })
  const dbName = `deadbolt:${site}/alice@example.com`
  const dbTyped = await execute("guard-db", `
    await page.goto(${JSON.stringify(`${site}/login`)});
    const user = await secrets.type('#user', ${JSON.stringify(dbName)}, { field: 'username' });
    const result = await secrets.type('#pass', ${JSON.stringify(dbName)});
    const readBack = await page.inputValue('#pass');
    console.log('typed', readBack);
    return { user, result, username: await page.inputValue('#user'), readBack }`)
  assert.equal(dbTyped.isError, false, dbTyped.text)
  assert.deepEqual(dbTyped.value.result, { typed: true, name: dbName, origin: site, field: "password" })
  assert.equal(dbTyped.value.username, "alice@example.com")
  assert.equal(dbTyped.value.readBack, `[secret deadbolt:${site}/alice@example.com password]`)
  assert.ok(!JSON.stringify(dbTyped).includes(dbPassword), "the execute result must not contain the Deadbolt password")
  const fills = fakeDeadbolt.requests.filter((request) => request.cmd === "agent-fill")
  assert.ok(fills.length >= 2 && fills.every((request) => request.origin === site), JSON.stringify(fills.map((request) => request.origin)))
  const dbIframe = await execute("guard-db", `return await secrets.type(page.frameLocator('iframe').locator('#inner'), ${JSON.stringify(dbName)})`)
  assert.equal(dbIframe.isError, true)
  assert.match(dbIframe.text, /domain_not_allowed: the field's frame is http:\/\/localhost:\d+/)
  const fillsBefore = fakeDeadbolt.requests.filter((request) => request.cmd === "agent-fill").length
  const dbNotGranted = await execute("guard-db", `return await secrets.type('#pass', ${JSON.stringify(`deadbolt:${site}/bob`)})`)
  assert.equal(dbNotGranted.isError, true)
  assert.match(dbNotGranted.text, /not_granted: No Deadbolt login for bob is granted/)
  assert.equal(fakeDeadbolt.requests.filter((request) => request.cmd === "agent-fill").length, fillsBefore, "nothing is asked of Deadbolt for an ungranted login")
  const dbWrongSite = await execute("guard-db", `return await secrets.type('#pass', 'deadbolt:example.com')`)
  assert.match(dbWrongSite.text, /domain_not_allowed: the field's frame is http:\/\/127\.0\.0\.1:\d+, which is not on example\.com/)
  fakeDeadbolt.locked = true
  const dbLocked = await execute("guard-db", `return await secrets.type('#pass', ${JSON.stringify(dbName)})`)
  fakeDeadbolt.locked = false
  assert.match(dbLocked.text, /secrets\.type: locked: .*Deadbolt is locked/)
  assert.equal(runCli(["session", "allow", "--session", "guard-db", "localhost"]).status, 0)
  const dbOutside = await execute("guard-db", `return { url: page.url(), result: await secrets.type('#pass', ${JSON.stringify(dbName)}).catch((error) => error.message) }`)
  assert.ok(dbOutside.value.url === "about:blank" || /outside this session's domain allowlist/.test(dbOutside.value.result), JSON.stringify(dbOutside.value))
  assert.equal(runCli(["session", "allow", "--session", "guard-db", "127.0.0.1"]).status, 0)
  const listedLogins = await api("/cli/deadbolt/logins", { sessionId: "guard-db" })
  assert.deepEqual(listedLogins.logins.map((login: { username: string; granted: boolean }) => [login.username, login.granted]), [["alice@example.com", true], ["carol", true], ["bob", false]])
  assert.deepEqual(listedLogins.passkeys.map((passkey: { username: string; displayName: string; granted: boolean }) => [passkey.username, passkey.displayName, passkey.granted]), [["alice@example.com", "Alice", true], ["carol", "Carol", true]])
  assert.ok(!JSON.stringify(listedLogins).includes(dbPassword))
  report.deadboltType = { typed: "PASS", redacted: "PASS", crossOriginIframe: "PASS", notGranted: "PASS", wrongSite: "PASS", locked: "PASS", allowlist: dbOutside.value.url === "about:blank" ? "PASS (tab sent away)" : "PASS", list: "PASS" }

  const signIn = async (pathname: string, options = "") => await execute("guard-db", `await page.goto(${JSON.stringify(`${site}${pathname}`)}); const result = await secrets.signIn(${options}); return { result, title: await page.title(), url: page.url() }`)
  const spa = await signIn("/db/spa")
  assert.equal(spa.isError, false, spa.text)
  assert.deepEqual(Object.keys(spa.value.result).sort(), ["reason", "status", "step"])
  assert.equal(spa.value.result.status, "signed_in", JSON.stringify(spa.value))
  assert.ok(!JSON.stringify(spa).includes(dbPassword))
  const two = await signIn("/db/two", "{ username: 'alice@example.com' }")
  assert.equal(two.value.result.status, "signed_in", JSON.stringify(two.value))
  assert.equal(two.value.title, "Dashboard", JSON.stringify(two.value))
  assert.ok(!JSON.stringify(two).includes(dbPassword) && !JSON.stringify(two).includes(dbTotp), "no value in the result")
  const captcha = await signIn("/db/captcha")
  assert.equal(captcha.value.result.status, "needs_user", JSON.stringify(captcha.value))
  assert.match(captcha.value.result.reason, /captcha.*handoff/)
  const sms = await signIn("/db/sms")
  assert.deepEqual([sms.value.result.status, sms.value.result.step], ["needs_user", "code"], JSON.stringify(sms.value))
  fakeDeadbolt.locked = true
  const locked = await signIn("/db/spa")
  fakeDeadbolt.locked = false
  assert.equal(locked.value.result.status, "needs_user", JSON.stringify(locked.value))
  report.deadboltSignIn = { identifierFirstSpa: "PASS", twoPageWithSplitTotp: "PASS", captcha: "PASS", smsCode: "PASS", locked: "PASS" }

  // ---- passkeys in agent tabs -----------------------------------------------------------------------
  const unchosen = await execute("guard-db", `
    await page.goto(${JSON.stringify(`${site}/db/passkey`)});
    await page.click('#pk');
    await page.waitForFunction(() => document.querySelector('#out').textContent.length > 0);
    return JSON.parse(await page.textContent('#out'))`)
  assert.deepEqual(unchosen.value, { ok: false, name: "NotAllowedError" }, "two granted passkeys and no account chosen: " + JSON.stringify(unchosen.value))
  const passkey = await execute("guard-db", `
    await page.goto(${JSON.stringify(`${site}/db/passkey`)});
    const title = await page.title();
    await secrets.usePasskey({ site: ${JSON.stringify(site)}, username: 'alice@example.com' });
    await page.click('#pk');
    await page.waitForFunction(() => document.querySelector('#out').textContent.length > 0);
    const result = JSON.parse(await page.textContent('#out'));
    const cdp = await page.context().newCDPSession(page);
    const webauthn = await cdp.send('WebAuthn.enable').then(() => 'allowed', (error) => error.message);
    return { title, result, webauthn }`)
  assert.equal(passkey.isError, false, passkey.text)
  assert.equal(passkey.value.title, "Passkey", "the binding must not be visible to page script")
  assert.equal(passkey.value.result.ok, true, JSON.stringify(passkey.value))
  assert.equal(passkey.value.result.isPublicKeyCredential, true)
  assert.equal(passkey.value.result.type, "public-key")
  assert.equal(passkey.value.result.clientData.origin, site, "Deadbolt got the origin from CDP")
  assert.equal(passkey.value.result.json, passkey.value.result.id)
  assert.equal(Buffer.from(passkey.value.result.id, "base64url").toString(), "cred-alice")
  assert.match(passkey.value.webauthn, /blocked WebAuthn\.enable/)
  const passkeyRequest = fakeDeadbolt.requests.find((request) => request.cmd === "agent-passkey-get")!
  assert.deepEqual([passkeyRequest.origin, passkeyRequest.rp_id, passkeyRequest.user_verification], [site, "127.0.0.1", "preferred"])
  const needsChoice = await signIn("/db/pk-login")
  assert.equal(needsChoice.value.result.status, "needs_choice", JSON.stringify(needsChoice.value))
  assert.deepEqual(needsChoice.value.result.choices, [{ username: "alice@example.com", displayName: "Alice" }, { username: "carol", displayName: "Carol" }])
  assert.ok(!JSON.stringify(needsChoice).includes("vault"), "no refs reach the agent")
  const chosen = await signIn("/db/pk-login", "{ username: 'carol' }")
  assert.equal(chosen.value.result.status, "signed_in", JSON.stringify(chosen.value))
  assert.equal(chosen.value.title, "Welcome", JSON.stringify(chosen.value))
  assert.equal(await execute("guard-db", "return await page.textContent('h1')").then((result) => result.value), "Welcome cred-carol")
  assert.equal(runCli(["session", "allow", "--session", "guard-db", "127.0.0.1", "localhost"]).status, 0)
  const noGrant = await execute("guard-db", `
    await page.goto(${JSON.stringify(`${other}/db/passkey`)});
    await page.click('#pk');
    await page.waitForFunction(() => document.querySelector('#out').textContent.length > 0);
    return JSON.parse(await page.textContent('#out'))`)
  assert.deepEqual(noGrant.value, { ok: false, name: "NotAllowedError" }, JSON.stringify(noGrant.value))
  report.passkeys = { chooseWithoutAccount: "PASS", usePasskey: "PASS", signInNeedsChoice: "PASS", signInWithUsername: "PASS", assertion: "PASS", originFromCdp: "PASS", bindingNotOnPageAtLoad: "PASS", webauthnBlocked: "PASS", noGrantNotAllowed: "PASS" }
  await pause(500)
  const dbLeaks = filesContaining(home, dbPassword, path.join(home, "site-secrets"))
  assert.deepEqual(dbLeaks, [], `the Deadbolt password leaked into ${dbLeaks.join(", ")}`)

  console.log(JSON.stringify(report, null, 2))
} finally {
  await fakeDeadbolt.close()
  await browser?.close()
  relay.kill("SIGTERM")
  await new Promise<void>(resolve => fixture.close(() => resolve()))
  fs.closeSync(log)
}
