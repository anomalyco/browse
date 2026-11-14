import type { Effect, Semaphore } from "effect"
import type { ExecuteOptions, ExecuteResult } from "../execute.ts"
import type { NetworkCaptureOptions, NetworkCaptureResult, NetworkCaptureStatus, NetworkCaptureStopOptions } from "../network-capture.ts"
import type { JsonObject, TargetInfo } from "../protocol.ts"
import type { AuthenticatedJsonOutcome, AuthenticatedJsonRequest, SessionSummary } from "./schema.ts"
export type SessionTarget = {
  readonly id: string
  readonly owner: "relay" | "user"
}

export type ConnectedTarget = {
  readonly tabId: number
  readonly sessionId: string
  /**
   * The browse session the tab was created for. Owned tabs are
   * visible only to that session's CDP clients; unowned tabs (user
   * toolbar-attached or raw-client-created) are visible to every client.
   */
  readonly opencodeBrowserSessionId?: string
  readonly targetInfo: TargetInfo
  readonly owner: "relay" | "user"
  readonly crashed?: boolean
  /**
   * `chrome.debugger` currently rejects every command for this tab because a
   * protected frame (another extension's UI, such as a password manager's
   * inline menu) is open inside it. Cleared when a command succeeds again or
   * the last protected frame goes away.
   */
  readonly protectedUi?: boolean
}

export type ChildTarget = {
  readonly tabId: number
  readonly sessionId: string
  readonly parentSessionId: string
  readonly targetInfo: TargetInfo
  readonly waitingForDebugger: boolean
}

export type StoredFrameEvents = {
  readonly frameId: string
  readonly attached?: JsonObject
  readonly navigated?: JsonObject
}

/**
 * The sandbox seam used by session management. `ExecuteSandbox` is the real
 * implementation; tests can substitute a fake.
 */
export interface ExecuteSandboxLike {
  execute(code: string, options?: ExecuteOptions): Effect.Effect<ExecuteResult>
  authenticatedJson(request: Omit<AuthenticatedJsonRequest, "sessionId">): Effect.Effect<AuthenticatedJsonOutcome, Error>
  adoptPage(targetId: string): Effect.Effect<void, Error>
  /** Stop a running script at once: its pending runs reject and its timers stop; the default tab is kept. */
  stopRealm(): void
  /** Shutdown and handoff cancellation await disconnection without closing or forgetting the default tab. */
  disconnectSettled(): Effect.Effect<void, Error>
  /** Adoption rollback cleanup does not settle before started Playwright close promises settle. */
  closeSettled(options?: { readonly clearState?: boolean }): Effect.Effect<void, Error>
  networkStart(options?: NetworkCaptureOptions): Effect.Effect<NetworkCaptureStatus, Error>
  networkStatus(): NetworkCaptureStatus
  networkStop(options?: NetworkCaptureStopOptions): Effect.Effect<NetworkCaptureResult, Error>
  networkCancel(): Effect.Effect<{ readonly cancelled: boolean }>
  /** Ends an active capture without a result, saying why on the next status or stop. */
  networkEnd(reason: string): Effect.Effect<{ readonly cancelled: boolean }>
  redactNetworkCaptureText(text: string): string
  markTargetCrashed(targetId: string): boolean
  markTargetProtectedUi(targetId: string, protectedUi: boolean): boolean
  markTargetDetached(targetId: string, options?: { readonly releasedByUser?: boolean }): boolean
  markTargetReplaced(previousTargetId: string, targetId: string): boolean
  /** Rebind a durable default target in a new sandbox; `warning` goes into the next execute result. */
  restore(target: SessionTarget | undefined, warning?: string): void
  getStatus(): {
    readonly sessionId?: string
    readonly connected: boolean
    readonly pageUrl: string | null
    readonly stateKeys: string[]
  }
}

export type OpenCodeBrowserSession = {
  readonly id: string
  readonly createdAt: string
  readonly readOnly: boolean
  /** Normalized allowed-origin patterns (domain-policy.ts); undefined: the session may go anywhere. */
  allowedOrigins?: readonly string[]
  /**
   * Keep this session's own tabs visible and focused to the page between execute calls, for apps that pause or
   * disconnect while hidden. Tabs the user lent are never kept. Pages can notice.
   */
  keepVisible?: boolean
  /** The immutable profile key, plus its agent-facing id. Older catalogs recorded at most the id. */
  browser?: { readonly id: string; readonly key?: string }
  /** Replaced when a stopped script does not settle in time (session-manager.ts). */
  sandbox: ExecuteSandboxLike
  readonly executeSemaphore: Semaphore.Semaphore
  /** Durable default-target identity. Authoritative live ownership remains in TargetRegistry. */
  target?: SessionTarget
  /**
   * Relay-owned targets the session held when the catalog was written (its default page included), restored at
   * startup so every page and popup it opened is reclaimed. Live ownership remains in TargetRegistry.
   */
  targets?: readonly SessionTarget[]
  updatedAt: string
  /** The process that last used the session (OpenCode-Browser-Client-Pid); see OpenCodeBrowserSessions.noteClient. */
  clientPid?: number
}

export type { SessionSummary }
