// Headless check of snapshot root selection in a plain page with no extension or relay:
//   PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=<chrome> bun test/snapshot-within-browser.ts [--browser <chrome>]
// Runs under Bun because it loads cli/src TypeScript directly; existing harnesses run Node against built output.
// The browser is --browser, else PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, else patchright-core's own Chromium.
import assert from "node:assert/strict"
import { parseArgs } from "node:util"
import { chromium, selectors } from "patchright-core"
import { createAriaSnapshotHelper, createSnapshotHelpers } from "../src/snapshot.ts"
import { ariaSnapshotWithoutTextControlValues } from "../src/snapshot/aria-snapshot.ts"
import type { SnapshotRefRegistry } from "../src/snapshot/types.ts"
import { portFromEnv } from "./support/ports.ts"

const { values: options } = parseArgs({ options: { browser: { type: "string" } } })
const executablePath = options.browser || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || chromium.executablePath()
const cdpPort = await portFromEnv("BROWSE_TEST_CDP_PORT")
const browser = await chromium.launch({ executablePath, args: [`--remote-debugging-port=${cdpPort}`] })
const registry = (): SnapshotRefRegistry => ({ selectors: new Map() })

try {
  const page = await browser.newPage()

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

  console.log(JSON.stringify({ multiple: "PASS", hidden: "PASS", missing: "PASS", single: "PASS", refStrict: "PASS", readonlyValues: "PASS" }))
} finally {
  await browser.close()
}
