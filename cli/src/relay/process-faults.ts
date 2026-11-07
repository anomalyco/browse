import { isSafeHostError, safeErrorMessage, safeErrorStack } from "../execute-realm/rejection-text.ts"
import { appendManagedRelayProcessLog, relayLog } from "./log.ts"

export type RelayProcessFaultKind = "uncaughtException" | "unhandledRejection"

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
// Unattributed rejections are logged at most once a minute, or immediately when the message changes; status/doctor
// still see every one through suppressedProcessFaults. The reason may be a sandbox value, so the log never includes it.
const unattributedRejections: { count: number; logged: number; lastLogAt: number; lastMessage?: string } = { count: 0, logged: 0, lastLogAt: 0 }

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
    const description = safeErrorMessage(cause)
    suppressedProcessFaults.count += 1
    suppressedProcessFaults.lastAt = new Date().toISOString()
    suppressedProcessFaults.lastMessage = description.slice(0, 300)
    unattributedRejections.count += 1
    const now = Date.now()
    if (description !== unattributedRejections.lastMessage || now - unattributedRejections.lastLogAt >= 60_000) {
      const since = unattributedRejections.count - unattributedRejections.logged
      unattributedRejections.lastLogAt = now
      unattributedRejections.logged = unattributedRejections.count
      unattributedRejections.lastMessage = description
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
