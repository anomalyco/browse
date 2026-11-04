import { Deferred, Effect, Fiber, Result, Semaphore } from "effect"
import type { OpenCodeBrowserSession, SessionTarget } from "../relay/types.ts"
import type { TargetOwnership, TargetOwnershipChange, TargetOwnershipReservation } from "../cdp/target-registry.ts"
import type { SessionAdmission } from "./admission.ts"
import {
  sessionError,
  sessionSummary,
  trySession,
  type AdoptionResult,
  type CreatedSessionSummary,
  type SessionHooks,
} from "./types.ts"

export type AdoptionContext = {
  readonly sessions: Map<string, OpenCodeBrowserSession>
  readonly hooks: SessionHooks
  readonly targetOwnership: TargetOwnership
  readonly adoptSemaphore: Semaphore.Semaphore
  readonly admission: SessionAdmission
  readonly resolveWorkSession: (id: string | undefined, createIfMissing: boolean, requestedBrowser?: string) => Effect.Effect<{ readonly session: OpenCodeBrowserSession; readonly created: boolean }, Error>
  readonly resolveBrowser: (requested?: string, session?: OpenCodeBrowserSession) => OpenCodeBrowserSession["browser"]
  readonly createOpenCodeBrowserSession: (id: string, readOnly: boolean, timestamps?: { readonly createdAt: string; readonly updatedAt?: string }) => OpenCodeBrowserSession
  readonly closeOpenCodeBrowserSessionSettled: (session: OpenCodeBrowserSession) => Effect.Effect<void>
  readonly closeRelayTarget: (targetId: string) => Effect.Effect<void, Error>
  readonly releaseSessionTargetOwnership: (session: OpenCodeBrowserSession) => Effect.Effect<void>
  readonly notifyTargetOwnershipChange: (change: TargetOwnershipChange) => void
}

export function adoptTargetForSession(
  context: AdoptionContext,
  options: {
    readonly sessionId?: string
    readonly createIfMissing: boolean
    readonly targetId: string
    readonly targetUrl: string
    readonly tabId?: number
  },
): Effect.Effect<AdoptionResult, Error> {
  return context.admission.withAdmission(options.sessionId, Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
    const resolved = yield* context.resolveWorkSession(options.sessionId, options.createIfMissing)
    const session = resolved.session
    const result = yield* Deferred.make<AdoptionResult, Error>()
    let state: "pending" | "reserved" | "committed" = "pending"
    let cancelled = false
    let reservation: TargetOwnershipReservation | undefined
    let previousTarget: SessionTarget | undefined
    let previousRelayClosed = false
    const timeoutMs = context.hooks.lifecycleTimeoutMs ?? 10_000
    const timeoutError = sessionError("timeout", `Session adopt for ${session.id} timed out after ${timeoutMs}ms`, session.id)
    const adoptionCancelled = () => cancelled
    const cancel = Effect.sync(() => {
      if (cancelled) {
        return
      }
      cancelled = true
      if (reservation && state === "reserved") {
        context.notifyTargetOwnershipChange(context.targetOwnership.rollbackTargetOwnership(reservation))
      }
    })
    const operation = Effect.gen(function* () {
      if (context.sessions.get(session.id) !== session) {
        return yield* sessionError("inactive", `Session is no longer active: ${session.id}`, session.id)
      }
      if (adoptionCancelled()) {
        return yield* timeoutError
      }
      const browser = yield* trySession(() => context.resolveBrowser(undefined, session))
      if (options.tabId !== undefined && browser?.key && context.hooks.targetBrowserKey?.(options.tabId) !== browser.key) {
        return yield* sessionError("invalid-request", `Tab ${options.tabId} is not in session ${session.id}'s browser '${browser.id}'. Start a new session for its browser.`, session.id)
      }
      reservation = yield* Effect.try({
        try: () => context.targetOwnership.reserveTargetOwnership(options.targetId, session.id),
        catch: (cause) => cause instanceof Error ? cause : new Error("Reserve target ownership", { cause }),
      })
      state = "reserved"
      context.notifyTargetOwnershipChange({ targetIds: [options.targetId], tabIds: reservation.tabId < 0 ? [] : [reservation.tabId] })
      previousTarget = session.target
      yield* session.sandbox.adoptPage(options.targetId)
      if (adoptionCancelled()) {
        return yield* timeoutError
      }
      const activeReservation = reservation
      previousTarget = session.target ?? previousTarget
      const previousTargetId = previousTarget?.id
      if (previousTarget?.owner === "relay" && previousTarget.id !== options.targetId) {
        yield* context.closeRelayTarget(previousTarget.id)
        previousRelayClosed = true
      }
      session.target = { id: options.targetId, owner: "user" }
      session.updatedAt = new Date().toISOString()
      yield* context.admission.commitPersistence()
      if (adoptionCancelled()) {
        return yield* timeoutError
      }
      yield* Effect.try({
        try: () => {
          context.notifyTargetOwnershipChange(context.targetOwnership.commitTargetOwnership({
            reservation: activeReservation,
            ...(previousTargetId ? { previousAdoptedTargetId: previousTargetId } : {}),
          }))
          state = "committed"
        },
        catch: (cause) => cause instanceof Error ? cause : new Error("Commit target ownership", { cause }),
      })
      const releasedTargetIds = previousTargetId && previousTargetId !== options.targetId ? [previousTargetId] : []
      const createdSummary: CreatedSessionSummary = { ...sessionSummary(session), ...(resolved.created ? { created: true } : {}) }
      const value = { adoptedUrl: options.targetUrl, releasedTargetIds, session: createdSummary }
      yield* Deferred.succeed(result, value)
      return value
    })
    const transaction = session.executeSemaphore.withPermit(operation.pipe(Effect.matchEffect({
      onFailure: (error) => Effect.gen(function* () {
        if (reservation && state !== "committed") {
          context.notifyTargetOwnershipChange(context.targetOwnership.rollbackTargetOwnership(reservation))
        }
        if (context.sessions.get(session.id) === session && (resolved.created || state !== "pending")) {
          const cleanup = yield* Effect.result(cleanupSettledAdoption(context, session, resolved.created, previousTarget, previousRelayClosed))
          if (Result.isFailure(cleanup)) {
            yield* Deferred.fail(result, cleanup.failure)
            return
          }
        }
        yield* Deferred.fail(result, error)
      }),
      onSuccess: () => Effect.void,
    })))
    const worker = context.adoptSemaphore.withPermit(transaction)
    yield* context.admission.forkTracked(worker, session.id)
    return yield* restore(Deferred.await(result).pipe(
      Effect.timeoutOrElse({
        duration: timeoutMs,
        orElse: () => cancel.pipe(Effect.andThen(Effect.fail(timeoutError))),
      }),
      Effect.onInterrupt(() => cancel),
    ))
  })))
}

function cleanupSettledAdoption(
  context: AdoptionContext,
  session: OpenCodeBrowserSession,
  created: boolean,
  previousTarget?: SessionTarget,
  previousRelayClosed = false,
): Effect.Effect<void, Error> {
  return Effect.gen(function* () {
    const activeTarget = session.target
    yield* context.releaseSessionTargetOwnership(session)
    if (previousTarget && previousTarget.id !== activeTarget?.id) {
      context.notifyTargetOwnershipChange(context.targetOwnership.releaseTargetOwnership(previousTarget.id, session.id))
      if (previousTarget.owner === "relay" && !previousRelayClosed) yield* context.closeRelayTarget(previousTarget.id)
    }
    yield* context.closeOpenCodeBrowserSessionSettled(session)
    if (context.sessions.get(session.id) !== session) {
      return
    }
    if (created) {
      context.sessions.delete(session.id)
    } else {
      const replacement = context.createOpenCodeBrowserSession(session.id, session.readOnly, {
        createdAt: session.createdAt,
      })
      if (session.allowedOrigins) replacement.allowedOrigins = session.allowedOrigins
      if (session.browser) replacement.browser = session.browser
      context.sessions.set(session.id, replacement)
    }
    yield* context.admission.commitPersistence()
  })
}

export function sessionRelayTargetIds(hooks: SessionHooks, session: OpenCodeBrowserSession): Set<string> {
  const ids = new Set(hooks.relayTargetIdsForSession?.(session.id) ?? [])
  for (const target of hooks.getTargets?.() ?? []) {
    if (target.owner === "relay" && target.opencodeBrowserSessionId === session.id) {
      ids.add(target.targetInfo.targetId)
    }
  }
  if (session.target?.owner === "relay") ids.add(session.target.id)
  else if (session.target) ids.delete(session.target.id)
  return ids
}

export function withLifecycleTimeout<A, E, R>(
  hooks: SessionHooks,
  effect: Effect.Effect<A, E, R>,
  label: string,
): Effect.Effect<A, E | Error, R> {
  const timeoutMs = hooks.lifecycleTimeoutMs ?? 10_000
  return effect.pipe(
    Effect.timeoutOrElse({
      duration: timeoutMs,
      orElse: () => Effect.fail(sessionError("timeout", `${label} timed out after ${timeoutMs}ms`)),
    }),
  )
}

export function closeSessionSettledWithTimeout(
  admission: SessionAdmission,
  hooks: SessionHooks,
  session: OpenCodeBrowserSession,
  closeSettled: Effect.Effect<void>,
): Effect.Effect<void> {
  return admission.forkTracked(closeSettled, session.id).pipe(
    Effect.flatMap((worker) => withLifecycleTimeout(hooks, Fiber.join(worker), `Close session ${session.id}`)),
    Effect.ignore,
  )
}
