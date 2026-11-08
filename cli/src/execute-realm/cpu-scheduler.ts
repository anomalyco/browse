import type { ExecuteRealm } from "../execute-realm.ts"
import { executeSliceMs } from "./file-roots.ts"

// While realm work is queued, realms get at most this share of wall time. The rest stays open for the
// relay's own work: HTTP (/version), CDP and extension sockets, and host timers such as human-input pacing.
const REALM_SHARE = 2 / 3
// Open time owed before async realm entries stop running on the spot and wait for the event loop.
const PACE_AFTER_MS = 8
// One long slice owes at most this much, so it is not followed by a long idle gap.
const MAX_DEBT_MS = 250

type RealmQueue = {
  readonly realm: ExecuteRealm
  readonly tasks: Array<() => void>
  // This realm's CPU per entry, kept for the sustained budget's window.
  readonly slices: Array<{ readonly start: number; readonly end: number }>
  // Recent CPU for picking the next realm: decays by e every busy window. A fixed window would forget a heavy
  // realm whose turn comes round less often than the window (many sessions), and let it cut ahead of light ones.
  decayedCpuMs: number
  decayedAt: number
  order: number
}

/**
 * Shares the relay's one event loop between execute realms (one scheduler per relay).
 *
 * Every realm entry is charged the relay thread's CPU time and owes the loop half that time as open time
 * (REALM_SHARE). Async entries (run(), settled host promises, realm timers) run on the spot while nothing is
 * queued and the debt is small. Otherwise they queue, and once the debt is paid the ready realm with the least
 * recent CPU runs one entry, FIFO within a realm and between equals. The scheduler yields with setTimeout,
 * so I/O and host timers get a turn between other sessions' slices instead of waiting behind all of them.
 *
 * Synchronous host-initiated entries (event listeners, route handlers, promise conversion) can't wait; they run
 * directly and are charged the same way.
 */
export class ExecuteCpuScheduler {
  readonly sliceMs: number
  // Sustained budget: one realm may use the relay thread's CPU at most half the time over three slice lengths
  // (3 s of 6 s by default), so a busy setInterval stops within a few seconds while one full slice, or a few heavy
  // operations back to back, still pass. CPU time, not wall time: on a loaded machine the thread can sit
  // descheduled mid-slice, and that wait is not work the realm made the relay do.
  private readonly busyWindowMs: number
  private readonly queues = new WeakMap<ExecuteRealm, RealmQueue>()
  private readonly ready = new Set<RealmQueue>()
  private queued = 0
  private debtMs = 0
  private lastExitAt = performance.now()
  private depth = 0
  private pumping = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private nextOrder = 0

  constructor(sliceMs = executeSliceMs()) {
    this.sliceMs = sliceMs
    this.busyWindowMs = sliceMs * 3
  }

  /** Queued entries across all realms, for tests and diagnostics. */
  get pending(): number {
    return this.queued
  }

  /** Run an async entry into `realm` now if the loop is free, or queue it. Dropped if the realm stops first. */
  schedule(realm: ExecuteRealm, task: () => void): void {
    if (realm.isStopped) return
    if (this.queued === 0 && this.depth === 0 && this.owedMs() < PACE_AFTER_MS) return task()
    const queue = this.queueOf(realm)
    if (queue.tasks.length === 0) {
      queue.order = ++this.nextOrder
      this.ready.add(queue)
    }
    queue.tasks.push(task)
    this.queued += 1
    if (!this.pumping && this.timer === undefined) this.arm()
  }

  /** An outermost realm entry starts. */
  begin(): void {
    this.owedMs()
    this.depth += 1
  }

  /** An outermost realm entry ended having used `cpu`; true when the realm is over its sustained budget. */
  end(realm: ExecuteRealm, cpu: NodeJS.CpuUsage): boolean {
    const now = performance.now()
    const cpuMs = (cpu.user + cpu.system) / 1000
    this.depth -= 1
    if (this.depth === 0) this.lastExitAt = now
    this.debtMs = Math.min(MAX_DEBT_MS, this.debtMs + cpuMs * (1 - REALM_SHARE) / REALM_SHARE)
    const queue = this.queueOf(realm)
    queue.decayedCpuMs = this.decayedCpuMs(queue, now) + cpuMs
    queue.decayedAt = now
    const windowStart = now - this.busyWindowMs
    queue.slices.push({ start: now - cpuMs, end: now })
    while (queue.slices.length > 0 && queue.slices[0]!.end <= windowStart) queue.slices.shift()
    let busyMs = 0
    for (const slice of queue.slices) busyMs += slice.end - Math.max(slice.start, windowStart)
    return busyMs > this.busyWindowMs / 2
  }

  /** Drop a stopped realm's queued entries. */
  forget(realm: ExecuteRealm): void {
    const queue = this.queues.get(realm)
    if (!queue) return
    this.queues.delete(realm)
    this.ready.delete(queue)
    this.queued -= queue.tasks.length
    queue.tasks.length = 0
    if (this.queued === 0 && this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  private readonly pump = () => {
    this.timer = undefined
    this.pumping = true
    try {
      while (this.queued > 0 && this.owedMs() < PACE_AFTER_MS) {
        const now = performance.now()
        let next: RealmQueue | undefined
        let nextCpuMs = 0
        for (const queue of this.ready) {
          const cpuMs = this.decayedCpuMs(queue, now)
          if (next === undefined || cpuMs < nextCpuMs || (cpuMs === nextCpuMs && queue.order < next.order)) {
            next = queue
            nextCpuMs = cpuMs
          }
        }
        const queue = next!
        const task = queue.tasks.shift()!
        this.queued -= 1
        if (queue.tasks.length === 0) this.ready.delete(queue)
        else queue.order = ++this.nextOrder
        try { task() } catch (error) {
          queue.realm.dispose(error instanceof Error ? error : new Error("Execute callback failed"))
        }
      }
    } finally {
      this.pumping = false
      if (this.queued > 0) this.arm()
    }
  }

  private arm(): void {
    this.timer = setTimeout(this.pump, Math.max(1, Math.ceil(this.owedMs())))
  }

  /** Open time still owed: debt minus the time the loop has been free of realm work since the last entry. */
  private owedMs(): number {
    if (this.depth > 0) return this.debtMs
    const now = performance.now()
    this.debtMs = Math.max(0, this.debtMs - (now - this.lastExitAt))
    this.lastExitAt = now
    return this.debtMs
  }

  private queueOf(realm: ExecuteRealm): RealmQueue {
    const existing = this.queues.get(realm)
    if (existing) return existing
    const queue: RealmQueue = { realm, tasks: [], slices: [], decayedCpuMs: 0, decayedAt: 0, order: 0 }
    this.queues.set(realm, queue)
    return queue
  }

  private decayedCpuMs(queue: RealmQueue, now: number): number {
    return queue.decayedCpuMs * Math.exp((queue.decayedAt - now) / this.busyWindowMs)
  }
}
