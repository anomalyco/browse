// The scenario set. Each scenario gets a fresh session and throws when browse misbehaves. Add scenarios by appending to
// `scenarios`; `soak` tags mark the ones the soak runner loops (safe to run concurrently with other sessions).
import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import type { BrowserCdp } from "./lib/cdp.ts"
import type { Fixtures } from "./lib/fixtures.ts"
import { exec, type McpClient } from "./lib/mcp.ts"
import { relayJson, sleep } from "./lib/env.ts"

export type Ctx = {
  client: McpClient
  session: string
  fx: Fixtures
  cdp: BrowserCdp
  artifacts: string
  exec: (code: string, timeoutMs?: number) => Promise<any>
}

export type Scenario = { name: string; tags: string[]; timeoutMs?: number; run: (ctx: Ctx) => Promise<unknown> }

const j = JSON.stringify
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

/** The session's targets as the relay lists them (the relay's target id is Chrome's target id). */
export async function sessionTargets(session: string): Promise<any[]> {
  const targets = await relayJson<any[]>("/json/list")
  return targets.filter((t) => t.opencodeBrowserSessionId === session)
}

export const scenarios: Scenario[] = [
  { name: "navigate-snapshot", tags: ["core", "soak"], run: async ({ exec, fx }) => {
    const out = await exec(`await page.goto(${j(fx.url("/form"))}); return await snapshot()`)
    assert(typeof out === "string" && out.includes('button "Save"') && /\[ref=e\d+\]/.test(out), `snapshot: ${String(out).slice(0, 200)}`)
  } },
  { name: "fill-click", tags: ["core", "soak"], run: async ({ exec, fx }) => {
    const out = await exec(`await page.goto(${j(fx.url("/form"))}); await page.getByLabel('Name').fill('stress'); await page.getByRole('button',{name:'Save'}).click(); return await page.locator('output').textContent()`)
    assert(out === "stress", `output ${out}`)
  } },
  { name: "snapshot-ref-click", tags: ["core", "soak"], run: async ({ exec, fx }) => {
    await exec(`await page.goto(${j(fx.url("/form"))})`)
    const snap: string = await exec(`return await snapshot()`)
    const ref = snap.match(/textbox "Name" \[ref=(e\d+)\]/)?.[1]
    const button = snap.match(/button "Save" \[ref=(e\d+)\]/)?.[1]
    assert(ref && button, `refs missing: ${snap}`)
    const out = await exec(`await ref(${j(ref)}).fill('via-ref'); await ref(${j(button)}).click(); return await page.locator('output').textContent()`)
    assert(out === "via-ref", `output ${out}`)
  } },
  { name: "type-sequentially", tags: ["core"], run: async ({ exec, fx }) => {
    const out = await exec(`await page.goto(${j(fx.url("/form"))}); await page.getByLabel('Name').pressSequentially('typed text'); return await page.getByLabel('Name').inputValue()`)
    assert(out === "typed text", `value ${out}`)
  } },
  { name: "screenshot", tags: ["core", "soak"], run: async ({ exec, fx }) => {
    const out = await exec(`await page.goto(${j(fx.url("/form"))}); const b = await page.screenshot(); const f = await page.screenshot({fullPage:true}); return [b.length, f.length]`)
    assert(Array.isArray(out) && out[0] > 1000 && out[1] > 1000, `sizes ${j(out)}`)
  } },
  { name: "popup-target-blank", tags: ["popups", "soak"], run: async ({ exec, fx, session }) => {
    const out = await exec(`await page.goto(${j(fx.url("/popup"))}); const [p] = await Promise.all([page.waitForEvent('popup'), page.click('#blank')]); await p.waitForLoadState(); const r = { url: p.url(), pages: context.pages().length, h1: await p.locator('h1').textContent() }; await p.close(); return r`)
    assert(out.url.includes("/target?from=blank") && out.h1.includes("blank"), `popup ${j(out)}`)
    const targets = await sessionTargets(session)
    assert(targets.length >= 1, "session lost its default page after closing the popup")
  } },
  { name: "popup-window-open", tags: ["popups", "soak"], run: async ({ exec, fx }) => {
    const out = await exec(`await page.goto(${j(fx.url("/popup"))}); const [p] = await Promise.all([context.waitForEvent('page'), page.click('#open')]); await p.waitForLoadState(); const r = { url: p.url(), h1: await p.locator('h1').textContent() }; await p.close(); return r`)
    assert(out.url.includes("from=open"), `popup ${j(out)}`)
  } },
  { name: "popups-grouping", tags: ["popups"], run: async ({ exec, fx, session, cdp }) => {
    await exec(`await page.goto(${j(fx.url("/popup"))}); const [p] = await Promise.all([page.waitForEvent('popup'), page.click('#blank')]); await p.waitForLoadState(); state.popup = p`)
    await sleep(1000)
    const targets = await sessionTargets(session)
    assert(targets.length >= 2, `relay lists ${targets.length} targets for the session, expected the popup too`)
    const view = await cdp.extensionView()
    const tabs = targets.map((t) => view.tabs.find((tab) => tab.id === t.tabId))
    assert(tabs.every(Boolean), `a session tab is missing from chrome.tabs: ${j(targets.map((t) => t.tabId))}`)
    const groups = new Set(tabs.map((t) => t!.groupId))
    assert(groups.size === 1 && !groups.has(-1), `popup not grouped with its opener: groups ${j([...groups])}`)
    await exec(`await state.popup.close()`)
  } },
  { name: "iframe-same-origin", tags: ["frames", "soak"], run: async ({ exec, fx }) => {
    const out = await exec(`await page.goto(${j(fx.url("/iframe-same"))}); const f = page.frameLocator('#f'); await f.getByRole('button',{name:'Press'}).click(); return await f.locator('button').textContent()`)
    assert(out === "pressed", `frame ${out}`)
  } },
  { name: "iframe-cross-origin", tags: ["frames", "soak"], run: async ({ exec, fx }) => {
    const out = await exec(`await page.goto(${j(fx.url("/iframe-cross"))}); const f = page.frameLocator('#f'); await f.getByRole('button',{name:'Press'}).click(); return { text: await f.locator('button').textContent(), origin: await f.locator('#origin').textContent() }`)
    assert(out.text === "pressed" && out.origin.includes("localhost"), `frame ${j(out)}`)
  } },
  { name: "many-frames-snapshot", tags: ["frames"], run: async ({ exec, fx }) => {
    const out = await exec(`await page.goto(${j(fx.url("/many-frames"))}); await page.waitForLoadState('load'); return { frames: page.frames().length, snap: (await snapshot()).length }`)
    assert(out.frames >= 21, `frames ${j(out)}`)
  } },
  { name: "shadow-dom", tags: ["core", "soak"], run: async ({ exec, fx }) => {
    const out = await exec(`await page.goto(${j(fx.url("/shadow"))}); await page.getByLabel('Inner').fill('deep'); await page.getByRole('button',{name:'Shadow button'}).click(); return await page.locator('x-card #s').textContent()`)
    assert(out === "shadow:deep", `shadow ${out}`)
  } },
  { name: "dialog-alert", tags: ["dialogs", "soak"], run: async ({ exec, fx }) => {
    const out = await exec(`await page.goto(${j(fx.url("/dialogs"))}); let seen; page.once('dialog', d => { seen = d.type() + ':' + d.message(); d.accept() }); await page.click('#alert'); await page.waitForFunction(() => document.title === 'alerted'); return seen`)
    assert(out === "alert:hello", `dialog ${out}`)
  } },
  { name: "dialog-confirm", tags: ["dialogs"], run: async ({ exec, fx }) => {
    const out = await exec(`await page.goto(${j(fx.url("/dialogs"))}); page.once('dialog', d => d.dismiss()); await page.click('#confirm'); await page.waitForFunction(() => document.title.startsWith('confirm:')); return await page.title()`)
    assert(out === "confirm:false", `title ${out}`)
  } },
  { name: "dialog-prompt", tags: ["dialogs"], run: async ({ exec, fx }) => {
    const out = await exec(`await page.goto(${j(fx.url("/dialogs"))}); page.once('dialog', d => d.accept('stress')); await page.click('#prompt'); await page.waitForFunction(() => document.title.startsWith('prompt:')); return await page.title()`)
    assert(out === "prompt:stress", `title ${out}`)
  } },
  { name: "dialog-unhandled", tags: ["dialogs"], run: async ({ exec, fx }) => {
    // No handler: Playwright dismisses the dialog; the session must stay usable.
    await exec(`await page.goto(${j(fx.url("/dialogs"))}); await page.click('#confirm'); await page.waitForFunction(() => document.title.startsWith('confirm:'), null, {timeout: 10000})`)
    const out = await exec(`return await page.title()`)
    assert(out === "confirm:false", `title ${out}`)
  } },
  { name: "dialog-beforeunload", tags: ["dialogs"], run: async ({ exec, fx }) => {
    const out = await exec(`await page.goto(${j(fx.url("/beforeunload"))}); await page.getByRole('button',{name:'Arm'}).click(); let type; page.once('dialog', d => { type = d.type(); d.accept() }); await page.evaluate(() => { location.href = '/target?from=unload' }); await page.waitForURL('**/target?from=unload', {timeout: 15000}); return { type, url: page.url() }`)
    assert(out.url.includes("from=unload"), `beforeunload ${j(out)}`)
  } },
  { name: "file-upload", tags: ["files", "soak"], run: async ({ exec, fx }) => {
    const out = await exec(`await page.goto(${j(fx.url("/upload"))}); await files.write('stress-upload.txt', 'hello upload'); await page.setInputFiles('#file', files.path('stress-upload.txt')); return await page.locator('#out').textContent()`)
    assert(out === "stress-upload.txt:12", `upload ${out}`)
  } },
  { name: "file-download", tags: ["files"], run: async ({ client, session, exec, fx }) => {
    // Chromium blocks download behaviour through chrome.debugger, so browse refuses download.saveAs() with a message
    // pointing at the workaround (fetch the file in the page and save it with files.write).
    await exec(`await page.goto(${j(fx.url("/download"))})`)
    const refused = await client.call("execute", { session, code: `const [d] = await Promise.all([page.waitForEvent('download', {timeout: 15000}), page.click('#dl')]); await d.saveAs(files.path('x.txt'))` }, 60_000)
    assert(refused.isError && /Downloads are unavailable/.test(refused.text), `download refusal: ${refused.text.slice(0, 200)}`)
    const out = await exec(`const body = await page.evaluate(() => fetch('/file.txt').then(r => r.text())); await files.write('stress-download.txt', body); return (await files.read(files.path('stress-download.txt'))).toString()`)
    assert(String(out).includes("stress download"), `workaround ${out}`)
  } },
  { name: "pdf", tags: ["files"], run: async ({ client, session, exec, fx }) => {
    // Chrome shows PDFs in its (protected) viewer and drops the debugger when it opens; the extension re-attaches and
    // the relay sets the tab up again. The session stays on the tab, the file is reachable, and navigating away works.
    const out = await exec(`try { await page.goto(${j(fx.url("/doc.pdf"))}, {timeout: 20000}) } catch (e) { return { error: String(e.message).slice(0, 200), url: page.url() } } return { url: page.url() }`)
    const viewer = await client.call("execute", { session, code: `const b64 = await page.evaluate(async () => { const bytes = new Uint8Array(await (await fetch(location.href)).arrayBuffer()); let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s) }); await files.write("stress.pdf", Buffer.from(b64, "base64")); return { url: page.url(), head: (await files.read(files.path("stress.pdf"))).toString("latin1").slice(0, 8) }` }, 60_000)
    assert(!viewer.isError, `PDF page unusable: ${viewer.text.slice(0, 300)}`)
    assert(String(viewer.data?.value?.url).endsWith("/doc.pdf") && String(viewer.data?.value?.head).startsWith("%PDF"), `PDF not reachable: ${j(viewer.data?.value)}`)
    const next = await exec(`await page.goto(${j(fx.url("/form"))}); return page.url()`)
    assert(String(next).endsWith("/form"), `session unusable after PDF (${j(out)})`)
    return { goto: out, viewerWarning: (viewer.data?.warnings ?? []).some((w: string) => /PDF in Chrome's viewer/.test(w)) }
  } },
  { name: "service-worker", tags: ["web", "soak"], run: async ({ exec, fx }) => {
    // Registration and control work. Fetches from browse-driven pages bypass the worker's fetch handler (Patchright's
    // request interception), so `intercepted` is recorded rather than asserted.
    const out = await exec(`await page.goto(${j(fx.url("/sw"))}); await page.locator('#state', {hasText: 'ready'}).waitFor({timeout: 15000}); await page.reload(); return { controller: await page.evaluate(() => !!navigator.serviceWorker.controller), body: await page.evaluate(() => fetch('/sw-hello').then(r => r.text())) }`)
    assert(out.controller === true, `sw ${j(out)}`)
    return { intercepted: out.body === "from-sw" }
  } },
  { name: "websocket", tags: ["web", "soak"], run: async ({ exec, fx }) => {
    const out = await exec(`await page.goto(${j(fx.url("/ws"))}); await page.locator('#ws', {hasText: 'got:'}).waitFor({timeout: 10000}); return await page.locator('#ws').textContent()`)
    assert(out === "got:ping", `ws ${out}`)
  } },
  { name: "history-back-forward", tags: ["core", "soak"], run: async ({ exec, fx }) => {
    const out = await exec(`await page.goto(${j(fx.url("/h/1"))}); await page.click('text=next'); await page.waitForURL('**/h/2'); await page.goBack(); const back = page.url(); await page.goForward(); return { back, forward: page.url() }`)
    assert(out.back.endsWith("/h/1") && out.forward.endsWith("/h/2"), `history ${j(out)}`)
  } },
  { name: "long-page-scroll", tags: ["core", "soak"], run: async ({ exec, fx }) => {
    const out = await exec(`await page.goto(${j(fx.url("/long"))}); await page.mouse.wheel(0, 3000); await page.getByRole('button',{name:'Bottom'}).click(); return { text: await page.locator('#bottom').textContent(), y: await page.evaluate(() => scrollY) }`)
    assert(out.text === "reached" && out.y > 15000, `scroll ${j(out)}`)
  } },
  { name: "big-dom-snapshot", tags: ["core", "soak"], timeoutMs: 120_000, run: async ({ exec, fx }) => {
    const started = Date.now()
    const out = await exec(`await page.goto(${j(fx.url("/big"))}); const s = await snapshot(); const f = await snapshot({find: 'Row 4321'}); return { len: s.length, find: f }`)
    const ms = Date.now() - started
    assert(out.len > 0 && out.len < 200_000, `snapshot length ${out.len}`)
    assert(String(out.find).includes("4321"), `find ${String(out.find).slice(0, 200)}`)
    return { ms, len: out.len }
  } },
  { name: "slow-response", tags: ["network", "soak"], run: async ({ exec, fx }) => {
    const out = await exec(`await page.goto(${j(fx.url("/slow?ms=4000"))}); return await page.locator('h1').textContent()`)
    assert(out === "Slow done", `slow ${out}`)
  } },
  { name: "navigation-timeout-recovers", tags: ["network"], run: async ({ exec, fx }) => {
    const out = await exec(`try { await page.goto(${j(fx.url("/slow?ms=8000"))}, {timeout: 1500}); return 'no-timeout' } catch (e) { return e.name }`)
    assert(out === "TimeoutError", `expected TimeoutError, got ${out}`)
    const next = await exec(`await page.goto(${j(fx.url("/form"))}); return page.url()`)
    assert(String(next).endsWith("/form"), `next ${next}`)
  } },
  { name: "redirect-chain", tags: ["network", "soak"], run: async ({ exec, fx }) => {
    const out = await exec(`const r = await page.goto(${j(fx.url("/redirect?n=5"))}); return { url: page.url(), status: r.status() }`)
    assert(out.url.includes("from=redirect") && out.status === 200, `redirect ${j(out)}`)
  } },
  { name: "http-errors", tags: ["network", "soak"], run: async ({ exec, fx }) => {
    const out = await exec(`const a = await page.goto(${j(fx.url("/status/404"))}); const b = await page.goto(${j(fx.url("/status/500"))}); return [a.status(), b.status()]`)
    assert(j(out) === "[404,500]", `statuses ${j(out)}`)
  } },
  { name: "unreachable-host", tags: ["network"], run: async ({ exec }) => {
    const out = await exec(`try { await page.goto('http://127.0.0.1:9/', {timeout: 10000}); return 'loaded' } catch (e) { return String(e.message).slice(0, 120) }`)
    assert(/ERR_CONNECTION_REFUSED|net::/.test(out), `unreachable ${out}`)
    await exec(`return 1`)
  } },
  { name: "data-url", tags: ["core", "soak"], run: async ({ exec }) => {
    const out = await exec(`await page.goto('data:text/html,<h1>from data</h1>'); return await page.locator('h1').textContent()`)
    assert(out === "from data", `data ${out}`)
  } },
  { name: "set-content", tags: ["core", "soak"], run: async ({ exec }) => {
    const out = await exec(`await page.setContent('<button onclick="this.textContent=1">x</button>'); await page.click('button'); return await page.textContent('button')`)
    assert(out === "1", `setContent ${out}`)
  } },
  { name: "file-url-refused", tags: ["security"], run: async ({ client, session }) => {
    const result = await client.call("execute", { session, code: `await page.goto('file:///etc/passwd'); return await page.content()` }, 60_000)
    assert(result.isError, `file: navigation was allowed: ${result.text.slice(0, 200)}`)
    assert(!result.text.includes("root:x:0:0"), "file contents leaked")
  } },
  { name: "chrome-url-refused", tags: ["security"], run: async ({ client, session }) => {
    const result = await client.call("execute", { session, code: `await page.goto('chrome://settings'); return page.url()` }, 60_000)
    assert(result.isError || !String(result.data?.value).startsWith("chrome://settings"), `chrome:// navigation allowed: ${result.text.slice(0, 200)}`)
    const ok = await client.call("execute", { session, code: `return 1` })
    assert(!ok.isError, `session unusable after chrome:// refusal: ${ok.text.slice(0, 200)}`)
  } },
  { name: "cookies-scoped", tags: ["security"], run: async ({ exec, fx }) => {
    const out = await exec(`await page.goto(${j(fx.url("/cookie"))}); const c = await context.cookies(); return c.map(x => x.name)`)
    assert(Array.isArray(out) && out.includes("fixture"), `cookies ${j(out)}`)
    const clear = await exec(`try { await context.clearCookies(); return 'cleared' } catch (e) { return 'refused' }`)
    assert(clear === "refused", `clearCookies was allowed (${clear})`)
  } },
  { name: "cpu-loop-recovers", tags: ["core"], run: async ({ client, session }) => {
    const loop = await client.call("execute", { session, code: `await Promise.resolve(); while (true) {}` }, 60_000)
    assert(loop.isError && /CPU budget/.test(loop.text), `loop: ${loop.text.slice(0, 200)}`)
    const ok = await client.call("execute", { session, code: `return 7` })
    assert(!ok.isError && ok.data?.value === 7, `after loop: ${ok.text.slice(0, 200)}`)
  } },
  { name: "multi-page", tags: ["core", "soak"], run: async ({ exec, fx, session }) => {
    const out = await exec(`const ps = []; for (let i = 0; i < 4; i++) { const p = await context.newPage(); await p.goto(${j(fx.url("/target?from=multi"))}); ps.push(p) } const n = context.pages().length; for (const p of ps) await p.close(); return { n, after: context.pages().length }`)
    assert(out.n >= 5 && out.after < out.n, `pages ${j(out)}`)
    await sleep(500)
    const targets = await sessionTargets(session)
    assert(targets.length <= 2, `closed pages still listed by the relay: ${targets.length}`)
  } },
  { name: "handoff-real-click", tags: ["handoff", "soak"], timeoutMs: 120_000, run: async ({ client, session, fx, cdp }) => {
    const nav = await client.call("execute", { session, code: `await page.goto(${j(fx.url("/handoff"))}); return page.url()` })
    assert(!nav.isError, nav.text)
    const started = Date.now()
    const waiting = client.call("execute", { session, code: `await handoff('Stress: finish sign-in', {timeoutMs: 90000}); return 'continued'` }, 110_000)
    const targets = await sessionTargets(session)
    const target = targets.find((t) => String(t.url).includes("/handoff")) ?? targets[0]
    assert(target, "no target for the handoff")
    let finished = false
    const clicking = cdp.clickHandoffContinue(target.id, () => finished)
    const result = await waiting.finally(() => { finished = true })
    const clicks = await clicking
    assert(!result.isError && result.data?.value === "continued", `handoff (Continue: ${JSON.stringify(clicks)}): ${result.text.slice(0, 300)}`)
    return { ms: Date.now() - started, clicks }
  } },
  { name: "handoff-synthetic-click-ignored", tags: ["handoff", "security"], timeoutMs: 60_000, run: async ({ client, session, fx }) => {
    await client.call("execute", { session, code: `await page.goto(${j(fx.url("/handoff"))})` })
    // A page can't finish a handoff: dispatching click events on every element from page script must not continue it.
    const result = await client.call("execute", { session, code: `await handoff('Stress: synthetic', {timeoutMs: 4000, start: async () => { await page.evaluate(() => { for (const el of document.querySelectorAll('*')) el.dispatchEvent(new MouseEvent('click', {bubbles: true})) }) }}); return 'continued'` }, 60_000)
    assert(result.isError && /timed out/i.test(result.text), `synthetic click continued the handoff: ${result.text.slice(0, 200)}`)
  } },
  { name: "network-capture", tags: ["network", "soak"], run: async ({ client, session, fx, artifacts }) => {
    const start = await client.call("network_start", { session, urlFilter: "/api/" })
    assert(!start.isError, start.text)
    const nav = await client.call("execute", { session, code: `await page.goto(${j(fx.url("/network"))}); await page.locator('#out', {hasText: '3 rows'}).waitFor(); return 1` })
    assert(!nav.isError, nav.text)
    const har = path.join(artifacts, `${session}.har`)
    const stop = await client.call("network_stop", { session, outputPath: har })
    assert(!stop.isError, stop.text)
    const parsed = JSON.parse(fs.readFileSync(har, "utf8"))
    const entries = parsed.log.entries as any[]
    assert(entries.filter((e) => e.request.url.includes("/api/data")).length === 3, `HAR has ${entries.length} entries`)
    assert(!fs.readFileSync(har, "utf8").includes("stress-fake-token"), "HAR leaked the bearer token")
    fs.rmSync(har, { force: true })
  } },
  { name: "network-cancel", tags: ["network"], run: async ({ client, session, fx }) => {
    assert(!(await client.call("network_start", { session })).isError, "start")
    await client.call("execute", { session, code: `await page.goto(${j(fx.url("/network"))})` })
    const cancel = await client.call("network_cancel", { session })
    assert(!cancel.isError, cancel.text)
    const status = await client.call("network_status", { session })
    assert(!/"active":\s*true/.test(status.text), `capture still active: ${status.text.slice(0, 200)}`)
  } },
  { name: "recording", tags: ["recording", "soak"], timeoutMs: 120_000, run: async ({ client, session, fx, artifacts }) => {
    await client.call("execute", { session, code: `await page.goto(${j(fx.url("/animate"))})` })
    const file = path.join(artifacts, `${session}.webm`)
    const start = await client.call("recording_start", { session, outputPath: file, maxDurationMs: 30_000 })
    assert(!start.isError, `recording_start: ${start.text.slice(0, 300)}`)
    await client.call("execute", { session, code: `await page.mouse.move(100, 100); await page.waitForTimeout(3000); return 1` })
    const stop = await client.call("recording_stop", { session }, 60_000)
    assert(!stop.isError, `recording_stop: ${stop.text.slice(0, 300)}`)
    const size = fs.existsSync(file) ? fs.statSync(file).size : 0
    assert(size > 10_000, `recording is ${size} bytes`)
    const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { encoding: "utf8" })
    const duration = Number(probe.stdout.trim())
    fs.rmSync(file, { force: true })
    assert(probe.status === 0 && (duration > 1 || Number.isNaN(duration)), `ffprobe: ${probe.stderr || probe.stdout}`)
    return { size, duration }
  } },
  { name: "recording-cancel", tags: ["recording"], run: async ({ client, session, fx, artifacts }) => {
    await client.call("execute", { session, code: `await page.goto(${j(fx.url("/animate"))})` })
    const file = path.join(artifacts, `${session}-cancel.webm`)
    assert(!(await client.call("recording_start", { session, outputPath: file })).isError, "start")
    await sleep(1000)
    const cancel = await client.call("recording_cancel", { session })
    assert(!cancel.isError, cancel.text)
    const status = await client.call("recording_status", { session })
    assert(!/"active":\s*true|"recording":\s*true/.test(status.text), `still recording: ${status.text.slice(0, 200)}`)
    const again = await client.call("recording_start", { session, outputPath: file, maxDurationMs: 2000 })
    assert(!again.isError, `restart after cancel: ${again.text.slice(0, 200)}`)
    await client.call("recording_stop", { session }, 60_000)
    fs.rmSync(file, { force: true })
  } },
  { name: "session-reset", tags: ["sessions", "soak"], run: async ({ client, session, fx }) => {
    await client.call("execute", { session, code: `await page.goto(${j(fx.url("/form"))}); state.x = 1` })
    const reset = await client.call("session_reset", { id: session })
    assert(!reset.isError, reset.text)
    const out = await client.call("execute", { session, code: `return { url: page.url(), x: state.x ?? null }` })
    assert(!out.isError && out.data.value.x === null, `after reset: ${out.text.slice(0, 200)}`)
  } },
  { name: "session-delete-closes-tabs", tags: ["sessions"], run: async ({ client, fx, cdp }) => {
    const id = `sc-del-${Date.now().toString(36)}`
    assert(!(await client.call("session_new", { id })).isError, "session_new")
    await client.call("execute", { session: id, code: `await page.goto(${j(fx.url("/target?from=delete"))}); const p = await context.newPage(); await p.goto(${j(fx.url("/target?from=delete2"))})` })
    const before = await sessionTargets(id)
    const tabIds = before.map((t) => t.tabId)
    assert(!(await client.call("session_delete", { id })).isError, "session_delete")
    await sleep(1500)
    const view = await cdp.extensionView()
    const left = view.tabs.filter((t) => tabIds.includes(t.id))
    assert(left.length === 0, `session_delete left ${left.length} tab(s) open`)
    assert((await sessionTargets(id)).length === 0, "relay still lists the deleted session's targets")
  } },
  { name: "sw-restart-keeps-tabs", tags: ["sessions", "chaos-lite"], timeoutMs: 120_000, run: async ({ client, fx, cdp }) => {
    // The extension's service worker restarting must not orphan agent tabs: each session keeps its tabs (same tab ids),
    // its group and idle-cleanup tracking, and session_delete still closes them.
    const ids = [0, 1, 2].map((i) => `sc-sw-${i}-${Date.now().toString(36)}`)
    for (const id of ids) {
      assert(!(await client.call("session_new", { id })).isError, "session_new")
      await exec(client, id, `await page.goto(${j(fx.url(`/target?from=${id}`))}); const p = await context.newPage(); await p.goto(${j(fx.url(`/target?from=${id}-2`))})`)
    }
    const before = new Map<string, number[]>()
    for (const id of ids) before.set(id, (await sessionTargets(id)).map((t) => t.tabId).sort())
    const all = [...before.values()].flat()
    assert(all.length === 6, `expected 6 session tabs, relay lists ${all.length}`)
    const started = Date.now()
    await cdp.stopExtensionWorker()
    // Recovered: every session runs an execute on its own tabs again.
    for (const id of ids) {
      const out = await exec(client, id, `return context.pages().length`, 60_000)
      assert(out === 2, `${id} sees ${out} pages after the worker restart`)
    }
    const recoveryMs = Date.now() - started
    for (const id of ids) {
      const after = (await sessionTargets(id)).map((t) => t.tabId).sort()
      assert(j(after) === j(before.get(id)), `${id} tabs changed across the worker restart: ${j(before.get(id))} -> ${j(after)}`)
    }
    const view = await cdp.extensionView()
    const tracked = await cdp.evalInExtension<number[]>(`chrome.storage.local.get("tabCleanup").then((s) => Object.keys(s.tabCleanup ?? {}).map(Number))`)
    for (const tabId of all) {
      const tab = view.tabs.find((t) => t.id === tabId)
      assert(tab, `tab ${tabId} disappeared`)
      assert(tab.groupId !== -1, `tab ${tabId} lost its group across the worker restart`)
      assert(tracked.includes(tabId), `tab ${tabId} is no longer tracked for idle cleanup`)
    }
    for (const id of ids) assert(!(await client.call("session_delete", { id })).isError, "session_delete")
    await sleep(1500)
    const left = (await cdp.extensionView()).tabs.filter((t) => all.includes(t.id))
    assert(left.length === 0, `session_delete left ${left.length} tab(s) open after the worker restart`)
    assert(recoveryMs < 20_000, `recovery took ${recoveryMs} ms`)
    return { recoveryMs }
  } },
  { name: "idle-cleanup", tags: ["sessions"], run: async ({ client, fx, cdp }) => {
    const id = `sc-idle-${Date.now().toString(36)}`
    await client.call("session_new", { id })
    await client.call("execute", { session: id, code: `await page.goto(${j(fx.url("/target?from=idle"))})` })
    const tabIds = (await sessionTargets(id)).map((t) => t.tabId)
    const cleanup = await client.call("tabs_cleanup", { idleMinutes: 0 })
    assert(!cleanup.isError, cleanup.text)
    await sleep(1000)
    // The tab a window shows stays open by design; Chrome activates an agent tab when the tab before it closes.
    const left = (await cdp.extensionView()).tabs.filter((t) => tabIds.includes(t.id) && !t.active)
    await client.call("session_delete", { id })
    assert(left.length === 0, `tabs_cleanup(0) left ${left.length} idle background agent tab(s)`)
  } },
  { name: "user-closes-tab", tags: ["chaos-lite", "soak"], run: async ({ client, session, fx, cdp }) => {
    await client.call("execute", { session, code: `await page.goto(${j(fx.url("/form"))})` })
    const [target] = await sessionTargets(session)
    assert(target, "no target")
    await cdp.evalInExtension(`chrome.tabs.remove(${target.tabId})`)
    await sleep(500)
    const out = await client.call("execute", { session, code: `await page.goto(${j(fx.url("/target?from=reopen"))}); return page.url()` })
    assert(!out.isError && String(out.data?.value).includes("from=reopen"), `after the user closed the tab: ${out.text.slice(0, 300)}`)
  } },
  { name: "heavy-page", tags: ["core"], run: async ({ exec, fx }) => {
    const out = await exec(`await page.goto(${j(fx.url("/heavy"))}); return Number(await page.locator('#n').textContent())`)
    assert(out > 0, `heavy ${out}`)
  } },
  { name: "large-result-stays-responsive", tags: ["core"], run: async ({ client, session }) => {
    // A 5 MB result used to hang the relay in journal redaction. browse doesn't cap what execute returns, so the size
    // the agent receives is recorded, not asserted.
    const started = Date.now()
    const out = await client.call("execute", { session, code: `return 'x'.repeat(5_000_000)` }, 60_000)
    const ms = Date.now() - started
    assert(!out.isError, out.text.slice(0, 200))
    assert(ms < 20_000, `5 MB result took ${ms} ms`)
    const ping = Date.now()
    await relayJson("/extension/status")
    assert(Date.now() - ping < 2000, "relay slow after a large result")
    return { ms, chars: out.text.length }
  } },
]
