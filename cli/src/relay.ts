import crypto from "node:crypto"
import path from "node:path"
import { Clock, Config, Effect, Option, Result } from "effect"
import type { WebSocket } from "ws"
import { createAutoUpdater, npmRuntime } from "./auto-update.ts"
import { BrowserLinks, type BrowserLink } from "./browser-links.ts"
import { CdpClientPool } from "./cdp-client-pool.ts"
import { CdpRouter } from "./cdp-router.ts"
import { CdpRuntime } from "./cdp-runtime.ts"
import { installedDevExtension, syncDevExtension } from "./dev-extension.ts"
import { ExecuteSandbox } from "./execute.ts"
import { pruneStaleExecuteFilesDirectories } from "./execute-realm.ts"
import type { ExtensionRpc } from "./extension-rpc.ts"
import { FlightRecorderRelay } from "./flight-recorder.ts"
import { GhostCursorTabs } from "./ghost-cursor.ts"
import { HandoffRegistry } from "./handoff.ts"
import { createHttpRequestHandler } from "./http-api.ts"
import { forgetTab } from "./human-input.ts"
import { PasskeyBridge } from "./passkey-bridge.ts"
import { devExtension, storeConfig } from "./paths.ts"
import { ProtectedFrameTracker } from "./protected-frames.ts"
import type { CdpEvent, JsonObject } from "./protocol.ts"
import { RecordingRelay } from "./recording-relay.ts"
import { relayHostname } from "./relay-config.ts"
import {
  closeHttpServer,
  closeWebSocketServer,
  defaultPort,
  formatHostForUrl,
  getNumber,
  listenHttpServer,
  logCloseError,
  sendCdpEvent,
} from "./relay-helpers.ts"
import { appendRelayLifecycleEvent, RelayLifecycleEvent } from "./relay-lifecycle-log.ts"
import { relayLog } from "./relay-log.ts"
import { ensurePrivateDirectory, relayToken } from "./relay-secrets.ts"
import { RelayShutdown } from "./relay-shutdown.ts"
import type { ChildTarget, ConnectedTarget } from "./relay-types.ts"
import { createCdpDispatcher } from "./relay/cdp-dispatch.ts"
import { createExtensionEventHandler } from "./relay/extension-events.ts"
import { ExtensionHandshake } from "./relay/extension-handshake.ts"
import {
  handleRelayProcessFault,
  installRelayProcessGuard,
  isBenignClosedSessionRejection,
  processAlive,
  relayProcessFaultSummary,
  shouldSuppressRelayProcessFault,
  targetDiagnosticIdentity,
} from "./relay/process-guard.ts"
import { createRelaySettingsSync } from "./relay/settings-sync.ts"
import { createTabPresentation } from "./relay/tab-presentation.ts"
import { createRelayTransportServers } from "./relay/transport-server.ts"
import { RootTargetLifecycle } from "./root-target-lifecycle.ts"
import { defaultSessionCatalogPath, SessionCatalog } from "./session-catalog.ts"
import { appendJournalEntry, defaultJournalBaseDir, makeJournalEntry, startJournalRetention } from "./session-journal.ts"
import { defaultExecuteTimeoutMs, OpenCodeBrowserSessions } from "./session-manager.ts"
import { SessionNavigationGuard } from "./session-navigation-guard.ts"
import { TabActivity } from "./tab-activity.ts"
import { TargetRegistry, type RootTargetChange, type TargetOwnershipChange } from "./target-registry.ts"
import { createUpdateWatcher } from "./update.ts"
import { opencodeBrowserBuildId, opencodeBrowserVersion } from "./version.ts"

export {
  handleRelayProcessFault,
  isBenignClosedSessionRejection,
  relayProcessFaultSummary,
  shouldSuppressRelayProcessFault,
} from "./relay/process-guard.ts"

export const startRelay = Effect.fn("Relay.start")(function* (options: {
  readonly port?: number
  readonly releaseTargetGraceMs?: number
  readonly sessionCatalogPath?: string | null
  readonly additionalExtensionOrigins?: readonly string[]
} = {}) {
  yield* installRelayProcessGuard
  return yield* Effect.acquireRelease(makeRelay(options), (server) => server.close())
})

const makeRelay = Effect.fnUntraced(function* (options: {
  readonly port?: number
  readonly releaseTargetGraceMs?: number
  readonly sessionCatalogPath?: string | null
  readonly additionalExtensionOrigins?: readonly string[]
} = {}) {
  const listenHost = relayHostname()
  const host = "127.0.0.1"
  const port = options.port ?? defaultPort
  const releaseTargetGraceMs = Math.max(0, options.releaseTargetGraceMs ?? 10_000)
  const browserId = crypto.randomUUID()
  const endpointUrl = `http://${formatHostForUrl(host)}:${port}`
  const additionalChromeExtensionOrigins = new Set(options.additionalExtensionOrigins ?? [])
  const storeId = storeConfig().id
  if (storeId) additionalChromeExtensionOrigins.add(`chrome-extension://${storeId}`)
  const sessionCatalog = options.sessionCatalogPath === null
    ? undefined
    : new SessionCatalog(options.sessionCatalogPath ?? defaultSessionCatalogPath(port))
  let catalogWritesEnabled = false
  const registry = new TargetRegistry()
  const authToken = yield* Effect.try({
    try: () => {
      ensurePrivateDirectory()
      return relayToken()
    },
    catch: (cause) => new Error("Create the relay token", { cause }),
  })
  const browsers = new BrowserLinks()
  type ExtensionCommandInput = Parameters<ExtensionRpc["send"]>[0]
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

  const debugEnabled = yield* Config.Boolean("OPENCODE_BROWSER_DEBUG").pipe(Config.withDefault(false))
  const debugLog = debugEnabled ? (line: string) => console.error(`[bc ${new Date().toISOString().slice(11, 23)}] ${line}`) : undefined
  const contextDebugLog = debugLog ? (line: string) => debugLog(`[bc:ctx] ${line}`) : undefined

  const sendDebuggerCommand = Effect.fnUntraced(function* (commandOptions: {
    readonly tabId: number
    readonly sessionId?: string
    readonly method: string
    readonly params: JsonObject
  }) {
    const finishDisable = commandOptions.method === "Runtime.disable"
      ? cdpRuntime.beginDisable(commandOptions.tabId, commandOptions.sessionId)
      : undefined
    return yield* sendToExtension({
      method: "debugger.sendCommand",
      params: {
        tabId: commandOptions.tabId,
        method: commandOptions.method,
        params: commandOptions.params,
        ...(commandOptions.sessionId === undefined ? {} : { sessionId: commandOptions.sessionId }),
      },
    }).pipe(Effect.ensuring(Effect.sync(() => { finishDisable?.() })))
  })

  const cdpRuntime = new CdpRuntime<WebSocket>({
    registry,
    generation: (tabId) => browsers.generationOf(tabId),
    send: sendDebuggerCommand,
    sendEvent: sendCdpEvent,
    ...(contextDebugLog ? { trace: contextDebugLog } : {}),
  })
  const cdpClients = new CdpClientPool<WebSocket>(
    (client, event) => cdpRuntime.deliver(client, event),
    (client, sessionId) => cdpRuntime.detach(client, sessionId),
  )

  const mainFrameIdsByTab = new Map<number, string>()
  const blankNavigationWaiters = new Map<number, (url: string, loaderId: string | undefined) => void>()
  const suppressedChildSessions = new Map<string, number>()
  const protectedFrames = new ProtectedFrameTracker()
  const handoffs = new HandoffRegistry()
  const ownersAcrossReconnect = new Map<string, { readonly sessionId?: string; readonly owner: "relay" | "user"; readonly browser: string }>()
  const sweptBrowsers = new Set<string>()

  const passkeys = new PasskeyBridge({
    send: (tabId, method, params) => Effect.runPromise(sendDebuggerCommand({ tabId, method, params })),
    allowedOrigins: (tabId) => {
      const sessionId = registry.tabTargets.get(tabId)?.opencodeBrowserSessionId
      return sessionId ? sessions.allowedOrigins(sessionId) : undefined
    },
    log: (event, fields) => relayLog(event, fields),
  })
  const recordingRelay = new RecordingRelay({
    sendToExtension: (command) => Effect.runPromise(sendToExtension(command)),
    sendDebuggerCommand: (command) => Effect.runPromise(sendDebuggerCommand(command)),
    isExtensionConnected: () => browsers.connected,
    isTabUnavailable: (tabId) => flightRecorder.isActiveTab(tabId),
    onTabRecordingChanged: (tabId) => recordingChanged(tabId),
  })
  const flightRecorder = new FlightRecorderRelay({
    sendDebuggerCommand: (command) => Effect.runPromise(sendDebuggerCommand(command)),
    isExtensionConnected: () => browsers.connected,
    isTabRecording: (tabId) => recordingRelay.isRecordingTab(tabId),
    onTabRecordingChanged: (tabId) => recordingChanged(tabId),
  })
  const isTabRecorded = (tabId: number) => recordingRelay.isRecordingTab(tabId) || flightRecorder.isActiveTab(tabId)

  const ghostCursorEnv = Option.getOrUndefined(yield* Config.option(Config.Boolean("OPENCODE_BROWSER_GHOST_CURSOR")))
  const ghostCursorAlways = (tabId: number) => ghostCursorEnv ?? browsers.browserTab(tabId)?.link.cursor ?? false
  const agentWindowSetting = Option.getOrUndefined(yield* Config.option(Config.String("OPENCODE_BROWSER_AGENT_WINDOW")))?.trim().toLowerCase()
  const agentWindow = agentWindowSetting === "current" || agentWindowSetting === "separate" ? agentWindowSetting : undefined
  const ghostCursor = new GhostCursorTabs({
    send: sendDebuggerCommand,
    mainFrameId: (tabId) => mainFrameIdsByTab.get(tabId),
    shownByDefault: (tabId) =>
      isTabRecorded(tabId) ? recordingRelay.showsGhostCursor(tabId) || flightRecorder.showsGhostCursor(tabId) : ghostCursorAlways(tabId),
  })

  const tabActivity = new TabActivity((tabId, enabled) => sendDebuggerCommand({
    tabId,
    method: "Emulation.setFocusEmulationEnabled",
    params: { enabled },
  }))

  const browsersChanged = () =>
    relayLog("browsers", { connected: browsers.list().map((link) => `${link.id}${link.rpc.connected ? "" : " (starting)"}`).join(", ") || "none" })
  const announceTab = (tabId: number) => browsers.browserTab(tabId)?.link.announcedRootTabIds.add(tabId)

  const presentation = createTabPresentation({
    registry,
    browsers,
    handoffs,
    passkeys,
    tabActivity,
    mainFrameIdsByTab,
    sendToExtension,
    sendExtensionBestEffort,
    isTabRecorded,
    getSessions: () => sessions,
    canSessionSeeTarget: (sessionId, target) => cdpRouter.canSessionSeeTarget(sessionId, target),
    toggleTab: (tabId) => toggleTab(tabId),
    pruneInvisibleAnnouncementsForSession: (sessionId) => pruneInvisibleAnnouncementsForSession(sessionId),
    contextDebugLog,
  })

  const recordingChanged = async (tabId: number): Promise<void> => {
    await ghostCursor.refresh([tabId])
    const pending = handoffs.pendingForTab(tabId)
    const target = registry.tabTargets.get(tabId)
    if (!pending || !target) return
    await Effect.runPromise(Effect.ignore(presentation.sendPageStatusEffect(target, "waiting", {
      sessionId: pending.sessionId,
      message: pending.message,
      handoffId: pending.id,
    })))
  }

  const clearLiveExtensionState = (key: string, reason: string) => {
    const mine = (tabId: number) => browsers.ownerKey(tabId) === key
    for (const target of [...registry.listRootTargets(), ...registry.listStagedRootTargets()]) {
      if (!mine(target.tabId)) continue
      void recordingRelay.abortRecordingForTab({ tabId: target.tabId, reason }).catch(() => {})
      void flightRecorder.cancel({ tabId: target.tabId }).catch(() => {})
      presentation.clearPendingTabGrouping(target.tabId)
      ownersAcrossReconnect.set(target.targetInfo.targetId, {
        browser: key,
        owner: target.owner,
        ...(target.opencodeBrowserSessionId ? { sessionId: target.opencodeBrowserSessionId } : {}),
      })
    }
    for (const target of [...registry.listRootTargets(), ...registry.listStagedRootTargets()]) {
      if (mine(target.tabId)) detachTargetState(target.tabId, { preserveSessionTarget: true, updateExtension: false })
    }
    for (const [childSessionId, tabId] of suppressedChildSessions) if (mine(tabId)) suppressedChildSessions.delete(childSessionId)
  }

  const handshake = new ExtensionHandshake({
    port,
    storeId,
    browsers,
    registry,
    sendExtensionBestEffort,
    clearLiveExtensionState,
    browsersChanged,
    cdpClientCount: () => cdpClients.size,
  })

  const releaseRelayTarget = Effect.fnUntraced(function* (targetId: string) {
    const deadline = (yield* Clock.currentTimeMillis) + releaseTargetGraceMs
    while (true) {
      const target = registry.targetsByTargetId.get(targetId)
      const link = target ? browsers.browserTab(target.tabId)?.link : undefined
      if (target && link && (link.rpc.connected || link.rpc.protocolLegacy === true)) {
        if (target.owner !== "relay") return
        yield* sendToExtension({ method: "tabs.remove", params: { tabId: target.tabId } })
        return
      }
      if (link?.rpc.connected && link.rpc.protocolLegacy === false) return
      const remaining = deadline - (yield* Clock.currentTimeMillis)
      if (remaining <= 0) return
      yield* Effect.sleep(Math.min(50, remaining))
    }
  })

  const executeTimeoutMs = yield* Config.Int("OPENCODE_BROWSER_EXECUTE_TIMEOUT_MS").pipe(Config.withDefault(defaultExecuteTimeoutMs))
  const keepaliveIntervalMs = yield* Config.Int("OPENCODE_BROWSER_KEEPALIVE_MS").pipe(Config.withDefault(20_000))
  const idleTabTtlMs = yield* Config.Int("OPENCODE_BROWSER_IDLE_TAB_TTL_MS").pipe(Config.withDefault(15 * 60_000))
  const journalBaseDir = defaultJournalBaseDir()
  let stopJournalRetention: (() => void) | undefined

  const sessions: OpenCodeBrowserSessions = new OpenCodeBrowserSessions(
    endpointUrl,
    (id, onDefaultTargetChange) =>
      new ExecuteSandbox({
        endpointUrl,
        authToken,
        sessionId: id,
        onDefaultTargetChange,
        allowedOrigins: () => sessions.allowedOrigins(id),
        drainGuardWarnings: () => navigationGuard.drainWarnings(id),
        passkeys: {
          select: (targetId, site, username) => {
            const target = registry.targetsByTargetId.get(targetId)
            if (!target || !("owner" in target) || target.owner !== "relay" || target.opencodeBrowserSessionId !== id) {
              throw new Error("secrets.usePasskey: passkeys are answered only in tabs this session opened")
            }
            if (username) passkeys.select(target.tabId, site, username)
            else passkeys.clearSelection(target.tabId)
          },
          choiceSince: (targetId, since) => {
            const target = registry.targetsByTargetId.get(targetId)
            return target && target.opencodeBrowserSessionId === id ? passkeys.choiceSince(target.tabId, since) : undefined
          },
        },
        isRecordingTarget: (targetId) => {
          const target = registry.targetsByTargetId.get(targetId)
          return target !== undefined && isTabRecorded(target.tabId)
        },
        requestHandoff: ({ message, timeoutMs, target, start, cancelStart }) => presentation.requestHandoff({
          sessionId: id,
          message,
          timeoutMs,
          target,
          ...(start ? { start } : {}),
          ...(cancelStart ? { cancelStart } : {}),
        }),
      }),
    {
      resolveBrowser: (requested, session) => {
        const link = handshake.resolveSessionBrowser(requested, session)
        return "error" in link ? link : { id: link.id, key: link.key }
      },
      targetBrowserKey: (tabId) => browsers.ownerKey(tabId),
      getUserAttachedPageUrls: (session) => registry.listRootTargets()
        .filter((target) => target.owner === "user" && browsers.ownerKey(target.tabId) === session.browser?.key)
        .map((target) => target.targetInfo.url || "about:blank"),
      executeTimeoutMs,
      onExecuteStateChange: (sessionId, executing) => presentation.onSessionExecuteStateChange(sessionId, executing),
      onExecuteRecord: (record) => {
        const entry = makeJournalEntry({
          sessionId: record.sessionId,
          code: record.code,
          isError: record.result.isError,
          durationMs: record.durationMs,
          resultText: record.result.text,
          logCount: record.result.logs.length,
          startUrl: record.result.aftermath?.startUrl,
          endUrl: record.result.aftermath?.endUrl,
          navigations: record.result.aftermath?.navigations,
          warnings: record.result.warnings,
          diagnostic: record.result.diagnostic,
          handoffs: record.result.aftermath?.handoffs,
        })
        return appendJournalEntry({ baseDir: journalBaseDir, entry })
      },
      onTargetOwnershipChange: (change) => reconcileTargetOwnership(change),
      onReleaseRelayTarget: (targetId) => releaseRelayTarget(targetId),
      getTargets: () => registry.listRootTargets(),
      relayTargetIdsForSession: (sessionId) => [
        ...registry.listRootTargets()
          .filter((target) => target.owner === "relay" && target.opencodeBrowserSessionId === sessionId)
          .map((target) => target.targetInfo.targetId),
        ...Array.from(ownersAcrossReconnect)
          .filter(([targetId, known]) => known.owner === "relay" && known.sessionId === sessionId && !registry.targetsByTargetId.has(targetId))
          .map(([targetId]) => targetId),
      ],
      onCancelSessionHandoff: (sessionId) => handoffs.cancelForSession(sessionId) !== undefined,
      onSessionsChanged: async (entries) => {
        if (catalogWritesEnabled) await sessionCatalog?.save(entries)
      },
    },
    registry,
  )

  const cdpRouter = new CdpRouter(cdpClients, registry, (id, tabId) => {
    const session = sessions.sessions.get(id)
    return !session || (session.browser?.key !== undefined && session.browser.key === browsers.ownerKey(tabId))
  })

  const navigationGuard = new SessionNavigationGuard({
    allowedOrigins: (sessionId) => sessions.allowedOrigins(sessionId),
    isExecuting: (sessionId) => sessions.isExecuting(sessionId),
    mainFrameId: (tabId) => mainFrameIdsByTab.get(tabId),
    send: (tabId, method, params) => Effect.runPromise(sendDebuggerCommand({ tabId, method, params })),
    closeTab: (tabId) => Effect.runPromise(Effect.gen(function* () {
      const target = registry.tabTargets.get(tabId)
      if (target?.owner === "user") return
      relayLog("allowlist.close", { tabId, registered: target !== undefined })
      yield* sendToExtension({ method: "tabs.remove", params: { tabId } })
      if (target) detachTargetState(tabId)
    })),
    log: (event, details) => relayLog(event, details),
  })

  const ownerAcrossReconnect = (targetId: string) => {
    const known = ownersAcrossReconnect.get(targetId)
    return known?.sessionId !== undefined && sessions.sessions.has(known.sessionId)
      ? { sessionId: known.sessionId, owner: known.owner }
      : undefined
  }

  const rootLifecycle = yield* RootTargetLifecycle.make({
    registry,
    sessions: {
      persistedTargetOwner: (targetId) => sessions.persistedTargetOwner(targetId) ?? ownerAcrossReconnect(targetId),
      markTargetReplaced: (previousTargetId, targetId) => sessions.markTargetReplaced(previousTargetId, targetId),
    },
    handoffs,
    clients: cdpClients,
    extension: {
      generation: (tabId) => browsers.generationOf(tabId),
      isCurrentGeneration: (generation) => browsers.isCurrentGeneration(generation),
      send: (command) => sendToExtension(command),
    },
    presentation: {
      replaced: recordRootReplacement,
      committed: (target) => presentation.presentAttachedTarget(target),
      announceRoot: announceAttachedTarget,
      announceChild: announceAttachedChildTarget,
    },
    reportError: (message, error) => console.error(message, error),
  })

  const settingsSync = createRelaySettingsSync({
    browsers,
    handshake,
    ghostCursor,
    ghostCursorEnv,
    agentWindow,
    sendToExtension,
    sendExtensionBestEffort,
  })

  const updates = createUpdateWatcher({ onChange: () => sendUpdateNotice() })
  let updateTimer: NodeJS.Timeout | undefined
  let orphanTimer: NodeJS.Timeout | undefined
  let keepaliveTimer: NodeJS.Timeout | undefined
  let idleReapTimer: NodeJS.Timeout | undefined
  const clientGoneSince = new Map<string, number>()

  const sendUpdateNotice = () => {
    const notice = updates.current
    sendToEveryBrowser({ method: "update.notice", ...(notice ? { params: { summary: notice.summary, command: notice.command } } : {}) })
  }

  const managed = yield* Config.Boolean("OPENCODE_BROWSER_MANAGED_RELAY").pipe(Config.withDefault(false))
  const restartTimeoutMs = yield* Config.Int("OPENCODE_BROWSER_RESTART_TIMEOUT_MS").pipe(Config.withDefault(10_000))
  const clientGoneGraceMs = yield* Config.Int("OPENCODE_BROWSER_CLIENT_GONE_GRACE_MS").pipe(Config.withDefault(60_000))
  const restartRequestId = yield* Config.option(Config.String("OPENCODE_BROWSER_RESTART_REQUEST_ID"))
  const lifecycleLogPath = path.join(path.dirname(defaultSessionCatalogPath(port)), "lifecycle.jsonl")
  const audit = (event: RelayLifecycleEvent) => Effect.try(() => appendRelayLifecycleEvent(lifecycleLogPath, event))
  const settleRootWork = Effect.fnUntraced(function* () {
    yield* rootLifecycle.settle()
    yield* sessions.beginDrain()
  })

  const shutdownControl = new RelayShutdown({
    instanceId: browserId,
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
    stop: () => { setImmediate(() => process.kill(process.pid, "SIGTERM")) },
  })

  const collectOrphans = () => {
    if (!shutdownControl.accepting) return
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
        if (!/^mcp-[0-9a-f]{8}$/.test(id) || sessions.isExecuting(id) || sessions.hasPendingWork(id)) return
        const tabs = registry.listRootTargets().filter((target) => target.opencodeBrowserSessionId === id).map((target) => target.tabId)
        if (tabs.some((tabId) => handoffs.pendingForTab(tabId) || isTabRecorded(tabId))) return
        if (presentation.activeHandoffTabs.has(id)) return
        relayLog("session.collected", { session: id, reason: "client gone", pid, tabs: tabs.length })
        clientGoneSince.delete(id)
        yield* sessions.delete(id)
      }).pipe(Effect.ignore)).catch(() => {})
    }
    for (const id of clientGoneSince.keys()) if (!sessions.sessions.has(id)) clientGoneSince.delete(id)
  }

  function setProtectedUi(tabId: number, protectedUi: boolean): void {
    const changed = registry.markRootTargetProtectedUi(tabId, protectedUi)
    if (!changed) return
    contextDebugLog?.(`protected-ui blocked=${protectedUi} ${targetDiagnosticIdentity(registry, changed)}`)
    sessions.markTargetProtectedUi(changed.targetInfo.targetId, protectedUi)
  }

  const detachTab = Effect.fnUntraced(function* (tabId: number) {
    yield* sendToExtension({ method: "debugger.detach", params: { tabId } })
    detachTargetState(tabId)
    yield* Effect.ignore(sendToExtension({ method: "action.setAttached", params: { tabId, attached: false } }))
  })

  function isTabBusy(tabId: number): boolean {
    return handoffs.pendingForTab(tabId) !== undefined || isTabRecorded(tabId) ||
      Array.from(sessions.sessions.keys()).some((id) => sessions.isExecuting(id) || sessions.hasPendingWork(id) || sessions.sessions.get(id)?.sandbox.networkStatus().active)
  }

  const detachIdleUserTarget = Effect.fnUntraced(function* (targetId: string) {
    const target = registry.targetsByTargetId.get(targetId)
    if (!target || target.owner !== "user" || isTabBusy(target.tabId)) return
    yield* detachTab(target.tabId)
  })

  const toggleTab = Effect.fnUntraced(function* (tabId: number) {
    if (registry.tabTargets.has(tabId)) return yield* detachTab(tabId)
    announceTab(tabId)
    yield* rootLifecycle.attach({ tabId, owner: "user" })
  })

  const sessionBrowser = (sessionId: string | undefined): Effect.Effect<BrowserLink, Error> => Effect.suspend(() => {
    const session = sessionId && sessions.sessions.get(sessionId)
    if (session) {
      const link = handshake.resolveSessionBrowser(undefined, session)
      return "error" in link ? Effect.fail(new Error(link.error)) : Effect.succeed(link)
    }
    const existing = sessionId
      ? registry.listRootTargets().find((target) => target.opencodeBrowserSessionId === sessionId && target.owner === "relay")
      : undefined
    const link = (existing && browsers.browserTab(existing.tabId)?.link) ?? browsers.defaultLink()
    return link ? Effect.succeed(link) : Effect.fail(new Error("Browse extension is not connected"))
  })

  const createAndAttachTab = Effect.fnUntraced(function* (createOptions: {
    readonly url: string
    readonly active: boolean
    readonly opencodeBrowserSessionId?: string
    readonly autoAttachParams?: JsonObject
  }) {
    const link = yield* sessionBrowser(createOptions.opencodeBrowserSessionId)
    const result = yield* sendToExtension({ method: "tabs.create", params: { url: createOptions.url, active: createOptions.active, ...(agentWindow ? { window: agentWindow } : {}) } }, link)
    const tabId = getNumber(result, "tabId")
    if (!tabId) return yield* Effect.fail(new Error("tabs.create did not return a tabId"))
    announceTab(tabId)
    return yield* rootLifecycle.attach({
      tabId,
      owner: "relay",
      ...(createOptions.opencodeBrowserSessionId ? { opencodeBrowserSessionId: createOptions.opencodeBrowserSessionId } : {}),
      ...(createOptions.autoAttachParams ? { autoAttachParams: createOptions.autoAttachParams } : {}),
    })
  })

  const closeTargetByTargetId = Effect.fnUntraced(function* (targetId: string) {
    const target = registry.targetsByTargetId.get(targetId)
    if (!target) return
    if (target.owner === "user") return yield* detachTab(target.tabId)
    yield* sendToExtension({ method: "tabs.remove", params: { tabId: target.tabId } })
    detachTargetState(target.tabId)
  })

  function clearTabRuntimeState(tabId: number): void {
    tabActivity.forget(tabId)
    mainFrameIdsByTab.delete(tabId)
    protectedFrames.forgetTab(tabId)
    navigationGuard.forgetTab(tabId)
    ghostCursor.forget(tabId)
    forgetTab(tabId)
    passkeys.forget(tabId)
    for (const [sessionId, childTabId] of suppressedChildSessions) {
      if (childTabId === tabId) suppressedChildSessions.delete(sessionId)
    }
  }

  function detachTargetState(tabId: number, detachOptions: {
    readonly preserveSessionTarget?: boolean
    readonly updateExtension?: boolean
  } = {}): void {
    rootLifecycle.invalidate(tabId)
    if (detachOptions.updateExtension !== false) {
      sendExtensionBestEffort({ method: "pageStatus.clear", params: { tabId } })
      presentation.scheduleTabGrouping(tabId, "tabs.ungroup")
      sendExtensionBestEffort({ method: "action.setAttached", params: { tabId, attached: false } })
      void recordingRelay.abortRecordingForTab({ tabId, reason: "Tab detached" }).catch((error: unknown) => {
        console.error("Failed to abort recording for detached tab", error)
      })
      void flightRecorder.cancel({ tabId }).catch((error: unknown) => {
        console.error("Failed to stop flight recorder for detached tab", error)
      })
    }
    const detached = registry.detachRootTargetState(tabId)
    if (detached) {
      presentation.cancelTargetHandoffs(detached.target, "target-detached")
      if (!detachOptions.preserveSessionTarget) sessions.markTargetDetached(detached.target.targetInfo.targetId)
      contextDebugLog?.(`target-detached kind=root ${targetDiagnosticIdentity(registry, detached.target)}`)
    }
    cdpClients.detachTab(tabId, { destroyed: true })
    clearTabRuntimeState(tabId)
  }

  function recordRootReplacement(change: Extract<RootTargetChange, { readonly kind: "replaced" }>): void {
    clearTabRuntimeState(change.target.tabId)
    contextDebugLog?.(`target-replaced kind=root old=${targetDiagnosticIdentity(registry, change.previous)} new=${targetDiagnosticIdentity(registry, change.target)}`)
  }

  function detachChildTargetState(sessionId: string): void {
    const detached = registry.detachChildTargetState(sessionId)
    if (detached) cdpClients.detachTarget(detached)
  }

  function sendEventToTargetViewers(rootSessionId: string, event: CdpEvent): void {
    cdpClients.sendToViewers(rootSessionId, event, (client, tabId) => cdpRouter.canSeeTab(client, tabId))
  }

  function pruneInvisibleAnnouncementsForSession(opencodeBrowserSessionId: string): void {
    for (const client of cdpClients) {
      if (cdpClients.sessionId(client) === opencodeBrowserSessionId) cdpRouter.reconcileClient(client)
    }
  }

  function reconcileTargetOwnership(change: TargetOwnershipChange): void {
    for (const client of cdpClients) cdpRouter.reconcileClient(client)
    for (const targetId of change.targetIds) {
      const target = registry.targetsByTargetId.get(targetId)
      if (target) announceAttachedTarget(target)
    }
    for (const tabId of change.tabIds) presentation.refreshTabPresentation(tabId)
  }

  function announceAttachedTarget(target: ConnectedTarget): void {
    for (const client of cdpClients) {
      if (cdpRouter.canSeeTarget(client, target)) cdpClients.announce(client, target)
    }
  }

  function announceAttachedChildTarget(rootSessionId: string, target: ChildTarget): void {
    for (const client of cdpClients) {
      if (cdpClients.hasSession(client, rootSessionId) && cdpRouter.canSeeTab(client, target.tabId)) {
        cdpClients.announce(client, target)
      }
    }
  }

  const handleExtensionMessage = createExtensionEventHandler({
    registry,
    browsers,
    sessions,
    rootLifecycle,
    cdpClients,
    cdpRuntime,
    handoffs,
    recordingRelay,
    flightRecorder,
    passkeys,
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
    applyExtensionSettings: settingsSync.applyExtensionSettings,
    hasUpdateNotice: () => updates.current !== undefined,
    sendUpdateNotice,
    announceTab,
    browsersChanged,
    refreshPageStatus: presentation.refreshPageStatus,
    refreshTabGrouping: presentation.refreshTabGrouping,
    handleToolbarClick: presentation.handleToolbarClick,
    cancelTargetHandoffs: presentation.cancelTargetHandoffs,
    detachTargetState,
    detachChildTargetState,
    sendEventToTargetViewers,
    announceAttachedChildTarget,
    setProtectedUi,
    debugLog,
    contextDebugLog,
  })

  const handleCdpMessage = createCdpDispatcher({
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
  })

  const relayRequestHandler = createHttpRequestHandler({
    host,
    port,
    browserId,
    authToken,
    relayInstance: { id: browserId, startedAt: new Date().toISOString(), pid: process.pid, managed },
    shutdown: shutdownControl,
    registry,
    recordingRelay,
    flightRecorder,
    sessions,
    reloadExtension: () => sendToEach({ method: "runtime.reload" }),
    revokeBrowser: (key) => handshake.revokeBrowser(key),
    cleanupTabs: (idleMinutes) =>
      sendToEach({ method: "tabs.cleanup", ...(idleMinutes === undefined ? {} : { params: { idleMinutes } }) }),
    settings: settingsSync.httpSettings,
    extensionStatus: () => handshake.extensionStatus(),
  })

  let relayReady = false
  let lastAgentActivity = Date.now()
  const autoUpdateIdleMs = Number(process.env.OPENCODE_BROWSER_AUTO_UPDATE_IDLE_MS) || 15 * 60_000
  const browserIdle = () =>
    shutdownControl.accepting &&
    !Array.from(cdpClients).some((client) => !cdpClients.isSandbox(client)) &&
    !sessions.hasActiveNetworkCapture() &&
    recordingRelay.recordingTabIds().length === 0 &&
    flightRecorder.activeTabIds().length === 0 &&
    !Array.from(presentation.activeHandoffTabs.values()).some((tabs) => tabs.size > 0) &&
    !Array.from(sessions.sessions.keys()).some((id) => sessions.isExecuting(id) || sessions.hasPendingWork(id)) &&
    Date.now() - lastAgentActivity >= autoUpdateIdleMs
  let autoUpdater: ReturnType<typeof createAutoUpdater> | undefined

  const { httpServer, websocketServer } = createRelayTransportServers({
    host,
    port,
    endpointUrl,
    authToken,
    additionalChromeExtensionOrigins,
    isReady: () => relayReady,
    onAgentHttpActivity: () => { lastAgentActivity = Date.now() },
    relayRequestHandler,
    shutdownControl,
    sessions,
    cdpClients,
    cdpRuntime,
    handshake,
    recordingRelay,
    handleExtensionMessage,
    handleCdpMessage,
    debugLog,
  })

  const cleanup = Effect.fnUntraced(function* () {
    stopJournalRetention?.()
    clearInterval(updateTimer)
    clearInterval(orphanTimer)
    clearInterval(keepaliveTimer)
    clearInterval(idleReapTimer)
    autoUpdater?.stop()
    yield* shutdownControl.close().pipe(Effect.ignore)
    yield* sessions.closeAll()
    yield* rootLifecycle.close()
    if (managed) {
      yield* audit(RelayLifecycleEvent.cases.Closed.make({ instanceId: browserId })).pipe(
        Effect.catch(() => Effect.sync(() => console.error("Failed to record relay shutdown lifecycle event"))),
      )
    }
    handoffs.cancelAll()
    for (const link of browsers.list()) link.rpc.rejectPending(new Error("Relay closed"))
    yield* Effect.tryPromise(() => recordingRelay.cleanupAll("Relay closed")).pipe(Effect.ignore)
    yield* Effect.tryPromise(() => flightRecorder.cleanupAll()).pipe(Effect.ignore)
    for (const socket of cdpClients) socket.close()
    for (const link of browsers.list()) link.rpc.close()
    yield* closeWebSocketServer(websocketServer).pipe(logCloseError("Failed to close websocket server"))
    yield* closeHttpServer(httpServer).pipe(logCloseError("Failed to close http server"))
  })

  const close = cleanup()

  yield* Effect.catch(listenHttpServer({ server: httpServer, host: listenHost, port }), (error) => {
    return Effect.gen(function* () {
      yield* cleanup()
      return yield* Effect.fail(error)
    })
  })
  yield* Effect.sync(() => pruneStaleExecuteFilesDirectories())

  yield* Effect.catch(
    Effect.gen(function* () {
      const restoredSessions = yield* Effect.tryPromise({
        try: async () => {
          if (!sessionCatalog) return []
          const entries = await sessionCatalog.load()
          const restored = entries.map((entry) => {
            const known = !entry.browserKey && browsers.knownBrowser(entry.browser)
            return known ? { ...entry, browser: known.id, browserKey: known.key } : entry
          })
          if (restored.some((entry, i) => entry !== entries[i])) await sessionCatalog.save(restored)
          return restored
        },
        catch: (cause) => cause instanceof Error ? cause : new Error("Load Browse session catalog", { cause }),
      })
      yield* Effect.try({
        try: () => sessions.restore(restoredSessions),
        catch: (cause) => cause instanceof Error ? cause : new Error("Restore Browse sessions", { cause }),
      })
      catalogWritesEnabled = true
      if (managed) {
        yield* audit(yield* RelayLifecycleEvent.cases.Ready.makeEffect({
          instanceId: browserId,
          buildId: opencodeBrowserBuildId,
          ...(Option.isSome(restartRequestId) ? { restartRequestId: restartRequestId.value } : {}),
        }))
      }
      relayReady = true
      stopJournalRetention = startJournalRetention({
        baseDir: journalBaseDir,
        isLive: (sessionId) => sessions.sessions.has(sessionId),
        onError: (error) => console.error("Failed to prune session journals", error),
      })
      void updates.refresh()
      updateTimer = setInterval(() => void updates.refresh(), 60 * 60 * 1000)
      updateTimer.unref()
      orphanTimer = setInterval(collectOrphans, Math.max(1_000, Math.min(30_000, Math.floor(clientGoneGraceMs / 2))))
      orphanTimer.unref()
      if (keepaliveIntervalMs > 0) {
        keepaliveTimer = setInterval(() => sendToEveryBrowser({ method: "ping" }), keepaliveIntervalMs)
        keepaliveTimer.unref()
      }
      if (idleTabTtlMs > 0) {
        idleReapTimer = setInterval(() => {
          if (!shutdownControl.accepting) return
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
      const runtime = managed ? npmRuntime() : undefined
      if (runtime) {
        autoUpdater = createAutoUpdater({
          runtime,
          isIdle: browserIdle,
          log: relayLog,
          onChange: () => settingsSync.sendRelaySettings(),
        })
        autoUpdater.start()
      }
      const dev = devExtension()
      if (dev && installedDevExtension()) {
        syncDevExtension(dev).then(
          (result) => {
            if (result === "updated") relayLog("extension.dev_updated", { file: dev.file })
            for (const link of browsers.list()) if (link.local) handshake.reloadOutdatedDevExtension(link)
          },
          (error: unknown) => relayLog("extension.dev_update_failed", { error: (error as Error).message }),
        )
      }
      relayLog("relay.ready", { url: endpointUrl, version: opencodeBrowserVersion, build: opencodeBrowserBuildId, pid: process.pid, managed })
    }),
    (error) => Effect.gen(function* () {
      yield* cleanup()
      return yield* Effect.fail(error)
    }),
  )

  return {
    url: endpointUrl,
    close: () => close,
  }
})
