import { afterEach, describe, expect, test } from "bun:test"
import { beforeInput, clampPoint, humanInputEnabled, setHumanInput } from "../src/execute/human-input.ts"

// Human-like input follows the extension's setting from the next input, without a relay restart, and
// OPENCODE_BROWSER_HUMAN_INPUT overrides it either way.

const original = process.env.OPENCODE_BROWSER_HUMAN_INPUT
afterEach(() => {
  setHumanInput(undefined)
  if (original === undefined) delete process.env.OPENCODE_BROWSER_HUMAN_INPUT
  else process.env.OPENCODE_BROWSER_HUMAN_INPUT = original
})

let nextTab = 1
/** Two clicks' worth of pointer moves far apart; returns the extra events human-like input sent and how long it took. */
async function move() {
  const tabId = nextTab++
  const sent: string[] = []
  const send = async (method: string) => {
    sent.push(method)
    return {}
  }
  const started = Date.now()
  await beforeInput(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: 10, y: 10 }, true, send)
  await beforeInput(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: 600, y: 400 }, true, send)
  return { sent: sent.length, ms: Date.now() - started }
}

describe("human-like input", () => {
  test("is on by default: a move becomes a path of intermediate moves", async () => {
    delete process.env.OPENCODE_BROWSER_HUMAN_INPUT
    expect(humanInputEnabled()).toBe(true)
    expect((await move()).sent).toBeGreaterThan(5)
  })

  test("turned off at runtime, the next move goes straight through, and back on it paces again", async () => {
    delete process.env.OPENCODE_BROWSER_HUMAN_INPUT
    setHumanInput(false)
    const off = await move()
    expect(off.sent).toBe(0)
    expect(off.ms).toBeLessThan(50)
    setHumanInput(true)
    expect((await move()).sent).toBeGreaterThan(5)
  })

  test("OPENCODE_BROWSER_HUMAN_INPUT overrides the setting both ways", async () => {
    process.env.OPENCODE_BROWSER_HUMAN_INPUT = "0"
    setHumanInput(true)
    expect(humanInputEnabled()).toBe(false)
    expect((await move()).sent).toBe(0)
    process.env.OPENCODE_BROWSER_HUMAN_INPUT = "1"
    setHumanInput(false)
    expect(humanInputEnabled()).toBe(true)
    expect((await move()).sent).toBeGreaterThan(5)
  })
})

/**
 * A page for scrolling an element into view: a 20px element `top` px below the viewport's top, which the wheel
 * moves only while the page has room (`maxScroll`) and the pointer is over the element's scroller (`stuck`: not).
 */
function scrollPage(options: { top: number; maxScroll: number; stuck?: boolean }) {
  const page = { scrollY: 0, wheel: 0 }
  const send = async (method: string, params: Record<string, unknown>) => {
    if (method === "Page.getLayoutMetrics") return { cssVisualViewport: { clientWidth: 1200, clientHeight: 800 }, cssLayoutViewport: { clientWidth: 1200, clientHeight: 800 } }
    if (method === "DOM.getContentQuads") {
      const top = options.top - page.scrollY
      return { quads: [[0, top, 100, top, 100, top + 20, 0, top + 20]] }
    }
    if (method === "Input.dispatchMouseEvent" && params.type === "mouseWheel") {
      const delta = Number(params.deltaY)
      page.wheel += delta
      if (!options.stuck) page.scrollY = Math.min(options.maxScroll, Math.max(0, page.scrollY + delta))
    }
    return {}
  }
  return { page, send }
}

describe("scrolling an element into view", () => {
  test("lands the element in view, sending about as much wheel as the distance", async () => {
    const { page, send } = scrollPage({ top: 3000, maxScroll: 10_000 })
    await beforeInput(nextTab++, "DOM.scrollIntoViewIfNeeded", { objectId: "target" }, true, send)
    const top = 3000 - page.scrollY
    expect(top).toBeGreaterThanOrEqual(0)
    expect(top).toBeLessThanOrEqual(780)
    expect(page.wheel).toBeLessThanOrEqual(3000)
  }, 15_000)

  // Re-aiming at a new random spot on every reading made the stall check see movement that wasn't there, so the
  // relay sent all 12 flicks (~8000px over ~8s) into a page that couldn't move the element.
  test("gives up after one flick when the wheel can't move the element", async () => {
    const { page, send } = scrollPage({ top: 3000, maxScroll: 10_000, stuck: true })
    const started = Date.now()
    await beforeInput(nextTab++, "DOM.scrollIntoViewIfNeeded", { objectId: "target" }, true, send)
    expect(page.wheel).toBeLessThanOrEqual(900)
    expect(Date.now() - started).toBeLessThan(2500)
  }, 15_000)

  test("stops soon after the page bottoms out short of the element", async () => {
    const { page, send } = scrollPage({ top: 6000, maxScroll: 2000 })
    await beforeInput(nextTab++, "DOM.scrollIntoViewIfNeeded", { objectId: "target" }, true, send)
    expect(page.scrollY).toBe(2000)
    // The flick that hits the end, then one that moves nothing and ends it.
    expect(page.wheel).toBeLessThanOrEqual(2000 + 2 * 900)
  }, 15_000)
})

describe("pointer positions stay on screen", () => {
  test("the first move near a corner never starts or passes off screen", async () => {
    for (let i = 0; i < 6; i++) {
      const moves: { x: number; y: number }[] = []
      const send = async (method: string, params: Record<string, unknown>) => {
        if (method === "Page.getLayoutMetrics") return { cssLayoutViewport: { clientWidth: 800, clientHeight: 600 } }
        if (method === "Input.dispatchMouseEvent") moves.push({ x: Number(params.x), y: Number(params.y) })
        return {}
      }
      await beforeInput(1000 + i, "Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 5 }, true, send)
      expect(moves.length).toBeGreaterThan(0)
      for (const point of moves) {
        expect(point.x).toBeGreaterThanOrEqual(0)
        expect(point.y).toBeGreaterThanOrEqual(0)
        expect(point.x).toBeLessThan(800)
        expect(point.y).toBeLessThan(600)
      }
    }
  }, 30_000)

  test("clampPoint keeps a point inside the viewport, and non-negative when the viewport is unknown", () => {
    expect(clampPoint({ x: -12, y: 900 }, { width: 800, height: 600 })).toEqual({ x: 0, y: 599 })
    expect(clampPoint({ x: -3, y: 40 })).toEqual({ x: 0, y: 40 })
  })
})

