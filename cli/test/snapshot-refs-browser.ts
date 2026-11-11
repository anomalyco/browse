// Headless check of how snapshot refs behave after the page changes, in a plain page with no extension or relay:
//   PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=<chrome> bun test/snapshot-refs-browser.ts [--browser <chrome>]
// Runs under Bun because it loads cli/src TypeScript directly. The browser is --browser, else
// PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, else patchright-core's own Chromium.
import assert from "node:assert/strict"
import { parseArgs } from "node:util"
import { chromium, type Page } from "patchright-core"
import { createSnapshotHelpers } from "../src/snapshot.ts"
import { registerRefSelector } from "../src/snapshot/ref-selector.ts"

const { values: options } = parseArgs({ options: { browser: { type: "string" } } })
const executablePath = options.browser || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || chromium.executablePath()
const browser = await chromium.launch({ executablePath })
const context = await browser.newContext()
await registerRefSelector(context)

// Each page records clicks in window.clicked and exposes window.mutate() for the change under test. execute runs
// actions with a 30 s timeout, and so does every page here.
async function open(html: string) {
  const page = await context.newPage()
  page.setDefaultTimeout(30_000)
  await page.setContent(`<!doctype html><title>t</title>${html}<script>window.clicked ??= []</script>`)
  const helpers = createSnapshotHelpers(page, { selectors: new Map() })
  const text = await helpers.snapshot()
  const refFor = (line: RegExp): string => {
    const id = new RegExp(`${line.source} \\[ref=(e\\d+)`).exec(text)?.[1]
    assert.ok(id, `no ref for ${line} in:\n${text}`)
    return id
  }
  return { page, helpers, text, refFor }
}
// Patchright evaluates in an isolated world, so page script globals are reached through script tags and the DOM.
const clicked = async (page: Page): Promise<string[]> => {
  await page.addScriptTag({ content: "document.body.dataset.clicked = JSON.stringify(clicked)" })
  return JSON.parse(await page.evaluate(() => document.body.dataset.clicked ?? "[]"))
}
const run = (page: Page, code: string) => page.addScriptTag({ content: code })
async function timed<T>(action: () => Promise<T>): Promise<{ ms: number; value?: T; error?: string }> {
  const started = Date.now()
  try {
    const value = await action()
    return { ms: Date.now() - started, value }
  } catch (error) {
    return { ms: Date.now() - started, error: error instanceof Error ? error.message : String(error) }
  }
}
const fast = (ms: number) => assert.ok(ms >= 2_500 && ms < 6_000, `took ${ms}ms`)
const results: Record<string, string> = {}

try {
  {
    // A control whose name changed fails within the grace period, says what changed and clicks nothing.
    const { page, helpers, refFor } = await open(`<a data-test="shopping-cart-link" role="button" href="#cart" aria-label="Cart, empty" onclick="clicked.push('cart')">cart</a>`)
    const cart = refFor(/button "Cart, empty"/)
    await run(page, `document.querySelector("a").setAttribute("aria-label", "Cart, 2 items")`)
    const result = await timed(() => helpers.ref(cart).click())
    assert.match(result.error ?? "", new RegExp(`^click: Error: ref ${cart} is stale: button "Cart, empty" now reads "Cart, 2 items"; call snapshot\\(\\) again\n`))
    assert.doesNotMatch(result.error ?? "", /page\.locator|\{"/)
    fast(result.ms)
    assert.deepEqual(await clicked(page), [])
    results.renamed = `PASS ${result.ms}ms`
  }

  {
    // A form re-mounted with a new structure fails fast instead of acting on the look-alike "Search" button.
    const { page, helpers, refFor } = await open(`<form id="searchform"><input type="search" aria-label="Search site"><button type="button">Search</button></form>`)
    const box = refFor(/searchbox "Search site"/)
    const button = refFor(/button "Search"/)
    await run(page, `
      const form = document.getElementById("searchform")
      form.innerHTML = '<div><input role="combobox" aria-label="Search site"><span><button type="button" onclick="clicked.push(1)">Search</button></span></div>'`)
    const filled = await timed(() => helpers.ref(box).fill("eiffel"))
    assert.match(filled.error ?? "", new RegExp(`ref ${box} is stale: searchbox "Search site" is now combobox "Search site"; call snapshot\\(\\) again`))
    const result = await timed(() => helpers.ref(button).click())
    assert.match(result.error ?? "", new RegExp(`ref ${button} is stale: button "Search" is gone`))
    fast(result.ms)
    assert.deepEqual(await clicked(page), [])
    results.remount = `PASS ${result.ms}ms`
  }

  {
    // Re-running a click on a "Delete" that opened a confirm dialog never reaches the dialog's own "Delete".
    const { page, helpers, refFor } = await open(`
      <main><button onclick="this.remove(); document.querySelector('dialog').showModal(); clicked.push('delete')">Delete</button></main>
      <dialog><p>Sure?</p><button onclick="clicked.push('confirm')">Delete</button></dialog>`)
    const remove = refFor(/button "Delete"/)
    await helpers.ref(remove).click()
    const again = await timed(() => helpers.ref(remove).click())
    assert.match(again.error ?? "", /is stale: button "Delete" is gone/)
    assert.deepEqual(await clicked(page), ["delete"])
    results.hiddenTwin = `PASS ${again.ms}ms`
  }

  {
    // A twin with the same role and name inside a closed shadow root isn't the ref's element either.
    const { page, helpers, refFor } = await open(`<div id="host"><button onclick="clicked.push('light')">Go</button></div>`)
    const go = refFor(/button "Go"/)
    await run(page, `
      const host = document.getElementById("host")
      host.innerHTML = ""
      const shadow = host.attachShadow({ mode: "closed" })
      shadow.innerHTML = '<span><button>Go</button></span>'
      shadow.querySelector("button").onclick = () => clicked.push("shadow")`)
    const result = await timed(() => helpers.ref(go).click())
    assert.match(result.error ?? "", /is stale: button "Go" is gone/)
    fast(result.ms)
    assert.deepEqual(await clicked(page), [])
    results.closedShadow = `PASS ${result.ms}ms`
  }

  {
    // Reads never throw: polling isVisible() and count() on a stale ref for longer than the grace period keeps
    // returning false and 0, and an aria-hidden control is matched no more than getByRole matched it.
    const { page, helpers, refFor } = await open(`<div><button>Save</button></div><div aria-hidden="true"><button>Hidden</button></div>`)
    const save = refFor(/button "Save"/)
    const hidden = refFor(/button "Hidden"/)
    await run(page, `document.querySelector("button").textContent = "Saved"`)
    const ref = helpers.ref(save)
    const started = Date.now()
    while (Date.now() - started < 4_000) {
      assert.equal(await ref.isVisible(), false)
      assert.equal(await ref.count(), 0)
      await page.waitForTimeout(250)
    }
    assert.equal(await helpers.ref(hidden).count(), 0)
    results.reads = "PASS"
  }

  {
    // Each action gets its own grace period: an earlier miss on the same locator doesn't shorten the next one.
    const { page, helpers, refFor } = await open(`<div><button onclick="clicked.push('save')">Save</button></div>`)
    const ref = helpers.ref(refFor(/button "Save"/))
    await run(page, `const save = document.querySelector("button"); save.textContent = "Saving…"; setTimeout(() => save.textContent = "Save", 5000)`)
    const first = await timed(() => ref.click())
    assert.match(first.error ?? "", /now reads "Saving…"/)
    const second = await timed(() => ref.click())
    assert.equal(second.error, undefined)
    assert.ok(second.ms >= 1_000, `took ${second.ms}ms`)
    assert.deepEqual(await clicked(page), ["save"])
    results.perCallGrace = `PASS ${first.ms}ms then ${second.ms}ms`
  }

  for (const [label, html, line, change] of [
    // A label that reads "Saving…" for 2 s still gets clicked.
    ["savingLabel", `<div><button onclick="clicked.push('clicked')">Save</button></div>`, /button "Save"/,
      `const save = document.querySelector("button"); save.textContent = "Saving…"; setTimeout(() => save.textContent = "Save", 2000)`],
    // So does a control that's gone for 2 s while its form re-mounts.
    ["remountGap", `<div id="root"><form><button type="button" onclick="clicked.push('clicked')">Go</button></form></div>`, /button "Go"/,
      `const root = document.getElementById("root"); const html = root.innerHTML; root.innerHTML = "<p>Loading…</p>"; setTimeout(() => root.innerHTML = html, 2000)`],
    // A ref that still matches but is hidden for longer than the grace period keeps waiting, as before.
    ["hiddenWait", `<div><button onclick="clicked.push('clicked')">Open</button></div>`, /button "Open"/,
      `const open = document.querySelector("button"); open.style.display = "none"; setTimeout(() => open.style.display = "", 5000)`],
    // So does a match covered by an overlay.
    ["overlay", `<button id="go" onclick="clicked.push('clicked')">Go</button>`, /button "Go"/,
      `const overlay = document.createElement("div"); overlay.style.cssText = "position:fixed;inset:0"; document.body.append(overlay); setTimeout(() => overlay.remove(), 4000)`],
  ] as const) {
    const { page, helpers, refFor } = await open(html)
    const id = refFor(line)
    await run(page, change)
    const result = await timed(() => helpers.ref(id).click())
    assert.equal(result.error, undefined, label)
    assert.ok(result.ms >= 1_500, `${label} took ${result.ms}ms`)
    assert.deepEqual(await clicked(page), ["clicked"], label)
    results[label] = `PASS ${result.ms}ms`
  }

  {
    // An action that passes its own timeout waits that long, like a plain locator, instead of failing after 3 s.
    const { page, helpers, refFor } = await open(`<div><button onclick="clicked.push('save')">Save</button></div>`)
    const save = refFor(/button "Save"/)
    await run(page, `const save = document.querySelector("button"); save.textContent = "Saving…"; setTimeout(() => save.textContent = "Save", 4500)`)
    const result = await timed(() => helpers.ref(save).click({ timeout: 10_000 }))
    assert.equal(result.error, undefined)
    assert.ok(result.ms >= 4_000, `took ${result.ms}ms`)
    assert.deepEqual(await clicked(page), ["save"])
    results.explicitTimeout = `PASS ${result.ms}ms`
  }

  {
    // A ref inside a same-origin iframe resolves in that frame, and fails fast there once its control is renamed.
    const frame = `<button onclick="parent.clicked.push('pay')">Pay</button><button onclick="parent.clicked.push('back')">Back</button>`
    const { page, helpers, refFor } = await open(`<iframe title="Checkout" style="width:300px;height:120px" srcdoc="${frame.replaceAll('"', "&quot;")}"></iframe>`)
    const pay = refFor(/button "Pay"/)
    const back = refFor(/button "Back"/)
    await helpers.ref(back).click()
    await run(page, `document.querySelector("iframe").contentDocument.querySelector("button").textContent = "Paid"`)
    const result = await timed(() => helpers.ref(pay).click())
    assert.match(result.error ?? "", new RegExp(`ref ${pay} is stale: button "Pay" now reads "Paid"; call snapshot\\(\\) again`))
    fast(result.ms)
    assert.equal(await helpers.ref(pay).count(), 0)
    assert.deepEqual(await clicked(page), ["back"])
    results.iframe = `PASS ${result.ms}ms`
  }

  {
    // A plain locator keeps Playwright's normal wait: it's still waiting well past the grace period.
    const { page } = await open(`<main></main>`)
    const pending = timed(() => page.locator("#late").click())
    await page.waitForTimeout(6_000)
    await run(page, `const late = document.createElement("button"); late.id = "late"; late.textContent = "Late"; late.onclick = () => clicked.push("late"); document.body.append(late)`)
    const result = await pending
    assert.equal(result.error, undefined)
    assert.ok(result.ms >= 6_000, `took ${result.ms}ms`)
    assert.deepEqual(await clicked(page), ["late"])
    results.plainLocator = `PASS ${result.ms}ms`
  }

  {
    // Refs keep their ids into a snapshot with different options, still scope snapshot({ within }), and stay strict
    // about a page change.
    const { page, helpers, text, refFor } = await open(`<main><button>One</button><button>Two</button></main>`)
    const one = refFor(/button "One"/)
    const smaller = await helpers.snapshot({ maxItems: 1 })
    assert.match(smaller, new RegExp(`button "One" \\[ref=${one}\\]`), `${text}\n---\n${smaller}`)
    assert.match(await helpers.snapshot({ within: helpers.ref(one) }), /button "One"/)
    await page.evaluate(() => history.pushState({}, "", "#moved"))
    assert.throws(() => helpers.ref(one), /Snapshot refs are stale after a page change; call snapshot\(\) again/)
    results.ids = "PASS"
  }

  console.log(JSON.stringify(results))
} finally {
  await browser.close()
}
