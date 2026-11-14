// Isolated headless check of the guarded-agent features against a real browser: challenge detection, per-session
// domain allowlists and page-visible API warnings.
//   bun run build && (cd cli && bun run build) && node --no-warnings test/guarded-agents-browser.ts [--browser <chromium executable>]
// Same isolation as execute-realm-browser.ts: the temp root, paired relay, port-patched extension and launch come from
// startBrowserScene; ports come from BROWSE_TEST_RELAY_PORT and BROWSE_TEST_FIXTURE_PORT, or are free ports.
import assert from "node:assert/strict"
import path from "node:path"
import http from "node:http"
import { spawnSync } from "node:child_process"
import { parseArgs } from "node:util"
import { relayToken } from "../src/relay/secrets.ts"
import { portFromEnv } from "./support/ports.ts"
import { startBrowserScene } from "./support/browser-scene.ts"

const { values: options } = parseArgs({ options: { browser: { type: "string" } } })
const fixturePort = await portFromEnv("BROWSE_TEST_FIXTURE_PORT")
const site = `http://127.0.0.1:${fixturePort}`
const other = `http://localhost:${fixturePort}`
const scene = await startBrowserScene({
  ...(options.browser === undefined ? {} : { browser: options.browser }),
  name: "guarded-browser-",
  env: {
    BROWSE_TEST_FIXTURE_PORT: String(fixturePort),
    OPENCODE_BROWSER_CHALLENGE_WAIT_MS: "4000",
    OPENCODE_BROWSER_HUMAN_INPUT: "0",
  },
})
const { cli, env, base, root, home } = scene
const authorization = `Bearer ${relayToken(home)}`

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

const report: Record<string, unknown> = { root }
try {
  await new Promise<void>((resolve, reject) => { fixture.once("error", reject); fixture.listen(fixturePort, "127.0.0.1", resolve) })

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

  console.log(JSON.stringify(report, null, 2))
} finally {
  await new Promise<void>(resolve => fixture.close(() => resolve()))
  await scene.stop()
}
