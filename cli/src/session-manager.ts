import { Deferred, Effect, Option, Semaphore } from "effect"
import { ExecuteSandbox, type ExecuteTargetSelection } from "./execute.ts"
import { ExecuteCpuScheduler } from "./execute-realm.ts"
import type { NetworkCaptureOptions, NetworkCaptureResult, NetworkCaptureStatus, NetworkCaptureStopOptions } from "./network-capture.ts"
import { generateSessionId } from "./relay/helpers.ts"
import type { AuthenticatedJsonOutcome, AuthenticatedJsonRequest } from "./relay/schema.ts"
import type { ConnectedTarget, ExecuteSandboxLike, OpenCodeBrowserSession, SessionSummary, SessionTarget } from "./relay/types.ts"
import type { PersistedSession } from "./session-manager/catalog.ts"
import { SessionAdmission } from "./session-manager/admission.ts"
import { adoptTargetForSession, closeSessionSettledWithTimeout, sessionRelayTargetIds, type AdoptionContext } from "./session-manager/adoption.ts"
import { executeInSession, type ExecutionContext } from "./session-manager/execution.ts"
import {
  defaultShutdownTimeoutMs,
  sessionError,
  sessionSummary,
  trySession,
  type AdoptionResult,
  type ExecutionResponse,
  type PendingSessionWork,
  type RunningExecution,
  type SessionCreateOptions,
  type SessionExecuteRecord,
  type SessionHooks,
  type SessionStopReport,
} from "./session-manager/types.ts"
import {
  MemoryTargetOwnership,
  type TargetOwnership,
  type TargetOwnershipChange,
} from "./cdp/target-registry.ts"

export {
  adoptionTipForUrl,
  defaultExecuteTimeoutMs,
  defaultShutdownTimeoutMs,
  SessionError,
  shouldAppendAdoptionTip,
  type SessionExecuteRecord,
  type SessionHooks,
  type SessionStopReport,
} from "./session-manager/types.ts"

/**
 * Session ids an MCP server picks for itself (the MCP supervisor and `browse mcp` both use eight hex characters).
 * Shared with the relay's orphan collector so both agree on which sessions nobody named.
 */
const mcpSessionPattern = /^mcp-[0-9a-f]{8}$/i

export function isMcpSession(id: string): boolean {
  return mcpSessionPattern.test(id)
}

/** Sessions browse names itself (an MCP server's implicit session, a generated id, or an opencode session). */
export function isAutoNamedSession(id: string): boolean {
  return isMcpSession(id) || /^[a-z]+-[a-z]+-\d{3}$/.test(id) || id.startsWith("oc-")
}

export class OpenCodeBrowserSessions {
  readonly sessions = new Map<string, OpenCodeBrowserSession>()
  /** One per relay: every session's execute realm shares the event loop through it. */
  readonly cpuScheduler = new ExecuteCpuScheduler()
  private readonly createSandbox: (id: string, onDefaultTargetChange: (target: SessionTarget | undefined) => void) => ExecuteSandboxLike
  private readonly hooks: SessionHooks
  private readonly executing = new Set<string>()
  /** Running executes by session: stopping one answers its caller now and ends the script (see execute()). */
  private readonly runningExecutions = new Map<string, RunningExecution>()
  private readonly adoptSemaphore = Semaphore.makeUnsafe(1)
  private readonly targetOwnership: TargetOwnership
  private readonly admission: SessionAdmission
  private readonly adoptionContext: AdoptionContext
  private readonly executionContext: ExecutionContext

  constructor(
    private readonly endpointUrl: string,
    createSandbox?: (id: string, onDefaultTargetChange: (target: SessionTarget | undefined) => void) => ExecuteSandboxLike,
    hooks?: SessionHooks,
    targetOwnership?: TargetOwnership,
  ) {
    this.createSandbox = createSandbox ?? ((id, onDefaultTargetChange) => new ExecuteSandbox({ endpointUrl: this.endpointUrl, sessionId: id, onDefaultTargetChange, cpuScheduler: this.cpuScheduler }))
    this.hooks = hooks ?? {}
    this.targetOwnership = targetOwnership ?? new MemoryTargetOwnership()
    this.admission = new SessionAdmission(this.sessions, this.hooks)
    this.adoptionContext = {
      sessions: this.sessions,
      hooks: this.hooks,
      targetOwnership: this.targetOwnership,
      adoptSemaphore: this.adoptSemaphore,
      admission: this.admission,
      resolveWorkSession: (id, createIfMissing, requestedBrowser) => this.resolveWorkSession(id, createIfMissing, requestedBrowser),
      resolveBrowser: (requested, session) => this.resolveBrowser(requested, session),
      createOpenCodeBrowserSession: (id, readOnly, timestamps) => this.createOpenCodeBrowserSession(id, readOnly, timestamps),
      closeOpenCodeBrowserSessionSettled: (session) => this.closeOpenCodeBrowserSessionSettled(session),
      closeRelayTarget: (targetId) => this.closeRelayTarget(targetId),
      releaseSessionTargetOwnership: (session) => this.releaseSessionTargetOwnership(session),
      notifyTargetOwnershipChange: (change) => this.notifyTargetOwnershipChange(change),
    }
    this.executionContext = {
      sessions: this.sessions,
      hooks: this.hooks,
      admission: this.admission,
      runningExecutions: this.runningExecutions,
      resolveWorkSession: (id, createIfMissing, requestedBrowser) => this.resolveWorkSession(id, createIfMissing, requestedBrowser),
      resolveBrowser: (requested, session) => this.resolveBrowser(requested, session),
      setExecuting: (id, executing) => this.setExecuting(id, executing),
      endStoppedScript: (session) => this.endStoppedScript(session),
      stopGraceMs: () => this.stopGraceMs(),
      replaceSandbox: (session) => this.replaceSandbox(session),
      recordExecute: (record) => this.recordExecute(record),
      cleanupCreatedSession: (session) => this.cleanupCreatedSession(session),
      stopExecution: (sessionId, message, diagnostic) => this.stopExecution(sessionId, message, diagnostic),
    }
  }

  listSummaries(): SessionSummary[] {
    return Array.from(this.sessions.values()).map((session) => sessionSummary(session))
  }

  restore(entries: readonly PersistedSession[]): void {
    this.admission.assertAdmission()
    if (this.sessions.size > 0) throw new Error("Cannot restore sessions after session management has started")
    const ids = new Set<string>()
    const targetOwners = new Set<string>()
    for (const entry of entries) {
      if (ids.has(entry.id)) throw new Error(`Duplicate persisted session: ${entry.id}`)
      ids.add(entry.id)
      if (entry.target && targetOwners.has(entry.target.id)) {
        throw new Error(`Duplicate persisted target owner: ${entry.target.id}`)
      }
      if (entry.target) targetOwners.add(entry.target.id)
    }
    for (const entry of entries) {
      const session = this.createOpenCodeBrowserSession(entry.id, entry.readOnly, {
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
      })
      if (entry.allowedOrigins && entry.allowedOrigins.length > 0) session.allowedOrigins = entry.allowedOrigins
      if (entry.keepVisible === true) session.keepVisible = true
      if (entry.browser) session.browser = { id: entry.browser, ...(entry.browserKey ? { key: entry.browserKey } : {}) }
      if (entry.target) session.target = entry.target
      if (entry.clientPid !== undefined) session.clientPid = entry.clientPid
      session.sandbox.restore(entry.target)
      this.sessions.set(entry.id, session)
    }
  }

  persistedTargetOwner(targetId: string): { readonly sessionId: string; readonly owner: "relay" | "user" } | undefined {
    for (const session of this.sessions.values()) {
      const target = session.target
      if (target?.id === targetId) return { sessionId: session.id, owner: target.owner }
    }
    return undefined
  }

  private updateTarget(session: OpenCodeBrowserSession, target: SessionTarget | undefined): void {
    if (this.sessions.get(session.id) !== session) return
    if (session.target?.id === target?.id && session.target?.owner === target?.owner) return
    if (target) session.target = target
    else delete session.target
    session.updatedAt = new Date().toISOString()
    this.admission.schedulePersistence()
  }

  createNew(id: string | undefined, options?: SessionCreateOptions): OpenCodeBrowserSession {
    this.admission.assertAdmission()
    if (id !== undefined) this.admission.assertStableIdentity(id)
    return this.createAcceptedSession(id, options)
  }

  private createAcceptedSession(id: string | undefined, options?: SessionCreateOptions): OpenCodeBrowserSession {
    const sessionId = id ?? generateSessionId(this.sessions)
    if (this.sessions.has(sessionId)) {
      throw sessionError("already-exists", `Session already exists: ${sessionId}`, sessionId)
    }
    const browser = this.resolveBrowser(options?.browser)
    const session = this.createOpenCodeBrowserSession(sessionId, options?.readOnly === true)
    if (options?.allowedOrigins && options.allowedOrigins.length > 0) session.allowedOrigins = options.allowedOrigins
    if (options?.keepVisible === true) session.keepVisible = true
    if (browser) session.browser = browser
    this.sessions.set(sessionId, session)
    this.admission.schedulePersistence()
    return session
  }

  create(id: string | undefined, options?: SessionCreateOptions): Effect.Effect<OpenCodeBrowserSession, Error> {
    return this.admission.withAdmission(id, this.createPersistedSession(id, options).pipe(Effect.uninterruptible))
  }

  ensure(id: string, options?: { readonly readOnly?: boolean }): Effect.Effect<SessionSummary, Error> {
    const manager = this
    return this.admission.withAdmission(id, Effect.gen(function* () {
      const existing = manager.sessions.get(id)
      if (existing) {
        yield* trySession(() => manager.resolveBrowser(undefined, existing))
        if (options?.readOnly === true && !existing.readOnly) {
          return yield* sessionError(
            "invalid-request",
            `Session ${id} already exists with write access and cannot be ensured as read-only`,
            id,
          )
        }
        return sessionSummary(existing)
      }
      const session = yield* manager.createPersistedSession(id, options)
      return sessionSummary(session)
    }).pipe(Effect.uninterruptible))
  }

  private readonly createPersistedSession = Effect.fnUntraced(function* (this: OpenCodeBrowserSessions, id: string | undefined, options?: SessionCreateOptions) {
    const manager = this
    const sessionId = id ?? generateSessionId(manager.sessions)
    return yield* manager.admission.withIdentityChange(sessionId, Effect.gen(function* () {
      const session = yield* trySession(() => manager.createAcceptedSession(sessionId, options))
      yield* manager.admission.flushPersistenceWithRollback(() => Effect.gen(function* () {
        if (manager.sessions.get(session.id) === session) manager.sessions.delete(session.id)
        yield* manager.closeOpenCodeBrowserSession(session)
      }))
      return session
    }))
  })

  getOrCreate(id: string): { readonly session: OpenCodeBrowserSession; readonly created: boolean } {
    this.admission.assertAdmission()
    this.admission.assertStableIdentity(id)
    const existing = this.sessions.get(id)
    if (existing) {
      return { session: existing, created: false }
    }
    return { session: this.createAcceptedSession(id), created: true }
  }

  isReadOnly(id: string): boolean {
    return this.sessions.get(id)?.readOnly === true
  }

  /** The session's allowed-origin patterns, or undefined when it has no allowlist. */
  allowedOrigins(id: string): readonly string[] | undefined {
    return this.sessions.get(id)?.allowedOrigins
  }

  /** Replace a session's allowed-origin patterns (already normalized); an empty list removes the allowlist. */
  setAllowedOrigins(id: string, patterns: readonly string[]): Effect.Effect<SessionSummary, Error> {
    const manager = this
    return Effect.gen(function* () {
      const session = manager.sessions.get(id)
      if (!session) return yield* sessionError("not-found", `Session not found: ${id}`, id)
      if (patterns.length > 0) session.allowedOrigins = patterns
      else delete session.allowedOrigins
      session.updatedAt = new Date().toISOString()
      manager.admission.schedulePersistence()
      return sessionSummary(session)
    })
  }

  /** Whether the session keeps its own tabs visible to the page between execute calls. */
  keepsTabsVisible(id: string): boolean {
    return this.sessions.get(id)?.keepVisible === true
  }

  isExecuting(id: string): boolean {
    return this.executing.has(id)
  }

  /**
   * Stops the session's running execute: its caller gets `message` as an error now, its pending handoff is cancelled,
   * and the script is ended (its Playwright calls reject, its timers stop). The execute lock is released as soon as
   * the script settles, or after the stop grace period with the sandbox replaced.
   */
  stopExecution(id: string, message: string, diagnostic = "user-stopped"): boolean {
    const running = this.runningExecutions.get(id)
    if (!running) return false
    running.stop(message, diagnostic)
    return true
  }

  /** Pauses a running execute's outer timeout while a handoff waits on the user; returns a resume callback. */
  pauseExecutionTimeout(id: string): () => void {
    return this.runningExecutions.get(id)?.pauseTimeout() ?? (() => {})
  }

  private stopForLifecycle(id: string, operation: "delete" | "reset"): Effect.Effect<SessionStopReport | undefined> {
    const manager = this
    return Effect.gen(function* () {
      const message = `Session ${id} was ${operation === "delete" ? "deleted" : "reset"} while this ran, so it was stopped.`
      const handoff = manager.cancelSessionHandoff(id)
      const running = manager.runningExecutions.get(id)
      if (!running) return handoff ? { execute: false, handoff, forced: false } : undefined
      running.stop(message, `session-${operation}`)
      const released = yield* Deferred.await(running.released).pipe(
        Effect.timeoutOption(manager.stopGraceMs() + 2_000),
      )
      return { execute: true, handoff, forced: Option.isNone(released) || released.value.forced }
    })
  }

  private cancelSessionHandoff(id: string): boolean {
    try {
      return this.hooks.onCancelSessionHandoff?.(id) ?? false
    } catch (error) {
      console.error("Session handoff cancellation hook failed", error)
      return false
    }
  }

  private stopGraceMs(): number {
    return this.hooks.stopGraceMs ?? 3_000
  }

  hasPendingWork(id: string): boolean {
    return this.admission.hasPendingWork(id)
  }

  hasActiveNetworkCapture(): boolean {
    for (const session of this.sessions.values()) {
      if (session.sandbox.networkStatus().active) return true
    }
    return false
  }

  /** Sessions with a network capture running, and since when. */
  activeNetworkCaptures(): { readonly sessionId: string; readonly startedAt?: string }[] {
    return Array.from(this.sessions.values()).flatMap((session) => {
      const status = session.sandbox.networkStatus()
      return status.active ? [{ sessionId: session.id, ...(status.startedAt ? { startedAt: status.startedAt } : {}) }] : []
    })
  }

  /** Records the process using a session (its MCP server or CLI), so the session can be cleaned up once it is gone. */
  noteClient(id: string, pid: number): void {
    const session = this.sessions.get(id)
    if (!session || session.clientPid === pid) return
    session.clientPid = pid
    this.admission.schedulePersistence()
  }

  /** Ends a session's network capture without a result (its client went away, or a forced restart). */
  networkEnd(id: string, reason: string): Effect.Effect<boolean> {
    const session = this.sessions.get(id)
    if (!session) return Effect.succeed(false)
    return session.sandbox.networkEnd(reason).pipe(Effect.map(({ cancelled }) => cancelled))
  }

  private collectSessionIds(matches: (session: OpenCodeBrowserSession) => boolean): string[] {
    const affectedSessionIds: string[] = []
    for (const session of this.sessions.values()) {
      if (matches(session)) {
        affectedSessionIds.push(session.id)
      }
    }
    return affectedSessionIds
  }

  markTargetCrashed(targetId: string): string[] {
    return this.collectSessionIds((session) => session.sandbox.markTargetCrashed(targetId))
  }

  markTargetProtectedUi(targetId: string, protectedUi: boolean): string[] {
    return this.collectSessionIds((session) => session.sandbox.markTargetProtectedUi(targetId, protectedUi))
  }

  markTargetDetached(targetId: string, options: { readonly releasedByUser?: boolean } = {}): string[] {
    return this.collectSessionIds((session) => {
      const detached = session.sandbox.markTargetDetached(targetId, options)
      if (session.target?.id === targetId && session.target.owner === "user") {
        this.notifyTargetOwnershipChange(this.targetOwnership.releaseTargetOwnership(targetId, session.id))
      }
      if (session.target?.id === targetId) {
        this.updateTarget(session, undefined)
      }
      return detached
    })
  }

  markTargetReplaced(previousTargetId: string, targetId: string): string[] {
    return this.collectSessionIds((session) => {
      if (session.target?.id === previousTargetId) this.updateTarget(session, { ...session.target, id: targetId })
      return session.sandbox.markTargetReplaced(previousTargetId, targetId)
    })
  }

  delete(id: string): Effect.Effect<{ readonly deleted: boolean; readonly stopped?: SessionStopReport }, Error> {
    const manager = this
    return this.admission.withAdmission(id, Effect.gen(function* () {
      const session = manager.sessions.get(id)
      if (!session) {
        return { deleted: false }
      }
      const stopped = yield* manager.stopForLifecycle(id, "delete")
      const deleted = yield* manager.withLifecyclePermit(session, "delete", manager.admission.withIdentityChange(id, Effect.gen(function* () {
        if (manager.sessions.get(id) !== session) {
          return false
        }
        yield* manager.closeSessionRelayTargets(session)
        manager.sessions.delete(id)
        yield* manager.admission.commitPersistence(() => Effect.sync(() => {
          manager.sessions.set(id, session)
        }))
        yield* manager.releaseSessionTargetOwnership(session)
        yield* manager.closeOpenCodeBrowserSession(session)
        yield* Effect.sync(() => {
          try {
            manager.hooks.onSessionDeleted?.(id)
          } catch (error) {
            console.error("Session deleted hook failed", error)
          }
        })
        return true
      })))
      return { deleted, ...(stopped ? { stopped } : {}) }
    }))
  }

  reset(id: string): Effect.Effect<{ readonly session: SessionSummary; readonly stopped?: SessionStopReport } | undefined, Error> {
    const manager = this
    return this.admission.withAdmission(id, Effect.gen(function* () {
      const existing = manager.sessions.get(id)
      if (!existing) {
        return undefined
      }
      const stopped = yield* manager.stopForLifecycle(id, "reset")
      const session = yield* manager.withLifecyclePermit(existing, "reset", manager.admission.withIdentityChange(id, Effect.gen(function* () {
        if (manager.sessions.get(id) !== existing) {
          return yield* sessionError("inactive", `Session is no longer active: ${id}`, id)
        }
        yield* manager.closeSessionRelayTargets(existing)
        const session = manager.createOpenCodeBrowserSession(id, existing.readOnly)
        if (existing.allowedOrigins) session.allowedOrigins = existing.allowedOrigins
        if (existing.keepVisible) session.keepVisible = true
        if (existing.browser) session.browser = existing.browser
        if (existing.clientPid !== undefined) session.clientPid = existing.clientPid
        manager.sessions.set(id, session)
        yield* manager.admission.commitPersistence(() => Effect.sync(() => {
          manager.sessions.set(id, existing)
        }))
        yield* manager.releaseSessionTargetOwnership(existing)
        yield* manager.closeOpenCodeBrowserSession(existing)
        // The id outlives the session object, so drop state keyed by it as a delete does (focus it kept, viewport
        // overrides its script left).
        yield* Effect.sync(() => {
          try {
            manager.hooks.onSessionDeleted?.(id)
          } catch (error) {
            console.error("Session reset hook failed", error)
          }
        })
        return sessionSummary(session)
      })))
      return { session, ...(stopped ? { stopped } : {}) }
    }))
  }

  adoptedTargetId(id: string): string | undefined {
    const target = this.sessions.get(id)?.target
    return target?.owner === "user" ? target.id : undefined
  }

  networkStart(id: string, options: NetworkCaptureOptions = {}): Effect.Effect<NetworkCaptureStatus, Error> {
    return this.withSessionOperation(id, "network start", (session) => session.sandbox.networkStart(options))
  }

  networkStatus(id: string): Effect.Effect<NetworkCaptureStatus, Error> {
    const session = this.sessions.get(id)
    return session
      ? Effect.succeed(session.sandbox.networkStatus())
      : Effect.fail(sessionError("not-found", `Session not found: ${id}`, id))
  }

  networkStop(id: string, options: NetworkCaptureStopOptions = {}): Effect.Effect<NetworkCaptureResult, Error> {
    return this.withSessionOperation(id, "network stop", (session) => session.sandbox.networkStop(options))
  }

  networkCancel(id: string): Effect.Effect<{ readonly cancelled: boolean }, Error> {
    return this.withSessionOperation(id, "network cancel", (session) => session.sandbox.networkCancel())
  }

  authRefresh(id: string, options: { readonly name: string; readonly urlFilter?: string; readonly timeoutMs?: number }): Effect.Effect<NetworkCaptureResult, Error> {
    return this.withSessionOperation(id, "auth refresh", (session) => session.sandbox.authRefresh(options))
  }

  private withSessionOperation<A>(
    id: string,
    operation: string,
    use: (session: OpenCodeBrowserSession) => Effect.Effect<A, Error>,
    beforePermit?: (session: OpenCodeBrowserSession) => Effect.Effect<void, Error>,
  ): Effect.Effect<A, Error> {
    const manager = this
    return this.admission.withAdmission(id, Effect.suspend(() => {
      const session = manager.sessions.get(id)
      if (!session) return Effect.fail(sessionError("not-found", `Session not found: ${id}`, id))
      return (beforePermit ? beforePermit(session) : Effect.void).pipe(
        Effect.andThen(manager.withLifecyclePermit(session, operation, Effect.gen(function* () {
          if (manager.sessions.get(id) !== session) {
            return yield* sessionError("inactive", `Session is no longer active: ${id}`, id)
          }
          yield* trySession(() => manager.resolveBrowser(undefined, session))
          return yield* use(session)
        }))),
      )
    }))
  }

  authenticatedJson(
    request: AuthenticatedJsonRequest,
  ): Effect.Effect<AuthenticatedJsonOutcome, Error> {
    const manager = this
    const { sessionId, ...pageRequest } = request
    return this.withSessionOperation(
      sessionId,
      "authenticated request",
      (session) => Effect.gen(function* () {
        yield* manager.setExecuting(session.id, true)
        const result = yield* session.sandbox.authenticatedJson(pageRequest).pipe(
          Effect.ensuring(manager.setExecuting(session.id, false)),
        )
        session.updatedAt = new Date().toISOString()
        yield* manager.admission.commitPersistence()
        return result
      }),
      (session) => session.readOnly && request.method !== "GET"
        ? Effect.fail(sessionError(
            "invalid-request",
            `Read-only session ${sessionId} cannot make ${request.method} authenticated requests`,
            sessionId,
          ))
        : Effect.void,
    )
  }

  execute(options: {
    readonly sessionId?: string
    readonly code: string
    readonly createIfMissing: boolean
    readonly removeAfterExecute?: boolean
    readonly timeoutMs?: number
    readonly targetSelection?: ExecuteTargetSelection
    readonly browser?: string
  }): Effect.Effect<ExecutionResponse, Error> {
    return executeInSession(this.executionContext, options)
  }

  targetsForAdoption(sessionId: string | undefined, targets: readonly ConnectedTarget[]) {
    return trySession(() => {
      const session = sessionId === undefined ? undefined : this.sessions.get(sessionId)
      const browser = this.resolveBrowser(undefined, session)
      return targets.filter((target) => !browser?.key || this.hooks.targetBrowserKey?.(target.tabId) === browser.key)
    })
  }

  adopt(options: {
    readonly sessionId?: string
    readonly createIfMissing: boolean
    readonly targetId: string
    readonly targetUrl: string
    readonly tabId?: number
  }): Effect.Effect<AdoptionResult, Error> {
    return adoptTargetForSession(this.adoptionContext, options)
  }

  /** Stop admission without cancelling accepted work or disconnecting sessions. */
  beginDrain(): Effect.Effect<void, Error> {
    return this.admission.beginDrain()
  }

  /** Recheck synchronously at commit: late catalog writes invalidate a completed drain. */
  isDrained(): boolean {
    return this.admission.isDrained()
  }

  /** Call only after cancelling or completing the reversible drain waiter. */
  resume(): void {
    this.admission.resume()
  }

  /**
   * Relay shutdown: stop admitting, let accepted work finish and disconnect the sessions, but wait at most
   * `timeoutMs`. A session whose work never finishes is reported through `onStalled` and dropped so the process can
   * exit.
   */
  closeAll(options: {
    readonly timeoutMs?: number
    /** Sessions still holding work when the wait expired, called before they are dropped. */
    readonly onStalled?: (sessions: readonly PendingSessionWork[]) => void
  } = {}): Effect.Effect<void> {
    const manager = this
    // Persisting the catalog is the shutdown's only chance to record the sessions it held; a stuck write must not
    // keep the process alive either.
    const stalledFlushMs = 1_000
    // Only the wait is interruptible (so the timeout can end it); naming, persisting and dropping stragglers is not.
    return Effect.uninterruptible(Effect.gen(function* () {
      manager.admission.markClosed()
      yield* Effect.interruptible(Effect.gen(function* () {
        yield* manager.admission.beginDrain().pipe(Effect.ignore)
        yield* manager.adoptSemaphore.withPermit(Effect.gen(function* () {
          yield* Effect.forEach(Array.from(manager.sessions.values()), (session) => {
            return session.executeSemaphore.withPermit(
              manager.disconnectOpenCodeBrowserSession(session),
            )
          }, { concurrency: "unbounded", discard: true })
          yield* manager.admission.flushPersistence().pipe(Effect.ignore)
          manager.sessions.clear()
        }))
      })).pipe(
        Effect.timeoutOrElse({
          duration: options.timeoutMs ?? defaultShutdownTimeoutMs,
          orElse: () => Effect.gen(function* () {
            options.onStalled?.(manager.admission.pendingWorkBySession())
            yield* Effect.interruptible(manager.admission.flushPersistence()).pipe(
              Effect.timeoutOrElse({ duration: stalledFlushMs, orElse: () => Effect.void }),
              Effect.ignore,
            )
            manager.sessions.clear()
          }),
        }),
      )
    }))
  }

  summary(id: string): SessionSummary | undefined {
    const session = this.sessions.get(id)
    return session ? sessionSummary(session) : undefined
  }

  /** Reaps idle auto-named and oc-* sessions; explicit (named) sessions keep their state and are never reset here. */
  reapIdleSessions(options: {
    readonly now?: number
    readonly maxIdleMs: number
    readonly isTargetBusy?: (targetId: string) => boolean
  }): Effect.Effect<readonly string[]> {
    const manager = this
    return Effect.gen(function* () {
      const now = options.now ?? Date.now()
      const reaped: string[] = []
      for (const session of Array.from(manager.sessions.values())) {
        if (!isAutoNamedSession(session.id)) continue
        if (manager.isExecuting(session.id) || manager.hasPendingWork(session.id) || session.sandbox.networkStatus().active) {
          continue
        }
        const updatedAtMs = Date.parse(session.updatedAt)
        if (!Number.isFinite(updatedAtMs) || now - updatedAtMs < options.maxIdleMs) {
          continue
        }
        const targetIds = sessionRelayTargetIds(manager.hooks, session)
        if (session.target) targetIds.add(session.target.id)
        if (Array.from(targetIds).some((id) => options.isTargetBusy?.(id))) continue
        const done = yield* manager.delete(session.id).pipe(Effect.map((result) => result.deleted), Effect.orElseSucceed(() => false))
        if (done) reaped.push(session.id)
      }
      return reaped
    })
  }

  /** Called once after startup inventory; unknown/user-owned tabs are never inferred. */
  sweepOrphanedRelayTargets(): Effect.Effect<void> {
    return Effect.forEach(this.hooks.getTargets?.() ?? [], (target) =>
      target.owner === "relay" && target.opencodeBrowserSessionId && !this.sessions.has(target.opencodeBrowserSessionId)
        ? this.closeRelayTarget(target.targetInfo.targetId).pipe(Effect.ignore)
        : Effect.void, { discard: true })
  }

  persist(): Effect.Effect<void, Error> {
    return this.admission.flushPersistence()
  }

  private setExecuting(id: string, executing: boolean): Effect.Effect<void> {
    return Effect.suspend(() => {
      if (executing) this.executing.add(id)
      else this.executing.delete(id)
      try {
        return this.hooks.onExecuteStateChange?.(id, executing) ?? Effect.void
      } catch (error) {
        console.error("Session execute-state hook failed", error)
      }
      return Effect.void
    })
  }

  private recordExecute(record: SessionExecuteRecord): Effect.Effect<void> {
    const hook = this.hooks.onExecuteRecord
    if (!hook) return Effect.void
    return Effect.tryPromise({
      try: async () => {
        const release = this.admission.retainWork(record.sessionId)
        try {
          return await hook(record)
        } finally {
          release()
        }
      },
      catch: (cause) => cause,
    }).pipe(
      Effect.timeoutOrElse({
        duration: this.hooks.journalTimeoutMs ?? 2_000,
        orElse: () => Effect.fail(new Error(`Session journal write timed out after ${this.hooks.journalTimeoutMs ?? 2_000}ms`)),
      }),
      Effect.catch((error) => Effect.sync(() => {
        console.error("Session execute-record hook failed", error)
      })),
      Effect.asVoid,
    )
  }

  private createOpenCodeBrowserSession(id: string, readOnly: boolean, timestamps?: {
    readonly createdAt: string
    readonly updatedAt?: string
  }): OpenCodeBrowserSession {
    const now = new Date().toISOString()
    let session: OpenCodeBrowserSession | undefined
    session = {
      id,
      createdAt: timestamps?.createdAt ?? now,
      updatedAt: timestamps?.updatedAt ?? now,
      readOnly,
      sandbox: this.createSandbox(id, (target) => {
        if (session) this.updateTarget(session, target)
      }),
      executeSemaphore: Semaphore.makeUnsafe(1),
    }
    return session
  }

  private endStoppedScript(session: OpenCodeBrowserSession): Effect.Effect<void> {
    this.cancelSessionHandoff(session.id)
    // User code stops first, synchronously, as before: nothing the script does runs after its caller was told it stopped.
    session.sandbox.stopRealm()
    // Then end a navigation it left pending, and only then close its browser connection. One stop grace covers both:
    // the cancel may take at most half of it (never more than 2s), so the disconnect always starts within the grace.
    const graceMs = this.stopGraceMs()
    const cancelNavigation = this.hooks.onStoppingExecute?.(session)
    const cancel = cancelNavigation === undefined
      ? Effect.void
      : cancelNavigation.pipe(
          Effect.timeoutOption(Math.min(2_000, Math.floor(graceMs / 2))),
          Effect.catchCause((cause) => Effect.sync(() => console.error("Cancel stopped execute navigation", cause))),
          Effect.asVoid,
        )
    return cancel.pipe(
      Effect.andThen(Effect.suspend(() => session.sandbox.disconnectSettled())),
      Effect.timeoutOption(graceMs),
      Effect.catchCause((cause) => Effect.sync(() => console.error("Disconnect stopped execute", cause))),
      Effect.asVoid,
    )
  }

  private replaceSandbox(session: OpenCodeBrowserSession): void {
    if (this.sessions.get(session.id) !== session) return
    session.sandbox = this.createSandbox(session.id, (target) => this.updateTarget(session, target))
    session.sandbox.restore(session.target, "The previous script was stopped and did not end in time, so this session's JavaScript state and snapshot refs were reset.")
  }

  private resolveBrowser(requested?: string, session?: OpenCodeBrowserSession): OpenCodeBrowserSession["browser"] {
    const browser = this.hooks.resolveBrowser?.(requested?.trim() || undefined, session)
    if (browser && "error" in browser) throw sessionError(browser.unavailable ? "browser-unavailable" : "invalid-request", browser.error, session?.id)
    if (browser && session && session.browser?.id !== browser.id) {
      session.browser = browser
      this.admission.schedulePersistence()
    }
    return browser
  }

  private resolveWorkSession(id: string | undefined, createIfMissing: boolean, requestedBrowser?: string) {
    return trySession(() => {
      const existing = id === undefined ? undefined : this.sessions.get(id)
      if (existing) {
        this.resolveBrowser(requestedBrowser, existing)
        return { session: existing, created: false }
      }
      if (!createIfMissing) {
        throw id === undefined
          ? sessionError("invalid-request", "sessionId is required when createIfMissing is false")
          : sessionError("not-found", `Session not found: ${id}`, id)
      }
      return { session: this.createAcceptedSession(id, requestedBrowser ? { browser: requestedBrowser } : undefined), created: true }
    })
  }

  private closeOpenCodeBrowserSession(session: OpenCodeBrowserSession): Effect.Effect<void> {
    return closeSessionSettledWithTimeout(this.admission, this.hooks, session, this.closeOpenCodeBrowserSessionSettled(session))
  }

  private disconnectOpenCodeBrowserSession(session: OpenCodeBrowserSession): Effect.Effect<void> {
    return Effect.acquireUseRelease(
      Effect.sync(() => this.admission.retainWork(session.id)),
      () => session.sandbox.disconnectSettled().pipe(Effect.ignore),
      (release) => Effect.sync(release),
    )
  }

  private closeOpenCodeBrowserSessionSettled(session: OpenCodeBrowserSession): Effect.Effect<void> {
    return session.sandbox.closeSettled({ clearState: true }).pipe(Effect.ignore)
  }

  private releaseSessionTargetOwnership(session: OpenCodeBrowserSession): Effect.Effect<void> {
    const ids = sessionRelayTargetIds(this.hooks, session)
    if (session.target) ids.add(session.target.id)
    for (const id of ids) this.notifyTargetOwnershipChange(this.targetOwnership.releaseTargetOwnership(id, session.id))
    delete session.target
    return Effect.void
  }

  private closeSessionRelayTargets(session: OpenCodeBrowserSession): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      const closed = new Set<string>()
      const defaultId = session.target?.owner === "relay" ? session.target.id : undefined
      if (defaultId) {
        yield* this.closeRelayTarget(defaultId).pipe(Effect.ignore)
        closed.add(defaultId)
      }
      while (true) {
        const pending = Array.from(sessionRelayTargetIds(this.hooks, session)).filter((id) => !closed.has(id))
        if (pending.length === 0) return
        // Each release may poll for up to the grace period; run a few at once instead of one after another.
        yield* Effect.forEach(pending, (targetId) =>
          this.closeRelayTarget(targetId).pipe(
            Effect.ignore,
            Effect.andThen(Effect.sync(() => { closed.add(targetId) })),
          ), { concurrency: 4, discard: true })
      }
    })
  }

  private closeRelayTarget(targetId: string): Effect.Effect<void, Error> {
    return this.hooks.onReleaseRelayTarget?.(targetId) ?? Effect.void
  }

  private notifyTargetOwnershipChange(change: TargetOwnershipChange): void {
    if (change.targetIds.length === 0 && change.tabIds.length === 0) return
    try {
      this.hooks.onTargetOwnershipChange?.(change)
    } catch (error) {
      console.error("Target ownership hook failed", error)
    }
  }

  private cleanupCreatedSession(session: OpenCodeBrowserSession): Effect.Effect<void> {
    const manager = this
    return Effect.gen(function* () {
      if (manager.sessions.get(session.id) !== session) return
      yield* manager.closeSessionRelayTargets(session)
      manager.sessions.delete(session.id)
      yield* manager.releaseSessionTargetOwnership(session)
      yield* manager.closeOpenCodeBrowserSession(session)
      yield* manager.admission.commitPersistence().pipe(Effect.ignore)
    })
  }

  private withLifecyclePermit<A, E, R>(
    session: OpenCodeBrowserSession,
    operation: string,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | Error, R> {
    return Effect.suspend(() => {
      let state: "waiting" | "started" | "timed-out" = "waiting"
      const timeout = sessionError("timeout", `Session ${operation} timed out waiting for active execute in ${session.id}`, session.id)
      return Effect.raceFirst(
        session.executeSemaphore.withPermit(Effect.suspend((): Effect.Effect<A, E | Error, R> => {
          if (state === "timed-out") return Effect.fail(timeout)
          state = "started"
          return effect
        }).pipe(Effect.uninterruptible)),
        Effect.sleep(this.hooks.lifecycleTimeoutMs ?? 10_000).pipe(Effect.flatMap(() => {
          if (state === "started") return Effect.never
          state = "timed-out"
          return Effect.fail(timeout)
        })),
      )
    })
  }
}
