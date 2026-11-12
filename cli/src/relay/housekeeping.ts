import { Clock, Effect } from "effect"
import type { WebSocket } from "ws"
import type { CdpClientPool } from "../cdp/client-pool.ts"
import type { RootTargetLifecycle } from "../cdp/root-target-lifecycle.ts"
import type { TabActivity } from "../cdp/tab-activity.ts"
import type { TargetRegistry } from "../cdp/target-registry.ts"
import { browserUnresponsive } from "../protocol.ts"
import type { FlightRecorderRelay } from "../recording-relay/flight-recorder.ts"
import type { RecordingRelay } from "../recording-relay.ts"
import type { OpenCodeBrowserSessions } from "../session-manager.ts"
import { isMcpSession } from "../session-manager.ts"
import type { HandoffRegistry } from "../session-manager/handoff.ts"
import { startJournalRetention } from "../session-manager/journal.ts"
import { createUpdateWatcher } from "../update.ts"
import type { BrowserLinks } from "./browser-links.ts"
import type { RelayLifecycleEvent } from "./lifecycle-log.ts"
import { relayLog } from "./log.ts"
import { processAlive } from "./process-guard.ts"
import type { ExtensionCommandInput } from "./rpc.ts"
import { RelayShutdown } from "./shutdown.ts"

/** The pieces of the relay a tab's busy check needs; separate so the check is testable without a whole relay. */
export type TabBusyDependencies = {
  readonly registry: Pick<TargetRegistry, "getRootTargetByTabId">
  readonly sessions: Pick<OpenCodeBrowserSessions, "sessions" | "isExecuting" | "hasPendingWork">
  readonly handoffs: Pick<HandoffRegistry, "pendingForTab">
  readonly isTabRecorded: (tabId: number) => boolean
}

/** Whether a tab is in use: a handoff waits on it, it is recorded, or its owning session is executing or capturing. */
export function tabIsBusy(tabId: number, deps: TabBusyDependencies): boolean {
  if (deps.handoffs.pendingForTab(tabId) !== undefined || deps.isTabRecorded(tabId)) return true
  const sessionId = deps.registry.getRootTargetByTabId(tabId)?.opencodeBrowserSessionId
  if (sessionId === undefined) return false
  const session = deps.sessions.sessions.get(sessionId)
  if (!session) return false
  return deps.sessions.isExecuting(sessionId) || deps.sessions.hasPendingWork(sessionId) || session.sandbox.networkStatus().active
}

/** The relay's periodic work: orphan collection, idle tab reaping, keepalives and update checks. */
export function createRelayHousekeeping(options: {
  readonly instanceId: string
  readonly managed: boolean
  readonly restartTimeoutMs: number
  readonly releaseTargetGraceMs: number
  readonly clientGoneGraceMs: number
  readonly idleTabTtlMs: number
  readonly keepaliveIntervalMs: number
  readonly journalBaseDir: string
  readonly sessions: OpenCodeBrowserSessions
  readonly registry: TargetRegistry
  readonly browsers: BrowserLinks
  readonly cdpClients: CdpClientPool<WebSocket>
  readonly handoffs: HandoffRegistry
  readonly activeHandoffTabs: ReadonlyMap<string, Set<number>>
  readonly tabActivity: TabActivity
  readonly recordingRelay: RecordingRelay
  readonly flightRecorder: FlightRecorderRelay
  readonly rootLifecycle: RootTargetLifecycle
  readonly closeTargetByTargetId: (targetId: string) => Effect.Effect<void, Error>
  readonly sendToEveryBrowser: (command: ExtensionCommandInput) => void
  readonly isTabRecorded: (tabId: number) => boolean
  readonly detachTab: (tabId: number) => Effect.Effect<void, Error>
  readonly audit: (event: RelayLifecycleEvent) => Effect.Effect<void, Error>
}) {
  const {
    instanceId,
    managed,
    restartTimeoutMs,
    releaseTargetGraceMs,
    clientGoneGraceMs,
    idleTabTtlMs,
    keepaliveIntervalMs,
    journalBaseDir,
    sessions,
    registry,
    browsers,
    cdpClients,
    handoffs,
    activeHandoffTabs,
    tabActivity,
    recordingRelay,
    flightRecorder,
    rootLifecycle,
    closeTargetByTargetId,
    sendToEveryBrowser,
    isTabRecorded,
    detachTab,
    audit,
  } = options

  const clientGoneSince = new Map<string, number>()
  let lastAgentActivity = Date.now()
  const autoUpdateIdleMs = Number(process.env.OPENCODE_BROWSER_AUTO_UPDATE_IDLE_MS) || 15 * 60_000
  let stopJournalRetention: (() => void) | undefined
  let updateTimer: NodeJS.Timeout | undefined
  let orphanTimer: NodeJS.Timeout | undefined
  let keepaliveTimer: NodeJS.Timeout | undefined
  let idleReapTimer: NodeJS.Timeout | undefined

  const updates = createUpdateWatcher({ onChange: () => sendUpdateNotice() })

  const sendUpdateNotice = () => {
    const notice = updates.current
    sendToEveryBrowser({ method: "update.notice", ...(notice ? { params: { summary: notice.summary, command: notice.command } } : {}) })
  }

  const releaseRelayTarget = Effect.fnUntraced(function* (targetId: string) {
    const first = registry.targetsByTargetId.get(targetId)
    // Nothing to release, or the user's tab: don't wait on the browser for either.
    if (!first || first.owner !== "relay") return
    const deadline = (yield* Clock.currentTimeMillis) + releaseTargetGraceMs
    while (true) {
      const target = registry.targetsByTargetId.get(targetId)
      if (!target || target.owner !== "relay") return
      const link = browsers.browserTab(target.tabId)?.link
      if (link && (link.rpc.connected || link.rpc.protocolLegacy === true)) {
        yield* closeTargetByTargetId(targetId)
        return
      }
      const remaining = deadline - (yield* Clock.currentTimeMillis)
      if (remaining <= 0) return
      yield* Effect.sleep(Math.min(50, remaining))
    }
  })

  /** Ask the supervisor to restart us: RelayShutdown calls this once a restart has drained cleanly. */
  const stop = () => { setImmediate(() => process.kill(process.pid, "SIGTERM")) }

  const settleRootWork = Effect.fnUntraced(function* () {
    yield* rootLifecycle.settle()
    yield* sessions.beginDrain()
  })

  const shutdown = new RelayShutdown({
    instanceId,
    managed,
    timeoutMs: Math.max(0, restartTimeoutMs),
    drain: sessions.beginDrain(),
    resume: () => sessions.resume(),
    busy: () => {
      const raw = Array.from(cdpClients).filter((client) => !cdpClients.isSandbox(client)).length
      if (raw > 0) return { reason: "raw-clients", detail: `${raw} raw CDP client${raw === 1 ? "" : "s"} attached (a script using connectOverCDP)` }
      const busy = [
        ...sessions.activeNetworkCaptures().map((capture) => `a network capture in session ${capture.sessionId}${capture.startedAt ? ` (since ${capture.startedAt})` : ""}`),
        ...recordingRelay.recordingTabIds().map((tabId) => `a recording of tab ${tabId}`),
        ...flightRecorder.activeTabIds().map((tabId) => `a flight recorder on tab ${tabId}`),
      ]
      return busy.length ? { reason: "recordings", detail: busy.slice(0, 5).join(", ") + (busy.length > 5 ? ` and ${busy.length - 5} more` : "") } : undefined
    },
    release: Effect.gen(function* () {
      relayLog("relay.restart.force", {})
      for (const capture of sessions.activeNetworkCaptures()) yield* sessions.networkEnd(capture.sessionId, "the relay was restarted with --force")
      yield* Effect.promise(() => recordingRelay.cleanupAll("The relay was restarted with --force").catch(() => {}))
      yield* Effect.promise(() => flightRecorder.cleanupAll().catch(() => {}))
      for (const client of Array.from(cdpClients)) if (!cdpClients.isSandbox(client)) client.close(1001, "Relay restarting")
      yield* Effect.sleep(200)
    }),
    settle: settleRootWork(),
    quiescent: () => rootLifecycle.isIdle() && sessions.isDrained(),
    audit,
    stop,
  })

  const collectOrphans = () => {
    if (!shutdown.accepting) return
    const now = Date.now()
    for (const session of sessions.sessions.values()) {
      const pid = session.clientPid
      if (pid === undefined || processAlive(pid)) {
        clientGoneSince.delete(session.id)
        continue
      }
      const since = clientGoneSince.get(session.id) ?? now
      clientGoneSince.set(session.id, since)
      if (now - since < clientGoneGraceMs) continue
      const id = session.id
      Effect.runPromise(Effect.gen(function* () {
        if (yield* sessions.networkEnd(id, `its client (process ${pid}) exited`)) relayLog("session.capture.ended", { session: id, reason: "client gone", pid })
        if (!isMcpSession(id) || sessions.isExecuting(id) || sessions.hasPendingWork(id)) return
        const tabs = registry.listRootTargets().filter((target) => target.opencodeBrowserSessionId === id).map((target) => target.tabId)
        if (tabs.some((tabId) => handoffs.pendingForTab(tabId) || isTabRecorded(tabId))) return
        if (activeHandoffTabs.has(id)) return
        relayLog("session.collected", { session: id, reason: "client gone", pid, tabs: tabs.length })
        clientGoneSince.delete(id)
        yield* sessions.delete(id)
      }).pipe(Effect.ignore)).catch(() => {})
    }
    for (const id of clientGoneSince.keys()) if (!sessions.sessions.has(id)) clientGoneSince.delete(id)
  }

  /** Whether an automatic update can restart the relay without interrupting anyone. */
  const browserIdle = () =>
    shutdown.accepting &&
    !Array.from(cdpClients).some((client) => !cdpClients.isSandbox(client)) &&
    !sessions.hasActiveNetworkCapture() &&
    recordingRelay.recordingTabIds().length === 0 &&
    flightRecorder.activeTabIds().length === 0 &&
    !Array.from(activeHandoffTabs.values()).some((tabs) => tabs.size > 0) &&
    !Array.from(sessions.sessions.keys()).some((id) => sessions.isExecuting(id) || sessions.hasPendingWork(id)) &&
    Date.now() - lastAgentActivity >= autoUpdateIdleMs

  const noteAgentActivity = () => {
    lastAgentActivity = Date.now()
  }

  const isTabBusy = (tabId: number): boolean => tabIsBusy(tabId, { registry, sessions, handoffs, isTabRecorded })

  const detachIdleUserTarget = Effect.fnUntraced(function* (targetId: string) {
    const target = registry.targetsByTargetId.get(targetId)
    if (!target || target.owner !== "user" || isTabBusy(target.tabId)) return
    yield* detachTab(target.tabId)
  })

  const startTimers = () => {
    stopJournalRetention = startJournalRetention({
      baseDir: journalBaseDir,
      isLive: (sessionId) => sessions.sessions.has(sessionId),
      onError: (error) => console.error("Failed to prune session journals", error),
    })
    updateTimer = setInterval(() => void updates.refresh(), 60 * 60 * 1000)
    updateTimer.unref()
    orphanTimer = setInterval(collectOrphans, Math.max(1_000, Math.min(30_000, Math.floor(clientGoneGraceMs / 2))))
    orphanTimer.unref()
    if (keepaliveIntervalMs > 0) {
      keepaliveTimer = setInterval(() => {
        for (const link of browsers.list()) {
          if (!link.rpc.connected && !link.rpc.unresponsive) continue
          // A slow worker still owes an answer to the last ping; another would only queue behind it.
          if (link.rpc.pingPending) continue
          void Effect.runPromise(link.rpc.send({ method: "ping" })).catch(() => {
            if (!link.rpc.unresponsive || browsers.byKey(link.key) !== link) return
            for (const session of sessions.sessions.values()) {
              if (session.browser?.key === link.key) sessions.stopExecution(session.id, browserUnresponsive, "browser-unresponsive")
            }
          })
        }
      }, keepaliveIntervalMs)
      keepaliveTimer.unref()
    }
    if (idleTabTtlMs > 0) {
      idleReapTimer = setInterval(() => {
        if (!shutdown.accepting) return
        Effect.runPromise(
          sessions.reapIdleSessions({
            maxIdleMs: idleTabTtlMs,
            isTargetBusy: (targetId) => {
              const target = registry.targetsByTargetId.get(targetId)
              return target ? isTabBusy(target.tabId) : false
            },
          }).pipe(Effect.andThen(() => Effect.forEach(
            tabActivity.idleUserTargets(registry.listRootTargets(), Date.now(), idleTabTtlMs),
            (target) => detachIdleUserTarget(target.targetInfo.targetId).pipe(Effect.ignore),
            { discard: true },
          ))),
        ).catch(() => {})
      }, 60_000)
      idleReapTimer.unref()
    }
  }

  /** Idempotent, and safe on the listen-failure path before startTimers has ever run. */
  const stopTimers = () => {
    stopJournalRetention?.()
    stopJournalRetention = undefined
    clearInterval(updateTimer)
    updateTimer = undefined
    clearInterval(orphanTimer)
    orphanTimer = undefined
    clearInterval(keepaliveTimer)
    keepaliveTimer = undefined
    clearInterval(idleReapTimer)
    idleReapTimer = undefined
  }

  return { shutdown, updates, sendUpdateNotice, releaseRelayTarget, collectOrphans, browserIdle, noteAgentActivity, startTimers, stopTimers }
}
