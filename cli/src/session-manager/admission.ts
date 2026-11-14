import { Deferred, Effect, Exit, Fiber, Latch } from "effect"
import type { OpenCodeBrowserSession } from "../relay/types.ts"
import type { PersistedSession } from "./catalog.ts"
import { persistedSession, sessionError, type PendingSessionWork, type SessionHooks } from "./types.ts"

export class SessionAdmission {
  private persistenceTail = Promise.resolve()
  private drainedPersistenceTail: Promise<void> | undefined
  private admission: "open" | "draining" | "closed" = "open"
  private pendingWork = 0
  private readonly pendingSessionWork = new Map<string, number>()
  private readonly identityChanges = new Map<string, Deferred.Deferred<void, Error>>()
  private readonly idle = Latch.makeUnsafe(true)

  constructor(
    private readonly sessions: Map<string, OpenCodeBrowserSession>,
    private readonly hooks: SessionHooks,
  ) {}

  hasPendingWork(id: string): boolean {
    return this.pendingSessionWork.has(id)
  }

  /** Sessions holding accepted work now, and how much, so a bounded shutdown can name what it is leaving behind. */
  pendingWorkBySession(): readonly PendingSessionWork[] {
    return Array.from(this.pendingSessionWork, ([sessionId, pending]) => ({ sessionId, pending }))
  }

  assertAdmission(): void {
    if (this.admission !== "open") {
      throw sessionError("inactive", this.admission === "closed"
        ? "browse sessions are closing"
        : "browse sessions are draining")
    }
  }

  assertStableIdentity(id: string): void {
    if (this.identityChanges.has(id)) {
      throw sessionError("inactive", `Session lifecycle change is still committing: ${id}`, id)
    }
  }

  private awaitStableIdentity(id: string | undefined): Effect.Effect<void, Error> {
    return Effect.suspend(() => {
      const pending = id === undefined ? undefined : this.identityChanges.get(id)
      return pending ? Deferred.await(pending).pipe(Effect.andThen(this.awaitStableIdentity(id))) : Effect.void
    })
  }

  /** Keep same-ID callers behind the entire commit/rollback, including corrective persistence. */
  withIdentityChange<A>(id: string, effect: Effect.Effect<A, Error>): Effect.Effect<A, Error> {
    return Effect.suspend(() => {
      // Check and claim synchronously: the run loop may yield between separate effects.
      const pending = this.identityChanges.get(id)
      if (pending) return Deferred.await(pending).pipe(Effect.andThen(this.withIdentityChange(id, effect)))
      const settled = Deferred.makeUnsafe<void, Error>()
      this.identityChanges.set(id, settled)
      return effect.pipe(Effect.onExit((exit) => Effect.suspend(() => {
        if (this.identityChanges.get(id) === settled) this.identityChanges.delete(id)
        // Waiters observe the change's failure or interruption and do not proceed past it.
        return Deferred.done(settled, Exit.asVoid(exit))
      })))
    })
  }

  retainWork(sessionId?: string): () => void {
    this.pendingWork += 1
    if (sessionId !== undefined) this.pendingSessionWork.set(sessionId, (this.pendingSessionWork.get(sessionId) ?? 0) + 1)
    this.idle.closeUnsafe()
    return () => {
      this.pendingWork -= 1
      if (sessionId !== undefined) {
        const remaining = (this.pendingSessionWork.get(sessionId) ?? 1) - 1
        if (remaining === 0) this.pendingSessionWork.delete(sessionId)
        else this.pendingSessionWork.set(sessionId, remaining)
      }
      if (this.pendingWork === 0) this.idle.openUnsafe()
    }
  }

  withAdmission<A, E, R>(sessionId: string | undefined, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | Error, R> {
    return Effect.acquireUseRelease(
      Effect.try({
        try: () => {
          this.assertAdmission()
          return this.retainWork(sessionId)
        },
        catch: (cause) => cause instanceof Error ? cause : new Error("Admit session operation", { cause }),
      }),
      () => this.awaitStableIdentity(sessionId).pipe(Effect.andThen(effect)),
      (release) => Effect.sync(release),
    )
  }

  forkTracked<A, E, R>(effect: Effect.Effect<A, E, R>, sessionId: string): Effect.Effect<Fiber.Fiber<A, E>, never, R> {
    return Effect.uninterruptibleMask(() => Effect.suspend(() => {
      // Transfer the lease before forking; caller interruption cannot strand it.
      const release = this.retainWork(sessionId)
      return effect.pipe(
        Effect.ensuring(Effect.sync(release)),
        Effect.forkDetach({ startImmediately: true }),
      )
    }))
  }

  private persistedSessions(): PersistedSession[] {
    return Array.from(this.sessions.values(), (session) => persistedSession(session, this.hooks))
  }

  schedulePersistence(): void {
    const hook = this.hooks.onSessionsChanged
    if (!hook) return
    const sessions = this.persistedSessions()
    const release = this.retainWork()
    const previous = this.persistenceTail
    this.persistenceTail = previous.catch(() => {}).then(async () => {
      try {
        await hook(sessions)
      } finally {
        release()
      }
    })
    void this.persistenceTail.catch((error) => {
      console.error("Failed to persist browse sessions", error)
    })
  }

  flushPersistence(): Effect.Effect<void, Error> {
    return Effect.tryPromise({
      try: () => this.persistenceTail,
      catch: (cause) => cause instanceof Error ? cause : new Error("Persist browse sessions", { cause }),
    })
  }

  commitPersistence(rollback?: () => Effect.Effect<void>): Effect.Effect<void, Error> {
    this.schedulePersistence()
    return rollback ? this.flushPersistenceWithRollback(rollback) : this.flushPersistence()
  }

  flushPersistenceWithRollback(rollback: () => Effect.Effect<void>): Effect.Effect<void, Error> {
    return this.flushPersistence().pipe(Effect.catch((error) => Effect.gen({ self: this }, function* () {
      yield* rollback()
      this.schedulePersistence()
      yield* this.flushPersistence().pipe(Effect.ignore)
      return yield* Effect.fail(error)
    })))
  }

  /** Stop admission without cancelling accepted work or disconnecting sessions. */
  beginDrain(): Effect.Effect<void, Error> {
    const self = this
    return Effect.gen(function* () {
      if (self.admission === "open") self.admission = "draining"
      while (true) {
        yield* self.idle.await
        const pending = self.persistenceTail
        yield* self.flushPersistence()
        // Target callbacks can append persistence while the previous tail settles.
        if (self.pendingWork === 0 && pending === self.persistenceTail) {
          self.drainedPersistenceTail = pending
          return
        }
      }
    })
  }

  /** Recheck synchronously at commit: late catalog writes invalidate a completed drain. */
  isDrained(): boolean {
    return this.admission !== "open"
      && this.pendingWork === 0
      && this.drainedPersistenceTail === this.persistenceTail
  }

  /** Call only after cancelling or completing the reversible drain waiter. */
  resume(): void {
    if (this.admission === "draining") this.admission = "open"
  }

  markClosed(): void {
    this.admission = "closed"
  }
}
