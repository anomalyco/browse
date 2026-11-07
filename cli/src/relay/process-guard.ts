import http from "node:http"
import type stream from "node:stream"
import { Effect } from "effect"
import type { RawData } from "ws"
import { handleExecuteRealmException, handleExecuteRealmRejection } from "../execute-realm.ts"
import { relayLog } from "./log.ts"
import { handleRelayProcessFault } from "./process-faults.ts"
import type { ChildTarget, ConnectedTarget } from "./types.ts"
import { boundedToken } from "../update/runtime-diagnostics.ts"
import type { TargetRegistry } from "../cdp/target-registry.ts"

export {
  handleRelayProcessFault,
  isBenignClosedSessionRejection,
  relayProcessFaultSummary,
  shouldSuppressRelayProcessFault,
  type RelayProcessFaultKind,
} from "./process-faults.ts"

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
