import http from "node:http"
import type stream from "node:stream"
import { Effect } from "effect"
import type { RawData } from "ws"
import { handleExecuteRealmException, handleExecuteRealmRejection } from "../execute-realm.ts"
import { isSafeHostError, safeErrorMessage, safeErrorStack } from "../execute-realm/rejection-text.ts"
import { appendManagedRelayProcessLog, relayLog } from "./log.ts"
import type { ChildTarget, ConnectedTarget } from "./types.ts"
import { boundedToken } from "../update/runtime-diagnostics.ts"
import type { TargetRegistry } from "../cdp/target-registry.ts"

export type RelayProcessFaultKind = "uncaughtException" | "unhandledRejection"

export const installRelayProcessGuard = Effect.acquireRelease(
  Effect.sync(() => {
    const onUncaughtException = (error: Error, origin: NodeJS.UncaughtExceptionOrigin) => {
      if (handleExecuteRealmException(error)) return
      handleRelayProcessFault("uncaughtException", error, { origin })
    }
    const onUnhandledRejection = (reason: unknown, promise: Promise<unknown>) => {
      if (handleExecuteRealmRejection(promise, reason)) {
        // No message: the reason may be a sandbox value and may contain page data. The agent result carries the
        // warning through its usual redaction; this line just records that the relay contained a rejection.
        relayLog("process.executeRejection")
        return
      }
      handleRelayProcessFault("unhandledRejection", reason, {})
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

/** Playwright dispatch faults and unhandled rejections the relay contained to stay alive; reported by `status` and `doctor`. */
const suppressedProcessFaults: { count: number; lastAt?: string; lastMessage?: string } = { count: 0 }

export function relayProcessFaultSummary(): { readonly suppressed: number; readonly lastAt?: string; readonly lastMessage?: string } {
  return {
    suppressed: suppressedProcessFaults.count,
    ...(suppressedProcessFaults.lastAt === undefined ? {} : { lastAt: suppressedProcessFaults.lastAt }),
    ...(suppressedProcessFaults.lastMessage === undefined ? {} : { lastMessage: suppressedProcessFaults.lastMessage }),
  }
}

export function shouldSuppressRelayProcessFault(cause: unknown): boolean {
  if (isPatchrightProtocolError(cause)) return true
  const errorText = `${safeErrorMessage(cause)}\n${safeErrorStack(cause) ?? ""}`
  return /playwright-core|patchright-core|coreBundle|Duplicate target/i.test(errorText)
}

// Patchright sets all three fields in its ProtocolError constructor, even when method or logs are undefined.
// The class is private and its name can be minified. The message alone isn't proof of a Patchright fault.
function isPatchrightProtocolError(cause: unknown): boolean {
  if (!isSafeHostError(cause)) return false
  const type = Object.getOwnPropertyDescriptor(cause, "type")?.value
  return Object.getOwnPropertyDescriptor(cause, "method") !== undefined
    && Object.getOwnPropertyDescriptor(cause, "logs") !== undefined
    && (type === "error" || type === "closed" || type === "crashed")
}

/**
 * A CDP command Patchright sent without awaiting it (its page constructor's setRequestInterception, for one) failing
 * because the session went away: the extension disconnected, the tab detached or closed. Harmless, and a single
 * extension restart produced a hundred of them, which buried real faults in the log; they're counted and summarized
 * instead (benignRejections).
 */
export function isBenignClosedSessionRejection(cause: unknown): boolean {
  if (!isSafeHostError(cause)) return false
  if (!isPatchrightProtocolError(cause) && !/patchright-core|playwright-core|coreBundle/.test(safeErrorStack(cause) ?? "")) return false
  return /^Protocol error \([\w.]+\): .*(session closed|Target closed|Extension disconnected|extension is not connected|Unknown CDP session|Detached while handling command|Relay closed)/i.test(safeErrorMessage(cause))
}

const benignRejections = { count: 0, logged: 0, lastLogAt: 0 }
// Unattributed rejections are logged at most once a minute; status/doctor still see every one through
// suppressedProcessFaults. The reason may be a sandbox value, so the log never includes it.
const unattributedRejections = { count: 0, logged: 0, lastLogAt: 0 }

export function handleRelayProcessFault(
  kind: RelayProcessFaultKind,
  cause: unknown,
  detail: Record<string, unknown>,
  options: { readonly rethrow?: (cause: unknown) => never } = {},
): void {
  if (kind === "unhandledRejection" && isBenignClosedSessionRejection(cause)) {
    benignRejections.count += 1
    const now = Date.now()
    if (now - benignRejections.lastLogAt >= 60_000) {
      const since = benignRejections.count - benignRejections.logged
      benignRejections.lastLogAt = now
      benignRejections.logged = benignRejections.count
      relayLog("process.benignRejections", { count: since, total: benignRejections.count, example: safeErrorMessage(cause).slice(0, 160) })
    }
    return
  }
  if (shouldSuppressRelayProcessFault(cause)) {
    suppressedProcessFaults.count += 1
    suppressedProcessFaults.lastAt = new Date().toISOString()
    suppressedProcessFaults.lastMessage = safeErrorMessage(cause).slice(0, 300)
    logProcessFault(kind, cause, detail, "keeping relay alive")
    return
  }
  // A rejection nobody handled may still be execute code's: a promise created after its call returned, by a helper's
  // fire-and-forget chain, or by full Node execute code in a callback the execute scope no longer covers. Taking the
  // relay down loses every session and tab, so it is logged and counted; `browse status` / `doctor` report it.
  // Synchronous programming faults (uncaughtException) still stop the relay below.
  if (kind === "unhandledRejection") {
    suppressedProcessFaults.count += 1
    suppressedProcessFaults.lastAt = new Date().toISOString()
    suppressedProcessFaults.lastMessage = safeErrorMessage(cause).slice(0, 300)
    unattributedRejections.count += 1
    const now = Date.now()
    if (now - unattributedRejections.lastLogAt >= 60_000) {
      const since = unattributedRejections.count - unattributedRejections.logged
      unattributedRejections.lastLogAt = now
      unattributedRejections.logged = unattributedRejections.count
      logProcessFault(kind, cause, { suppressed: since }, "keeping relay alive; an unhandled rejection never stops the relay")
    }
    return
  }
  logProcessFault(kind, cause, detail, "not a known Playwright dispatch fault; rethrowing")
  const rethrow = options.rethrow ?? rethrowProcessFault
  rethrow(cause)
}

function rethrowProcessFault(cause: unknown): never {
  if (isSafeHostError(cause)) {
    throw cause
  }
  throw new Error(safeErrorMessage(cause))
}

function logProcessFault(kind: RelayProcessFaultKind, cause: unknown, detail: Record<string, unknown>, disposition: string): void {
  const message = `[browse relay] ${kind}; ${disposition}\n${safeErrorStack(cause) ?? safeErrorMessage(cause)}`
  console.error(message)
  if (process.env.OPENCODE_BROWSER_MANAGED_RELAY === "1") appendManagedRelayProcessLog(message)
  if (debugEnvironmentEnabled(process.env.OPENCODE_BROWSER_DEBUG)) {
    console.error(`[browse relay] ${kind} detail`, detail)
  }
}

function debugEnvironmentEnabled(value: string | undefined): boolean {
  return value !== undefined && ["1", "true", "yes", "on"].includes(value.toLowerCase())
}

/** Whether a local process still runs (a pid from OpenCode-Browser-Client-Pid). */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

export function sendUpgradeError(options: {
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

export function rawDataToBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) {
    return data
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data)
  }
  return Buffer.from(data)
}

export function targetDiagnosticIdentity(registry: TargetRegistry, target: ConnectedTarget | ChildTarget | undefined): string {
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
