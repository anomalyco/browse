import { Deferred, Effect, Fiber, Option } from "effect"
import { hasExplicitTargetSelection, type ExecuteTargetSelection } from "../execute.ts"
import type { OpenCodeBrowserSession } from "../relay/types.ts"
import {
  adoptionTipForUrl,
  createdSummary,
  defaultExecuteTimeoutMs,
  ExecutionDeadline,
  sessionError,
  shouldAppendAdoptionTip,
  stoppedExecuteResult,
  trySession,
  type ExecutionResponse,
  type RunningExecution,
  type SessionContext,
  type SessionExecuteRecord,
} from "./types.ts"

export interface ExecutionContext extends SessionContext {
  readonly runningExecutions: Map<string, RunningExecution>
  readonly setExecuting: (id: string, executing: boolean) => Effect.Effect<void>
  readonly endStoppedScript: (session: OpenCodeBrowserSession) => Effect.Effect<void>
  readonly stopGraceMs: () => number
  readonly replaceSandbox: (session: OpenCodeBrowserSession) => void
  readonly recordExecute: (record: SessionExecuteRecord) => Effect.Effect<void>
  readonly cleanupCreatedSession: (session: OpenCodeBrowserSession) => Effect.Effect<void>
  readonly stopExecution: (sessionId: string, message: string, diagnostic: string) => void
}

export function executeInSession(
  ctx: ExecutionContext,
  options: {
    readonly sessionId?: string
    readonly code: string
    readonly createIfMissing: boolean
    readonly removeAfterExecute?: boolean
    readonly timeoutMs?: number
    readonly targetSelection?: ExecuteTargetSelection
    readonly browser?: string
  },
): Effect.Effect<ExecutionResponse, Error> {
  return ctx.admission.withAdmission(options.sessionId, Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
    if (options.removeAfterExecute && options.sessionId) {
      return yield* sessionError("invalid-request", "One-shot execute requires a fresh unnamed session")
    }
    const resolved = yield* ctx.resolveWorkSession(options.sessionId, options.createIfMissing, options.browser)
    const session = resolved.session
    const response = yield* Deferred.make<ExecutionResponse, Error>()
    const stopSignal = Deferred.makeUnsafe<{ readonly message: string; readonly diagnostic: string }>()
    let started = false
    let cancelled = false
    let stopped: { readonly message: string; readonly diagnostic: string } | undefined
    const chosenTimeoutMs = options.timeoutMs ?? ctx.hooks.executeTimeoutMs
    const effectiveTimeoutMs = chosenTimeoutMs ?? defaultExecuteTimeoutMs
    // Only an explicit per-call or relay timeout raises Playwright's 30s action timeout; the built-in default leaves it alone.
    const actionTimeoutMs = chosenTimeoutMs === undefined
      ? undefined
      : chosenTimeoutMs === 0 ? 0 : Math.max(30_000, chosenTimeoutMs)
    let deadline: ExecutionDeadline | undefined
    const stopRunning = (message: string, diagnostic: string) => {
      // A timeout and a toolbar stop can race; the caller gets whichever stopped it first.
      if (stopped !== undefined) return
      stopped = { message, diagnostic }
      deadline?.cancel()
      Effect.runSync(Deferred.succeed(stopSignal, { message, diagnostic }))
      Effect.runSync(Deferred.succeed(response, {
        result: stoppedExecuteResult(message, diagnostic),
        session: createdSummary(session, resolved.created),
      }))
    }
    // Armed before the session's execute lock: a call queued behind a stopped execute that is still settling gets
    // its own timeout instead of waiting for that lock, which may be held by a wedged tab's browser connection.
    if (effectiveTimeoutMs > 0) {
      deadline = new ExecutionDeadline(effectiveTimeoutMs, () => {
        stopRunning(
          `Execute timed out after ${effectiveTimeoutMs}ms. Pass --timeout-ms <ms> (or timeoutMs in MCP) for longer runs, or 0 to disable.`,
          "execute-timeout",
        )
      })
    }
    const operation = Effect.gen(function* () {
      if (cancelled) {
        return yield* sessionError("inactive", `Session execute was cancelled before starting: ${session.id}`, session.id)
      }
      // The deadline expired while this call waited for the execute lock; its caller already has the answer.
      if (stopped !== undefined) {
        return { result: stoppedExecuteResult(stopped.message, stopped.diagnostic), session: createdSummary(session, resolved.created) }
      }
      if (ctx.sessions.get(session.id) !== session) {
        return yield* sessionError("inactive", `Session is no longer active: ${session.id}`, session.id)
      }
      yield* trySession(() => ctx.resolveBrowser(options.browser, session))
      // Don't dispatch user code into a sleeping browser: it could otherwise run long after its caller gave up.
      if (session.browser?.key && ctx.hooks.checkBrowserResponsive) yield* ctx.hooks.checkBrowserResponsive(session.browser.key).pipe(
        Effect.mapError(error => sessionError("browser-unavailable", error.message, session.id)),
      )
      started = true
      session.updatedAt = new Date().toISOString()
      const released = Deferred.makeUnsafe<{ readonly forced: boolean }>()
      const running: RunningExecution = {
        released,
        stop: stopRunning,
        pauseTimeout: () => deadline ? deadline.pause() : () => {},
      }
      // Registered before setExecuting yields: a caller that disconnects while the state hook runs still finds the
      // execution to stop instead of leaving its script running with nobody waiting for it.
      ctx.runningExecutions.set(session.id, running)
      yield* ctx.setExecuting(session.id, true)
      let forced = false
      const startedAt = Date.now()
      // The script runs in its own fiber so a stop can release the execute lock without waiting for it: a stopped
      // script that never settles (it awaits a timer the stop cleared) is abandoned, not awaited.
      const result = yield* Effect.gen(function* () {
        const script = yield* session.sandbox
          .execute(options.code, {
            ...(options.targetSelection ? { targetSelection: options.targetSelection } : {}),
            ...(actionTimeoutMs === undefined ? {} : { actionTimeoutMs }),
          })
          .pipe(Effect.forkDetach({ startImmediately: true }))
        const first = yield* Effect.raceFirst(
          Fiber.join(script).pipe(Effect.map((value) => ({ settled: true as const, value }))),
          Deferred.await(stopSignal).pipe(Effect.map((stop) => ({ settled: false as const, stop }))),
        )
        if (first.settled) return first.value
        yield* ctx.endStoppedScript(session)
        // Its own outcome no longer matters (the caller has the stop); only whether it settled does.
        const settled = yield* Fiber.join(script).pipe(Effect.exit, Effect.timeoutOption(ctx.stopGraceMs()))
        if (Option.isNone(settled)) {
          forced = true
          // Again: a stop during connect lets the script finish connecting after the first abort.
          yield* ctx.endStoppedScript(session)
          ctx.replaceSandbox(session)
        }
        return stoppedExecuteResult(first.stop.message, first.stop.diagnostic)
      }).pipe(Effect.ensuring(Effect.gen(function* () {
        deadline?.cancel()
        if (ctx.runningExecutions.get(session.id) === running) ctx.runningExecutions.delete(session.id)
        yield* ctx.setExecuting(session.id, false)
        Effect.runSync(Deferred.succeed(released, { forced }))
      })))
      if (resolved.created && result.setupFailed) {
        return yield* sessionError("setup-failed", result.text, session.id)
      }
      const userAttachedPageUrls = ctx.hooks.getUserAttachedPageUrls?.(session) ?? []
      const resultWithHint = shouldAppendAdoptionTip({
        explicitTargetSelection: hasExplicitTargetSelection(options.targetSelection),
        sessionCreated: resolved.created,
        warnings: result.warnings,
        userAttachedPageUrls,
      })
        ? { ...result, warnings: [...result.warnings, adoptionTipForUrl(userAttachedPageUrls[0] ?? "about:blank")] }
        : result
      session.updatedAt = new Date().toISOString()
      yield* ctx.recordExecute({
        sessionId: session.id,
        code: session.sandbox.redactNetworkCaptureText(options.code),
        durationMs: Date.now() - startedAt,
        result: resultWithHint,
      })
      yield* ctx.admission.commitPersistence()
      return { result: resultWithHint, session: createdSummary(session, resolved.created) }
    })
    const worker = session.executeSemaphore.withPermit(operation.pipe(Effect.matchEffect({
      onFailure: (error) => (resolved.created
        ? ctx.cleanupCreatedSession(session)
        : Effect.void).pipe(Effect.andThen(Effect.sync(() => deadline?.cancel())), Effect.andThen(Deferred.fail(response, error))),
      onSuccess: (value) => (options.removeAfterExecute
        ? ctx.cleanupCreatedSession(session)
        : Effect.void).pipe(Effect.andThen(Effect.sync(() => deadline?.cancel())), Effect.andThen(Deferred.succeed(response, value))),
    })))
    const workerFiber = yield* ctx.admission.forkTracked(worker, session.id)
    return yield* restore(Deferred.await(response)).pipe(
      Effect.onInterrupt(() => Effect.suspend(() => {
        if (started) {
          ctx.stopExecution(session.id, `Execute stopped because its caller disconnected.`, "client-disconnected")
          return Effect.void
        }
        cancelled = true
        deadline?.cancel()
        return Fiber.interrupt(workerFiber).pipe(
          Effect.asVoid,
          Effect.andThen(resolved.created
            ? session.executeSemaphore.withPermit(ctx.cleanupCreatedSession(session))
            : Effect.void),
        )
      })),
    )
  })))
}
