import {
  retainPromiseHook,
  runWithRejectionOwner,
  unhandledExecuteRejectionWarning,
  type ExecuteRejectionOwner,
} from "../execute-realm/membrane-policy.ts"

/** Even if a full-Node call never settles, release the process-wide promise hook eventually. */
const defaultRejectionOwnershipExpiryMs = 10 * 60_000

/**
 * Rejection owner for full-Node execute calls (`OPENCODE_BROWSER_ALLOW_NODE=1`), where there is no realm to tag
 * promises. Node's promise hook tags the promise the synchronous call creates; continuations inherit the owner from
 * their async context. Under Bun there is no promise hook, so this scope is inert and the process guard's generic
 * fallback contains rejections (logged and counted) without a per-call warning.
 */
export class ExecuteRejectionScope implements ExecuteRejectionOwner {
  private releaseHook: (() => void) | undefined
  private expiry: ReturnType<typeof setTimeout> | undefined
  private readonly expiryMs: number
  private readonly onRejection: ((message: string) => void) | undefined

  constructor(options: { readonly onRejection?: (message: string) => void; readonly expiryMs?: number } = {}) {
    this.onRejection = options.onRejection
    this.expiryMs = options.expiryMs ?? defaultRejectionOwnershipExpiryMs
  }

  /** Install the promise hook for this call. No-op under Bun, which has no promiseHooks. */
  begin(): void {
    if (process.versions.bun || this.releaseHook) return
    this.releaseHook = retainPromiseHook()
    this.expiry = setTimeout(() => this.end(), this.expiryMs)
    this.expiry.unref?.()
  }

  /** Set the owner for the synchronous call and its async continuations. */
  invoke<T>(run: () => T): T {
    if (process.versions.bun) return run()
    return runWithRejectionOwner(this, run)
  }

  /** Stop tagging new promises; promises already tagged stay attributed. */
  end(): void {
    if (this.expiry !== undefined) {
      clearTimeout(this.expiry)
      this.expiry = undefined
    }
    this.releaseHook?.()
    this.releaseHook = undefined
  }

  handleUnhandledRejection(cause: unknown, certain: boolean): void {
    try { this.onRejection?.(unhandledExecuteRejectionWarning(cause, certain)) } catch {
      // Reporting must never turn a contained rejection into a relay fault.
    }
  }
}
