// Headless check of snapshot root selection and iframe capture in a plain page with no extension or relay:
//   PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=<chrome> bun test/snapshot-within-browser.ts [--browser <chrome>]
// Runs under Bun because it loads cli/src TypeScript directly; existing harnesses run Node against built output.
// The browser is --browser, else PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, else patchright-core's own Chromium.
import assert from "node:assert/strict"
import http from "node:http"
import { parseArgs } from "node:util"
import { chromium, selectors } from "patchright-core"
import { createAriaSnapshotHelper, createSnapshotHelpers } from "../src/snapshot.ts"
import { ariaSnapshotWithoutTextControlValues, registerAriaSnapshotSelector } from "../src/snapshot/aria-snapshot.ts"
import type { SnapshotRefRegistry } from "../src/snapshot/types.ts"
import { portFromEnv } from "./support/ports.ts"

const { values: options } = parseArgs({ options: { browser: { type: "string" } } })
const executablePath = options.browser || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || chromium.executablePath()
const cdpPort = await portFromEnv("BROWSE_TEST_CDP_PORT")
const browser = await chromium.launch({ executablePath, args: [`--remote-debugging-port=${cdpPort}`] })
const registry = (): SnapshotRefRegistry => ({ selectors: new Map() })

// The iframe fixture: a modal checkout dialog with a cross-origin payment frame (localhost, so Chromium puts it in
// its own process) and a same-origin one, each with a heading, two textboxes, a button and a nested frame.
const frameForm = (title: string, nested = ""): string => `<!doctype html><html><body>
  <h1>${title}</h1>
  <label>Card number<input name="card" aria-label="Card number"></label>
  <label>Expiry<input name="expiry" aria-label="Expiry"></label>
  <button type="button" onclick="this.textContent='Paid'">Pagar</button>
  ${nested}
</body></html>`

let sameOriginFrameUrl = ""
const nestedHtml = frameForm("Nested").replace("Pagar", "Nested")
// A third origin for a frame that never answers, on its own address so it cannot share a renderer with the page.
// macOS has no 127.0.0.2 unless aliased, so fall back to the IPv6 loopback there.
const hungServer = http.createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
  response.end(`<!doctype html><html><head><script>while (true) {}</script></head><body></body></html>`)
})
await new Promise<void>((resolve, reject) => {
  hungServer.once("listening", () => resolve())
  hungServer.once("error", (error: NodeJS.ErrnoException) => {
    // Bun reports an address the host doesn't have as EADDRINUSE; port 0 can't really be in use.
    if (error.code !== "EADDRNOTAVAIL" && error.code !== "EADDRINUSE") return reject(error)
    hungServer.once("error", reject)
    hungServer.listen(0, "::1")
  })
  hungServer.listen(0, "127.0.0.2")
})
const hungAddress = hungServer.address() as { address: string; family: string; port: number }
const hungHost = hungAddress.family === "IPv6" ? `[${hungAddress.address}]` : hungAddress.address
const hungPort = hungAddress.port
const crossOriginServer = http.createServer((request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
  if (request.url === "/nested") return response.end(nestedHtml)
  if (request.url === "/moved") return response.end(frameForm("Moved"))
  if (request.url === "/leak") return response.end(`<!doctype html><html><body><h1>Leaky</h1><input aria-label="Key" value="LEAK-VALUE-CROSS"><button>Go</button></body></html>`)
  if (request.url === "/hung") return response.end(`<!doctype html><html><head><script>while (true) {}</script></head><body></body></html>`)
  if (request.url === "/nested-host") return response.end(`<!doctype html><html><body><h1>A</h1><iframe src="http://${hungHost}:${hungPort}/hung" title="a1"></iframe></body></html>`)
  if (request.url === "/slow") return response.end(`<!doctype html><html><head><script>const end = Date.now() + 1500; while (Date.now() < end) {}</script></head><body><h1>Slow</h1></body></html>`)
  response.end(frameForm("Pay form", request.url === "/payment" ? `<iframe src="${sameOriginFrameUrl}/nested" title="nested" width="200" height="150"></iframe>` : ""))
})
await new Promise<void>((resolve) => crossOriginServer.listen(0, "127.0.0.1", resolve))
const crossOriginPort = (crossOriginServer.address() as { port: number }).port

const hostServer = http.createServer((request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
  if (request.url === "/same") return response.end(frameForm("Same form"))
  if (request.url === "/many") return response.end(`<!doctype html><html><body><h1>Many</h1>${Array.from({ length: 10 }, (_, index) => `<iframe src="/same" title="same-${index}"></iframe>`).join("")}</body></html>`)
  if (request.url === "/nested") return response.end(nestedHtml)
  if (request.url === "/moved-frame") return response.end(frameForm("Moved"))
  if (request.url === "/frame-leak") return response.end(`<!doctype html><html><body><h1>Late</h1><input aria-label="Key" value="LEAK-VALUE-ATTR"><button>Go</button></body></html>`)
  if (request.url === "/working") return response.end(`<!doctype html><html><body><h1>Working</h1><input aria-label="Working field" value="working-value"></body></html>`)
  if (request.url === "/mislabel") return response.end(`<!doctype html><html><body><main><h1>Host</h1>
    <div aria-hidden="true"><template shadowrootmode="open"><iframe src="/shadow-frame" title="hidden-host"></iframe></template></div>
    <iframe src="/zero-frame" title="zero" style="border:0;width:0;height:0"></iframe></main></body></html>`)
  if (request.url === "/shadow-frame") return response.end(`<!doctype html><html><body><h1>B frame</h1></body></html>`)
  if (request.url === "/zero-frame") return response.end(`<!doctype html><html><body><h1>A frame</h1></body></html>`)
  if (request.url === "/late-target") return response.end(`<!doctype html><html><body><main><h1>Host</h1><div id="late-slot"></div></main>
    <script>setTimeout(() => { const el = document.createElement("section"); el.id = "late"; el.innerHTML = "<h2>Late</h2>" + Array.from({ length: 12000 }, (_, index) => "<p>row " + index + "</p>").join(""); document.getElementById("late-slot").appendChild(el) }, 1750)</script></body></html>`)
  if (request.url === "/slow-parent") return response.end(`<!doctype html><html><body><main><h1>Host</h1><iframe src="http://localhost:${crossOriginPort}/slow" title="slow"></iframe></main></body></html>`)
  if (request.url === "/aria-many") return response.end(`<!doctype html><html><body><main><h1>Host</h1>
    ${Array.from({ length: 10 }, (_, index) => `<iframe src="/working" title="many-${index}"></iframe>`).join("")}
    ${Array.from({ length: 2 }, (_, index) => `<iframe src="/working" title="tiny-${index}" style="border:0;width:0;height:0"></iframe>`).join("")}
    </main></body></html>`)
  if (request.url === "/nested-hung") return response.end(`<!doctype html><html><body><main><h1>Host</h1>
    <iframe src="http://localhost:${crossOriginPort}/nested-host" title="a"></iframe>
    <iframe src="/working" title="b"></iframe></main></body></html>`)
  if (request.url === "/hung-parent") return response.end(`<!doctype html><html><body><main><h1>Host</h1>
    <iframe src="http://localhost:${crossOriginPort}/hung" title="hung"></iframe>
    <iframe src="/working" title="healthy"></iframe></main></body></html>`)
  if (request.url === "/modal") return response.end(`<!doctype html><html><body><main><h1>Checkout</h1>
    <dialog open aria-modal="true" aria-label="Modal">
      <h2>Details</h2>
      <input aria-label="Email">
      <button type="button">Apply</button>
      <iframe src="/working" title="tiny" width="10" height="10"></iframe>
    </dialog></main></body></html>`)
  if (request.url === "/ads") return response.end(`<!doctype html><html><body><main><h1>Ads</h1>
    ${Array.from({ length: 6 }, (_, index) => `<iframe src="/working" title="ad-${index}" width="300" height="100"></iframe>`).join("")}
    <button type="button">Real action</button></main></body></html>`)
  if (request.url === "/redact-fail") return response.end(`<!doctype html><html><body><main><h1>Host</h1>
    <iframe src="/frame-leak" title="broken"></iframe><iframe src="/working" title="working"></iframe></main></body></html>`)
  response.end(`<!doctype html><html><body><main><h1>Checkout</h1>
    <dialog open aria-modal="true" aria-label="Pagar">
      <iframe src="http://localhost:${crossOriginPort}/payment" title="payment" width="400" height="300"></iframe>
      <iframe src="/same" title="same" width="400" height="300"></iframe>
    </dialog>
  </main></body></html>`)
})
await new Promise<void>((resolve) => hostServer.listen(0, "127.0.0.1", resolve))
const hostPort = (hostServer.address() as { port: number }).port
sameOriginFrameUrl = `http://127.0.0.1:${hostPort}`

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const refFor = (output: string, role: string, name: string, after?: string): string | undefined => {
  const lines = output.split("\n")
  const start = after === undefined ? 0 : Math.max(0, lines.findIndex((line) => line.includes(after)))
  for (let index = start; index < lines.length; index++) {
    const match = new RegExp(`${role} "${name}" \\[ref=(e\\d+)`).exec(lines[index]!)
    if (match) return match[1]
  }
  return undefined
}

try {
  const page = await browser.newPage()
  // The execute sandbox registers the redaction engine when it connects, before any frame's utility world exists.
  await registerAriaSnapshotSelector(page.context())

  // Each CDP connection gets a default context. Even connections made after the first registration must redact,
  // without a stream of short-lived connections retaining a new selector source per context in Patchright.
  const engines = (selectors as unknown as { _selectorEngines: unknown[] })._selectorEngines
  const initial = engines.length
  for (let index = 0; index < 3; index++) {
    const connection = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`)
    try {
      const field = await connection.contexts()[0]!.newPage()
      await field.setContent('<input aria-label="Account" value="private-marker">')
      const root = field.locator("body")
      const snapshot = await ariaSnapshotWithoutTextControlValues(root, { timeout: 3000 })
      assert.match(snapshot, /textbox "Account"/)
      assert.doesNotMatch(snapshot, /private-marker/)
      assert.match(await root.ariaSnapshot(), /private-marker/)
      await field.close()
    } finally { await connection.close() }
  }
  assert.ok(engines.length <= initial + 1, `${engines.length - initial} retained redaction engines`)

  // Two mains: the first visible one is captured and the output says why.
  await page.setContent(`
    <main><h1>First main</h1><button>Save first</button></main>
    <main><h1>Second main</h1><button>Save second</button></main>
  `)
  const multiple = await createSnapshotHelpers(page, registry()).snapshot({ within: "main" })
  assert.equal(multiple.split("\n")[0], 'within "main" matched 2 elements; showing the first', multiple)
  assert.match(multiple, /button "Save first"/)
  assert.doesNotMatch(multiple, /Save second/)

  // A hidden first match is passed over in favour of the visible one.
  await page.setContent(`
    <main style="display:none"><button>Hidden first</button></main>
    <main><button>Visible second</button></main>
  `)
  const hidden = await createSnapshotHelpers(page, registry()).snapshot({ within: "main" })
  assert.equal(hidden.split("\n")[0], 'within "main" matched 2 elements; showing the first', hidden)
  assert.match(hidden, /button "Visible second"/)
  assert.doesNotMatch(hidden, /Hidden first/)

  // No match: the whole page is captured instead of throwing.
  await page.setContent(`
    <header><h1>No main here</h1></header>
    <section><button>Lonely button</button></section>
  `)
  const missing = await createSnapshotHelpers(page, registry()).snapshot({ within: "main" })
  assert.equal(missing.split("\n")[0], 'within "main" matched nothing; showing the whole page', missing)
  assert.match(missing, /button "Lonely button"/)

  // Exactly one match keeps the old behaviour, with no note.
  await page.setContent(`<main><button>Only button</button></main>`)
  const single = await createSnapshotHelpers(page, registry()).snapshot({ within: "main" })
  assert.equal(single.split("\n")[0]?.startsWith("- "), true, single)
  assert.match(single, /button "Only button"/)
  assert.doesNotMatch(single, /within "main"/)

  // A ref root stays strict: the forgiving fallback is only for a `within` selector string.
  const refButton = async (): Promise<{ helpers: ReturnType<typeof createSnapshotHelpers>; refId: string }> => {
    await page.setContent(`<main><button id="dup">Duplicate me</button></main>`)
    const helpers = createSnapshotHelpers(page, registry())
    const refId = /button "Duplicate me" \[ref=(e\d+)\]/.exec(await helpers.snapshot())?.[1]
    assert.ok(refId, "expected a ref for the duplicate button")
    return { helpers, refId }
  }
  const duplicated = await refButton()
  await page.evaluate(() => { document.body.appendChild(document.querySelector("#dup")!.cloneNode(true)) })
  await assert.rejects(
    duplicated.helpers.snapshot({ within: duplicated.helpers.ref(duplicated.refId) }),
    /snapshot within expects exactly one match for selector: #dup; got 2/,
  )
  const dropped = await refButton()
  await page.evaluate(() => document.querySelector("#dup")!.remove())
  await assert.rejects(
    dropped.helpers.snapshot({ within: dropped.helpers.ref(dropped.refId) }),
    /snapshot within expects exactly one match for selector: #dup; got 0/,
  )

  // Readonly text fields show the value the page generated; editable, password, one-time-code and card values stay hidden.
  const readonlyContent = `
    <main>
      <input type="text" readonly value="someone@example.com">
      <input type="password" readonly value="hunter2">
      <input type="text" readonly autocomplete="one-time-code" value="424242">
      <input type="text" readonly autocomplete="cc-number" value="4111111111111111">
      <input type="text" value="private-marker">
      <input type="text" disabled>
      <textarea readonly>readonly-notes</textarea>
      <textarea>editable-notes</textarea>
      <input type="checkbox" readonly value="cbval">
      <input type="submit" readonly value="SubmitVal">
      <input type="checkbox" disabled>
    </main>
  `
  await page.setContent(readonlyContent)
  const readonlySnapshot = await createSnapshotHelpers(page, registry()).snapshot()
  assert.match(readonlySnapshot, /readonly value="someone@example\.com"/, readonlySnapshot)
  assert.match(readonlySnapshot, /readonly value="readonly-notes"/, readonlySnapshot)
  assert.equal((readonlySnapshot.match(/^- textbox "textbox"/gm) ?? []).length, 8, readonlySnapshot)
  assert.match(readonlySnapshot, /textbox "textbox" \[ref=e\d+ disabled\]/, readonlySnapshot)
  assert.doesNotMatch(readonlySnapshot, /hunter2|424242|4111111111111111|private-marker|editable-notes/)
  assert.doesNotMatch(readonlySnapshot, /readonly value="(?:cbval|SubmitVal)"/, readonlySnapshot)
  assert.doesNotMatch(readonlySnapshot, /^- checkbox "checkbox" .*disabled/m, readonlySnapshot)

  // A fresh CDP context: the redaction selector has to be registered before the page's first evaluate.
  const readonlyConnection = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`)
  try {
    const readonlyPage = await readonlyConnection.contexts()[0]!.newPage()
    await readonlyPage.setContent(readonlyContent)
    const readonlyAria = await createAriaSnapshotHelper(readonlyPage)("main")
    assert.match(readonlyAria, /someone@example\.com/, readonlyAria)
    assert.match(readonlyAria, /readonly-notes/, readonlyAria)
    assert.doesNotMatch(readonlyAria, /hunter2|424242|4111111111111111|private-marker|editable-notes/)
    await readonlyPage.close()
  } finally { await readonlyConnection.close() }

  // --- iframes ---
  await page.goto(`http://127.0.0.1:${hostPort}/`)
  for (const title of ["payment", "same"]) {
    await page.frameLocator(`iframe[title="${title}"]`).locator("h1").waitFor()
  }
  await page.frameLocator('iframe[title="payment"]').frameLocator('iframe[title="nested"]').locator("h1").waitFor()
  const frameHelpers = createSnapshotHelpers(page, registry())
  const frameSnapshot = await frameHelpers.snapshot()
  const printed = frameSnapshot.split("\n")
  const indentOf = (line: string) => line.length - line.trimStart().length
  const dialogIndex = printed.findIndex((line) => line.includes('- dialog "Pagar"'))
  const paymentIndex = printed.findIndex((line) => line.includes('- iframe "payment"'))
  const sameIndex = printed.findIndex((line) => line.includes('- iframe "same"'))
  assert.ok(dialogIndex >= 0 && paymentIndex >= 0, frameSnapshot)
  assert.ok(sameIndex > paymentIndex, frameSnapshot)
  // The dialog is the capture root and its own entry; both iframes sit one level under it.
  assert.equal(indentOf(printed[paymentIndex]!), indentOf(printed[dialogIndex]!) + 2, frameSnapshot)
  assert.equal(indentOf(printed[sameIndex]!), indentOf(printed[dialogIndex]!) + 2, frameSnapshot)
  assert.match(frameSnapshot, /- iframe "payment" \[ref=e\d+ src=localhost:\d+\]/, frameSnapshot)
  assert.match(frameSnapshot, /- iframe "same" \[ref=e\d+ src=127\.0\.0\.1:\d+\]/, frameSnapshot)
  // Both documents are captured, nested under their iframe line, and cross-origin content is included.
  const inFrame = (index: number, pattern: RegExp) => {
    const base = indentOf(printed[index]!)
    for (let cursor = index + 1; cursor < printed.length; cursor++) {
      const line = printed[cursor]!
      if (line.startsWith("- ") || indentOf(line) <= base) return false
      if (pattern.test(line)) return true
    }
    return false
  }
  assert.ok(inFrame(paymentIndex, /heading "Pay form"/), frameSnapshot)
  assert.ok(inFrame(sameIndex, /heading "Same form"/), frameSnapshot)
  assert.equal((frameSnapshot.match(/textbox "Card number"/g) ?? []).length, 3, "cross-origin, same-origin and nested frames each print a card field")

  // Frames are cheaper to leave out when they are irrelevant: the iframe line stays, its content does not.
  const withoutFrames = await createSnapshotHelpers(page, registry()).snapshot({ frames: false })
  assert.match(withoutFrames, /- iframe "payment"/)
  assert.doesNotMatch(withoutFrames, /Pay form/)

  // A ref from the cross-origin document clicks inside that document.
  const crossOriginButton = refFor(frameSnapshot, "button", "Pagar", '- iframe "payment"')
  const sameOriginField = refFor(frameSnapshot, "textbox", "Card number", '- iframe "same"')
  assert.ok(crossOriginButton, frameSnapshot)
  assert.ok(sameOriginField, frameSnapshot)
  await frameHelpers.ref(crossOriginButton).click()
  assert.equal(await page.frameLocator('iframe[title="payment"]').locator("button").textContent(), "Paid")
  await frameHelpers.ref(sameOriginField).fill("4242 4242 4242 4242")
  assert.equal(await page.frameLocator('iframe[title="same"]').locator("input[name=card]").inputValue(), "4242 4242 4242 4242")

  // find still sees frame content.
  const found = await frameHelpers.snapshot({ find: "Expiry" })
  assert.match(found, /matching snapshot lines/)
  assert.match(found, /textbox "Expiry"/)

  // A `within` locator in a frame captures there and its refs resolve there.
  const withinFrame = createSnapshotHelpers(page, registry())
  const frameBody = page.frameLocator('iframe[title="payment"]').locator("body")
  const withinOutput = await withinFrame.snapshot({ within: frameBody })
  assert.match(withinOutput, /heading "Pay form"/)
  assert.doesNotMatch(withinOutput, /Checkout/)
  const withinRef = refFor(withinOutput, "textbox", "Expiry")
  assert.ok(withinRef, withinOutput)
  assert.equal(await withinFrame.ref(withinRef).count(), 1)
  await withinFrame.ref(withinRef).fill("12/34")
  assert.equal(await page.frameLocator('iframe[title="payment"]').locator("input[name=expiry]").inputValue(), "12/34")

  // `within: ref("eN")` captures in the frame the ref came from.
  const beforeFrameRoot = await frameHelpers.snapshot()
  const frameControl = refFor(beforeFrameRoot, "textbox", "Expiry", '- iframe "payment"')
  assert.ok(frameControl, beforeFrameRoot)
  const withinFrameRef = await frameHelpers.snapshot({ within: frameHelpers.ref(frameControl) })
  assert.match(withinFrameRef, /textbox "Expiry"/)
  assert.doesNotMatch(withinFrameRef, /Checkout/)

  // A frame ref fails closed once that frame navigates.
  const beforeNavigation = await frameHelpers.snapshot()
  const paymentControl = refFor(beforeNavigation, "textbox", "Expiry", '- iframe "payment"')
  assert.ok(paymentControl, beforeNavigation)
  const crossOriginFrame = page.frames().find((frame) => frame.url().includes("localhost"))
  assert.ok(crossOriginFrame, "cross-origin frame is a real Playwright frame")
  await crossOriginFrame.goto(`http://localhost:${crossOriginPort}/moved`)
  await page.frameLocator('iframe[title="payment"]').locator("h1").filter({ hasText: "Moved" }).waitFor()
  assert.throws(
    () => frameHelpers.ref(paymentControl),
    /was captured in an iframe that has navigated or detached; call snapshot\(\) again/,
  )

  // ariaSnapshot includes iframe content but never values typed into one, cross-origin or same-origin.
  await page.goto(`http://127.0.0.1:${hostPort}/`)
  for (const title of ["payment", "same"]) {
    await page.frameLocator(`iframe[title="${title}"]`).locator("h1").waitFor()
  }
  const ariaHelpers = createAriaSnapshotHelper(page)
  await page.frameLocator('iframe[title="payment"]').locator("input[name=card]").fill("cross-secret")
  await page.frameLocator('iframe[title="same"]').locator("input[name=card]").fill("same-secret")
  await page.frameLocator('iframe[title="payment"]').frameLocator('iframe[title="nested"]').locator("input[name=card]").fill("nested-secret")
  const aria = await ariaHelpers()
  assert.match(aria, /^- iframe "payment" \[src=localhost:\d+\]:$/m, aria)
  assert.match(aria, /^- iframe "same" \[src=127\.0\.0\.1:\d+\]:$/m, aria)
  assert.match(aria, /^  - iframe "nested" \[src=127\.0\.0\.1:\d+\]:$/m, aria)
  assert.match(aria, /heading "Pay form"/, aria)
  assert.match(aria, /heading "Same form"/, aria)
  assert.match(aria, /heading "Nested"/, aria)
  assert.doesNotMatch(aria, /cross-secret/)
  assert.doesNotMatch(aria, /same-secret/)
  assert.doesNotMatch(aria, /nested-secret/)
  assert.doesNotMatch(aria, /\[ref=|\[active\]|\bgeneric\b/, "the default format is kept")
  // A target inside the frame redacts that frame and the frames nested under it too.
  const ariaInFrame = await ariaHelpers(page.frameLocator('iframe[title="payment"]').locator("body"))
  assert.match(ariaInFrame, /heading "Pay form"/)
  assert.match(ariaInFrame, /^- iframe "nested" \[src=127\.0\.0\.1:\d+\]:\n  - heading "Nested"/m, ariaInFrame)
  assert.doesNotMatch(ariaInFrame, /cross-secret/)
  assert.doesNotMatch(ariaInFrame, /nested-secret/)
  // Values are in the DOM; only the snapshot redacts them.
  assert.equal(await page.frameLocator('iframe[title="payment"]').locator("input[name=card]").inputValue(), "cross-secret")

  // diff reports a change made inside a frame, against a baseline taken with the same options.
  await page.goto(`http://127.0.0.1:${hostPort}/`)
  await page.frameLocator('iframe[title="payment"]').locator("h1").waitFor()
  const diffHelpers = createSnapshotHelpers(page, registry())
  const baseline = await diffHelpers.snapshot()
  const diffButton = refFor(baseline, "button", "Pagar", '- iframe "payment"')
  assert.ok(diffButton, baseline)
  await diffHelpers.ref(diffButton).click()
  const diff = await diffHelpers.snapshot({ diff: true })
  assert.match(diff, /\+\s+button "Paid"/, diff)

  // The frame budget is honest about the iframes it leaves out.
  await page.goto(`http://127.0.0.1:${hostPort}/many`)
  await page.frameLocator('iframe[title="same-0"]').locator("h1").waitFor()
  const many = await createSnapshotHelpers(page, registry()).snapshot({ maxItems: 200 })
  assert.match(many, /- \.\.\. 2 iframe contents not captured \(8 iframes at most per snapshot\)/, many)
  assert.match(many, /- iframe "same-9"/, many)

  // D: a modal without iframes keeps dev's shape: dialog at 0, heading at 1, its controls at 2.
  await page.goto(`http://127.0.0.1:${hostPort}/modal`)
  const modalSnapshot = await createSnapshotHelpers(page, registry()).snapshot()
  const modalLines = modalSnapshot.split("\n")
  const modalLine = (needle: string) => modalLines.findIndex((line) => line.includes(needle))
  assert.ok(modalLine('- dialog "Modal"') >= 0, modalSnapshot)
  assert.equal(indentOf(modalLines[modalLine('- dialog "Modal"')]!), 0, modalSnapshot)
  assert.equal(indentOf(modalLines[modalLine('heading "Details"')]!), 2, modalSnapshot)
  assert.equal(indentOf(modalLines[modalLine('textbox "Email"')]!), 4, modalSnapshot)
  assert.equal(indentOf(modalLines[modalLine('button "Apply"')]!), 4, modalSnapshot)
  assert.doesNotMatch(modalSnapshot, /iframe "tiny"/, "a 10x10 iframe is not worth a line")

  // E: ad iframes have ordinary priority; with a small maxItems the real control still makes it in.
  await page.goto(`http://127.0.0.1:${hostPort}/ads`)
  await page.frameLocator('iframe[title="ad-0"]').locator("h1").waitFor()
  const crowded = await createSnapshotHelpers(page, registry()).snapshot({ maxItems: 4, frames: false })
  assert.match(crowded, /button "Real action"/, crowded)
  assert.ok((crowded.match(/- iframe/g) ?? []).length < 6, crowded)

  // B: removing the first iframe never retargets its refs to the frame that shifts up.
  await page.goto(`http://127.0.0.1:${hostPort}/`)
  for (const title of ["payment", "same"]) {
    await page.frameLocator(`iframe[title="${title}"]`).locator("h1").waitFor()
  }
  const identityHelpers = createSnapshotHelpers(page, registry())
  const identityBefore = await identityHelpers.snapshot()
  const paymentButton = refFor(identityBefore, "button", "Pagar", '- iframe "payment"')
  const sameButton = refFor(identityBefore, "button", "Pagar", '- iframe "same"')
  assert.ok(paymentButton && sameButton, identityBefore)
  await page.evaluate(() => document.querySelector('iframe[title="payment"]')!.remove())
  const identityAfter = await identityHelpers.snapshot()
  assert.throws(() => identityHelpers.ref(paymentButton!), /Unknown snapshot ref/, identityAfter)
  assert.equal(refFor(identityAfter, "button", "Pagar", '- iframe "same"'), sameButton, identityAfter)

  // F: a bare FrameLocator scopes the snapshot to that frame's document.
  const frameScopeHelpers = createSnapshotHelpers(page, registry())
  const bareScope = await frameScopeHelpers.snapshot({ within: page.frameLocator('iframe[title="same"]') })
  assert.match(bareScope, /heading "Same form"/, bareScope)
  const bareRef = refFor(bareScope, "textbox", "Card number")
  assert.ok(bareRef, bareScope)
  assert.equal(await frameScopeHelpers.ref(bareRef).count(), 1)

  // I: a `within` ref root rechecks its frame; a ref resolved before the navigation cannot be used after it.
  await page.goto(`http://127.0.0.1:${hostPort}/`)
  await page.frameLocator('iframe[title="payment"]').locator("h1").waitFor()
  const staleHelpers = createSnapshotHelpers(page, registry())
  const staleSnapshot = await staleHelpers.snapshot()
  const staleControl = refFor(staleSnapshot, "textbox", "Card number", '- iframe "payment"')
  assert.ok(staleControl, staleSnapshot)
  const staleRoot = staleHelpers.ref(staleControl)
  const staleFrame = page.frames().find((frame) => frame.url().includes("localhost"))
  assert.ok(staleFrame, "cross-origin frame is a real Playwright frame")
  await staleFrame.goto(`http://localhost:${crossOriginPort}/moved`)
  await assert.rejects(
    () => staleHelpers.snapshot({ within: staleRoot }),
    /stale after an iframe navigation or detach/,
  )

  // An aria-hidden host in a shadow root and a 0x0 iframe make line-to-element mapping impossible; the tree is
  // left alone and each captured frame gets a label that names the frame it actually is.
  await page.goto(`http://127.0.0.1:${hostPort}/mislabel`)
  await page.frameLocator('iframe[title="hidden-host"]').locator("h1").waitFor()
  const mislabel = await createAriaSnapshotHelper(page)()
  assert.match(mislabel, /^\s+- iframe$/m, mislabel)
  assert.match(mislabel, /- iframe "hidden-host" \[src=127\.0\.0\.1:\d+\]:\n  - heading "B frame"/, mislabel)
  assert.doesNotMatch(mislabel, /- iframe "zero"/, "a 0x0 iframe is not captured")
  assert.doesNotMatch(mislabel, /heading "A frame"/)

  // --- ariaSnapshot: frames are read one document at a time, each with its own redaction ---
  await page.goto(`http://127.0.0.1:${hostPort}/`)
  await page.frameLocator('iframe[title="payment"]').locator("h1").waitFor()
  const leakHelpers = createAriaSnapshotHelper(page)
  // An iframe inserted just before the snapshot is read through its own token, redacted in its own frame.
  await page.evaluate((url) => {
    const iframe = document.createElement("iframe")
    iframe.src = url
    iframe.title = "late"
    document.body.appendChild(iframe)
  }, `http://127.0.0.1:${hostPort}/frame-leak`)
  await page.frameLocator('iframe[title="late"]').locator("h1").waitFor()
  const inserted = await leakHelpers()
  assert.match(inserted, /heading "Late"/, inserted)
  assert.doesNotMatch(inserted, /LEAK-VALUE-ATTR/)

  // A cross-origin frame navigated just before, or while, the snapshot runs never returns the new values.
  const crossOrigin = page.frames().find((frame) => frame.url().includes("localhost"))
  assert.ok(crossOrigin, "cross-origin frame is a real Playwright frame")
  await crossOrigin.goto(`http://localhost:${crossOriginPort}/leak`)
  const navigated = await leakHelpers()
  assert.doesNotMatch(navigated, /LEAK-VALUE-CROSS/)
  const pendingAria = leakHelpers()
  await pause(5)
  await crossOrigin.goto(`http://localhost:${crossOriginPort}/leak?again`).catch(() => {})
  assert.doesNotMatch(await pendingAria, /LEAK-VALUE-CROSS/)

  // A frame whose redaction cannot be activated becomes a note, is not left patched, and does not fail the rest.
  const brokenConnection = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`)
  try {
    const brokenPage = await brokenConnection.contexts()[0]!.newPage()
    await brokenPage.goto(`http://127.0.0.1:${hostPort}/redact-fail`)
    const brokenFrame = brokenPage.frames().find((frame) => frame.url().includes("/frame-leak"))
    assert.ok(brokenFrame, "the broken frame loaded")
    // Warm only that frame's utility world, before the redaction engine is registered for this context.
    await brokenFrame.locator("body").innerText()
    const brokenAria = await createAriaSnapshotHelper(brokenPage)()
    assert.match(brokenAria, /heading "Host"/, brokenAria)
    assert.match(brokenAria, /content not captured/, brokenAria)
    assert.match(brokenAria, /heading "Working"/, "a healthy frame still gets its content")
    assert.doesNotMatch(brokenAria, /LEAK-VALUE-ATTR/)
    assert.equal(
      await brokenPage.frameLocator('iframe[title="broken"]').locator("input").inputValue(),
      "LEAK-VALUE-ATTR",
      "a frame whose activation failed is not left patched",
    )
    await brokenPage.close()
  } finally { await brokenConnection.close() }

  // One slow frame (1.5s) gets the caller's time when it is the only frame, rather than an eighth of it.
  await page.goto(`http://127.0.0.1:${hostPort}/slow-parent`, { waitUntil: "domcontentloaded" })
  const slowSnapshot = await createSnapshotHelpers(page, registry()).snapshot({ timeout: 5_000 })
  assert.match(slowSnapshot, /- iframe "slow"[\s\S]*heading "Slow"/, slowSnapshot)
  const slowAria = await createAriaSnapshotHelper(page)()
  assert.match(slowAria, /- iframe "slow" \[src=localhost:\d+\]:\n  - heading "Slow"/, slowAria)

  // Tiny iframes are filtered before the 8-frame cap, so they are not counted in the skip note either.
  await page.goto(`http://127.0.0.1:${hostPort}/aria-many`)
  await page.frameLocator('iframe[title="many-0"]').locator("h1").waitFor()
  const ariaMany = await createAriaSnapshotHelper(page)()
  assert.match(ariaMany, /- \.\.\. 2 iframe contents not captured \(8 iframes at most per snapshot\)/, ariaMany)
  assert.doesNotMatch(ariaMany, /iframe "tiny-/)

  // A hung frame nested inside the first iframe is bounded by that frame's slice, so the next sibling is still
  // captured instead of inheriting the whole snapshot deadline.
  await page.goto(`http://127.0.0.1:${hostPort}/nested-hung`, { waitUntil: "domcontentloaded" })
  await page.frameLocator('iframe[title="b"]').locator("h1").waitFor()
  const nestedSnapshot = await createSnapshotHelpers(page, registry()).snapshot({ timeout: 5_000 })
  assert.match(nestedSnapshot, /content not captured \(the frame did not answer in time\)/, nestedSnapshot)
  assert.match(nestedSnapshot, /- iframe "b"[\s\S]*heading "Working"/, nestedSnapshot)
  const nestedAria = await createAriaSnapshotHelper(page)(undefined, { timeout: 5_000 })
  assert.match(nestedAria, /- iframe "b" \[src=127\.0\.0\.1:\d+\]:\n  - heading "Working"/, nestedAria)
  await page.goto("about:blank")

  // A page without iframes keeps dev's output even when its tree read runs past the caller's timeout: the cheap
  // listing still runs, finds nothing, and must not add an iframe deadline note.
  await page.goto(`http://127.0.0.1:${hostPort}/late-target`)
  const lateTarget = await createAriaSnapshotHelper(page)("#late", { timeout: 2_000 })
  assert.match(lateTarget, /heading "Late"/, lateTarget)
  assert.doesNotMatch(lateTarget, /iframe contents not captured/, lateTarget)

  // One hung frame gets a capped timeout, so a healthy frame after it is still captured (snapshot and aria).
  await page.goto(`http://127.0.0.1:${hostPort}/hung-parent`, { waitUntil: "domcontentloaded" })
  await page.frameLocator('iframe[title="healthy"]').locator("h1").waitFor()
  const hungSnapshot = await createSnapshotHelpers(page, registry()).snapshot({ timeout: 5_000 })
  assert.match(hungSnapshot, /- iframe "hung"/, hungSnapshot)
  assert.match(hungSnapshot, /content not captured \(the frame did not answer in time\)/, hungSnapshot)
  assert.match(hungSnapshot, /- iframe "healthy"[\s\S]*heading "Working"/, hungSnapshot)
  const hungAria = await createAriaSnapshotHelper(page)()
  assert.match(hungAria, /- iframe "hung" \[src=localhost:\d+\]:\n  - \.\.\. content not captured/, hungAria)
  assert.match(hungAria, /- iframe "healthy" \[src=127\.0\.0\.1:\d+\]:\n  - heading "Working"/, hungAria)
  await page.goto("about:blank")

  console.log(JSON.stringify({
    multiple: "PASS",
    hidden: "PASS",
    missing: "PASS",
    single: "PASS",
    refStrict: "PASS",
    readonlyValues: "PASS",
    frames: "PASS",
    crossOriginRef: "PASS",
    withinFrame: "PASS",
    frameRefClosed: "PASS",
    ariaFrames: "PASS",
    frameBudget: "PASS",
    modalDepth: "PASS",
    framePriority: "PASS",
    frameIdentity: "PASS",
    frameScope: "PASS",
    ariaLabelledBlocks: "PASS",
    withinRefRecheck: "PASS",
    ariaNoLeak: "PASS",
    ariaRedactionFailure: "PASS",
    hungFrame: "PASS",
    lateTreeNoIframeNote: "PASS",
    singleSlowFrame: "PASS",
    nestedHungSibling: "PASS",
    ariaTinyNotCounted: "PASS",
  }))
} finally {
  await browser.close().catch(() => {})
  await new Promise<void>((resolve) => hostServer.close(() => resolve()))
  await new Promise<void>((resolve) => crossOriginServer.close(() => resolve()))
  await new Promise<void>((resolve) => hungServer.close(() => resolve()))
}
