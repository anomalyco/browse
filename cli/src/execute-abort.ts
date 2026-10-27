/**
 * Timers for the execute realm that a stop can clear.
 *
 * The user's stop (toolbar button) and session delete/reset end a running script from outside. Closing the
 * sandbox's browser connection makes every Playwright call reject, but a script waiting on its own timers would keep
 * running. These wrappers replace the realm's timer globals: abort() clears every pending timer and makes new ones
 * never fire (a script awaiting one stays parked instead of spinning through errors), and resume() allows them again
 * when the next execute starts.
 */
import vm from "node:vm"
import type { ExecuteRealm } from "./execute-realm.ts"

export type AbortableTimers = {
  /** Clear every pending timer; timers created until resume() never fire. */
  readonly abort: () => void
  readonly resume: () => void
  /** Pending timers, for tests and diagnostics. */
  readonly pending: () => number
}

type Handle = NodeJS.Timeout | NodeJS.Immediate

export function installAbortableTimers(realm: ExecuteRealm): AbortableTimers {
  const live = new Map<Handle, "timeout" | "immediate">()
  let aborted = false
  const clear = (handle: Handle) => {
    const kind = live.get(handle)
    live.delete(handle)
    if (kind === "immediate") clearImmediate(handle as NodeJS.Immediate)
    else clearTimeout(handle as NodeJS.Timeout)
  }
  const requireCallback = (callback: unknown, name: string): Function => {
    if (typeof callback !== "function") throw new TypeError(`${name}: the callback must be a function`)
    return callback
  }
  /** A real but already cleared handle, so code that keeps or clears it still works. */
  const parked = (): NodeJS.Timeout => {
    const handle = setTimeout(() => {}, 0)
    clearTimeout(handle)
    return handle
  }
  const timers: Record<string, Function> = {
    setTimeout(callback: unknown, delay?: number, ...args: unknown[]) {
      const run = requireCallback(callback, "setTimeout")
      if (aborted) return parked()
      const handle: NodeJS.Timeout = setTimeout(function (this: unknown, ...values: unknown[]) {
        live.delete(handle)
        return Reflect.apply(run, this, values)
      }, delay, ...args)
      live.set(handle, "timeout")
      return handle
    },
    setInterval(callback: unknown, delay?: number, ...args: unknown[]) {
      const run = requireCallback(callback, "setInterval")
      if (aborted) return parked()
      const handle = setInterval(function (this: unknown, ...values: unknown[]) {
        return Reflect.apply(run, this, values)
      }, delay, ...args)
      live.set(handle, "timeout")
      return handle
    },
    setImmediate(callback: unknown, ...args: unknown[]) {
      const run = requireCallback(callback, "setImmediate")
      if (aborted) return parked()
      const handle: NodeJS.Immediate = setImmediate(function (this: unknown, ...values: unknown[]) {
        live.delete(handle)
        return Reflect.apply(run, this, values)
      }, ...args)
      live.set(handle, "immediate")
      return handle
    },
    clearTimeout(handle: unknown) {
      if (handle) clear(handle as Handle)
    },
    clearInterval(handle: unknown) {
      if (handle) clear(handle as Handle)
    },
    clearImmediate(handle: unknown) {
      if (handle) clear(handle as Handle)
    },
  }
  const global = new vm.Script("globalThis").runInContext(realm.context) as Record<string, unknown>
  for (const [name, value] of Object.entries(timers)) {
    Reflect.defineProperty(global, name, { value: realm.toSandbox(value), writable: true, configurable: true, enumerable: false })
  }
  return {
    abort: () => {
      aborted = true
      for (const handle of Array.from(live.keys())) clear(handle)
    },
    resume: () => {
      aborted = false
    },
    pending: () => live.size,
  }
}
