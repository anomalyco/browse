import http from "node:http"
import stream from "node:stream"
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Clock, Config, Effect, Option } from "effect"
import { WebSocket, WebSocketServer, type RawData } from "ws"
import {
  removeDefaultLightColorSchemeEmulation,
  replayChildFrameNavigation,
  replayChildTargetsForParent,
  replayTargetCreated,
} from "./cdp-shims.ts"
import { CdpClientPool } from "./cdp-client-pool.ts"
import { beforeInput, forgetTab } from "./human-input.ts"
import { CdpRouter } from "./cdp-router.ts"
import { CdpRuntime } from "./cdp-runtime.ts"
import { ExtensionRpc } from "./extension-rpc.ts"
import { createHttpRequestHandler, hasRelayToken } from "./http-api.ts"
import type { CdpEvent, CdpRequest, JsonObject, PageStatus } from "./protocol.ts"
import { extensionProtocolCompatibility, isCdpRequest, isExtensionEvent, isExtensionResponse, makePageStatus, parseJsonObject } from "./protocol.ts"
import {
  closeHttpServer,
  closeWebSocketServer,
  dataUrlDocument,
  chromeExtensionOriginForPath,
  defaultHost,
  defaultPort,
  formatHostForUrl,
  getIdText,
  getNumber,
  getObject,
  getString,
  getTargetInfo,
  headerValue,
  isRestrictedTarget,
  listenHttpServer,
  logCloseError,
  sendCdpEvent,
  sendCdpResponse,
  stableUnpackedExtensionOrigin,
  validateHostHeader,
  validateWebSocketOrigin,
} from "./relay-helpers.ts"
import { ensurePrivateDirectory, pairingCode, pairingProof, relayToken, relayTokenQueryParam, secretsEqual } from "./relay-secrets.ts"
import type { ChildTarget, ConnectedTarget } from "./relay-types.ts"
import { GhostCursorTabs, ghostCursorCommandMethod } from "./ghost-cursor.ts"
import { guardCdpMethod, scopeCdpResult } from "./cdp-guardrails.ts"
import {
  awaitHandoffAction,
  HandoffRegistry,
  resolveExactHandoffTarget,
  toolbarClickAction,
  type HandoffCancellationReason,
  type HandoffOutcome,
} from "./handoff.ts"
import { ExecuteSandbox, type HandoffPageTarget } from "./execute.ts"
import { appendJournalEntry, defaultJournalBaseDir, makeJournalEntry, startJournalRetention } from "./session-journal.ts"
import { defaultSessionCatalogPath, SessionCatalog } from "./session-catalog.ts"
import { OpenCodeBrowserSessions } from "./session-manager.ts"
import { RecordingRelay } from "./recording-relay.ts"
import { FlightRecorderRelay } from "./flight-recorder.ts"
import { appendManagedRelayProcessLog, relayLog } from "./relay-log.ts"
import { appendRelayLifecycleEvent, RelayLifecycleEvent } from "./relay-lifecycle-log.ts"
import { RelayShutdown } from "./relay-shutdown.ts"
import { ProtectedFrameTracker } from "./protected-frames.ts"
import { RootTargetLifecycle } from "./root-target-lifecycle.ts"
import { boundedToken, runtimeFailureKind, summarizeDiagnosticUrl, summarizeRuntimeEvaluate } from "./runtime-diagnostics.ts"
import { shouldExposeChildTarget, TargetRegistry, type RootTargetChange, type TargetOwnershipChange } from "./target-registry.ts"
import { opencodeBrowserBuildId, opencodeBrowserVersion } from "./version.ts"
import { handleExecuteRealmException, handleExecuteRealmRejection, pruneStaleExecuteFilesDirectories } from "./execute-realm.ts"

export const startRelay = Effect.fn("Relay.start")(function* (options: {
  readonly port?: number
  readonly releaseTargetGraceMs?: number
  readonly sessionCatalogPath?: string | null
  readonly additionalExtensionOrigins?: readonly string[]
} = {}) {
  yield* installRelayProcessGuard
  return yield* Effect.acquireRelease(makeRelay(options), (server) => {
    return server.close()
  })
})

type RelayProcessFaultKind = "uncaughtException" | "unhandledRejection"

const installRelayProcessGuard = Effect.acquireRelease(
  Effect.sync(() => {
    const onUncaughtException = (error: Error, origin: NodeJS.UncaughtExceptionOrigin) => {
      if (handleExecuteRealmException(error)) return
      handleRelayProcessFault("uncaughtException", error, { origin })
    }
    const onUnhandledRejection = (reason: unknown, promise: Promise<unknown>) => {
      if (handleExecuteRealmRejection(promise)) return
      handleRelayProcessFault("unhandledRejection", reason, { promise })
    }
    process.on("uncaughtException", onUncaughtException)
    process.on("unhandledRejection", onUnhandledRejection)
    return { onUncaughtException, onUnhandledRejection }
  }),
  (handlers) => {
    return Effect.sync(() => {
      process.off("uncaughtException", handlers.onUncaughtException)
      process.off("unhandledRejection", handlers.onUnhandledRejection)
    })
  },
)

/** Playwright dispatch faults the relay swallowed to stay alive; reported by `status` and `doctor`. */
const suppressedProcessFaults: { count: number; lastAt?: string; lastMessage?: string } = { count: 0 }

export function relayProcessFaultSummary(): { readonly suppressed: number; readonly lastAt?: string; readonly lastMessage?: string } {
  return {
    suppressed: suppressedProcessFaults.count,
    ...(suppressedProcessFaults.lastAt === undefined ? {} : { lastAt: suppressedProcessFaults.lastAt }),
    ...(suppressedProcessFaults.lastMessage === undefined ? {} : { lastMessage: suppressedProcessFaults.lastMessage }),
  }
}

export function shouldSuppressRelayProcessFault(cause: unknown): boolean {
  const errorText = cause instanceof Error ? `${cause.message}\n${cause.stack ?? ""}` : String(cause)
  return /playwright-core|patchright-core|coreBundle|Duplicate target/i.test(errorText)
}

export function handleRelayProcessFault(
  kind: RelayProcessFaultKind,
  cause: unknown,
  detail: Record<string, unknown>,
  options: { readonly rethrow?: (cause: unknown) => never } = {},
): void {
  if (shouldSuppressRelayProcessFault(cause)) {
    suppressedProcessFaults.count += 1
    suppressedProcessFaults.lastAt = new Date().toISOString()
    suppressedProcessFaults.lastMessage = (cause instanceof Error ? cause.message : String(cause)).slice(0, 300)
    logProcessFault(kind, cause, detail, "keeping relay alive")
    return
  }
  logProcessFault(kind, cause, detail, "not a known Playwright dispatch fault; rethrowing")
  const rethrow = options.rethrow ?? rethrowProcessFault
  rethrow(cause)
}

function rethrowProcessFault(cause: unknown): never {
  if (cause instanceof Error) {
    throw cause
  }
  throw new Error(String(cause))
}

function logProcessFault(kind: RelayProcessFaultKind, cause: unknown, detail: Record<string, unknown>, disposition: string): void {
  const errorText = cause instanceof Error ? cause.stack ?? cause.message : String(cause)
  const message = `[opencode-browser relay] ${kind}; ${disposition}\n${errorText}`
  console.error(message)
  if (process.env.OPENCODE_BROWSER_MANAGED_RELAY === "1") appendManagedRelayProcessLog(message)
  if (debugEnvironmentEnabled(process.env.OPENCODE_BROWSER_DEBUG)) {
    console.error(`[opencode-browser relay] ${kind} detail`, detail)
  }
}

function debugEnvironmentEnabled(value: string | undefined): boolean {
  return value !== undefined && ["1", "true", "yes", "on"].includes(value.toLowerCase())
}

const makeRelay = Effect.fnUntraced(function* (options: {
  readonly port?: number
  readonly releaseTargetGraceMs?: number
  readonly sessionCatalogPath?: string | null
  readonly additionalExtensionOrigins?: readonly string[]
} = {}) {
  const host = defaultHost
  const port = options.port ?? defaultPort
  const releaseTargetGraceMs = Math.max(0, options.releaseTargetGraceMs ?? 10_000)
  const browserId = crypto.randomUUID()
  const endpointUrl = `http://${formatHostForUrl(host)}:${port}`
  // Every build, from source too, accepts only the store and unpacked IDs plus OPENCODE_BROWSER_EXTENSION_ORIGINS.
  const additionalChromeExtensionOrigins = new Set(options.additionalExtensionOrigins ?? [])
  const sessionCatalog = options.sessionCatalogPath === null
    ? undefined
    : new SessionCatalog(options.sessionCatalogPath ?? defaultSessionCatalogPath(port))
  let catalogWritesEnabled = false
  const registry = new TargetRegistry()
  type TabGroupingMethod = "tabs.group" | "tabs.ungroup"
  const pendingTabGrouping = new Map<number, TabGroupingMethod>()
  const tabGroupingWorkers = new Map<number, Promise<void>>()
  const authToken = yield* Effect.try({
    try: () => {
      ensurePrivateDirectory()
      return relayToken()
    },
    catch: (cause) => new Error("Create the relay token", { cause }),
  })
  let extensionGeneration = 0
  let rejectedExtensionConnections = 0
  /** Extension connections that failed the pairing handshake (wrong code, or an extension without one). */
  let pairingFailures = 0
  /** An extension too old to pair is reloaded once, so an unpacked install picks up the new files on disk. */
  let legacyExtensionReloaded = false
  let extensionBuild: string | undefined
  let extensionOrigin: string | undefined
  const extensionRpc = new ExtensionRpc()
  const sendToExtension = (command: Parameters<ExtensionRpc["send"]>[0]) => extensionRpc.send(command)
  const sendExtensionBestEffort = (command: Parameters<ExtensionRpc["send"]>[0]): void => {
    Effect.runPromise(Effect.ignore(sendToExtension(command))).catch(() => {})
  }
  const sendDebuggerCommand = Effect.fnUntraced(function* (options: {
    readonly tabId: number
    readonly sessionId?: string
    readonly method: string
    readonly params: JsonObject
  }) {
    const finishDisable = options.method === "Runtime.disable" ? cdpRuntime.beginDisable(options.tabId, options.sessionId) : undefined
    return yield* sendToExtension({
      method: "debugger.sendCommand",
      params: {
        tabId: options.tabId,
        method: options.method,
        params: options.params,
        ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
      },
    }).pipe(Effect.ensuring(Effect.sync(() => { finishDisable?.() })))
  })
  const recordingRelay = new RecordingRelay({
    sendToExtension: (command) => {
      return Effect.runPromise(extensionRpc.send(command))
    },
    sendDebuggerCommand: (command) => {
      return Effect.runPromise(sendDebuggerCommand(command))
    },
    isExtensionConnected: () => {
      return extensionRpc.connected
    },
    isTabUnavailable: (tabId) => flightRecorder.isActiveTab(tabId),
    onTabRecordingChanged: (tabId) => recordingChanged(tabId),
  })
  const flightRecorder = new FlightRecorderRelay({
    sendDebuggerCommand: (command) => Effect.runPromise(sendDebuggerCommand(command)),
    isExtensionConnected: () => extensionRpc.connected,
    isTabRecording: (tabId) => recordingRelay.isRecordingTab(tabId),
    onTabRecordingChanged: (tabId) => recordingChanged(tabId),
  })
  const isTabRecorded = (tabId: number) => recordingRelay.isRecordingTab(tabId) || flightRecorder.isActiveTab(tabId)
  /** A waiting handoff's card leaves the page while it is recorded (the extension notifies instead), and returns after. */
  const recordingChanged = async (tabId: number): Promise<void> => {
    const pending = handoffs.pendingForTab(tabId)
    const target = registry.tabTargets.get(tabId)
    if (!pending || !target) return
    await Effect.runPromise(Effect.ignore(sendPageStatusEffect(target, "waiting", { sessionId: pending.sessionId, message: pending.message, handoffId: pending.id })))
  }
  const handoffs = new HandoffRegistry()
  const activeHandoffTabs = new Map<string, Set<number>>()
  const clearLiveExtensionState = (reason: string) => {
    void recordingRelay.cleanupAll(reason).catch(() => {})
    void flightRecorder.cleanupAll().catch(() => {})
    pendingTabGrouping.clear()
    for (const target of [...registry.listRootTargets()]) {
      detachTargetState(target.tabId, { preserveSessionTarget: true, updateExtension: false })
    }
    registry.clear()
    suppressedChildSessions.clear()
  }
  const releaseRelayTarget = Effect.fnUntraced(function* (targetId: string) {
    const deadline = (yield* Clock.currentTimeMillis) + releaseTargetGraceMs
    while (true) {
      const target = registry.targetsByTargetId.get(targetId)
      if (target && (extensionRpc.connected || extensionRpc.protocolLegacy === true)) {
        yield* sendToExtension({ method: "tabs.remove", params: { tabId: target.tabId } })
        return
      }
      // Protocol v1 reports ready only after its complete attached-tab inventory
      // has reconciled. Legacy shims need the full grace because hello came first.
      if (extensionRpc.connected && extensionRpc.protocolLegacy === false) return
      const remaining = deadline - (yield* Clock.currentTimeMillis)
      if (remaining <= 0) return
      yield* Effect.sleep(Math.min(50, remaining))
    }
  })
  const journalBaseDir = defaultJournalBaseDir()
  let stopJournalRetention: (() => void) | undefined
  const attachedBadge = { text: "ON", color: "#7c3aed", title: "Detach from OpenCode Browser" }
  const executingBadge = { text: "RUN", color: "#f59e0b", title: "OpenCode Browser is running a script. Click to stop it and take this tab back." }
  const waitingBadge = (message: string) => ({ text: "WAIT", color: "#2563eb", title: `OpenCode Browser is waiting for you: ${message} Click here when you're done.` })
  const executionBadge = (sessionId: string, executing: boolean) => executing && !sessions.isReadOnly(sessionId) ? executingBadge : attachedBadge
  const setActivityForSessionTabs = (
    opencodeBrowserSessionId: string,
    state: PageStatus["state"],
    badge: { readonly text: string; readonly color: string; readonly title: string },
  ) => {
    for (const target of registry.listRootTargets()) {
      if (pageStatusSessionId(target) !== opencodeBrowserSessionId) {
        continue
      }
      // Best-effort: older shims without action.setBadge just reject the command.
      sendExtensionBestEffort({ method: "action.setBadge", params: { tabId: target.tabId, ...badge } })
      sendPageStatus(target, state)
    }
  }
  const setActivityForTarget = (
    target: ConnectedTarget,
    state: PageStatus["state"],
    badge: { readonly text: string; readonly color: string; readonly title: string },
    options: { readonly sessionId?: string; readonly message?: string; readonly handoffId?: string } = {},
  ) => {
    sendExtensionBestEffort({ method: "action.setBadge", params: { tabId: target.tabId, ...badge } })
    sendPageStatus(target, state, options)
  }
  const setActivityForTargetAcknowledged = async (
    target: ConnectedTarget,
    state: PageStatus["state"],
    badge: { readonly text: string; readonly color: string; readonly title: string },
    options: { readonly sessionId?: string; readonly message?: string; readonly handoffId?: string } = {},
  ): Promise<void> => {
    sendExtensionBestEffort({ method: "action.setBadge", params: { tabId: target.tabId, ...badge } })
    await Effect.runPromise(sendPageStatusEffect(target, state, options))
  }
  const removeActiveHandoffTab = (sessionId: string, tabId: number): void => {
    const tabIds = activeHandoffTabs.get(sessionId)
    if (!tabIds) {
      return
    }
    tabIds.delete(tabId)
    if (tabIds.size === 0) {
      activeHandoffTabs.delete(sessionId)
    }
  }
  const cancelTargetHandoffs = (target: ConnectedTarget, reason: HandoffCancellationReason): void => {
    const cancelled = handoffs.cancelForTarget({
      targetId: target.targetInfo.targetId,
      targetSessionId: target.sessionId,
      reason,
    })
    for (const pending of cancelled) {
      removeActiveHandoffTab(pending.sessionId, pending.tabId)
    }
  }
  const requestHandoff = async (options: {
    readonly sessionId: string
    readonly message: string
    readonly timeoutMs: number
    readonly target: HandoffPageTarget
    readonly start?: () => unknown | Promise<unknown>
    readonly cancelStart?: () => Promise<void>
  }): Promise<HandoffOutcome> => {
    const target = resolveHandoffTarget(options.sessionId, options.target)
    const sessionTabs = activeHandoffTabs.get(options.sessionId) ?? new Set<number>()
    sessionTabs.add(target.tabId)
    activeHandoffTabs.set(options.sessionId, sessionTabs)
    const wait = handoffs.wait({
      sessionId: options.sessionId,
      tabId: target.tabId,
      targetId: target.targetInfo.targetId,
      targetSessionId: target.sessionId,
      message: options.message,
      timeoutMs: options.timeoutMs,
    })
    let outcome: HandoffOutcome | undefined
    try {
      outcome = await awaitHandoffAction({
        wait,
        present: () => setActivityForTargetAcknowledged(target, "waiting", waitingBadge(options.message), {
          sessionId: options.sessionId,
          message: options.message,
          handoffId: wait.id,
        }),
        ...(options.start ? { start: options.start } : {}),
        ...(options.cancelStart ? { cancelStart: options.cancelStart } : {}),
      })
      return outcome
    } catch (error) {
      wait.cancel()
      removeActiveHandoffTab(options.sessionId, target.tabId)
      throw error
    } finally {
      if (outcome !== undefined && outcome !== "resolved" && outcome !== "timeout") {
        removeActiveHandoffTab(options.sessionId, target.tabId)
      }
      const currentTarget = registry.tabTargets.get(target.tabId)
      if (currentTarget) {
        if (outcome !== undefined && outcome !== "resolved" && outcome !== "timeout") {
          refreshPageStatus(currentTarget.tabId)
        } else {
          const executing = sessions.isExecuting(options.sessionId)
          setActivityForTarget(currentTarget, executing ? "running" : "attached", executionBadge(options.sessionId, executing), { sessionId: options.sessionId })
        }
      }
    }
  }
  const sessions: OpenCodeBrowserSessions = new OpenCodeBrowserSessions(
    endpointUrl,
    (id, onDefaultTargetChange) =>
      new ExecuteSandbox({
        endpointUrl,
        authToken,
        sessionId: id,
        onDefaultTargetChange,
        isRecordingTarget: (targetId) => {
          const target = registry.targetsByTargetId.get(targetId)
          return target !== undefined && isTabRecorded(target.tabId)
        },
        requestHandoff: ({ message, timeoutMs, target, start, cancelStart }) => requestHandoff({
          sessionId: id,
          message,
          timeoutMs,
          target,
          ...(start ? { start } : {}),
          ...(cancelStart ? { cancelStart } : {}),
        }),
      }),
    {
      onExecuteStateChange: (sessionId, executing) => {
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
      },
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
      onTargetOwnershipChange: (change) => {
        reconcileTargetOwnership(change)
      },
      onReleaseRelayTarget: (targetId) => releaseRelayTarget(targetId),
      onCancelSessionHandoff: (sessionId) => handoffs.cancelForSession(sessionId) !== undefined,
      onSessionsChanged: async (entries) => {
        if (catalogWritesEnabled) await sessionCatalog?.save(entries)
      },
    },
    registry,
  )
  function pageStatusSessionId(target: ConnectedTarget): string | undefined {
    return target.opencodeBrowserSessionId
  }

  function activeHandoffSessionIdForTab(tabId: number): string | undefined {
    return Array.from(activeHandoffTabs.entries()).find(([, tabIds]) => tabIds.has(tabId))?.[0]
  }

  function resolveHandoffTarget(sessionId: string, selectedPage: HandoffPageTarget): ConnectedTarget {
    return resolveExactHandoffTarget({
      targetId: selectedPage.targetId,
      targets: registry.listRootTargets(),
      isVisible: (target) => cdpRouter.canSessionSeeTarget(sessionId, target),
    })
  }

  function sendPageStatusEffect(
    target: ConnectedTarget,
    state: PageStatus["state"],
    options: { readonly sessionId?: string; readonly message?: string; readonly handoffId?: string } = {},
  ): Effect.Effect<void, Error> {
    const sessionId = options.sessionId ?? pageStatusSessionId(target)
    const status = makePageStatus({
      state,
      targetOwner: target.owner,
      ...(sessionId ? { sessionId, readOnly: sessions.isReadOnly(sessionId) } : {}),
      ...(options.message ? { message: options.message } : {}),
      ...(options.handoffId ? { handoffId: options.handoffId } : {}),
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
    options: { readonly sessionId?: string; readonly message?: string; readonly handoffId?: string } = {},
  ): void {
    Effect.runPromise(Effect.ignore(sendPageStatusEffect(target, state, options))).catch(() => {})
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
    sendPageStatus(target, sessionId && sessions.isExecuting(sessionId) ? "running" : "attached", sessionId ? { sessionId } : {})
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
  const managed = yield* Config.Boolean("OPENCODE_BROWSER_MANAGED_RELAY").pipe(Config.withDefault(false))
  const restartTimeoutMs = yield* Config.Int("OPENCODE_BROWSER_RESTART_TIMEOUT_MS").pipe(Config.withDefault(10_000))
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
      if (Array.from(cdpClients).some((client) => !cdpClients.isSandbox(client))) return "raw-clients"
      if (recordingRelay.hasActiveRecordings() || flightRecorder.hasActiveRecorders() || sessions.hasActiveNetworkCapture()) return "recordings"
      return undefined
    },
    settle: settleRootWork(),
    quiescent: () => rootLifecycle.isIdle() && sessions.isDrained(),
    audit,
    stop: () => { setImmediate(() => process.kill(process.pid, "SIGTERM")) },
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
    reloadExtension: () => sendToExtension({ method: "runtime.reload" }),
    cleanupTabs: (idleMinutes) =>
      sendToExtension({ method: "tabs.cleanup", ...(idleMinutes === undefined ? {} : { params: { idleMinutes } }) }),
    extensionStatus: () => {
      return {
        connected: extensionRpc.connected,
        version: extensionRpc.version ?? null,
        build: extensionBuild ?? null,
        origin: extensionOrigin ?? null,
        protocolVersion: extensionRpc.protocolVersion ?? null,
        protocolCompatible: extensionRpc.protocolCompatible ?? null,
        protocolLegacy: extensionRpc.protocolLegacy ?? null,
        rejectedConnections: rejectedExtensionConnections,
        pairingFailures,
        cdpClients: cdpClients.size,
        processFaults: relayProcessFaultSummary(),
      }
    },
  })
  let relayReady = false
  const httpServer = http.createServer((request, response) => {
    if (!relayReady) {
      response.writeHead(503, { "content-type": "application/json; charset=utf-8", "retry-after": "1" })
      response.end(JSON.stringify({ error: "OpenCode Browser relay is starting", code: "relay-starting" }))
      return
    }
    const started = performance.now()
    response.once("finish", () => {
      const pathname = (request.url ?? "").split("?")[0]
      // Health, version, and connection polls (every 200ms while a client waits) are frequent and uninteresting.
      if (pathname === "/version" || pathname === "/json/version" || pathname === "/json/version/" || pathname === "/extension/status") return
      relayLog("http", { method: request.method, path: pathname, status: response.statusCode, ms: Math.round(performance.now() - started) })
    })
    relayRequestHandler(request, response)
  })
  // Handoffs and secrets run commands legitimately outlive Node's 5-minute default request timeout.
  httpServer.requestTimeout = 0
  httpServer.timeout = 0
  // listenHttpServer handles errors only until the server listens; later ones (EMFILE on accept) would otherwise be
  // unhandled and crash the relay.
  httpServer.on("error", (error) => relayLog("http.error", { error: error.message, code: (error as NodeJS.ErrnoException).code }))

  const debugEnabled = yield* Config.Boolean("OPENCODE_BROWSER_DEBUG").pipe(Config.withDefault(false))
  const debugLog = debugEnabled ? (line: string) => console.error(`[bc ${new Date().toISOString().slice(11, 23)}] ${line}`) : undefined
  const contextDebugLog = debugLog ? (line: string) => debugLog(`[bc:ctx] ${line}`) : undefined
  // ws defaults to 100 MiB and closes a socket that sends more. Playwright's own CDP client accepts 256 MiB (large
  // screenshots and response bodies come close), so the relay does too.
  const websocketServer = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 * 1024 })
  const cdpClients = new CdpClientPool<WebSocket>(
    (client, event) => cdpRuntime.deliver(client, event),
    (client, sessionId) => cdpRuntime.detach(client, sessionId),
  )
  const cdpRouter = new CdpRouter(cdpClients, registry)
  const cdpRuntime = new CdpRuntime<WebSocket>({
    registry,
    generation: () => extensionGeneration,
    send: sendDebuggerCommand,
    sendEvent: sendCdpEvent,
    ...(contextDebugLog ? { trace: contextDebugLog } : {}),
  })
  const mainFrameIdsByTab = new Map<number, string>()
  /** Page.navigate to a data: URL waits for its tab's main frame to commit the about:blank document it writes into. */
  const blankNavigationWaiters = new Map<number, (url: string, loaderId: string | undefined) => void>()
  // Off by default: pages can detect an injected cursor, and recordings should show only the page. A recording or
  // flight recorder started with cursor: true shows it (demo videos), as do showGhostCursor() and the env var.
  const ghostCursorByDefault = yield* Config.Boolean("OPENCODE_BROWSER_GHOST_CURSOR").pipe(Config.withDefault(false))
  const ghostCursor = new GhostCursorTabs({
    send: sendDebuggerCommand,
    mainFrameId: (tabId) => mainFrameIdsByTab.get(tabId),
    shownByDefault: (tabId) => ghostCursorByDefault || recordingRelay.showsGhostCursor(tabId) || flightRecorder.showsGhostCursor(tabId),
  })
  const suppressedChildSessions = new Map<string, number>()
  const protectedFrames = new ProtectedFrameTracker()

  function setProtectedUi(tabId: number, protectedUi: boolean): void {
    const changed = registry.markRootTargetProtectedUi(tabId, protectedUi)
    if (!changed) return
    contextDebugLog?.(`protected-ui blocked=${protectedUi} ${targetDiagnosticIdentity(changed)}`)
    sessions.markTargetProtectedUi(changed.targetInfo.targetId, protectedUi)
  }

  /** Hide a protected frame from clients that already saw it attach. */
  function retractProtectedFrame(target: ConnectedTarget, frameId: string, url: string | undefined): void {
    contextDebugLog?.(`protected-frame frame=${boundedToken(frameId)} ${targetDiagnosticIdentity(target)} ${summarizeDiagnosticUrl(url)}`)
    sendEventToTargetViewers(target.sessionId, { method: "Page.frameDetached", params: { frameId, reason: "remove" }, sessionId: target.sessionId })
  }

  function forgetProtectedFrames(tabId: number): void {
    protectedFrames.forgetTab(tabId)
    setProtectedUi(tabId, false)
  }

  function targetDiagnosticIdentity(target: ConnectedTarget | ChildTarget | undefined): string {
    if (!target) {
      return "target=unknown"
    }
    const root = registry.tabTargets.get(target.tabId)
    const isRoot = "owner" in target
    return [
      `tab=${target.tabId}`,
      `target=${boundedToken(target.targetInfo.targetId)}`,
      `cdpSession=${boundedToken(target.sessionId)}`,
      `owner=${isRoot ? target.owner : root?.owner ?? "child"}`,
      `bcSession=${boundedToken(isRoot ? target.opencodeBrowserSessionId : root?.opencodeBrowserSessionId)}`,
      `browserContext=${boundedToken(target.targetInfo.browserContextId ?? root?.targetInfo.browserContextId)}`,
    ].join(" ")
  }

  function targetForCdpSession(tabId: number, sessionId: string | undefined): ConnectedTarget | ChildTarget | undefined {
    if (sessionId) {
      return registry.targets.get(sessionId) ?? registry.childTargets.get(sessionId) ?? registry.tabTargets.get(tabId)
    }
    return registry.tabTargets.get(tabId)
  }

  function diagnosticTargetForClient(socket: WebSocket, sessionId: string | undefined): ConnectedTarget | ChildTarget | undefined {
    return sessionId
      ? cdpRouter.targetInfo(socket, { sessionId })
      : cdpRouter.preferredRoot(socket)
  }

  function isRuntimeEvaluationMethod(method: string): boolean {
    return method === "Runtime.evaluate" || method === "Runtime.callFunctionOn"
  }

  const cleanup = Effect.fnUntraced(function* () {
    stopJournalRetention?.()
    yield* shutdownControl.close().pipe(Effect.ignore)
    yield* sessions.closeAll()
    yield* rootLifecycle.close()
    if (managed) {
      yield* audit(RelayLifecycleEvent.cases.Closed.make({ instanceId: browserId })).pipe(
        Effect.catch(() => Effect.sync(() => console.error("Failed to record relay shutdown lifecycle event"))),
      )
    }
    handoffs.cancelAll()
    extensionRpc.rejectPending(new Error("Relay closed"))
    yield* Effect.tryPromise(() => recordingRelay.cleanupAll("Relay closed")).pipe(Effect.ignore)
    yield* Effect.tryPromise(() => flightRecorder.cleanupAll()).pipe(Effect.ignore)
    for (const socket of cdpClients) {
      socket.close()
    }
    extensionRpc.close()
    yield* closeWebSocketServer(websocketServer).pipe(logCloseError("Failed to close websocket server"))
    yield* closeHttpServer(httpServer).pipe(logCloseError("Failed to close http server"))
  })

  httpServer.on("upgrade", (request, socket, head) => {
    if (!relayReady) {
      sendUpgradeError({ socket, status: 404, message: "OpenCode Browser relay is starting" })
      return
    }
    const hostError = validateHostHeader({ hostHeader: request.headers.host, host, port })
    if (hostError) {
      sendUpgradeError({ socket, status: 403, message: hostError })
      return
    }
    const requestUrl = new URL(request.url ?? "/", endpointUrl)
    const origin = Array.isArray(request.headers.origin) ? request.headers.origin[0] : request.headers.origin
    if (requestUrl.pathname === "/extension") {
      // The extension proves itself with the pairing handshake once connected; there is no token for it.
      const originError = validateWebSocketOrigin({
        origin,
        requireChromeExtension: true,
        additionalChromeExtensionOrigins,
      })
      if (originError) {
        sendUpgradeError({ socket, status: 403, message: originError })
        return
      }
      websocketServer.handleUpgrade(request, socket, head, (websocket) => {
        websocketServer.emit("connection", websocket, request)
      })
      return
    }
    if (!hasRelayToken(request, authToken) && !secretsEqual(authToken, requestUrl.searchParams.get(relayTokenQueryParam) ?? undefined)) {
      sendUpgradeError({ socket, status: 401, message: "Missing or invalid OpenCode Browser relay token" })
      return
    }
    if (requestUrl.pathname.startsWith("/devtools/browser/")) {
      const sessionId = requestUrl.searchParams.get("opencodeBrowserSessionId") ?? headerValue(request.headers["opencode-browser-session-id"])
      if (!shutdownControl.accepting && (headerValue(request.headers["opencode-browser-client-kind"]) !== "sandbox" || !sessionId || !sessions.hasPendingWork(sessionId))) {
        sendUpgradeError({ socket, status: 503, message: "Relay is draining for an explicit restart" })
        return
      }
      const originError = validateWebSocketOrigin({ origin, additionalChromeExtensionOrigins })
      if (originError) {
        sendUpgradeError({ socket, status: 403, message: originError })
        return
      }
      websocketServer.handleUpgrade(request, socket, head, (websocket) => {
        websocketServer.emit("connection", websocket, request)
      })
      return
    }
    socket.destroy()
  })

  let currentAnnouncedRootTabIds: Set<number> | undefined
  websocketServer.on("connection", (socket, request) => {
    const requestUrl = new URL(request.url ?? "/", endpointUrl)
    if (requestUrl.pathname === "/extension") {
      let handshaken = false
      let socketGeneration = 0
      const announcedRootTabIds = new Set<number>()
      // Pairing: the extension's hello carries a nonce; the relay answers with its own nonce and an HMAC proving it
      // knows the pairing code; the extension answers with its proof. Only then does the relay treat the socket as the
      // extension (and the extension obey it).
      let challenge: { readonly hello: JsonObject; readonly extensionNonce: string; readonly relayNonce: string; readonly code: string } | undefined
      socket.on("message", (data, isBinary) => {
        try {
          if (!handshaken) {
            if (socket.readyState !== WebSocket.OPEN) return
            const message = isBinary ? undefined : parseJsonObject(data.toString())
            if (!message || !isExtensionEvent(message)) {
              socket.close(4002, "Extension hello required")
              return
            }
            if (!challenge) {
              challenge = challengeExtension(socket, message, headerValue(request.headers.origin))
              return
            }
            const proof = message.method === "auth.response" ? getString(message.params, "proof") : undefined
            if (!secretsEqual(pairingProof(challenge.code, "extension", port, challenge.extensionNonce, challenge.relayNonce), proof)) {
              pairingFailures += 1
              relayLog("extension.rejected", { reason: "pairing failed", profile: getString(getObject(challenge.hello.params), "profileName") })
              socket.close(4006, "Pairing failed: the extension's pairing code does not match this relay")
              return
            }
            const acceptedGeneration = acceptExtensionHello(socket, challenge.hello, headerValue(request.headers.origin))
            if (acceptedGeneration === undefined) {
              socket.close(4002, "Extension hello required")
              return
            }
            socketGeneration = acceptedGeneration
            handshaken = true
            // Only a paired extension that became the current link names the tabs it announces; an unpaired socket
            // (or one refused for another active link) must not replace the live inventory.
            if (extensionRpc.isCurrent(socket)) currentAnnouncedRootTabIds = announcedRootTabIds
            return
          }
          if (!extensionRpc.isCurrent(socket) || !extensionRpc.acceptsEvents) {
            return
          }
          if (isBinary) {
            try {
              recordingRelay.handleBinaryData(rawDataToBuffer(data))
            } catch {
              socket.close(1002, "Invalid recording frame")
            }
            return
          }
          handleExtensionMessage(socket, data.toString(), socketGeneration, announcedRootTabIds)
        } catch (error) {
          console.error("Extension message handling failed", error)
        }
      })
      // ws reports an oversized or malformed frame as an "error" on the socket and then closes it. Without a listener
      // Node treats the event as unhandled and the relay crashes (and keeps crashing while the extension retries).
      socket.on("error", (error) => {
        relayLog("extension.error", { error: error.message, code: (error as NodeJS.ErrnoException).code })
      })
      socket.on("close", (code, reason) => {
        relayLog("extension.close", { code, reason: reason.toString() || undefined, current: extensionRpc.isCurrent(socket) })
        if (extensionRpc.disconnectIfCurrent(socket)) {
          rejectedExtensionConnections = 0
          clearLiveExtensionState("Extension disconnected")
        }
      })
      return
    }

    const opencodeBrowserSessionId = requestUrl.searchParams.get("opencodeBrowserSessionId") ?? headerValue(request.headers["opencode-browser-session-id"])
    cdpClients.register(socket, opencodeBrowserSessionId, headerValue(request.headers["opencode-browser-client-kind"]) === "sandbox" ? "sandbox" : "raw")
    debugLog?.(`client+ ${opencodeBrowserSessionId ?? "raw"} total=${cdpClients.size}`)
    socket.on("message", (data) => {
      Effect.runPromise(shutdownControl.trackTransport(handleCdpMessage(socket, data.toString()))).catch((error: unknown) => {
        sendCdpResponse(socket, {
          id: 0,
          error: { message: error instanceof Error ? error.message : String(error) },
        })
      })
    })
    socket.on("error", (error) => {
      relayLog("client.error", { session: cdpClients.sessionId(socket), error: error.message, code: (error as NodeJS.ErrnoException).code })
    })
    socket.on("close", () => {
      debugLog?.(`client- ${cdpClients.sessionId(socket) ?? "raw"} total=${cdpClients.size - 1}`)
      cdpRuntime.disconnect(socket)
      const idleGeneration = cdpClients.unregister(socket)
      if (idleGeneration !== undefined && !shutdownControl.stopping) {
        Effect.runPromise(shutdownControl.trackTransport(cdpRuntime.disableIdle(() => cdpClients.isCurrentIdleGeneration(idleGeneration))).pipe(Effect.ignore)).catch((error: unknown) => {
          console.error("Failed to reset idle runtime domains", error)
        })
      }
    })
  })

  const close = cleanup()

  const closeTargetByTargetId = Effect.fnUntraced(function* (targetId: string) {
    const target = registry.targetsByTargetId.get(targetId)
    if (!target) {
      return
    }
    // Only tabs agents opened close; a user's tab is released.
    if (target.owner === "user") return yield* detachTab(target.tabId)
    yield* sendToExtension({ method: "tabs.remove", params: { tabId: target.tabId } })
    detachTargetState(target.tabId)
  })

  /** Answers the extension's hello with the relay's pairing proof; undefined when the socket was closed instead. */
  function challengeExtension(socket: WebSocket, message: JsonObject, origin: string | undefined): { readonly hello: JsonObject; readonly extensionNonce: string; readonly relayNonce: string; readonly code: string } | undefined {
    if (message.method !== "hello") {
      socket.close(4002, "Extension hello required")
      return undefined
    }
    const extensionNonce = getString(getObject(getObject(message.params)?.pairing), "nonce")
    if (extensionNonce === undefined) {
      pairingFailures += 1
      relayLog("extension.rejected", { reason: "no pairing (extension too old)", version: getString(getObject(message.params), "version") })
      // An unpacked extension older than pairing reloads once, picking up the files install just wrote. The command
      // carries nothing; the relay never trusts this socket.
      if (!legacyExtensionReloaded && origin === stableUnpackedExtensionOrigin) {
        legacyExtensionReloaded = true
        socket.send(JSON.stringify({ id: 0, method: "runtime.reload" }))
      }
      socket.close(4005, "Pairing required: update OpenCode Browser")
      return undefined
    }
    if (!/^[A-Za-z0-9_-]{22,128}$/.test(extensionNonce)) {
      socket.close(4002, "Invalid pairing nonce")
      return undefined
    }
    let code: string
    try {
      code = pairingCode()
    } catch (error) {
      relayLog("extension.rejected", { reason: "pairing code unavailable", error: error instanceof Error ? error.message : String(error) })
      socket.close(1011, "Relay pairing code unavailable")
      return undefined
    }
    const relayNonce = crypto.randomBytes(32).toString("base64url")
    socket.send(JSON.stringify({
      method: "auth.challenge",
      params: { nonce: relayNonce, proof: pairingProof(code, "relay", port, relayNonce, extensionNonce) },
    }))
    return { hello: message, extensionNonce, relayNonce, code }
  }

  function acceptExtensionHello(socket: WebSocket, message: JsonObject, origin: string | undefined): number | undefined {
    if (!isExtensionEvent(message) || message.method !== "hello") {
      return undefined
    }
    const protocol = extensionProtocolCompatibility(message.params?.protocolVersion)
    if (!protocol.compatible && extensionRpc.protocolCompatible === true) {
      relayLog("extension.rejected", { reason: "incompatible", protocol: protocol.version, version: getString(getObject(message.params), "version") })
      socket.close(4003, "Extension protocol incompatible")
      return extensionGeneration
    }
    // Protect an OPEN compatible connection, including its inventory handshake.
    // Competing browser retries must not erase targets, handoffs, or pending RPCs.
    if (extensionRpc.acceptsEvents) {
      rejectedExtensionConnections += 1
      relayLog("extension.rejected", { reason: "another connection is active", profile: getString(message.params, "profileName") })
      extensionRpc.probeLiveness()
      socket.close(4004, "Another browser or profile is already connected")
      return extensionGeneration
    }
    extensionGeneration += 1
    rejectedExtensionConnections = 0
    clearLiveExtensionState("Extension replaced")
    extensionRpc.replaceSocket(socket)
    extensionRpc.markHandshake(
      getString(message.params, "version"),
      message.params?.protocolVersion,
    )
    extensionBuild = getString(message.params, "build")
    extensionOrigin = origin
    relayLog("extension.connected", {
      version: getString(message.params, "version"),
      build: getString(message.params, "build"),
      protocol: protocol.version,
      profile: getString(message.params, "profileName"),
      generation: extensionGeneration,
    })
    return extensionGeneration
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
    Effect.runPromise(sendDebuggerCommand({
      tabId,
      ...(parentSessionId === undefined ? {} : { sessionId: parentSessionId }),
      method: "Target.detachFromTarget",
      params: { sessionId: childSessionId },
    }).pipe(Effect.ignore)).catch(() => {})
  }

  /**
   * A tab the page in an attached tab opened. When the opener belongs to a session (an agent's tab, or a lent tab
   * while its session runs a script, so a user's own click in their tab stays theirs), the new tab joins that session
   * as a relay-owned page. Clients get it with openerId set to the opener's target, so Playwright reports it as the
   * opener's popup and lists it in context.pages().
   */
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
    currentAnnouncedRootTabIds?.add(tabId)
    Effect.runPromise(rootLifecycle.attach({
      tabId,
      owner: "relay",
      opencodeBrowserSessionId: sessionId,
      openerTargetId: opener.targetInfo.targetId,
      ...(autoAttachParams ? { autoAttachParams } : {}),
    })).catch((error: unknown) => {
      relayLog("tab.opened.error", { tabId, error: error instanceof Error ? error.message : String(error) })
    })
  }

  function handleExtensionMessage(socket: WebSocket, raw: string, generation: number, announcedRootTabIds: Set<number>): void {
    const message = parseJsonObject(raw)
    if (isExtensionResponse(message)) {
      extensionRpc.handleResponse(message)
      return
    }

    if (!isExtensionEvent(message)) {
      return
    }
    const extensionMethod = message.method as string
    const eventTabId = getNumber(message.params, "tabId")
    if (extensionMethod === "hello") {
      return
    }
    if (extensionMethod === "log") {
      const text = getString(message.params, "message")
      if (!text) return
      const level = message.params?.level === "error" || message.params?.level === "warn" ? message.params.level : "log"
      console[level](`[opencode-browser extension] ${text}`)
      return
    }
    if (extensionMethod === "ready") {
      void Effect.runPromise(rootLifecycle.settle(generation)).then((reconciled) => {
        if (!extensionRpc.isCurrent(socket) || generation !== extensionGeneration) return
        if (reconciled) {
          for (const target of registry.listRootTargets()) {
            if (!announcedRootTabIds.has(target.tabId)) detachTargetState(target.tabId)
          }
          extensionRpc.markReady()
          for (const target of registry.listRootTargets()) refreshTabGrouping(target.tabId)
        } else {
          socket.close(1011, "Target inventory reconciliation failed")
        }
      })
      return
    }
    if (extensionMethod === "debugger.attached") {
      if (eventTabId) {
        announcedRootTabIds.add(eventTabId)
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
        if (completed) {
          refreshPageStatus(target.tabId)
        }
      }
      return
    }
    if (extensionMethod === "pageStatus.requested") {
      if (eventTabId) {
        refreshPageStatus(eventTabId)
      }
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
          rootLifecycle.queue({ tabId: eventTabId, attachIfMissing: false, verificationRetries: 3, errorMessage: "Failed to reconcile ambiguous debugger detach" })
        }
        return
      }
      if (eventTabId) {
        detachTargetState(eventTabId)
      }
      return
    }
    if (extensionMethod === "tabs.opened") {
      const openerTabId = getNumber(message.params, "openerTabId")
      if (eventTabId && openerTabId) adoptOpenedTab(eventTabId, openerTabId)
      return
    }
    if (extensionMethod === "tabs.removed") {
      if (eventTabId) {
        detachTargetState(eventTabId)
      }
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
    if (!target) {
      return
    }
    const method = getString(message.params, "method") ?? ""
    const params = getObject(message.params?.params)
    const sourceSessionId = getString(message.params, "sessionId")
    debugLog?.(`evt tab=${tabId} ${method} src=${sourceSessionId ?? "root"}`)
    const sourceChild = sourceSessionId ? registry.childTargets.get(sourceSessionId) : undefined
    if (sourceSessionId && sourceSessionId !== target.sessionId && !sourceChild) {
      return
    }
    if (
      sourceSessionId &&
      method !== "Target.attachedToTarget" &&
      method !== "Target.detachedFromTarget" &&
      method !== "Target.targetInfoChanged" &&
      (suppressedChildSessions.has(sourceSessionId) || (sourceChild && !shouldExposeChildTarget(sourceChild)))
    ) {
      return
    }
    if (flightRecorder.handleDebuggerEvent({ tabId, method, params }) || recordingRelay.handleDebuggerEvent({ tabId, method, params })) {
      return
    }
    let shouldBroadcast = true
    let attachedChildTarget: ChildTarget | undefined

    if ((method === "Inspector.targetCrashed" || method === "Target.targetCrashed") && (sourceSessionId === undefined || sourceSessionId === target.sessionId)) {
      const crashedTarget = registry.markRootTargetCrashed(tabId)
      if (crashedTarget) {
        cancelTargetHandoffs(crashedTarget, "target-crashed")
        const affectedSessions = sessions.markTargetCrashed(crashedTarget.targetInfo.targetId)
        extensionRpc.rejectDebuggerCommandsForTab(tabId, new Error(`Target crashed: ${crashedTarget.targetInfo.targetId}`))
        contextDebugLog?.(`target-crashed ${targetDiagnosticIdentity(crashedTarget)} affectedSessions=${affectedSessions.length}`)
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
          // A popup or window the page opened (target=_blank, window.open). Clients ignore page children, so it
          // becomes a root target of its own once the extension reports its tab (tabs.opened). The opener's
          // auto-attached session lets go of it here, so the new page isn't left paused or shared.
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
        contextDebugLog?.(`target-attached kind=child parentSession=${boundedToken(parentSessionId)} ${targetDiagnosticIdentity(childTarget)} ${summarizeDiagnosticUrl(targetInfo.url)}`)
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
        contextDebugLog?.(`target-detached kind=child ${targetDiagnosticIdentity(registry.childTargets.get(childSessionId))}`)
        detachChildTargetState(childSessionId)
      }
    }
    if (method === "Target.targetInfoChanged") {
      const targetInfo = getTargetInfo(params?.targetInfo)
      if (!targetInfo) {
        return
      }
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
      contextDebugLog?.(`target-info-changed ${targetDiagnosticIdentity(changed.target)} ${summarizeDiagnosticUrl(targetInfo.url)}`)
      if (changed.kind === "child" && !wasExposed && shouldExposeChildTarget(changed.target)) {
        announceAttachedChildTarget(target.sessionId, changed.target)
      }
    } else if (method.startsWith("Target.") && params?.targetInfo !== undefined) {
      const eventTargetInfo = getTargetInfo(params.targetInfo)
      if (!eventTargetInfo || isRestrictedTarget(eventTargetInfo)) {
        return
      }
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
        // Dismissed protected UI lifts Chrome's debugger block for the tab.
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
        if (frameId !== undefined) {
          mainFrameIdsByTab.set(tabId, frameId)
        }
        // The previous document's frames, protected ones included, are gone.
        forgetProtectedFrames(tabId)
        // A visible ghost cursor goes back where it was in the new document.
        Effect.runPromise(Effect.ignore(ghostCursor.documentCreated(tabId))).catch(() => {})
        contextDebugLog?.(`main-frame-navigated frame=${boundedToken(frameId)} loader=${boundedToken(getString(frame, "loaderId"))} ${targetDiagnosticIdentity(target)} ${summarizeDiagnosticUrl(frameUrl)}`)
        registry.updateTargetUrl(tabId, frameUrl)
        blankNavigationWaiters.get(tabId)?.(frameUrl, getString(frame, "loaderId"))
        // Some Chromium builds drop focus emulation across navigations; without it a background tab is throttled.
        Effect.runPromise(Effect.ignore(sendDebuggerCommand({ tabId, method: "Emulation.setFocusEmulationEnabled", params: { enabled: true } }))).catch(() => {})
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
        if (frameId !== undefined) {
          mainFrameIdsByTab.set(tabId, frameId)
        }
        contextDebugLog?.(`main-frame-same-document frame=${boundedToken(frameId)} ${targetDiagnosticIdentity(target)} ${summarizeDiagnosticUrl(url)}`)
        registry.updateTargetUrl(tabId, url)
      }
    }
    if (method === "Page.lifecycleEvent") {
      const frameId = getString(params, "frameId")
      if (frameId && frameId === mainFrameIdsByTab.get(tabId)) {
        contextDebugLog?.(`main-frame-lifecycle name=${boundedToken(getString(params, "name"))} frame=${boundedToken(frameId)} loader=${boundedToken(getString(params, "loaderId"))} ${targetDiagnosticIdentity(target)}`)
      }
    }
    if (method === "Page.frameAttached") {
      const frameId = getString(params, "frameId")
      if (frameId && params) {
        registry.rememberFrameEvent({ tabId, frameId, attached: params })
      }
    }
    if (method === "Page.frameDetached") {
      const frameId = getString(params, "frameId")
      if (frameId) {
        registry.tabFrameEvents.get(tabId)?.delete(frameId)
      }
    }

    const eventSessionId = sourceSessionId ?? target.sessionId
    const event: CdpEvent = { method, ...(params === undefined ? {} : { params }), sessionId: eventSessionId }
    if (method === "Runtime.executionContextCreated") {
      const context = getObject(params?.context)
      const auxData = getObject(context?.auxData)
      const contextTarget = targetForCdpSession(tabId, eventSessionId)
      contextDebugLog?.(`context-created id=${boundedToken(getIdText(context, "id"))} unique=${boundedToken(getString(context, "uniqueId"))} default=${auxData?.isDefault === true} type=${boundedToken(getString(auxData, "type"))} frame=${boundedToken(getString(auxData, "frameId"))} ${targetDiagnosticIdentity(contextTarget)} ${summarizeDiagnosticUrl(getString(context, "origin"))}`)
    } else if (method === "Runtime.executionContextDestroyed") {
      const contextTarget = targetForCdpSession(tabId, eventSessionId)
      contextDebugLog?.(`context-destroyed id=${boundedToken(getIdText(params, "executionContextId"))} unique=${boundedToken(getString(params, "executionContextUniqueId"))} ${targetDiagnosticIdentity(contextTarget)}`)
    } else if (method === "Runtime.executionContextsCleared") {
      contextDebugLog?.(`contexts-cleared ${targetDiagnosticIdentity(targetForCdpSession(tabId, eventSessionId))}`)
    }
    cdpRuntime.notify(event)
    if (attachedChildTarget) {
      announceAttachedChildTarget(target.sessionId, attachedChildTarget)
      return
    }
    if (shouldBroadcast) {
      sendEventToTargetViewers(target.sessionId, event)
    }
  }

  function handleToolbarClick(tabId: number): void {
    const target = registry.tabTargets.get(tabId)
    if (target) {
      const sessionId = pageStatusSessionId(target) ?? activeHandoffSessionIdForTab(tabId)
      const pending = handoffs.pendingForTab(tabId)
      const action = toolbarClickAction({
        handoffPending: pending !== undefined,
        sessionExecuting: sessionId !== undefined && sessions.isExecuting(sessionId),
      })
      if (action === "complete-handoff" && pending) {
        // A click on the browser's own toolbar is the trusted way to say "done": page script can't make one.
        relayLog("handoff.completed", { tabId, from: "toolbar" })
        if (handoffs.complete({ id: pending.id, tabId, targetId: target.targetInfo.targetId, targetSessionId: target.sessionId })) {
          refreshPageStatus(tabId)
        }
        return
      }
      if (action === "stop-execution" && sessionId) {
        relayLog("execute.stopped", { tabId, session: sessionId, from: "toolbar" })
        sessions.stopExecution(sessionId, `The user took tab ${tabId} back (OpenCode Browser toolbar button) while this script ran, so it was stopped. Don't use that tab again unless the user lends it back; ask the user how to continue.`)
      }
    }
    Effect.runPromise(toggleTab(tabId)).catch((error: unknown) => {
      console.error("Toolbar toggle failed", error)
    })
  }

  const handleCdpMessage = Effect.fnUntraced(function* (socket: WebSocket, raw: string) {
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
            contextDebugLog?.(`evaluation-failed method=${message.method} failure=${runtimeFailureKind(error)} client=${boundedToken(cdpClients.sessionId(socket) ?? "raw")} ${targetDiagnosticIdentity(diagnosticTargetForClient(socket, message.sessionId))} ${summarizeRuntimeEvaluate(message.params)}`)
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
            contextDebugLog?.(`evaluation-exception method=${message.method} exceptionId=${boundedToken(getIdText(exceptionDetails, "exceptionId"))} line=${getNumber(exceptionDetails, "lineNumber") ?? "none"} column=${getNumber(exceptionDetails, "columnNumber") ?? "none"} client=${boundedToken(cdpClients.sessionId(socket) ?? "raw")} ${targetDiagnosticIdentity(diagnosticTargetForClient(socket, message.sessionId))} ${summarizeRuntimeEvaluate(message.params)}`)
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

  /** A client can keep using a session only while it still routes to a visible target. */
  function clientRoutesSession(socket: WebSocket, sessionId: string): boolean {
    return socket.readyState === WebSocket.OPEN && cdpRouter.session(socket, sessionId) !== undefined
  }

  /** Canonical sessions may later receive cached Runtime replay; aliases keep the native path. */
  function admitFrameTreeResponse(socket: WebSocket, sessionId: string | undefined): ((result: unknown) => void) | undefined {
    if (sessionId === undefined || !cdpClients.hasSession(socket, sessionId)) return undefined
    const route = cdpRouter.session(socket, sessionId)
    // Detaching the announcement retires the requester through the client pool.
    return route && cdpRuntime.frameTreeResponse(socket, route, () => clientRoutesSession(socket, sessionId))
  }

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
        if (!targetId && !message.sessionId) {
          return {}
        }
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
        // page.close() on a tab the user lent: give it back instead of closing it. Clients see the page close.
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
    if (message.method === ghostCursorCommandMethod) return yield* ghostCursor.command(tabId, message.params)
    if (message.method === "Page.navigate" && route.chromeSessionId === undefined) {
      const dataNavigation = yield* navigateTopFrameToDataUrl(tabId, message.params)
      if (dataNavigation) return dataNavigation
    }
    const command = {
      tabId,
      method: normalizedMessage.method,
      params: normalizedMessage.params ?? {},
      ...(route.chromeSessionId === undefined ? {} : { sessionId: route.chromeSessionId }),
    }
    const sessionId = message.sessionId
    const announced = sessionId !== undefined && cdpClients.hasSession(socket, sessionId)
    // The visible cursor animates while the human-like movement leading up to the event is sent.
    yield* Effect.all([
      applyGhostCursorMouseEvent({ tabId, message }).pipe(Effect.ignore),
      Effect.promise(() =>
        beforeInput(tabId, command.method, command.params, route.chromeSessionId === undefined, (method, params) =>
          Effect.runPromise(sendDebuggerCommand({ ...command, method, params })),
        ).catch(() => undefined),
      ),
    ], { concurrency: "unbounded", discard: true })
    const result = yield* (message.method === "Runtime.enable" && sessionId
      ? cdpRuntime.enable(route, command.params, () => clientRoutesSession(socket, sessionId) && (!announced || cdpClients.hasSession(socket, sessionId)), announced ? socket : undefined)
      : sendDebuggerCommand(command)).pipe(
        // Chrome rejects every command for a tab while another extension's frame
        // is open in it; clients only see the rejection, so record it per tab.
        Effect.tapError((error) => Effect.sync(() => {
          if (runtimeFailureKind(error) === "cross-extension-page") setProtectedUi(tabId, true)
        })),
        Effect.tap(() => Effect.sync(() => setProtectedUi(tabId, false))),
      )
    return scopeCdpResult({ method: message.method, result, pageUrls: () => cdpRouter.visibleRoots(socket).map((target) => target.targetInfo.url) })
  })

  /**
   * Chromium refuses top-frame navigations to data: URLs that an extension starts (chrome.debugger's Page.navigate and
   * chrome.tabs.update both end in ERR_ABORTED), so page.goto("data:...") would always fail. The relay navigates the
   * frame to about:blank instead (which extensions may open, giving a fresh opaque origin like a data: document has)
   * and writes the data URL's content into it with Page.setDocumentContent before answering, with the about:blank
   * document's loader id, so Playwright's goto waits for that document as usual. HTML is written as is; text and
   * JSON appear as preformatted text and images as an image, the way the browser shows them. The page URL stays
   * about:blank. Undefined when this isn't such a navigation or the content type can't be shown; the original
   * command is then forwarded.
   */
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

  const detachTab = Effect.fnUntraced(function* (tabId: number) {
    yield* sendToExtension({ method: "debugger.detach", params: { tabId } })
    detachTargetState(tabId)
    yield* Effect.ignore(sendToExtension({ method: "action.setAttached", params: { tabId, attached: false } }))
  })

  const toggleTab = Effect.fnUntraced(function* (tabId: number) {
    if (registry.tabTargets.has(tabId)) {
      return yield* detachTab(tabId)
    }
    currentAnnouncedRootTabIds?.add(tabId)
    yield* rootLifecycle.attach({ tabId, owner: "user" })
  })

  const createAndAttachTab = Effect.fnUntraced(function* (options: {
    readonly url: string
    readonly active: boolean
    readonly opencodeBrowserSessionId?: string
    readonly autoAttachParams?: JsonObject
  }) {
    const result = yield* sendToExtension({ method: "tabs.create", params: { url: options.url, active: options.active } })
    const tabId = getNumber(result, "tabId")
    if (!tabId) {
      return yield* Effect.fail(new Error("tabs.create did not return a tabId"))
    }
    currentAnnouncedRootTabIds?.add(tabId)
    return yield* rootLifecycle.attach({
      tabId,
      owner: "relay",
      ...(options.opencodeBrowserSessionId ? { opencodeBrowserSessionId: options.opencodeBrowserSessionId } : {}),
      ...(options.autoAttachParams ? { autoAttachParams: options.autoAttachParams } : {}),
    })
  })

  const rootLifecycle = yield* RootTargetLifecycle.make({
    registry,
    sessions,
    handoffs,
    clients: cdpClients,
    extension: { generation: () => extensionGeneration, send: sendToExtension },
    presentation: {
      replaced: recordRootReplacement,
      committed: presentAttachedTarget,
      announceRoot: announceAttachedTarget,
      announceChild: announceAttachedChildTarget,
    },
    reportError: (message, error) => console.error(message, error),
  })

  function presentAttachedTarget(committedTarget: ConnectedTarget): void {
    const tabId = committedTarget.tabId
    mainFrameIdsByTab.set(tabId, committedTarget.targetInfo.targetId)
    contextDebugLog?.(`target-attached kind=root ${targetDiagnosticIdentity(committedTarget)} ${summarizeDiagnosticUrl(committedTarget.targetInfo.url)}`)
    if (committedTarget.opencodeBrowserSessionId) {
      pruneInvisibleAnnouncementsForSession(committedTarget.opencodeBrowserSessionId)
    }
    if (extensionRpc.connected) {
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
      sendPageStatus(committedTarget, committedTarget.opencodeBrowserSessionId && sessions.isExecuting(committedTarget.opencodeBrowserSessionId) ? "running" : "attached")
    }
  }

  const applyGhostCursorMouseEvent = Effect.fnUntraced(function* (options: { readonly tabId: number; readonly message: CdpRequest }) {
    if (options.message.method !== "Input.dispatchMouseEvent") {
      return
    }
    yield* ghostCursor.mouseEvent(options.tabId, options.message.params)
  })

  function clearTabRuntimeState(tabId: number): void {
    mainFrameIdsByTab.delete(tabId)
    protectedFrames.forgetTab(tabId)
    ghostCursor.forget(tabId)
    forgetTab(tabId)
    for (const [sessionId, childTabId] of suppressedChildSessions) {
      if (childTabId === tabId) {
        suppressedChildSessions.delete(sessionId)
      }
    }
  }

  function detachTargetState(tabId: number, options: {
    readonly preserveSessionTarget?: boolean
    readonly updateExtension?: boolean
  } = {}): void {
    rootLifecycle.invalidate(tabId)
    if (options.updateExtension !== false) {
      sendExtensionBestEffort({ method: "pageStatus.clear", params: { tabId } })
      scheduleTabGrouping(tabId, "tabs.ungroup")
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
      cancelTargetHandoffs(detached.target, "target-detached")
      if (!options.preserveSessionTarget) sessions.markTargetDetached(detached.target.targetInfo.targetId)
      contextDebugLog?.(`target-detached kind=root ${targetDiagnosticIdentity(detached.target)}`)
    }
    // A staged-only root has no committed target but may already own tab-scoped relay state.
    cdpClients.detachTab(tabId, { destroyed: true })
    clearTabRuntimeState(tabId)
  }

  function recordRootReplacement(change: Extract<RootTargetChange, { readonly kind: "replaced" }>): void {
    clearTabRuntimeState(change.target.tabId)
    contextDebugLog?.(`target-replaced kind=root old=${targetDiagnosticIdentity(change.previous)} new=${targetDiagnosticIdentity(change.target)}`)
  }

  function detachChildTargetState(sessionId: string): void {
    const detached = registry.detachChildTargetState(sessionId)
    if (detached) {
      cdpClients.detachTarget(detached)
    }
  }

  // Deliver a session-scoped event only to clients that have been told about
  // the tab's root target. Broadcasting to every client lets concurrently
  // connected sandboxes attach to each other's pages and interfere.
  function sendEventToTargetViewers(rootSessionId: string, event: CdpEvent): void {
    cdpClients.sendToViewers(rootSessionId, event, (client, tabId) => cdpRouter.canSeeTab(client, tabId))
  }

  function pruneInvisibleAnnouncementsForSession(opencodeBrowserSessionId: string): void {
    for (const client of cdpClients) {
      if (cdpClients.sessionId(client) === opencodeBrowserSessionId) {
        cdpRouter.reconcileClient(client)
      }
    }
  }

  function reconcileTargetOwnership(change: TargetOwnershipChange): void {
    for (const client of cdpClients) {
      cdpRouter.reconcileClient(client)
    }
    for (const targetId of change.targetIds) {
      const target = registry.targetsByTargetId.get(targetId)
      if (target) {
        announceAttachedTarget(target)
      }
    }
    for (const tabId of change.tabIds) {
      refreshTabPresentation(tabId)
    }
  }

  function announceAttachedTarget(target: ConnectedTarget): void {
    for (const client of cdpClients) {
      if (cdpRouter.canSeeTarget(client, target)) {
        cdpClients.announce(client, target)
      }
    }
  }

  function announceAttachedChildTarget(rootSessionId: string, target: ChildTarget): void {
    for (const client of cdpClients) {
      if (cdpClients.hasSession(client, rootSessionId) && cdpRouter.canSeeTab(client, target.tabId)) {
        cdpClients.announce(client, target)
      }
    }
  }

  yield* Effect.catch(listenHttpServer({ server: httpServer, host, port }), (error) => {
    return Effect.gen(function* () {
      yield* cleanup()
      return yield* Effect.fail(error)
    })
  })
  // Execute files directories of relays and CLI processes that died without their exit hook.
  yield* Effect.sync(() => pruneStaleExecuteFilesDirectories())

  yield* Effect.catch(
    Effect.gen(function* () {
      const restoredSessions = yield* Effect.tryPromise({
        try: () => sessionCatalog?.load() ?? Promise.resolve([]),
        catch: (cause) => cause instanceof Error ? cause : new Error("Load OpenCode Browser session catalog", { cause }),
      })
      yield* Effect.try({
        try: () => sessions.restore(restoredSessions),
        catch: (cause) => cause instanceof Error ? cause : new Error("Restore OpenCode Browser sessions", { cause }),
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
      relayLog("relay.ready", { url: endpointUrl, version: opencodeBrowserVersion, build: opencodeBrowserBuildId, pid: process.pid, managed })
    }),
    (error) => Effect.gen(function* () {
      yield* cleanup()
      return yield* Effect.fail(error)
    }),
  )

  return {
    url: endpointUrl,
    close: () => {
      return close
    },
  }
})

function sendUpgradeError(options: {
  readonly socket: stream.Duplex
  readonly status: 400 | 401 | 403 | 404 | 503
  readonly message: string
}): void {
  const statusText = http.STATUS_CODES[options.status] ?? "Error"
  options.socket.write(
    `HTTP/1.1 ${options.status} ${statusText}\r\ncontent-type: text/plain; charset=utf-8\r\nconnection: close\r\n\r\n${options.message}`,
  )
  options.socket.destroy()
}

function rawDataToBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) {
    return data
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data)
  }
  return Buffer.from(data)
}
