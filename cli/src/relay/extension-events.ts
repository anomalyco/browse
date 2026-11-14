import { Effect } from "effect"
import type { WebSocket } from "ws"
import type { BrowserLink, BrowserLinks } from "./browser-links.ts"
import type { CdpClientPool } from "../cdp/client-pool.ts"
import type { CdpRuntime } from "../cdp/runtime.ts"
import type { ExtensionCommandInput } from "./rpc.ts"
import type { FlightRecorderRelay } from "../recording-relay/flight-recorder.ts"
import type { GhostCursorTabs } from "../ghost-cursor.ts"
import type { HandoffCancellationReason, HandoffRegistry } from "../session-manager/handoff.ts"
import type { ProtectedFrameTracker } from "../cdp/protected-frames.ts"
import { isExtensionEvent, isExtensionResponse, parseJsonObject, type CdpEvent, type JsonObject } from "../protocol.ts"
import type { RecordingRelay } from "../recording-relay.ts"
import { getIdText, getNumber, getObject, getString, getTargetInfo, isRestrictedTarget } from "./helpers.ts"
import { relayLog } from "./log.ts"
import type { ChildTarget, ConnectedTarget } from "./types.ts"
import type { RootTargetLifecycle } from "../cdp/root-target-lifecycle.ts"
import { boundedToken, summarizeDiagnosticUrl } from "../update/runtime-diagnostics.ts"
import type { OpenCodeBrowserSessions } from "../session-manager.ts"
import type { SessionNavigationGuard } from "../session-manager/navigation-guard.ts"
import type { TabActivity } from "../cdp/tab-activity.ts"
import { shouldExposeChildTarget, type TargetRegistry } from "../cdp/target-registry.ts"
import { targetDiagnosticIdentity } from "./process-guard.ts"

export function createExtensionEventHandler(options: {
  readonly registry: TargetRegistry
  readonly browsers: BrowserLinks
  readonly sessions: OpenCodeBrowserSessions
  readonly rootLifecycle: RootTargetLifecycle
  readonly cdpClients: CdpClientPool<WebSocket>
  readonly cdpRuntime: CdpRuntime<WebSocket>
  readonly handoffs: HandoffRegistry
  readonly recordingRelay: RecordingRelay
  readonly flightRecorder: FlightRecorderRelay
  readonly navigationGuard: SessionNavigationGuard
  readonly ghostCursor: GhostCursorTabs
  readonly tabActivity: TabActivity
  readonly protectedFrames: ProtectedFrameTracker
  readonly mainFrameIdsByTab: Map<number, string>
  readonly blankNavigationWaiters: Map<number, (url: string, loaderId: string | undefined) => void>
  readonly suppressedChildSessions: Map<string, number>
  readonly ownersAcrossReconnect: Map<string, { readonly sessionId?: string; readonly owner: "relay" | "user"; readonly browser: string }>
  readonly sweptBrowsers: Set<string>
  readonly sendDebuggerCommand: (command: { readonly tabId: number; readonly sessionId?: string; readonly method: string; readonly params: JsonObject }) => Effect.Effect<JsonObject, Error>
  readonly sendExtensionBestEffort: (command: ExtensionCommandInput, link?: BrowserLink) => void
  readonly applyExtensionSettings: (link: BrowserLink, params: JsonObject | undefined) => void
  /** Sends the settings answer an extension asked for before pairing finished, once the browser is ready. */
  readonly relaySettingsReady: (link: BrowserLink) => void
  readonly hasUpdateNotice: () => boolean
  readonly sendUpdateNotice: () => void
  readonly announceTab: (tabId: number) => void
  readonly browsersChanged: () => void
  readonly refreshPageStatus: (tabId: number) => void
  readonly refreshTabGrouping: (tabId: number) => void
  readonly handleToolbarClick: (tabId: number) => void
  readonly handleDebuggingBarCancel: (tabId: number) => void
  readonly cancelTargetHandoffs: (target: ConnectedTarget, reason: HandoffCancellationReason) => void
  readonly detachTargetState: (tabId: number, detachOptions?: { readonly preserveSessionTarget?: boolean; readonly updateExtension?: boolean; readonly releasedByUser?: boolean }) => void
  readonly detachChildTargetState: (sessionId: string) => void
  readonly sendEventToTargetViewers: (rootSessionId: string, event: CdpEvent) => void
  readonly announceAttachedChildTarget: (rootSessionId: string, target: ChildTarget) => void
  readonly setProtectedUi: (tabId: number, protectedUi: boolean) => void
  readonly debugLog: ((line: string) => void) | undefined
  readonly contextDebugLog: ((line: string) => void) | undefined
}) {
  const {
    registry,
    browsers,
    sessions,
    rootLifecycle,
    cdpClients,
    cdpRuntime,
    handoffs,
    recordingRelay,
    flightRecorder,
    navigationGuard,
    ghostCursor,
    tabActivity,
    protectedFrames,
    mainFrameIdsByTab,
    blankNavigationWaiters,
    suppressedChildSessions,
    ownersAcrossReconnect,
    sweptBrowsers,
    sendDebuggerCommand,
    sendExtensionBestEffort,
    applyExtensionSettings,
    relaySettingsReady,
    hasUpdateNotice,
    sendUpdateNotice,
    announceTab,
    browsersChanged,
    refreshPageStatus,
    refreshTabGrouping,
    handleToolbarClick,
    handleDebuggingBarCancel,
    cancelTargetHandoffs,
    detachTargetState,
    detachChildTargetState,
    sendEventToTargetViewers,
    announceAttachedChildTarget,
    setProtectedUi,
    debugLog,
    contextDebugLog,
  } = options

  /** Opener tab -> in-flight detaches of its popups' auto-attached sessions, which a root attach must wait for. */
  const openedPageReleases = new Map<number, Set<Promise<void>>>()

  /** An event from a browser with its tab ids (the tab, and a popup's opener) made the relay's. */
  const relayTabIds = <T extends { readonly params?: JsonObject | undefined }>(link: BrowserLink, message: T): T => {
    const tabId = getNumber(message.params, "tabId")
    const openerTabId = getNumber(message.params, "openerTabId")
    if (tabId === undefined && openerTabId === undefined) return message
    return {
      ...message,
      params: {
        ...message.params,
        ...(tabId === undefined ? {} : { tabId: browsers.relayTabId(link, tabId) }),
        ...(openerTabId === undefined ? {} : { openerTabId: browsers.relayTabId(link, openerTabId) }),
      },
    }
  }

  /** Hide a protected frame from clients that already saw it attach. */
  function retractProtectedFrame(target: ConnectedTarget, frameId: string, url: string | undefined): void {
    contextDebugLog?.(`protected-frame frame=${boundedToken(frameId)} ${targetDiagnosticIdentity(registry, target)} ${summarizeDiagnosticUrl(url)}`)
    sendEventToTargetViewers(target.sessionId, { method: "Page.frameDetached", params: { frameId, reason: "remove" }, sessionId: target.sessionId })
  }

  function forgetProtectedFrames(tabId: number): void {
    protectedFrames.forgetTab(tabId)
    setProtectedUi(tabId, false)
  }

  function targetForCdpSession(tabId: number, sessionId: string | undefined): ConnectedTarget | ChildTarget | undefined {
    if (sessionId) {
      return registry.targets.get(sessionId) ?? registry.childTargets.get(sessionId) ?? registry.tabTargets.get(tabId)
    }
    return registry.tabTargets.get(tabId)
  }

  function resumeIfWaitingForDebugger(tabId: number, childSessionId: string, params: JsonObject | undefined, label: string): void {
    if (params?.waitingForDebugger !== true) return
    Effect.runPromise(
      sendDebuggerCommand({
        tabId,
        sessionId: childSessionId,
        method: "Runtime.runIfWaitingForDebugger",
        params: {},
      }).pipe(Effect.ignore),
    ).catch((error: unknown) => {
      console.error(label, error)
    })
  }

  function releaseOpenedPageSession(tabId: number, parentSessionId: string | undefined, childSessionId: string, params: JsonObject | undefined): void {
    resumeIfWaitingForDebugger(tabId, childSessionId, params, "Failed to resume opened page")
    const release = Effect.runPromise(sendDebuggerCommand({
      tabId,
      ...(parentSessionId === undefined ? {} : { sessionId: parentSessionId }),
      method: "Target.detachFromTarget",
      params: { sessionId: childSessionId },
    }).pipe(Effect.ignore)).catch(() => {})
    const releases = openedPageReleases.get(tabId) ?? new Set()
    releases.add(release)
    openedPageReleases.set(tabId, releases)
    void release.finally(() => {
      releases.delete(release)
      if (releases.size === 0 && openedPageReleases.get(tabId) === releases) openedPageReleases.delete(tabId)
    })
  }

  function adoptOpenedTab(tabId: number, openerTabId: number): void {
    const opener = registry.tabTargets.get(openerTabId)
    const sessionId = opener?.opencodeBrowserSessionId
    if (!opener || !sessionId || registry.routingRootTarget(tabId)) return
    if (opener.owner === "user" && !sessions.isExecuting(sessionId)) return
    const autoAttachParams = Array.from(cdpClients)
      .filter((client) => cdpClients.sessionId(client) === sessionId)
      .map((client) => cdpClients.autoAttachParams(client))
      .find((params) => params !== undefined)
    relayLog("tab.opened", { tabId, openerTabId, session: sessionId })
    announceTab(tabId)
    const attach = () => Effect.runPromise(rootLifecycle.attach({
      tabId,
      owner: "relay",
      opencodeBrowserSessionId: sessionId,
      openerTargetId: opener.targetInfo.targetId,
      ...(autoAttachParams ? { autoAttachParams } : {}),
    }))
    const attachWithRetry = async () => {
      await Promise.allSettled(Array.from(openedPageReleases.get(openerTabId) ?? []))
      for (const delayMs of [100, 250, 500, 1_000]) {
        try {
          return await attach()
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          if (!/already attached|another debugger/i.test(message) || registry.routingRootTarget(tabId) || !registry.tabTargets.has(openerTabId)) throw error
          relayLog("tab.opened.retry", { tabId, delayMs, error: message })
          await new Promise((resolve) => setTimeout(resolve, delayMs))
        }
      }
      return await attach()
    }
    attachWithRetry().then(() => {
      const popup = registry.tabTargets.get(tabId)
      if (popup) navigationGuard.popupAttached(popup)
    }).catch((error: unknown) => {
      relayLog("tab.opened.error", { tabId, error: error instanceof Error ? error.message : String(error) })
    })
  }

  return function handleExtensionMessage(link: BrowserLink, raw: string): void {
    const parsed = parseJsonObject(raw)
    if (isExtensionResponse(parsed)) {
      link.rpc.handleResponse(parsed)
      return
    }
    if (!isExtensionEvent(parsed)) {
      return
    }
    link.rpc.noteResponse()
    const message = relayTabIds(link, parsed)
    const { socket, generation, announcedRootTabIds, announcedAgentTabIds } = link
    const mine = (tabId: number) => browsers.ownerKey(tabId) === link.key
    const extensionMethod = message.method as string
    const eventTabId = getNumber(message.params, "tabId")
    if (extensionMethod === "hello") return
    if (extensionMethod === "settings") {
      applyExtensionSettings(link, message.params)
      return
    }
    if (extensionMethod === "log") {
      const text = getString(message.params, "message")
      if (!text) return
      const level = message.params?.level === "error" || message.params?.level === "warn" ? message.params.level : "log"
      console[level](`[browse extension] ${text}`)
      return
    }
    if (extensionMethod === "ready") {
      void Effect.runPromise(rootLifecycle.settle(generation)).then((settled) => {
        if (browsers.ofSocket(socket) !== link) return
        const failed = settled ? [] : rootLifecycle.failedTabIds(generation)
        if (failed.length > 0) {
          relayLog("extension.inventory.dropped", { tabIds: failed.join(","), generation })
          for (const tabId of failed) {
            detachTargetState(tabId)
            sendExtensionBestEffort({ method: "debugger.detach", params: { tabId } })
          }
        }
        if (settled || failed.length > 0) {
          for (const target of registry.listRootTargets()) {
            if (mine(target.tabId) && !announcedRootTabIds.has(target.tabId)) detachTargetState(target.tabId)
          }
          for (const [targetId, known] of ownersAcrossReconnect) {
            if (known.browser !== link.key) continue
            if (known.owner !== "relay" || known.sessionId === undefined || sessions.sessions.has(known.sessionId)) continue
            const target = registry.targetsByTargetId.get(targetId)
            if (!target || target.opencodeBrowserSessionId !== undefined) continue
            relayLog("extension.inventory.orphan", { tabId: target.tabId, session: known.sessionId })
            sendExtensionBestEffort({ method: "tabs.remove", params: { tabId: target.tabId } })
            detachTargetState(target.tabId, { updateExtension: false })
          }
          for (const target of registry.listRootTargets()) {
            if (!announcedAgentTabIds.has(target.tabId) || target.owner !== "user" || target.opencodeBrowserSessionId !== undefined) continue
            if (ownersAcrossReconnect.get(target.targetInfo.targetId)?.owner === "user") continue
            relayLog("extension.inventory.orphan", { tabId: target.tabId, reason: "agent tab without a session" })
            sendExtensionBestEffort({ method: "tabs.remove", params: { tabId: target.tabId } })
            detachTargetState(target.tabId, { updateExtension: false })
          }
          announcedAgentTabIds.clear()
          for (const [targetId, known] of ownersAcrossReconnect) if (known.browser === link.key) ownersAcrossReconnect.delete(targetId)
          link.rpc.markReady()
          // An extension sends its own settings right after pairing, before the relay marks this browser ready, so
          // that answer was dropped. Deliver it now that it can arrive, once.
          relaySettingsReady(link)
          if (hasUpdateNotice()) sendUpdateNotice()
          for (const target of registry.listRootTargets()) if (mine(target.tabId)) refreshTabGrouping(target.tabId)
          browsersChanged()
          if (!sweptBrowsers.has(link.key)) {
            sweptBrowsers.add(link.key)
            void Effect.runPromise(sessions.sweepOrphanedRelayTargets())
          }
        } else {
          socket.close(1011, "Target inventory reconciliation failed")
        }
      })
      return
    }
    if (extensionMethod === "debugger.attached") {
      if (eventTabId) {
        announcedRootTabIds.add(eventTabId)
        if (message.params?.agent === true) announcedAgentTabIds.add(eventTabId)
        rootLifecycle.queue({ tabId: eventTabId, attachIfMissing: true, verificationRetries: 0, errorMessage: "Debugger re-announce failed", generation })
      }
      return
    }
    if (extensionMethod === "toolbar.clicked") {
      if (eventTabId) {
        announcedRootTabIds.add(eventTabId)
        handleToolbarClick(eventTabId)
      }
      return
    }
    if (extensionMethod === "handoff.completed") {
      const handoffId = getString(message.params, "handoffId")
      const target = eventTabId ? registry.tabTargets.get(eventTabId) : undefined
      if (target && handoffId) {
        const completed = handoffs.complete({
          id: handoffId,
          tabId: target.tabId,
          targetId: target.targetInfo.targetId,
          targetSessionId: target.sessionId,
        })
        if (completed) refreshPageStatus(target.tabId)
      }
      return
    }
    if (extensionMethod === "pageStatus.requested") {
      if (eventTabId) refreshPageStatus(eventTabId)
      return
    }
    if (extensionMethod === "debugger.detached") {
      const detachedSessionId = getString(message.params, "sessionId")
      const reason = getString(message.params, "reason")
      if (detachedSessionId) {
        suppressedChildSessions.delete(detachedSessionId)
        detachChildTargetState(detachedSessionId)
        return
      }
      if (reason === "target_closed") {
        if (eventTabId) {
          const renewed = message.params?.reattached === true
          if (renewed) relayLog("debugger.renewed", { tabId: eventTabId })
          rootLifecycle.queue({
            tabId: eventTabId,
            attachIfMissing: false,
            verificationRetries: renewed ? 0 : 3,
            errorMessage: "Failed to reconcile ambiguous debugger detach",
            renewed,
          })
        }
        return
      }
      // The browser's debugging bar button (Cancel in Chrome, OK in some browsers) detaches every tab, not just this
      // one. Unlike target_closed, none is re-attached: a tab the user lent is theirs again, an agent's stays open.
      if (reason === "canceled_by_user") {
        if (eventTabId) {
          handleDebuggingBarCancel(eventTabId)
          detachTargetState(eventTabId, { releasedByUser: true })
        }
        return
      }
      if (eventTabId) detachTargetState(eventTabId)
      return
    }
    if (extensionMethod === "tabs.opened") {
      const openerTabId = getNumber(message.params, "openerTabId")
      if (eventTabId && openerTabId) adoptOpenedTab(eventTabId, openerTabId)
      return
    }
    if (extensionMethod === "tabs.removed") {
      if (eventTabId) detachTargetState(eventTabId)
      return
    }
    if (extensionMethod === "recording.cancelled") {
      recordingRelay.handleRecordingCancelled(message)
      return
    }
    if (extensionMethod !== "debugger.event" || !eventTabId) {
      return
    }

    const tabId = eventTabId
    const target = registry.routingRootTarget(tabId)
    if (!target) return
    const method = getString(message.params, "method") ?? ""
    const params = getObject(message.params?.params)
    const sourceSessionId = getString(message.params, "sessionId")
    debugLog?.(`evt tab=${tabId} ${method} src=${sourceSessionId ?? "root"}`)
    const sourceChild = sourceSessionId ? registry.childTargets.get(sourceSessionId) : undefined
    if (sourceSessionId && sourceSessionId !== target.sessionId && !sourceChild) return
    if (
      sourceSessionId &&
      method !== "Target.attachedToTarget" &&
      method !== "Target.detachedFromTarget" &&
      method !== "Target.targetInfoChanged" &&
      (suppressedChildSessions.has(sourceSessionId) || (sourceChild && !shouldExposeChildTarget(sourceChild)))
    ) {
      return
    }
    if (flightRecorder.handleDebuggerEvent({ tabId, method, params }) || recordingRelay.handleDebuggerEvent({ tabId, method, params })) return
    if (sourceSessionId === undefined || sourceSessionId === target.sessionId) navigationGuard.observeEvent(target, method, params)
    let shouldBroadcast = true
    let attachedChildTarget: ChildTarget | undefined

    if ((method === "Inspector.targetCrashed" || method === "Target.targetCrashed") && (sourceSessionId === undefined || sourceSessionId === target.sessionId)) {
      const crashedTarget = registry.markRootTargetCrashed(tabId)
      if (crashedTarget) {
        cancelTargetHandoffs(crashedTarget, "target-crashed")
        const affectedSessions = sessions.markTargetCrashed(crashedTarget.targetInfo.targetId)
        const owner = browsers.browserTab(tabId)
        owner?.link.rpc.rejectDebuggerCommandsForTab(owner.tabId, new Error(`Target crashed: ${crashedTarget.targetInfo.targetId}`))
        contextDebugLog?.(`target-crashed ${targetDiagnosticIdentity(registry, crashedTarget)} affectedSessions=${affectedSessions.length}`)
      }
    }
    if (method === "Target.attachedToTarget") {
      const childSessionId = getString(params, "sessionId")
      const targetInfo = getTargetInfo(params?.targetInfo)
      if (childSessionId && !targetInfo) {
        resumeIfWaitingForDebugger(tabId, childSessionId, params, "Failed to resume unsupported target")
        return
      }
      if (childSessionId && targetInfo) {
        if (isRestrictedTarget(targetInfo)) {
          suppressedChildSessions.set(childSessionId, tabId)
          if (targetInfo.type === "iframe" && protectedFrames.mark(tabId, targetInfo.targetId)) {
            retractProtectedFrame(target, targetInfo.targetId, targetInfo.url)
          }
          resumeIfWaitingForDebugger(tabId, childSessionId, params, "Failed to resume restricted target")
          return
        }
        if (targetInfo.type === "page") {
          suppressedChildSessions.set(childSessionId, tabId)
          releaseOpenedPageSession(tabId, sourceSessionId, childSessionId, params)
          return
        }
        suppressedChildSessions.delete(childSessionId)
        shouldBroadcast = false
        const parentSessionId = sourceSessionId ?? target.sessionId
        const childTarget: ChildTarget = {
          tabId,
          sessionId: childSessionId,
          parentSessionId,
          targetInfo,
          waitingForDebugger: params?.waitingForDebugger === true,
        }
        for (const previous of registry.addChildTarget(childTarget)) {
          cdpClients.detachTarget(previous)
        }
        contextDebugLog?.(`target-attached kind=child parentSession=${boundedToken(parentSessionId)} ${targetDiagnosticIdentity(registry, childTarget)} ${summarizeDiagnosticUrl(targetInfo.url)}`)
        if (shouldExposeChildTarget(childTarget)) {
          attachedChildTarget = childTarget
        }
      }
    }
    if (method === "Target.detachedFromTarget") {
      const childSessionId = getString(params, "sessionId")
      if (childSessionId) {
        shouldBroadcast = false
        suppressedChildSessions.delete(childSessionId)
        contextDebugLog?.(`target-detached kind=child ${targetDiagnosticIdentity(registry, registry.childTargets.get(childSessionId))}`)
        detachChildTargetState(childSessionId)
      }
    }
    if (method === "Target.targetInfoChanged") {
      const targetInfo = getTargetInfo(params?.targetInfo)
      if (!targetInfo) return
      const childTarget = registry.childTargetsByTargetId.get(targetInfo.targetId)
      const wasExposed = childTarget ? shouldExposeChildTarget(childTarget) : false
      if (isRestrictedTarget(targetInfo)) {
        if (childTarget) {
          suppressedChildSessions.set(childTarget.sessionId, tabId)
          detachChildTargetState(childTarget.sessionId)
          if (targetInfo.type === "iframe" && protectedFrames.mark(tabId, targetInfo.targetId)) {
            retractProtectedFrame(target, targetInfo.targetId, targetInfo.url)
          }
        }
        return
      }
      const changed = registry.updateConnectedTargetInfo({ tabId, targetInfo })
      if (!changed) {
        const currentRoot = registry.routingRootTarget(tabId)
        if (targetInfo.type === "page" && currentRoot && currentRoot.targetInfo.targetId !== targetInfo.targetId) {
          rootLifecycle.queue({ tabId, attachIfMissing: false, verificationRetries: 1, errorMessage: "Failed to reconcile changed root target info" })
        }
        return
      }
      contextDebugLog?.(`target-info-changed ${targetDiagnosticIdentity(registry, changed.target)} ${summarizeDiagnosticUrl(targetInfo.url)}`)
      if (changed.kind === "child" && !wasExposed && shouldExposeChildTarget(changed.target)) {
        announceAttachedChildTarget(target.sessionId, changed.target)
      }
    } else if (method.startsWith("Target.") && params?.targetInfo !== undefined) {
      const eventTargetInfo = getTargetInfo(params.targetInfo)
      if (!eventTargetInfo || isRestrictedTarget(eventTargetInfo)) return
    }
    if (sourceSessionId === undefined || sourceSessionId === target.sessionId) {
      const decision = protectedFrames.observe({
        tabId,
        method,
        params,
        mainFrameId: mainFrameIdsByTab.get(tabId),
        isChildFrame: (frameId) => getString(registry.tabFrameEvents.get(tabId)?.get(frameId)?.attached, "parentFrameId") !== undefined,
      })
      if (decision.kind === "retract") {
        const frame = getObject(params?.frame)
        retractProtectedFrame(target, decision.frameId, getString(params, "url") ?? getString(frame, "url"))
        return
      }
      if (decision.kind === "suppress") {
        if (method === "Page.frameDetached" && !protectedFrames.hasAny(tabId)) setProtectedUi(tabId, false)
        return
      }
      if (decision.kind === "restore") {
        sendEventToTargetViewers(target.sessionId, { method: "Page.frameAttached", params: { frameId: decision.frameId, parentFrameId: decision.parentFrameId }, sessionId: target.sessionId })
      }
    }
    if (method === "Page.frameNavigated") {
      const frame = getObject(params?.frame)
      const frameId = getString(frame, "id")
      const frameUrl = getString(frame, "url")
      const frameParentId = getString(frame, "parentId")
      if (frameUrl !== undefined && frameParentId === undefined && (sourceSessionId === undefined || sourceSessionId === target.sessionId)) {
        if (frameId !== undefined) mainFrameIdsByTab.set(tabId, frameId)
        forgetProtectedFrames(tabId)
        Effect.runPromise(Effect.ignore(ghostCursor.documentCreated(tabId))).catch(() => {})
        contextDebugLog?.(`main-frame-navigated frame=${boundedToken(frameId)} loader=${boundedToken(getString(frame, "loaderId"))} ${targetDiagnosticIdentity(registry, target)} ${summarizeDiagnosticUrl(frameUrl)}`)
        registry.updateTargetUrl(tabId, frameUrl)
        blankNavigationWaiters.get(tabId)?.(frameUrl, getString(frame, "loaderId"))
        Effect.runPromise(Effect.ignore(sendDebuggerCommand({ tabId, method: "Emulation.setFocusEmulationEnabled", params: { enabled: tabActivity.isFocused(tabId) } }))).catch(() => {})
      }
      if (frameId !== undefined && frameParentId !== undefined && params) {
        registry.rememberFrameEvent({ tabId, frameId, navigated: params })
      }
    }
    if (method === "Page.navigatedWithinDocument") {
      const frameId = getString(params, "frameId")
      const url = getString(params, "url")
      if (
        url !== undefined
        && (sourceSessionId === undefined || sourceSessionId === target.sessionId)
        && (frameId === mainFrameIdsByTab.get(tabId) || frameId === target.targetInfo.targetId || !mainFrameIdsByTab.has(tabId))
      ) {
        if (frameId !== undefined) mainFrameIdsByTab.set(tabId, frameId)
        contextDebugLog?.(`main-frame-same-document frame=${boundedToken(frameId)} ${targetDiagnosticIdentity(registry, target)} ${summarizeDiagnosticUrl(url)}`)
        registry.updateTargetUrl(tabId, url)
      }
    }
    if (method === "Page.lifecycleEvent") {
      const frameId = getString(params, "frameId")
      if (frameId && frameId === mainFrameIdsByTab.get(tabId)) {
        contextDebugLog?.(`main-frame-lifecycle name=${boundedToken(getString(params, "name"))} frame=${boundedToken(frameId)} loader=${boundedToken(getString(params, "loaderId"))} ${targetDiagnosticIdentity(registry, target)}`)
      }
    }
    if (method === "Page.frameAttached") {
      const frameId = getString(params, "frameId")
      if (frameId && params) registry.rememberFrameEvent({ tabId, frameId, attached: params })
    }
    if (method === "Page.frameDetached") {
      const frameId = getString(params, "frameId")
      if (frameId) registry.tabFrameEvents.get(tabId)?.delete(frameId)
    }

    const eventSessionId = sourceSessionId ?? target.sessionId
    const event: CdpEvent = { method, ...(params === undefined ? {} : { params }), sessionId: eventSessionId }
    if (method === "Runtime.executionContextCreated") {
      const context = getObject(params?.context)
      const auxData = getObject(context?.auxData)
      const contextTarget = targetForCdpSession(tabId, eventSessionId)
      contextDebugLog?.(`context-created id=${boundedToken(getIdText(context, "id"))} unique=${boundedToken(getString(context, "uniqueId"))} default=${auxData?.isDefault === true} type=${boundedToken(getString(auxData, "type"))} frame=${boundedToken(getString(auxData, "frameId"))} ${targetDiagnosticIdentity(registry, contextTarget)} ${summarizeDiagnosticUrl(getString(context, "origin"))}`)
    } else if (method === "Runtime.executionContextDestroyed") {
      const contextTarget = targetForCdpSession(tabId, eventSessionId)
      contextDebugLog?.(`context-destroyed id=${boundedToken(getIdText(params, "executionContextId"))} unique=${boundedToken(getString(params, "executionContextUniqueId"))} ${targetDiagnosticIdentity(registry, contextTarget)}`)
    } else if (method === "Runtime.executionContextsCleared") {
      contextDebugLog?.(`contexts-cleared ${targetDiagnosticIdentity(registry, targetForCdpSession(tabId, eventSessionId))}`)
    }
    cdpRuntime.notify(event)
    if (attachedChildTarget) {
      announceAttachedChildTarget(target.sessionId, attachedChildTarget)
      return
    }
    if (shouldBroadcast) {
      sendEventToTargetViewers(target.sessionId, event)
      const frame = method === "Page.frameNavigated" && params?.type === "BackForwardCacheRestore" ? getObject(params.frame) : undefined
      const frameId = getString(frame, "id")
      if (frameId !== undefined) {
        const timestamp = performance.now() / 1000
        for (const name of ["DOMContentLoaded", "load"])
          sendEventToTargetViewers(target.sessionId, { method: "Page.lifecycleEvent", params: { frameId, loaderId: getString(frame, "loaderId") ?? "", name, timestamp }, sessionId: eventSessionId })
      }
    }
  }
}
