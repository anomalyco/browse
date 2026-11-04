import { Effect } from "effect"
import { WebSocket } from "ws"
import type { BrowserLinks } from "../browser-links.ts"
import type { CdpClientPool } from "../cdp-client-pool.ts"
import { guardCdpMethod, scopeCdpResult } from "../cdp-guardrails.ts"
import type { CdpRouter } from "../cdp-router.ts"
import type { CdpRuntime } from "../cdp-runtime.ts"
import {
  removeDefaultLightColorSchemeEmulation,
  replayChildFrameNavigation,
  replayChildTargetsForParent,
  replayTargetCreated,
} from "../cdp-shims.ts"
import { ghostCursorCommandMethod, type GhostCursorTabs } from "../ghost-cursor.ts"
import { beforeInput } from "../human-input.ts"
import { isCdpRequest, parseJsonObject, type CdpRequest, type JsonObject } from "../protocol.ts"
import { dataUrlDocument, getIdText, getNumber, getObject, getString, sendCdpResponse } from "../relay-helpers.ts"
import { relayLog } from "../relay-log.ts"
import type { RelayShutdown } from "../relay-shutdown.ts"
import type { ChildTarget, ConnectedTarget } from "../relay-types.ts"
import { boundedToken, runtimeFailureKind, summarizeRuntimeEvaluate } from "../runtime-diagnostics.ts"
import type { OpenCodeBrowserSessions } from "../session-manager.ts"
import type { SessionNavigationGuard } from "../session-navigation-guard.ts"
import type { TabActivity } from "../tab-activity.ts"
import type { TargetRegistry } from "../target-registry.ts"
import { targetDiagnosticIdentity } from "./process-guard.ts"

export function createCdpDispatcher(options: {
  readonly registry: TargetRegistry
  readonly browsers: BrowserLinks
  readonly sessions: OpenCodeBrowserSessions
  readonly cdpClients: CdpClientPool<WebSocket>
  readonly cdpRouter: CdpRouter<WebSocket>
  readonly cdpRuntime: CdpRuntime<WebSocket>
  readonly shutdownControl: RelayShutdown
  readonly navigationGuard: SessionNavigationGuard
  readonly ghostCursor: GhostCursorTabs
  readonly tabActivity: TabActivity
  readonly mainFrameIdsByTab: Map<number, string>
  readonly blankNavigationWaiters: Map<number, (url: string, loaderId: string | undefined) => void>
  readonly sendDebuggerCommand: (command: { readonly tabId: number; readonly sessionId?: string; readonly method: string; readonly params: JsonObject }) => Effect.Effect<JsonObject, Error>
  readonly createAndAttachTab: (createOptions: {
    readonly url: string
    readonly active: boolean
    readonly opencodeBrowserSessionId?: string
    readonly autoAttachParams?: JsonObject
  }) => Effect.Effect<ConnectedTarget, Error>
  readonly detachTab: (tabId: number) => Effect.Effect<void, Error>
  readonly closeTargetByTargetId: (targetId: string) => Effect.Effect<void, Error>
  readonly setProtectedUi: (tabId: number, protectedUi: boolean) => void
  readonly debugLog: ((line: string) => void) | undefined
  readonly contextDebugLog: ((line: string) => void) | undefined
}) {
  const {
    registry,
    browsers,
    sessions,
    cdpClients,
    cdpRouter,
    cdpRuntime,
    shutdownControl,
    navigationGuard,
    ghostCursor,
    tabActivity,
    mainFrameIdsByTab,
    blankNavigationWaiters,
    sendDebuggerCommand,
    createAndAttachTab,
    detachTab,
    closeTargetByTargetId,
    setProtectedUi,
    debugLog,
    contextDebugLog,
  } = options

  function diagnosticTargetForClient(socket: WebSocket, sessionId: string | undefined): ConnectedTarget | ChildTarget | undefined {
    return sessionId
      ? cdpRouter.targetInfo(socket, { sessionId })
      : cdpRouter.preferredRoot(socket)
  }

  function isRuntimeEvaluationMethod(method: string): boolean {
    return method === "Runtime.evaluate" || method === "Runtime.callFunctionOn"
  }

  /** A client can keep using a session only while it still routes to a visible target. */
  function clientRoutesSession(socket: WebSocket, sessionId: string): boolean {
    return socket.readyState === WebSocket.OPEN && cdpRouter.session(socket, sessionId) !== undefined
  }

  /** Canonical sessions may later receive cached Runtime replay; aliases keep the native path. */
  function admitFrameTreeResponse(socket: WebSocket, sessionId: string | undefined): ((result: unknown) => void) | undefined {
    if (sessionId === undefined || !cdpClients.hasSession(socket, sessionId)) return undefined
    const route = cdpRouter.session(socket, sessionId)
    return route && cdpRuntime.frameTreeResponse(socket, route, () => clientRoutesSession(socket, sessionId))
  }

  const applyGhostCursorMouseEvent = Effect.fnUntraced(function* (mouseOptions: { readonly tabId: number; readonly message: CdpRequest }) {
    if (mouseOptions.message.method !== "Input.dispatchMouseEvent") return
    yield* ghostCursor.mouseEvent(mouseOptions.tabId, mouseOptions.message.params)
  })

  function captureScreenshotNudged(command: { readonly tabId: number; readonly method: string; readonly params: JsonObject }) {
    const nudges = Effect.gen(function* () {
      for (const delayMs of [600, 1_000, 1_500, 2_000, 3_000, 5_000, 8_000]) {
        yield* Effect.sleep(delayMs)
        relayLog("screenshot.nudge", { tabId: command.tabId, afterMs: delayMs })
        yield* Effect.forkDetach(sendDebuggerCommand({
          tabId: command.tabId,
          method: "Page.captureScreenshot",
          params: { format: "jpeg", quality: 1, clip: { x: 0, y: 0, width: 1, height: 1, scale: 1 } },
        }).pipe(Effect.ignore))
      }
      return yield* Effect.never
    })
    return Effect.raceFirst(sendDebuggerCommand(command), nudges)
  }

  const navigateTopFrameToDataUrl = Effect.fnUntraced(function* (tabId: number, params: JsonObject | undefined) {
    const url = getString(params, "url")?.trim()
    if (!url || !/^data:/i.test(url)) return undefined
    const frameId = mainFrameIdsByTab.get(tabId) ?? registry.tabTargets.get(tabId)?.targetInfo.targetId
    const requestedFrameId = getString(params, "frameId")
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

  const routeCdpCommand = Effect.fn("Relay.routeCdpCommand")(function* (socket: WebSocket, message: CdpRequest) {
    const clientOpenCodeBrowserSessionId = cdpClients.sessionId(socket)
    if (!shutdownControl.accepting && (!cdpClients.isSandbox(socket) || !clientOpenCodeBrowserSessionId || !sessions.hasPendingWork(clientOpenCodeBrowserSessionId))) {
      return yield* Effect.fail(new Error("Relay is draining for an explicit restart"))
    }
    const guardMessage = guardCdpMethod({
      method: message.method,
      readOnly: clientOpenCodeBrowserSessionId ? sessions.isReadOnly(clientOpenCodeBrowserSessionId) : false,
      sessionId: clientOpenCodeBrowserSessionId,
      params: message.params,
      pageUrls: () => cdpRouter.visibleRoots(socket).map((target) => target.targetInfo.url),
    })
    if (guardMessage) {
      return yield* Effect.fail(new Error(guardMessage))
    }
    if (message.method === "Page.navigate" || message.method === "Target.createTarget") {
      const tabSessionId = message.method === "Page.navigate"
        ? (() => {
            try {
              return registry.tabTargets.get(cdpRouter.resolveCommandRoute(socket, message).tabId)?.opencodeBrowserSessionId
            } catch {
              return undefined
            }
          })()
        : undefined
      const refusal = yield* Effect.promise(() => navigationGuard.checkCommand({
        method: message.method,
        params: message.params,
        sessionId: tabSessionId ?? clientOpenCodeBrowserSessionId,
      }))
      if (refusal) return yield* Effect.fail(new Error(refusal))
    }
    if (message.method === "Browser.getVersion") {
      return {
        protocolVersion: "1.3",
        product: "OpenCode-Browser/0.0.0",
        revision: "0",
        userAgent: "OpenCode-Browser",
        jsVersion: "V8",
      }
    }
    if (message.method === "Browser.setDownloadBehavior") {
      return {}
    }
    if (message.method === "Target.setDiscoverTargets") {
      if (message.params?.discover === true) {
        replayTargetCreated({ socket, targetInfos: cdpRouter.visibleTargetInfos(socket) })
      }
      return {}
    }
    if (message.method === "Target.setAutoAttach" && !message.sessionId) {
      cdpClients.setAutoAttachParams(socket, message.params)
      for (const target of cdpRouter.visibleRoots(socket)) {
        yield* Effect.ignore(sendDebuggerCommand({ tabId: target.tabId, method: "Target.setAutoAttach", params: message.params ?? {} }))
        cdpClients.announce(socket, target)
      }
      return {}
    }
    if (message.method === "Target.setAutoAttach" && message.sessionId && registry.targets.has(message.sessionId)) {
      const target = cdpRouter.rootForSession(socket, message.sessionId)
      if (!target) {
        return yield* Effect.fail(new Error(`Target not found: ${message.sessionId}`))
      }
      const result = yield* sendDebuggerCommand({ tabId: target.tabId, method: "Target.setAutoAttach", params: message.params ?? {} })
      replayChildTargetsForParent({ socket, parentSessionId: target.sessionId, registry, clients: cdpClients })
      return result
    }
    if (message.method === "Target.getTargets") {
      return {
        targetInfos: cdpRouter.visibleTargetInfos(socket),
      }
    }
    if (message.method === "Target.attachToBrowserTarget") {
      return { sessionId: cdpClients.createBrowserAlias(socket) }
    }
    if (message.method === "Target.attachToTarget") {
      const targetId = getString(message.params, "targetId") ?? ""
      const target = cdpRouter.targetForAttach(socket, targetId)
      if (target) {
        if (cdpClients.hasSession(socket, target.sessionId)) {
          return { sessionId: cdpClients.createTargetAlias(socket, target) }
        }
        cdpClients.announce(socket, target)
        if ("parentSessionId" in target) replayChildFrameNavigation({ socket, registry, target })
        return { sessionId: target.sessionId }
      }
      return yield* Effect.fail(new Error(`Target not found: ${targetId}`))
    }
    if (message.method === "Target.getTargetInfo") {
      const targetId = getString(message.params, "targetId") ?? ""
      const target = cdpRouter.targetInfo(socket, {
        ...(targetId ? { targetId } : {}),
        ...(message.sessionId ? { sessionId: message.sessionId } : {}),
      })
      if (!target) {
        if (!targetId && !message.sessionId) return {}
        return yield* Effect.fail(new Error(`Target not found: ${targetId || message.sessionId || "unknown"}`))
      }
      return { targetInfo: target.targetInfo }
    }
    if (message.method === "Target.createTarget" || message.method === "Target.closeTarget") {
      if (message.method === "Target.createTarget") {
        const url = getString(message.params, "url") ?? "about:blank"
        const opencodeBrowserSessionId = cdpClients.sessionId(socket)
        const autoAttachParams = cdpClients.autoAttachParams(socket)
        const target = yield* createAndAttachTab({
          url,
          active: false,
          ...(opencodeBrowserSessionId ? { opencodeBrowserSessionId } : {}),
          ...(autoAttachParams ? { autoAttachParams } : {}),
        })
        return { targetId: target.targetInfo.targetId }
      }
      const targetId = getString(message.params, "targetId") ?? ""
      const target = cdpRouter.targetForAttach(socket, targetId)
      if (!target || !("owner" in target)) {
        return { success: false }
      }
      if (target.owner === "user") {
        yield* detachTab(target.tabId)
        relayLog("target.released", { tabId: target.tabId, reason: "Target.closeTarget on a user tab" })
        return { success: true, released: true, message: "This tab belongs to the user, so it was released to them instead of closed." }
      }
      yield* closeTargetByTargetId(targetId)
      return { success: true }
    }
    if (message.method === "Target.detachFromTarget") {
      const childSessionId = getString(message.params, "sessionId")
      if (childSessionId) cdpClients.detach(socket, childSessionId)
      return {}
    }
    const normalizedMessage = removeDefaultLightColorSchemeEmulation(message)
    const route = yield* Effect.try({
      try: () => cdpRouter.resolveCommandRoute(socket, message),
      catch: (error) => error instanceof Error ? error : new Error(String(error)),
    })
    const { tabId } = route
    tabActivity.touch(tabId)
    const executingSession = cdpClients.sessionId(socket)
    if (executingSession && sessions.isExecuting(executingSession)) {
      yield* tabActivity.focus(tabId, executingSession)
    }
    if (message.method === ghostCursorCommandMethod) return yield* ghostCursor.command(tabId, message.params)
    if (message.method === "Page.navigate" && route.chromeSessionId === undefined) {
      const dataNavigation = yield* navigateTopFrameToDataUrl(tabId, message.params)
      if (dataNavigation) return dataNavigation
    }
    const command = {
      tabId,
      method: normalizedMessage.method,
      params: normalizedMessage.method === "Emulation.setFocusEmulationEnabled"
        ? { enabled: tabActivity.isFocused(tabId) }
        : normalizedMessage.params ?? {},
      ...(route.chromeSessionId === undefined ? {} : { sessionId: route.chromeSessionId }),
    }
    const sessionId = message.sessionId
    const announced = sessionId !== undefined && cdpClients.hasSession(socket, sessionId)
    yield* Effect.all([
      applyGhostCursorMouseEvent({ tabId, message }).pipe(Effect.ignore),
      Effect.promise(() =>
        beforeInput(tabId, command.method, command.params, route.chromeSessionId === undefined, (method, params) =>
          Effect.runPromise(sendDebuggerCommand({ ...command, method, params })),
        browsers.browserTab(tabId)?.link.humanInput).catch(() => undefined),
      ),
    ], { concurrency: "unbounded", discard: true })
    const result = yield* (message.method === "Runtime.enable" && sessionId
      ? cdpRuntime.enable(route, command.params, () => clientRoutesSession(socket, sessionId) && (!announced || cdpClients.hasSession(socket, sessionId)), announced ? socket : undefined)
      : command.method === "Page.captureScreenshot" && route.chromeSessionId === undefined
      ? captureScreenshotNudged(command)
      : sendDebuggerCommand(command)).pipe(
        Effect.tapError((error) => Effect.sync(() => {
          if (runtimeFailureKind(error) === "cross-extension-page") setProtectedUi(tabId, true)
        })),
        Effect.tap(() => Effect.sync(() => setProtectedUi(tabId, false))),
      )
    return scopeCdpResult({ method: message.method, result, pageUrls: () => cdpRouter.visibleRoots(socket).map((target) => target.targetInfo.url) })
  })

  return Effect.fnUntraced(function* (socket: WebSocket, raw: string) {
    const message = parseJsonObject(raw)
    if (!isCdpRequest(message)) {
      return yield* Effect.fail(new Error("Invalid CDP request"))
    }
    const frameTreeSent = message.method === "Page.getFrameTree" ? admitFrameTreeResponse(socket, message.sessionId) : undefined
    debugLog?.(`cdp<- ${cdpClients.sessionId(socket) ?? "raw"} #${message.id} ${message.method} ${message.sessionId ?? ""}`)
    yield* Effect.matchEffect(routeCdpCommand(socket, message), {
      onFailure: (error) => {
        return Effect.sync(() => {
          const runtimeEvaluation = isRuntimeEvaluationMethod(message.method)
          const errorDetail = runtimeEvaluation ? runtimeFailureKind(error) : error.message
          debugLog?.(`cdp-> ${cdpClients.sessionId(socket) ?? "raw"} #${message.id} ${message.method} ERROR ${errorDetail}`)
          if (runtimeEvaluation) {
            contextDebugLog?.(`evaluation-failed method=${message.method} failure=${runtimeFailureKind(error)} client=${boundedToken(cdpClients.sessionId(socket) ?? "raw")} ${targetDiagnosticIdentity(registry, diagnosticTargetForClient(socket, message.sessionId))} ${summarizeRuntimeEvaluate(message.params)}`)
          }
          sendCdpResponse(socket, {
            id: message.id,
            error: { message: error.message },
            ...(message.sessionId === undefined ? {} : { sessionId: message.sessionId }),
          })
        })
      },
      onSuccess: (result) => {
        return Effect.sync(() => {
          debugLog?.(`cdp-> ${cdpClients.sessionId(socket) ?? "raw"} #${message.id} ${message.method} ok`)
          const resultObject = getObject(result)
          const exceptionDetails = isRuntimeEvaluationMethod(message.method) ? getObject(resultObject?.exceptionDetails) : undefined
          if (exceptionDetails) {
            contextDebugLog?.(`evaluation-exception method=${message.method} exceptionId=${boundedToken(getIdText(exceptionDetails, "exceptionId"))} line=${getNumber(exceptionDetails, "lineNumber") ?? "none"} column=${getNumber(exceptionDetails, "columnNumber") ?? "none"} client=${boundedToken(cdpClients.sessionId(socket) ?? "raw")} ${targetDiagnosticIdentity(registry, diagnosticTargetForClient(socket, message.sessionId))} ${summarizeRuntimeEvaluate(message.params)}`)
          }
          sendCdpResponse(socket, {
            id: message.id,
            result,
            ...(message.sessionId === undefined ? {} : { sessionId: message.sessionId }),
          })
          frameTreeSent?.(result)
        })
      },
    })
  })
}
