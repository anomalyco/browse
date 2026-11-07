import childProcess from "node:child_process"
import cluster from "node:cluster"
import crypto from "node:crypto"
import dgram from "node:dgram"
import dns from "node:dns"
import events from "node:events"
import fs from "node:fs"
import fsPromises from "node:fs/promises"
import http from "node:http"
import http2 from "node:http2"
import https from "node:https"
import inspector from "node:inspector"
import module from "node:module"
import net from "node:net"
import os from "node:os"
import tls from "node:tls"
import util from "node:util"
import v8 from "node:v8"
import vm from "node:vm"
import workerThreads from "node:worker_threads"
import * as acorn from "acorn"
import type { ExecuteRealm } from "../execute-realm.ts"

export const deniedHostValues = new Map<unknown, string>([
  [process, "process"],
  [globalThis, "the relay's global object"],
  [fs, "fs"],
  [fsPromises, "fs/promises"],
  [fs.promises, "fs/promises"],
  [childProcess, "child_process"],
  [cluster, "cluster"],
  [dgram, "dgram"],
  [dns, "dns"],
  [http, "http"],
  [http2, "http2"],
  [https, "https"],
  [inspector, "inspector"],
  [module, "module"],
  [net, "net"],
  [os, "os"],
  [tls, "tls"],
  [v8, "v8"],
  [vm, "vm"],
  [workerThreads, "worker_threads"],
  [globalThis.fetch, "Node fetch"],
  [eval, "eval"],
  [util.inspect, "host object inspection"],
  [util.format, "host object formatting"],
  [util.formatWithOptions, "host object formatting"],
  [crypto.setEngine, "loading native crypto engines"],
  [events.setMaxListeners, "changing shared event-emitter defaults or prototypes"],
  // Native work the CPU budget cannot interrupt until it returns; the async versions run off the event loop.
  ...[crypto.pbkdf2Sync, crypto.scryptSync, crypto.hkdfSync, crypto.generateKeyPairSync, crypto.generateKeySync, crypto.generatePrimeSync, crypto.checkPrimeSync]
    .map((fn) => [fn, `crypto.${fn.name} (blocks the relay; use the async version)`] as const),
])

// Playwright classes that launch local processes or make Node-side HTTP requests.
export const deniedHostClasses = new Map<string, string>([
  ["APIRequest", "Playwright's Node-side HTTP client is not available in execute code"],
  ["APIResponse", "Playwright's Node-side HTTP responses are not available in execute code"],
  ["APIRequestContext", "Playwright's Node-side HTTP client (page.request / context.request) is not available in execute code; use page.evaluate(() => fetch(...)) for requests with the page's cookies"],
  ["Tracing", "Playwright tracing performs Node-side file I/O and is not available in execute code"],
  ["Download", "Playwright download file access is not available in execute code; use browser fetch and files.write()"],
  ["Video", "Playwright video file access is not available in execute code"],
  ["BrowserType", "browser.browserType() can launch local processes and is not available in execute code"],
  ["Playwright", "the Playwright root object is not available in execute code"],
  ["Android", "Playwright Android is not available in execute code"],
  ["Electron", "Playwright Electron is not available in execute code"],
  ["LocalUtils", "Playwright local utilities are not available in execute code"],
])

const intrinsicNames = [
  "Object", "Function", "Array", "Number", "String", "Boolean", "Symbol", "BigInt", "Date", "RegExp",
  "Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "EvalError", "URIError", "AggregateError",
  "Promise", "Map", "Set", "WeakMap", "WeakSet", "WeakRef", "ArrayBuffer", "DataView",
  "Uint8Array", "Int8Array", "Uint16Array", "Int16Array", "Uint32Array", "Int32Array", "Float32Array", "Float64Array",
  "Uint8ClampedArray", "BigInt64Array", "BigUint64Array", "JSON", "Math", "Reflect", "Proxy", "Intl", "Atomics",
] as const

export const intrinsicSource = `(() => {
  const named = { ${intrinsicNames.map((name) => `${name}: typeof ${name} === "undefined" ? undefined : ${name}`).join(", ")} }
  named.AsyncFunction = (async function () {}).constructor
  named.GeneratorFunction = (function* () {}).constructor
  named.AsyncGeneratorFunction = (async function* () {}).constructor
  named.IteratorPrototype = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()))
  named.AsyncIteratorPrototype = Object.getPrototypeOf(Object.getPrototypeOf((async function* () {}).prototype))
  named.TypedArray = Object.getPrototypeOf(Uint8Array)
  named.eval = eval
  return named
})()`

export function hostIntrinsics(): Record<string, unknown> {
  // Evaluated with indirect eval so the values are this (host) realm's.
  return (0, eval)(intrinsicSource) as Record<string, unknown>
}

export function containsDynamicImport(source: string): boolean {
  let ast: acorn.Node
  try {
    ast = acorn.parse(source, { ecmaVersion: "latest", sourceType: "script", allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true })
  } catch {
    // vm.Script reports the syntax error.
    return false
  }
  const pending: unknown[] = [ast]
  while (pending.length > 0) {
    const node = pending.pop()
    if (node === null || typeof node !== "object") continue
    if (Array.isArray(node)) {
      pending.push(...node)
      continue
    }
    const type = (node as { type?: unknown }).type
    if (type === "ImportExpression" || (type === "MetaProperty" && (node as { meta?: { name?: unknown } }).meta?.name === "import")) return true
    for (const value of Object.values(node)) if (value !== null && typeof value === "object") pending.push(value)
  }
  return false
}

export function isObjectLike(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function"
}

export const isHiddenKey = (key: PropertyKey): boolean => typeof key === "string" && key.startsWith("_")

// Promise rejections originating in execute must not become relay process faults.
// Creation is tracked without inspecting attacker-controlled promise prototypes.

/** Code that created a promise: a sandbox realm, or a full-Node execute call (ExecuteRejectionScope). */
export interface ExecuteRejectionOwner {
  /** A realm stops and resets itself; a full-Node call can only report (its code cannot be interrupted safely). */
  handleUnhandledRejection(cause: unknown): void
}

let activeOwner: ExecuteRejectionOwner | undefined
const promiseOwners = new WeakMap<Promise<unknown>, ExecuteRejectionOwner>()
// The hook is installed only while execute JavaScript runs: promise hooks slow every await in the
// process. An npm install's relay runs under Node; a binary install's under Bun, which has no promiseHooks
// (bunRejectionOwner below).
let stopPromiseHook: (() => void) | undefined

export function trackPromisesOf(owner: ExecuteRejectionOwner): () => void {
  const previous = activeOwner
  activeOwner = owner
  if (process.versions.bun) {
    const entered = { owner, at: Date.now() }
    lastOwner = entered
    return () => {
      activeOwner = previous
      entered.at = Date.now()
    }
  }
  if (!stopPromiseHook) {
    stopPromiseHook = v8.promiseHooks.createHook({ init(promise: Promise<unknown>) {
      if (activeOwner) promiseOwners.set(promise, activeOwner)
    } }) as () => void
  }
  return () => {
    activeOwner = previous
    if (!activeOwner && stopPromiseHook) {
      stopPromiseHook()
      stopPromiseHook = undefined
    }
  }
}

// Bun (a binary install's relay) has no promiseHooks, so creation can't be tracked. There a rejected promise whose own
// prototype is a realm's Promise.prototype came from that realm (the runtime hands a real promise, never a proxy, so
// reading its prototype runs no sandbox code). Any other (a Promise subclass, a re-prototyped promise, a full-Node
// call's host promise) goes to the owner active within the last second: the runtime reports a rejection right after the
// turn that left it unhandled, and every sandbox turn (code, callbacks, timers) enters its realm. A stopped realm still
// claims late rejections in that window: `execute --rm` disposes the session's realm right after its call, and the
// rejection most likely belongs to that call. Agent code then can't take the relay down; the cost is that a host fault
// in that window is contained instead of stopping the relay.
const realmsByPromisePrototype = new WeakMap<object, ExecuteRealm>()
let lastOwner: { readonly owner: ExecuteRejectionOwner; at: number } | undefined
const lastOwnerWindowMs = 1000

/** Under Bun, remember which realm a sandbox Promise.prototype belongs to (bunRejectionOwner). */
export function registerRealmPromisePrototype(prototype: object, realm: ExecuteRealm): void {
  if (process.versions.bun) realmsByPromisePrototype.set(prototype, realm)
}

function bunRejectionOwner(promise: Promise<unknown>): ExecuteRejectionOwner | undefined {
  const byPrototype = realmsByPromisePrototype.get(Object.getPrototypeOf(promise) as object)
  if (byPrototype) return byPrototype
  if (!lastOwner) return undefined
  return activeOwner === lastOwner.owner || Date.now() - lastOwner.at <= lastOwnerWindowMs ? lastOwner.owner : undefined
}

/** Contain a rejection created by execute code (a sandbox realm, or a full-Node execute scope). */
export function handleExecuteRealmRejection(promise: Promise<unknown>, reason?: unknown): boolean {
  const owner = promiseOwners.get(promise) ?? (process.versions.bun ? bunRejectionOwner(promise) : undefined)
  if (!owner) return false
  owner.handleUnhandledRejection(reason)
  return true
}

/** The message an un-awaited execute rejection reports, bounded like other process diagnostics. */
export function unhandledExecuteRejectionWarning(cause: unknown): string {
  const detail = (cause instanceof Error ? cause.message : String(cause ?? "no reason")).slice(0, 300)
  return `Execute code started a promise that rejected and was never awaited: ${detail}. The rejection was contained and the relay kept running; await the promise or handle its rejection to return the error from execute.`
}

/**
 * Rejection owner for full-Node execute calls (`OPENCODE_BROWSER_ALLOW_NODE=1`), where there is no realm to tag
 * promises. Promises created while the call runs are tagged through trackPromisesOf (Node) or the recent-owner
 * fallback (Bun); a rejection after the call returns is still reported to the sandbox for its next result.
 */
export class ExecuteRejectionScope implements ExecuteRejectionOwner {
  private untrack: (() => void) | undefined
  private readonly onRejection: ((message: string) => void) | undefined

  constructor(options: { readonly onRejection?: (message: string) => void } = {}) {
    this.onRejection = options.onRejection
  }

  /** Start tagging promises created by the call. Tagged promises stay owned after end(). */
  begin(): void {
    this.untrack ??= trackPromisesOf(this)
  }

  /** Stop tagging new promises (an un-tagged, late rejection falls back to the process guard). */
  end(): void {
    this.untrack?.()
    this.untrack = undefined
  }

  handleUnhandledRejection(cause: unknown): void {
    try { this.onRejection?.(unhandledExecuteRejectionWarning(cause)) } catch {
      // Reporting must never turn a contained rejection into a relay fault.
    }
  }
}

// Errors execute callbacks throw into host code. A host caller that does not catch them
// (a timer or event emitter outside the realm's own wrappers) would otherwise crash the relay.
const thrownByRealm = new WeakMap<object, ExecuteRealm>()

export function tagThrownByRealm(value: object, realm: ExecuteRealm): void {
  if (!thrownByRealm.has(value)) thrownByRealm.set(value, realm)
}

export function handleExecuteRealmException(error: unknown): boolean {
  const realm = isObjectLike(error) ? thrownByRealm.get(error) : undefined
  if (!realm) return false
  realm.dispose(new Error("Uncaught exception in an execute callback; JavaScript state will reset before the next execute"))
  return true
}

/** A shadow target with no non-configurable own properties, so the proxy can report the host object's shape freely. */
export function shadowFor(value: object): object {
  if (typeof value === "function") return (function () {}).bind(undefined)
  return {}
}
