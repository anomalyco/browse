// Headless check of snapshot root selection in a plain page with no extension or relay:
//   PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=<chrome> bun test/snapshot-within-browser.ts [--browser <chrome>]
// Runs under Bun because it loads cli/src TypeScript directly; existing harnesses run Node against built output.
// The browser is --browser, else PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, else patchright-core's own Chromium.
import assert from "node:assert/strict"
import { parseArgs } from "node:util"
import { chromium } from "patchright-core"
import { createSnapshotHelpers } from "../src/snapshot.ts"
import type { SnapshotRefRegistry } from "../src/snapshot/types.ts"

const { values: options } = parseArgs({ options: { browser: { type: "string" } } })
const executablePath = options.browser || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || chromium.executablePath()
const browser = await chromium.launch({ executablePath })
const registry = (): SnapshotRefRegistry => ({ selectors: new Map() })

try {
  const page = await browser.newPage()

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

  console.log(JSON.stringify({ multiple: "PASS", hidden: "PASS", missing: "PASS", single: "PASS", refStrict: "PASS" }))
} finally {
  await browser.close()
}
