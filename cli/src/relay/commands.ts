import { Effect, Result } from "effect"
import type { JsonObject } from "../protocol.ts"
import type { BrowserLink, BrowserLinks } from "./browser-links.ts"
import { getNumber } from "./helpers.ts"
import type { ExtensionCommandInput } from "./rpc.ts"

/**
 * Extension command routing: one browser by link, the browser that owns a tab, every connected browser, or the first
 * that answers. Tab ids are translated at the link's edge, so callers only ever see relay ids.
 */
export function createExtensionCommands(options: { readonly browsers: BrowserLinks }) {
  const { browsers } = options
  const sendToBrowser = (link: BrowserLink, command: ExtensionCommandInput) =>
    link.rpc.send(command).pipe(Effect.map((result) => {
      const tabId = getNumber(result, "tabId")
      return tabId === undefined ? result : { ...result, tabId: browsers.relayTabId(link, tabId) }
    }))
  const sendToExtension = (command: ExtensionCommandInput, link?: BrowserLink): Effect.Effect<JsonObject, Error> => {
    const tabId = getNumber(command.params, "tabId")
    if (tabId !== undefined) {
      const owner = browsers.browserTab(tabId)
      if (!owner) return Effect.fail(new Error("Browse extension is not connected"))
      return sendToBrowser(owner.link, { ...command, params: { ...command.params, tabId: owner.tabId } })
    }
    const target = link ?? browsers.defaultLink()
    return target ? sendToBrowser(target, command) : Effect.fail(new Error("Browse extension is not connected"))
  }
  const sendExtensionBestEffort = (command: ExtensionCommandInput, link?: BrowserLink): void => {
    Effect.runPromise(Effect.ignore(sendToExtension(command, link))).catch(() => {})
  }
  const sendToEveryBrowser = (command: ExtensionCommandInput): void => {
    for (const link of browsers.list()) if (link.rpc.connected) sendExtensionBestEffort(command, link)
  }
  const sendToEach = (command: ExtensionCommandInput): Effect.Effect<JsonObject, Error> => Effect.gen(function* () {
    const links = browsers.list().filter((link) => link.rpc.connected)
    if (links.length === 0) return yield* Effect.fail(new Error("Browse extension is not connected"))
    const results = yield* Effect.forEach(links, (link) => Effect.result(sendToBrowser(link, command)), { concurrency: "unbounded" })
    const succeeded = results.find(Result.isSuccess)
    if (succeeded) return succeeded.success
    const failed = results.find(Result.isFailure)
    return yield* Effect.fail(failed?.failure ?? new Error("Browse extension is not connected"))
  })
  return { sendToExtension, sendExtensionBestEffort, sendToEveryBrowser, sendToEach }
}
