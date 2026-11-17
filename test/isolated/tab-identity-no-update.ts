import { expect, test } from "bun:test"
import { installChrome } from "../chrome-stub"

// No session marker and no update event means a new browser session (the extension was disabled at the last
// shutdown, so onStartup never came): tab ids restarted, and ungrouped or lent ids must not survive. Run by
// ../isolated.test.ts in a process of its own.

const stub = installChrome()

test("a missing session marker without an update event drops ungrouped ids", async () => {
  const window = await stub.chrome.windows.create({ url: "https://user.example/", focused: true })
  const lent = await stub.chrome.tabs.create({ windowId: window.id, url: "https://lent.example/", active: false })
  const side = await stub.chrome.tabs.create({ windowId: window.id, url: "https://side.example/", active: false })
  const { TabIdentity } = await import("../../src/background/tab-identity")
  await TabIdentity.ensure(lent.id!, { agent: false })
  await TabIdentity.ensure(side.id!, { agent: true, chosen: "side-mail" })
  const session = await stub.chrome.storage.session.get(null)
  await stub.chrome.storage.session.remove(Object.keys(session))

  const specifier = "../../src/background/tab-identity?restart"
  const restarted = (await import(specifier)) as typeof TabIdentity
  expect(await restarted.browseId(lent.id!)).toBeUndefined()
  expect(await restarted.chosen(side.id!)).toBeUndefined()
  expect((await stub.chrome.storage.local.get("tabIdentity")).tabIdentity).toBeUndefined()
}, 15_000)
