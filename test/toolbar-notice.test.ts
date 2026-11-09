import { beforeEach, describe, expect, test } from "bun:test"
import { installChrome } from "./chrome-stub"

// The toolbar click's notice: a failed attach after a click gets the specific file or browser-page message when it
// applies, and Chrome's reason otherwise.

const stub = installChrome()
const { ToolbarNotice } = await import("../src/background/toolbar-notice")

const tab = async (url: string) => (await stub.chrome.windows.create({ url })).tabs[0]!.id
const notification = (tabId: number) => stub.state.notifications.get(`opencode-browser-toolbar:${tabId}`) as { message: string } | undefined

beforeEach(() => {
  stub.state.permissionLevel = "granted"
  stub.state.fileAccess = false
  stub.state.notifications.clear()
})

describe("ToolbarNotice", () => {
  test("a file page without file access says how to turn it on", async () => {
    const tabId = await tab("file:///tmp/report.html")
    expect(await ToolbarNotice.unavailable(tabId)).toBe("file")
    expect(notification(tabId)?.message).toContain("Allow access to file URLs")
    expect(notification(tabId)?.message).toContain("chrome://extensions")
  })

  test("a file page with file access is left to the relay", async () => {
    stub.state.fileAccess = true
    const tabId = await tab("file:///tmp/report.html")
    expect(await ToolbarNotice.unavailable(tabId)).toBeUndefined()
    expect(stub.state.notifications.size).toBe(0)
  })

  test("browser pages and the Web Store can't be lent", async () => {
    for (const url of ["chrome://extensions", "https://chromewebstore.google.com/detail/browse/abc"]) {
      const tabId = await tab(url)
      expect(await ToolbarNotice.unavailable(tabId)).toBe("page")
      expect(notification(tabId)?.message).toContain("browse can't use this page")
    }
  })

  test("an ordinary page is left to the relay", async () => {
    const tabId = await tab("https://example.com/")
    expect(await ToolbarNotice.unavailable(tabId)).toBeUndefined()
  })

  test("browse's own pages aren't called unusable", async () => {
    const tabId = await tab("chrome-extension://stubextensionid/settings.html")
    expect(await ToolbarNotice.unavailable(tabId)).toBeUndefined()
    expect(stub.state.notifications.size).toBe(0)
  })

  test("a loading tab is judged by the page it will attach", async () => {
    const tabId = await tab("https://example.com/")
    stub.state.tabs.get(tabId)!.pendingUrl = "file:///tmp/report.html"
    expect(await ToolbarNotice.unavailable(tabId)).toBe("file")
  })

  test("only the attach after a click belongs to the user", () => {
    const tabId = 1
    expect(ToolbarNotice.take(tabId)).toBe(false)
    ToolbarNotice.expect(tabId)
    expect(ToolbarNotice.take(tabId)).toBe(true)
    expect(ToolbarNotice.take(tabId)).toBe(false)
  })

  test("a failed attach after a click says why, in Chrome's words", async () => {
    const tabId = await tab("https://example.com/")
    ToolbarNotice.expect(tabId)
    expect(ToolbarNotice.take(tabId)).toBe(true)
    await ToolbarNotice.failed(tabId, new Error("Could not attach to this tab: The extensions gallery cannot be scripted."))
    expect(notification(tabId)?.message).toBe("browse couldn't use this tab: The extensions gallery cannot be scripted.")
  })

  test("another debugger gets advice instead of its agent-facing wording", async () => {
    const tabId = await tab("https://example.com/")
    await ToolbarNotice.failed(
      tabId,
      new Error("Another debugger (DevTools or another extension) is attached to this tab. Ask the user to close it, then retry."),
    )
    expect(notification(tabId)?.message).toContain("Close that, then click the toolbar button again")
  })

  test("with notifications turned off, nothing is shown and nothing throws", async () => {
    stub.state.permissionLevel = "denied"
    const tabId = await tab("chrome://extensions")
    expect(await ToolbarNotice.unavailable(tabId)).toBe("page")
    expect(stub.state.notifications.size).toBe(0)
  })

  test("clear drops the click and the notification", async () => {
    const tabId = await tab("chrome://extensions")
    ToolbarNotice.expect(tabId)
    await ToolbarNotice.unavailable(tabId)
    await ToolbarNotice.clear(tabId)
    expect(stub.state.notifications.size).toBe(0)
    expect(ToolbarNotice.take(tabId)).toBe(false)
  })
})
