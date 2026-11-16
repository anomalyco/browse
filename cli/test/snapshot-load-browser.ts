// Isolated headless regression and load check for snapshot() on large DOMs:
//   bun build.ts && node --no-warnings test/snapshot-load-browser.ts [--browser <chromium executable>]
// Uses a port-patched copy of the extension in headless Chromium with --use-mock-keychain, a fresh
// OPENCODE_BROWSER_HOME, and BROWSE_TEST_RELAY_PORT / BROWSE_TEST_FIXTURE_PORT (else free ports).
import assert from "node:assert/strict"
import fs from "node:fs"
import http from "node:http"
import { parseArgs } from "node:util"
import { relayToken } from "../src/relay/secrets.ts"
import { startBrowserScene } from "./support/browser-scene.ts"

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
const scene = await startBrowserScene({
  ...(options.browser === undefined ? {} : { browser: options.browser }),
  name: "snapshot-load-browser-",
  extraArgs: ["--use-mock-keychain"],
  env: { OPENCODE_BROWSER_AUTOSTART: "false" },
})
const { root, home, base, fixturePort, fixtureUrl } = scene
const authorization = `Bearer ${relayToken(home)}`

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

const staleRefsHtml = htmlPage(
  "Stale refs",
  `<a data-test="shopping-cart-link" role="button" href="#cart" aria-label="Cart, empty">cart</a>
  <button onclick="document.title = 'saved'">Save</button>
  <form id="searchform"><input type="search" aria-label="Search site"><button type="button">Search</button></form>
  <script>
    window.mutate = () => {
      document.querySelector("a").setAttribute("aria-label", "Cart, 2 items")
      document.getElementById("searchform").innerHTML = '<div><input role="combobox" aria-label="Search site"><span><button type="button">Search</button></span></div>'
    }
  </script>`,
)

const fixture = http.createServer((request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
  response.end(request.url === "/big-table" ? bigDataTableHtml : request.url === "/stale-refs" ? staleRefsHtml : bigRowsHtml)
})

async function api(route: string, body?: unknown) {
  const response = await fetch(`${base}${route}`, {
    ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
    headers: { authorization, "content-type": "application/json" },
  })
  assert.equal(response.status, 200, route)
  return await response.json() as Record<string, any>
}

async function execute(sessionId: string, code: string, extra: Record<string, unknown> = {}) {
  return await api("/cli/execute", { sessionId, code, createIfMissing: false, ...extra })
}

try {
  await new Promise<void>((resolve, reject) => { fixture.once("error", reject); fixture.listen(fixturePort, "127.0.0.1", resolve) })
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

  // Through the sandbox: a ref still on its element works, reads of a stale ref return false, and actions on stale
  // refs fail within a few seconds with what changed.
  const staleRefs = await execute("snap-single", `
    await page.goto(${JSON.stringify(`${fixtureUrl}/stale-refs`)});
    const s = await snapshot();
    const id = (pattern) => s.match(new RegExp(pattern + ' \\\\[ref=(e\\\\d+)'))?.[1];
    await page.addScriptTag({ content: "mutate()" });
    await ref(id('button "Save"')).click();
    const visible = await ref(id('button "Cart, empty"')).isVisible();
    const t0 = performance.now();
    const cart = await ref(id('button "Cart, empty"')).click().then(() => "clicked", (cause) => cause.message);
    const ms = performance.now() - t0;
    const search = await ref(id('button "Search"')).click().then(() => "clicked", (cause) => cause.message);
    return { title: await page.title(), visible, cart, search, ms, hash: await page.evaluate(() => location.hash) };
  `)
  assert.equal(staleRefs.isError, false, staleRefs.text)
  assert.equal(staleRefs.value.title, "saved")
  assert.equal(staleRefs.value.visible, false)
  assert.match(staleRefs.value.cart, /^locator\.click: Error: ref e\d+ is stale: button "Cart, empty" now reads "Cart, 2 items"; call snapshot\(\) again/)
  assert.match(staleRefs.value.search, /ref e\d+ is stale: button "Search" is gone/)
  assert.ok(staleRefs.value.ms < 6_000, `stale ref took ${staleRefs.value.ms}ms`)
  assert.equal(staleRefs.value.hash, "")
  // A longer action timeout from execute's timeoutMs doesn't stretch the stale-ref grace.
  const staleRefsLongTimeout = await execute("snap-single", `
    await page.goto(${JSON.stringify(`${fixtureUrl}/stale-refs`)});
    const s = await snapshot();
    const id = (pattern) => s.match(new RegExp(pattern + ' \\\\[ref=(e\\\\d+)'))?.[1];
    await page.addScriptTag({ content: "mutate()" });
    await ref(id('button "Save"')).click();
    const visible = await ref(id('button "Cart, empty"')).isVisible();
    const t0 = performance.now();
    const cart = await ref(id('button "Cart, empty"')).click().then(() => "clicked", (cause) => cause.message);
    const ms = performance.now() - t0;
    const search = await ref(id('button "Search"')).click().then(() => "clicked", (cause) => cause.message);
    return { title: await page.title(), visible, cart, search, ms, hash: await page.evaluate(() => location.hash) };
  `, { timeoutMs: 120_000 })
  assert.equal(staleRefsLongTimeout.isError, false, staleRefsLongTimeout.text)
  assert.match(staleRefsLongTimeout.value.cart, /is stale: button "Cart, empty" now reads "Cart, 2 items"/)
  assert.ok(staleRefsLongTimeout.value.ms < 6_000, `stale ref took ${staleRefsLongTimeout.value.ms}ms`)

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
    staleRefMs: Math.round(staleRefs.value.ms),
    singleSnapshotMs: summarize(singleSamples),
    concurrent8x3ScenarioMs: summarize(scenarioMs),
    concurrent8x3PerSnapshotMs: summarize(perSnapshotMs),
    concurrent8x3WarmSnapshotMs: summarize(warmConcurrentMs),
  }))
} finally {
  await scene.stop()
  await new Promise<void>((resolve) => fixture.close(() => resolve()))
  fs.rmSync(root, { recursive: true, force: true })
}
