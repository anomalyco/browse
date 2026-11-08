import { executeSliceMs } from "./file-roots.ts"

/**
 * Relay-wide execute CPU ledger and admission gate.
 *
 * Execute code from every session runs on the relay's one JavaScript thread. A per-realm budget is
 * not enough: several sessions can each stay just under half while together keeping the thread busy
 * all the time. Slices are therefore charged here by owner, and an entry starts only while the total
 * over the last three slices is at most half of them. Callers that do not fit wait FIFO, with a timer
 * computed from the ledger, so timers and I/O still get turns while they wait.
 */
type Slice = { readonly owner: object; readonly start: number; readonly end: number }
type Waiter = { readonly owner: object; readonly resolve: () => void }

const windowMs = executeSliceMs() * 3
const halfWindowMs = windowMs / 2
const slices: Slice[] = []
const waiters: Waiter[] = []
let wakeTimer: ReturnType<typeof setTimeout> | undefined

function prune(now: number): void {
  const windowStart = now - windowMs
  while (slices.length > 0 && slices[0]!.end <= windowStart) slices.shift()
}

/** Relay thread CPU ms in the current window, for one owner or for every owner. */
function busyMsAt(now: number, owner?: object): number {
  const windowStart = now - windowMs
  let busy = 0
  for (const slice of slices) {
    if (slice.end <= windowStart) continue
    if (owner !== undefined && slice.owner !== owner) continue
    busy += slice.end - Math.max(slice.start, windowStart)
  }
  return busy
}

function hasBudget(now: number): boolean {
  return busyMsAt(now) <= halfWindowMs
}

/** First time at or after `now` when the window's busy time is back to half or less. */
function nextTurnAt(now: number): number {
  if (hasBudget(now)) return now
  let low = now
  let high = now + windowMs
  // Busy time only falls as the window moves forward; find the crossing to the millisecond.
  for (let step = 0; step < 20; step += 1) {
    const middle = (low + high) / 2
    if (hasBudget(middle)) high = middle
    else low = middle
  }
  return high
}

function wakeAt(at: number): void {
  if (wakeTimer !== undefined) clearTimeout(wakeTimer)
  wakeTimer = setTimeout(() => {
    wakeTimer = undefined
    wake()
  }, Math.max(0, Math.ceil(at - performance.now())))
}

function wake(): void {
  if (waiters.length === 0) return
  const now = performance.now()
  if (!hasBudget(now)) {
    wakeAt(nextTurnAt(now))
    return
  }
  waiters.shift()!.resolve()
  // One grant per wake. The granted entry's charge wakes the next waiter if there is room; the
  // fallback keeps the queue moving if that entry stops before it charges anything.
  if (waiters.length > 0) wakeAt(now + windowMs / 3)
}

/**
 * Charge `cpuMs` of relay thread time to `owner`. Returns the owner's own busy time in the window,
 * which is what its per-realm sustained budget checks, then wakes any waiter that now fits.
 */
export function chargeExecuteCpu(owner: object, cpuMs: number): number {
  const now = performance.now()
  slices.push({ owner, start: now - cpuMs, end: now })
  prune(now)
  const ownBusyMs = busyMsAt(now, owner)
  wake()
  return ownBusyMs
}

/**
 * Wait for a relay-wide execute turn. Returns undefined when the caller may enter immediately;
 * otherwise resolves when this owner reaches the front of the queue and the budget has room.
 */
export function waitForExecuteTurn(owner: object): Promise<void> | undefined {
  const now = performance.now()
  if (waiters.length === 0 && hasBudget(now)) return undefined
  return new Promise<void>((resolve) => {
    waiters.push({ owner, resolve })
    wake()
  })
}

/**
 * Hand a granted turn back unused. A waiter can be granted and then run no sandbox code (its timer
 * was cleared, its owner stopped, it lost a race with disposal), so it charges nothing; wake the
 * next waiter now instead of leaving it for the fallback timer, which is a whole slice away.
 */
export function releaseExecuteTurn(): void {
  wake()
}

/** Drop a disposed owner's waiters so they never run and do not hold up the queue. */
export function cancelExecuteWaiters(owner: object): void {
  for (let index = waiters.length - 1; index >= 0; index -= 1) {
    if (waiters[index]!.owner === owner) waiters.splice(index, 1)
  }
  if (waiters.length === 0) {
    if (wakeTimer !== undefined) {
      clearTimeout(wakeTimer)
      wakeTimer = undefined
    }
    return
  }
  // The front waiter may have been the one cancelled. Give the next a turn now rather than at the
  // fallback timer left by the last grant.
  wake()
}
