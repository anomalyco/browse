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
let activeRealm: ExecuteRealm | undefined
const promiseRealms = new WeakMap<Promise<unknown>, ExecuteRealm>()
// The hook is installed only while execute JavaScript runs: promise hooks slow every await in the
// process. The relay runs under Node; Bun runs the outer tests and has no promiseHooks.
let stopPromiseHook: (() => void) | undefined

export function trackPromisesOf(realm: ExecuteRealm): () => void {
  const previous = activeRealm
  activeRealm = realm
  if (!stopPromiseHook && !process.versions.bun) {
    stopPromiseHook = v8.promiseHooks.createHook({ init(promise: Promise<unknown>) {
      if (activeRealm) promiseRealms.set(promise, activeRealm)
    } }) as () => void
  }
  return () => {
    activeRealm = previous
    if (!activeRealm && stopPromiseHook) {
      stopPromiseHook()
      stopPromiseHook = undefined
    }
  }
}

export function handleExecuteRealmRejection(promise: Promise<unknown>): boolean {
  const realm = promiseRealms.get(promise)
  if (!realm) return false
  realm.dispose(new Error("Unhandled execute rejection; JavaScript state will reset before the next execute"))
  return true
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
