import { Data, Effect, Exit, Latch, Match, Schema } from "effect"
import type { RelayShutdownRequest } from "./relay-schema.ts"
import { RelayLifecycleEvent } from "./relay-lifecycle-log.ts"
import { cliCommand } from "./paths.ts"

/** What keeps the relay from restarting, in words for the user ("a network capture in session x since 12:01"). */
export type RelayBusy = { readonly reason: "raw-clients" | "recordings"; readonly detail: string }

type State = Data.TaggedEnum<{
  Running: {}
  Draining: {}
  Stopping: {}
  Closing: {}
}>
const State = Data.taggedEnum<State>()

export class RelayShutdownError extends Schema.TaggedError<RelayShutdownError>()(
  "RelayShutdown.Error",
  {
    reason: Schema.Literals(["busy", "instance-changed", "not-managed"]),
    message: Schema.String,
  },
) {}

export class RelayShutdown {
  private state: State = State.Running()
  private requests = 0
  private readonly idle = Latch.makeUnsafe(true)

  constructor(private readonly options: {
    readonly instanceId: string
    readonly managed: boolean
    readonly drain: Effect.Effect<void, Error>
    readonly resume: () => void
    readonly busy: () => RelayBusy | undefined
    /** For a forced restart: ends captures and recordings and disconnects raw CDP clients. */
    readonly release?: Effect.Effect<void>
    readonly settle: Effect.Effect<void, Error>
    readonly quiescent: () => boolean
    readonly audit: (event: RelayLifecycleEvent) => Effect.Effect<void, Error>
    readonly stop: () => void
    readonly timeoutMs?: number
  }) {}

  get accepting(): boolean {
    return State.$is("Running")(this.state)
  }

  get stopping(): boolean {
    return State.$is("Stopping")(this.state) || State.$is("Closing")(this.state)
  }

  close(): Effect.Effect<void, Error> {
    const control = this
    return Effect.gen(function* () {
      control.state = State.Closing()
      yield* Effect.all([control.options.drain, control.idle.await], { concurrency: "unbounded" })
      yield* control.idle.await
      yield* control.options.settle
    })
  }

  track<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | RelayShutdownError, R> {
    const control = this
    return Effect.acquireUseRelease(
      Effect.suspend(() => {
        if (!control.accepting) return Effect.fail(control.busyError())
        return Effect.sync(() => control.retain())
      }),
      () => effect,
      (release) => Effect.sync(release),
    )
  }

  // Already-admitted sandbox work needs continuation RPCs during a drain.
  // Keep their lifetime independent of the client socket remaining connected.
  trackTransport<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
    return Effect.acquireUseRelease(
      Effect.sync(() => this.retain()),
      () => effect,
      (release) => Effect.sync(release),
    )
  }

  private retain(): () => void {
    this.requests += 1
    this.idle.closeUnsafe()
    return () => {
      if (--this.requests === 0) this.idle.openUnsafe()
    }
  }

  request(request: RelayShutdownRequest): Effect.Effect<void, Error> {
    const control = this
    return Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
      if (request.instanceId !== control.options.instanceId) {
        return yield* new RelayShutdownError({ reason: "instance-changed", message: "Relay shutdown does not match the active managed instance" })
      }
      if (!control.options.managed) {
        return yield* new RelayShutdownError({ reason: "not-managed", message: "A foreground relay must be stopped by its owner" })
      }
      if (!control.accepting) return yield* control.busyError()
      // A forced restart ends what would otherwise refuse it (the user asked for exactly that).
      if (request.force === true && control.options.busy() && control.options.release) {
        yield* control.options.release
      }
      control.state = State.Draining()
      const fields = { instanceId: request.instanceId, requestId: request.requestId, client: request.client }
      yield* Effect.gen(function* () {
        yield* control.options.audit(RelayLifecycleEvent.cases.Requested.make(fields))
        const drain = Effect.gen(function* () {
          const busy = control.options.busy()
          if (busy) return yield* control.busyError(busy)
          yield* Effect.all([control.options.drain, control.idle.await], { concurrency: "unbounded" })
          yield* control.idle.await
          yield* control.options.settle
          const remaining = control.options.busy()
          if (remaining) return yield* control.busyError(remaining)
        })
        yield* restore(drain.pipe(Effect.timeoutOrElse({
          duration: control.options.timeoutMs ?? 10_000,
          orElse: () => control.busyError("timeout"),
        })))
        if (!State.$is("Draining")(control.state)) {
          return yield* control.busyError()
        }
        yield* control.options.audit(RelayLifecycleEvent.cases.Stopping.make(fields))
        yield* restore(Effect.void)
        if (!State.$is("Draining")(control.state)) {
          return yield* control.busyError()
        }
        if (control.requests !== 0 || !control.options.quiescent()) {
          return yield* control.busyError("changed")
        }
        const busy = control.options.busy()
        if (busy) return yield* control.busyError(busy)
        control.state = State.Stopping()
        control.options.stop()
      }).pipe(Effect.onExit((exit) => {
        if (Exit.isSuccess(exit) || !State.$is("Draining")(control.state)) return Effect.void
        control.options.resume()
        control.state = State.Running()
        return control.options.audit(RelayLifecycleEvent.cases.Cancelled.make(fields)).pipe(
          Effect.catch(() => Effect.sync(() => {
            console.error(`Relay cancellation audit failed for request ${request.requestId}`)
          })),
        )
      }))
    }))
  }

  private busyError(busy?: RelayBusy | "timeout" | "changed"): RelayShutdownError {
    const reason = typeof busy === "object" ? busy.reason : busy
    const detail = typeof busy === "object" ? busy.detail : undefined
    const force = cliCommand("relay restart --force")
    const message = Match.value(reason).pipe(
      Match.when("raw-clients", () => `Relay has ${detail ?? "raw CDP clients attached"}; disconnect them, or run \`${force}\` to disconnect them and restart`),
      Match.when("recordings", () => `Relay has ${detail ?? "active recordings or network captures"}; stop them, or run \`${force}\` to end them (discarding what they captured) and restart`),
      Match.when("timeout", () => "Relay restart timed out waiting for accepted work; the relay is still running"),
      Match.when("changed", () => "Relay changed while preparing restart; it is still running, retry the restart"),
      Match.orElse(() => "Relay is draining for an explicit restart; retry after it completes"),
    )
    return new RelayShutdownError({ reason: "busy", message })
  }
}
