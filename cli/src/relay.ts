import crypto from "node:crypto"
import path from "node:path"
import { Config, Effect, Option } from "effect"
import type { WebSocket } from "ws"
import { createAutoUpdater, installedRuntime } from "./update/auto-update.ts"
import { BrowserLinks, type BrowserLink } from "./relay/browser-links.ts"
import { CdpClientPool } from "./cdp/client-pool.ts"
import { clearDeviceMetricsOverride, DeviceMetricsOverrides, tabsToClearOnExecuteEnd } from "./cdp/emulation.ts"
import { CdpRouter } from "./cdp/router.ts"
import { CdpRuntime } from "./cdp/runtime.ts"
import { installedDevExtension, syncDevExtension } from "./setup/dev-extension.ts"
import { ExecuteSandbox } from "./execute.ts"
import { pruneStaleExecuteFilesDirectories } from "./execute-realm.ts"
import { FlightRecorderRelay } from "./recording-relay/flight-recorder.ts"
import { GhostCursorTabs } from "./ghost-cursor.ts"
import { HandoffRegistry } from "./session-manager/handoff.ts"
import { createHttpRequestHandler } from "./http-api.ts"
import { forgetTab } from "./execute/human-input.ts"
import { devExtension, PUBLIC_STORE_ID, stateRoot, storeConfig } from "./paths.ts"
import { ProtectedFrameTracker } from "./cdp/protected-frames.ts"
import type { CdpEvent, JsonObject } from "./protocol.ts"
import { RecordingRelay } from "./recording-relay.ts"
import { relayHostname } from "./relay/config.ts"
import {
  closeHttpServer,
  closeWebSocketServer,
  createTargetUrl,
  defaultPort,
  formatHostForUrl,
  getNumber,
  getString,
  getTargetInfo,
  isRestrictedTarget,
  listenHttpServer,
  logCloseError,
  sendCdpEvent,
} from "./relay/helpers.ts"
import { appendRelayLifecycleEvent, RelayLifecycleEvent } from "./relay/lifecycle-log.ts"
import { relayLog } from "./relay/log.ts"
import { ensurePrivateDirectory, relayToken } from "./relay/secrets.ts"
import type { ChildTarget, ConnectedTarget } from "./relay/types.ts"
import { createCdpDispatcher } from "./relay/cdp-dispatch.ts"
import { createExtensionCommands, isMissingTabError } from "./relay/commands.ts"
import { navigateTopFrameToDataUrl } from "./relay/data-navigation.ts"
import { createExtensionEventHandler } from "./relay/extension-events.ts"
import { ExtensionHandshake } from "./relay/extension-handshake.ts"
import { installRelayProcessGuard, targetDiagnosticIdentity } from "./relay/process-guard.ts"
import { createRelayHousekeeping } from "./relay/housekeeping.ts"
import { createRelaySettingsSync } from "./relay/settings-sync.ts"
import { createTabPresentation } from "./relay/tab-presentation.ts"
import { createRelayTransportServers } from "./relay/transport-server.ts"
import { RootTargetLifecycle } from "./cdp/root-target-lifecycle.ts"
import { defaultSessionCatalogPath, SessionCatalog } from "./session-manager/catalog.ts"
import { appendJournalEntry, defaultJournalBaseDir, makeJournalEntry } from "./session-manager/journal.ts"
import { defaultShutdownTimeoutMs, OpenCodeBrowserSessions } from "./session-manager.ts"
import { SessionNavigationGuard } from "./session-manager/navigation-guard.ts"
import { TabActivity } from "./cdp/tab-activity.ts"
import { TargetRegistry, type RootTargetChange, type TargetOwnershipChange } from "./cdp/target-registry.ts"
import { opencodeBrowserBuildId, opencodeBrowserVersion } from "./version.ts"

export {
  handleRelayProcessFault,
  isBenignClosedSessionRejection,
  relayProcessFaultSummary,
  shouldSuppressRelayProcessFault,
} from "./relay/process-guard.ts"

/**
 * OPENCODE_BROWSER_EXECUTE_TIMEOUT_MS when the relay was given one: the default budget for an execute that didn't
 * choose its own, and the action budget that comes with it. Unset keeps the 60s fallback in session-manager.
 */
export const configuredExecuteTimeoutMs = Config.Int("OPENCODE_BROWSER_EXECUTE_TIMEOUT_MS").pipe(
  Config.option,
  Config.map(Option.getOrUndefined),
)

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
  // The store build installs from, for a checkout too: install points every channel at it (paths.ts PUBLIC_STORE_ID).
  const storeId = storeConfig().id ?? PUBLIC_STORE_ID
  additionalChromeExtensionOrigins.add(`chrome-extension://${storeId}`)
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
  const { sendToExtension, sendExtensionBestEffort, sendToEveryBrowser, sendToEach, cleanupTabs } = createExtensionCommands({ browsers, registry, onTabGone: forgetMissingTab })

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

  const executeTimeoutMs = yield* configuredExecuteTimeoutMs
  const keepaliveIntervalMs = yield* Config.Int("OPENCODE_BROWSER_KEEPALIVE_MS").pipe(Config.withDefault(20_000))
  const idleTabTtlMs = yield* Config.Int("OPENCODE_BROWSER_IDLE_TAB_TTL_MS").pipe(Config.withDefault(15 * 60_000))
  const journalBaseDir = defaultJournalBaseDir()
  // Tabs that received a device-metrics override; the execute end clears only these.
  const deviceMetricsOverrides = new DeviceMetricsOverrides()

  // The sandbox wiring stays here: it closes over `sessions` itself and over `navigationGuard`, declared below.
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
        cpuScheduler: sessions.cpuScheduler,
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
      checkBrowserResponsive: (key) => {
        const link = browsers.byKey(key)
        return link ? link.rpc.send({ method: "ping" }).pipe(Effect.asVoid)
          : Effect.fail(new Error("The browser disconnected before execution."))
      },
      targetBrowserKey: (tabId) => browsers.ownerKey(tabId),
      getUserAttachedPageUrls: (session) => registry.listRootTargets()
        .filter((target) => target.owner === "user" && browsers.ownerKey(target.tabId) === session.browser?.key)
        .map((target) => target.targetInfo.url || "about:blank"),
      ...(executeTimeoutMs === undefined ? {} : { executeTimeoutMs }),
      onExecuteStateChange: (sessionId, executing) => Effect.gen(function* () {
        yield* presentation.onSessionExecuteStateChange(sessionId, executing)
        if (executing) return
        // A viewport emulated on a tab outlives the script that set it: the tab stays letterboxed
        // until the debugger detaches. Clear the tabs this session's script set an override on,
        // owned or just driven through target selection, which also covers raw CDP overrides. This
        // runs inline under the session's execute semaphore, so nothing is left for the next call.
        const tabs = tabsToClearOnExecuteEnd({
          overrides: deviceMetricsOverrides,
          readOnly: sessions.isReadOnly(sessionId),
          sessionId,
          canSee: (tabId) => {
            const target = registry.tabTargets.get(tabId)
            return target !== undefined && cdpRouter.canSessionSeeTarget(sessionId, target)
          },
        })
        for (const { tabId, generation } of tabs) {
          if (!deviceMetricsOverrides.isCurrent(tabId, generation)) continue
          yield* clearDeviceMetricsOverride(
            (method, params) => sendDebuggerCommand({ tabId, method, params }),
            { retry: () => deviceMetricsOverrides.isCurrent(tabId, generation) },
          ).pipe(Effect.ignore)
        }
      }),
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

  // An attach command may run on an existing tab that is still loading, so it gets more time than the reconnect inventory.
  const attachTimeoutMs = yield* Config.Int("OPENCODE_BROWSER_ATTACH_TIMEOUT_MS").pipe(Config.withDefault(10_000))

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
    attachCommandTimeoutMs: attachTimeoutMs,
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

  const managed = yield* Config.Boolean("OPENCODE_BROWSER_MANAGED_RELAY").pipe(Config.withDefault(false))
  const restartTimeoutMs = yield* Config.Int("OPENCODE_BROWSER_RESTART_TIMEOUT_MS").pipe(Config.withDefault(10_000))
  const clientGoneGraceMs = yield* Config.Int("OPENCODE_BROWSER_CLIENT_GONE_GRACE_MS").pipe(Config.withDefault(60_000))
  const restartRequestId = yield* Config.option(Config.String("OPENCODE_BROWSER_RESTART_REQUEST_ID"))
  const lifecycleLogPath = path.join(stateRoot(), "relays", String(port), "lifecycle.jsonl")
  const audit = (event: RelayLifecycleEvent) => Effect.try(() => appendRelayLifecycleEvent(lifecycleLogPath, event))

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

  const housekeeping = createRelayHousekeeping({
    instanceId: browserId,
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
    activeHandoffTabs: presentation.activeHandoffTabs,
    tabActivity,
    recordingRelay,
    flightRecorder,
    rootLifecycle,
    closeTargetByTargetId: (targetId) => closeTargetByTargetId(targetId),
    sendToEveryBrowser,
    isTabRecorded,
    detachTab,
    audit,
  })
  const { shutdown: shutdownControl, updates, sendUpdateNotice, releaseRelayTarget, browserIdle, startTimers, stopTimers } = housekeeping

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
    return link ? Effect.succeed(link) : Effect.fail(new Error("browse extension is not connected"))
  })

  const createAndAttachTab = Effect.fnUntraced(function* (createOptions: {
    readonly url: string
    readonly active: boolean
    readonly opencodeBrowserSessionId?: string
    readonly autoAttachParams?: JsonObject
  }) {
    const link = yield* sessionBrowser(createOptions.opencodeBrowserSessionId)
    // Create the tab blank and navigate only after attaching: the navigation guard then sees the real load (a tab
    // created at the URL would load it before any debugger was attached), and Vivaldi never has to answer commands
    // on a tab that is still loading.
    const result = yield* sendToExtension({ method: "tabs.create", params: { url: "about:blank", active: createOptions.active, ...(agentWindow ? { window: agentWindow } : {}) } }, link)
    const tabId = getNumber(result, "tabId")
    if (!tabId) return yield* Effect.fail(new Error("tabs.create did not return a tabId"))
    announceTab(tabId)
    const target = yield* rootLifecycle.attach({
      tabId,
      owner: "relay",
      ...(createOptions.opencodeBrowserSessionId ? { opencodeBrowserSessionId: createOptions.opencodeBrowserSessionId } : {}),
      ...(createOptions.autoAttachParams ? { autoAttachParams: createOptions.autoAttachParams } : {}),
    }).pipe(
      // The tab exists for this createTarget alone: a failed attach must not leave an unattached blank tab behind.
      Effect.tapError((error) => Effect.sync(() => {
        relayLog("create.attach-failed", { tabId, error: error instanceof Error ? error.message : String(error) })
        sendExtensionBestEffort({ method: "tabs.remove", params: { tabId } })
        detachTargetState(tabId)
      })),
    )
    const requested = createTargetUrl({ url: createOptions.url })
    if (requested !== "about:blank") {
      const data = /^data:/i.test(requested.trim())
      const navigation = yield* (
        data
          ? navigateTopFrameToDataUrl({ tabId, params: { url: requested }, mainFrameIdsByTab, blankNavigationWaiters, registry, sendDebuggerCommand })
          : sendDebuggerCommand({ tabId, method: "Page.navigate", params: { url: requested } })
      ).pipe(
        // A failed navigation must not fail the create and leak an announced tab; Chrome answers createTarget anyway.
        Effect.catch((error) => Effect.sync(() => {
          relayLog("create.navigate-failed", { tabId, error: error instanceof Error ? error.message : String(error) })
          return undefined
        })),
      )
      const errorText = getString(navigation, "errorText")
      if (errorText) relayLog("create.navigate-failed", { tabId, errorText })
      else if (data && navigation === undefined) relayLog("create.data-skipped", { tabId })
      // Defense in depth: check where the tab actually ended up, in case its load beat the guard's events. A
      // disallowed result is blanked here like any other agent tab; only a URL this check allows reaches the registry.
      const current = yield* sendDebuggerCommand({ tabId, method: "Target.getTargetInfo", params: {} }).pipe(Effect.orElseSucceed((): JsonObject => ({})))
      const targetInfo = getTargetInfo(current.targetInfo)
      if (targetInfo && !isRestrictedTarget(targetInfo) && navigationGuard.createdTabNavigated({ ...target, targetInfo })) {
        const updated = registry.updateConnectedTargetInfo({ tabId, targetInfo })
        if (updated?.kind === "root") return updated.target
      }
    }
    return target
  })

  const closeTargetByTargetId = Effect.fnUntraced(function* (targetId: string) {
    const target = registry.targetsByTargetId.get(targetId)
    if (!target) return
    if (target.owner === "user") return yield* detachTab(target.tabId)
    // A tab that is already gone is closed: answering an error would leave Playwright's page.close() waiting forever.
    yield* sendToExtension({ method: "tabs.remove", params: { tabId: target.tabId } }).pipe(Effect.catchIf(isMissingTabError, () => Effect.void))
    detachTargetState(target.tabId)
  })

  function clearTabRuntimeState(tabId: number): void {
    tabActivity.forget(tabId)
    mainFrameIdsByTab.delete(tabId)
    protectedFrames.forgetTab(tabId)
    navigationGuard.forgetTab(tabId)
    ghostCursor.forget(tabId)
    deviceMetricsOverrides.forget(tabId)
    forgetTab(tabId)
    for (const [sessionId, childTabId] of suppressedChildSessions) {
      if (childTabId === tabId) suppressedChildSessions.delete(sessionId)
    }
  }

  function detachTargetState(tabId: number, detachOptions: {
    readonly preserveSessionTarget?: boolean
    readonly updateExtension?: boolean
    readonly releasedByUser?: boolean
  } = {}): void {
    rootLifecycle.invalidate(tabId)
    if (detachOptions.updateExtension !== false) {
      sendExtensionBestEffort({ method: "pageStatus.clear", params: { tabId } })
      // An agent-opened tab stays in its group and on the idle timer after a cancel, so an ungroup here would close it.
      if (detachOptions.releasedByUser !== true || registry.tabTargets.get(tabId)?.owner !== "relay") presentation.scheduleTabGrouping(tabId, "tabs.ungroup")
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
      if (!detachOptions.preserveSessionTarget) sessions.markTargetDetached(detached.target.targetInfo.targetId, { releasedByUser: detachOptions.releasedByUser === true })
      contextDebugLog?.(`target-detached kind=root ${targetDiagnosticIdentity(registry, detached.target)}`)
    }
    cdpClients.detachTab(tabId, { destroyed: true })
    clearTabRuntimeState(tabId)
  }

  /**
   * Chrome answered a command for this tab that it has no such tab, though the extension never reported it closed
   * (#153). Drop it as a reported close does, so clients see the page close, and fail what is still waiting on it.
   */
  function forgetMissingTab(tabId: number, method: string): void {
    if (!registry.routingRootTarget(tabId)) return
    relayLog("target.gone", { tabId, method })
    detachTargetState(tabId)
    const owner = browsers.browserTab(tabId)
    owner?.link.rpc.rejectDebuggerCommandsForTab(owner.tabId, new Error(`Target closed: tab ${tabId} no longer exists`))
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
    handleDebuggingBarCancel: presentation.handleDebuggingBarCancel,
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
    deviceMetricsOverrides,
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
    cleanupTabs,
    settings: settingsSync.httpSettings,
    extensionStatus: () => handshake.extensionStatus(),
  })

  let relayReady = false
  let autoUpdater: ReturnType<typeof createAutoUpdater> | undefined

  const { httpServer, websocketServer } = createRelayTransportServers({
    host,
    port,
    endpointUrl,
    authToken,
    additionalChromeExtensionOrigins,
    isReady: () => relayReady,
    onAgentHttpActivity: () => housekeeping.noteAgentActivity(),
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
    stopTimers()
    autoUpdater?.stop()
    yield* shutdownControl.close().pipe(Effect.ignore)
    yield* sessions.closeAll({
      onStalled: (sessions) => relayLog("relay.shutdown.stalled", {
        sessions: sessions.length > 0 ? sessions.map(({ sessionId, pending }) => `${sessionId} (${pending})`).join(", ") : "none",
        waitedMs: defaultShutdownTimeoutMs,
      }),
    })
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
        catch: (cause) => cause instanceof Error ? cause : new Error("Load browse session catalog", { cause }),
      })
      yield* Effect.try({
        try: () => sessions.restore(restoredSessions),
        catch: (cause) => cause instanceof Error ? cause : new Error("Restore browse sessions", { cause }),
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
      void updates.refresh()
      startTimers()
      const runtime = managed ? installedRuntime() : undefined
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
