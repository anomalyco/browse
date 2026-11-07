import { Effect } from "effect"
import type { TargetRegistry } from "../cdp/target-registry.ts"
import type { JsonObject } from "../protocol.ts"
import { dataUrlDocument, getString } from "./helpers.ts"
import { relayLog } from "./log.ts"

type SendDebuggerCommand = (command: {
  readonly tabId: number
  readonly sessionId?: string
  readonly method: string
  readonly params: JsonObject
}) => Effect.Effect<JsonObject, Error>

/**
 * A data: URL can't be navigated to through the extension: Chromium refuses it. Navigate to about:blank and write the
 * document there instead. Returns undefined when the command is not a data: navigation the relay can write.
 */
export const navigateTopFrameToDataUrl = Effect.fnUntraced(function* (options: {
  readonly tabId: number
  readonly params: JsonObject | undefined
  readonly mainFrameIdsByTab: Map<number, string>
  readonly blankNavigationWaiters: Map<number, (url: string, loaderId: string | undefined) => void>
  readonly registry: TargetRegistry
  readonly sendDebuggerCommand: SendDebuggerCommand
}) {
  const url = getString(options.params, "url")?.trim()
  if (!url || !/^data:/i.test(url)) return undefined
  const { tabId, mainFrameIdsByTab, blankNavigationWaiters, registry, sendDebuggerCommand } = options
  const frameId = mainFrameIdsByTab.get(tabId) ?? registry.tabTargets.get(tabId)?.targetInfo.targetId
  const requestedFrameId = getString(options.params, "frameId")
  if (!frameId || (requestedFrameId !== undefined && requestedFrameId !== frameId) || blankNavigationWaiters.has(tabId)) return undefined
  const html = yield* Effect.tryPromise(() => dataUrlDocument(url)).pipe(Effect.orElseSucceed(() => undefined))
  if (html === undefined) return undefined
  const committedLoaders = new Set<string>()
  let loaderCommitted: (loaderId: string) => void = () => {}
  blankNavigationWaiters.set(tabId, (frameUrl, loaderId) => {
    if (frameUrl !== "about:blank" || loaderId === undefined) return
    committedLoaders.add(loaderId)
    loaderCommitted(loaderId)
  })
  return yield* Effect.gen(function* () {
    const navigated = yield* sendDebuggerCommand({ tabId, method: "Page.navigate", params: { url: "about:blank", frameId } })
    const loaderId = getString(navigated, "loaderId")
    if (getString(navigated, "errorText") || loaderId === undefined) return navigated
    if (!committedLoaders.has(loaderId)) {
      const committed = yield* Effect.promise(() => new Promise<void>((resolve) => {
        loaderCommitted = (id) => { if (id === loaderId) resolve() }
      })).pipe(Effect.timeoutOption(10_000))
      if (committed._tag === "None") return navigated
    }
    yield* sendDebuggerCommand({ tabId, method: "Page.setDocumentContent", params: { frameId, html } })
    relayLog("navigate.data", { tabId, chars: html.length })
    return { frameId: getString(navigated, "frameId") ?? frameId, loaderId } as JsonObject
  }).pipe(Effect.ensuring(Effect.sync(() => { blankNavigationWaiters.delete(tabId) })))
})
