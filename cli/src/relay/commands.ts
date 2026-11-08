import { Effect, Result } from "effect"
import type { JsonObject } from "../protocol.ts"
import type { TargetRegistry } from "../cdp/target-registry.ts"
import type { BrowserLink, BrowserLinks } from "./browser-links.ts"
import { getNumber } from "./helpers.ts"
import type { ExtensionCommandInput } from "./rpc.ts"

/**
 * Extension command routing: one browser by link, the browser that owns a tab, every connected browser, or the first
 * that answers. Tab ids are translated at the link's edge, so callers only ever see relay ids.
 */
export function createExtensionCommands(options: { readonly browsers: BrowserLinks; readonly registry: Pick<TargetRegistry, "listRootTargets"> }) {
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
      if (!owner) return Effect.fail(new Error("browse extension is not connected"))
      return sendToBrowser(owner.link, { ...command, params: { ...command.params, tabId: owner.tabId } })
    }
    const target = link ?? browsers.defaultLink()
    return target ? sendToBrowser(target, command) : Effect.fail(new Error("browse extension is not connected"))
  }
  const sendExtensionBestEffort = (command: ExtensionCommandInput, link?: BrowserLink): void => {
    Effect.runPromise(Effect.ignore(sendToExtension(command, link))).catch(() => {})
  }
  const sendToEveryBrowser = (command: ExtensionCommandInput): void => {
    for (const link of browsers.list()) if (link.rpc.connected) sendExtensionBestEffort(command, link)
  }
  /** Sends to every connected browser (`command` may differ per browser) and answers with the first success. */
  const sendToEach = (command: ExtensionCommandInput | ((link: BrowserLink) => ExtensionCommandInput)): Effect.Effect<JsonObject, Error> => Effect.gen(function* () {
    const links = browsers.list().filter((link) => link.rpc.connected)
    if (links.length === 0) return yield* Effect.fail(new Error("browse extension is not connected"))
    const results = yield* Effect.forEach(links, (link) => Effect.result(sendToBrowser(link, typeof command === "function" ? command(link) : command)), { concurrency: "unbounded" })
    const succeeded = results.find(Result.isSuccess)
    if (succeeded) return succeeded.success
    const failed = results.find(Result.isFailure)
    return yield* Effect.fail(failed?.failure ?? new Error("browse extension is not connected"))
  })
  /**
   * Closes idle agent tabs in every browser. With `sessionIds` (one agent's sessions), `idleMinutes` covers only their
   * tabs. It goes in `own`, which an older extension doesn't read, so that one sweeps at the user's setting instead of
   * closing other agents' tabs.
   */
  const cleanupTabs = (idleMinutes: number | undefined, sessionIds?: readonly string[]) => {
    const minutes = idleMinutes === undefined ? {} : { idleMinutes }
    if (!sessionIds) return sendToEach({ method: "tabs.cleanup", ...(idleMinutes === undefined ? {} : { params: minutes }) })
    const owners = new Set(sessionIds)
    const own = options.registry.listRootTargets()
      .filter((target) => target.opencodeBrowserSessionId !== undefined && owners.has(target.opencodeBrowserSessionId))
      .flatMap((target) => browsers.browserTab(target.tabId) ?? [])
    return sendToEach((link) => ({
      method: "tabs.cleanup",
      params: { own: { tabIds: own.filter((tab) => tab.link === link).map((tab) => tab.tabId), ...minutes } },
    }))
  }
  return { sendToExtension, sendExtensionBestEffort, sendToEveryBrowser, sendToEach, cleanupTabs }
}
