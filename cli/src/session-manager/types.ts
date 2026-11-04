import { Deferred, Effect, Schema } from "effect"
import { defaultPageClosedWarning, type ExecuteResult } from "../execute.ts"
import { cliCommand } from "../paths.ts"
import type { AuthenticatedJsonOutcome, AuthenticatedJsonRequest } from "../relay/schema.ts"
import type { ConnectedTarget, OpenCodeBrowserSession, SessionSummary, SessionTarget } from "../relay/types.ts"
import type { PersistedSession } from "./catalog.ts"
import type { TargetOwnershipChange } from "../cdp/target-registry.ts"

export type { AuthenticatedJsonOutcome, AuthenticatedJsonRequest }

export type SessionExecuteRecord = {
  readonly sessionId: string
  readonly code: string
  readonly durationMs: number
  readonly result: ExecuteResult
}

export type CreatedSessionSummary = SessionSummary & { readonly created?: boolean }
export type SessionCreateOptions = { readonly readOnly?: boolean; readonly allowedOrigins?: readonly string[]; readonly browser?: string }

export type ExecutionResponse = { readonly result: ExecuteResult; readonly session: CreatedSessionSummary }

export type AdoptionResult = {
  readonly adoptedUrl: string
  readonly session: CreatedSessionSummary
  readonly releasedTargetIds: readonly string[]
}

export const defaultExecuteTimeoutMs = 60_000

export type SessionHooks = {
  /** Select once on creation, otherwise check the stored profile and any requested selector. */
  readonly resolveBrowser?: (requested?: string, session?: OpenCodeBrowserSession) => { readonly id: string; readonly key: string } | { readonly error: string; readonly unavailable?: true }
  readonly targetBrowserKey?: (tabId: number) => string | undefined
  /** Called when a session starts (true) or finishes (false) an execute. */
  readonly onExecuteStateChange?: (sessionId: string, executing: boolean) => void | Effect.Effect<void>
  /** Called after each execute completes, for journaling. Failure is logged and ignored. */
  readonly onExecuteRecord?: (record: SessionExecuteRecord) => unknown | Promise<unknown>
  /** How long lifecycle commands wait for a permit or sandbox operation. */
  readonly lifecycleTimeoutMs?: number
  /** Overall budget for a single execute call (paused while handoff waits on the user); 0 disables. */
  readonly executeTimeoutMs?: number
  /** Maximum time best-effort journal I/O may retain an execute permit. */
  readonly journalTimeoutMs?: number
  /** Current user-owned attached page URLs, used for relay-side adoption hints. */
  readonly getUserAttachedPageUrls?: (session: OpenCodeBrowserSession) => readonly string[]
  /** Reconcile relay visibility and presentation after authoritative ownership changes. */
  readonly onTargetOwnershipChange?: (change: TargetOwnershipChange) => void
  /** Close a live relay-owned target by its durable target id. */
  readonly onReleaseRelayTarget?: (targetId: string) => Effect.Effect<void, Error>
  /** Target ids of every live relay-owned page of a session: its default page and the pages and popups it opened. */
  readonly relayTargetIdsForSession?: (sessionId: string) => readonly string[]
  /** Live root targets currently attached to the relay. */
  readonly getTargets?: () => readonly ConnectedTarget[]
  /** Persist session identity and target continuity after durable lifecycle changes. */
  readonly onSessionsChanged?: (sessions: readonly PersistedSession[]) => unknown | Promise<unknown>
  /** Cancel the session's pending handoff so its waiter fails; true when one was pending. */
  readonly onCancelSessionHandoff?: (sessionId: string) => boolean
  /** How long a stopped script may take to settle before its sandbox is abandoned and the execute lock released. */
  readonly stopGraceMs?: number
}

/** What a stop, delete or reset had to end in the session first. */
export type SessionStopReport = {
  /** A running execute was stopped (its caller got an error). */
  readonly execute: boolean
  /** A pending handoff was cancelled. */
  readonly handoff: boolean
  /** The stopped script didn't settle within the grace period; its sandbox (and execute state) was replaced. */
  readonly forced: boolean
}

export type RunningExecution = {
  readonly stop: (message: string, diagnostic: string) => void
  readonly pauseTimeout: () => () => void
  /** Settles once the execute lock is released, with whether the script had to be abandoned. */
  readonly released: Deferred.Deferred<{ readonly forced: boolean }>
}

export class ExecutionDeadline {
  private remainingMs: number
  private startedAt: number | undefined
  private timer: NodeJS.Timeout | undefined
  private pauses = 0
  private settled = false

  constructor(timeoutMs: number, private readonly onExpire: () => void) {
    this.remainingMs = timeoutMs
    this.arm()
  }

  pause(): () => void {
    if (!this.settled && this.pauses++ === 0 && this.startedAt !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
      this.remainingMs = Math.max(0, this.remainingMs - (Date.now() - this.startedAt))
      this.startedAt = undefined
    }
    let resumed = false
    return () => {
      if (resumed) return
      resumed = true
      if (!this.settled && --this.pauses === 0) this.arm()
    }
  }

  cancel(): void {
    this.settled = true
    clearTimeout(this.timer)
    this.timer = undefined
  }

  private arm(): void {
    if (this.settled || this.pauses > 0) return
    if (this.remainingMs <= 0) {
      this.settled = true
      this.onExpire()
      return
    }
    this.startedAt = Date.now()
    this.timer = setTimeout(() => {
      this.settled = true
      this.onExpire()
    }, this.remainingMs)
    this.timer.unref?.()
  }
}

export class SessionError extends Schema.TaggedError<SessionError>()(
  "OpenCodeBrowserSessions.SessionError",
  {
    message: Schema.String,
    reason: Schema.Literals([
      "already-exists",
      "browser-unavailable",
      "inactive",
      "invalid-request",
      "not-found",
      "setup-failed",
      "target-owned",
      "timeout",
    ]),
    sessionId: Schema.optionalKey(Schema.String),
  },
) {}

export const sessionError = (
  reason: SessionError["reason"],
  message: string,
  sessionId?: string,
): SessionError => new SessionError({ message, reason, ...(sessionId ? { sessionId } : {}) })

export const trySession = <A>(work: () => A) => Effect.try({ try: work, catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)) })

export const adoptionTipForUrl = (url: string): string => {
  const selector = targetUrlHintSelector(url)
  return `Tip: an attached tab is open (${url}). Use session_adopt with targetUrl '${selector}' (CLI: ${cliCommand(`session adopt --target-url '${selector}'`)}) to drive it instead of this new tab.`
}

export const shouldAppendAdoptionTip = (options: {
  readonly explicitTargetSelection: boolean
  readonly sessionCreated: boolean
  readonly warnings: readonly string[]
  readonly userAttachedPageUrls: readonly string[]
}): boolean => {
  if (options.explicitTargetSelection || options.userAttachedPageUrls.length === 0) {
    return false
  }
  return options.sessionCreated || options.warnings.includes(defaultPageClosedWarning)
}

export function stoppedExecuteResult(message: string, diagnostic: string): ExecuteResult {
  return {
    text: message,
    isError: true,
    logs: [],
    logSummary: { totalCount: 0, returnedCount: 0, repeatedCount: 0, omittedCount: 0 },
    warnings: [],
    diagnostic,
  }
}

export function sessionSummary(session: OpenCodeBrowserSession): SessionSummary {
  const status = session.sandbox.getStatus()
  return {
    id: session.id,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    connected: status.connected,
    pageUrl: status.pageUrl,
    stateKeys: status.stateKeys,
    ...(session.readOnly ? { readOnly: true } : {}),
    ...(session.allowedOrigins ? { allowedOrigins: [...session.allowedOrigins] } : {}),
    ...(session.browser ? { browser: session.browser.id } : {}),
  }
}

export function persistedSession(session: OpenCodeBrowserSession): PersistedSession {
  const target: SessionTarget | undefined = session.target
  return {
    id: session.id,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    readOnly: session.readOnly,
    ...(session.allowedOrigins ? { allowedOrigins: [...session.allowedOrigins] } : {}),
    ...(session.browser ? { browser: session.browser.id, ...(session.browser.key ? { browserKey: session.browser.key } : {}) } : {}),
    ...(target ? { target } : {}),
    ...(session.clientPid === undefined ? {} : { clientPid: session.clientPid }),
  }
}

function targetUrlHintSelector(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl)
    return parsed.host || rawUrl
  } catch {
    return rawUrl
  }
}
