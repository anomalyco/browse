import { Effect } from "effect"
import type { BrowserLink, BrowserLinks } from "./browser-links.ts"
import { debuggingBarDismissedStop, type HandoffPageTarget } from "../execute.ts"
import type { ExtensionCommandInput } from "./rpc.ts"
import {
  awaitHandoffAction,
  resolveExactHandoffTarget,
  toolbarClickAction,
  type HandoffCancellationReason,
  type HandoffOutcome,
  type HandoffRegistry,
} from "../session-manager/handoff.ts"
import { makePageStatus, type JsonObject, type PageStatus } from "../protocol.ts"
import { relayLog } from "./log.ts"
import type { ConnectedTarget } from "./types.ts"
import { summarizeDiagnosticUrl } from "../update/runtime-diagnostics.ts"
import type { OpenCodeBrowserSessions } from "../session-manager.ts"
import type { TabActivity } from "../cdp/tab-activity.ts"
import type { TargetRegistry } from "../cdp/target-registry.ts"
import { targetDiagnosticIdentity } from "./process-guard.ts"

export type TabGroupingMethod = "tabs.group" | "tabs.ungroup"

export const attachedBadge = { text: "ON", color: "#7c3aed", title: "Detach from browse" }
export const executingBadge = { text: "RUN", color: "#f59e0b", title: "browse is running a script. Click to stop it and take this tab back." }
export const waitingBadge = (message: string) => ({ text: "WAIT", color: "#2563eb", title: `browse is waiting for you: ${message} Click here when you're done.` })

export function createTabPresentation(options: {
  readonly registry: TargetRegistry
  readonly browsers: BrowserLinks
  readonly handoffs: HandoffRegistry
  readonly tabActivity: TabActivity
  readonly mainFrameIdsByTab: Map<number, string>
  readonly sendToExtension: (command: ExtensionCommandInput, link?: BrowserLink) => Effect.Effect<JsonObject, Error>
  readonly sendExtensionBestEffort: (command: ExtensionCommandInput, link?: BrowserLink) => void
  readonly isTabRecorded: (tabId: number) => boolean
  readonly getSessions: () => OpenCodeBrowserSessions
  readonly canSessionSeeTarget: (sessionId: string, target: ConnectedTarget) => boolean
  readonly toggleTab: (tabId: number) => Effect.Effect<void, Error>
  readonly pruneInvisibleAnnouncementsForSession: (sessionId: string) => void
  readonly contextDebugLog: ((line: string) => void) | undefined
}) {
  const {
    registry,
    browsers,
    handoffs,
    tabActivity,
    mainFrameIdsByTab,
    sendToExtension,
    sendExtensionBestEffort,
    isTabRecorded,
    getSessions,
    canSessionSeeTarget,
    toggleTab,
    pruneInvisibleAnnouncementsForSession,
    contextDebugLog,
  } = options

  const pendingTabGrouping = new Map<number, TabGroupingMethod>()
  const tabGroupingWorkers = new Map<number, Promise<void>>()
  const activeHandoffTabs = new Map<string, Set<number>>()

  const executionBadge = (sessionId: string, executing: boolean) =>
    executing && !getSessions().isReadOnly(sessionId) ? executingBadge : attachedBadge

  function pageStatusSessionId(target: ConnectedTarget): string | undefined {
    return target.opencodeBrowserSessionId
  }

  function activeHandoffSessionIdForTab(tabId: number): string | undefined {
    return Array.from(activeHandoffTabs.entries()).find(([, tabIds]) => tabIds.has(tabId))?.[0]
  }

  function sendPageStatusEffect(
    target: ConnectedTarget,
    state: PageStatus["state"],
    statusOptions: { readonly sessionId?: string; readonly message?: string; readonly handoffId?: string } = {},
  ): Effect.Effect<void, Error> {
    const sessionId = statusOptions.sessionId ?? pageStatusSessionId(target)
    const status = makePageStatus({
      state,
      targetOwner: target.owner,
      ...(sessionId ? { sessionId, readOnly: getSessions().isReadOnly(sessionId) } : {}),
      ...(statusOptions.message ? { message: statusOptions.message } : {}),
      ...(statusOptions.handoffId ? { handoffId: statusOptions.handoffId } : {}),
      recording: isTabRecorded(target.tabId),
    })
    return sendToExtension({
      method: "pageStatus.set",
      params: { tabId: target.tabId, status },
    }).pipe(Effect.asVoid)
  }

  function sendPageStatus(
    target: ConnectedTarget,
    state: PageStatus["state"],
    statusOptions: { readonly sessionId?: string; readonly message?: string; readonly handoffId?: string } = {},
  ): void {
    Effect.runPromise(Effect.ignore(sendPageStatusEffect(target, state, statusOptions))).catch(() => {})
  }

  function refreshPageStatus(tabId: number): void {
    const target = registry.tabTargets.get(tabId)
    if (!target) {
      sendExtensionBestEffort({ method: "pageStatus.clear", params: { tabId } })
      return
    }
    const pending = handoffs.pendingForTab(tabId)
    if (pending) {
      sendPageStatus(target, "waiting", { sessionId: pending.sessionId, message: pending.message, handoffId: pending.id })
      return
    }
    const sessionId = pageStatusSessionId(target) ?? activeHandoffSessionIdForTab(tabId)
    sendPageStatus(target, sessionId && getSessions().isExecuting(sessionId) ? "running" : "attached", sessionId ? { sessionId } : {})
  }

  function scheduleTabGrouping(tabId: number, method: TabGroupingMethod): void {
    pendingTabGrouping.set(tabId, method)
    if (tabGroupingWorkers.has(tabId)) return
    const worker = (async () => {
      while (true) {
        const next = pendingTabGrouping.get(tabId)
        if (!next) return
        pendingTabGrouping.delete(tabId)
        const target = registry.tabTargets.get(tabId)
        const sessionId = target ? pageStatusSessionId(target) : undefined
        const params: JsonObject = next === "tabs.group" && sessionId
          ? { tabId, sessionId }
          : { tabId }
        await Effect.runPromise(Effect.ignore(sendToExtension({ method: next, params })))
      }
    })().finally(() => {
      if (tabGroupingWorkers.get(tabId) !== worker) return
      tabGroupingWorkers.delete(tabId)
      const next = pendingTabGrouping.get(tabId)
      if (next) scheduleTabGrouping(tabId, next)
    })
    tabGroupingWorkers.set(tabId, worker)
  }

  function refreshTabGrouping(tabId: number): void {
    const target = registry.tabTargets.get(tabId)
    scheduleTabGrouping(tabId, target && pageStatusSessionId(target) ? "tabs.group" : "tabs.ungroup")
  }

  function refreshTabPresentation(tabId: number): void {
    refreshPageStatus(tabId)
    refreshTabGrouping(tabId)
  }

  function clearPendingTabGrouping(tabId: number): void {
    pendingTabGrouping.delete(tabId)
  }

  function setActivityForSessionTabs(
    opencodeBrowserSessionId: string,
    state: PageStatus["state"],
    badge: { readonly text: string; readonly color: string; readonly title: string },
  ): void {
    for (const target of registry.listRootTargets()) {
      if (pageStatusSessionId(target) !== opencodeBrowserSessionId) continue
      sendExtensionBestEffort({ method: "action.setBadge", params: { tabId: target.tabId, ...badge } })
      sendPageStatus(target, state)
    }
  }

  function setActivityForTarget(
    target: ConnectedTarget,
    state: PageStatus["state"],
    badge: { readonly text: string; readonly color: string; readonly title: string },
    statusOptions: { readonly sessionId?: string; readonly message?: string; readonly handoffId?: string } = {},
  ): void {
    sendExtensionBestEffort({ method: "action.setBadge", params: { tabId: target.tabId, ...badge } })
    sendPageStatus(target, state, statusOptions)
  }

  async function setActivityForTargetAcknowledged(
    target: ConnectedTarget,
    state: PageStatus["state"],
    badge: { readonly text: string; readonly color: string; readonly title: string },
    statusOptions: { readonly sessionId?: string; readonly message?: string; readonly handoffId?: string } = {},
  ): Promise<void> {
    sendExtensionBestEffort({ method: "action.setBadge", params: { tabId: target.tabId, ...badge } })
    await Effect.runPromise(sendPageStatusEffect(target, state, statusOptions))
  }

  function removeActiveHandoffTab(sessionId: string, tabId: number): void {
    const tabIds = activeHandoffTabs.get(sessionId)
    if (!tabIds) return
    tabIds.delete(tabId)
    if (tabIds.size === 0) activeHandoffTabs.delete(sessionId)
  }

  function cancelTargetHandoffs(target: ConnectedTarget, reason: HandoffCancellationReason): void {
    const cancelled = handoffs.cancelForTarget({
      targetId: target.targetInfo.targetId,
      targetSessionId: target.sessionId,
      reason,
    })
    for (const pending of cancelled) {
      removeActiveHandoffTab(pending.sessionId, pending.tabId)
    }
  }

  async function requestHandoff(handoffOptions: {
    readonly sessionId: string
    readonly message: string
    readonly timeoutMs: number
    readonly target: HandoffPageTarget
    readonly start?: () => unknown | Promise<unknown>
    readonly cancelStart?: () => Promise<void>
  }): Promise<HandoffOutcome> {
    const sessions = getSessions()
    const target = resolveExactHandoffTarget({
      targetId: handoffOptions.target.targetId,
      targets: registry.listRootTargets(),
      isVisible: (candidate) => canSessionSeeTarget(handoffOptions.sessionId, candidate),
    })
    const sessionTabs = activeHandoffTabs.get(handoffOptions.sessionId) ?? new Set<number>()
    sessionTabs.add(target.tabId)
    activeHandoffTabs.set(handoffOptions.sessionId, sessionTabs)
    const wait = handoffs.wait({
      sessionId: handoffOptions.sessionId,
      tabId: target.tabId,
      targetId: target.targetInfo.targetId,
      targetSessionId: target.sessionId,
      message: handoffOptions.message,
      timeoutMs: handoffOptions.timeoutMs,
    })
    const resumeTimeout = sessions.pauseExecutionTimeout(handoffOptions.sessionId)
    let outcome: HandoffOutcome | undefined
    try {
      outcome = await awaitHandoffAction({
        wait,
        present: () => setActivityForTargetAcknowledged(target, "waiting", waitingBadge(handoffOptions.message), {
          sessionId: handoffOptions.sessionId,
          message: handoffOptions.message,
          handoffId: wait.id,
        }),
        ...(handoffOptions.start ? { start: handoffOptions.start } : {}),
        ...(handoffOptions.cancelStart ? { cancelStart: handoffOptions.cancelStart } : {}),
      })
      return outcome
    } catch (error) {
      wait.cancel()
      removeActiveHandoffTab(handoffOptions.sessionId, target.tabId)
      throw error
    } finally {
      resumeTimeout()
      if (outcome !== undefined && outcome !== "resolved" && outcome !== "timeout") {
        removeActiveHandoffTab(handoffOptions.sessionId, target.tabId)
      }
      const currentTarget = registry.tabTargets.get(target.tabId)
      if (currentTarget) {
        if (outcome !== undefined && outcome !== "resolved" && outcome !== "timeout") {
          refreshPageStatus(currentTarget.tabId)
        } else {
          const executing = sessions.isExecuting(handoffOptions.sessionId)
          setActivityForTarget(currentTarget, executing ? "running" : "attached", executionBadge(handoffOptions.sessionId, executing), { sessionId: handoffOptions.sessionId })
        }
      }
    }
  }

  function onSessionExecuteStateChange(sessionId: string, executing: boolean): Effect.Effect<void> {
    setActivityForSessionTabs(sessionId, executing ? "running" : "attached", executionBadge(sessionId, executing))
    if (!executing) {
      for (const tabId of activeHandoffTabs.get(sessionId) ?? []) {
        const target = registry.tabTargets.get(tabId)
        if (target) {
          setActivityForTarget(target, "attached", attachedBadge, { sessionId })
        }
      }
      activeHandoffTabs.delete(sessionId)
    }
    return executing ? Effect.void : tabActivity.finish(sessionId)
  }

  function handleToolbarClick(tabId: number): void {
    const sessions = getSessions()
    const target = registry.tabTargets.get(tabId)
    if (target) {
      const sessionId = pageStatusSessionId(target) ?? activeHandoffSessionIdForTab(tabId)
      const pending = handoffs.pendingForTab(tabId)
      const action = toolbarClickAction({
        handoffPending: pending !== undefined,
        sessionExecuting: sessionId !== undefined && sessions.isExecuting(sessionId),
      })
      if (action === "complete-handoff" && pending) {
        relayLog("handoff.completed", { tabId, from: "toolbar" })
        if (handoffs.complete({ id: pending.id, tabId, targetId: target.targetInfo.targetId, targetSessionId: target.sessionId })) {
          refreshPageStatus(tabId)
        }
        return
      }
      if (action === "stop-execution" && sessionId) {
        relayLog("execute.stopped", { tabId, session: sessionId, from: "toolbar" })
        sessions.stopExecution(sessionId, `The user took tab ${tabId} back (browse toolbar button) while this script ran, so it was stopped. Don't use that tab again unless the user lends it back; ask the user how to continue.`)
      }
    }
    Effect.runPromise(toggleTab(tabId)).catch((error: unknown) => {
      console.error("Toolbar toggle failed", error)
    })
  }

  /**
   * The user clicked the browser's debugging bar button, which detaches the debugger and leaves the tab open. A
   * script running on the tab is stopped with a message naming what happened; the tab itself is released by the
   * caller (detachTargetState with releasedByUser).
   */
  function handleDebuggingBarCancel(tabId: number): void {
    const sessions = getSessions()
    const target = registry.tabTargets.get(tabId)
    if (!target) return
    const sessionId = pageStatusSessionId(target) ?? activeHandoffSessionIdForTab(tabId)
    if (sessionId && sessions.isExecuting(sessionId)) {
      relayLog("execute.stopped", { tabId, session: sessionId, from: "debugging-bar" })
      sessions.stopExecution(sessionId, debuggingBarDismissedStop, "debugging-bar-cancel")
    }
  }

  function presentAttachedTarget(committedTarget: ConnectedTarget): void {
    tabActivity.touch(committedTarget.tabId)
    const tabId = committedTarget.tabId
    mainFrameIdsByTab.set(tabId, committedTarget.targetInfo.targetId)
    contextDebugLog?.(`target-attached kind=root ${targetDiagnosticIdentity(registry, committedTarget)} ${summarizeDiagnosticUrl(committedTarget.targetInfo.url)}`)
    if (committedTarget.opencodeBrowserSessionId) {
      pruneInvisibleAnnouncementsForSession(committedTarget.opencodeBrowserSessionId)
    }
    if (browsers.browserTab(tabId)?.link.rpc.connected) {
      refreshTabGrouping(tabId)
    }
    const pendingHandoff = handoffs.pendingForTab(tabId)
    if (pendingHandoff) {
      setActivityForTarget(committedTarget, "waiting", waitingBadge(pendingHandoff.message), {
        sessionId: pendingHandoff.sessionId,
        message: pendingHandoff.message,
        handoffId: pendingHandoff.id,
      })
    } else {
      sendPageStatus(committedTarget, committedTarget.opencodeBrowserSessionId && getSessions().isExecuting(committedTarget.opencodeBrowserSessionId) ? "running" : "attached")
    }
  }

  return {
    activeHandoffTabs,
    sendPageStatusEffect,
    refreshPageStatus,
    scheduleTabGrouping,
    refreshTabGrouping,
    refreshTabPresentation,
    clearPendingTabGrouping,
    cancelTargetHandoffs,
    requestHandoff,
    onSessionExecuteStateChange,
    handleToolbarClick,
    handleDebuggingBarCancel,
    presentAttachedTarget,
  }
}
