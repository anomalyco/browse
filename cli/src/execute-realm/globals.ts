import vm from "node:vm"
import type { ExecuteRealm } from "../execute-realm.ts"
import { releaseExecuteTurn, waitForExecuteTurn } from "./cpu-budget.ts"
import { hostIntrinsics, isObjectLike } from "./membrane-policy.ts"

/**
 * Fill `hostToSandbox` with host intrinsic -> sandbox intrinsic pairs.
 *
 * Host intrinsics (`Function`, `AsyncFunction`, `Object`, `Error`, ...) must map to the context's
 * own, so `page.constructor.constructor("return process")()` compiles in the context and finds no
 * `process`. Prototypes map too, so a sandbox value's chain never reaches host intrinsics.
 * Brand-checking intrinsics (e.g. `TypedArray.prototype.every` on Buffer) need their host
 * receiver; callback arguments still get guarded when they cross back to the host.
 */
export function populateHostToSandboxIntrinsics(hostToSandbox: Map<unknown, unknown>, sandboxIntrinsics: Record<string, unknown>): void {
  const host = hostIntrinsics()
  for (const name of Object.keys(host)) {
    const hostValue = host[name]
    const sandboxValue = sandboxIntrinsics[name]
    if (!isObjectLike(hostValue) || !isObjectLike(sandboxValue)) continue
    hostToSandbox.set(hostValue, sandboxValue)
    const hostPrototype = (hostValue as { prototype?: unknown }).prototype
    const sandboxPrototype = (sandboxValue as { prototype?: unknown }).prototype
    if (typeof hostValue === "function" && isObjectLike(hostPrototype) && isObjectLike(sandboxPrototype)) {
      hostToSandbox.set(hostPrototype, sandboxPrototype)
    }
    // Intrinsic invocation must retain the sandbox proxy as its target. In particular,
    // a host Function.prototype.call/apply/bind would otherwise unwrap the function
    // and invoke it without the membrane's apply trap (and checkHostCall).
    for (const [from, to] of ["Object", "Function", "Reflect"].includes(name) ? [[hostValue, sandboxValue], [hostPrototype, sandboxPrototype]] : []) {
      if (!isObjectLike(from) || !isObjectLike(to)) continue
      for (const key of Reflect.ownKeys(from)) {
        const source = Reflect.getOwnPropertyDescriptor(from, key)?.value
        const destination = Reflect.getOwnPropertyDescriptor(to, key)?.value
        if (typeof source === "function" && typeof destination === "function") {
          hostToSandbox.set(source, destination)
        }
      }
    }
  }
}

/**
 * Install the realm's timers and harmless host utilities on its global object.
 *
 * A string callback would be code generation, so a non-function callback throws TypeError. Ids come
 * from the realm's one counter; a stopped realm hands an id out without scheduling. A timer fire
 * waits for a relay-wide execute turn before it runs sandbox code, and an interval skips a fire
 * while an earlier one still waits, so callbacks cannot pile up. A throwing callback disposes the
 * realm so the next execute starts from clean state. `queueMicrotask` is built inside the context
 * so it never holds a host function.
 */
export function installRealmGlobals(realm: ExecuteRealm, target: Record<string, unknown>): void {
  const awaitingTurn = new Set<number>()
  const cancelled = new Set<number>()
  const schedule = (repeat: boolean, callback: (...args: unknown[]) => unknown, delay = 0, ...args: unknown[]) => {
    // A string callback would be code generation; refuse it rather than failing later.
    if (typeof callback !== "function") throw new TypeError("The timer callback must be a function")
    const id = ++realm.nextTimer
    if (realm.stopped) return id
    const invoke = () => {
      if (realm.stopped || cancelled.delete(id)) return false
      try { callback(...args) } catch {
        realm.dispose(new Error("Execute timer callback failed; JavaScript state will reset before the next execute"))
      }
      return true
    }
    const fire = () => {
      if (!repeat) realm.timers.delete(id)
      if (realm.stopped || awaitingTurn.has(id)) return
      const turn = waitForExecuteTurn(realm)
      if (turn === undefined) { invoke(); return }
      awaitingTurn.add(id)
      void turn.then(() => {
        awaitingTurn.delete(id)
        // A cleared timer or a stopped realm runs no sandbox code, so its turn charged nothing.
        if (!invoke()) releaseExecuteTurn()
      })
    }
    realm.timers.set(id, (repeat ? setInterval : setTimeout)(fire, delay))
    return id
  }
  const clear = (id: number) => {
    const timer = realm.timers.get(id)
    if (timer) clearTimeout(timer)
    realm.timers.delete(id)
    if (awaitingTurn.has(id)) cancelled.add(id)
  }
  const hostGlobals: Record<string, unknown> = {
    setTimeout: (callback: (...args: unknown[]) => unknown, delay?: number, ...args: unknown[]) => schedule(false, callback, delay, ...args),
    setInterval: (callback: (...args: unknown[]) => unknown, delay?: number, ...args: unknown[]) => schedule(true, callback, delay, ...args),
    setImmediate: (callback: (...args: unknown[]) => unknown, ...args: unknown[]) => schedule(false, callback, 0, ...args),
    clearTimeout: clear, clearInterval: clear, clearImmediate: clear,
    // structuredClone is deliberately absent: as a host function it receives the raw host object behind a
    // proxy and copies its hidden `_` members and connection internals into sandbox-visible data.
    atob, btoa, URL, URLSearchParams, TextEncoder, TextDecoder, Buffer, AbortController,
    AbortSignal, Blob, Event, EventTarget, performance, crypto: globalThis.crypto,
  }
  for (const [name, value] of Object.entries(hostGlobals)) {
    if (value === undefined) continue
    Reflect.defineProperty(target, name, { value: realm.toSandbox(value), writable: true, configurable: true, enumerable: false })
  }
  new vm.Script("{ const then = Promise.prototype.then; const ready = Promise.resolve(); globalThis.queueMicrotask = callback => Reflect.apply(then, ready, [callback]); }").runInContext(realm.context)
}
